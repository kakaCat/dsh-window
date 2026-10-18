import { describe, expect, it, vi } from 'vitest'
import {
  applyWindowInheritance,
  deriveTaskTitle,
  windowProfileFromProjectionValues,
} from '../src/application/windowInherit.js'
import type { WindowOpenerPort } from '../src/application/ports.js'

function opener(over: Partial<WindowOpenerPort> = {}): { port: WindowOpenerPort; renamed: string[] } {
  const renamed: string[] = []
  const port: WindowOpenerPort = {
    available: () => true,
    fork: async (source) => ({ ok: true, windowKey: 'child-1', parentSessionId: source }),
    create: async () => ({ ok: true, windowKey: 'child-1' }),
    rename: async (_id, title) => {
      renamed.push(title)
    },
    selectModel: async () => undefined,
    ...over,
  }
  return { port, renamed }
}

const BRANCH_SEED = [
  '[DSH Window 分支任务包]',
  'scenario: branch',
  'run_id: run-1',
  '完成后必须调用 window_complete 上报 status 与 content；普通 turn/end 不算完成。',
  '---',
  '补 e2e 自测脚本',
].join('\n')

describe('deriveTaskTitle', () => {
  it('跳过协议行，按场景给前缀 + seed 首条有效内容', () => {
    expect(deriveTaskTitle('branch', BRANCH_SEED)).toBe('分叉：补 e2e 自测脚本')
    expect(deriveTaskTitle('continuation', '[DSH Window 续接任务包]\nscenario: continuation\n---\n接管登录重构'))
      .toBe('续接：接管登录重构')
  })

  it('超长截断加省略号；去掉列表符号；折叠空白', () => {
    const long = `分叉任务：${'很长的任务描述'.repeat(10)}`
    const title = deriveTaskTitle('branch', `[DSH Window 分支任务包]\n---\n- ${long}`)
    expect(title?.startsWith('分叉：分叉任务：')).toBe(true)
    expect(title?.endsWith('…')).toBe(true)
    expect((title ?? '').length).toBeLessThanOrEqual('分叉：'.length + 37)
    expect(deriveTaskTitle('branch', '标题   里有\t多余空白')).toBe('分叉：标题 里有 多余空白')
  })

  it('只有协议行或空 seed → undefined（交给调用方回退源标题）', () => {
    expect(deriveTaskTitle('branch', '[DSH Window 分支任务包]\nscenario: branch\nrun_id: r\n---\n')).toBeUndefined()
    expect(deriveTaskTitle('branch', '   ')).toBeUndefined()
  })
})

describe('windowProfileFromProjectionValues', () => {
  it('解包 {ver,seq,val} 投影行', () => {
    const profile = windowProfileFromProjectionValues({
      title: { ver: 1, seq: 17, val: '我要把pm插件里的窗口工具独 (1)' },
      agentPreset: { ver: 1, seq: 17, val: 'standard' },
      modelSelection: { ver: 1, seq: 17, val: { next: { provider: 'deepseek', model: 'chat' } } },
    })
    expect(profile).toEqual({
      title: '我要把pm插件里的窗口工具独 (1)',
      agentPreset: 'standard',
      modelSelection: { provider: 'deepseek', model: 'chat' },
    })
  })

  it('未包装的普通值照常可读', () => {
    const profile = windowProfileFromProjectionValues({
      title: '普通标题',
      modelSelection: { next: { provider: 'kimi', model: 'k3' } },
    })
    expect(profile).toMatchObject({ title: '普通标题', modelSelection: { provider: 'kimi', model: 'k3' } })
  })
})

describe('applyWindowInheritance 标题优先级', () => {
  it('显式 title > 任务派生；任务派生 > 源标题递增', async () => {
    const a = opener()
    const inheritedA = await applyWindowInheritance(a.port, {
      childKey: 'child-1',
      mode: 'create',
      scenario: 'branch',
      seedText: BRANCH_SEED,
      sourceRead: { profile: { title: '源标题' } },
      explicitTitle: '我指定的标题',
    })
    expect(inheritedA.title).toBe('set')
    expect(a.renamed).toEqual(['我指定的标题'])

    const b = opener()
    const inheritedB = await applyWindowInheritance(b.port, {
      childKey: 'child-1',
      mode: 'create',
      scenario: 'branch',
      seedText: BRANCH_SEED,
      sourceRead: { profile: { title: '源标题' } },
    })
    expect(b.renamed).toEqual(['分叉：补 e2e 自测脚本'])
    expect(inheritedB.title).toBe('set')
  })

  it('seed 无可派生摘要时回退源标题递增；两者都没有则 skipped', async () => {
    const a = opener()
    await applyWindowInheritance(a.port, {
      childKey: 'child-1',
      mode: 'create',
      scenario: 'branch',
      seedText: '[DSH Window 分支任务包]\nscenario: branch\n---\n',
      sourceRead: { profile: { title: '源标题 (2)' } },
    })
    expect(a.renamed).toEqual(['源标题 (3)'])

    const b = opener()
    const inherited = await applyWindowInheritance(b.port, {
      childKey: 'child-1',
      mode: 'create',
      scenario: 'branch',
      seedText: '---\n',
      sourceRead: { profile: {} },
    })
    expect(inherited.title).toBe('skipped')
    expect(b.renamed).toEqual([])
  })

  it('rename 抛错时 title=failed 但不止步其它两步', async () => {
    const { port } = opener({ rename: async () => { throw new Error('rename boom') } })
    const selectModel = vi.fn(async () => undefined)
    const inherited = await applyWindowInheritance({ ...port, selectModel }, {
      childKey: 'child-1',
      mode: 'create',
      scenario: 'branch',
      seedText: BRANCH_SEED,
      sourceRead: { profile: { modelSelection: { provider: 'deepseek', model: 'chat' } } },
    })
    expect(inherited.title).toBe('failed')
    expect(inherited.model).toBe('set')
    expect(selectModel).toHaveBeenCalledOnce()
  })
})
