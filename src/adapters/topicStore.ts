/**
 * 项目主题台账（Topic Ledger）持久化：按需求 §7.4 的金字塔目录落盘到
 * `$DSH_HOME/storages/dsh-window`（与 run store 共用一个插件根）。
 *
 * - L0 `index.json`；L1 `projects/<projectHash>/project.json`；
 *   L2 `projects/<projectHash>/topics/<topicHash>/{topic,summary}.json`；
 *   L3 `participants/ | entries/ | claims/ | conflicts/` 明细事实；
 * - 跨文件写入先写 `_journal/<txId>.json` 这一份原子事务记录，再应用各文件；
 *   启动时按 journal 重做，半截状态不会被读成事实；
 * - 所有路径段都是 sha256 前缀：原始 projectId / cwd / topicId / scope / 窗口 id
 *   一律不进路径，读取时再按记录里的原始 ID 校验归属，防止哈希碰撞被当成同一对象；
 * - revision 只增不减，entry append-only；L0/L1/L2 汇总都是由 L3 明细派生的
 *   可重建投影，汇总与明细不一致时以明细为准。
 *
 * @module dsh-window/adapters/topicStore
 */
import { createHash, randomUUID } from 'node:crypto'
import type { Dirent } from 'node:fs'
import { mkdir, readdir, readFile, unlink } from 'node:fs/promises'
import { isAbsolute, join, normalize, relative, resolve, sep } from 'node:path'
import type {
  GlobalIndex,
  GlobalIndexProject,
  GlobalIndexTopicRef,
  ProjectSummary,
  ProjectTopicRef,
  TopicCasResult,
  TopicClaim,
  TopicClaimAcquireInput,
  TopicClaimAcquireResult,
  TopicClaimEvent,
  TopicClaimMutationResult,
  TopicClaimQuery,
  TopicClaimReleaseInput,
  TopicClaimRenewInput,
  TopicConflict,
  TopicConflictQuery,
  TopicCreateInput,
  TopicCreateOutcome,
  TopicDecisionRef,
  TopicCompletionRef,
  TopicEntry,
  TopicEntryAppendInput,
  TopicEntryAppendResult,
  TopicEntryKind,
  TopicEntryPage,
  TopicEntryQuery,
  TopicParticipant,
  TopicParticipantInput,
  TopicProjectRef,
  TopicRecord,
  TopicRef,
  TopicRebuildSummary,
  TopicStorePort,
  TopicSummary,
} from '../application/ports.js'
import { GLOBAL_PROJECT_ID, TOPIC_CAS_ENTRY_KINDS } from '../application/ports.js'
import type { Scenario } from '../shared/protocol.js'
import { WindowError } from '../shared/errors.js'
import { KeyedLock, writeJsonAtomic } from './atomicJson.js'
import { resolveDataRoot } from './runStore.js'

/** 目录结构版本；不兼容时必须响亮拒绝，不能按新结构误读旧目录。 */
export const TOPIC_STORAGE_VERSION = 1
/** index.json 的 schema 版本。 */
export const TOPIC_INDEX_SCHEMA_VERSION = 1

/** sha256 前缀长度（128 bit）。 */
const HASH_LEN = 32
/** 十六进制 hash 段。 */
const HASH_RE = /^[0-9a-f]{32}$/
/** entry 文件名：e_<补零 revision>_<entryId>.json。 */
const ENTRY_FILE_RE = /^e_(\d{12})_([A-Za-z0-9_-]{1,64})\.json$/
/** 模型拿不到物理路径，但插件生成的 ID 必须是路径安全字符。 */
const ENTRY_ID_RE = /^[A-Za-z0-9_-]{1,64}$/
const CONFLICT_ID_RE = /^[A-Za-z0-9_-]{1,80}$/
const REVISION_WIDTH = 12

const MAX_SUMMARY_TEXT = 500
const MAX_SUMMARY_DECISIONS = 20
const MAX_SUMMARY_COMPLETIONS = 5
const DEFAULT_ENTRY_LIMIT = 20
const MAX_ENTRY_LIMIT = 100
const MAX_ID_LENGTH = 200
const MAX_JOURNAL_DEPTH = 8

/** 存储自身写事务的串行 key；所有多文件提交都在它下面完成。 */
const STORAGE_LOCK = '__topicStorage__'

const OWNERSHIP = '主题记录归属校验失败'

/** ENOENT 判定。 */
function isEnoent(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === 'ENOENT'
}

/** sha256 前缀；各段以 NUL 分隔，输入里的 NUL 已在入口拒绝。 */
function hashOf(...parts: string[]): string {
  return createHash('sha256').update(parts.join('\0')).digest('hex').slice(0, HASH_LEN)
}

/** 规范项目身份：workspaceId 只 trim；cwd 走 normalize(resolve) 后再 hash；global 固定保留 ID。 */
export function normalizeProjectId(project: TopicProjectRef): string {
  if (project === null || typeof project !== 'object') {
    throw new WindowError('WINDOW_INVALID_INPUT', '项目引用必须是对象')
  }
  if (project.source === 'global') return GLOBAL_PROJECT_ID
  if (project.source !== 'workspaceId' && project.source !== 'cwd') {
    throw new WindowError('WINDOW_INVALID_INPUT', `项目来源非法（${String(project.source)}）`)
  }
  const raw = typeof project.projectId === 'string' ? project.projectId.trim() : ''
  if (raw.length === 0 || raw.includes('\0') || raw.length > MAX_ID_LENGTH * 8) {
    throw new WindowError('WINDOW_INVALID_INPUT', 'projectId 必须是非空且不含 NUL 的字符串')
  }
  // 保留命名空间：真实 workspaceId / cwd 不得占用 @global，否则会与全局主题哈希碰撞。
  if (raw === GLOBAL_PROJECT_ID) {
    throw new WindowError('WINDOW_INVALID_INPUT', `projectId ${GLOBAL_PROJECT_ID} 是全局主题保留命名空间，不能作为项目 ID`)
  }
  return project.source === 'cwd' ? normalize(resolve(raw)) : raw
}

/** 合法项目来源判定；global 只用于跨工作区共享主题。 */
function isTopicProjectSource(value: unknown): value is TopicProjectRef['source'] {
  return value === 'workspaceId' || value === 'cwd' || value === 'global'
}

/** `projectHash = sha256(normalizedProjectId)` 的小写十六进制前缀。 */
export function projectHashOf(project: TopicProjectRef): string {
  return hashOf(normalizeProjectId(project))
}

/** `topicHash = sha256(normalizedProjectId + '\0' + topicId)` 的小写十六进制前缀。 */
export function topicHashOf(project: TopicProjectRef, topicId: string): string {
  validateTopicId(topicId)
  return hashOf(normalizeProjectId(project), topicId)
}

/** participant 目录/文件名：按 (windowKey, scenario) 派生，窗口 id 不入路径。 */
export function participantHashOf(windowKey: string, scenario: Scenario): string {
  validateWindowKey(windowKey)
  return hashOf(windowKey, scenario)
}

/** claim scope 目录名：scope 文本不入路径。 */
export function scopeHashOf(scope: string): string {
  validateScope(scope)
  return hashOf(scope)
}

/** entry 文件名；补零 revision 保证字典序与写入顺序一致。 */
export function entryFileName(revision: number, entryId: string): string {
  return `e_${String(revision).padStart(REVISION_WIDTH, '0')}_${entryId}.json`
}

function padRevision(revision: number): string {
  return String(revision).padStart(REVISION_WIDTH, '0')
}

function boundText(text: string): string {
  const trimmed = text.trim()
  return trimmed.length <= MAX_SUMMARY_TEXT ? trimmed : `${trimmed.slice(0, MAX_SUMMARY_TEXT)}…`
}

function nonEmptyString(raw: unknown, label: string): string {
  if (typeof raw !== 'string' || raw.trim().length === 0 || raw.includes('\0') || raw.length > MAX_ID_LENGTH * 8) {
    throw new WindowError('WINDOW_INVALID_INPUT', `${label} 必须是非空且不含 NUL 的字符串`)
  }
  return raw.trim()
}

function validateTopicId(topicId: unknown): string {
  return nonEmptyString(topicId, 'topicId')
}

function validateWindowKey(windowKey: unknown): string {
  return nonEmptyString(windowKey, 'windowKey')
}

function validateScope(scope: unknown): string {
  return nonEmptyString(scope, 'scope')
}

function validateEntryId(entryId: unknown): string {
  if (typeof entryId !== 'string' || !ENTRY_ID_RE.test(entryId)) {
    throw new WindowError('WINDOW_INVALID_INPUT', `entryId 非法（必须是路径安全字符）：${String(entryId)}`)
  }
  return entryId
}

function validateConflictId(conflictId: unknown): string {
  if (typeof conflictId !== 'string' || !CONFLICT_ID_RE.test(conflictId)) {
    throw new WindowError('WINDOW_INVALID_INPUT', `conflictId 非法：${String(conflictId)}`)
  }
  return conflictId
}

function validateKind(kind: unknown): TopicEntryKind {
  if (kind !== 'progress' && kind !== 'decision' && kind !== 'completion'
    && kind !== 'conflict' && kind !== 'resolution' && kind !== 'message') {
    throw new WindowError('WINDOW_INVALID_INPUT', `entry kind 非法：${String(kind)}`)
  }
  return kind
}

function validateTime(at: unknown, label: string): number {
  if (typeof at !== 'number' || !Number.isSafeInteger(at) || at < 0) {
    throw new WindowError('WINDOW_INVALID_INPUT', `${label} 必须是非负安全整数（收到 ${String(at)}）`)
  }
  return at
}

function requiresCas(kind: TopicEntryKind): boolean {
  return (TOPIC_CAS_ENTRY_KINDS as readonly string[]).includes(kind)
}

