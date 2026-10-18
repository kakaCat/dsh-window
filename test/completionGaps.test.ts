import { describe, expect, it, vi } from 'vitest'
import { createWindowHostService } from '../src/hostService.js'
import { SessionWindowInspector } from '../src/adapters/sessionWindowInspector.js'
import { completeRun, getRunStatus } from '../src/application/completeRun.js'
import { inspectWindow } from '../src/application/inspectWindow.js'
import { drainLifecycle } from '../src/application/lifecycle.js'
import { listRuns } from '../src/application/listRuns.js'
import { resolveClaimLease } from '../src/application/topicLedger.js'
import { sendGuidance } from '../src/application/sendGuidance.js'
import { waitRuns } from '../src/application/waitRuns.js'
import type {
  AgentControlPort,
  RunAuditEvent,
  RunControlEvent,
  RunMessage,
  RunRecord,
  RunStorePort,
  SeedDeliveryPort,
  WindowDeps,
  WindowOpenerPort,
} from '../src/application/ports.js'

const ORIGIN = 'session-origin'
const CHILD = 'session-child'

class MemoryRunStore implements RunStorePort {
  readonly records = new Map<string, RunRecord>()
  readonly controls: RunControlEvent[] = []
  readonly messages: RunMessage[] = []
  readonly audits: RunAuditEvent[] = []
  available(): boolean {
    return true
  }
  async create(record: RunRecord): Promise<void> {
    this.records.set(record.runId, record)
  }
  async update(runId: string, patch: Partial<RunRecord>): Promise<void> {
    const current = this.records.get(runId)
    if (current === undefined) throw new Error(`missing ${runId}`)
    this.records.set(runId, { ...current, ...patch })
  }
  async get(runId: string): Promise<RunRecord | undefined> {
    return this.records.get(runId)
  }
  async list(): Promise<RunRecord[]> {
    return [...this.records.values()]
  }
  async withLock<T>(_runId: string, operation: () => Promise<T>): Promise<T> {
    return await operation()
  }
  async appendControl(_runId: string, event: RunControlEvent): Promise<void> {
    this.controls.push(event)
  }
  async readControl(_runId: string): Promise<RunControlEvent[]> {
    return this.controls
  }
  async appendMessage(_runId: string, message: RunMessage): Promise<void> {
    this.messages.push(message)
  }
  async readMessages(_runId: string): Promise<RunMessage[]> {
    return this.messages
  }
  async appendAudit(event: RunAuditEvent): Promise<void> {
    this.audits.push(event)
  }
}

