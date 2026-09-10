import { measure } from '@architect/core'
import type { Bounds } from '@architect/core'
import { openProject, packProject } from '@architect/mcai'
import { describe, expect, it } from 'vitest'

import { runAgent, formatToolResult } from '../src/loop.js'
import { buildStateMessage, buildSystemPrompt } from '../src/prompts.js'
import { ScriptedProvider, scriptFromCalls } from '../src/providers/scripted.js'
import { AgentSession } from '../src/session.js'
import { LlmError } from '../src/types.js'
import type { AgentEvent } from '../src/loop.js'

const volume: Bounds = { min: { x: 0, y: 0, z: 0 }, max: { x: 31, y: 31, z: 31 } }

const makeSession = (): AgentSession => new AgentSession({ volume, plain: true })

describe('System Prompt', () => {
  const base = { volume: '(0,0,0) .. (31,31,31)' }

  it('**逐字节稳定**：同样输入必然产生同样字符串（前缀缓存的前提）', () => {
    expect(buildSystemPrompt(base)).toBe(buildSystemPrompt(base))
  })

  it('不含任何随时间变化的内容（时间戳/版本号会打掉整个前缀缓存）', () => {
    const prompt = buildSystemPrompt(base)
    expect(prompt).not.toMatch(/\d{4}-\d{2}-\d{2}/)
    expect(prompt).not.toMatch(/revision=\d+/)
    expect(prompt).not.toMatch(/\d{13,}/)
  })

  it('包含验证纪律与完成检查清单', () => {
    const prompt = buildSystemPrompt(base)
    expect(prompt).toContain('VERIFICATION DISCIPLINE')
    expect(prompt).toContain('COMPLETION CHECKLIST')
    expect(prompt).toContain('NEVER guess coordinates from a screenshot')
  })

  it('要求对用户说中文，但工具参数保持 ASCII', () => {
    expect(buildSystemPrompt(base)).toContain('Reply to the user in Chinese')
  })

  it('白名单非空时列出限制', () => {
    const prompt = buildSystemPrompt({ ...base, palette: ['minecraft:stone', 'minecraft:oak_planks'] })
    expect(prompt).toContain('Only these 2 block types')
    expect(prompt).toContain('minecraft:oak_planks')
  })

  it('volatile 状态走 buildStateMessage 而不是 system 前缀', () => {
    const line = buildStateMessage({ revision: 7, blocks: 128, bounds: '0,0,0..3,3,3' })
    expect(line).toContain('revision=7')
    expect(buildSystemPrompt(base)).not.toContain('revision=7')
  })
})

