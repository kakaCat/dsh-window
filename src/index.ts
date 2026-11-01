/**
 * dsh-window —— Cordis 插件入口（对话组）。
 *
 * 本仓库按能力面装三行（workprocess-bundle 同款：一个 bundle 多行，插件页每行一个开关）：
 * - `dsh-window`（本文件）：开窗 / 发消息 / 完成回调 / 状态 / 列表 + `window` Host Service + 生命周期对账；
 * - `dsh-window/control`：dispatch / inspect / interrupt / wait / retry_callback；
 * - `dsh-window/topic`：Topic Ledger 协作（create / join / get / append / claim / send）。
 *
 * 关掉哪一行，那一行的 `apply` 就不跑，它的工具根本不注册（模型完全看不到）。
 * 三行共用 {@link createWindowRuntime} 装配；`dataRoot` 必须三行同值。
 *
 * @module dsh-window
 */
import type { Context } from '@deepseek-ai/cordis'
import {
  defineWindowCompleteTool,
  defineWindowStatusTool,
} from './tools/windowRunTools.js'
import { defineWindowListTool } from './tools/windowDiscoverTools.js'
import { defineWindowSendTool } from './tools/windowControlTools.js'
import { defineWindowOpenTool } from './tools/windowOpenTool.js'
import { drainLifecycle, reconcileRuns } from './application/lifecycle.js'
import { startWindowObservers } from './application/windowObservers.js'
import { createWindowRuntime, provideWindowService, registerToolRow, type LoggerLike, type PluginContextLike } from './runtime.js'
import { resolveConfig, type WindowConfig } from './config.js'

/** 插件名（装载层条目 id 同源）。 */
export const name = 'dsh-window'

/** 本插件需要工具注册表；其他服务按调用时惰性解析。 */
export const inject = ['tools']

/** 插件配置（见 config.ts）。 */
export type Config = WindowConfig

/** 对话组的工具面：窗口之间能开窗、说话、回报、查状态。 */
const DIALOGUE_TOOLS = '对话组'

/** 装载对话组。 */
export function apply(ctx: Context, config: Config = {}): void {
  const resolved = resolveConfig(config)
  const runtime = createWindowRuntime(ctx, resolved, name)
  const logger: LoggerLike | undefined = runtime.logger

  // 服务化对外入口（REQ §6.5）：外部插件按 ctx.inject('window') 选用。只有本行提供。
  provideWindowService(ctx, runtime.deps, logger)

  registerToolRow(ctx, logger, () => [
    defineWindowOpenTool(runtime.deps),
    defineWindowSendTool(runtime.deps),
    defineWindowCompleteTool(runtime.deps),
    defineWindowStatusTool(runtime.deps),
    defineWindowListTool(runtime.deps),
  ], resolved, DIALOGUE_TOOLS)

  // 观测接线：心跳（lastTurnAt）与读回执（readAt）+ 回调自动重试调度。
  // 只观测、不完成：普通回合结束永远不会触发 window_complete（见反向探针）。
  // 只有本行接管观测、对账与 drain：管控组 / 协作组重复跑会重复写心跳与重复投递。
  const observers = startWindowObservers(runtime.deps, logger ?? undefined)

  // 生命周期接线：宿主事件可用则订阅，不可用则只在启动时对账一次，并如实记录。
  const anyCtx = ctx as unknown as PluginContextLike
  const runReconcile = (): void => {
    void reconcileRuns(runtime.deps).then((summary) => {
      const receipts = summary.receipts
      if (summary.orphaned.length > 0 || summary.redelivered.length > 0 || summary.cleaned > 0
        || receipts?.read.length || receipts?.redelivered.length) {
        logger?.info?.(`生命周期对账：orphaned=${summary.orphaned.length} redelivered=${summary.redelivered.length}`
          + ` cleaned=${summary.cleaned} failures=${summary.failures.length}`
          + ` read=${receipts?.read.length ?? 0} requeued=${receipts?.redelivered.length ?? 0}`)
      }
    }).catch((error: unknown) => {
      logger?.warn?.(`生命周期对账失败：${error instanceof Error ? error.message : String(error)}`)
    })
  }
  // Cordis 没有 'ready'/'dispose' 公共事件（Events 只有 internal/*）；清理必须用 ctx.effect，
  // 启动对账则直接在本插件装载后排队执行。
  queueMicrotask(runReconcile)
  if (typeof anyCtx.effect === 'function') {
    anyCtx.effect(
      () => async () => {
        try {
          observers.stop()
          await drainLifecycle(runtime.deps)
        } catch {
          // 卸载路径不抛：drain 内部已按 run 粒度容错。
        }
      },
      'dsh-window: drain',
    )
  } else {
    logger?.warn?.('ctx.effect 不可用：卸载时不会执行 drain（active run 不会被标记 drained）')
  }
}

export { openWindow } from './application/openWindow.js'
export { completeRun, getRunStatus, retryCallback } from './application/completeRun.js'
export { dispatchTask } from './application/dispatchTask.js'
export { listRuns } from './application/listRuns.js'
export { inspectWindow } from './application/inspectWindow.js'
export { sendGuidance } from './application/sendGuidance.js'
export { interruptRun } from './application/interruptRun.js'
export { waitRuns, isTerminalRun } from './application/waitRuns.js'
export { reconcileRuns, stopActiveRunsForOrigin, drainLifecycle } from './application/lifecycle.js'
export { listRowOf } from './application/listRuns.js'
export { runIndexRowOf } from './application/runIndex.js'
export {
  topicAppend,
  topicClaim,
  topicCreate,
  topicGet,
  topicJoin,
  topicSend,
  resolveTopicProject,
  resolveTopicProjectByScope,
  normalizeTopicScope,
  relevantUnresolvedConflicts,
} from './application/topicLedger.js'
export { WindowError, reject } from './shared/errors.js'
export { FsRunStore, resolveDataRoot, resolveDshHome } from './adapters/runStore.js'
export { FsTopicStore, normalizeProjectId, topicHashOf, projectHashOf, scopeHashOf } from './adapters/topicStore.js'
export { SessionWindowOpener } from './adapters/sessionWindowOpener.js'
export { SessionWindowInspector } from './adapters/sessionWindowInspector.js'
export { JsonSchemaGuard } from './adapters/jsonSchemaGuard.js'
export { AgentMessenger } from './adapters/agentMessenger.js'
export { AgentControl } from './adapters/agentControl.js'
export { createWindowHostService, WINDOW_SERVICE, type WindowHostService } from './hostService.js'
export { DEFAULT_WINDOW_CONFIG, resolveConfig, type WindowConfig, type ResolvedWindowConfig } from './config.js'
export { createWindowRuntime, registerToolRow, provideWindowService, windowKeyOf, type WindowRuntime } from './runtime.js'
export { RUN_TERMINAL_STATUSES, SCENARIOS, WINDOW_MODES, RESULT_KIND, SEED_KIND, GUIDANCE_KIND } from './shared/protocol.js'
