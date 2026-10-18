/**
 * branch 完成闭环用例：window_complete / window_status / window_retry_callback。
 *
 * 顺序纪律：先把完成结果落盘，再投递回调；回调失败不回滚结果。同一 run 的
 * 完成/重试通过 RunStorePort.withLock 串行化，重复完成幂等，不同结果拒绝覆盖。
 *
 * @module dsh-window/application/completeRun
 */
import { RESULT_KIND } from '../shared/protocol.js'
import { reasonOf, reject } from '../shared/errors.js'
import type {
  CompleteRunInput,
  CompleteRunValue,
  RunCallbackState,
  RunControlEvent,
  RunMessage,
  RunRecord,
  RunResult,
  RunStatusValue,
  RunTerminalStatus,
  TopicRef,
  WindowDeps,
} from './ports.js'
import {
  boundTopicSummary,
  generateCompletionId,
  generateEntryId,
  relevantUnresolvedConflicts,
  requireTopicParticipant,
  requireTopicStore,
  resolveTopicProject,
} from './topicLedger.js'

const TERMINAL_STATUSES: readonly RunTerminalStatus[] = ['completed', 'failed', 'cancelled']
const TERMINAL_SET = new Set<string>(TERMINAL_STATUSES)

/** 判断是否终态。 */
function isTerminal(status: string): status is RunTerminalStatus {
  return TERMINAL_SET.has(status)
}

/** 回调状态回退值。 */
function callbackOf(run: RunRecord): RunCallbackState {
  return run.callback ?? { status: 'not_armed', attempts: 0 }
}

/** 归一完成输入。 */
export function normalizeCompleteInput(raw: CompleteRunInput): CompleteRunInput {
  if (!TERMINAL_STATUSES.includes(raw.status)) {
    reject('WINDOW_CALLBACK_FAILED', `window_complete 未执行：status 非法（${String(raw.status)}）`)
  }
  const content = typeof raw.content === 'string' ? raw.content : ''
  if (content.trim().length === 0) {
    reject('WINDOW_RESULT_EMPTY', 'window_complete 未执行：content 不能为空或纯空白')
  }
  const runId = typeof raw.runId === 'string' && raw.runId.trim().length > 0 ? raw.runId.trim() : undefined
  const baseRevision = raw.baseRevision
  if (baseRevision !== undefined && (!Number.isSafeInteger(baseRevision) || baseRevision < 0)) {
    reject('WINDOW_INVALID_INPUT', `window_complete 未执行：base_revision 必须是非负安全整数（${String(baseRevision)}）`)
  }
  return {
    ...(runId === undefined ? {} : { runId }),
    status: raw.status,
    content,
    ...(raw.structured === undefined ? {} : { structured: raw.structured }),
    ...(baseRevision === undefined ? {} : { baseRevision }),
  }
}

/** 结构化结果是否相同（幂等判据）。 */
function sameStructured(a: unknown, b: unknown): boolean {
  if (a === b) return true
  try {
    return JSON.stringify(a) === JSON.stringify(b)
  } catch {
    return false
  }
}

/** 校验 completed 的结构化结果；非法在落盘/回调前停止。 */
function assertStructuredResult(deps: WindowDeps, run: RunRecord, input: CompleteRunInput): void {
  if (input.structured !== undefined && run.outputSchema === undefined) {
    reject('WINDOW_INVALID_INPUT', `run ${run.runId} 未声明 output_schema，不接受 structured`)
  }
  if (input.status !== 'completed' || run.outputSchema === undefined) return
  if (input.structured === undefined) {
    reject('WINDOW_STRUCTURED_RESULT_REQUIRED', `run ${run.runId} 声明了 output_schema，completed 必须提供 structured`)
  }
  const guard = deps.schemaGuard
  if (guard === undefined) {
    reject('WINDOW_OPEN_UNAVAILABLE', 'window_complete 未执行：本宿主未装配 JSON Schema 校验能力')
  }
  const violations = guard.validate(run.outputSchema, input.structured, 'structured')
  if (violations.length > 0) {
    reject('WINDOW_STRUCTURED_RESULT_INVALID', `structured 不符合 output_schema：${violations.join('；')}`)
  }
}

