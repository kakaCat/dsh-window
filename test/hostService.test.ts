import { describe, expect, it, vi } from 'vitest'
import { createWindowHostService, WINDOW_SERVICE } from '../src/hostService.js'
import type {
  RunControlEvent,
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
    createMessage: (params) => ({ message: { content: [{ type: 'text', text: params.text }] }, messageId: 'm-1' }),
    deliver: async () => ({ delivered: true }),
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
    now: () => 100,
    newRunId: () => `run-${++counter}`,
  }
}

function exec(id: string): unknown {
  return { agent: { id } }
}

describe('window Host Service（REQ §6.5）', () => {
  it('服务名与服务面符合对外约定', () => {
    expect(WINDOW_SERVICE).toBe('window')
    const service = createWindowHostService(deps(new MemoryRunStore()))
    expect(typeof service.open).toBe('function')
    expect(typeof service.stopForOrigin).toBe('function')
  })

  it('open：branch 返回 camelCase 回执且带 run/callback', async () => {
    const service = createWindowHostService(deps(new MemoryRunStore()))
    const value = await service.open({ scenario: 'branch', seedText: '做事' }, exec(ORIGIN))
    expect(value).toMatchObject({
      success: true,
      scenario: 'branch',
      callbackPolicy: 'required',
      callbackArmed: true,
      windowKey: CHILD,
      parentSessionId: ORIGIN,
      mode: 'fork',
    })
    expect(typeof value['runId']).toBe('string')
    expect(value['inheritance']).toMatchObject({ title: expect.any(String) })
  })

  it('open：continuation 不带 run、不回调', async () => {
    const service = createWindowHostService(deps(new MemoryRunStore()))
    const value = await service.open({ scenario: 'continuation', seedText: '接着做' }, exec(ORIGIN))
    expect(value).toMatchObject({ success: true, scenario: 'continuation', callbackPolicy: 'none', callbackArmed: false })
    expect(value['runId']).toBeUndefined()
  })

  it('open：非法输入按 WindowError 抛出（带 code）', async () => {
    const service = createWindowHostService(deps(new MemoryRunStore()))
    await expect(service.open({ scenario: 'nope', seedText: 'x' }, exec(ORIGIN)))
      .rejects.toMatchObject({ code: 'WINDOW_SCENARIO_REQUIRED' })
    await expect(service.open({ scenario: 'branch', seedText: '   ' }, exec(ORIGIN)))
      .rejects.toMatchObject({ code: 'WINDOW_SEED_REQUIRED' })
  })

  it('stopForOrigin：把 origin 的活动 run 落 cancelled', async () => {
    const store = new MemoryRunStore()
    await store.create({
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
    })
    // origin 已离线（isWindowAlive=false）才允许宿主对账路径代停
    const service = createWindowHostService({ ...deps(store), isWindowAlive: () => false })
    const summary = await service.stopForOrigin(ORIGIN, '需求取消')
    expect(summary.affected).toEqual(['run-1'])
    expect(summary.failures).toEqual([])
    expect(await store.get('run-1')).toMatchObject({ status: 'cancelled' })
  })

  it('stopForOrigin：origin 在线或在线状态不可判定时拒绝代停（fail-closed）', async () => {
    const store = new MemoryRunStore()
    await store.create({
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
    })

    const online = createWindowHostService({ ...deps(store), isWindowAlive: () => true })
    await expect(online.stopForOrigin(ORIGIN, '需求取消')).rejects.toMatchObject({ code: 'WINDOW_RUN_FORBIDDEN' })

    // 未装配 isWindowAlive：无法证明 origin 已离线，同样拒绝（不能默认放行）
    const noPort = createWindowHostService(deps(store))
    await expect(noPort.stopForOrigin(ORIGIN, '需求取消')).rejects.toMatchObject({ code: 'WINDOW_RUN_FORBIDDEN' })

    // origin 自己带 exec 调用则允许
    const self = createWindowHostService({ ...deps(store), isWindowAlive: () => true })
    const summary = await self.stopForOrigin(ORIGIN, '需求取消', { agent: { id: ORIGIN, status: 'running' } })
    expect(summary.affected).toEqual(['run-1'])
  })
})
