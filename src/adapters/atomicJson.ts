/**
 * 存储底座：单文件原子写与按 key 串行锁。
 *
 * run store（`runs/`）与 Topic Ledger（`projects/`）共用这一份实现，
 * 不各自再写一套临时文件/锁逻辑：
 *
 * - 单文件写入 = 同目录隐藏临时文件 → fsync → rename → fsync 目录，
 *   崩溃后不会读到半截 JSON；临时文件只出现在目标目录内，不写 /tmp；
 * - 目录与文件默认只给当前用户读写（目录 0700、文件 0600）；
 * - 按 key 串行锁把同进程内的 read-modify-write 排成队，key 的尾巴空了自动释放。
 *
 * @module dsh-window/adapters/atomicJson
 */
import { randomUUID } from 'node:crypto'
import { mkdir, open, rename } from 'node:fs/promises'
import { closeSync, fsyncSync, mkdirSync, openSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

/** 单文件原子写：写同目录临时文件 → fsync → rename → fsync 目录。 */
export async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  const temp = join(dirname(path), `.${randomUUID()}.tmp`)
  const handle = await open(temp, 'w', 0o600)
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, 'utf8')
    await handle.sync()
  } finally {
    await handle.close()
  }
  await rename(temp, path)
  try {
    const directory = await open(dirname(path), 'r')
    try {
      await directory.sync()
    } finally {
      await directory.close()
    }
  } catch {
    // Windows 不允许打开目录句柄；文件已 rename 成功，恢复一致性交给文件本身。
  }
}

/**
 * 单文件原子写的同步版（卸载路径用）：宿主退出不 await 异步 disposer，
 * 同步写才能最大化 drain 记录的落地概率；仍走 temp+rename，不留半截 JSON。
 */
export function writeJsonAtomicSync(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  const temp = join(dirname(path), `.${randomUUID()}.tmp`)
  const handle = openSync(temp, 'w', 0o600)
  try {
    writeFileSync(handle, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
    fsyncSync(handle)
  } finally {
    closeSync(handle)
  }
  renameSync(temp, path)
  try {
    // 与异步版同口径：fsync 目录，保证断电后该 rename 自身也持久（drain 是硬退出保命路径）。
    const directory = openSync(dirname(path), 'r')
    try {
      fsyncSync(directory)
    } finally {
      closeSync(directory)
    }
  } catch {
    // Windows 不允许打开目录句柄；文件已 rename 成功。
  }
}

/** 按 key 串行化的读改写锁（同进程内）；不同 key 互不阻塞。 */
export class KeyedLock {
  private readonly tails = new Map<string, Promise<unknown>>()

  /** 把一段异步操作排到该 key 的队尾，并返回它自己的结果。 */
  run<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(key) ?? Promise.resolve()
    const result = previous.then(operation, operation)
    const tail = result.then(
      () => undefined,
      () => undefined,
    )
    this.tails.set(key, tail)
    void tail.then(() => {
      if (this.tails.get(key) === tail) this.tails.delete(key)
    })
    return result
  }

  /** 等待某个 key（或全部 key）已排队的操作落定；只等待不接受新结果。 */
  async settle(key?: string): Promise<void> {
    if (key !== undefined) {
      await this.tails.get(key)
      return
    }
    for (;;) {
      const tails = [...this.tails.values()]
      if (tails.length === 0) return
      await Promise.all(tails)
      if (this.tails.size === 0) return
    }
  }
}
