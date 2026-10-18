import { appendFile, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { RunRecord } from '../src/application/ports.js'
import { FsRunStore, resolveDataRoot, resolveDshHome } from '../src/adapters/runStore.js'

const roots: string[] = []

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-window-run-'))
  roots.push(root)
  return root
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(async (root) => rm(root, { recursive: true, force: true })))
})

function record(over: Partial<RunRecord> = {}): RunRecord {
  return {
    runId: 'run-a',
    scenario: 'branch',
    createdBy: 'open',
    originSessionId: 'session-origin',
    childSessionId: 'session-child',
    mode: 'fork',
    status: 'pending',
    callbackArmed: false,
    lastActivityAt: 1,
    createdAt: 1,
    updatedAt: 1,
    ...over,
  }
}

describe('FsRunStore', () => {
  it('create/update/get 往返，落盘在 runs/<runId>/run.json', async () => {
    const root = await tempRoot()
    const store = new FsRunStore({ root })
    await store.create(record())
    expect(await store.get('run-a')).toMatchObject({ status: 'pending' })

    await store.update('run-a', { status: 'running', seedMessageId: 'm-1', updatedAt: 2 })
    expect(await store.get('run-a')).toMatchObject({ status: 'running', seedMessageId: 'm-1' })

    const raw = JSON.parse(await readFile(store.pathOf('run-a'), 'utf8')) as { runId?: string }
    expect(raw.runId).toBe('run-a')
  })

  it('unknown run 返回 undefined，update 抛错', async () => {
    const store = new FsRunStore({ root: await tempRoot() })
    expect(await store.get('missing')).toBeUndefined()
    await expect(store.update('missing', { status: 'running' })).rejects.toThrow('run 不存在')
  })

  it('list 与 withLock 可用', async () => {
    const store = new FsRunStore({ root: await tempRoot() })
    await store.create(record({ runId: 'run-a' }))
    await store.create(record({ runId: 'run-b' }))
    expect((await store.list()).map((item) => item.runId).sort()).toEqual(['run-a', 'run-b'])

    const order: string[] = []
    await Promise.all([
      store.withLock('run-a', async () => {
        order.push('a1-start')
        await new Promise((resolve) => setTimeout(resolve, 5))
        order.push('a1-end')
      }),
      store.withLock('run-a', async () => {
        order.push('a2-start')
        order.push('a2-end')
      }),
    ])
    expect(order).toEqual(['a1-start', 'a1-end', 'a2-start', 'a2-end'])
  })

  it('runId 不能作为路径段时拒绝', () => {
    const store = new FsRunStore({ root: '/tmp/dsh-window-test' })
    expect(() => store.pathOf('../escape')).toThrow('runId 非法')
    expect(() => store.pathOf('a/b')).toThrow('runId 非法')
  })

  it('数据根默认是 $DSH_HOME/storages/dsh-window', () => {
    expect(resolveDshHome({ DSH_HOME: '/tmp/dsh-home' })).toBe('/tmp/dsh-home')
    expect(resolveDataRoot({ DSH_HOME: '/tmp/dsh-home' })).toBe(join('/tmp/dsh-home', 'storages', 'dsh-window'))
  })

  it('RunListIndex 随 create/update 维护，损坏后按 run.json 重建', async () => {
    const root = await tempRoot()
    const store = new FsRunStore({ root })
    await store.create(record({ runId: 'run-a' }))
    await store.create(record({ runId: 'run-b', createdBy: 'dispatch', status: 'running', lastActivityAt: 5, updatedAt: 5 }))

    const rows = await store.listIndex()
    expect(rows.map((row) => row.runId).sort()).toEqual(['run-a', 'run-b'])
    expect(rows.find((row) => row.runId === 'run-b')).toMatchObject({
      createdBy: 'dispatch',
      runStatus: 'running',
      lastActivityAt: 5,
    })

    await store.update('run-a', { status: 'completed', lastActivityAt: 9, updatedAt: 9 })
    expect((await store.listIndex()).find((row) => row.runId === 'run-a')).toMatchObject({ runStatus: 'completed', lastActivityAt: 9 })

    // 索引损坏/缺失 → 重建，不丢 run
    await rm(store.indexPath(), { force: true })
    const rebuilt = await store.listIndex()
    expect(rebuilt.map((row) => row.runId).sort()).toEqual(['run-a', 'run-b'])
  })

  it('control.jsonl append-only 追加与读取', async () => {
    const store = new FsRunStore({ root: await tempRoot() })
    await store.create(record())
    await store.appendControl('run-a', {
      eventId: 'e1',
      runId: 'run-a',
      kind: 'send',
      actorSessionId: 'session-origin',
      at: 10,
      result: 'accepted',
    })
    await store.appendControl('run-a', {
      eventId: 'e2',
      runId: 'run-a',
      kind: 'interrupt-turn',
      actorSessionId: 'session-origin',
      at: 11,
      result: 'target-offline',
    })
    expect((await store.readControl('run-a')).map((event) => event.kind)).toEqual(['send', 'interrupt-turn'])
  })

  it('cleanup 清理半截 .tmp 文件，settle 等待内部写入落定', async () => {
    const root = await tempRoot()
    const store = new FsRunStore({ root })
    await store.create(record({ runId: 'run-a' }))
    await writeFile(join(root, 'runs', '.orphan.tmp'), 'half', 'utf8')
    await writeFile(join(root, 'runs', 'run-a', '.half.tmp'), 'half', 'utf8')

    expect(await store.cleanup()).toBe(2)
    await expect(store.settle()).resolves.toBeUndefined()
    expect((await store.list()).map((item) => item.runId)).toEqual(['run-a'])
  })

  it('drainActiveRunsSync 同步标记 drained 并写控制记录与索引（FR-19）', async () => {
    const root = await tempRoot()
    const store = new FsRunStore({ root })
    await store.create(record({ runId: 'run-running', status: 'running' }))
    await store.create(record({ runId: 'run-done', status: 'completed', updatedAt: 2, lastActivityAt: 2 }))

    const done = store.drainActiveRunsSync('插件卸载排空', 99)
    expect(done).toEqual(['run-running'])
    expect((await store.get('run-running'))?.lifecycle).toMatchObject({ state: 'drained' })
    expect((await store.get('run-done'))?.lifecycle).toBeUndefined()
    expect((await store.readControl('run-running')).map((event) => event.kind)).toEqual(['drain'])
    expect((await store.listIndex()).find((row) => row.runId === 'run-running')?.lifecycleState).toBe('drained')

    // 幂等：已 drained 的不再重复处理
    expect(store.drainActiveRunsSync('插件卸载排空', 100)).toEqual([])
  })

  it('非法 runId 抛结构化 WINDOW_INVALID_INPUT（不是裸 Error）', async () => {
    const store = new FsRunStore({ root: await tempRoot() })
    await expect(store.get('../escape')).rejects.toMatchObject({ code: 'WINDOW_INVALID_INPUT' })
  })

  it('缺必需字段的 run.json 按损坏隔离，list 不返回它', async () => {
    const root = await tempRoot()
    const store = new FsRunStore({ root })
    await store.create(record({ runId: 'run-shape' }))
    await writeFile(join(root, 'runs', 'run-shape', 'run.json'), JSON.stringify({ foo: 'bar' }), 'utf8')
    expect((await store.list()).map((item) => item.runId)).not.toContain('run-shape')
  })

  it('JSONL 半行不再让整份留痕消失', async () => {
    const root = await tempRoot()
    const store = new FsRunStore({ root })
    await store.create(record({ runId: 'run-jsonl' }))
    await store.appendControl('run-jsonl', {
      eventId: 'e1', runId: 'run-jsonl', kind: 'send', actorSessionId: 'session-origin', at: 1, result: 'accepted',
    })
    await appendFile(join(root, 'runs', 'run-jsonl', 'control.jsonl'), '{"eventId":"e2"', 'utf8')
    expect((await store.readControl('run-jsonl')).map((event) => event.eventId)).toEqual(['e1'])
  })

  it('索引新鲜度：损坏隔离后连续 listIndex 不再每次重建', async () => {
    const root = await tempRoot()
    const store = new FsRunStore({ root })
    await store.create(record({ runId: 'run-a' }))
    await store.create(record({ runId: 'run-b' }))
    await writeFile(join(root, 'runs', 'run-b', 'run.json'), '{半截', 'utf8')
    await store.list()
    await store.listIndex()
    const first = (await stat(join(root, 'runs', 'index.json'))).mtimeMs
    await store.listIndex()
    expect((await stat(join(root, 'runs', 'index.json'))).mtimeMs).toBe(first)
  })

  it('索引被清空后 listIndex 必须收回仍存在的 run（不能因 mtime 更早而永久缺席）', async () => {
    const root = await tempRoot()
    const store = new FsRunStore({ root })
    await store.create(record({ runId: 'run-a' }))
    await store.create(record({ runId: 'run-b' }))
    await store.listIndex()
    await writeFile(join(root, 'runs', 'index.json'), '[]\n', 'utf8')
    const rows = await store.listIndex()
    expect(rows.map((row) => row.runId).sort()).toEqual(['run-a', 'run-b'])
  })

  it('drainActiveRunsSync 原子性：不留 .tmp，run.json 仍完整可解析，控制记录可读回', async () => {
    const root = await tempRoot()
    const store = new FsRunStore({ root })
    await store.create(record({ runId: 'run-a', status: 'running' }))
    // 先造一个半截临时文件，确认 drain 不会把它当记录、也不会自己留下新的 .tmp
    await writeFile(join(root, 'runs', 'run-a', '.stale.tmp'), 'half', 'utf8')

    const done = store.drainActiveRunsSync('插件卸载排空', 123)
    expect(done).toEqual(['run-a'])

    const entries = await readdir(join(root, 'runs', 'run-a'))
    expect(entries.filter((name) => name.endsWith('.tmp'))).toEqual(['.stale.tmp'])

    // run.json 必须是完整 JSON 且关键字段齐全（同步写不能截断）
    const raw = JSON.parse(await readFile(store.pathOf('run-a'), 'utf8')) as {
      runId?: string
      status?: string
      lifecycle?: { state?: string; at?: number }
      callbackArmed?: boolean
    }
    expect(raw).toMatchObject({
      runId: 'run-a',
      status: 'running',
      lifecycle: { state: 'drained', at: 123 },
    })

    // 控制记录与索引同步落盘
    expect((await store.readControl('run-a')).map((event) => event.kind)).toEqual(['drain'])
    expect((await store.listIndex()).find((row) => row.runId === 'run-a')?.lifecycleState).toBe('drained')

    // 半截 .tmp 交给 cleanup 处理，不影响记录可读
    expect(await store.cleanup()).toBe(1)
    expect((await store.list()).map((item) => item.runId)).toEqual(['run-a'])
  })
})
