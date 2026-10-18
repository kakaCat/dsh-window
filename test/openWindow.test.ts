import { describe, expect, it, vi } from 'vitest'
import { openWindow, normalizeOpenWindowInput } from '../src/application/openWindow.js'
import type {
  OpenWindowDeps,
  OpenWindowOutcome,
  RunRecord,
  RunStorePort,
  SeedDeliveryPort,
  WindowCreateOptions,
  WindowModelSelection,
  WindowOpenerPort,
  WindowSourceProfile,
} from '../src/application/ports.js'
import { WindowError } from '../src/shared/errors.js'

const ORIGIN = 'session-origin'
const EXEC = { agent: { id: ORIGIN, status: 'running' } }

interface OpenerOptions {
  available?: boolean
  forkOutcome?: OpenWindowOutcome
  createOutcome?: OpenWindowOutcome
  profile?: WindowSourceProfile
  registryProject?: WindowCreateOptions
  failRename?: boolean
}

function makeOpener(options: OpenerOptions = {}): {
  opener: WindowOpenerPort
  calls: {
    fork: { source: string; atSeq?: number }[]
    create: (WindowCreateOptions | undefined)[]
    rename: { id: string; title: string }[]
    selectModel: { id: string; selection: WindowModelSelection }[]
  }
} {
  const calls = {
    fork: [] as { source: string; atSeq?: number }[],
    create: [] as (WindowCreateOptions | undefined)[],
    rename: [] as { id: string; title: string }[],
    selectModel: [] as { id: string; selection: WindowModelSelection }[],
  }
  const opener: WindowOpenerPort = {
    available: () => options.available ?? true,
    fork: async (source, atSeq) => {
      calls.fork.push({ source, ...(atSeq === undefined ? {} : { atSeq }) })
      return options.forkOutcome ?? { ok: true, windowKey: 'session-child', parentSessionId: source }
    },
    create: async (opts) => {
      calls.create.push(opts)
      return options.createOutcome ?? { ok: true, windowKey: 'session-child' }
    },
    readProfile: async () => options.profile ?? {},
    rename: async (id, title) => {
      if (options.failRename === true) throw new Error('rename boom')
      calls.rename.push({ id, title })
    },
    selectModel: async (id, selection) => {
      calls.selectModel.push({ id, selection })
    },
  }
  if (options.registryProject !== undefined) {
    opener.resolveSourceProject = () => options.registryProject
  }
  return { opener, calls }
}

function makeDelivery(options: { delivered?: boolean; reason?: string } = {}): {
  port: SeedDeliveryPort
  seeds: { params: { text: string; kind: string; scenario: string; runId?: string }; message: unknown }[]
} {
  const seeds: { params: { text: string; kind: string; scenario: string; runId?: string }; message: unknown }[] = []
  const port: SeedDeliveryPort = {
    createMessage: (params) => {
      const message = {
        id: 'message-seed',
        role: 'user',
        content: [{ type: 'text', text: params.text }],
        source: { kind: params.kind, scenario: params.scenario, ...(params.runId === undefined ? {} : { runId: params.runId }) },
      }
      seeds.push({ params, message })
      return { message, messageId: 'message-seed' }
    },
    deliver: async () => ({
      delivered: options.delivered ?? true,
      ...(options.reason === undefined ? {} : { reason: options.reason }),
    }),
  }
  return { port, seeds }
}

class MemoryRunStore implements RunStorePort {
  readonly records = new Map<string, RunRecord>()
  private readonly locks = new Map<string, Promise<unknown>>()

  available(): boolean {
    return true
  }

  async create(record: RunRecord): Promise<void> {
    this.records.set(record.runId, record)
  }

  async update(runId: string, patch: Partial<RunRecord>): Promise<void> {
    const current = this.records.get(runId)
    if (current === undefined) throw new Error(`missing run ${runId}`)
    this.records.set(runId, { ...current, ...patch })
  }

  async get(runId: string): Promise<RunRecord | undefined> {
    return this.records.get(runId)
  }

  async list(): Promise<RunRecord[]> {
    return [...this.records.values()]
  }

  async withLock<T>(runId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(runId) ?? Promise.resolve()
    const result = previous.then(operation, operation)
    const tail = result.then(() => undefined, () => undefined)
    this.locks.set(runId, tail)
    void tail.then(() => {
      if (this.locks.get(runId) === tail) this.locks.delete(runId)
    })
    return result
  }
}

class FailingUpdateRunStore extends MemoryRunStore {
  override async update(): Promise<void> {
    throw new Error('update boom')
  }
}

