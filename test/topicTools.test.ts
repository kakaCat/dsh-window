import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { validateJsonSchemaValue, type ToolRunContext } from '@deepseek-ai/dsh-tools'
import { JsonSchemaGuard } from '../src/adapters/jsonSchemaGuard.js'
import { FsTopicStore } from '../src/adapters/topicStore.js'
import type {
  RunControlEvent,
  RunRecord,
  RunStorePort,
  SeedDeliveryPort,
  TopicProjectRef,
  TopicRef,
  WindowDeps,
  WindowOpenerPort,
} from '../src/application/ports.js'
import { openWindow } from '../src/application/openWindow.js'
import { topicAppend, topicClaim, topicCreate, topicGet, topicJoin } from '../src/application/topicLedger.js'
import { defineWindowCompleteTool } from '../src/tools/windowRunTools.js'
import {
  defineWindowTopicAppendTool,
  defineWindowTopicClaimTool,
  defineWindowTopicCreateTool,
  defineWindowTopicGetTool,
  defineWindowTopicJoinTool,
} from '../src/tools/windowTopicTools.js'

const ORIGIN = 'w-a'
const CHILD = 'w-c'
const PEER = 'w-b'
const STRANGER = 'w-d'

const PROJECT: TopicProjectRef = { projectId: 'ws-1', source: 'workspaceId' }
const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['summary'],
  properties: { summary: { type: 'string' } },
}

const roots: string[] = []

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-window-topic-tools-'))
  roots.push(root)
  return root
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(async (root) => rm(root, { recursive: true, force: true })))
})

/** 内存 run store：只服务开窗/完成链路，行为与 toolOutputs.test.ts 保持一致。 */
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

interface OpenerCalls {
  fork: number
  create: number
}

/** 宿主开窗桩：项目落点固定 ws-1，fork/create 都返回同一个 child。 */
function makeOpener(calls: OpenerCalls): WindowOpenerPort {
  return {
    available: () => true,
    fork: async (source) => {
      calls.fork += 1
      return { ok: true, windowKey: CHILD, parentSessionId: source }
    },
    create: async () => {
      calls.create += 1
      return { ok: true, windowKey: CHILD }
    },
    resolveSourceProject: () => ({ workspaceId: 'ws-1' }),
    readProfile: async () => ({}),
    rename: async () => undefined,
    selectModel: async () => undefined,
  }
}

interface Delivery {
  port: SeedDeliveryPort
  seeds: { target: string; params: { kind: string; scenario: string; runId?: string; text: string } }[]
  callbacks: { target: string; text: string }[]
}

function makeDelivery(): Delivery {
  const seeds: Delivery['seeds'] = []
  const callbacks: Delivery['callbacks'] = []
  const port: SeedDeliveryPort = {
    createMessage: (params) => ({
      message: { content: [{ type: 'text', text: params.text }], source: { kind: params.kind } },
      messageId: params.messageId ?? `message-${seeds.length + callbacks.length}`,
    }),
    deliver: async (target, message) => {
      const text = (message as { content?: { text?: string }[] }).content?.[0]?.text ?? ''
      const kind = (message as { source?: { kind?: string } }).source?.kind ?? ''
      if (kind === 'dsh-window-result') callbacks.push({ target, text })
      else seeds.push({ target, params: { kind, scenario: '', text } })
      return { delivered: true }
    },
  }
  return { port, seeds, callbacks }
}

interface Harness {
  deps: WindowDeps
  store?: FsTopicStore
  runStore: MemoryRunStore
  delivery: Delivery
  openerCalls: OpenerCalls
  clock: { value: number }
}

/** 组装一份最小依赖；`withTopicStore=false` 用来验证存储不可用时的响亮失败。 */
async function makeHarness(options: { withTopicStore?: boolean } = {}): Promise<Harness> {
  const withTopicStore = options.withTopicStore !== false
  const root = await tempRoot()
  const clock = { value: 1_000 }
  const store = withTopicStore ? new FsTopicStore({ root, now: () => clock.value }) : undefined
  const runStore = new MemoryRunStore()
  const delivery = makeDelivery()
  const openerCalls: OpenerCalls = { fork: 0, create: 0 }
  let counter = 0
  const deps: WindowDeps = {
    resolveWindowKey: (exec) => (exec as { agent: { id: string } }).agent.id,
    requireLiveDriver: vi.fn(),
    windowOpener: makeOpener(openerCalls),
    seedDelivery: delivery.port,
    runStore,
    ...(store === undefined ? {} : { topicStore: store }),
    schemaGuard: new JsonSchemaGuard(),
    now: () => clock.value,
    newRunId: () => `id-${++counter}`,
  }
  return {
    deps,
    ...(store === undefined ? {} : { store }),
    runStore,
    delivery,
    openerCalls,
    clock,
  }
}

