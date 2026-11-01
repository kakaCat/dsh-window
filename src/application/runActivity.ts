/**
 * run 活动追踪：把宿主会话事件折算成 run 记录上的两件事。
 *
 * 1) **心跳**：child 的回合/事件推进 → `lastTurnAt`（按 run 节流写入）。
 *    与 `lastActivityAt` 分开，正是为了避免「投递动作重置停滞读数」（ADR-0004 §三）。
 * 2) **读回执**：origin 把某条回调消息读入历史 → `callback.readAt`，
 *    并把它从自动重投队列里摘掉（`delivered` 只代表进了收件箱，不代表读过）。
 *
 * 只写这两个字段，绝不改 run 状态、不写结果、不完成 run。
 * 所有异常都吞掉：这是宿主事件热路径，观测失败不能影响会话本身。
 *
 * @module dsh-window/application/runActivity
 */
import type { RunRecord, SessionActivityEvent, WindowDeps } from './ports.js'

/** 默认缓存 TTL：期间不重扫 run 目录。 */
const DEFAULT_CACHE_TTL_MS = 15_000
/** 默认心跳写盘节流：同一 run 至多这么久写一次。 */
const DEFAULT_TOUCH_MS = 30_000
/** 缓存未命中时的强制重扫最小间隔：挡住「无关会话的每个事件都扫一遍 run 目录」。 */
const FORCED_REFRESH_MIN_MS = 2_000

export interface RunActivityOptions {
  /** 心跳写盘节流（ms）。 */
  touchIntervalMs?: number
  /** run 目录缓存 TTL（ms）。 */
  cacheTtlMs?: number
}

/** 事件 → run 记录的两条写路径。 */
export class RunActivityTracker {
  private readonly byChild = new Map<string, RunRecord>()
  private readonly byOriginCallback = new Map<string, RunRecord>()
  private readonly touched = new Map<string, number>()
  private refreshedAt = Number.NEGATIVE_INFINITY
  private refreshing: Promise<void> | undefined

  constructor(private readonly deps: WindowDeps, private readonly options: RunActivityOptions = {}) {}

  /** 处理一条宿主活动读数；永不抛。 */
  async handle(event: SessionActivityEvent): Promise<void> {
    try {
      if (event.callbackId !== undefined) {
        await this.recordReadReceipt(event.sessionId, event.callbackId, event.at)
        return
      }
      await this.recordChildActivity(event.sessionId, event.at)
    } catch {
      // 观测失败不影响宿主事件循环，也不改变 run 状态。
    }
  }

  /** child 推进 → lastTurnAt（节流）。 */
  private async recordChildActivity(sessionId: string, at: number): Promise<void> {
    const store = this.deps.runStore
    if (store === undefined || !store.available()) return
    await this.ensureFresh(at)
    let run = this.byChild.get(sessionId)
    if (run === undefined) {
      await this.ensureFresh(at, true)
      run = this.byChild.get(sessionId)
    }
    if (run === undefined || (run.status !== 'pending' && run.status !== 'running')) return
    const touchInterval = this.options.touchIntervalMs ?? this.deps.activityTouchMs ?? DEFAULT_TOUCH_MS
    const last = this.touched.get(run.runId) ?? run.lastTurnAt ?? 0
    if (at - last < touchInterval) return
    await store.withLock(run.runId, async () => {
      const current = await store.get(run.runId)
      if (current === undefined || (current.status !== 'pending' && current.status !== 'running')) return
      await store.update(run.runId, { lastTurnAt: at })
      this.byChild.set(sessionId, { ...current, lastTurnAt: at })
    })
    this.touched.set(run.runId, at)
  }

  /** origin 读入回调 → readAt，并停止重投。 */
  private async recordReadReceipt(originSessionId: string, callbackId: string, at: number): Promise<void> {
    const store = this.deps.runStore
    if (store === undefined || !store.available()) return
    const key = `${originSessionId}\u0000${callbackId}`
    await this.ensureFresh(at)
    let run = this.byOriginCallback.get(key)
    if (run === undefined) {
      await this.ensureFresh(at, true)
      run = this.byOriginCallback.get(key)
    }
    if (run === undefined) return
    if (run.callback?.readAt !== undefined) return
    await store.withLock(run.runId, async () => {
      const current = await store.get(run.runId)
      const callback = current?.callback
      if (current === undefined || callback === undefined) return
      if ((callback.callbackId ?? `result-${current.runId}`) !== callbackId) return
      if (callback.readAt !== undefined) return
      const next = {
        ...callback,
        // 能读进历史就证明投递确实发生过：把之前记成 failed 的读数纠正过来。
        status: 'delivered' as const,
        readAt: at,
        deliveredAt: callback.deliveredAt ?? at,
        nextAttemptAt: undefined,
      }
      await store.update(current.runId, { callback: next })
      this.byOriginCallback.set(key, { ...current, callback: next })
    })
  }

  /** 重扫 run 记录；同一时刻只跑一次。失败时保留旧缓存。 */
  private async ensureFresh(at: number, force = false): Promise<void> {
    const store = this.deps.runStore
    const ttl = this.options.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS
    if (!force && at - this.refreshedAt < ttl) return
    // 未命中才强制重扫，但同一窗口内也只扫一次：别的窗口的事件同样会走到这里。
    if (force && at - this.refreshedAt < FORCED_REFRESH_MIN_MS) return
    if (this.refreshing !== undefined) {
      await this.refreshing
      return
    }
    this.refreshing = (async () => {
      const runs = await store!.list()
      this.byChild.clear()
      this.byOriginCallback.clear()
      for (const run of runs) {
        this.byChild.set(run.childSessionId, run)
        const callbackId = run.callback?.callbackId
        if (callbackId !== undefined) this.byOriginCallback.set(`${run.originSessionId}\u0000${callbackId}`, run)
      }
      this.refreshedAt = this.deps.now()
    })()
    try {
      await this.refreshing
    } finally {
      this.refreshing = undefined
    }
  }
}
