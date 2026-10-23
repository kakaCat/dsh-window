/**
 * `window_open` 用例：把双场景开窗、落点、继承、seed 投递与 branch 运行登记编排在一起。
 *
 * 本层只依赖端口；宿主服务访问全部在 adapters。
 *
 * @module dsh-window/application/openWindow
 */
import {
  DEGRADED_NOTE,
  SEED_KIND,
  callbackPolicyOf,
  defaultModeOf,
  isScenario,
  isWindowMode,
  type OpenWindowInput,
  type Scenario,
} from '../shared/protocol.js'
import { reasonOf, reject } from '../shared/errors.js'
import type {
  NormalizedOpenWindowInput,
  OpenWindowDeps,
  OpenWindowOutcome,
  OpenWindowValue,
  RunRecord,
  TopicGetValue,
  TopicParticipantStatus,
  TopicRef,
  TopicStorePort,
  WindowCreateOptions,
  WindowDeps,
  WindowWorkspaceTarget,
} from './ports.js'
import { applyWindowInheritance, presetInheritanceOf, readWindowProfile } from './windowInherit.js'
import { execCwd } from './execView.js'
import {
  buildTopicSeedAddendum,
  joinTopicParticipant,
  normalizeTopicScope,
  resolveTopicProjectByScope,
} from './topicLedger.js'

/** 校验并归一工具输入；scenario / seed_text 缺失在开窗前就拒绝。 */
export function normalizeOpenWindowInput(raw: OpenWindowInput): NormalizedOpenWindowInput {
  if (!isScenario(raw.scenario)) {
    reject('WINDOW_SCENARIO_REQUIRED', 'window_open 未执行：scenario 必填，且只能是 continuation 或 branch')
  }
  const seedText = typeof raw.seedText === 'string' ? raw.seedText : ''
  if (seedText.trim().length === 0) {
    reject('WINDOW_SEED_REQUIRED', 'window_open 未执行：seed_text 必填，不能为空或纯空白')
  }
  const mode = raw.mode === undefined ? defaultModeOf(raw.scenario) : raw.mode
  if (!isWindowMode(mode)) {
    reject('WINDOW_OPEN_FAILED', `window_open 未执行：mode 非法（${String(raw.mode)}）`)
  }
  if (raw.atSeq !== undefined && (!Number.isInteger(raw.atSeq) || raw.atSeq < 0)) {
    reject('WINDOW_OPEN_FAILED', `window_open 未执行：at_seq 必须是非负整数（${String(raw.atSeq)}）`)
  }
  const title = typeof raw.title === 'string' && raw.title.trim().length > 0 ? raw.title.trim() : undefined
  if (title !== undefined && title.length > 200) {
    reject('WINDOW_OPEN_FAILED', 'window_open 未执行：title 超过 200 字符')
  }
  const rawTopicId = typeof raw.topicId === 'string' ? raw.topicId.trim() : undefined
  if (raw.topicId !== undefined && (rawTopicId === undefined || rawTopicId.length === 0)) {
    reject('WINDOW_INVALID_INPUT', 'window_open 未执行：topic_id 不能为空或纯空白')
  }
  if (rawTopicId !== undefined && (rawTopicId.includes('\0') || rawTopicId.length > 200)) {
    reject('WINDOW_INVALID_INPUT', 'window_open 未执行：topic_id 不能含 NUL，且不超过 200 字符')
  }
  if (raw.topicScope !== undefined && rawTopicId === undefined) {
    reject('WINDOW_INVALID_INPUT', 'window_open 未执行：topic_scope 只能与 topic_id 一起使用')
  }
  const topicScope = rawTopicId === undefined ? undefined : normalizeTopicScope(raw.topicScope)
  const rawTarget = typeof raw.targetWorkspace === 'string' ? raw.targetWorkspace.trim() : undefined
  if (raw.targetWorkspace !== undefined && (rawTarget === undefined || rawTarget.length === 0)) {
    reject('WINDOW_INVALID_INPUT', 'window_open 未执行：target_workspace 不能为空或纯空白')
  }
  if (rawTarget !== undefined && (rawTarget.includes('\0') || rawTarget.length > 1_024)) {
    reject('WINDOW_INVALID_INPUT', 'window_open 未执行：target_workspace 不能含 NUL，且不超过 1024 字符')
  }
  if (rawTarget !== undefined && mode !== 'create') {
    reject(
      'WINDOW_WORKSPACE_UNSUPPORTED',
      "window_open 未执行：target_workspace 仅支持 mode='create'；fork 会继承源会话的 cwd，不能换工作区",
    )
  }
  return {
    scenario: raw.scenario,
    mode,
    seedText,
    ...(raw.atSeq === undefined ? {} : { atSeq: raw.atSeq }),
    ...(title === undefined ? {} : { title }),
    ...(rawTarget === undefined ? {} : { targetWorkspace: rawTarget }),
    ...(rawTopicId === undefined ? {} : { topicId: rawTopicId }),
    ...(topicScope === undefined ? {} : { topicScope }),
    ...(raw.outputSchema === undefined ? {} : { outputSchema: raw.outputSchema }),
    ...(raw.resultRequired === undefined ? {} : { resultRequired: raw.resultRequired === true }),
  }
}

