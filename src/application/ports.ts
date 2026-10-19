/**
 * 应用层端口：开窗用例只依赖这些结构类型，不 import 宿主包，便于纯单测。
 *
 * @module dsh-window/application/ports
 */
import type { OpenWindowInput, RunTerminalStatus, Scenario, WindowMode } from '../shared/protocol.js'

/** 继承三态：set = 已写入；skipped = 源本来没有；failed = 想做没做成。 */
export type WindowInheritanceStatus = 'set' | 'skipped' | 'failed'

/** 会话模型选择读数。 */
export interface WindowModelSelection {
  provider: string
  model: string
  reasoningEffort?: string
}

/** 源会话画像；三项都可独立缺失。 */
export interface WindowSourceProfile {
  title?: string
  agentPreset?: string
  modelSelection?: WindowModelSelection
}

/** 读画像结果：要么拿到画像，要么带原因说明读不到。 */
export interface WindowProfileRead {
  profile?: WindowSourceProfile
  reason?: string
}

/** 新建会话的落点；workspaceId 与 cwd 互斥。 */
export interface WindowCreateOptions {
  workspaceId?: string
  cwd?: string
  agentPreset?: string
}

/** 继承回执：三项状态并列，不折叠成败。 */
export interface WindowInheritance {
  title: WindowInheritanceStatus
  preset: WindowInheritanceStatus
  model: WindowInheritanceStatus
  reasons: string[]
}

/** 开窗端口结果；成功必须给出非空且不等于源的窗口码。 */
export type OpenWindowOutcome =
  | { ok: true; windowKey: string; parentSessionId?: string }
  | {
      ok: false
      code: 'unavailable_no_completed_turn' | 'open_failed' | 'opener_unavailable'
      reason: string
    }

/** 会话开窗端口：唯一 I/O 实现由 adapters 提供。 */
export interface WindowOpenerPort {
  /** 本宿主是否具备开窗能力。 */
  available(): boolean
  /** 从源会话 fork 一个新会话。 */
  fork(sourceSessionId: string, atSeq?: number): Promise<OpenWindowOutcome>
  /** 创建一个全新会话。 */
  create(opts?: WindowCreateOptions): Promise<OpenWindowOutcome>
  /** 源会话所属项目；拿不到返回 undefined，不猜。 */
  resolveSourceProject?(sourceSessionId: string): WindowCreateOptions | undefined
  /** 冷读源会话画像；读不到必须抛错，不得静默返回 undefined。 */
  readProfile?(sessionId: string): Promise<WindowSourceProfile>
  /** 写定会话标题。 */
  rename?(sessionId: string, title: string): Promise<void>
  /** 写定会话模型。 */
  selectModel?(sessionId: string, selection: WindowModelSelection): Promise<void>
}

/** 自署消息工厂与投递端口。 */
export interface SeedDeliveryPort {
  /** 造一条自署来源消息；kind 永不为 user。 */
  createMessage(params: {
    text: string
    kind: string
    scenario: Scenario
    runId?: string
    /** 可选确定性消息 id；回调使用 callbackId 以保证重试同一条逻辑消息。 */
    messageId?: string
    /** FR-7：回调来源读数，便于按 child/callbackId 对账。 */
    childSessionId?: string
    callbackId?: string
  }): { message: unknown; messageId: string }
  /** 投给任意窗口；冷会话可先 resume。永不抛，返回结构化结果。 */
  deliver(windowKey: string, message: unknown): Promise<{ delivered: boolean; reason?: string }>
}

/** 运行终态。 */
export type { RunTerminalStatus }

/** 运行状态。 */
export type RunStatus = 'pending' | 'running' | RunTerminalStatus | 'seed_failed' | 'orphaned'

/** 已落盘的完成结果。 */
export interface RunResult {
  status: RunTerminalStatus
  content: string
  /** 结构化结果；仅在 run 声明 outputSchema 且 status=completed 时必填并通过校验。 */
  structured?: unknown
  /** 绑定 topic 时的共享完成 id；topic completion entry 用它对齐，不复制正文。 */
  completionEntryId?: string
  /** 绑定 topic 时写入 completion entry 后的主题 revision。 */
  topicRevision?: number
  completedAt: number
  completedBy: string
}

/** JSON Schema 校验端口；唯一实现见 adapters/jsonSchemaGuard。 */
export interface SchemaGuardPort {
  /** 断言 schema 属于允许子集且是 object 根；非法抛错。 */
  assertObjectSchema(raw: unknown): void
  /** 校验值是否符合 schema；返回路径化 violations，空数组表示通过。 */
  validate(schema: unknown, value: unknown, path?: string): string[]
}

/** 回调投递状态；与业务 run 状态分离。 */
export interface RunCallbackState {
  status: 'not_armed' | 'not_requested' | 'pending' | 'delivered' | 'failed' | 'unknown'
  callbackId?: string
  attempts: number
  reason?: string
  deliveredAt?: number
}

/** 生命周期状态：active 正常；stopped = origin 主动停；orphaned = origin 不在线或超时；drained = 卸载排空。 */
export interface RunLifecycle {
  state: 'active' | 'stopped' | 'orphaned' | 'drained'
  reason?: string
  at: number
}

/** guidance 留痕（§7.5）；只存正文摘要，不默认保存敏感全文。 */
export interface RunMessage {
  messageId: string
  runId: string
  senderSessionId: string
  targetSessionId: string
  kind: string
  textDigest: string
  at: number
  deliveredAt?: number
}

