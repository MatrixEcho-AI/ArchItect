/**
 * 上下文预算策略（plan §9.2）。
 *
 * 这里要钉死两件事：
 *
 * 1. **判断本身**：有前缀缓存就不裁剪，没有缓存（或窗口很小）就切滑动窗口。
 *    选错的代价是双向的——有缓存时裁剪会把后面几十万 token 的缓存打掉（贵三个数量级），
 *    没缓存时不裁剪则每个请求都全价重付一遍。
 * 2. **裁出来的请求视图仍然是合法的**：`tool` 消息必须跟着它所属的那条 assistant
 *    一起留下或一起丢掉。只留下 `tool` 会得到一个 **API 层面就非法**的请求，
 *    而那种错误在真机上表现为一个莫名其妙的 400。
 */

import { describe, expect, it } from 'vitest'

import {
  appendPolicy,
  contextPolicyFor,
  DEFAULT_TOOL_RESULT_CHARS,
  splitTurns,
  WINDOWED_TOOL_RESULT_CHARS,
  windowMessages,
} from '../src/context.js'
import type { ContextPolicy } from '../src/context.js'
import { formatToolResult, runAgent } from '../src/loop.js'
import type { AgentEvent } from '../src/loop.js'
import { ScriptedProvider } from '../src/providers/scripted.js'
import { AgentSession } from '../src/session.js'
import type { LlmMessage, LlmProvider } from '../src/types.js'

const VOLUME = { min: { x: 0, y: 0, z: 0 }, max: { x: 15, y: 15, z: 15 } }

const policy = (overrides: Partial<ContextPolicy> = {}): ContextPolicy => ({
  regime: 'windowed',
  keepTurns: 2,
  keepImages: 1,
  toolResultChars: 4_000,
  reason: 'test',
  ...overrides,
})

/** 一轮 = assistant(tool_calls) + tool 结果 + 可选的贴图消息。 */
function turn(n: number, images = 0): LlmMessage[] {
  const messages: LlmMessage[] = [
    { role: 'assistant', content: `plan ${n}`, toolCalls: [{ id: `c${n}`, name: 'measure', args: {} }] },
    { role: 'tool', content: `result ${n}`, toolCallId: `c${n}` },
  ]
  if (images > 0) {
    messages.push({
      role: 'user',
      content: `Attached image(s) (revision ${n})`,
      images: Array.from({ length: images }, (_, i) => ({ png: new Uint8Array([1]), mimeType: 'image/png', id: `img${n}-${i}` })),
    })
  }
  return messages
}

const history = (turns: number, imagesPerTurn = 0): LlmMessage[] => [
  { role: 'user', content: '[STATE] revision=0 blocks=0' },
  { role: 'user', content: 'build a lighthouse' },
  ...Array.from({ length: turns }, (_, i) => turn(i + 1, imagesPerTurn)).flat(),
]

describe('上下文策略：选哪一套', () => {
  it('有前缀缓存 → 不裁剪（剪了反而更贵）', () => {
    expect(contextPolicyFor({ promptCache: 'auto', contextWindow: 1_000_000 }).regime).toBe('append')
    expect(contextPolicyFor({ promptCache: 'explicit' }).regime).toBe('append')
  })

  it('没有前缀缓存 → 滑动窗口（旧 token 每个请求都要全价重付）', () => {
    const chosen = contextPolicyFor({ promptCache: 'none' })
    expect(chosen.regime).toBe('windowed')
    expect(chosen.keepTurns).toBe(6)
    expect(chosen.keepImages).toBe(3)
    expect(chosen.reason).toContain('缓存')
  })

  it('**窗口很小 → 也必须裁剪**（否则请求直接放不下，跟缓存无关了）', () => {
    const chosen = contextPolicyFor({ promptCache: 'auto', contextWindow: 8192 })
    expect(chosen.regime).toBe('windowed')
    expect(chosen.reason).toContain('8192')
  })

  it('能力未知 → 不裁剪（宁可多花钱，也不要在未知 provider 上悄悄丢历史）', () => {
    expect(contextPolicyFor(undefined).regime).toBe('append')
    expect(appendPolicy().keepTurns).toBe(Number.POSITIVE_INFINITY)
  })

  it('窗口参数可以覆盖，但不会改变"选哪套"', () => {
    const chosen = contextPolicyFor({ promptCache: 'none' }, { keepTurns: 2, keepImages: 1 })
    expect(chosen.regime).toBe('windowed')
    expect(chosen.keepTurns).toBe(2)
    expect(chosen.keepImages).toBe(1)
  })
})

describe('上下文窗口：切轮', () => {
  it('头的定义是"第一条 assistant 之前"，状态行与目标都在里面', () => {
    const { head, turns } = splitTurns(history(3, 1))
    expect(head.map((message) => message.content)).toEqual(['[STATE] revision=0 blocks=0', 'build a lighthouse'])
    expect(turns).toHaveLength(3)
    // 每轮都完整：assistant + tool + 贴图
    for (const one of turns) expect(one[0]!.role).toBe('assistant')
  })
})

