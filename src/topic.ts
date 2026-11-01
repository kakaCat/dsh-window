/**
 * `dsh-window/topic` —— 协作组（插件页独立一行，可单独开关）。
 *
 * Topic Ledger：主题台账、协作占用（claim）与跨窗口消息。默认关闭：
 * 这 6 个工具只在多窗口协作时用得到，开着会长期占据模型可见的工具列表。
 * 本行不 provide Host Service、不跑生命周期对账。
 *
 * @module dsh-window/topic
 */
import type { Context } from '@deepseek-ai/cordis'
import {
  defineWindowTopicAppendTool,
  defineWindowTopicClaimTool,
  defineWindowTopicCreateTool,
  defineWindowTopicGetTool,
  defineWindowTopicJoinTool,
  defineWindowTopicSendTool,
} from './tools/windowTopicTools.js'
import { createWindowRuntime, registerToolRow } from './runtime.js'
import { resolveConfig, type WindowConfig } from './config.js'

/** 插件名（装载层条目 id 同源）。 */
export const name = 'dsh-window/topic'

/** 工具注册表；其余服务按调用时惰性解析。 */
export const inject = ['tools']

/** 与对话组同一套配置（`dataRoot` 必须同值）。 */
export type Config = WindowConfig

/** 装载协作组。 */
export function apply(ctx: Context, config: Config = {}): void {
  const resolved = resolveConfig(config)
  const runtime = createWindowRuntime(ctx, resolved, name)
  registerToolRow(ctx, runtime.logger, () => [
    defineWindowTopicCreateTool(runtime.deps),
    defineWindowTopicJoinTool(runtime.deps),
    defineWindowTopicGetTool(runtime.deps),
    defineWindowTopicAppendTool(runtime.deps),
    defineWindowTopicClaimTool(runtime.deps),
    defineWindowTopicSendTool(runtime.deps),
  ], resolved, '协作组')
}
