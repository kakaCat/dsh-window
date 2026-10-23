/**
 * `window` Host Service：把 `window_open` 与生命周期能力服务化，供其他插件
 * 按 `ctx.inject('window')` 选用（REQ-DSH-WINDOW-001 §6.5）。
 *
 * 约定（对外契约）：
 * - 服务名 `window`；
 * - `open(request, exec)`：入参 camelCase（scenario 必填、seedText 必填），出参 camelCase；
 * - `stopForOrigin(originSessionId, reason, exec?)`：B5 `stopActiveRunsForOrigin` 的服务化入口；
 *   传 exec 时必须调用者就是该 origin；不传 exec（宿主对账）时仅允许 origin 已离线。
 *
 * 校验失败仍按 WindowError 抛出（带 code/message）；调用方按其错误码适配层处理。
 *
 * @module dsh-window/hostService
 */
import { openWindow } from './application/openWindow.js'
import { completeRun, getRunStatus, retryCallback } from './application/completeRun.js'
import { listRuns } from './application/listRuns.js'
import { inspectWindow } from './application/inspectWindow.js'
import { dispatchTask } from './application/dispatchTask.js'
import { sendGuidance } from './application/sendGuidance.js'
import { interruptRun } from './application/interruptRun.js'
import { waitRuns } from './application/waitRuns.js'
import {
  topicAppend,
  topicClaim,
  topicCreate,
  topicGet,
  topicJoin,
  topicSend,
} from './application/topicLedger.js'
import { reconcileRuns, stopActiveRunsForOrigin, type ReconcileSummary } from './application/lifecycle.js'
import { WindowError } from './shared/errors.js'
import type {
  CompleteRunInput,
  CompleteRunValue,
  DispatchTaskInput,
  DispatchTaskValue,
  InterruptRunInput,
  InterruptRunValue,
  RunCallbackState,
  RunStatusValue,
  SendGuidanceInput,
  SendGuidanceValue,
  TopicAppendToolInput,
  TopicClaimToolInput,
  TopicCreateToolInput,
  TopicGetToolInput,
  TopicJoinToolInput,
  TopicSendToolInput,
  TopicSendValue,
  WaitRunsInput,
  WaitRunsValue,
  WindowDeps,
  WindowInspectInput,
  WindowInspectValue,
  WindowListInput,
  WindowListValue,
} from './application/ports.js'
import type { OpenWindowInput, Scenario, WindowMode } from './shared/protocol.js'

/** Host Service 名（Cordis provide / inject 的键）。 */
export const WINDOW_SERVICE = 'window'

/** stop 汇总（`{ affected, failures }` 即对外契约）。 */
export interface WindowHostStopSummary {
  affected: string[]
  failures: { runId: string; reason: string }[]
}

/** 服务面（方法名与出参字段即对外契约）。 */
export interface WindowHostService {
  /** 按显式 scenario 开窗；返回 camelCase 回执。 */
  open(request: unknown, exec: unknown): Promise<Record<string, unknown>>
  /** 按 branch run_id 完成（与 window_complete 同用例）。 */
  complete(input: CompleteRunInput, exec: unknown): Promise<CompleteRunValue>
  /** 查询 run 状态（与 window_status 同用例）。 */
  get(runId: string, exec: unknown): Promise<RunStatusValue>
  /** 手动重试回调（与 window_retry_callback 同用例）。 */
  retryCallback(runId: string, exec: unknown): Promise<{ success: true; run_id: string; callback: RunCallbackState }>
  /** 列出可见 run（与 window_list 同用例）。 */
  list(input: WindowListInput, exec: unknown): Promise<WindowListValue>
  /** 只读查看窗口（与 window_inspect 同用例）。 */
  inspect(input: WindowInspectInput, exec: unknown): Promise<WindowInspectValue>
  /** 复用 child 再派任务（与 window_dispatch 同用例）。 */
  dispatch(input: DispatchTaskInput, exec: unknown): Promise<DispatchTaskValue>
  /** 运行中引导（与 window_send 同用例）。 */
  send(input: SendGuidanceInput, exec: unknown): Promise<SendGuidanceValue>
  /** 中断/取消（与 window_interrupt 同用例）。 */
  interrupt(input: InterruptRunInput, exec: unknown): Promise<InterruptRunValue>
  /** 等待终态（与 window_wait 同用例）。 */
  wait(input: WaitRunsInput, exec: unknown): Promise<WaitRunsValue>
  /** 主题用例（与 window_topic_* 同用例）。 */
  topicCreate(input: TopicCreateToolInput, exec: unknown): Promise<unknown>
  topicJoin(input: TopicJoinToolInput, exec: unknown): Promise<unknown>
  topicGet(input: TopicGetToolInput, exec: unknown): Promise<unknown>
  topicAppend(input: TopicAppendToolInput, exec: unknown): Promise<unknown>
  topicClaim(input: TopicClaimToolInput, exec: unknown): Promise<unknown>
  /** 写一条协作消息并投递给其他参与者（`window_topic_send` 同用例）。 */
  topicSend(input: TopicSendToolInput, exec: unknown): Promise<TopicSendValue>
  /** 生命周期对账（§6.17）：恢复未送达 callback、标记 orphan、清理半截写入。 */
  reconcile(): Promise<ReconcileSummary>
  /** 对某个 origin 名下的活动 run 做 stop（会话停止/归档联动）。 */
  stopForOrigin(originSessionId: string, reason: string, exec?: unknown): Promise<WindowHostStopSummary>
}