/** 校验结构化结果契约；非法在开窗前拒绝，且不创建 run。 */
export function assertSchemaContract(
  deps: WindowDeps,
  input: Pick<NormalizedOpenWindowInput, 'scenario' | 'outputSchema' | 'resultRequired'>,
): void {
  if (input.scenario === 'continuation' && input.outputSchema !== undefined) {
    reject('WINDOW_INVALID_INPUT', 'window_open 未执行：continuation 没有 run，不支持 output_schema')
  }
  if (input.outputSchema === undefined) {
    if (input.resultRequired === true) {
      reject('WINDOW_OUTPUT_SCHEMA_INVALID', 'window_open 未执行：result_required=true 时必须同时提供 output_schema')
    }
    return
  }
  const guard = deps.schemaGuard
  if (guard === undefined) {
    reject('WINDOW_OPEN_UNAVAILABLE', 'window_open 未执行：本宿主未装配 JSON Schema 校验能力')
  }
  try {
    guard.assertObjectSchema(input.outputSchema)
  } catch (error: unknown) {
    reject('WINDOW_OUTPUT_SCHEMA_INVALID', `window_open 未执行：output_schema 非法（${reasonOf(error)}）`)
  }
}

/** create 落点：源项目优先，其次调用会话 cwd；两者都没有返回 undefined，绝不回落宿主目录。 */
export function resolvePlacement(
  opener: { resolveSourceProject?: (sourceSessionId: string) => WindowCreateOptions | undefined },
  sourceSessionId: string,
  exec: unknown,
): WindowCreateOptions | undefined {
  const fromProject = opener.resolveSourceProject?.(sourceSessionId)
  if (fromProject !== undefined) return fromProject
  const cwd = execCwd(exec)
  if (cwd !== undefined) return { cwd }
  return undefined
}

/** 显式目标工作区的一行说明；只陈述落点，不宣称与 origin 共享 cwd。 */
function workspaceSeedLine(target: WindowWorkspaceTarget | undefined): string[] {
  if (target === undefined) return []
  const path = target.path === undefined ? '' : ` (${target.path})`
  return [`target_workspace: ${target.title}${path}`]
}

