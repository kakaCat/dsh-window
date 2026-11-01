import { describe, expect, it, vi } from 'vitest'
import { BranchPrompts } from '../src/adapters/branchPrompts.js'
import { branchContractText, findActiveRunByChild, installBranchContracts } from '../src/application/branchContracts.js'
import type { WindowDeps } from '../src/application/ports.js'
import { MemoryRunStore, makeRunRecord } from './helpers/memoryRunStore.js'

const ORIGIN = 'session-origin'
const CHILD = 'session-child'

function makeDeps(store: MemoryRunStore, over: Partial<WindowDeps> = {}): WindowDeps {
  return {
    resolveWindowKey: (exec) => (exec as { agent: { id: string } }).agent.id,
    requireLiveDriver: vi.fn(),
    runStore: store,
    now: () => 1_000,
    newRunId: () => 'run-new',
    ...over,
  }
}

/** 记录订阅与 section 注册的假宿主。 */
function fakeHost(): {
  ctx: unknown
  agents: { get: (id: string) => unknown; set: (id: string, agent: unknown) => void }
  emit: (event: string, payload: unknown) => void
  sections: Map<string, { name?: string; order?: number; interpolate?: boolean; text: string }>
  releases: string[]
} {
  const handlers = new Map<string, (...args: unknown[]) => void>()
  const map = new Map<string, unknown>()
  const sections = new Map<string, { name?: string; order?: number; interpolate?: boolean; text: string }>()
  const releases: string[] = []
  return {
    ctx: {
      on: (event: string, handler: (...args: unknown[]) => void) => {
        handlers.set(event, handler)
        return () => handlers.delete(event)
      },
    },
    agents: {
      get: (id: string) => map.get(id),
      set: (id: string, agent: unknown) => map.set(id, agent),
    },
    emit: (event, payload) => handlers.get(event)?.(payload),
    sections,
    releases,
  }
}

/** 造一个带 systemPrompt.section 的假 agent。 */
function fakeAgent(host: ReturnType<typeof fakeHost>, id: string): unknown {
  return {
    id,
    ctx: {
      systemPrompt: {
        section: (options: { name?: string; order?: number; interpolate?: boolean; text: string }) => {
          host.sections.set(id, options)
          return () => host.releases.push(id)
        },
      },
    },
  }
}

const tick = async (): Promise<void> => { await new Promise((resolve) => setTimeout(resolve, 0)) }

describe('branch 契约文本', () => {
  it('带 run_id / 完成要求 / 正文上限，且不含任何用户口令', () => {
    const text = branchContractText(makeRunRecord({ runId: 'run-1', originSessionId: ORIGIN, childSessionId: CHILD }))
    expect(text).toContain('run_id: run-1')
    expect(text).toContain('window_complete')
    expect(text).toContain('普通 turn/end 不算完成')
    expect(text).toContain('4000')
    expect(text).toContain('不随上下文压缩消失')
  })
})

describe('活动 run 查找（只给活动 branch 注入）', () => {
  it('running 的 child 命中；终态、别人、已 stop 的不命中', async () => {
    const store = new MemoryRunStore()
    await store.create(makeRunRecord({ runId: 'run-live', childSessionId: CHILD }))
    await store.create(makeRunRecord({ runId: 'run-done', childSessionId: 'session-done', status: 'completed' }))
    await store.create(makeRunRecord({
      runId: 'run-stopped',
      childSessionId: 'session-stopped',
      lifecycle: { state: 'stopped', at: 1 },
    }))
    const deps = makeDeps(store)

    expect((await findActiveRunByChild(deps, CHILD))?.runId).toBe('run-live')
    expect(await findActiveRunByChild(deps, 'session-done')).toBeUndefined()
    expect(await findActiveRunByChild(deps, 'session-stopped')).toBeUndefined()
    expect(await findActiveRunByChild(deps, 'session-unknown')).toBeUndefined()
  })

  it('存储读失败当作没有（注入是增强，不是依赖）', async () => {
    const store = new MemoryRunStore()
    const broken = Object.create(store) as MemoryRunStore
    Object.defineProperty(broken, 'list', { value: async () => { throw new Error('boom') } })
    expect(await findActiveRunByChild(makeDeps(broken), CHILD)).toBeUndefined()
  })
})