/** 只读访问留痕（§8：window_inspect 读取行为必须留痕）。 */
export interface RunAuditEvent {
  eventId: string
  actorSessionId: string
  targetSessionId: string
  action: 'inspect'
  includeHistory: boolean
  at: number
}

/** branch 运行记录。 */
export interface RunRecord {
  runId: string
  scenario: 'branch'
  /** open = 新建会话；dispatch = 复用已有 child。旧记录缺省按 open 处理。 */
  createdBy?: 'open' | 'dispatch'
  originSessionId: string
  childSessionId: string
  mode: WindowMode
  title?: string
  topicId?: string
  /** run 绑定 topic 时记录开跑时读取的主题 revision（§7.1）。 */
  startedTopicRevision?: number
  seedMessageId?: string
  status: RunStatus
  /** seed 已送达时为 true；只有 armed 的 run 才接受首次完成。 */
  callbackArmed: boolean
  result?: RunResult
  callback?: RunCallbackState
  /** 结构化结果契约（object 根 JSON Schema 子集）；声明后 completed 必须带 structured。 */
  outputSchema?: unknown
  /** 创建时是否显式要求结构化结果；true 时必须有 outputSchema。 */
  resultRequired?: boolean
  /** 生命周期归属；缺省视为 active。 */
  lifecycle?: RunLifecycle
  /** 最近一次 seed/guidance/控制操作或状态变化时间；旧记录缺省按 updatedAt 处理。不随每个回合刷新。 */
  lastActivityAt?: number
  createdAt: number
  updatedAt: number
}

/** RunListIndex 的一行投影；只含清单所需字段，不含 result 正文。 */
export interface RunIndexRow {
  runId: string
  createdBy: 'open' | 'dispatch'
  originSessionId: string
  childSessionId: string
  runStatus: RunStatus
  callbackStatus: RunCallbackState['status']
  callbackAttempts: number
  /** 生命周期状态（§7.5）；缺省视为 active。 */
  lifecycleState?: RunLifecycle['state']
  topicId?: string
  lastActivityAt: number
  createdAt: number
  updatedAt: number
}

/** 控制事件留痕；append-only。 */
export interface RunControlEvent {
  eventId: string
  runId: string
  kind: 'send' | 'interrupt-turn' | 'interrupt-run' | 'stop' | 'orphan' | 'drain'
  actorSessionId: string
  reason?: string
  at: number
  result: 'accepted' | 'failed' | 'target-offline'
  /** guidance 的确定性消息 id（仅 kind=send）。 */
  messageId?: string
  /** guidance 正文摘要/哈希；不存敏感全文。 */
  textDigest?: string
}

/** 目标 agent 的引导/中断端口；唯一实现见 adapters/agentControl。 */
export interface AgentControlPort {
  /** 运行中 steer，空闲 followup；永不抛。 */
  steer(windowKey: string, message: unknown): Promise<{ delivered: boolean; mode: 'steered' | 'queued' | 'failed'; reason?: string }>
  /** 取消目标当前轮次；永不抛。 */
  cancelTurn(windowKey: string, reason: string): Promise<{ accepted: boolean; reason?: string }>
}

/** 运行记录持久化端口。 */
export interface RunStorePort {
  /** 存储是否可用；branch 在开窗前必须确认。 */
  available(): boolean
  create(record: RunRecord): Promise<void>
  update(runId: string, patch: Partial<RunRecord>): Promise<void>
  get(runId: string): Promise<RunRecord | undefined>
  /** 列出所有 run；用于“省略 run_id 且唯一活动 run”的定位。 */
  list(): Promise<RunRecord[]>
  /** 以 runId 为键串行化一段读改写；同进程并发完成/重试必须走它。 */
  withLock<T>(runId: string, operation: () => Promise<T>): Promise<T>
  /** 读取可重建的 RunListIndex；缺失/陈旧实现自行重建。可选，缺失时调用方回落 list()。 */
  listIndex?(): Promise<RunIndexRow[]>
  /** 从 run.json 重建 RunListIndex 并返回。可选。 */
  rebuildIndex?(): Promise<RunIndexRow[]>
  /** 追加一条控制事件到 control.jsonl。可选。 */
  appendControl?(runId: string, event: RunControlEvent): Promise<void>
  /** 读取某 run 的控制事件（测试/诊断用）。可选。 */
  readControl?(runId: string): Promise<RunControlEvent[]>
  /** 追加一条 guidance 留痕到 messages.jsonl。可选。 */
  appendMessage?(runId: string, message: RunMessage): Promise<void>
  /** 读取某 run 的 guidance 留痕。可选。 */
  readMessages?(runId: string): Promise<RunMessage[]>
  /** 追加一条只读访问留痕到插件根 audit.jsonl。可选。 */
  appendAudit?(event: RunAuditEvent): Promise<void>
  /** 读取只读访问留痕。可选。 */
  readAudit?(): Promise<RunAuditEvent[]>
  /** 订阅 run 变更（create/update/remove）；返回取消订阅。可选；缺失时调用方走有界轮询。 */
  watch?(listener: () => void): () => void
  /** 等待本存储内部待排空的写入落定；drain 用。可选。 */
  settle?(): Promise<void>
  /** 清理半截临时文件；返回清理数量。可选。 */
  cleanup?(): Promise<number>
  /** 卸载时的同步 best-effort 排空：把 active run 标 drained 并写 drain 控制记录；返回处理的 runId。可选。 */
  drainActiveRunsSync?(reason: string, at: number): string[]
}

