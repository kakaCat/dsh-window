/**
 * `window_wait` 用例：等待一组 branch run 进入终态（all / any），超时给快照。
 *
 * 拉取语义：只读 run store，不消费 callback、不改变 run。优先用
 * `RunStorePort.watch` 事件驱动；无 watch 能力时走受配置约束的有界轮询。
 *
 * @module dsh-window/application/waitRuns
 */
import { reject } from '../shared/errors.js'
import type {
  RunRecord,
  RunStatus,
  WaitRunsInput,
  WaitRunsValue,
  WindowDeps,
  WindowListRow,
} from './ports.js'
import { listRowOf } from './listRuns.js'
import { runIndexRowOf } from './runIndex.js'
import { execSignal } from './execView.js'

const TERMINAL = new Set(['completed', 'failed', 'cancelled', 'seed_failed', 'orphaned'])
const DEFAULT_POLL_MS = 500

/** 终态判断（含 B5 的 orphaned）。 */
export function isTerminalRun(status: string): boolean {
  return TERMINAL.has(status)
}

/** 归一输入。 */
function normalize(raw: WaitRunsInput): {
  runIds?: string[]
  scope?: 'my_active'
  topicId?: string
  status?: RunStatus[]
  mode: 'all' | 'any'
  timeoutMs: number
} {
  if (raw.mode !== 'all' && raw.mode !== 'any') {
    reject('WINDOW_INVALID_INPUT', `window_wait 未执行：mode 只能是 all 或 any（${String(raw.mode)}）`)
  }
  if (!Number.isSafeInteger(raw.timeoutMs) || raw.timeoutMs < 1) {
    reject('WINDOW_INVALID_INPUT', `window_wait 未执行：timeout_ms 必须是 ≥1 的整数（${String(raw.timeoutMs)}）`)
  }
  const runIds = Array.isArray(raw.runIds)
    ? [...new Set(raw.runIds.filter((id): id is string => typeof id === 'string' && id.trim().length > 0).map((id) => id.trim()))]
    : []
  if (raw.scope !== undefined && raw.scope !== 'my_active') {
    reject('WINDOW_INVALID_INPUT', `window_wait 未执行：scope 只能是 my_active（${String(raw.scope)}）`)
  }
  const topicId = typeof raw.topicId === 'string' && raw.topicId.trim().length > 0 ? raw.topicId.trim() : undefined
  const status = Array.isArray(raw.status) && raw.status.length > 0 ? [...new Set(raw.status)] : undefined
  if (status !== undefined) {
    const allowed = new Set<string>(['pending', 'running', 'completed', 'failed', 'cancelled', 'seed_failed', 'orphaned'])
    for (const item of status) {
      if (typeof item !== 'string' || !allowed.has(item)) {
        reject('WINDOW_INVALID_INPUT', `window_wait 未执行：status 含非法值（${String(item)}）`)
      }
    }
  }
  return {
    ...(runIds.length === 0 ? {} : { runIds }),
    ...(raw.scope === undefined ? {} : { scope: raw.scope }),
    ...(topicId === undefined ? {} : { topicId }),
    ...(status === undefined ? {} : { status }),
    mode: raw.mode,
    timeoutMs: raw.timeoutMs,
  }
}

/** 按 status 过滤（FR-17）。 */
function byStatus(runs: RunRecord[], status: RunStatus[] | undefined): RunRecord[] {
  return status === undefined ? runs : runs.filter((run) => status.includes(run.status))
}

/** 解析目标 run 集合。 */
async function resolveTargets(
  deps: WindowDeps,
  caller: string,
  input: ReturnType<typeof normalize>,
): Promise<RunRecord[]> {
  const store = deps.runStore
  if (store === undefined || !store.available()) {
    reject('WINDOW_RUN_STORE_UNAVAILABLE', 'window_wait 未执行：运行记录存储不可用')
  }
  if (input.runIds !== undefined) {
    const runs: RunRecord[] = []
    for (const runId of input.runIds) {
      const run = await store.get(runId)
      if (run === undefined) reject('WINDOW_RUN_NOT_FOUND', `run 不存在：${runId}`)
      if (caller !== run.originSessionId && caller !== run.childSessionId) {
        reject('WINDOW_RUN_FORBIDDEN', `本窗口无权等待 run ${runId}`)
      }
      runs.push(run)
    }
    return byStatus(runs, input.status)
  }

  const all = await store.list()
  if (input.topicId !== undefined) {
    const runs = byStatus(
      all.filter((run) =>
        run.topicId === input.topicId && (run.originSessionId === caller || run.childSessionId === caller)),
      input.status,
    )
    if (runs.length === 0) {
      reject('WINDOW_WAIT_UNAVAILABLE', `没有与 topic ${input.topicId} 相关且本窗口可见的 run`)
    }
    return runs
  }

  const active = byStatus(
    all.filter((run) => run.originSessionId === caller && !isTerminalRun(run.status)),
    input.status,
  )
  if (active.length === 0) {
    reject('WINDOW_WAIT_UNAVAILABLE', '本窗口没有可等待的活动 run')
  }
  return active
}