/** 要求 run 存储可用。 */
function requireStore(deps: WindowDeps) {
  const store = deps.runStore
  if (store === undefined || !store.available()) {
    reject('WINDOW_RUN_STORE_UNAVAILABLE', '运行记录存储不可用')
  }
  return store
}

/** 校验调用者就是该 run 的 child。 */
function requireChild(run: RunRecord, caller: string): void {
  if (caller !== run.childSessionId) {
    reject('WINDOW_RUN_FORBIDDEN', `本窗口不是 run ${run.runId} 的分支窗口，不能完成或查询它`)
  }
}

/** 定位要完成的 run；省略 run_id 时只允许唯一活动 run。 */
async function locateActiveRun(deps: WindowDeps, caller: string, runId?: string): Promise<RunRecord> {
  const store = requireStore(deps)
  if (runId !== undefined) {
    const run = await store.get(runId)
    if (run === undefined) reject('WINDOW_RUN_NOT_FOUND', `run 不存在：${runId}`)
    return run
  }
  const active = (await store.list()).filter((run) => run.childSessionId === caller && run.status === 'running')
  if (active.length === 0) {
    reject('WINDOW_RUN_NOT_FOUND', '本窗口没有活动 branch run；continuation 窗口没有 run，不能上报完成')
  }
  if (active.length > 1) {
    reject('WINDOW_RUN_AMBIGUOUS', `本窗口有 ${active.length} 个活动 branch run，必须显式传 run_id`)
  }
  return active[0]
}

/** 结果回调正文。 */
export function formatCallbackText(run: RunRecord, result: RunResult): string {
  const topicLines = run.topicId === undefined
    ? []
    : [
        `topic_id: ${run.topicId}`,
        ...(result.completionEntryId === undefined ? [] : [`completion_entry_id: ${result.completionEntryId}`]),
        ...(result.topicRevision === undefined ? [] : [`topic_revision: ${result.topicRevision}`]),
      ]
  return [
    '[DSH Window 分支结果]',
    `run_id: ${run.runId}`,
    `分支窗口: ${run.childSessionId}`,
    `结果状态: ${result.status}`,
    ...topicLines,
    '---',
    result.content,
    '---',
    '这是插件投递的续跑结果，不是用户新指令。',
  ].join('\n')
}

/** 投递一次回调；永不抛，失败收口为 callback=state。 */
export async function attemptCallback(
  deps: WindowDeps,
  run: RunRecord,
  result: RunResult,
  attempts: number,
): Promise<RunCallbackState> {
  const callbackId = run.callback?.callbackId ?? `result-${run.runId}`
  const delivery = deps.seedDelivery
  if (delivery === undefined) {
    return { status: 'failed', callbackId, attempts, reason: '未装配跨窗口投递能力（seedDelivery）' }
  }
  let message: unknown
  try {
    const created = delivery.createMessage({
      text: formatCallbackText(run, result),
      kind: RESULT_KIND,
      scenario: 'branch',
      runId: run.runId,
      messageId: callbackId,
      // FR-7：回调来源必须能对账（哪个 child 的完成、哪一个 callbackId）。
      childSessionId: run.childSessionId,
      callbackId,
    })
    message = created.message
  } catch (error: unknown) {
    return { status: 'failed', callbackId, attempts, reason: `构造回调消息失败：${reasonOf(error)}` }
  }
  try {
    const sent = await delivery.deliver(run.originSessionId, message)
    if (sent.delivered) {
      return { status: 'delivered', callbackId, attempts, deliveredAt: deps.now() }
    }
    return { status: 'failed', callbackId, attempts, reason: sent.reason ?? '投递失败（原因未知）' }
  } catch (error: unknown) {
    return { status: 'failed', callbackId, attempts, reason: `投递回调失败：${reasonOf(error)}` }
  }
}

