/**
 * 运行时发现（D-12）。
 *
 * **能力不是配置项，是事实。** 模型清单、"吃不吃图"、"单图多少 token"、"支不支持
 * 原生 tool_calls" 全都随账号权限、模型版本、灰度命名而变，任何静态表都会过期。
 * 所以这里做三条实测：
 *
 * 1. `GET /models`   —— 这个 key 到底能调哪些模型
 * 2. 文本 + 工具探针 —— 能不能调通、工具调用走哪条路
 * 3. 视觉探针        —— 同一句话，一次带图一次不带，两次 `prompt_tokens` 的**差**
 *                       就是这张图真实的 token 成本
 *
 * 探针结果写回 `config.capabilities` 并标 `source: 'probe'`。UI 要如实区分
 * "实测出来的" 和 "用户手填的"，不能把猜测说成实测。
 */

import { t } from '@architect/i18n'
import { Canvas, encodePng } from '@architect/render'

import { LlmError } from '../types.js'
import type { LlmToolSchema } from '../types.js'
import { configFromPreset, PROVIDER_PRESETS } from './config.js'
import type { PresetKey, ProviderCapabilities, ProviderConfig, ToolCallingMode } from './config.js'
import { classifyHttpError, OpenAiCompatibleProvider } from './openai.js'

export interface ModelInfo {
  id: string
  ownedBy?: string
  /** 有些网关会顺带返回上下文窗口；有就采信，没有就不猜。 */
  contextWindow?: number
}

export type ProbeStep =
  | { type: 'models'; count: number; models: string[] }
  | { type: 'model'; model: string; matched?: string; guessed?: boolean }
  | { type: 'text'; ok: boolean; tokensIn?: number; error?: string }
  | { type: 'tools'; mode: ToolCallingMode }
  | { type: 'vision'; vision: boolean; imageTokenCost?: number; error?: string }
  | { type: 'capabilities'; capabilities: ProviderCapabilities }
  | { type: 'error'; error: string }

export interface DiscoverOptions {
  /** 注入的 fetch（测试用）。 */
  fetchImpl?: typeof fetch
  /** 已解析出的密钥。省略表示这个 provider 不需要密钥。 */
  apiKey?: string
  /** 跳过 `GET /models` 的挑选，强制探测这个模型。 */
  model?: string
  /** 只列模型，不跑能力探针。 */
  listOnly?: boolean
  /** 探针截图的边长。默认 336（足够大，不会踩到最小 patch 的下限）。 */
  probeImageEdge?: number
  /** 单次请求超时。默认 30s。 */
  timeoutMs?: number
  onStep?: (step: ProbeStep) => void
}

export interface DiscoveryResult {
  ok: boolean
  /** 写回了 `model` 与 `capabilities` 的配置副本。 */
  config: ProviderConfig
  models: string[]
  steps: ProbeStep[]
  error?: string
}

const DEFAULT_TIMEOUT_MS = 30_000
const DEFAULT_PROBE_EDGE = 336

/** `GET /models`。Ollama 的 `/v1/models` 与 OpenAI 同形，所以一份解析够用。 */
export async function listModels(
  config: Pick<ProviderConfig, 'baseURL' | 'kind'>,
  options: { apiKey?: string; fetchImpl?: typeof fetch; timeoutMs?: number } = {},
): Promise<ModelInfo[]> {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch
  const url = `${config.baseURL.replace(/\/+$/, '')}/models`
  const headers: Record<string, string> = { accept: 'application/json' }
  if (options.apiKey !== undefined && options.apiKey.length > 0) {
    headers.authorization = `Bearer ${options.apiKey}`
  }

  let response: Response
  try {
    response = await withTimeout(
      fetchImpl(url, { method: 'GET', headers }),
      options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      `GET ${url}`,
    )
  } catch (error) {
    throw new LlmError(
      t('agent.network.requestFailed', {
        url,
        error: error instanceof Error ? error.message : String(error),
      }),
      'NETWORK',
      true,
    )
  }
  if (!response.ok) {
    const text = await response.text().catch(() => '')
    throw classifyHttpError(response.status, `${url} → ${text.slice(0, 300)}`)
  }

  const payload = (await response.json().catch(() => {
    throw new LlmError(t('agent.discover.modelsInvalidJson', { url }), 'PARSE', false)
  })) as {
    data?: Array<{ id?: string; owned_by?: string; context_length?: number; context_window?: number }>
    models?: Array<{ name?: string; model?: string }>
  }

  const out: ModelInfo[] = []
  for (const entry of payload.data ?? []) {
    if (typeof entry.id !== 'string' || entry.id.length === 0) continue
    const info: ModelInfo = { id: entry.id }
    if (typeof entry.owned_by === 'string') info.ownedBy = entry.owned_by
    const window = entry.context_length ?? entry.context_window
    if (typeof window === 'number') info.contextWindow = window
    out.push(info)
  }
  // Ollama 的原生 /api/tags 形状，顺手兼容一下（用户可能把 baseURL 填成根路径）
  for (const entry of payload.models ?? []) {
    const id = entry.name ?? entry.model
    if (typeof id === 'string' && id.length > 0) out.push({ id })
  }
  out.sort((a, b) => a.id.localeCompare(b.id))
  return out
}

