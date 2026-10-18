import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { waitRuns } from '../src/application/waitRuns.js'
import type { RunRecord, WindowDeps } from '../src/application/ports.js'
import { FsRunStore } from '../src/adapters/runStore.js'

const roots: string[] = []

async function tempStore(): Promise<FsRunStore> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-window-wait-'))
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
    lastActivityAt: 1,
    createdAt: 1,
    updatedAt: 1,
    ...over,
  }
}

function deps(store: FsRunStore): WindowDeps {
  return {
    resolveWindowKey: (exec) => (exec as { agent: { id: string } }).agent.id,
    requireLiveDriver: vi.fn(),
    runStore: store,
    waitPollMs: 20,
    now: () => 1_000,
    newRunId: () => 'run-x',
  }
}

function exec(id: string, signal?: AbortSignal): unknown {
  return { agent: { id }, ...(signal === undefined ? {} : { signal }) }
}

describe('window_wait', () => {
  it('mode=all：等全部终态，事件驱动即时返回', async () => {
    const store = await tempStore()
    await store.create(record({ runId: 'run-a' }))
    await store.create(record({ runId: 'run-b', childSessionId: 'session-c2' }))

    const pending = waitRuns(deps(store), { runIds: ['run-a', 'run-b'], mode: 'all', timeoutMs: 2_000 }, exec('session-o1'))
    await new Promise((resolve) => setTimeout(resolve, 20))
    await store.update('run-a', { status: 'completed', updatedAt: 5, lastActivityAt: 5 })
    await store.update('run-b', { status: 'failed', updatedAt: 6, lastActivityAt: 6 })

    const value = await pending
    expect(value.timed_out).toBe(false)
    expect(value.runs.map((row) => row.run_status).sort()).toEqual(['completed', 'failed'])
  })

  it('mode=any：任一终态即返回；已终态时立即返回', async () => {
    const store = await tempStore()
    await store.create(record({ runId: 'run-a' }))
    await store.create(record({ runId: 'run-b', status: 'completed', updatedAt: 2 }))
    const value = await waitRuns(deps(store), { runIds: ['run-a', 'run-b'], mode: 'any', timeoutMs: 500 }, exec('session-o1'))
    expect(value.timed_out).toBe(false)
    expect(value.runs.map((row) => row.run_id).sort()).toEqual(['run-a', 'run-b'])
  })

  it('超时返回快照，不把 running 当完成', async () => {
    const store = await tempStore()
    await store.create(record({ runId: 'run-a' }))
    const value = await waitRuns(deps(store), { runIds: ['run-a'], mode: 'all', timeoutMs: 40 }, exec('session-o1'))
    expect(value.timed_out).toBe(true)
    expect(value.runs[0]).toMatchObject({ run_id: 'run-a', run_status: 'running' })
  })

  it('调用方取消返回 aborted 快照', async () => {
    const store = await tempStore()
    await store.create(record({ runId: 'run-a' }))
    const controller = new AbortController()
    setTimeout(() => controller.abort(), 20)
    const value = await waitRuns(deps(store), { runIds: ['run-a'], mode: 'all', timeoutMs: 2_000 }, exec('session-o1', controller.signal))
    expect(value.aborted).toBe(true)
    expect(value.timed_out).toBe(false)
  })

  it('scope/topic 解析与授权失败', async () => {
    const store = await tempStore()
    await store.create(record({ runId: 'run-a', topicId: 'topic-1' }))
    await store.create(record({ runId: 'run-b', originSessionId: 'session-other', childSessionId: 'session-c9', status: 'completed' }))

    const topicValue = await waitRuns(deps(store), { topicId: 'topic-1', mode: 'all', timeoutMs: 30 }, exec('session-o1'))
    expect(topicValue.runs.map((row) => row.run_id)).toEqual(['run-a'])

    await expect(waitRuns(deps(store), { runIds: ['run-b'], mode: 'all', timeoutMs: 30 }, exec('session-o1')))
      .rejects.toMatchObject({ code: 'WINDOW_RUN_FORBIDDEN' })

    const empty = await tempStore()
    await expect(waitRuns(deps(empty), { scope: 'my_active', mode: 'all', timeoutMs: 30 }, exec('session-o1')))
      .rejects.toMatchObject({ code: 'WINDOW_WAIT_UNAVAILABLE' })
  })

  it('scope=my_active 只返回调用方自己的活动 run（不含他人、不含自己已终态）', async () => {
    const store = await tempStore()
    await store.create(record({ runId: 'run-mine', originSessionId: 'session-o1', childSessionId: 'session-c1', status: 'running' }))
    await store.create(record({ runId: 'run-theirs', originSessionId: 'session-o2', childSessionId: 'session-c2', status: 'running' }))
    await store.create(record({
      runId: 'run-mine-done',
      originSessionId: 'session-o1',
      childSessionId: 'session-c3',
      status: 'completed',
      updatedAt: 2,
    }))

    const mine = await waitRuns(deps(store), { scope: 'my_active', mode: 'all', timeoutMs: 20 }, exec('session-o1'))
    expect(mine.runs.map((row) => row.run_id)).toEqual(['run-mine'])
    expect(mine.timed_out).toBe(true) // 只有自己那条活动 run，未被判定完成

    const theirs = await waitRuns(deps(store), { scope: 'my_active', mode: 'all', timeoutMs: 20 }, exec('session-o2'))
    expect(theirs.runs.map((row) => row.run_id)).toEqual(['run-theirs'])
  })

  it('等待不消费也不改写 callback', async () => {
    const store = await tempStore()
    await store.create(record({ runId: 'run-a', callback: { status: 'pending', callbackId: 'result-run-a', attempts: 1 } }))
    const before = await store.get('run-a')
    await waitRuns(deps(store), { runIds: ['run-a'], mode: 'all', timeoutMs: 30 }, exec('session-o1'))
    expect(await store.get('run-a')).toEqual(before)
  })
})
