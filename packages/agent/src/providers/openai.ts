import { t } from '@architect/i18n'

import { LlmError } from '../types.js'
import type { LlmMessage, LlmProvider, LlmRequest, LlmResponse, LlmToolCall, LlmUsage } from '../types.js'

export interface OpenAiCompatibleConfig {
  id?: string
  /** 接口地址，如 `https://api.deepseek.com` 或 `http://localhost:11434/v1`。 */
  baseURL: string
  apiKey?: string
  model: string
  supportsImages?: boolean
  /**
   * 兼容开关。**默认 'auto'**——不要为每个供应商写一套标志位（plan §9.5 排查清单）。
   *
   * 这些开关最初是"首次调用返回 400 时的排查清单"，既然排查动作是确定的，
   * 就让适配层自己试出来并把结果记住：
   *
   * - `maxTokensField: 'auto'`：先发 `max_tokens`；若 400 的正文提到
   *   `max_completion_tokens`，就换成它重发一次，并把能用的那个记住。
   * - `reasoningContent: 'auto'`：只有当这个模型**确实返回过** `reasoning_content`
   *   时，才在回传 assistant 消息时带上它。DeepSeek 要求带（带了 `tools` 的请求里
   *   历史每一轮的 `reasoning_content` 都必须原样回传，否则 400），
   *   而 OpenAI 收到未知字段也会报错——'auto' 两边都对。
   * - `thinking` / `reasoningEffort`：思考模式的开关与强度。`'auto'` 表示**不传**。
   */
  compat?: {
    maxTokensField?: 'max_tokens' | 'max_completion_tokens' | 'auto'
    reasoningContent?: boolean | 'auto'
    thinking?: 'enabled' | 'disabled' | 'auto'
    reasoningEffort?: 'low' | 'high' | 'max' | 'auto'
    /** 额外合并进请求体的字段。 */
    extraBody?: Record<string, unknown>
  }
  /**
   * 单次请求的输出上限。**默认不设**——不设才是不限制：
   * 服务端思考模式默认 64K，比我们猜的任何数字都准。
   * 请求里显式给了 `maxTokens` 时以请求为准。
   */
  maxOutputTokens?: number
  /** 自定义 fetch（测试注入用）。 */
  fetchImpl?: typeof fetch
}

const BASE64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

/** 纯 JS base64 编码（不依赖 Buffer / btoa，Node 与浏览器都能跑）。 */
export function bytesToBase64(bytes: Uint8Array): string {
  let out = ''
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i]!
    const b1 = bytes[i + 1]
    const b2 = bytes[i + 2]
    out += BASE64_ALPHABET[b0 >> 2]
    out += BASE64_ALPHABET[((b0 & 0x03) << 4) | ((b1 ?? 0) >> 4)]
    out += b1 === undefined ? '=' : BASE64_ALPHABET[((b1 & 0x0f) << 2) | ((b2 ?? 0) >> 6)]
    out += b2 === undefined ? '=' : BASE64_ALPHABET[b2 & 0x3f]
  }
  return out
}

/**
 * OpenAI 兼容的 chat/completions provider。
 *
 * 一份实现同时覆盖 DeepSeek、Ollama、vLLM、LM Studio——它们的差别都在
 * `compat` 里，不需要为每个供应商写一套（plan §9.5「不做特殊分支」）。
 */
export class OpenAiCompatibleProvider implements LlmProvider {
  readonly id: string
  readonly model: string
  readonly supportsImages: boolean
  private readonly fetchImpl: typeof fetch
  /** `maxTokensField: 'auto'` 试出来的那个字段，试到之后就不再反复试错。 */
  private learnedMaxTokensField: 'max_tokens' | 'max_completion_tokens' | undefined
  /** 这个模型是否返回过 `reasoning_content`——决定要不要在回传时带上它。 */
  private sawReasoningContent = false

  constructor(private readonly config: OpenAiCompatibleConfig) {
    this.id = config.id ?? 'openai-compatible'
    this.model = config.model
    this.supportsImages = config.supportsImages ?? true
    this.fetchImpl = config.fetchImpl ?? globalThis.fetch
  }

