/**
 * 运行中控制工具壳：`window_send` 与 `window_interrupt`。
 *
 * @module dsh-window/tools/windowControlTools
 */
import { defineTool, type ToolRunContext } from '@deepseek-ai/dsh-tools'
import { interruptRun } from '../application/interruptRun.js'
import { sendGuidance } from '../application/sendGuidance.js'
import type { RunCallbackState, RunResult, WindowDeps } from '../application/ports.js'

/** `window_send` 提示词。 */
export const WINDOW_SEND_PROMPT = `Send guidance to a running branch child. This only guides the child and never completes the run. A running target receives the message at its next step boundary (steer); an idle target queues it for its next turn. The message is marked as coming from a collaborating window, not as a new user instruction. Only the run's origin may send, and the target must have an active run; use window_dispatch to assign new work.`

/** `window_interrupt` 提示词。 */
export const WINDOW_INTERRUPT_PROMPT = `Stop a branch child's current turn, or cancel its whole run. mode='turn' stops only the current turn and leaves the run active, preserving its inbox and queued guidance; mode='run' also marks the run cancelled and sends no callback to the origin. Only the run's origin may call this. When the target is offline, the result states truthfully whether it was actually interrupted.`

const resultProperties = {
  status: { type: 'string' as const },
  content: { type: 'string' as const },
  completed_at: { type: 'number' as const },
  completed_by: { type: 'string' as const },
}

const callbackProperties = {
  status: { type: 'string' as const },
  callback_id: { type: 'string' as const },
  attempts: { type: 'integer' as const },
  reason: { type: 'string' as const },
  delivered_at: { type: 'number' as const },
}

function sendSummary(value: unknown): string {
  const record = value as Record<string, unknown>
  if (record['accepted'] !== true) {
    return `⚠️ 引导未送达：${String(record['reason'] ?? '见明细')}`
  }
  return `📨 引导已${record['delivery'] === 'steered' ? '插入运行中' : '排队'}（run=${String(record['run_id'] ?? '?')}）`
}

function interruptSummary(value: unknown): string {
  const record = value as Record<string, unknown>
  return `🛑 ${String(record['mode'] ?? '?')} 中断：run=${String(record['run_id'] ?? '?')} → ${String(record['run_status'] ?? '?')}`
}

/** 定义 `window_send`。 */
export function defineWindowSendTool(deps: WindowDeps) {
  return defineTool({
    name: 'window_send',
    description: WINDOW_SEND_PROMPT,
    parameters: {
      run_id: { type: 'string', description: 'Target run id. Provide this or to_window; if both are given they must match.' },
      to_window: { type: 'string', description: 'Target child window key; used to locate its single active run.' },
      message: { type: 'string', required: true, description: 'Guidance text, at most 4000 characters.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          accepted: { type: 'boolean' },
          run_id: { type: 'string' },
          message_id: { type: 'string' },
          delivery: { type: 'string' },
          reason: { type: 'string' },
          note: { type: 'string' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: sendSummary(value) }],
    },
    async execute(args, exec: ToolRunContext) {
      return await sendGuidance(
        deps,
        {
          ...(args.run_id === undefined ? {} : { runId: args.run_id }),
          ...(args.to_window === undefined ? {} : { toWindow: args.to_window }),
          message: args.message,
        },
        exec,
      )
    },
  })
}

/** 定义 `window_interrupt`。 */
export function defineWindowInterruptTool(deps: WindowDeps) {
  return defineTool({
    name: 'window_interrupt',
    description: WINDOW_INTERRUPT_PROMPT,
    parameters: {
      run_id: { type: 'string', required: true, description: 'Run id to interrupt or cancel.' },
      mode: { type: 'string', enum: ['turn', 'run'], required: true, description: 'turn stops only the current turn; run cancels the whole run.' },
      reason: { type: 'string', description: 'Reason for the interrupt, recorded in the control log; at most 500 characters.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          accepted: { type: 'boolean' },
          run_id: { type: 'string' },
          mode: { type: 'string' },
          run_status: { type: 'string' },
          result: { type: 'object', additionalProperties: false, properties: resultProperties },
          callback: { type: 'object', additionalProperties: false, properties: callbackProperties },
          note: { type: 'string' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: interruptSummary(value) }],
    },
    async execute(args, exec: ToolRunContext) {
      const value = await interruptRun(
        deps,
        {
          runId: args.run_id,
          mode: args.mode,
          ...(args.reason === undefined ? {} : { reason: args.reason }),
        },
        exec,
      )
      return {
        accepted: value.accepted,
        run_id: value.run_id,
        mode: value.mode,
        run_status: value.run_status,
        ...(value.result === undefined ? {} : { result: resultOut(value.result) }),
        callback: callbackOut(value.callback),
        note: value.note,
      }
    },
  })
}

function resultOut(result: RunResult) {
  return {
    status: result.status,
    content: result.content,
    completed_at: result.completedAt,
    completed_by: result.completedBy,
  }
}

function callbackOut(callback: RunCallbackState) {
  return {
    status: callback.status,
    ...(callback.callbackId === undefined ? {} : { callback_id: callback.callbackId }),
    attempts: callback.attempts,
    ...(callback.reason === undefined ? {} : { reason: callback.reason }),
    ...(callback.deliveredAt === undefined ? {} : { delivered_at: callback.deliveredAt }),
  }
}