function makeDeps(overrides: {
  opener?: WindowOpenerPort
  delivery?: SeedDeliveryPort
  runStore?: RunStorePort
} = {}): OpenWindowDeps {
  return {
    resolveWindowKey: vi.fn(() => ORIGIN),
    requireLiveDriver: vi.fn(),
    now: () => 1_700_000_000_000,
    newRunId: () => 'run-1',
    ...(overrides.opener === undefined ? {} : { windowOpener: overrides.opener }),
    ...(overrides.delivery === undefined ? {} : { seedDelivery: overrides.delivery }),
    ...(overrides.runStore === undefined ? {} : { runStore: overrides.runStore }),
  }
}

describe('window_open 输入校验', () => {
  it('缺 scenario 时在开窗前拒绝', () => {
    expect(() => normalizeOpenWindowInput({ scenario: undefined as never, seedText: 'x' }))
      .toThrowError(WindowError)
  })

  it('blank seed 被拒绝', () => {
    try {
      normalizeOpenWindowInput({ scenario: 'continuation', seedText: '   ' })
      throw new Error('should have thrown')
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(WindowError)
      expect((error as WindowError).code).toBe('WINDOW_SEED_REQUIRED')
    }
  })

  it('默认 mode 由 scenario 决定', () => {
    expect(normalizeOpenWindowInput({ scenario: 'continuation', seedText: 'x' }).mode).toBe('create')
    expect(normalizeOpenWindowInput({ scenario: 'branch', seedText: 'x' }).mode).toBe('fork')
  })

  it('title 超过 200 字符在开窗前拒绝，且不触发任何会话创建', async () => {
    const { opener, calls } = makeOpener()
    const { port } = makeDelivery()
    const deps = makeDeps({ opener, delivery: port })

    await expect(openWindow(
      deps,
      { scenario: 'branch', seedText: 'x', title: 'a'.repeat(201) },
      EXEC,
    )).rejects.toMatchObject({ code: 'WINDOW_OPEN_FAILED' })

    expect(calls.fork).toHaveLength(0)
    expect(calls.create).toHaveLength(0)

    // 边界：正好 200 字符允许
    const { opener: okOpener, calls: okCalls } = makeOpener()
    const { port: okPort } = makeDelivery()
    const ok = await openWindow(
      makeDeps({ opener: okOpener, delivery: okPort, runStore: new MemoryRunStore() }),
      { scenario: 'branch', seedText: 'x', title: 'a'.repeat(200) },
      EXEC,
    )
    expect(ok.success).toBe(true)
    expect(okCalls.fork).toHaveLength(1)
  })
})

describe('continuation：续接不回调', () => {
  it('默认 create，返回无 run_id / callback_policy=none', async () => {
    const { opener, calls } = makeOpener({
      registryProject: { workspaceId: 'ws-1' },
      profile: {
        title: '当前任务',
        agentPreset: 'standard',
        modelSelection: { provider: 'deepseek', model: 'chat' },
      },
    })
    const { port, seeds } = makeDelivery()
    const deps = makeDeps({ opener, delivery: port })

    const value = await openWindow(deps, { scenario: 'continuation', seedText: '继续做' }, EXEC)

    expect(value).toMatchObject({
      success: true,
      scenario: 'continuation',
      callback_policy: 'none',
      callback_armed: false,
      session_created: true,
      window_key: 'session-child',
      mode: 'create',
    })
    expect(value.run_id).toBeUndefined()
    expect(deps.requireLiveDriver).toHaveBeenCalledOnce()
    expect(calls.create).toHaveLength(1)
    expect(calls.create[0]).toMatchObject({ workspaceId: 'ws-1', agentPreset: 'standard' })
    expect(calls.fork).toHaveLength(0)
    expect(calls.rename[0]).toMatchObject({ id: 'session-child', title: '续接：继续做' })
    expect(calls.selectModel[0]).toMatchObject({
      id: 'session-child',
      selection: { provider: 'deepseek', model: 'chat' },
    })
    expect(seeds[0]?.params).toMatchObject({ kind: 'dsh-window-seed', scenario: 'continuation' })
    expect((seeds[0]?.message as { source?: { kind?: string } }).source?.kind).toBe('dsh-window-seed')
  })

  it('显式 fork 时返回 parent_session_id 且不建 run', async () => {
    const { opener, calls } = makeOpener()
    const { port } = makeDelivery()
    const deps = makeDeps({ opener, delivery: port })
    const value = await openWindow(
      deps,
      { scenario: 'continuation', mode: 'fork', atSeq: 42, seedText: '继续做' },
      EXEC,
    )
    expect(value.parent_session_id).toBe(ORIGIN)
    expect(value.run_id).toBeUndefined()
    expect(calls.fork[0]).toMatchObject({ source: ORIGIN, atSeq: 42 })
  })
})