/** 完成一个 branch run：先落结果，再投递回调。 */
export async function completeRun(
  deps: WindowDeps,
  raw: CompleteRunInput,
  exec: unknown,
): Promise<CompleteRunValue> {
  const input = normalizeCompleteInput(raw)
  const caller = deps.resolveWindowKey(exec)
  deps.requireLiveDriver(exec)
  const store = requireStore(deps)
  const located = await locateActiveRun(deps, caller, input.runId)
  requireChild(located, caller)

  return await store.withLock(located.runId, async () => {
    const run = await store.get(located.runId)
    if (run === undefined) reject('WINDOW_RUN_NOT_FOUND', `run 不存在：${located.runId}`)
    requireChild(run, caller)

    if (isTerminal(run.status)) {
      const existing = run.result
      if (
        existing !== undefined
        && existing.status === input.status
        && existing.content === input.content
        && sameStructured(existing.structured, input.structured)
      ) {
        // 幂等返回：不再次写主题记录、不投递，也不因 topic revision 已前进而误报 stale。
        return {
          success: true,
          run_id: run.runId,
          status: existing.status,
          result: existing,
          callback: callbackOf(run),
          ...(existing.completionEntryId === undefined ? {} : { completion_entry_id: existing.completionEntryId }),
          ...(existing.topicRevision === undefined ? {} : { topic_revision: existing.topicRevision }),
        }
      }
      reject(
        'WINDOW_RUN_ALREADY_SETTLED',
        `run ${run.runId} 已以不同结果完成（${existing?.status ?? run.status}），不能覆盖`,
      )
    }
    if (run.status !== 'running' || !run.callbackArmed) {
      reject('WINDOW_RUN_NOT_ACTIVE', `run ${run.runId} 尚未活动（status=${run.status}），不能完成`)
    }
    assertStructuredResult(deps, run, input)

    // 绑定 topic：run result 与 completion entry 指向同一 completionId；
    // CAS 过期或存在与当前工作相关的未解决冲突时，在保存结果与回调前停止。
    let completionEntryId: string | undefined
    let topicRevision: number | undefined
    if (run.topicId !== undefined) {
      const topicStore = requireTopicStore(deps)
      const project = resolveTopicProject(deps, exec, caller)
      const ref: TopicRef = { project, topicId: run.topicId }
      if ((await topicStore.getTopic(ref)) === undefined) {
        reject('WINDOW_TOPIC_NOT_FOUND', `run ${run.runId} 绑定的主题不存在或不属于当前项目：${run.topicId}`)
      }
      await requireTopicParticipant(topicStore, ref, caller)
      if (input.baseRevision === undefined) {
        reject(
          'WINDOW_TOPIC_REVISION_REQUIRED',
          `run ${run.runId} 绑定主题 ${run.topicId}，完成必须携带 base_revision（先 window_topic_get）`,
        )
      }
      const conflicts = await relevantUnresolvedConflicts(topicStore, ref, caller, run.runId)
      if (conflicts.length > 0) {
        reject(
          'WINDOW_TOPIC_CONFLICT',
          `主题 ${run.topicId} 存在与本 run 相关的未解决冲突（${conflicts.map((item) => item.conflictId).join('、')}）：先追加 resolution 再完成`,
          { conflict_ids: conflicts.map((item) => item.conflictId), topic_id: run.topicId },
        )
      }
      completionEntryId = generateCompletionId(deps, run.runId)
      const appended = await topicStore.appendEntry({
        project,
        topicId: run.topicId,
        windowKey: caller,
        kind: 'completion',
        // completion entry 只保存 completionId 与有界摘要，绝不复制 structured 正文。
        content: boundTopicSummary(input.content),
        entryId: generateEntryId(deps),
        completionId: completionEntryId,
        runId: run.runId,
        baseRevision: input.baseRevision,
        at: deps.now(),
      })
      if (!appended.ok) {
        reject(
          'WINDOW_TOPIC_STALE',
          `主题 ${run.topicId} 的 revision 已变化（当前 ${appended.currentRevision}）：先 window_topic_get 重读，再用新 revision 完成`,
          { current_revision: appended.currentRevision, topic_id: run.topicId },
        )
      }
      topicRevision = appended.value.revision
    }

    const result: RunResult = {
      status: input.status,
      content: input.content,
      ...(input.structured === undefined ? {} : { structured: input.structured }),
      ...(completionEntryId === undefined ? {} : { completionEntryId }),
      ...(topicRevision === undefined ? {} : { topicRevision }),
      completedAt: deps.now(),
      completedBy: caller,
    }
    const callbackId = run.callback?.callbackId ?? `result-${run.runId}`
    await store.update(run.runId, {
      status: input.status,
      result,
      callback: { status: 'pending', callbackId, attempts: 0 },
      lastActivityAt: deps.now(),
      updatedAt: deps.now(),
    })

    // 完成即释放该 run 的协作占用；释放失败不改变“完成已记录”的事实。
    if (run.topicId !== undefined) {
      try {
        await deps.topicStore?.releaseClaimsForRun(run.runId, {
          at: deps.now(),
          reason: 'run 已完成，自动释放占用',
        })
      } catch {
        // 占用历史保留，后续可显式 release 或等过期接管。
      }
    }

    let callback = await attemptCallback(deps, { ...run, result, callback: { status: 'pending', callbackId, attempts: 0 } }, result, 1)
    try {
      await store.update(run.runId, { callback, lastActivityAt: deps.now(), updatedAt: deps.now() })
    } catch (error: unknown) {
      // 投递已发生但状态落盘失败：盘上必须是 unknown（而非停在 pending 被 reconcile 盲重投）。
      callback = { ...callback, status: 'unknown', reason: `回调状态落盘失败：${reasonOf(error)}` }
      try {
        await store.update(run.runId, { callback, lastActivityAt: deps.now(), updatedAt: deps.now() })
      } catch {
        // 连 unknown 都写不进去：回执如实带 unknown，由调用方/下次对账处理。
      }
    }
    return {
      success: true,
      run_id: run.runId,
      status: input.status,
      result,
      callback,
      ...(completionEntryId === undefined ? {} : { completion_entry_id: completionEntryId }),
      ...(topicRevision === undefined ? {} : { topic_revision: topicRevision }),
    }
  })
}