function stringOf(raw: unknown): string | undefined {
  return typeof raw === 'string' ? raw : undefined
}

/** 由 WindowDeps 构造 Host Service。 */
export function createWindowHostService(deps: WindowDeps): WindowHostService {
  return {
    async open(request: unknown, exec: unknown): Promise<Record<string, unknown>> {
      const raw = request !== null && typeof request === 'object' ? request as Record<string, unknown> : {}
      const input: OpenWindowInput = {
        scenario: raw['scenario'] as Scenario,
        seedText: stringOf(raw['seedText']) ?? '',
        ...(stringOf(raw['mode']) === undefined ? {} : { mode: raw['mode'] as WindowMode }),
        ...(typeof raw['atSeq'] === 'number' ? { atSeq: raw['atSeq'] } : {}),
        ...(stringOf(raw['title']) === undefined ? {} : { title: raw['title'] as string }),
        ...(stringOf(raw['targetWorkspace']) === undefined ? {} : { targetWorkspace: raw['targetWorkspace'] as string }),
        ...(stringOf(raw['topicId']) === undefined ? {} : { topicId: raw['topicId'] as string }),
        ...(stringOf(raw['topicScope']) === undefined ? {} : { topicScope: raw['topicScope'] as OpenWindowInput['topicScope'] }),
        ...(raw['outputSchema'] === undefined ? {} : { outputSchema: raw['outputSchema'] }),
        ...(raw['resultRequired'] === undefined ? {} : { resultRequired: raw['resultRequired'] === true }),
      }
      const value = await openWindow(deps, input, exec)
      return {
        success: value.success,
        scenario: value.scenario,
        callbackPolicy: value.callback_policy,
        sessionCreated: value.session_created,
        ...(value.window_key === undefined ? {} : { windowKey: value.window_key }),
        ...(value.parent_session_id === undefined ? {} : { parentSessionId: value.parent_session_id }),
        mode: value.mode,
        ...(value.target_workspace === undefined
          ? {}
          : {
              targetWorkspace: {
                id: value.target_workspace.id,
                title: value.target_workspace.title,
                ...(value.target_workspace.path === undefined ? {} : { path: value.target_workspace.path }),
              },
            }),
        ...(value.run_id === undefined ? {} : { runId: value.run_id }),
        topicTracking: value.topic_tracking,
        ...(value.topic_id === undefined ? {} : { topicId: value.topic_id }),
        ...(value.topic_scope === undefined ? {} : { topicScope: value.topic_scope }),
        ...(value.topic_revision === undefined ? {} : { topicRevision: value.topic_revision }),
        callbackArmed: value.callback_armed,
        ...(value.delivery === undefined
          ? {}
          : {
              delivery: {
                delivered: value.delivery.delivered,
                kind: value.delivery.kind,
                ...(value.delivery.reason === undefined ? {} : { reason: value.delivery.reason }),
                // §6.18：run_error / topic_note 也属 open 回执契约，不能只留在工具面。
                ...(value.delivery.run_error === undefined ? {} : { runError: value.delivery.run_error }),
                ...(value.delivery.topic_note === undefined ? {} : { topicNote: value.delivery.topic_note }),
              },
            }),
        inheritance: value.inheritance,
        degradedNote: value.degraded_note,
      }
    },

    /**
     * origin 停止/归档时回收它的 active run。
     *
     * 安全（审核修复）：这不是无门槛的写入口——
     * - 传了 `exec`：调用者必须**就是该 origin**（自己停自己）；
     * - 未传 `exec`（宿主生命周期/对账路径）：仅当该 origin **确实不在线**时才允许代停；
     *   origin 仍在线时拒绝，要求它自己走 `window_interrupt(mode='run')`。
     */
    async stopForOrigin(originSessionId: string, reason: string, exec?: unknown): Promise<WindowHostStopSummary> {
      if (typeof originSessionId !== 'string' || originSessionId.trim().length === 0) {
        throw new WindowError('WINDOW_INVALID_INPUT', 'stopForOrigin 需要非空的 originSessionId')
      }
      if (typeof reason !== 'string' || reason.trim().length === 0) {
        throw new WindowError('WINDOW_INVALID_INPUT', 'stopForOrigin 需要非空的 reason')
      }
      if (reason.length > 500) {
        throw new WindowError('WINDOW_INVALID_INPUT', `stopForOrigin 的 reason 过长（${reason.length} > 500）`)
      }
      if (exec !== undefined && exec !== null) {
        const caller = deps.resolveWindowKey(exec)
        deps.requireLiveDriver(exec)
        if (caller !== originSessionId) {
          throw new WindowError('WINDOW_RUN_FORBIDDEN', `只有 origin ${originSessionId} 自己可以停止它的 run（调用者是 ${caller}）`)
        }
      } else {
        // fail-closed：没有 isWindowAlive 端口就判不了在线，不能默认放行代停。
        if (deps.isWindowAlive === undefined) {
          throw new WindowError(
            'WINDOW_RUN_FORBIDDEN',
            'stopForOrigin 未装配 isWindowAlive：无法证明 origin 已离线，拒绝代停（请由 origin 自己调用 window_interrupt，或让宿主装配该端口）',
          )
        }
        let alive: boolean | undefined
        try {
          alive = deps.isWindowAlive(originSessionId)
        } catch {
          alive = undefined
        }
        if (alive !== false) {
          throw new WindowError(
            'WINDOW_RUN_FORBIDDEN',
            `origin ${originSessionId} 仍在线或在线状态不可判定：停止它的 run 应由该窗口调用 window_interrupt(mode='run')，或等它确实离线后再对账`,
          )
        }
      }
      const summary = await stopActiveRunsForOrigin(deps, originSessionId, reason)
      return { affected: summary.affected, failures: summary.failures }
    },

    // §6.5：其余能力与工具同用例，供宿主做运行时调度与业务集成。
    complete: async (input, exec) => await completeRun(deps, input, exec),
    get: async (runId, exec) => await getRunStatus(deps, runId, exec),
    retryCallback: async (runId, exec) => await retryCallback(deps, runId, exec),
    list: async (input, exec) => await listRuns(deps, input, exec),
    inspect: async (input, exec) => await inspectWindow(deps, input, exec),
    dispatch: async (input, exec) => await dispatchTask(deps, input, exec),
    send: async (input, exec) => await sendGuidance(deps, input, exec),
    interrupt: async (input, exec) => await interruptRun(deps, input, exec),
    wait: async (input, exec) => await waitRuns(deps, input, exec),
    topicCreate: async (input, exec) => await topicCreate(deps, input, exec),
    topicJoin: async (input, exec) => await topicJoin(deps, input, exec),
    topicGet: async (input, exec) => await topicGet(deps, input, exec),
    topicAppend: async (input, exec) => await topicAppend(deps, input, exec),
    topicClaim: async (input, exec) => await topicClaim(deps, input, exec),
    topicSend: async (input, exec) => await topicSend(deps, input, exec),
    reconcile: async () => await reconcileRuns(deps),
  }
}