/** seed 任务包：让新窗口知道自己是续接还是分叉，以及 branch 必须显式完成。 */
export function buildSeedText(
  input: NormalizedOpenWindowInput,
  runId?: string,
  topicAddendum?: string,
  targetWorkspace?: WindowWorkspaceTarget,
): string {
  const header = input.scenario === 'branch'
    ? [
        '[DSH Window 分支任务包]',
        'scenario: branch',
        ...(runId === undefined ? [] : [`run_id: ${runId}`]),
        ...workspaceSeedLine(targetWorkspace),
        '完成后必须调用 window_complete 上报 status 与 content；普通 turn/end 不算完成。',
        '---',
        '',
      ].join('\n')
    : [
        '[DSH Window 续接任务包]',
        'scenario: continuation',
        ...workspaceSeedLine(targetWorkspace),
        '本窗口接管当前任务；结果留在本窗口，不向原窗口主动回调。',
        '---',
        '',
      ].join('\n')
  const body = `${header}${input.seedText}`
  return topicAddendum === undefined || topicAddendum.length === 0 ? body : `${body}\n${topicAddendum}`
}

/** 宿主开窗失败 → 结构化错误。 */
function throwOpenFailure(outcome: Extract<OpenWindowOutcome, { ok: false }>): never {
  if (outcome.code === 'unavailable_no_completed_turn') {
    reject(
      'WINDOW_OPEN_UNAVAILABLE',
      `window_open 未执行：源会话没有可切分的完整回合，无法 fork（${outcome.reason}）。请改用 mode=create`,
    )
  }
  if (outcome.code === 'opener_unavailable') {
    reject('WINDOW_OPEN_UNAVAILABLE', `window_open 未执行：会话开窗能力不可用（${outcome.reason}）`)
  }
  reject('WINDOW_OPEN_FAILED', `window_open 未执行：建会话失败（${outcome.reason}）`)
}

