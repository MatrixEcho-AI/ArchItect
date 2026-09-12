/**
 * **上下文预算策略**（plan §9.2 的两套 regime）。
 *
 * 这是整个项目最容易失控的地方，而"怎么省"取决于**这个 provider 的计费方式**，
 * 不能一刀切。所以这里只做两件事：**判断走哪一套**，以及**按那一套把请求视图裁出来**。
 *
 * | | Regime A：`append` | Regime B：`windowed` |
 * |---|---|---|
 * | 适用 | 有前缀缓存（DeepSeek 默认路径） | 无缓存 / 上下文很小（本地模型） |
 * | 历史 | 只追加、永不修改 | 只保留最近 K 轮，旧的丢掉 |
 * | 图像 | 不剪 | 最多留最近 M 张 |
 *
 * **为什么有缓存时"剪掉旧图省钱"是错的**：前缀缓存按逐字节前缀匹配。剪掉一张
 * 369 token 的旧图省下约 `369 × $0.14/1M ≈ $0.00005`，但它后面 100k token 的缓存
 * 全部作废、要以全价重算，约 `$0.014`——**少三个数量级**。所以省钱点在"加进来之前
 * 拦住重复图"（内容寻址去重，在 `loop.ts` 里），而不是"加进来之后再剪掉"。
 *
 * 反过来，**没有缓存时剪了就是净赚**：那些 token 每个请求都要全价重付一遍。
 *
 * 两套都要实现，但**不能同时开**——同时开就是"一边付缓存的钱一边把缓存打掉"。
 */

import type { PromptCacheMode } from './providers/config.js'
import type { LlmMessage } from './types.js'

export type ContextRegime = 'append' | 'windowed'

export interface ContextPolicy {
  regime: ContextRegime
  /** `windowed`：保留最近几轮（一轮 = 一次 LLM 调用 + 它请求的全部工具）。 */
  keepTurns: number
  /** `windowed`：最多保留最近几张图。 */
  keepImages: number
  /**
   * 一条工具结果进对话前的字符上限（见 `formatToolResult`）。
   *
   * 两套 regime 给的数**不一样**，这正是它属于策略而不是常量的原因：
   * A 有大窗口与缓存，一条 1 万字的 `slice` 只是钱的问题；B 的窗口可能只有 8K token，
   * 一条结果就能把整轮挤掉。所以 B 卡得更紧，宁可让模型"缩小范围再问一次"。
   */
  toolResultChars: number
  /** 为什么这么选。界面与日志都拿它解释行为，不要只说"策略生效了"。 */
  reason: string
}

/** 一条工具结果的默认上限（Regime A）。约 3K token。 */
export const DEFAULT_TOOL_RESULT_CHARS = 12_000
/** Regime B 的上限：小窗口下一条结果不能吃掉整轮。约 1K token。 */
export const WINDOWED_TOOL_RESULT_CHARS = 4_000

/** 判定"上下文小"的门槛。低于它放不下几十轮对话 + 几十张图。 */
const SMALL_CONTEXT_WINDOW = 100_000

/** plan §9.2 给的默认值。 */
const DEFAULT_KEEP_TURNS = 6
const DEFAULT_KEEP_IMAGES = 3

/** 有缓存就走 A：不做任何裁剪。 */
export function appendPolicy(
  reason = 'The provider caches prefixes, so trimming would re-bill every later token at full price',
): ContextPolicy {
  return {
    regime: 'append',
    keepTurns: Number.POSITIVE_INFINITY,
    keepImages: Number.POSITIVE_INFINITY,
    toolResultChars: DEFAULT_TOOL_RESULT_CHARS,
    reason,
  }
}

/**
 * 按 provider 声明的能力决定策略。
 *
 * 忘了传能力时走 A（不裁剪）——这是**保守**的选择：宁可多花钱，也不要在未知的
 * provider 上悄悄丢历史。探针会写回真实能力，所以正常路径不会走到这个分支。
 */
export function contextPolicyFor(
  capabilities?: { promptCache: PromptCacheMode; contextWindow?: number },
  overrides: { keepTurns?: number; keepImages?: number } = {},
): ContextPolicy {
  if (capabilities === undefined) return appendPolicy('No provider capability information is available, so nothing is trimmed')
  if (capabilities.promptCache === 'none') {
    return {
      regime: 'windowed',
      keepTurns: overrides.keepTurns ?? DEFAULT_KEEP_TURNS,
      keepImages: overrides.keepImages ?? DEFAULT_KEEP_IMAGES,
      toolResultChars: WINDOWED_TOOL_RESULT_CHARS,
      reason: 'The provider does not cache prefixes, so old tokens are re-billed at full price on every request',
    }
  }
  const window = capabilities.contextWindow
  if (window !== undefined && window < SMALL_CONTEXT_WINDOW) {
    return {
      regime: 'windowed',
      keepTurns: overrides.keepTurns ?? DEFAULT_KEEP_TURNS,
      keepImages: overrides.keepImages ?? DEFAULT_KEEP_IMAGES,
      toolResultChars: WINDOWED_TOOL_RESULT_CHARS,
      reason: `The context window is only ${window} tokens, so the request only fits after trimming`,
    }
  }
  return appendPolicy()
}