function exec(id: string): ToolRunContext {
  return { agent: { id } } as unknown as ToolRunContext
}

interface ToolLike {
  output: { schema: unknown }
  execute: (args: unknown, exec: unknown) => Promise<unknown>
}

/** 执行工具并断言回执符合它自己声明的 output schema。 */
async function runTool(tool: unknown, args: unknown, id: string): Promise<Record<string, unknown>> {
  const typed = tool as ToolLike
  const value = await typed.execute(args, exec(id))
  expect(validateJsonSchemaValue(typed.output.schema as never, value)).toEqual([])
  return value as Record<string, unknown>
}

/** 建一个主题（ORIGIN 创建并成为 owner 参与者），返回 topic_id 与 revision。 */
async function createTopic(deps: WindowDeps, title = '协作主题', objective = '同一目标'): Promise<{ topicId: string; revision: number }> {
  const created = await topicCreate(deps, { topicId: 'topic-1', title, objective }, exec(ORIGIN))
  return { topicId: created.topic_id, revision: created.revision }
}

async function currentRevision(store: FsTopicStore, topicId: string): Promise<number> {
  const ref: TopicRef = { project: PROJECT, topicId }
  return (await store.getTopic(ref))?.revision ?? 0
}

describe('window_topic_* 回执符合 output schema', () => {
  it('create / join / get / append / claim 五个工具', async () => {
    const { deps, store } = await makeHarness()
    const created = await runTool(defineWindowTopicCreateTool(deps), { topic_id: 'topic-1', title: '协作主题', objective: '同一目标' }, ORIGIN)
    expect(created['created']).toBe(true)

    const joined = await runTool(defineWindowTopicJoinTool(deps), { topic_id: 'topic-1', scenario: 'branch' }, PEER)
    expect((joined['participant'] as Record<string, unknown>)['window_key']).toBe(PEER)

    const read = await runTool(defineWindowTopicGetTool(deps), { topic_id: 'topic-1' }, ORIGIN)
    expect((read['topic'] as Record<string, unknown>)['topic_id']).toBe('topic-1')

    const appended = await runTool(
      defineWindowTopicAppendTool(deps),
      { topic_id: 'topic-1', kind: 'progress', content: '第一步完成' },
      ORIGIN,
    )
    expect(appended['kind']).toBe('progress')

    const revision = await currentRevision(store!, 'topic-1')
    const claimed = await runTool(
      defineWindowTopicClaimTool(deps),
      { topic_id: 'topic-1', scope: 'src/a.ts', action: 'acquire', base_revision: revision, lease_ms: 60_000 },
      ORIGIN,
    )
    expect(claimed['expires_at']).toBe(1_000 + 60_000)

    await runTool(
      defineWindowTopicClaimTool(deps),
      { topic_id: 'topic-1', scope: 'src/a.ts', action: 'release' },
      ORIGIN,
    )
  })
})

