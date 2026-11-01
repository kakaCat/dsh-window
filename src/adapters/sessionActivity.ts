/**
 * 宿主会话活动观测：订阅 `session/event` / `agent/status`，并提供只读的「回调在哪」核对。
 *
 * 这一层只观测、只读：
 * - 不修改会话、不完成 run、不写 run 记录（写入决策在 application 层）；
 * - 宿主不支持事件订阅时安静降级（`watch` 返回空 disposer，`locate` 返回 `unknown`）；
 * - 事件处理器永不抛：热路径上的异常不能影响宿主。
 *
 * @module dsh-window/adapters/sessionActivity
 */
import type { CallbackLocation, SessionActivityEvent, SessionActivityPort } from '../application/ports.js'

/** 宿主上下文的最小面：只要有 `on` 即可订阅。 */
interface ContextLike {
  on?: (event: string, handler: (...args: unknown[]) => void) => unknown
}

interface AgentsLike {
  get?: (id: string) => unknown
}

interface AgentLike {
  status?: unknown
  inbox?: { nextTurn?: unknown[]; nextStep?: unknown[] }
}

interface ControllerLike {
  inspect?: (sessionId: string, signal?: AbortSignal) => Promise<unknown>
}

/** 一条消息的 `source.callbackId`；不是回调消息则为 undefined。 */
function callbackIdOf(message: unknown): string | undefined {
  if (message === null || typeof message !== 'object') return undefined
  const source = (message as { source?: unknown }).source
  if (source === null || typeof source !== 'object') return undefined
  const callbackId = (source as { callbackId?: unknown }).callbackId
  return typeof callbackId === 'string' && callbackId.length > 0 ? callbackId : undefined
}

/** 过滤 `session/event`：只关心进入历史的用户消息。 */
function eventOf(session: unknown, event: unknown): SessionActivityEvent | undefined {
  if (session === null || typeof session !== 'object' || event === null || typeof event !== 'object') return undefined
  const sessionId = (session as { id?: unknown }).id
  if (typeof sessionId !== 'string' || sessionId.length === 0) return undefined
  const record = event as { type?: unknown; data?: unknown; time?: unknown; at?: unknown }
  if (record.type !== 'user/message') return { sessionId, at: Date.now() }
  const callbackId = callbackIdOf(record.data)
  return { sessionId, at: Date.now(), ...(callbackId === undefined ? {} : { callbackId }) }
}

/** `agent/status` 载荷：只有 `running` 代表一次推进。 */
function statusOf(payload: unknown): SessionActivityEvent | undefined {
  if (payload === null || typeof payload !== 'object') return undefined
  const record = payload as { agent?: unknown; status?: unknown }
  if (record.status !== 'running') return undefined
  const agent = record.agent
  if (agent === null || typeof agent !== 'object') return undefined
  const sessionId = (agent as { id?: unknown }).id
  if (typeof sessionId !== 'string' || sessionId.length === 0) return undefined
  return { sessionId, at: Date.now() }
}

/** 基于宿主事件的会话观测实现。 */
export class SessionActivity implements SessionActivityPort {
  private readonly listeners = new Set<(event: SessionActivityEvent) => void>()
  private readonly disposers: (() => void)[] = []
  private installed = false

  constructor(
    private readonly resolveContext: () => unknown,
    private readonly resolveAgents: () => unknown,
    private readonly resolveController: () => unknown,
  ) {}

  watch(listener: (event: SessionActivityEvent) => void): () => void {
    this.listeners.add(listener)
    this.install()
    return () => {
      this.listeners.delete(listener)
    }
  }

  dispose(): void {
    for (const dispose of this.disposers.splice(0).reverse()) {
      try {
        dispose()
      } catch {
        // 释放订阅失败不影响调用方。
      }
    }
  }

  async locate(windowKey: string, callbackId: string): Promise<CallbackLocation> {
    // 1) 收件箱：还在排队等下一回合，说明投递确实到了、只是尚未被消费。
    const agent = this.agentOf(windowKey)
    if (agent !== undefined) {
      const messages = [...(agent.inbox?.nextTurn ?? []), ...(agent.inbox?.nextStep ?? [])]
      if (messages.some((message) => callbackIdOf(message) === callbackId)) return 'inbox'
    }
    // 2) 历史：宿主能读会话事件，且已包含这条消息 → 已读。
    const controller = this.controller()
    if (controller?.inspect === undefined) return 'unknown'
    try {
      const inspection = await controller.inspect(windowKey)
      if (inspection === null || typeof inspection !== 'object') return 'unknown'
      const events = (inspection as { events?: unknown }).events
      if (!Array.isArray(events)) return 'unknown'
      const found = events.some((event) => {
        if (event === null || typeof event !== 'object') return false
        const record = event as { type?: unknown; data?: unknown }
        return record.type === 'user/message' && callbackIdOf(record.data) === callbackId
      })
      if (found) return 'history'
      // 历史可读且确定没有 → 既不在收件箱也不在历史，可以安全补投。
      return 'absent'
    } catch {
      return 'unknown'
    }
  }

  private agentOf(windowKey: string): AgentLike | undefined {
    let raw: unknown
    try {
      raw = this.resolveAgents()
    } catch {
      return undefined
    }
    if (raw === null || typeof raw !== 'object') return undefined
    const agents = raw as AgentsLike
    if (typeof agents.get !== 'function') return undefined
    try {
      const agent = agents.get(windowKey)
      return agent !== null && typeof agent === 'object' ? agent as AgentLike : undefined
    } catch {
      return undefined
    }
  }

  private controller(): ControllerLike | undefined {
    let raw: unknown
    try {
      raw = this.resolveController()
    } catch {
      return undefined
    }
    return raw !== null && typeof raw === 'object' ? raw as ControllerLike : undefined
  }

  private install(): void {
    if (this.installed) return
    this.installed = true
    let ctx: ContextLike | undefined
    try {
      const raw = this.resolveContext()
      ctx = raw !== null && typeof raw === 'object' ? raw as ContextLike : undefined
    } catch {
      ctx = undefined
    }
    if (typeof ctx?.on !== 'function') return
    const subscribe = (event: string, handler: (...args: unknown[]) => void): void => {
      try {
        const disposer = ctx!.on!(event, handler)
        if (typeof disposer === 'function') this.disposers.push(disposer as () => void)
      } catch {
        // 订阅失败：安静降级，心跳与回执都按「无观测」处理。
      }
    }
    subscribe('session/event', (session, event) => {
      const parsed = eventOf(session, event)
      if (parsed !== undefined) this.emit(parsed)
    })
    subscribe('agent/status', (payload) => {
      const parsed = statusOf(payload)
      if (parsed !== undefined) this.emit(parsed)
    })
  }

  /** 分发给所有监听者；单个监听者抛错不影响其它监听者，也不冒泡。 */
  private emit(event: SessionActivityEvent): void {
    for (const listener of [...this.listeners]) {
      try {
        listener(event)
      } catch {
        // 观测失败不影响宿主事件循环。
      }
    }
  }
}
