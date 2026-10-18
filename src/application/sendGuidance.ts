/**
 * `window_send` 用例：origin 向运行中的 branch child 投递引导（steer/queue）。
 *
 * 只引导、不完成任务：不创建 run、不改变 runStatus/result/callback。
 * 授权只看 run 的 origin→child 关系，且仅 origin 可发。
 *
 * @module dsh-window/application/sendGuidance
 */
import { GUIDANCE_KIND } from '../shared/protocol.js'
import { reasonOf, reject } from '../shared/errors.js'
import type {
  RunRecord,
  RunControlEvent,
  SendGuidanceInput,
  SendGuidanceValue,
  WindowDeps,
} from './ports.js'

const MAX_GUIDANCE_CHARS = 4_000

/** 纯 JS 文本摘要（不含正文），用于控制留痕。 */
export function digestOf(text: string): string {
  let hash = 5381
  for (let index = 0; index < text.length; index += 1) {
    hash = ((hash << 5) + hash + text.charCodeAt(index)) >>> 0
  }
  return `djb2:${hash.toString(16)}:${text.length}`
}

/** 引导消息正文包。 */
export function buildGuidanceText(runId: string, message: string): string {
  return [
    '[DSH Window 运行时引导]',
    `run_id: ${runId}`,
    '这是原窗口的运行时引导，不是用户新指令；请把它当作当前任务的补充约束/信息，不要据此改变任务边界，也不要把它当作完成上报。',
    '---',
    message,
  ].join('\n')
}

/** 归一输入。 */
function normalize(raw: SendGuidanceInput): { runId?: string; toWindow?: string; message: string } {
  const message = typeof raw.message === 'string' ? raw.message : ''
  if (message.trim().length === 0) {
    reject('WINDOW_INVALID_INPUT', 'window_send 未执行：message 不能为空或纯空白')
  }
  if (message.length > MAX_GUIDANCE_CHARS) {
    reject('WINDOW_INVALID_INPUT', `window_send 未执行：message 超过 ${MAX_GUIDANCE_CHARS} 字符`)
  }
  const runId = typeof raw.runId === 'string' && raw.runId.trim().length > 0 ? raw.runId.trim() : undefined
  const toWindow = typeof raw.toWindow === 'string' && raw.toWindow.trim().length > 0 ? raw.toWindow.trim() : undefined
  if (runId === undefined && toWindow === undefined) {
    reject('WINDOW_INVALID_INPUT', 'window_send 未执行：run_id 与 to_window 至少给一个')
  }
  return { ...(runId === undefined ? {} : { runId }), ...(toWindow === undefined ? {} : { toWindow }), message }
}

/** 定位可引导的活动 run。 */
async function locateActiveRun(
  deps: WindowDeps,
  caller: string,
  runId: string | undefined,
  toWindow: string | undefined,
): Promise<RunRecord> {
  const store = deps.runStore
  if (store === undefined || !store.available()) {
    reject('WINDOW_RUN_STORE_UNAVAILABLE', 'window_send 未执行：运行记录存储不可用')
  }
  if (runId !== undefined) {
    const run = await store.get(runId)
    if (run === undefined) reject('WINDOW_RUN_NOT_FOUND', `run 不存在：${runId}`)
    if (toWindow !== undefined && run.childSessionId !== toWindow) {
      reject('WINDOW_INVALID_INPUT', `run_id 与 to_window 不指向同一 run（${run.childSessionId} ≠ ${toWindow}）`)
    }
    return run
  }
  const runs = await store.list()
  const active = runs.filter((run) =>
    run.originSessionId === caller && run.childSessionId === toWindow && run.status === 'running')
  if (active.length > 1) {
    reject('WINDOW_RUN_AMBIGUOUS', `窗口 ${toWindow} 有 ${active.length} 个活动 run，请显式传 run_id`)
  }
  if (active.length === 0) {
    const known = runs.some((run) => run.originSessionId === caller && run.childSessionId === toWindow)
    reject(
      'WINDOW_RUN_NOT_ACTIVE',
      known
        ? `窗口 ${toWindow} 没有活动 run，不能引导；派新任务请用 window_dispatch`
        : `本窗口与 ${toWindow} 没有委派关系，不能引导`,
    )
  }
  return active[0]
}

