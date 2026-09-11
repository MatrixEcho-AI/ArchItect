import { t } from '@architect/i18n'

import { scrubSecrets } from '../redact.js'
import { LlmError } from '../types.js'
import type { LlmDelta, LlmMessage, LlmProvider, LlmRequest, LlmResponse, LlmToolCall, LlmUsage } from '../types.js'

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
  /**
   * 要不要在流式请求里要用量（`stream_options.include_usage`）。
   *
   * 默认要——没有它，流式的响应里**根本没有 usage**，成本表盘与缓存命中率会全变 0。
   * 端点不认这个字段（400）时学一次，之后不再发。
   */
  private wantUsage = true

  constructor(private readonly config: OpenAiCompatibleConfig) {
    this.id = config.id ?? 'openai-compatible'
    this.model = config.model
    this.supportsImages = config.supportsImages ?? true
    this.fetchImpl = config.fetchImpl ?? globalThis.fetch
  }

  async chat(request: LlmRequest, onDelta?: (delta: LlmDelta) => void): Promise<LlmResponse> {
    const fields = this.maxTokensFields()
    let lastError: unknown
    for (const [index, field] of fields.entries()) {
      try {
        return await this.streamOnce(request, field, onDelta)
      } catch (error) {
        lastError = error
        const canRetry = index < fields.length - 1 && isWrongMaxTokensField(error, field)
        if (!canRetry) throw error
      }
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError))
  }

  /**
   * 发一次流式请求，把 SSE 拼回一个完整响应。
   *
   * 里面多一层 `stream_options` 的自适应：`include_usage` 是拿到用量（成本表盘、
   * 缓存命中率）的唯一途径，但个别兼容端点不认这个字段。被 400 顶回来就**去掉它重发一次**
   * 并记住——少一份用量也不能少一次回答。
   */
  private async streamOnce(
    request: LlmRequest,
    maxTokensField: 'max_tokens' | 'max_completion_tokens',
    onDelta?: (delta: LlmDelta) => void,
  ): Promise<LlmResponse> {
    try {
      const parsed = await this.readStream(
        await this.send(this.buildBody(request, maxTokensField, this.wantUsage)),
        onDelta,
      )
      this.learnedMaxTokensField = maxTokensField
      return parsed
    } catch (error) {
      if (!this.wantUsage || !isUsageOptionRejection(error)) throw error
      this.wantUsage = false
      const parsed = await this.readStream(
        await this.send(this.buildBody(request, maxTokensField, false)),
        onDelta,
      )
      this.learnedMaxTokensField = maxTokensField
      return parsed
    }
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
    withUsage: boolean,
  ): Record<string, unknown> {
    const body: Record<string, unknown> = {
      model: this.model,
      messages: request.messages.map((message) => this.serialize(message)),
      // **永远流式**。非流式意味着"整个响应准备好才发第一个字节"：服务端思考多久，
      // 这条连接就得干等多久，网关那堵 50 s 的墙就是这么撞上的（plan §16）。
      // 流式下字节一直在流动，那堵墙不成立——模型想多久想多久，输出也不设上限。
      stream: true,
      ...(this.config.compat?.extraBody ?? {}),
    }
    // 流式的用量只在最后一个 chunk 里给，而且**要显式索取**
    // （`stream_options: { include_usage: true }`）。不发的后果是成本表盘与
    // 缓存命中率永远是 0——那是这个 harness 最看重的两个数字。
    if (withUsage) body.stream_options = { include_usage: true }
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

  private async send(body: Record<string, unknown>): Promise<Response> {
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
    return response
  }

  /**
   * 把 SSE 流拼回一个完整响应。
   *
   * 事件格式（OpenAI / DeepSeek 一致）：一行一个 `data: <json>`，空行分隔事件，
   * 末尾 `data: [DONE]`。增量在 `choices[0].delta` 里：
   *
   * - `content` 是正文碎片，**直接拼**；
   * - `reasoning_content` 是思维链碎片，**同样要拼**（DeepSeek 的推理模型要求的回传字段）；
   * - `tool_calls` 按 `index` 分片到达，`function.arguments` 是**跨 chunk 的 JSON 碎片**，
   *   必须按 index 累加到最后才 `JSON.parse`——这也是流式最容易被写错的一处；
   * - `finish_reason` 只在最后那个带内容的 chunk 里，之前一直是 `null`。
   *
   * 用量要走 `stream_options.include_usage`，服务端才会在 `[DONE]` 之前补一个
   * 只有 `usage` 的 chunk。
   *
   * `onDelta` 是一条**旁路**：每片碎片在到达的当下就报出去（界面靠它逐字输出），
   * 而返回值仍然是拼好的整段——两边的口径必须一致，否则画面与历史会各说各话。
   */
  private async readStream(response: Response, onDelta?: (delta: LlmDelta) => void): Promise<LlmResponse> {
    const body = response.body
    if (body === null) {
      // 没有 body 说明这个端点根本没打算流式回话（或者被中间层吃掉了）
      throw new LlmError(t('agent.network.noStreamBody'), 'NETWORK', true)
    }

    const reader = body.getReader()
    const decoder = new TextDecoder()
    const text: string[] = []
    const reasoning: string[] = []
    /** index → 累加中的工具调用。`arguments` 是碎片，拼完才解析。 */
    const calls = new Map<number, { id: string; name: string; args: string }>()
    let usage: LlmUsage = { in: 0, out: 0 }
    let finishReason: string | undefined
    let sawDone = false
    let cutOff = false
    let buffer = ''

    const consume = (line: string): void => {
      // SSE 的其它行（`event:` / `id:` / `:keep-alive` 注释）一律忽略
      if (!line.startsWith('data:')) return
      const payload = line.slice(5).trim()
      if (payload.length === 0) return
      if (payload === '[DONE]') {
        sawDone = true
        return
      }
      let chunk: StreamChunk
      try {
        chunk = JSON.parse(payload) as StreamChunk
      } catch {
        // 服务端真的回了个坏 JSON：重试只会重复同一个错误
        throw new LlmError(t('agent.openai.chunkInvalid', { chunk: payload.slice(0, 200) }), 'PARSE', false)
      }
      const choice = chunk.choices?.[0]
      // `delta` 可能是 `{}`、也可能是 `null`（收尾那一帧），两种都要当"没有内容"处理
      const delta = choice?.delta ?? undefined
      if (delta !== undefined && delta !== null) {
        // 碎片**先报出去**（能报一片就报一片），再照样累积——界面靠这一路逐字输出，
        // 而返回给循环的仍然是拼好的完整响应。空字符串不报：那只是帧的边界，不是内容。
        if (typeof delta.content === 'string' && delta.content.length > 0) {
          text.push(delta.content)
          onDelta?.({ text: delta.content })
        }
        if (typeof delta.reasoning_content === 'string' && delta.reasoning_content.length > 0) {
          reasoning.push(delta.reasoning_content)
          onDelta?.({ reasoning: delta.reasoning_content })
        }
        for (const part of delta.tool_calls ?? []) {
          const index = typeof part.index === 'number' ? part.index : 0
          const entry = calls.get(index) ?? { id: '', name: '', args: '' }
          if (typeof part.id === 'string' && part.id.length > 0) entry.id = part.id
          // 名字与参数都按官方 SDK 的口径**拼接**（它们都可能分片到达）
          if (typeof part.function?.name === 'string') entry.name += part.function.name
          if (typeof part.function?.arguments === 'string') entry.args += part.function.arguments
          calls.set(index, entry)
        }
      }
      if (typeof choice?.finish_reason === 'string') finishReason = choice.finish_reason
      // **`usage` 在每个 chunk 里都是 `null`，只有最后一个 chunk 才有对象**——这是
      // DeepSeek / OpenAI 流式的正常形状，不是"缺字段"。判据必须是"是不是对象"，
      // 用 `!== undefined` 会让 `null` 漏进来，然后在 `null` 上读 `prompt_tokens` 抛
      // TypeError ——那个错误还会顺着下面的 catch 被包装成"连接被掐断"，
      // 让人去查网络，而真凶是这里（真机上就这么翻过一次车）。
      if (chunk.usage !== null && typeof chunk.usage === 'object') {
        usage = {
          in: chunk.usage.prompt_tokens ?? 0,
          out: chunk.usage.completion_tokens ?? 0,
        }
        if (chunk.usage.prompt_cache_hit_tokens !== undefined) {
          usage.cachedIn = chunk.usage.prompt_cache_hit_tokens
        }
      }
    }

    for (;;) {
      let done: boolean
      let value: Uint8Array | undefined
      try {
        ;({ done, value } = await reader.read())
      } catch (error) {
        // **只有读流本身失败**才是网络故障（`terminated` / `ECONNRESET`）：可重试
        await reader.cancel().catch(() => undefined)
        throw new LlmError(
          t('agent.network.truncated', { error: error instanceof Error ? error.message : String(error) }),
          'TRUNCATED',
          true,
        )
      }
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      // **只处理完整的行**：一个 chunk 的边界可能正好切在一行中间。
      // 这里抛出的异常（比如 chunk 不是合法 JSON）是**服务端或我们自己的问题**，
      // 不能再被包装成"连接被掐断"——那会把一个确定的错误说成一个网络的错。
      let newline: number
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline).replace(/\r$/, '')
        buffer = buffer.slice(newline + 1)
        consume(line)
      }
    }
    buffer += decoder.decode()
    const tail = buffer.trim()
    if (tail.length > 0) {
      // 流的最后一行**没有以换行结束**，说明它被砍断了。正常收尾的流最后一定是
      // `data: [DONE]\n\n`，这时 buffer 里什么都不该剩。
      // 按"可重试的掐断"处理，**不能**当成"服务端回了坏 JSON"——
      // 后者不可重试，一次误判就白丢掉一整轮（而且用户看到的是个假原因）。
      try {
        consume(tail.replace(/\r$/, ''))
      } catch (error) {
        // 只有"这半行不是合法 JSON"才说明它是被砍断的；别的异常照原样抛
        if (error instanceof LlmError && error.code === 'PARSE') cutOff = true
        else throw error
      }
    }
    reader.releaseLock()

    // **没有 `[DONE]` 也没有 `finish_reason`** = 流在半路断了。这时候拿到的正文是
    // 半截的，当成正常响应会让循环把半句话当成模型的最终答复。
    if (cutOff || (!sawDone && finishReason === undefined)) {
      throw new LlmError(t('agent.network.truncated', { error: 'stream ended early' }), 'TRUNCATED', true)
    }

    const toolCalls: LlmToolCall[] = []
    for (const [index, entry] of [...calls.entries()].sort((a, b) => a[0] - b[0])) {
      if (entry.name.length === 0) continue
      let args: unknown = {}
      try {
        args = entry.args.trim().length === 0 ? {} : JSON.parse(entry.args)
      } catch {
        // 参数不是合法 JSON 时不要吞掉——把原文交给上层，它会回灌给模型重试
        throw new LlmError(
          t('agent.openai.toolArgsInvalid', { name: entry.name, args: entry.args.slice(0, 200) }),
          'PARSE',
          false,
        )
      }
      toolCalls.push({ id: entry.id.length > 0 ? entry.id : `call_${index}`, name: entry.name, args })
    }

    const reasoningText = reasoning.join('')
    const result: LlmResponse = {
      text: text.join(''),
      toolCalls,
      usage,
      finishReason: finishReason ?? (toolCalls.length > 0 ? 'tool_calls' : 'stop'),
    }
    if (reasoningText.length > 0) {
      // 记住"这个模型会说思维链"，下次回传时要带上（'auto' 模式的判断依据）
      this.sawReasoningContent = true
      result.reasoningContent = reasoningText
    }
    return result
  }
}