describe('共享读取与金字塔分层（FR-11）', () => {
  it('create 幂等、creator 成为参与者、目标不一致被拒', async () => {
    const { deps } = await makeHarness()
    const first = await topicCreate(deps, { topicId: 'topic-1', title: 'T', objective: '同一目标' }, exec(ORIGIN))
    expect(first.created).toBe(true)
    expect(first.revision).toBe(1)
    expect(first.participant).toMatchObject({ window_key: ORIGIN, role: 'owner', status: 'active' })

    const again = await topicCreate(deps, { topicId: 'topic-1', title: '改个标题', objective: '同一目标' }, exec(ORIGIN))
    expect(again.created).toBe(false)
    expect(again.revision).toBe(1)

    await expect(
      topicCreate(deps, { topicId: 'topic-1', title: 'T', objective: '换目标' }, exec(ORIGIN)),
    ).rejects.toMatchObject({ code: 'WINDOW_TOPIC_CONFLICT' })

    const generated = await topicCreate(deps, { title: 'T2', objective: 'O2' }, exec(ORIGIN))
    expect(generated.topic_id.length).toBeGreaterThan(0)
    expect(generated.topic_id).not.toBe('topic-1')
  })

  it('省略 topic_id 只给 L0/L1；提供时给 L2 与最近 L3；非参与者被拒', async () => {
    const { deps } = await makeHarness()
    const { topicId } = await createTopic(deps)
    const peer = await topicJoin(deps, { topicId, scenario: 'continuation' }, exec(PEER))
    const child = await topicJoin(deps, { topicId, scenario: 'branch' }, exec(CHILD))
    expect(peer.snapshot.summary?.revision).toBe(1)
    expect(child.snapshot.summary?.revision).toBe(1)

    const overview = await topicGet(deps, {}, exec(STRANGER))
    expect(overview.topic).toBeUndefined()
    expect(overview.entries).toBeUndefined()
    expect(overview.projects).toHaveLength(1)
    expect(overview.projects[0]?.topics[0]).toMatchObject({ topic_id: topicId, participant_count: 3, revision: 1 })

    const detail = await topicGet(deps, { topicId }, exec(ORIGIN))
    expect(detail.topic).toMatchObject({ topic_id: topicId, title: '协作主题', objective: '同一目标' })
    expect(detail.summary?.participants.map((item) => item.window_key).sort()).toEqual([CHILD, ORIGIN, PEER].sort())
    expect(detail.entries).toEqual([])
    expect(detail.entry_total).toBe(0)

    await expect(topicGet(deps, { topicId }, exec(STRANGER)))
      .rejects.toMatchObject({ code: 'WINDOW_TOPIC_FORBIDDEN' })
    await expect(topicAppend(deps, { topicId, kind: 'progress', content: '偷写' }, exec(STRANGER)))
      .rejects.toMatchObject({ code: 'WINDOW_TOPIC_FORBIDDEN' })
    await expect(topicClaim(deps, { topicId, scope: 's', action: 'acquire', baseRevision: 1 }, exec(STRANGER)))
      .rejects.toMatchObject({ code: 'WINDOW_TOPIC_FORBIDDEN' })
  })

  it('A/B/C 三个参与者读到同一 L0/L1 与同一 revision（AC-18 一致性）', async () => {
    const { deps } = await makeHarness()
    const { topicId } = await createTopic(deps)
    await topicJoin(deps, { topicId, scenario: 'continuation' }, exec(PEER))
    await topicJoin(deps, { topicId, scenario: 'branch' }, exec(CHILD))

    const overviews = await Promise.all([ORIGIN, PEER, CHILD].map(async (windowKey) => await topicGet(deps, {}, exec(windowKey))))
    const shapes = overviews.map((overview) => JSON.stringify(overview.projects))
    expect(new Set(shapes).size).toBe(1)
    expect(overviews.map((overview) => overview.projects[0]?.topics[0]?.revision)).toEqual([1, 1, 1])

    await topicAppend(deps, { topicId, kind: 'progress', content: 'A 的进度' }, exec(ORIGIN))
    const details = await Promise.all([ORIGIN, PEER, CHILD].map(async (windowKey) => await topicGet(deps, { topicId }, exec(windowKey))))
    expect(details.map((detail) => detail.summary?.revision)).toEqual([2, 2, 2])
    expect(details.every((detail) => detail.entries?.[0]?.content === 'A 的进度')).toBe(true)
  })

  it('L3 明细分页读取，默认只给最近一页', async () => {
    const { deps, store } = await makeHarness()
    const { topicId } = await createTopic(deps)
    for (let index = 1; index <= 5; index += 1) {
      await topicAppend(deps, { topicId, kind: 'progress', content: `进度 ${index}` }, exec(ORIGIN))
    }
    const first = await topicGet(deps, { topicId, limit: 2 }, exec(ORIGIN))
    expect(first.entries?.map((entry) => entry.content)).toEqual(['进度 5', '进度 4'])
    expect(first.entry_total).toBe(5)
    expect(first.next_cursor).toBe('2')

    const second = await topicGet(deps, { topicId, limit: 2, cursor: first.next_cursor }, exec(ORIGIN))
    expect(second.entries?.map((entry) => entry.content)).toEqual(['进度 3', '进度 2'])

    expect((await currentRevision(store!, topicId))).toBe(6)
  })

  it('新实例重启后恢复主题、参与者与明细，revision 严格递增', async () => {
    const harness = await makeHarness()
    const { topicId } = await createTopic(harness.deps)
    await topicJoin(harness.deps, { topicId, scenario: 'continuation' }, exec(PEER))
    await topicAppend(harness.deps, { topicId, kind: 'progress', content: '重启前' }, exec(ORIGIN))

    const restarted = new FsTopicStore({ root: harness.store!.layout.root, now: () => harness.clock.value })
    const deps: WindowDeps = { ...harness.deps, topicStore: restarted }
    const detail = await topicGet(deps, { topicId }, exec(ORIGIN))
    expect(detail.summary?.revision).toBe(2)
    expect(detail.summary?.entry_count).toBe(1)
    expect(detail.entries?.map((entry) => entry.content)).toEqual(['重启前'])

    const next = await topicAppend(deps, { topicId, kind: 'progress', content: '重启后' }, exec(ORIGIN))
    expect(next.revision).toBe(3)
  })
})

