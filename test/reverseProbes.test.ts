import { readFile } from 'node:fs/promises'
import { describe, expect, it, vi } from 'vitest'
import { completeRun } from '../src/application/completeRun.js'
import { interruptRun } from '../src/application/interruptRun.js'
import { reconcileRuns } from '../src/application/lifecycle.js'
import { openWindow } from '../src/application/openWindow.js'
import type {
  RunControlEvent,
  RunRecord,
  RunStorePort,
  SeedDeliveryPort,
  WindowDeps,
  WindowOpenerPort,
} from '../src/application/ports.js'

/**
 * AC-17 反向探针：这些用例**必须**证明“错误行为会被拒绝”。
 * 如果其中任何一条开始通过“错误行为”，说明不变量被破坏。
 */

const ORIGIN = 'session-origin'
const CHILD = 'session-child'

class MemoryRunStore implements RunStorePort {
  readonly records = new Map<string, RunRecord>()
  available(): boolean {
    return true
  }
  async create(record: RunRecord): Promise<void> {
    this.records.set(record.runId, record)
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
    void event
  }
}

function opener(): WindowOpenerPort {
  return {
    available: () => true,
    fork: async (source) => ({ ok: true, windowKey: CHILD, parentSessionId: source }),
    create: async () => ({ ok: true, windowKey: CHILD }),
    resolveSourceProject: () => ({ cwd: '/ws' }),
    readProfile: async () => ({}),
    rename: async () => undefined,
    selectModel: async () => undefined,
  }
}

/** 记录每一次回调投递；用于证明“没有第 N 次回调”。 */
function makeDelivery(): { port: SeedDeliveryPort; callbacks: string[] } {
  const callbacks: string[] = []
  const port: SeedDeliveryPort = {
    createMessage: (params) => ({
      message: { content: [{ type: 'text', text: params.text }], source: { kind: params.kind } },
      messageId: params.messageId ?? 'm-1',
    }),
    deliver: async (windowKey) => {
      if (windowKey === ORIGIN) callbacks.push(windowKey)
      return { delivered: true }
    },
  }
  return { port, callbacks }
}

function deps(store: RunStorePort, port: SeedDeliveryPort): WindowDeps {
  let counter = 0
  return {
    resolveWindowKey: (exec) => (exec as { agent: { id: string } }).agent.id,
    requireLiveDriver: vi.fn(),
    windowOpener: opener(),
    seedDelivery: port,
    runStore: store,
    now: () => 100,
    newRunId: () => `run-${++counter}`,
  }
}

function exec(id: string): unknown {
  return { agent: { id } }
}

