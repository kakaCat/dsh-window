/**
 * 自署消息与跨窗口投递：seed 只走自署 kind，绝不使用会把来源标成 `user` 的 prompt 入口。
 *
 * 热窗口直接 followup；冷会话先 resolveAgent 再 followup。永不抛，失败收口为
 * `{ delivered:false, reason }`。
 *
 * @module dsh-window/adapters/agentMessenger
 */
import { PLUGIN_NAME, type Scenario } from '../shared/protocol.js'

interface AgentsLike {
  get?: (id: string) => unknown
}

interface AgentLike {
  followup?: (message: unknown) => void
}

interface SessionControllerLike {
  resolveAgent?: (sessionId: string) => Promise<unknown>
}

/** 把任意抛出值压成原因文本；结构化 `{message}` 也要解出来（别压成 [object Object]）。 */
function reasonOf(error: unknown): string {
  if (error instanceof Error) return error.message
  if (error !== null && typeof error === 'object') {
    const message = (error as { message?: unknown }).message
    if (typeof message === 'string' && message.length > 0) return message
  }
  return String(error)
}

/**
 * 宿主 inbox 以 message.id 去重：同一 id 重复投递会抛「already pending」。
 * 这不是投递失败——该 id 的逻辑消息已**恰好一次**在收件箱里，必须收敛成已投递，
 * 否则会被记成 failed，等首条被消费后重投出第二条重复回调。
 */
function isDuplicateDelivery(error: unknown): boolean {
  return /already pending|already queued|duplicate/i.test(reasonOf(error))
}

/** 结构化描述不可预期返回值。 */
function describe(value: unknown): string {
  if (value === null) return 'null'
  if (value === undefined) return 'undefined'
  if (typeof value === 'object') {
    // 宿主失败常以 {error: ...} 形式返回：压成 'object' 会丢掉真实原因（对账时需要看到）。
    const error = (value as { error?: unknown }).error
    if (error !== undefined) return `error=${reasonOf(error)}`
    try {
      return JSON.stringify(value).slice(0, 200)
    } catch {
      return 'object'
    }
  }
  return typeof value
}

/** 自署消息工厂 + 跨窗口投递实现。 */
export class AgentMessenger {
  constructor(
    private readonly resolveAgents: () => unknown,
    private readonly resolveController: () => unknown,
    private readonly idFactory: () => string,
  ) {}

  /**
   * 造一条自署来源消息。
   *
   * 红线：`source.kind` **永不为裸用户发言**——调用方若传 `user` 直接拒绝，
   * 不依赖调用点自觉（否则一次误传就会让插件消息被当成用户指令）。
   */
  createMessage(params: {
    text: string
    kind: string
    scenario: Scenario
    runId?: string
    messageId?: string
    /** 回调对账所需的来源读数（FR-7）；只在有值时写入 source。 */
    childSessionId?: string
    callbackId?: string
  }): { message: unknown; messageId: string } {
    if (params.kind === 'user') {
      throw new Error('dsh-window 拒绝以 user 作为 source.kind：自署消息不能伪装成用户发言')
    }
    const messageId = params.messageId ?? this.idFactory()
    return {
      messageId,
      message: {
        id: messageId,
        role: 'user',
        content: [{ type: 'text', text: params.text }],
        source: {
          kind: params.kind,
          plugin: PLUGIN_NAME,
          scenario: params.scenario,
          ...(params.runId === undefined ? {} : { runId: params.runId }),
          ...(params.childSessionId === undefined ? {} : { childSessionId: params.childSessionId }),
          ...(params.callbackId === undefined ? {} : { callbackId: params.callbackId }),
        },
      },
    }
  }

  /** 投给任意窗口；冷会话先 resume。永不抛。 */
  async deliver(windowKey: string, message: unknown): Promise<{ delivered: boolean; reason?: string }> {
    const hot = this.deliverHot(windowKey, message)
    if (hot.delivered) return hot
    // 热路径失败原因不能丢：后续冷路径的失败原因与它并列保留（多个失败原因都要可见）。
    const hotReason = hot.reason
    const withHot = (reason: string): { delivered: false; reason: string } => ({
      delivered: false,
      reason: hotReason === undefined ? reason : `${reason}；热路径原因：${hotReason}`,
    })

    let controller: SessionControllerLike | undefined
    try {
      const raw = this.resolveController()
      controller = raw === null || typeof raw !== 'object' ? undefined : raw as SessionControllerLike
    } catch (error: unknown) {
      return withHot(`会话控制器解析失败：${reasonOf(error)}`)
    }
    if (controller === undefined || typeof controller.resolveAgent !== 'function') {
      return withHot(`窗口 ${windowKey} 不在线，且无冷会话 resume 能力`)
    }

    let resolved: unknown
    try {
      resolved = await controller.resolveAgent(windowKey)
    } catch (error: unknown) {
      return withHot(`冷会话 resume 失败：${reasonOf(error)}`)
    }
    if (resolved === null || typeof resolved !== 'object' || !('agent' in (resolved as object))) {
      return withHot(`冷会话 resume 未返回 agent：${describe(resolved)}`)
    }
    const agent = (resolved as { agent: unknown }).agent
    const followup = agent === null || typeof agent !== 'object' ? undefined : (agent as AgentLike).followup
    if (typeof followup !== 'function') {
      return withHot('resume 出来的 agent 无 followup 投递能力')
    }
    try {
      followup.call(agent, message)
      return { delivered: true }
    } catch (error: unknown) {
      if (isDuplicateDelivery(error)) {
        return { delivered: true, reason: `同一 messageId 已在收件箱（宿主幂等去重）：${reasonOf(error)}` }
      }
      return withHot(`冷会话投递失败：${reasonOf(error)}`)
    }
  }

  /** 热路径：本进程内活着的窗口。 */
  private deliverHot(windowKey: string, message: unknown): { delivered: boolean; reason?: string } {
    let agents: AgentsLike | undefined
    try {
      const raw = this.resolveAgents()
      agents = raw === null || typeof raw !== 'object' ? undefined : raw as AgentsLike
    } catch (error: unknown) {
      return { delivered: false, reason: `agents 服务解析失败：${reasonOf(error)}` }
    }
    if (typeof agents?.get !== 'function') {
      return { delivered: false, reason: 'agents 服务不可得（未装配 ctx.agents）' }
    }
    let agent: unknown
    try {
      agent = agents.get(windowKey)
    } catch (error: unknown) {
      return { delivered: false, reason: `agents.get 抛错：${reasonOf(error)}` }
    }
    if (agent === undefined || agent === null) {
      return { delivered: false, reason: `窗口 ${windowKey} 不在线` }
    }
    const followup = (agent as AgentLike).followup
    if (typeof followup !== 'function') {
      return { delivered: false, reason: 'agent 无 followup 投递能力' }
    }
    try {
      followup.call(agent, message)
      return { delivered: true }
    } catch (error: unknown) {
      if (isDuplicateDelivery(error)) {
        return { delivered: true, reason: `同一 messageId 已在收件箱（宿主幂等去重）：${reasonOf(error)}` }
      }
      return { delivered: false, reason: `投递失败：${reasonOf(error)}` }
    }
  }
}
