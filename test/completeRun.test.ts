import { describe, expect, it, vi } from 'vitest'
import { completeRun, formatCallbackText, getRunStatus, retryCallback } from '../src/application/completeRun.js'
import type {
  RunRecord,
  RunStorePort,
  SeedDeliveryPort,
  WindowDeps,
} from '../src/application/ports.js'
import { WindowError } from '../src/shared/errors.js'
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
    status: 'running',
    callbackArmed: true,
    callback: { status: 'pending', callbackId: 'result-run-1', attempts: 0 },
    createdAt: 1,
    updatedAt: 1,
    ...over,
  }
}

function makeDelivery(plan: boolean[]): {
  port: SeedDeliveryPort
  calls: { windowKey: string; message: unknown }[]
} {
  const calls: { windowKey: string; message: unknown }[] = []
  let index = 0
  const port: SeedDeliveryPort = {
    createMessage: (params) => ({
      message: {
        id: params.messageId ?? 'message-1',
        role: 'user',
        content: [{ type: 'text', text: params.text }],
        source: {
          kind: params.kind,
          scenario: params.scenario,
          ...(params.runId === undefined ? {} : { runId: params.runId }),
        },
      },
      messageId: params.messageId ?? 'message-1',
    }),
    deliver: async (windowKey, message) => {
      calls.push({ windowKey, message })
      const delivered = plan[Math.min(index, plan.length - 1)] ?? true
      index += 1
      return delivered ? { delivered: true } : { delivered: false, reason: 'origin offline' }
    },
  }
  return { port, calls }
}