/** 只读查询 run 状态；仅 origin / child 可读。 */
export async function getRunStatus(deps: WindowDeps, runId: string, exec: unknown): Promise<RunStatusValue> {
  const caller = deps.resolveWindowKey(exec)
  deps.requireLiveDriver(exec)
  const store = requireStore(deps)
  const run = await store.get(runId)
  if (run === undefined) reject('WINDOW_RUN_NOT_FOUND', `run 不存在：${runId}`)
  if (caller !== run.originSessionId && caller !== run.childSessionId) {
    reject('WINDOW_RUN_FORBIDDEN', `本窗口无权读取 run ${runId}`)
  }
  // FR-16 / §7.5：中断与控制留痕要能被 window_status 复盘（有界，最新的在前）。
  let control: RunControlEvent[] | undefined
  if (store.readControl !== undefined) {
    try {
      control = (await store.readControl(runId)).slice(-20).reverse()
    } catch {
      control = undefined
    }
  }
  let messages: RunMessage[] | undefined
  if (store.readMessages !== undefined) {
    try {
      messages = (await store.readMessages(runId)).slice(-20)
    } catch {
      messages = undefined
    }
  }
  return {
    run_id: run.runId,
    scenario: run.scenario,
    origin_session_id: run.originSessionId,
    child_session_id: run.childSessionId,
    created_by: run.createdBy ?? 'open',
    run_status: run.status,
    callback_armed: run.callbackArmed,
    ...(run.result === undefined ? {} : { result: run.result }),
    ...(run.outputSchema === undefined ? {} : { output_schema: run.outputSchema }),
    ...(run.resultRequired === undefined ? {} : { result_required: run.resultRequired }),
    ...(run.topicId === undefined ? {} : { topic_id: run.topicId }),
    ...(run.startedTopicRevision === undefined ? {} : { started_topic_revision: run.startedTopicRevision }),
    ...(run.lifecycle === undefined ? {} : { lifecycle: run.lifecycle }),
    ...(control === undefined ? {} : { control }),
    ...(messages === undefined ? {} : { messages }),
    callback: callbackOf(run),
    last_activity_at: run.lastActivityAt ?? run.updatedAt,
    created_at: run.createdAt,
    updated_at: run.updatedAt,
  }
}

