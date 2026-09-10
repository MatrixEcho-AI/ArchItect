import { beforeAll, describe, expect, it } from 'vitest'

import { initI18n } from '@architect/i18n'

import {
  addPreset,
  activeProvider,
  cacheHitRatio,
  checkBudget,
  configFromPreset,
  costOf,
  createProvider,
  defaultSettings,
  discoverProvider,
  emptyUsage,
  envKeyRef,
  isPeakHour,
  listModels,
  parseSettings,
  pickModel,
  presetFromEnv,
  PROVIDER_PRESETS,
  redactSecret,
  resolveApiKey,
  safeKeyRef,
  serializeSettings,
  settingsFromEnv,
  upsertProvider,
  UsageMeter,
  USD_PER_CNY,
  validateProviderConfig,
} from '../src/index.js'
import { LlmError } from '../src/types.js'
import type { ProviderConfig } from '../src/index.js'

// 这些用例断言的是中文明文；把 locale 钉死，免得 CI 的 LANG=en-US 让它们变色
beforeAll(() => {
  initI18n({ locale: 'zh-CN' })
})

// ── 打桩的 fetch ───────────────────────────────────────────────────────────────

interface RecordedCall {
  url: string
  body: Record<string, unknown> | undefined
  headers: Record<string, string>
}

interface StubResponse {
  status?: number
  json?: unknown
  text?: string
}

function stubFetch(handler: (call: RecordedCall) => StubResponse): {
  impl: typeof fetch
  calls: RecordedCall[]
} {
  const calls: RecordedCall[] = []
  const impl = (async (input: unknown, init?: { body?: string; headers?: Record<string, string> }) => {
    const call: RecordedCall = {
      url: String(input),
      body: init?.body !== undefined ? (JSON.parse(init.body) as Record<string, unknown>) : undefined,
      headers: (init?.headers ?? {}) as Record<string, string>,
    }
    calls.push(call)
    const out = handler(call)
    const status = out.status ?? 200
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => out.json,
      text: async () => out.text ?? JSON.stringify(out.json ?? ''),
    } as unknown as Response
  }) as unknown as typeof fetch
  return { impl, calls }
}

const chatOk = (content: string, tokensIn: number, extra: Record<string, unknown> = {}): StubResponse => ({
  json: {
    choices: [{ message: { content, ...extra }, finish_reason: 'stop' }],
    usage: { prompt_tokens: tokensIn, completion_tokens: 2 },
  },
})

/** 判断一次 chat 请求是不是带图的。 */
function hasImage(call: RecordedCall): boolean {
  const messages = (call.body?.['messages'] ?? []) as Array<{ content?: unknown }>
  return messages.some(
    (m) => Array.isArray(m.content) && (m.content as Array<{ type?: string }>).some((p) => p.type === 'image_url'),
  )
}

function hasTools(call: RecordedCall): boolean {
  return Array.isArray(call.body?.['tools']) && (call.body?.['tools'] as unknown[]).length > 0
}

const DEEPSEEK_MODELS = {
  data: [
    { id: 'deepseek-chat', owned_by: 'deepseek' },
    { id: 'deepseek-reasoner', owned_by: 'deepseek' },
    { id: 'deepseek-v4.1-flash', owned_by: 'deepseek' },
  ],
}

