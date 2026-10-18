import { describe, expect, it, vi } from 'vitest'
import { JsonSchemaGuard } from '../src/adapters/jsonSchemaGuard.js'
import { completeRun, getRunStatus } from '../src/application/completeRun.js'
import { dispatchTask } from '../src/application/dispatchTask.js'
import { openWindow } from '../src/application/openWindow.js'
import type {
  OpenWindowDeps,
  RunRecord,
  RunStorePort,
  SeedDeliveryPort,
  WindowDeps,
  WindowOpenerPort,
} from '../src/application/ports.js'

const ORIGIN = 'session-origin'
const CHILD = 'session-child'

const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['summary', 'files'],
  properties: {
    summary: { type: 'string' },
    files: { type: 'array', items: { type: 'string' } },
  },
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

class MemoryRunStore implements RunStorePort {
  readonly records = new Map<string, RunRecord>()
  private counter = 0

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

  nextId(): string {
    this.counter += 1
    return `run-${this.counter}`
  }
}

function makeOpener(): { opener: WindowOpenerPort; calls: { opens: number } } {
  const calls = { opens: 0 }
  const opener: WindowOpenerPort = {
    available: () => true,
    fork: async (source) => {
      calls.opens += 1
      return { ok: true, windowKey: CHILD, parentSessionId: source }
    },
    create: async () => {
      calls.opens += 1
      return { ok: true, windowKey: CHILD }
    },
    readProfile: async () => ({}),
    rename: async () => undefined,
    selectModel: async () => undefined,
  }
  return { opener, calls }
}

function makeDelivery(): { port: SeedDeliveryPort; deliveries: string[] } {
  const deliveries: string[] = []
  const port: SeedDeliveryPort = {
    createMessage: (params) => ({
      message: { content: [{ type: 'text', text: params.text }], source: { kind: params.kind } },
      messageId: params.messageId ?? 'message-1',
    }),
    deliver: async (windowKey) => {
      deliveries.push(windowKey)
      return { delivered: true }
    },
  }
  return { port, deliveries }
}

function openDeps(store: RunStorePort, opener: WindowOpenerPort, delivery: SeedDeliveryPort): OpenWindowDeps {
  let counter = 0
  return {
    resolveWindowKey: (exec) => (exec as { agent: { id: string } }).agent.id,
    requireLiveDriver: vi.fn(),
    windowOpener: opener,
    seedDelivery: delivery,
    runStore: store,
    schemaGuard: new JsonSchemaGuard(),
    now: () => 10,
    newRunId: () => `run-${++counter}`,
  }
}

function runDeps(store: RunStorePort, delivery: SeedDeliveryPort): WindowDeps {
  let counter = 0
  return {
    resolveWindowKey: (exec) => (exec as { agent: { id: string } }).agent.id,
    requireLiveDriver: vi.fn(),
    seedDelivery: delivery,
    runStore: store,
    schemaGuard: new JsonSchemaGuard(),
    now: () => 20,
    newRunId: () => `id-${++counter}`,
  }
}

function exec(id: string): unknown {
  return { agent: { id } }
}

