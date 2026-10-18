import { describe, expect, it, vi } from 'vitest'
import { AgentMessenger } from '../src/adapters/agentMessenger.js'
import { PLUGIN_NAME, RESULT_KIND, SEED_KIND } from '../src/shared/protocol.js'

describe('AgentMessenger 跨窗口投递', () => {
  it('热窗口：直接 followup，不碰 resolveAgent，也从不 steer', async () => {
    const followup = vi.fn()
    const steer = vi.fn()
    const resolveAgent = vi.fn(async () => ({ agent: { followup } }))
    const messenger = new AgentMessenger(
      () => ({ get: () => ({ followup, steer, status: 'running' }) }),
      () => ({ resolveAgent }),
      () => 'm-1',
    )

    const { message } = messenger.createMessage({ text: '结果 A', kind: RESULT_KIND, scenario: 'branch', runId: 'run-1' })
    const out = await messenger.deliver('session-origin', message)

    expect(out).toEqual({ delivered: true })
    expect(followup).toHaveBeenCalledOnce()
    expect(followup).toHaveBeenCalledWith(message)
    expect(steer).not.toHaveBeenCalled()
    expect(resolveAgent).not.toHaveBeenCalled()
  })

  it('冷窗口：agents.get 无结果 → resolveAgent 恢复后 followup 投递，且从不 steer', async () => {
    const followup = vi.fn()
    const steer = vi.fn()
    const resolveAgent = vi.fn(async () => ({ agent: { followup, steer } }))
    const messenger = new AgentMessenger(
      () => ({ get: () => undefined }),
      () => ({ resolveAgent }),
      () => 'm-1',
    )

    const { message } = messenger.createMessage({ text: '结果 A', kind: RESULT_KIND, scenario: 'branch' })
    const out = await messenger.deliver('session-origin', message)

    expect(out).toEqual({ delivered: true })
    expect(resolveAgent).toHaveBeenCalledWith('session-origin')
    expect(followup).toHaveBeenCalledOnce()
    expect(steer).not.toHaveBeenCalled()
  })

  it('重复 messageId（宿主 inbox 去重）收敛为已投递，不记为 failed', async () => {
    const messenger = new AgentMessenger(
      () => ({ get: () => ({ followup: () => { throw new Error('message already pending in inbox') } }) }),
      () => ({}),
      () => 'm-1',
    )
    const out = await messenger.deliver('w-1', { id: 'm' })
    expect(out.delivered).toBe(true)
    expect(out.reason).toContain('已在收件箱')
  })

  it("createMessage 拒绝 kind='user'（红线不靠调用点自觉）", () => {
    const messenger = new AgentMessenger(() => ({ get: () => undefined }), () => ({}), () => 'm-1')
    expect(() => messenger.createMessage({ text: 'x', kind: 'user', scenario: 'branch' }))
      .toThrowError(/不能伪装成用户发言|拒绝以 user/)
  })

  it('冷路径失败时保留宿主的结构化 error（不再压成 object）', async () => {
    const messenger = new AgentMessenger(
      () => ({ get: () => undefined }),
      () => ({ resolveAgent: async () => ({ error: 'session not found' }) }),
      () => 'm-1',
    )
    const out = await messenger.deliver('w-1', { id: 'm' })
    expect(out.delivered).toBe(false)
    expect(out.reason).toContain('session not found')
  })

  it('冷路径也失败时，热路径失败原因仍并列保留（不互相覆盖）', async () => {
    const messenger = new AgentMessenger(
      () => ({ get: () => { throw new Error('registry down') } }),
      () => ({ resolveAgent: async () => { throw new Error('resume 失败') } }),
      () => 'm-1',
    )
    const out = await messenger.deliver('w-1', { id: 'm' })
    expect(out.delivered).toBe(false)
    expect(out.reason).toContain('冷会话 resume 失败')
    expect(out.reason).toContain('resume 失败')
    expect(out.reason).toContain('热路径原因')
    expect(out.reason).toContain('registry down')
  })

  it('resolveAgent 抛错：不抛，收口为 delivered:false + reason', async () => {
    const messenger = new AgentMessenger(
      () => ({ get: () => undefined }),
      () => ({ resolveAgent: async () => { throw new Error('resume 失败') } }),
      () => 'm-1',
    )

    const { message } = messenger.createMessage({ text: 'x', kind: RESULT_KIND, scenario: 'branch' })
    const out = await messenger.deliver('session-origin', message)

    expect(out.delivered).toBe(false)
    expect(out.reason).toContain('冷会话 resume 失败')
    expect(out.reason).toContain('resume 失败')
  })

  it('缺冷恢复能力 / resume 未返回 agent：如实失败，不谎报已投递', async () => {
    const noResolve = new AgentMessenger(() => ({ get: () => undefined }), () => ({}), () => 'm-1')
    const first = await noResolve.deliver('w-1', { id: 'm' })
    expect(first.delivered).toBe(false)
    expect(first.reason).toContain('无冷会话 resume 能力')

    const badReturn = new AgentMessenger(
      () => ({ get: () => undefined }),
      () => ({ resolveAgent: async () => undefined }),
      () => 'm-1',
    )
    const second = await badReturn.deliver('w-1', { id: 'm' })
    expect(second.delivered).toBe(false)
    expect(second.reason).toContain('未返回 agent')
  })

  it('agents.get 抛错时如实失败（无冷恢复能力时保留热路径原因）', async () => {
    const messenger = new AgentMessenger(
      () => ({ get: () => { throw new Error('registry down') } }),
      () => ({}),
      () => 'm-1',
    )
    const out = await messenger.deliver('w-1', { id: 'm' })
    expect(out.delivered).toBe(false)
    expect(out.reason).toContain('agents.get 抛错')
    expect(out.reason).toContain('registry down')
  })

  it('自署消息：role 可以是 user，但 source.kind 是插件 kind、绝不是裸用户发言', () => {
    const messenger = new AgentMessenger(() => ({}), () => ({}), () => 'fixed-id')
    const seed = messenger.createMessage({ text: '底稿', kind: SEED_KIND, scenario: 'continuation' })
    const result = messenger.createMessage({ text: '结果', kind: RESULT_KIND, scenario: 'branch', runId: 'run-1' })

    expect(seed.messageId).toBe('fixed-id')
    expect(seed.message).toMatchObject({
      role: 'user',
      source: { kind: SEED_KIND, plugin: PLUGIN_NAME, scenario: 'continuation' },
    })
    expect(result.message).toMatchObject({
      source: { kind: RESULT_KIND, plugin: PLUGIN_NAME, scenario: 'branch', runId: 'run-1' },
    })
    // 显式 messageId 时以它为准（回调重试复用同一 id）。
    const reused = messenger.createMessage({ text: 'x', kind: RESULT_KIND, scenario: 'branch', messageId: 'callback-1' })
    expect(reused.messageId).toBe('callback-1')
    expect((reused.message as { id?: string }).id).toBe('callback-1')
  })
})