describe('预置模板（D-14 四项）', () => {
  it('四项预设齐全，键与 key 字段一致', () => {
    expect(Object.keys(PROVIDER_PRESETS).sort()).toEqual(['custom', 'deepseek', 'ollama', 'openai'])
    for (const [key, preset] of Object.entries(PROVIDER_PRESETS)) {
      expect(preset.key, key).toBe(key)
    }
  })

  it('云端预设都有 https 地址与密钥变量；本地 Ollama 不需要密钥', () => {
    for (const key of ['deepseek', 'openai'] as const) {
      expect(PROVIDER_PRESETS[key].baseURL).toMatch(/^https:\/\//)
      expect(PROVIDER_PRESETS[key].requiresApiKey).toBe(true)
      expect(PROVIDER_PRESETS[key].apiKeyEnv.length).toBeGreaterThan(0)
    }
    expect(PROVIDER_PRESETS.ollama.requiresApiKey).toBe(false)
    expect(PROVIDER_PRESETS.ollama.baseURL).toContain('localhost')
  })

  it('DeepSeek 走 Regime A（有前缀缓存），Ollama 走 Regime B', () => {
    expect(PROVIDER_PRESETS.deepseek.promptCache).toBe('auto')
    expect(PROVIDER_PRESETS.ollama.promptCache).toBe('none')
  })

  it('**不硬编码具体模型 id**：偏好必须能命中一个真实的列表项，兜底本身不是"事实"', () => {
    // 偏好是模糊匹配的模式串，全部小写、不含空格
    for (const preset of Object.values(PROVIDER_PRESETS)) {
      for (const pattern of preset.modelPreference) {
        expect(pattern, preset.key).toBe(pattern.toLowerCase())
        expect(pattern.includes(' '), preset.key).toBe(false)
      }
    }
  })

  it('configFromPreset 不预填模型能力——能力留给探针（D-12）', () => {
    const config = configFromPreset('deepseek')
    expect(config.capabilities.source).toBe('preset')
    expect(config.capabilities.vision).toBe(false)
    expect(config.model).toBe(PROVIDER_PRESETS.deepseek.fallbackModel)
  })

  it('configFromPreset 只放引用，不放密钥（D-13）', () => {
    const config = configFromPreset('deepseek')
    expect(config.apiKeyRef).toBe('env:ARCHITECT_API_KEY')
    expect(JSON.stringify(config)).not.toMatch(/sk-/)
  })

  it('configFromPreset 支持覆盖 id / 地址 / 模型', () => {
    const config = configFromPreset('custom', {
      id: '我的 vLLM',
      baseURL: 'http://10.0.0.2:8000/v1',
      model: 'Qwen/Qwen2.5-VL-7B',
    })
    expect(config.id).toBe('我的 vLLM')
    expect(config.baseURL).toBe('http://10.0.0.2:8000/v1')
    expect(config.model).toBe('Qwen/Qwen2.5-VL-7B')
  })

  it('线上真实 id 必须命中偏好——不能靠"取列表第一个"（D-37）', () => {
    // `GET /models` 实测只返回这两个，且版本号不在 id 里
    const listed = ['deepseek-flash', 'deepseek-v4-pro']
    const picked = pickModel(listed, PROVIDER_PRESETS.deepseek.modelPreference)
    expect(picked?.model).toBe('deepseek-flash')
    // 顺序反过来也得选 Flash：兜底"第一个"会随服务端排序漂移
    const reversed = pickModel([...listed].reverse(), PROVIDER_PRESETS.deepseek.modelPreference)
    expect(reversed?.model).toBe('deepseek-flash')
  })

  it('**不设单轮输出上限**——不设才是不限制，猜小了会把思考模型的额度吃光（D-37）', () => {
    // 8192 曾在真机上翻车：思维链把额度吃光，正文空、工具调用零，还被报成 completed
    for (const preset of Object.values(PROVIDER_PRESETS)) {
      expect(preset.maxOutputTokens, preset.key).toBeUndefined()
    }
    expect(configFromPreset('deepseek').maxOutputTokens).toBeUndefined()
  })

  it('DeepSeek 预设显式打开思考模式，而不是吃服务端默认', () => {
    expect(PROVIDER_PRESETS.deepseek.compat?.thinking).toBe('enabled')
  })

  it('DeepSeek 价格按官方价格页（元换算成美元），且高峰价单列', () => {
    const cost = PROVIDER_PRESETS.deepseek.cost!
    // 官方：输入 1 元(低谷)/2 元(高峰)，输出 4/8，缓存命中 0.02/0.04
    expect(cost.inPerMTok).toBeCloseTo(1 * USD_PER_CNY, 10)
    expect(cost.outPerMTok).toBeCloseTo(4 * USD_PER_CNY, 10)
    expect(cost.cacheReadPerMTok).toBeCloseTo(0.02 * USD_PER_CNY, 10)
    expect(cost.peak).toEqual({
      inPerMTok: 2 * USD_PER_CNY,
      outPerMTok: 8 * USD_PER_CNY,
      cacheReadPerMTok: 0.04 * USD_PER_CNY,
    })
    // 缓存命中必须比全价便宜得多，否则 Regime A 的整套设计（只追加、不剪图）就不成立
    expect(cost.cacheReadPerMTok!).toBeLessThan(cost.inPerMTok / 10)
  })
})

describe('配置校验', () => {
  it('拒绝把密钥当引用粘进来', () => {
    const config = configFromPreset('deepseek', { apiKeyRef: 'sk-abcdefghijklmnop' })
    const problems = validateProviderConfig(config)
    expect(problems.some((p) => p.field === 'apiKeyRef')).toBe(true)
    expect(problems.find((p) => p.field === 'apiKeyRef')?.message).toContain('不要直接粘密钥')
  })

  it('接受 env: 与 safe: 两种引用', () => {
    for (const ref of [envKeyRef('ARCHITECT_API_KEY'), safeKeyRef('abc-123')]) {
      const config = configFromPreset('deepseek', { apiKeyRef: ref })
      expect(validateProviderConfig(config)).toEqual([])
    }
  })

  it('地址必须带协议', () => {
    expect(validateProviderConfig(configFromPreset('custom', { baseURL: 'api.foo.com' }))[0]?.field).toBe('baseURL')
    expect(validateProviderConfig(configFromPreset('ollama', { baseURL: '' })).some((p) => p.field === 'baseURL')).toBe(true)
  })

  it('还没实现的协议要明确说，而不是到运行时才 400', () => {
    const config = { ...configFromPreset('custom'), kind: 'anthropic' as const }
    expect(validateProviderConfig(config).some((p) => p.field === 'kind')).toBe(true)
  })

  it('redactSecret 不泄露任何前缀', () => {
    expect(redactSecret('sk-1234567890')).toBe('***')
    expect(redactSecret(undefined)).toBe('(未设置)')
  })
})

describe('密钥解析', () => {
  it('env: 引用从环境变量取（测试注入的 resolver）', async () => {
    const value = await resolveApiKey('env:MY_KEY', (ref) => (ref === 'env:MY_KEY' ? 'secret-value' : undefined))
    expect(value).toBe('secret-value')
  })

  it('空引用表示不需要密钥', async () => {
    expect(await resolveApiKey('')).toBeUndefined()
  })

  it('拿不到时抛错并说明该怎么做', async () => {
    await expect(resolveApiKey('env:MISSING', () => undefined)).rejects.toThrow(/拿不到密钥/)
  })
})

describe('GET /models', () => {
  it('解析 OpenAI 形状并带上 Authorization', async () => {
    const { impl, calls } = stubFetch(() => ({ json: DEEPSEEK_MODELS }))
    const models = await listModels(
      { baseURL: 'https://api.deepseek.com', kind: 'openai-compatible' },
      { apiKey: 'sk-test', fetchImpl: impl },
    )
    expect(models.map((m) => m.id)).toEqual(['deepseek-chat', 'deepseek-reasoner', 'deepseek-v4.1-flash'])
    expect(calls[0]?.url).toBe('https://api.deepseek.com/models')
    expect(calls[0]?.headers['authorization']).toBe('Bearer sk-test')
  })

  it('兼容 Ollama 的 {models:[{name}]} 形状', async () => {
    const { impl } = stubFetch(() => ({ json: { models: [{ name: 'llama3.1:latest' }] } }))
    const models = await listModels(
      { baseURL: 'http://localhost:11434/v1', kind: 'openai-compatible' },
      { fetchImpl: impl },
    )
    expect(models.map((m) => m.id)).toEqual(['llama3.1:latest'])
  })

  it('401 归类成 AUTH 且不可重试', async () => {
    const { impl } = stubFetch(() => ({ status: 401, text: 'bad key' }))
    await expect(
      listModels({ baseURL: 'https://x.test', kind: 'openai-compatible' }, { fetchImpl: impl }),
    ).rejects.toMatchObject({ code: 'AUTH', retryable: false })
  })

  it('网络异常归类成 NETWORK 且可重试', async () => {
    const impl = (async () => {
      throw new Error('ECONNREFUSED')
    }) as unknown as typeof fetch
    await expect(
      listModels({ baseURL: 'http://localhost:11434/v1', kind: 'openai-compatible' }, { fetchImpl: impl }),
    ).rejects.toMatchObject({ code: 'NETWORK', retryable: true })
  })

  it('顺带带回上下文窗口（有就采信，没有就不猜）', async () => {
    const { impl } = stubFetch(() => ({ json: { data: [{ id: 'a', context_length: 131072 }, { id: 'b' }] } }))
    const models = await listModels({ baseURL: 'https://x.test', kind: 'openai-compatible' }, { fetchImpl: impl })
    expect(models.find((m) => m.id === 'a')?.contextWindow).toBe(131072)
    expect(models.find((m) => m.id === 'b')?.contextWindow).toBeUndefined()
  })
})

describe('按偏好挑模型（D-12：不写死 id）', () => {
  it('精确 > 前缀 > 包含', () => {
    expect(pickModel(['deepseek-v4.1-flash-exp', 'deepseek-v4.1-flash'], ['v4.1-flash'])).toEqual({
      model: 'deepseek-v4.1-flash',
      matched: 'v4.1-flash',
    })
  })

  it('按偏好顺序取第一个命中的', () => {
    expect(pickModel(['deepseek-chat', 'gpt-4o-mini'], ['v4.1-flash', 'chat'])?.model).toBe('deepseek-chat')
  })

  it('同样输入必然挑出同一个模型（排序后取第一个）', () => {
    const a = pickModel(['zz-v4.1-flash', 'aa-v4.1-flash'], ['v4.1-flash'])
    const b = pickModel(['aa-v4.1-flash', 'zz-v4.1-flash'], ['v4.1-flash'])
    expect(a).toEqual(b)
    expect(a?.model).toBe('aa-v4.1-flash')
  })

  it('一个都不命中就返回 undefined，不瞎猜', () => {
    expect(pickModel(['mistral:latest'], ['v4.1-flash', 'chat'])).toBeUndefined()
    expect(pickModel([], ['chat'])).toBeUndefined()
  })
})

describe('能力探针（D-12 运行时实测）', () => {
  /** 一个"理想的 DeepSeek"：有 v4.1-flash、吃图、原生 tool_calls。 */
  function idealHandler(imageTokens: number) {
    return (call: RecordedCall): StubResponse => {
      if (call.url.endsWith('/models')) return { json: DEEPSEEK_MODELS }
      if (hasImage(call)) return chatOk('Red and blue', 30 + imageTokens)
      if (hasTools(call)) {
        return {
          json: {
            choices: [
              {
                message: {
                  content: '',
                  tool_calls: [
                    { id: 'c1', type: 'function', function: { name: 'report_ready', arguments: '{"status":"ready"}' } },
                  ],
                },
                finish_reason: 'tool_calls',
              },
            ],
            usage: { prompt_tokens: 60, completion_tokens: 8 },
          },
        }
      }
      return chatOk('Blue', 30)
    }
  }

  it('走完三条探针并写回 capabilities', async () => {
    const { impl, calls } = stubFetch(idealHandler(369))
    const result = await discoverProvider(configFromPreset('deepseek'), { apiKey: 'sk-test', fetchImpl: impl })

    expect(result.ok).toBe(true)
    expect(result.models).toContain('deepseek-v4.1-flash')
    // 挑中的是偏好里的 v4.1-flash，而不是列表里排第一的 deepseek-chat
    expect(result.config.model).toBe('deepseek-v4.1-flash')
    expect(result.config.capabilities).toMatchObject({
      vision: true,
      toolCalling: 'native',
      promptCache: 'auto',
      source: 'probe',
      imageTokenCost: 369,
    })
    expect(result.config.capabilities.probedAt).toBeDefined()
    // 1 次 /models + 3 次探针
    expect(calls).toHaveLength(4)
  })

  it('单图 token 是"带图 / 不带图"两次 prompt_tokens 的差', async () => {
    const { impl } = stubFetch(idealHandler(117))
    const result = await discoverProvider(configFromPreset('openai'), {
      apiKey: 'sk-test',
      fetchImpl: impl,
      model: 'gpt-4o-mini',
    })
    expect(result.config.capabilities.imageTokenCost).toBe(117)
  })

  it('网关不把图算进 prompt_tokens 时**不报数**（报 0 会让成本表盘骗人）', async () => {
    const { impl } = stubFetch(idealHandler(0))
    const result = await discoverProvider(configFromPreset('openai'), {
      apiKey: 'sk-test',
      fetchImpl: impl,
      model: 'gpt-4o-mini',
    })
    expect(result.config.capabilities.vision).toBe(true)
    expect(result.config.capabilities.imageTokenCost).toBeUndefined()
  })

  it('不吃图的模型：vision=false，但其它能力照样写回（部分成功也是结论）', async () => {
    const { impl } = stubFetch((call) => {
      if (call.url.endsWith('/models')) return { json: DEEPSEEK_MODELS }
      if (hasImage(call)) {
        return { status: 400, text: '{"error":{"message":"this model does not support image input"}}' }
      }
      if (hasTools(call)) return chatOk('', 60)
      return chatOk('Blue', 30)
    })
    const result = await discoverProvider(configFromPreset('deepseek'), { apiKey: 'sk-test', fetchImpl: impl })

    expect(result.ok).toBe(true)
    expect(result.config.capabilities.vision).toBe(false)
    expect(result.config.capabilities.imageTokenCost).toBeUndefined()
    // 不支持 tools 参数也没关系，退化成 prompted
    expect(result.config.capabilities.toolCalling).toBe('prompted')
    expect(result.steps.some((s) => s.type === 'vision' && !s.vision)).toBe(true)
  })

  it('模型没用原生 tool_calls 但吐了 JSON 调用 → json-mode', async () => {
    const { impl } = stubFetch((call) => {
      if (call.url.endsWith('/models')) return { json: DEEPSEEK_MODELS }
      if (hasImage(call)) return chatOk('Red', 40)
      if (hasTools(call)) {
        return chatOk('```json\n{"name":"report_ready","arguments":{"status":"ready"}}\n```', 60)
      }
      return chatOk('Blue', 30)
    })
    const result = await discoverProvider(configFromPreset('deepseek'), { apiKey: 'sk-test', fetchImpl: impl })
    expect(result.config.capabilities.toolCalling).toBe('json-mode')
  })

  it('鉴权失败立刻停下——后面的每一步都会以同样的理由失败，白花钱', async () => {
    const { impl, calls } = stubFetch(() => ({ status: 401, text: 'unauthorized' }))
    const result = await discoverProvider(configFromPreset('deepseek'), { apiKey: 'sk-bad', fetchImpl: impl })

    expect(result.ok).toBe(false)
    expect(result.error).toContain('鉴权失败')
    expect(calls).toHaveLength(1)
  })

  it('listOnly 只列模型，不发探针请求', async () => {
    const { impl, calls } = stubFetch(() => ({ json: DEEPSEEK_MODELS }))
    const result = await discoverProvider(configFromPreset('deepseek'), {
      apiKey: 'sk-test',
      fetchImpl: impl,
      listOnly: true,
    })
    expect(result.models).toHaveLength(3)
    expect(calls).toHaveLength(1)
    expect(result.config.capabilities.source).toBe('preset')
  })

  it('偏好一个都没命中时先用列表里第一个探通，并标成 guessed', async () => {
    const { impl } = stubFetch((call) => {
      if (call.url.endsWith('/models')) return { json: { data: [{ id: 'mistral:latest' }] } }
      if (hasImage(call)) return chatOk('Red', 40)
      if (hasTools(call)) return chatOk('', 60)
      return chatOk('Blue', 30)
    })
    const result = await discoverProvider(configFromPreset('ollama'), { fetchImpl: impl })
    expect(result.config.model).toBe('mistral:latest')
    const step = result.steps.find((s) => s.type === 'model')
    expect(step).toMatchObject({ guessed: true })
    expect(step).not.toHaveProperty('matched')
  })

  it('模型列表拿不到时用配置里的模型继续探（网关没实现 /models 也要能用）', async () => {
    const { impl } = stubFetch((call) => {
      if (call.url.endsWith('/models')) return { status: 404, text: 'not found' }
      if (hasImage(call)) return chatOk('Red', 40)
      if (hasTools(call)) return chatOk('', 60)
      return chatOk('Blue', 30)
    })
    const result = await discoverProvider(configFromPreset('custom', { baseURL: 'http://x.test/v1', model: 'my-model' }), {
      apiKey: 'k',
      fetchImpl: impl,
    })
    expect(result.ok).toBe(true)
    expect(result.config.model).toBe('my-model')
    expect(result.steps.some((s) => s.type === 'error')).toBe(true)
  })
})

describe('OpenAI 兼容层的自适应（plan §9.5 排查清单自动化）', () => {
  const base = {
    system: '',
    messages: [{ role: 'user' as const, content: 'hi' }],
    tools: [],
  }

  it('max_tokens 被 400 拒绝且正文提到 max_completion_tokens 时，自动换字段重发并记住', async () => {
    const { impl, calls } = stubFetch((call) => {
      if ('max_tokens' in (call.body ?? {})) {
        return {
          status: 400,
          text: '{"error":{"message":"Unsupported parameter: \'max_tokens\' is not supported with this model. Use \'max_completion_tokens\' instead."}}',
        }
      }
      return chatOk('ok', 10)
    })
    // 只有**配了上限**才会发这个字段，所以这条自适应逻辑也必须配上限才走得到
    const provider = createProvider(
      { ...configFromPreset('openai', { model: 'o4-mini' }), maxOutputTokens: 8192 },
      { apiKey: 'k', fetchImpl: impl },
    )
    const first = await provider.chat(base)
    expect(first.text).toBe('ok')
    expect('max_completion_tokens' in (calls[1]?.body ?? {})).toBe(true)

    // 学到之后第二次直接用它，不再试错
    await provider.chat(base)
    expect(calls).toHaveLength(3)
    expect('max_completion_tokens' in (calls[2]?.body ?? {})).toBe(true)
  })

  it('**默认不发 max_tokens**：不设才是不限制，服务端思考模式默认 64K（D-37）', async () => {
    const { impl, calls } = stubFetch(() => chatOk('ok', 10))
    const provider = createProvider(configFromPreset('deepseek', { model: 'deepseek-flash' }), {
      apiKey: 'k',
      fetchImpl: impl,
    })
    await provider.chat(base)
    expect('max_tokens' in (calls[0]?.body ?? {})).toBe(false)
    expect('max_completion_tokens' in (calls[0]?.body ?? {})).toBe(false)

    // 只有显式配了才发——它是"要压成本"时才用的旋钮
    const capped = createProvider(
      { ...configFromPreset('deepseek', { model: 'deepseek-flash' }), maxOutputTokens: 4096 },
      { apiKey: 'k', fetchImpl: impl },
    )
    await capped.chat(base)
    expect(calls[1]?.body?.['max_tokens']).toBe(4096)
  })

  it('思考模式的开关与强度只在**显式配置**时才发（auto = 不传，用服务端默认）', async () => {
    const { impl, calls } = stubFetch(() => chatOk('ok', 10))
    // DeepSeek 预设：思考显式打开、强度用服务端默认
    const deepseek = createProvider(configFromPreset('deepseek', { model: 'deepseek-flash' }), {
      apiKey: 'k',
      fetchImpl: impl,
    })
    await deepseek.chat(base)
    expect(calls[0]?.body?.['thinking']).toEqual({ type: 'enabled' })
    expect('reasoning_effort' in (calls[0]?.body ?? {})).toBe(false)

    // OpenAI 预设不带 thinking（它是 DeepSeek 的字段，别人收到会 400）
    const openai = createProvider(configFromPreset('openai', { model: 'gpt-4o-mini' }), {
      apiKey: 'k',
      fetchImpl: impl,
    })
    await openai.chat(base)
    expect('thinking' in (calls[1]?.body ?? {})).toBe(false)

    // 显式给强度就发出去
    const low = createProvider(
      configFromPreset('deepseek', { model: 'deepseek-flash', compat: { reasoningEffort: 'low', thinking: 'enabled' } }),
      { apiKey: 'k', fetchImpl: impl },
    )
    await low.chat(base)
    expect(calls[2]?.body?.['reasoning_effort']).toBe('low')
  })

  it('**不相干**的 400 不会触发重试（否则会白打一次请求还盖掉真错误）', async () => {
    const { impl, calls } = stubFetch(() => ({ status: 400, text: '{"error":{"message":"model not found"}}' }))
    const provider = createProvider(configFromPreset('openai', { model: 'nope' }), { apiKey: 'k', fetchImpl: impl })
    await expect(provider.chat(base)).rejects.toMatchObject({ code: 'BAD_REQUEST' })
    expect(calls).toHaveLength(1)
  })

  it('reasoningContent=auto：模型给过思维链才回传，没给过就不带', async () => {
    // 第一轮：模型返回 reasoning_content
    const first = stubFetch(() => chatOk('答', 10, { reasoning_content: '我想了想' }))
    const provider = createProvider(configFromPreset('deepseek', { model: 'm' }), {
      apiKey: 'k',
      fetchImpl: first.impl,
    })
    const response = await provider.chat(base)
    expect(response.reasoningContent).toBe('我想了想')

    // 下一轮把带思维链的 assistant 消息回传——必须带上 reasoning_content
    await provider.chat({
      ...base,
      messages: [
        { role: 'user', content: 'hi' },
        { role: 'assistant', content: '答', reasoningContent: '我想了想' },
      ],
    })
    const sent = (first.calls[1]?.body?.['messages'] ?? []) as Array<Record<string, unknown>>
    expect(sent.find((m) => m['role'] === 'assistant')).toMatchObject({ reasoning_content: '我想了想' })
  })

  it('reasoningContent=auto：从没给过思维链的模型不会被塞未知字段（OpenAI 会因此 400）', async () => {
    const { impl, calls } = stubFetch(() => chatOk('答', 10))
    const provider = createProvider(configFromPreset('openai', { model: 'gpt-4o-mini' }), {
      apiKey: 'k',
      fetchImpl: impl,
    })
    await provider.chat({
      ...base,
      messages: [{ role: 'assistant', content: '答', reasoningContent: '不该出现' }],
    })
    const sent = (calls[0]?.body?.['messages'] ?? []) as Array<Record<string, unknown>>
    expect(sent.find((m) => m['role'] === 'assistant')).not.toHaveProperty('reasoning_content')
  })
})

describe('设置文件读写（D-13 两条红线）', () => {
  it('默认设置内置一个 DeepSeek 预设，模型留空等发现（D-12）', () => {
    const settings = defaultSettings()
    expect(settings.providers).toHaveLength(1)
    expect(settings.providers[0]?.preset).toBe('deepseek')
    expect(settings.providers[0]?.model).toBe('')
    expect(activeProvider(settings)?.id).toBe(settings.activeId)
  })

  it('序列化出来的东西里不可能有密钥', () => {
    const json = serializeSettings(defaultSettings())
    expect(json).not.toMatch(/sk-/)
    expect(json).toContain('env:ARCHITECT_API_KEY')
  })

  it('往返稳定', () => {
    const settings = defaultSettings()
    const round = parseSettings(JSON.parse(serializeSettings(settings)))
    expect(round.issues.filter((i) => !i.message.includes('缺'))).toEqual([])
    expect(round.settings.providers[0]?.id).toBe(settings.providers[0]?.id)
    expect(round.settings.ui).toEqual(settings.ui)
  })

  it('**丢掉手改 json 塞进来的明文密钥**并报告', () => {
    const raw = {
      version: 1,
      activeId: 'x',
      providers: [{ id: 'x', preset: 'deepseek', baseURL: 'https://api.deepseek.com', apiKey: 'sk-realsecret123456' }],
    }
    const { settings, issues } = parseSettings(raw)
    expect(JSON.stringify(settings)).not.toContain('sk-realsecret')
    expect(issues.some((i) => i.message.includes('疑似明文密钥'))).toBe(true)
  })

  it('设置文件坏掉时退回默认值而不是抛异常', () => {
    for (const bad of [null, 42, 'nope', [], { version: 'x' }]) {
      const { settings } = parseSettings(bad)
      expect(settings.providers.length).toBeGreaterThan(0)
      expect(settings.activeId.length).toBeGreaterThan(0)
    }
  })

  it('版本比程序新时警告但不拒绝', () => {
    const { settings, issues } = parseSettings({ version: 99, providers: defaultSettings().providers, activeId: 'DeepSeek' })
    expect(issues.some((i) => i.message.includes('比本程序'))).toBe(true)
    expect(settings.providers).toHaveLength(1)
  })

  it('activeId 指向不存在的实例时自动修好', () => {
    const { settings, issues } = parseSettings({
      version: 1,
      activeId: '不存在',
      providers: defaultSettings().providers,
    })
    expect(settings.activeId).toBe('DeepSeek')
    expect(issues.some((i) => i.field === 'activeId')).toBe(true)
  })

  it('预算必须是正数', () => {
    const { settings, issues } = parseSettings({
      version: 1,
      activeId: 'DeepSeek',
      providers: defaultSettings().providers,
      budget: { maxUsd: 2.5, maxTurns: -1, maxTokensOut: 'many' },
    })
    expect(settings.budget).toEqual({ maxUsd: 2.5 })
    expect(issues.filter((i) => i.field.startsWith('budget.'))).toHaveLength(2)
  })

  it('addPreset 不覆盖同名实例', () => {
    const settings = defaultSettings()
    addPreset(settings, 'ollama', 'Ollama')
    addPreset(settings, 'ollama', 'Ollama')
    expect(settings.providers.map((p) => p.id)).toEqual(['DeepSeek', 'Ollama', 'Ollama 2'])
  })

  it('upsertProvider 让新增的实例成为当前实例', () => {
    const settings = defaultSettings()
    const ollama: ProviderConfig = configFromPreset('ollama', { id: '本地' })
    const next = upsertProvider(settings, ollama)
    expect(next.activeId).toBe('本地')
    expect(next.providers).toHaveLength(2)
  })

  it('presetFromEnv 认用户 export 的是哪个 key', () => {
    expect(presetFromEnv({ OPENAI_API_KEY: 'sk-x' })).toBe('openai')
    expect(presetFromEnv({ ARCHITECT_API_KEY: 'sk-x' })).toBe('deepseek')
    expect(presetFromEnv({ ARCHITECT_PROVIDER: 'ollama' })).toBe('ollama')
    expect(presetFromEnv({})).toBe('deepseek')
  })

  it('settingsFromEnv 只放 env: 引用，不读也不存密钥值', () => {
    const settings = settingsFromEnv({ ARCHITECT_API_KEY: 'sk-secret-value' })
    expect(JSON.stringify(settings)).not.toContain('sk-secret-value')
    expect(settings.providers[0]?.apiKeyRef).toBe('env:ARCHITECT_API_KEY')
  })

})

describe('成本记账', () => {
  const cost = { inPerMTok: 0.14, outPerMTok: 0.28, cacheReadPerMTok: 0.0028 }

  it('**cachedIn 是 in 的子集**，不能算两份', () => {
    // 1M 输入里 999_000 命中缓存
    const usd = costOf({ in: 1_000_000, out: 0, cachedIn: 999_000 }, cost)!
    const naive = costOf({ in: 1_000_000, out: 0, cachedIn: 0 }, cost)!
    expect(usd).toBeLessThan(naive / 20)
    expect(usd).toBeCloseTo((1000 * 0.14) / 1e6 + (999_000 * 0.0028) / 1e6, 10)
  })

  it('没有价格表就返回 undefined，而不是编一个数字', () => {
    expect(costOf({ in: 1, out: 1, cachedIn: 0 })).toBeUndefined()
  })

  it('三重预算各自能刹车，并给出具体原因', () => {
    const totals = { ...emptyUsage(), turns: 40, out: 100 }
    expect(checkBudget(totals, { maxTurns: 40 })).toMatchObject({ ok: false, reason: 'turns' })
    expect(checkBudget(totals, { maxTokensOut: 100 })).toMatchObject({ ok: false, reason: 'tokens' })
    expect(checkBudget({ ...totals, in: 1_000_000 }, { maxUsd: 0.01 }, cost)).toMatchObject({
      ok: false,
      reason: 'usd',
    })
    expect(checkBudget(totals, {})).toEqual({ ok: true })
  })

  it('设了美元上限却没有价格表 → 判为越界（"设了上限其实没生效"更糟）', () => {
    const verdict = checkBudget(emptyUsage(), { maxUsd: 5 })
    expect(verdict.ok).toBe(false)
    expect((verdict as { detail: string }).detail).toContain('没有价格表')
  })

  it('高峰 / 低谷价按**供应商时区**切换，高峰正好贵一倍', () => {
    const table = PROVIDER_PRESETS.deepseek.cost!
    // 北京时间周三 10:00 → 高峰
    const peak = new Date('2026-03-04T02:00:00Z')
    // 北京时间周三 20:00 → 低谷
    const off = new Date('2026-03-04T12:00:00Z')
    const totals = { in: 1_000_000, out: 0, cachedIn: 0 }
    expect(costOf(totals, table, peak)).toBeCloseTo(2 * USD_PER_CNY, 10)
    expect(costOf(totals, table, off)).toBeCloseTo(1 * USD_PER_CNY, 10)
    expect(costOf(totals, table, peak)! / costOf(totals, table, off)!).toBeCloseTo(2, 10)
  })

  it('周末没有高峰价', () => {
    const table = PROVIDER_PRESETS.deepseek.cost!
    // 北京时间周六 10:00
    const saturday = new Date('2026-03-07T02:00:00Z')
    expect(costOf({ in: 1_000_000, out: 0, cachedIn: 0 }, table, saturday)).toBeCloseTo(1 * USD_PER_CNY, 10)
  })

  it('没配时段的价格表不分时段——不给别的供应商瞎套北京时间', () => {
    const flat = { inPerMTok: 1, outPerMTok: 2, peak: { inPerMTok: 9, outPerMTok: 9 } }
    // 有 peak 但没有 peakHours → 不切换
    expect(costOf({ in: 1_000_000, out: 0, cachedIn: 0 }, flat, new Date('2026-03-04T02:00:00Z'))).toBe(1)
  })

  it('时区名不被运行时认识时**按低谷算**，不猜（虚高一倍比少算更糟）', () => {
    const weird = {
      inPerMTok: 1,
      outPerMTok: 2,
      peak: { inPerMTok: 9, outPerMTok: 9 },
      peakHours: { timeZone: 'Nowhere/Fake', weekdays: [1], ranges: [[0, 24] as const] },
    }
    expect(isPeakHour(weird.peakHours, new Date('2026-03-02T02:00:00Z'))).toBe(false)
    expect(costOf({ in: 1_000_000, out: 0, cachedIn: 0 }, weird)).toBe(1)
  })

  it('UsageMeter 累计 token / 轮数 / 工具调用 / 截图', () => {
    const meter = new UsageMeter()
    meter.add({ in: 100, out: 20, cachedIn: 80 })
    meter.add({ in: 50, out: 10 })
    meter.turn()
    meter.toolCall()
    meter.toolCall()
    meter.screenshot()
    const totals = meter.value
    expect(totals).toMatchObject({ in: 150, out: 30, cachedIn: 80, turns: 1, toolCalls: 2, screenshots: 1 })
    expect(meter.costUsd(cost)).toBeGreaterThan(0)
    expect(cacheHitRatio(totals)).toBeCloseTo(80 / 150, 10)
  })

  it('reset 之后一切归零', () => {
    const meter = new UsageMeter()
    meter.add({ in: 100, out: 20 })
    meter.reset()
    expect(meter.value).toEqual(emptyUsage())
    expect(cacheHitRatio(meter.value)).toBe(0)
  })
})

describe('LlmError 语义没被改坏', () => {
  it('分类错误仍带 code 与 retryable', () => {
    const error = new LlmError('x', 'SERVER', true)
    expect(error.code).toBe('SERVER')
    expect(error.retryable).toBe(true)
  })
})
