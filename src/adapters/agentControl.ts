/**
 * 目标 agent 的引导/中断能力探测与调用。
 *
 * 宿主形态会变：有的 agent 只有 followup，有的支持 steer/cancel。能力探测必须
 * 如实降级，不能把“只能排队”说成“已中途引导”，也不能把“没有 cancel”说成“已中断”。
 *
 * @module dsh-window/adapters/agentControl
 */

interface AgentsLike {
  get?: (id: string) => unknown
}

interface SessionControllerLike {
  resolveAgent?: (sessionId: string) => Promise<unknown>
}

interface AgentLike {
  id?: string
  status?: string
  followup?: (message: unknown) => void
  steer?: (message: unknown) => void
  cancel?: (
    cause: { kind: 'hook'; reason: string; keepInbox?: boolean },
    options?: { keepInbox?: boolean },
  ) => void
}

/** 能力探测结果。 */
export interface AgentControlCapabilities {
  online: boolean
  followup: boolean
  steer: boolean
  cancel: boolean
}

/** 引导投递结果。 */
export interface SteerOutcome {
  delivered: boolean
  mode: 'steered' | 'queued' | 'failed'
  reason?: string
}

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** agent 能力探测与调用。 */
export class AgentControl {
  constructor(
    private readonly resolveAgents: () => unknown,
    private readonly resolveController: () => unknown,
  ) {}

  /** 解析目标 agent：优先热注册表，冷会话走 resolveAgent。 */
  async resolve(windowKey: string): Promise<AgentLike | undefined> {
    let agents: AgentsLike | undefined
    try {
      const raw = this.resolveAgents()
      agents = raw === null || typeof raw !== 'object' ? undefined : raw as AgentsLike
    } catch {
      agents = undefined
    }
    if (typeof agents?.get === 'function') {
      const hot = agents.get(windowKey)
      if (hot !== null && hot !== undefined) return hot as AgentLike
    }
    let controller: SessionControllerLike | undefined
    try {
      const raw = this.resolveController()
      controller = raw === null || typeof raw !== 'object' ? undefined : raw as SessionControllerLike
    } catch {
      controller = undefined
    }
    if (typeof controller?.resolveAgent !== 'function') return undefined
    try {
      const resolved = await controller.resolveAgent(windowKey)
      if (resolved === null || typeof resolved !== 'object' || !('agent' in resolved)) return undefined
      return (resolved as { agent: unknown }).agent as AgentLike
    } catch {
      return undefined
    }
  }

  /** 只查热注册表（不冷恢复）：用于中断这种「不能靠复活会话来实现」的操作。 */
  resolveHot(windowKey: string): AgentLike | undefined {
    try {
      const raw = this.resolveAgents()
      const agents = raw === null || typeof raw !== 'object' ? undefined : (raw as AgentsLike)
      if (typeof agents?.get !== 'function') return undefined
      const hot = agents.get(windowKey)
      return hot === null || hot === undefined ? undefined : (hot as AgentLike)
    } catch {
      return undefined
    }
  }

  /** 探测目标能力；agent 不在线时全 false。 */
  capabilities(agent: AgentLike | undefined): AgentControlCapabilities {
    return {
      online: agent !== undefined && agent !== null,
      followup: typeof agent?.followup === 'function',
      steer: typeof agent?.steer === 'function',
      cancel: typeof agent?.cancel === 'function',
    }
  }

  /** 运行中 steer，空闲 followup；都没有则 failed。永不抛。 */
  async steer(windowKey: string, message: unknown): Promise<SteerOutcome> {
    let agent: AgentLike | undefined
    try {
      agent = await this.resolve(windowKey)
    } catch (error: unknown) {
      return { delivered: false, mode: 'failed', reason: `目标解析失败：${reasonOf(error)}` }
    }
    if (agent === undefined) {
      return { delivered: false, mode: 'failed', reason: `窗口 ${windowKey} 不在线且无法冷恢复` }
    }
    const capabilities = this.capabilities(agent)
    try {
      if (agent.status === 'running' && capabilities.steer) {
        agent.steer?.(message)
        return { delivered: true, mode: 'steered' }
      }
      if (capabilities.followup) {
        agent.followup?.(message)
        return { delivered: true, mode: 'queued' }
      }
      if (capabilities.steer) {
        agent.steer?.(message)
        return { delivered: true, mode: 'steered' }
      }
      return { delivered: false, mode: 'failed', reason: '目标 agent 既无 steer 也无 followup 能力' }
    } catch (error: unknown) {
      return { delivered: false, mode: 'failed', reason: `投递失败：${reasonOf(error)}` }
    }
  }

  /** 取消目标当前轮次；无 cancel 能力或原因为空返回 accepted=false。永不抛。 */
  async cancelTurn(windowKey: string, reason: string): Promise<{ accepted: boolean; reason?: string }> {
    if (reason.trim().length === 0) {
      return { accepted: false, reason: '中断原因不能为空' }
    }
    // 只认热窗口：中断不能靠「冷恢复会话」来实现——复活一个离线窗口再取消，
    // 会把「未执行」谎报成「已请求取消当前轮」。
    const agent = this.resolveHot(windowKey)
    if (agent === undefined) return { accepted: false, reason: `窗口 ${windowKey} 不在线（中断未执行）` }
    if (typeof agent.cancel !== 'function') {
      return { accepted: false, reason: '目标 agent 无 cancel 能力' }
    }
    try {
      // 与 window_interrupt 的回执承诺一致：只停当前轮，**保留收件箱与排队引导**。
      // 宿主签名是 cancel(cause, options)：keepInbox 在第二个参数里（停止按钮这么传，
      // session-stop 才故意不带）；cause 上的同名字段是给只读 cause 的旧签名兜底，
      // 两处都给，避免因宿主版本不同而静默清空收件箱。
      agent.cancel({ kind: 'hook', reason, keepInbox: true }, { keepInbox: true })
      return { accepted: true }
    } catch (error: unknown) {
      return { accepted: false, reason: `中断失败：${reasonOf(error)}` }
    }
  }
}