describe('上下文窗口：裁剪', () => {
  it('`append` 一个字节都不动', () => {
    const messages = history(10, 2)
    const result = windowMessages(messages, appendPolicy())
    expect(result.messages).toEqual(messages)
    expect(result.droppedTurns).toBe(0)
    expect(result.droppedImages).toBe(0)
  })

  it('保留最近 K 轮，头一直在，并在头后面插一句说明', () => {
    const result = windowMessages(history(5), policy({ keepTurns: 2, keepImages: 0 }))
    expect(result.droppedTurns).toBe(3)
    expect(result.messages[0]!.content).toContain('[STATE]')
    expect(result.messages[1]!.content).toBe('build a lighthouse')
    expect(result.messages[2]!.content).toContain('[CONTEXT]')
    expect(result.messages[2]!.content).toContain('3 earlier turn(s)')
    // 只留下最后两轮的内容
    const kept = result.messages.map((message) => message.content).join(' ')
    expect(kept).toContain('plan 4')
    expect(kept).toContain('plan 5')
    expect(kept).not.toContain('plan 3')
  })

  it('**`tool` 消息永远跟着它的 assistant 一起走**（只留 tool 的请求是非法请求）', () => {
    const result = windowMessages(history(6), policy({ keepTurns: 3, keepImages: 0 }))
    let pending: string | undefined
    for (const message of result.messages) {
      if (message.role === 'assistant') {
        pending = message.toolCalls?.[0]?.id
        continue
      }
      if (message.role !== 'tool') continue
      expect(pending, `tool 消息 ${message.toolCallId} 找不到它的 assistant`).toBe(message.toolCallId)
    }
    // 而且每一轮的 assistant 也都在
    expect(result.messages.filter((message) => message.role === 'assistant')).toHaveLength(3)
  })

  it('图像只留最近 M 张，被剪掉的那条消息**留下那句话**并说明剪了几张', () => {
    const result = windowMessages(history(3, 2), policy({ keepTurns: 10, keepImages: 2 }))
    expect(result.droppedImages).toBe(4)
    const keptImages = result.messages.flatMap((message) => message.images ?? [])
    expect(keptImages.map((one) => one.id)).toEqual(['img3-0', 'img3-1'])
    // 前两轮的贴图消息还在（位置与轮次关系不变），只是没有图了
    const stripped = result.messages.filter((message) => message.content.includes('omitted to save context'))
    expect(stripped).toHaveLength(2)
    expect(stripped[0]!.content).toContain('2 screenshot(s) omitted')
    expect(stripped[0]!.images).toBeUndefined()
  })

  it('**动的是请求视图，不是历史**（否则会把用户的对话档案也剪了）', () => {
    const messages = history(5, 1)
    const snapshot = JSON.stringify(messages.map((message) => message.content))
    windowMessages(messages, policy({ keepTurns: 1, keepImages: 0 }))
    expect(JSON.stringify(messages.map((message) => message.content))).toBe(snapshot)
    expect(messages).toHaveLength(2 + 5 * 3)
  })

  it('没东西可丢时不插说明（每轮都塞一句"什么都没发生"是噪音）', () => {
    const result = windowMessages(history(2, 1), policy({ keepTurns: 6, keepImages: 6 }))
    expect(result.droppedTurns).toBe(0)
    expect(result.droppedImages).toBe(0)
    expect(result.stub).toBeUndefined()
    expect(result.messages.some((message) => message.content.includes('[CONTEXT]'))).toBe(false)
  })

  it('空历史与只有头的历史都不炸', () => {
    expect(windowMessages([], policy()).messages).toEqual([])
    const head = [{ role: 'user' as const, content: 'only head' }]
    expect(windowMessages(head, policy()).messages).toEqual(head)
  })
})

