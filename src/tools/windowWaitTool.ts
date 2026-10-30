/**
 * `window_wait` 工具壳：等待一组 branch run 进入终态（all / any）。
 *
 * @module dsh-window/tools/windowWaitTool
 */
import { defineTool, type ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { RunStatus, WindowDeps } from '../application/ports.js'
import { waitRuns } from '../application/waitRuns.js'

/** `window_wait` 提示词。 */
export const WINDOW_WAIT_PROMPT = `Wait for a set of branch runs to reach a terminal state before continuing the origin's next step. Select targets with run_ids, scope='my_active', or topic_id; mode='all' waits for every run, while 'any' returns on the first terminal run. At timeout_ms it returns the current snapshot with timed_out set; a running run is not complete. Waiting does not consume the callback or modify any run.`

/** 回执摘要。 */
function waitSummary(value: unknown): string {
  const record = value as Record<string, unknown>
  const runs = Array.isArray(record['runs']) ? record['runs'] : []
  const flag = record['aborted'] === true ? '已取消' : record['timed_out'] === true ? '超时' : '已收齐'
  const hint = typeof record['hint'] === 'string' && record['hint'].length > 0 ? `\n${record['hint']}` : ''
  return `⏳ window_wait ${flag}：${runs.length} 条 run${hint}`
}

/** 定义 `window_wait`。 */
export function defineWindowWaitTool(deps: WindowDeps) {
  return defineTool({
    name: 'window_wait',
    description: WINDOW_WAIT_PROMPT,
    parameters: {
      run_ids: { type: 'array', items: { type: 'string' }, description: 'Explicit list of target run ids.' },
      scope: { type: 'string', enum: ['my_active'], description: 'Active runs started by this origin window.' },
      topic_id: { type: 'string', description: 'Wait for runs related to this topic that are visible to this window.' },
      status: {
        type: 'array',
        items: { type: 'string' },
        description: 'Wait only for these run states: pending, running, completed, failed, cancelled, seed_failed, orphaned.',
      },
      mode: { type: 'string', enum: ['all', 'any'], required: true, description: 'all waits for every run; any returns on the first terminal run.' },
      timeout_ms: { type: 'integer', required: true, description: 'Maximum wait in milliseconds; returns the current snapshot when reached.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          timed_out: { type: 'boolean' },
          aborted: { type: 'boolean' },
          hint: { type: 'string', description: 'Suggested action on timeout.' },
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