/** 存储布局；供测试与诊断使用，模型拿不到物理路径。 */
export interface TopicStoreLayout {
  readonly root: string
  readonly manifest: string
  readonly index: string
  readonly projectsDir: string
  readonly journalDir: string
  projectDir(project: TopicProjectRef): string
  projectJson(project: TopicProjectRef): string
  topicsDir(project: TopicProjectRef): string
  topicDir(project: TopicProjectRef, topicId: string): string
  topicJson(project: TopicProjectRef, topicId: string): string
  summaryJson(project: TopicProjectRef, topicId: string): string
  participantsDir(project: TopicProjectRef, topicId: string): string
  participantFile(project: TopicProjectRef, topicId: string, participantHash: string): string
  entriesDir(project: TopicProjectRef, topicId: string): string
  entryFile(project: TopicProjectRef, topicId: string, revision: number, entryId: string): string
  claimsDir(project: TopicProjectRef, topicId: string): string
  claimDir(project: TopicProjectRef, topicId: string, scope: string): string
  claimActiveFile(project: TopicProjectRef, topicId: string, scope: string): string
  claimHistoryDir(project: TopicProjectRef, topicId: string, scope: string): string
  claimHistoryFile(project: TopicProjectRef, topicId: string, scope: string, claimEventId: string): string
  conflictsDir(project: TopicProjectRef, topicId: string): string
  conflictDir(project: TopicProjectRef, topicId: string, conflictId: string): string
  conflictJson(project: TopicProjectRef, topicId: string, conflictId: string): string
  resolutionsDir(project: TopicProjectRef, topicId: string, conflictId: string): string
  resolutionFile(project: TopicProjectRef, topicId: string, conflictId: string, entryId: string): string
  journalFile(txId: string): string
}

/** 构造存储布局；路径段全部是 hash 或插件生成的路径安全 ID。 */
export function topicStoreLayout(root: string): TopicStoreLayout {
  const projectsDir = join(root, 'projects')
  const projectDirOf = (project: TopicProjectRef): string => join(projectsDir, projectHashOf(project))
  const topicDirOf = (project: TopicProjectRef, topicId: string): string =>
    join(projectDirOf(project), 'topics', topicHashOf(project, topicId))
  const claimDirOf = (project: TopicProjectRef, topicId: string, scope: string): string =>
    join(topicDirOf(project, topicId), 'claims', scopeHashOf(scope))
  const conflictDirOf = (project: TopicProjectRef, topicId: string, conflictId: string): string =>
    join(topicDirOf(project, topicId), 'conflicts', validateConflictId(conflictId))
  return {
    root,
    manifest: join(root, 'manifest.json'),
    index: join(root, 'index.json'),
    projectsDir,
    journalDir: join(root, '_journal'),
    projectDir: projectDirOf,
    projectJson: (project) => join(projectDirOf(project), 'project.json'),
    topicsDir: (project) => join(projectDirOf(project), 'topics'),
    topicDir: topicDirOf,
    topicJson: (project, topicId) => join(topicDirOf(project, topicId), 'topic.json'),
    summaryJson: (project, topicId) => join(topicDirOf(project, topicId), 'summary.json'),
    participantsDir: (project, topicId) => join(topicDirOf(project, topicId), 'participants'),
    participantFile: (project, topicId, participantHash) => {
      if (!HASH_RE.test(participantHash)) throw new Error(`${OWNERSHIP}：参与者路径段非法（${participantHash}）`)
      return join(topicDirOf(project, topicId), 'participants', `${participantHash}.json`)
    },
    entriesDir: (project, topicId) => join(topicDirOf(project, topicId), 'entries'),
    entryFile: (project, topicId, revision, entryId) => {
      validateEntryId(entryId)
      return join(topicDirOf(project, topicId), 'entries', entryFileName(revision, entryId))
    },
    claimsDir: (project, topicId) => join(topicDirOf(project, topicId), 'claims'),
    claimDir: claimDirOf,
    claimActiveFile: (project, topicId, scope) => join(claimDirOf(project, topicId, scope), 'active.json'),
    claimHistoryDir: (project, topicId, scope) => join(claimDirOf(project, topicId, scope), 'history'),
    claimHistoryFile: (project, topicId, scope, claimEventId) => {
      if (!/^[A-Za-z0-9_-]{1,120}$/.test(claimEventId)) throw new Error(`claimEventId 非法：${claimEventId}`)
      return join(claimDirOf(project, topicId, scope), 'history', `${claimEventId}.json`)
    },
    conflictsDir: (project, topicId) => join(topicDirOf(project, topicId), 'conflicts'),
    conflictDir: conflictDirOf,
    conflictJson: (project, topicId, conflictId) => join(conflictDirOf(project, topicId, conflictId), 'conflict.json'),
    resolutionsDir: (project, topicId, conflictId) => join(conflictDirOf(project, topicId, conflictId), 'resolutions'),
    resolutionFile: (project, topicId, conflictId, entryId) => {
      validateEntryId(entryId)
      return join(conflictDirOf(project, topicId, conflictId), 'resolutions', `${entryId}.json`)
    },
    journalFile: (txId) => {
      if (!/^[A-Za-z0-9_-]{1,120}$/.test(txId)) throw new Error(`txId 非法：${txId}`)
      return join(root, '_journal', `${txId}.json`)
    },
  }
}

/** 事务里的一条文件写入。 */
export interface TopicJournalOp {
  /** 目标文件的绝对路径；恢复时会校验它确实落在本存储根内。 */
  path: string
  value: unknown
}

/** `_journal/<txId>.json` 的内容：跨文件提交的唯一原子事实。 */
export interface TopicJournalTransaction {
  txId: string
  createdAt: number
  ops: TopicJournalOp[]
}

/** 冲突 resolution 投影文件的内容。 */
export interface TopicResolutionRecord {
  entryId: string
  conflictId: string
  windowKey: string
  at: number
  decisionKey?: string
  summary: string
}

/** 主题的 L3 明细快照；一切汇总都由它派生。 */
interface TopicState {
  topic: TopicRecord
  entries: TopicEntry[]
  participants: TopicParticipant[]
  claimEvents: TopicClaimEvent[]
  claims: TopicClaim[]
  conflicts: TopicConflict[]
}

/** 被后续记录 supersede 的 entry（仍在明细里，只是不再是有效结论）。 */
function supersededIdsOf(entries: TopicEntry[]): Set<string> {
  const ids = new Set<string>()
  for (const entry of entries) {
    // resolution 的 supersedes 表示“采纳该结论”，不是“替代并作废”。
    if (entry.kind === 'resolution') continue
    if (entry.supersedesEntryId !== undefined) ids.add(entry.supersedesEntryId)
  }
  return ids
}

/** 被 resolution 明确采纳的 entry（candidate 只能这样变成有效结论）。 */
function adoptedIdsOf(entries: TopicEntry[]): Set<string> {
  const ids = new Set<string>()
  for (const entry of entries) {
    if (entry.kind === 'resolution' && entry.supersedesEntryId !== undefined) ids.add(entry.supersedesEntryId)
  }
  return ids
}

/** 每个 decision_key 当前有效的结论；返回按 revision 升序。 */
function effectiveDecisionEntries(entries: TopicEntry[]): TopicEntry[] {
  const superseded = supersededIdsOf(entries)
  const adopted = adoptedIdsOf(entries)
  const byKey = new Map<string, TopicEntry>()
  for (const entry of entries) {
    if (entry.kind !== 'decision') continue
    if (entry.effective === false && !adopted.has(entry.entryId)) continue
    if (superseded.has(entry.entryId)) continue
    const key = entry.decisionKey ?? `\0${entry.entryId}`
    const previous = byKey.get(key)
    if (previous === undefined || entry.revision > previous.revision) byKey.set(key, entry)
  }
  return [...byKey.values()].sort((a, b) => a.revision - b.revision)
}

/** 冲突投影：由带 conflictId 的 entry（冲突源 + 可能的 resolution）派生。 */
function conflictsOf(entries: TopicEntry[]): TopicConflict[] {
  const ids = new Set<string>()
  for (const entry of entries) {
    if (typeof entry.conflictId === 'string' && entry.conflictId.length > 0) ids.add(entry.conflictId)
  }
  const conflicts: TopicConflict[] = []
  for (const conflictId of ids) {
    const members = entries.filter((entry) => entry.conflictId === conflictId)
    const origin = members.find((entry) => entry.kind !== 'resolution')
    if (origin === undefined) continue
    const resolutions = members
      .filter((entry) => entry.kind === 'resolution')
      .sort((a, b) => a.revision - b.revision)
    const resolution = resolutions[resolutions.length - 1]
    const entryIds: string[] = [origin.entryId]
    for (const id of origin.relatedEntryIds ?? []) {
      if (!entryIds.includes(id)) entryIds.push(id)
    }
    conflicts.push({
      conflictId,
      projectId: origin.projectId,
      topicId: origin.topicId,
      entryIds,
      status: resolution === undefined ? 'unresolved' : 'resolved',
      createdAt: origin.createdAt,
      ...(resolution === undefined ? {} : { resolvedAt: resolution.createdAt, resolutionEntryId: resolution.entryId }),
      ...(origin.decisionKey === undefined ? {} : { decisionKey: origin.decisionKey }),
      reason: boundText(origin.content),
    })
  }
  return conflicts.sort((a, b) => a.createdAt - b.createdAt || a.conflictId.localeCompare(b.conflictId))
}

/** 当前占用投影：每个 scope 取 revision 最大的那条事件。 */
function claimsOf(events: TopicClaimEvent[]): TopicClaim[] {
  const latest = new Map<string, TopicClaimEvent>()
  for (const event of events) {
    const previous = latest.get(event.claim.scope)
    if (
      previous === undefined
      || event.revision > previous.revision
      || (event.revision === previous.revision && event.claimEventId > previous.claimEventId)
    ) {
      latest.set(event.claim.scope, event)
    }
  }
  return [...latest.values()]
    .map((event) => event.claim)
    .sort((a, b) => a.scopeHash.localeCompare(b.scopeHash))
}

function decisionRefOf(entry: TopicEntry): TopicDecisionRef {
  return {
    entryId: entry.entryId,
    ...(entry.decisionKey === undefined ? {} : { decisionKey: entry.decisionKey }),
    windowKey: entry.windowKey,
    summary: boundText(entry.content),
    revision: entry.revision,
    createdAt: entry.createdAt,
  }
}

function completionRefOf(entry: TopicEntry): TopicCompletionRef {
  return {
    entryId: entry.entryId,
    ...(entry.completionId === undefined ? {} : { completionId: entry.completionId }),
    ...(entry.runId === undefined ? {} : { runId: entry.runId }),
    windowKey: entry.windowKey,
    summary: boundText(entry.content),
    revision: entry.revision,
    createdAt: entry.createdAt,
  }
}