describe('revision CAS 与冲突解决（FR-12）', () => {
  it('旧 base_revision 返回 WINDOW_TOPIC_STALE 且不覆盖他人记录', async () => {
    const { deps } = await makeHarness()
    const { topicId } = await createTopic(deps)
    await topicJoin(deps, { topicId, scenario: 'continuation' }, exec(PEER))

    const first = await topicAppend(
      deps,
      { topicId, kind: 'decision', content: '采用方案甲', decisionKey: 'k', baseRevision: 1 },
      exec(ORIGIN),
    )
    expect(first.effective).toBe(true)
    expect(first.revision).toBe(2)

    try {
      await topicAppend(
        deps,
        { topicId, kind: 'decision', content: '采用方案乙', decisionKey: 'k', baseRevision: 1 },
        exec(PEER),
      )
      throw new Error('should have thrown')
    } catch (error: unknown) {
      expect(error).toMatchObject({ code: 'WINDOW_TOPIC_STALE' })
      expect((error as { details?: Record<string, unknown> }).details).toMatchObject({ current_revision: 2 })
    }

    const detail = await topicGet(deps, { topicId }, exec(ORIGIN))
    expect(detail.summary?.entry_count).toBe(1)
  })

  it('并发写入同一 base_revision 只有一个成功', async () => {
    const { deps } = await makeHarness()
    const { topicId } = await createTopic(deps)
    await topicJoin(deps, { topicId, scenario: 'continuation' }, exec(PEER))

    const results = await Promise.allSettled([
      topicAppend(deps, { topicId, kind: 'decision', content: '甲', decisionKey: 'k', baseRevision: 1 }, exec(ORIGIN)),
      topicAppend(deps, { topicId, kind: 'decision', content: '乙', decisionKey: 'k2', baseRevision: 1 }, exec(PEER)),
    ])
    const ok = results.filter((item) => item.status === 'fulfilled')
    const rejected = results.filter((item) => item.status === 'rejected')
    expect(ok).toHaveLength(1)
    expect(rejected).toHaveLength(1)
    expect((rejected[0] as PromiseRejectedResult).reason).toMatchObject({ code: 'WINDOW_TOPIC_STALE' })
  })

  it('同 decision_key 不同结论只存 candidate 并形成 unresolved conflict；resolution 后生效', async () => {
    const { deps } = await makeHarness()
    const { topicId } = await createTopic(deps)
    await topicJoin(deps, { topicId, scenario: 'branch' }, exec(PEER))

    await topicAppend(deps, { topicId, kind: 'decision', content: '采用方案甲', decisionKey: 'k', baseRevision: 1 }, exec(ORIGIN))
    const candidate = await topicAppend(
      deps,
      { topicId, kind: 'decision', content: '采用方案乙', decisionKey: 'k', baseRevision: 2 },
      exec(PEER),
    )
    expect(candidate.effective).toBe(false)
    expect(candidate.candidate_entry_id).toBe(candidate.entry_id)
    expect(candidate.conflict?.status).toBe('unresolved')

    const summaryBefore = await topicGet(deps, { topicId }, exec(ORIGIN))
    expect(summaryBefore.summary?.unresolved_conflicts).toHaveLength(1)
    expect(summaryBefore.summary?.effective_decisions.map((item) => item.entry_id)).toEqual([candidate.conflict?.entry_ids[1]])

    const resolution = await topicAppend(
      deps,
      {
        topicId,
        kind: 'resolution',
        content: '采用方案乙更合适',
        conflictId: candidate.conflict_id,
        supersedesEntryId: candidate.entry_id,
        supersedesReason: '乙覆盖甲的场景',
        baseRevision: 3,
      },
      exec(PEER),
    )
    expect(resolution.effective).toBe(true)
    expect(resolution.conflict?.status).toBe('resolved')

    const summaryAfter = await topicGet(deps, { topicId }, exec(ORIGIN))
    expect(summaryAfter.summary?.unresolved_conflicts).toHaveLength(0)
    expect(summaryAfter.summary?.effective_decisions.map((item) => item.entry_id)).toEqual([candidate.entry_id])
  })
})

