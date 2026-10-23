import { describe, expect, it } from 'vitest'
import { SessionWindowOpener } from '../src/adapters/sessionWindowOpener.js'

/** 与 Workspace 实体同形的注册表行：只含 id/title/path/sessionIds。 */
const ROWS = [
  { id: 'ws-frontend', title: '前端', path: '/repos/frontend', sessionIds: ['session-1'] },
  { id: 'ws-backend', title: '后端', path: '/repos/backend', sessionIds: ['session-2'] },
  { id: 'ws-backend-copy', title: '后端', path: '/repos/backend-copy', sessionIds: [] },
]

type Controller = Record<string, unknown>

function makeOpener(
  rows: unknown = ROWS,
  controller: Controller = { create: async () => ({ sessionId: 'session-new' }) },
): SessionWindowOpener {
  return new SessionWindowOpener(() => controller, () => ({ list: () => rows }))
}

describe('SessionWindowOpener.resolveWorkspace：目标工作区寻址', () => {
  it('workspace id 精确命中优先', () => {
    const opener = makeOpener()
    expect(opener.resolveWorkspace('ws-backend')).toEqual({
      ok: true,
      workspace: { id: 'ws-backend', title: '后端', path: '/repos/backend' },
    })
  })

  it('绝对路径可命中，尾部分隔符不影响归一', () => {
    const opener = makeOpener()
    expect(opener.resolveWorkspace('/repos/backend/')).toMatchObject({
      ok: true,
      workspace: { id: 'ws-backend' },
    })
  })

  it('标题只有唯一命中时才解析成功', () => {
    const opener = makeOpener()
    expect(opener.resolveWorkspace('前端')).toMatchObject({
      ok: true,
      workspace: { id: 'ws-frontend' },
    })
  })

  it('标题歧义时如实返回 ambiguous，不猜一个', () => {
    const opener = makeOpener()
    const result = opener.resolveWorkspace('后端')
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.code).toBe('ambiguous')
    expect(result.candidates?.map((item) => item.id).sort()).toEqual(['ws-backend', 'ws-backend-copy'])
  })

  it('未命中时返回 not_found 与有界候选，且候选不含 sessionIds', () => {
    const opener = makeOpener()
    const result = opener.resolveWorkspace('ghost')
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.code).toBe('not_found')
    expect(result.candidates?.[0]).toEqual({ id: 'ws-frontend', title: '前端', path: '/repos/frontend' })
    expect(JSON.stringify(result.candidates)).not.toContain('session-1')
  })

  it('注册表未装配或不可读时返回 unavailable', () => {
    const missing = new SessionWindowOpener(
      () => ({ create: async () => ({ sessionId: 'session-new' }) }),
      () => undefined,
    )
    expect(missing.resolveWorkspace('ws-backend')).toMatchObject({ ok: false, code: 'unavailable' })

    const broken = new SessionWindowOpener(
      () => ({ create: async () => ({ sessionId: 'session-new' }) }),
      () => ({ list: () => { throw new Error('boom') } }),
    )
    const result = broken.resolveWorkspace('ws-backend')
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.code).toBe('unavailable')
  })

  it('create 会把解析出的 workspaceId 原样交给宿主', async () => {
    const requests: unknown[] = []
    const opener = makeOpener(ROWS, {
      create: async (request: unknown) => {
        requests.push(request)
        return { sessionId: 'session-new' }
      },
    })
    await expect(opener.create({ workspaceId: 'ws-backend' })).resolves.toMatchObject({
      ok: true,
      windowKey: 'session-new',
    })
    expect(requests).toEqual([{ workspaceId: 'ws-backend' }])
  })
})
