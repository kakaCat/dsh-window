import { describe, expect, it, vi } from 'vitest'
import { SessionActivity } from '../src/adapters/sessionActivity.js'
import { RunActivityTracker } from '../src/application/runActivity.js'
import type { SessionActivityEvent, WindowDeps } from '../src/application/ports.js'
import { MemoryRunStore, makeRunRecord } from './helpers/memoryRunStore.js'

const ORIGIN = 'session-origin'
const CHILD = 'session-child'

/** 最小宿主上下文：记录订阅并允许手动触发。 */
function fakeContext(): {
  ctx: unknown
  emit: (event: string, ...args: unknown[]) => void
  handlers: Map<string, (...args: never[]) => void>
} {
  const handlers = new Map<string, (...args: never[]) => void>()
  const ctx = {
    on: (event: string, handler: (...args: never[]) => void) => {
      handlers.set(event, handler)
      return () => handlers.delete(event)
    },
  }
  return { ctx, handlers, emit: (event, ...args) => handlers.get(event)?.(...(args as never[])) }
}

function fakeAgents(map: Record<string, unknown> = {}) {
  return { get: (id: string) => map[id] }
}

function makeDeps(store: MemoryRunStore, clock: { at: number }, over: Partial<WindowDeps> = {}): WindowDeps {
  return {
    resolveWindowKey: (exec) => (exec as { agent: { id: string } }).agent.id,
    requireLiveDriver: vi.fn(),
    runStore: store,
    now: () => clock.at,
    newRunId: () => 'run-new',
    ...over,
  }
}

describe('SessionActivity 适配器（只观测，不改状态）', () => {
  it('把进入历史的回调消息折算成 callbackId，其它会话事件折算成推进', () => {
    const fake = fakeContext()
    const port = new SessionActivity(() => fake.ctx, () => fakeAgents(), () => undefined)
    const seen: SessionActivityEvent[] = []
    const dispose = port.watch((event) => seen.push(event))

    fake.emit('session/event', { id: ORIGIN }, { type: 'user/message', data: { source: { callbackId: 'result-r1' } } })
    fake.emit('session/event', { id: CHILD }, { type: 'assistant/message', data: {} })
    fake.emit('agent/status', { agent: { id: CHILD }, status: 'running' })
    fake.emit('agent/status', { agent: { id: CHILD }, status: 'idle' })

    expect(seen).toHaveLength(3)
    expect(seen[0]).toMatchObject({ sessionId: ORIGIN, callbackId: 'result-r1' })
    expect(seen[1]).toMatchObject({ sessionId: CHILD })
    expect(seen[1]?.callbackId).toBeUndefined()
    expect(seen[2]).toMatchObject({ sessionId: CHILD })
    dispose()
    fake.emit('session/event', { id: CHILD }, { type: 'assistant/message', data: {} })
    expect(seen).toHaveLength(3)
  })

  it('宿主没有 on 能力时安静降级（watch 返回空 disposer）', () => {
    const port = new SessionActivity(() => ({}), () => fakeAgents(), () => undefined)
    const dispose = port.watch(() => {
      throw new Error('不该被调用')
    })
    expect(typeof dispose).toBe('function')
    dispose()
  })

  it('locate：收件箱命中优先于历史，历史命中返回 history，都没有返回 absent', async () => {
    const inboxMessage = { id: 'm', source: { callbackId: 'result-r1' } }
    const withInbox = new SessionActivity(
      () => fakeContext().ctx,
      () => fakeAgents({ [ORIGIN]: { inbox: { nextTurn: [inboxMessage] } } }),
      () => ({ inspect: async () => ({ events: [] }) }),
    )
    expect(await withInbox.locate(ORIGIN, 'result-r1')).toBe('inbox')

    const inHistory = new SessionActivity(
      () => fakeContext().ctx,
      () => fakeAgents(),
      () => ({ inspect: async () => ({ events: [{ type: 'user/message', data: { source: { callbackId: 'result-r1' } } }] }) }),
    )
    expect(await inHistory.locate(ORIGIN, 'result-r1')).toBe('history')

    const absent = new SessionActivity(
      () => fakeContext().ctx,
      () => fakeAgents(),
      () => ({ inspect: async () => ({ events: [{ type: 'user/message', data: { source: { callbackId: 'other' } } }] }) }),
    )
    expect(await absent.locate(ORIGIN, 'result-r1')).toBe('absent')
  })

  it('locate：没有 inspect 能力或读取抛错时返回 unknown（绝不猜 absent）', async () => {
    const noCapability = new SessionActivity(() => fakeContext().ctx, () => fakeAgents(), () => undefined)
    expect(await noCapability.locate(ORIGIN, 'result-r1')).toBe('unknown')

    const broken = new SessionActivity(
      () => fakeContext().ctx,
      () => fakeAgents(),
      () => ({ inspect: async () => { throw new Error('读不到') } }),
    )
    expect(await broken.locate(ORIGIN, 'result-r1')).toBe('unknown')
  })
})

