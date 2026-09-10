/**
 * 输出截断的处理（D-37）。
 *
 * 这一组用例的来源是一次**真机事故**：`max_tokens` 按 8192 发，思考模型把额度
 * 全烧在思维链上，`finish_reason` 回 `length`、正文空、工具调用零。主循环当时
 * 落进了"没有工具调用 = 模型说完了"的分支，于是 CLI 打印"结束原因：completed"、
 * 产出一个 0 方块的 `.mcai`——**钱花了，产出是零，而且报告说成功**。
 *
 * 所以这里锁两件事：
 * 1. 截断**永远不能**变成 `completed`；
 * 2. 能续就续一次（钱已经花了，别浪费），续不动就如实以 `max_tokens` 停下。
 */

import { beforeAll, describe, expect, it } from 'vitest'

import { initI18n } from '@architect/i18n'

import { runAgent } from '../src/loop.js'
import { AgentSession } from '../src/session.js'
import type { AgentEvent } from '../src/loop.js'
import type { LlmProvider, LlmRequest, LlmResponse } from '../src/types.js'

beforeAll(() => {
  initI18n({ locale: 'zh-CN' })
})

const makeSession = (): AgentSession =>
  new AgentSession({ volume: { min: { x: 0, y: 0, z: 0 }, max: { x: 15, y: 15, z: 15 } }, plain: true })

/** 按顺序吐固定响应，用完之后一直重复最后一个。 */
function sequence(responses: LlmResponse[]): { provider: LlmProvider; requests: LlmRequest[] } {
  const requests: LlmRequest[] = []
  let index = 0
  const provider: LlmProvider = {
    id: 'stub',
    model: 'stub',
    supportsImages: false,
    chat: async (request: LlmRequest) => {
      requests.push(request)
      const response = responses[Math.min(index, responses.length - 1)]
      index++
      return response!
    },
  }
  return { provider, requests }
}

const truncated = (reasoning: string): LlmResponse => ({
  text: '',
  toolCalls: [],
  usage: { in: 100, out: 8192 },
  finishReason: 'length',
  reasoningContent: reasoning,
})

const done = (text: string): LlmResponse => ({
  text,
  toolCalls: [],
  usage: { in: 100, out: 20 },
  finishReason: 'stop',
})

