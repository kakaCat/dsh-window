/**
 * 测试用共享 RunStore fake：**带真实 per-run 串行锁**，读写都走 structuredClone。
 *
 * 为什么单独抽出来：早期各测试文件各写一份「withLock 直接执行」的假存储，等于没有锁，
 * 于是「并发完成 / 并发派单只允许一个成功」这类不变量在测试里根本不可能被证伪。
 * 这里按 FsRunStore 同款 Promise 链锁实现，让并发用例能测到真实互斥行为。
 *
 * @module dsh-window/test/helpers/memoryRunStore
 */
import type {
  RunAuditEvent,
  RunControlEvent,
  RunMessage,
  RunRecord,
  RunStorePort,
} from '../../src/application/ports.js'

/** 造一条 branch run 记录；测试里只覆盖关心的字段。 */
export function makeRunRecord(over: Partial<RunRecord> = {}): RunRecord {
  return {
    runId: 'run-1',
    scenario: 'branch',
    createdBy: 'open',
    originSessionId: 'session-origin',
    childSessionId: 'session-child',
    mode: 'fork',
    status: 'running',
    callbackArmed: true,
    callback: { status: 'pending', callbackId: 'result-run-1', attempts: 0 },
    lastActivityAt: 1,
    createdAt: 1,
    updatedAt: 1,
    ...over,
  }
}

/** 注入失败：按 update 调用序号（1 起）或只对某个 runId 生效。 */
export interface MemoryRunStoreOptions {
  /** 第 n 次 update 抛错（数字或序号数组）；用于驱动 callback=unknown 等落盘失败路径。 */
  failUpdateAt?: number | number[]
  /** 只在指定 runId 上应用 failUpdateAt。 */
  failUpdateFor?: string
  /** 是否记录每次 update 的 patch。 */
  recordUpdates?: boolean
}

/** 无文件系统、带锁的 RunStore；供并发与失败注入用例使用。 */
export class MemoryRunStore implements RunStorePort {
  readonly records = new Map<string, RunRecord>()
  readonly controls: RunControlEvent[] = []
  readonly messages: RunMessage[] = []
  readonly audits: RunAuditEvent[] = []
  readonly updates: { runId: string; patch: Partial<RunRecord> }[] = []

  private readonly locks = new Map<string, Promise<unknown>>()
  private updateCount = 0

  constructor(private readonly options: MemoryRunStoreOptions = {}) {}

  available(): boolean {
    return true
  }

  async create(record: RunRecord): Promise<void> {
    this.records.set(record.runId, structuredClone(record))
  }

  async update(runId: string, patch: Partial<RunRecord>): Promise<void> {
    this.updateCount += 1
    if (this.options.recordUpdates === true) this.updates.push({ runId, patch: structuredClone(patch) })
    if (this.shouldFailUpdate(runId)) {
      throw new Error(`注入的 update 失败（第 ${this.updateCount} 次，run ${runId}）`)
    }
    const current = this.records.get(runId)
    if (current === undefined) throw new Error(`missing run ${runId}`)
    this.records.set(runId, { ...structuredClone(current), ...structuredClone(patch) })
  }

  async get(runId: string): Promise<RunRecord | undefined> {
    const record = this.records.get(runId)
    return record === undefined ? undefined : structuredClone(record)
  }

  async list(): Promise<RunRecord[]> {
    return [...this.records.values()].map((record) => structuredClone(record))
  }

  /** 与 FsRunStore 同款：按 runId 串行化 read-modify-write。 */
  async withLock<T>(runId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(runId) ?? Promise.resolve()
    const result = previous.then(operation, operation)
    const tail = result.then(() => undefined, () => undefined)
    this.locks.set(runId, tail)
    void tail.then(() => {
      if (this.locks.get(runId) === tail) this.locks.delete(runId)
    })
    return result
  }

  async appendControl(_runId: string, event: RunControlEvent): Promise<void> {
    this.controls.push(structuredClone(event))
  }

  async readControl(_runId: string): Promise<RunControlEvent[]> {
    return this.controls.map((event) => structuredClone(event))
  }

  async appendMessage(_runId: string, message: RunMessage): Promise<void> {
    this.messages.push(structuredClone(message))
  }

  async readMessages(_runId: string): Promise<RunMessage[]> {
    return this.messages.map((message) => structuredClone(message))
  }

  async appendAudit(event: RunAuditEvent): Promise<void> {
    this.audits.push(structuredClone(event))
  }

  async readAudit(): Promise<RunAuditEvent[]> {
    return this.audits.map((event) => structuredClone(event))
  }

  private shouldFailUpdate(runId: string): boolean {
    if (this.options.failUpdateFor !== undefined && this.options.failUpdateFor !== runId) return false
    const failAt = this.options.failUpdateAt
    if (failAt === undefined) return false
    return Array.isArray(failAt) ? failAt.includes(this.updateCount) : failAt === this.updateCount
  }
}
