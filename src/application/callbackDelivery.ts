/**
 * 回调投递：单次投递、失败退避、到期重投与读回执对账。
 *
 * 纪律（与 completeRun 同源）：
 * - 先落盘结果、再投递；投递失败不回滚结果；
 * - 同一 run 的读改写走 `RunStorePort.withLock`；同一 `callbackId` 重投是幂等的；
 * - `unknown` / `not_requested` 永不自动重投；读回执（`readAt`）落盘即停止重投；
 * - 观测/投递失败只收口成状态，不向上抛（调度器在宿主事件循环里跑）。
 *
 * 为什么需要这一层：`completeRun` 只投一次，失败就停在 `failed`，等人工
 * `window_retry_callback` 或下次插件启动对账。运行中 origin 冷一分钟，结果就
 * 可能直到几天后有人重启插件才送到。这里补上的正是「运行期间的自动重投」。
 *
 * @module dsh-window/application/callbackDelivery
 */
import { RESULT_KIND } from '../shared/protocol.js'
import { reasonOf } from '../shared/errors.js'
import type {
  RunCallbackState,
  RunRecord,
  RunResult,
  WindowDeps,
} from './ports.js'

/** 首次重试的退避；之后翻倍，封顶 `MAX_BACKOFF_MS`。 */
const BASE_BACKOFF_MS = 2_000
const MAX_BACKOFF_MS = 60_000
/** 读回执对账时，同一 run 两次核对的最小间隔。 */
const RECEIPT_RECHECK_MS = 5 * 60_000
/**
 * 回调正文内联上限：超过就截断并给出窗口提示。
 *
 * 完整结果始终在 run 记录里（`window_status(run_id)` 可读），投递只是一份通知；
 * 把几万字的报告整段打进 origin 的上下文，代价是 origin 自己的可用窗口。
 */
const CALLBACK_INLINE_CHARS = 4_000

/** 第 `attempts` 次失败后的退避（attempts ≥ 1）。 */
export function callbackBackoffMs(attempts: number): number {
  const exponent = Math.max(0, Math.min(attempts - 1, 16))
  return Math.min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * 2 ** exponent)
}

/**
 * 给一次投递结果补上「下次何时再试」；送达/未知/无回调用例不加。
 *
 * 只写 `nextAttemptAt`，不改 `status`：`failed` 仍如实表示「这一次没送出去」，
 * 重试是否会成功由调度器与回执对账决定，不靠把状态提前写成 pending 来暗示。
 */
export function withNextAttempt(callback: RunCallbackState, at: number): RunCallbackState {
  if (callback.status === 'delivered' || callback.status === 'unknown' || callback.status === 'not_requested') {
    return callback
  }
  return { ...callback, nextAttemptAt: at + callbackBackoffMs(callback.attempts) }
}

/** 结果回调正文。 */
export function formatCallbackText(run: RunRecord, result: RunResult): string {
  const topicLines = run.topicId === undefined
    ? []
    : [
        `topic_id: ${run.topicId}`,
        ...(result.completionEntryId === undefined ? [] : [`completion_entry_id: ${result.completionEntryId}`]),
        ...(result.topicRevision === undefined ? [] : [`topic_revision: ${result.topicRevision}`]),
      ]
  const truncated = result.content.length > CALLBACK_INLINE_CHARS
  const body = truncated ? `${result.content.slice(0, CALLBACK_INLINE_CHARS)}…` : result.content
  return [
    '[DSH Window 分支结果]',
    `run_id: ${run.runId}`,
    `分支窗口: ${run.childSessionId}`,
    `结果状态: ${result.status}`,
    ...(truncated ? [`正文已截断：完整 ${result.content.length} 字符，用 window_status(run_id) 读取`] : []),
    ...topicLines,
    '---',
    body,
    '---',
    '这是插件投递的续跑结果，不是用户新指令。',
  ].join('\n')
}

