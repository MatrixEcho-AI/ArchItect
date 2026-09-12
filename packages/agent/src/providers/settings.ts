/**
 * 设置文件的读写模型（plan §13.3、§9.5）。
 *
 * **两条红线在这里体现为代码**：
 *
 * 1. `serializeSettings` 写出去的东西里**不可能**包含密钥——因为 `ProviderConfig`
 *    里只有 `env:NAME` / `safe:id` 这样的**指针**，类型上就没有放密钥的地方。
 * 2. `parseSettings` 遇到疑似密钥的字段会**丢掉并记一条 issue**。用户把 `sk-...`
 *    粘进 `apiKeyRef`、或者手改 json 塞了个 `apiKey` 字段，都不会被静默带进运行时。
 */

import { t } from '@architect/i18n'

import { envKeyRef, configFromPreset, PROVIDER_PRESETS, validateProviderConfig } from './config.js'
import type { CostTable, PresetKey, ProviderConfig } from './config.js'
import type { Budget } from '../usage.js'

export const SETTINGS_VERSION = 1

export interface ProviderSettings {
  version: number
  /** 当前用哪个 provider 实例。 */
  activeId: string
  providers: ProviderConfig[]
  budget?: Budget
  locale?: 'zh-CN' | 'en-US'
  /** UI 偏好（跟模型无关，但同一个文件里放省事）。 */
  ui?: {
    view?: string
    /** 完成闸门（plan §9.4）。关掉它会让"我说完了"变成可接受的结束方式，默认开。 */
    requireVerification?: boolean
  }
}

/**
 * 默认设置：**内置一个 DeepSeek 预设**（D-12、用户要求"可以内置 DeepSeek 先"）。
 *
 * 注意这**不是**"绑定供应商"（D-02）：它只是设置文件里的一行可编辑配置，
 * 没有任何代码分支认识 `deepseek` 这个名字。换成 OpenAI / Ollama 就是改这一行。
 *
 * `model` 故意留空——由 `GET /models` 发现后写回（D-12）。
 */
export function defaultSettings(): ProviderSettings {
  const deepseek = configFromPreset('deepseek', { id: 'DeepSeek', model: '' })
  return {
    version: SETTINGS_VERSION,
    activeId: deepseek.id,
    providers: [deepseek],
    locale: 'zh-CN',
    ui: { view: 'iso_ne', requireVerification: true },
  }
}

/** 按预设新增一个 provider 实例。id 冲突时自动加后缀，不覆盖用户已有的配置。 */
export function addPreset(settings: ProviderSettings, key: PresetKey, id?: string): ProviderConfig {
  const base = id ?? PROVIDER_PRESETS[key].key
  const taken = new Set(settings.providers.map((p) => p.id))
  let name = base
  for (let n = 2; taken.has(name); n++) name = `${base} ${n}`
  const config = configFromPreset(key, { id: name, model: '' })
  settings.providers.push(config)
  if (settings.activeId.length === 0) settings.activeId = name
  return config
}

export function activeProvider(settings: ProviderSettings): ProviderConfig | undefined {
  return settings.providers.find((p) => p.id === settings.activeId) ?? settings.providers[0]
}

export interface SettingsIssue {
  field: string
  message: string
}

export interface ParsedSettings {
  settings: ProviderSettings
  issues: SettingsIssue[]
}

/** 长得像密钥就一律拒绝落进运行时（D-13）。 */
const SECRET_LIKE = /^(sk-|sk_|Bearer\s|eyJ)[A-Za-z0-9._-]{8,}$/
const SECRET_FIELD_NAMES = ['apikey', 'api_key', 'key', 'token', 'secret', 'password', 'authorization']

/**
 * 解析设置文件。
 *
 * **永不抛异常**：设置文件损坏时退回默认值并报告问题，
 * 总好过因为一个 json 少了个逗号就打不开应用。
 */
