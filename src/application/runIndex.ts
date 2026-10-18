/**
 * RunRecord → RunListIndex 行的唯一投影口径。
 *
 * window_list 与存储层共用它，避免索引字段在两处各写一份。
 *
 * @module dsh-window/application/runIndex
 */
import type { RunIndexRow, RunRecord } from './ports.js'

/** 把 run 记录投影成 RunListIndex 一行。 */
export function runIndexRowOf(record: RunRecord): RunIndexRow {
  return {
    runId: record.runId,
    createdBy: record.createdBy ?? 'open',
    originSessionId: record.originSessionId,
    childSessionId: record.childSessionId,
    runStatus: record.status,
    callbackStatus: record.callback?.status ?? 'not_armed',
    callbackAttempts: record.callback?.attempts ?? 0,
    ...(record.lifecycle === undefined ? {} : { lifecycleState: record.lifecycle.state }),
    ...(record.topicId === undefined ? {} : { topicId: record.topicId }),
    lastActivityAt: record.lastActivityAt ?? record.updatedAt,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  }
}
