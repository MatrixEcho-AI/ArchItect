import { createHash } from 'node:crypto'

import { t } from '@architect/i18n'
import type { ToolContext, ToolRegistry, ToolResult } from '@architect/tools'

import { LlmError } from './types.js'
import type { LlmDelta, LlmImage, LlmMessage, LlmProvider, LlmUsage } from './types.js'
import { contextPolicyFor, DEFAULT_TOOL_RESULT_CHARS, windowMessages } from './context.js'
import type { ContextPolicy } from './context.js'
import { checkBudget, costOf } from './usage.js'
import type { Budget } from './usage.js'
import type { CostTable } from './providers/config.js'

export type StopReason =
  | 'completed'
  | 'max_turns'
  | 'max_tool_calls'
  | 'max_tokens'
  /** 触到用户设的花费/预算上限——**主动刹车，不是故障**。 */
  | 'budget'
  | 'stopped'
  /** 改了东西却始终不肯调 verify 读回——**不算完成**。 */
  | 'unverified'
  /** 模型返回了空回复（既没正文也没工具调用）——**不算完成**。 */
  | 'empty'
  | 'error'

export interface AgentState {
  turn: number
  toolCalls: number
  usage: Required<LlmUsage>
  messages: LlmMessage[]
  stopReason: StopReason
  error?: string
  /** 最后一轮的文本回复。 */
  finalText: string
  /** 结束时还没读回的改动数。调用方下一轮要把它带回来（见 `AgentOptions.pendingMutations`）。 */
  pendingMutations: number
}

export type AgentEvent =
  | { type: 'turn'; turn: number }
  | { type: 'assistant'; turn: number; text: string }
  /**
   * 这一轮正文（或思维链）的**一小片**，随字节到达即发。
   *
   * 它是**视图事件**，不是历史：`assistant` 才是收口的那一条（完整、权威）。
   * 界面拿它逐字输出；档案不录它（`.mcai` 只存成型的消息，见 `TranscriptEvent`）。
   * 重试时这一轮的碎片**作废**——重试会从头再吐一遍，所以先发的 `retry` 事件
   * 就是"把刚才那些碎片丢掉"的信号。
   */
  | { type: 'assistant_delta'; turn: number; text: string; reasoning: string }
  | { type: 'tool_call'; turn: number; id: string; name: string; args: unknown }
  | { type: 'tool_result'; turn: number; id: string; name: string; result: ToolResult }
  | { type: 'images'; turn: number; count: number; bytes: number }
  | { type: 'retry'; attempt: number; reason: string }
  /** 输出撞上了 token 上限。`toolCalls` 为 0 表示这一轮**什么都没产出**。 */
  | { type: 'truncated'; turn: number; out: number; toolCalls: number }
  /** 预算触顶：带上原因与累计用量，界面据此解释为什么停下来。 */
  | { type: 'budget'; reason: 'usd' | 'tokens' | 'turns'; detail: string; usage: Required<LlmUsage>; usd?: number }
  /** 完成闸门拒绝了模型的"我做完了"，要求它先读回。 */
  | { type: 'nudge'; reason: string; pendingMutations: number }
  /**
   * 这一轮发出去的请求**裁过**（Regime B）。
   *
   * 只在真的丢了东西时发：没丢也发的话，事件流里会塞满"什么都没发生"。
   */
  | { type: 'context'; regime: ContextPolicy['regime']; droppedTurns: number; droppedImages: number; reason: string }
  | { type: 'stop'; reason: StopReason }

