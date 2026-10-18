import { describe, expect, it, vi } from 'vitest'
import { interruptRun } from '../src/application/interruptRun.js'
import type {
  AgentControlPort,
  RunRecord,
  RunStorePort,
  TopicStorePort,
  WindowDeps,
} from '../src/application/ports.js'
import { MemoryRunStore } from './helpers/memoryRunStore.js'

const ORIGIN = 'session-origin'
const CHILD = 'session-child'

function record(over: Partial<RunRecord> = {}): RunRecord {
  return {
    runId: 'run-1',
    scenario: 'branch',
    createdBy: 'open',
    originSessionId: ORIGIN,
    childSessionId: CHILD,
    mode: 'fork',
    status: 'running',
    callbackArmed: true,
    callback: { status: 'pending', callbackId: 'result-run-1', attempts: 0 },
    lastActivityAt: 1,
    createdAt: 1,
    updatedAt: 1,
    ...over,
  }
}

function deps(store: RunStorePort, control?: AgentControlPort): WindowDeps {
  let counter = 0
  return {
    resolveWindowKey: (exec) => (exec as { agent: { id: string } }).agent.id,
    requireLiveDriver: vi.fn(),
    runStore: store,
    ...(control === undefined ? {} : { agentControl: control }),
    now: () => 100,
    newRunId: () => `id-${counter++}`,
  }
}

function control(accepted = true): AgentControlPort {
  return {
    steer: async () => ({ delivered: true, mode: 'steered' }),
    cancelTurn: async () => (accepted ? { accepted: true } : { accepted: false, reason: '窗口不在线' }),
  }
}

function exec(id: string): unknown {
  return { agent: { id } }
}

describe('window_interrupt', () => {
  it('mode=turn 只停当前轮，run 保持 running', async () => {
    const store = new MemoryRunStore()
    await store.create(record())
    const value = await interruptRun(deps(store, control()), { runId: 'run-1', mode: 'turn', reason: '方向错了' }, exec(ORIGIN))
    expect(value).toMatchObject({ accepted: true, mode: 'turn', run_status: 'running' })
    expect(await store.get('run-1')).toMatchObject({ status: 'running', lastActivityAt: 100 })
    expect(store.controls[0]).toMatchObject({ kind: 'interrupt-turn', result: 'accepted', reason: '方向错了' })
  })

  it('mode=run 落 cancelled + not_requested，且不回调 origin', async () => {
    const store = new MemoryRunStore()
    await store.create(record())
    const value = await interruptRun(deps(store, control()), { runId: 'run-1', mode: 'run', reason: '需求取消' }, exec(ORIGIN))
    expect(value).toMatchObject({ accepted: true, mode: 'run', run_status: 'cancelled' })
    expect(value.result).toMatchObject({ status: 'cancelled', content: '需求取消', completedBy: ORIGIN })
    expect(value.callback).toMatchObject({ status: 'not_requested' })
    expect(await store.get('run-1')).toMatchObject({ status: 'cancelled', callbackArmed: false })
    expect(store.controls[0]).toMatchObject({ kind: 'interrupt-run' })
  })

  it('重复取消同 origin 幂等；child 无权中断；非活动 run 拒绝', async () => {
    const store = new MemoryRunStore()
    await store.create(record())
    const depsObj = deps(store, control())
    await interruptRun(depsObj, { runId: 'run-1', mode: 'run' }, exec(ORIGIN))
    const again = await interruptRun(depsObj, { runId: 'run-1', mode: 'run' }, exec(ORIGIN))
    expect(again.note).toContain('幂等')

    const fresh = new MemoryRunStore()
    await fresh.create(record())
    await expect(interruptRun(deps(fresh, control()), { runId: 'run-1', mode: 'turn' }, exec(CHILD)))
      .rejects.toMatchObject({ code: 'WINDOW_RUN_FORBIDDEN' })

    const inactive = new MemoryRunStore()
    await inactive.create(record({ status: 'seed_failed', callbackArmed: false }))
    await expect(interruptRun(deps(inactive, control()), { runId: 'run-1', mode: 'turn' }, exec(ORIGIN)))
      .rejects.toMatchObject({ code: 'WINDOW_RUN_NOT_ACTIVE' })
  })

  it('目标离线：turn 如实未执行；run 仍落盘取消', async () => {
    const turnStore = new MemoryRunStore()
    await turnStore.create(record())
    const turnValue = await interruptRun(deps(turnStore, control(false)), { runId: 'run-1', mode: 'turn' }, exec(ORIGIN))
    expect(turnValue.accepted).toBe(false)
    expect(turnValue.note).toContain('未执行')
    expect((await turnStore.get('run-1'))?.status).toBe('running')

    const runStore = new MemoryRunStore()
    await runStore.create(record())
    const runValue = await interruptRun(deps(runStore, control(false)), { runId: 'run-1', mode: 'run' }, exec(ORIGIN))
    expect(runValue.accepted).toBe(true)
    expect(runValue.run_status).toBe('cancelled')
    expect(runValue.note).toContain('child 离线')
  })

  it('mode=run 落 lifecycle=stopped，并释放该 run 的协作占用（与 stop/orphan 同口径）', async () => {
    const store = new MemoryRunStore()
    await store.create(record({ topicId: 'topic-1' }))
    const releaseClaimsForRun = vi.fn(async () => [])
    const topicStore = { available: () => true, releaseClaimsForRun } as unknown as TopicStorePort
    const depsObj: WindowDeps = { ...deps(store, control()), topicStore }

    const value = await interruptRun(depsObj, { runId: 'run-1', mode: 'run', reason: '需求取消' }, exec(ORIGIN))

    expect(value).toMatchObject({ accepted: true, run_status: 'cancelled' })
    const onDisk = await store.get('run-1')
    expect(onDisk?.lifecycle).toMatchObject({ state: 'stopped' })
    expect(onDisk?.lifecycle?.reason).toContain('需求取消')
    expect(releaseClaimsForRun).toHaveBeenCalledOnce()
    expect(releaseClaimsForRun).toHaveBeenCalledWith('run-1', expect.objectContaining({
      reason: expect.stringContaining('取消'),
    }))
  })

  it('未绑定 topic 的 run 取消时不触碰占用存储', async () => {
    const store = new MemoryRunStore()
    await store.create(record())
    const releaseClaimsForRun = vi.fn(async () => [])
    const topicStore = { available: () => true, releaseClaimsForRun } as unknown as TopicStorePort

    await interruptRun({ ...deps(store, control()), topicStore }, { runId: 'run-1', mode: 'run' }, exec(ORIGIN))

    expect(releaseClaimsForRun).not.toHaveBeenCalled()
  })
})
