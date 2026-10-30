/**
 * `window_open` 工具壳：只做参数声明与回执渲染，判定全部在 application 层。
 *
 * @module dsh-window/tools/windowOpenTool
 */
import { defineTool, type ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { OpenWindowDeps } from '../application/ports.js'
import { openWindow } from '../application/openWindow.js'
import { SCENARIOS, WINDOW_MODES } from '../shared/protocol.js'

/** 工具提示词：把两个场景的选择规则说清。 */
export const WINDOW_OPEN_PROMPT = `Open a new window and hand a task to it. Choose the scenario by purpose: continuation when the current window is near its context limit and a new window should take over the current task (no run, no callback to the origin); branch to hand an independent side task to a new window, which reports back with window_complete and delivers the result to the origin. Scenario is the business intent; mode only chooses how the session is created (fork carries context, create starts fresh), so never infer the scenario from mode. The new window appears in the sidebar; this tool does not open a side-by-side window for you. Pass target_workspace to create the child in another workspace, and topic_id to register both windows in a shared topic before the seed is delivered.`

/** 回执一句话摘要。 */
function summaryOf(value: unknown): string {
  const record = value as Record<string, unknown>
  if (record['success'] === false) {
    const delivery = (record['delivery'] ?? {}) as Record<string, unknown>
    const reason = typeof delivery['reason'] === 'string' ? delivery['reason'] : '见明细'
    return `❌ window_open 未完整建立：${reason}`
  }
  const scenario = String(record['scenario'] ?? '?')
  const windowKey = String(record['window_key'] ?? '?')
  const runId = record['run_id'] === undefined ? '无 run_id' : `run_id=${String(record['run_id'])}`
  return `🪟 ${scenario} 新窗口已创建：${windowKey}（${runId}；请在侧栏打开）`
}

/** 定义 `window_open` 工具。 */
export function defineWindowOpenTool(deps: OpenWindowDeps) {
  return defineTool({
    name: 'window_open',
    description: WINDOW_OPEN_PROMPT,
    parameters: {
      scenario: {
        type: 'string',
        enum: [...SCENARIOS],
        required: true,
        description: 'continuation takes over the current task with no callback; branch calls the result back to the origin when done.',
      },
      mode: {
        type: 'string',
        enum: [...WINDOW_MODES],
        description: 'fork carries context; create starts a fresh session. Defaults: continuation→create, branch→fork.',
      },
      at_seq: {
        type: 'integer',
        description: 'fork only: event sequence number to fork at (inclusive); defaults to the latest complete turn.',
      },
      title: {
        type: 'string',
        description: 'New window title. When omitted, it is derived from the task, falling back to an incremented source title.',
      },
      seed_text: {
        type: 'string',
        required: true,
        description: 'Breakpoint brief for continuation, or the standalone task package for branch; must not be empty.',
      },
      target_workspace: {
        type: 'string',
        description: 'Target workspace (workspace id, title, or absolute path). mode=create only; fork inherits the source session cwd and cannot change workspaces.',
      },
      topic_id: {
        type: 'string',
        description: 'Collaboration topic id. When provided, the origin and child join it and bind the same revision before the seed is delivered.',
      },
      topic_scope: {
        type: 'string',
        enum: ['project', 'global'],
        description: 'Topic scope. Defaults to project; global allows combination with target_workspace and shares one topic across workspaces.',
      },
      output_schema: {
        type: 'json',
        description: 'branch only: an object-rooted JSON Schema subset describing the structured result.',
      },
      result_required: {
        type: 'boolean',
        description: 'branch only: true requires output_schema.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          success: { type: 'boolean', description: 'Whether the requested scenario was fully established.' },
          scenario: { type: 'string', description: 'continuation / branch' },
          callback_policy: { type: 'string', description: 'none / required' },
          session_created: { type: 'boolean', description: 'Whether the session was created.' },
          window_key: { type: 'string', description: 'New window key (= new session id); returned even on failure if the session was created.' },
          parent_session_id: { type: 'string', description: 'Source window for fork; omitted for create.' },
          mode: { type: 'string', description: 'The fork or create mode actually used.' },
          target_workspace: {
            type: 'object',
            additionalProperties: false,
            properties: {
              id: { type: 'string', description: 'workspace id' },
              title: { type: 'string', description: 'Workspace display name.' },
              path: { type: 'string', description: 'Absolute workspace path.' },
            },
            description: 'Resolved destination when target_workspace is supplied.',
          },
          run_id: { type: 'string', description: 'branch only: run record id.' },
          topic_tracking: { type: 'boolean', description: 'Whether the windows were registered in the topic ledger; false means no collaboration conflict protection.' },
          topic_id: { type: 'string', description: 'Collaboration topic id.' },
          topic_scope: { type: 'string', description: 'Topic scope used: project or global.' },
          topic_revision: { type: 'integer', description: 'Topic revision registered at open time (used as base_revision when completing).' },
          callback_armed: { type: 'boolean', description: 'Always false for continuation; true for branch after the seed is delivered (the origin will then receive the callback).' },
          delivery: {
            type: 'object',
            additionalProperties: false,
            properties: {
              delivered: { type: 'boolean' },
              kind: { type: 'string' },
              reason: { type: 'string' },
              run_error: { type: 'string' },
              topic_note: { type: 'string' },
            },
          },
          inheritance: {
            type: 'object',
            additionalProperties: false,
            properties: {
              title: { type: 'string' },
              preset: { type: 'string' },
              model: { type: 'string' },
              reasons: { type: 'array', items: { type: 'string' } },
            },
          },
          degraded_note: { type: 'string', description: 'Honest degradation note.' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: summaryOf(value) }],
    },
    async execute(args, exec: ToolRunContext) {
      return await openWindow(
        deps,
        {
          scenario: args.scenario,
          ...(args.mode === undefined ? {} : { mode: args.mode }),
          ...(args.at_seq === undefined ? {} : { atSeq: args.at_seq }),
          ...(args.title === undefined ? {} : { title: args.title }),
          seedText: args.seed_text,
          ...(args.target_workspace === undefined ? {} : { targetWorkspace: args.target_workspace }),
          ...(args.topic_id === undefined ? {} : { topicId: args.topic_id }),
          ...(args.topic_scope === undefined ? {} : { topicScope: args.topic_scope }),
          ...(args.output_schema === undefined ? {} : { outputSchema: args.output_schema }),
          ...(args.result_required === undefined ? {} : { resultRequired: args.result_required }),
        },
        exec,
      )
    },
  })
}