function makeDeps(store: RunStorePort, delivery: SeedDeliveryPort): WindowDeps {
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

describe('window_complete', () => {
  it('先落结果再回调，回执分离 run/callback 状态', async () => {
    const store = new MemoryRunStore()
    await store.create(record())
    const { port, calls } = makeDelivery([true])
    const deps = makeDeps(store, port)

    const value = await completeRun(deps, { status: 'completed', content: '分支结果 X' }, exec(CHILD))

    expect(value).toMatchObject({ success: true, run_id: 'run-1', status: 'completed' })
    expect(value.result).toMatchObject({ status: 'completed', content: '分支结果 X', completedBy: CHILD })
    expect(value.callback).toMatchObject({ status: 'delivered', callbackId: 'result-run-1', attempts: 1 })
    expect(calls).toHaveLength(1)
    expect(calls[0]?.windowKey).toBe(ORIGIN)
    expect((calls[0]?.message as { source?: { kind?: string } }).source?.kind).toBe('dsh-window-result')
    expect((calls[0]?.message as { id?: string }).id).toBe('result-run-1')
    expect(await store.get('run-1')).toMatchObject({
      status: 'completed',
      result: { content: '分支结果 X' },
      callback: { status: 'delivered' },
    })
  })

  it('空 content 被拒', async () => {
    const store = new MemoryRunStore()
    await store.create(record())
    const { port } = makeDelivery([true])
    await expect(completeRun(makeDeps(store, port), { status: 'completed', content: '  ' }, exec(CHILD)))
      .rejects.toMatchObject({ code: 'WINDOW_RESULT_EMPTY' })
  })

  it('run 不存在 / 非 child / seed 未武装分别拒绝', async () => {
    const store = new MemoryRunStore()
    await store.create(record({ runId: 'run-a' }))
    await store.create(record({ runId: 'run-b', status: 'seed_failed', callbackArmed: false }))
    const { port } = makeDelivery([true])
    const deps = makeDeps(store, port)

    await expect(completeRun(deps, { runId: 'missing', status: 'completed', content: 'x' }, exec(CHILD)))
      .rejects.toMatchObject({ code: 'WINDOW_RUN_NOT_FOUND' })
    await expect(completeRun(deps, { runId: 'run-a', status: 'completed', content: 'x' }, exec('stranger')))
      .rejects.toMatchObject({ code: 'WINDOW_RUN_FORBIDDEN' })
    await expect(completeRun(deps, { runId: 'run-b', status: 'completed', content: 'x' }, exec(CHILD)))
      .rejects.toMatchObject({ code: 'WINDOW_RUN_NOT_ACTIVE' })
  })

  it('省略 run_id 时只允许唯一活动 run', async () => {
    const store = new MemoryRunStore()
    await store.create(record({ runId: 'run-1' }))
    await store.create(record({ runId: 'run-2' }))
    const { port } = makeDelivery([true])
    await expect(completeRun(makeDeps(store, port), { status: 'completed', content: 'x' }, exec(CHILD)))
      .rejects.toMatchObject({ code: 'WINDOW_RUN_AMBIGUOUS' })
  })

  it('相同结果重复完成幂等，不重复回调；不同结果拒绝覆盖', async () => {
    const store = new MemoryRunStore()
    await store.create(record())
    const { port, calls } = makeDelivery([true, true])
    const deps = makeDeps(store, port)

    const first = await completeRun(deps, { runId: 'run-1', status: 'completed', content: '结果 A' }, exec(CHILD))
    const second = await completeRun(deps, { runId: 'run-1', status: 'completed', content: '结果 A' }, exec(CHILD))
    expect(first.callback.status).toBe('delivered')
    expect(second.callback.status).toBe('delivered')
    expect(calls).toHaveLength(1)

    await expect(completeRun(deps, { runId: 'run-1', status: 'failed', content: '结果 B' }, exec(CHILD)))
      .rejects.toMatchObject({ code: 'WINDOW_RUN_ALREADY_SETTLED' })
    expect(calls).toHaveLength(1)
  })

  it('回调失败保留结果，retry 用同一 callbackId 补投', async () => {
    const store = new MemoryRunStore()
    await store.create(record())
    const { port, calls } = makeDelivery([false, true])
    const deps = makeDeps(store, port)

    const first = await completeRun(deps, { status: 'completed', content: '结果 A' }, exec(CHILD))
    expect(first.callback).toMatchObject({ status: 'failed', reason: 'origin offline', attempts: 1 })
    expect(await store.get('run-1')).toMatchObject({ status: 'completed', result: { content: '结果 A' } })

    const retried = await retryCallback(deps, 'run-1', exec(ORIGIN))
    expect(retried.callback).toMatchObject({ status: 'delivered', callbackId: 'result-run-1', attempts: 2 })
    expect(calls).toHaveLength(2)
    expect((calls[1]?.message as { id?: string }).id).toBe('result-run-1')

    const again = await retryCallback(deps, 'run-1', exec(ORIGIN))
    expect(again.callback.status).toBe('delivered')
    expect(calls).toHaveLength(2)
  })

  it('child 不能重试回调，未完成 run 不能重试', async () => {
    const store = new MemoryRunStore()
    await store.create(record())
    const { port } = makeDelivery([true])
    const deps = makeDeps(store, port)

    await expect(retryCallback(deps, 'run-1', exec(CHILD)))
      .rejects.toMatchObject({ code: 'WINDOW_RUN_FORBIDDEN' })
    await expect(retryCallback(deps, 'run-1', exec(ORIGIN)))
      .rejects.toMatchObject({ code: 'WINDOW_RUN_NOT_ACTIVE' })
  })
})

describe('window_status', () => {
  it('origin / child 可读，run 状态与 callback 状态分离', async () => {
    const store = new MemoryRunStore()
    await store.create(record())
    const { port } = makeDelivery([false])
    const deps = makeDeps(store, port)
    await completeRun(deps, { status: 'completed', content: '结果 A' }, exec(CHILD))

    const status = await getRunStatus(deps, 'run-1', exec(ORIGIN))
    expect(status).toMatchObject({
      run_id: 'run-1',
      run_status: 'completed',
      callback_armed: true,
      result: { content: '结果 A' },
      callback: { status: 'failed', attempts: 1 },
    })
    await expect(getRunStatus(deps, 'run-1', exec('stranger')))
      .rejects.toMatchObject({ code: 'WINDOW_RUN_FORBIDDEN' })
  })
})

describe('回调正文', () => {
  it('包含 run、状态、内容与非人类来源说明', () => {
    const text = formatCallbackText(record(), {
      status: 'completed',
      content: '结果 A',
      completedAt: 1,
      completedBy: CHILD,
    })
    expect(text).toContain('run_id: run-1')
    expect(text).toContain('结果状态: completed')
    expect(text).toContain('结果 A')
    expect(text).toContain('不是用户新指令')
  })
})

describe('错误对象', () => {
  it('结构化错误带 code', () => {
    try {
      throw new WindowError('WINDOW_RUN_NOT_FOUND', 'x')
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(WindowError)
      expect((error as WindowError).code).toBe('WINDOW_RUN_NOT_FOUND')
    }
  })
})
