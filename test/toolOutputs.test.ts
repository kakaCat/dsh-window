import { describe, expect, it, vi } from 'vitest'
import { validateJsonSchemaValue } from '@deepseek-ai/dsh-tools'
import { JsonSchemaGuard } from '../src/adapters/jsonSchemaGuard.js'
import type {
  AgentControlPort,
  RunControlEvent,
  RunRecord,
  RunStorePort,
  SeedDeliveryPort,
  WindowDeps,
  WindowInspectPort,
  WindowOpenerPort,
} from '../src/application/ports.js'
import { defineWindowOpenTool } from '../src/tools/windowOpenTool.js'
import {
  defineWindowCompleteTool,
  defineWindowDispatchTool,
  defineWindowRetryCallbackTool,
  defineWindowStatusTool,
} from '../src/tools/windowRunTools.js'
import { defineWindowInspectTool, defineWindowListTool } from '../src/tools/windowDiscoverTools.js'
import { defineWindowInterruptTool, defineWindowSendTool } from '../src/tools/windowControlTools.js'
import { defineWindowWaitTool } from '../src/tools/windowWaitTool.js'

const ORIGIN = 'session-origin'
const CHILD = 'session-child'
const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['summary'],
  properties: { summary: { type: 'string' } },
}

class MemoryRunStore implements RunStorePort {
  readonly records = new Map<string, RunRecord>()
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
    void event
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

function makeDelivery(): SeedDeliveryPort {
  return {
    createMessage: (params) => ({
      message: { content: [{ type: 'text', text: params.text }], source: { kind: params.kind } },
      messageId: params.messageId ?? 'message-1',
    }),
    deliver: async () => ({ delivered: true }),
  }
}

function makeDeps(over: Partial<WindowDeps> = {}): WindowDeps {
  let counter = 0
  return {
    resolveWindowKey: (exec) => (exec as { agent: { id: string } }).agent.id,
    requireLiveDriver: vi.fn(),
    seedDelivery: makeDelivery(),
    schemaGuard: new JsonSchemaGuard(),
    now: () => 20,
    newRunId: () => `id-${++counter}`,
    ...over,
  }
}

function opener(): WindowOpenerPort {
  return {
    available: () => true,
    fork: async (source) => ({ ok: true, windowKey: CHILD, parentSessionId: source }),
    create: async () => ({ ok: true, windowKey: CHILD }),
    readProfile: async () => ({}),
    rename: async () => undefined,
    selectModel: async () => undefined,
  }
}

function control(): AgentControlPort {
  return {
    steer: async () => ({ delivered: true, mode: 'steered' }),
    cancelTurn: async () => ({ accepted: true }),
  }
}

function inspector(): WindowInspectPort {
  return {
    inspect: async (windowKey) => ({ windowKey, running: true, title: '子任务' }),
    history: async () => ({ items: [{ seq: 1, type: 'user/message', time: 1, role: 'user', text: 'x' }] }),
  }
}

function exec(id: string): unknown {
  return { agent: { id } }
}

/** 执行工具并断言回执符合它自己声明的 output schema。 */
async function runTool(
  tool: { output: { schema: unknown }; execute: (args: unknown, exec: unknown) => Promise<unknown> },
  args: unknown,
  id: string = ORIGIN,
): Promise<Record<string, unknown>> {
  const value = await tool.execute(args, exec(id))
  const violations = validateJsonSchemaValue(tool.output.schema as never, value)
  expect(violations).toEqual([])
  return value as Record<string, unknown>
}

/** 把 render 产出的内容块拼成纯文本（只看 text 块）。 */
function renderText(tool: { output: { render: (...args: never[]) => unknown } }, value: unknown): string {
  const render = tool.output.render as unknown as (a: unknown, v: unknown) => { type: string; text?: string }[]
  return render({}, value)
    .filter((block) => block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n')
}

describe('工具回执符合 output schema', () => {
  it('window_open（含结构化 schema）', async () => {
    const store = new MemoryRunStore()
    const tool = defineWindowOpenTool(makeDeps({ windowOpener: opener(), runStore: store }))
    const value = await runTool(tool as never, { scenario: 'branch', seed_text: '做事', output_schema: SCHEMA })
    expect(value['success']).toBe(true)
  })

  it('window_open(target_workspace) 回执带跨区落点且符合 output schema', async () => {
    const store = new MemoryRunStore()
    const base = opener()
    const tool = defineWindowOpenTool(makeDeps({
      windowOpener: {
        ...base,
        resolveWorkspace: () => ({
          ok: true,
          workspace: { id: 'ws-2', title: '后端仓库', path: '/repos/backend' },
        }),
      },
      runStore: store,
    }))
    const value = await runTool(tool as never, {
      scenario: 'branch',
      mode: 'create',
      seed_text: '跨区做事',
      target_workspace: 'ws-2',
    })
    expect(value['success']).toBe(true)
    expect(value['target_workspace']).toEqual({ id: 'ws-2', title: '后端仓库', path: '/repos/backend' })
  })

  it('window_complete / window_status / window_retry_callback（含 structured 与 snake_case 回调）', async () => {
    const store = new MemoryRunStore()
    await store.create(record({ outputSchema: SCHEMA, resultRequired: true }))
    const deps = makeDeps({ runStore: store, schemaGuard: new JsonSchemaGuard() })

    const complete = defineWindowCompleteTool(deps)
    const completed = await runTool(complete as never, { run_id: 'run-1', status: 'completed', content: 'ok', structured: { summary: 'ok' } }, CHILD)
    expect((completed['result'] as Record<string, unknown>)['structured']).toEqual({ summary: 'ok' })

    const status = defineWindowStatusTool(deps)
    const statusValue = await runTool(status as never, { run_id: 'run-1' })
    expect(statusValue['output_schema']).toEqual(SCHEMA)

    const retry = defineWindowRetryCallbackTool(deps)
    await runTool(retry as never, { run_id: 'run-1' })

    const dispatchTool = defineWindowDispatchTool(deps)
    const dispatched = await runTool(dispatchTool as never, { to_window: CHILD, seed_text: '再来', output_schema: SCHEMA })
    expect(dispatched['success']).toBe(true)
  })

  it('window_list / window_inspect / window_send / window_interrupt / window_wait', async () => {
    const store = new MemoryRunStore()
    await store.create(record())
    const deps = makeDeps({ runStore: store, windowInspect: inspector(), agentControl: control(), waitPollMs: 20, windowOpener: opener() })

    await runTool(defineWindowListTool(deps) as never, {})
    await runTool(defineWindowInspectTool(deps) as never, { window_key: CHILD, include_history: true })
    await runTool(defineWindowSendTool(deps) as never, { run_id: 'run-1', message: '补充约束' })
    await runTool(defineWindowInterruptTool(deps) as never, { run_id: 'run-1', mode: 'turn', reason: '方向错了' })
    const waited = await runTool(defineWindowWaitTool(deps) as never, { run_ids: ['run-1'], mode: 'all', timeout_ms: 30 })
    expect(waited['timed_out']).toBe(true)
    await runTool(defineWindowInterruptTool(deps) as never, { run_id: 'run-1', mode: 'run' })
  })

  it('超时 hint 与 inspect 不一致告警要真正进到模型可见文本', async () => {
    const store = new MemoryRunStore()
    await store.create(record())
    const deps = makeDeps({ runStore: store, windowInspect: inspector(), agentControl: control(), waitPollMs: 20, windowOpener: opener() })

    const waitTool = defineWindowWaitTool(deps)
    const waited = await runTool(waitTool as never, { run_ids: ['run-1'], mode: 'all', timeout_ms: 30 })
    expect(waited['hint']).toBeTypeOf('string')
    const waitText = renderText(waitTool, waited)
    expect(waitText).toContain(String(waited['hint']))
    expect(waitText).toContain('不说明停滞')

    // 会话不在线、run 仍 running：摘要必须提示不一致，而不是只说 running=false。
    const stalledDeps = makeDeps({
      runStore: store,
      windowInspect: { ...inspector(), inspect: async (windowKey) => ({ windowKey, running: false }) },
      agentControl: control(),
      windowOpener: opener(),
    })
    const inspectTool = defineWindowInspectTool(stalledDeps)
    const inspected = await runTool(inspectTool as never, { window_key: CHILD })
    expect(inspected['run_status']).toBe('running')
    const inspectText = renderText(inspectTool, inspected)
    expect(inspectText).toContain('不一致')
    expect(inspectText).toContain('window_dispatch')
  })
})
