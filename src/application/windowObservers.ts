/**
 * 对话组的观测接线：心跳/读回执订阅 + 回调自动重试调度器。
 *
 * 只由对话组启动（与 reconcile / drain 同所有权），避免三行各起一份：
 * 重复的调度器会重复重投、重复写心跳。
 *
 * 这里不做任何完成判定：订阅只喂 `lastTurnAt` 与 `readAt`，完成仍然只能由
 * `window_complete`（或宿主插件的确定性完成信号）触发。
 *
 * @module dsh-window/application/windowObservers
 */
import { startCallbackRetry, type CallbackRetryHandle } from './callbackDelivery.js'
import type { WindowDeps } from './ports.js'
import { RunActivityTracker } from './runActivity.js'

/** 观测接线的最小日志面。 */
export interface ObserverLogger {
  info?: (message: string) => void
  warn?: (message: string) => void
}

export interface WindowObservers {
  /** 停止订阅与调度（幂等）。 */
  stop(): void
}

/**
 * 启动观测与重试；宿主缺端口时逐项安静降级，不影响工具面。
 */
export function startWindowObservers(deps: WindowDeps, logger?: ObserverLogger): WindowObservers {
  const activity = deps.sessionActivity
  const tracker = new RunActivityTracker(deps)
  const unsubscribe = activity === undefined
    ? undefined
    : activity.watch((event) => {
        void tracker.handle(event)
      })

  let retry: CallbackRetryHandle | undefined
  try {
    retry = startCallbackRetry(deps, {
      ...(deps.callbackRetryMs === undefined ? {} : { intervalMs: deps.callbackRetryMs }),
      onRound: (result) => {
        const { retry: callbacks, receipts } = result
        const interesting = callbacks.delivered > 0 || callbacks.failed > 0
          || receipts.read.length > 0 || receipts.redelivered.length > 0
        if (!interesting) return
        logger?.info?.(
          `回调调度：重投到期 ${callbacks.due}（送达 ${callbacks.delivered}，失败 ${callbacks.failed}）；`
          + `回执对账 ${receipts.checked}（已读 ${receipts.read.length}，补投 ${receipts.redelivered.length}）`,
        )
      },
    })
  } catch (error: unknown) {
    logger?.warn?.(`回调自动重试调度器未能启动：${error instanceof Error ? error.message : String(error)}`)
  }

  let stopped = false
  return {
    stop: () => {
      if (stopped) return
      stopped = true
      unsubscribe?.()
      retry?.stop()
      activity?.dispose?.()
    },
  }
}
