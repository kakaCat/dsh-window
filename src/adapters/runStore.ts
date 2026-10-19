/**
 * branch 运行记录持久化：按需求的分层 JSON 目录落盘到
 * `$DSH_HOME/storages/dsh-window/runs/<runId>/run.json`。
 *
 * 单文件写入走同目录临时文件 + fsync + rename，保证崩溃后不会读到半截 JSON；
 * 目录和记录文件只给当前用户读写。
 *
 * @module dsh-window/adapters/runStore
 */
import { appendFile, mkdir, readFile, readdir, rename, stat, unlink } from 'node:fs/promises'
import { appendFileSync, readFileSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import type { RunAuditEvent, RunControlEvent, RunIndexRow, RunMessage, RunRecord, RunStorePort } from '../application/ports.js'
import { runIndexRowOf } from '../application/runIndex.js'
import { WindowError } from '../shared/errors.js'
import { KeyedLock, writeJsonAtomic, writeJsonAtomicSync } from './atomicJson.js'

/** 单条 run 记录损坏（半截 JSON / 形状不符）：可隔离；其它 I/O 错误不属此类。 */
class CorruptRunRecord extends Error {}

/** 展开 `~` / `~/`；其余原样返回。 */
function expandHome(path: string): string {
  if (path === '~') return homedir()
  if (path.startsWith('~/') || path.startsWith('~\\')) return join(homedir(), path.slice(2))
  return path
}

/** 解析 DSH home：DSH_HOME 优先，其次 ~/.dsh。 */
export function resolveDshHome(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env['DSH_HOME']
  if (typeof configured === 'string' && configured.trim().length > 0) return resolve(expandHome(configured.trim()))
  return join(homedir(), '.dsh')
}

/** 插件数据根：与 Topic Ledger 阶段 4 的设计保持同一根。 */
export function resolveDataRoot(env: NodeJS.ProcessEnv = process.env): string {
  return join(resolveDshHome(env), 'storages', 'dsh-window')
}

/** runId 必须能安全作为目录名；模型不能传物理路径。 */
const RUN_ID_RE = /^[A-Za-z0-9_-]+$/

/** RunListIndex 写入的串行 key；与 run 级锁区分。 */
const INDEX_LOCK = '__runIndex__'

/** 把 run 记录投影成 RunListIndex 一行。 */
const toIndexRow = runIndexRowOf

/** 基于文件系统的 RunStore。 */
export class FsRunStore implements RunStorePort {
  private readonly root: string
  private readonly locks = new KeyedLock()
  private readonly watchers = new Set<() => void>()

  constructor(options: { root?: string } = {}) {
    this.root = options.root ?? resolveDataRoot()
  }

  /** 当前实现总是可用；后续若改为可选后端，可在这里探测。 */
  available(): boolean {
    return true
  }

  /** 返回某个 run 的规范路径，供测试与诊断使用。 */
  pathOf(runId: string): string {
    if (!RUN_ID_RE.test(runId)) throw new WindowError('WINDOW_INVALID_INPUT', `runId 非法，不能作为路径段：${String(runId).slice(0, 80)}`)
    return join(this.root, 'runs', runId, 'run.json')
  }

  /** RunListIndex 路径。 */
  indexPath(): string {
    return join(this.root, 'runs', 'index.json')
  }

  /** 某 run 的控制日志路径。 */
  controlPathOf(runId: string): string {
    if (!RUN_ID_RE.test(runId)) throw new WindowError('WINDOW_INVALID_INPUT', `runId 非法，不能作为路径段：${String(runId).slice(0, 80)}`)
    return join(this.root, 'runs', runId, 'control.jsonl')
  }

  async create(record: RunRecord): Promise<void> {
    await writeJsonAtomic(this.pathOf(record.runId), record)
    await this.updateIndexWith(record)
    this.notify()
  }

  async update(runId: string, patch: Partial<RunRecord>): Promise<void> {
    const current = await this.get(runId)
    if (current === undefined) throw new Error(`run 不存在：${runId}`)
    const merged = { ...current, ...patch }
    await writeJsonAtomic(this.pathOf(runId), merged)
    await this.updateIndexWith(merged)
    this.notify()
  }

  async get(runId: string): Promise<RunRecord | undefined> {
    const path = this.pathOf(runId)
    let text: string
    try {
      text = await readFile(path, 'utf8')
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
      throw error
    }
    let raw: unknown
    try {
      raw = JSON.parse(text) as unknown
    } catch (error: unknown) {
      throw new CorruptRunRecord(`run 记录不是合法 JSON：${runId}（${error instanceof Error ? error.message : String(error)}）`)
    }
    if (raw === null || typeof raw !== 'object') throw new CorruptRunRecord(`run 记录不是对象：${runId}`)
    // 形状校验：缺必需字段的合法 JSON 不是 RunRecord，按损坏处理（否则 NaN 比较等会流入用例）。
    const candidate = raw as Partial<RunRecord>
    if (
      typeof candidate.runId !== 'string'
      || typeof candidate.status !== 'string'
      || typeof candidate.originSessionId !== 'string'
      || typeof candidate.childSessionId !== 'string'
      || typeof candidate.createdAt !== 'number'
      || typeof candidate.updatedAt !== 'number'
    ) {
      throw new CorruptRunRecord(`run 记录缺少必需字段：${runId}`)
    }
    return raw as RunRecord
  }

  /** 列出 runs/ 下的全部记录；缺失目录表示空。run.json 是权威事实源。 */
  async list(): Promise<RunRecord[]> {
    let entries: string[]
    try {
      entries = await readdir(join(this.root, 'runs'))
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw error
    }
    const records: RunRecord[] = []
    for (const runId of entries) {
      if (!RUN_ID_RE.test(runId)) continue
      try {
        const record = await this.get(runId)
        if (record !== undefined) records.push(record)
      } catch (error: unknown) {
        // 只有「解析/形状损坏」才隔离改名；EACCES/EIO 等真实 I/O 错误必须如实抛出，
        // 绝不能把一个权限问题当成损坏、把合法记录改名搬走（那是毁数据）。
        if (!(error instanceof CorruptRunRecord)) throw error
        const broken = this.pathOf(runId)
        await rename(broken, join(dirname(broken), `run.corrupt-${Date.now()}.json`)).catch(() => undefined)
      }
    }
    return records
  }

  /** 读 RunListIndex；缺失/为空/陈旧（与 run.json 不符）时按 run.json 重建。 */
  async listIndex(): Promise<RunIndexRow[]> {
    const rows = await this.readIndexRaw()
    if (await this.indexIsFresh(rows)) return rows
    return await this.rebuildIndex()
  }

  /**
   * 索引新鲜度：run.json 与索引是两次独立写，中间崩溃会让索引永久陈旧。
   *
   * 判定口径（不按目录计数，因为损坏隔离/删除只移除 run.json、目录仍在）：
   * 1) 每条索引行的 run.json 都存在；
   * 2) 每个**有 run.json** 的目录都在索引里（新增 run 不会漏）；
   * 3) 没有 run.json 比索引文件更新。
   */
  private async indexIsFresh(rows: RunIndexRow[]): Promise<boolean> {
    const runsDir = join(this.root, 'runs')
    let entries: string[]
    try {
      entries = await readdir(runsDir)
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return rows.length === 0
      throw error
    }
    let indexStat
    try {
      indexStat = await stat(this.indexPath())
    } catch {
      return false
    }
    const indexed = new Set(rows.map((row) => row.runId))
    for (const row of rows) {
      try {
        const runStat = await stat(this.pathOf(row.runId))
        if (runStat.mtimeMs > indexStat.mtimeMs) return false
      } catch {
        return false // 索引行对应的 run.json 已不在：陈旧
      }
    }
    for (const entry of entries) {
      if (!RUN_ID_RE.test(entry) || indexed.has(entry)) continue
      // 目录存在但没有 run.json（损坏隔离/删除后残留）不算 run；
      // **只要还有 run.json 就说明索引漏了它**——不能只比 mtime，否则索引被清空/损坏后
      // 旧 run 会因 mtime 更早而永久缺席（对抗验证实测复现）。
      try {
        await stat(this.pathOf(entry))
        return false
      } catch {
        continue
      }
    }
    return true
  }

  /** 从 run.json 重建 RunListIndex；写索引走 INDEX_LOCK，避免与增量更新互相覆盖。 */
  async rebuildIndex(): Promise<RunIndexRow[]> {
    const rows = (await this.list()).map(toIndexRow)
    await this.withIndexLock(async () => {
      await this.writeIndex(rows)
    })
    return rows
  }

  /** 追加一条控制事件到 control.jsonl（append-only）。 */
  async appendControl(runId: string, event: RunControlEvent): Promise<void> {
    await this.appendLine(this.controlPathOf(runId), event)
  }

  /** 读取某 run 的控制事件；文件缺失表示空。 */
  async readControl(runId: string): Promise<RunControlEvent[]> {
    return await this.readJsonl<RunControlEvent>(this.controlPathOf(runId))
  }

  /** 某 run 的 guidance 留痕路径（§7.5 RunMessage）。 */
  messagePathOf(runId: string): string {
    if (!RUN_ID_RE.test(runId)) throw new Error(`runId 非法，不能作为路径段：${runId}`)
    return join(this.root, 'runs', runId, 'messages.jsonl')
  }

  /** 插件根的只读访问留痕路径（§8）。 */
  auditPath(): string {
    return join(this.root, 'audit.jsonl')
  }

  /** 追加一条 guidance 留痕。 */
  async appendMessage(runId: string, message: RunMessage): Promise<void> {
    await this.appendLine(this.messagePathOf(runId), message)
  }

  /** 读取某 run 的 guidance 留痕。 */
  async readMessages(runId: string): Promise<RunMessage[]> {
    return await this.readJsonl<RunMessage>(this.messagePathOf(runId))
  }

  /** 追加一条只读访问留痕。 */
  async appendAudit(event: RunAuditEvent): Promise<void> {
    await this.appendLine(this.auditPath(), event)
  }

  /** 读取只读访问留痕。 */
  async readAudit(): Promise<RunAuditEvent[]> {
    return await this.readJsonl<RunAuditEvent>(this.auditPath())
  }

  /** append-only 追加一行 JSON。 */
  private async appendLine(path: string, value: unknown): Promise<void> {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 })
    await appendFile(path, `${JSON.stringify(value)}\n`, { encoding: 'utf8', mode: 0o600 })
  }

  /**
   * 读取 JSONL；文件缺失表示空。
   *
   * append-only 文件末尾可能被硬杀/断电截成半行：逐行容错，跳过不可解析的行而**不丢整份留痕**
   * （半行会被后续 append 自然接续或被 cleanup 处理，但绝不能让它把整段历史变成"无留痕"）。
   */
  private async readJsonl<T>(path: string): Promise<T[]> {
    let text: string
    try {
      text = await readFile(path, 'utf8')
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw error
    }
    const values: T[] = []
    for (const line of text.split('\n')) {
      if (line.trim().length === 0) continue
      let parsed: unknown
      try {
        parsed = JSON.parse(line) as unknown
      } catch {
        continue // 半截行：跳过，保留其余留痕
      }
      if (parsed !== null && typeof parsed === 'object') values.push(parsed as T)
    }
    return values
  }

  /** 同进程内按 runId 串行化 read-modify-write。 */
  async withLock<T>(runId: string, operation: () => Promise<T>): Promise<T> {
    if (!RUN_ID_RE.test(runId)) throw new Error(`runId 非法，不能作为路径段：${runId}`)
    return await this.locks.run(runId, operation)
  }

  /** 清理一个 run 的存储（测试/运维用，不供模型调用）。 */
  async remove(runId: string): Promise<void> {
    await unlink(this.pathOf(runId)).catch(() => undefined)
    await unlink(this.controlPathOf(runId)).catch(() => undefined)
    await unlink(this.messagePathOf(runId)).catch(() => undefined)
    await this.withIndexLock(async () => {
      const rows = await this.readIndexRaw()
      await this.writeIndex(rows.filter((row) => row.runId !== runId))
    })
    this.notify()
  }

  /** 订阅 run 变更；返回取消订阅。 */
  watch(listener: () => void): () => void {
    this.watchers.add(listener)
    return () => {
      this.watchers.delete(listener)
    }
  }

  /** 等待内部待排空写入（RunListIndex）落定。 */
  async settle(): Promise<void> {
    // 必须等**所有** key 的排队写入（含 per-run 锁），否则 drain 回执的「已落定」不成立。
    await this.locks.settle()
  }

  /** 清理原子写遗留的 `.tmp` 半截文件；返回清理数量。 */
  async cleanup(): Promise<number> {
    let removed = 0
    const scan = async (directory: string): Promise<void> => {
      let entries: string[]
      try {
        entries = await readdir(directory)
      } catch {
        return
      }
      for (const entry of entries) {
        if (entry.startsWith('.') && entry.endsWith('.tmp')) {
          await unlink(join(directory, entry)).catch(() => undefined)
          removed += 1
        }
      }
    }
    const runsDir = join(this.root, 'runs')
    await scan(runsDir)
    let runDirs: string[]
    try {
      runDirs = await readdir(runsDir)
    } catch {
      return removed
    }
    for (const runId of runDirs) {
      if (RUN_ID_RE.test(runId)) await scan(join(runsDir, runId))
    }
    return removed
  }

  /**
   * 卸载时的同步 best-effort 排空（FR-19）：宿主退出可能不 await 异步 disposer，
   * 所以这里用同步 fs 先把 drained 状态与 drain 控制记录落盘，再重建索引。
   * 返回本次处理的 runId；失败按 run 粒度跳过，不抛。
   */
  drainActiveRunsSync(reason: string, at: number): string[] {
    const runsDir = join(this.root, 'runs')
    let entries: string[]
    try {
      entries = readdirSync(runsDir)
    } catch {
      return []
    }
    const done: string[] = []
    for (const runId of entries) {
      if (!RUN_ID_RE.test(runId)) continue
      const runPath = join(runsDir, runId, 'run.json')
      try {
        const record = JSON.parse(readFileSync(runPath, 'utf8')) as RunRecord
        if (record.status !== 'pending' && record.status !== 'running') continue
        if (record.lifecycle?.state === 'drained') continue
        const next: RunRecord = {
          ...record,
          lifecycle: { state: 'drained', reason, at },
          lastActivityAt: at,
          updatedAt: at,
        }
        // 与异步路径同一纪律：temp+rename，不留半截 JSON（宿主退出可能硬杀）。
        writeJsonAtomicSync(runPath, next)
        const event: RunControlEvent = {
          eventId: `drain-${runId}-${at}`,
          runId,
          kind: 'drain',
          actorSessionId: 'dsh-window-lifecycle',
          reason,
          at,
          result: 'accepted',
        }
        appendFileSync(join(runsDir, runId, 'control.jsonl'), `${JSON.stringify(event)}\n`, { mode: 0o600 })
        done.push(runId)
      } catch {
        // 单个 run 失败不阻断其余 run 的排空。
      }
    }
    if (done.length > 0) {
      // 同步重建索引，避免下次启动读到陈旧投影。
      const rows: RunIndexRow[] = []
      for (const runId of entries) {
        if (!RUN_ID_RE.test(runId)) continue
        try {
          rows.push(runIndexRowOf(JSON.parse(readFileSync(join(runsDir, runId, 'run.json'), 'utf8')) as RunRecord))
        } catch {
          // 跳过损坏/半截记录。
        }
      }
      try {
        writeJsonAtomicSync(join(runsDir, 'index.json'), rows)
      } catch {
        // 索引只是投影；run.json 已是事实源。
      }
    }
    return done
  }

  private notify(): void {
    for (const listener of [...this.watchers]) {
      try {
        listener()
      } catch {
        // 订阅者异常不得影响存储写入。
      }
    }
  }

  /** 读 index.json 原始行；缺失/损坏返回空数组（由重建兜底）。 */
  private async readIndexRaw(): Promise<RunIndexRow[]> {
    let text: string
    try {
      text = await readFile(this.indexPath(), 'utf8')
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw error
    }
    try {
      const parsed = JSON.parse(text) as unknown
      if (!Array.isArray(parsed)) return []
      const rows: RunIndexRow[] = []
      for (const row of parsed) {
        if (row === null || typeof row !== 'object') continue
        const candidate = row as Partial<RunIndexRow>
        if (typeof candidate.runId !== 'string') continue
        // 旧记录可能缺 lastActivityAt：按“缺省按 updatedAt 处理”的口径补齐，
        // 保证投影字段恒为数字（window_list 的 last_activity_at 声明为 number）。
        rows.push({
          ...candidate,
          lastActivityAt: candidate.lastActivityAt ?? candidate.updatedAt ?? candidate.createdAt ?? 0,
        } as RunIndexRow)
      }
      return rows
    } catch {
      return []
    }
  }

  private async writeIndex(rows: RunIndexRow[]): Promise<void> {
    await writeJsonAtomic(this.indexPath(), rows)
  }

  private async updateIndexWith(record: RunRecord): Promise<void> {
    await this.withIndexLock(async () => {
      const rows = await this.readIndexRaw()
      const next = rows.filter((row) => row.runId !== record.runId)
      next.push(toIndexRow(record))
      await this.writeIndex(next)
    })
  }

  private async withIndexLock<T>(operation: () => Promise<T>): Promise<T> {
    return await this.locks.run(INDEX_LOCK, operation)
  }
}