describe('branch：分叉记录与回调策略', () => {
  it('默认 fork，落 run 并投递带 run_id 的 seed', async () => {
    const { opener, calls } = makeOpener()
    const { port, seeds } = makeDelivery()
    const store = new MemoryRunStore()
    const deps = makeDeps({ opener, delivery: port, runStore: store })

    const value = await openWindow(deps, { scenario: 'branch', seedText: '做分支' }, EXEC)

    expect(value).toMatchObject({
      success: true,
      scenario: 'branch',
      callback_policy: 'required',
      callback_armed: true,
      session_created: true,
      window_key: 'session-child',
      run_id: 'run-1',
      mode: 'fork',
    })
    expect(calls.fork).toHaveLength(1)
    expect(calls.create).toHaveLength(0)
    expect(seeds[0]?.params.runId).toBe('run-1')
    expect(String((seeds[0]?.message as { content?: { text?: string }[] }).content?.[0]?.text))
      .toContain('window_complete')
    const run = await store.get('run-1')
    expect(run).toMatchObject({ status: 'running', callbackArmed: true, seedMessageId: 'message-seed' })
  })

  it('seed 投递失败时 run 落 seed_failed 且 success=false', async () => {
    const { opener } = makeOpener()
    const { port } = makeDelivery({ delivered: false, reason: '窗口不在线' })
    const store = new MemoryRunStore()
    const deps = makeDeps({ opener, delivery: port, runStore: store })

    const value = await openWindow(deps, { scenario: 'branch', seedText: '做分支' }, EXEC)

    expect(value.success).toBe(false)
    expect(value.session_created).toBe(true)
    expect(value.window_key).toBe('session-child')
    expect(value.delivery).toMatchObject({ delivered: false, reason: '窗口不在线' })
    expect(await store.get('run-1')).toMatchObject({ status: 'seed_failed' })
  })

  it('run 更新失败时如实返回 success=false', async () => {
    const { opener } = makeOpener()
    const { port } = makeDelivery()
    const deps = makeDeps({ opener, delivery: port, runStore: new FailingUpdateRunStore() })
    const value = await openWindow(deps, { scenario: 'branch', seedText: '做分支' }, EXEC)
    expect(value.success).toBe(false)
    // 分字段后运行记录失败原因走 run_error，不再覆盖 delivery.reason
    expect(value.delivery?.run_error).toContain('运行记录更新失败')
  })
})

describe('开窗前置失败不产生会话', () => {
  it('缺开窗能力时 WINDOW_OPEN_UNAVAILABLE', async () => {
    const { opener, calls } = makeOpener({ available: false })
    const { port } = makeDelivery()
    const deps = makeDeps({ opener, delivery: port, runStore: new MemoryRunStore() })
    await expect(openWindow(deps, { scenario: 'branch', seedText: 'x' }, EXEC))
      .rejects.toMatchObject({ code: 'WINDOW_OPEN_UNAVAILABLE' })
    expect(calls.fork).toHaveLength(0)
    expect(calls.create).toHaveLength(0)
  })

  it('branch 缺 runStore 时 WINDOW_RUN_STORE_UNAVAILABLE 且不建窗', async () => {
    const { opener, calls } = makeOpener()
    const { port } = makeDelivery()
    const deps = makeDeps({ opener, delivery: port })
    await expect(openWindow(deps, { scenario: 'branch', seedText: 'x' }, EXEC))
      .rejects.toMatchObject({ code: 'WINDOW_RUN_STORE_UNAVAILABLE' })
    expect(calls.fork).toHaveLength(0)
    expect(calls.create).toHaveLength(0)
  })

  it('create 拿不到落点时响亮失败', async () => {
    const { opener, calls } = makeOpener()
    const { port } = makeDelivery()
    const deps = makeDeps({ opener, delivery: port })
    await expect(openWindow(deps, { scenario: 'continuation', seedText: 'x' }, EXEC))
      .rejects.toMatchObject({ code: 'WINDOW_OPEN_UNAVAILABLE' })
    expect(calls.create).toHaveLength(0)
  })

  it('fork 没有完整回合时提示改用 create', async () => {
    const { opener } = makeOpener({
      forkOutcome: { ok: false, code: 'unavailable_no_completed_turn', reason: 'no completed turn' },
    })
    const { port } = makeDelivery()
    const deps = makeDeps({ opener, delivery: port, runStore: new MemoryRunStore() })
    await expect(openWindow(deps, { scenario: 'branch', seedText: 'x' }, EXEC))
      .rejects.toMatchObject({ code: 'WINDOW_OPEN_UNAVAILABLE' })
  })
})

describe('继承失败不改变开窗成败', () => {
  it('rename 失败时 title=failed，但会话与 seed 仍成立', async () => {
    const { opener } = makeOpener({ profile: { title: '源标题' }, failRename: true })
    const { port } = makeDelivery()
    const deps = makeDeps({ opener, delivery: port })
    const value = await openWindow(deps, { scenario: 'continuation', mode: 'fork', seedText: '继续' }, EXEC)
    expect(value.success).toBe(true)
    expect(value.inheritance.title).toBe('failed')
    expect(value.inheritance.reasons.join('')).toContain('标题')
  })
})