/**
 * 按**偏好**在真实列表里挑一个模型。
 *
 * 不写死 id 的理由见 `PROVIDER_PRESETS.modelPreference`。匹配顺序：精确 > 前缀 > 包含，
 * 同一档里按名字排序取第一个，保证**同样输入必然挑出同一个模型**。
 */
export function pickModel(
  models: readonly string[],
  preference: readonly string[],
): { model: string; matched?: string } | undefined {
  if (models.length === 0) return undefined
  for (const pattern of preference) {
    const needle = pattern.toLowerCase()
    const exact = models.find((m) => m.toLowerCase() === needle)
    if (exact !== undefined) return { model: exact, matched: pattern }
    const prefix = [...models].sort().find((m) => m.toLowerCase().startsWith(needle))
    if (prefix !== undefined) return { model: prefix, matched: pattern }
    const contains = [...models].sort().find((m) => m.toLowerCase().includes(needle))
    if (contains !== undefined) return { model: contains, matched: pattern }
  }
  return undefined
}

/** 探针工具：一个小到不可能被拒、又必须走 tool_calls 才能满足的调用。 */
const PROBE_TOOL: LlmToolSchema = {
  name: 'report_ready',
  description: 'Report readiness. The only way to answer is to call this tool.',
  parameters: {
    type: 'object',
    properties: {
      status: { type: 'string', description: 'Always the literal string "ready".' },
    },
    required: ['status'],
    additionalProperties: false,
  },
}

const VISION_QUESTION = 'What colour dominates this image? Answer with one word.'

/**
 * 跑完整套探针。
 *
 * 任何一步失败都**不会抛**——部分失败也要把已经测出来的东西写回去，
 * 因为"能调通但吃不了图"本身就是最有用的结论。
 */