export interface AgentOptions {
  provider: LlmProvider
  registry: ToolRegistry
  ctx: ToolContext
  system: string
  /**
   * volatile 状态行（`AgentSession.buildStateLine()`）。
   *
   * 按 §9.2 它必须是**历史里的第一条 user 消息**而不是 system 前缀的一部分：
   * revision 每轮都变，放进前缀会把整段缓存打掉；而放在历史开头，
   * 后面所有内容仍然共享同一个稳定前缀。
   */
  stateLine?: string
  /**
   * **接续上一轮**：上一次 `runAgent` 留下的消息（`AgentState.messages`）。
   *
   * 桌面端一次 `send` 就是一次 `runAgent`。不把上一轮接上的话，模型对
   * "刚才那几句"毫无记忆——它只看得到 system + 一行 `[STATE]` + 这一句新需求，
   * 于是"接续提问"变成了对着一个陌生工地重新开工。
   *
   * 接法是**追加**：历史在下，新的状态行与本次需求在上。
   * 这样前缀逐字节不变，DeepSeek 的前缀缓存才能跨轮命中——
   * 在中间插一句/改一句，后面十几万 token 就要按全价重算（§9.2 Regime A）。
   */
  history?: readonly LlmMessage[]
  /**
   * 上一轮结束时**还没读回**的改动数（完成闸门的状态）。
   *
   * 跨轮必须带着走：不然"A 轮改完没 verify 就收工、B 轮说一句好话"就能把闸门绕过去，
   * 而闸门的全部意义就是不让"没读回"被当成"做完了"。
   */
  pendingMutations?: number
  /** 最多几轮（一轮 = 一次 LLM 调用 + 它请求的全部工具）。默认 40。 */
  maxTurns?: number
  /** 最多执行几次工具调用。默认 120——防止 LLM 陷入死循环。 */
  maxToolCalls?: number
  /** 累计输出 token 上限。 */
  maxTokens?: number
  /**
   * **花费预算**。触顶即停，停止原因是 `budget`。
   *
   * 与 `maxTurns` / `maxToolCalls` 的差别在于它是**用户的钱**，不是 harness 的防呆：
   * 界面里填了 `$2` 就必须真的在 $2 停下来。只记账不刹车比不记账更糟——
   * 用户会以为自己被保护着。
   *
   * `maxUsd` 需要 `costTable`；没有价格表时**不算通过**（见 `checkBudget`），
   * 因为"设了上限其实没生效"是这里最坏的失败模式。
   */
  budget?: Budget
  costTable?: CostTable
  maxTokensPerCall?: number
  temperature?: number
  onEvent?: (event: AgentEvent) => void
  /** 可选的提前停止判据（UI 的"停止"按钮）。 */
  shouldStop?: () => boolean
  /**
   * **完成闸门**：改过东西之后，必须有一次成功的**结构化读回**才能结束。默认 `true`。
   * 读回由工具结果里的 `data.readback === true` 声明（`verify` 全部通过、
   * `analyze_structure` 无 error 级问题时都会置真）。
   *
   * 这条在 harness 层强制，而不是写在 prompt 里求模型自觉——plan §9.3 的
   * "声称完成前必须全部通过"如果是软约束，长会话里会稳定退化成"我说完了就完了"。
   */
  requireVerification?: boolean
  /** 闸门最多提醒几次，超过就以 `unverified` 结束。默认 2。 */
  maxNudges?: number
  /**
   * provider 声明的能力。**决定走哪套上下文策略**（plan §9.2）。
   *
   * 省略时按"有缓存、不裁剪"处理——宁可多花钱，也不要在未知的 provider 上
   * 悄悄丢掉历史。探针会写回真实能力，所以正常路径不会省略。
   */
  capabilities?: { promptCache: 'auto' | 'explicit' | 'none'; contextWindow?: number }
  /** 覆盖窗口参数（默认 K=6 轮 / M=3 图）。只对 `windowed` 有意义。 */
  contextWindow?: { keepTurns?: number; keepImages?: number }
  /**
   * **用户随这句话一起给的图**（桌面端"插入图片"与"采集视口"两个入口）。
   *
   * 挂在本次需求那条 user 消息上，与 `goal` 一起构成这一轮的最新输入。
   * 与工具截图**分开**：那些是模型自己看回来的，这些是人给的，两者的语义与
   * 生命周期都不同（人的图不会被 `retainHistory` 当成过期截图剪掉）。
   */
  images?: readonly LlmImage[]
}

