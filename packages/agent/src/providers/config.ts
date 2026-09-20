/**
 * Provider 配置（plan §9.5）。
 *
 * 三条设计要点：
 *
 * 1. **不绑定供应商**（D-02）。只有两种**协议**适配：`openai-compatible` 与 `anthropic`。
 *    DeepSeek / OpenAI / Ollama / vLLM / LM Studio 的差别都落在配置里，不写特殊分支。
 * 2. **能力靠运行时实测**（D-12）。`capabilities` 里没有一个字段是"预填的事实"——
 *    它们由 `discover.ts` 的探针写回。静态能力表一定会过期（官方上新、账号权限差异）。
 * 3. **密钥只有一个引用**（D-13）。`ProviderConfig` 里存的是 `env:VAR` 或 `safe:<id>`
 *    这样的**指针**，所以整份配置可以安全地落盘、进日志、贴进 issue。
 */

import { t } from '@architect/i18n'

/** 只做这两种协议适配。 */
export type ProviderKind = 'openai-compatible' | 'anthropic'

export type PresetKey = 'deepseek' | 'custom'

/** 工具调用的实现方式。`prompted` 表示模型不支持原生 tool_calls，要靠提示词约定 JSON。 */
export type ToolCallingMode = 'native' | 'json-mode' | 'prompted'

/**
 * 前缀缓存计费口径。**决定走 §9.2 的哪个 regime**，所以它是能力而不是优化开关。
 *
 * - `auto`：命中便宜很多且写缓存免费（DeepSeek）→ Regime A，历史只追加、图像不剪
 * - `explicit`：需要显式打 cache 断点（Anthropic）
 * - `none`：没有缓存（多数本地小模型）→ Regime B，保守剪枝
 */
export type PromptCacheMode = 'auto' | 'explicit' | 'none'

export interface ProviderCapabilities {
  /** 是否接受图像输入。**由探针实测写回**，不读静态表。 */
  vision: boolean
  toolCalling: ToolCallingMode
  /** 单图大概多少 token（探针用"带图/不带图"两次请求的 prompt_tokens 差算出来）。 */
  imageTokenCost?: number
  contextWindow?: number
  maxImageEdge?: number
  promptCache: PromptCacheMode
  /** 谁测出来的：探针实测 / 用户手工填写 / 预设兜底。UI 要如实显示，不能把猜测说成实测。 */
  source: 'probe' | 'user' | 'preset'
  /** 实测时间。配置项不是 prompt 前缀，带时间戳没有缓存风险。 */
  probedAt?: string
}

/** 一个 provider 下保存的一项模型。能力属于模型，不能在同一端点的模型之间串用。 */
export interface ProviderModelConfig {
  id: string
  /** 尚未探测的模型省略；选中时使用该 provider 的保守预设能力。 */
  capabilities?: ProviderCapabilities
}

/**
 * 每 1M token 的价格，**美元**。用户自己核对自己的账单页面，这里只是记账用的口径。
 *
 * `inPerMTok` 等三个字段是**低谷价**；`peak` 给了就是高峰价（DeepSeek 的高峰价
 * 恰好是低谷价的 2 倍，时段见 `peakHours`）。分开存而不是取一个平均值：
 * 平均值会让"什么时候跑"这件事在账面上消失，而它其实差一倍。
 */
export type CurrencyCode = 'USD' | 'CNY' | 'EUR'

export interface CostTable {
  /**
   * 这张表用哪种货币计价。省略按 `USD`。
   *
   * **为什么不统一折成美元**：官方价格页是分币种标的，而汇率会动——折算出来的数字
   * 是编的。表盘要报的是"账单上会写多少"，所以原样存原币种，显示时带上币种代码。
   * 货币上限（`maxUsd`）已经删掉了，所以跨币种比较这件事不存在了。
   */
  currency?: CurrencyCode
  inPerMTok: number
  outPerMTok: number
  cacheReadPerMTok?: number
  /** 高峰价。省略表示不分时段。 */
  peak?: Omit<CostTable, 'peak'>
  /**
   * 高峰时段（**按供应商本地时区**，DeepSeek 是北京时间）。
   * 省略表示不分时段——不要默认按北京时间给所有供应商分时段。
   */
  peakHours?: {
    /** IANA 时区名，如 `Asia/Shanghai`。 */
    timeZone: string
    /** 周几算高峰，0 = 周日。 */
    weekdays: readonly number[]
    /** 高峰的小时区间，左闭右开。 */
    ranges: ReadonlyArray<readonly [number, number]>
  }
}