export async function discoverProvider(
  base: ProviderConfig,
  options: DiscoverOptions = {},
): Promise<DiscoveryResult> {
  const steps: ProbeStep[] = []
  const config: ProviderConfig = structuredClone(base)
  const emit = (step: ProbeStep): void => {
    steps.push(step)
    options.onStep?.(step)
  }
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const fetchImpl = options.fetchImpl ?? globalThis.fetch

  const finish = (ok: boolean, error?: string): DiscoveryResult => {
    const result: DiscoveryResult = {
      ok,
      config,
      models: models.map((m) => m.id),
      steps,
    }
    if (error !== undefined) result.error = error
    return result
  }

  // ── 1. 列模型 ──────────────────────────────────────────────────────────────
  let models: ModelInfo[] = []
  try {
    models = await listModels(config, {
      ...(options.apiKey !== undefined ? { apiKey: options.apiKey } : {}),
      fetchImpl,
      timeoutMs,
    })
    emit({ type: 'models', count: models.length, models: models.map((m) => m.id) })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    emit({ type: 'error', error: message })
    // 鉴权失败就别往下走了——后面每一步都会以同样的理由失败，白花钱
    if (error instanceof LlmError && error.code === 'AUTH') return finish(false, message)
  }

  // ── 2. 选定模型 ────────────────────────────────────────────────────────────
  const preset = PROVIDER_PRESETS[config.preset] ?? PROVIDER_PRESETS.custom
  const preferenceHit =
    options.model !== undefined ? undefined : pickModel(models.map((m) => m.id), preset.modelPreference)
  let chosen = options.model ?? preferenceHit?.model ?? (config.model.length > 0 ? config.model : undefined)
  let guessed = false
  if (chosen === undefined || chosen.length === 0) {
    // 本地模型的命名完全无法预判（Ollama 里可能只有 `mistral:latest`）。
    // 列表里真有东西就先用第一个把能力探通，让用户随后改——比直接失败有用得多。
    const fallback = models[0]?.id
    if (fallback !== undefined) {
      chosen = fallback
      guessed = true
    }
  }
  if (chosen === undefined || chosen.length === 0) {
    const message = t('agent.discover.noModel', { url: config.baseURL })
    emit({ type: 'error', error: message })
    return finish(false, message)
  }
  config.model = chosen
  emit({
    type: 'model',
    model: chosen,
    ...(preferenceHit?.matched !== undefined ? { matched: preferenceHit.matched } : {}),
    ...(guessed ? { guessed: true } : {}),
  })

  const listed = models.find((m) => m.id === config.model)
  config.capabilities = {
    ...config.capabilities,
    promptCache: preset.promptCache,
    source: 'preset',
    ...(listed?.contextWindow !== undefined ? { contextWindow: listed.contextWindow } : {}),
  }

  if (options.listOnly === true) {
    emit({ type: 'capabilities', capabilities: config.capabilities })
    return finish(true)
  }

  const provider = new OpenAiCompatibleProvider({
    id: config.id,
    baseURL: config.baseURL,
    ...(options.apiKey !== undefined ? { apiKey: options.apiKey } : {}),
    model: config.model,
    supportsImages: true,
    ...(config.compat !== undefined ? { compat: config.compat } : {}),
    ...(config.maxOutputTokens !== undefined ? { maxOutputTokens: config.maxOutputTokens } : {}),
    fetchImpl,
  })

  // ── 3. 文本探针：能不能调通 ────────────────────────────────────────────────
  let baselineIn: number | undefined
  try {
    const response = await withTimeout(
      provider.chat({
        system: '',
        messages: [{ role: 'user', content: VISION_QUESTION }],
        tools: [],
        maxTokens: 16,
      }),
      timeoutMs,
      t('agent.discover.probeText'),
    )
    baselineIn = response.usage.in
    emit({ type: 'text', ok: true, tokensIn: baselineIn })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    emit({ type: 'text', ok: false, error: message })
    emit({ type: 'capabilities', capabilities: config.capabilities })
    return finish(false, message)
  }

  // ── 4. 工具调用探针 ────────────────────────────────────────────────────────
  let toolCalling: ToolCallingMode = 'prompted'
  try {
    const response = await withTimeout(
      provider.chat({
        system: '',
        messages: [
          {
            role: 'user',
            content: 'Call the report_ready tool with status="ready". Do not answer with plain text.',
          },
        ],
        tools: [PROBE_TOOL],
        maxTokens: 128,
      }),
      timeoutMs,
      t('agent.discover.probeTools'),
    )
    toolCalling =
      response.toolCalls.some((call) => call.name === 'report_ready') || response.toolCalls.length > 0
        ? 'native'
        : looksLikeJsonToolCall(response.text)
          ? 'json-mode'
          : 'prompted'
  } catch {
    // 模型不支持 tools 参数时这里会 400——那本身就是结论
    toolCalling = 'prompted'
  }
  emit({ type: 'tools', mode: toolCalling })

  // ── 5. 视觉探针：同题带图 / 不带图，差就是图的钱 ────────────────────────────
  let vision = false
  let imageTokenCost: number | undefined
  try {
    const response = await withTimeout(
      provider.chat({
        system: '',
        messages: [
          {
            role: 'user',
            content: VISION_QUESTION,
            images: [
              { png: probeImage(options.probeImageEdge ?? DEFAULT_PROBE_EDGE), mimeType: 'image/png', id: 'probe' },
            ],
          },
        ],
        tools: [],
        maxTokens: 16,
      }),
      timeoutMs,
      t('agent.discover.probeVision'),
    )
    vision = true
    const delta = response.usage.in - baselineIn
    // 差为 0 说明这个网关不把图像算进 prompt_tokens——那就**不报数**，
    // 报一个 0 会让成本表盘骗人
    if (delta > 0) imageTokenCost = delta
    emit({
      type: 'vision',
      vision: true,
      ...(imageTokenCost !== undefined ? { imageTokenCost } : {}),
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    vision = false
    emit({ type: 'vision', vision: false, error: message })
  }

  config.capabilities = {
    vision,
    toolCalling,
    promptCache: preset.promptCache,
    source: 'probe',
    probedAt: new Date().toISOString(),
    ...(imageTokenCost !== undefined ? { imageTokenCost } : {}),
    ...(config.capabilities.contextWindow !== undefined
      ? { contextWindow: config.capabilities.contextWindow }
      : {}),
  }
  emit({ type: 'capabilities', capabilities: config.capabilities })
  return finish(true)
}

/** 从配置建一个可用的 provider。密钥**由调用方解析后传入**，这里不碰存储。 */
export function createProvider(
  config: ProviderConfig,
  options: { apiKey?: string; fetchImpl?: typeof fetch } = {},
): OpenAiCompatibleProvider {
  return new OpenAiCompatibleProvider({
    id: config.id,
    baseURL: config.baseURL,
    ...(options.apiKey !== undefined ? { apiKey: options.apiKey } : {}),
    model: config.model,
    supportsImages: config.capabilities.vision,
    ...(config.compat !== undefined ? { compat: config.compat } : {}),
    ...(config.maxOutputTokens !== undefined ? { maxOutputTokens: config.maxOutputTokens } : {}),
    ...(options.fetchImpl !== undefined ? { fetchImpl: options.fetchImpl } : {}),
  })
}

/** 预设 → 配置 → 探针，一步到位（设置页「测试连接」就是这个）。 */
export async function discoverPreset(
  key: PresetKey,
  options: DiscoverOptions & { apiKeyRef?: string } = {},
): Promise<DiscoveryResult> {
  const config = configFromPreset(key, {
    ...(options.apiKeyRef !== undefined ? { apiKeyRef: options.apiKeyRef } : {}),
  })
  return discoverProvider(config, options)
}

/** 探针图：8×8 的红蓝棋盘。**必须是非均匀图**，纯色图连"没看"都能蒙对。 */
function probeImage(edge: number): Uint8Array {
  const canvas = new Canvas(edge, edge)
  const cell = Math.max(1, Math.floor(edge / 8))
  for (let y = 0; y < edge; y++) {
    for (let x = 0; x < edge; x++) {
      const on = (Math.floor(x / cell) + Math.floor(y / cell)) % 2 === 0
      const i = (y * edge + x) * 4
      canvas.data[i] = on ? 220 : 20
      canvas.data[i + 1] = 40
      canvas.data[i + 2] = on ? 40 : 200
      canvas.data[i + 3] = 255
    }
  }
  return encodePng(canvas)
}

/** 模型没用原生 tool_calls，但吐了个像样的 JSON 调用——那就是 json-mode。 */
function looksLikeJsonToolCall(text: string): boolean {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text)
  const candidate = (fenced?.[1] ?? text).trim()
  const start = candidate.indexOf('{')
  const end = candidate.lastIndexOf('}')
  if (start < 0 || end <= start) return false
  try {
    const parsed = JSON.parse(candidate.slice(start, end + 1)) as Record<string, unknown>
    const hasName = typeof parsed['name'] === 'string' || typeof parsed['tool'] === 'string'
    const hasArgs = 'arguments' in parsed || 'args' in parsed || 'parameters' in parsed
    return hasName && hasArgs
  } catch {
    return false
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(t('agent.discover.timeout', { label, ms }))), ms)
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error: unknown) => {
        clearTimeout(timer)
        reject(error instanceof Error ? error : new Error(String(error)))
      },
    )
  })
}

