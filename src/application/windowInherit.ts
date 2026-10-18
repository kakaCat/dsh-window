/**
 * 开窗继承：标题 / Agent 预设 / 模型三项三态，纯编排、零宿主 import。
 *
 * 纪律：不短路、读不到记 failed、源没有记 skipped、继承失败不改变开窗成败。
 *
 * @module dsh-window/application/windowInherit
 */
import type {
  WindowInheritance,
  WindowInheritanceStatus,
  WindowModelSelection,
  WindowOpenerPort,
  WindowProfileRead,
  WindowSourceProfile,
} from './ports.js'
import type { Scenario } from '../shared/protocol.js'

/** 半角标题后缀：`标题(2)` → `标题(3)`。 */
const ASCII_SUFFIX_RE = /^(.*?)\((\d+)\)$/u
/** 全角标题后缀：`标题（2）` → `标题（3）`。 */
const FULLWIDTH_SUFFIX_RE = /^(.*?)（(\d+)）$/u

/** 与宿主客户端同口径的标题递增。 */
export function increasedWindowTitle(title: string): string {
  const ascii = ASCII_SUFFIX_RE.exec(title)
  if (ascii?.[1] !== undefined && ascii[2] !== undefined) {
    return `${ascii[1]}(${BigInt(ascii[2]) + 1n})`
  }
  const fullWidth = FULLWIDTH_SUFFIX_RE.exec(title)
  if (fullWidth?.[1] !== undefined && fullWidth[2] !== undefined) {
    return `${fullWidth[1]}（${BigInt(fullWidth[2]) + 1n}）`
  }
  return `${title} (1)`
}

/** 非空 trim 字符串读数；空串 / 纯空白 / 非字符串按缺失。 */
function textOf(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined
  const trimmed = raw.trim()
  return trimmed.length > 0 ? trimmed : undefined
}

/** 模型读数归一：provider 与 model 都非空才算有读数。 */
function selectionOf(raw: unknown): WindowModelSelection | undefined {
  if (raw === null || typeof raw !== 'object') return undefined
  const value = raw as { provider?: unknown; model?: unknown; reasoningEffort?: unknown }
  const provider = textOf(value.provider)
  const model = textOf(value.model)
  if (provider === undefined || model === undefined) return undefined
  const reasoningEffort = textOf(value.reasoningEffort)
  return { provider, model, ...(reasoningEffort === undefined ? {} : { reasoningEffort }) }
}

/** 画像归一：只保留真实读数。 */
export function normalizeWindowProfile(raw: unknown): WindowSourceProfile {
  if (raw === null || typeof raw !== 'object') return {}
  const source = raw as Record<string, unknown>
  const profile: WindowSourceProfile = {}
  const title = textOf(source['title'])
  const agentPreset = textOf(source['agentPreset'])
  const modelSelection = selectionOf(source['modelSelection'])
  if (title !== undefined) profile.title = title
  if (agentPreset !== undefined) profile.agentPreset = agentPreset
  if (modelSelection !== undefined) profile.modelSelection = modelSelection
  return profile
}

/**
 * 投影行解包：宿主可能返回 `{ ver, seq, val }` 形式的投影行，也可能直接返回值。
 * 只认带 `val` 且带 `ver`/`seq` 的对象，避免把普通业务对象误拆。
 */
function unwrapProjection(raw: unknown): unknown {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return raw
  const row = raw as Record<string, unknown>
  if ('val' in row && ('ver' in row || 'seq' in row)) return row['val']
  return raw
}

/** 宿主投影 → 画像；模型读数在 `modelSelection.next`（投影行会先解包）。 */
export function windowProfileFromProjectionValues(values: unknown): WindowSourceProfile {
  if (values === null || typeof values !== 'object') return {}
  const raw = values as Record<string, unknown>
  const modelSelection = unwrapProjection(raw['modelSelection'])
  const next = modelSelection !== null && typeof modelSelection === 'object'
    ? (modelSelection as Record<string, unknown>)['next']
    : undefined
  return normalizeWindowProfile({
    title: unwrapProjection(raw['title']),
    agentPreset: unwrapProjection(raw['agentPreset']),
    modelSelection: next ?? modelSelection,
  })
}