const UNVERIFIED_NUDGE =
  '[GATE] You have made changes since your last passing verify() and have not read them back.\n' +
  'Do NOT claim completion yet. Call verify() with explicit expectations for what you just built ' +
  '(existence of key features and their coordinates), and take a screenshot if you have not. ' +
  'If verify reports failures, fix them and verify again.'

/**
 * 输出被 token 上限截断时的提醒。
 *
 * 截断几乎总是**思考模型的思维链太长**——额度烧在 `reasoning_content` 上，
 * 正文是空的、一个工具都没调。重试一次并明确要求"短思考、立刻动手"，
 * 比直接把这次请求的钱扔掉有用得多。
 */
const TRUNCATED_NUDGE =
  '[GATE] Your previous response was cut off by the output token limit before you called any tool. ' +
  'Your reasoning was too long. Do not restate your plan. Be terse and act now: ' +
  'call the tools that make progress, one or a few at a time.'

const DEFAULT_MAX_TURNS = 40
const DEFAULT_MAX_TOOL_CALLS = 120
const MAX_RETRIES = 3
/** 一个回合里最多因为截断续几次。超过就停，别把钱倒进一个填不满的洞。 */
const MAX_TRUNCATION_CONTINUATIONS = 2

/**
 * Agent 主循环。
 *
 * 三条硬约束写在实现里而不是 prompt 里：
 * 1. **消息数组只 push、不 splice**（plan §9.2 Regime A）——回头改历史会让前缀缓存
 *    整段失效，而缓存读比全价便宜 50 倍。
 * 2. **工具异常不逃逸**：`registry.call` 永远返回结果，循环不会因为一个坏工具就崩。
 * 3. **预算三重上限**（轮数 / 工具调用数 / token）——任一触顶即停，并如实报告原因。
 */