describe('协作占用 claim（FR-12）', () => {
  it('同 scope 冲突、非 owner 不能 renew/release、过期后被接管', async () => {
    const { deps, clock } = await makeHarness()
    const { topicId } = await createTopic(deps)
    await topicJoin(deps, { topicId, scenario: 'continuation' }, exec(PEER))

    // claim 上挂的 run_id 现在有归属校验：先造一条属于 ORIGIN 的 run。
    await deps.runStore!.create({
      runId: 'run-1',
      scenario: 'branch',
      createdBy: 'open',
      originSessionId: ORIGIN,
      childSessionId: CHILD,
      mode: 'fork',
      status: 'running',
      callbackArmed: true,
      lastActivityAt: 1,
      createdAt: 1,
      updatedAt: 1,
    })

    const acquired = await topicClaim(
      deps,
      { topicId, scope: 'src/a.ts', action: 'acquire', baseRevision: 1, leaseMs: 1_000, runId: 'run-1' },
      exec(ORIGIN),
    )
    expect(acquired.action).toBe('acquire')
    expect(acquired.expires_at).toBe(2_000)
    expect(acquired.run_id).toBe('run-1')

    await expect(
      topicClaim(deps, { topicId, scope: 'src/a.ts', action: 'acquire', baseRevision: acquired.revision }, exec(PEER)),
    ).rejects.toMatchObject({ code: 'WINDOW_TOPIC_CLAIM_CONFLICT' })

    await expect(
      topicClaim(deps, { topicId, scope: 'src/a.ts', action: 'renew', leaseMs: 5_000 }, exec(PEER)),
    ).rejects.toMatchObject({ code: 'WINDOW_TOPIC_CLAIM_CONFLICT' })
    await expect(
      topicClaim(deps, { topicId, scope: 'src/a.ts', action: 'release' }, exec(PEER)),
    ).rejects.toMatchObject({ code: 'WINDOW_TOPIC_CLAIM_CONFLICT' })

    const renewed = await topicClaim(
      deps,
      { topicId, scope: 'src/a.ts', action: 'renew', leaseMs: 1_000 },
      exec(ORIGIN),
    )
    expect(renewed.action).toBe('renew')
    expect(renewed.expires_at).toBe(2_000)

    clock.value = 3_001
    const taken = await topicClaim(
      deps,
      { topicId, scope: 'src/a.ts', action: 'acquire', baseRevision: renewed.revision, leaseMs: 1_000 },
      exec(PEER),
    )
    expect(taken.action).toBe('takeover')
    expect(taken.took_over?.owner_window_key).toBe(ORIGIN)

    await expect(
      topicClaim(deps, { topicId, scope: 'src/a.ts', action: 'release' }, exec(ORIGIN)),
    ).rejects.toMatchObject({ code: 'WINDOW_TOPIC_CLAIM_CONFLICT' })

    const released = await topicClaim(deps, { topicId, scope: 'src/a.ts', action: 'release' }, exec(PEER))
    expect(released.released_at).toBe(3_001)

    await expect(
      topicClaim(deps, { topicId, scope: 'src/a.ts', action: 'renew', leaseMs: 1_000 }, exec(PEER)),
    ).rejects.toMatchObject({ code: 'WINDOW_TOPIC_CLAIM_NOT_FOUND' })

    await expect(
      topicClaim(deps, { topicId, scope: 'src/b.ts', action: 'acquire', baseRevision: released.revision, leaseMs: 0 }, exec(PEER)),
    ).rejects.toMatchObject({ code: 'WINDOW_INVALID_INPUT' })
    await expect(
      topicClaim(deps, { topicId, scope: 'src/b.ts', action: 'acquire' }, exec(PEER)),
    ).rejects.toMatchObject({ code: 'WINDOW_TOPIC_REVISION_REQUIRED' })
  })
})

describe('window_open 接入 topic（FR-11 / FR-5）', () => {
  it('branch 带 topic_id：origin/child 登记同一 revision、run 绑定主题、seed 带 revision', async () => {
    const { deps, runStore, delivery } = await makeHarness()
    const { topicId } = await createTopic(deps)

    const value = await openWindow(
      deps,
      { scenario: 'branch', seedText: '做分支', topicId, outputSchema: SCHEMA },
      exec(ORIGIN),
    )
    expect(value.topic_tracking).toBe(true)
    expect(value.topic_id).toBe(topicId)
    expect(value.topic_revision).toBe(1)
    expect(value.run_id).toBeDefined()

    const run = await runStore.get(value.run_id!)
    expect(run).toMatchObject({ topicId, startedTopicRevision: 1 })

    const detail = await topicGet(deps, { topicId }, exec(ORIGIN))
    // origin 在 create 时以 continuation 登记过；window_open(branch) 再登记一条 branch participation（§6.10 允许）。
    expect([...new Set(detail.summary?.participants.map((item) => item.window_key))].sort()).toEqual([CHILD, ORIGIN].sort())
    expect(detail.summary?.participants.every((item) => item.status === 'active')).toBe(true)
    // 主题 activeRuns 只是“已写台账的 run”指针；开窗绑定本身记录在 run store（window_list 可按 topic_id 过滤）。
    expect(detail.summary?.active_run_ids).toEqual([])

    expect(delivery.seeds[0]?.params.text).toContain(`topic_revision: 1`)
    expect(delivery.seeds[0]?.params.text).toContain('WINDOW_TOPIC_STALE')
  })

  it('continuation 也允许带 topic_id，且不产生 run', async () => {
    const { deps } = await makeHarness()
    const { topicId } = await createTopic(deps)
    const value = await openWindow(deps, { scenario: 'continuation', seedText: '续接', topicId }, exec(ORIGIN))
    expect(value.topic_tracking).toBe(true)
    expect(value.run_id).toBeUndefined()
    expect(value.topic_revision).toBe(1)

    const detail = await topicGet(deps, { topicId }, exec(ORIGIN))
    expect([...new Set(detail.summary?.participants.map((item) => item.window_key))].sort()).toEqual([CHILD, ORIGIN].sort())
  })

  it('省略 topic_id 时 topic_tracking=false，不声称具备协作能力', async () => {
    const { deps } = await makeHarness()
    const value = await openWindow(deps, { scenario: 'branch', seedText: '做分支' }, exec(ORIGIN))
    expect(value.topic_tracking).toBe(false)
    expect(value.topic_id).toBeUndefined()
  })

  it('主题不存在或存储不可用时在建会话前失败', async () => {
    const withStore = await makeHarness()
    await expect(
      openWindow(withStore.deps, { scenario: 'branch', seedText: '做分支', topicId: 'missing' }, exec(ORIGIN)),
    ).rejects.toMatchObject({ code: 'WINDOW_TOPIC_NOT_FOUND' })
    expect(withStore.openerCalls.fork).toBe(0)

    const withoutStore = await makeHarness({ withTopicStore: false })
    await expect(
      openWindow(withoutStore.deps, { scenario: 'branch', seedText: '做分支', topicId: 'topic-1' }, exec(ORIGIN)),
    ).rejects.toMatchObject({ code: 'WINDOW_TOPIC_STORAGE_UNAVAILABLE' })
    expect(withoutStore.openerCalls.fork).toBe(0)
    expect(withoutStore.openerCalls.create).toBe(0)
  })
})

