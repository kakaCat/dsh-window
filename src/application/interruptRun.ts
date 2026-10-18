/**
 * `window_interrupt` 用例：origin 中断 child 当前轮，或取消整条 run。
 *
 * - mode='turn'：只取消当前轮，run 保持 running；
 * - mode='run'：取消当前轮 + run 置 cancelled + callback=not_requested；
 * 两者都只允许 run 的 origin 调用，且 origin 主动取消不回调自己。
 *
 * @module dsh-window/application/interruptRun
 */
import { reasonOf, reject } from '../shared/errors.js'
import type {
  InterruptRunInput,
  InterruptRunValue,
  RunCallbackState,
  RunControlEvent,
  RunRecord,
  RunResult,
  WindowDeps,
} from './ports.js'

const MAX_REASON_CHARS = 500

function callbackOf(run: RunRecord): RunCallbackState {
  return run.callback ?? { status: 'not_armed', attempts: 0 }
}

/** 归一输入。 */
function normalize(raw: InterruptRunInput): { runId: string; mode: 'turn' | 'run'; reason?: string } {
  const runId = typeof raw.runId === 'string' ? raw.runId.trim() : ''
  if (runId.length === 0) reject('WINDOW_INVALID_INPUT', 'window_interrupt 未执行：run_id 必填')
  if (raw.mode !== 'turn' && raw.mode !== 'run') {
    reject('WINDOW_INVALID_INPUT', `window_interrupt 未执行：mode 只能是 turn 或 run（${String(raw.mode)}）`)
  }
  const reason = typeof raw.reason === 'string' && raw.reason.trim().length > 0 ? raw.reason.trim() : undefined
  if (reason !== undefined && reason.length > MAX_REASON_CHARS) {
    reject('WINDOW_INVALID_INPUT', `window_interrupt 未执行：reason 超过 ${MAX_REASON_CHARS} 字符`)
  }
  return { runId, mode: raw.mode, ...(reason === undefined ? {} : { reason }) }
}

/** 追加控制事件；失败不让中断结果反转，但要在 note 里说。 */
async function appendControl(
  deps: WindowDeps,
  event: RunControlEvent,
): Promise<string | undefined> {
  if (deps.runStore?.appendControl === undefined) return undefined
  try {
    await deps.runStore.appendControl(event.runId, event)
    return undefined
  } catch (error: unknown) {
    return `控制留痕失败：${reasonOf(error)}`
  }
}

/** 中断或取消一个 branch run。 */
export async function interruptRun(
  deps: WindowDeps,
  raw: InterruptRunInput,
  exec: unknown,
): Promise<InterruptRunValue> {
  const input = normalize(raw)
  const caller = deps.resolveWindowKey(exec)
  deps.requireLiveDriver(exec)
  const store = deps.runStore
  if (store === undefined || !store.available()) {
    reject('WINDOW_RUN_STORE_UNAVAILABLE', 'window_interrupt 未执行：运行记录存储不可用')
  }

  return await store.withLock(input.runId, async () => {
    const run = await store.get(input.runId)
    if (run === undefined) reject('WINDOW_RUN_NOT_FOUND', `run 不存在：${input.runId}`)
    if (caller !== run.originSessionId) {
      reject('WINDOW_RUN_FORBIDDEN', `只有 run ${run.runId} 的 origin（${run.originSessionId}）可以中断/取消它`)
    }

    // mode='run' 幂等：同 origin 重复取消返回既有终态。
    if (
      input.mode === 'run'
      && run.status === 'cancelled'
      && run.result?.status === 'cancelled'
      && run.result.completedBy === caller
    ) {
      return {
        accepted: true,
        run_id: run.runId,
        mode: 'run',
        run_status: run.status,
        result: run.result,
        callback: callbackOf(run),
        note: '该 run 已由本窗口取消（幂等返回，未重复中断 child）',
      }
    }
    if (run.status !== 'running') {
      reject('WINDOW_RUN_NOT_ACTIVE', `run ${run.runId} 不是活动状态（status=${run.status}），不能中断`)
    }

    const reason = input.reason ?? 'dsh-window-origin-interrupt'
    const control = deps.agentControl

    if (input.mode === 'turn') {
      if (control === undefined) {
        reject('WINDOW_INTERRUPT_FAILED', 'window_interrupt 未执行：本宿主未装配 agent 中断能力')
      }
      const outcome = await control.cancelTurn(run.childSessionId, reason)
      const result: RunControlEvent['result'] = outcome.accepted ? 'accepted' : 'target-offline'
      const controlNote = await appendControl(deps, {
        eventId: deps.newRunId(),
        runId: run.runId,
        kind: 'interrupt-turn',
        actorSessionId: caller,
        reason,
        at: deps.now(),
        result,
      })
      if (outcome.accepted) {
        try {
          await store.update(run.runId, { lastActivityAt: deps.now(), updatedAt: deps.now() })
        } catch {
          // lastActivityAt 只是投影输入。
        }
      }
      return {
        accepted: outcome.accepted,
        run_id: run.runId,
        mode: 'turn',
        run_status: run.status,
        callback: callbackOf(run),
        note: outcome.accepted
          ? '已请求取消 child 当前轮次；run 仍保持 active，收件箱与后续引导保留'
          : `未执行中断：${outcome.reason ?? '原因未知'}（run 仍保持 active）${controlNote === undefined ? '' : `；${controlNote}`}`,
      }
    }

    // mode='run'：先尽力取消 child 当前轮，再落 run 终态。
    const cancelOutcome = control === undefined
      ? { accepted: false, reason: '未装配 agent 中断能力' }
      : await control.cancelTurn(run.childSessionId, reason)
    const at = deps.now()
    const result: RunResult = {
      status: 'cancelled',
      content: input.reason ?? 'origin cancelled the run',
      completedAt: at,
      completedBy: caller,
    }
    const callback: RunCallbackState = { status: 'not_requested', attempts: 0 }
    await store.update(run.runId, {
      status: 'cancelled',
      result,
      callback,
      callbackArmed: false,
      // 与 stop 路径同口径：终态也写 lifecycle（stopped = origin 显式取消）。
      lifecycle: { state: 'stopped', reason: `origin interrupt：${reason}`, at },
      lastActivityAt: at,
      updatedAt: at,
    })
    // 与 complete/stop/orphan 同口径：该 run 持有的协作占用随终态释放（失败容忍）。
    if (run.topicId !== undefined) {
      try {
        await deps.topicStore?.releaseClaimsForRun(run.runId, { at, reason: 'run 已被 origin 取消，自动释放占用' })
      } catch {
        // 占用是软约束，历史保留。
      }
    }
    const controlNote = await appendControl(deps, {
      eventId: deps.newRunId(),
      runId: run.runId,
      kind: 'interrupt-run',
      actorSessionId: caller,
      reason: cancelOutcome.accepted || cancelOutcome.reason === undefined
        ? reason
        : `${reason}（child: ${cancelOutcome.reason}）`,
      at,
      result: cancelOutcome.accepted ? 'accepted' : 'target-offline',
    })
    return {
      accepted: true,
      run_id: run.runId,
      mode: 'run',
      run_status: 'cancelled',
      result,
      callback,
      note: cancelOutcome.accepted
        ? 'run 已取消并落 cancelled；child 当前轮已请求停止，callback=not_requested'
        : `run 已落 cancelled；child 离线或不可中断（${cancelOutcome.reason ?? '原因未知'}），callback=not_requested${controlNote === undefined ? '' : `；${controlNote}`}`,
    }
  })
}
