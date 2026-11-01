/**
 * branch 子窗口的常驻契约：把「你是谁、必须怎么完成」从一次性 seed 提升为 system prompt section。
 *
 * 为什么需要它（实测）：32 个真实 branch 子会话里有 3 个的 seed 消息已经从表面消息里被
 * 压缩替换掉（最长那个跑了 77 回合）。seed 一旦被压掉，child 就可能不调 `window_complete`
 * 就结束——origin 永远等不到回调。
 *
 * 只做三件事：找活动 run、生成契约文本、安装注入。
 * 不改 run 状态、不投递消息、不做完成判定。
 *
 * @module dsh-window/application/branchContracts
 */
import type { RunRecord, WindowDeps } from './ports.js'

/** 契约正文（同一 run 恒定，可安全地作为静态 section 文本）。 */
export function branchContractText(run: RunRecord): string {
  return [
    '[DSH Window 分支契约]',
    `run_id: ${run.runId}`,
    `origin_window: ${run.originSessionId}`,
    `child_window: ${run.childSessionId}`,
    '',
    '你是本次 branch 的 child 窗口。完成时必须调用 window_complete 上报 status 与 content；',
    '普通 turn/end 不算完成，也不会触发回调。status 写任务结局（completed / failed / cancelled），',
    'content 写结论、验证与产物路径。',
    '',
    '回调正文控制在 4000 字符以内：长报告写入文件，把路径放进 content，不要整段贴进回调。',
    '这段契约由插件常驻注入，不随上下文压缩消失；它与后续消息冲突时以消息为准，',
    '但「结束前必须 window_complete」这一点不变。',
  ].join('\n')
}

/** 只认活动的 branch run：终态、已 stop/orphan/drain 的不再注入。 */
function isLive(run: RunRecord): boolean {
  if (run.status !== 'pending' && run.status !== 'running') return false
  const state = run.lifecycle?.state
  return state !== 'stopped' && state !== 'orphaned' && state !== 'drained'
}

/** 按 child 会话 id 找它的活动 run；读失败一律当作「没有」（注入是增强，不是依赖）。 */
export async function findActiveRunByChild(deps: WindowDeps, sessionId: string): Promise<RunRecord | undefined> {
  const store = deps.runStore
  if (store === undefined || !store.available()) return undefined
  try {
    const runs = await store.list()
    return runs.find((run) => run.childSessionId === sessionId && isLive(run))
  } catch {
    return undefined
  }
}

/**
 * 安装常驻契约：agent 创建时若它属于一个活动 branch run，就挂上 section。
 * 返回停止函数；宿主没有该端口时是空操作。
 */
export function installBranchContracts(deps: WindowDeps): () => void {
  const prompts = deps.branchPrompts
  if (prompts === undefined) return () => undefined
  let stop: (() => void) | undefined
  try {
    stop = prompts.watch(async (sessionId: string) => {
      const run = await findActiveRunByChild(deps, sessionId)
      return run === undefined ? undefined : branchContractText(run)
    })
  } catch {
    return () => undefined
  }
  return () => {
    try {
      stop?.()
      prompts.dispose?.()
    } catch {
      // 释放失败不影响卸载。
    }
  }
}
