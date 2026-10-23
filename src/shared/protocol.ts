/**
 * dsh-window 的协议常量与双场景判定。
 *
 * `scenario` 是业务语义（续接 / 分叉），`mode` 是技术手段（fork / create），
 * 两者正交：回调策略只由 scenario 决定，不能由 mode 或别名字段猜测。
 *
 * @module dsh-window/shared/protocol
 */

/** 当前支持的两个业务场景。 */
export const SCENARIOS = ['continuation', 'branch'] as const
/** 续接当前任务或执行分叉任务。 */
export type Scenario = (typeof SCENARIOS)[number]

/** 会话创建方式。 */
export const WINDOW_MODES = ['fork', 'create'] as const
/** fork = 带上下文；create = 全新会话。 */
export type WindowMode = (typeof WINDOW_MODES)[number]

/** 回调策略由场景唯一决定：continuation 无回调，branch 必须有回调策略。 */
export type CallbackPolicy = 'none' | 'required'

/** branch 完成状态。 */
export const RUN_TERMINAL_STATUSES = ['completed', 'failed', 'cancelled'] as const
/** branch 完成状态类型。 */
export type RunTerminalStatus = (typeof RUN_TERMINAL_STATUSES)[number]

/** seed 消息的自署来源；永不为 `user`。 */
export const SEED_KIND = 'dsh-window-seed'

/** 分支结果回调消息的自署来源；永不为 `user`。 */
export const RESULT_KIND = 'dsh-window-result'

/** 运行中引导消息的自署来源；永不为 `user`。 */
export const GUIDANCE_KIND = 'dsh-window-guidance'

/** 主题协作消息的自署来源；永不为 `user`。 */
export const TOPIC_MESSAGE_KIND = 'dsh-window-topic-message'

/** 主题作用域：project = 当前项目内（缺省）；global = 跨工作区共享。 */
export const TOPIC_SCOPES = ['project', 'global'] as const
/** 主题作用域类型。 */
export type TopicScope = (typeof TOPIC_SCOPES)[number]

/** 判断任意输入是否是合法主题作用域。 */
export function isTopicScope(value: unknown): value is TopicScope {
  return typeof value === 'string' && (TOPIC_SCOPES as readonly string[]).includes(value)
}

/** 插件名，写进消息 source.plugin。 */
export const PLUGIN_NAME = 'dsh-window'

/** 新会话只出现在侧栏，插件不能代替人打开并列窗口。 */
export const DEGRADED_NOTE = '会话已创建，请在侧栏打开（本页可切换到它）；本页不能替你开一个并列窗口。'

/** 判断任意输入是否是合法 scenario。 */
export function isScenario(value: unknown): value is Scenario {
  return typeof value === 'string' && (SCENARIOS as readonly string[]).includes(value)
}

/** 判断任意输入是否是合法 mode。 */
export function isWindowMode(value: unknown): value is WindowMode {
  return typeof value === 'string' && (WINDOW_MODES as readonly string[]).includes(value)
}

/** 场景默认 mode：续接避免复制将满上下文，分叉默认共享上下文。 */
export function defaultModeOf(scenario: Scenario): WindowMode {
  return scenario === 'continuation' ? 'create' : 'fork'
}

/** 场景对应的回调策略。 */
export function callbackPolicyOf(scenario: Scenario): CallbackPolicy {
  return scenario === 'branch' ? 'required' : 'none'
}

/** `window_open` 的规范化输入。 */
export interface OpenWindowInput {
  /** 业务场景；必填。 */
  scenario: Scenario
  /** 会话创建方式；缺省按 scenario 取默认值。 */
  mode?: WindowMode
  /** 仅 fork：切点事件序号（含）。 */
  atSeq?: number
  /** 新会话标题；缺省按场景派生任务标题，再回退源标题递增（见需求 FR-20）。 */
  title?: string
  /** seed 正文；两个场景都必填。 */
  seedText: string
  /** 目标工作区（id / 标题 / 绝对路径）；提供时子窗建到该工作区，且仅支持 mode=create。 */
  targetWorkspace?: string
  /** 多窗口协作主题；提供时参与登记与 run 绑定都走 Topic Ledger。 */
  topicId?: string
  /** 主题作用域；缺省 project。global 时允许不同工作区的父子窗口共用一个主题。 */
  topicScope?: TopicScope
  /** 结构化结果契约（object 根 JSON Schema 子集）；仅 branch 有意义。 */
  outputSchema?: unknown
  /** true 时必须同时给 outputSchema；completed 必须带 structured。 */
  resultRequired?: boolean
}
