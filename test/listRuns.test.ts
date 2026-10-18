import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { listRuns } from '../src/application/listRuns.js'
import type { RunRecord, WindowDeps } from '../src/application/ports.js'
import { FsRunStore } from '../src/adapters/runStore.js'

const roots: string[] = []

async function tempStore(): Promise<FsRunStore> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-window-list-'))
  roots.push(root)
  return new FsRunStore({ root })
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(async (root) => rm(root, { recursive: true, force: true })))
})

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
    callback: { status: 'pending', callbackId: 'result-run-a', attempts: 0 },
    lastActivityAt: 30,
    createdAt: 1,
    updatedAt: 30,
    ...over,
  }
}

function deps(store: FsRunStore | undefined): WindowDeps {
  return {
    resolveWindowKey: (exec) => (exec as { agent: { id: string } }).agent.id,
    requireLiveDriver: vi.fn(),
    ...(store === undefined ? {} : { runStore: store }),
    now: () => 1_000,
    newRunId: () => 'run-x',
  }
}

function exec(id: string): unknown {
  return { agent: { id } }
}

describe('window_list', () => {
  it('origin 只见自己的 run，child 只见分配给自己的，不返回 result 正文', async () => {
    const store = await tempStore()
    await store.create(record({ runId: 'run-a', result: { status: 'completed', content: '秘密正文', completedAt: 9, completedBy: 'session-c1' } }))
    await store.create(record({ runId: 'run-b', childSessionId: 'session-c2', status: 'completed', updatedAt: 20, lastActivityAt: 20 }))
    await store.create(record({ runId: 'run-c', originSessionId: 'session-other', childSessionId: 'session-c3', updatedAt: 10, lastActivityAt: 10 }))

    const originView = await listRuns(deps(store), {}, exec('session-o1'))
    expect(originView.total).toBe(2)
    expect(originView.rows.map((row) => row.run_id).sort()).toEqual(['run-a', 'run-b'])
    expect(JSON.stringify(originView)).not.toContain('秘密正文')

    const childView = await listRuns(deps(store), {}, exec('session-c1'))
    expect(childView.rows.map((row) => row.run_id)).toEqual(['run-a'])
    expect(childView.rows[0]?.callback).toMatchObject({ status: 'pending', attempts: 0 })
  })

  it('status / topic / time_window 过滤', async () => {
    const store = await tempStore()
    await store.create(record({ runId: 'run-a', status: 'running', topicId: 'topic-1', updatedAt: 30, lastActivityAt: 30 }))
    await store.create(record({ runId: 'run-b', status: 'completed', updatedAt: 20, lastActivityAt: 20 }))
    const base = deps(store)

    expect((await listRuns(base, { status: 'active' }, exec('session-o1'))).rows.map((row) => row.run_id)).toEqual(['run-a'])
    expect((await listRuns(base, { status: 'terminal' }, exec('session-o1'))).rows.map((row) => row.run_id)).toEqual(['run-b'])
    expect((await listRuns(base, { topicId: 'topic-1' }, exec('session-o1'))).rows.map((row) => row.run_id)).toEqual(['run-a'])
    expect((await listRuns(base, { timeWindow: { from: 25 } }, exec('session-o1'))).rows.map((row) => row.run_id)).toEqual(['run-a'])
  })

  it('分页：limit + next_cursor 连续读取', async () => {
    const store = await tempStore()
    await store.create(record({ runId: 'run-a', updatedAt: 30, lastActivityAt: 30 }))
    await store.create(record({ runId: 'run-b', childSessionId: 'session-c2', updatedAt: 20, lastActivityAt: 20 }))
    await store.create(record({ runId: 'run-c', childSessionId: 'session-c3', updatedAt: 10, lastActivityAt: 10 }))

    const first = await listRuns(deps(store), { limit: 2 }, exec('session-o1'))
    expect(first.rows.map((row) => row.run_id)).toEqual(['run-a', 'run-b'])
    expect(first.total).toBe(3)
    expect(first.next_cursor).toBe('2')

    const second = await listRuns(deps(store), { limit: 2, cursor: first.next_cursor }, exec('session-o1'))
    expect(second.rows.map((row) => row.run_id)).toEqual(['run-c'])
    expect(second.next_cursor).toBeUndefined()
  })

  it('存储不可用 / cursor 非法分别响亮失败', async () => {
    await expect(listRuns(deps(undefined), {}, exec('session-o1')))
      .rejects.toMatchObject({ code: 'WINDOW_RUN_STORE_UNAVAILABLE' })

    const store = await tempStore()
    await expect(listRuns(deps(store), { cursor: 'abc' }, exec('session-o1')))
      .rejects.toMatchObject({ code: 'WINDOW_INVALID_INPUT' })
  })
})