/** 会话只读探测器：window_inspect 的宿主端口。 */
export interface WindowInspectPort {
  /** 读会话元数据（不激活 Agent）。 */
  inspect(windowKey: string): Promise<WindowInspectMeta>
  /** 按需分页读历史；默认不返回完整对话。 */
  history(
    windowKey: string,
    options: { cursor?: string; limit?: number; signal?: AbortSignal },
  ): Promise<{ items: WindowHistoryItem[]; nextCursor?: string }>
}

/** 会话元数据（window_inspect 默认返回）。 */
export interface WindowInspectMeta {
  windowKey: string
  title?: string
  cwd?: string
  parentSessionId?: string
  origin?: string
  agentPreset?: string
  modelSelection?: WindowModelSelection
  /** true/false = 在线注册表状态；null = 冷会话或无法判定。 */
  running: boolean | null
  updatedAt?: number
  eventCount?: number
}

/** 一条历史记录（有界文本）。 */
export interface WindowHistoryItem {
  seq: number
  type: string
  time: number
  role?: string
  sourceKind?: string
  text: string
}

/* -------------------------------------------------------------------------- *
 * Topic Ledger（FR-11 / FR-12；记录字段见需求 §7.3、路径见 §7.4）
 *
 * 端口只描述持久化事实（L3 明细）与可重建投影（L0/L1/L2 汇总）：
 * - 参与者授权（谁可读、谁可写、只能操作自己的占用）由用例层判定，
 *   存储层只做“该窗口是不是本主题参与者 / 是不是占用者”的事实校验；
 * - revision CAS 失败与 scope 占用冲突是预期并发结果，用返回值表达；
 *   契约错误（缺 base_revision、目标不一致、非参与者）才抛 WindowError；
 * - 汇总投影一律由 L3 明细派生，明细与汇总不一致时以明细为准并重建。
 * -------------------------------------------------------------------------- */

/** 项目身份来源：优先 workspaceId，无 workspace 时才用规范化 cwd 并显式标记。 */
export type TopicProjectSource = 'workspaceId' | 'cwd'

/** 项目引用；同一项目在整个存储内必须始终使用同一 projectId + source。 */
export interface TopicProjectRef {
  /** workspaceId，或（source='cwd' 时）规范化后的 cwd。 */
  projectId: string
  source: TopicProjectSource
}

/** 主题定位：项目引用 + 业务 topicId；模型只能拿到 ID，拿不到物理路径。 */
export interface TopicRef {
  project: TopicProjectRef
  topicId: string
}

/** 参与状态：pending = 已登记未送达 seed；seed_failed = seed 投递失败；left = 已退出。 */
export type TopicParticipantStatus = 'active' | 'pending' | 'seed_failed' | 'left'

/** 参与角色；只描述本主题内的协作位置，不复制外部业务插件的 owner 授权。 */
export type TopicParticipantRole = 'owner' | 'participant' | 'observer'

/** L3 参与者明细；每个 (windowKey, scenario) 一条，重复 join 只更新 status/lastSeenAt。 */
export interface TopicParticipant {
  participationId: string
  projectId: string
  topicId: string
  windowKey: string
  scenario: Scenario
  role: TopicParticipantRole
  status: TopicParticipantStatus
  joinedAt: number
  lastSeenAt: number
}

/** 登记（或重复登记）一个参与者；只允许用例层传调用方自己的 windowKey。 */
export interface TopicParticipantInput {
  project: TopicProjectRef
  topicId: string
  windowKey: string
  scenario: Scenario
  status: TopicParticipantStatus
  /** 仅首次登记生效；重复 join 不覆盖首次角色。 */
  role?: TopicParticipantRole
  at: number
}

/** 主题 entry 类型；全部 append-only。 */
export type TopicEntryKind = 'progress' | 'decision' | 'completion' | 'conflict' | 'resolution'

/** 需要 base_revision 做 CAS 的 entry 类型（§6.8）。 */
export const TOPIC_CAS_ENTRY_KINDS = ['decision', 'completion', 'conflict', 'resolution'] as const

/** L3 entry 明细；只能追加，修正历史用 supersedes 指向新记录。 */
export interface TopicEntry {
  entryId: string
  projectId: string
  topicId: string
  /** 写入后的主题 revision；同一主题内严格递增。 */
  revision: number
  windowKey: string
  kind: TopicEntryKind
  content: string
  /** 调用方写入时读取并携带的 revision；progress 可缺省。 */
  baseRevision?: number
  createdAt: number
  /** 关联的分支 run（completion 等）。 */
  runId?: string
  /** 共享完成 id；run result 与 completion entry 用它对齐，不复制 structured 正文。 */
  completionId?: string
  /** 决策的稳定键；同键不同结论用于冲突检测。 */
  decisionKey?: string
  /** 产物路径或 ID 引用，不复制文件内容。 */
  artifactRefs?: string[]
  /** 本记录替代的旧记录；必须与 supersedesReason 同时给出。 */
  supersedesEntryId?: string
  supersedesReason?: string
  /** decision/completion 为 candidate 时为 false；其余记录恒为 true。 */
  effective?: boolean
  /** 关联冲突；resolution 记录用指向它正在解决的冲突。 */
  conflictId?: string
  /** 本记录与之矛盾/相关的既有 entry（显式 conflict 与 candidate 使用）。 */
  relatedEntryIds?: string[]
}

/** `appendEntry` 入参。 */
export interface TopicEntryAppendInput {
  project: TopicProjectRef
  topicId: string
  windowKey: string
  kind: TopicEntryKind
  /** 非空摘要或结论；不写完整对话。 */
  content: string
  /** 由插件生成且路径安全；重复写入同一 entryId 按幂等返回既有记录。 */
  entryId: string
  baseRevision?: number
  runId?: string
  completionId?: string
  decisionKey?: string
  artifactRefs?: string[]
  supersedesEntryId?: string
  supersedesReason?: string
  /** kind='conflict' 时列出与之矛盾的既有 entry。 */
  relatedEntryIds?: string[]
  /** kind='resolution' 时必填。 */
  conflictId?: string
  at: number
}

