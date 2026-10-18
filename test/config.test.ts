import { describe, expect, it } from 'vitest'
import { DEFAULT_WINDOW_CONFIG, resolveConfig } from '../src/config.js'
import { WindowError } from '../src/shared/errors.js'

describe('配置校验', () => {
  it('缺省补默认值', () => {
    expect(resolveConfig()).toEqual(DEFAULT_WINDOW_CONFIG)
    expect(resolveConfig({})).toEqual(DEFAULT_WINDOW_CONFIG)
  })

  it('接受合法配置并 trim dataRoot', () => {
    expect(resolveConfig({ dataRoot: '  /tmp/x  ', orphanTimeoutMs: 60_000, waitPollMs: 200 })).toEqual({
      dataRoot: '/tmp/x',
      orphanTimeoutMs: 60_000,
      waitPollMs: 200,
      leaseMinMs: 1_000,
      leaseMaxMs: 24 * 60 * 60 * 1000,
    })
    expect(resolveConfig({ leaseMinMs: 5_000, leaseMaxMs: 10_000 })).toMatchObject({ leaseMinMs: 5_000, leaseMaxMs: 10_000 })
  })

  it('租约上下限倒挂也响亮失败', () => {
    try {
      resolveConfig({ leaseMinMs: 10_000, leaseMaxMs: 5_000 })
      throw new Error('should have thrown')
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(WindowError)
      expect((error as WindowError).code).toBe('WINDOW_CONFIG_INVALID')
    }
  })

  it('非法值在装配期响亮失败', () => {
    for (const bad of [
      { orphanTimeoutMs: 0 },
      { orphanTimeoutMs: -1 },
      { orphanTimeoutMs: 1.5 },
      { waitPollMs: 10 },
      { waitPollMs: Number.NaN },
    ]) {
      try {
        resolveConfig(bad as never)
        throw new Error('should have thrown')
      } catch (error: unknown) {
        expect(error).toBeInstanceOf(WindowError)
        expect((error as WindowError).code).toBe('WINDOW_CONFIG_INVALID')
      }
    }
  })
})