export function parseSettings(raw: unknown): ParsedSettings {
  const issues: SettingsIssue[] = []
  const settings = defaultSettings()

  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    issues.push({ field: '', message: t('agent.settings.notObject') })
    return { settings, issues }
  }
  const source = raw as Record<string, unknown>

  if (typeof source['version'] !== 'number') {
    issues.push({ field: 'version', message: t('agent.settings.missingVersion') })
  } else if (source['version'] > SETTINGS_VERSION) {
    issues.push({
      field: 'version',
      message: t('agent.settings.futureVersion', {
        version: source['version'],
        current: SETTINGS_VERSION,
      }),
    })
  }

  if (source['locale'] === 'zh-CN' || source['locale'] === 'en-US') settings.locale = source['locale']

  const providers = source['providers']
  if (Array.isArray(providers) && providers.length > 0) {
    const parsed: ProviderConfig[] = []
    for (const [index, entry] of providers.entries()) {
      const result = parseProvider(entry, index, issues)
      if (result !== undefined) parsed.push(result)
    }
    if (parsed.length > 0) {
      settings.providers = parsed
      settings.activeId = typeof source['activeId'] === 'string' ? source['activeId'] : parsed[0]!.id
      if (!parsed.some((p) => p.id === settings.activeId)) {
        issues.push({
          field: 'activeId',
          message: t('agent.settings.activeIdMissing', {
            activeId: settings.activeId,
            fallback: parsed[0]!.id,
          }),
        })
        settings.activeId = parsed[0]!.id
      }
    } else {
      issues.push({ field: 'providers', message: t('agent.settings.noProviders') })
    }
  }

  if (source['budget'] !== null && typeof source['budget'] === 'object') {
    const budget = source['budget'] as Record<string, unknown>
    const parsed: Budget = {}
    for (const key of ['maxUsd', 'maxTokensOut', 'maxTurns'] as const) {
      const value = budget[key]
      if (typeof value === 'number' && Number.isFinite(value) && value > 0) parsed[key] = value
      else if (value !== undefined) issues.push({ field: `budget.${key}`, message: t('agent.settings.positiveNumber') })
    }
    if (Object.keys(parsed).length > 0) settings.budget = parsed
  }

  const ui = source['ui']
  if (ui !== null && typeof ui === 'object') {
    const record = ui as Record<string, unknown>
    settings.ui = {
      ...(typeof record['view'] === 'string' ? { view: record['view'] } : {}),
      ...(typeof record['requireVerification'] === 'boolean'
        ? { requireVerification: record['requireVerification'] }
        : {}),
    }
  }

  return { settings, issues }
}

function parseProvider(raw: unknown, index: number, issues: SettingsIssue[]): ProviderConfig | undefined {
  if (raw === null || typeof raw !== 'object') {
    issues.push({ field: `providers[${index}]`, message: t('agent.settings.providerNotObject') })
    return undefined
  }
  const entry = raw as Record<string, unknown>

  // 先把疑似密钥的字段挑出来丢掉——**在任何其它处理之前**，避免它顺着某条路径漏出去
  for (const key of Object.keys(entry)) {
    if (!SECRET_FIELD_NAMES.includes(key.toLowerCase())) continue
    const value = entry[key]
    const looksSecret = typeof value === 'string' && (SECRET_LIKE.test(value) || value.length > 20)
    delete entry[key]
    issues.push({
      field: `providers[${index}].${key}`,
      message: looksSecret ? t('agent.settings.secretDiscarded') : t('agent.settings.unknownField'),
    })
  }

  const preset = typeof entry['preset'] === 'string' && entry['preset'] in PROVIDER_PRESETS
    ? (entry['preset'] as PresetKey)
    : 'custom'
  const fallback = configFromPreset(preset)
  const id = typeof entry['id'] === 'string' && entry['id'].trim().length > 0 ? entry['id'].trim() : fallback.id

  const config: ProviderConfig = {
    id,
    preset,
    kind: entry['kind'] === 'anthropic' ? 'anthropic' : 'openai-compatible',
    baseURL: typeof entry['baseURL'] === 'string' ? entry['baseURL'].trim() : fallback.baseURL,
    apiKeyRef: typeof entry['apiKeyRef'] === 'string' ? entry['apiKeyRef'].trim() : fallback.apiKeyRef,
    model: typeof entry['model'] === 'string' ? entry['model'].trim() : '',
    capabilities: parseCapabilities(entry['capabilities'], fallback.capabilities),
  }
  applyCostShape(config, entry['cost'])

  if (entry['compat'] !== null && typeof entry['compat'] === 'object') {
    config.compat = entry['compat'] as ProviderConfig['compat']
  }
  // 单轮输出上限：文件里没写就用**预设的默认值**（DeepSeek 预设带 8000，理由见 config.ts）。
  //
  // 这一条以前在这里被悄悄丢掉（`config` 是重建的，只挑已知字段），于是
  // "预设给了默认值"和"用户手改设置文件"两条路都走不通——桌面端根本没有这个旋钮，
  // 只能眼睁睁看着单轮生成太久、连接被网关掐断。
  const cap = entry['maxOutputTokens'] ?? fallback.maxOutputTokens
  if (typeof cap === 'number' && Number.isFinite(cap) && cap > 0) {
    config.maxOutputTokens = Math.floor(cap)
  }

  for (const problem of validateProviderConfig(config)) {
    // 缺 baseURL / 缺引用是"还没配完"，不是文件损坏——报出来但不丢弃这一行
    issues.push({ field: `providers[${index}].${problem.field}`, message: problem.message })
  }
  return config
}

