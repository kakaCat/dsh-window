/**
 * branch 生命周期：重启对账（reconcile）、origin 停止联动（stop）、卸载排空（drain）。
 *
 * 纪律：
 * - orphan 不伪造完成结果、不写虚假 callback；
 * - stop 只写 cancelled + not_requested，绝不冒充 completed；
 * - reconcile 对未送达 callback 只做重投，不改变已落盘结果；
 * - continuation 没有 run，不参与任何生命周期动作。
 *
 * @module dsh-window/application/lifecycle
 */
import { reasonOf, reject } from '../shared/errors.js'
import { attemptCallback } from './completeRun.js'
import type {
  RunCallbackState,
  RunControlEvent,
  RunRecord,
  RunResult,
  WindowDeps,
} from './ports.js'

/** reconcile 汇总。 */
export interface ReconcileSummary {
  scanned: number
  orphaned: string[]
  redelivered: string[]
  cleaned: number
  failures: { runId: string; reason: string }[]
}

/** stop/orphan 汇总。 */
export interface LifecycleActionSummary {
  affected: string[]
  childCancelAccepted: number
  failures: { runId: string; reason: string }[]
}

function isActive(run: RunRecord): boolean {
  return run.lifecycle?.state !== 'stopped' && (run.status === 'pending' || run.status === 'running')
}

function requireStore(deps: WindowDeps) {
  const store = deps.runStore
  if (store === undefined || !store.available()) {
    reject('WINDOW_RUN_STORE_UNAVAILABLE', '生命周期动作未执行：运行记录存储不可用')
  }
  return store
}

/** 追加控制事件；失败只记录，不让生命周期动作反转。 */
async function appendControl(deps: WindowDeps, event: RunControlEvent): Promise<void> {
  if (deps.runStore?.appendControl === undefined) return
  try {
    await deps.runStore.appendControl(event.runId, event)
  } catch {
    // 留痕失败不改变 run 终态。
  }
}

/** 尽力取消 child 当前轮（复用 B2 的 cancel 路径）。 */
async function cancelChild(deps: WindowDeps, run: RunRecord, reason: string): Promise<boolean> {
  if (deps.agentControl === undefined) return false
  try {
    const outcome = await deps.agentControl.cancelTurn(run.childSessionId, reason)
    return outcome.accepted
  } catch {
    return false
  }
}

/** 释放该 run 的协作占用（FR-19）；失败不改变 run 生命周期事实。 */
async function releaseTopicClaims(deps: WindowDeps, runId: string, reason: string): Promise<void> {
  const store = deps.topicStore
  if (store === undefined || !store.available()) return
  try {
    await store.releaseClaimsForRun(runId, { at: deps.now(), reason })
  } catch {
    // 占用是软约束；历史保留，可等过期接管或显式 release。
  }
}

/** 标记 orphaned：不写 result、不改 callback；写操作与 complete/interrupt 同锁串行（B-竞态修复）。 */
async function markOrphaned(deps: WindowDeps, run: RunRecord, reason: string): Promise<boolean> {
  const store = requireStore(deps)
  const at = deps.now()
  let marked = false
  await store.withLock(run.runId, async () => {
    // 锁内重读：与进行中的 complete/interrupt 交错时以最新状态为准，不产生 lost update。
    const current = await store.get(run.runId)
    if (current === undefined) return
    if (current.status !== 'pending' && current.status !== 'running') return
    await store.update(run.runId, {
      status: 'orphaned',
      lifecycle: { state: 'orphaned', reason, at },
      lastActivityAt: at,
      updatedAt: at,
    })
    marked = true
  })
  if (!marked) return false
  const accepted = await cancelChild(deps, run, `origin ${reason}`)
  await releaseTopicClaims(deps, run.runId, `run 已 orphaned：${reason}`)
  await appendControl(deps, {
    eventId: deps.newRunId(),
    runId: run.runId,
    kind: 'orphan',
    actorSessionId: 'dsh-window-lifecycle',
    reason,
    at,
    result: accepted ? 'accepted' : 'target-offline',
  })
  return true
}

