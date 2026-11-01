/**
 * branch 完成闭环的三个工具壳：完成、查询、重试回调。
 *
 * @module dsh-window/tools/windowRunTools
 */
import { defineTool, type ToolRunContext } from '@deepseek-ai/dsh-tools'
import { completeRun, getRunStatus, retryCallback } from '../application/completeRun.js'
import { dispatchTask } from '../application/dispatchTask.js'
import type { RunCallbackState, RunResult, WindowDeps } from '../application/ports.js'
import { RUN_TERMINAL_STATUSES } from '../shared/protocol.js'

/** `window_complete` 提示词。 */
export const WINDOW_COMPLETE_PROMPT = `Report the actual result of a branch run: persist the result first, then deliver the callback to the origin. status is the task outcome (completed, failed, or cancelled), not the turn state. content states the conclusion, verification, and artifact paths without copying the full conversation. When the run declared output_schema, completed must include a structured value that matches it; runs without a schema do not accept structured. A failed callback does not roll back the result, and delivery is retried automatically with backoff (up to a minute apart); retry immediately with window_retry_callback if the origin is known to be reachable. An ordinary turn/end is not a completion; only this tool or a deterministic completion signal from a host plugin counts.`

/** `window_status` 提示词。 */
export const WINDOW_STATUS_PROMPT = `Read one branch run's status without changing it. Only the origin and the child can read it. Run status and callback status are returned separately; when a result is complete but its callback has not been delivered, callback reports failed or unknown. callback.read_at is the proof the origin actually read the result into its history: delivered only means the inbox accepted it, and a message can be dropped before it reaches history. A run that declared output_schema also returns the schema and structured result. No other window's full conversation is returned.`

/** `window_retry_callback` 提示词。 */
export const WINDOW_RETRY_CALLBACK_PROMPT = `Retry delivery of a completed branch result to its origin window. Use it only after the result is persisted and the callback is unconfirmed; the retry reuses the original callback identity and never fabricates a new logical result. Only the origin may retry.`

/** `window_dispatch` 提示词。 */
export const WINDOW_DISPATCH_PROMPT = `Dispatch another task to an existing branch child without opening a new session. Each dispatch creates a new run, and the child reports it through window_complete as usual so the origin receives the callback. Only the origin with an existing delegation relationship to that child may dispatch. The child's context accumulates; when it approaches its limit, open a fresh window with window_open instead.`

/** 结果对象输出 schema。 */
const resultProperties = {
  status: { type: 'string' as const },
  content: { type: 'string' as const },
  structured: { type: 'json' as const },
  completion_entry_id: { type: 'string' as const },
  topic_revision: { type: 'integer' as const },
  completed_at: { type: 'number' as const },
  completed_by: { type: 'string' as const },
}

/** 回调对象输出 schema。 */
const callbackProperties = {
  status: { type: 'string' as const },
  callback_id: { type: 'string' as const },
  attempts: { type: 'integer' as const },
  reason: { type: 'string' as const },
  delivered_at: { type: 'number' as const },
  read_at: { type: 'number' as const },
  next_attempt_at: { type: 'number' as const },
}

/** 结果 → 工具回执（snake_case + 去掉未声明的 structured）。 */
function resultOut(result: RunResult) {
  return {
    status: result.status,
    content: result.content,
    ...(result.structured === undefined ? {} : { structured: result.structured as never }),
    ...(result.completionEntryId === undefined ? {} : { completion_entry_id: result.completionEntryId }),
    ...(result.topicRevision === undefined ? {} : { topic_revision: result.topicRevision }),
    completed_at: result.completedAt,
    completed_by: result.completedBy,
  }
}

/** 回调状态 → 工具回执（snake_case）。 */
function callbackOut(callback: RunCallbackState) {
  return {
    status: callback.status,
    ...(callback.callbackId === undefined ? {} : { callback_id: callback.callbackId }),
    attempts: callback.attempts,
    ...(callback.reason === undefined ? {} : { reason: callback.reason }),
    ...(callback.deliveredAt === undefined ? {} : { delivered_at: callback.deliveredAt }),
    ...(callback.readAt === undefined ? {} : { read_at: callback.readAt }),
    ...(callback.nextAttemptAt === undefined ? {} : { next_attempt_at: callback.nextAttemptAt }),
  }
}

/** 完成回执摘要。 */
function completeSummary(value: unknown): string {
  const record = value as Record<string, unknown>
  const callback = (record['callback'] ?? {}) as Record<string, unknown>
  const state = String(callback['status'] ?? '?')
  // unknown 不是「未送达」：投递可能已发生、只是状态没落盘，文案不能反向断言。
  const delivered = state === 'delivered'
    ? '回调已送达'
    : state === 'unknown'
      ? `回调状态未知（可能已送达，需按 callbackId 对账：${String(callback['reason'] ?? state)}）`
      : `回调未送达（${String(callback['reason'] ?? state)}）`
  return `✅ branch 结果已记录：${String(record['run_id'] ?? '?')}（${String(record['status'] ?? '?')}，${delivered}）`
}