/** L2 汇总投影：只保留有界结论、计数与指针。 */
function summaryOf(state: TopicState, at: number): TopicSummary {
  const decisions = effectiveDecisionEntries(state.entries)
  const completions = state.entries
    .filter((entry) => entry.kind === 'completion' && entry.effective !== false)
    .sort((a, b) => a.revision - b.revision)
  const completedRuns = new Set<string>()
  for (const entry of completions) {
    if (entry.runId !== undefined) completedRuns.add(entry.runId)
  }
  const runIds = new Set<string>()
  for (const entry of state.entries) {
    if (entry.runId !== undefined) runIds.add(entry.runId)
  }
  for (const claim of state.claims) {
    if (claim.runId !== undefined) runIds.add(claim.runId)
  }
  return {
    topicId: state.topic.topicId,
    topicHash: state.topic.topicHash,
    revision: state.topic.revision,
    participants: [...state.participants].sort((a, b) => a.joinedAt - b.joinedAt || a.participationId.localeCompare(b.participationId)),
    effectiveDecisions: decisions.slice(-MAX_SUMMARY_DECISIONS).map(decisionRefOf),
    activeClaims: state.claims.filter((claim) => claim.releasedAt === undefined && claim.expiresAt > at),
    lastCompletions: completions.slice(-MAX_SUMMARY_COMPLETIONS).map(completionRefOf),
    unresolvedConflicts: state.conflicts.filter((conflict) => conflict.status === 'unresolved'),
    activeRunIds: [...runIds].filter((runId) => !completedRuns.has(runId)).sort(),
    entryCount: state.entries.length,
    updatedAt: at,
  }
}

function lastCompletionAtOfSummary(summary: TopicSummary): number | undefined {
  const last = summary.lastCompletions[summary.lastCompletions.length - 1]
  return last?.createdAt
}

function projectTopicRefOf(summary: TopicSummary, topic: TopicRecord): ProjectTopicRef {
  const lastCompletionAt = lastCompletionAtOfSummary(summary)
  return {
    topicId: topic.topicId,
    topicHash: topic.topicHash,
    title: topic.title,
    objective: topic.objective,
    revision: summary.revision,
    participantCount: summary.participants.length,
    activeClaimCount: summary.activeClaims.length,
    unresolvedCount: summary.unresolvedConflicts.length,
    activeRunIds: [...summary.activeRunIds],
    ...(lastCompletionAt === undefined ? {} : { lastCompletionAt }),
    updatedAt: topic.updatedAt,
  }
}

function projectSummaryOf(project: TopicProjectRef, topics: ProjectTopicRef[], at: number): ProjectSummary {
  const activeRuns = new Set<string>()
  let unresolvedCount = 0
  let lastCompletionAt: number | undefined
  for (const topic of topics) {
    for (const runId of topic.activeRunIds) activeRuns.add(runId)
    unresolvedCount += topic.unresolvedCount
    if (topic.lastCompletionAt !== undefined && (lastCompletionAt === undefined || topic.lastCompletionAt > lastCompletionAt)) {
      lastCompletionAt = topic.lastCompletionAt
    }
  }
  return {
    projectId: normalizeProjectId(project),
    projectHash: projectHashOf(project),
    projectSource: project.source,
    topics: [...topics].sort((a, b) => b.updatedAt - a.updatedAt || a.topicId.localeCompare(b.topicId)),
    activeRuns: [...activeRuns].sort(),
    unresolvedCount,
    ...(lastCompletionAt === undefined ? {} : { lastCompletionAt }),
    updatedAt: at,
  }
}

function indexProjectOf(project: ProjectSummary, at: number): GlobalIndexProject {
  const topics: GlobalIndexTopicRef[] = project.topics.map((topic) => ({
    topicId: topic.topicId,
    topicHash: topic.topicHash,
    title: topic.title,
    revision: topic.revision,
    participantCount: topic.participantCount,
    unresolvedCount: topic.unresolvedCount,
    ...(topic.lastCompletionAt === undefined ? {} : { lastCompletionAt: topic.lastCompletionAt }),
    updatedAt: topic.updatedAt,
  }))
  return {
    projectId: project.projectId,
    projectHash: project.projectHash,
    projectSource: project.projectSource,
    topics,
    unresolvedCount: project.unresolvedCount,
    ...(project.lastCompletionAt === undefined ? {} : { lastCompletionAt: project.lastCompletionAt }),
    updatedAt: at,
  }
}

function indexOf(projects: GlobalIndexProject[], at: number): GlobalIndex {
  return {
    schemaVersion: TOPIC_INDEX_SCHEMA_VERSION,
    projects: [...projects].sort((a, b) => b.updatedAt - a.updatedAt || a.projectId.localeCompare(b.projectId)),
    updatedAt: at,
  }
}

/** 基于文件系统的 TopicStore；唯一 I/O 实现。 */
export class FsTopicStore implements TopicStorePort {
  readonly layout: TopicStoreLayout
  private readonly locks = new KeyedLock()
  private readonly now: () => number
  private readyPromise?: Promise<void>

  constructor(options: { root?: string; now?: () => number } = {}) {
    this.layout = topicStoreLayout(options.root ?? resolveDataRoot())
    this.now = options.now ?? Date.now
  }

  /** 当前实现总是可用；写入失败按异常上报，由用例层映射成 STORAGE_UNAVAILABLE。 */
  available(): boolean {
    return true
  }

  /** 按 journal 重做半截事务；返回本次重做的交易数。可选。 */
  async recover(): Promise<number> {
    return await this.locks.run(STORAGE_LOCK, async () => await this.recoverInternal())
  }

  /** 等存储内部待排空写入落定；drain 用。 */
  async settle(): Promise<void> {
    await this.ready()
    await this.locks.settle(STORAGE_LOCK)
  }

  /**
   * 清理原子写遗留的 `.tmp` 半截文件；返回清理数量。
   *
   * 刻意**不走 ready()**：清理是恢复动作，不能被「journal/manifest 损坏」挡住
   * （否则坏 journal 会让台账永久不可用且连清理都做不了）；同时避免在启动对账时
   * 仅为清理就 bootstrap 出存储根（无谓副作用）。
   */
  async cleanup(): Promise<number> {
    return await this.locks.run(STORAGE_LOCK, async () => await this.cleanupInternal())
  }

  /** 用例层组合读改写用的按主题串行锁；存储自身的单次写入已各自原子。 */
  async withTopicLock<T>(ref: TopicRef, operation: () => Promise<T>): Promise<T> {
    return await this.locks.run(this.topicLockKey(ref), operation)
  }

  // ---------------------------------------------------------------- L0 / L1

  async readIndex(): Promise<GlobalIndex> {
    await this.ready()
    return await this.locks.run(STORAGE_LOCK, async () => {
      const index = await this.readIndexRaw()
      if (index !== undefined && (await this.indexIsFresh(index))) return index
      await this.rebuildInternal()
      return (await this.readIndexRaw()) ?? indexOf([], this.now())
    })
  }

  async readProject(project: TopicProjectRef): Promise<ProjectSummary | undefined> {
    await this.ready()
    return await this.locks.run(STORAGE_LOCK, async () => {
      const stored = await this.readProjectRaw(project)
      if (stored !== undefined && (await this.projectIsFresh(project, stored))) return stored
      await this.rebuildInternal({ project })
      return await this.readProjectRaw(project)
    })
  }

  // --------------------------------------------------------------------- L2

  async getTopic(ref: TopicRef): Promise<TopicRecord | undefined> {
    await this.ready()
    return await this.locks.run(STORAGE_LOCK, async () => await this.readTopicRaw(ref))
  }

  async readTopicSummary(ref: TopicRef): Promise<TopicSummary | undefined> {
    await this.ready()
    return await this.locks.run(STORAGE_LOCK, async () => {
      const topic = await this.readTopicRaw(ref)
      if (topic === undefined) return undefined
      const summary = await this.readSummaryRaw(ref)
      if (summary !== undefined && (await this.summaryLooksFresh(ref, topic, summary))) {
        return summary
      }
      await this.rebuildInternal({ project: ref.project, topicId: ref.topicId })
      return await this.readSummaryRaw(ref)
    })
  }

  async openTopic(input: TopicCreateInput): Promise<TopicCreateOutcome> {
    await this.ready()
    const ref: TopicRef = { project: input.project, topicId: validateTopicId(input.topicId) }
    return await this.locks.run(STORAGE_LOCK, async () => {
      const title = nonEmptyString(input.title, 'title')
      const objective = nonEmptyString(input.objective, 'objective')
      const createdBy = validateWindowKey(input.createdBy)
      const at = validateTime(input.at, 'at')
      const existing = await this.readTopicRaw(ref)
      if (existing !== undefined) {
        if (existing.objective.trim() !== objective) {
          throw new WindowError(
            'WINDOW_TOPIC_CONFLICT',
            `主题 ${ref.topicId} 已存在且目标不一致，不能覆盖：${existing.objective}`,
          )
        }
        const creator = await this.findParticipant(ref, createdBy)
        return { topic: existing, created: false, ...(creator === undefined ? {} : { creator }) }
      }
      const topic: TopicRecord = {
        projectId: normalizeProjectId(input.project),
        projectSource: input.project.source,
        projectHash: projectHashOf(input.project),
        topicId: ref.topicId,
        topicHash: topicHashOf(input.project, ref.topicId),
        title,
        objective,
        revision: 1,
        createdBy,
        createdAt: at,
        updatedAt: at,
      }
      const creator = input.scenario === undefined
        ? undefined
        : this.buildParticipant(ref, createdBy, input.scenario, 'active', 'owner', at)
      const state: TopicState = {
        topic,
        entries: [],
        participants: creator === undefined ? [] : [creator],
        claimEvents: [],
        claims: [],
        conflicts: [],
      }
      const ops = await this.projectionOps(ref, state, at)
      if (creator !== undefined) {
        ops.unshift({
          path: this.layout.participantFile(input.project, ref.topicId, participantHashOf(creator.windowKey, creator.scenario)),
          value: creator,
        })
      }
      await this.commit(ops)
      return { topic, created: true, ...(creator === undefined ? {} : { creator }) }
    })
  }

  // --------------------------------------------------------------- 参与者 L3

  async upsertParticipant(input: TopicParticipantInput): Promise<TopicParticipant> {
    await this.ready()
    const ref: TopicRef = { project: input.project, topicId: validateTopicId(input.topicId) }
    return await this.locks.run(STORAGE_LOCK, async () => {
      const windowKey = validateWindowKey(input.windowKey)
      const at = validateTime(input.at, 'at')
      const state = await this.stateOf(ref)
      const hash = participantHashOf(windowKey, input.scenario)
      const existing = state.participants.find((item) => item.participationId === `p_${hash}`)
      const participant = existing === undefined
        ? this.buildParticipant(ref, windowKey, input.scenario, input.status, input.role ?? 'participant', at)
        : { ...existing, status: input.status, lastSeenAt: at }
      const participants = [
        ...state.participants.filter((item) => item.participationId !== participant.participationId),
        participant,
      ]
      const next: TopicState = { ...state, participants }
      const ops = await this.projectionOps(ref, next, at)
      ops.unshift({ path: this.layout.participantFile(ref.project, ref.topicId, hash), value: participant })
      await this.commit(ops)
      return participant
    })
  }

