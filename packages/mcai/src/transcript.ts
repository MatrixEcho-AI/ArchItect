import { createHash } from 'node:crypto'

import { buildCaptureBundle, makeCaptureRef } from './chat.js'
import type { CaptureBundle, CaptureRef, ChatMessageRecord, ChatSessionRecord, ChatTranscript } from './chat.js'

/**
 * 把 agent 的事件流录成一份**可随工程文件分享的对话记录**。
 *
 * ## 为什么类型定义在这里，而不是 import `AgentEvent`
 *
 * `.mcai` 是格式的权威，`packages/agent` 是 harness 的实现。让"格式"反过来依赖"实现"
 * 会把两边的演进绑死（改一个事件字段就要动格式包）。所以这里声明一份**结构化视图**，
 * `AgentEvent` 在结构上满足它即可——`packages/agent/test/transcript.test.ts` 里有一条
 * 编译期断言把这个约束钉住，字段对不上会直接编译失败。
 *
 * ## 录什么、不录什么
 *
 * 录的是**给人看的过程**：用户说了什么、模型说了什么、调了哪个工具、结果如何、
 * 拍出来的图。**不录**发给模型的原始消息——里面有 system prompt、工具 schema、
 * 图片 base64，既有重复又可能夹着不该随文件分享的东西（§9.2 那份是缓存前缀，
 * 不是档案）。
 */

/** `AgentEvent` 的结构化最小视图。 */
export type TranscriptEvent =
  | { type: 'turn'; turn: number }
  | { type: 'assistant'; turn: number; text: string }
  | { type: 'tool_call'; turn: number; id: string; name: string; args: unknown }
  | { type: 'tool_result'; turn: number; id: string; name: string; result: TranscriptToolResult }
  | { type: 'images'; turn: number; count: number; bytes: number }
  | { type: 'retry'; attempt: number; reason: string }
  /** 单轮输出撞上 token 上限。`toolCalls` 为 0 表示这一轮什么都没产出。 */
  | { type: 'truncated'; turn: number; out: number; toolCalls: number }
  | { type: 'nudge'; reason: string; pendingMutations: number }
  /**
   * 这一轮发出去的请求被**裁剪**过（无前缀缓存的 provider，见 plan §9.2 Regime B）。
   *
   * 必须进档案：事后看"模型为什么忘了前面那几步"，答案就在这里——
   * 那些轮次根本没发出去。
   */
  | { type: 'context'; regime: string; droppedTurns: number; droppedImages: number; reason: string }
  /** 预算触顶：会话被主动刹住，不是故障。 */
  | { type: 'budget'; reason: string; detail: string; usage: { in: number; out: number; cachedIn?: number }; usd?: number }
  | { type: 'stop'; reason: string }

export interface TranscriptToolResult {
  ok: boolean
  summary: string
  image?: { png: Uint8Array; width: number; height: number; camera: string; revision: number }
}

export interface TranscriptRecorderOptions {
  /** 会话 id。省略时按时间生成一个。 */
  sessionId?: string
  /** 会话标题，通常就是用户那句需求。 */
  title?: string
  model?: string
  providerId?: string
  /** 注入时钟（测试用）。 */
  now?: () => string
}

export interface TranscriptRecording {
  transcript: ChatTranscript
  captures: CaptureBundle
}

/**
 * 事件流 → 对话记录。
 *
 * 用法：把它挂到 agent 的 `onEvent` 上，跑完取 `recording`。
 */
export class TranscriptRecorder {
  private readonly messages: ChatMessageRecord[] = []
  private readonly captureEntries: Array<{ ref: CaptureRef; png: Uint8Array }> = []
  private readonly session: ChatSessionRecord
  private readonly now: () => string
  private readonly model: string | undefined
  private nextId = 1

  constructor(options: TranscriptRecorderOptions = {}) {
    this.now = options.now ?? (() => new Date().toISOString())
    this.model = options.model
    this.session = {
      id: options.sessionId ?? `s${Date.now().toString(36)}`,
      title: options.title ?? '未命名会话',
      createdAt: this.now(),
      ...(options.model !== undefined ? { model: options.model } : {}),
      ...(options.providerId !== undefined ? { providerId: options.providerId } : {}),
    }
  }

  /** 手动补一条（比如用户那句需求——它不来自事件流）。 */
  add(role: ChatMessageRecord['role'], text: string): ChatMessageRecord {
    const message: ChatMessageRecord = { id: this.nextId++, role, text, ts: this.now() }
    this.messages.push(message)
    return message
  }

  /**
   * 记一条 assistant 回复并挂上这一轮的用量。
   *
   * `AgentEvent` 里没有 usage（用量在 `AgentState` 上，循环结束时才有），
   * 所以由调用方在收尾时补进来——见 `attachUsage`。
   */
  attachUsage(usage: { in: number; out: number; cachedIn?: number }, model?: string): void {
    const resolved = model ?? this.model
    for (let i = this.messages.length - 1; i >= 0; i--) {
      const message = this.messages[i]!
      if (message.role !== 'assistant' || message.usage !== undefined) continue
      message.usage = {
        in: usage.in,
        out: usage.out,
        ...(usage.cachedIn !== undefined ? { cachedIn: usage.cachedIn } : {}),
      }
      if (resolved !== undefined) message.model = resolved
      return
    }
  }

