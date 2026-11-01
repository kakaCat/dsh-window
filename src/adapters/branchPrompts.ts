/**
 * 宿主 system prompt section 注入：给 branch 子窗口挂一条常驻契约。
 *
 * 只做一件事：在 agent 创建时，若用例层判定该会话需要契约文本，就调用宿主
 * `agent.ctx.systemPrompt.section(...)` 挂一段 section，并在 agent 销毁时释放。
 *
 * 安全边界：
 * - 宿主没有该能力（旧版本 / 精简 profile）时安静降级，绝不抛；
 * - section 注册失败只当作没挂，不影响 agent 创建；
 * - 不修改会话内容、不投递消息、不参与完成判定。
 *
 * @module dsh-window/adapters/branchPrompts
 */
import type { BranchPromptPort } from '../application/ports.js'

interface SectionOptions {
  name: string
  order?: number
  interpolate?: boolean
  text: string
}

interface AgentLike {
  id?: unknown
  ctx?: { systemPrompt?: { section?: (options: SectionOptions) => unknown } }
}

interface AgentsLike {
  get?: (id: string) => unknown
}

interface ContextLike {
  on?: (event: string, handler: (...args: unknown[]) => void) => unknown
}

/** section 名固定：一个会话只挂一条分支契约。 */
const SECTION_NAME = 'dsh-window-branch'
/** 靠后渲染，避免被后来的通用段覆盖。 */
const SECTION_ORDER = 900

/** 把宿主事件折算成 agent；不认识就当没有。 */
function agentOf(payload: unknown): AgentLike | undefined {
  if (payload === null || typeof payload !== 'object') return undefined
  const agent = (payload as { agent?: unknown }).agent
  return agent !== null && typeof agent === 'object' ? agent as AgentLike : undefined
}

/** 基于宿主 `systemPrompt` 的常驻契约注入。 */
export class BranchPrompts implements BranchPromptPort {
  private decorate?: (sessionId: string) => Promise<string | undefined>
  private readonly disposers = new Map<string, () => void>()
  private readonly subscriptions: (() => void)[] = []
  private installed = false

  constructor(
    private readonly resolveContext: () => unknown,
    private readonly resolveAgents: () => unknown,
  ) {}

  watch(decorate: (sessionId: string) => Promise<string | undefined>): () => void {
    this.decorate = decorate
    this.install()
    return () => {
      this.decorate = undefined
      for (const id of [...this.disposers.keys()]) this.release(id)
    }
  }

  /** 热路径：run 建好后立刻挂，不等 `agent/created`。 */
  attach(sessionId: string, text: string): boolean {
    if (text.length === 0) return false
    if (this.disposers.has(sessionId)) return true
    const agent = this.agents()?.get?.(sessionId)
    if (agent === null || typeof agent !== 'object') return false
    return this.register(sessionId, agent as AgentLike, text)
  }

  dispose(): void {
    for (const id of [...this.disposers.keys()]) this.release(id)
    for (const unsubscribe of this.subscriptions.splice(0).reverse()) {
      try {
        unsubscribe()
      } catch {
        // 释放订阅失败不影响卸载。
      }
    }
  }

  /** 订阅一次；没有 `on` 能力时安静降级。 */
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
        if (typeof disposer === 'function') this.subscriptions.push(disposer as () => void)
      } catch {
        // 订阅失败：退化为「只有 seed」。
      }
    }
    subscribe('agent/created', (payload) => {
      const agent = agentOf(payload)
      if (agent !== undefined) void this.attachFromEvent(agent)
    })
    subscribe('agent/disposed', (payload) => {
      const agent = agentOf(payload)
      const id = agent?.id
      if (typeof id === 'string') this.release(id)
    })
  }

  /** 异步取文本后再挂：查找期间 agent 可能已被销毁，挂之前再确认一次。 */
  private async attachFromEvent(agent: AgentLike): Promise<void> {
    const id = agent.id
    if (typeof id !== 'string' || id.length === 0) return
    let text: string | undefined
    try {
      text = await this.decorate?.(id)
    } catch {
      return
    }
    if (text === undefined || text.length === 0) return
    if (this.disposers.has(id)) return
    if (this.agents()?.get?.(id) !== agent) return
    this.register(id, agent, text)
  }

  /** 真正调用宿主 `section()`；没有能力或抛错时安静降级。 */
  private register(id: string, agent: AgentLike, text: string): boolean {
    const prompt = agent.ctx?.systemPrompt
    if (typeof prompt?.section !== 'function') return false
    try {
      const disposer = prompt.section({ name: SECTION_NAME, order: SECTION_ORDER, interpolate: false, text })
      if (typeof disposer !== 'function') return false
      this.disposers.set(id, disposer as () => void)
      return true
    } catch {
      // 注册失败：只当作没挂，agent 照常创建。
      return false
    }
  }

  private release(id: string): void {
    const dispose = this.disposers.get(id)
    if (dispose === undefined) return
    this.disposers.delete(id)
    try {
      dispose()
    } catch {
      // 释放失败不影响会话。
    }
  }

  private agents(): AgentsLike | undefined {
    let raw: unknown
    try {
      raw = this.resolveAgents()
    } catch {
      return undefined
    }
    return raw !== null && typeof raw === 'object' ? raw as AgentsLike : undefined
  }
}
