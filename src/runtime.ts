/**
 * 插件运行时装配：三行（对话 / 管控 / 协作）共用的适配器与 `WindowDeps` 构造。
 *
 * 一行一个插件入口，各自 `apply` 一次；装配代码集中在这里，避免三份实现漂移。
 * 只有对话组（`src/index.ts`）provide `window` Host Service 并接管生命周期对账，
 * 管控组 / 协作组只注册各自的工具。
 *
 * @module dsh-window/runtime
 */
import { randomUUID } from 'node:crypto'
import type { WindowDeps } from './application/ports.js'
import { AgentMessenger } from './adapters/agentMessenger.js'
import { AgentControl } from './adapters/agentControl.js'
import { FsRunStore } from './adapters/runStore.js'
import { FsTopicStore } from './adapters/topicStore.js'
import { JsonSchemaGuard } from './adapters/jsonSchemaGuard.js'
import { SessionWindowInspector } from './adapters/sessionWindowInspector.js'
import { SessionWindowOpener } from './adapters/sessionWindowOpener.js'
import type { ResolvedWindowConfig } from './config.js'
import { WindowError } from './shared/errors.js'
import { createWindowHostService, WINDOW_SERVICE } from './hostService.js'

/** 插件日志的最小面。 */
export interface LoggerLike {
  info?: (message: string) => void
  warn?: (message: string) => void
  debug?: (message: string) => void
}

/** 工具注册表的最小面。 */
export interface ToolRuntimeLike {
  register?: (tool: unknown) => unknown
}

/** Cordis 插件上下文的最小面（三行共用）。 */
export interface PluginContextLike {
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

/** 一行插件的装配结果。 */
export interface WindowRuntime {
  readonly deps: WindowDeps
  readonly logger: LoggerLike | undefined
}

/** 从执行上下文取窗口码（= root agent id = session id）。 */
export function windowKeyOf(exec: unknown): string {
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

/**
 * 装配一行插件所需的适配器与端口。
 *
 * 三行各自调用一次：数据根缺省相同（`$DSH_HOME/storages/dsh-window`），因此三行
 * **必须配置同一个 `dataRoot`**——不一致时各写各的，run 与 topic 会互相看不见。
 */
export function createWindowRuntime(
  ctx: unknown,
  resolved: ResolvedWindowConfig,
  logName: string,
): WindowRuntime {
  const anyCtx = ctx as PluginContextLike
  const logger = anyCtx.logger?.(logName)

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

  return { deps, logger }
}

/** 只有对话组调用：把 `window` Host Service 提供给其他插件（失败只告警，不阻断工具面）。 */
export function provideWindowService(ctx: unknown, deps: WindowDeps, logger: LoggerLike | undefined): void {
  const anyCtx = ctx as PluginContextLike
  if (typeof anyCtx.provide !== 'function') {
    logger?.warn?.(`ctx.provide 不可用：未提供 ${WINDOW_SERVICE} Host Service（其他插件将按“未装配”降级）`)
    return
  }
  try {
    anyCtx.provide(WINDOW_SERVICE, createWindowHostService(deps))
    logger?.info?.(`已 provide ${WINDOW_SERVICE} Host Service（open / stopForOrigin）`)
  } catch (error: unknown) {
    logger?.warn?.(`provide ${WINDOW_SERVICE} 失败：${error instanceof Error ? error.message : String(error)}`
      + '（其他插件将按“未装配”结构化降级）')
  }
}

/**
 * 注册一行的工具（惰性等待 `tools` 服务就绪）。
 *
 * 工具注册是这行插件存在的理由：服务缺席时告警并放弃注册，不伪装成功。
 */
export function registerToolRow(
  ctx: unknown,
  logger: LoggerLike | undefined,
  factory: () => unknown[],
  resolved: ResolvedWindowConfig,
  rowLabel: string,
): void {
  const anyCtx = ctx as PluginContextLike
  anyCtx.inject?.(['tools'], (serviceCtx) => {
    const rawTools = serviceCtx['tools']
    if (rawTools === null || typeof rawTools !== 'object') {
      logger?.warn?.(`tools 服务不可用：${rowLabel} 未注册`)
      return
    }
    const tools = rawTools as ToolRuntimeLike
    if (typeof tools.register !== 'function') {
      logger?.warn?.(`tools.register 不可用：${rowLabel} 未注册`)
      return
    }
    const registered = factory()
    for (const tool of registered) tools.register(tool)
    const names = registered.map((tool) => (tool as { name?: unknown }).name).filter((name) => typeof name === 'string')
    logger?.info?.(`${rowLabel}已注册 ${registered.length} 个工具：${names.join(' / ')}`
      + `（数据根：${resolved.dataRoot ?? '默认 $DSH_HOME/storages/dsh-window'}）`)
  })
}