/** SSE 里的一个 chunk。字段名跟随 OpenAI / DeepSeek。 */
interface StreamChunk {
  choices?: Array<{
    delta?: {
      content?: string | null
      reasoning_content?: string
      tool_calls?: Array<{
        index?: number
        id?: string
        function?: { name?: string; arguments?: string }
      }>
    } | null
    finish_reason?: string | null
  }>
  /**
   * **流里的每个 chunk 都带这个字段，而且除最后一个之外都是 `null`**。
   * 类型上必须允许 `null`，否则就会写出"在 null 上读 prompt_tokens"那种 bug。
   */
  usage?: {
    prompt_tokens?: number
    completion_tokens?: number
    prompt_cache_hit_tokens?: number
  } | null
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

/**
 * 这个 400 是不是"端点不认 `stream_options`"引起的。
 *
 * 只认正文里明确提到这个字段名的 400：别的参数错误不该被当成它，
 * 否则我们会白白去掉用量、而且真正的错误信息也被盖住。
 */
function isUsageOptionRejection(error: unknown): boolean {
  if (!(error instanceof LlmError) || error.code !== 'BAD_REQUEST') return false
  return /stream_options|include_usage/i.test(error.message)
}

export function classifyHttpError(status: number, body: string): LlmError {
  // 正文来自服务端，未必可信。**先脱敏再进消息**：这条消息会进界面、进日志，
  // 还会随 `retry` 事件进 `.mcai` 的对话档案，而 `.mcai` 是要分享的。
  // 会回显整个请求（含 `Authorization`）的中转站是现实存在的。
  const detail = scrubSecrets(body.slice(0, 400))
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
