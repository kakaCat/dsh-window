import { describe, expect, it, vi } from 'vitest'
import {
  callbackBackoffMs,
  formatCallbackText,
  redeliverDueCallbacks,
  refreshCallbackReceipts,
  startCallbackRetry,
  withNextAttempt,
} from '../src/application/callbackDelivery.js'
import type {
  CallbackLocation,
  RunRecord,
  SeedDeliveryPort,
  SessionActivityPort,
  WindowDeps,
} from '../src/application/ports.js'
import { MemoryRunStore } from './helpers/memoryRunStore.js'

const ORIGIN = 'session-origin'
const CHILD = 'session-child'

/** 已完成、回调未送达的 run。 */
function completed(over: Partial<RunRecord> = {}): RunRecord {
  return {
    runId: 'run-1',
    scenario: 'branch',
    createdBy: 'open',
    originSessionId: ORIGIN,
    childSessionId: CHILD,
    mode: 'fork',
    status: 'completed',
    callbackArmed: true,
    result: { status: 'completed', content: '结果 A', completedAt: 10, completedBy: CHILD },
    callback: { status: 'failed', callbackId: 'result-run-1', attempts: 1, reason: 'origin offline', nextAttemptAt: 1_000 },
    lastActivityAt: 5,
    createdAt: 1,
    updatedAt: 10,
    ...over,
  }
}

/** 可编排的投递：按调用顺序消费 true/false/throw。 */
function makeDelivery(plan: Array<boolean | 'throw'>): { port: SeedDeliveryPort; calls: string[] } {
  const calls: string[] = []
  let index = 0
  const port: SeedDeliveryPort = {
    createMessage: (params) => ({
      message: { id: params.messageId ?? 'm-1', content: [{ type: 'text', text: params.text }], source: { kind: params.kind, callbackId: params.callbackId } },
      messageId: params.messageId ?? 'm-1',
    }),
    deliver: async (windowKey) => {
      calls.push(windowKey)
      const next = plan[Math.min(index, plan.length - 1)] ?? true
      index += 1
      if (next === 'throw') throw new Error('投递炸了')
      return next ? { delivered: true } : { delivered: false, reason: 'origin offline' }
    },
  }
  return { port, calls }
}

function makeDeps(
  store: MemoryRunStore,
  delivery: SeedDeliveryPort,
  options: { clock?: { at: number }; activity?: SessionActivityPort; graceMs?: number } = {},
): WindowDeps {
  const clock = options.clock ?? { at: 10_000 }
  return {
    resolveWindowKey: (exec) => (exec as { agent: { id: string } }).agent.id,
    requireLiveDriver: vi.fn(),
    seedDelivery: delivery,
    runStore: store,
    ...(options.activity === undefined ? {} : { sessionActivity: options.activity }),
    ...(options.graceMs === undefined ? {} : { callbackGraceMs: options.graceMs }),
    now: () => clock.at,
    newRunId: () => 'run-2',
  }
}

/** 只实现 locate 的观测端口。 */
function makeActivity(locate: (windowKey: string, callbackId: string) => Promise<CallbackLocation>): SessionActivityPort & { calls: number } {
  const port = {
    calls: 0,
    watch: () => () => {},
    locate: async (windowKey: string, callbackId: string) => {
      port.calls += 1
      return await locate(windowKey, callbackId)
    },
  }
  return port
}

