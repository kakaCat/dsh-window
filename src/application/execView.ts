/**
 * exec 形状的唯一读取点。
 *
 * 宿主 `exec` 的结构（agent.session.header.cwd、signal）原先散落在
 * openWindow / topicLedger / waitRuns / inspectWindow 四处；宿主改形状时端口契约兜不住。
 * 现在只允许在这里读 exec，应用层其余位置一律调本模块。
 *
 * @module dsh-window/application/execView
 */

/** 取调用者会话的 cwd；拿不到返回 undefined（不猜、不回落宿主目录）。 */
export function execCwd(exec: unknown): string | undefined {
  const cwd = (exec as { agent?: { session?: { header?: { cwd?: unknown } } } } | undefined)
    ?.agent?.session?.header?.cwd
  return typeof cwd === 'string' && cwd.trim().length > 0 ? cwd : undefined
}

/** 取调用者传下来的取消信号；没有则 undefined。 */
export function execSignal(exec: unknown): AbortSignal | undefined {
  const signal = (exec as { signal?: unknown } | undefined)?.signal
  return signal instanceof AbortSignal ? signal : undefined
}
