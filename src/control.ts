/**
 * `dsh-window/control` —— 管控组（插件页独立一行，可单独开关）。
 *
 * 运行中接管与善后：再派活、听墙角、打断、等终态、重试回调。
 * 本行不 provide Host Service、不跑生命周期对账（那是对话组 `dsh-window` 的职责）。
 *
 * @module dsh-window/control
 */
import type { Context } from '@deepseek-ai/cordis'
import {
  defineWindowDispatchTool,
  defineWindowRetryCallbackTool,
} from './tools/windowRunTools.js'
import { defineWindowInspectTool } from './tools/windowDiscoverTools.js'
import { defineWindowInterruptTool } from './tools/windowControlTools.js'
import { defineWindowWaitTool } from './tools/windowWaitTool.js'
import { createWindowRuntime, registerToolRow } from './runtime.js'
import { resolveConfig, type WindowConfig } from './config.js'

/** 插件名（装载层条目 id 同源）。 */
export const name = 'dsh-window/control'

/** 工具注册表；其余服务按调用时惰性解析。 */
export const inject = ['tools']

/** 与对话组同一套配置（`dataRoot` 必须同值）。 */
export type Config = WindowConfig

/** 装载管控组。 */
export function apply(ctx: Context, config: Config = {}): void {
  const resolved = resolveConfig(config)
  const runtime = createWindowRuntime(ctx, resolved, name)
  registerToolRow(ctx, runtime.logger, () => [
    defineWindowDispatchTool(runtime.deps),
    defineWindowInspectTool(runtime.deps),
    defineWindowInterruptTool(runtime.deps),
    defineWindowWaitTool(runtime.deps),
    defineWindowRetryCallbackTool(runtime.deps),
  ], resolved, '管控组')
}