/** 手动重试回调；仅 origin 可调用。 */
export async function retryCallback(
  deps: WindowDeps,
  runId: string,
  exec: unknown,
): Promise<{ success: true; run_id: string; callback: RunCallbackState }> {
  const caller = deps.resolveWindowKey(exec)
  deps.requireLiveDriver(exec)
  const store = requireStore(deps)
  const located = await store.get(runId)
  if (located === undefined) reject('WINDOW_RUN_NOT_FOUND', `run 不存在：${runId}`)
  if (caller !== located.originSessionId) {
    reject('WINDOW_RUN_FORBIDDEN', `只有原窗口（${located.originSessionId}）可以重试回调`)
  }

  return await store.withLock(runId, async () => {
    const run = await store.get(runId)
    if (run === undefined) reject('WINDOW_RUN_NOT_FOUND', `run 不存在：${runId}`)
    if (caller !== run.originSessionId) reject('WINDOW_RUN_FORBIDDEN', `只有原窗口可以重试回调`)
    if (run.result === undefined) reject('WINDOW_RUN_NOT_ACTIVE', `run ${runId} 还没有完成结果，不能重试回调`)
    const existing = callbackOf(run)
    if (existing.status === 'delivered') {
      return { success: true, run_id: runId, callback: existing }
    }
    // origin 主动取消的 run 按语义无回调请求，重试也必须拒绝（§7.2 不变量 19）。
    if (existing.status === 'not_requested') {
      reject('WINDOW_CALLBACK_NOT_REQUESTED', `run ${runId} 的回调已被取消（origin 主动取消），按语义不再投递`)
    }
    // FR-8：unknown 必须先对账，不允许盲目重发（同一 callbackId 已可能投递成功）。
    if (existing.status === 'unknown') {
      reject('WINDOW_CALLBACK_UNKNOWN', `run ${runId} 的回调状态未知，请先人工对账（同一 callbackId 可能已投递），不要直接重试`)
    }
    if (existing.status === 'not_armed') {
      reject('WINDOW_RUN_NOT_ACTIVE', `run ${runId} 的 seed 未送达，回调未武装`)
    }
    const callbackId = existing.callbackId ?? `result-${run.runId}`
    const attempts = existing.attempts + 1
    let callback = await attemptCallback(
      deps,
      { ...run, callback: { ...existing, callbackId, attempts } },
      run.result,
      attempts,
    )
    try {
      await store.update(runId, { callback, lastActivityAt: deps.now(), updatedAt: deps.now() })
    } catch (error: unknown) {
      callback = { ...callback, status: 'unknown', reason: `回调状态落盘失败：${reasonOf(error)}` }
      try {
        await store.update(runId, { callback, lastActivityAt: deps.now(), updatedAt: deps.now() })
      } catch {
        // unknown 也写不进去：回执如实带 unknown。
      }
    }
    return { success: true, run_id: runId, callback }
  })
}