/**
 * 把配置里那两种价格写法归一成**一种内存形状**。
 *
 * 文件里两种写法同名（`cost`），靠"输入价与输出价**同时**是数字"区分：
 *
 * - 是 → provider 级的一张表（预设与老文件）。**若已知模型名，仍归一成按模型那张
 *   map**——否则界面读 `costs` 而内存里只有 `cost`，价格表会在打开对话框时看着是空的。
 *   拿不到模型名就留在 `cost` 里：那时没有键可用，查表与界面都会退到 provider 级。
 * - 不是 → 按模型分表，逐项解析；半个表（缺输入或输出价）整张丢掉。
 *
 * **解析与保存必须走同一个函数。** 这条踩过：`parseProvider` 归一了，而
 * `saveProvider` 是把配置直接塞进内存的（不走解析），于是"刚保存的那一份"用的是
 * 文件形状、界面读不到，用户看到价格凭空消失；再点一次保存就真的写没了。
 */
export function applyCostShape(config: ProviderConfig, raw: unknown): void {
  if (raw === null || typeof raw !== 'object') return
  const entry = raw as Record<string, unknown>
  if (typeof entry['inPerMTok'] === 'number' && typeof entry['outPerMTok'] === 'number') {
    const table = parseCostTable(entry)
    if (table === undefined) return
    const model = config.model.trim()
    if (model.length > 0) config.costs = { [model]: table }
    else config.cost = table
    return
  }
  const costs: Record<string, CostTable> = {}
  for (const [model, value] of Object.entries(entry)) {
    if (value === null || typeof value !== 'object') continue
    const table = parseCostTable(value as Record<string, unknown>)
    if (table !== undefined) costs[model] = table
  }
  if (Object.keys(costs).length > 0) config.costs = costs
}

/**
 * 落盘前再归一一次。
 *
 * 存在的理由：`saveProvider` 收到的是**界面拼出来的一份配置**，它只保证"文件形状对"，
 * 不保证内存形状对。归一的规则只写在 `applyCostShape` 一处，这里复用同一份——
 * 于是"启动读文件"与"设置里点保存"两条路得到的内存形状必然一致。
 */
export function normalizeProviderCosts(config: ProviderConfig): ProviderConfig {
  const flat = config.cost
  const perModel = config.costs
  delete config.cost
  delete config.costs
  if (perModel !== undefined) {
    config.costs = perModel
    if (flat !== undefined) config.cost = flat
    return config
  }
  applyCostShape(config, flat)
  return config
}

/**
 * 一张价格表。缺 `inPerMTok` / `outPerMTok` 就**整张丢掉**——半个价格表会让
 * "这次花了多少"变成编出来的数字，而那个数字是刹车依据。
 *
 * 只解析低谷价与缓存价：高峰价在文件里也有（DeepSeek 预设那份），但用户手填的
 * 价格从界面上只填三个数，所以这里只认这三个。
 */
function parseCostTable(raw: Record<string, unknown>): CostTable | undefined {
  if (typeof raw['inPerMTok'] !== 'number' || typeof raw['outPerMTok'] !== 'number') return undefined
  return {
    inPerMTok: raw['inPerMTok'],
    outPerMTok: raw['outPerMTok'],
    ...(typeof raw['cacheReadPerMTok'] === 'number' ? { cacheReadPerMTok: raw['cacheReadPerMTok'] } : {}),
  }
}