  async getParticipant(ref: TopicRef, windowKey: string, scenario?: Scenario): Promise<TopicParticipant | undefined> {
    await this.ready()
    return await this.locks.run(STORAGE_LOCK, async () => {
      const participants = await this.readParticipants(ref)
      return participants.find(
        (item) => item.windowKey === windowKey && (scenario === undefined || item.scenario === scenario),
      )
    })
  }

  async listParticipants(ref: TopicRef): Promise<TopicParticipant[]> {
    await this.ready()
    return await this.locks.run(STORAGE_LOCK, async () => {
      await this.requireTopic(ref)
      return await this.readParticipants(ref)
    })
  }

  // ------------------------------------------------------------- entry L3

  async appendEntry(input: TopicEntryAppendInput): Promise<TopicCasResult<TopicEntryAppendResult>> {
    await this.ready()
    const ref: TopicRef = { project: input.project, topicId: validateTopicId(input.topicId) }
    return await this.locks.run(STORAGE_LOCK, async () => {
      const entryId = validateEntryId(input.entryId)
      const kind = validateKind(input.kind)
      const content = nonEmptyString(input.content, 'content')
      const windowKey = validateWindowKey(input.windowKey)
      const at = validateTime(input.at, 'at')
      const state = await this.stateOf(ref)
      this.requireParticipant(state, ref, windowKey)

      const duplicate = state.entries.find((entry) => entry.entryId === entryId)
      if (duplicate !== undefined) {
        // 幂等只对同一写入者、同一内容成立；他人同 entryId 或同 ID 不同内容都是抢占/覆盖冲突。
        if (duplicate.windowKey !== windowKey) {
          throw new WindowError('WINDOW_TOPIC_CONFLICT', `entryId ${entryId} 已被窗口 ${duplicate.windowKey} 占用，不能代写`)
        }
        if (duplicate.content !== content) {
          throw new WindowError('WINDOW_TOPIC_CONFLICT', `entryId ${entryId} 已存在且内容不同，不能幂等覆盖`)
        }
        return { ok: true, value: { entry: duplicate, revision: duplicate.revision, effective: duplicate.effective !== false } }
      }
      if (kind === 'completion' && input.completionId !== undefined) {
        const settled = state.entries.find(
          (entry) => entry.kind === 'completion' && entry.completionId === input.completionId,
        )
        if (settled !== undefined) {
          // completionId 确定性派生（cmp_<runId>）会公开出现在 active_run_ids 附近；
          // 幂等命中必须核对归属与内容，否则攻击者可以先抢占该 ID 让真实完成静默丢失。
          if (settled.windowKey !== windowKey || (input.runId !== undefined && settled.runId !== input.runId)) {
            throw new WindowError(
              'WINDOW_TOPIC_CONFLICT',
              `completionId ${input.completionId} 已属于窗口 ${settled.windowKey}（runId=${settled.runId ?? '无'}），不能抢占`,
            )
          }
          if (settled.content !== content) {
            throw new WindowError('WINDOW_TOPIC_CONFLICT', `completionId ${input.completionId} 已有不同内容；run 级完成已落定，不能覆盖`)
          }
          return { ok: true, value: { entry: settled, revision: settled.revision, effective: settled.effective !== false } }
        }
      }

      if (requiresCas(kind)) {
        if (typeof input.baseRevision !== 'number' || !Number.isSafeInteger(input.baseRevision) || input.baseRevision < 0) {
          throw new WindowError(
            'WINDOW_TOPIC_REVISION_REQUIRED',
            `${kind} 记录必须携带 base_revision（先 window_topic_get 读取当前 revision）`,
          )
        }
        if (input.baseRevision !== state.topic.revision) {
          return { ok: false, currentRevision: state.topic.revision }
        }
      } else if (input.baseRevision !== undefined && input.baseRevision !== state.topic.revision) {
        return { ok: false, currentRevision: state.topic.revision }
      }

      const supersedesEntryId = this.resolveSupersedes(state, input)
      if (kind === 'resolution') validateConflictId(input.conflictId)

      const newRevision = state.topic.revision + 1
      let effective: boolean
      let conflictId: string | undefined
      let relatedEntryIds: string[] | undefined
      let supersededEntryId: string | undefined

      if (kind === 'decision') {
        const prior = input.decisionKey === undefined
          ? undefined
          : effectiveDecisionEntries(state.entries).find((entry) => entry.decisionKey === input.decisionKey)
        const contradicts = prior !== undefined && prior.content.trim() !== content.trim()
        if (contradicts && supersedesEntryId === undefined) {
          effective = false
          conflictId = `c_${padRevision(newRevision)}_${entryId}`
          relatedEntryIds = [prior.entryId]
        } else {
          effective = true
          if (contradicts && prior !== undefined) supersededEntryId = prior.entryId
        }
      } else if (kind === 'completion') {
        const priorCompletion = state.entries.find(
          (entry) =>
            entry.kind === 'completion'
            && entry.effective !== false
            && input.runId !== undefined
            && entry.runId === input.runId
            && entry.completionId !== input.completionId,
        )
        if (priorCompletion !== undefined) {
          effective = false
          conflictId = `c_${padRevision(newRevision)}_${entryId}`
          relatedEntryIds = [priorCompletion.entryId]
        } else {
          effective = true
        }
      } else if (kind === 'conflict') {
        effective = false
        conflictId = `c_${padRevision(newRevision)}_${entryId}`
        relatedEntryIds = this.resolveRelatedEntries(state, input.relatedEntryIds)
      } else if (kind === 'resolution') {
        const target = state.conflicts.find((conflict) => conflict.conflictId === input.conflictId)
        if (target === undefined) {
          throw new WindowError('WINDOW_TOPIC_NOT_FOUND', `冲突不存在：${String(input.conflictId)}`)
        }
        if (target.status === 'resolved') {
          throw new WindowError('WINDOW_TOPIC_CONFLICT', `冲突 ${target.conflictId} 已解决，不能重复写入 resolution`)
        }
        effective = true
        conflictId = target.conflictId
      } else {
        effective = true
      }

      const entry: TopicEntry = {
        entryId,
        projectId: state.topic.projectId,
        topicId: ref.topicId,
        revision: newRevision,
        windowKey,
        kind,
        content,
        createdAt: at,
        ...(input.baseRevision === undefined ? {} : { baseRevision: input.baseRevision }),
        ...(input.runId === undefined ? {} : { runId: input.runId }),
        ...(input.completionId === undefined ? {} : { completionId: input.completionId }),
        ...(input.decisionKey === undefined ? {} : { decisionKey: input.decisionKey }),
        ...(input.artifactRefs === undefined ? {} : { artifactRefs: [...input.artifactRefs] }),
        ...(supersedesEntryId === undefined ? {} : { supersedesEntryId }),
        ...(input.supersedesReason === undefined ? {} : { supersedesReason: input.supersedesReason }),
        effective,
        ...(conflictId === undefined ? {} : { conflictId }),
        ...(relatedEntryIds === undefined ? {} : { relatedEntryIds }),
      }

      const entries = [...state.entries, entry]
      const touched = this.touchParticipants(ref, state.participants, windowKey, at)
      const next: TopicState = {
        ...state,
        topic: { ...state.topic, revision: newRevision, updatedAt: at },
        entries,
        participants: touched.participants,
        conflicts: conflictsOf(entries),
      }

      const ops: TopicJournalOp[] = [
        { path: this.layout.entryFile(ref.project, ref.topicId, newRevision, entryId), value: entry },
        ...touched.ops,
      ]
      const conflict = conflictId === undefined
        ? undefined
        : next.conflicts.find((item) => item.conflictId === conflictId)
      if (conflictId !== undefined && conflict !== undefined) {
        ops.push({ path: this.layout.conflictJson(ref.project, ref.topicId, conflictId), value: conflict })
      }
      if (kind === 'resolution' && conflictId !== undefined) {
        const record: TopicResolutionRecord = {
          entryId,
          conflictId,
          windowKey,
          at,
          ...(input.decisionKey === undefined ? {} : { decisionKey: input.decisionKey }),
          summary: boundText(content),
        }
        ops.push({ path: this.layout.resolutionFile(ref.project, ref.topicId, conflictId, entryId), value: record })
      }
      ops.push(...(await this.projectionOps(ref, next, at)))
      await this.commit(ops)

      return {
        ok: true,
        value: {
          entry,
          revision: newRevision,
          effective,
          ...(conflict === undefined ? {} : { conflict }),
          ...(supersededEntryId === undefined ? {} : { supersededEntryId }),
        },
      }
    })
  }

  async getEntry(ref: TopicRef, entryId: string): Promise<TopicEntry | undefined> {
    await this.ready()
    const id = validateEntryId(entryId)
    return await this.locks.run(STORAGE_LOCK, async () => {
      await this.requireTopic(ref)
      const entries = await this.readEntries(ref)
      return entries.find((entry) => entry.entryId === id)
    })
  }

  async listEntries(ref: TopicRef, query: TopicEntryQuery = {}): Promise<TopicEntryPage> {
    await this.ready()
    return await this.locks.run(STORAGE_LOCK, async () => {
      await this.requireTopic(ref)
      const entries = await this.readEntries(ref)
      const filtered = query.kinds === undefined
        ? entries
        : entries.filter((entry) => query.kinds?.includes(entry.kind) === true)
      const sorted = [...filtered].sort((a, b) => b.revision - a.revision)
      const limit = normalizeLimit(query.limit)
      const start = decodeCursor(query.cursor)
      const page = sorted.slice(start, start + limit)
      const next = start + limit < sorted.length ? String(start + limit) : undefined
      return { entries: page, total: sorted.length, ...(next === undefined ? {} : { nextCursor: next }) }
    })
  }

  // -------------------------------------------------------------- claim L3

