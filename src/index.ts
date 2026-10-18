/**
 * dsh-window —— Cordis 插件入口。
 *
 * 已交付：continuation / branch 双场景开窗、branch 完成回调、运行时控制
 * （list/inspect/dispatch/send/interrupt/wait）、结构化结果、生命周期对账
 * （stop/orphan/drain/reconcile）、Topic Ledger，共 15 个 `window_*` 工具，
 * 并通过 `ctx.provide('window', ...)` 暴露 Host Service。
 * 装载后排队执行启动对账；卸载排空用 `ctx.effect` 注册（Cordis 没有 ready/dispose 公共事件）。
 *
 * @module dsh-window
 */
import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type { WindowDeps } from './application/ports.js'
import { AgentMessenger } from './adapters/agentMessenger.js'
import { AgentControl } from './adapters/agentControl.js'
import { FsRunStore } from './adapters/runStore.js'
import { FsTopicStore } from './adapters/topicStore.js'
import { JsonSchemaGuard } from './adapters/jsonSchemaGuard.js'
import { SessionWindowInspector } from './adapters/sessionWindowInspector.js'
import { SessionWindowOpener } from './adapters/sessionWindowOpener.js'
import { defineWindowOpenTool } from './tools/windowOpenTool.js'
import {
  defineWindowCompleteTool,
  defineWindowDispatchTool,
  defineWindowRetryCallbackTool,
  defineWindowStatusTool,
} from './tools/windowRunTools.js'
import { defineWindowInspectTool, defineWindowListTool } from './tools/windowDiscoverTools.js'
import { defineWindowInterruptTool, defineWindowSendTool } from './tools/windowControlTools.js'
import {
  defineWindowTopicAppendTool,
  defineWindowTopicClaimTool,
  defineWindowTopicCreateTool,
  defineWindowTopicGetTool,
  defineWindowTopicJoinTool,
} from './tools/windowTopicTools.js'
import { defineWindowWaitTool } from './tools/windowWaitTool.js'
import { drainLifecycle, reconcileRuns } from './application/lifecycle.js'
import { createWindowHostService, WINDOW_SERVICE } from './hostService.js'
import { resolveConfig, type WindowConfig } from './config.js'
import { WindowError } from './shared/errors.js'

/** 插件名。 */
export const name = 'dsh-window'

/** 本插件需要工具注册表；其他服务按调用时惰性解析。 */
export const inject = ['tools']

/** 插件配置（见 config.ts）。 */
export type Config = WindowConfig

interface LoggerLike {
  info?: (message: string) => void
  warn?: (message: string) => void
  debug?: (message: string) => void
}

interface ToolRuntimeLike {
  register?: (tool: unknown) => unknown
}

interface PluginContextLike {
  logger?: (name: string) => LoggerLike
  inject?: (services: string[], callback: (ctx: Record<string, unknown>) => void) => void
  provide?: (name: string, value: unknown) => unknown
  /** Cordis 生命周期清理：execute 返回的 disposer 会在插件卸载时被 await。 */
  effect?: (execute: () => unknown, label?: string) => unknown
}

interface AgentsLike {
  get?: (id: string) => unknown
  currentInitiator?: () => unknown
}

/** 从执行上下文取窗口码（= root agent id = session id）。 */
function windowKeyOf(exec: unknown): string {
  const id = (exec as { agent?: { id?: unknown } } | undefined)?.agent?.id
  if (typeof id !== 'string' || id.length === 0) {
    throw new WindowError('WINDOW_OPEN_UNAVAILABLE', '需要由执行窗口的 agent 调用（缺 exec.agent）')
  }
  return id
}

/** 构造 live-driver 校验；agents 服务不可得时降级为 identity-only（写操作会如实拒绝）。 */
function makeRequireLiveDriver(resolveAgents: () => unknown): (exec: unknown) => void {
  return (exec: unknown): void => {
    const raw = resolveAgents()
    if (raw === null || typeof raw !== 'object') return
    const agents = raw as AgentsLike
    if (typeof agents.get !== 'function' || typeof agents.currentInitiator !== 'function') return
    const agent = (exec as { agent?: unknown } | undefined)?.agent
    if (agent === undefined || agent === null) {
      throw new WindowError('WINDOW_OPEN_UNAVAILABLE', 'window_* 工具需要由执行窗口的 agent 调用（缺 exec.agent）')
    }
    const id = (agent as { id?: unknown }).id
    if (typeof id !== 'string' || id.length === 0) {
      throw new WindowError('WINDOW_OPEN_UNAVAILABLE', 'window_* 工具需要由执行窗口的 agent 调用（agent.id 缺失）')
    }
    const live = agents.get(id) === agent
      && (agent as { status?: unknown }).status === 'running'
      && agents.currentInitiator() === agent
    if (!live) {
      throw new WindowError('WINDOW_OPEN_UNAVAILABLE', 'window_* 工具需要确切的在线调用 agent 且在其 live driver 回合内')
    }
  }
}

