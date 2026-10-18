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
export const WINDOW_SEND_PROMPT = `向运行中的 branch child 投递引导（steer/排队），只引导、不完成。

- 只有 run 的 origin 能发；child、sibling、无关窗口一律拒绝。
- 目标必须有活动 run；没有活动 run 返回 WINDOW_RUN_NOT_ACTIVE，派新任务请用 window_dispatch。
- 目标正在运行 → steer（最近 step 边界生效）；空闲 → followup 排队。
- 不创建 run、不改 runStatus、不写 result/callback；只返回是否被目标接受。
- 消息来源 dsh-window-guidance，正文标明“非用户新指令”。`

/** `window_interrupt` 提示词。 */
export const WINDOW_INTERRUPT_PROMPT = `中断 branch child 当前轮，或取消整条 run。

- mode='turn'：只取消当前轮，run 保持 active，收件箱与后续引导保留。
- mode='run'：取消当前轮 + run 置 cancelled，callback=not_requested（origin 主动取消不回调自己）。
- 只有 run 的 origin 可以调用；child 不能中断自己或 sibling。
- 目标离线时如实报告：turn 报“未执行”；run 仍可落盘取消，但会说明 child 未被中断。`

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
      run_id: { type: 'string', description: '目标 run id；与 to_window 至少给一个（同时给必须一致）' },
      to_window: { type: 'string', description: '目标 child 窗口码；用于定位其唯一活动 run' },
      message: { type: 'string', required: true, description: '引导正文，≤4000 字符' },
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
      run_id: { type: 'string', required: true, description: '要中断/取消的 run id' },
      mode: { type: 'string', enum: ['turn', 'run'], required: true, description: 'turn=只停当前轮；run=取消整条 run' },
      reason: { type: 'string', description: '中断原因，进控制留痕，≤500 字符' },
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
