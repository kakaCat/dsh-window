import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const ROOT = process.cwd()

/** 递归列出 src 下的 TypeScript 文件。 */
async function sourceFiles(): Promise<string[]> {
  const entries = await readdir(join(ROOT, 'src'), { recursive: true, withFileTypes: true })
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.ts'))
    .map((entry) => join(entry.parentPath ?? join(ROOT, 'src'), entry.name))
}

describe('独立插件边界', () => {
  it('package.json 不依赖任何 PM 包', async () => {
    const pkg = JSON.parse(await readFile(join(ROOT, 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>
      peerDependencies?: Record<string, string>
      devDependencies?: Record<string, string>
    }
    const names = [
      ...Object.keys(pkg.dependencies ?? {}),
      ...Object.keys(pkg.peerDependencies ?? {}),
      ...Object.keys(pkg.devDependencies ?? {}),
    ]
    expect(names.filter((name) => /^(dsh-pmboard|pm-|tool-pm)/.test(name))).toEqual([])
  })

  it('源码不 import PM 包，也不使用会冒充用户的 prompt 入口', async () => {
    const files = await sourceFiles()
    expect(files.length).toBeGreaterThan(0)
    for (const file of files) {
      const text = await readFile(file, 'utf8')
      expect(text, file).not.toMatch(/from ['"](dsh-pmboard|pm-core|pm-common|tool-pm)/)
      expect(text, file).not.toContain('sessionController.prompt')
    }
  })
})
