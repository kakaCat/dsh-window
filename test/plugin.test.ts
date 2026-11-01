import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { apply as applyDialogue, name as dialogueName } from '../src/index.js'
import { apply as applyControl, name as controlName } from '../src/control.js'
import { apply as applyTopic, name as topicName } from '../src/topic.js'

interface FakeRuntime {
  registered: unknown[]
  logs: string[]
  provided: Record<string, unknown>
  effects: (() => unknown)[]
}

function fakeHost(runtime: FakeRuntime): { ctx: unknown; runtime: FakeRuntime } {
  const services: Record<string, unknown> = {
    tools: { register: (tool: unknown) => { runtime.registered.push(tool); return () => undefined } },
    sessionController: {},
    agents: {},
    workspaceRegistry: {},
  }
  return {
    runtime,
    ctx: {
      logger: () => ({
        info: (message: string) => runtime.logs.push(message),
        warn: (message: string) => runtime.logs.push(`warn:${message}`),
        debug: () => undefined,
      }),
      inject: (names: string[], callback: (ctx: Record<string, unknown>) => void) => {
        const selected: Record<string, unknown> = {}
        for (const serviceName of names) selected[serviceName] = services[serviceName]
        callback(selected)
      },
      provide: (serviceName: string, value: unknown) => {
        runtime.provided[serviceName] = value
        return () => undefined
      },
      effect: (execute: () => unknown) => {
        runtime.effects.push(execute)
        return () => undefined
      },
    },
  }
}

function names(runtime: FakeRuntime): string[] {
  return runtime.registered.map((tool) => (tool as { name?: string }).name) as string[]
}

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(async (root) => rm(root, { recursive: true, force: true })))
})

describe('Cordis 装载（三行：对话 / 管控 / 协作）', () => {
  it('对话组注册 5 个工具、provide window Host Service、并接管 drain', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-window-plugin-'))
    roots.push(root)
    const runtime: FakeRuntime = { registered: [], logs: [], provided: {}, effects: [] }
    applyDialogue(fakeHost(runtime).ctx as never, { dataRoot: root })

    expect(dialogueName).toBe('dsh-window')
    expect(names(runtime)).toEqual([
      'window_open',
      'window_send',
      'window_complete',
      'window_status',
      'window_list',
    ])
    expect(runtime.logs.join('')).toContain('对话组已注册 5 个工具')

    // REQ §6.5：对外可注入点（只有对话组提供）
    const service = runtime.provided['window'] as Record<string, unknown> | undefined
    expect(service).toBeDefined()
    expect(typeof service?.['open']).toBe('function')
    expect(typeof service?.['stopForOrigin']).toBe('function')
    expect(runtime.logs.join('')).toContain('已 provide window Host Service')

    // Cordis 清理：drain 必须注册成 effect（没有 dispose 公共事件）
    expect(runtime.effects).toHaveLength(1)
    expect(runtime.logs.join('')).not.toContain('ctx.effect 不可用')

  })

  it('管控组只注册自己的 5 个工具，不第二次 provide、不跑 drain', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-window-plugin-'))
    roots.push(root)
    const runtime: FakeRuntime = { registered: [], logs: [], provided: {}, effects: [] }
    applyControl(fakeHost(runtime).ctx as never, { dataRoot: root })

    expect(controlName).toBe('dsh-window/control')
    expect(names(runtime)).toEqual([
      'window_dispatch',
      'window_inspect',
      'window_interrupt',
      'window_wait',
      'window_retry_callback',
    ])
    expect(runtime.logs.join('')).toContain('管控组已注册 5 个工具')
    expect(runtime.provided['window']).toBeUndefined()
    expect(runtime.effects).toHaveLength(0)
  })

  it('协作组只注册 6 个 topic 工具，不第二次 provide、不跑 drain', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-window-plugin-'))
    roots.push(root)
    const runtime: FakeRuntime = { registered: [], logs: [], provided: {}, effects: [] }
    applyTopic(fakeHost(runtime).ctx as never, { dataRoot: root })

    expect(topicName).toBe('dsh-window/topic')
    expect(names(runtime)).toEqual([
      'window_topic_create',
      'window_topic_join',
      'window_topic_get',
      'window_topic_append',
      'window_topic_claim',
      'window_topic_send',
    ])
    expect(runtime.logs.join('')).toContain('协作组已注册 6 个工具')
    expect(runtime.provided['window']).toBeUndefined()
    expect(runtime.effects).toHaveLength(0)
  })

  it('三行全开时合起来正好是原来的 16 个工具，且没有重复', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-window-plugin-'))
    roots.push(root)
    const runtime: FakeRuntime = { registered: [], logs: [], provided: {}, effects: [] }
    const host = fakeHost(runtime)
    applyDialogue(host.ctx as never, { dataRoot: root })
    applyControl(host.ctx as never, { dataRoot: root })
    applyTopic(host.ctx as never, { dataRoot: root })

    const all = names(runtime)
    expect(all).toHaveLength(16)
    expect(new Set(all).size).toBe(16)
  })
})