export async function runAgent(options: AgentOptions, goal: string): Promise<AgentState> {
  const {
    provider,
    registry,
    ctx,
    system,
    maxTurns = DEFAULT_MAX_TURNS,
    maxToolCalls = DEFAULT_MAX_TOOL_CALLS,
  } = options

  const requireVerification = options.requireVerification !== false
  const maxNudges = options.maxNudges ?? 2
  // 走哪套上下文策略**在循环开始前就定死**：中途换策略会让"这次请求为什么短了"
  // 变得无法解释（而且两套的假设互相冲突）。
  const policy = contextPolicyFor(options.capabilities, options.contextWindow ?? {})

  const messages: LlmMessage[] = []
  // **先接上上一轮**（有的话）。顺序是刻意的：历史 → 状态行 → 本次需求。
  // 状态行放在历史**之后**：它每轮都变（revision），放在前面会把后面的缓存全部作废。
  if (options.history !== undefined) {
    for (const message of options.history) messages.push(message)
  }
  // 状态行在历史里**只出现一次**，且在最前面。之后每轮的 revision 变化由工具结果
  // 自己带（`writeResultToTool` 每次都回显 revision），不需要再插一条新消息——
  // 插一条就是在历史中间动刀，会让它后面的前缀缓存全部失效。
  if (options.stateLine !== undefined && options.stateLine.length > 0) {
    messages.push({ role: 'user', content: options.stateLine })
  }
  messages.push({
    role: 'user',
    content: goal,
    ...(options.images !== undefined && options.images.length > 0 ? { images: [...options.images] } : {}),
  })
  const tools = registry.toToolSchemas()
  const usage: Required<LlmUsage> = { in: 0, out: 0, cachedIn: 0 }
  const seenImages = new Set<string>()

  const state: AgentState = {
    turn: 0,
    toolCalls: 0,
    usage,
    messages,
    stopReason: 'max_turns',
    finalText: '',
    pendingMutations: options.pendingMutations ?? 0,
  }
  const emit = (event: AgentEvent): void => options.onEvent?.(event)

  // 完成闸门的状态：改过东西之后必须重新 verify 通过。
  // 初值可能来自上一轮（跨轮延续），所以这里不是从 0 开始。
  let pendingMutations = state.pendingMutations
  let nudges = 0
  let continuations = 0

  for (let turn = 0; turn < maxTurns; turn++) {
    state.turn = turn + 1
    emit({ type: 'turn', turn: state.turn })

    if (options.shouldStop?.() === true) {
      state.stopReason = 'stopped'
      break
    }

    let response
    try {
      // **请求视图 ≠ 历史**：Regime B 只裁这一次发出去的东西，
      // `messages` 本身仍然只追加（对话档案与 `.mcai` 读的是它）。
      const view = windowMessages(messages, policy)
      if (view.droppedTurns > 0 || view.droppedImages > 0) {
        emit({
          type: 'context',
          regime: policy.regime,
          droppedTurns: view.droppedTurns,
          droppedImages: view.droppedImages,
          reason: policy.reason,
        })
      }
      // 每次重试都**重新构建**请求（Regime B 的窗口是纯函数，重建结果一样）
      response = await chatWithRetry(
        provider,
        () => ({
          system,
          messages: windowMessages(messages, policy).messages,
          tools,
          ...(options.maxTokensPerCall !== undefined ? { maxTokens: options.maxTokensPerCall } : {}),
          ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
        }),
        emit,
        // 片段原样往上抛：谁在听（CLI / 桌面端）自己决定要不要画出来
        (delta) => {
          if ((delta.text?.length ?? 0) === 0 && (delta.reasoning?.length ?? 0) === 0) return
          emit({
            type: 'assistant_delta',
            turn: state.turn,
            text: delta.text ?? '',
            reasoning: delta.reasoning ?? '',
          })
        },
      )
    } catch (error) {
      state.stopReason = 'error'
      state.error = error instanceof Error ? error.message : String(error)
      state.pendingMutations = pendingMutations
      emit({ type: 'stop', reason: 'error' })
      return state
    }

    usage.in += response.usage.in
    usage.out += response.usage.out
    usage.cachedIn += response.usage.cachedIn ?? 0

    if (options.maxTokens !== undefined && usage.out >= options.maxTokens) {
      state.finalText = response.text
      state.stopReason = 'max_tokens'
      break
    }

    // **花费预算在这里刹车。** 放在用量累加之后、处理工具调用之前——
    // 已经花掉的钱收不回来，但下一步的请求可以不发出去。
    if (options.budget !== undefined) {
      const verdict = checkBudget(
        {
          in: usage.in,
          out: usage.out,
          cachedIn: usage.cachedIn,
          turns: state.turn,
          toolCalls: state.toolCalls,
          screenshots: 0,
        },
        options.budget,
        options.costTable,
      )
      if (!verdict.ok) {
        const usd = costOf(usage, options.costTable)
        state.finalText = response.text
        state.stopReason = 'budget'
        state.error = verdict.detail
        emit({
          type: 'budget',
          reason: verdict.reason,
          detail: verdict.detail,
          usage: { ...usage },
          ...(usd !== undefined ? { usd } : {}),
        })
        break
      }
    }

    // ── 输出被 token 上限截断：**绝不能当成"说完了"** ──────────────────────────
    //
    // 思考模型会把输出额度先烧在 `reasoning_content` 上，然后以 `finish_reason: 'length'`
    // 收场：正文空、工具调用零。早先这里直接落进下面那条"没有工具调用 = 完成"的分支，
    // 于是 CLI 打印"结束原因：completed"、产出一个 0 方块的工程——**静默失败**，
    // 而且钱已经花了。真机上就是这么翻的车（`max_tokens: 8192` + 6k token 思维链）。
    //
    // 处理原则：能续就续，续不动就**如实**以 `max_tokens` 停下并说明原因。
    if (response.finishReason === 'length') {
      emit({
        type: 'truncated',
        turn: state.turn,
        out: response.usage.out,
        toolCalls: response.toolCalls.length,
      })
      if (response.toolCalls.length === 0) {
        if (continuations < MAX_TRUNCATION_CONTINUATIONS) {
          continuations++
          // **空正文 + 没有 tool_calls 的 assistant 消息是非法的**：API 直接回
          // 400 `Invalid assistant message: content or tool_calls must be set`。
          // 截断恰恰最常产出这种消息（额度全烧在思维链上，正文空），所以只有
          // 真有正文时才回灌它；否则就只发收敛提示，让模型重新开口。
          // 此时那一轮的思维链也**不该**回传——它没有对应的 assistant 消息可挂。
          if (response.text.length > 0) {
            const partial: LlmMessage = { role: 'assistant', content: response.text }
            if (response.reasoningContent !== undefined) partial.reasoningContent = response.reasoningContent
            messages.push(partial)
          }
          messages.push({ role: 'user', content: TRUNCATED_NUDGE })
          continue
        }
        state.finalText = response.text
        state.stopReason = 'max_tokens'
        state.error = t('agent.loop.truncated', { out: response.usage.out })
        break
      }
      // 有工具调用说明截断发生在"打算继续"的位置，这一轮的工具照常执行
    } else {
      continuations = 0
    }

    // 没有工具调用 = 模型认为说完了
    if (response.toolCalls.length === 0) {
      // **空正文 + 没有 tool_calls 的 assistant 消息不能进历史**：API 会回
      // 400 `Invalid assistant message: content or tool_calls must be set`。
      // 而且一条空回复本来也不是"说完了"——它是**卡住了**，下面按卡住处理。
      if (response.text.length > 0) {
        const message: LlmMessage = { role: 'assistant', content: response.text }
        if (response.reasoningContent !== undefined) message.reasoningContent = response.reasoningContent
        messages.push(message)
        emit({ type: 'assistant', turn: state.turn, text: response.text })
      }

      // 完成闸门：改了却没读回，不接受"完成"
      if (requireVerification && pendingMutations > 0) {
        if (nudges < maxNudges) {
          nudges++
          emit({ type: 'nudge', reason: 'unverified mutations', pendingMutations })
          messages.push({ role: 'user', content: UNVERIFIED_NUDGE })
          continue
        }
        state.finalText = response.text
        state.stopReason = 'unverified'
        break
      }

      state.finalText = response.text
      // 空回复**不是完成**。报成 completed 就是在骗人：用户会看到一个 0 方块的
      // 工程和一句"结束原因：completed"，然后不知道该去查什么。
      state.stopReason = response.text.length > 0 ? 'completed' : 'empty'
      if (state.stopReason === 'empty') state.error = t('agent.loop.empty')
      break
    }

    const assistantMessage: LlmMessage = {
      role: 'assistant',
      content: response.text,
      toolCalls: response.toolCalls,
    }
    if (response.reasoningContent !== undefined) {
      assistantMessage.reasoningContent = response.reasoningContent
    }
    messages.push(assistantMessage)
    if (response.text.length > 0) {
      emit({ type: 'assistant', turn: state.turn, text: response.text })
    }

    // 执行本轮的全部工具调用
    const images: LlmImage[] = []
    for (const call of response.toolCalls) {
      state.toolCalls++
      if (state.toolCalls > maxToolCalls) {
        state.stopReason = 'max_tool_calls'
        break
      }
      emit({ type: 'tool_call', turn: state.turn, id: call.id, name: call.name, args: call.args })

      const result = await registry.call(ctx, call.name, call.args)
      // 进对话的那段文本**先算出来**，事件里也发同一份：档案与界面看到的应当就是
      // 模型看到的那份。否则"模型为什么漏看了后半截"在档案里查不出来——
      // 截断标记只出现在发出去的请求里，而归档的是没截断的原文（D-67 同一个道理）。
      const content = formatToolResult(result, policy.toolResultChars)
      emit({
        type: 'tool_result',
        turn: state.turn,
        id: call.id,
        name: call.name,
        result: content === result.summary ? result : { ...result, summary: content },
      })

      // 闸门记账：修改类工具让"待验证"累加；一次**成功的结构化读回**清零。
      //
      // 判据是工具自己声明的 `data.readback`，而不是把工具名写死在这里——
      // `verify` 全部 claim 通过时、`analyze_structure` 没有 error 级问题时都会把它置真。
      // 这样"什么算读回"由工具定义，循环不需要认识任何一个具体工具名。
      if (registry.get(call.name)?.mutating === true && result.ok) pendingMutations++
      if (result.ok && result.data?.['readback'] === true) pendingMutations = 0

      messages.push({ role: 'tool', toolCallId: call.id, content })

      if (result.image !== undefined) {
        const id = hashPng(result.image.png)
        // 同一张图不重复进上下文（plan §7.3 内容寻址去重）
        if (!seenImages.has(id)) {
          seenImages.add(id)
          images.push({ png: result.image.png, mimeType: 'image/png', id })
        }
      }
    }

    // 截图必须以**独立的 user 消息**回灌：OpenAI 的 tool 消息只接受文本
    if (images.length > 0) {
      messages.push({
        role: 'user',
        content: `Attached image(s) from tool result (revision ${ctx.store.revision}):`,
        images,
      })
      emit({
        type: 'images',
        turn: state.turn,
        count: images.length,
        bytes: images.reduce((sum, image) => sum + image.png.length, 0),
      })
    }

    if (state.stopReason === 'max_tool_calls') break
  }

  state.pendingMutations = pendingMutations
  emit({ type: 'stop', reason: state.stopReason })
  return state
}