/** CAS 结果：ok=false 时 currentRevision 是调用方必须重读的最新版本。 */
export type TopicCasResult<T> =
  | { ok: true; value: T }
  | { ok: false; currentRevision: number }

/** `appendEntry` 结果。 */
export interface TopicEntryAppendResult {
  entry: TopicEntry
  /** 写入后的主题 revision。 */
  revision: number
  /** false = 只作为 candidate/witness 保存，尚未成为有效结论。 */
  effective: boolean
  /** 本次写入产生（或涉及）的冲突。 */
  conflict?: TopicConflict
  /** 被本记录替代的旧有效记录（历史保留）。 */
  supersededEntryId?: string
}

/** L3 明细分页读取。 */
export interface TopicEntryQuery {
  /** 非负整数字符串游标；缺省从最新一条开始。 */
  cursor?: string
  /** 每页条数，默认 20，上限 100。 */
  limit?: number
  kinds?: TopicEntryKind[]
}

/** 一页 L3 entry（最新在前）。 */
export interface TopicEntryPage {
  entries: TopicEntry[]
  nextCursor?: string
  total: number
}

/** 协作占用声明；同一 scope 同时最多一个未释放且未过期的占用。 */
export interface TopicClaim {
  projectId: string
  topicId: string
  /** 任务/模块/文件范围的稳定字符串；不入路径，只存 hash。 */
  scope: string
  scopeHash: string
  ownerWindowKey: string
  runId?: string
  claimedAt: number
  expiresAt: number
  /** 已释放时间；缺省表示未释放（可能已过期）。 */
  releasedAt?: number
  releasedBy?: string
  /** 最近一次占用事件 id；接管时用于指认被接管的历史。 */
  claimEventId: string
}

/** 占用事件类型。 */
export type TopicClaimAction = 'acquire' | 'renew' | 'release' | 'takeover'

/** L3 占用历史事件；active 投影由它派生。 */
export interface TopicClaimEvent {
  claimEventId: string
  action: TopicClaimAction
  claim: TopicClaim
  actorWindowKey: string
  at: number
  revision: number
  reason?: string
}

/** `acquireClaim` 入参；base_revision 必填（§6.9）。 */
export interface TopicClaimAcquireInput {
  project: TopicProjectRef
  topicId: string
  scope: string
  ownerWindowKey: string
  baseRevision: number
  runId?: string
  expiresAt: number
  at: number
}

/** `acquireClaim` 结果；同窗口重复 acquire 视为续租。 */
export type TopicClaimAcquireResult =
  | { ok: true; claim: TopicClaim; revision: number; tookOver?: TopicClaim }
  | { ok: false; reason: 'stale'; currentRevision: number }
  | { ok: false; reason: 'conflict'; holder: TopicClaim; currentRevision: number }

/** `renewClaim` 入参；不支持用旧快照覆盖他人占用。 */
export interface TopicClaimRenewInput {
  project: TopicProjectRef
  topicId: string
  scope: string
  ownerWindowKey: string
  expiresAt: number
  at: number
  runId?: string
}

/** `releaseClaim` 入参。 */
export interface TopicClaimReleaseInput {
  project: TopicProjectRef
  topicId: string
  scope: string
  ownerWindowKey: string
  at: number
  reason?: string
}

/** renew/release 结果；只能操作自己的占用。 */
export type TopicClaimMutationResult =
  | { ok: true; claim: TopicClaim; revision: number }
  | { ok: false; reason: 'not-found' }
  | { ok: false; reason: 'not-owner'; holder: TopicClaim }

/** `listClaims` 过滤条件。 */
export interface TopicClaimQuery {
  scope?: string
  /** true 时一并返回已释放的占用；缺省只给未释放（含已过期）。 */
  includeReleased?: boolean
}

/** 冲突状态；未解决冲突必须可见。 */
export type TopicConflictStatus = 'unresolved' | 'resolved'

/** L3 冲突投影：由 entry（candidate/witness + resolution）派生。 */
export interface TopicConflict {
  conflictId: string
  projectId: string
  topicId: string
  /** 构成冲突的 entry：冲突源 + 与之矛盾的既有记录。 */
  entryIds: string[]
  status: TopicConflictStatus
  createdAt: number
  resolvedAt?: number
  /** 解决该冲突的 resolution entry。 */
  resolutionEntryId?: string
  decisionKey?: string
  /** 冲突原因的界摘要。 */
  reason?: string
}

/** `listConflicts` 过滤条件。 */
export interface TopicConflictQuery {
  status?: TopicConflictStatus | 'all'
}

/** L2 主题身份卡（需求 §7.3 的 `ProjectTopic`）。 */
export interface TopicRecord {
  projectId: string
  projectSource: TopicProjectSource
  projectHash: string
  topicId: string
  topicHash: string
  title: string
  objective: string
  /** 单调递增；只有 entry 与占用变化会推进它。 */
  revision: number
  createdBy: string
  createdAt: number
  updatedAt: number
}

/** 文档命名别名：§7.3 把 L2 身份卡叫 `ProjectTopic`。 */
export type ProjectTopic = TopicRecord

/** 有界决策指针；只保留结论摘要与 entry 指针。 */
export interface TopicDecisionRef {
  entryId: string
  decisionKey?: string
  windowKey: string
  summary: string
  revision: number
  createdAt: number
}