  async acquireClaim(input: TopicClaimAcquireInput): Promise<TopicClaimAcquireResult> {
    await this.ready()
    const ref: TopicRef = { project: input.project, topicId: validateTopicId(input.topicId) }
    return await this.locks.run(STORAGE_LOCK, async () => {
      const scope = validateScope(input.scope)
      const owner = validateWindowKey(input.ownerWindowKey)
      const at = validateTime(input.at, 'at')
      const expiresAt = validateTime(input.expiresAt, 'expiresAt')
      if (expiresAt <= at) {
        throw new WindowError('WINDOW_INVALID_INPUT', `expiresAt 必须晚于当前时间（${expiresAt} <= ${at}）`)
      }
      if (typeof input.baseRevision !== 'number' || !Number.isSafeInteger(input.baseRevision) || input.baseRevision < 0) {
        throw new WindowError('WINDOW_TOPIC_REVISION_REQUIRED', 'acquire claim 必须携带 base_revision')
      }
      const state = await this.stateOf(ref)
      this.requireParticipant(state, ref, owner)
      if (input.baseRevision !== state.topic.revision) {
        return { ok: false, reason: 'stale', currentRevision: state.topic.revision }
      }
      const existing = state.claims.find((claim) => claim.scope === scope && claim.releasedAt === undefined)
      const unexpired = existing !== undefined && existing.expiresAt > at
      if (existing !== undefined && unexpired && existing.ownerWindowKey !== owner) {
        return { ok: false, reason: 'conflict', holder: existing, currentRevision: state.topic.revision }
      }

      const isTakeover = existing !== undefined && !unexpired && existing.ownerWindowKey !== owner
      const isRenew = existing !== undefined && existing.ownerWindowKey === owner
      const newRevision = isTakeover ? state.topic.revision + 2 : state.topic.revision + 1
      const eventId = this.newClaimEventId(newRevision)
      const claim: TopicClaim = {
        projectId: state.topic.projectId,
        topicId: ref.topicId,
        scope,
        scopeHash: scopeHashOf(scope),
        ownerWindowKey: owner,
        ...(input.runId === undefined ? {} : { runId: input.runId }),
        claimedAt: isRenew && existing !== undefined ? existing.claimedAt : at,
        expiresAt,
        claimEventId: eventId,
      }

      const events: TopicClaimEvent[] = [...state.claimEvents]
      const ops: TopicJournalOp[] = []
      if (isTakeover && existing !== undefined) {
        const takeoverEventId = this.newClaimEventId(state.topic.revision + 1)
        const takeoverEvent: TopicClaimEvent = {
          claimEventId: takeoverEventId,
          action: 'takeover',
          // 旧占用事实保留：这条事件是它最近一次（被接管）的占用事件。
          claim: { ...existing, claimEventId: takeoverEventId },
          actorWindowKey: owner,
          at,
          revision: state.topic.revision + 1,
          reason: '原占用已过期，被新窗口接管；历史保留',
        }
        events.push(takeoverEvent)
        ops.push({
          path: this.layout.claimHistoryFile(ref.project, ref.topicId, scope, takeoverEvent.claimEventId),
          value: takeoverEvent,
        })
      }
      const event: TopicClaimEvent = {
        claimEventId: eventId,
        action: isRenew && !isTakeover ? 'renew' : 'acquire',
        claim,
        actorWindowKey: owner,
        at,
        revision: newRevision,
      }
      events.push(event)
      ops.push({ path: this.layout.claimHistoryFile(ref.project, ref.topicId, scope, eventId), value: event })
      ops.push({ path: this.layout.claimActiveFile(ref.project, ref.topicId, scope), value: claim })

      const touched = this.touchParticipants(ref, state.participants, owner, at)
      const next: TopicState = {
        ...state,
        topic: { ...state.topic, revision: newRevision, updatedAt: at },
        participants: touched.participants,
        claimEvents: events,
        claims: claimsOf(events),
      }
      ops.push(...touched.ops)
      ops.push(...(await this.projectionOps(ref, next, at)))
      await this.commit(ops)
      return {
        ok: true,
        claim,
        revision: newRevision,
        ...(isTakeover && existing !== undefined ? { tookOver: existing } : {}),
      }
    })
  }

  async renewClaim(input: TopicClaimRenewInput): Promise<TopicClaimMutationResult> {
    await this.ready()
    const ref: TopicRef = { project: input.project, topicId: validateTopicId(input.topicId) }
    return await this.locks.run(STORAGE_LOCK, async () => {
      const scope = validateScope(input.scope)
      const owner = validateWindowKey(input.ownerWindowKey)
      const at = validateTime(input.at, 'at')
      const expiresAt = validateTime(input.expiresAt, 'expiresAt')
      if (expiresAt <= at) {
        throw new WindowError('WINDOW_INVALID_INPUT', `expiresAt 必须晚于当前时间（${expiresAt} <= ${at}）`)
      }
      const state = await this.stateOf(ref)
      this.requireParticipant(state, ref, owner)
      const holder = state.claims.find((claim) => claim.scope === scope && claim.releasedAt === undefined)
      if (holder === undefined) return { ok: false, reason: 'not-found' }
      if (holder.ownerWindowKey !== owner) return { ok: false, reason: 'not-owner', holder }

      const newRevision = state.topic.revision + 1
      const eventId = this.newClaimEventId(newRevision)
      const claim: TopicClaim = {
        ...holder,
        ...(input.runId === undefined ? {} : { runId: input.runId }),
        expiresAt,
        claimEventId: eventId,
      }
      const event: TopicClaimEvent = {
        claimEventId: eventId,
        action: 'renew',
        claim,
        actorWindowKey: owner,
        at,
        revision: newRevision,
      }
      const events = [...state.claimEvents, event]
      const touched = this.touchParticipants(ref, state.participants, owner, at)
      const next: TopicState = {
        ...state,
        topic: { ...state.topic, revision: newRevision, updatedAt: at },
        participants: touched.participants,
        claimEvents: events,
        claims: claimsOf(events),
      }
      const ops: TopicJournalOp[] = [
        { path: this.layout.claimHistoryFile(ref.project, ref.topicId, scope, eventId), value: event },
        { path: this.layout.claimActiveFile(ref.project, ref.topicId, scope), value: claim },
        ...touched.ops,
      ]
      ops.push(...(await this.projectionOps(ref, next, at)))
      await this.commit(ops)
      return { ok: true, claim, revision: newRevision }
    })
  }

  async releaseClaim(input: TopicClaimReleaseInput): Promise<TopicClaimMutationResult> {
    await this.ready()
    const ref: TopicRef = { project: input.project, topicId: validateTopicId(input.topicId) }
    return await this.locks.run(STORAGE_LOCK, async () => {
      const scope = validateScope(input.scope)
      const owner = validateWindowKey(input.ownerWindowKey)
      const at = validateTime(input.at, 'at')
      const state = await this.stateOf(ref)
      this.requireParticipant(state, ref, owner)
      const holder = state.claims.find((claim) => claim.scope === scope && claim.releasedAt === undefined)
      if (holder === undefined) return { ok: false, reason: 'not-found' }
      if (holder.ownerWindowKey !== owner) return { ok: false, reason: 'not-owner', holder }

      const newRevision = state.topic.revision + 1
      const eventId = this.newClaimEventId(newRevision)
      const claim: TopicClaim = {
        ...holder,
        releasedAt: at,
        releasedBy: owner,
        claimEventId: eventId,
      }
      const event: TopicClaimEvent = {
        claimEventId: eventId,
        action: 'release',
        claim,
        actorWindowKey: owner,
        at,
        revision: newRevision,
        ...(input.reason === undefined ? {} : { reason: input.reason }),
      }
      const events = [...state.claimEvents, event]
      const touched = this.touchParticipants(ref, state.participants, owner, at)
      const next: TopicState = {
        ...state,
        topic: { ...state.topic, revision: newRevision, updatedAt: at },
        participants: touched.participants,
        claimEvents: events,
        claims: claimsOf(events),
      }
      const ops: TopicJournalOp[] = [
        { path: this.layout.claimHistoryFile(ref.project, ref.topicId, scope, eventId), value: event },
        { path: this.layout.claimActiveFile(ref.project, ref.topicId, scope), value: claim },
        ...touched.ops,
      ]
      ops.push(...(await this.projectionOps(ref, next, at)))
      await this.commit(ops)
      return { ok: true, claim, revision: newRevision }
    })
  }

  async listClaims(ref: TopicRef, query: TopicClaimQuery = {}): Promise<TopicClaim[]> {
    await this.ready()
    return await this.locks.run(STORAGE_LOCK, async () => {
      await this.requireTopic(ref)
      const events = await this.readClaimEvents(ref, query.scope)
      let claims = claimsOf(events)
      if (query.scope !== undefined) claims = claims.filter((claim) => claim.scope === query.scope)
      if (query.includeReleased !== true) claims = claims.filter((claim) => claim.releasedAt === undefined)
      return claims.sort((a, b) => a.scopeHash.localeCompare(b.scopeHash))
    })
  }

  async listClaimEvents(ref: TopicRef, scope?: string): Promise<TopicClaimEvent[]> {
    await this.ready()
    return await this.locks.run(STORAGE_LOCK, async () => {
      await this.requireTopic(ref)
      const events = await this.readClaimEvents(ref, scope)
      return events.sort((a, b) => a.revision - b.revision || a.claimEventId.localeCompare(b.claimEventId))
    })
  }

  async releaseClaimsForRun(runId: string, options: { at?: number; reason?: string } = {}): Promise<TopicClaim[]> {
    await this.ready()
    const id = nonEmptyString(runId, 'runId')
    const at = validateTime(options.at ?? this.now(), 'at')
    return await this.locks.run(STORAGE_LOCK, async () => {
      const released: TopicClaim[] = []
      for (const project of await this.listProjectRefs()) {
        for (const topicHash of await this.listTopicHashes(project)) {
          const topic = await this.readTopicByHash(project, topicHash)
          if (topic === undefined) continue
          const ref: TopicRef = { project, topicId: topic.topicId }
          const state = await this.stateOf(ref)
          const targets = state.claims.filter((claim) => claim.runId === id && claim.releasedAt === undefined)
          if (targets.length === 0) continue
          let revision = state.topic.revision
          let events = [...state.claimEvents]
          const ops: TopicJournalOp[] = []
          for (const target of targets) {
            revision += 1
            const eventId = this.newClaimEventId(revision)
            const claim: TopicClaim = {
              ...target,
              releasedAt: at,
              releasedBy: 'dsh-window-lifecycle',
              claimEventId: eventId,
            }
            const event: TopicClaimEvent = {
              claimEventId: eventId,
              action: 'release',
              claim,
              actorWindowKey: target.ownerWindowKey,
              at,
              revision,
              reason: options.reason ?? '关联 run 已终态，对账释放占用',
            }
            events = [...events, event]
            ops.push({ path: this.layout.claimHistoryFile(project, ref.topicId, target.scope, eventId), value: event })
            ops.push({ path: this.layout.claimActiveFile(project, ref.topicId, target.scope), value: claim })
            released.push(claim)
          }
          const next: TopicState = {
            ...state,
            topic: { ...state.topic, revision, updatedAt: at },
            claimEvents: events,
            claims: claimsOf(events),
          }
          ops.push(...(await this.projectionOps(ref, next, at)))
          await this.commit(ops)
        }
      }
      return released
    })
  }

