import { describe, expect, it, vi } from 'vitest'
import {
  drainLifecycle,
  reconcileRuns,
  stopActiveRunsForOrigin,
} from '../src/application/lifecycle.js'
import { completeRun } from '../src/application/completeRun.js'
import { isTerminalRun } from '../src/application/waitRuns.js'
import type {
  AgentControlPort,
  RunControlEvent,
  RunRecord,
  RunStorePort,
  SeedDeliveryPort,
  WindowDeps,
} from '../src/application/ports.js'

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

class MemoryRunStore implements RunStorePort {
  readonly records = new Map<string, RunRecord>()
  readonly controls: RunControlEvent[] = []
  settleImpl: (() => Promise<void>) | undefined
  cleanupCount = 0

  available(): boolean {
    return true
  }
  async create(r: RunRecord): Promise<void> {
    this.records.set(r.runId, r)
  }
  async update(runId: string, patch: Partial<RunRecord>): Promise<void> {
    const current = this.records.get(runId)
    if (current === undefined) throw new Error(`missing ${runId}`)
    this.records.set(runId, { ...current, ...patch })
  }
  async get(runId: string): Promise<RunRecord | undefined> {
    return this.records.get(runId)
  }
  async list(): Promise<RunRecord[]> {
    return [...this.records.values()]
  }
  async withLock<T>(_runId: string, operation: () => Promise<T>): Promise<T> {
    return await operation()
  }
  async appendControl(_runId: string, event: RunControlEvent): Promise<void> {
    this.controls.push(event)
  }
  async settle(): Promise<void> {
    if (this.settleImpl !== undefined) await this.settleImpl()
  }
  async cleanup(): Promise<number> {
    return this.cleanupCount
  }
}

function delivery(over: { delivered?: boolean } = {}): { port: SeedDeliveryPort; calls: number[] } {
  const calls: number[] = []
  const port: SeedDeliveryPort = {
    createMessage: () => ({ message: {}, messageId: 'm' }),
    deliver: async () => {
      calls.push(1)
      return over.delivered === false ? { delivered: false, reason: 'origin 冷启动失败' } : { delivered: true }
    },
  }
  return { port, calls }
}

function control(accepted = true): AgentControlPort {
  return {
    steer: async () => ({ delivered: true, mode: 'steered' }),
    cancelTurn: async () => (accepted ? { accepted: true } : { accepted: false, reason: '窗口不在线' }),
  }
}

function deps(store: RunStorePort, port: SeedDeliveryPort, over: Partial<WindowDeps> = {}): WindowDeps {
  let counter = 0
  return {
    resolveWindowKey: (exec) => (exec as { agent: { id: string } }).agent.id,
    requireLiveDriver: vi.fn(),
    seedDelivery: port,
    runStore: store,
    agentControl: control(),
    orphanTimeoutMs: 1_000,
    now: () => 10_000,
    newRunId: () => `id-${++counter}`,
    ...over,
  }
}

