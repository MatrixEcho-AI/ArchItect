import { describe, expect, it } from 'vitest'

import { AgentSession } from '../src/session.js'
import { runAgent } from '../src/loop.js'
import type { AgentEvent } from '../src/loop.js'
import { ScriptedProvider } from '../src/providers/scripted.js'
import { checkBudget, costOf } from '../src/usage.js'

/**
 * **花费预算必须真的刹车。**
 *
 * 界面里填了 `$2` 就必须在 $2 停下来。只记账不刹车比不记账更糟——
 * 用户会以为自己被保护着。所以这一组测试验的不是"算得对不对"（那是
 * `usage.test.ts` 的事），而是"到点了会不会停"。
 */

const VOLUME = { min: { x: 0, y: 0, z: 0 }, max: { x: 15, y: 15, z: 15 } }

/** 一个"永远在调工具"的剧本：不刹车就会一直跑下去。 */
const chattyScript = (callCount: number): Array<{ toolCalls: Array<{ name: string; args: unknown }> }> =>
  Array.from({ length: callCount }, (_, i) => ({
    toolCalls: [{ name: 'place_block', args: { pos: [i % 16, 0, 0], block: 'minecraft:stone' } }],
  }))

/**
 * 补一次通过的 verify。
 *
 * 不改东西的剧本才能直接以文本收尾——**完成闸门在预算是 set 时同样有效**，
 * 所以凡是要跑到 `completed` 的用例都得先读回一次。
 */
const verifyStep = {
  toolCalls: [
    { name: 'verify' as const, args: { claims: [{ check: 'block_at', pos: [0, 0, 0], expect: 'minecraft:stone' }] } },
  ],
}

/** DeepSeek 的实测口径，用来算钱。 */
const PRICE = { inPerMTok: 0.14, outPerMTok: 0.28, cacheReadPerMTok: 0.0028 }

interface RunResult {
  stopReason: string
  error?: string
  events: AgentEvent[]
  turns: number
  toolCalls: number
}

async function run(
  script: Parameters<typeof ScriptedProvider.prototype.chat> extends never ? never : ConstructorParameters<typeof ScriptedProvider>[0],
  options: { budget?: Parameters<typeof runAgent>[0]['budget']; costTable?: Parameters<typeof runAgent>[0]['costTable']; maxTurns?: number } = {},
): Promise<RunResult> {
  const session = new AgentSession({ volume: VOLUME, plain: true })
  const events: AgentEvent[] = []
  const state = await runAgent(
    {
      provider: new ScriptedProvider(script),
      registry: session.registry,
      ctx: session.ctx,
      system: session.buildSystem(),
      stateLine: session.buildStateLine(),
      onEvent: (event) => events.push(event),
      ...options,
    },
    '一直造下去',
  )
  return {
    stopReason: state.stopReason,
    ...(state.error !== undefined ? { error: state.error } : {}),
    events,
    turns: state.turn,
    toolCalls: state.toolCalls,
  }
}

describe('预算刹车：轮数', () => {
  it('**到轮数上限就停，不是跑到剧本用完**', async () => {
    const result = await run(chattyScript(50), { budget: { maxTurns: 3 } })
    expect(result.stopReason).toBe('budget')
    expect(result.turns).toBe(3)
    const event = result.events.find((entry) => entry.type === 'budget')
    expect(event).toMatchObject({ type: 'budget', reason: 'turns' })
  })
})

describe('预算刹车：输出 token', () => {
  it('累计输出 token 越线即停，并报出真实用量', async () => {
    // 剧本每轮都有一段不短的文本，token 会很快累积
    const script = Array.from({ length: 30 }, () => ({
      text: '这是一段足够长的说明文字，用来让输出 token 稳定增长。'.repeat(4),
      toolCalls: [{ name: 'place_block', args: { pos: [0, 0, 0], block: 'minecraft:stone' } }],
    }))
    const result = await run(script, { budget: { maxTokensOut: 200 } })
    expect(result.stopReason).toBe('budget')
    const event = result.events.find((entry) => entry.type === 'budget')
    expect(event).toMatchObject({ type: 'budget', reason: 'tokens' })
    if (event?.type === 'budget') {
      expect(event.usage.out).toBeGreaterThanOrEqual(200)
    }
  })
})

