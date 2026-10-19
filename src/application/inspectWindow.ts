/**
 * `window_inspect` 用例：只读查看某个窗口的元数据与（可选）分页历史。
 *
 * 授权只看 run 关系：本人，或对该窗口存在 origin→child run 的窗口。
 * 历史内容按不可信数据处理；默认只返回元数据。
 *
 * @module dsh-window/application/inspectWindow
 */
import { reasonOf, reject } from '../shared/errors.js'
import type { WindowDeps, WindowInspectInput, WindowInspectValue } from './ports.js'
import { execSignal } from './execView.js'

const DEFAULT_HISTORY_LIMIT = 20

/** 只读查看一个窗口。 */
export async function inspectWindow(
  deps: WindowDeps,
  raw: WindowInspectInput,
  exec: unknown,
): Promise<WindowInspectValue> {
  const caller = deps.resolveWindowKey(exec)
  deps.requireLiveDriver(exec)

  const windowKey = typeof raw.windowKey === 'string' ? raw.windowKey.trim() : ''
  if (windowKey.length === 0) {
    reject('WINDOW_INVALID_INPUT', 'window_inspect 未执行：window_key 必填')
  }
  const port = deps.windowInspect
  if (port === undefined) {
    reject('WINDOW_OPEN_UNAVAILABLE', 'window_inspect 未执行：本宿主未装配会话只读探测能力')
  }

  const store = deps.runStore
  const runs = store === undefined || !store.available() ? [] : await store.list()
  if (windowKey !== caller) {
    const related = runs.some((run) => run.originSessionId === caller && run.childSessionId === windowKey)
    if (!related) {
      reject('WINDOW_RUN_FORBIDDEN', `本窗口与 ${windowKey} 没有 run 关系，不能查看它的会话信息`)
    }
  }

  // 只读事实：该窗口作为 child 的 run 状态（供摘要判断“run 说在跑、会话却不在线”）。
  const relatedRun = runs.find((run) => run.childSessionId === windowKey)
  const runFacts =
    relatedRun === undefined
      ? {}
      : {
          run_status: relatedRun.status,
          ...(relatedRun.lifecycle === undefined ? {} : { lifecycle_state: relatedRun.lifecycle.state }),
        }

  let meta
  try {
    meta = await port.inspect(windowKey)
  } catch (error: unknown) {
    reject('WINDOW_RUN_NOT_FOUND', `window_inspect 未执行：会话不可读（${reasonOf(error)}）`)
  }

  // §8 红线：只读访问必须留痕（授权通过后才记为成功读取）。
  if (deps.runStore?.appendAudit !== undefined) {
    try {
      await deps.runStore.appendAudit({
        eventId: deps.newRunId(),
        actorSessionId: caller,
        targetSessionId: windowKey,
        action: 'inspect',
        includeHistory: raw.includeHistory === true,
        at: deps.now(),
      })
    } catch {
      // 留痕失败不阻断只读查看，但也不假装已留痕。
    }
  }

  if (raw.includeHistory !== true) {
    return { meta, untrusted: true, ...runFacts }
  }

  const limit = raw.limit === undefined ? DEFAULT_HISTORY_LIMIT : raw.limit
  if (!Number.isSafeInteger(limit) || limit < 1) {
    reject('WINDOW_INVALID_INPUT', `window_inspect 未执行：limit 必须是正整数（${String(raw.limit)}）`)
  }
  const signal = execSignal(exec)
  try {
    const history = await port.history(windowKey, {
      limit: Math.min(limit, 100),
      ...(raw.cursor === undefined ? {} : { cursor: raw.cursor }),
      ...(signal === undefined ? {} : { signal }),
    })
    return {
      meta,
      untrusted: true,
      ...runFacts,
      history: {
        items: history.items,
        ...(history.nextCursor === undefined ? {} : { next_cursor: history.nextCursor }),
      },
    }
  } catch (error: unknown) {
    reject('WINDOW_RUN_NOT_FOUND', `window_inspect 未执行：历史不可读（${reasonOf(error)}）`)
  }
}
