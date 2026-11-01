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
  WindowWorkspaceResolution,
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
  workspace?: WindowWorkspaceResolution
  failRename?: boolean
}

function makeOpener(options: OpenerOptions = {}): {
  opener: WindowOpenerPort
  calls: {
    fork: { source: string; atSeq?: number }[]
    create: (WindowCreateOptions | undefined)[]
    rename: { id: string; title: string }[]
    selectModel: { id: string; selection: WindowModelSelection }[]
    workspaceQueries: string[]
  }
} {
  const calls = {
    fork: [] as { source: string; atSeq?: number }[],
    create: [] as (WindowCreateOptions | undefined)[],
    rename: [] as { id: string; title: string }[],
    selectModel: [] as { id: string; selection: WindowModelSelection }[],
    workspaceQueries: [] as string[],
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
  if (options.workspace !== undefined) {
    const resolution = options.workspace
    opener.resolveWorkspace = (query) => {
      calls.workspaceQueries.push(query)
      return resolution
    }
  }
  return { opener, calls }
}

function makeDelivery(options: { delivered?: boolean; reason?: string } = {}): {
  port: SeedDeliveryPort
  seeds: { params: { text: string; kind: string; scenario?: string; runId?: string }; message: unknown }[]
} {
  const seeds: { params: { text: string; kind: string; scenario?: string; runId?: string }; message: unknown }[] = []
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

describe('跨工作区开窗（target_workspace）', () => {
  const TARGET = { id: 'ws-2', title: '后端仓库', path: '/repos/backend' }
  const RESOLVED: WindowWorkspaceResolution = { ok: true, workspace: TARGET }

  it('continuation + target_workspace 把子窗建到目标工作区，并在 seed 里写明落点', async () => {
    const { opener, calls } = makeOpener({
      registryProject: { workspaceId: 'ws-1' },
      workspace: RESOLVED,
    })
    const { port, seeds } = makeDelivery()
    const deps = makeDeps({ opener, delivery: port })

    const value = await openWindow(
      deps,
      { scenario: 'continuation', seedText: '跨区干活', targetWorkspace: '/repos/backend' },
      EXEC,
    )

    expect(value.success).toBe(true)
    expect(value.target_workspace).toEqual(TARGET)
    expect(calls.workspaceQueries).toEqual(['/repos/backend'])
    expect(calls.create).toHaveLength(1)
    expect(calls.create[0]).toMatchObject({ workspaceId: 'ws-2' })
    expect(calls.fork).toHaveLength(0)
    const text = String((seeds[0]?.message as { content?: { text?: string }[] }).content?.[0]?.text)
    expect(text).toContain('target_workspace: 后端仓库 (/repos/backend)')
  })

  it('branch + mode=create 跨区仍落 run、武装回调，且 child 就是跨区会话', async () => {
    const { opener, calls } = makeOpener({
      registryProject: { workspaceId: 'ws-1' },
      workspace: RESOLVED,
    })
    const { port } = makeDelivery()
    const store = new MemoryRunStore()
    const deps = makeDeps({ opener, delivery: port, runStore: store })

    const value = await openWindow(
      deps,
      { scenario: 'branch', mode: 'create', seedText: '跨区分支', targetWorkspace: '后端仓库' },
      EXEC,
    )

    expect(value).toMatchObject({
      success: true,
      scenario: 'branch',
      mode: 'create',
      run_id: 'run-1',
      callback_armed: true,
    })
    expect(value.target_workspace).toEqual(TARGET)
    expect(calls.create[0]).toMatchObject({ workspaceId: 'ws-2' })
    expect(await store.get('run-1')).toMatchObject({
      childSessionId: 'session-child',
      status: 'running',
      callbackArmed: true,
    })
  })

  it('branch 默认 fork 与 target_workspace 组合被拒，且不建窗', async () => {
    const { opener, calls } = makeOpener({ registryProject: { workspaceId: 'ws-1' }, workspace: RESOLVED })
    const { port } = makeDelivery()
    const deps = makeDeps({ opener, delivery: port, runStore: new MemoryRunStore() })

    await expect(openWindow(deps, { scenario: 'branch', seedText: 'x', targetWorkspace: 'ws-2' }, EXEC))
      .rejects.toMatchObject({ code: 'WINDOW_WORKSPACE_UNSUPPORTED' })

    expect(calls.fork).toHaveLength(0)
    expect(calls.create).toHaveLength(0)
  })

  it('目标工作区不存在时响亮失败并给候选，不退回源工作区', async () => {
    const { opener, calls } = makeOpener({
      registryProject: { workspaceId: 'ws-1' },
      workspace: {
        ok: false,
        code: 'not_found',
        reason: '没有匹配的工作区：ghost',
        candidates: [TARGET],
      },
    })
    const { port } = makeDelivery()
    const deps = makeDeps({ opener, delivery: port })

    const error = await openWindow(
      deps,
      { scenario: 'continuation', seedText: 'x', targetWorkspace: 'ghost' },
      EXEC,
    ).catch((caught: unknown) => caught)

    expect(error).toBeInstanceOf(WindowError)
    expect((error as WindowError).code).toBe('WINDOW_WORKSPACE_NOT_FOUND')
    expect((error as WindowError).message).toContain('后端仓库')
    expect(calls.create).toHaveLength(0)
    expect(calls.fork).toHaveLength(0)
  })

  it('目标工作区命中多个时拒绝，不猜一个', async () => {
    const { opener, calls } = makeOpener({
      registryProject: { workspaceId: 'ws-1' },
      workspace: {
        ok: false,
        code: 'ambiguous',
        reason: '工作区查询「后端」按标题命中 2 个',
        candidates: [TARGET, { id: 'ws-3', title: '后端仓库', path: '/repos/backend-copy' }],
      },
    })
    const { port } = makeDelivery()
    const deps = makeDeps({ opener, delivery: port })

    await expect(openWindow(
      deps,
      { scenario: 'continuation', seedText: 'x', targetWorkspace: '后端' },
      EXEC,
    )).rejects.toMatchObject({ code: 'WINDOW_WORKSPACE_AMBIGUOUS' })
    expect(calls.create).toHaveLength(0)
  })

  it('宿主没有工作区解析能力时 WINDOW_WORKSPACE_UNAVAILABLE', async () => {
    const { opener, calls } = makeOpener({ registryProject: { workspaceId: 'ws-1' } })
    const { port } = makeDelivery()
    const deps = makeDeps({ opener, delivery: port })

    await expect(openWindow(
      deps,
      { scenario: 'continuation', seedText: 'x', targetWorkspace: 'ws-2' },
      EXEC,
    )).rejects.toMatchObject({ code: 'WINDOW_WORKSPACE_UNAVAILABLE' })
    expect(calls.create).toHaveLength(0)
  })

  it('target_workspace 与 topic_id 暂不能组合，在建窗与主题读写前拒绝', async () => {
    const { opener, calls } = makeOpener({ registryProject: { workspaceId: 'ws-1' }, workspace: RESOLVED })
    const { port } = makeDelivery()
    const deps = makeDeps({ opener, delivery: port, runStore: new MemoryRunStore() })

    await expect(openWindow(
      deps,
      { scenario: 'branch', mode: 'create', seedText: 'x', targetWorkspace: 'ws-2', topicId: 'topic-1' },
      EXEC,
    )).rejects.toMatchObject({ code: 'WINDOW_WORKSPACE_UNSUPPORTED' })
    expect(calls.create).toHaveLength(0)
  })

  it('target_workspace 为纯空白在归一阶段拒绝', () => {
    expect(() => normalizeOpenWindowInput({
      scenario: 'continuation',
      seedText: 'x',
      targetWorkspace: '   ',
    })).toThrowError(WindowError)
  })
})

describe('branch 常驻契约接线', () => {
  it('branch 建完 run 立刻 attach（不等 agent/created），continuation 不 attach', async () => {
    const store = new MemoryRunStore()
    const { opener } = makeOpener({ registryProject: { cwd: '/ws' } })
    const { port } = makeDelivery()
    const attached: { id: string; text: string }[] = []
    const deps = {
      ...makeDeps({ opener, delivery: port, runStore: store }),
      branchPrompts: { watch: () => () => undefined, attach: (id: string, text: string) => { attached.push({ id, text }); return true } },
    }

    const branch = await openWindow(deps, { scenario: 'branch', seedText: '做事' }, EXEC)
    expect(attached).toHaveLength(1)
    expect(attached[0]!.id).toBe(branch.window_key)
    expect(attached[0]!.text).toContain(`run_id: ${branch.run_id}`)
    expect(attached[0]!.text).toContain('window_complete')

    const continuation = await openWindow(deps, { scenario: 'continuation', seedText: '接手' }, EXEC)
    expect((await store.get(branch.run_id!))?.contractAttached).toBe(true)
    expect(continuation.run_id).toBeUndefined()
    expect(attached).toHaveLength(1) // continuation 没有 run，不注入
  })

  it('run 落盘失败时不 attach（没有可挂的对象）', async () => {
    class BrokenCreateStore extends MemoryRunStore {
      override async create(): Promise<void> { throw new Error('create boom') }
    }
    const { opener } = makeOpener()
    const { port } = makeDelivery()
    const attached: string[] = []
    const deps = {
      ...makeDeps({ opener, delivery: port, runStore: new BrokenCreateStore() }),
      branchPrompts: { watch: () => () => undefined, attach: (id: string) => { attached.push(id); return true } },
    }
    const value = await openWindow(deps, { scenario: 'branch', seedText: '做事' }, EXEC)
    expect(value.success).toBe(false)
    expect(attached).toEqual([])
  })
})

describe('重复开窗观测（只记录、不拦截）', () => {
  function counterDeps(store: MemoryRunStore): OpenWindowDeps {
    const { opener } = makeOpener()
    const { port } = makeDelivery()
    let index = 0
    return {
      ...makeDeps({ opener, delivery: port, runStore: store }),
      // makeDeps 的 resolveWindowKey 是固定 ORIGIN；这里要按真实 exec 取，才能测「不同 origin」。
      resolveWindowKey: (exec) => (exec as { agent: { id: string } }).agent.id,
      newRunId: () => `run-${++index}`,
    }
  }

  it('同源同 seed 的第二次开窗：照常建窗，但回执带 duplicate_of 与处置建议', async () => {
    const store = new MemoryRunStore()
    const deps = counterDeps(store)
    const first = await openWindow(deps, { scenario: 'branch', seedText: '同样的任务' }, EXEC)
    expect(first.duplicate_of).toBeUndefined()
    expect((await store.get(first.run_id!))?.openKey).toBeDefined()

    const second = await openWindow(deps, { scenario: 'branch', seedText: '同样的任务' }, EXEC)
    expect(second.success).toBe(true)
    expect(second.window_key).toBeDefined()
    expect(second.duplicate_of).toEqual([first.run_id!])
    expect(second.duplicate_note).toContain('未被拦截')
    expect((await store.get(second.run_id!))?.duplicateOf).toEqual([first.run_id!])
    // 两条 run 都在：观测不改变既有行为。
    expect((await store.list())).toHaveLength(2)
  })

  it('seed 不同 / origin 不同：不算重复', async () => {
    const store = new MemoryRunStore()
    const deps = counterDeps(store)
    await openWindow(deps, { scenario: 'branch', seedText: '任务 A' }, EXEC)

    const differentSeed = await openWindow(deps, { scenario: 'branch', seedText: '任务 B' }, EXEC)
    expect(differentSeed.duplicate_of).toBeUndefined()

    const otherOrigin = await openWindow(
      deps,
      { scenario: 'branch', seedText: '任务 A' },
      { agent: { id: 'session-other', status: 'running' } },
    )
    expect(otherOrigin.duplicate_of).toBeUndefined()
  })

  it('第一条 run 已终态时不再报重复（重跑同一个任务是合法的）', async () => {
    const store = new MemoryRunStore()
    const deps = counterDeps(store)
    const first = await openWindow(deps, { scenario: 'branch', seedText: '任务 A' }, EXEC)
    await store.update(first.run_id!, {
      status: 'completed',
      result: { status: 'completed', content: '完成', completedAt: 2, completedBy: 'session-child' },
    })

    const again = await openWindow(deps, { scenario: 'branch', seedText: '任务 A' }, EXEC)
    expect(again.duplicate_of).toBeUndefined()
  })

  it('观测探针不阻断建窗：读 run 记录失败也照常开窗', async () => {
    class BrokenListStore extends MemoryRunStore {
      override async list(): Promise<RunRecord[]> {
        throw new Error('list boom')
      }
    }
    const store = new BrokenListStore()
    const deps = counterDeps(store)
    const value = await openWindow(deps, { scenario: 'branch', seedText: '任务 A' }, EXEC)
    expect(value.success).toBe(true)
    expect(value.duplicate_of).toBeUndefined()
  })
})

describe('origin 级并发上限（安全阀，不排队）', () => {
  function cappedDeps(store: MemoryRunStore, limit: number): { deps: OpenWindowDeps; calls: { fork: number; create: number } } {
    const { opener, calls } = makeOpener({ registryProject: { cwd: '/ws' } })
    const { port } = makeDelivery()
    let index = 0
    return {
      deps: {
        ...makeDeps({ opener, delivery: port, runStore: store }),
        resolveWindowKey: (exec) => (exec as { agent: { id: string } }).agent.id,
        newRunId: () => `run-${++index}`,
        maxActiveRunsPerOrigin: limit,
      },
      calls: { get fork() { return calls.fork.length }, get create() { return calls.create.length } },
    }
  }

  async function activeRun(store: MemoryRunStore, over: Partial<RunRecord> = {}): Promise<void> {
    await store.create({
      runId: `run-active-${store.records.size}`,
      scenario: 'branch',
      originSessionId: ORIGIN,
      childSessionId: `child-${store.records.size}`,
      mode: 'fork',
      openKey: 'k-active',
      status: 'running',
      callbackArmed: true,
      createdAt: 1,
      updatedAt: 1,
      ...over,
    })
  }

  it('达到上限：拒绝且不建会话、不落 run', async () => {
    const store = new MemoryRunStore()
    await activeRun(store)
    await activeRun(store)
    const { deps, calls } = cappedDeps(store, 2)

    await expect(openWindow(deps, { scenario: 'branch', seedText: '再开一个' }, EXEC))
      .rejects.toMatchObject({ code: 'WINDOW_ORIGIN_BUSY' })
    expect(calls.fork).toBe(0)
    expect(calls.create).toBe(0)
    expect(store.records.size).toBe(2)
  })

  it('错误读数带 active / limit / active_run_ids，便于模型自己收口', async () => {
    const store = new MemoryRunStore()
    await activeRun(store, { runId: 'run-a' })
    const { deps } = cappedDeps(store, 1)
    try {
      await openWindow(deps, { scenario: 'branch', seedText: 'x' }, EXEC)
      throw new Error('should have thrown')
    } catch (error) {
      expect(error).toMatchObject({ code: 'WINDOW_ORIGIN_BUSY', details: { active: 1, limit: 1 } })
      expect((error as { details?: { active_run_ids?: string[] } }).details?.active_run_ids).toEqual(['run-a'])
    }
  })

  it('终态 / 已 stop / 别人的 run 都不占额度', async () => {
    const store = new MemoryRunStore()
    await activeRun(store, { runId: 'run-done', status: 'completed' })
    await activeRun(store, { runId: 'run-stopped', lifecycle: { state: 'stopped', at: 1 } })
    await activeRun(store, { runId: 'run-other', originSessionId: 'session-other' })
    const { deps } = cappedDeps(store, 1)

    const value = await openWindow(deps, { scenario: 'branch', seedText: 'x' }, EXEC)
    expect(value.success).toBe(true)
  })

  it('上限之下照常开窗；continuation 不受额度影响', async () => {
    const store = new MemoryRunStore()
    await activeRun(store)
    const { deps } = cappedDeps(store, 2)

    const branch = await openWindow(deps, { scenario: 'branch', seedText: 'a' }, EXEC)
    expect(branch.success).toBe(true)

    // 此时 branch 已到 2 条上限；continuation 没有 run，不该被额度挡住。
    const continuation = await openWindow(deps, { scenario: 'continuation', seedText: '接手' }, EXEC)
    expect(continuation.success).toBe(true)
    expect(continuation.run_id).toBeUndefined()
  })
})