  async chat(request: LlmRequest): Promise<LlmResponse> {
    const fields = this.maxTokensFields()
    let lastError: unknown
    for (const [index, field] of fields.entries()) {
      try {
        const response = await this.send(this.buildBody(request, field))
        this.learnedMaxTokensField = field
        return this.parse(response)
      } catch (error) {
        lastError = error
        const canRetry = index < fields.length - 1 && isWrongMaxTokensField(error, field)
        if (!canRetry) throw error
      }
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError))
  }

  /**
   * 该按什么顺序试 `max_tokens` 字段。
   *
   * 配了 `'auto'` 且还没试出结果时，两个都准备好——但**只在真的被 400 拒绝时才试第二个**，
   * 所以正常路径永远只有一次请求。
   */
  private maxTokensFields(): Array<'max_tokens' | 'max_completion_tokens'> {
    const configured = this.config.compat?.maxTokensField ?? 'auto'
    if (configured !== 'auto') return [configured]
    const first = this.learnedMaxTokensField ?? 'max_tokens'
    return [first, first === 'max_tokens' ? 'max_completion_tokens' : 'max_tokens']
  }

  private buildBody(
    request: LlmRequest,
    maxTokensField: 'max_tokens' | 'max_completion_tokens',
  ): Record<string, unknown> {
    const body: Record<string, unknown> = {
      model: this.model,
      messages: request.messages.map((message) => this.serialize(message)),
      stream: false,
      ...(this.config.compat?.extraBody ?? {}),
    }
    // **不设上限时就不要发这个字段**，让服务端用它自己的默认值。
    //
    // DeepSeek 官方口径（api/create-chat-completion）：`max_tokens` 未设置时
    // **非思考模式默认 8K、思考模式默认 64K**，`reasoning_effort: max` 时 128K。
    // 也就是说"不设置"比我们自己猜一个数更强——我们猜的 8192 曾在真机上
    // 把思考模型的额度全吃掉：`finish_reason: length`、正文空、工具调用零。
    // 发一个**更大**的默认值只是把同一个错误推远一点，正确做法是别抢这个决定权。
    const maxTokens = request.maxTokens ?? this.config.maxOutputTokens
    if (maxTokens !== undefined) body[maxTokensField] = maxTokens
    if (request.temperature !== undefined) body.temperature = request.temperature
    // 思考模式开关与强度走顶层字段（OpenAI SDK 里要放进 extra_body，裸 HTTP 不用）。
    // 只在**显式配置**时才发：'auto' 是不发，把选择权留给服务端默认。
    const thinking = this.config.compat?.thinking ?? 'auto'
    if (thinking !== 'auto') body.thinking = { type: thinking }
    const effort = this.config.compat?.reasoningEffort ?? 'auto'
    if (effort !== 'auto') body.reasoning_effort = effort
    if (request.tools.length > 0) {
      body.tools = request.tools.map((tool) => ({
        type: 'function',
        function: { name: tool.name, description: tool.description, parameters: tool.parameters },
      }))
      body.tool_choice = 'auto'
    }
    if (request.system.length > 0) {
      body.messages = [{ role: 'system', content: request.system }, ...(body.messages as unknown[])]
    }
    return body
  }

  /** 显式的 `true`/`false` 优先；`'auto'`（默认）看这个模型的实际行为。 */
  private shouldEchoReasoning(): boolean {
    const configured = this.config.compat?.reasoningContent
    if (configured === true) return true
    if (configured === false) return false
    return this.sawReasoningContent
  }

  private serialize(message: LlmMessage): Record<string, unknown> {
    if (message.role === 'tool') {
      return { role: 'tool', tool_call_id: message.toolCallId, content: message.content }
    }
    if (message.role === 'assistant') {
      const out: Record<string, unknown> = { role: 'assistant', content: message.content || null }
      if (message.toolCalls !== undefined && message.toolCalls.length > 0) {
        out.tool_calls = message.toolCalls.map((call) => ({
          id: call.id,
          type: 'function',
          function: { name: call.name, arguments: JSON.stringify(call.args ?? {}) },
        }))
      }
      // 只有模型确实返回过 `reasoning_content` 才回传：DeepSeek 不带会报错，
      // 而 OpenAI 收到这个未知字段同样会报错（plan §9.5 排查清单）
      if (this.shouldEchoReasoning() && message.reasoningContent !== undefined) {
        out.reasoning_content = message.reasoningContent
      }
      return out
    }

    // user：带图时用 content parts，否则用纯字符串（省 token）
    if (message.images === undefined || message.images.length === 0 || !this.supportsImages) {
      // 这段文本会发给模型，属于 prompt（英文，见 prompts.ts），不走 i18n
      const text =
        message.images !== undefined && message.images.length > 0 && !this.supportsImages
          ? `${message.content}\n(The current model does not support images; ${message.images.length} screenshot(s) omitted)`
          : message.content
      return { role: 'user', content: text }
    }
    const parts: Array<Record<string, unknown>> = []
    if (message.content.length > 0) parts.push({ type: 'text', text: message.content })
    for (const image of message.images) {
      parts.push({
        type: 'image_url',
        image_url: { url: `data:${image.mimeType};base64,${bytesToBase64(image.png)}` },
      })
    }
    return { role: 'user', content: parts }
  }

  private async send(body: Record<string, unknown>): Promise<unknown> {
    const url = `${this.config.baseURL.replace(/\/+$/, '')}/chat/completions`
    const headers: Record<string, string> = { 'content-type': 'application/json' }
    if (this.config.apiKey !== undefined && this.config.apiKey.length > 0) {
      headers.authorization = `Bearer ${this.config.apiKey}`
    }

    let response: Response
    try {
      response = await this.fetchImpl(url, { method: 'POST', headers, body: JSON.stringify(body) })
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
      throw classifyHttpError(response.status, text)
    }
    try {
      return await response.json()
    } catch (error) {
      throw new LlmError(
        t('agent.network.invalidJson', { error: error instanceof Error ? error.message : String(error) }),
        'PARSE',
        false,
      )
    }
  }

  private parse(raw: unknown): LlmResponse {
    const payload = raw as {
      choices?: Array<{
        message?: {
          content?: string | null
          reasoning_content?: string
          tool_calls?: Array<{ id?: string; function?: { name?: string; arguments?: string } }>
        }
        finish_reason?: string
      }>
      usage?: {
        prompt_tokens?: number
        completion_tokens?: number
        prompt_cache_hit_tokens?: number
      }
    }

    const choice = payload.choices?.[0]
    if (choice?.message === undefined) {
      throw new LlmError(t('agent.openai.noChoices'), 'PARSE', false)
    }
    const message = choice.message

    const toolCalls: LlmToolCall[] = []
    for (const [index, call] of (message.tool_calls ?? []).entries()) {
      const name = call.function?.name
      if (name === undefined) continue
      let args: unknown = {}
      const rawArgs = call.function?.arguments ?? '{}'
      try {
        args = rawArgs.trim().length === 0 ? {} : JSON.parse(rawArgs)
      } catch {
        // 参数不是合法 JSON 时不要吞掉——把原文交给上层，它会回灌给模型重试
        throw new LlmError(
          t('agent.openai.toolArgsInvalid', { name, args: rawArgs.slice(0, 200) }),
          'PARSE',
          false,
        )
      }
      toolCalls.push({ id: call.id ?? `call_${index}`, name, args })
    }

    const usage: LlmUsage = {
      in: payload.usage?.prompt_tokens ?? 0,
      out: payload.usage?.completion_tokens ?? 0,
    }
    if (payload.usage?.prompt_cache_hit_tokens !== undefined) {
      usage.cachedIn = payload.usage.prompt_cache_hit_tokens
    }

    const response: LlmResponse = {
      text: message.content ?? '',
      toolCalls,
      usage,
      finishReason: choice.finish_reason ?? (toolCalls.length > 0 ? 'tool_calls' : 'stop'),
    }
    if (message.reasoning_content !== undefined) {
      // 记住"这个模型会说思维链"，下次回传时要带上（'auto' 模式的判断依据）
      this.sawReasoningContent = true
      response.reasoningContent = message.reasoning_content
    }
    return response
  }
}

/**
 * 这个 400 是不是"`max_tokens` 字段名不对"引起的。
 *
 * 只认**正文里明确提到另一个字段名**的 400——否则一次普通的参数错误会被当成
 * 字段名问题，白白多打一次请求，还会把真正的错误信息盖掉。
 */
function isWrongMaxTokensField(
  error: unknown,
  attempted: 'max_tokens' | 'max_completion_tokens',
): boolean {
  if (!(error instanceof LlmError) || error.code !== 'BAD_REQUEST') return false
  const other = attempted === 'max_tokens' ? 'max_completion_tokens' : 'max_tokens'
  return error.message.includes(other)
}

export function classifyHttpError(status: number, body: string): LlmError {
  const detail = body.slice(0, 400)
  if (status === 401 || status === 403) {
    return new LlmError(t('agent.openai.authFailed', { status, detail }), 'AUTH', false)
  }
  if (status === 429) {
    return new LlmError(t('agent.openai.rateLimited', { detail }), 'RATE_LIMIT', true)
  }
  if (status >= 500) {
    return new LlmError(t('agent.openai.serverError', { status, detail }), 'SERVER', true)
  }
  return new LlmError(t('agent.openai.badRequest', { status, detail }), 'BAD_REQUEST', false)
}