describe('上下文窗口：接到循环上', () => {
  /** 跑若干轮 `measure`，看 provider 实际收到了什么。 */
  async function run(
    capabilities: { promptCache: 'auto' | 'none'; contextWindow?: number } | undefined,
    turns: number,
  ): Promise<{ seen: LlmMessage[][]; events: AgentEvent[]; archived: number }> {
    const seen: LlmMessage[][] = []
    const events: AgentEvent[] = []
    const provider = new ScriptedProvider((_request, turn) =>
      turn < turns ? { toolCalls: [{ name: 'measure', args: {} }] } : { text: 'done' },
    )
    const inner = provider.chat.bind(provider)
    const spy: LlmProvider = {
      id: provider.id,
      model: provider.model,
      supportsImages: provider.supportsImages,
      chat: (request) => {
        seen.push([...request.messages])
        return inner(request)
      },
    }
    const session = new AgentSession({ volume: VOLUME, plain: true })
    const state = await runAgent(
      {
        provider: spy,
        registry: session.registry,
        ctx: session.ctx,
        system: session.buildSystem(),
        stateLine: session.buildStateLine(),
        ...(capabilities !== undefined ? { capabilities } : {}),
        contextWindow: { keepTurns: 2, keepImages: 1 },
        requireVerification: false,
        onEvent: (event) => events.push(event),
      },
      'build something',
    )
    return { seen, events, archived: state.messages.length }
  }

  it('**没有缓存时，provider 只看到最近几轮**，而档案里是全的', async () => {
    const { seen, events, archived } = await run({ promptCache: 'none' }, 6)
    // 第一次请求时只有头（还没产生任何轮次）
    expect(seen[0]).toHaveLength(2)
    // 之后每一轮：头 + 说明 + 最多 2 轮
    const last = seen[seen.length - 1]!
    const assistantCount = last.filter((message) => message.role === 'assistant').length
    expect(assistantCount).toBeLessThanOrEqual(2)
    expect(last.some((message) => message.content.includes('[CONTEXT]'))).toBe(true)
    // 档案（`state.messages`）**没有被剪**：对话记录要留给用户回看
    expect(archived).toBeGreaterThan(last.length)
    // 事件流里明确说了这一轮裁过
    const contextEvents = events.filter((event) => event.type === 'context')
    expect(contextEvents.length).toBeGreaterThan(0)
    expect(contextEvents[0]).toMatchObject({ regime: 'windowed' })
  })

  it('有缓存时一轮都不剪（`append` 是刻意的不作为）', async () => {
    const { seen, events } = await run({ promptCache: 'auto', contextWindow: 1_000_000 }, 6)
    const last = seen[seen.length - 1]!
    expect(last.filter((message) => message.role === 'assistant')).toHaveLength(6)
    expect(last.some((message) => message.content.includes('[CONTEXT]'))).toBe(false)
    expect(events.filter((event) => event.type === 'context')).toHaveLength(0)
  })
})

describe('工具结果压缩：一条结果不能吃掉整个上下文（§9.2 Regime B）', () => {
  const huge = (lines: number, width = 40): string =>
    Array.from({ length: lines }, (_, i) => `line ${i} ${'x'.repeat(width)}`).join('\n')

  it('**超上限就截断，并明说截掉了多少**（切在行边界上）', () => {
    const text = formatToolResult({ ok: true, summary: huge(200) }, 500)
    expect(text.length).toBeLessThan(600)
    expect(text).toContain('[... truncated')
    expect(text).toContain('characters')
    // 切在行边界：最后一行完整
    const body = text.slice(0, text.indexOf('\n[... truncated'))
    expect(body.endsWith('x')).toBe(true)
    expect(body.split('\n').every((line) => line.startsWith('line ') || line.length === 0)).toBe(true)
  })

  it('不超上限时一个字都不动（截断不该是常态）', () => {
    const summary = 'matched 3 types: minecraft:stone, minecraft:dirt, minecraft:sand'
    expect(formatToolResult({ ok: true, summary })).toBe(summary)
  })

  it('失败信息也一样被压（错误也可能很长）', () => {
    const text = formatToolResult(
      { ok: false, summary: huge(100), error: { code: 'TOO_LARGE', message: 'too large' } },
      300,
    )
    expect(text.startsWith('ERROR [TOO_LARGE]')).toBe(true)
    expect(text).toContain('[... truncated')
  })

  it('**两套 regime 的上限不一样**：B（小窗口）卡得更紧', () => {
    const append = contextPolicyFor({ promptCache: 'auto', contextWindow: 1_000_000 })
    const windowed = contextPolicyFor({ promptCache: 'none' })
    expect(append.regime).toBe('append')
    expect(windowed.regime).toBe('windowed')
    expect(windowed.toolResultChars).toBeLessThan(append.toolResultChars)
    expect(append.toolResultChars).toBe(DEFAULT_TOOL_RESULT_CHARS)
  })

  it('**发出去的请求里那条工具消息真的被压过**（不是只在单元层面压）', async () => {
    const session = new AgentSession({ volume: VOLUME, plain: true })
    const seen: LlmMessage[][] = []
    const provider = new ScriptedProvider([
      { toolCalls: [{ name: 'search_blocks', args: { query: 'oak', limit: 999 } }] },
      { text: 'done' },
    ])
    const spy: LlmProvider = {
      id: provider.id,
      model: provider.model,
      supportsImages: false,
      chat: async (request) => {
        seen.push(request.messages.map((message) => ({ ...message })))
        return provider.chat(request)
      },
    }
    await runAgent(
      {
        provider: spy,
        registry: session.registry,
        ctx: session.ctx,
        system: session.buildSystem(),
        capabilities: { promptCache: 'none' },
      },
      '找一下橡木方块，越多越好',
    )
    const toolMessage = seen[1]?.find((message) => message.role === 'tool')
    expect(toolMessage).toBeDefined()
    expect(String(toolMessage!.content).length).toBeLessThanOrEqual(WINDOWED_TOOL_RESULT_CHARS + 200)
  })
})