/** 启动/定期对账：孤儿标记、未送达回调重投、半截文件清理。 */
export async function reconcileRuns(deps: WindowDeps): Promise<ReconcileSummary> {
  const store = requireStore(deps)
  const summary: ReconcileSummary = { scanned: 0, orphaned: [], redelivered: [], cleaned: 0, failures: [] }
  try {
    summary.cleaned = (await store.cleanup?.()) ?? 0
  } catch (error: unknown) {
    summary.failures.push({ runId: '-', reason: `清理半截文件失败：${reasonOf(error)}` })
  }
  // 主题台账的 .tmp 也要清：它有自己的根与原子写（此前 cleanup 是死端口，projects/ 下的残留永不清）。
  try {
    const topicStore = deps.topicStore
    if (topicStore?.cleanup !== undefined && topicStore.available()) {
      summary.cleaned += (await topicStore.cleanup()) ?? 0
    }
  } catch (error: unknown) {
    summary.failures.push({ runId: '-', reason: `清理主题台账半截文件失败：${reasonOf(error)}` })
  }

  const now = deps.now()
  const timeout = deps.orphanTimeoutMs ?? 24 * 60 * 60 * 1000
  const runs = await store.list()
  summary.scanned = runs.length
  for (const run of runs) {
    if (isActive(run)) {
      const lastActivity = run.lastActivityAt ?? run.updatedAt
      const idleMs = now - lastActivity
      if (idleMs < timeout) continue
      let alive: boolean | undefined
      try {
        alive = deps.isWindowAlive?.(run.originSessionId)
      } catch {
        alive = undefined
      }
      // FR-19：「origin 不可用超过 orphanTimeoutMs」——origin 在线时绝不 orphan
      // （child 在跑长任务期间 run 闲置不构成失联；判不到在线时保守按超时判）。
      if (alive === true) continue
      const reason = alive === false
        ? `origin 不在线且已 ${idleMs}ms 未活动`
        : `origin 超过 ${timeout}ms 未活动`
      try {
        const marked = await markOrphaned(deps, run, reason)
        if (marked) summary.orphaned.push(run.runId)
      } catch (error: unknown) {
        summary.failures.push({ runId: run.runId, reason: reasonOf(error) })
      }
      continue
    }

    const callback = run.callback
    if (run.result !== undefined && callback !== undefined && (callback.status === 'pending' || callback.status === 'failed')) {
      try {
        // 与 complete/retry 同锁；锁内重读，pending/failed 之外（如 unknown）不重投（FR-8）。
        await store.withLock(run.runId, async () => {
          const current = await store.get(run.runId)
          const currentCallback = current?.callback
          if (current?.result === undefined || currentCallback === undefined) return
          if (currentCallback.status !== 'pending' && currentCallback.status !== 'failed') return
          const next: RunCallbackState = await attemptCallback(
            deps,
            current,
            current.result,
            currentCallback.attempts + 1,
          )
          try {
            await store.update(run.runId, { callback: next, lastActivityAt: deps.now(), updatedAt: deps.now() })
          } catch (error: unknown) {
            // 只有「投递确实发生（delivered）但状态写回失败」才降级 unknown：
            // 此时盘上停在 pending 会诱发重复投递。投递本身失败（failed）时什么都没发出去，
            // 盘上保持原状即可，绝不能也标成 unknown（那会把"没投"说成"不确定"）。
            if (next.status === 'delivered') {
              const unknown: RunCallbackState = {
                ...next,
                status: 'unknown',
                reason: `回调状态落盘失败：${reasonOf(error)}`,
              }
              try {
                await store.update(run.runId, { callback: unknown, lastActivityAt: deps.now(), updatedAt: deps.now() })
              } catch {
                // 连 unknown 都写不进去：如实记失败，下次对账仍会读到 pending/failed。
              }
            }
            summary.failures.push({ runId: run.runId, reason: `回调状态落盘失败：${reasonOf(error)}` })
            return
          }
          if (next.status === 'delivered') summary.redelivered.push(run.runId)
          else if (next.status === 'failed') {
            summary.failures.push({ runId: run.runId, reason: next.reason ?? '回调重投失败' })
          }
        })
      } catch (error: unknown) {
        summary.failures.push({ runId: run.runId, reason: reasonOf(error) })
      }
    }
  }
  return summary
}