describe('回调自动重试（非终态才可重投）', () => {
  it('退避 2s 起、翻倍、封顶 60s；送达/unknown/not_requested 不加下次时间', () => {
    expect(callbackBackoffMs(1)).toBe(2_000)
    expect(callbackBackoffMs(2)).toBe(4_000)
    expect(callbackBackoffMs(6)).toBe(60_000)
    expect(callbackBackoffMs(100)).toBe(60_000)
    const failed = { status: 'failed' as const, callbackId: 'c', attempts: 1 }
    expect(withNextAttempt(failed, 1_000)).toMatchObject({ nextAttemptAt: 3_000 })
    for (const status of ['delivered', 'unknown', 'not_requested'] as const) {
      expect(withNextAttempt({ status, callbackId: 'c', attempts: 1 }, 1_000)).toEqual({ status, callbackId: 'c', attempts: 1 })
    }
  })

  it('到期的失败回调被自动重投并送达（attempts+1，nextAttemptAt 清空）', async () => {
    const store = new MemoryRunStore()
    await store.create(completed())
    const { port, calls } = makeDelivery([true])
    const clock = { at: 10_000 }
    const summary = await redeliverDueCallbacks(makeDeps(store, port, { clock }), clock.at)
    expect(calls).toEqual([ORIGIN])
    expect(summary).toMatchObject({ scanned: 1, due: 1, delivered: 1, failed: 0 })
    const saved = await store.get('run-1')
    expect(saved?.callback).toMatchObject({ status: 'delivered', attempts: 2, deliveredAt: 10_000 })
    expect(saved?.callback?.nextAttemptAt).toBeUndefined()
    // 重试不得重置 orphan 判据的输入（ADR-0004 §三）。
    expect(saved?.lastActivityAt).toBe(5)
  })

  it('未到 nextAttemptAt 的不投递：自动重试不制造重投风暴', async () => {
    const store = new MemoryRunStore()
    await store.create(completed({ callback: { status: 'failed', callbackId: 'result-run-1', attempts: 1, nextAttemptAt: 60_000 } }))
    const { port, calls } = makeDelivery([true])
    const clock = { at: 10_000 }
    const summary = await redeliverDueCallbacks(makeDeps(store, port, { clock }), clock.at)
    expect(summary.due).toBe(0)
    expect(calls).toEqual([])
    expect((await store.get('run-1'))?.callback).toMatchObject({ status: 'failed', attempts: 1 })
  })

  it('再次失败：attempts 递增并按新退避安排下一次', async () => {
    const store = new MemoryRunStore()
    await store.create(completed())
    const { port } = makeDelivery([false])
    const clock = { at: 10_000 }
    await redeliverDueCallbacks(makeDeps(store, port, { clock }), clock.at)
    const saved = await store.get('run-1')
    expect(saved?.callback).toMatchObject({ status: 'failed', attempts: 2, reason: 'origin offline' })
    expect(saved?.callback?.nextAttemptAt).toBe(14_000)
  })

  it('一条投递抛错不阻塞其它 run', async () => {
    const store = new MemoryRunStore()
    await store.create(completed({ runId: 'run-a', childSessionId: 'child-a', callback: { status: 'failed', callbackId: 'result-run-a', attempts: 1, nextAttemptAt: 0 } }))
    await store.create(completed({ runId: 'run-b', childSessionId: 'child-b', callback: { status: 'failed', callbackId: 'result-run-b', attempts: 1, nextAttemptAt: 0 } }))
    const { port, calls } = makeDelivery(['throw', true])
    const clock = { at: 10_000 }
    const summary = await redeliverDueCallbacks(makeDeps(store, port, { clock }), clock.at)
    expect(calls).toHaveLength(2)
    expect(summary.delivered).toBe(1)
    expect(summary.failed).toBe(1)
    expect((await store.get('run-b'))?.callback).toMatchObject({ status: 'delivered' })
  })

  it('只重投 pending/failed：delivered、unknown、not_requested 与无结果的 run 都不动', async () => {
    const store = new MemoryRunStore()
    await store.create(completed({ runId: 'run-d', callback: { status: 'delivered', callbackId: 'result-run-d', attempts: 1, deliveredAt: 9 } }))
    await store.create(completed({ runId: 'run-u', callback: { status: 'unknown', callbackId: 'result-run-u', attempts: 1 } }))
    await store.create(completed({ runId: 'run-n', callback: { status: 'not_requested', attempts: 0 } }))
    await store.create(completed({
      runId: 'run-r',
      status: 'running',
      result: undefined,
      callback: { status: 'pending', callbackId: 'result-run-r', attempts: 0 },
    }))
    const { port, calls } = makeDelivery([true])
    const clock = { at: 10_000 }
    const summary = await redeliverDueCallbacks(makeDeps(store, port, { clock }), clock.at)
    expect(summary.due).toBe(0)
    expect(calls).toEqual([])
  })

  it('调度器 tick 立即跑一轮，stop 幂等', async () => {
    const store = new MemoryRunStore()
    await store.create(completed())
    const { port, calls } = makeDelivery([true])
    const clock = { at: 10_000 }
    const handle = startCallbackRetry(makeDeps(store, port, { clock }), { intervalMs: 100 })
    const round = await handle.tick()
    expect(round.retry.delivered).toBe(1)
    expect(calls).toEqual([ORIGIN])
    handle.stop()
    handle.stop()
  })
})

describe('回调正文上限', () => {
  it('超过 4000 字符：内联截断、给出完整长度与 window_status 指针，完整结果仍留在 run 里', () => {
    const content = 'x'.repeat(4_500)
    const text = formatCallbackText(completed(), { status: 'completed', content, completedAt: 10, completedBy: CHILD })
    expect(text).toContain('正文已截断：完整 4500 字符')
    expect(text).toContain('window_status(run_id)')
    expect(text).not.toContain(content)
    expect(text.length).toBeLessThan(4_500)
  })

  it('未超过上限：正文原样内联', () => {
    const text = formatCallbackText(completed(), { status: 'completed', content: '短结论', completedAt: 10, completedBy: CHILD })
    expect(text).toContain('短结论')
    expect(text).not.toContain('正文已截断')
  })
})

