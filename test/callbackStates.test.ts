import { describe, expect, it, vi } from 'vitest'
import { completeRun, retryCallback } from '../src/application/completeRun.js'
import { interruptRun } from '../src/application/interruptRun.js'
import { reconcileRuns } from '../src/application/lifecycle.js'
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

function deps(store: RunStorePort, delivery: SeedDeliveryPort): WindowDeps {
  return {
    resolveWindowKey: (exec) => (exec as { agent: { id: string } }).agent.id,
    requireLiveDriver: vi.fn(),
    seedDelivery: delivery,
    runStore: store,
    now: () => 1_700_000_000_000,
    newRunId: () => 'run-2',
  }
}

function exec(id: string): unknown {
  return { agent: { id } }
}

describe('回调 unknown 态（FR-8 / 审核发现）', () => {
  it('回调状态落盘失败：回执与盘上都是 unknown，结果不丢，投递只发生一次', async () => {
    // 第 2 次 update 是「把 delivered 写回 run」——注入失败，逼出 unknown 分支。
    const store = new MemoryRunStore({ failUpdateAt: 2, recordUpdates: true })
    await store.create(record())
    const { port, calls } = makeDelivery()

    const value = await completeRun(deps(store, port), { status: 'completed', content: '结果 A' }, exec(CHILD))

    expect(value.result).toMatchObject({ status: 'completed', content: '结果 A' })
    expect(value.callback.status).toBe('unknown')
    expect(value.callback.reason).toContain('回调状态落盘失败')
    expect(calls).toHaveLength(1)

    // 关键：unknown 必须**落盘**，不能停在 pending 被 reconcile 盲重投。
    const onDisk = await store.get('run-1')
    expect(onDisk?.status).toBe('completed')
    expect(onDisk?.result).toMatchObject({ content: '结果 A' })
    expect(onDisk?.callback?.status).toBe('unknown')
    expect(store.updates).toHaveLength(3)
  })

  it('reconcile 不重投 unknown：投递次数 0、callback 保持 unknown', async () => {
    const store = new MemoryRunStore()
    await store.create(record({
      status: 'completed',
      result: { status: 'completed', content: '结果 A', completedAt: 5, completedBy: CHILD },
      callback: { status: 'unknown', callbackId: 'result-run-1', attempts: 1, reason: '回调状态落盘失败' },
      updatedAt: 5,
      lastActivityAt: 5,
    }))
    const { port, calls } = makeDelivery()

    const summary = await reconcileRuns(deps(store, port))

    expect(calls).toHaveLength(0)
    expect(summary.redelivered).toEqual([])
    expect(summary.failures).toEqual([])
    expect((await store.get('run-1'))?.callback?.status).toBe('unknown')
  })

  it('unknown 态拒绝盲目重试：WINDOW_CALLBACK_UNKNOWN，且不产生第二次投递', async () => {
    const store = new MemoryRunStore()
    await store.create(record({
      status: 'completed',
      result: { status: 'completed', content: '结果 A', completedAt: 5, completedBy: CHILD },
      callback: { status: 'unknown', callbackId: 'result-run-1', attempts: 1, reason: '回调状态落盘失败' },
      updatedAt: 5,
      lastActivityAt: 5,
    }))
    const { port, calls } = makeDelivery()

    await expect(retryCallback(deps(store, port), 'run-1', exec(ORIGIN)))
      .rejects.toMatchObject({ code: 'WINDOW_CALLBACK_UNKNOWN' })
    expect(calls).toHaveLength(0)
  })

  it('not_requested 态拒绝重试：WINDOW_CALLBACK_NOT_REQUESTED（origin 主动取消无回调请求）', async () => {
    const store = new MemoryRunStore()
    await store.create(record())
    const { port, calls } = makeDelivery()
    const depsObj = deps(store, port)

    await interruptRun(depsObj, { runId: 'run-1', mode: 'run', reason: '需求取消' }, exec(ORIGIN))
    expect((await store.get('run-1'))?.callback?.status).toBe('not_requested')

    await expect(retryCallback(depsObj, 'run-1', exec(ORIGIN)))
      .rejects.toMatchObject({ code: 'WINDOW_CALLBACK_NOT_REQUESTED' })
    expect(calls).toHaveLength(0)
  })
})
