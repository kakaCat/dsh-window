/**
 * 会话只读探测适配器：`WindowInspectPort` 的宿主 I/O 实现。
 *
 * 元数据走 `sessionController.inspect`（不激活 Agent）+ `projections`（标题/模型）；
 * 历史走 `sessionController.page`（冷安全、分页）。只读，不写任何会话状态。
 *
 * @module dsh-window/adapters/sessionWindowInspector
 */
import type {
  WindowHistoryItem,
  WindowInspectMeta,
  WindowInspectPort,
  WindowSourceProfile,
} from '../application/ports.js'
import { windowProfileFromProjectionValues } from '../application/windowInherit.js'

interface SessionControllerLike {
  inspect?: (sessionId: string, signal?: AbortSignal) => Promise<unknown>
  page?: (request: unknown, signal: AbortSignal) => Promise<unknown>
  projections?: (request: { sessionId: string }, signal?: AbortSignal) => Promise<{ values?: unknown } | null>
}

interface AgentsLike {
  get?: (id: string) => unknown
}

/** 单条历史文本上限，避免把超长工具输出整段搬进上下文。 */
const MAX_TEXT_PER_ITEM = 4_000

function numberOrUndefined(raw: unknown): number | undefined {
  return typeof raw === 'number' && Number.isFinite(raw) ? raw : undefined
}

function stringOrUndefined(raw: unknown): string | undefined {
  return typeof raw === 'string' && raw.trim().length > 0 ? raw.trim() : undefined
}

/** 从一条 session event 提取有界历史项；无文本返回 undefined。 */
function historyItemOf(entry: unknown): WindowHistoryItem | undefined {
  if (entry === null || typeof entry !== 'object') return undefined
  const wrapper = entry as { type?: unknown; event?: unknown }
  if (wrapper.type !== 'event' || wrapper.event === null || typeof wrapper.event !== 'object') return undefined
  const event = wrapper.event as { type?: unknown; seq?: unknown; time?: unknown; data?: unknown }
  const type = typeof event.type === 'string' ? event.type : ''
  const seq = numberOrUndefined(event.seq)
  const time = numberOrUndefined(event.time)
  if (seq === undefined || time === undefined) return undefined
  const data = event.data === null || typeof event.data !== 'object' ? {} : event.data as Record<string, unknown>
  const message = data['message'] !== null && typeof data['message'] === 'object'
    ? data['message'] as Record<string, unknown>
    : data
  const role = stringOrUndefined(message['role'])
  const source = message['source'] !== null && typeof message['source'] === 'object'
    ? message['source'] as Record<string, unknown>
    : {}
  const sourceKind = stringOrUndefined(source['kind'])
  const content = Array.isArray(message['content']) ? message['content'] : []
  const texts: string[] = []
  for (const block of content) {
    if (block === null || typeof block !== 'object') continue
    const kind = (block as { type?: unknown }).type
    if (kind === 'text') {
      const text = (block as { text?: unknown }).text
      if (typeof text === 'string' && text.length > 0) texts.push(text)
      continue
    }
    // §6.12：工具只给名称摘要，不返回工具日志全文。
    if (kind === 'tool-call' || kind === 'tool_use' || kind === 'tool_call') {
      const name = (block as { name?: unknown; toolName?: unknown }).name ?? (block as { toolName?: unknown }).toolName
      texts.push(typeof name === 'string' && name.length > 0 ? `[tool: ${name}]` : '[tool]')
    }
  }
  const text = texts.join('\n').slice(0, MAX_TEXT_PER_ITEM)
  if (text.length === 0 && role === undefined) return undefined
  return {
    seq,
    type,
    time,
    ...(role === undefined ? {} : { role }),
    ...(sourceKind === undefined ? {} : { sourceKind }),
    text,
  }
}

/** 宿主会话只读探测器。 */
export class SessionWindowInspector implements WindowInspectPort {
  constructor(
    private readonly resolveService: () => unknown,
    private readonly resolveAgents?: () => unknown,
  ) {}

  private service(): SessionControllerLike | undefined {
    let raw: unknown
    try {
      raw = this.resolveService()
    } catch {
      return undefined
    }
    return raw === null || typeof raw !== 'object' ? undefined : raw as SessionControllerLike
  }

  private agents(): AgentsLike | undefined {
    let raw: unknown
    try {
      raw = this.resolveAgents?.()
    } catch {
      return undefined
    }
    return raw === null || typeof raw !== 'object' ? undefined : raw as AgentsLike
  }