/**
 * OpenAI 兼容层的序列化开关。默认 'auto'——见 `openai.ts` 的自适应逻辑。
 */
export interface CompatOptions {
  maxTokensField?: 'max_tokens' | 'max_completion_tokens' | 'auto'
  reasoningContent?: boolean | 'auto'
  /**
   * 思考模式（DeepSeek V4.1 起的新参数 `thinking: {type}`）。
   *
   * - `'enabled'`：显式打开。**带上 `tools` 后，历史每一轮的 `reasoning_content`
   *   都必须原样回传**，否则 400——`openai.ts` 的 `reasoningContent: 'auto'` 负责这件事。
   * - `'disabled'`：关掉。便宜、快，但空间推理质量明显下降。
   * - `'auto'`：不传，用服务端默认（当前默认是**打开**）。默认值是最不该被依赖的东西——
   *   所以预设里明确写成 `'enabled'`。
   */
  thinking?: 'enabled' | 'disabled' | 'auto'
  /**
   * 思考强度（`reasoning_effort`）。`'auto'` 表示不传、用服务端默认（high）。
   *
   * 思考模式下 `temperature` / `presence_penalty` / `frequency_penalty` **一律不生效**
   * （传了不报错，也不起作用），所以调"随机性"只能靠改这个字段。
   */
  reasoningEffort?: 'low' | 'high' | 'max' | 'auto'
  extraBody?: Record<string, unknown>
}

export interface ProviderConfig {
  /** 用户自取的实例名，如 `DeepSeek`。 */
  id: string
  preset: PresetKey
  kind: ProviderKind
  /** 接口地址，云端与本地同一字段。 */
  baseURL: string
  /**
   * **密钥引用，绝不是密钥本身**（D-13）。
   *
   * 支持两种指针：
   * - `env:ARCHITECT_API_KEY` —— CLI 从环境变量读，密钥不落盘
   * - `safe:<uuid>` —— 桌面端从 Electron `safeStorage` 加密存储读
   *
   * 空字符串表示这个 provider 不需要密钥（本地 Ollama）。
   */
  apiKeyRef: string
  /** 模型 id。**由 `GET /models` 发现后选定**，不预填（D-12）。 */
  model: string
  /**
   * 这个端点下可选择的模型。`model` 仍是当前项，保留它是为了兼容旧设置、CLI 与请求层。
   * 老文件没有本字段时，设置解析会把 `model` 自动迁移成唯一的一项。
   */
  models?: ProviderModelConfig[]
  /**
   * 单次请求的输出上限（`max_tokens`）。
   *
   * **默认不设。不设才是不限制**——服务端思考模式的默认输出上限是 64K
   * （`reasoning_effort: max` 时 128K），比 harness 猜的任何数字都准。
   *
   * 这个值和预算无关，但它**先于预算生效**：一次请求被截断时钱已经花了，
   * 产出却是零。思考模型尤其容易踩——它把额度烧在思维链上，`finish_reason`
   * 返回 `length`，正文是空的。所以只在确实要压成本时才填这个字段。
   */
  maxOutputTokens?: number
  capabilities: ProviderCapabilities
  /**
   * **每个模型一份价格表**（自定义端点必须能这么配）。
   *
   * 为什么不能只有 provider 级的一张：一个自定义端点上挂的往往是好几个模型，
   * 价格差好几倍（同一个网关上的 flash 与 pro、或者第三方转售的不同上游）。
   * 只按 provider 记一份的话，切模型之后表盘上的钱就是编的——而它是**刹车依据**
   * （`--max-usd` 真的会让 agent 停下来）。
   *
   * 查表顺序见 `costTableFor`：先按当前 model id 精确匹配，再退到 `cost`。
   * 键就是模型 id 原文（大小写敏感）——它是端点自己报出来的那个字符串。
   */
  costs?: Record<string, CostTable>
  /** provider 级兜底价格（预设带的那份，或自定义端点只配一个价时用）。 */
  cost?: CostTable
  compat?: CompatOptions
}