function record(over: Partial<RunRecord> = {}): RunRecord {
  return {
    runId: 'run-1',
    scenario: 'branch',
    createdBy: 'open',
    originSessionId: ORIGIN,
    childSessionId: CHILD,
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

function opener(): WindowOpenerPort {
  return {
    available: () => true,
    fork: async (source) => ({ ok: true, windowKey: CHILD, parentSessionId: source }),
    create: async () => ({ ok: true, windowKey: CHILD }),
    resolveSourceProject: () => ({ cwd: '/ws' }),
    readProfile: async () => ({}),
    rename: async () => undefined,
    selectModel: async () => undefined,
  }
}

function delivery(): SeedDeliveryPort {
  return {
    createMessage: (params) => ({ message: { content: [] }, messageId: params.messageId ?? 'm-1' }),
    deliver: async () => ({ delivered: true }),
  }
}

function control(): AgentControlPort {
  return {
    steer: async () => ({ delivered: true, mode: 'steered' }),
    cancelTurn: async () => ({ accepted: true }),
  }
}

function deps(store: RunStorePort): WindowDeps {
  let counter = 0
  return {
    resolveWindowKey: (exec) => (exec as { agent: { id: string } }).agent.id,
    requireLiveDriver: vi.fn(),
    windowOpener: opener(),
    seedDelivery: delivery(),
    runStore: store,
    agentControl: control(),
    waitPollMs: 20,
    now: () => 100,
    newRunId: () => `id-${++counter}`,
  }
}

function exec(id: string): unknown {
  return { agent: { id } }
}

describe('需求文档补齐项', () => {
  it('window_wait 支持 status 过滤（FR-17）', async () => {
    const store = new MemoryRunStore()
    await store.create(record({ runId: 'run-a', status: 'running' }))
    await store.create(record({ runId: 'run-b', status: 'completed', updatedAt: 2 }))
    const value = await waitRuns(
      deps(store),
      { runIds: ['run-a', 'run-b'], status: ['completed'], mode: 'all', timeoutMs: 30 },
      exec(ORIGIN),
    )
    expect(value.runs.map((row) => row.run_id)).toEqual(['run-b'])
  })

  it('drain 写 RunLifecycle=drained 与控制记录（FR-19 / §7.5）', async () => {
    const store = new MemoryRunStore()
    await store.create(record())
    const result = await drainLifecycle(deps(store), 50)
    expect(result.drained).toBe(true)
    expect(await store.get('run-1')).toMatchObject({ lifecycle: { state: 'drained' } })
    expect(store.controls.at(-1)).toMatchObject({ kind: 'drain', result: 'accepted' })
  })

  it('window_send 写独立 RunMessage 留痕（§7.5）', async () => {
    const store = new MemoryRunStore()
    await store.create(record())
    const value = await sendGuidance(deps(store), { runId: 'run-1', message: '补充约束' }, exec(ORIGIN))
    expect(store.messages[0]).toMatchObject({
      messageId: value.message_id,
      runId: 'run-1',
      senderSessionId: ORIGIN,
      targetSessionId: CHILD,
      kind: 'dsh-window-guidance',
    })
    expect(store.messages[0]?.deliveredAt).toBe(100)
    expect(JSON.stringify(store.messages)).not.toContain('补充约束')
  })

  it('window_status 暴露 lifecycle / control / messages 供复盘（FR-16）', async () => {
    const store = new MemoryRunStore()
    await store.create(record({ lifecycle: { state: 'active', at: 1 } }))
    await sendGuidance(deps(store), { runId: 'run-1', message: 'x' }, exec(ORIGIN))
    const status = await getRunStatus(deps(store), 'run-1', exec(ORIGIN))
    expect(status.lifecycle).toMatchObject({ state: 'active' })
    expect(status.control?.map((event) => event.kind)).toContain('send')
    expect(status.messages?.[0]).toMatchObject({ kind: 'dsh-window-guidance' })
  })

  it('window_list 行带 lifecycle_state', async () => {
    const store = new MemoryRunStore()
    await store.create(record({ lifecycle: { state: 'orphaned', reason: 'origin 不在线', at: 2 } }))
    const value = await listRuns(deps(store), {}, exec(ORIGIN))
    expect(value.rows[0]).toMatchObject({ run_id: 'run-1', lifecycle_state: 'orphaned' })
  })

  it('window_inspect 写访问留痕，历史给工具名摘要（§8 / §6.12）', async () => {
    const store = new MemoryRunStore()
    await store.create(record())
    const port = {
      inspect: async (windowKey: string) => ({ windowKey, running: true }),
      history: async () => ({ items: [{ seq: 1, type: 'assistant/message', time: 1, role: 'assistant', text: 'hi' }] }),
    }
    await inspectWindow(
      { ...deps(store), windowInspect: port },
      { windowKey: CHILD, includeHistory: true },
      exec(ORIGIN),
    )
    expect(store.audits[0]).toMatchObject({ action: 'inspect', actorSessionId: ORIGIN, targetSessionId: CHILD, includeHistory: true })

    const service = {
      inspect: async () => ({ meta: { id: 's' }, inheritedEventCount: 1, events: [] }),
      page: async () => ({
        records: [{
          type: 'event',
          event: {
            type: 'assistant/message',
            seq: 1,
            time: 1,
            data: { message: { role: 'assistant', content: [{ type: 'tool-call', name: 'read_file' }, { type: 'text', text: '结论' }] } },
          },
        }],
        hasMore: false,
      }),
    }
    const inspector = new SessionWindowInspector(() => service)
    const history = await inspector.history('s', {})
    expect(history.items[0]?.text).toContain('[tool: read_file]')
    expect(history.items[0]?.text).toContain('结论')
  })

  it('claim 租约受配置上下限夹逼（§6.9）', () => {
    expect(resolveClaimLease(50, { minMs: 1_000, maxMs: 5_000 })).toBe(1_000)
    expect(resolveClaimLease(9_000, { minMs: 1_000, maxMs: 5_000 })).toBe(5_000)
    expect(resolveClaimLease(3_000, { minMs: 1_000, maxMs: 5_000 })).toBe(3_000)
  })

  it('Host Service 提供 §6.5 的完整方法面并可用', async () => {
    const store = new MemoryRunStore()
    const service = createWindowHostService(deps(store))
    for (const method of [
      'open', 'complete', 'get', 'retryCallback', 'list', 'inspect', 'dispatch',
      'send', 'interrupt', 'wait', 'topicCreate', 'topicJoin', 'topicGet',
      'topicAppend', 'topicClaim', 'reconcile', 'stopForOrigin',
    ]) {
      expect(typeof (service as unknown as Record<string, unknown>)[method], method).toBe('function')
    }

    const opened = await service.open({ scenario: 'branch', seedText: '做事' }, exec(ORIGIN))
    const listed = await service.list({}, exec(ORIGIN))
    expect(listed.total).toBe(1)
    const completed = await service.complete({ runId: opened['runId'] as string, status: 'completed', content: 'done' }, exec(CHILD))
    expect(completed.status).toBe('completed')
    const recon = await service.reconcile()
    expect(recon.scanned).toBe(1)
  })
})

// 保留 completeRun 引用，避免 lint 误判未使用（完成路径已在上面的 Host Service 用例覆盖）。
void completeRun
