/**
 * 会话开窗适配器：`WindowOpenerPort` 的唯一宿主 I/O 实现。
 *
 * 服务按调用时惰性解析——装配期拿不到不等于永远拿不到；服务缺失返回
 * `opener_unavailable`，由用例层翻成 `WINDOW_OPEN_UNAVAILABLE`，绝不伪造窗口码。
 *
 * @module dsh-window/adapters/sessionWindowOpener
 */
import type {
  OpenWindowOutcome,
  WindowCreateOptions,
  WindowModelSelection,
  WindowOpenerPort,
  WindowSourceProfile,
} from '../application/ports.js'
import { windowProfileFromProjectionValues } from '../application/windowInherit.js'

interface SessionControllerLike {
  fork?: (request: { sessionId: string; atSeq?: number }) => Promise<{ sessionId?: unknown }>
  create?: (request?: { cwd?: string; workspaceId?: string; agentPreset?: string }) => Promise<{ sessionId?: unknown }>
  projections?: (request: { sessionId: string }) => Promise<{ values?: unknown } | null>
  rename?: (request: { sessionId: string; title: string }) => Promise<unknown>
  selectModel?: (request: {
    sessionId: string
    provider: string
    model: string
    reasoningEffort?: string
  }) => Promise<unknown>
}

interface WorkspaceRegistryLike {
  list?: () => unknown
}

interface ProjectRow {
  id: string
  sessionIds: readonly string[]
}

/** 原始错误可读化。 */
function reasonOf(error: unknown): string {
  if (error instanceof Error) return error.message
  if (typeof error === 'object' && error !== null) {
    const message = (error as { message?: unknown }).message
    if (typeof message === 'string' && message.length > 0) return message
  }
  return String(error)
}

/** 注册表行归一：id 支持 string / number；sessionIds 只收字符串。 */
function toProjectRows(rows: readonly unknown[]): ProjectRow[] {
  const out: ProjectRow[] = []
  for (const row of rows) {
    if (row === null || typeof row !== 'object') continue
    const value = row as { id?: unknown; sessionIds?: unknown }
    const id = typeof value.id === 'string' && value.id.length > 0
      ? value.id
      : (typeof value.id === 'number' && Number.isFinite(value.id) ? String(value.id) : undefined)
    if (id === undefined) continue
    const sessionIds = Array.isArray(value.sessionIds)
      ? value.sessionIds.filter((item): item is string => typeof item === 'string' && item.length > 0)
      : []
    out.push({ id, sessionIds })
  }
  return out
}

/** 组织宿主建会话请求：workspaceId 优先，cwd 兜底，二者互斥；agentPreset 正交。 */
function createRequestOf(opts?: WindowCreateOptions): { cwd?: string; workspaceId?: string; agentPreset?: string } {
  const preset = typeof opts?.agentPreset === 'string' && opts.agentPreset.trim().length > 0
    ? opts.agentPreset.trim()
    : undefined
  const withPreset = (base: { cwd?: string; workspaceId?: string }): { cwd?: string; workspaceId?: string; agentPreset?: string } =>
    preset === undefined ? base : { ...base, agentPreset: preset }
  const workspaceId = opts?.workspaceId
  if (typeof workspaceId === 'string' && workspaceId.length > 0) return withPreset({ workspaceId })
  const cwd = opts?.cwd
  if (typeof cwd === 'string' && cwd.length > 0) return withPreset({ cwd })
  return withPreset({})
}

/** 会话开窗适配器。 */
export class SessionWindowOpener implements WindowOpenerPort {
  constructor(
    private readonly resolveService: () => unknown,
    private readonly resolveWorkspaceRegistry?: () => unknown,
  ) {}

  private service(): SessionControllerLike | undefined {
    let raw: unknown
    try {
      raw = this.resolveService()
    } catch {
      return undefined
    }
    if (raw === null || typeof raw !== 'object') return undefined
    return raw as SessionControllerLike
  }

  private registry(): WorkspaceRegistryLike | undefined {
    let raw: unknown
    try {
      raw = this.resolveWorkspaceRegistry?.()
    } catch {
      return undefined
    }
    if (raw === null || typeof raw !== 'object') return undefined
    return raw as WorkspaceRegistryLike
  }

  available(): boolean {
    const service = this.service()
    return service !== undefined
      && (typeof service.fork === 'function' || typeof service.create === 'function')
  }