  // ----------------------------------------------------------- conflict L3

  async getConflict(ref: TopicRef, conflictId: string): Promise<TopicConflict | undefined> {
    await this.ready()
    const id = validateConflictId(conflictId)
    return await this.locks.run(STORAGE_LOCK, async () => {
      await this.requireTopic(ref)
      const conflicts = conflictsOf(await this.readEntries(ref))
      return conflicts.find((conflict) => conflict.conflictId === id)
    })
  }

  async listConflicts(ref: TopicRef, query: TopicConflictQuery = {}): Promise<TopicConflict[]> {
    await this.ready()
    return await this.locks.run(STORAGE_LOCK, async () => {
      await this.requireTopic(ref)
      const conflicts = conflictsOf(await this.readEntries(ref))
      const status = query.status ?? 'all'
      return status === 'all' ? conflicts : conflicts.filter((conflict) => conflict.status === status)
    })
  }

  // -------------------------------------------------------------- 投影重建

  async rebuildProjections(options: { project?: TopicProjectRef; topicId?: string } = {}): Promise<TopicRebuildSummary> {
    await this.ready()
    return await this.locks.run(STORAGE_LOCK, async () => await this.rebuildInternal(options))
  }

  // ------------------------------------------------------------------ 内部

  private topicLockKey(ref: TopicRef): string {
    return `topic:${projectHashOf(ref.project)}:${topicHashOf(ref.project, ref.topicId)}`
  }

  /** 懒恢复：首次操作前按 journal 重做半截事务；失败不缓存，允许下次重试。 */
  private async ready(): Promise<void> {
    if (this.readyPromise === undefined) {
      this.readyPromise = this.recoverInternal().then(() => undefined)
      void this.readyPromise.catch(() => {
        this.readyPromise = undefined
      })
    }
    try {
      await this.readyPromise
    } catch (error: unknown) {
      // 存储根/manifest/journal 层面的失败统一翻成存储不可用，不让裸 Error 透到工具层。
      if (error instanceof WindowError) throw error
      throw new WindowError('WINDOW_TOPIC_STORAGE_UNAVAILABLE', `主题台账不可用：${error instanceof Error ? error.message : String(error)}`)
    }
  }

  private async ensureRoot(): Promise<void> {
    await mkdir(this.layout.journalDir, { recursive: true, mode: 0o700 })
    const raw = await this.readJsonLenient(this.layout.manifest)
    if (raw === undefined) {
      await writeJsonAtomic(this.layout.manifest, {
        schemaVersion: TOPIC_INDEX_SCHEMA_VERSION,
        storageVersion: TOPIC_STORAGE_VERSION,
        createdAt: this.now(),
        updatedAt: this.now(),
      })
      return
    }
    if (raw === null || typeof raw !== 'object') {
      throw new WindowError('WINDOW_TOPIC_STORAGE_UNAVAILABLE', `manifest.json 损坏，拒绝读写主题台账：${this.layout.manifest}`)
    }
    const version = (raw as { storageVersion?: unknown }).storageVersion
    if (version !== TOPIC_STORAGE_VERSION) {
      throw new WindowError(
        'WINDOW_TOPIC_STORAGE_UNAVAILABLE',
        `主题台账 storageVersion=${String(version)} 与当前实现 ${TOPIC_STORAGE_VERSION} 不兼容，拒绝按新结构读取`,
      )
    }
  }

  /** 按 `_journal/` 重做半截事务；只重放落在本存储根内的目标。 */
  private async recoverInternal(): Promise<number> {
    await this.ensureRoot()
    let names: string[]
    try {
      names = await readdir(this.layout.journalDir)
    } catch (error: unknown) {
      if (isEnoent(error)) return 0
      throw error
    }
    const transactions: TopicJournalTransaction[] = []
    for (const name of names) {
      if (!name.endsWith('.json')) continue
      const raw = await this.readJson(join(this.layout.journalDir, name))
      if (raw === undefined) continue
      transactions.push(this.parseJournal(raw, name))
    }
    transactions.sort((a, b) => a.createdAt - b.createdAt || a.txId.localeCompare(b.txId))
    for (const transaction of transactions) {
      for (const op of transaction.ops) {
        this.assertOpPath(op.path)
        await writeJsonAtomic(op.path, op.value)
      }
      await unlink(this.layout.journalFile(transaction.txId)).catch(() => undefined)
    }
    return transactions.length
  }

  private parseJournal(raw: unknown, name: string): TopicJournalTransaction {
    if (raw === null || typeof raw !== 'object') {
      throw new Error(`事务记录损坏（${name}）：不是对象`)
    }
    const record = raw as { txId?: unknown; createdAt?: unknown; ops?: unknown }
    if (typeof record.txId !== 'string' || `${record.txId}.json` !== name) {
      throw new Error(`事务记录损坏（${name}）：txId 与文件名不一致`)
    }
    if (typeof record.createdAt !== 'number' || !Array.isArray(record.ops)) {
      throw new Error(`事务记录损坏（${name}）：缺少 createdAt/ops`)
    }
    const ops: TopicJournalOp[] = []
    for (const op of record.ops) {
      if (op === null || typeof op !== 'object') throw new Error(`事务记录损坏（${name}）：op 不是对象`)
      const item = op as { path?: unknown; value?: unknown }
      if (typeof item.path !== 'string') throw new Error(`事务记录损坏（${name}）：op.path 缺失`)
      ops.push({ path: item.path, value: item.value })
    }
    return { txId: record.txId, createdAt: record.createdAt, ops }
  }

  /** 事务目标必须落在本存储根内，且不能改写 journal 自身。 */
  private assertOpPath(path: string): void {
    const rel = relative(this.layout.root, path)
    if (rel.length === 0 || rel.startsWith('..') || isAbsolute(rel)) {
      throw new Error(`${OWNERSHIP}：事务目标路径不属于本存储根（${path}）`)
    }
    if (rel.split(sep)[0] === '_journal') {
      throw new Error(`${OWNERSHIP}：事务不能改写 _journal（${path}）`)
    }
  }

  /** 一次跨文件提交：先落 journal，再应用各文件，最后清 journal。 */
  private async commit(ops: TopicJournalOp[]): Promise<void> {
    const txId = `tx_${this.now()}_${randomUUID()}`
    const transaction: TopicJournalTransaction = { txId, createdAt: this.now(), ops }
    const journalPath = this.layout.journalFile(txId)
    await writeJsonAtomic(journalPath, transaction)
    for (const op of ops) {
      this.assertOpPath(op.path)
      await writeJsonAtomic(op.path, op.value)
    }
    await unlink(journalPath).catch(() => undefined)
  }

  private async cleanupInternal(): Promise<number> {
    let removed = 0
    const walk = async (dir: string, depth: number): Promise<void> => {
      if (depth > MAX_JOURNAL_DEPTH) return
      let entries: Dirent[]
      try {
        entries = await readdir(dir, { withFileTypes: true })
      } catch {
        return
      }
      for (const entry of entries) {
        const full = join(dir, entry.name)
        if (entry.isDirectory()) {
          await walk(full, depth + 1)
          continue
        }
        if (entry.name.startsWith('.') && entry.name.endsWith('.tmp')) {
          await unlink(full).catch(() => undefined)
          removed += 1
        }
      }
    }
    // 只清本存储自己的范围：projects/（金字塔）与 _journal/（事务日志）。
    // 不扫整个 root——root 下还有 run store 的 runs/，越界清理会侵入另一个存储的领地。
    await walk(this.layout.projectsDir, 0)
    await walk(this.layout.journalDir, 0)
    return removed
  }

  // ------------------------------------------------------------------ 读明细

  private async readJson(path: string): Promise<unknown | undefined> {
    let text: string
    try {
      text = await readFile(path, 'utf8')
    } catch (error: unknown) {
      if (isEnoent(error)) return undefined
      throw error
    }
    try {
      return JSON.parse(text) as unknown
    } catch {
      throw new Error(`JSON 损坏，拒绝当成事实读取：${path}`)
    }
  }

  /** 索引/汇总这类可重建投影：缺失或损坏都返回 undefined，由重建兜底。 */
  private async readJsonLenient(path: string): Promise<unknown | undefined> {
    try {
      return await this.readJson(path)
    } catch {
      return undefined
    }
  }

  private async listDirs(dir: string, pattern: RegExp): Promise<string[]> {
    let entries: Dirent[]
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch (error: unknown) {
      if (isEnoent(error)) return []
      throw error
    }
    return entries.filter((entry) => entry.isDirectory() && pattern.test(entry.name)).map((entry) => entry.name)
  }

  private async listJsonFiles(dir: string): Promise<string[]> {
    let entries: Dirent[]
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch (error: unknown) {
      if (isEnoent(error)) return []
      throw error
    }
    return entries.filter((entry) => entry.isFile() && entry.name.endsWith('.json')).map((entry) => entry.name)
  }

  private async listProjectHashes(): Promise<string[]> {
    return await this.listDirs(this.layout.projectsDir, HASH_RE)
  }

  private async listTopicHashes(project: TopicProjectRef): Promise<string[]> {
    return await this.listDirs(this.layout.topicsDir(project), HASH_RE)
  }

  private async readTopicRaw(ref: TopicRef): Promise<TopicRecord | undefined> {
    const record = await this.readTopicByHash(ref.project, topicHashOf(ref.project, ref.topicId))
    if (record === undefined) return undefined
    if (record.topicId !== ref.topicId) {
      throw new Error(`${OWNERSHIP}：哈希 ${record.topicHash} 下的 topicId=${record.topicId} 与请求的 ${ref.topicId} 不一致`)
    }
    return record
  }

