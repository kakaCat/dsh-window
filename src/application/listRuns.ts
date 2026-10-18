/**
 * `window_list` 用例：列出调用窗口可见的 branch run 摘要。
 *
 * 只读：不返回 result 正文、不改变 run。运行状态的权威来源是 run store /
 * RunListIndex；Topic Ledger 的 activeRuns 只是指针，不在这里参与判定。
 *
 * @module dsh-window/application/listRuns
 */
import { reasonOf, reject } from '../shared/errors.js'
import type {
  RunIndexRow,
  WindowDeps,
  WindowListInput,
  WindowListRow,
  WindowListValue,
} from './ports.js'
import { runIndexRowOf } from './runIndex.js'

const DEFAULT_LIMIT = 20
const MAX_LIMIT = 100

/** 活动 run：尚未进入终态。 */
function isActive(row: RunIndexRow): boolean {
  return row.runStatus === 'pending' || row.runStatus === 'running'
}

/** 解析分页游标（非负整数）；非法响亮失败。 */
function decodeCursor(cursor: string | undefined): number {
  if (cursor === undefined || cursor.trim().length === 0) return 0
  if (!/^\d+$/.test(cursor)) {
    reject('WINDOW_INVALID_INPUT', `window_list 未执行：cursor 非法（${cursor}）`)
  }
  return Number(cursor)
}

/** 归一 limit。 */
function normalizeLimit(raw: number | undefined): number {
  if (raw === undefined) return DEFAULT_LIMIT
  if (!Number.isSafeInteger(raw) || raw < 1) {
    reject('WINDOW_INVALID_INPUT', `window_list 未执行：limit 必须是正整数（${String(raw)}）`)
  }
  return Math.min(raw, MAX_LIMIT)
}

/** 索引行 → 工具回执行（不含 result 正文）。window_wait 复用同一投影。 */
export function listRowOf(row: RunIndexRow): WindowListRow {
  return {
    run_id: row.runId,
    created_by: row.createdBy,
    child_window_key: row.childSessionId,
    run_status: row.runStatus,
    ...(row.lifecycleState === undefined ? {} : { lifecycle_state: row.lifecycleState }),
    callback: { status: row.callbackStatus, attempts: row.callbackAttempts },
    ...(row.topicId === undefined ? {} : { topic_id: row.topicId }),
    last_activity_at: row.lastActivityAt,
    created_at: row.createdAt,
    updated_at: row.updatedAt,
  }
}

/** 列出调用窗口可见的 branch run。 */
export async function listRuns(
  deps: WindowDeps,
  raw: WindowListInput,
  exec: unknown,
): Promise<WindowListValue> {
  const caller = deps.resolveWindowKey(exec)
  deps.requireLiveDriver(exec)
  const store = deps.runStore
  if (store === undefined || !store.available()) {
    reject('WINDOW_RUN_STORE_UNAVAILABLE', 'window_list 未执行：运行记录存储不可用')
  }

  let rows: RunIndexRow[]
  try {
    rows = store.listIndex === undefined
      ? (await store.list()).map(runIndexRowOf)
      : await store.listIndex()
  } catch (error: unknown) {
    reject('WINDOW_RUN_STORE_UNAVAILABLE', `window_list 未执行：读取 run 索引失败（${reasonOf(error)}）`)
  }

  const status = raw.status ?? 'all'
  if (status !== 'all' && status !== 'active' && status !== 'terminal') {
    reject('WINDOW_INVALID_INPUT', `window_list 未执行：status 非法（${String(raw.status)}）`)
  }

  const filtered = rows
    .filter((row) => row.originSessionId === caller || row.childSessionId === caller)
    .filter((row) => {
      if (status === 'active') return isActive(row)
      if (status === 'terminal') return !isActive(row)
      return true
    })
    .filter((row) => raw.topicId === undefined || row.topicId === raw.topicId)
    .filter((row) => {
      if (raw.timeWindow === undefined) return true
      const from = raw.timeWindow.from
      const to = raw.timeWindow.to
      if (from !== undefined && row.updatedAt < from) return false
      if (to !== undefined && row.updatedAt > to) return false
      return true
    })
    .sort((a, b) => b.updatedAt - a.updatedAt)

  const limit = normalizeLimit(raw.limit)
  const start = decodeCursor(raw.cursor)
  const page = filtered.slice(start, start + limit)
  const next = start + limit < filtered.length ? String(start + limit) : undefined
  return {
    rows: page.map(listRowOf),
    total: filtered.length,
    ...(next === undefined ? {} : { next_cursor: next }),
  }
}