  async fork(sourceSessionId: string, atSeq?: number): Promise<OpenWindowOutcome> {
    const service = this.service()
    if (service === undefined || typeof service.fork !== 'function') {
      return { ok: false, code: 'opener_unavailable', reason: 'sessionController.fork 不可用（服务未装配或本宿主无此能力）' }
    }
    try {
      const result = await service.fork({ sessionId: sourceSessionId, ...(atSeq === undefined ? {} : { atSeq }) })
      return this.outcomeOf(result?.sessionId, sourceSessionId)
    } catch (error: unknown) {
      const text = reasonOf(error)
      if (/no completed turn/i.test(text) || (typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'session/fork-unavailable')) {
        return { ok: false, code: 'unavailable_no_completed_turn', reason: text }
      }
      return { ok: false, code: 'open_failed', reason: text }
    }
  }

  async create(opts?: WindowCreateOptions): Promise<OpenWindowOutcome> {
    const service = this.service()
    if (service === undefined || typeof service.create !== 'function') {
      return { ok: false, code: 'opener_unavailable', reason: 'sessionController.create 不可用（服务未装配或本宿主无此能力）' }
    }
    try {
      const result = await service.create(createRequestOf(opts))
      return this.outcomeOf(result?.sessionId, undefined)
    } catch (error: unknown) {
      return { ok: false, code: 'open_failed', reason: reasonOf(error) }
    }
  }

  async readProfile(sessionId: string): Promise<WindowSourceProfile> {
    const service = this.service()
    if (service === undefined || typeof service.projections !== 'function') {
      throw new Error('sessionController.projections 不可用（服务未装配或本宿主无此能力）')
    }
    const result = await service.projections({ sessionId })
    if (result === null || typeof result !== 'object') {
      throw new Error(`会话 ${sessionId} 的投影不可读（宿主未返回读数）`)
    }
    return windowProfileFromProjectionValues(result.values)
  }

  async rename(sessionId: string, title: string): Promise<void> {
    const service = this.service()
    if (service === undefined || typeof service.rename !== 'function') {
      throw new Error('sessionController.rename 不可用（服务未装配或本宿主无此能力）')
    }
    await service.rename({ sessionId, title })
  }

  async selectModel(sessionId: string, selection: WindowModelSelection): Promise<void> {
    const service = this.service()
    if (service === undefined || typeof service.selectModel !== 'function') {
      throw new Error('sessionController.selectModel 不可用（服务未装配或本宿主无此能力）')
    }
    await service.selectModel({
      sessionId,
      provider: selection.provider,
      model: selection.model,
      ...(selection.reasoningEffort === undefined ? {} : { reasoningEffort: selection.reasoningEffort }),
    })
  }

  /** 源会话所属项目：命中唯一 workspace 时返回 { workspaceId }；歧义或未命中返回 undefined。 */
  resolveSourceProject(sourceSessionId: string): WindowCreateOptions | undefined {
    const registry = this.registry()
    if (registry === undefined || typeof registry.list !== 'function') return undefined
    let rows: unknown
    try {
      rows = registry.list()
    } catch {
      return undefined
    }
    if (!Array.isArray(rows)) return undefined
    let found: string | undefined
    for (const row of toProjectRows(rows)) {
      if (!row.sessionIds.includes(sourceSessionId)) continue
      if (found === undefined) {
        found = row.id
        continue
      }
      if (found !== row.id) return undefined
    }
    return found === undefined ? undefined : { workspaceId: found }
  }

  /** 子会话 id 必须是非空字符串且不等于源，否则开窗结果不可信。 */
  private outcomeOf(rawId: unknown, sourceSessionId: string | undefined): OpenWindowOutcome {
    if (typeof rawId !== 'string' || rawId.length === 0) {
      return { ok: false, code: 'open_failed', reason: '宿主未返回会话 id（开窗结果不可信）' }
    }
    if (sourceSessionId !== undefined && rawId === sourceSessionId) {
      return { ok: false, code: 'open_failed', reason: `宿主返回的会话 id 与源相同（${rawId}），不是新窗口` }
    }
    return {
      ok: true,
      windowKey: rawId,
      ...(sourceSessionId === undefined ? {} : { parentSessionId: sourceSessionId }),
    }
  }
}