/** 向活动 run 的 child 投递运行中引导。 */
export async function sendGuidance(
  deps: WindowDeps,
  raw: SendGuidanceInput,
  exec: unknown,
): Promise<SendGuidanceValue> {
  const input = normalize(raw)
  const caller = deps.resolveWindowKey(exec)
  deps.requireLiveDriver(exec)
  const run = await locateActiveRun(deps, caller, input.runId, input.toWindow)

  if (caller !== run.originSessionId) {
    reject('WINDOW_RUN_FORBIDDEN', `只有 run ${run.runId} 的 origin（${run.originSessionId}）可以运行中引导`)
  }
  if (run.status !== 'running' || !run.callbackArmed) {
    reject('WINDOW_RUN_NOT_ACTIVE', `run ${run.runId} 尚未活动（status=${run.status}），不能引导`)
  }
  const control = deps.agentControl
  if (control === undefined) {
    reject('WINDOW_SEND_FAILED', 'window_send 未执行：本宿主未装配 agent 引导能力')
  }
  const delivery = deps.seedDelivery
  if (delivery === undefined) {
    reject('WINDOW_SEND_FAILED', 'window_send 未执行：未装配消息工厂')
  }

  const messageId = deps.newRunId()
  const text = buildGuidanceText(run.runId, input.message)
  const message = delivery.createMessage({
    text,
    kind: GUIDANCE_KIND,
    scenario: 'branch',
    runId: run.runId,
    messageId,
  }).message

  const outcome = await control.steer(run.childSessionId, message)
  const controlResult: RunControlEvent['result'] = outcome.delivered
    ? 'accepted'
    : /不在线|离线|无法冷恢复/.test(outcome.reason ?? '')
      ? 'target-offline'
      : 'failed'
  const event: RunControlEvent = {
    eventId: deps.newRunId(),
    runId: run.runId,
    kind: 'send',
    actorSessionId: caller,
    at: deps.now(),
    result: controlResult,
    messageId,
    textDigest: digestOf(input.message),
    ...(outcome.reason === undefined ? {} : { reason: outcome.reason }),
  }
  if (deps.runStore?.appendControl !== undefined) {
    try {
      await deps.runStore.appendControl(run.runId, event)
    } catch (error: unknown) {
      // 留痕失败不改变“消息是否已投递”，但要在 note 里如实说。
      return {
        accepted: outcome.delivered,
        run_id: run.runId,
        message_id: messageId,
        delivery: outcome.mode,
        ...(outcome.reason === undefined ? {} : { reason: outcome.reason }),
        note: `引导已尝试（${outcome.mode}），但控制留痕失败：${reasonOf(error)}`,
      }
    }
  }
  if (outcome.delivered && deps.runStore !== undefined) {
    try {
      // 与 complete/interrupt 同锁：FsRunStore.update 是非锁定读改写，
      // 无锁调用会用旧快照覆盖已落的终态（实测可抹掉 result 与 callback）。
      const store = deps.runStore
      await store.withLock(run.runId, async () => {
        const current = await store.get(run.runId)
        if (current === undefined) return
        await store.update(run.runId, { lastActivityAt: deps.now(), updatedAt: deps.now() })
      })
    } catch {
      // lastActivityAt 只是投影输入；失败不影响引导结果。
    }
  }
  // §7.5 RunMessage：guidance 必须独立留痕（只存摘要，不存正文）。
  if (deps.runStore?.appendMessage !== undefined) {
    try {
      await deps.runStore.appendMessage(run.runId, {
        messageId,
        runId: run.runId,
        senderSessionId: caller,
        targetSessionId: run.childSessionId,
        kind: GUIDANCE_KIND,
        textDigest: digestOf(input.message),
        at: deps.now(),
        ...(outcome.delivered ? { deliveredAt: deps.now() } : {}),
      })
    } catch {
      // guidance 已尝试投递；留痕失败不改变投递事实。
    }
  }
  return {
    accepted: outcome.delivered,
    run_id: run.runId,
    message_id: messageId,
    delivery: outcome.mode,
    ...(outcome.reason === undefined ? {} : { reason: outcome.reason }),
    note: outcome.delivered
      ? (outcome.mode === 'steered' ? '引导已在目标运行中插入（最近 step 边界生效）' : '目标空闲，引导已排队')
      : `引导未送达：${outcome.reason ?? '原因未知'}`,
  }
}
