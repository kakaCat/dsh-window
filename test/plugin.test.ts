import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { apply, name } from '../src/index.js'

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

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(async (root) => rm(root, { recursive: true, force: true })))
})

describe('Cordis 装载', () => {
  it('注册全部工具、声明插件名并提供 window Host Service', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-window-plugin-'))
    roots.push(root)
    const runtime: FakeRuntime = { registered: [], logs: [], provided: {}, effects: [] }
    apply(fakeHost(runtime).ctx as never, { dataRoot: root })

    expect(name).toBe('dsh-window')
    expect(runtime.registered).toHaveLength(15)
    expect(runtime.registered.map((tool) => (tool as { name?: string }).name)).toEqual([
      'window_open',
      'window_complete',
      'window_status',
      'window_retry_callback',
      'window_dispatch',
      'window_list',
      'window_inspect',
      'window_send',
      'window_interrupt',
      'window_wait',
      'window_topic_create',
      'window_topic_join',
      'window_topic_get',
      'window_topic_append',
      'window_topic_claim',
    ])
    expect(runtime.logs.join('')).toContain('已注册 15 个工具')

    // REQ §6.5：对外可注入点
    const service = runtime.provided['window'] as Record<string, unknown> | undefined
    expect(service).toBeDefined()
    expect(typeof service?.['open']).toBe('function')
    expect(typeof service?.['stopForOrigin']).toBe('function')
    expect(runtime.logs.join('')).toContain('已 provide window Host Service')

    // Cordis 清理：drain 必须注册成 effect（没有 dispose 公共事件）
    expect(runtime.effects).toHaveLength(1)
    expect(runtime.logs.join('')).not.toContain('ctx.effect 不可用')
  })
})