/** 装载插件。 */
export function apply(ctx: Context, config: Config = {}): void {
  const resolved = resolveConfig(config)
  const anyCtx = ctx as unknown as PluginContextLike
  const logger = anyCtx.logger?.(name)

  let sessionControllerSvc: unknown
  let agentsSvc: unknown
  let workspaceRegistrySvc: unknown

  anyCtx.inject?.(['sessionController'], (serviceCtx) => {
    sessionControllerSvc = serviceCtx['sessionController']
    logger?.debug?.(sessionControllerSvc === undefined
      ? 'sessionController 服务不可用（window_open 将响亮失败）'
      : 'sessionController 服务已就绪（window_open 可用）')
  })
  anyCtx.inject?.(['agents'], (serviceCtx) => {
    agentsSvc = serviceCtx['agents']
  })
  anyCtx.inject?.(['workspaceRegistry'], (serviceCtx) => {
    workspaceRegistrySvc = serviceCtx['workspaceRegistry']
  })

  const opener = new SessionWindowOpener(() => sessionControllerSvc, () => workspaceRegistrySvc)
  const messenger = new AgentMessenger(() => agentsSvc, () => sessionControllerSvc, () => randomUUID())
  const inspector = new SessionWindowInspector(() => sessionControllerSvc, () => agentsSvc)
  const control = new AgentControl(() => agentsSvc, () => sessionControllerSvc)
  const schemaGuard = new JsonSchemaGuard()
  const runStore = new FsRunStore(resolved.dataRoot === undefined ? {} : { root: resolved.dataRoot })
  const topicStore = new FsTopicStore(resolved.dataRoot === undefined ? {} : { root: resolved.dataRoot })

  const deps: WindowDeps = {
    resolveWindowKey: windowKeyOf,
    requireLiveDriver: makeRequireLiveDriver(() => agentsSvc),
    windowOpener: opener,
    seedDelivery: messenger,
    runStore,
    topicStore,
    windowInspect: inspector,
    agentControl: control,
    schemaGuard,
    waitPollMs: resolved.waitPollMs,
    orphanTimeoutMs: resolved.orphanTimeoutMs,
    claimLeaseBounds: { minMs: resolved.leaseMinMs, maxMs: resolved.leaseMaxMs },
    isWindowAlive: (windowKey: string): boolean => {
      let raw: unknown
      try {
        raw = agentsSvc
      } catch {
        return true
      }
      if (raw === null || typeof raw !== 'object') return true
      const agents = raw as AgentsLike
      if (typeof agents.get !== 'function') return true
      try {
        const agent = agents.get(windowKey)
        return agent !== undefined && agent !== null
      } catch {
        return true
      }
    },
    now: () => Date.now(),
    newRunId: () => randomUUID(),
  }

  // 服务化对外入口（REQ §6.5）：外部插件按 ctx.inject('window') 选用。
  if (typeof anyCtx.provide === 'function') {
    try {
      anyCtx.provide(WINDOW_SERVICE, createWindowHostService(deps))
      logger?.info?.(`已 provide ${WINDOW_SERVICE} Host Service（open / stopForOrigin）`)
    } catch (error: unknown) {
      logger?.warn?.(`provide ${WINDOW_SERVICE} 失败：${error instanceof Error ? error.message : String(error)}`
        + '（其他插件将按“未装配”结构化降级）')
    }
  } else {
    logger?.warn?.(`ctx.provide 不可用：未提供 ${WINDOW_SERVICE} Host Service（其他插件将按“未装配”降级）`)
  }

  anyCtx.inject?.(['tools'], (serviceCtx) => {
    const rawTools = serviceCtx['tools']
    if (rawTools === null || typeof rawTools !== 'object') {
      logger?.warn?.('tools 服务不可用：window_open 未注册')
      return
    }
    const tools = rawTools as ToolRuntimeLike
    if (typeof tools.register !== 'function') {
      logger?.warn?.('tools.register 不可用：window_open 未注册')
      return
    }
    const registered = [
      defineWindowOpenTool(deps),
      defineWindowCompleteTool(deps),
      defineWindowStatusTool(deps),
      defineWindowRetryCallbackTool(deps),
      defineWindowDispatchTool(deps),
      defineWindowListTool(deps),
      defineWindowInspectTool(deps),
      defineWindowSendTool(deps),
      defineWindowInterruptTool(deps),
      defineWindowWaitTool(deps),
      defineWindowTopicCreateTool(deps),
      defineWindowTopicJoinTool(deps),
      defineWindowTopicGetTool(deps),
      defineWindowTopicAppendTool(deps),
      defineWindowTopicClaimTool(deps),
    ]
    for (const tool of registered) tools.register(tool)
    logger?.info?.(`已注册 ${registered.length} 个工具：window_open / window_complete / window_status / window_retry_callback`
      + ` / window_dispatch / window_list / window_inspect / window_send / window_interrupt / window_wait`
      + ` / window_topic_create / window_topic_join / window_topic_get / window_topic_append / window_topic_claim`
      + `（数据根：${resolved.dataRoot ?? '默认 $DSH_HOME/storages/dsh-window'}）`)
  })

  // 生命周期接线：宿主事件可用则订阅，不可用则只在启动时对账一次，并如实记录。
  const runReconcile = (): void => {
    void reconcileRuns(deps).then((summary) => {
      if (summary.orphaned.length > 0 || summary.redelivered.length > 0 || summary.cleaned > 0) {
        logger?.info?.(`生命周期对账：orphaned=${summary.orphaned.length} redelivered=${summary.redelivered.length}`
          + ` cleaned=${summary.cleaned} failures=${summary.failures.length}`)
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
          await drainLifecycle(deps)
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
  resolveTopicProject,
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
export { DEFAULT_WINDOW_CONFIG, resolveConfig, type WindowConfig } from './config.js'
export { RUN_TERMINAL_STATUSES, SCENARIOS, WINDOW_MODES, RESULT_KIND, SEED_KIND, GUIDANCE_KIND } from './shared/protocol.js'
