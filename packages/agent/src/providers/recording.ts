import { t } from '@architect/i18n'

import { LlmError } from '../types.js'
import type { LlmDelta, LlmMessage, LlmProvider, LlmRequest, LlmResponse, LlmToolCall, LlmUsage } from '../types.js'

/** 请求侧的可序列化快照。图像只记数量与哈希——把 PNG 塞进录音会让文件大到没法用。 */
export interface RecordedRequest {
  system: string
  messages: Array<{
    role: string
    content: string
    toolCalls?: Array<{ id: string; name: string }>
    toolCallId?: string
    images?: Array<{ id: string; bytes: number }>
  }>
  /** 本轮暴露了哪些工具。工具集变了录音就该作废。 */
  tools: string[]
}

export interface RecordedResponse {
  text: string
  toolCalls: LlmToolCall[]
  reasoningContent?: string
  usage: LlmUsage
  finishReason: string
}

export interface RecordedExchange {
  turn: number
  meta: { at: string; provider: string; model: string; ms: number }
  request: RecordedRequest
  response: RecordedResponse
}

/**
 * 包一层，把每次 LLM 交互记成 JSONL。
 *
 * 真实 API 调用是**不可重放的**：模型有随机性、成本真实、还要联网。
 * 录下来之后，"这次跑砸了"就能离线反复复现——调 prompt、改工具描述、
 * 写回归测试都不再需要再花一次钱。
 */
export class RecordingProvider implements LlmProvider {
  readonly id: string
  readonly model: string
  readonly supportsImages: boolean
  private turn = 0

  constructor(
    private readonly inner: LlmProvider,
    private readonly sink: (exchange: RecordedExchange) => void,
    private readonly clock: () => Date = () => new Date(),
  ) {
    this.id = `${inner.id}+recording`
    this.model = inner.model
    this.supportsImages = inner.supportsImages
  }

  async chat(request: LlmRequest, onDelta?: (delta: LlmDelta) => void): Promise<LlmResponse> {
    const started = Date.now()
    // 增量**原样透传**：录音要录的是"最终响应"，而界面要的是"字在往外冒"，
    // 这两件事互不干扰，在这一层不需要做任何取舍
    const response = await this.inner.chat(request, onDelta)
    this.turn++
    this.sink({
      turn: this.turn,
      meta: {
        at: this.clock().toISOString(),
        provider: this.inner.id,
        model: this.inner.model,
        ms: Date.now() - started,
      },
      request: serializeRequest(request),
      response: {
        text: response.text,
        toolCalls: response.toolCalls,
        ...(response.reasoningContent !== undefined
          ? { reasoningContent: response.reasoningContent }
          : {}),
        usage: response.usage,
        finishReason: response.finishReason,
      },
    })
    return response
  }
}

function serializeRequest(request: LlmRequest): RecordedRequest {
  return {
    system: request.system,
    messages: request.messages.map((message) => {
      const out: RecordedRequest['messages'][number] = {
        role: message.role,
        content: message.content,
      }
      if (message.toolCalls !== undefined) {
        out.toolCalls = message.toolCalls.map((call) => ({ id: call.id, name: call.name }))
      }
      if (message.toolCallId !== undefined) out.toolCallId = message.toolCallId
      if (message.images !== undefined) {
        out.images = message.images.map((image) => ({ id: image.id, bytes: image.png.length }))
      }
      return out
    }),
    tools: request.tools.map((tool) => tool.name),
  }
}

export interface ReplayOptions {
  /** 录音里的工具集与当前不一致时是否直接报错。默认 `true`。 */
  strictTools?: boolean
  /** 用录音里的 token 数还是估算值。默认用录音里的。 */
  onExhausted?: 'error' | 'stop'
}

/**
 * 按录音重放。
 *
 * 它不校验请求——因为工具执行是确定性的，同一段对话会走到同一处；
 * 一旦走岔了（改了 prompt、改了工具描述），**实际轮数与录音对不上**，
 * 重放会在对应位置报错。这正是我们想要的信号：录音过期了。
 */
export class ReplayProvider implements LlmProvider {
  readonly id = 'replay'
  readonly model: string
  readonly supportsImages = true
  private cursor = 0

  constructor(
    private readonly exchanges: readonly RecordedExchange[],
    private readonly options: ReplayOptions = {},
  ) {
    this.model = exchanges[0]?.meta.model ?? 'replay'
  }

  get consumed(): number {
    return this.cursor
  }

  get remaining(): number {
    return this.exchanges.length - this.cursor
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async chat(request: LlmRequest, onDelta?: (delta: LlmDelta) => void): Promise<LlmResponse> {
    const exchange = this.exchanges[this.cursor]
    if (exchange === undefined) {
      if (this.options.onExhausted === 'stop') {
        return { text: t('agent.recording.exhausted'), toolCalls: [], usage: { in: 0, out: 0 }, finishReason: 'stop' }
      }
      throw new LlmError(
        t('agent.recording.stale', { total: this.exchanges.length, turn: this.cursor + 1 }),
        'PARSE',
        false,
      )
    }

    if (this.options.strictTools !== false) {
      const recorded = new Set(exchange.request.tools)
      const current = new Set(request.tools.map((tool) => tool.name))
      const missing = [...recorded].filter((name) => !current.has(name))
      if (missing.length > 0) {
        throw new LlmError(
          t('agent.recording.missingTools', { turn: this.cursor + 1, tools: missing.join(', ') }),
          'PARSE',
          false,
        )
      }
    }

    this.cursor++
    const { response } = exchange
    const result: LlmResponse = {
      text: response.text,
      toolCalls: response.toolCalls,
      usage: response.usage,
      finishReason: response.finishReason,
    }
    if (response.reasoningContent !== undefined) result.reasoningContent = response.reasoningContent
    // 重放没有真实的碎片（录音里存的是成型响应），所以**一次报完**：
    // 界面走的仍是同一条流式路径，只是"逐字"退化成"一次性出现"
    if (typeof onDelta === 'function') {
      if (result.text.length > 0) onDelta({ text: result.text })
      if (result.reasoningContent !== undefined) onDelta({ reasoning: result.reasoningContent })
    }
    return result
  }
}

/** JSONL 序列化（一行一次交互），便于增量写与断点查看。 */
export function exchangesToJsonl(exchanges: readonly RecordedExchange[]): string {
  return exchanges.map((exchange) => JSON.stringify(exchange)).join('\n') + '\n'
}

export function exchangesFromJsonl(text: string): RecordedExchange[] {
  const out: RecordedExchange[] = []
  for (const [index, line] of text.split('\n').entries()) {
    const trimmed = line.trim()
    if (trimmed.length === 0) continue
    try {
      out.push(JSON.parse(trimmed) as RecordedExchange)
    } catch (error) {
      throw new LlmError(
        t('agent.recording.invalidJsonLine', {
          line: index + 1,
          error: error instanceof Error ? error.message : String(error),
        }),
        'PARSE',
        false,
      )
    }
  }
  return out
}

/** 把一段消息数组压成人类可读的单行摘要（日志用）。 */
export function summarizeMessages(messages: readonly LlmMessage[]): string {
  return messages
    .map((message) => {
      const images = message.images !== undefined ? ` +${message.images.length}img` : ''
      return `${message.role}:${message.content.slice(0, 40)}${images}`
    })
    .join(' | ')
}
