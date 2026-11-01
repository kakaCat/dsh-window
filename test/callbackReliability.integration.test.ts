import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { completeRun } from '../src/application/completeRun.js'
import { redeliverDueCallbacks, refreshCallbackReceipts } from '../src/application/callbackDelivery.js'
import { openWindow } from '../src/application/openWindow.js'
import { RunActivityTracker } from '../src/application/runActivity.js'
import { FsRunStore } from '../src/adapters/runStore.js'
import type { SeedDeliveryPort, SessionActivityPort, WindowDeps, WindowOpenerPort } from '../src/application/ports.js'

const ORIGIN = 'session-origin'
const CHILD = 'session-child'

const dirs: string[] = []

afterEach(async () => {
  while (dirs.length > 0) {
    const dir = dirs.pop()!
    await rm(dir, { recursive: true, force: true })
  }
})

async function tempStore(): Promise<FsRunStore> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-window-'))
  dirs.push(dir)
  return new FsRunStore({ root: dir })
}

function opener(created: string[]): WindowOpenerPort {
  return {
    available: () => true,
    fork: async (source) => {
      created.push(CHILD)
      return { ok: true, windowKey: CHILD, parentSessionId: source }
    },
    create: async () => {
      created.push(CHILD)
      return { ok: true, windowKey: CHILD }
    },
    resolveSourceProject: () => ({ cwd: '/ws' }),
    readProfile: async () => ({}),
    rename: async () => undefined,
    selectModel: async () => undefined,
  }
}

/** seed 必达；回调按 plan 编排。 */
function delivery(plan: Array<boolean | 'throw'>): { port: SeedDeliveryPort; callbacks: string[] } {
  const callbacks: string[] = []
  let index = 0
  const port: SeedDeliveryPort = {
    createMessage: (params) => ({
      message: {
        id: params.messageId ?? 'm-seed',
        content: [{ type: 'text', text: params.text }],
        source: { kind: params.kind, ...(params.callbackId === undefined ? {} : { callbackId: params.callbackId }) },
      },
      messageId: params.messageId ?? 'm-seed',
    }),
    deliver: async (windowKey) => {
      if (windowKey !== ORIGIN) return { delivered: true }
      callbacks.push(windowKey)
      const next = plan[Math.min(index, plan.length - 1)] ?? true
      index += 1
      if (next === 'throw') throw new Error('投递炸了')
      return next ? { delivered: true } : { delivered: false, reason: 'origin offline' }
    },
  }
  return { port, callbacks }
}

function deps(
  store: FsRunStore,
  seed: SeedDeliveryPort,
  clock: { at: number },
  activity?: SessionActivityPort,
): WindowDeps {
  return {
    resolveWindowKey: (exec) => (exec as { agent: { id: string } }).agent.id,
    requireLiveDriver: vi.fn(),
    windowOpener: opener([]),
    seedDelivery: seed,
    runStore: store,
    ...(activity === undefined ? {} : { sessionActivity: activity }),
    callbackGraceMs: 100,
    now: () => clock.at,
    newRunId: () => `run-${Math.random().toString(36).slice(2, 8)}`,
  }
}

function exec(id: string): unknown {
  return { agent: { id } }
}

describe('回调可靠性（真实文件存储 + 索引投影）', () => {
  it('冷 origin：首投失败 → 运行期自动补投 → 读回执落盘；索引同步 last_turn_at / read_at', async () => {
    const store = await tempStore()
    const { port, callbacks } = delivery([false, true])
    const clock = { at: 10_000 }
    const activityPort = {
      watch: () => () => {},
      locate: async () => 'history' as const,
    }
    const base = deps(store, port, clock, activityPort)

    const opened = await openWindow(base, { scenario: 'branch', seedText: '做分支任务' }, exec(ORIGIN))
    const runId = opened.run_id!
    expect(opened.callback_armed).toBe(true)
    // seed 的消息 id 由 runId 派生，可对账、可幂等。
    expect((await store.get(runId))?.seedMessageId).toBe(`seed-${runId}`)

    // 心跳：child 推进写 lastTurnAt（终态 run 不写，所以要在完成之前观测）。
    const tracker = new RunActivityTracker(base, { touchIntervalMs: 0, cacheTtlMs: 0 })
    clock.at = 10_500
    await tracker.handle({ sessionId: CHILD, at: 10_500 })
    expect((await store.get(runId))?.lastTurnAt).toBe(10_500)

    clock.at = 10_600
    const first = await completeRun(base, { runId, status: 'completed', content: '分支结果 A' }, exec(CHILD))
    expect(first.callback).toMatchObject({ status: 'failed', attempts: 1, reason: 'origin offline' })
    expect(first.callback.nextAttemptAt).toBe(12_600)
    expect(callbacks).toEqual([ORIGIN])

    // 磁盘上的 nextAttemptAt 也要能阻止提前重投。
    clock.at = 11_000
    const early = await redeliverDueCallbacks(base, clock.at)
    expect(early.due).toBe(0)

    clock.at = 12_600
    const retried = await redeliverDueCallbacks(base, clock.at)
    expect(retried).toMatchObject({ due: 1, delivered: 1 })
    expect(callbacks).toEqual([ORIGIN, ORIGIN])

    // 读回执：origin 读入历史。
    await tracker.handle({ sessionId: ORIGIN, at: 13_500, callbackId: `result-${runId}` })

    const saved = await store.get(runId)
    expect(saved?.lastTurnAt).toBe(10_500)
    expect(saved?.callback).toMatchObject({ status: 'delivered', readAt: 13_500 })
    expect(saved?.callback?.nextAttemptAt).toBeUndefined()

    // 回执对账：已读的 run 不再补投。
    const receipts = await refreshCallbackReceipts(base, 99_000)
    expect(receipts.checked).toBe(0)

    const rows = await store.listIndex!()
    const row = rows.find((item) => item.runId === runId)!
    expect(row).toMatchObject({ callbackReadAt: 13_500, lastTurnAt: 10_500, callbackStatus: 'delivered' })
  })

  it('回调被丢弃：对账判 absent 后补投成功（同一 callbackId，不产生第二条逻辑结果）', async () => {
    const store = await tempStore()
    const { port, callbacks } = delivery([true, true])
    const clock = { at: 10_000 }
    const base = deps(store, port, clock, { watch: () => () => {}, locate: async () => 'absent' })

    const opened = await openWindow(base, { scenario: 'branch', seedText: '做分支任务' }, exec(ORIGIN))
    const runId = opened.run_id!
    await completeRun(base, { runId, status: 'completed', content: '结果 B' }, exec(CHILD))
    expect(callbacks).toEqual([ORIGIN])

    clock.at = 20_000
    const receipts = await refreshCallbackReceipts(base, clock.at)
    expect(receipts.redelivered).toEqual([runId])
    expect((await store.get(runId))?.callback).toMatchObject({ status: 'pending', nextAttemptAt: 20_000 })

    const retried = await redeliverDueCallbacks(base, clock.at)
    expect(retried.delivered).toBe(1)
    expect(callbacks).toEqual([ORIGIN, ORIGIN])
    expect((await store.get(runId))?.result?.content).toBe('结果 B')
  })
})
