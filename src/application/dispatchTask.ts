/**
 * 向已有 branch child 再投递任务的用例（window_dispatch）。
 *
 * 不创建会话：复用 child 的既有上下文，新建一条 branch run 并投递 seed。
 * 安全与并发：只有与该 child 存在 origin→child 委派关系的窗口可发；同一 child
 * 同时最多一条活动 run，忙时返回 WINDOW_CHILD_BUSY。
 *
 * @module dsh-window/application/dispatchTask
 */
import { DEGRADED_NOTE, SEED_KIND } from '../shared/protocol.js'
import { reasonOf, reject } from '../shared/errors.js'
import type { DispatchTaskInput, DispatchTaskValue, RunRecord, WindowDeps } from './ports.js'
import { assertSchemaContract } from './openWindow.js'

/** 追加任务 seed 正文。 */
export function buildDispatchSeedText(seedText: string, runId: string): string {
  return [
    '[DSH Window 追加分叉任务包]',
    'scenario: branch',
    `run_id: ${runId}`,
    '你正在同一个分支窗口上执行新的分派任务；完成后必须调用 window_complete 上报 status 与 content。',
    '普通 turn/end 不算完成。',
    '---',
    '',
    seedText,
  ].join('\n')
}

/** 归一输入。 */
function normalizeDispatchInput(raw: DispatchTaskInput): DispatchTaskInput {
  const toWindow = typeof raw.toWindow === 'string' ? raw.toWindow.trim() : ''
  if (toWindow.length === 0) {
    reject('WINDOW_RUN_NOT_FOUND', 'window_dispatch 未执行：to_window 必填')
  }
  const seedText = typeof raw.seedText === 'string' ? raw.seedText : ''
  if (seedText.trim().length === 0) {
    reject('WINDOW_SEED_REQUIRED', 'window_dispatch 未执行：seed_text 不能为空或纯空白')
  }
  return {
    toWindow,
    seedText,
    ...(raw.outputSchema === undefined ? {} : { outputSchema: raw.outputSchema }),
    ...(raw.resultRequired === undefined ? {} : { resultRequired: raw.resultRequired === true }),
  }
}

/** 向已有 child 投递新任务。 */
export async function dispatchTask(
  deps: WindowDeps,
  raw: DispatchTaskInput,
  exec: unknown,
): Promise<DispatchTaskValue> {
  const input = normalizeDispatchInput(raw)
  assertSchemaContract(deps, { scenario: 'branch', ...(input.outputSchema === undefined ? {} : { outputSchema: input.outputSchema }), ...(input.resultRequired === undefined ? {} : { resultRequired: input.resultRequired }) })
  const origin = deps.resolveWindowKey(exec)
  deps.requireLiveDriver(exec)

  if (input.toWindow === origin) {
    reject('WINDOW_RUN_FORBIDDEN', 'window_dispatch 未执行：不能把任务派给本窗口')
  }
  const store = deps.runStore
  if (store === undefined || !store.available()) {
    reject('WINDOW_RUN_STORE_UNAVAILABLE', 'window_dispatch 未执行：运行记录存储不可用')
  }
  const delivery = deps.seedDelivery
  if (delivery === undefined) {
    reject('WINDOW_OPEN_UNAVAILABLE', 'window_dispatch 未执行：未装配跨窗口投递能力')
  }

  return await store.withLock(input.toWindow, async () => {
    const runs = await store.list()
    const related = runs.some((run) => run.originSessionId === origin && run.childSessionId === input.toWindow)
    if (!related) {
      reject(
        'WINDOW_RUN_FORBIDDEN',
        `本窗口与 ${input.toWindow} 没有委派关系，不能给它派任务；continuation 接管窗口也不接受再次派单`,
      )
    }
    const busy = runs.some(
      (run) => run.childSessionId === input.toWindow && (run.status === 'running' || run.status === 'pending'),
    )
    if (busy) {
      reject('WINDOW_CHILD_BUSY', `分支窗口 ${input.toWindow} 还有活动 run，完成后再派下一条`)
    }

    const runId = deps.newRunId()
    const now = deps.now()
    const run: RunRecord = {
      runId,
      scenario: 'branch',
      createdBy: 'dispatch',
      originSessionId: origin,
      childSessionId: input.toWindow,
      mode: 'fork',
      status: 'pending',
      callbackArmed: false,
      callback: { status: 'not_armed', attempts: 0 },
      ...(input.outputSchema === undefined ? {} : { outputSchema: input.outputSchema }),
      ...(input.resultRequired === undefined ? {} : { resultRequired: input.resultRequired }),
      lastActivityAt: now,
      createdAt: now,
      updatedAt: now,
    }
    await store.create(run)

    let delivered = false
    let deliveryReason: string | undefined
    let messageId: string | undefined
    try {
      const created = delivery.createMessage({
        text: buildDispatchSeedText(input.seedText, runId),
        kind: SEED_KIND,
        scenario: 'branch',
        runId,
      })
      messageId = created.messageId
      const sent = await delivery.deliver(input.toWindow, created.message)
      delivered = sent.delivered === true
      deliveryReason = sent.reason
    } catch (error: unknown) {
      delivered = false
      deliveryReason = reasonOf(error)
    }

    let updateError: string | undefined
    try {
      await store.update(runId, {
        status: delivered ? 'running' : 'seed_failed',
        callbackArmed: delivered,
        callback: delivered
          ? { status: 'pending', callbackId: `result-${runId}`, attempts: 0 }
          : { status: 'not_armed', attempts: 0 },
        ...(delivered && messageId !== undefined ? { seedMessageId: messageId } : {}),
        lastActivityAt: deps.now(),
        updatedAt: deps.now(),
      })
    } catch (error: unknown) {
      updateError = reasonOf(error)
    }

    const success = delivered && updateError === undefined
    return {
      success,
      run_id: runId,
      to_window: input.toWindow,
      callback_policy: 'required',
      callback_armed: success,
      delivery: {
        delivered,
        kind: SEED_KIND,
        ...(deliveryReason === undefined ? {} : { reason: deliveryReason }),
        ...(updateError === undefined ? {} : { run_error: `运行记录更新失败：${updateError}` }),
      },
      degraded_note: success ? DEGRADED_NOTE : `${DEGRADED_NOTE} 本次追加任务未完整建立。`,
    }
  })
}