describe('branch window_complete 自动写 completion（FR-6 / FR-12）', () => {
  it('completion entry 只存 completionId + 有界摘要，不复制 structured；回调带 topic 指针', async () => {
    const { deps, runStore, delivery } = await makeHarness()
    const { topicId } = await createTopic(deps)
    const opened = await openWindow(
      deps,
      { scenario: 'branch', seedText: '做分支', topicId, outputSchema: SCHEMA, resultRequired: true },
      exec(ORIGIN),
    )
    const runId = opened.run_id!
    const payload = { summary: 'TOP_SECRET_PAYLOAD_9f3' }

    const completeTool = defineWindowCompleteTool(deps)
    const completed = await runTool(
      completeTool,
      { run_id: runId, status: 'completed', content: '分支结论：完成', structured: payload, base_revision: opened.topic_revision },
      CHILD,
    )
    expect(completed['success']).toBe(true)
    expect(completed['completion_entry_id']).toBeDefined()
    expect(completed['topic_revision']).toBe(2)

    const run = await runStore.get(runId)
    expect(run?.result?.structured).toEqual(payload)
    expect(run?.result?.completionEntryId).toBe(completed['completion_entry_id'])
    expect(run?.result?.content).toBe('分支结论：完成')
    expect(delivery.callbacks[0]?.text).toContain(`topic_id: ${topicId}`)
    expect(delivery.callbacks[0]?.text).toContain(`completion_entry_id: ${String(completed['completion_entry_id'])}`)

    const detail = await topicGet(deps, { topicId }, exec(ORIGIN))
    const completion = detail.summary?.last_completions[0]
    expect(completion).toMatchObject({ completion_id: completed['completion_entry_id'], run_id: runId })
    const entry = detail.entries?.find((item) => item.kind === 'completion')
    expect(entry?.content).toBe('分支结论：完成')
    expect(JSON.stringify(detail.entries)).not.toContain('TOP_SECRET_PAYLOAD_9f3')
  })

  it('base_revision 过期或缺失时在保存结果与回调前停止', async () => {
    const { deps, runStore, delivery } = await makeHarness()
    const { topicId } = await createTopic(deps)
    const opened = await openWindow(deps, { scenario: 'branch', seedText: '做分支', topicId }, exec(ORIGIN))
    const runId = opened.run_id!

    await expect(
      defineWindowCompleteTool(deps).execute({ run_id: runId, status: 'completed', content: 'x' }, exec(CHILD)),
    ).rejects.toMatchObject({ code: 'WINDOW_TOPIC_REVISION_REQUIRED' })
    await expect(
      defineWindowCompleteTool(deps).execute({ run_id: runId, status: 'completed', content: 'x', base_revision: 0 }, exec(CHILD)),
    ).rejects.toMatchObject({ code: 'WINDOW_TOPIC_STALE' })

    expect((await runStore.get(runId))?.status).toBe('running')
    expect((await runStore.get(runId))?.result).toBeUndefined()
    expect(delivery.callbacks).toHaveLength(0)
  })

  it('存在与本 run 相关的 unresolved conflict 时返回 WINDOW_TOPIC_CONFLICT', async () => {
    const { deps, runStore, delivery } = await makeHarness()
    const { topicId } = await createTopic(deps)
    const opened = await openWindow(deps, { scenario: 'branch', seedText: '做分支', topicId }, exec(ORIGIN))
    const runId = opened.run_id!

    // child 自己制造一个与本主题相关的未解决冲突。
    await topicAppend(
      deps,
      { topicId, kind: 'decision', content: '采用甲', decisionKey: 'k', baseRevision: opened.topic_revision },
      exec(CHILD),
    )
    const candidate = await topicAppend(
      deps,
      { topicId, kind: 'decision', content: '采用乙', decisionKey: 'k', baseRevision: 2 },
      exec(CHILD),
    )
    expect(candidate.conflict?.status).toBe('unresolved')

    await expect(
      defineWindowCompleteTool(deps).execute(
        { run_id: runId, status: 'completed', content: '收尾', base_revision: candidate.revision },
        exec(CHILD),
      ),
    ).rejects.toMatchObject({ code: 'WINDOW_TOPIC_CONFLICT' })
    expect((await runStore.get(runId))?.result).toBeUndefined()
    expect(delivery.callbacks).toHaveLength(0)

    // 解决冲突后即可完成。
    const resolved = await topicAppend(
      deps,
      {
        topicId,
        kind: 'resolution',
        content: '采纳乙',
        conflictId: candidate.conflict_id,
        supersedesEntryId: candidate.entry_id,
        supersedesReason: '乙覆盖甲',
        baseRevision: candidate.revision,
      },
      exec(CHILD),
    )
    const done = await defineWindowCompleteTool(deps).execute(
      { run_id: runId, status: 'completed', content: '收尾', base_revision: resolved.revision },
      exec(CHILD),
    ) as { success: boolean; completion_entry_id?: string }
    expect(done.success).toBe(true)
    expect(done.completion_entry_id).toBeDefined()
  })

  it('绑定 topic 的 run 未声明 base_revision 的旧式重复完成仍幂等', async () => {
    const { deps } = await makeHarness()
    const { topicId } = await createTopic(deps)
    const opened = await openWindow(deps, { scenario: 'branch', seedText: '做分支', topicId }, exec(ORIGIN))
    const runId = opened.run_id!
    const first = await defineWindowCompleteTool(deps).execute(
      { run_id: runId, status: 'completed', content: '结论', base_revision: opened.topic_revision },
      exec(CHILD),
    ) as { completion_entry_id?: string }
    const again = await defineWindowCompleteTool(deps).execute(
      { run_id: runId, status: 'completed', content: '结论', base_revision: opened.topic_revision },
      exec(CHILD),
    ) as { completion_entry_id?: string }
    expect(again.completion_entry_id).toBe(first.completion_entry_id)
    const detail = await topicGet(deps, { topicId }, exec(ORIGIN))
    expect(detail.entries?.filter((entry) => entry.kind === 'completion')).toHaveLength(1)
  })

  it('完成时自动释放该 run 的占用', async () => {
    const { deps } = await makeHarness()
    const { topicId } = await createTopic(deps)
    const opened = await openWindow(deps, { scenario: 'branch', seedText: '做分支', topicId }, exec(ORIGIN))
    const runId = opened.run_id!
    const claimed = await topicClaim(
      deps,
      { topicId, scope: 'src/a.ts', action: 'acquire', baseRevision: opened.topic_revision, leaseMs: 60_000, runId },
      exec(CHILD),
    )
    await defineWindowCompleteTool(deps).execute(
      { run_id: runId, status: 'completed', content: '收尾', base_revision: claimed.revision },
      exec(CHILD),
    )
    const detail = await topicGet(deps, { topicId }, exec(ORIGIN))
    expect(detail.summary?.active_claims).toHaveLength(0)
  })
})