describe('输出被 token 上限截断', () => {
  it('**截断不许报成 completed**：续不动时以 max_tokens 停下并说清原因', async () => {
    const session = makeSession()
    const events: AgentEvent[] = []
    // 一直截断，永远不给正文——这就是真机上的那一次
    const { provider } = sequence([truncated('想……'), truncated('还想……'), truncated('继续想……')])
    const state = await runAgent(
      { provider, registry: session.registry, ctx: session.ctx, system: session.buildSystem(), onEvent: (e) => events.push(e) },
      '设计一座灯塔',
    )

    expect(state.stopReason).toBe('max_tokens')
    expect(state.stopReason).not.toBe('completed')
    expect(state.error).toContain('上限')
    // 截断这件事必须出现在事件流里（界面与对话档案都靠它解释"为什么什么都没有"）
    expect(events.filter((e) => e.type === 'truncated').length).toBeGreaterThanOrEqual(1)
  })

  it('截断后给一次收敛提示，模型照做就能正常完成', async () => {
    const session = makeSession()
    const events: AgentEvent[] = []
    const { provider, requests } = sequence([
      truncated('让我先规划一下整个灯塔的结构……'),
      { toolCalls: [{ id: 'call_1', name: 'fill_box', args: { from: [0, 0, 0], to: [3, 0, 3], block: 'stone' } }], text: '', usage: { in: 100, out: 50 }, finishReason: 'tool_calls' },
      { toolCalls: [{ id: 'call_2', name: 'verify', args: { claims: [{ check: 'count', block: 'stone', min: 16 }] } }], text: '', usage: { in: 100, out: 50 }, finishReason: 'tool_calls' },
      done('灯塔做好了。'),
    ])
    const state = await runAgent(
      { provider, registry: session.registry, ctx: session.ctx, system: session.buildSystem(), onEvent: (e) => events.push(e) },
      '设计一座灯塔',
    )

    expect(state.stopReason).toBe('completed')
    expect(state.finalText).toContain('灯塔')
    // 第二次请求必须带上"[GATE] … cut off …"的收敛要求，否则"续一次"只是白花钱
    const second = requests[1]
    expect(second?.messages.some((m) => m.content.includes('cut off by the output token limit'))).toBe(true)
    // **不能**回灌空正文的 assistant 消息：API 会回 400
    // `Invalid assistant message: content or tool_calls must be set`（真机踩过）
    for (const message of second?.messages ?? []) {
      if (message.role !== 'assistant') continue
      const hasContent = message.content.length > 0
      const hasCalls = (message.toolCalls?.length ?? 0) > 0
      expect(hasContent || hasCalls, JSON.stringify(message).slice(0, 120)).toBe(true)
    }
  })

  it('截断时若已经有正文，就把正文连同思维链一起回灌', async () => {
    const session = makeSession()
    const { provider, requests } = sequence([
      {
        text: '我打算先铺一层基座，然后',
        toolCalls: [],
        usage: { in: 10, out: 8192 },
        finishReason: 'length',
        reasoningContent: '规划中',
      },
      { toolCalls: [{ id: 'call_x', name: 'fill_box', args: { from: [0, 0, 0], to: [0, 0, 0], block: 'stone' } }], text: '', usage: { in: 10, out: 10 }, finishReason: 'tool_calls' },
      { toolCalls: [{ id: 'call_y', name: 'verify', args: { claims: [{ check: 'count', block: 'stone', min: 1 }] } }], text: '', usage: { in: 10, out: 10 }, finishReason: 'tool_calls' },
      done('完成。'),
    ])
    const state = await runAgent(
      { provider, registry: session.registry, ctx: session.ctx, system: session.buildSystem() },
      '铺一格',
    )
    expect(state.stopReason).toBe('completed')
    // 有正文的半截回复要连思维链一起回灌（带 tools 时 DeepSeek 要求回传 reasoning_content）
    const partial = requests[1]?.messages.find((m) => m.content.includes('铺一层基座'))
    expect(partial?.reasoningContent).toBe('规划中')
  })

  it('截断但已经产出了工具调用 → 工具照常执行，不算"什么都没做"', async () => {
    const session = makeSession()
    const { provider } = sequence([
      {
        text: '',
        toolCalls: [{ id: 'call_3', name: 'fill_box', args: { from: [0, 0, 0], to: [1, 0, 1], block: 'stone' } }],
        usage: { in: 10, out: 8192 },
        finishReason: 'length',
      },
      { toolCalls: [{ id: 'call_4', name: 'verify', args: { claims: [{ check: 'count', block: 'stone', min: 4 }] } }], text: '', usage: { in: 10, out: 10 }, finishReason: 'tool_calls' },
      done('好了。'),
    ])
    const state = await runAgent(
      { provider, registry: session.registry, ctx: session.ctx, system: session.buildSystem() },
      '铺一块地',
    )
    expect(state.stopReason).toBe('completed')
    // (0,0,0)-(1,0,1) 含端点是 2×1×2 = 4 格
    expect(session.store.stats().blocks).toBe(4)
  })

  it('一轮里最多续两次，不会无限往一个填不满的洞里倒钱', async () => {
    const session = makeSession()
    const { provider, requests } = sequence([truncated('想'), truncated('想'), truncated('想'), truncated('想'), truncated('想')])
    const state = await runAgent(
      { provider, registry: session.registry, ctx: session.ctx, system: session.buildSystem() },
      '设计',
    )
    expect(state.stopReason).toBe('max_tokens')
    // 首发 + 2 次续写 = 3 次请求，然后停下
    expect(requests.length).toBe(3)
  })

  it('正常结束的一轮会把续写计数清零，不会攒着用完', async () => {    const session = makeSession()
    const { provider, requests } = sequence([
      truncated('想'),
      { toolCalls: [{ id: 'call_5', name: 'fill_box', args: { from: [0, 0, 0], to: [0, 0, 0], block: 'stone' } }], text: '', usage: { in: 1, out: 1 }, finishReason: 'tool_calls' },
      truncated('又想'),
      { toolCalls: [{ id: 'call_6', name: 'fill_box', args: { from: [1, 0, 0], to: [1, 0, 0], block: 'stone' } }], text: '', usage: { in: 1, out: 1 }, finishReason: 'tool_calls' },
      truncated('还在想'),
      { toolCalls: [{ id: 'call_7', name: 'verify', args: { claims: [{ check: 'count', block: 'stone', min: 2 }] } }], text: '', usage: { in: 1, out: 1 }, finishReason: 'tool_calls' },
      done('完成。'),
    ])
    const state = await runAgent(
      { provider, registry: session.registry, ctx: session.ctx, system: session.buildSystem() },
      '设计',
    )
    expect(state.stopReason).toBe('completed')
    expect(requests.length).toBe(7)
  })
})
