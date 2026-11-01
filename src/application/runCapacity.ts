/**
 * origin 级并发上限：同一个窗口同时最多能有多少条活动 branch run。
 *
 * 这是**安全阀**，不是调度器：超限直接拒绝，不排队、不延迟、不自动收口。
 * 排队需要持久队列、超时、取消与公平性，会把本插件变成调度器——那超出边界。
 *
 * 为什么要有：每个 child 都是真实成本（一个会话、独立模型调用、磁盘、侧栏窗口）。
 * 一次模型重试循环或一段批量脚本可以在几分钟内开出几十个，而 origin 自己看不到全貌。
 *
 * 统计口径：`originSessionId` 相同、`status` 为 pending/running、且生命周期未被
 * stop/orphan/drain 的 run。终态 run 不计入（重跑同一个任务是合法的）。
 *
 * @module dsh-window/application/runCapacity
 */
import { reject } from '../shared/errors.js'
import type { RunRecord, WindowDeps } from './ports.js'

/** 缺省上限：足以覆盖正常的并行分叉，又能挡住失控增长。 */
export const DEFAULT_MAX_ACTIVE_RUNS_PER_ORIGIN = 16

/** 一条 run 是否仍占着 origin 的并发额度。 */
export function occupiesSlot(run: RunRecord): boolean {
  if (run.status !== 'pending' && run.status !== 'running') return false
  const state = run.lifecycle?.state
  return state !== 'stopped' && state !== 'orphaned' && state !== 'drained'
}

/** 统计某个 origin 当前的活动 run。 */
export async function activeRunsOf(deps: WindowDeps, origin: string): Promise<RunRecord[]> {
  const store = deps.runStore
  if (store === undefined || !store.available()) return []
  const runs = await store.list()
  return runs.filter((run) => run.originSessionId === origin && occupiesSlot(run))
}

/** 纯断言：拿到活动 run 列表后判额度。超限时结构化拒绝。 */
export function assertCapacity(active: RunRecord[], limit: number): void {
  if (active.length < limit) return
  reject(
    'WINDOW_ORIGIN_BUSY',
    `本窗口已有 ${active.length} 条活动 branch run，达到上限 ${limit}：未创建新会话、未投递 seed。`
    + '先用 window_wait 等其中几条收口，或 window_interrupt(mode=\'run\') 取消不再需要的，再开新窗。',
    { active: active.length, limit, active_run_ids: active.slice(0, 20).map((run) => run.runId) },
  )
}

/**
 * 建 run 前检查并发额度（自带一次读取）。
 *
 * 读不到运行记录时放行：额度是安全阀，不该因为一次读失败就把正常开窗打死；
 * 真读不到时后续 `runStore.create` 也会响亮失败。
 */
export async function assertOriginCapacity(deps: WindowDeps, origin: string): Promise<void> {
  const limit = deps.maxActiveRunsPerOrigin ?? DEFAULT_MAX_ACTIVE_RUNS_PER_ORIGIN
  let active: RunRecord[]
  try {
    active = await activeRunsOf(deps, origin)
  } catch {
    return
  }
  assertCapacity(active, limit)
}
