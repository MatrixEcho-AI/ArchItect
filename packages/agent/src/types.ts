/** 一条对话消息。**只追加、不修改**（plan §9.2 Regime A：破坏前缀缓存比省 token 贵得多）。 */
export interface LlmMessage {
  role: 'user' | 'assistant' | 'tool'
  /** 文本内容。工具结果也走这里。 */
  content: string
  /** assistant 消息里的工具调用。 */
  toolCalls?: LlmToolCall[]
  /** role=tool 时对应哪个调用。 */
  toolCallId?: string
  /** 随消息附带的图像。 */
  images?: LlmImage[]
  /**
   * 推理模型的思维链。
   *
   * **DeepSeek 要求把 assistant 消息回传时带上此前的 `reasoning_content`**
   * （`requiresReasoningContentOnAssistantMessages`），否则报错。这是最常见的集成 bug。
   */
  reasoningContent?: string
}

export interface LlmImage {
  png: Uint8Array
  mimeType: string
  /**
   * 内容寻址的去重键（sha256 前若干位）。
   *
   * 由**存图的那一层**在收下图片时算出来（`ChatController.storeAttachment`），
   * 所以构造 `LlmImage` 的调用方不必给——那个值只有存图的一层知道。
   * 它只用于去重、以及 `retainHistory` 判断"这张是不是用户给的"，缺了不会画错东西。
   */
  id?: string
}

export interface LlmToolCall {
  id: string
  name: string
  args: unknown
}

export interface LlmToolSchema {
  name: string
  description: string
  parameters: unknown
}

export interface LlmRequest {
  /** 稳定前缀的一部分——**逐字节固定，不许插时间戳/随机数**。 */
  system: string
  messages: readonly LlmMessage[]
  tools: readonly LlmToolSchema[]
  maxTokens?: number
  temperature?: number
}

export interface LlmUsage {
  in: number
  out: number
  cachedIn?: number
}

export interface LlmResponse {
  text: string
  toolCalls: LlmToolCall[]
  reasoningContent?: string
  usage: LlmUsage
  finishReason: string
}

/**
 * 流式增量：一次只带一小片正文或思维链。
 *
 * 它**不是**响应的一部分——拼好的完整响应仍然由 `chat()` 返回。这一路只是让调用方
 * 在字节到达的当下就能把字画出来（"逐字输出"），而不是等整段生成完。
 */
export interface LlmDelta {
  /** 正文碎片。 */
  text?: string
  /** 思维链碎片（DeepSeek 的 `reasoning_content`）。 */
  reasoning?: string
}

export interface LlmProvider {
  readonly id: string
  readonly model: string
  /** 是否支持图像输入。不支持时调用方要把图换成文字描述。 */
  readonly supportsImages: boolean
  /**
   * 发一次请求。
   *
   * 给了 `onDelta` 就**边收边报**：每收到一片就调一次，调用方可以立刻显示。
   * 不给也不影响正确性，只是要等整段生成完才看得到内容。
   */
  chat(request: LlmRequest, onDelta?: (delta: LlmDelta) => void): Promise<LlmResponse>
}

export class LlmError extends Error {
  override readonly name = 'LlmError'
  constructor(
    message: string,
    readonly code: 'AUTH' | 'RATE_LIMIT' | 'BAD_REQUEST' | 'SERVER' | 'NETWORK' | 'PARSE' | 'TRUNCATED',
    readonly retryable: boolean,
  ) {
    super(message)
  }
}
