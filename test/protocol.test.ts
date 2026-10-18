import { describe, expect, it } from 'vitest'
import {
  SCENARIOS,
  WINDOW_MODES,
  callbackPolicyOf,
  defaultModeOf,
  isScenario,
  isWindowMode,
} from '../src/shared/protocol.js'
import { increasedWindowTitle } from '../src/application/windowInherit.js'

describe('双场景协议', () => {
  it('只认 continuation / branch', () => {
    expect(SCENARIOS).toEqual(['continuation', 'branch'])
    expect(isScenario('continuation')).toBe(true)
    expect(isScenario('branch')).toBe(true)
    expect(isScenario('fork')).toBe(false)
    expect(isScenario(undefined)).toBe(false)
  })

  it('mode 与 scenario 正交', () => {
    expect(WINDOW_MODES).toEqual(['fork', 'create'])
    expect(isWindowMode('fork')).toBe(true)
    expect(isWindowMode('continuation')).toBe(false)
  })

  it('默认 mode 与回调策略由 scenario 决定', () => {
    expect(defaultModeOf('continuation')).toBe('create')
    expect(defaultModeOf('branch')).toBe('fork')
    expect(callbackPolicyOf('continuation')).toBe('none')
    expect(callbackPolicyOf('branch')).toBe('required')
  })
})

describe('标题递增', () => {
  it('与宿主客户端同口径', () => {
    expect(increasedWindowTitle('登录重构')).toBe('登录重构 (1)')
    expect(increasedWindowTitle('登录重构 (2)')).toBe('登录重构 (3)')
    expect(increasedWindowTitle('登录重构（3）')).toBe('登录重构（4）')
  })
})