export interface ProviderPreset {
  key: PresetKey
  kind: ProviderKind
  baseURL: string
  /** 本地服务不需要密钥。 */
  requiresApiKey: boolean
  /** CLI 读密钥的环境变量名。密钥永不落盘（D-13）。 */
  apiKeyEnv: string
  /**
   * 模型**偏好**，不是默认值。
   *
   * 用它在 `GET /models` 的真实返回列表里挑：按数组顺序做不区分大小写的包含匹配，
   * 第一个命中的就是选定模型。之所以不写死 id——官方上新、账号权限差异、
   * 灰度命名（`-exp` 后缀）都会让静态 id 过期，而列表是运行时事实。
   */
  modelPreference: readonly string[]
  /** 列表不可用或一个都没命中时的兜底；此时 `capabilities.source` 标 `preset` 而不是 `probe`。 */
  fallbackModel: string
  promptCache: PromptCacheMode
  /** 见 `ProviderConfig.maxOutputTokens`。 */
  maxOutputTokens?: number
  cost?: CostTable
  compat?: CompatOptions
  /** 面向用户的补充说明（UI 里原样显示）。 */
  note?: string
}

/**
 * 内置预设**只有两项**：DeepSeek 与自定义。
 *
 * OpenAI 与 Ollama 删掉了（用户定的）：这两个都是"另一个 OpenAI 兼容端点"，而自定义
 * 那一项能填任意地址——留着它们只是让选择变多、让"该点哪个"变模糊。真要用它们，
 * 用自定义填地址即可。
 *
 * **只预填协议层信息**，能力一律留给探针。DeepSeek 的价格是官方价格页那份口径
 * （人民币，表自带币种）；自定义不预填价格——报一个我没量过的数字比不报更糟，
 * UI 会退化成只显示 token 数。
 */