async function chatWithRetry(
  provider: LlmProvider,
  buildRequest: () => Parameters<LlmProvider['chat']>[0],
  emit: (event: AgentEvent) => void,
  onDelta?: (delta: LlmDelta) => void,
): Promise<Awaited<ReturnType<LlmProvider['chat']>>> {
  let lastError: unknown
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      return await provider.chat(buildRequest(), onDelta)
    } catch (error) {
      lastError = error
      const retryable = error instanceof LlmError ? error.retryable : true
      if (!retryable || attempt === MAX_RETRIES) break
      const reason = error instanceof Error ? error.message : String(error)
      emit({ type: 'retry', attempt, reason })
      await delay(2 ** attempt * 250)
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError))
}

/** 工具结果转成回灌给 LLM 的文本。**失败也要带足自纠信息**。 */
export function formatToolResult(result: ToolResult, maxChars = DEFAULT_TOOL_RESULT_CHARS): string {
  const text = result.ok
    ? result.summary
    : `ERROR [${result.error?.code ?? 'ERROR'}] ${result.summary}` +
      `${result.error?.hint !== undefined ? `\nHINT: ${result.error.hint}` : ''}`
  return capToolResult(text, maxChars)
}

/**
 * 工具结果的**硬上限**：超了就截断，并**明说截断了多少**。
 *
 * 为什么要有这一层（而不是只靠每个工具自己设 limit）：
 *
 * - 有的参数是**模型给的**（`search_blocks` 的 `limit`、`slice` 的 `maxCells`），
 *   模型完全可能填一个把结果撑到几十 KB 的数；
 * - 以后新加的工具不会自动记得这件事，而"一条结果吃掉整个上下文"在 Regime B
 *   （8K 窗口）上是致命的——那一轮剩下的空间连工具描述都放不下。
 *
 * 截断标记必须写清楚"少了多少"，否则模型会以为那就是全部内容，然后在缺数据的基础上
 * 下结论——那比直接报错更糟。切在**行边界**上：半行 JSON/表格比少几行更难读。
 */
function capToolResult(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text
  const clipped = text.slice(0, maxChars)
  const boundary = clipped.lastIndexOf('\n')
  const kept = boundary > maxChars * 0.5 ? clipped.slice(0, boundary) : clipped
  const dropped = text.length - kept.length
  return `${kept}\n[... truncated ${dropped} characters; narrow the query or ask for a smaller region]`
}

function hashPng(png: Uint8Array): string {
  return createHash('sha256').update(png).digest('hex').slice(0, 16)
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