/** 有界完成指针；run result 仍是完成正文的唯一权威。 */
export interface TopicCompletionRef {
  entryId: string
  completionId?: string
  runId?: string
  windowKey: string
  summary: string
  revision: number
  createdAt: number
}

/** L2 主题摘要投影；由 L3 明细可重建。 */
export interface TopicSummary {
  topicId: string
  topicHash: string
  revision: number
  participants: TopicParticipant[]
  effectiveDecisions: TopicDecisionRef[]
  /** 未释放且未过期的占用。 */
  activeClaims: TopicClaim[]
  lastCompletions: TopicCompletionRef[]
  unresolvedConflicts: TopicConflict[]
  /** 绑定到本主题、尚无有效 completion 的 run_id 指针；实时状态以 run store 为准。 */
  activeRunIds: string[]
  entryCount: number
  updatedAt: number
}

/** L1 项目摘要里的主题指针。 */
export interface ProjectTopicRef {
  topicId: string
  topicHash: string
  title: string
  objective: string
  revision: number
  participantCount: number
  activeClaimCount: number
  unresolvedCount: number
  /** 只存 run_id 指针，不复制 run 状态。 */
  activeRunIds: string[]
  lastCompletionAt?: number
  updatedAt: number
}

/** L1 项目摘要。 */
export interface ProjectSummary {
  projectId: string
  projectHash: string
  projectSource: TopicProjectSource
  topics: ProjectTopicRef[]
  /** 项目内全部主题的 run_id 指针并集。 */
  activeRuns: string[]
  unresolvedCount: number
  lastCompletionAt?: number
  updatedAt: number
}

/** L0 索引里的主题指针。 */
export interface GlobalIndexTopicRef {
  topicId: string
  topicHash: string
  title: string
  revision: number
  participantCount: number
  unresolvedCount: number
  lastCompletionAt?: number
  updatedAt: number
}

/** L0 索引里的项目指针。 */
export interface GlobalIndexProject {
  projectId: string
  projectHash: string
  projectSource: TopicProjectSource
  topics: GlobalIndexTopicRef[]
  unresolvedCount: number
  lastCompletionAt?: number
  updatedAt: number
}

/** L0 全局索引；只放指针、计数与时间，不放任何完成正文。 */
export interface GlobalIndex {
  schemaVersion: number
  projects: GlobalIndexProject[]
  updatedAt: number
}

/** 幂等创建/按 ID 打开主题。 */
export interface TopicCreateInput {
  project: TopicProjectRef
  topicId: string
  title: string
  objective: string
  createdBy: string
  at: number
  /** 提供时在同一事务内把创建窗口登记为 owner 参与者。 */
  scenario?: Scenario
}

/** 创建结果；created=false 表示按同一目标幂等打开。 */
export interface TopicCreateOutcome {
  topic: TopicRecord
  created: boolean
  creator?: TopicParticipant
}

/** 投影重建汇总。 */
export interface TopicRebuildSummary {
  projects: number
  topics: number
  entries: number
}

/**
 * Topic Ledger 持久化端口；唯一 I/O 实现见 adapters/topicStore。
 *
 * 读顺序 L0 → L1 → L2 → L3；明细只在核对证据时按需分页读取。
 */
export interface TopicStorePort {
  /** 存储是否可用；不可用时所有 `window_topic_*` 必须响亮失败，不得回落内存台账。 */
  available(): boolean

  /** 读 L0 全局索引；缺失/陈旧时按项目与 L2/L3 重建。 */
  readIndex(): Promise<GlobalIndex>
  /** 读 L1 项目摘要；项目不存在返回 undefined。 */
  readProject(project: TopicProjectRef): Promise<ProjectSummary | undefined>

  /** 读 L2 身份卡；不存在返回 undefined。 */
  getTopic(ref: TopicRef): Promise<TopicRecord | undefined>
  /** 读 L2 汇总投影；陈旧时按 L3 明细重建。 */
  readTopicSummary(ref: TopicRef): Promise<TopicSummary | undefined>

  /** 幂等创建或按 ID 打开主题；同 ID 目标不一致抛 WINDOW_TOPIC_CONFLICT。 */
  openTopic(input: TopicCreateInput): Promise<TopicCreateOutcome>

  /** 登记参与者（重复 join 只更新 status/lastSeenAt）；不推进 revision。 */
  upsertParticipant(input: TopicParticipantInput): Promise<TopicParticipant>
  getParticipant(ref: TopicRef, windowKey: string, scenario?: Scenario): Promise<TopicParticipant | undefined>
  listParticipants(ref: TopicRef): Promise<TopicParticipant[]>

  /**
   * 追加一条 entry（append-only）。
   *
   * - decision/completion/conflict/resolution 必须带 baseRevision，过期返回 ok:false；
   * - decision 同键不同结论且未给有效 supersedes 时只存为 candidate 并生成 unresolved conflict；
   * - 同 completionId（或同 entryId）重复写入按幂等返回既有记录，不推进 revision；
   * - resolution 必须关联未解决的 conflictId。
   */
  appendEntry(input: TopicEntryAppendInput): Promise<TopicCasResult<TopicEntryAppendResult>>
  getEntry(ref: TopicRef, entryId: string): Promise<TopicEntry | undefined>
  /** 分页读取 L3 entry；默认最新在前、不返回完整对话。 */
  listEntries(ref: TopicRef, query?: TopicEntryQuery): Promise<TopicEntryPage>

