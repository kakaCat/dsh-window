import { describe, expect, it, vi } from 'vitest'
import { JsonSchemaGuard } from '../src/adapters/jsonSchemaGuard.js'
import type {
  AgentControlPort,
  SeedDeliveryPort,
  WindowDeps,
  WindowOpenerPort,
} from '../src/application/ports.js'
import { defineWindowInterruptTool } from '../src/tools/windowControlTools.js'
import { defineWindowStatusTool } from '../src/tools/windowRunTools.js'
import { defineWindowOpenTool } from '../src/tools/windowOpenTool.js'
import { MemoryRunStore, makeRunRecord } from './helpers/memoryRunStore.js'

const ORIGIN = 'session-origin'
const CHILD = 'session-child'

/** 工具壳执行函数的最小形状；避免依赖 defineTool 的完整泛型。 */
interface ToolShell {
  output: { schema: Record<string, unknown> }
  execute: (args: unknown, exec: unknown) => Promise<unknown>
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
    createMessage: (params) => ({
      message: { content: [{ type: 'text', text: params.text }], source: { kind: params.kind } },
      messageId: params.messageId ?? 'message-1',
    }),
    deliver: async () => ({ delivered: true }),
  }
}

function control(): AgentControlPort {
  return {
    steer: async () => ({ delivered: true, mode: 'steered' }),
    cancelTurn: async () => ({ accepted: true }),
  }
}

function deps(store: MemoryRunStore, over: Partial<WindowDeps> = {}): WindowDeps {
  let counter = 0
  return {
    resolveWindowKey: (exec) => (exec as { agent: { id: string } }).agent.id,
    requireLiveDriver: vi.fn(),
    seedDelivery: delivery(),
    schemaGuard: new JsonSchemaGuard(),
    runStore: store,
    now: () => 20,
    newRunId: () => `id-${++counter}`,
    ...over,
  }
}

function exec(id: string): unknown {
  return { agent: { id } }
}

async function runTool(tool: ToolShell, args: unknown, id: string = ORIGIN): Promise<Record<string, unknown>> {
  return await tool.execute(args, exec(id)) as Record<string, unknown>
}

function declaredProps(tool: ToolShell): string[] {
  const properties = tool.output.schema['properties']
  return properties === undefined || properties === null ? [] : Object.keys(properties as Record<string, unknown>)
}

describe('REQ §6 契约字面断言（工具回执逐字段）', () => {
  it('§6.1 window_open：continuation 与 branch 的关键字段与字面值', async () => {
    const tool = defineWindowOpenTool(deps(new MemoryRunStore(), { windowOpener: opener() })) as unknown as ToolShell
    // 声明面必须覆盖 REQ §6.1 的「关键返回字段」。
    expect(declaredProps(tool)).toEqual(expect.arrayContaining([
      'success', 'scenario', 'callback_policy', 'callback_armed', 'window_key', 'mode',
    ]))

    const continuation = await runTool(tool, { scenario: 'continuation', seed_text: '接管当前任务' })
    expect(continuation['success']).toBe(true)
    expect(continuation['scenario']).toBe('continuation')
    expect(continuation['callback_policy']).toBe('none')
    expect(continuation['callback_armed']).toBe(false)
    expect(continuation['mode']).toBe('create')
    expect(continuation['run_id']).toBeUndefined()

    const branch = await runTool(tool, { scenario: 'branch', seed_text: '做分叉任务' })
    expect(branch['success']).toBe(true)
    expect(branch['scenario']).toBe('branch')
    expect(branch['callback_policy']).toBe('required')
    expect(branch['callback_armed']).toBe(true)
    expect(branch['window_key']).toBe(CHILD)
    expect(branch['mode']).toBe('fork')
    expect(typeof branch['run_id']).toBe('string')
  })

  it('§6.3 window_status：run 身份、created_by、run_status、last_activity_at 与 callback 嵌套字段', async () => {
    const store = new MemoryRunStore()
    await store.create(makeRunRecord({
      createdBy: 'dispatch',
      status: 'completed',
      topicId: 'topic-1',
      startedTopicRevision: 3,
      result: { status: 'completed', content: '结果 A', completedAt: 5, completedBy: CHILD },
      callback: { status: 'failed', callbackId: 'result-run-1', attempts: 2, reason: 'origin offline' },
      lastActivityAt: 7,
      updatedAt: 7,
    }))
    const tool = defineWindowStatusTool(deps(store)) as unknown as ToolShell
    expect(declaredProps(tool)).toEqual(expect.arrayContaining([
      'run_id', 'scenario', 'created_by', 'run_status', 'last_activity_at', 'callback',
    ]))

    const value = await runTool(tool, { run_id: 'run-1' })

    expect(value['run_id']).toBe('run-1')
    expect(value['scenario']).toBe('branch')
    expect(value['created_by']).toBe('dispatch')
    expect(value['run_status']).toBe('completed')
    expect(value['last_activity_at']).toBe(7)
    expect(value['topic_id']).toBe('topic-1')
    expect(value['started_topic_revision']).toBe(3)
    expect(value['callback']).toEqual({
      status: 'failed',
      callback_id: 'result-run-1',
      attempts: 2,
      reason: 'origin offline',
    })
    expect(value['result']).toMatchObject({ status: 'completed', content: '结果 A', completed_at: 5 })
  })

  it('§6.15 window_interrupt：turn 保持 running，run 落 cancelled 且 callback=not_requested', async () => {
    const store = new MemoryRunStore()
    await store.create(makeRunRecord())
    const tool = defineWindowInterruptTool(deps(store, { agentControl: control() })) as unknown as ToolShell
    expect(declaredProps(tool)).toEqual(expect.arrayContaining([
      'accepted', 'run_id', 'mode', 'run_status', 'callback',
    ]))

    const turn = await runTool(tool, { run_id: 'run-1', mode: 'turn', reason: '方向错了' })
    expect(turn['accepted']).toBe(true)
    expect(turn['run_id']).toBe('run-1')
    expect(turn['mode']).toBe('turn')
    expect(turn['run_status']).toBe('running')
    expect(turn['callback']).toMatchObject({ status: 'pending' })
    expect(String(turn['note'])).toContain('保持 active')

    const run = await runTool(tool, { run_id: 'run-1', mode: 'run', reason: '需求取消' })
    expect(run['accepted']).toBe(true)
    expect(run['run_id']).toBe('run-1')
    expect(run['mode']).toBe('run')
    expect(run['run_status']).toBe('cancelled')
    expect(run['callback']).toMatchObject({ status: 'not_requested' })
    expect(run['result']).toMatchObject({ status: 'cancelled', content: '需求取消', completed_by: ORIGIN })
  })
})