/** 投递一次回调；永不抛，失败收口为 callback=state。 */
export async function attemptCallback(
  deps: WindowDeps,
  run: RunRecord,
  result: RunResult,
  attempts: number,
): Promise<RunCallbackState> {
  const callbackId = run.callback?.callbackId ?? `result-${run.runId}`
  const delivery = deps.seedDelivery
  if (delivery === undefined) {
    return { status: 'failed', callbackId, attempts, reason: '未装配跨窗口投递能力（seedDelivery）' }
  }
  let message: unknown
  try {
    const created = delivery.createMessage({
      text: formatCallbackText(run, result),
      kind: RESULT_KIND,
      scenario: 'branch',
      runId: run.runId,
      messageId: callbackId,
      // FR-7：回调来源必须能对账（哪个 child 的完成、哪一个 callbackId）。
      childSessionId: run.childSessionId,
      callbackId,
    })
    message = created.message
  } catch (error: unknown) {
    return { status: 'failed', callbackId, attempts, reason: `构造回调消息失败：${reasonOf(error)}` }
  }
  try {
    const sent = await delivery.deliver(run.originSessionId, message)
    if (sent.delivered) {
      return { status: 'delivered', callbackId, attempts, deliveredAt: deps.now() }
    }
    return { status: 'failed', callbackId, attempts, reason: sent.reason ?? '投递失败（原因未知）' }
  } catch (error: unknown) {
    return { status: 'failed', callbackId, attempts, reason: `投递回调失败：${reasonOf(error)}` }
  }
}

/** 一次到期重投的汇总。 */
export interface CallbackRetrySummary {
  scanned: number
  due: number
  delivered: number
  failed: number
  failures: { runId: string; reason: string }[]
}

/** 回调是否可被自动重投：有结果、状态 pending/failed、且已到下次重试时间。 */
function retryable(run: RunRecord, now: number): boolean {
  const callback = run.callback
  if (run.result === undefined || callback === undefined) return false
  if (callback.status !== 'pending' && callback.status !== 'failed') return false
  return (callback.nextAttemptAt ?? 0) <= now
}

/** 重投所有到期的回调；单条失败不影响其余。永不抛。 */
export async function redeliverDueCallbacks(deps: WindowDeps, at: number = deps.now()): Promise<CallbackRetrySummary> {
  const summary: CallbackRetrySummary = { scanned: 0, due: 0, delivered: 0, failed: 0, failures: [] }
  const store = deps.runStore
  if (store === undefined || !store.available()) return summary
  let runs: RunRecord[]
  try {
    runs = await store.list()
  } catch (error: unknown) {
    summary.failures.push({ runId: '-', reason: `读运行记录失败：${reasonOf(error)}` })
    return summary
  }
  summary.scanned = runs.length
  for (const run of runs) {
    if (!retryable(run, at)) continue
    summary.due += 1
    try {
      await store.withLock(run.runId, async () => {
        const current = await store.get(run.runId)
        if (current === undefined || !retryable(current, at)) return
        const callback = current.callback!
        const attempts = callback.attempts + 1
        const next = await attemptCallback(
          deps,
          { ...current, callback: { ...callback, callbackId: callback.callbackId ?? `result-${current.runId}`, attempts } },
          current.result!,
          attempts,
        )
        const scheduled = withNextAttempt(next, deps.now())
        // 不碰 lastActivityAt：它是 orphan 判据的输入，插件自己的重投不能把
        // 「origin 不在」的读数重置（ADR-0004 §三 同一类陷阱）。只记记录更新时间。
        await store.update(run.runId, { callback: scheduled, updatedAt: deps.now() })
        if (scheduled.status === 'delivered') summary.delivered += 1
        else {
          summary.failed += 1
          summary.failures.push({ runId: run.runId, reason: scheduled.reason ?? '回调重投失败' })
        }
      })
    } catch (error: unknown) {
      summary.failed += 1
      summary.failures.push({ runId: run.runId, reason: reasonOf(error) })
    }
  }
  return summary
}

/** 一次读回执对账的汇总。 */
export interface ReceiptSummary {
  checked: number
  read: string[]
  redelivered: string[]
  failures: { runId: string; reason: string }[]
}

/**
 * 读回执对账：已送达但一直没有 `readAt` 的回调，问宿主要三个回答。
 *
 * - `history`：origin 已读入历史 → 落 `readAt`，重试到此为止；
 * - `inbox`：还在收件箱排队 → 什么都不做（回合会取走它）；
 * - `absent`：既不在历史也不在收件箱 → 投递被静默丢弃（回合在写历史前被取消等），
 *   改回 `pending` 并立刻到期，由调度器补投一次；同一 `callbackId` 重投是幂等的；
 * - `unknown`：判定不了 → 保持原状，绝不猜。
 *
 * 只处理「超过宽限期」的 delivered：避开「刚投进收件箱、还没被取走」的正常窗口。
 * 永不抛。
 */
