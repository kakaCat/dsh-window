import { describe, expect, it, vi } from 'vitest'
import { sendGuidance } from '../src/application/sendGuidance.js'
import type {
  AgentControlPort,
  RunControlEvent,
  RunRecord,
  RunStorePort,
  SeedDeliveryPort,
  WindowDeps,
} from '../src/application/ports.js'

const ORIGIN = 'session-origin'
const CHILD = 'session-child'

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

class MemoryRunStore implements RunStorePort {
  readonly records = new Map<string, RunRecord>()
  readonly controls: RunControlEvent[] = []

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
}

function makeDelivery(): { port: SeedDeliveryPort; messages: { kind?: string; runId?: string; text?: string }[] } {
  const messages: { kind?: string; runId?: string; text?: string }[] = []
  const port: SeedDeliveryPort = {
    createMessage: (params) => {
      messages.push({ kind: params.kind, runId: params.runId, text: params.text })
      return { message: { id: params.messageId, content: [{ type: 'text', text: params.text }] }, messageId: params.messageId ?? 'm' }
    },
    deliver: async () => ({ delivered: true }),
  }
  return { port, messages }
}

function makeControl(over: Partial<AgentControlPort> = {}): AgentControlPort {
  return {
    steer: async () => ({ delivered: true, mode: 'steered' }),
    cancelTurn: async () => ({ accepted: true }),
    ...over,
  }
}

function deps(store: RunStorePort, delivery: SeedDeliveryPort, control: AgentControlPort): WindowDeps {
  let counter = 0
  return {
    resolveWindowKey: (exec) => (exec as { agent: { id: string } }).agent.id,
    requireLiveDriver: vi.fn(),
    seedDelivery: delivery,
    runStore: store,
    agentControl: control,
    now: () => 100,
    newRunId: () => `id-${counter++}`,
  }
}

function exec(id: string): unknown {
  return { agent: { id } }
}

describe('window_send', () => {
  it('running + 有委派关系：steer 投递、留痕、runStatus 不变', async () => {
    const store = new MemoryRunStore()
    await store.create(record())
    const { port, messages } = makeDelivery()
    const depsObj = deps(store, port, makeControl())

    const value = await sendGuidance(depsObj, { runId: 'run-1', message: '接口字段改了，别按旧约定做' }, exec(ORIGIN))

    expect(value).toMatchObject({ accepted: true, delivery: 'steered', run_id: 'run-1' })
    expect(messages[0]).toMatchObject({ kind: 'dsh-window-guidance', runId: 'run-1' })
    expect(messages[0]?.text).toContain('不是用户新指令')
    expect(await store.get('run-1')).toMatchObject({ status: 'running', lastActivityAt: 100 })
    expect(store.controls[0]).toMatchObject({ kind: 'send', result: 'accepted', actorSessionId: ORIGIN })
  })

  it('空闲 child 走 queued；target offline 如实失败', async () => {
    const store = new MemoryRunStore()
    await store.create(record())
    const { port } = makeDelivery()
    const queued = deps(store, port, makeControl({ steer: async () => ({ delivered: true, mode: 'queued' }) }))
    expect((await sendGuidance(queued, { runId: 'run-1', message: 'x' }, exec(ORIGIN))).delivery).toBe('queued')

    const offline = deps(store, port, makeControl({ steer: async () => ({ delivered: false, mode: 'failed', reason: '窗口不在线' }) }))
    const value = await sendGuidance(offline, { runId: 'run-1', message: 'x' }, exec(ORIGIN))
    expect(value.accepted).toBe(false)
    expect(store.controls.at(-1)).toMatchObject({ kind: 'send', result: 'target-offline' })
  })

  it('无活动 run / 非 origin / run_id 与 to_window 不一致分别拒绝', async () => {
    const store = new MemoryRunStore()
    await store.create(record({ status: 'completed', updatedAt: 2 }))
    const { port } = makeDelivery()
    const depsObj = deps(store, port, makeControl())

    await expect(sendGuidance(depsObj, { toWindow: CHILD, message: 'x' }, exec(ORIGIN)))
      .rejects.toMatchObject({ code: 'WINDOW_RUN_NOT_ACTIVE' })
    await expect(sendGuidance(depsObj, { runId: 'run-1', message: 'x' }, exec(ORIGIN)))
      .rejects.toMatchObject({ code: 'WINDOW_RUN_NOT_ACTIVE' })
    await expect(sendGuidance(depsObj, { runId: 'run-1', message: 'x' }, exec(CHILD)))
      .rejects.toMatchObject({ code: 'WINDOW_RUN_FORBIDDEN' })
    await expect(sendGuidance(depsObj, { runId: 'run-1', toWindow: 'other', message: 'x' }, exec(ORIGIN)))
      .rejects.toMatchObject({ code: 'WINDOW_INVALID_INPUT' })
  })

  it('to_window 定位唯一活动 run；多个活动 run 报 ambiguous；空 message 拒绝', async () => {
    const store = new MemoryRunStore()
    await store.create(record({ runId: 'run-1' }))
    const { port } = makeDelivery()
    const depsObj = deps(store, port, makeControl())
    expect((await sendGuidance(depsObj, { toWindow: CHILD, message: 'x' }, exec(ORIGIN))).run_id).toBe('run-1')

    await store.create(record({ runId: 'run-2', callback: { status: 'pending', callbackId: 'result-run-2', attempts: 0 } }))
    await expect(sendGuidance(depsObj, { toWindow: CHILD, message: 'x' }, exec(ORIGIN)))
      .rejects.toMatchObject({ code: 'WINDOW_RUN_AMBIGUOUS' })
    await expect(sendGuidance(depsObj, { runId: 'run-1', message: '   ' }, exec(ORIGIN)))
      .rejects.toMatchObject({ code: 'WINDOW_INVALID_INPUT' })
  })
})
