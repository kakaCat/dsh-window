import { describe, expect, it, vi } from 'vitest'
import { inspectWindow } from '../src/application/inspectWindow.js'
import type {
  RunRecord,
  RunStorePort,
  WindowDeps,
  WindowInspectMeta,
  WindowInspectPort,
} from '../src/application/ports.js'

function record(over: Partial<RunRecord> = {}): RunRecord {
  return {
    runId: 'run-a',
    scenario: 'branch',
    createdBy: 'open',
    originSessionId: 'session-o1',
    childSessionId: 'session-c1',
    mode: 'fork',
    status: 'running',
    callbackArmed: true,
    lastActivityAt: 1,
    createdAt: 1,
    updatedAt: 1,
    ...over,
  }
}

function fakeStore(runs: RunRecord[]): RunStorePort {
  return {
    available: () => true,
    create: async () => undefined,
    update: async () => undefined,
    get: async (runId) => runs.find((run) => run.runId === runId),
    list: async () => runs,
    withLock: async (_runId, operation) => await operation(),
  }
}

function fakeInspector(over: Partial<WindowInspectPort> = {}): WindowInspectPort {
  const meta: WindowInspectMeta = {
    windowKey: 'session-c1',
    title: '子任务',
    cwd: '/ws',
    parentSessionId: 'session-o1',
    agentPreset: 'standard',
    modelSelection: { provider: 'deepseek', model: 'chat' },
    running: true,
    eventCount: 3,
  }
  return {
    inspect: async () => meta,
    history: async () => ({
      items: [
        { seq: 1, type: 'user/message', time: 10, role: 'user', sourceKind: 'user', text: '做这个' },
        { seq: 2, type: 'assistant/message', time: 11, role: 'assistant', sourceKind: 'model', text: '好的' },
      ],
    }),
    ...over,
  }
}

function deps(over: Partial<WindowDeps> = {}): WindowDeps {
  return {
    resolveWindowKey: (exec) => (exec as { agent: { id: string } }).agent.id,
    requireLiveDriver: vi.fn(),
    now: () => 1,
    newRunId: () => 'run-x',
    ...over,
  }
}

function exec(id: string): unknown {
  return { agent: { id } }
}

describe('window_inspect', () => {
  it('默认只返回元数据，历史按需', async () => {
    const port = fakeInspector()
    const value = await inspectWindow(deps({ windowInspect: port, runStore: fakeStore([record()]) }), { windowKey: 'session-c1' }, exec('session-c1'))
    expect(value.untrusted).toBe(true)
    expect(value.meta).toMatchObject({ windowKey: 'session-c1', title: '子任务', running: true })
    expect(value.history).toBeUndefined()

    const withHistory = await inspectWindow(
      deps({ windowInspect: port, runStore: fakeStore([record()]) }),
      { windowKey: 'session-c1', includeHistory: true, limit: 10 },
      exec('session-o1'),
    )
    expect(withHistory.history?.items.map((item) => item.text)).toEqual(['做这个', '好的'])
  })

  it('无 run 关系的窗口被拒', async () => {
    const value = deps({ windowInspect: fakeInspector(), runStore: fakeStore([record()]) })
    await expect(inspectWindow(value, { windowKey: 'session-c1' }, exec('session-stranger')))
      .rejects.toMatchObject({ code: 'WINDOW_RUN_FORBIDDEN' })
  })

  it('端口缺失 / 会话不可读 / limit 非法分别响亮失败', async () => {
    await expect(inspectWindow(deps(), { windowKey: 'session-c1' }, exec('session-c1')))
      .rejects.toMatchObject({ code: 'WINDOW_OPEN_UNAVAILABLE' })

    const broken = fakeInspector({ inspect: async () => { throw new Error('gone') } })
    await expect(inspectWindow(deps({ windowInspect: broken, runStore: fakeStore([]) }), { windowKey: 'session-c1' }, exec('session-c1')))
      .rejects.toMatchObject({ code: 'WINDOW_RUN_NOT_FOUND' })

    const port = fakeInspector()
    await expect(inspectWindow(deps({ windowInspect: port, runStore: fakeStore([record()]) }), { windowKey: 'session-c1', includeHistory: true, limit: 0 }, exec('session-c1')))
      .rejects.toMatchObject({ code: 'WINDOW_INVALID_INPUT' })
  })
})
