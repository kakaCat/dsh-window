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
export const WINDOW_COMPLETE_PROMPT = `上报 branch 续跑的实际完成结果。

- status：completed / failed / cancelled，必须是对任务结果的声明，不是回合状态。
- content：非空结果结论、验证结果与产物路径；不复制完整对话。
- structured：run 声明了 output_schema 时，status=completed 必须提供，且必须符合该 schema；不符会被拒绝且不落盘、不回调。
- 未声明 output_schema 的 run 不接受 structured。
- base_revision：run 绑定了 topic 时必填；等于完成前最新主题 revision。revision 已变化返回 WINDOW_TOPIC_STALE，在保存结果与回调前停止；存在与本 run 相关的未解决冲突时返回 WINDOW_TOPIC_CONFLICT。
- run_id：可省略的唯一条件是当前窗口只有一个活动 branch run；多个必须显式传。
- 普通 turn/end 不算完成；只有本工具或宿主业务插件的确定性完成信号才算。
- 绑定 topic 时自动写入 completion entry（只存 completionId 与有界摘要，不复制 structured 正文），再投递回调。
- 先落结果，再投递回调；回调失败不回滚结果，可用 window_retry_callback 重试。`

/** `window_status` 提示词。 */
export const WINDOW_STATUS_PROMPT = `查询一个 branch run 的只读状态。

- 只有 origin（原窗口）与 child（分支窗口）可以读取。
- run 状态与 callback 状态分开：结果已完成但回调未送达时，callback 会显示 failed / unknown。
- 声明过 output_schema 的 run 会一并返回 schema 与 structured 结果。
- 不返回其他窗口的完整对话。`

/** `window_retry_callback` 提示词。 */
export const WINDOW_RETRY_CALLBACK_PROMPT = `重试把一个已完成的 branch 结果回调投递给原窗口。

- 只有 origin 原窗口可以重试；child 不能借重试向其他窗口发消息。
- 结果必须已经落盘（run 有 result）；seed 未送达的 run 不能重试。
- 使用同一个 callbackId，重试不会伪造新的逻辑结果。`

/** `window_dispatch` 提示词。 */
export const WINDOW_DISPATCH_PROMPT = `向已有的 branch child 再派一条任务，不创建新会话。

- 只允许与目标 child 存在既有委派关系的原窗口调用；continuation 接管窗口和任意无关窗口一律拒绝。
- 同一 child 同时最多一条活动 run，忙时返回 WINDOW_CHILD_BUSY；完成后再派下一条。
- 每次派发生成新的 run_id，child 完成后照常 window_complete 回调原窗口。
- child 上下文会累积；接近顶墙时应新开 branch/continuation，而不是继续向同一 child 塞任务。`

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
      run_id: { type: 'string', description: 'branch run id；当前窗口只有一个活动 run 时可省略' },
      status: { type: 'string', enum: [...RUN_TERMINAL_STATUSES], required: true, description: 'completed / failed / cancelled' },
      content: { type: 'string', required: true, description: '非空完成结果；failed/cancelled 写真实原因与已有产出' },
      structured: { type: 'json', description: '声明 output_schema 时 completed 必填；必须符合该 schema' },
      base_revision: { type: 'integer', description: 'run 绑定 topic 时必填；等于完成前最新主题 revision' },
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
      run_id: { type: 'string', required: true, description: '要查询的 branch run id' },
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
          last_activity_at: { type: 'number' },
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
        last_activity_at: value.last_activity_at,
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
      run_id: { type: 'string', required: true, description: '结果已落盘但回调未确认的 branch run id' },
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
      to_window: { type: 'string', required: true, description: '已有 branch child 的窗口码（= 会话 id）' },
      seed_text: { type: 'string', required: true, description: '追加任务包；不能为空' },
      output_schema: { type: 'json', description: '本次追加任务的结构化契约；object 根 JSON Schema 子集' },
      result_required: { type: 'boolean', description: 'true 时必须同时给 output_schema' },
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