export const PROVIDER_PRESETS: Readonly<Record<PresetKey, ProviderPreset>> = {
  deepseek: {
    key: 'deepseek',
    kind: 'openai-compatible',
    baseURL: 'https://api.deepseek.com',
    requiresApiKey: true,
    apiKeyEnv: 'ARCHITECT_API_KEY',
    // D-12 的联调目标：V4.1 Flash 档优先，其次同代的其它档位。
    // `GET /models` 实测线上只暴露 `deepseek-flash` 与 `deepseek-v4-pro` 两个 id，
    // 版本号不出现在 id 里——所以"V4.1 Flash"落到的就是 `deepseek-flash`。
    // 必须把真实 id 写进偏好：只靠兜底"取列表第一个"的话，
    // 一旦服务端调整返回顺序就会静默换成 Pro 档（更贵，而且不是要求的那个模型）。
    modelPreference: [
      'v4.1-flash',
      'deepseek-flash',
      'v4-flash',
      'v4-1-flash',
      'flash',
      'v4.1',
      'chat',
      'reasoner',
    ],
    fallbackModel: 'deepseek-chat',
    promptCache: 'auto',
    // **不设单轮输出上限**（D-37）。以前不设会撞上"单轮生成太久 → 网关 50 s 处切连接"
    // （plan §16），一度用 8000 的上限去堵；**现在堵法换成了流式**（D-73）：
    // 请求永远 `stream: true`，字节一直在流动，那堵墙不成立。
    // 于是没有任何理由再压缩模型的输出——上限这个字段只留给"用户自己要压成本"的场合，
    // 由设置文件或 CLI 的 `--max-output-tokens` 显式给。
    // 用户可以在设置文件里按 provider 覆盖；`parseSettings` 会原样保留它。
    // **官方价格页的数字原样写，单位是人民币**（元/百万 token）。
    // 以前这里是"元 × 一个手写汇率"折成美元，那是个会漂的编造值；价格表现在自己带
    // 币种，表盘直接按元显示，跟账单页对得上。
    // 高峰时段是北京时间周一至周五 9:00–12:00、14:00–18:00，高峰价正好是低谷的 2 倍。
    cost: {
      currency: 'CNY',
      inPerMTok: 1,
      outPerMTok: 4,
      cacheReadPerMTok: 0.02,
      peak: {
        inPerMTok: 2,
        outPerMTok: 8,
        cacheReadPerMTok: 0.04,
      },
      peakHours: {
        timeZone: 'Asia/Shanghai',
        weekdays: [1, 2, 3, 4, 5],
        ranges: [
          [9, 12],
          [14, 18],
        ],
      },
    },
    compat: {
      maxTokensField: 'max_tokens',
      reasoningContent: 'auto',
      // 显式写出来而不是吃服务端默认：默认值会变，而"思考开着"是这套 harness 的
      // 设计前提（带图的迭代式空间推理）。要省钱可以在设置里改成 disabled。
      thinking: 'enabled',
      reasoningEffort: 'auto',
    },
    // note 用 getter 按需取：这样切语言时不会停留在 import 时刻的语言
    get note() {
      return t('agent.config.presetNote.deepseek')
    },
  },
  custom: {
    key: 'custom',
    kind: 'openai-compatible',
    baseURL: '',
    requiresApiKey: true,
    apiKeyEnv: 'ARCHITECT_API_KEY',
    modelPreference: [],
    fallbackModel: '',
    promptCache: 'none',
    compat: { maxTokensField: 'auto', reasoningContent: 'auto' },
    get note() {
      return t('agent.config.presetNote.custom')
    },
  },
}

/** 把预设转成一份可编辑的配置。`apiKeyRef` 由调用方决定（CLI 用 env:，桌面用 safe:）。 */
export function configFromPreset(
  key: PresetKey,
  overrides: Partial<Pick<ProviderConfig, 'id' | 'baseURL' | 'apiKeyRef' | 'model' | 'compat' | 'maxOutputTokens'>> = {},
): ProviderConfig {
  const preset = PROVIDER_PRESETS[key]
  const apiKeyRef =
    overrides.apiKeyRef ?? (preset.requiresApiKey ? `env:${preset.apiKeyEnv}` : '')
  const config: ProviderConfig = {
    id: overrides.id ?? preset.key,
    preset: key,
    kind: preset.kind,
    baseURL: overrides.baseURL ?? preset.baseURL,
    apiKeyRef,
    // 预填的模型只是**倾向**：真正选定发生在 discover 之后，且会被标成 source='preset'
    model: overrides.model ?? preset.fallbackModel,
    capabilities: {
      vision: false,
      toolCalling: 'native',
      promptCache: preset.promptCache,
      source: 'preset',
    },
  }
  const maxOutputTokens = overrides.maxOutputTokens ?? preset.maxOutputTokens
  if (maxOutputTokens !== undefined) config.maxOutputTokens = maxOutputTokens
  if (preset.cost !== undefined) config.cost = preset.cost
  const compat = overrides.compat ?? preset.compat
  if (compat !== undefined) config.compat = compat
  return config
}

// ── 密钥引用 ────────────────────────────────────────────────────────────────────

export const envKeyRef = (name: string): string => `env:${name}`
export const safeKeyRef = (id: string): string => `safe:${id}`

/**
 * 解析密钥引用。
 *
 * CLI 走环境变量；桌面端注入一个读 `safeStorage` 的实现。
 * **返回 undefined 表示"这个 provider 不需要密钥"**，抛错表示"需要但拿不到"。
 */
export type ApiKeyResolver = (ref: string) => Promise<string | undefined> | string | undefined

export async function resolveApiKey(
  ref: string,
  resolve: ApiKeyResolver = defaultResolver,
): Promise<string | undefined> {
  if (ref.length === 0) return undefined
  const value = await resolve(ref)
  if (value === undefined || value.trim().length === 0) {
    throw new Error(t('agent.config.apiKeyMissing', { ref }))
  }
  return value
}

