import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, normalize, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { GLOBAL_TOPIC_PROJECT } from '../src/application/ports.js'
import type { TopicEntryAppendInput, TopicProjectRef, TopicRef } from '../src/application/ports.js'
import {
  entryFileName,
  FsTopicStore,
  normalizeProjectId,
  projectHashOf,
  scopeHashOf,
  topicHashOf,
} from '../src/adapters/topicStore.js'

const roots: string[] = []

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-window-topic-'))
  roots.push(root)
  return root
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(async (root) => rm(root, { recursive: true, force: true })))
})

const PROJECT: TopicProjectRef = { projectId: 'project-alpha', source: 'workspaceId' }
const OTHER_PROJECT: TopicProjectRef = { projectId: 'project-beta', source: 'workspaceId' }
const TOPIC = 'topic-1'
const REF: TopicRef = { project: PROJECT, topicId: TOPIC }

/** 固定存储时钟：测试里的 at/expiresAt 都取这个量级，过期判定才可确定。 */
const CLOCK = 1_000

function makeStore(root: string): FsTopicStore {
  return new FsTopicStore({ root, now: () => CLOCK })
}

/** 建一个临时根并在其中打开一个主题（创建者 w-a 以 branch 身份加入）。 */
async function openStore(root?: string): Promise<FsTopicStore> {
  const store = makeStore(root ?? (await tempRoot()))
  await store.openTopic({
    project: PROJECT,
    topicId: TOPIC,
    title: '协作主题',
    objective: '同一目标',
    createdBy: 'w-a',
    scenario: 'branch',
    at: 1,
  })
  return store
}

async function addParticipant(store: FsTopicStore, windowKey: string, at = 2): Promise<void> {
  await store.upsertParticipant({
    project: PROJECT,
    topicId: TOPIC,
    windowKey,
    scenario: 'continuation',
    status: 'active',
    at,
  })
}

function decisionInput(
  entryId: string,
  content: string,
  baseRevision: number,
  at: number,
  over: Partial<TopicEntryAppendInput> = {},
): TopicEntryAppendInput {
  return {
    project: PROJECT,
    topicId: TOPIC,
    windowKey: 'w-a',
    kind: 'decision',
    content,
    entryId,
    decisionKey: 'k',
    baseRevision,
    at,
    ...over,
  }
}