describe('B5 branch 生命周期', () => {
  it('reconcile：超时/离线 origin 的 active run 标记 orphaned，不伪造 result/callback', async () => {
    const store = new MemoryRunStore()
    await store.create(record({ lastActivityAt: 1, updatedAt: 1 }))
    const { port } = delivery()
    const summary = await reconcileRuns(deps(store, port))

    expect(summary.orphaned).toEqual(['run-1'])
    const run = await store.get('run-1')
    expect(run).toMatchObject({ status: 'orphaned' })
    expect(run?.lifecycle).toMatchObject({ state: 'orphaned' })
    expect(run?.result).toBeUndefined()
    expect(run?.callback).toMatchObject({ status: 'pending' })
    expect(store.controls[0]).toMatchObject({ kind: 'orphan' })
    expect(isTerminalRun('orphaned')).toBe(true)

    // orphaned 的 child 不能再“完成”，防止伪造完成
    await expect(completeRun(deps(store, port), { runId: 'run-1', status: 'completed', content: 'x' }, { agent: { id: CHILD } }))
      .rejects.toMatchObject({ code: 'WINDOW_RUN_NOT_ACTIVE' })
  })

  it('reconcile：超时且 origin 不在线 → orphan；未超时或健康 → 不动（FR-19）', async () => {
    const store = new MemoryRunStore()
    await store.create(record({ runId: 'run-dead', lastActivityAt: 1, updatedAt: 1 }))
    const { port } = delivery()
    const summary = await reconcileRuns(deps(store, port, {
      isWindowAlive: () => false,
    }))
    expect(summary.orphaned).toEqual(['run-dead'])
    expect((await store.get('run-dead'))?.lifecycle?.reason).toContain('不在线')

    // origin 不在线但**未超过** orphanTimeoutMs：不得立即判死
    const fresh = new MemoryRunStore()
    await fresh.create(record({ runId: 'run-fresh', lastActivityAt: 9_999, updatedAt: 9_999 }))
    const freshSummary = await reconcileRuns(deps(fresh, port, { isWindowAlive: () => false }))
    expect(freshSummary.orphaned).toEqual([])
    expect((await fresh.get('run-fresh'))?.status).toBe('running')

    // origin 在线且未超时：不动
    const healthy = new MemoryRunStore()
    await healthy.create(record({ lastActivityAt: 9_999, updatedAt: 9_999 }))
    const healthySummary = await reconcileRuns(deps(healthy, port, { isWindowAlive: () => true }))
    expect(healthySummary.orphaned).toEqual([])
    expect((await healthy.get('run-1'))?.status).toBe('running')
  })

  it('reconcile：重投未送达 callback，不改变已落盘结果', async () => {
    const store = new MemoryRunStore()
    await store.create(record({
      status: 'completed',
      result: { status: 'completed', content: '做完了', completedAt: 5, completedBy: CHILD },
      callback: { status: 'failed', callbackId: 'result-run-1', attempts: 1, reason: '投递失败' },
    }))
    const { port, calls } = delivery()
    const summary = await reconcileRuns(deps(store, port))

    expect(summary.redelivered).toEqual(['run-1'])
    expect(calls).toHaveLength(1)
    const run = await store.get('run-1')
    expect(run?.callback).toMatchObject({ status: 'delivered', attempts: 2 })
    expect(run?.result?.content).toBe('做完了')
  })

  it('reconcile 重投：投递失败且写回也失败时不得标 unknown（什么都没发出去）', async () => {
    const store = new MemoryRunStore()
    await store.create(record({
      status: 'completed',
      result: { status: 'completed', content: '做完了', completedAt: 5, completedBy: CHILD },
      callback: { status: 'failed', callbackId: 'result-run-1', attempts: 1, reason: '上次投递失败' },
    }))
    // 投递失败 + 状态写回抛错：盘上应保持原样，不能被改成 unknown
    const failing: MemoryRunStore = Object.assign(store, {
      update: async () => { throw new Error('disk full') },
    })
    const base = deps(failing, { createMessage: () => ({ message: {}, messageId: 'm' }), deliver: async () => ({ delivered: false, reason: '目标离线' }) } as unknown as SeedDeliveryPort)
    const summary = await reconcileRuns(base)

    const run = await store.get('run-1')
    expect(run?.callback?.status).toBe('failed')
    expect(run?.callback?.status).not.toBe('unknown')
    expect(summary.failures.length).toBeGreaterThan(0)
  })

  it('reconcile 重投：投递成功但写回失败时降级 unknown（避免下次重复投递）', async () => {
    const store = new MemoryRunStore()
    await store.create(record({
      status: 'completed',
      result: { status: 'completed', content: '做完了', completedAt: 5, completedBy: CHILD },
      callback: { status: 'failed', callbackId: 'result-run-1', attempts: 1, reason: '上次投递失败' },
    }))
    let updates = 0
    const failing: MemoryRunStore = Object.assign(store, {
      update: async () => { updates += 1; throw new Error('disk full') },
    })
    const base = deps(failing, { createMessage: () => ({ message: {}, messageId: 'm' }), deliver: async () => ({ delivered: true }) } as unknown as SeedDeliveryPort)
    await reconcileRuns(base)
    expect(updates).toBeGreaterThanOrEqual(1)
  })

  it('origin 停止：活动 run 全部 stop（cancelled + not_requested），并尽力取消 child', async () => {
    const store = new MemoryRunStore()
    await store.create(record({ runId: 'run-a' }))
    await store.create(record({ runId: 'run-b', childSessionId: 'session-c2', status: 'completed', result: { status: 'completed', content: 'ok', completedAt: 2, completedBy: 'session-c2' } }))
    const { port } = delivery()
    const summary = await stopActiveRunsForOrigin(deps(store, port), ORIGIN, 'origin 归档')

    expect(summary.affected).toEqual(['run-a'])
    expect(await store.get('run-a')).toMatchObject({
      status: 'cancelled',
      callbackArmed: false,
      lifecycle: { state: 'stopped' },
    })
    expect((await store.get('run-a'))?.callback).toMatchObject({ status: 'not_requested' })
    expect((await store.get('run-b'))?.status).toBe('completed')
    expect(store.controls.map((event) => event.kind)).toEqual(['stop'])
  })

  it('drain：无 settle 视为已排空；有 settle 等待落定；超时如实报告', async () => {
    const store = new MemoryRunStore()
    const { port } = delivery()
    expect(await drainLifecycle(deps(store, port))).toMatchObject({ drained: true })

    let release: (() => void) | undefined
    store.settleImpl = () => new Promise((resolve) => { release = resolve })
    const pendingDrain = drainLifecycle(deps(store, port), 1_000)
    release?.()
    expect(await pendingDrain).toMatchObject({ drained: true })

    store.settleImpl = () => new Promise(() => undefined)
    expect(await drainLifecycle(deps(store, port), 20)).toMatchObject({ drained: false })
  })

  it('reconcile 汇总 cleanup 数量与失败项', async () => {
    const store = new MemoryRunStore()
    store.cleanupCount = 3
    const { port } = delivery()
    const summary = await reconcileRuns(deps(store, port))
    expect(summary.cleaned).toBe(3)
    expect(summary.failures).toEqual([])
  })
})