describe('反向探针（AC-17）', () => {
  it('若 continuation 能产生回调 → 本条必须失败：它没有 run、完成工具拒绝、origin 零回调', async () => {
    const store = new MemoryRunStore()
    const { port, callbacks } = makeDelivery()
    const value = await openWindow(
      deps(store, port),
      { scenario: 'continuation', seedText: '接管当前任务' },
      exec(ORIGIN),
    )

    // continuation 契约：无 run、不回调
    expect(value).toMatchObject({ success: true, scenario: 'continuation', callback_policy: 'none', callback_armed: false })
    expect(value.run_id).toBeUndefined()
    expect(store.records.size).toBe(0)

    // 新窗口（= child 窗口）尝试“完成”必须找不到可完成的 run
    await expect(completeRun(deps(store, port), { status: 'completed', content: '假装完成' }, exec(CHILD)))
      .rejects.toMatchObject({ code: 'WINDOW_RUN_NOT_FOUND' })
    // 显式编一个 run_id 也不行
    await expect(completeRun(deps(store, port), { runId: 'run-1', status: 'completed', content: '假装完成' }, exec(CHILD)))
      .rejects.toMatchObject({ code: 'WINDOW_RUN_NOT_FOUND' })
    expect(callbacks).toEqual([])
  })

  it('若 branch 会重复回调 → 本条必须失败：同结果幂等且只投递一次，改内容被拒', async () => {
    const store = new MemoryRunStore()
    const { port, callbacks } = makeDelivery()
    const opened = await openWindow(deps(store, port), { scenario: 'branch', seedText: '做分支任务' }, exec(ORIGIN))
    const runId = opened.run_id!
    expect(callbacks).toEqual([])

    const first = await completeRun(deps(store, port), { runId, status: 'completed', content: '分支结果X' }, exec(CHILD))
    expect(first.callback.status).toBe('delivered')
    expect(callbacks).toHaveLength(1)

    const again = await completeRun(deps(store, port), { runId, status: 'completed', content: '分支结果X' }, exec(CHILD))
    expect(again.callback.status).toBe('delivered')
    expect(callbacks).toHaveLength(1) // 没有第二次回调

    await expect(completeRun(deps(store, port), { runId, status: 'completed', content: '换个结果' }, exec(CHILD)))
      .rejects.toMatchObject({ code: 'WINDOW_RUN_ALREADY_SETTLED' })
    expect(callbacks).toHaveLength(1)
    expect((await store.get(runId))?.result?.content).toBe('分支结果X') // 首次结果不被覆盖
  })

  it('无任何完成信号时 run 保持 running：对账不把 running 当完成，也不回调', async () => {
    const store = new MemoryRunStore()
    const { port, callbacks } = makeDelivery()
    const opened = await openWindow(deps(store, port), { scenario: 'branch', seedText: '做分支任务' }, exec(ORIGIN))
    const runId = opened.run_id!

    // 只投了 seed，没有任何完成信号（本用例不依赖“turn/end 事件”——插件根本不订阅宿主事件）。
    expect(await store.get(runId)).toMatchObject({ status: 'running', callbackArmed: true })
    expect((await store.get(runId))?.result).toBeUndefined()

    // 生命周期对账（origin 在线、未超时）不得把 running 当完成
    const summary = await reconcileRuns(deps(store, port))
    expect(summary.orphaned).toEqual([])
    expect(summary.redelivered).toEqual([])
    expect(await store.get(runId)).toMatchObject({ status: 'running' })
    expect((await store.get(runId))?.result).toBeUndefined()
    expect(callbacks).toEqual([])
  })

  it('接线层不存在“回合结束 → 完成”的路径：index 不订阅任何宿主事件，也不调用 completeRun', async () => {
    // 这条是源码级反向探针：若将来有人把 turn/end（或任何宿主事件）接到自动完成上，
    // 对应断言会红——因为本插件的完成入口只有 window_complete 工具与 Host Service.complete。
    const index = await readFile(new URL('../src/index.ts', import.meta.url), 'utf8')
    const lifecycle = await readFile(new URL('../src/application/lifecycle.ts', import.meta.url), 'utf8')

    expect(index).not.toMatch(/\.on\s*\(/) // 不订阅任何宿主事件（无 ready/dispose/turn-end 接线）
    expect(index).not.toMatch(/completeRun\s*\(/) // 接线层不直接完成 run
    expect(lifecycle).not.toMatch(/completeRun\s*\(/) // 对账/孤儿/排空不伪造完成

    // 强化：完成入口只在工具壳与 Host Service 里出现，二者都要求显式调用。
    const tools = await readFile(new URL('../src/tools/windowRunTools.ts', import.meta.url), 'utf8')
    expect(tools).toMatch(/completeRun\s*\(/)
    const host = await readFile(new URL('../src/hostService.ts', import.meta.url), 'utf8')
    expect(host).toMatch(/completeRun\s*\(/)
  })

  it('若已取消/孤儿 run 能被补完成 → 本条必须失败', async () => {
    const store = new MemoryRunStore()
    const { port, callbacks } = makeDelivery()
    const opened = await openWindow(deps(store, port), { scenario: 'branch', seedText: '做分支任务' }, exec(ORIGIN))
    const runId = opened.run_id!

    await interruptRun(deps(store, port), { runId, mode: 'run', reason: '需求取消' }, exec(ORIGIN))
    // 已落 cancelled 结果：补完成只会被终态拒绝（ALREADY_SETTLED），不会覆盖
    await expect(completeRun(deps(store, port), { runId, status: 'completed', content: '事后补完成' }, exec(CHILD)))
      .rejects.toMatchObject({ code: 'WINDOW_RUN_ALREADY_SETTLED' })
    expect((await store.get(runId))?.result).toMatchObject({ status: 'cancelled', content: '需求取消' })
    expect(callbacks).toEqual([]) // origin 主动取消不回调自己

    const orphanStore = new MemoryRunStore()
    const second = makeDelivery()
    await orphanStore.create({
      runId: 'run-orphan',
      scenario: 'branch',
      createdBy: 'open',
      originSessionId: ORIGIN,
      childSessionId: CHILD,
      mode: 'fork',
      status: 'running',
      callbackArmed: true,
      callback: { status: 'pending', callbackId: 'result-run-orphan', attempts: 0 },
      lastActivityAt: 1,
      createdAt: 1,
      updatedAt: 1,
    })
    await reconcileRuns({
      ...deps(orphanStore, second.port),
      orphanTimeoutMs: 1_000,
      now: () => 10_000,
    })
    expect(await orphanStore.get('run-orphan')).toMatchObject({ status: 'orphaned' })
    await expect(completeRun(deps(orphanStore, second.port), { runId: 'run-orphan', status: 'completed', content: '补完成' }, exec(CHILD)))
      .rejects.toMatchObject({ code: 'WINDOW_RUN_NOT_ACTIVE' })
    expect(second.callbacks).toEqual([])
  })
})