  onEvent(event: TranscriptEvent): void {
    switch (event.type) {
      case 'assistant':
        if (event.text.trim().length === 0) return
        this.messages.push({ id: this.nextId++, role: 'assistant', text: event.text, ts: this.now() })
        return
      case 'tool_call': {
        // 一次 LLM 响应里的**多个**工具调用属于同一条 assistant 消息。事件流把它们
        // 拆成了多条 `tool_call` 事件，这里再合回去——否则档案里会出现一串
        // 没有内容的空行，而"这一轮模型想做什么"恰恰是最该看清的东西。
        const last = this.messages[this.messages.length - 1]
        const call = { id: event.id, name: event.name, args: event.args }
        if (last !== undefined && last.role === 'assistant' && last.note === undefined) {
          if (last.toolCalls === undefined) last.toolCalls = [call]
          else last.toolCalls.push(call)
          return
        }
        this.messages.push({
          id: this.nextId++,
          role: 'assistant',
          text: '',
          ts: this.now(),
          toolCalls: [call],
        })
        return
      }
      case 'tool_result':
        this.recordToolResult(event)
        return
      case 'retry':
        this.messages.push({
          id: this.nextId++,
          role: 'assistant',
          text: `[retry ${event.attempt}] ${event.reason}`,
          ts: this.now(),
          note: 'retry',
        })
        return
      case 'nudge':
        this.messages.push({
          id: this.nextId++,
          role: 'assistant',
          text: `[GATE] ${event.reason} (pending mutations: ${event.pendingMutations})`,
          ts: this.now(),
          note: 'gate',
        })
        return
      case 'truncated':
        // 截断要留在档案里：它解释了两件事——为什么这一轮什么都没有，
        // 以及钱花到哪去了（`out` 是**被浪费掉**的那部分额度）
        this.messages.push({
          id: this.nextId++,
          role: 'assistant',
          text: `[TRUNCATED] output limit hit at ${event.out} tokens, ${event.toolCalls} tool call(s) emitted`,
          ts: this.now(),
          note: 'truncated',
          usage: { in: 0, out: event.out },
        })
        return
      case 'budget':
        // 预算刹车也是"不是模型说的话"，但它**带着用量**——档案里留一份，
        // 事后才能回答"这次为什么停了、花到多少"
        this.messages.push({
          id: this.nextId++,
          role: 'assistant',
          text: `[BUDGET] ${event.detail}`,
          ts: this.now(),
          note: 'budget',
          usage: {
            in: event.usage.in,
            out: event.usage.out,
            ...(event.usage.cachedIn !== undefined ? { cachedIn: event.usage.cachedIn } : {}),
          },
          ...(event.usd !== undefined ? { usd: event.usd } : {}),
        })
        return
      case 'context':
        // 裁剪也进档案：事后看"模型为什么忘了前面那几步"，答案就在这里——
        // 那些轮次根本没发出去（不是模型没看）
        this.messages.push({
          id: this.nextId++,
          role: 'assistant',
          text:
            `[CONTEXT] request trimmed (${event.regime}): ${event.droppedTurns} earlier turn(s)` +
            `${event.droppedImages > 0 ? ` and ${event.droppedImages} screenshot(s)` : ''} dropped — ${event.reason}`,
          ts: this.now(),
          note: 'context',
        })
        return
      default:
        return
    }
  }

  private recordToolResult(event: TranscriptEvent & { type: 'tool_result' }): void {
    const image = event.result.image
    const imageIds: string[] = []
    if (image !== undefined) {
      const sha256 = createHash('sha256').update(image.png).digest('hex')
      const ref = makeCaptureRef(
        image.png,
        { revision: image.revision, camera: image.camera, width: image.width, height: image.height },
        sha256,
      )
      // 内容寻址：同一张图重复出现时只记一条
      if (!this.captureEntries.some((entry) => entry.ref.id === ref.id)) {
        this.captureEntries.push({ ref, png: image.png })
      }
      imageIds.push(ref.id)
    }

    // tool 消息跟在它的 assistant 调用后面；把 `toolCallId` 对上
    const record: ChatMessageRecord = {
      id: this.nextId++,
      role: 'tool',
      text: event.result.summary,
      ts: this.now(),
      toolCallId: event.id,
      toolName: event.name,
      ok: event.result.ok,
      ...(imageIds.length > 0 ? { imageIds } : {}),
    }
    this.messages.push(record)
    // 回填 messageId，界面就能从截图反查到消息
    for (const entry of this.captureEntries) {
      if (imageIds.includes(entry.ref.id) && entry.ref.messageId === undefined) entry.ref.messageId = record.id
    }
  }

  get recording(): TranscriptRecording {
    return {
      transcript: { sessions: [this.session], messages: this.messages.map((message) => ({ ...message })) },
      captures: buildCaptureBundle(this.captureEntries),
    }
  }

  get messageCount(): number {
    return this.messages.length
  }

  get captureCount(): number {
    return this.captureEntries.length
  }
}