  private async readTopicByHash(project: TopicProjectRef, topicHash: string): Promise<TopicRecord | undefined> {
    if (!HASH_RE.test(topicHash)) return undefined
    const path = join(this.layout.topicsDir(project), topicHash, 'topic.json')
    const raw = await this.readJson(path)
    if (raw === undefined) return undefined
    if (raw === null || typeof raw !== 'object') throw new Error(`topic.json 不是对象：${path}`)
    const record = raw as TopicRecord
    if (typeof record.topicId !== 'string' || record.topicId.length === 0) {
      throw new Error(`topic.json 缺少 topicId：${path}`)
    }
    if (record.projectId !== normalizeProjectId(project)) {
      throw new Error(`${OWNERSHIP}：${path} 的 projectId 与所在项目不一致`)
    }
    if (record.projectHash !== projectHashOf(project)) {
      throw new Error(`${OWNERSHIP}：${path} 的 projectHash 与所在目录不一致`)
    }
    if (record.topicHash !== topicHashOf(project, record.topicId) || record.topicHash !== topicHash) {
      throw new Error(`${OWNERSHIP}：${path} 的 topicHash 与所在目录不一致`)
    }
    return record
  }

  private async readSummaryRaw(ref: TopicRef): Promise<TopicSummary | undefined> {
    const raw = await this.readJsonLenient(this.layout.summaryJson(ref.project, ref.topicId))
    if (raw === null || typeof raw !== 'object') return undefined
    const summary = raw as TopicSummary
    if (summary.topicHash !== topicHashOf(ref.project, ref.topicId) || typeof summary.revision !== 'number') {
      return undefined
    }
    return summary
  }

  private async readProjectRaw(project: TopicProjectRef): Promise<ProjectSummary | undefined> {
    const raw = await this.readJsonLenient(this.layout.projectJson(project))
    if (raw === null || typeof raw !== 'object') return undefined
    const summary = raw as ProjectSummary
    if (summary.projectId !== normalizeProjectId(project) || summary.projectHash !== projectHashOf(project)) {
      return undefined
    }
    return summary
  }

  private async readIndexRaw(): Promise<GlobalIndex | undefined> {
    const raw = await this.readJsonLenient(this.layout.index)
    if (raw === null || typeof raw !== 'object') return undefined
    const index = raw as GlobalIndex
    if (!Array.isArray(index.projects)) return undefined
    return index
  }

  private async readEntries(ref: TopicRef): Promise<TopicEntry[]> {
    const dir = this.layout.entriesDir(ref.project, ref.topicId)
    const names = await this.listJsonFiles(dir)
    const entries: TopicEntry[] = []
    for (const name of names) {
      const match = ENTRY_FILE_RE.exec(name)
      if (match === null) continue
      const raw = await this.readJson(join(dir, name))
      if (raw === undefined) continue
      if (raw === null || typeof raw !== 'object') throw new Error(`entry 记录不是对象：${name}`)
      const entry = raw as TopicEntry
      if (entry.projectId !== normalizeProjectId(ref.project) || entry.topicId !== ref.topicId) {
        throw new Error(`${OWNERSHIP}：${name} 的 projectId/topicId 与所在路径不一致`)
      }
      if (entry.entryId !== match[2] || entry.revision !== Number(match[1])) {
        throw new Error(`${OWNERSHIP}：${name} 的文件名与记录内容不一致`)
      }
      entries.push(entry)
    }
    return entries.sort((a, b) => a.revision - b.revision || a.entryId.localeCompare(b.entryId))
  }

  private async readParticipants(ref: TopicRef): Promise<TopicParticipant[]> {
    const dir = this.layout.participantsDir(ref.project, ref.topicId)
    const names = await this.listJsonFiles(dir)
    const participants: TopicParticipant[] = []
    for (const name of names) {
      const raw = await this.readJson(join(dir, name))
      if (raw === undefined) continue
      if (raw === null || typeof raw !== 'object') throw new Error(`参与者记录不是对象：${name}`)
      const participant = raw as TopicParticipant
      if (participant.projectId !== normalizeProjectId(ref.project) || participant.topicId !== ref.topicId) {
        throw new Error(`${OWNERSHIP}：${name} 的 projectId/topicId 与所在路径不一致`)
      }
      if (`${participantHashOf(participant.windowKey, participant.scenario)}.json` !== name) {
        throw new Error(`${OWNERSHIP}：${name} 的文件名与参与者身份不一致`)
      }
      if (participant.participationId !== `p_${participantHashOf(participant.windowKey, participant.scenario)}`) {
        throw new Error(`${OWNERSHIP}：${name} 的 participationId 与参与者身份不一致`)
      }
      participants.push(participant)
    }
    return participants.sort((a, b) => a.joinedAt - b.joinedAt || a.participationId.localeCompare(b.participationId))
  }

  private async readClaimEvents(ref: TopicRef, scope?: string): Promise<TopicClaimEvent[]> {
    const claimsDir = this.layout.claimsDir(ref.project, ref.topicId)
    const scopeHashes = scope === undefined ? await this.listDirs(claimsDir, HASH_RE) : [scopeHashOf(scope)]
    const events: TopicClaimEvent[] = []
    for (const scopeHash of scopeHashes) {
      if (!HASH_RE.test(scopeHash)) continue
      const historyDir = join(claimsDir, scopeHash, 'history')
      for (const name of await this.listJsonFiles(historyDir)) {
        const raw = await this.readJson(join(historyDir, name))
        if (raw === undefined) continue
        if (raw === null || typeof raw !== 'object') throw new Error(`占用事件不是对象：${name}`)
        const event = raw as TopicClaimEvent
        const claim = event.claim
        if (claim === null || typeof claim !== 'object') throw new Error(`占用事件缺少 claim：${name}`)
        if (claim.projectId !== normalizeProjectId(ref.project) || claim.topicId !== ref.topicId) {
          throw new Error(`${OWNERSHIP}：${name} 的 projectId/topicId 与所在路径不一致`)
        }
        if (claim.scopeHash !== scopeHash) throw new Error(`${OWNERSHIP}：${name} 的 scopeHash 与所在目录不一致`)
        if (event.claimEventId !== claim.claimEventId || `${event.claimEventId}.json` !== name) {
          throw new Error(`${OWNERSHIP}：${name} 的 claimEventId 与记录不一致`)
        }
        events.push(event)
      }
    }
    return events
  }

  /** 读 L3 明细快照；主题不存在时抛 WINDOW_TOPIC_NOT_FOUND。 */
  private async stateOf(ref: TopicRef): Promise<TopicState> {
    const topic = await this.requireTopic(ref)
    const entries = await this.readEntries(ref)
    const participants = await this.readParticipants(ref)
    const claimEvents = await this.readClaimEvents(ref)
    return {
      topic,
      entries,
      participants,
      claimEvents,
      claims: claimsOf(claimEvents),
      conflicts: conflictsOf(entries),
    }
  }

  private async requireTopic(ref: TopicRef): Promise<TopicRecord> {
    const topic = await this.readTopicRaw(ref)
    if (topic === undefined) {
      throw new WindowError('WINDOW_TOPIC_NOT_FOUND', `主题不存在或不属于当前项目：${ref.topicId}`)
    }
    return topic
  }

  private requireParticipant(state: TopicState, ref: TopicRef, windowKey: string): void {
    const found = state.participants.some(
      (participant) => participant.windowKey === windowKey && participant.status !== 'left',
    )
    if (!found) {
      throw new WindowError(
        'WINDOW_TOPIC_FORBIDDEN',
        `窗口 ${windowKey} 不是主题 ${ref.topicId} 的参与者，先 window_topic_join`,
      )
    }
  }

  private async findParticipant(ref: TopicRef, windowKey: string): Promise<TopicParticipant | undefined> {
    const participants = await this.readParticipants(ref)
    return participants.find((participant) => participant.windowKey === windowKey)
  }

  private buildParticipant(
    ref: TopicRef,
    windowKey: string,
    scenario: Scenario,
    status: TopicParticipant['status'],
    role: TopicParticipant['role'],
    at: number,
  ): TopicParticipant {
    const hash = participantHashOf(windowKey, scenario)
    return {
      participationId: `p_${hash}`,
      projectId: normalizeProjectId(ref.project),
      topicId: ref.topicId,
      windowKey,
      scenario,
      role,
      status,
      joinedAt: at,
      lastSeenAt: at,
    }
  }

  /** 更新调用方参与者的 lastSeenAt；不推进 revision。 */
  private touchParticipants(
    ref: TopicRef,
    participants: TopicParticipant[],
    windowKey: string,
    at: number,
  ): { participants: TopicParticipant[]; ops: TopicJournalOp[] } {
    const ops: TopicJournalOp[] = []
    const next = participants.map((participant) => {
      if (participant.windowKey !== windowKey || participant.lastSeenAt === at) return participant
      const updated: TopicParticipant = { ...participant, lastSeenAt: at }
      ops.push({
        path: this.layout.participantFile(
          ref.project,
          ref.topicId,
          participantHashOf(participant.windowKey, participant.scenario),
        ),
        value: updated,
      })
      return updated
    })
    return { participants: next, ops }
  }

  /** supersedes 必须指向本主题既有 entry，且必须同时给出替代理由。 */
  private resolveSupersedes(state: TopicState, input: TopicEntryAppendInput): string | undefined {
    const target = input.supersedesEntryId
    const reason = typeof input.supersedesReason === 'string' ? input.supersedesReason.trim() : ''
    if (target === undefined) {
      if (reason.length > 0) {
        throw new WindowError('WINDOW_INVALID_INPUT', 'supersedes_reason 必须与 supersedes_entry_id 同时给出')
      }
      return undefined
    }
    const entryId = validateEntryId(target)
    if (!state.entries.some((entry) => entry.entryId === entryId)) {
      throw new WindowError('WINDOW_INVALID_INPUT', `supersedes_entry_id 指向的 entry 不存在：${entryId}`)
    }
    if (reason.length === 0) {
      throw new WindowError('WINDOW_INVALID_INPUT', 'supersedes_entry_id 必须与 supersedes_reason 同时给出')
    }
    return entryId
  }

  private resolveRelatedEntries(state: TopicState, related: string[] | undefined): string[] {
    if (related === undefined) return []
    const ids: string[] = []
    for (const raw of related) {
      const entryId = validateEntryId(raw)
      if (!state.entries.some((entry) => entry.entryId === entryId)) {
        throw new WindowError('WINDOW_INVALID_INPUT', `related_entry_ids 指向的 entry 不存在：${entryId}`)
      }
      if (!ids.includes(entryId)) ids.push(entryId)
    }
    return ids
  }

  private newClaimEventId(revision: number): string {
    return `cl_${padRevision(revision)}_${randomUUID()}`
  }

  // ---------------------------------------------------------------- 投影写入