const defaultResolver: ApiKeyResolver = (ref) => {
  if (ref.startsWith('env:')) {
    const proc = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process
    return proc?.env?.[ref.slice(4)]
  }
  return undefined
}

/**
 * 脱敏：**任何要写进日志或错误信息的地方都必须过这一层**（plan §13.3 红线）。
 *
 * 不是"打码前几位"，而是直接换成 `***`——前缀 `sk-` 加几个字符已经能用来撞库。
 */
export function redactSecret(value: string | undefined): string {
  if (value === undefined || value.length === 0) return t('agent.config.notSet')
  return '***'
}


/** 把配置里的敏感部分抹掉，用于日志 / 错误报告 / `.mcai` 的 settings 副本。 */
export function redactConfig(config: ProviderConfig): ProviderConfig {
  // `apiKeyRef` 本身就是**指针**（`env:NAME` / `safe:id`），不含密钥，
  // 所以原样保留——排查"为什么鉴权失败"时，知道它指向哪个变量是有用信息。
  // 这个函数存在的意义是：所有出口都走它，将来配置里真加了密钥字段也不会漏。
  return { ...config }
}

// 从一整段文本里抹掉密钥的那一层，实现放在 `../redact.ts`（`openai.ts` 要用它，
// 而直接让它 import 这个文件会绕出循环）。这里转出来，让脱敏工具只有一个入口。
export { scrubSecrets } from '../redact.js'

/** 恰好是密钥的长相就拒绝——防止用户把 `sk-...` 粘进本该放引用的字段。 */
const LOOKS_LIKE_SECRET = /^(sk-|sk_|Bearer\s|eyJ)[A-Za-z0-9._-]{8,}$/

/** 一条配置问题。`code` 是**机器可判**的那一份（文案表里的键），`message` 给人看。 */
export interface ConfigProblem {
  field: string
  /**
   * 稳定的标识，**就是文案表里那条 `agent.config.problem.*` 的键**。
   *
   * 有它，下游（`ChatController` 的门禁提示）就不必把一句会跟语言变的句子
   * 当成身份来用——测试与诊断按 `code` 断言，与界面语言无关。
   */
  code: string
  message: string
}

/** 配置能不能用。返回空数组表示可以发起请求了。 */
export function validateProviderConfig(config: ProviderConfig): ConfigProblem[] {
  const problems: ConfigProblem[] = []
  if (config.baseURL.trim().length === 0) {
    problems.push({ field: 'baseURL', code: 'agent.config.problem.baseUrlEmpty', message: t('agent.config.problem.baseUrlEmpty') })
  } else if (!/^https?:\/\//i.test(config.baseURL.trim())) {
    problems.push({ field: 'baseURL', code: 'agent.config.problem.baseUrlScheme', message: t('agent.config.problem.baseUrlScheme') })
  }
  if (LOOKS_LIKE_SECRET.test(config.apiKeyRef.trim())) {
    problems.push({ field: 'apiKeyRef', code: 'agent.config.problem.apiKeyRefSecret', message: t('agent.config.problem.apiKeyRefSecret') })
  } else if (config.apiKeyRef.length > 0 && !/^(env|safe):/.test(config.apiKeyRef)) {
    problems.push({ field: 'apiKeyRef', code: 'agent.config.problem.apiKeyRefFormat', message: t('agent.config.problem.apiKeyRefFormat') })
  }
  if (PROVIDER_PRESETS[config.preset].requiresApiKey && config.apiKeyRef.trim().length === 0) {
    problems.push({ field: 'apiKeyRef', code: 'agent.config.problem.apiKeyRequired', message: t('agent.config.problem.apiKeyRequired') })
  }
  if (config.kind === 'anthropic') {
    problems.push({ field: 'kind', code: 'agent.config.problem.anthropicUnsupported', message: t('agent.config.problem.anthropicUnsupported') })
  }
  return problems
}