/** 状态回执摘要。 */
function statusSummary(value: unknown): string {
  const record = value as Record<string, unknown>
  const callback = (record['callback'] ?? {}) as Record<string, unknown>
  return `📄 run ${String(record['run_id'] ?? '?')}：run=${String(record['run_status'] ?? '?')}，`
    + `callback=${String(callback['status'] ?? '?')}，attempts=${String(callback['attempts'] ?? 0)}`
}

/** 重试回执摘要。 */
function retrySummary(value: unknown): string {
  const record = value as Record<string, unknown>
  const callback = (record['callback'] ?? {}) as Record<string, unknown>
  return `🔁 回调重试：${String(record['run_id'] ?? '?')} → ${String(callback['status'] ?? '?')}`
}

/** 追加任务回执摘要。 */
function dispatchSummary(value: unknown): string {
  const record = value as Record<string, unknown>
  const delivery = (record['delivery'] ?? {}) as Record<string, unknown>
  if (record['success'] !== true) {
    return `❌ 追加任务未完整建立：${String(delivery['reason'] ?? '见明细')}`
  }
  return `📨 已向 ${String(record['to_window'] ?? '?')} 派发新任务（run_id=${String(record['run_id'] ?? '?')}）`
}

/** 定义 `window_complete`。 */
export function defineWindowCompleteTool(deps: WindowDeps) {
  return defineTool({
    name: 'window_complete',
    description: WINDOW_COMPLETE_PROMPT,
    parameters: {
      run_id: { type: 'string', description: 'Branch run id; omit only when the current window has exactly one active run.' },
      status: { type: 'string', enum: [...RUN_TERMINAL_STATUSES], required: true, description: 'completed / failed / cancelled' },
      content: { type: 'string', required: true, description: 'Non-empty completion result; for failed or cancelled, give the real reason and any output produced.' },
      structured: { type: 'json', description: 'Required for completed when the run declared output_schema; must match that schema.' },
      base_revision: { type: 'integer', description: 'Required when the run is bound to a topic; must equal the latest topic revision before completion.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          success: { type: 'boolean' },
          run_id: { type: 'string' },
          status: { type: 'string' },
          result: { type: 'object', additionalProperties: false, properties: resultProperties },
          callback: { type: 'object', additionalProperties: false, properties: callbackProperties },
          completion_entry_id: { type: 'string' },
          topic_revision: { type: 'integer' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: completeSummary(value) }],
    },
    async execute(args, exec: ToolRunContext) {
      const value = await completeRun(
        deps,
        {
          ...(args.run_id === undefined ? {} : { runId: args.run_id }),
          status: args.status,
          content: args.content,
          ...(args.structured === undefined ? {} : { structured: args.structured }),
          ...(args.base_revision === undefined ? {} : { baseRevision: args.base_revision }),
        },
        exec,
      )
      return {
        success: value.success,
        run_id: value.run_id,
        status: value.status,
        result: resultOut(value.result),
        callback: callbackOut(value.callback),
        ...(value.completion_entry_id === undefined ? {} : { completion_entry_id: value.completion_entry_id }),
        ...(value.topic_revision === undefined ? {} : { topic_revision: value.topic_revision }),
      }
    },
  })
}