  /** 申请协作占用；同 scope 已有未过期占用且非本人时返回 ok:false(conflict)。 */
  acquireClaim(input: TopicClaimAcquireInput): Promise<TopicClaimAcquireResult>
  /** 续租自己的占用；他人的占用只能等过期接管。 */
  renewClaim(input: TopicClaimRenewInput): Promise<TopicClaimMutationResult>
  /** 释放自己的占用；历史保留。 */
  releaseClaim(input: TopicClaimReleaseInput): Promise<TopicClaimMutationResult>
  listClaims(ref: TopicRef, query?: TopicClaimQuery): Promise<TopicClaim[]>
  listClaimEvents(ref: TopicRef, scope?: string): Promise<TopicClaimEvent[]>
  /** 释放某个 run 的全部未释放占用（B5 orphan/stop 对账钩子）。 */
  releaseClaimsForRun(runId: string, options?: { at?: number; reason?: string }): Promise<TopicClaim[]>

  getConflict(ref: TopicRef, conflictId: string): Promise<TopicConflict | undefined>
  listConflicts(ref: TopicRef, query?: TopicConflictQuery): Promise<TopicConflict[]>

  /** 从 L3 明细重建 L2/L1/L0 投影（明细为准）。 */
  rebuildProjections(options?: { project?: TopicProjectRef; topicId?: string }): Promise<TopicRebuildSummary>

  /** 用例层组合读改写用的按主题串行锁；存储自身的单次写入已各自原子。 */
  withTopicLock<T>(ref: TopicRef, operation: () => Promise<T>): Promise<T>
  /** 等待存储内部待排空写入落定；drain 用。 */
  settle(): Promise<void>
  /** 按 journal 恢复半截事务；返回重做的交易数。可选。 */
  recover?(): Promise<number>
  /** 清理原子写遗留的 `.tmp` 半截文件；返回清理数量。可选。 */
  cleanup?(): Promise<number>
}

/* -------------------------------------------------------------------------- *
 * Topic 工具用例的输入与回执（FR-11 / FR-12；§6.6–6.10）
 *
 * 回执一律 snake_case（与 window_open / window_list 等工具回执一致），
 * 并且只暴露有界摘要与指针：L3 明细不返回任何窗口的完整对话。
 * -------------------------------------------------------------------------- */

/** 参与者的工具视图。 */
export interface TopicParticipantView {
  participation_id: string
  window_key: string
  scenario: Scenario
  role: TopicParticipantRole
  status: TopicParticipantStatus
  joined_at: number
  last_seen_at: number
}

/** 有效决策指针视图（有界摘要）。 */
export interface TopicDecisionView {
  entry_id: string
  decision_key?: string
  window_key: string
  summary: string
  revision: number
  created_at: number
}

/** 完成指针视图；完成正文的权威仍是 run result。 */
export interface TopicCompletionView {
  entry_id: string
  completion_id?: string
  run_id?: string
  window_key: string
  summary: string
  revision: number
  created_at: number
}

/** 协作占用视图；历史保留，过期不等于从未发生。 */
export interface TopicClaimView {
  scope: string
  owner_window_key: string
  run_id?: string
  claimed_at: number
  expires_at: number
  released_at?: number
  /** true = 未释放但已过期（可被接管）。 */
  expired: boolean
  claim_event_id: string
}

/** 冲突视图；unresolved 必须可见。 */
export interface TopicConflictView {
  conflict_id: string
  entry_ids: string[]
  status: TopicConflictStatus
  created_at: number
  resolved_at?: number
  resolution_entry_id?: string
  decision_key?: string
  reason?: string
}

/** L3 entry 视图（append-only；不含完整对话）。 */
export interface TopicEntryView {
  entry_id: string
  kind: TopicEntryKind
  revision: number
  window_key: string
  content: string
  effective: boolean
  created_at: number
  base_revision?: number
  run_id?: string
  completion_id?: string
  decision_key?: string
  artifact_refs?: string[]
  supersedes_entry_id?: string
  supersedes_reason?: string
  conflict_id?: string
  related_entry_ids?: string[]
}

/** L2 主题身份卡视图。 */
export interface TopicCardView {
  topic_id: string
  title: string
  objective: string
  revision: number
  created_by: string
  created_at: number
  updated_at: number
}

/** L2 主题摘要投影视图。 */
export interface TopicSummaryView {
  revision: number
  participants: TopicParticipantView[]
  effective_decisions: TopicDecisionView[]
  active_claims: TopicClaimView[]
  last_completions: TopicCompletionView[]
  unresolved_conflicts: TopicConflictView[]
  active_run_ids: string[]
  entry_count: number
  updated_at: number
}

/** L1 项目摘要里的主题指针视图。 */
export interface TopicPointerView {
  topic_id: string
  title: string
  objective: string
  revision: number
  participant_count: number
  active_claim_count: number
  unresolved_count: number
  active_run_ids: string[]
  last_completion_at?: number
  updated_at: number
}

/** L1 项目摘要视图；active run 只存指针，实时状态以 run store 为准。 */
export interface TopicProjectView {
  project_id: string
  project_source: TopicProjectSource
  topics: TopicPointerView[]
  active_run_ids: string[]
  unresolved_count: number
  last_completion_at?: number
  updated_at: number
}

/** `window_topic_create` 输入。 */
export interface TopicCreateToolInput {
  /** 缺省由插件生成；调用方可传业务 ID 的命名空间形式。 */
  topicId?: string
  title: string
  objective: string
}

/** `window_topic_create` 回执。 */
export interface TopicCreateValue {
  project_id: string
  project_source: TopicProjectSource
  topic_id: string
  title: string
  objective: string
  revision: number
  /** false = 按同一目标幂等打开既有主题。 */
  created: boolean
  created_by: string
  participant?: TopicParticipantView
  untrusted: true
  note: string
}

