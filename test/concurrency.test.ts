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

function makeDelivery(): { port: SeedDeliveryPort; calls: { windowKey: string; message: unknown }[] } {
  const calls: { windowKey: string; message: unknown }[] = []
  const port: SeedDeliveryPort = {
    createMessage: (params) => ({
      message: {
        id: params.messageId ?? 'message-1',
        content: [{ type: 'text', text: params.text }],
        source: { kind: params.kind, scenario: params.scenario, runId: params.runId },
      },
      messageId: params.messageId ?? 'message-1',
    }),
    deliver: async (windowKey, message) => {
      calls.push({ windowKey, message })
      return { delivered: true }
    },
  }
  return { port, calls }
}

function deps(store: RunStorePort, delivery: SeedDeliveryPort, newRunId?: () => string): WindowDeps {
  let counter = 0
  return {
    resolveWindowKey: (exec) => (exec as { agent: { id: string } }).agent.id,
    requireLiveDriver: vi.fn(),
    seedDelivery: delivery,
    runStore: store,
    now: () => 1_700_000_000_000,
    newRunId: newRunId ?? (() => `run-new-${++counter}`),
  }
}

function exec(id: string): unknown {
  return { agent: { id } }
}

/** 把 settled 结果拆成「成功值 / 失败原因」。 */
function split<T>(results: PromiseSettledResult<T>[]): {
  ok: T[]
  rejected: { code?: string; message?: string }[]
} {
  const ok: T[] = []
  const rejected: { code?: string; message?: string }[] = []
  for (const result of results) {
    if (result.status === 'fulfilled') ok.push(result.value)
    else rejected.push(result.reason as { code?: string; message?: string })
  }
  return { ok, rejected }
}

describe('并发不变量（真实并发，不是顺序调用）', () => {
  it('同一 run 两个不同结果并发完成：恰好一个成功，另一个 ALREADY_SETTLED，只回调一次', async () => {
    const store = new MemoryRunStore()
    await store.create(record())
    const { port, calls } = makeDelivery()
    const depsObj = deps(store, port)

    const settled = await Promise.allSettled([
      completeRun(depsObj, { runId: 'run-1', status: 'completed', content: '结果 A' }, exec(CHILD)),
      completeRun(depsObj, { runId: 'run-1', status: 'completed', content: '结果 B' }, exec(CHILD)),
    ])

    const { ok, rejected } = split(settled)
    expect(ok).toHaveLength(1)
    expect(rejected).toHaveLength(1)
    expect(rejected[0]?.code).toBe('WINDOW_RUN_ALREADY_SETTLED')
    expect(calls).toHaveLength(1)

    const onDisk = await store.get('run-1')
    expect(onDisk?.status).toBe('completed')
    expect(['结果 A', '结果 B']).toContain(onDisk?.result?.content)
    expect(onDisk?.callback?.status).toBe('delivered')
  })

  it('同一 child 两次并发 dispatch：恰好一个成功，另一个 CHILD_BUSY', async () => {
    // 先有一条终态 run 建立 origin→child 委派关系。
    const store = new MemoryRunStore()
    await store.create(record({
      status: 'completed',
      result: { status: 'completed', content: '旧结果', completedAt: 1, completedBy: CHILD },
      callback: { status: 'delivered', callbackId: 'result-run-1', attempts: 1 },
    }))
    const { port, calls } = makeDelivery()
    const depsObj = deps(store, port)

    const settled = await Promise.allSettled([
      dispatchTask(depsObj, { toWindow: CHILD, seedText: '任务 1' }, exec(ORIGIN)),
      dispatchTask(depsObj, { toWindow: CHILD, seedText: '任务 2' }, exec(ORIGIN)),
    ])

    const { ok, rejected } = split(settled)
    expect(ok).toHaveLength(1)
    expect(rejected).toHaveLength(1)
    expect(rejected[0]?.code).toBe('WINDOW_CHILD_BUSY')
    expect(calls).toHaveLength(1)

    const active = (await store.list()).filter((run) => run.status === 'running' || run.status === 'pending')
    expect(active).toHaveLength(1)
  })

  it('并发完成同一内容时也只有一个赢家（幂等只对已终态生效，不越过互斥）', async () => {
    const store = new MemoryRunStore()
    await store.create(record())
    const { port, calls } = makeDelivery()
    const depsObj = deps(store, port)

    const settled = await Promise.allSettled([
      completeRun(depsObj, { runId: 'run-1', status: 'completed', content: '同一结果' }, exec(CHILD)),
      completeRun(depsObj, { runId: 'run-1', status: 'completed', content: '同一结果' }, exec(CHILD)),
    ])

    // 第二个进入锁时已是终态且内容相同 → 幂等返回成功，但绝不重复回调。
    const { ok } = split(settled)
    expect(ok).toHaveLength(2)
    expect(calls).toHaveLength(1)
    expect((await store.get('run-1'))?.callback?.attempts).toBe(1)
  })
})