describe('预算刹车：美元', () => {
  it('**给了价格表时，美元上限真的会刹住**', async () => {
    const result = await run(chattyScript(50), { budget: { maxUsd: 0.0001 }, costTable: PRICE })
    expect(result.stopReason).toBe('budget')
    const event = result.events.find((entry) => entry.type === 'budget')
    expect(event).toMatchObject({ type: 'budget', reason: 'usd' })
    if (event?.type === 'budget') {
      expect(event.usd).toBeGreaterThanOrEqual(0.0001)
      // 用量如实带上，界面才能解释"花到多少停的"
      expect(event.usage.in).toBeGreaterThan(0)
    }
  })

  it('上限给得足够宽时不该被刹住，照常完成', async () => {
    const script = [...chattyScript(2), verifyStep, { text: '做完了。' }]
    const result = await run(script, { budget: { maxUsd: 100 }, costTable: PRICE })
    expect(result.stopReason).toBe('completed')
    expect(result.events.some((entry) => entry.type === 'budget')).toBe(false)
  })

  it('**没有价格表却设了美元上限 → 判为越界**（"设了没生效"是最坏的失败模式）', async () => {
    const result = await run(chattyScript(5), { budget: { maxUsd: 5 } })
    expect(result.stopReason).toBe('budget')
    const event = result.events.find((entry) => entry.type === 'budget')
    expect(event?.type === 'budget' && event.reason).toBe('usd')
    // **不要断言 detail 的具体文字**：那句话是本地化的（`agent.usage.noPriceTable`），
    // 断言中文会让整个文件在 `LANG=en-US` 下挂掉。要断言"它说清楚了原因"，
    // 就断言那句提示非空、且与 reason 对应。
    expect(result.error, '预算触顶时必须给出可读的原因').toBeTruthy()
    expect(event?.type === 'budget' && event.detail).toBe(result.error)
  })
})

describe('预算不该误伤', () => {
  it('**不设预算时行为完全不变**', async () => {
    const script = [...chattyScript(3), verifyStep, { text: '好了。' }]
    const result = await run(script, { maxTurns: 20 })
    expect(result.stopReason).toBe('completed')
    expect(result.turns).toBe(5) // 3 步 + verify + 收尾文本
    expect(result.toolCalls).toBe(4)
  })

  it('**预算检查夹在"收到响应"与"执行工具"之间**：触顶之后连本轮的工具都不再执行', async () => {
    const result = await run(chattyScript(50), { budget: { maxTurns: 2 } })
    // 第二轮：请求发出去了（这笔钱收不回来），响应回来一看已触顶 → 直接停，
    // 连第二轮请求的那些工具也不执行。已经花掉的追不回，能省的一分不花。
    expect(result.turns).toBe(2)
    expect(result.toolCalls).toBe(1)
    expect(result.stopReason).toBe('budget')
  })

  it('预算刹车与"完成闸门"互不干扰：闸门不因为预算是 set 就放松', async () => {
    const script = [
      { toolCalls: [{ name: 'fill_box', args: { from: [0, 0, 0], to: [1, 0, 1], block: 'minecraft:stone' } }] },
      { text: '我做完了。' },
      { text: '好吧，我核对了。' },
    ]
    const result = await run(script, { budget: { maxTurns: 10 }, costTable: PRICE })
    // 改了东西又没 verify → 闸门拦下，与预算无关
    expect(result.stopReason).toBe('unverified')
  })
})

describe('预算提示会跟着语言走（D-01）', () => {
  it('**同一个越界在中英下给出不同的说明文字**，而 reason 码不变', async () => {
    const { initI18n } = await import('@architect/i18n')

    initI18n({ locale: 'zh-CN' })
    const zh = await run(chattyScript(5), { budget: { maxUsd: 5 } })

    initI18n({ locale: 'en-US' })
    const en = await run(chattyScript(5), { budget: { maxUsd: 5 } })

    initI18n({ locale: 'zh-CN' }) // 复位，别影响同文件里的其它用例

    expect(zh.error).toBeTruthy()
    expect(en.error).toBeTruthy()
    expect(en.error).not.toBe(zh.error)
    expect(en.error).not.toMatch(/[一-龥]/)
    // 机器读的是 reason 码，它两种语言下必须一样
    const reasonOf = (events: AgentEvent[]): string | undefined => {
      const event = events.find((entry) => entry.type === 'budget')
      return event?.type === 'budget' ? event.reason : undefined
    }
    expect(reasonOf(en.events)).toBe(reasonOf(zh.events))
    expect(reasonOf(en.events)).toBe('usd')
  })
})

describe('金额口径与 loop 一致', () => {
  it('loop 报出来的 usd 与 `costOf` 对同一份用量算出的值一致', async () => {
    const result = await run(chattyScript(50), { budget: { maxUsd: 0.00005 }, costTable: PRICE })
    const event = result.events.find((entry) => entry.type === 'budget')
    expect(event?.type).toBe('budget')
    if (event?.type !== 'budget') return
    const expected = costOf(
      { in: event.usage.in, out: event.usage.out, cachedIn: event.usage.cachedIn },
      PRICE,
    )!
    expect(event.usd).toBeCloseTo(expected, 10)
  })

  it('checkBudget 的三种越界互不掩盖：先轮数、再 token、最后美元', () => {
    const totals = { in: 1_000_000, out: 999, cachedIn: 0, turns: 40, toolCalls: 0, screenshots: 0 }
    expect(checkBudget(totals, { maxTurns: 40, maxTokensOut: 999, maxUsd: 0.0001 }, PRICE)).toMatchObject({
      reason: 'turns',
    })
    expect(checkBudget({ ...totals, turns: 0 }, { maxTokensOut: 999, maxUsd: 0.0001 }, PRICE)).toMatchObject({
      reason: 'tokens',
    })
    expect(checkBudget({ ...totals, turns: 0, out: 0 }, { maxUsd: 0.0001 }, PRICE)).toMatchObject({ reason: 'usd' })
  })
})
