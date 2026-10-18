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
export const WINDOW_OPEN_PROMPT = `打开一个新窗口，按业务目的选择 continuation 或 branch。

选择规则：
- continuation：当前窗口上下文将满，新窗口接管并继续当前任务。默认 mode=create，不生成 run_id，不回调原窗口。
- branch：原窗口保留主任务，只把独立分叉任务交给新窗口，完成后需要把结果回调原窗口。默认 mode=fork。
- 两个场景都必填 seed_text；不得用 mode 反推 scenario。

调用后：
- 会话出现在侧栏；本工具不会替你打开并列窗口。
- continuation 成功 = 会话已创建且 seed 已投递。
- branch 成功 = 会话已创建、run 已落盘、seed 已投递且回调已 armed（callback_armed=true）。
- 标题 / 模式 / 模型继承三项分别以 set / skipped / failed 回报，继承失败不影响开窗。
- 标题：显式 title 优先；不传时按任务派生「续接：<seed 摘要>」/「分叉：<seed 摘要>」，seed 没有有效内容才回退源标题递增——同一源派出的多个窗口因此不会同名。

结构化结果（仅 branch）：
- output_schema 是 object 根 JSON Schema 子集；声明后子窗口必须用 window_complete 带 structured 上报。
- result_required=true 时必须同时给 output_schema；非法 schema → WINDOW_OUTPUT_SCHEMA_INVALID（不创建 run）。

多窗口协作（topic_id）：
- 提供 topic_id 时，origin 与 child 会在投递 seed 前登记进同一主题并取得同一 revision 快照，回执 topic_tracking=true、topic_revision=开跑版本。
- 主题不存在 → WINDOW_TOPIC_NOT_FOUND；主题存储不可用 → WINDOW_TOPIC_STORAGE_UNAVAILABLE；两者都在建会话前失败，不会静默降级成未跟踪协作。
- 缺席 topic_id 时保持原行为并返回 topic_tracking=false，不声称具备协作防冲突能力。

失败时：
- scenario 缺失 → WINDOW_SCENARIO_REQUIRED；seed_text 为空 → WINDOW_SEED_REQUIRED。
- 服务不可用 / create 拿不到项目落点 / fork 没有完整回合 → WINDOW_OPEN_UNAVAILABLE。
- 建会话宿主失败 → WINDOW_OPEN_FAILED。`

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
        description: 'continuation = 接管当前任务且不回调；branch = 完成后回调原窗口',
      },
      mode: {
        type: 'string',
        enum: [...WINDOW_MODES],
        description: 'fork = 带上下文；create = 全新会话。缺省：continuation→create，branch→fork',
      },
      at_seq: {
        type: 'integer',
        description: '仅 fork：切点事件序号（含）；缺省 = 最近一个完整回合',
      },
      title: {
        type: 'string',
        description: '新窗口标题；不传则按任务派生「续接：…」/「分叉：…」，再回退源标题递增',
      },
      seed_text: {
        type: 'string',
        required: true,
        description: 'continuation 的断点底稿，或 branch 的独立任务包；不能为空',
      },
      topic_id: {
        type: 'string',
        description: '多窗口协作主题；提供时 origin/child 会在投递 seed 前登记并绑定同一 revision',
      },
      output_schema: {
        type: 'json',
        description: '仅 branch：object 根 JSON Schema 子集，约定 structured 结果形状',
      },
      result_required: {
        type: 'boolean',
        description: '仅 branch：true 时必须同时给 output_schema',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          success: { type: 'boolean', description: '请求的场景是否完整建立' },
          scenario: { type: 'string', description: 'continuation / branch' },
          callback_policy: { type: 'string', description: 'none / required' },
          session_created: { type: 'boolean', description: '会话是否已创建' },
          window_key: { type: 'string', description: '新窗口码（= 新会话 id）；失败时如已创建也会返回' },
          parent_session_id: { type: 'string', description: 'fork 的源窗口；create 时省略' },
          mode: { type: 'string', description: '实际使用的 fork / create' },
          run_id: { type: 'string', description: '仅 branch：运行记录 id' },
          topic_tracking: { type: 'boolean', description: '是否已登记进项目主题台账；false 时不具备协作防冲突能力' },
          topic_id: { type: 'string', description: '协作主题 ID' },
          topic_revision: { type: 'integer', description: '开窗口时登记的主题 revision（用作完成时的 base_revision）' },
          callback_armed: { type: 'boolean', description: 'continuation 恒 false；branch seed 投递成功时为 true（此时完成后会回调原窗口）' },
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
          degraded_note: { type: 'string', description: '诚实降级说明' },
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
          ...(args.topic_id === undefined ? {} : { topicId: args.topic_id }),
          ...(args.output_schema === undefined ? {} : { outputSchema: args.output_schema }),
          ...(args.result_required === undefined ? {} : { resultRequired: args.result_required }),
        },
        exec,
      )
    },
  })
}