describe('continuation 手工登记 completion（FR-4 / FR-11）', () => {
  it('append(kind=completion) 写台账但不触发任何回调', async () => {
    const { deps, delivery } = await makeHarness()
    const { topicId } = await createTopic(deps)
    const opened = await openWindow(deps, { scenario: 'continuation', seedText: '续接', topicId }, exec(ORIGIN))
    expect(opened.run_id).toBeUndefined()

    const appended = await topicAppend(
      deps,
      { topicId, kind: 'completion', content: '续接完成：结果留在本窗口', baseRevision: opened.topic_revision },
      exec(CHILD),
    )
    expect(appended.kind).toBe('completion')
    expect(appended.revision).toBe(2)

    const detail = await topicGet(deps, { topicId }, exec(ORIGIN))
    expect(detail.summary?.last_completions[0]?.summary).toBe('续接完成：结果留在本窗口')
    expect(delivery.callbacks).toHaveLength(0)
  })
})

describe('topic 存储不可用', () => {
  it('所有 window_topic_* 都返回 WINDOW_TOPIC_STORAGE_UNAVAILABLE', async () => {
    const { deps } = await makeHarness({ withTopicStore: false })
    const cases: (() => Promise<unknown>)[] = [
      async () => await topicCreate(deps, { title: 'T', objective: 'O' }, exec(ORIGIN)),
      async () => await topicJoin(deps, { topicId: 'topic-1' }, exec(ORIGIN)),
      async () => await topicGet(deps, {}, exec(ORIGIN)),
      async () => await topicAppend(deps, { topicId: 'topic-1', kind: 'progress', content: 'x' }, exec(ORIGIN)),
      async () => await topicClaim(deps, { topicId: 'topic-1', scope: 's', action: 'release' }, exec(ORIGIN)),
    ]
    for (const run of cases) {
      await expect(run()).rejects.toMatchObject({ code: 'WINDOW_TOPIC_STORAGE_UNAVAILABLE' })
    }
  })
})