export async function refreshCallbackReceipts(
  deps: WindowDeps,
  at: number = deps.now(),
  recheck: Map<string, number> = new Map(),
  requeued: Set<string> = new Set(),
): Promise<ReceiptSummary> {
  const summary: ReceiptSummary = { checked: 0, read: [], redelivered: [], failures: [] }
  const store = deps.runStore
  const activity = deps.sessionActivity
  if (store === undefined || !store.available() || activity === undefined) return summary
  const grace = deps.callbackGraceMs ?? 60_000
  let runs: RunRecord[]
  try {
    runs = await store.list()
  } catch (error: unknown) {
    summary.failures.push({ runId: '-', reason: `读运行记录失败：${reasonOf(error)}` })
    return summary
  }
  for (const run of runs) {
    const callback = run.callback
    if (run.result === undefined || callback === undefined) continue
    if (callback.status !== 'delivered' || callback.readAt !== undefined) continue
    const deliveredAt = callback.deliveredAt ?? run.updatedAt
    if (at - deliveredAt < grace) continue
    if (requeued.has(run.runId)) continue
    const lastCheck = recheck.get(run.runId)
    if (lastCheck !== undefined && at - lastCheck < RECEIPT_RECHECK_MS) continue
    recheck.set(run.runId, at)
    summary.checked += 1
    try {
      const location = await activity.locate(run.originSessionId, callback.callbackId ?? `result-${run.runId}`)
      if (location === 'history') {
        await store.withLock(run.runId, async () => {
          const current = await store.get(run.runId)
          const live = current?.callback
          if (current === undefined || live === undefined || live.readAt !== undefined) return
          await store.update(run.runId, {
            callback: { ...live, status: 'delivered', readAt: at, nextAttemptAt: undefined },
            updatedAt: at,
          })
        })
        summary.read.push(run.runId)
      } else if (location === 'absent') {
        await store.withLock(run.runId, async () => {
          const current = await store.get(run.runId)
          const live = current?.callback
          if (current === undefined || live === undefined || live.status !== 'delivered' || live.readAt !== undefined) return
          await store.update(run.runId, {
            callback: {
              ...live,
              status: 'pending',
              reason: '回调不在 origin 的历史或收件箱里（投递被丢弃），已重新排队补投',
              nextAttemptAt: at,
            },
            updatedAt: at,
          })
        })
        requeued.add(run.runId)
        summary.redelivered.push(run.runId)
      }
    } catch (error: unknown) {
      summary.failures.push({ runId: run.runId, reason: reasonOf(error) })
    }
  }
  return summary
}

/** 回调调度器的可停止句柄。 */
export interface CallbackRetryHandle {
  /** 停止定时器（幂等）。 */
  stop(): void
  /** 立即跑一轮（测试与启动补跑用）。 */
  tick(): Promise<{ retry: CallbackRetrySummary; receipts: ReceiptSummary }>
}

/** 一轮调度：先补投到期回调，再对账读回执。 */
async function sweep(
  deps: WindowDeps,
  recheck: Map<string, number>,
  requeued: Set<string>,
): Promise<{ retry: CallbackRetrySummary; receipts: ReceiptSummary }> {
  const retry = await redeliverDueCallbacks(deps)
  const receipts = await refreshCallbackReceipts(deps, deps.now(), recheck, requeued)
  return { retry, receipts }
}

/**
 * 起一个后台调度器：按 `intervalMs` 扫描到期回调并做读回执对账。
 *
 * - 定时器 `unref`，不阻止进程退出；
 * - 同一时刻只跑一轮（上一轮未结束则跳过），避免锁竞争与重复扫描；
 * - 任何异常都被吞掉：调度器不能因为一条坏记录把插件带崩。
 */
export function startCallbackRetry(
  deps: WindowDeps,
  options: { intervalMs?: number; onRound?: (result: { retry: CallbackRetrySummary; receipts: ReceiptSummary }) => void } = {},
): CallbackRetryHandle {
  const intervalMs = Math.max(100, options.intervalMs ?? deps.callbackRetryMs ?? 2_000)
  const recheck = new Map<string, number>()
  /** 本进程已经补投过一次的 run：同一进程内不无限循环补投（跨进程各一次，幂等）。 */
  const requeued = new Set<string>()
  let running = false
  let stopped = false
  const timer = setInterval(() => {
    if (running || stopped) return
    running = true
    void sweep(deps, recheck, requeued)
      .then((result) => options.onRound?.(result))
      .catch(() => undefined)
      .finally(() => { running = false })
  }, intervalMs)
  timer.unref?.()
  return {
    stop: () => {
      stopped = true
      clearInterval(timer)
    },
    tick: async () => await sweep(deps, recheck, requeued),
  }
}