/** `window_topic_join` 输入；只能加入当前窗口自己。 */
export interface TopicJoinToolInput {
  topicId: string
  scenario?: Scenario
}

/** `window_topic_join` 回执：参与者记录 + 一份与 get 同构的 L2/L3 快照。 */
export interface TopicJoinValue {
  participant: TopicParticipantView
  snapshot: TopicGetValue
  untrusted: true
  note: string
}

/** `window_topic_get` 输入。 */
export interface TopicGetToolInput {
  /** 省略 = 只读 L0/L1；提供 = 读 L2 与最近 L3。 */
  topicId?: string
  cursor?: string
  limit?: number
}

/** `window_topic_get` 回执；projects 是 L1，topic/summary/entries 是 L2/L3。 */
export interface TopicGetValue {
  project_id: string
  project_source: TopicProjectSource
  projects: TopicProjectView[]
  topic?: TopicCardView
  summary?: TopicSummaryView
  entries?: TopicEntryView[]
  next_cursor?: string
  entry_total?: number
  untrusted: true
  note: string
}

/** `window_topic_append` 输入；只追加，不篡改历史。 */
export interface TopicAppendToolInput {
  topicId: string
  kind: TopicEntryKind
  content: string
  baseRevision?: number
  decisionKey?: string
  artifactRefs?: string[]
  supersedesEntryId?: string
  supersedesReason?: string
  conflictId?: string
  /** 完成记录关联的 run；有 runId 时 completionId 由插件按 run_id 确定性派生，调用方不得自造。 */
  runId?: string
  /** 幂等键：同一窗口 + kind + key 的重试命中同一 entry，不会重复落条（写入已提交但响应丢失的场景）。 */
  idempotencyKey?: string
  relatedEntryIds?: string[]
}

/** `window_topic_append` 回执；从不触发 origin 回调。 */
export interface TopicAppendValue {
  entry_id: string
  kind: TopicEntryKind
  revision: number
  /** false = 只作为 candidate 保存，冲突未解决。 */
  effective: boolean
  candidate_entry_id?: string
  conflict_id?: string
  conflict?: TopicConflictView
  superseded_entry_id?: string
  untrusted: true
  note: string
}

/** `window_topic_claim` 输入；base_revision 仅 acquire 必填。 */
export interface TopicClaimToolInput {
  topicId: string
  scope: string
  action: TopicClaimAction
  baseRevision?: number
  runId?: string
  leaseMs?: number
  reason?: string
}

/** 被接管的历史占用摘要（只含公开字段）。 */
export interface TopicClaimHolderView {
  owner_window_key: string
  expires_at: number
  scope: string
}

/** `window_topic_claim` 回执。 */
export interface TopicClaimValue {
  action: TopicClaimAction
  scope: string
  owner_window_key: string
  run_id?: string
  claimed_at: number
  expires_at: number
  released_at?: number
  expired: boolean
  claim_event_id: string
  revision: number
  /** 仅 action='takeover'：被接管的历史占用摘要。 */
  took_over?: TopicClaimHolderView
  untrusted: true
  note: string
}

/** 窗口能力用例依赖；开窗、完成、查询共用。 */
export interface WindowDeps {
  /** 从工具执行上下文取窗口码（= root agent id = session id）。 */
  resolveWindowKey(exec: unknown): string
  /** 校验调用者确实是本窗口的 live driver。 */
  requireLiveDriver(exec: unknown): void
  windowOpener?: WindowOpenerPort
  seedDelivery?: SeedDeliveryPort
  runStore?: RunStorePort
  /** Topic Ledger 持久化端口；缺失或不可用时主题工具必须响亮失败。 */
  topicStore?: TopicStorePort
  /** window_inspect 的只读宿主端口；缺失时该工具响亮失败。 */
  windowInspect?: WindowInspectPort
  /** 运行中引导/中断端口；B2 的 send/interrupt 使用。 */
  agentControl?: AgentControlPort
  /** JSON Schema 校验端口；声明 outputSchema 时必须可用。 */
  schemaGuard?: SchemaGuardPort
  /** window_wait 缺事件驱动时的轮询间隔；缺省 500ms。 */
  waitPollMs?: number
  /** origin 多久未活动后判定 orphaned；缺省 24h。 */
  orphanTimeoutMs?: number
  /** claim 租约上下限（§6.9）；缺省用插件常量。 */
  claimLeaseBounds?: { minMs: number; maxMs: number }
  /** origin 是否仍在线；缺失时只按超时判定 orphan。 */
  isWindowAlive?(windowKey: string): boolean
  now(): number
  newRunId(): string
}

/** 兼容别名：`WindowDeps` 的旧名，保留给既有调用方。 */
export type OpenWindowDeps = WindowDeps

/** `window_complete` 输入。 */
export interface CompleteRunInput {
  runId?: string
  status: RunTerminalStatus
  content: string
  /** run 声明 outputSchema 且 completed 时必填并通过校验。 */
  structured?: unknown
  /** run 绑定 topic 时必填；必须等于完成前最新主题 revision。 */
  baseRevision?: number
}

/** `window_complete` 回执。 */
export interface CompleteRunValue {
  success: true
  run_id: string
  status: RunTerminalStatus
  result: RunResult
  callback: RunCallbackState
  /** 绑定 topic 时的共享完成 id 与写入后的 revision。 */
  completion_entry_id?: string
  topic_revision?: number
}

/** `window_dispatch` 输入：向已有 branch child 再投递一条任务。 */
export interface DispatchTaskInput {
  toWindow: string
  seedText: string
  outputSchema?: unknown
  resultRequired?: boolean
}