  /** 派生 L2 汇总 + L1 项目摘要 + L0 索引，与明细同事务提交。 */
  private async projectionOps(ref: TopicRef, state: TopicState, at: number): Promise<TopicJournalOp[]> {
    const summary = summaryOf(state, at)
    const ops: TopicJournalOp[] = [
      { path: this.layout.summaryJson(ref.project, ref.topicId), value: summary },
      { path: this.layout.topicJson(ref.project, ref.topicId), value: state.topic },
    ]
    const topicRefs = await this.projectTopicRefs(ref, state, summary, at)
    const project = projectSummaryOf(ref.project, topicRefs, at)
    ops.push({ path: this.layout.projectJson(ref.project), value: project })
    const existing = await this.readIndexRaw()
    const projects = existing === undefined
      ? await this.collectIndexProjects(project, at)
      : [...existing.projects.filter((item) => item.projectId !== project.projectId), indexProjectOf(project, at)]
    ops.push({ path: this.layout.index, value: indexOf(projects, at) })
    return ops
  }

  /** 同项目其它主题的指针；当前主题用内存里的最新状态覆盖。 */
  private async projectTopicRefs(
    ref: TopicRef,
    state: TopicState,
    summary: TopicSummary,
    at: number,
  ): Promise<ProjectTopicRef[]> {
    const refs: ProjectTopicRef[] = [projectTopicRefOf(summary, state.topic)]
    for (const topicHash of await this.listTopicHashes(ref.project)) {
      if (topicHash === state.topic.topicHash) continue
      const sibling = await this.readTopicByHash(ref.project, topicHash)
      if (sibling === undefined) continue
      const siblingRef: TopicRef = { project: ref.project, topicId: sibling.topicId }
      let siblingSummary = await this.readSummaryRaw(siblingRef)
      if (siblingSummary === undefined || siblingSummary.revision !== sibling.revision) {
        siblingSummary = summaryOf(await this.stateOf(siblingRef), at)
      }
      refs.push(projectTopicRefOf(siblingSummary, sibling))
    }
    return refs
  }

  /** 索引缺失/损坏时从磁盘上的项目摘要重建 L0；当前项目用内存结果覆盖。 */
  private async collectIndexProjects(current: ProjectSummary, at: number): Promise<GlobalIndexProject[]> {
    const projects: GlobalIndexProject[] = []
    for (const project of await this.listProjectRefs()) {
      if (project.projectId === current.projectId) continue
      const stored = await this.readProjectRaw(project)
      const summary = stored ?? (await this.projectSummaryFromTopics(project, at))
      projects.push(indexProjectOf(summary, at))
    }
    projects.push(indexProjectOf(current, at))
    return projects
  }

  private async projectSummaryFromTopics(project: TopicProjectRef, at: number): Promise<ProjectSummary> {
    const refs: ProjectTopicRef[] = []
    for (const topicHash of await this.listTopicHashes(project)) {
      const topic = await this.readTopicByHash(project, topicHash)
      if (topic === undefined) continue
      const ref: TopicRef = { project, topicId: topic.topicId }
      let summary = await this.readSummaryRaw(ref)
      if (summary === undefined || summary.revision !== topic.revision) {
        summary = summaryOf(await this.stateOf(ref), at)
      }
      refs.push(projectTopicRefOf(summary, topic))
    }
    return projectSummaryOf(project, refs, at)
  }

  private async listProjectRefs(): Promise<TopicProjectRef[]> {
    const refs: TopicProjectRef[] = []
    for (const hash of await this.listProjectHashes()) {
      const ref = await this.readProjectRefByHash(hash)
      if (ref !== undefined) refs.push(ref)
    }
    return refs
  }

  /** 从 project.json 认项目身份；缺失时回落到该项目下任一 topic.json。 */
  private async readProjectRefByHash(hash: string): Promise<TopicProjectRef | undefined> {
    const projectDir = join(this.layout.projectsDir, hash)
    const raw = await this.readJsonLenient(join(projectDir, 'project.json'))
    if (raw !== null && typeof raw === 'object') {
      const summary = raw as ProjectSummary
      if (typeof summary.projectId === 'string' && isTopicProjectSource(summary.projectSource)) {
        const ref: TopicProjectRef = { projectId: summary.projectId, source: summary.projectSource }
        if (projectHashOf(ref) === hash) return ref
      }
    }
    for (const topicHash of await this.listDirs(join(projectDir, 'topics'), HASH_RE)) {
      const topicRaw = await this.readJsonLenient(join(projectDir, 'topics', topicHash, 'topic.json'))
      if (topicRaw === null || typeof topicRaw !== 'object') continue
      const topic = topicRaw as TopicRecord
      if (typeof topic.projectId !== 'string' || !isTopicProjectSource(topic.projectSource)) continue
      const ref: TopicProjectRef = { projectId: topic.projectId, source: topic.projectSource }
      if (projectHashOf(ref) === hash) return ref
    }
    return undefined
  }

  private async indexIsFresh(index: GlobalIndex): Promise<boolean> {
    const hashes = await this.listProjectHashes()
    if (index.projects.length !== hashes.length) return false
    for (const project of await this.listProjectRefs()) {
      const entry = index.projects.find((item) => item.projectId === project.projectId)
      if (entry === undefined) return false
      const stored = await this.readProjectRaw(project)
      if (stored === undefined || stored.updatedAt !== entry.updatedAt) return false
    }
    return true
  }

  private async projectIsFresh(project: TopicProjectRef, summary: ProjectSummary): Promise<boolean> {
    const hashes = await this.listTopicHashes(project)
    if (hashes.length !== summary.topics.length) return false
    for (const hash of hashes) {
      const topic = await this.readTopicByHash(project, hash)
      if (topic === undefined) return false
      const ref = summary.topics.find((item) => item.topicId === topic.topicId)
      if (ref === undefined || ref.revision !== topic.revision || ref.topicHash !== hash) return false
      const stored = await this.readSummaryRaw({ project, topicId: topic.topicId })
      if (stored === undefined || stored.revision !== topic.revision) return false
      if (
        ref.participantCount !== stored.participants.length
        || ref.activeClaimCount !== stored.activeClaims.length
        || ref.unresolvedCount !== stored.unresolvedConflicts.length
      ) {
        return false
      }
    }
    return true
  }

  /** L2 汇总是否仍与 L3 明细对得上；对不上就按明细重建（不静默相信陈旧摘要）。 */
  private async summaryLooksFresh(ref: TopicRef, topic: TopicRecord, summary: TopicSummary): Promise<boolean> {
    if (summary.revision !== topic.revision || summary.topicHash !== topic.topicHash) return false
    const entries = await this.listJsonFiles(this.layout.entriesDir(ref.project, ref.topicId))
    if (summary.entryCount !== entries.length) return false
    const participants = await this.listJsonFiles(this.layout.participantsDir(ref.project, ref.topicId))
    return summary.participants.length === participants.length
  }

  /** 从 L3 明细重建 L2/L1/L0；revision 只增不减（取明细与已存值中的最大者）。 */
  private async rebuildInternal(options: { project?: TopicProjectRef; topicId?: string } = {}): Promise<TopicRebuildSummary> {
    const at = this.now()
    const projects = options.project === undefined ? await this.listProjectRefs() : [options.project]
    let topics = 0
    let entries = 0
    for (const project of projects) {
      const refs: ProjectTopicRef[] = []
      const hashes = options.topicId === undefined
        ? await this.listTopicHashes(project)
        : [topicHashOf(project, options.topicId)]
      for (const hash of hashes) {
        const stored = await this.readTopicByHash(project, hash)
        if (stored === undefined) continue
        const ref: TopicRef = { project, topicId: stored.topicId }
        const state = await this.stateOf(ref)
        const revision = Math.max(
          stored.revision,
          1,
          ...state.entries.map((entry) => entry.revision),
          ...state.claimEvents.map((event) => event.revision),
        )
        const topic: TopicRecord = revision === stored.revision ? stored : { ...stored, revision, updatedAt: at }
        const next: TopicState = { ...state, topic }
        const summary = summaryOf(next, at)
        for (const claim of next.claims) {
          await writeJsonAtomic(this.layout.claimActiveFile(project, ref.topicId, claim.scope), claim)
        }
        for (const conflict of next.conflicts) {
          await writeJsonAtomic(this.layout.conflictJson(project, ref.topicId, conflict.conflictId), conflict)
        }
        for (const entry of next.entries) {
          if (entry.kind !== 'resolution' || entry.conflictId === undefined) continue
          const record: TopicResolutionRecord = {
            entryId: entry.entryId,
            conflictId: entry.conflictId,
            windowKey: entry.windowKey,
            at: entry.createdAt,
            ...(entry.decisionKey === undefined ? {} : { decisionKey: entry.decisionKey }),
            summary: boundText(entry.content),
          }
          await writeJsonAtomic(this.layout.resolutionFile(project, ref.topicId, entry.conflictId, entry.entryId), record)
        }
        await writeJsonAtomic(this.layout.topicJson(project, ref.topicId), topic)
        await writeJsonAtomic(this.layout.summaryJson(project, ref.topicId), summary)
        refs.push(projectTopicRefOf(summary, topic))
        topics += 1
        entries += state.entries.length
      }
      await writeJsonAtomic(this.layout.projectJson(project), projectSummaryOf(project, refs, at))
    }
    const indexProjects: GlobalIndexProject[] = []
    for (const project of await this.listProjectRefs()) {
      const stored = await this.readProjectRaw(project)
      const summary = stored ?? (await this.projectSummaryFromTopics(project, at))
      indexProjects.push(indexProjectOf(summary, at))
    }
    await writeJsonAtomic(this.layout.index, indexOf(indexProjects, at))
    return { projects: projects.length, topics, entries }
  }
}

/** limit 归一：正整数，上限 100。 */
function normalizeLimit(raw: number | undefined): number {
  if (raw === undefined) return DEFAULT_ENTRY_LIMIT
  if (!Number.isSafeInteger(raw) || raw < 1) {
    throw new WindowError('WINDOW_INVALID_INPUT', `limit 必须是正整数（收到 ${String(raw)}）`)
  }
  return Math.min(raw, MAX_ENTRY_LIMIT)
}

/** 分页游标：非负整数字符串。 */
function decodeCursor(cursor: string | undefined): number {
  if (cursor === undefined || cursor.trim().length === 0) return 0
  if (!/^\d+$/.test(cursor)) {
    throw new WindowError('WINDOW_INVALID_INPUT', `cursor 非法（${cursor}）`)
  }
  return Number(cursor)
}
