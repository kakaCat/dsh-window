/**
 * `window_wait` 工具壳：等待一组 branch run 进入终态（all / any）。
 *
 * @module dsh-window/tools/windowWaitTool
 */
import { defineTool, type ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { RunStatus, WindowDeps } from '../application/ports.js'
import { waitRuns } from '../application/waitRuns.js'

/** `window_wait` 提示词。 */
export const WINDOW_WAIT_PROMPT = `等待一组 branch run 进入终态，再继续 origin 的后续步骤。

- 目标三选一：run_ids 显式列表、scope='my_active'（本窗口 origin 的活动 run）、topic_id。
- mode='all' 等全部终态；mode='any' 任一终态即返回。
- timeout_ms 到点返回当前快照 + timed_out=true；running 不等于完成。
- 拉取语义：不消费 callback、不改 run；callback 仍会照常投递。
- 只有 origin 或对应 child 能等待自己的 run；无关窗口返回 WINDOW_RUN_FORBIDDEN。`

/** 回执摘要。 */
function waitSummary(value: unknown): string {
  const record = value as Record<string, unknown>
  const runs = Array.isArray(record['runs']) ? record['runs'] : []
  const flag = record['aborted'] === true ? '已取消' : record['timed_out'] === true ? '超时' : '已收齐'
  return `⏳ window_wait ${flag}：${runs.length} 条 run`
}

/** 定义 `window_wait`。 */
export function defineWindowWaitTool(deps: WindowDeps) {
  return defineTool({
    name: 'window_wait',
    description: WINDOW_WAIT_PROMPT,
    parameters: {
      run_ids: { type: 'array', items: { type: 'string' }, description: '显式目标 run id 列表' },
      scope: { type: 'string', enum: ['my_active'], description: '本窗口 origin 的活动 run' },
      topic_id: { type: 'string', description: '等待该 topic 相关且本窗口可见的 run' },
      status: {
        type: 'array',
        items: { type: 'string' },
        description: '只等待这些 run 状态（FR-17）：pending/running/completed/failed/cancelled/seed_failed/orphaned',
      },
      mode: { type: 'string', enum: ['all', 'any'], required: true, description: 'all=全部终态；any=任一终态' },
      timeout_ms: { type: 'integer', required: true, description: '最长等待毫秒数；到点返回快照' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          timed_out: { type: 'boolean' },
          aborted: { type: 'boolean' },
          runs: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                run_id: { type: 'string' },
                created_by: { type: 'string' },
                child_window_key: { type: 'string' },
                run_status: { type: 'string' },
                lifecycle_state: { type: 'string' },
                callback: {
                  type: 'object',
                  additionalProperties: false,
                  properties: {
                    status: { type: 'string' },
                    attempts: { type: 'integer' },
                    reason: { type: 'string' },
                  },
                },
                topic_id: { type: 'string' },
                last_activity_at: { type: 'number' },
                created_at: { type: 'number' },
                updated_at: { type: 'number' },
              },
            },
          },
        },
      },
      render: (_args, value) => [{ type: 'text', text: waitSummary(value) }],
    },
    async execute(args, exec: ToolRunContext) {
      return await waitRuns(
        deps,
        {
          ...(args.run_ids === undefined ? {} : { runIds: args.run_ids }),
          ...(args.scope === undefined ? {} : { scope: args.scope }),
          ...(args.topic_id === undefined ? {} : { topicId: args.topic_id }),
          ...(args.status === undefined ? {} : { status: args.status as RunStatus[] }),
          mode: args.mode,
          timeoutMs: args.timeout_ms,
        },
        exec,
      )
    },
  })
}