describe('topic 写入安全语义（§8 / 审核发现）', () => {
  it('idempotencyKey：同 key 重试命中同一 entry、不重复落条、revision 不再推进', async () => {
    const { deps, store } = await makeHarness()
    const { topicId } = await createTopic(deps)

    const first = await topicAppend(
      deps,
      { topicId, kind: 'progress', content: '上报一次', idempotencyKey: 'retry-1' },
      exec(ORIGIN),
    )
    const second = await topicAppend(
      deps,
      { topicId, kind: 'progress', content: '上报一次', idempotencyKey: 'retry-1' },
      exec(ORIGIN),
    )

    expect(second.entry_id).toBe(first.entry_id)
    expect(second.revision).toBe(first.revision)
    const page = await store!.listEntries({ project: PROJECT, topicId })
    expect(page.total).toBe(1)

    // 同 key 换内容 = 想覆盖已落定记录 → 响亮拒绝，不静默改写。
    await expect(topicAppend(
      deps,
      { topicId, kind: 'progress', content: '换了内容', idempotencyKey: 'retry-1' },
      exec(ORIGIN),
    )).rejects.toMatchObject({ code: 'WINDOW_TOPIC_CONFLICT' })
    expect((await store!.listEntries({ project: PROJECT, topicId })).total).toBe(1)
  })

  it('带不属于调用者的 run_id 写完成 → WINDOW_RUN_FORBIDDEN；不存在 → RUN_NOT_FOUND；自己的 run 放行', async () => {
    const { deps, runStore, store } = await makeHarness()
    const { topicId } = await createTopic(deps)

    await runStore.create({
      runId: 'run-other',
      scenario: 'branch',
      originSessionId: 'w-x',
      childSessionId: 'w-y',
      mode: 'fork',
      status: 'running',
      callbackArmed: true,
      callback: { status: 'pending', callbackId: 'result-run-other', attempts: 0 },
      createdAt: 1,
      updatedAt: 1,
    })

    await expect(topicAppend(
      deps,
      { topicId, kind: 'completion', content: '代写完成', runId: 'run-other' },
      exec(ORIGIN),
    )).rejects.toMatchObject({ code: 'WINDOW_RUN_FORBIDDEN' })

    await expect(topicAppend(
      deps,
      { topicId, kind: 'completion', content: '代写完成', runId: 'run-missing' },
      exec(ORIGIN),
    )).rejects.toMatchObject({ code: 'WINDOW_RUN_NOT_FOUND' })

    // 自己的 run：放行（证明上面的拒绝是授权判定，不是一刀切禁用 runId）。
    await runStore.create({
      runId: 'run-mine',
      scenario: 'branch',
      originSessionId: ORIGIN,
      childSessionId: CHILD,
      mode: 'fork',
      status: 'running',
      callbackArmed: true,
      callback: { status: 'pending', callbackId: 'result-run-mine', attempts: 0 },
      lastActivityAt: 1,
      createdAt: 1,
      updatedAt: 1,
    })
    const revision = await currentRevision(store!, topicId)
    // completion 只能由该 run 的 child 写：origin 抢先写会占住 completionId，
    // 令 child 的真实完成被永久拒（二轮审核发现的反向漏洞）。
    await topicJoin(deps, { topicId, scenario: 'branch' }, exec(CHILD))
    await expect(topicAppend(
      deps,
      { topicId, kind: 'completion', content: 'origin 抢先完成', runId: 'run-mine', baseRevision: revision },
      exec(ORIGIN),
    )).rejects.toMatchObject({ code: 'WINDOW_RUN_FORBIDDEN' })

    // child 自己写才放行（证明上面的拒绝是归属判定，不是一刀切禁用 runId）。
    const mine = await topicAppend(
      deps,
      { topicId, kind: 'completion', content: 'child 自己的完成', runId: 'run-mine', baseRevision: revision },
      exec(CHILD),
    )
    expect(mine.kind).toBe('completion')
  })
})