describe('Agent 循环', () => {
  it('模型直接给文本就结束', async () => {
    const session = makeSession()
    const provider = new ScriptedProvider([{ text: '好的，我先规划一下。' }])
    const state = await runAgent(
      { provider, registry: session.registry, ctx: session.ctx, system: session.buildSystem() },
      '设计一座小屋',
    )
    expect(state.stopReason).toBe('completed')
    expect(state.finalText).toBe('好的，我先规划一下。')
    expect(state.turn).toBe(1)
    expect(session.store.revision).toBe(0)
  })

  it('工具调用会被执行、结果回灌、再进下一轮', async () => {
    const session = makeSession()
    const provider = new ScriptedProvider([
      { toolCalls: [{ name: 'fill_box', args: { from: [0, 0, 0], to: [3, 0, 3], block: 'stone' } }] },
      { text: '地板铺好了。' },
    ])
    const state = await runAgent(
      { provider, registry: session.registry, ctx: session.ctx, system: session.buildSystem(),
        requireVerification: false },
      '铺一层 4x4 的石地板',
    )
    expect(state.stopReason).toBe('completed')
    expect(state.toolCalls).toBe(1)
    expect(session.store.revision).toBe(1)
    expect(measure(session.store).blocks).toBe(16)

    // 工具结果以文本形式进了历史
    const toolMessage = state.messages.find((m) => m.role === 'tool')
    expect(toolMessage?.content).toContain('changed 16 cells')
  })

  it('一次响应里的多个工具调用都会执行，且共享 correlationId', async () => {
    const session = makeSession()
    const provider = new ScriptedProvider([
      {
        toolCalls: [
          { name: 'fill_box', args: { from: [0, 0, 0], to: [3, 0, 3], block: 'stone' } },
          { name: 'fill_box', args: { from: [0, 1, 0], to: [3, 1, 3], block: 'oak_planks' } },
        ],
      },
      { text: '完成。' },
    ])
    const state = await runAgent(
      { provider, registry: session.registry, ctx: session.ctx, system: session.buildSystem() },
      '铺地板和一层木台',
    )
    expect(state.toolCalls).toBe(2)
    expect(session.log.length).toBe(2)
    expect(session.log.at(0)!.correlationId).toBe(session.log.at(1)!.correlationId)
  })

  it('截图以**独立的 user 消息**回灌（OpenAI 的 tool 消息只收文本）', async () => {
    const session = makeSession()
    const provider = new ScriptedProvider([
      { toolCalls: [{ name: 'fill_box', args: { from: [0, 0, 0], to: [3, 3, 3], block: 'stone' } }] },
      { toolCalls: [{ name: 'screenshot', args: { view: 'iso_ne', width: 160, height: 120 } }] },
      { text: '看起来不错。' },
    ])
    const state = await runAgent(
      { provider, registry: session.registry, ctx: session.ctx, system: session.buildSystem() },
      '建一个立方体然后拍张照',
    )
    const withImages = state.messages.find((m) => m.images !== undefined && m.images.length > 0)
    expect(withImages).toBeDefined()
    expect(withImages!.role).toBe('user')
    expect(withImages!.images![0]!.png.length).toBeGreaterThan(100)
    expect(withImages!.content).toContain('revision')
  })

  it('同一张截图不会被重复塞进上下文（内容寻址去重）', async () => {
    const session = makeSession()
    const provider = new ScriptedProvider([
      { toolCalls: [{ name: 'fill_box', args: { from: [0, 0, 0], to: [3, 3, 3], block: 'stone' } }] },
      { toolCalls: [{ name: 'screenshot', args: { view: 'iso_ne', width: 160, height: 120 } }] },
      { toolCalls: [{ name: 'screenshot', args: { view: 'iso_ne', width: 160, height: 120 } }] },
      { text: 'done' },
    ])
    const state = await runAgent(
      { provider, registry: session.registry, ctx: session.ctx, system: session.buildSystem() },
      '立方体',
    )
    const imageMessages = state.messages.filter((m) => m.images !== undefined && m.images.length > 0)
    // 第二次同机位同版本 → 同一张 PNG → 不重复入上下文
    expect(imageMessages).toHaveLength(1)
  })

  it('工具报错不会让循环崩掉，错误会回灌给模型', async () => {
    const session = makeSession()
    const provider = new ScriptedProvider([
      { toolCalls: [{ name: 'fill_box', args: { from: [0, 0, 0], to: [3, 0, 3], block: 'nope:block' } }] },
      { toolCalls: [{ name: 'fill_box', args: { from: [0, 0, 0], to: [3, 0, 3], block: 'stone' } }] },
      { text: '改用合法方块后成功了。' },
    ])
    const state = await runAgent(
      { provider, registry: session.registry, ctx: session.ctx, system: session.buildSystem(),
        requireVerification: false },
      '铺地板',
    )
    expect(state.stopReason).toBe('completed')
    expect(state.toolCalls).toBe(2)
    const errors = state.messages.filter((m) => m.role === 'tool' && m.content.startsWith('ERROR'))
    expect(errors).toHaveLength(1)
    expect(errors[0]!.content).toContain('UNKNOWN_BLOCK')
    expect(errors[0]!.content).toContain('HINT')
  })

  it('未知工具也走同一条可自纠路径', async () => {
    const session = makeSession()
    const provider = new ScriptedProvider([
      { toolCalls: [{ name: 'make_a_castle', args: {} }] },
      { text: '换个工具。' },
    ])
    const state = await runAgent(
      { provider, registry: session.registry, ctx: session.ctx, system: session.buildSystem() },
      '造城堡',
    )
    const toolMessage = state.messages.find((m) => m.role === 'tool')
    expect(toolMessage?.content).toContain('UNKNOWN_TOOL')
    expect(toolMessage?.content).toContain('fill_box')
  })

  it('预算：轮数上限', async () => {
    const session = makeSession()
    const provider = new ScriptedProvider(() => ({
      toolCalls: [{ name: 'measure', args: {} }],
    }))
    const state = await runAgent(
      { provider, registry: session.registry, ctx: session.ctx, system: session.buildSystem(), maxTurns: 3 },
      '没完没了',
    )
    expect(state.stopReason).toBe('max_turns')
    expect(state.turn).toBe(3)
  })

  it('预算：工具调用数上限', async () => {
    const session = makeSession()
    const provider = new ScriptedProvider(() => ({
      toolCalls: [
        { name: 'measure', args: {} },
        { name: 'measure', args: {} },
      ],
    }))
    const state = await runAgent(
      {
        provider,
        registry: session.registry,
        ctx: session.ctx,
        system: session.buildSystem(),
        maxTurns: 100,
        maxToolCalls: 5,
      },
      '刷工具调用',
    )
    expect(state.stopReason).toBe('max_tool_calls')
    expect(state.toolCalls).toBeGreaterThan(5)
  })

  it('预算：token 上限', async () => {
    const session = makeSession()
    const provider = new ScriptedProvider(() => ({ text: 'x'.repeat(4000) }))
    const state = await runAgent(
      {
        provider,
        registry: session.registry,
        ctx: session.ctx,
        system: session.buildSystem(),
        maxTokens: 10,
      },
      '说很多话',
    )
    expect(state.stopReason).toBe('max_tokens')
  })

  it('可重试的错误会退避重试', async () => {
    const session = makeSession()
    let attempts = 0
    const provider = {
      id: 'flaky',
      model: 'flaky',
      supportsImages: false,
      chat: async () => {
        attempts++
        if (attempts < 3) throw new LlmError('限流', 'RATE_LIMIT', true)
        return {
          text: '终于成功',
          toolCalls: [],
          usage: { in: 1, out: 1 },
          finishReason: 'stop',
        }
      },
    }
    const events: AgentEvent[] = []
    const state = await runAgent(
      {
        provider,
        registry: session.registry,
        ctx: session.ctx,
        system: session.buildSystem(),
        onEvent: (event) => events.push(event),
      },
      '重试看看',
    )
    expect(attempts).toBe(3)
    expect(state.stopReason).toBe('completed')
    expect(events.filter((e) => e.type === 'retry')).toHaveLength(2)
  })

  it('不可重试的错误直接终止并如实报告', async () => {
    const session = makeSession()
    const provider = {
      id: 'bad',
      model: 'bad',
      supportsImages: false,
      chat: async () => {
        throw new LlmError('鉴权失败', 'AUTH', false)
      },
    }
    const state = await runAgent(
      { provider, registry: session.registry, ctx: session.ctx, system: session.buildSystem() },
      '你好',
    )
    expect(state.stopReason).toBe('error')
    expect(state.error).toContain('鉴权失败')
  })

  it('shouldStop 可以中途叫停', async () => {
    const session = makeSession()
    let calls = 0
    const provider = new ScriptedProvider(() => {
      calls++
      return { toolCalls: [{ name: 'measure', args: {} }] }
    })
    const state = await runAgent(
      {
        provider,
        registry: session.registry,
        ctx: session.ctx,
        system: session.buildSystem(),
        shouldStop: () => calls >= 2,
      },
      '停',
    )
    expect(state.stopReason).toBe('stopped')
  })

  it('token 用量被累计（含缓存命中）', async () => {
    const session = makeSession()
    const provider = new ScriptedProvider([{ text: 'hi' }])
    const state = await runAgent(
      { provider, registry: session.registry, ctx: session.ctx, system: session.buildSystem() },
      '你好',
    )
    expect(state.usage.in).toBeGreaterThan(0)
    expect(state.usage.out).toBeGreaterThan(0)
  })
})