/** origin 停止/归档：把它的活动 run 全部 stop（cancelled + not_requested）。 */
export async function stopActiveRunsForOrigin(
  deps: WindowDeps,
  originSessionId: string,
  reason = 'origin 已停止/归档',
): Promise<LifecycleActionSummary> {
  const store = requireStore(deps)
  const summary: LifecycleActionSummary = { affected: [], childCancelAccepted: 0, failures: [] }
  const runs = (await store.list()).filter((run) => run.originSessionId === originSessionId && isActive(run))
  for (const run of runs) {
    try {
      const at = deps.now()
      const result: RunResult = {
        status: 'cancelled',
        content: reason,
        completedAt: at,
        completedBy: 'dsh-window-lifecycle',
      }
      const callback: RunCallbackState = { status: 'not_requested', attempts: 0 }
      // 与 complete/interrupt 同锁；锁内重读，终态不再改写（B-竞态修复）。
      let marked = false
      await store.withLock(run.runId, async () => {
        const current = await store.get(run.runId)
        if (current === undefined) return
        if (current.status !== 'pending' && current.status !== 'running') return
        await store.update(run.runId, {
          status: 'cancelled',
          result,
          callback,
          callbackArmed: false,
          lifecycle: { state: 'stopped', reason, at },
          lastActivityAt: at,
          updatedAt: at,
        })
        marked = true
      })
      if (!marked) continue
      if (await cancelChild(deps, run, reason)) summary.childCancelAccepted += 1
      await releaseTopicClaims(deps, run.runId, `origin 已停止：${reason}`)
      await appendControl(deps, {
        eventId: deps.newRunId(),
        runId: run.runId,
        kind: 'stop',
        actorSessionId: originSessionId,
        reason,
        at,
        result: 'accepted',
      })
      summary.affected.push(run.runId)
    } catch (error: unknown) {
      summary.failures.push({ runId: run.runId, reason: reasonOf(error) })
    }
  }
  return summary
}

/** 卸载排空：等待存储写入落定，并把 active run 记为 drained（FR-19 / §7.5）。 */
export async function drainLifecycle(
  deps: WindowDeps,
  timeoutMs = 5_000,
): Promise<{ drained: boolean; note: string }> {
  const store = deps.runStore

  // 先用同步 best-effort 落盘（宿主退出可能不 await 异步 disposer）；
  // 有同步能力的存储随后会被异步循环跳过（已是 drained）。
  let marked = 0
  if (store?.drainActiveRunsSync !== undefined && store.available()) {
    try {
      marked = store.drainActiveRunsSync('插件卸载排空', deps.now()).length
    } catch {
      marked = 0
    }
  }

  let settled = true
  if (store?.settle !== undefined) {
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => resolve('timeout'), timeoutMs)
    })
    try {
      const outcome = await Promise.race([store.settle().then(() => 'settled' as const), timeout])
      settled = outcome === 'settled'
    } finally {
      if (timer !== undefined) clearTimeout(timer)
    }
  }

  // 三类生命周期（stop/orphan/drain）都必须留痕，不得静默（FR-19）。
  if (store !== undefined && store.available()) {
    const at = deps.now()
    for (const run of await store.list()) {
      if (run.status !== 'pending' && run.status !== 'running') continue
      if (run.lifecycle?.state === 'drained') continue
      try {
        await store.withLock(run.runId, async () => {
          const current = await store.get(run.runId)
          if (current === undefined) return
          if (current.lifecycle?.state === 'drained') return
          await store.update(run.runId, {
            lifecycle: { state: 'drained', reason: '插件卸载排空', at },
            lastActivityAt: at,
            updatedAt: at,
          })
        })
        await appendControl(deps, {
          eventId: deps.newRunId(),
          runId: run.runId,
          kind: 'drain',
          actorSessionId: 'dsh-window-lifecycle',
          reason: '插件卸载排空',
          at,
          result: 'accepted',
        })
        marked += 1
      } catch {
        // 单个 run 留痕失败不阻断整体排空。
      }
    }
  }

  return settled
    ? { drained: true, note: `已等待存储写入落定；${marked} 条 active run 记为 drained` }
    : { drained: false, note: `排空超时（${timeoutMs}ms）；仍尝试记录 ${marked} 条 drained` }
}