/** 定义 `window_status`。 */
export function defineWindowStatusTool(deps: WindowDeps) {
  return defineTool({
    name: 'window_status',
    description: WINDOW_STATUS_PROMPT,
    parameters: {
      run_id: { type: 'string', required: true, description: 'Branch run id to query.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          run_id: { type: 'string' },
          scenario: { type: 'string' },
          origin_session_id: { type: 'string' },
          child_session_id: { type: 'string' },
          created_by: { type: 'string' },
          run_status: { type: 'string' },
          callback_armed: { type: 'boolean' },
          result: { type: 'object', additionalProperties: false, properties: resultProperties },
          output_schema: { type: 'json' },
          result_required: { type: 'boolean' },
          topic_id: { type: 'string' },
          started_topic_revision: { type: 'integer' },
          duplicate_of: { type: 'array', items: { type: 'string' } },
          contract_attached: { type: 'boolean' },
          last_activity_at: { type: 'number' },
          last_turn_at: { type: 'number' },
          lifecycle: {
            type: 'object',
            additionalProperties: false,
            properties: {
              state: { type: 'string' },
              reason: { type: 'string' },
              at: { type: 'number' },
            },
          },
          control: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                event_id: { type: 'string' },
                run_id: { type: 'string' },
                kind: { type: 'string' },
                actor_session_id: { type: 'string' },
                reason: { type: 'string' },
                at: { type: 'number' },
                result: { type: 'string' },
                message_id: { type: 'string' },
                text_digest: { type: 'string' },
              },
            },
          },
          messages: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                message_id: { type: 'string' },
                run_id: { type: 'string' },
                sender_session_id: { type: 'string' },
                target_session_id: { type: 'string' },
                kind: { type: 'string' },
                text_digest: { type: 'string' },
                at: { type: 'number' },
                delivered_at: { type: 'number' },
              },
            },
          },
          callback: { type: 'object', additionalProperties: false, properties: callbackProperties },
          created_at: { type: 'number' },
          updated_at: { type: 'number' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: statusSummary(value) }],
    },
    async execute(args, exec: ToolRunContext) {
      const value = await getRunStatus(deps, args.run_id, exec)
      return {
        run_id: value.run_id,
        scenario: value.scenario,
        origin_session_id: value.origin_session_id,
        child_session_id: value.child_session_id,
        created_by: value.created_by,
        run_status: value.run_status,
        ...(value.duplicate_of === undefined ? {} : { duplicate_of: value.duplicate_of }),
        ...(value.contract_attached === undefined ? {} : { contract_attached: value.contract_attached }),
        last_activity_at: value.last_activity_at,
        ...(value.last_turn_at === undefined ? {} : { last_turn_at: value.last_turn_at }),
        ...(value.topic_id === undefined ? {} : { topic_id: value.topic_id }),
        ...(value.started_topic_revision === undefined ? {} : { started_topic_revision: value.started_topic_revision }),
        callback_armed: value.callback_armed,
        ...(value.result === undefined ? {} : { result: resultOut(value.result) }),
        ...(value.output_schema === undefined ? {} : { output_schema: value.output_schema as never }),
        ...(value.result_required === undefined ? {} : { result_required: value.result_required }),
        ...(value.lifecycle === undefined
          ? {}
          : {
              lifecycle: {
                state: value.lifecycle.state,
                ...(value.lifecycle.reason === undefined ? {} : { reason: value.lifecycle.reason }),
                at: value.lifecycle.at,
              },
            }),
        ...(value.control === undefined
          ? {}
          : {
              control: value.control.map((event) => ({
                event_id: event.eventId,
                run_id: event.runId,
                kind: event.kind,
                actor_session_id: event.actorSessionId,
                ...(event.reason === undefined ? {} : { reason: event.reason }),
                at: event.at,
                result: event.result,
                ...(event.messageId === undefined ? {} : { message_id: event.messageId }),
                ...(event.textDigest === undefined ? {} : { text_digest: event.textDigest }),
              })),
            }),
        ...(value.messages === undefined
          ? {}
          : {
              messages: value.messages.map((message) => ({
                message_id: message.messageId,
                run_id: message.runId,
                sender_session_id: message.senderSessionId,
                target_session_id: message.targetSessionId,
                kind: message.kind,
                text_digest: message.textDigest,
                at: message.at,
                ...(message.deliveredAt === undefined ? {} : { delivered_at: message.deliveredAt }),
              })),
            }),
        callback: callbackOut(value.callback),
        created_at: value.created_at,
        updated_at: value.updated_at,
      }
    },
  })
}

/** 定义 `window_retry_callback`。 */
export function defineWindowRetryCallbackTool(deps: WindowDeps) {
  return defineTool({
    name: 'window_retry_callback',
    description: WINDOW_RETRY_CALLBACK_PROMPT,
    parameters: {
      run_id: { type: 'string', required: true, description: 'Branch run id whose result is persisted but whose callback is unconfirmed.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          success: { type: 'boolean' },
          run_id: { type: 'string' },
          callback: { type: 'object', additionalProperties: false, properties: callbackProperties },
        },
      },
      render: (_args, value) => [{ type: 'text', text: retrySummary(value) }],
    },
    async execute(args, exec: ToolRunContext) {
      const value = await retryCallback(deps, args.run_id, exec)
      return { success: value.success, run_id: value.run_id, callback: callbackOut(value.callback) }
    },
  })
}

/** 定义 `window_dispatch`。 */
export function defineWindowDispatchTool(deps: WindowDeps) {
  return defineTool({
    name: 'window_dispatch',
    description: WINDOW_DISPATCH_PROMPT,
    parameters: {
      to_window: { type: 'string', required: true, description: 'Window key of an existing branch child (= session id).' },
      seed_text: { type: 'string', required: true, description: 'Additional task package; must not be empty.' },
      output_schema: { type: 'json', description: 'Structured contract for this task; an object-rooted JSON Schema subset.' },
      result_required: { type: 'boolean', description: 'true requires output_schema.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          success: { type: 'boolean' },
          run_id: { type: 'string' },
          to_window: { type: 'string' },
          callback_policy: { type: 'string' },
          callback_armed: { type: 'boolean' },
          delivery: {
            type: 'object',
            additionalProperties: false,
            properties: {
              delivered: { type: 'boolean' },
              kind: { type: 'string' },
              reason: { type: 'string' },
              run_error: { type: 'string' },
            },
          },
          degraded_note: { type: 'string' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: dispatchSummary(value) }],
    },
    async execute(args, exec: ToolRunContext) {
      return await dispatchTask(
        deps,
        {
          toWindow: args.to_window,
          seedText: args.seed_text,
          ...(args.output_schema === undefined ? {} : { outputSchema: args.output_schema }),
          ...(args.result_required === undefined ? {} : { resultRequired: args.result_required }),
        },
        exec,
      )
    },
  })
}
