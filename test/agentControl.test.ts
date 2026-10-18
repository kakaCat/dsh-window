import { describe, expect, it, vi } from 'vitest'
import { AgentControl } from '../src/adapters/agentControl.js'

function controlWith(agents: Record<string, unknown>, controller?: unknown): AgentControl {
  return new AgentControl(() => ({ get: (id: string) => agents[id] }), () => controller)
}

describe('AgentControl', () => {
  it('能力探测如实反映 steer/followup/cancel', () => {
    const control = controlWith({
      a: { status: 'running', steer: () => undefined, cancel: () => undefined },
      b: { status: 'idle', followup: () => undefined },
    })
    expect(control.capabilities({ status: 'running', steer: () => undefined, cancel: () => undefined })).toMatchObject({
      online: true,
      steer: true,
      followup: false,
      cancel: true,
    })
    expect(control.capabilities(undefined)).toEqual({ online: false, followup: false, steer: false, cancel: false })
    expect(control.capabilities({ status: 'idle', followup: () => undefined })).toMatchObject({ followup: true, steer: false })
  })

  it('running 且有 steer → steered；空闲有 followup → queued；都没有 → failed', async () => {
    const steer = vi.fn()
    const followup = vi.fn()
    const control = controlWith({
      running: { status: 'running', steer },
      idle: { status: 'idle', followup },
      bare: { status: 'running' },
    })
    expect(await control.steer('running', { text: 'x' })).toMatchObject({ delivered: true, mode: 'steered' })
    expect(steer).toHaveBeenCalledTimes(1)
    expect(await control.steer('idle', { text: 'x' })).toMatchObject({ delivered: true, mode: 'queued' })
    expect(followup).toHaveBeenCalledTimes(1)
    expect(await control.steer('bare', { text: 'x' })).toMatchObject({ delivered: false, mode: 'failed' })
  })

  it('冷会话经 resolveAgent 恢复后可投递', async () => {
    const followup = vi.fn()
    const control = controlWith({}, {
      resolveAgent: async () => ({ agent: { status: 'idle', followup } }),
    })
    expect(await control.steer('cold', { text: 'x' })).toMatchObject({ delivered: true, mode: 'queued' })
    expect(followup).toHaveBeenCalledTimes(1)
  })

  it('cancelTurn 只认热窗口：不靠冷恢复离线会话来"取消"', async () => {
    const cancel = vi.fn()
    const control = new AgentControl(
      () => ({ get: (id: string) => (id === 'w-hot' ? { id, status: 'running', cancel } : undefined) }),
      () => ({ resolveAgent: async () => ({ agent: { cancel: () => { throw new Error('不应冷恢复') } } }) }),
    )
    expect((await control.cancelTurn('w-cold', 'x')).accepted).toBe(false)
    expect((await control.cancelTurn('w-cold', 'x')).reason).toContain('未执行')
    expect(cancel).not.toHaveBeenCalled()
  })

  it('cancelTurn：有 cancel 接受，离线/无能力拒绝', async () => {
    const cancel = vi.fn()
    const control = controlWith({ live: { status: 'running', cancel }, bare: { status: 'running' } })
    expect(await control.cancelTurn('live', '方向错了')).toMatchObject({ accepted: true })
    // keepInbox：只停当前轮，保留收件箱与排队引导（对齐 window_interrupt 的回执承诺）
    // 宿主签名是 cancel(cause, options)：keepInbox 在第二个参数；cause 上的同名字段是旧签名兜底
    expect(cancel).toHaveBeenCalledWith(
      { kind: 'hook', reason: '方向错了', keepInbox: true },
      { keepInbox: true },
    )
    expect((await control.cancelTurn('missing', 'x')).accepted).toBe(false)
    expect((await control.cancelTurn('bare', 'x')).accepted).toBe(false)
  })
})