/** `window_dispatch` 回执。 */
export interface DispatchTaskValue {
  success: boolean
  run_id: string
  to_window: string
  callback_policy: 'required'
  callback_armed: boolean
  delivery: { delivered: boolean; kind: string; reason?: string; run_error?: string }
  degraded_note: string
}

/** `window_send` 输入：向活动 run 的 child 投递运行中引导。 */
export interface SendGuidanceInput {
  runId?: string
  toWindow?: string
  message: string
}

/** `window_send` 回执。 */
export interface SendGuidanceValue {
  accepted: boolean
  run_id: string
  message_id: string
  delivery: 'steered' | 'queued' | 'failed'
  reason?: string
  note: string
}

/** `window_interrupt` 输入。 */
export interface InterruptRunInput {
  runId: string
  mode: 'turn' | 'run'
  reason?: string
}

/** `window_interrupt` 回执。 */
export interface InterruptRunValue {
  accepted: boolean
  run_id: string
  mode: 'turn' | 'run'
  run_status: RunStatus
  result?: RunResult
  callback: RunCallbackState
  note: string
}

/** `window_status` 只读回执。 */
export interface RunStatusValue {
  run_id: string
  scenario: 'branch'
  origin_session_id: string
  child_session_id: string
  created_by: 'open' | 'dispatch'
  run_status: RunStatus
  callback_armed: boolean
  result?: RunResult
  output_schema?: unknown
  result_required?: boolean
  topic_id?: string
  /** 开跑时读取并登记的主题 revision。 */
  started_topic_revision?: number
  /** 生命周期归属（§7.5），供复盘 stop/orphan/drain。 */
  lifecycle?: RunLifecycle
  /** 最近的控制留痕（有界，最新的在前），供复盘 send/interrupt/stop/orphan。 */
  control?: RunControlEvent[]
  /** guidance 留痕（§7.5，有界）。 */
  messages?: RunMessage[]
  callback: RunCallbackState
  last_activity_at: number
  created_at: number
  updated_at: number
}

/** `window_list` 过滤条件。 */
export interface WindowListInput {
  /** active = pending/running；terminal = 其余终态；all = 全部。 */
  status?: 'active' | 'terminal' | 'all'
  topicId?: string
  timeWindow?: { from?: number; to?: number }
  cursor?: string
  limit?: number
}

/** `window_list` 的一行；不包含 result 正文。 */
export interface WindowListRow {
  run_id: string
  created_by: 'open' | 'dispatch'
  child_window_key: string
  run_status: RunStatus
  /** 生命周期归属；缺省视为 active。 */
  lifecycle_state?: RunLifecycle['state']
  callback: { status: RunCallbackState['status']; attempts: number; reason?: string }
  topic_id?: string
  last_activity_at: number
  created_at: number
  updated_at: number
}

/** `window_list` 回执。 */
export interface WindowListValue {
  rows: WindowListRow[]
  next_cursor?: string
  total: number
}

/** `window_wait` 输入。 */
export interface WaitRunsInput {
  /** 显式目标；与 scope/topicId 三选一（显式优先）。 */
  runIds?: string[]
  /** my_active = 本窗口 origin 的 pending/running run。 */
  scope?: 'my_active'
  topicId?: string
  /** 只等待这些 run 状态的 run（FR-17 的 status 过滤）。 */
  status?: RunStatus[]
  mode: 'all' | 'any'
  timeoutMs: number
}

/** `window_wait` 回执。 */
export interface WaitRunsValue {
  timed_out: boolean
  /** 调用方取消信号命中；返回当前快照。 */
  aborted?: boolean
  runs: WindowListRow[]
  /** 超时时的建议动作；超时只是到点，既不代表完成，也不代表目标停滞。 */
  hint?: string
}

/** `window_inspect` 输入。 */
export interface WindowInspectInput {
  windowKey: string
  includeHistory?: boolean
  cursor?: string
  limit?: number
}

/** `window_inspect` 回执。 */
export interface WindowInspectValue {
  meta: WindowInspectMeta
  /** 历史内容按不可信数据处理。 */
  untrusted: true
  /** 该窗口作为 child 的可见 run 状态；自省或无 run 关系时缺省。只读事实，不含 result 正文。 */
  run_status?: RunStatus
  lifecycle_state?: string
  history?: { items: WindowHistoryItem[]; next_cursor?: string }
}

/** `window_open` 的完整回执。 */
export interface OpenWindowValue {
  /** 请求的场景是否完整建立；不等于“会话是否创建”。 */
  success: boolean
  scenario: Scenario
  callback_policy: 'none' | 'required'
  /** 会话是否已创建；失败时也必须如实返回。 */
  session_created: boolean
  window_key?: string
  parent_session_id?: string
  mode: WindowMode
  run_id?: string
  /** 是否已加入项目主题台账；false 时不得声称具备协作防冲突能力。 */
  topic_tracking: boolean
  topic_id?: string
  /** 开窗口时读取并登记的主题 revision。 */
  topic_revision?: number
  callback_armed: boolean
  delivery?: { delivered: boolean; kind: string; reason?: string; run_error?: string; topic_note?: string }
  inheritance: WindowInheritance
  degraded_note: string
}

/** 归一后的开窗输入。 */
export interface NormalizedOpenWindowInput {
  scenario: Scenario
  mode: WindowMode
  atSeq?: number
  title?: string
  seedText: string
  topicId?: string
  outputSchema?: unknown
  resultRequired?: boolean
}

export type { OpenWindowInput }