/** 打开一个新窗口。 */
export async function openWindow(
  deps: OpenWindowDeps,
  raw: OpenWindowInput,
  exec: unknown,
): Promise<OpenWindowValue> {
  const input = normalizeOpenWindowInput(raw)
  assertSchemaContract(deps, input)
  const origin = deps.resolveWindowKey(exec)
  deps.requireLiveDriver(exec)

  const opener = deps.windowOpener
  if (opener === undefined || !opener.available()) {
    reject('WINDOW_OPEN_UNAVAILABLE', 'window_open 未执行：本宿主未装配会话开窗能力（sessionController.fork/create 不可得）')
  }
  const seedDelivery = deps.seedDelivery
  if (seedDelivery === undefined) {
    reject('WINDOW_OPEN_UNAVAILABLE', 'window_open 未执行：未装配跨窗口投递能力，无法投递 seed')
  }
  if (input.scenario === 'branch') {
    const runStore = deps.runStore
    if (runStore === undefined || !runStore.available()) {
      reject(
        'WINDOW_RUN_STORE_UNAVAILABLE',
        'window_open 未执行：branch 运行记录存储不可用，窗口未创建、seed 未投递',
      )
    }
  }

  // 目标工作区必须在创建会话之前解析：未命中/歧义都不建窗，也不退回源工作区。
  let targetWorkspace: WindowWorkspaceTarget | undefined
  if (input.targetWorkspace !== undefined) {
    const resolveWorkspace = opener.resolveWorkspace
    if (typeof resolveWorkspace !== 'function') {
      reject(
        'WINDOW_WORKSPACE_UNAVAILABLE',
        'window_open 未执行：本宿主未装配工作区解析能力（workspaceRegistry.list 不可得）',
      )
    }
    const resolved = resolveWorkspace.call(opener, input.targetWorkspace)
    if (!resolved.ok) {
      if (resolved.code === 'not_found') {
        const names = (resolved.candidates ?? [])
          .slice(0, 5)
          .map((item) => `${item.title}${item.path === undefined ? '' : `（${item.path}）`}`)
          .join('、')
        reject(
          'WINDOW_WORKSPACE_NOT_FOUND',
          `window_open 未执行：没有匹配的工作区「${input.targetWorkspace}」`
          + `${names.length === 0 ? '' : `；可用：${names}`}`,
          resolved.candidates === undefined ? undefined : { candidates: resolved.candidates },
        )
      }
      if (resolved.code === 'ambiguous') {
        reject('WINDOW_WORKSPACE_AMBIGUOUS', `window_open 未执行：${resolved.reason}`, {
          ...(resolved.candidates === undefined ? {} : { candidates: resolved.candidates }),
        })
      }
      reject('WINDOW_WORKSPACE_UNAVAILABLE', `window_open 未执行：${resolved.reason}`)
    }
    targetWorkspace = resolved.workspace
  }

  // Topic 意图校验必须在创建会话之前：存储不可用或主题不存在时不建窗、不投递 seed，
  // 也不静默降级成未跟踪协作。
  const topicStore = deps.topicStore
  let topicRoster: { store: NonNullable<WindowDeps['topicStore']>; ref: TopicRef } | undefined
  if (input.topicId !== undefined) {
    const topicScope = input.topicScope ?? 'project'
    // 跨工作区父子窗口只有全局主题可以共用；项目内主题仍要求同一个 workspace。
    if (targetWorkspace !== undefined && topicScope !== 'global') {
      const sourceProject = opener.resolveSourceProject?.(origin)
      if (sourceProject?.workspaceId !== targetWorkspace.id) {
        reject(
          'WINDOW_WORKSPACE_UNSUPPORTED',
          'window_open 未执行：target_workspace 与项目内 topic_id 不能组合；'
          + '跨工作区协作请用 topic_scope=global，同一工作区请省略 target_workspace',
        )
      }
    }
    if (topicStore === undefined || !topicStore.available()) {
      reject(
        'WINDOW_TOPIC_STORAGE_UNAVAILABLE',
        'window_open 未执行：请求了 topic_id 但主题台账存储不可用；窗口未创建、seed 未投递',
      )
    }
    const ref: TopicRef = {
      project: resolveTopicProjectByScope(deps, exec, origin, topicScope),
      topicId: input.topicId,
    }
    if ((await topicStore.getTopic(ref)) === undefined) {
      reject(
        'WINDOW_TOPIC_NOT_FOUND',
        `window_open 未执行：主题 ${input.topicId} 不存在（topic_scope=${topicScope}）；先 window_topic_create`,
      )
    }
    topicRoster = { store: topicStore, ref }
  }

  const sourceRead = await readWindowProfile(opener, origin)

  let outcome: OpenWindowOutcome
  if (input.mode === 'fork') {
    outcome = await opener.fork(origin, input.atSeq)
  } else {
    // 显式目标工作区优先；未给时才按源项目 / 调用会话 cwd 定位。两者都不猜。
    const placement: WindowCreateOptions | undefined = targetWorkspace === undefined
      ? resolvePlacement(opener, origin, exec)
      : { workspaceId: targetWorkspace.id }
    if (placement === undefined) {
      reject(
        'WINDOW_OPEN_UNAVAILABLE',
        'window_open 未执行：拿不到源会话的项目落点（workspace 与 cwd 都不可得），不在宿主目录里静默建窗',
      )
    }
    const preset = presetInheritanceOf(sourceRead, 'create').agentPreset
    outcome = await opener.create(preset === undefined ? placement : { ...placement, agentPreset: preset })
  }
  if (!outcome.ok) throwOpenFailure(outcome)

  const childKey = outcome.windowKey
  const inheritance = await applyWindowInheritance(opener, {
    childKey,
    mode: input.mode,
    scenario: input.scenario,
    seedText: input.seedText,
    sourceRead,
    ...(input.title === undefined ? {} : { explicitTitle: input.title }),
  })

  // Topic 参与登记：origin 与 child 在投递 seed 前登记并取得同一 revision 快照；
  // 复用 window_topic_join 的加入规则，不另写一套。
  let topicContext: {
    store: TopicStorePort
    ref: TopicRef
    revision: number
    snapshot: TopicGetValue
  } | undefined
  const roster = topicRoster
  if (roster !== undefined) {
    try {
      const joined = await roster.store.withTopicLock(roster.ref, async () => {
        const originJoin = await joinTopicParticipant(deps, roster.store, {
          project: roster.ref.project,
          topicId: roster.ref.topicId,
          windowKey: origin,
          scenario: input.scenario,
          status: 'pending',
          at: deps.now(),
        })
        const childJoin = await joinTopicParticipant(deps, roster.store, {
          project: roster.ref.project,
          topicId: roster.ref.topicId,
          windowKey: childKey,
          scenario: input.scenario,
          status: 'pending',
          at: deps.now(),
        })
        return { originJoin, childJoin }
      })
      topicContext = {
        store: roster.store,
        ref: roster.ref,
        revision: joined.childJoin.revision,
        snapshot: joined.childJoin.snapshot,
      }
    } catch (error: unknown) {
      return {
        success: false,
        scenario: input.scenario,
        callback_policy: callbackPolicyOf(input.scenario),
        session_created: true,
        window_key: childKey,
        ...(outcome.parentSessionId === undefined ? {} : { parent_session_id: outcome.parentSessionId }),
        mode: input.mode,
        ...(targetWorkspace === undefined ? {} : { target_workspace: targetWorkspace }),
        topic_tracking: false,
...(input.topicId === undefined ? {} : { topic_id: input.topicId }),
        ...(input.topicId === undefined ? {} : { topic_scope: input.topicScope ?? 'project' }),
        callback_armed: false,
        inheritance,
        degraded_note: `${DEGRADED_NOTE} 主题参与登记失败：${reasonOf(error)}；协作未启用，不得声称具备协作防冲突能力。`,
      }
    }
  }
  const topic = topicContext

  let run: RunRecord | undefined
  if (input.scenario === 'branch') {
    const runId = deps.newRunId()
    const now = deps.now()
    run = {
      runId,
      scenario: 'branch',
      createdBy: 'open',
      originSessionId: origin,
      childSessionId: childKey,
      mode: input.mode,
      ...(input.title === undefined ? {} : { title: input.title }),
      ...(input.topicId === undefined ? {} : { topicId: input.topicId }),
      ...(topic === undefined ? {} : { startedTopicRevision: topic.revision }),
      status: 'pending',
      callbackArmed: false,
      callback: { status: 'not_armed', attempts: 0 },
      ...(input.outputSchema === undefined ? {} : { outputSchema: input.outputSchema }),
      ...(input.resultRequired === undefined ? {} : { resultRequired: input.resultRequired }),
      lastActivityAt: now,
      createdAt: now,
      updatedAt: now,
    }
    try {
      await deps.runStore!.create(run)
    } catch (error: unknown) {
      await markTopicParticipants(topic, deps, [origin, childKey], input.scenario, 'seed_failed').catch(() => undefined)
      return {
        success: false,
        scenario: input.scenario,
        callback_policy: callbackPolicyOf(input.scenario),
        session_created: true,
        window_key: childKey,
        ...(outcome.parentSessionId === undefined ? {} : { parent_session_id: outcome.parentSessionId }),
        mode: input.mode,
        ...(targetWorkspace === undefined ? {} : { target_workspace: targetWorkspace }),
        topic_tracking: topic !== undefined,
...(input.topicId === undefined ? {} : { topic_id: input.topicId }),
        ...(input.topicId === undefined ? {} : { topic_scope: input.topicScope ?? 'project' }),
        ...(topic === undefined ? {} : { topic_revision: topic.revision }),
        callback_armed: false,
        inheritance,
        degraded_note: `${DEGRADED_NOTE} 运行记录写入失败：${reasonOf(error)}；该窗口未登记 branch run。`,
      }
    }
  }

  const topicAddendum = topic === undefined ? undefined : buildTopicSeedAddendum(topic.snapshot)
  const seedText = buildSeedText(input, run?.runId, topicAddendum, targetWorkspace)
  const { message, messageId } = seedDelivery.createMessage({
    text: seedText,
    kind: SEED_KIND,
    scenario: input.scenario,
    ...(run === undefined ? {} : { runId: run.runId }),
  })

  let delivered = false
  let deliveryReason: string | undefined
  try {
    const sent = await seedDelivery.deliver(childKey, message)
    delivered = sent.delivered === true
    deliveryReason = sent.reason
  } catch (error: unknown) {
    delivered = false
    deliveryReason = reasonOf(error)
  }

  let runUpdateError: string | undefined
  if (run !== undefined) {
    try {
      // 与 stop/drain/complete 同锁：否则「武装回调」的无锁读改写会覆盖已落的终态
      //（例如 origin 刚 stop 掉的 run 被写回 running + armed）。
      const store = deps.runStore!
      await store.withLock(run.runId, async () => {
        const current = await store.get(run.runId)
        if (current === undefined) return
        if (current.status !== 'pending' && current.status !== 'running') return
        await store.update(run.runId, {
          status: delivered ? 'running' : 'seed_failed',
          callbackArmed: delivered,
          callback: delivered
            ? { status: 'pending', callbackId: `result-${run.runId}`, attempts: 0 }
            : { status: 'not_armed', attempts: 0 },
          ...(delivered ? { seedMessageId: messageId } : {}),
          lastActivityAt: deps.now(),
          updatedAt: deps.now(),
        })
      })
    } catch (error: unknown) {
      runUpdateError = reasonOf(error)
    }
  }

  // seed 成功后参与状态为 active，失败则记 seed_failed；状态更新失败不改写“seed 已投递”的事实。
  let topicNote: string | undefined
  if (topic !== undefined) {
    try {
      await markTopicParticipants(topic, deps, [origin, childKey], input.scenario, delivered ? 'active' : 'seed_failed')
    } catch (error: unknown) {
      topicNote = `主题参与状态更新失败：${reasonOf(error)}`
    }
  }

  const success = delivered && runUpdateError === undefined
  const callbackArmed = run !== undefined && success
  // delivery.reason 分字段，不允许后写覆盖先写（多个失败原因都要可见）。
  const delivery = {
    delivered,
    kind: SEED_KIND,
    ...(deliveryReason === undefined ? {} : { reason: deliveryReason }),
    ...(runUpdateError === undefined ? {} : { run_error: `运行记录更新失败：${runUpdateError}` }),
    ...(topicNote === undefined ? {} : { topic_note: topicNote }),
  }

  return {
    success,
    scenario: input.scenario,
    callback_policy: callbackPolicyOf(input.scenario),
    session_created: true,
    window_key: childKey,
    ...(outcome.parentSessionId === undefined ? {} : { parent_session_id: outcome.parentSessionId }),
    mode: input.mode,
    ...(targetWorkspace === undefined ? {} : { target_workspace: targetWorkspace }),
    ...(run === undefined ? {} : { run_id: run.runId }),
    topic_tracking: topic !== undefined,
    ...(input.topicId === undefined ? {} : { topic_id: input.topicId }),
    ...(input.topicId === undefined ? {} : { topic_scope: input.topicScope ?? 'project' }),
    ...(topic === undefined ? {} : { topic_revision: topic.revision }),
    callback_armed: callbackArmed,
    delivery,
    inheritance,
    degraded_note: topicNote === undefined ? DEGRADED_NOTE : `${DEGRADED_NOTE} ${topicNote}`,
  }
}

/** 把已登记窗口的参与状态写成 active/seed_failed；失败由调用方如实上报。 */
async function markTopicParticipants(
  topic: { store: TopicStorePort; ref: TopicRef } | undefined,
  deps: WindowDeps,
  windowKeys: string[],
  scenario: Scenario,
  status: TopicParticipantStatus,
): Promise<void> {
  if (topic === undefined) return
  const at = deps.now()
  await topic.store.withTopicLock(topic.ref, async () => {
    for (const windowKey of windowKeys) {
      await topic.store.upsertParticipant({
        project: topic.ref.project,
        topicId: topic.ref.topicId,
        windowKey,
        scenario,
        status,
        at,
      })
    }
  })
}

export type { OpenWindowValue, Scenario }