/** 一次裁剪的结果。 */
export interface WindowResult {
  /**
   * **只用于这一次请求**的消息视图。
   *
   * 调用方那份历史数组仍然是只追加的那一份：窗口是对"请求视图"的变换，
   * 不是对历史的修改。混起来的话，Regime B 的裁剪会污染 `state.messages`
   * （对话档案、`.mcai` 的对话记录都读它），把用户的档案也剪了。
   */
  messages: LlmMessage[]
  droppedTurns: number
  droppedImages: number
  /** 塞在历史头部之后的占位说明（没有东西被丢时是 `undefined`）。 */
  stub?: string
}

/**
 * 把消息数组切成"头 + 若干轮"。
 *
 * 头 = 第一条 assistant 之前的全部内容（状态行 + 目标）。**它必须一直留着**：
 * 状态行是模型知道自己面对哪个版本、哪个工区的唯一依据。
 *
 * 一"轮"从一条 assistant 消息开始，到下一个 assistant 之前结束。工具消息必须跟着
 * 它所属的那条 assistant 一起被保留或丢弃——只留 `tool` 不留 `assistant` 会产生
 * 一个 **API 层面就非法**的请求（`tool` 消息必须能对应到某条 assistant 的 tool_calls）。
 */
export function splitTurns(messages: readonly LlmMessage[]): { head: LlmMessage[]; turns: LlmMessage[][] } {
  const head: LlmMessage[] = []
  const turns: LlmMessage[][] = []
  let current: LlmMessage[] | undefined
  for (const message of messages) {
    if (message.role === 'assistant') {
      current = [message]
      turns.push(current)
      continue
    }
    if (current === undefined) head.push(message)
    else current.push(message)
  }
  return { head, turns }
}

/**
 * 按策略把请求视图裁出来。
 *
 * `append` 时原样返回（Regime A：一个字节都不动，缓存才稳）。
 */
export function windowMessages(messages: readonly LlmMessage[], policy: ContextPolicy): WindowResult {
  if (policy.regime === 'append') {
    return { messages: [...messages], droppedTurns: 0, droppedImages: 0 }
  }

  const { head, turns } = splitTurns(messages)
  const keepFrom = Math.max(0, turns.length - policy.keepTurns)
  const keptTurns = turns.slice(keepFrom)
  const droppedTurns = keepFrom

  // 图像从**最新往回**数：模型最需要的是"我刚改完的样子"，不是十轮前的样子。
  // 所以两层循环**都**要倒着走——只倒一层的话，预算会先花在最旧的那一轮上
  // （这个 bug 真写过一次，被"留下的应当是 img3-*"那条断言抓住）。
  let imageBudget = policy.keepImages
  let droppedImages = 0
  const prunedTurns: LlmMessage[][] = new Array<LlmMessage[]>(keptTurns.length)
  for (let t = keptTurns.length - 1; t >= 0; t--) {
    const turn = keptTurns[t]!
    const pruned: LlmMessage[] = [...turn]
    for (let i = turn.length - 1; i >= 0; i--) {
      const message = turn[i]!
      const images = message.images
      if (images === undefined || images.length === 0) continue
      const keep = Math.max(0, Math.min(images.length, imageBudget))
      imageBudget -= keep
      if (keep === images.length) continue
      droppedImages += images.length - keep
      // 丢掉图**但留下那句话**：位置与轮次关系不变，模型仍然知道"这里当时截过图"，
      // 需要的话可以重新截一张（比让它以为这轮什么都没发生要好）
      const { images: _dropped, ...rest } = message
      pruned[i] = {
        ...rest,
        content: `${message.content}${message.content.length > 0 ? ' ' : ''}(${images.length - keep} screenshot(s) omitted to save context)`,
      }
    }
    prunedTurns[t] = pruned
  }

  const stub =
    droppedTurns > 0
      ? `[CONTEXT] ${droppedTurns} earlier turn(s) omitted to fit this model's context window` +
        `${droppedImages > 0 ? `, plus ${droppedImages} screenshot(s)` : ''}. ` +
        `Your own memory of them is gone — re-check anything you need with slice / measure / screenshot ` +
        `instead of assuming. The full history is still in the transcript.`
      : undefined

  return {
    messages: [...head, ...(stub !== undefined ? [{ role: 'user' as const, content: stub }] : []), ...prunedTurns.flat()],
    droppedTurns,
    droppedImages,
    ...(stub !== undefined ? { stub } : {}),
  }
}