describe('端到端：Agent 盖完房子并产出可回放的 .mcai', () => {
  it('从一句需求到可重新打开的工程文件', async () => {
    const session = new AgentSession({
      volume: { min: { x: 0, y: 0, z: 0 }, max: { x: 24, y: 24, z: 24 } },
      plain: true,
    })

    // 剧本模拟一个"像样的"LLM：规划 → 地板 → 墙 → 门 → 读回 → 收尾
    const provider = new ScriptedProvider(
      scriptFromCalls(
        [
          ['measure', {}],
          [
            'extrude',
            {
              points: [
                [2, 2],
                [11, 2],
                [11, 11],
                [2, 11],
              ],
              baseY: 0,
              height: 1,
              block: 'minecraft:oak_planks',
            },
          ],
          [
            'extrude',
            {
              points: [
                [2, 2],
                [11, 2],
                [11, 11],
                [2, 11],
              ],
              baseY: 1,
              height: 3,
              block: 'minecraft:stone_bricks',
              hollow: true,
              capTop: false,
              capBottom: false,
            },
          ],
          ['erase', { from: [6, 1, 2], to: [6, 2, 2] }],
          [
            'verify',
            {
              claims: [
                { check: 'air_at', pos: [6, 1, 2] },
                { check: 'air_at', pos: [6, 2, 2] },
                { check: 'block_at', pos: [6, 3, 2], expect: 'minecraft:stone_bricks' },
                { check: 'count', block: 'minecraft:oak_planks', min: 90, max: 110 },
              ],
            },
          ],
          ['screenshot', { view: 'iso_ne', width: 200, height: 150 }],
        ],
        '房子建好了：10x10 的木地板 + 三格高的石砖墙，南墙开了 1x2 的门洞。',
      ),
    )

    const state = await runAgent(
      {
        provider,
        registry: session.registry,
        ctx: session.ctx,
        system: session.buildSystem(),
      },
      '设计一座 10x10 的小石屋，有木地板和一扇门',
    )

    // 1. 循环正常结束
    expect(state.stopReason).toBe('completed')
    expect(state.finalText).toContain('房子建好了')

    // 2. 世界符合需求
    const stats = measure(session.store)
    expect(stats.bounds).toEqual({ min: { x: 2, y: 0, z: 2 }, max: { x: 11, y: 3, z: 11 } })
    expect(session.store.isAir({ x: 6, y: 1, z: 2 })).toBe(true) // 门洞
    expect(session.store.isAir({ x: 6, y: 2, z: 2 })).toBe(true)
    expect(session.store.getBlockString({ x: 6, y: 3, z: 2 })).toBe('minecraft:stone_bricks')
    expect(session.store.getBlockString({ x: 5, y: 0, z: 5 })).toBe('minecraft:oak_planks')

    // 3. 事件日志完整且自洽
    expect(session.log.length).toBe(3) // 两个 extrude + erase；measure/verify/screenshot 不改世界，不产生 op
    expect(session.log.validate()).toEqual([])

    // 4. 打包成 .mcai 再打开，逐格一致
    const bytes = packProject({
      name: '10x10 小石屋',
      projectId: '01AGENTTEST',
      store: session.store,
      log: session.log,
      settings: { volume: session.store.volume },
      now: '2026-01-01T00:00:00.000Z',
    })
    const { store: reopened, project } = openProject(bytes)
    expect(reopened.contentHash()).toBe(session.store.contentHash())
    expect(project.log.length).toBe(session.log.length)

    // 5. 截图确实产出过
    expect(session.screenshots).toBe(1)
  })

  it('verify 失败时循环会看到 FAIL 并有机会修正', async () => {
    const session = new AgentSession({ volume, plain: true })
    const provider = new ScriptedProvider([
      { toolCalls: [{ name: 'fill_box', args: { from: [0, 0, 0], to: [1, 0, 1], block: 'stone' } }] },
      {
        toolCalls: [
          {
            name: 'verify',
            args: { claims: [{ check: 'block_at', pos: [9, 9, 9], expect: 'minecraft:stone' }] },
          },
        ],
      },
      { text: '我搞错了坐标，修正预期。' },
    ])
    const state = await runAgent(
      { provider, registry: session.registry, ctx: session.ctx, system: session.buildSystem() },
      '铺 2x2 地板',
    )
    const verifyMessage = state.messages.filter((m) => m.role === 'tool')[1]
    expect(verifyMessage?.content).toContain('FAIL')
    expect(verifyMessage?.content).toContain('actual is minecraft:air')
  })
})

describe('工具结果格式化', () => {
  it('成功时只给 summary', () => {
    expect(formatToolResult({ ok: true, summary: '改了 16 格' })).toBe('改了 16 格')
  })

  it('失败时带错误码与 HINT', () => {
    const text = formatToolResult({
      ok: false,
      summary: '参数不合法',
      error: { code: 'INVALID_ARGS', message: 'x', hint: '检查 from' },
    })
    expect(text).toContain('ERROR [INVALID_ARGS]')
    expect(text).toContain('HINT: 检查 from')
  })
})