describe('读回执对账（delivered ≠ read）', () => {
  it('已读入历史：落 readAt，并停止自动重投', async () => {
    const store = new MemoryRunStore()
    await store.create(completed({
      callback: { status: 'delivered', callbackId: 'result-run-1', attempts: 1, deliveredAt: 1_000 },
    }))
    const activity = makeActivity(async () => 'history')
    const clock = { at: 10_000 }
    const deps = makeDeps(store, makeDelivery([true]).port, { clock, activity, graceMs: 100 })
    const result = await refreshCallbackReceipts(deps, clock.at)
    expect(activity.calls).toBe(1)
    expect(result.read).toEqual(['run-1'])
    expect((await store.get('run-1'))?.callback).toMatchObject({ status: 'delivered', readAt: 10_000 })
    expect((await store.get('run-1'))?.callback?.nextAttemptAt).toBeUndefined()
  })

  it('既不在历史也不在收件箱：判定被丢弃，重新排队并由下一轮补投', async () => {
    const store = new MemoryRunStore()
    await store.create(completed({
      callback: { status: 'delivered', callbackId: 'result-run-1', attempts: 1, deliveredAt: 1_000 },
    }))
    const activity = makeActivity(async () => 'absent')
    const { port, calls } = makeDelivery([true])
    const clock = { at: 10_000 }
    const deps = makeDeps(store, port, { clock, activity, graceMs: 100 })
    const result = await refreshCallbackReceipts(deps, clock.at)
    expect(result.redelivered).toEqual(['run-1'])
    expect((await store.get('run-1'))?.callback).toMatchObject({ status: 'pending', nextAttemptAt: 10_000 })
    expect(calls).toEqual([])

    const retry = await redeliverDueCallbacks(deps, clock.at)
    expect(retry.delivered).toBe(1)
    expect(calls).toEqual([ORIGIN])
  })

  it('还在收件箱 / 判定不了：保持原状，不猜也不补投', async () => {
    for (const location of ['inbox', 'unknown'] as const) {
      const store = new MemoryRunStore()
      await store.create(completed({
        callback: { status: 'delivered', callbackId: 'result-run-1', attempts: 1, deliveredAt: 1_000 },
      }))
      const activity = makeActivity(async () => location)
      const clock = { at: 10_000 }
      const deps = makeDeps(store, makeDelivery([true]).port, { clock, activity, graceMs: 100 })
      const result = await refreshCallbackReceipts(deps, clock.at)
      expect(result.read).toEqual([])
      expect(result.redelivered).toEqual([])
      expect((await store.get('run-1'))?.callback).toMatchObject({ status: 'delivered' })
    }
  })

  it('未过宽限期不查（刚投进收件箱、还没被取走的正常窗口）', async () => {
    const store = new MemoryRunStore()
    await store.create(completed({
      callback: { status: 'delivered', callbackId: 'result-run-1', attempts: 1, deliveredAt: 9_000 },
    }))
    const activity = makeActivity(async () => 'absent')
    const clock = { at: 10_000 }
    const deps = makeDeps(store, makeDelivery([true]).port, { clock, activity, graceMs: 60_000 })
    const result = await refreshCallbackReceipts(deps, clock.at)
    expect(result.checked).toBe(0)
    expect(activity.calls).toBe(0)
  })

  it('同一进程最多补投一次：反复 absent 不会无限循环', async () => {
    const store = new MemoryRunStore()
    await store.create(completed({
      callback: { status: 'delivered', callbackId: 'result-run-1', attempts: 1, deliveredAt: 1_000 },
    }))
    const activity = makeActivity(async () => 'absent')
    const clock = { at: 10_000 }
    const deps = makeDeps(store, makeDelivery([true]).port, { clock, activity, graceMs: 100 })
    const requeued = new Set<string>()
    const first = await refreshCallbackReceipts(deps, 10_000, new Map(), requeued)
    expect(first.redelivered).toEqual(['run-1'])
    // 就算时间过去、节流过期，本进程也不再补投同一个 run。
    const again = await refreshCallbackReceipts(deps, 10_000 + 10 * 60_000, new Map(), requeued)
    expect(again.redelivered).toEqual([])
  })

  it('已读的回调不再进入对账', async () => {
    const store = new MemoryRunStore()
    await store.create(completed({
      callback: { status: 'delivered', callbackId: 'result-run-1', attempts: 1, deliveredAt: 1_000, readAt: 2_000 },
    }))
    const activity = makeActivity(async () => 'absent')
    const clock = { at: 10_000 }
    const deps = makeDeps(store, makeDelivery([true]).port, { clock, activity, graceMs: 100 })
    const result = await refreshCallbackReceipts(deps, clock.at)
    expect(result.checked).toBe(0)
    expect(activity.calls).toBe(0)
  })
})