  async inspect(windowKey: string): Promise<WindowInspectMeta> {
    const service = this.service()
    if (service === undefined || typeof service.inspect !== 'function') {
      throw new Error('sessionController.inspect 不可用（服务未装配或本宿主无此能力）')
    }
    const inspection = await service.inspect(windowKey)
    if (inspection === null || typeof inspection !== 'object') {
      throw new Error(`会话 ${windowKey} 的 inspect 未返回对象`)
    }
    const record = inspection as { meta?: unknown; inheritedEventCount?: unknown; events?: unknown }
    const header = record.meta !== null && typeof record.meta === 'object'
      ? record.meta as Record<string, unknown>
      : {}
    let profile: WindowSourceProfile = {}
    if (typeof service.projections === 'function') {
      try {
        const projections = await service.projections({ sessionId: windowKey })
        if (projections !== null && typeof projections === 'object') {
          profile = windowProfileFromProjectionValues(projections.values)
        }
      } catch {
        // 投影读不到不影响元数据：title/model 缺失即省略，不编造。
      }
    }
    const agent = this.agents()?.get?.(windowKey)
    const running = agent === undefined || agent === null
      ? null
      : typeof (agent as { status?: unknown }).status === 'string'
        ? (agent as { status: string }).status === 'running'
        : true
    const eventCount = numberOrUndefined(record.inheritedEventCount)
    return {
      windowKey,
      ...(profile.title === undefined ? {} : { title: profile.title }),
      ...(stringOrUndefined(header['cwd']) === undefined ? {} : { cwd: String(header['cwd']).trim() }),
      ...(stringOrUndefined(header['parentSession']) === undefined ? {} : { parentSessionId: String(header['parentSession']).trim() }),
      ...(stringOrUndefined(header['origin']) === undefined ? {} : { origin: String(header['origin']).trim() }),
      ...(stringOrUndefined(header['agentPreset']) === undefined && profile.agentPreset === undefined
        ? {}
        : { agentPreset: (stringOrUndefined(header['agentPreset']) ?? profile.agentPreset) as string }),
      ...(profile.modelSelection === undefined ? {} : { modelSelection: profile.modelSelection }),
      running,
      ...(eventCount === undefined ? {} : { eventCount }),
    }
  }

  async history(
    windowKey: string,
    options: { cursor?: string; limit?: number; signal?: AbortSignal },
  ): Promise<{ items: WindowHistoryItem[]; nextCursor?: string }> {
    const service = this.service()
    if (service === undefined || typeof service.inspect !== 'function' || typeof service.page !== 'function') {
      throw new Error('sessionController.inspect/page 不可用（服务未装配或本宿主无此能力）')
    }
    const inspection = await service.inspect(windowKey, options.signal)
    if (inspection === null || typeof inspection !== 'object') {
      throw new Error(`会话 ${windowKey} 的 inspect 未返回对象`)
    }
    const record = inspection as { inheritedEventCount?: unknown; events?: unknown }
    const events = Array.isArray(record.events) ? record.events : []
    let throughSeq: number | undefined
    for (const event of events) {
      const seq = numberOrUndefined((event as { seq?: unknown } | undefined)?.seq)
      if (seq !== undefined && (throughSeq === undefined || seq > throughSeq)) throughSeq = seq
    }
    if (throughSeq === undefined) {
      const count = numberOrUndefined(record.inheritedEventCount)
      throughSeq = count === undefined ? undefined : count - 1
    }
    if (throughSeq === undefined || throughSeq < 0) return { items: [] }

    const beforeSeq = options.cursor === undefined || options.cursor.trim().length === 0
      ? undefined
      : Number(options.cursor)
    if (beforeSeq !== undefined && (!Number.isSafeInteger(beforeSeq) || beforeSeq < 0)) {
      throw new Error(`history cursor 非法：${options.cursor}`)
    }
    const page = await service.page(
      {
        address: { kind: 'session', sessionId: windowKey },
        throughSeq,
        ...(beforeSeq === undefined ? {} : { beforeSeq }),
        maxMessages: options.limit ?? 20,
      },
      options.signal ?? new AbortController().signal,
    )
    if (page === null || typeof page !== 'object') throw new Error('sessionController.page 未返回对象')
    const records = Array.isArray((page as { records?: unknown }).records)
      ? (page as { records: unknown[] }).records
      : []
    const items: WindowHistoryItem[] = []
    for (const entry of records) {
      const item = historyItemOf(entry)
      if (item !== undefined) items.push(item)
    }
    const hasMore = (page as { hasMore?: unknown }).hasMore === true
    const firstSeq = items.length > 0 ? items[0]?.seq : undefined
    return {
      items,
      ...(hasMore && firstSeq !== undefined ? { nextCursor: String(firstSeq) } : {}),
    }
  }
}