describe('RunActivityTracker（心跳与读回执）', () => {
  it('child 推进写 lastTurnAt，并按节流合并高频事件', async () => {
    const store = new MemoryRunStore({ recordUpdates: true })
    await store.create(makeRunRecord({ runId: 'run-1', childSessionId: CHILD, lastActivityAt: 1 }))
    const clock = { at: 5_000 }
    const tracker = new RunActivityTracker(makeDeps(store, clock), { touchIntervalMs: 1_000, cacheTtlMs: 0 })

    await tracker.handle({ sessionId: CHILD, at: 5_000 })
    expect((await store.get('run-1'))?.lastTurnAt).toBe(5_000)
    const writes = store.updates.length

    await tracker.handle({ sessionId: CHILD, at: 5_500 })
    expect(store.updates.length).toBe(writes) // 节流内不写
    expect((await store.get('run-1'))?.lastTurnAt).toBe(5_000)

    await tracker.handle({ sessionId: CHILD, at: 7_000 })
    expect((await store.get('run-1'))?.lastTurnAt).toBe(7_000)
    // 心跳不碰写入时间口径的 lastActivityAt。
    expect((await store.get('run-1'))?.lastActivityAt).toBe(1)
  })

  it('终态 run 的推进事件不写心跳', async () => {
    const store = new MemoryRunStore()
    await store.create(makeRunRecord({ runId: 'run-1', childSessionId: CHILD, status: 'completed' }))
    const clock = { at: 5_000 }
    const tracker = new RunActivityTracker(makeDeps(store, clock), { touchIntervalMs: 0, cacheTtlMs: 0 })
    await tracker.handle({ sessionId: CHILD, at: 5_000 })
    expect((await store.get('run-1'))?.lastTurnAt).toBeUndefined()
  })

  it('origin 读入回调：落 readAt、纠正 failed 读数、清掉下次重试时间', async () => {
    const store = new MemoryRunStore()
    await store.create(makeRunRecord({
      runId: 'run-1',
      originSessionId: ORIGIN,
      childSessionId: CHILD,
      status: 'completed',
      result: { status: 'completed', content: '结果', completedAt: 3, completedBy: CHILD },
      callback: {
        status: 'failed',
        callbackId: 'result-run-1',
        attempts: 2,
        reason: 'origin offline',
        nextAttemptAt: 60_000,
      },
    }))
    const clock = { at: 8_000 }
    const tracker = new RunActivityTracker(makeDeps(store, clock), { cacheTtlMs: 0 })
    await tracker.handle({ sessionId: ORIGIN, at: 8_000, callbackId: 'result-run-1' })
    const callback = (await store.get('run-1'))?.callback
    expect(callback).toMatchObject({ status: 'delivered', readAt: 8_000, deliveredAt: 8_000, callbackId: 'result-run-1' })
    expect(callback?.nextAttemptAt).toBeUndefined()
  })

  it('不相关的 callbackId / 重复回执不重复写', async () => {
    const store = new MemoryRunStore({ recordUpdates: true })
    await store.create(makeRunRecord({
      runId: 'run-1',
      originSessionId: ORIGIN,
      status: 'completed',
      result: { status: 'completed', content: '结果', completedAt: 3, completedBy: CHILD },
      callback: { status: 'delivered', callbackId: 'result-run-1', attempts: 1, deliveredAt: 1 },
    }))
    const clock = { at: 8_000 }
    const tracker = new RunActivityTracker(makeDeps(store, clock), { cacheTtlMs: 0 })
    await tracker.handle({ sessionId: ORIGIN, at: 8_000, callbackId: 'result-other' })
    expect((await store.get('run-1'))?.callback?.readAt).toBeUndefined()

    await tracker.handle({ sessionId: ORIGIN, at: 8_000, callbackId: 'result-run-1' })
    const writes = store.updates.length
    await tracker.handle({ sessionId: ORIGIN, at: 9_000, callbackId: 'result-run-1' })
    expect(store.updates.length).toBe(writes)
    expect((await store.get('run-1'))?.callback?.readAt).toBe(8_000)
  })

  it('存储写失败被吞掉：观测不能影响宿主事件循环', async () => {
    const store = new MemoryRunStore({ failUpdateAt: 1 })
    await store.create(makeRunRecord({ runId: 'run-1', childSessionId: CHILD }))
    const clock = { at: 5_000 }
    const tracker = new RunActivityTracker(makeDeps(store, clock), { touchIntervalMs: 0, cacheTtlMs: 0 })
    await expect(tracker.handle({ sessionId: CHILD, at: 5_000 })).resolves.toBeUndefined()
  })
})