describe('B4 结构化结果', () => {
  it('window_open：非法 schema / result_required 缺 schema / continuation 带 schema 都拒绝且不建会话', async () => {
    const store = new MemoryRunStore()
    const { opener, calls } = makeOpener()
    const { port } = makeDelivery()
    const deps = openDeps(store, opener, port)

    await expect(openWindow(deps, { scenario: 'branch', seedText: 'x', outputSchema: { type: 'array' } }, exec(ORIGIN)))
      .rejects.toMatchObject({ code: 'WINDOW_OUTPUT_SCHEMA_INVALID' })
    await expect(openWindow(deps, { scenario: 'branch', seedText: 'x', resultRequired: true }, exec(ORIGIN)))
      .rejects.toMatchObject({ code: 'WINDOW_OUTPUT_SCHEMA_INVALID' })
    await expect(openWindow(deps, { scenario: 'continuation', seedText: 'x', outputSchema: SCHEMA }, exec(ORIGIN)))
      .rejects.toMatchObject({ code: 'WINDOW_INVALID_INPUT' })
    expect(calls.opens).toBe(0)
    expect(store.records.size).toBe(0)
  })

  it('window_open：合法 schema 随 run 持久化', async () => {
    const store = new MemoryRunStore()
    const { opener } = makeOpener()
    const { port } = makeDelivery()
    const value = await openWindow(
      openDeps(store, opener, port),
      { scenario: 'branch', seedText: 'x', outputSchema: SCHEMA, resultRequired: true },
      exec(ORIGIN),
    )
    const run = await store.get(value.run_id!)
    expect(run?.outputSchema).toEqual(SCHEMA)
    expect(run?.resultRequired).toBe(true)
  })

  it('window_dispatch：合法 schema 落到新 run；非法 schema 拒绝且不建 run', async () => {
    const store = new MemoryRunStore()
    await store.create(record({ runId: 'run-prev', status: 'completed', updatedAt: 2 }))
    const { port } = makeDelivery()
    const deps = runDeps(store, port)

    const value = await dispatchTask(deps, { toWindow: CHILD, seedText: '再来一遍', outputSchema: SCHEMA }, exec(ORIGIN))
    expect((await store.get(value.run_id))?.outputSchema).toEqual(SCHEMA)

    await expect(dispatchTask(deps, { toWindow: CHILD, seedText: 'x', outputSchema: { type: 'string' } }, exec(ORIGIN)))
      .rejects.toMatchObject({ code: 'WINDOW_OUTPUT_SCHEMA_INVALID' })
    expect(store.records.size).toBe(2)
  })

  it('window_complete：缺 structured / 不符 schema 都在落盘前拒绝', async () => {
    const store = new MemoryRunStore()
    await store.create(record({ outputSchema: SCHEMA, resultRequired: true }))
    const { port, deliveries } = makeDelivery()
    const deps = runDeps(store, port)

    await expect(completeRun(deps, { runId: 'run-1', status: 'completed', content: '做完了' }, exec(CHILD)))
      .rejects.toMatchObject({ code: 'WINDOW_STRUCTURED_RESULT_REQUIRED' })
    await expect(completeRun(deps, {
      runId: 'run-1',
      status: 'completed',
      content: '做完了',
      structured: { summary: 'ok', files: [1, 2] },
    }, exec(CHILD))).rejects.toMatchObject({ code: 'WINDOW_STRUCTURED_RESULT_INVALID' })

    const run = await store.get('run-1')
    expect(run?.status).toBe('running')
    expect(run?.result).toBeUndefined()
    expect(deliveries).toHaveLength(0)
  })

  it('window_complete：符合 schema 才完成并回调；同结果幂等不重复回调', async () => {
    const store = new MemoryRunStore()
    await store.create(record({ outputSchema: SCHEMA, resultRequired: true }))
    const { port, deliveries } = makeDelivery()
    const deps = runDeps(store, port)

    const structured = { summary: '完成', files: ['a.ts'] }
    const value = await completeRun(deps, { runId: 'run-1', status: 'completed', content: '完成', structured }, exec(CHILD))
    expect(value.status).toBe('completed')
    expect(value.result.structured).toEqual(structured)
    expect(deliveries).toEqual([ORIGIN])

    const again = await completeRun(deps, { runId: 'run-1', status: 'completed', content: '完成', structured }, exec(CHILD))
    expect(again.callback.status).toBe('delivered')
    expect(deliveries).toEqual([ORIGIN])

    await expect(completeRun(deps, {
      runId: 'run-1',
      status: 'completed',
      content: '完成',
      structured: { summary: '改了', files: [] },
    }, exec(CHILD))).rejects.toMatchObject({ code: 'WINDOW_RUN_ALREADY_SETTLED' })
  })

  it('failed 可省略 structured；未声明 schema 不接受 structured', async () => {
    const store = new MemoryRunStore()
    await store.create(record({ runId: 'run-fail', outputSchema: SCHEMA }))
    await store.create(record({ runId: 'run-plain' }))
    const { port } = makeDelivery()
    const deps = runDeps(store, port)

    const failed = await completeRun(deps, { runId: 'run-fail', status: 'failed', content: '构建失败' }, exec(CHILD))
    expect(failed.status).toBe('failed')

    await expect(completeRun(deps, {
      runId: 'run-plain',
      status: 'completed',
      content: 'ok',
      structured: { summary: 'x' },
    }, exec(CHILD))).rejects.toMatchObject({ code: 'WINDOW_INVALID_INPUT' })
  })

  it('window_status 回读 output_schema 与 structured', async () => {
    const store = new MemoryRunStore()
    await store.create(record({ outputSchema: SCHEMA, resultRequired: true }))
    const { port } = makeDelivery()
    const deps = runDeps(store, port)
    const structured = { summary: '完成', files: ['a.ts'] }
    await completeRun(deps, { runId: 'run-1', status: 'completed', content: '完成', structured }, exec(CHILD))

    const status = await getRunStatus(deps, 'run-1', exec(ORIGIN))
    expect(status.output_schema).toEqual(SCHEMA)
    expect(status.result_required).toBe(true)
    expect(status.result?.structured).toEqual(structured)
  })
})