function parseCapabilities(raw: unknown, fallback: ProviderConfig['capabilities']): ProviderConfig['capabilities'] {
  if (raw === null || typeof raw !== 'object') return fallback
  const entry = raw as Record<string, unknown>
  const toolCalling = entry['toolCalling']
  return {
    vision: entry['vision'] === true,
    toolCalling:
      toolCalling === 'native' || toolCalling === 'json-mode' || toolCalling === 'prompted'
        ? toolCalling
        : 'native',
    promptCache:
      entry['promptCache'] === 'auto' || entry['promptCache'] === 'explicit' || entry['promptCache'] === 'none'
        ? entry['promptCache']
        : fallback.promptCache,
    source: entry['source'] === 'probe' || entry['source'] === 'user' ? entry['source'] : 'preset',
    ...(typeof entry['imageTokenCost'] === 'number' ? { imageTokenCost: entry['imageTokenCost'] } : {}),
    ...(typeof entry['contextWindow'] === 'number' ? { contextWindow: entry['contextWindow'] } : {}),
    ...(typeof entry['probedAt'] === 'string' ? { probedAt: entry['probedAt'] } : {}),
  }
}

/**
 * 序列化。缩进 2 空格——这个文件是给人看、给人手改的。
 *
 * 有一处**必须改写**：内存里按模型分的价格表叫 `costs`，而文件里它就叫 `cost`
 * （两种写法同名字段，靠"输入价与输出价是不是数字"区分，见 `parseProvider`）。
 * 直接 `JSON.stringify(settings)` 会把 `costs` 原样写出去，于是**自己写出来的文件
 * 自己读不回来**——按模型的价格表在下次启动时静默消失。这条是往返测试抓出来的。
 *
 * 所以这里深拷一份再改名，而不是让内存里的字段也叫 `cost`：`ProviderConfig.cost`
 * 是 provider 级兜底，两者必须能同时存在。
 */
export function serializeSettings(settings: ProviderSettings): string {
  const onDisk = {
    ...settings,
    providers: settings.providers.map((provider) => {
      const { costs, ...rest } = provider
      if (costs === undefined) return rest
      // 两张表同时存在时**并起来**而不是让后者盖掉前者：provider 级那张是兜底，
      // 丢掉它会让"没单独配价的模型"突然没有价格
      const merged = provider.cost !== undefined ? { ...provider.cost, ...costs } : costs
      return { ...rest, cost: merged }
    }),
  }
  return `${JSON.stringify(onDisk, null, 2)}\n`
}

/** 把一个 provider 写回设置（按 id upsert）。 */
export function upsertProvider(settings: ProviderSettings, config: ProviderConfig): ProviderSettings {
  const providers = settings.providers.filter((p) => p.id !== config.id)
  providers.push(config)
  return { ...settings, providers, activeId: config.id }
}

/**
 * 从环境里猜用哪个预设。CLI 的 `--provider` 没给时的兜底。
 *
 * 判据是"哪个环境变量真的有值"，而不是"哪个更像默认"——用户 export 了哪个 key，
 * 他想用的就是那家。都没有就回到 DeepSeek（D-12 的联调目标）。
 */
export function presetFromEnv(env: Record<string, string | undefined>): PresetKey {
  const declared = env['ARCHITECT_PROVIDER']
  if (declared !== undefined && declared in PROVIDER_PRESETS) return declared as PresetKey
  if (hasValue(env['OPENAI_API_KEY'])) return 'openai'
  if (hasValue(env['ARCHITECT_API_KEY'])) return 'deepseek'
  return 'deepseek'
}

/**
 * CLI 用的最小设置：**密钥只从环境变量读**（D-13），连设置文件都不需要存在。
 *
 * 注意这里不读 `env` 的值——密钥是在真正发请求前由 `resolveApiKey` 现取的，
 * 这个函数只决定"引用哪个变量"。这样密钥的生命周期尽可能短。
 */
export function settingsFromEnv(
  env: Record<string, string | undefined>,
  key: PresetKey = presetFromEnv(env),
): ProviderSettings {
  const config = configFromPreset(key, { model: '' })
  config.apiKeyRef = envKeyRef(PROVIDER_PRESETS[key].apiKeyEnv)
  return {
    version: SETTINGS_VERSION,
    activeId: config.id,
    providers: [config],
    locale: 'zh-CN',
    ui: { view: 'iso_ne', requireVerification: true },
  }
}

function hasValue(value: string | undefined): boolean {
  return value !== undefined && value.trim().length > 0
}