describe('topicStore 路径与命名（§7.4）', () => {
  it('路径段全部是 hash，原始 projectId / topicId / scope 不入路径', async () => {
    const store = makeStore(await tempRoot())
    const project: TopicProjectRef = { projectId: '/Users/someone/My Project', source: 'cwd' }
    const topicId = '../escape/主题'
    await store.openTopic({ project, topicId, title: 'T', objective: 'O', createdBy: 'w-a', at: 1 })

    const dir = store.layout.topicDir(project, topicId)
    expect(projectHashOf(project)).toMatch(/^[0-9a-f]{32}$/)
    expect(dir.startsWith(store.layout.root)).toBe(true)
    expect(dir).toContain(projectHashOf(project))
    expect(dir).toContain(topicHashOf(project, topicId))
    expect(dir).not.toContain('My Project')
    expect(dir).not.toContain('escape')
    expect(dir).not.toContain('主题')
    expect(normalizeProjectId(project)).toBe(normalize(resolve('/Users/someone/My Project')))

    const claimDir = store.layout.claimDir(project, topicId, 'src/秘密/a.ts')
    expect(claimDir).toContain(scopeHashOf('src/秘密/a.ts'))
    expect(claimDir).not.toContain('秘密')
    expect(entryFileName(2, 'e1')).toBe('e_000000000002_e1.json')

    const record = await store.getTopic({ project, topicId })
    expect(record?.topicId).toBe(topicId)
    expect(record?.topicHash).toBe(topicHashOf(project, topicId))
  })

  it('L0/L1/L2/L3 按金字塔落盘，且都在插件根内', async () => {
    const store = await openStore()
    await addParticipant(store, 'w-b')
    await store.appendEntry({ project: PROJECT, topicId: TOPIC, windowKey: 'w-a', kind: 'progress', content: '进行中', entryId: 'p1', at: 3 })
    await store.acquireClaim({
      project: PROJECT,
      topicId: TOPIC,
      scope: 'src/a.ts',
      ownerWindowKey: 'w-a',
      baseRevision: 2,
      expiresAt: 9_999,
      at: 4,
    })

    const files = [
      store.layout.manifest,
      store.layout.index,
      store.layout.projectJson(PROJECT),
      store.layout.topicJson(PROJECT, TOPIC),
      store.layout.summaryJson(PROJECT, TOPIC),
      store.layout.entryFile(PROJECT, TOPIC, 2, 'p1'),
      store.layout.claimActiveFile(PROJECT, TOPIC, 'src/a.ts'),
    ]
    for (const path of files) {
      await expect(stat(path), path).resolves.toBeTruthy()
      expect(path.startsWith(store.layout.root)).toBe(true)
    }
    expect(await readdir(store.layout.claimHistoryDir(PROJECT, TOPIC, 'src/a.ts'))).toHaveLength(1)
    expect(store.layout.topicsDir(PROJECT)).toBe(join(store.layout.projectDir(PROJECT), 'topics'))
  })

  it('落盘权限位：JSON 文件 0600、目录 0700', async () => {
    const store = await openStore()
    await addParticipant(store, 'w-b')
    await store.appendEntry({ project: PROJECT, topicId: TOPIC, windowKey: 'w-a', kind: 'progress', content: '进行中', entryId: 'p1', at: 3 })

    const files = [
      store.layout.projectJson(PROJECT),
      store.layout.topicJson(PROJECT, TOPIC),
      store.layout.summaryJson(PROJECT, TOPIC),
      store.layout.entryFile(PROJECT, TOPIC, 2, 'p1'),
      store.layout.index,
    ]
    for (const path of files) {
      expect((await stat(path)).mode & 0o777, path).toBe(0o600)
    }

    const dirs = [
      store.layout.projectDir(PROJECT),
      store.layout.topicsDir(PROJECT),
      store.layout.topicDir(PROJECT, TOPIC),
      store.layout.entriesDir(PROJECT, TOPIC),
      store.layout.participantsDir(PROJECT, TOPIC),
    ]
    for (const path of dirs) {
      expect((await stat(path)).mode & 0o777, path).toBe(0o700)
    }
  })

  it('同 completionId 被他人抢占 → WINDOW_TOPIC_CONFLICT；同窗口同内容幂等命中', async () => {
    const store = await openStore()
    await addParticipant(store, 'w-b')

    const first = await store.appendEntry({
      project: PROJECT,
      topicId: TOPIC,
      windowKey: 'w-a',
      kind: 'completion',
      content: '完成 A',
      entryId: 'c1',
      completionId: 'cmp_run-1',
      runId: 'run-1',
      baseRevision: 1,
      at: 3,
    })
    expect(first.ok).toBe(true)

    // 他人抢用同一 completionId：响亮拒绝，不能静默顶掉真实完成。
    await expect(store.appendEntry({
      project: PROJECT,
      topicId: TOPIC,
      windowKey: 'w-b',
      kind: 'completion',
      content: '伪造完成',
      entryId: 'c2',
      completionId: 'cmp_run-1',
      runId: 'run-1',
      baseRevision: 2,
      at: 4,
    })).rejects.toMatchObject({ code: 'WINDOW_TOPIC_CONFLICT' })

    // 同一窗口、同一 run、同一内容 → 幂等命中既有 entry，不重复落条。
    const again = await store.appendEntry({
      project: PROJECT,
      topicId: TOPIC,
      windowKey: 'w-a',
      kind: 'completion',
      content: '完成 A',
      entryId: 'c3',
      completionId: 'cmp_run-1',
      runId: 'run-1',
      baseRevision: 1,
      at: 5,
    })
    expect(again.ok).toBe(true)
    if (again.ok) expect(again.value.entry.entryId).toBe('c1')
  })

  it('记录归属：跨项目复制的 topic.json 被响亮拒绝', async () => {
    const store = await openStore()
    const foreign = await readFile(store.layout.topicJson(PROJECT, TOPIC), 'utf8')
    await mkdir(store.layout.topicDir(OTHER_PROJECT, TOPIC), { recursive: true })
    await writeFile(store.layout.topicJson(OTHER_PROJECT, TOPIC), foreign, 'utf8')
    await expect(store.getTopic({ project: OTHER_PROJECT, topicId: TOPIC })).rejects.toThrow(/归属校验失败/)
  })

  it('journal 目标越出存储根时响亮拒绝，不写根外文件', async () => {
    const root = await tempRoot()
    const store = makeStore(root)
    await mkdir(store.layout.journalDir, { recursive: true, mode: 0o700 })
    const txId = 'tx_evil'
    const outside = join(tmpdir(), `dsh-window-evil-${String(process.pid)}.json`)
    await writeFile(
      store.layout.journalFile(txId),
      JSON.stringify({ txId, createdAt: 1, ops: [{ path: outside, value: { a: 1 } }] }),
      'utf8',
    )
    await expect(store.recover()).rejects.toThrow(/归属校验失败/)
    await expect(stat(outside)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('topicId 为空或 NUL 时拒绝', async () => {
    const store = makeStore(await tempRoot())
    await expect(
      store.openTopic({ project: PROJECT, topicId: '  ', title: 'T', objective: 'O', createdBy: 'w-a', at: 1 }),
    ).rejects.toMatchObject({ code: 'WINDOW_INVALID_INPUT' })
  })
})

describe('topicStore revision CAS（FR-12）', () => {
  it('append 推进 revision；旧 base_revision 返回 stale 且不覆盖他人记录', async () => {
    const store = await openStore()
    await addParticipant(store, 'w-b')

    const first = await store.appendEntry(decisionInput('e1', '采用方案甲', 1, 5))
    expect(first.ok).toBe(true)
    if (!first.ok) return
    expect(first.value.revision).toBe(2)
    expect(first.value.effective).toBe(true)

    const stale = await store.appendEntry(decisionInput('e2', '采用方案乙', 1, 6))
    expect(stale).toEqual({ ok: false, currentRevision: 2 })

    const page = await store.listEntries(REF)
    expect(page.entries.map((entry) => entry.entryId)).toEqual(['e1'])
    expect(page.total).toBe(1)
    expect((await store.getTopic(REF))?.revision).toBe(2)
  })

  it('decision 缺 base_revision 响亮失败；progress 可省略', async () => {
    const store = await openStore()
    await expect(
      store.appendEntry({ project: PROJECT, topicId: TOPIC, windowKey: 'w-a', kind: 'decision', content: '甲', entryId: 'e1', at: 5 }),
    ).rejects.toMatchObject({ code: 'WINDOW_TOPIC_REVISION_REQUIRED' })

    const progress = await store.appendEntry({
      project: PROJECT,
      topicId: TOPIC,
      windowKey: 'w-a',
      kind: 'progress',
      content: '开工',
      entryId: 'p1',
      at: 6,
    })
    expect(progress.ok).toBe(true)
    if (!progress.ok) return
    expect(progress.value.revision).toBe(2)
  })

  it('同 decision_key 不同结论只存 candidate 并生成 unresolved conflict；带 supersedes 为正常演进', async () => {
    const store = await openStore()
    await addParticipant(store, 'w-b')

    const a = await store.appendEntry(decisionInput('e1', '采用方案甲', 1, 5))
    expect(a.ok).toBe(true)
    if (!a.ok) return

    const b = await store.appendEntry(decisionInput('e2', '采用方案乙', 2, 6))
    expect(b.ok).toBe(true)
    if (!b.ok) return
    expect(b.value.effective).toBe(false)
    expect(b.value.conflict?.status).toBe('unresolved')
    expect([...(b.value.conflict?.entryIds ?? [])].sort()).toEqual(['e1', 'e2'])

    const summary = await store.readTopicSummary(REF)
    expect(summary?.effectiveDecisions.map((item) => item.entryId)).toEqual(['e1'])
    expect(summary?.unresolvedConflicts).toHaveLength(1)
    expect(await store.listConflicts(REF, { status: 'unresolved' })).toHaveLength(1)

    const c = await store.appendEntry(
      decisionInput('e3', '采用方案丙', 3, 7, { supersedesEntryId: 'e1', supersedesReason: '甲不适用' }),
    )
    expect(c.ok).toBe(true)
    if (!c.ok) return
    expect(c.value.effective).toBe(true)
    expect(c.value.conflict).toBeUndefined()
    expect(c.value.supersededEntryId).toBe('e1')

    await expect(
      store.appendEntry(decisionInput('e4', '采用方案丁', 4, 8, { supersedesEntryId: 'missing', supersedesReason: 'x' })),
    ).rejects.toMatchObject({ code: 'WINDOW_INVALID_INPUT' })
    await expect(
      store.appendEntry(decisionInput('e5', '采用方案戊', 4, 9, { supersedesEntryId: 'e3' })),
    ).rejects.toMatchObject({ code: 'WINDOW_INVALID_INPUT' })
  })

  it('resolution 关联 conflict 后冲突 resolved、candidate 被采纳；重复 resolution 被拒', async () => {
    const store = await openStore()
    await addParticipant(store, 'w-b')
    await store.appendEntry(decisionInput('e1', '采用方案甲', 1, 5)) // revision 2
    const b = await store.appendEntry(decisionInput('e2', '采用方案乙', 2, 6)) // revision 3
    expect(b.ok).toBe(true)
    if (!b.ok) return
    const conflictId = b.value.conflict?.conflictId
    expect(conflictId).toBeDefined()
    if (conflictId === undefined) return

    await expect(
      store.appendEntry({ project: PROJECT, topicId: TOPIC, windowKey: 'w-b', kind: 'resolution', content: '采纳乙', entryId: 'r0', baseRevision: 3, at: 7 }),
    ).rejects.toMatchObject({ code: 'WINDOW_INVALID_INPUT' })

    const r = await store.appendEntry({
      project: PROJECT,
      topicId: TOPIC,
      windowKey: 'w-b',
      kind: 'resolution',
      content: '采纳方案乙',
      entryId: 'r1',
      conflictId,
      baseRevision: 3,
      supersedesEntryId: 'e2',
      supersedesReason: '乙更合适',
      at: 8,
    })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value.revision).toBe(4)
    expect(r.value.conflict?.status).toBe('resolved')
    expect(r.value.conflict?.resolutionEntryId).toBe('r1')

    const summary = await store.readTopicSummary(REF)
    expect(summary?.unresolvedConflicts).toHaveLength(0)
    expect(summary?.effectiveDecisions.map((item) => item.entryId)).toEqual(['e2'])
    await expect(stat(store.layout.resolutionFile(PROJECT, TOPIC, conflictId, 'r1'))).resolves.toBeTruthy()

    // resolution 投影也属于可重建投影：删掉后按明细重建。
    await rm(store.layout.resolutionsDir(PROJECT, TOPIC, conflictId), { recursive: true, force: true })
    await store.rebuildProjections({ project: PROJECT, topicId: TOPIC })
    await expect(stat(store.layout.resolutionFile(PROJECT, TOPIC, conflictId, 'r1'))).resolves.toBeTruthy()
    expect((await store.getConflict(REF, conflictId))?.resolutionEntryId).toBe('r1')

    await expect(
      store.appendEntry({ project: PROJECT, topicId: TOPIC, windowKey: 'w-b', kind: 'resolution', content: '再来一次', entryId: 'r2', conflictId, baseRevision: 4, at: 9 }),
    ).rejects.toMatchObject({ code: 'WINDOW_TOPIC_CONFLICT' })
    expect((await store.getConflict(REF, conflictId))?.status).toBe('resolved')
  })

  it('非参与者、未知主题分别被拒', async () => {
    const store = await openStore()
    await expect(
      store.appendEntry(decisionInput('e1', '甲', 1, 5, { windowKey: 'w-zzz' })),
    ).rejects.toMatchObject({ code: 'WINDOW_TOPIC_FORBIDDEN' })
    await expect(
      store.appendEntry(decisionInput('e2', '甲', 1, 5, { topicId: 'no-such-topic' })),
    ).rejects.toMatchObject({ code: 'WINDOW_TOPIC_NOT_FOUND' })
    await expect(
      store.acquireClaim({ project: PROJECT, topicId: TOPIC, scope: 's', ownerWindowKey: 'w-zzz', baseRevision: 1, expiresAt: 99, at: 5 }),
    ).rejects.toMatchObject({ code: 'WINDOW_TOPIC_FORBIDDEN' })
  })

  it('重复 completionId 幂等返回，不推进 revision', async () => {
    const store = await openStore()
    const input: TopicEntryAppendInput = {
      project: PROJECT,
      topicId: TOPIC,
      windowKey: 'w-a',
      kind: 'completion',
      content: '完成摘要',
      entryId: 'c1',
      completionId: 'cmp-1',
      baseRevision: 1,
      at: 5,
    }
    const first = await store.appendEntry(input)
    expect(first.ok).toBe(true)
    if (!first.ok) return
    const again = await store.appendEntry({ ...input, entryId: 'c2' })
    expect(again.ok).toBe(true)
    if (!again.ok) return
    expect(again.value.entry.entryId).toBe('c1')
    expect(again.value.revision).toBe(first.value.revision)
    expect((await store.listEntries(REF)).total).toBe(1)
  })
})

describe('topicStore 协作占用（FR-12）', () => {
  it('同 scope 冲突、非 owner 不能 renew/release，释放后可再 acquire', async () => {
    const store = await openStore()
    await addParticipant(store, 'w-b')

    const a = await store.acquireClaim({ project: PROJECT, topicId: TOPIC, scope: 'src/a.ts', ownerWindowKey: 'w-a', baseRevision: 1, expiresAt: 1_000, at: 10 })
    expect(a.ok).toBe(true)
    if (!a.ok) return

    const b = await store.acquireClaim({ project: PROJECT, topicId: TOPIC, scope: 'src/a.ts', ownerWindowKey: 'w-b', baseRevision: a.revision, expiresAt: 1_000, at: 11 })
    expect(b.ok).toBe(false)
    if (b.ok) return
    expect(b.reason).toBe('conflict')
    if (b.reason !== 'conflict') return
    expect(b.holder.ownerWindowKey).toBe('w-a')
    expect((await store.getTopic(REF))?.revision).toBe(a.revision)

    const renew = await store.renewClaim({ project: PROJECT, topicId: TOPIC, scope: 'src/a.ts', ownerWindowKey: 'w-b', expiresAt: 2_000, at: 12 })
    expect(renew.ok).toBe(false)
    if (renew.ok) return
    expect(renew.reason).toBe('not-owner')

    const release = await store.releaseClaim({ project: PROJECT, topicId: TOPIC, scope: 'src/a.ts', ownerWindowKey: 'w-b', at: 13 })
    expect(release.ok).toBe(false)
    if (release.ok) return
    expect(release.reason).toBe('not-owner')

    const own = await store.releaseClaim({ project: PROJECT, topicId: TOPIC, scope: 'src/a.ts', ownerWindowKey: 'w-a', at: 14 })
    expect(own.ok).toBe(true)
    if (!own.ok) return
    expect(own.claim.releasedAt).toBe(14)
    expect(await store.listClaims(REF)).toHaveLength(0)
    expect(await store.listClaims(REF, { includeReleased: true })).toHaveLength(1)

    const takeover = await store.acquireClaim({ project: PROJECT, topicId: TOPIC, scope: 'src/a.ts', ownerWindowKey: 'w-b', baseRevision: own.revision, expiresAt: 5_000, at: 15 })
    expect(takeover.ok).toBe(true)
    if (!takeover.ok) return
    expect(takeover.tookOver).toBeUndefined()
  })

  it('acquire 的 base_revision 过期返回 stale，不产生占用', async () => {
    const store = await openStore()
    const stale = await store.acquireClaim({ project: PROJECT, topicId: TOPIC, scope: 's', ownerWindowKey: 'w-a', baseRevision: 99, expiresAt: 1_000, at: 10 })
    expect(stale).toEqual({ ok: false, reason: 'stale', currentRevision: 1 })
    expect(await store.listClaims(REF)).toHaveLength(0)
    await expect(
      store.acquireClaim({ project: PROJECT, topicId: TOPIC, scope: 's', ownerWindowKey: 'w-a', baseRevision: undefined as unknown as number, expiresAt: 1_000, at: 10 }),
    ).rejects.toMatchObject({ code: 'WINDOW_TOPIC_REVISION_REQUIRED' })
  })

  it('过期占用可被接管，历史保留且旧占用不被说成从未发生', async () => {
    const store = await openStore()
    await addParticipant(store, 'w-b')
    const a = await store.acquireClaim({ project: PROJECT, topicId: TOPIC, scope: 'src/a.ts', ownerWindowKey: 'w-a', baseRevision: 1, expiresAt: 100, at: 10 })
    expect(a.ok).toBe(true)
    if (!a.ok) return

    const b = await store.acquireClaim({ project: PROJECT, topicId: TOPIC, scope: 'src/a.ts', ownerWindowKey: 'w-b', baseRevision: a.revision, expiresAt: 300, at: 200 })
    expect(b.ok).toBe(true)
    if (!b.ok) return
    expect(b.tookOver?.ownerWindowKey).toBe('w-a')

    const claims = await store.listClaims(REF)
    expect(claims).toHaveLength(1)
    expect(claims[0]).toMatchObject({ ownerWindowKey: 'w-b', expiresAt: 300 })
    expect(claims[0]?.releasedAt).toBeUndefined()

    const events = await store.listClaimEvents(REF, 'src/a.ts')
    expect(events.map((event) => event.action)).toEqual(['acquire', 'takeover', 'acquire'])
    expect(events[1]?.claim.ownerWindowKey).toBe('w-a')
    expect(events[2]?.claim.ownerWindowKey).toBe('w-b')

    // 同一 owner 在自己的占用过期后重新 acquire 是续租，不是自我接管。
    const renew = await store.acquireClaim({ project: PROJECT, topicId: TOPIC, scope: 'src/a.ts', ownerWindowKey: 'w-b', baseRevision: b.revision, expiresAt: 600, at: 400 })
    expect(renew.ok).toBe(true)
    if (!renew.ok) return
    expect(renew.tookOver).toBeUndefined()
    expect(renew.claim.ownerWindowKey).toBe('w-b')
    expect((await store.listClaimEvents(REF, 'src/a.ts')).map((event) => event.action)).toEqual(['acquire', 'takeover', 'acquire', 'renew'])
  })

  it('releaseClaimsForRun 释放 run 绑定的占用', async () => {
    const store = await openStore()
    const a = await store.acquireClaim({ project: PROJECT, topicId: TOPIC, scope: 'src/a.ts', ownerWindowKey: 'w-a', runId: 'run-1', baseRevision: 1, expiresAt: 9_999, at: 10 })
    expect(a.ok).toBe(true)
    await store.acquireClaim({ project: PROJECT, topicId: TOPIC, scope: 'src/b.ts', ownerWindowKey: 'w-a', runId: 'run-2', baseRevision: 2, expiresAt: 9_999, at: 11 })

    const released = await store.releaseClaimsForRun('run-1', { at: 20, reason: 'orphan' })
    expect(released).toHaveLength(1)
    expect(released[0]).toMatchObject({ scope: 'src/a.ts', releasedAt: 20, releasedBy: 'dsh-window-lifecycle' })
    expect((await store.listClaims(REF)).map((claim) => claim.scope)).toEqual(['src/b.ts'])
  })
})

describe('topicStore 汇总投影与重建（§7.4）', () => {
  it('投影文件丢失后按明细重建 L2/L1/L0', async () => {
    const store = await openStore()
    await addParticipant(store, 'w-b')
    await store.appendEntry({ project: PROJECT, topicId: TOPIC, windowKey: 'w-a', kind: 'progress', content: '开始', entryId: 'p1', at: 5 })
    await store.appendEntry({ project: PROJECT, topicId: TOPIC, windowKey: 'w-a', kind: 'completion', content: '完成摘要', entryId: 'c1', completionId: 'cmp-1', baseRevision: 2, at: 6 })
    await store.acquireClaim({ project: PROJECT, topicId: TOPIC, scope: 'mod-x', ownerWindowKey: 'w-b', baseRevision: 3, expiresAt: 99_999, at: 7 })

    await rm(store.layout.summaryJson(PROJECT, TOPIC), { force: true })
    await rm(store.layout.projectJson(PROJECT), { force: true })
    await rm(store.layout.index, { force: true })

    const rebuilt = await store.rebuildProjections()
    expect(rebuilt).toEqual({ projects: 1, topics: 1, entries: 2 })

    const summary = await store.readTopicSummary(REF)
    expect(summary?.entryCount).toBe(2)
    expect(summary?.participants.map((item) => item.windowKey).sort()).toEqual(['w-a', 'w-b'])
    expect(summary?.activeClaims.map((claim) => claim.scope)).toEqual(['mod-x'])
    expect(summary?.lastCompletions.map((item) => item.completionId)).toEqual(['cmp-1'])

    const project = await store.readProject(PROJECT)
    expect(project?.topics.map((topic) => topic.topicId)).toEqual([TOPIC])
    expect(project?.topics[0]?.participantCount).toBe(2)
    expect(project?.unresolvedCount).toBe(0)

    const index = await store.readIndex()
    expect(index.schemaVersion).toBe(1)
    expect(index.projects.map((item) => item.projectId)).toEqual([PROJECT.projectId])
    expect(index.projects[0]?.topics.map((topic) => topic.topicId)).toEqual([TOPIC])
  })

  it('汇总陈旧时以明细为准自动重建', async () => {
    const store = await openStore()
    await addParticipant(store, 'w-b')
    await store.appendEntry({ project: PROJECT, topicId: TOPIC, windowKey: 'w-a', kind: 'progress', content: '进行中', entryId: 'p1', at: 5 })

    const tampered = {
      topicId: TOPIC,
      topicHash: topicHashOf(PROJECT, TOPIC),
      revision: 999,
      participants: [],
      effectiveDecisions: [],
      activeClaims: [],
      lastCompletions: [],
      unresolvedConflicts: [],
      activeRunIds: [],
      entryCount: 0,
      updatedAt: 0,
    }
    await writeFile(store.layout.summaryJson(PROJECT, TOPIC), JSON.stringify(tampered), 'utf8')

    const summary = await store.readTopicSummary(REF)
    expect(summary?.revision).toBe(2)
    expect(summary?.entryCount).toBe(1)
    expect(summary?.participants).toHaveLength(2)
    expect((await store.getTopic(REF))?.revision).toBe(2)
  })
})

describe('topicStore 重启恢复（FR-11 / AC-23）', () => {
  it('新实例恢复主题/参与者/明细/占用/冲突，且 revision 严格递增', async () => {
    const root = await tempRoot()
    const first = makeStore(root)
    await first.openTopic({ project: PROJECT, topicId: TOPIC, title: '协作主题', objective: '同一目标', createdBy: 'w-a', scenario: 'branch', at: 1 })
    await addParticipant(first, 'w-b')
    await first.appendEntry(decisionInput('e1', '采用方案甲', 1, 3))
    await first.appendEntry(decisionInput('e2', '采用方案乙', 2, 4, { windowKey: 'w-b' }))
    await first.acquireClaim({ project: PROJECT, topicId: TOPIC, scope: 's1', ownerWindowKey: 'w-a', baseRevision: 3, expiresAt: 100, at: 5 })
    await first.acquireClaim({ project: PROJECT, topicId: TOPIC, scope: 's2', ownerWindowKey: 'w-b', baseRevision: 4, expiresAt: 999_999, at: 6 })

    const second = makeStore(root)
    expect((await second.getTopic(REF))?.revision).toBe(5)
    const summary = await second.readTopicSummary(REF)
    expect(summary?.revision).toBe(5)
    expect(summary?.entryCount).toBe(2)
    expect(summary?.participants.map((item) => item.windowKey).sort()).toEqual(['w-a', 'w-b'])
    expect(summary?.effectiveDecisions.map((item) => item.entryId)).toEqual(['e1'])
    expect(summary?.unresolvedConflicts).toHaveLength(1)
    expect((await second.listClaims(REF)).map((claim) => claim.scope).sort()).toEqual(['s1', 's2'])

    const next = await second.appendEntry(decisionInput('e3', '采用方案丙', 5, 7, { decisionKey: 'k2' }))
    expect(next.ok).toBe(true)
    if (!next.ok) return
    expect(next.value.revision).toBe(6)
    expect((await second.listEntries(REF)).entries.map((entry) => entry.entryId)).toEqual(['e3', 'e2', 'e1'])
  })

  it('journal 半截事务在重启后重做', async () => {
    const root = await tempRoot()
    const store = await openStore(root)
    const topicPath = store.layout.topicJson(PROJECT, TOPIC)
    const record = JSON.parse(await readFile(topicPath, 'utf8')) as { revision: number }
    record.revision = 42
    const txId = 'tx_1_manual'
    await writeFile(
      store.layout.journalFile(txId),
      JSON.stringify({ txId, createdAt: 1, ops: [{ path: topicPath, value: record }] }),
      'utf8',
    )

    const restarted = makeStore(root)
    expect(await restarted.recover()).toBe(1)
    expect((await restarted.getTopic(REF))?.revision).toBe(42)
    await expect(stat(store.layout.journalFile(txId))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('cleanup 清理原子写遗留的 .tmp', async () => {
    const store = await openStore()
    const dir = store.layout.entriesDir(PROJECT, TOPIC)
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, '.half.tmp'), 'half', 'utf8')
    expect(await store.cleanup()).toBe(1)
    expect(await readdir(dir)).toHaveLength(0)
  })
})

describe('global 主题来源与 message entry（FR-22）', () => {
  const GLOBAL_REF: TopicRef = { project: GLOBAL_TOPIC_PROJECT, topicId: 'topic-global' }

  it('global 项目固定归一到 @global，且保留命名空间不允许真实项目占用', () => {
    expect(normalizeProjectId({ projectId: 'anything', source: 'global' })).toBe('@global')
    expect(normalizeProjectId(GLOBAL_TOPIC_PROJECT)).toBe('@global')
    // 不论调用方传什么 projectId，global 来源都落到同一个固定哈希。
    expect(projectHashOf({ projectId: 'x-1', source: 'global' })).toBe(projectHashOf(GLOBAL_TOPIC_PROJECT))
    expect(topicHashOf(GLOBAL_TOPIC_PROJECT, 't-1'))
      .not.toBe(topicHashOf({ projectId: 'ws-1', source: 'workspaceId' }, 't-1'))
    // 真实 workspaceId / cwd 不能占用保留 ID，否则会与全局命名空间哈希碰撞。
    expect(() => normalizeProjectId({ projectId: '@global', source: 'workspaceId' }))
      .toThrowError(/保留命名空间/)
  })

  it('不同项目的窗口可加入同一全局主题并写入 message；重启重建后来源仍是 global', async () => {
    const root = await tempRoot()
    const store = makeStore(root)
    await store.openTopic({
      project: GLOBAL_TOPIC_PROJECT,
      topicId: 'topic-global',
      title: '跨工作区协作',
      objective: '两个仓库协同',
      createdBy: 'w-a',
      scenario: 'continuation',
      at: 1,
    })
    // 来自另一个工作区的窗口加入同一全局主题（参与者记录只记 windowKey，不绑定项目）。
    await store.upsertParticipant({
      project: GLOBAL_TOPIC_PROJECT,
      topicId: 'topic-global',
      windowKey: 'w-b',
      scenario: 'continuation',
      status: 'active',
      at: 2,
    })
    const appended = await store.appendEntry({
      project: GLOBAL_TOPIC_PROJECT,
      topicId: 'topic-global',
      windowKey: 'w-b',
      kind: 'message',
      content: '后端接口已就绪',
      entryId: 'e_msg',
      at: 3,
    })
    expect(appended.ok).toBe(true)
    if (!appended.ok) throw new Error('unreachable')
    expect(appended.value.entry.kind).toBe('message')

    // 删掉 L0 索引迫使新实例从磁盘重建，验证 global 来源不会被过滤掉。
    await rm(join(root, 'index.json'), { force: true })
    const reopened = makeStore(root)
    await reopened.readIndex()
    expect(await reopened.getTopic(GLOBAL_REF)).toMatchObject({
      projectId: '@global',
      projectSource: 'global',
      topicId: 'topic-global',
    })
    const entries = await reopened.listEntries(GLOBAL_REF, { limit: 10 })
    expect(entries.entries.map((entry) => entry.kind)).toContain('message')
  })
})
