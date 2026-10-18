import { describe, expect, it, vi } from 'vitest'
import { completeRun } from '../src/application/completeRun.js'
import { dispatchTask } from '../src/application/dispatchTask.js'
import type { RunRecord, RunStorePort, SeedDeliveryPort, WindowDeps } from '../src/application/ports.js'
import { MemoryRunStore } from './helpers/memoryRunStore.js'

const ORIGIN = 'session-origin'
const CHILD = 'session-child'

function record(over: Partial<RunRecord> = {}): RunRecord {
  return {
    runId: 'run-1',
    scenario: 'branch',
    originSessionId: ORIGIN,
    childSessionId: CHILD,
    mode: 'fork',
    status: 'completed',
    callbackArmed: true,
    callback: { status: 'delivered', callbackId: 'result-run-1', attempts: 1 },
    result: { status: 'completed', content: '旧结果', completedAt: 1, completedBy: CHILD },
    createdAt: 1,
    updatedAt: 1,
    ...over,
  }
}

function makeDelivery(delivered = true): { port: SeedDeliveryPort; calls: { windowKey: string; message: unknown }[] } {
  const calls: { windowKey: string; message: unknown }[] = []
  const port: SeedDeliveryPort = {
    createMessage: (params) => ({
      message: {
        id: params.messageId ?? 'seed-1',
        content: [{ type: 'text', text: params.text }],
        source: { kind: params.kind, scenario: params.scenario, runId: params.runId },
      },
      messageId: params.messageId ?? 'seed-1',
    }),
    deliver: async (windowKey, message) => {
      calls.push({ windowKey, message })
      return delivered ? { delivered: true } : { delivered: false, reason: 'child offline' }
    },
  }
  return { port, calls }
}

function makeDeps(store: RunStorePort, delivery: SeedDeliveryPort, ids = ['run-new']): WindowDeps {
  let index = 0
  return {
    resolveWindowKey: (exec) => (exec as { agent: { id: string } }).agent.id,
    requireLiveDriver: vi.fn(),
    seedDelivery: delivery,
    runStore: store,
    now: () => 1_700_000_000_000,
    newRunId: () => ids[Math.min(index++, ids.length - 1)] ?? 'run-new',
  }
}

function exec(id: string): unknown {
  return { agent: { id } }
}

describe('window_dispatch', () => {
  it('复用已有 child，新建 run 并投递任务', async () => {
    const store = new MemoryRunStore()
    await store.create(record())
    const { port, calls } = makeDelivery(true)
    const deps = makeDeps(store, port, ['run-new'])

    const value = await dispatchTask(deps, { toWindow: CHILD, seedText: '再做一个子任务' }, exec(ORIGIN))

    expect(value).toMatchObject({
      success: true,
      run_id: 'run-new',
      to_window: CHILD,
      callback_policy: 'required',
      callback_armed: true,
      delivery: { delivered: true, kind: 'dsh-window-seed' },
    })
    expect(calls).toHaveLength(1)
    expect(calls[0]?.windowKey).toBe(CHILD)
    expect(String((calls[0]?.message as { content?: { text?: string }[] }).content?.[0]?.text))
      .toContain('run_id: run-new')
    expect(await store.get('run-new')).toMatchObject({
      status: 'running',
      callbackArmed: true,
      originSessionId: ORIGIN,
      childSessionId: CHILD,
    })
  })

  it('没有委派关系时拒绝', async () => {
    const store = new MemoryRunStore()
    await store.create(record({ originSessionId: 'session-other' }))
    const { port } = makeDelivery(true)
    await expect(dispatchTask(makeDeps(store, port), { toWindow: CHILD, seedText: 'x' }, exec(ORIGIN)))
      .rejects.toMatchObject({ code: 'WINDOW_RUN_FORBIDDEN' })
  })

  it('child 忙时拒绝', async () => {
    const store = new MemoryRunStore()
    await store.create(record({ status: 'running', callbackArmed: true, result: undefined }))
    const { port } = makeDelivery(true)
    await expect(dispatchTask(makeDeps(store, port), { toWindow: CHILD, seedText: 'x' }, exec(ORIGIN)))
      .rejects.toMatchObject({ code: 'WINDOW_CHILD_BUSY' })
  })

  it('不能派给自己；seed 失败时 run 落 seed_failed', async () => {
    const store = new MemoryRunStore()
    await store.create(record())
    const { port } = makeDelivery(false)
    const deps = makeDeps(store, port, ['run-new'])
    await expect(dispatchTask(deps, { toWindow: ORIGIN, seedText: 'x' }, exec(ORIGIN)))
      .rejects.toMatchObject({ code: 'WINDOW_RUN_FORBIDDEN' })

    const value = await dispatchTask(deps, { toWindow: CHILD, seedText: 'x' }, exec(ORIGIN))
    expect(value.success).toBe(false)
    expect(value.callback_armed).toBe(false)
    expect(await store.get('run-new')).toMatchObject({ status: 'seed_failed', callbackArmed: false })
  })

  it('完成一条后可以再派下一条', async () => {
    const store = new MemoryRunStore()
    await store.create(record())
    const delivery = makeDelivery(true)
    const deps = makeDeps(store, delivery.port, ['run-new-1', 'run-new-2'])

    const first = await dispatchTask(deps, { toWindow: CHILD, seedText: '任务 1' }, exec(ORIGIN))
    await completeRun(deps, { runId: first.run_id, status: 'completed', content: '完成 1' }, exec(CHILD))
    const second = await dispatchTask(deps, { toWindow: CHILD, seedText: '任务 2' }, exec(ORIGIN))
    expect(second.success).toBe(true)
    expect(second.run_id).toBe('run-new-2')
  })
})