/** seed 任务包里的协议行；派生标题时跳过。 */
const PROTOCOL_LINE_RE = /^(?:\[DSH Window|scenario:|run_id:|完成后必须|普通 turn\/end|本窗口接管|你正在同一个分支窗口|-{3,})/u

/** 标题上限（含前缀），超出截断加省略号。 */
const TITLE_EXCERPT_MAX = 36

/**
 * 按任务派生窗口标题：`续接：…` / `分叉：…` + seed 首条有效内容。
 *
 * 为什么不用源标题递增：fork 会继承父会话历史，宿主按「首条用户消息」自动命名，
 * 同一源派出的多个窗口会得到完全相同的标题；按任务摘要命名才能区分各窗口用途。
 * 源没有可用 seed 摘要时返回 undefined，由调用方回退源标题递增。
 */
export function deriveTaskTitle(scenario: Scenario, seedText: string): string | undefined {
  if (typeof seedText !== 'string' || seedText.trim().length === 0) return undefined
  for (const line of seedText.split(/\r?\n/)) {
    const text = line.trim()
    if (text.length === 0) continue
    if (PROTOCOL_LINE_RE.test(text)) continue
    const clean = text.replace(/^[#>*\-\s]+/u, '').replace(/\s+/gu, ' ').trim()
    if (clean.length === 0) continue
    const excerpt = clean.length > TITLE_EXCERPT_MAX ? `${clean.slice(0, TITLE_EXCERPT_MAX)}…` : clean
    return `${scenario === 'continuation' ? '续接' : '分叉'}：${excerpt}`
  }
  return undefined
}

/** 结构化错误可读化；跨包不依赖 instanceof。 */
function reasonText(error: unknown): string {
  if (error instanceof Error) return error.message
  if (typeof error === 'object' && error !== null) {
    const message = (error as { message?: unknown }).message
    if (typeof message === 'string' && message.length > 0) return message
  }
  return String(error)
}

/** 读源会话画像；永不抛，读不到把原因收进 reason。 */
export async function readWindowProfile(
  opener: WindowOpenerPort,
  sessionId: string,
): Promise<WindowProfileRead> {
  try {
    if (opener.readProfile === undefined) {
      return { reason: '未装配读画像能力（readProfile）' }
    }
    const raw = await opener.readProfile(sessionId)
    if (raw === null || typeof raw !== 'object') {
      return { reason: '读画像失败：readProfile 未返回画像对象' }
    }
    return { profile: normalizeWindowProfile(raw) }
  } catch (error: unknown) {
    return { reason: `读画像失败：${reasonText(error)}` }
  }
}

/** 模式三态；create 路径回带 agentPreset，fork 路径由宿主继承。 */
export function presetInheritanceOf(
  read: WindowProfileRead,
  mode: 'fork' | 'create',
): { status: WindowInheritanceStatus; reason?: string; agentPreset?: string } {
  if (read.profile === undefined) {
    return { status: 'failed', reason: `源会话画像不可得：${read.reason ?? '原因未知'}` }
  }
  const agentPreset = textOf(read.profile.agentPreset)
  if (agentPreset === undefined) {
    return { status: 'skipped', reason: '源会话未登记 Agent 预设' }
  }
  return { status: 'set', ...(mode === 'create' ? { agentPreset } : {}) }
}

/** 落定继承三步并合成回执；任一步失败不影响其他两步。 */
export async function applyWindowInheritance(
  opener: WindowOpenerPort,
  args: {
    childKey: string
    mode: 'fork' | 'create'
    scenario: Scenario
    seedText: string
    sourceRead: WindowProfileRead
    explicitTitle?: string
  },
): Promise<WindowInheritance> {
  const profile = args.sourceRead.profile
  const reasons: string[] = []

  const explicit = textOf(args.explicitTitle)
  const taskTitle = deriveTaskTitle(args.scenario, args.seedText)
  const sourceTitle = textOf(profile?.title)
  const wantTitle = explicit
    ?? taskTitle
    ?? (sourceTitle === undefined ? undefined : increasedWindowTitle(sourceTitle))
  let title: WindowInheritanceStatus
  if (wantTitle !== undefined) {
    if (opener.rename === undefined) {
      title = 'failed'
      reasons.push('标题：未装配写标题能力（rename）')
    } else {
      try {
        await opener.rename(args.childKey, wantTitle)
        title = 'set'
      } catch (error: unknown) {
        title = 'failed'
        reasons.push(`标题：写标题失败：${reasonText(error)}`)
      }
    }
  } else if (profile === undefined) {
    title = 'failed'
    reasons.push(`标题：源会话画像不可得：${args.sourceRead.reason ?? '原因未知'}`)
  } else {
    title = 'skipped'
    reasons.push('标题：seed 无可派生摘要且源会话无标题')
  }

  const preset = presetInheritanceOf(args.sourceRead, args.mode)
  if (preset.status !== 'set') reasons.push(`模式：${preset.reason ?? '未继承'}`)

  const selection = selectionOf(profile?.modelSelection)
  let model: WindowInheritanceStatus
  if (selection !== undefined) {
    if (opener.selectModel === undefined) {
      model = 'failed'
      reasons.push('模型：未装配设模型能力（selectModel）')
    } else {
      try {
        await opener.selectModel(args.childKey, selection)
        model = 'set'
      } catch (error: unknown) {
        model = 'failed'
        reasons.push(`模型：设模型失败：${reasonText(error)}`)
      }
    }
  } else if (profile === undefined) {
    model = 'failed'
    reasons.push(`模型：源会话画像不可得：${args.sourceRead.reason ?? '原因未知'}`)
  } else {
    model = 'skipped'
    reasons.push('模型：源会话无模型读数')
  }

  return { title, preset: preset.status, model, reasons }
}
