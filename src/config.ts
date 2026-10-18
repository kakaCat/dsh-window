/**
 * 插件配置与装配期校验。
 *
 * 不在代码里散落超时/轮询常量：默认值集中在 DEFAULT 常量，非法配置在装配期
 * 响亮失败（WINDOW_CONFIG_INVALID），避免运行到一半才发现。
 *
 * @module dsh-window/config
 */
import { WindowError } from './shared/errors.js'

/** 用户可配字段。 */
export interface WindowConfig {
  /** 覆盖默认数据根（默认为 `$DSH_HOME/storages/dsh-window`）。 */
  dataRoot?: string
  /** origin 不可用多久后把 active run 标记 orphaned；缺省 24h。 */
  orphanTimeoutMs?: number
  /** window_wait 走轮询时的最小间隔；缺省 500ms。 */
  waitPollMs?: number
  /** claim 租约下限（§6.9）；缺省 1s。 */
  leaseMinMs?: number
  /** claim 租约上限（§6.9）；缺省 24h。 */
  leaseMaxMs?: number
}

/** 校验并补默认值后的配置。 */
export interface ResolvedWindowConfig {
  dataRoot?: string
  orphanTimeoutMs: number
  waitPollMs: number
  leaseMinMs: number
  leaseMaxMs: number
}

/** 默认值：集中一处，便于测试与文档引用。 */
export const DEFAULT_WINDOW_CONFIG: ResolvedWindowConfig = {
  orphanTimeoutMs: 24 * 60 * 60 * 1000,
  waitPollMs: 500,
  leaseMinMs: 1_000,
  leaseMaxMs: 24 * 60 * 60 * 1000,
}

function positiveInt(raw: unknown, name: string, min: number): number | undefined {
  if (raw === undefined) return undefined
  if (typeof raw !== 'number' || !Number.isSafeInteger(raw) || raw < min) {
    throw new WindowError('WINDOW_CONFIG_INVALID', `配置 ${name} 必须是 ≥${min} 的安全整数（收到 ${String(raw)}）`)
  }
  return raw
}

/** 解析配置：非法则响亮失败，绝不静默回落。 */
export function resolveConfig(raw: WindowConfig = {}): ResolvedWindowConfig {
  if (raw === null || typeof raw !== 'object') {
    throw new WindowError('WINDOW_CONFIG_INVALID', '配置必须是对象')
  }
  const dataRoot = typeof raw.dataRoot === 'string' && raw.dataRoot.trim().length > 0
    ? raw.dataRoot.trim()
    : undefined
  const orphanTimeoutMs = positiveInt(raw.orphanTimeoutMs, 'orphanTimeoutMs', 1000) ?? DEFAULT_WINDOW_CONFIG.orphanTimeoutMs
  const waitPollMs = positiveInt(raw.waitPollMs, 'waitPollMs', 50) ?? DEFAULT_WINDOW_CONFIG.waitPollMs
  const leaseMinMs = positiveInt(raw.leaseMinMs, 'leaseMinMs', 1) ?? DEFAULT_WINDOW_CONFIG.leaseMinMs
  const leaseMaxMs = positiveInt(raw.leaseMaxMs, 'leaseMaxMs', 1) ?? DEFAULT_WINDOW_CONFIG.leaseMaxMs
  if (leaseMaxMs < leaseMinMs) {
    throw new WindowError('WINDOW_CONFIG_INVALID', `配置 leaseMaxMs(${leaseMaxMs}) 不能小于 leaseMinMs(${leaseMinMs})`)
  }
  return {
    ...(dataRoot === undefined ? {} : { dataRoot }),
    orphanTimeoutMs,
    waitPollMs,
    leaseMinMs,
    leaseMaxMs,
  }
}