/** 等到 predicate 成立 / 超时 / 调用方取消。 */
async function waitUntil(
  deps: WindowDeps,
  check: () => Promise<boolean>,
  timeoutMs: number,
  signal: AbortSignal | undefined,
): Promise<'done' | 'timeout' | 'aborted'> {
  if (signal?.aborted === true) return 'aborted'
  return await new Promise<'done' | 'timeout' | 'aborted'>((resolve) => {
    let settled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    let poll: ReturnType<typeof setInterval> | undefined
    let unsubscribe: (() => void) | undefined
    const finish = (reason: 'done' | 'timeout' | 'aborted'): void => {
      if (settled) return
      settled = true
      if (timer !== undefined) clearTimeout(timer)
      if (poll !== undefined) clearInterval(poll)
      unsubscribe?.()
      signal?.removeEventListener('abort', onAbort)
      resolve(reason)
    }
    const onAbort = (): void => finish('aborted')
    signal?.addEventListener('abort', onAbort, { once: true })
    timer = setTimeout(() => finish('timeout'), timeoutMs)
    const checkAsync = async (): Promise<void> => {
      if (settled) return
      try {
        if (await check()) finish('done')
      } catch {
        // 读失败：不把异常当完成，等下一次事件/轮询或超时。
      }
    }
    const store = deps.runStore
    if (store?.watch !== undefined) {
      unsubscribe = store.watch(() => {
        void checkAsync()
      })
    } else {
      poll = setInterval(() => {
        void checkAsync()
      }, Math.max(50, deps.waitPollMs ?? DEFAULT_POLL_MS))
    }
    void checkAsync()
  })
}

/** 等待一组 run 进入终态。 */
export async function waitRuns(
  deps: WindowDeps,
  raw: WaitRunsInput,
  exec: unknown,
): Promise<WaitRunsValue> {
  const input = normalize(raw)
  const caller = deps.resolveWindowKey(exec)
  deps.requireLiveDriver(exec)
  const targets = await resolveTargets(deps, caller, input)
  const targetIds = new Set(targets.map((run) => run.runId))

  const snapshot = async (): Promise<WindowListRow[]> => {
    const store = deps.runStore!
    const runs = await store.list()
    return runs
      .filter((run) => targetIds.has(run.runId))
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .map((run) => listRowOf(runIndexRowOf(run)))
  }

  const check = async (): Promise<boolean> => {
    const store = deps.runStore!
    const runs = await store.list()
    const current = runs.filter((run) => targetIds.has(run.runId))
    if (input.mode === 'any') return current.some((run) => isTerminalRun(run.status))
    return current.length === targetIds.size && current.every((run) => isTerminalRun(run.status))
  }

  if (await check()) {
    return { timed_out: false, runs: await snapshot() }
  }

  const signal = execSignal(exec)
  const outcome = await waitUntil(deps, check, input.timeoutMs, signal)
  const runs = await snapshot()
  if (outcome === 'aborted') return { timed_out: false, aborted: true, runs }
  if (outcome !== 'timeout') return { timed_out: false, runs }
  const pending = runs.filter((run) => !TERMINAL.has(run.run_status))
  return {
    timed_out: true,
    runs,
    ...(pending.length === 0
      ? {}
      : {
          hint:
            `超时只说明到点，不说明停滞：仍有 ${pending.length} 条 run 未终态。` +
            'last_activity_at 不随回合刷新，不能作为停滞判据；要判断子窗口是否还在干活，' +
            "用 window_inspect 看 running 与历史；必要时 window_send 追加引导，或 window_interrupt(mode='turn') 只中断当前轮（run 仍在、收件箱保留）。",
        }),
  }
}