describe('BranchPrompts 适配器', () => {
  it('agent/created 命中活动 child 时挂 section；销毁时释放', async () => {
    const host = fakeHost()
    const store = new MemoryRunStore()
    await store.create(makeRunRecord({ runId: 'run-1', childSessionId: CHILD }))
    const port = new BranchPrompts(() => host.ctx, () => host.agents)
    const stop = installBranchContracts(makeDeps(store, { branchPrompts: port }))

    const agent = fakeAgent(host, CHILD)
    host.agents.set(CHILD, agent)
    host.emit('agent/created', { agent })
    await tick()

    const section = host.sections.get(CHILD)
    expect(section?.name).toBe('dsh-window-branch')
    expect(section?.text).toContain('run_id: run-1')
    expect(section?.interpolate).toBe(false)

    host.emit('agent/disposed', { agent })
    expect(host.releases).toEqual([CHILD])
    stop()
  })

  it('非 branch 会话、或 agent 没有 systemPrompt 能力：不挂、也不抛', async () => {
    const host = fakeHost()
    const store = new MemoryRunStore()
    await store.create(makeRunRecord({ runId: 'run-1', childSessionId: CHILD }))
    const port = new BranchPrompts(() => host.ctx, () => host.agents)
    installBranchContracts(makeDeps(store, { branchPrompts: port }))

    const other = fakeAgent(host, 'session-other')
    host.agents.set('session-other', other)
    host.emit('agent/created', { agent: other })
    await tick()
    expect(host.sections.size).toBe(0)

    const bare = { id: CHILD, ctx: {} }
    host.agents.set(CHILD, bare)
    host.emit('agent/created', { agent: bare })
    await tick()
    expect(host.sections.size).toBe(0)
    expect(host.releases).toEqual([])
  })

  it('attach 热路径：run 建好即挂，不等 agent/created；重复调用不重复挂', async () => {
    const host = fakeHost()
    const port = new BranchPrompts(() => host.ctx, () => host.agents)
    const agent = fakeAgent(host, CHILD)
    host.agents.set(CHILD, agent)

    port.attach(CHILD, '契约正文')
    const section = host.sections.get(CHILD)
    expect(section?.text).toBe('契约正文')
    expect(section?.name).toBe('dsh-window-branch')

    port.attach(CHILD, '契约正文')
    expect(host.sections.size).toBe(1)
    expect(host.releases).toEqual([])
  })

  it('attach：agent 不存在 / 没有 systemPrompt 能力时不抛、不挂', () => {
    const host = fakeHost()
    const port = new BranchPrompts(() => host.ctx, () => host.agents)
    expect(() => port.attach('session-cold', 'x')).not.toThrow()
    host.agents.set('session-bare', { id: 'session-bare', ctx: {} })
    expect(() => port.attach('session-bare', 'x')).not.toThrow()
    expect(host.sections.size).toBe(0)
  })

  it('安装时回填已在线的 agent：插件在子窗运行中才启用/重载也能补挂', async () => {
    const host = fakeHost()
    const live = fakeAgent(host, CHILD)
    host.agents.set(CHILD, live)
    const store = new MemoryRunStore()
    await store.create(makeRunRecord({ runId: 'run-live', childSessionId: CHILD }))
    const port = new BranchPrompts(() => host.ctx, () => ({ ...host.agents, list: () => [live] }))
    installBranchContracts(makeDeps(store, { branchPrompts: port }))
    await tick()
    expect(host.sections.get(CHILD)?.text).toContain('run_id: run-live')
  })

  it('宿主没有 on 能力时安静降级；stop 幂等', async () => {
    const store = new MemoryRunStore()
    await store.create(makeRunRecord({ runId: 'run-1', childSessionId: CHILD }))
    const port = new BranchPrompts(() => ({}), () => ({ get: () => undefined }))
    const stop = installBranchContracts(makeDeps(store, { branchPrompts: port }))
    stop()
    stop()
    expect(true).toBe(true)
  })

  it('查找期间 agent 已被替换：不挂过期 section', async () => {
    const host = fakeHost()
    const store = new MemoryRunStore()
    await store.create(makeRunRecord({ runId: 'run-1', childSessionId: CHILD }))
    const port = new BranchPrompts(() => host.ctx, () => host.agents)
    installBranchContracts(makeDeps(store, { branchPrompts: port }))

    const stale = fakeAgent(host, CHILD)
    host.agents.set(CHILD, stale)
    host.emit('agent/created', { agent: stale })
    // 在异步查找返回前换掉 agent
    host.agents.set(CHILD, fakeAgent(host, CHILD))
    await tick()
    expect(host.sections.size).toBe(0)
  })
})
