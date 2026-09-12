import { forEachExtrude } from '@architect/core'
import { beforeAll, describe, expect, it } from 'vitest'

import { initI18n } from '@architect/i18n'

import { evaluateTask, findTask, GOLDEN_TASKS } from '../src/golden.js'
import { runAgent } from '../src/loop.js'
import { exchangesFromJsonl, exchangesToJsonl, RecordingProvider, ReplayProvider } from '../src/providers/recording.js'
import { ScriptedProvider } from '../src/providers/scripted.js'
import { AgentSession } from '../src/session.js'
import type { AgentEvent } from '../src/loop.js'
import type { RecordedExchange } from '../src/providers/recording.js'

// 这些用例断言的是中文明文（录音报错等）；把 locale 钉死，免得 CI 的 LANG=en-US 让它们变色
beforeAll(() => {
  initI18n({ locale: 'zh-CN' })
})

const makeSession = (): AgentSession =>
  new AgentSession({ volume: { min: { x: 0, y: 0, z: 0 }, max: { x: 31, y: 31, z: 31 } }, plain: true })

const run = (
  session: AgentSession,
  provider: Parameters<typeof runAgent>[0]['provider'],
  extra: Partial<Parameters<typeof runAgent>[0]> = {},
): ReturnType<typeof runAgent> =>
  runAgent(
    { provider, registry: session.registry, ctx: session.ctx, system: session.buildSystem(), ...extra },
    '盖点东西',
  )

describe('完成闸门（harness 层强制"写后读"）', () => {

  it('**放了实体却不读回 → 被驳回**（实体层与方块层共用同一道闸门）', async () => {
    const session = makeSession()
    const events: AgentEvent[] = []
    const provider = new ScriptedProvider([
      { toolCalls: [{ name: 'place_entity', args: { entities: [{ type: 'minecraft:oak_boat', at: [1, 1, 1] }] } }] },
      { text: '船放好了。' },
      {
        toolCalls: [
          {
            name: 'verify',
            args: { claims: [{ check: 'entity_at', pos: [1, 1, 1], type: 'minecraft:oak_boat' }] },
          },
        ],
      },
      { text: '读回确认过了。' },
    ])
    const state = await run(session, provider, { onEvent: (e) => events.push(e) })

    expect(events.filter((e) => e.type === 'nudge')).toHaveLength(1)
    expect(state.stopReason).toBe('completed')
    expect(state.finalText).toContain('读回确认过了')
  })

  it('实体的改动**始终不读回** → 提醒用尽后以 unverified 收场，不假装完成', async () => {
    const session = makeSession()
    const events: AgentEvent[] = []
    const provider = new ScriptedProvider([
      { toolCalls: [{ name: 'place_entity', args: { entities: [{ type: 'minecraft:oak_boat', at: [1, 1, 1] }] } }] },
      { text: '做完了。' },
      { text: '真的做完了。' },
      { text: '非常确定做完了。' },
    ])
    const state = await run(session, provider, { onEvent: (e) => events.push(e) })

    // 一次 nudge 之后模型还是不肯读回：**不许**以 completed 收尾
    expect(events.filter((e) => e.type === 'nudge').length).toBeGreaterThanOrEqual(1)
    expect(state.stopReason).toBe('unverified')
  })

  it('失败的实体写入不欠读回（`mutating` 但 `ok:false` 不算改动）', async () => {
    const session = makeSession()
    const events: AgentEvent[] = []
    const provider = new ScriptedProvider([
      // 类型拼错 → 工具返回 ok:false，世界一点没变
      { toolCalls: [{ name: 'place_entity', args: { entities: [{ type: 'minecraft:oak_bot', at: [1, 1, 1] }] } }] },
      { text: '没放成，我换个说法。' },
    ])
    const state = await run(session, provider, { onEvent: (e) => events.push(e) })

    expect(events.filter((e) => e.type === 'nudge')).toHaveLength(0)
    expect(state.stopReason).toBe('completed')
  })

  it('改了东西却直接说完成 → 被驳回并要求 verify', async () => {
    const session = makeSession()
    const events: AgentEvent[] = []
    const provider = new ScriptedProvider([
      { toolCalls: [{ name: 'fill_box', args: { from: [0, 0, 0], to: [3, 0, 3], block: 'stone' } }] },
      { text: '我做完了！' },
      { toolCalls: [{ name: 'verify', args: { claims: [{ check: 'count', block: 'stone', min: 1 }] } }] },
      { text: '这次真的做完了。' },
    ])
    const state = await run(session, provider, { onEvent: (e) => events.push(e) })

    expect(events.filter((e) => e.type === 'nudge')).toHaveLength(1)
    expect(state.stopReason).toBe('completed')
    expect(state.finalText).toContain('真的做完了')
    // 提醒消息进了历史，模型能看到
    const nudge = state.messages.find((m) => m.content.startsWith('[GATE]'))
    expect(nudge).toBeDefined()
  })

  it('verify 通过之后才允许结束', async () => {
    const session = makeSession()
    const provider = new ScriptedProvider([
      { toolCalls: [{ name: 'fill_box', args: { from: [0, 0, 0], to: [3, 0, 3], block: 'stone' } }] },
      { toolCalls: [{ name: 'verify', args: { claims: [{ check: 'count', block: 'stone', min: 16 }] } }] },
      { text: '完成。' },
    ])
    const events: AgentEvent[] = []
    const state = await run(session, provider, { onEvent: (e) => events.push(e) })
    expect(events.filter((e) => e.type === 'nudge')).toHaveLength(0)
    expect(state.stopReason).toBe('completed')
  })

  it('verify 失败不算数，仍会被驳回', async () => {
    const session = makeSession()
    const provider = new ScriptedProvider([
      { toolCalls: [{ name: 'fill_box', args: { from: [0, 0, 0], to: [3, 0, 3], block: 'stone' } }] },
      // 预期写错 → verify 返回 ok:false → 不能清账
      { toolCalls: [{ name: 'verify', args: { claims: [{ check: 'count', block: 'stone', min: 999 }] } }] },
      { text: '完成。' },
      { toolCalls: [{ name: 'verify', args: { claims: [{ check: 'count', block: 'stone', min: 1 }] } }] },
      { text: '好了。' },
    ])
    const events: AgentEvent[] = []
    const state = await run(session, provider, { onEvent: (e) => events.push(e) })
    expect(events.filter((e) => e.type === 'nudge')).toHaveLength(1)
    expect(state.stopReason).toBe('completed')
  })

  it('提醒次数用尽后以 unverified 结束，而不是假装完成', async () => {
    const session = makeSession()
    const provider = new ScriptedProvider(() => ({ text: '我做完了。' }))
    const state = await run(session, provider)
    // 第一轮没有修改，所以闸门不触发
    expect(state.stopReason).toBe('completed')

    const session2 = makeSession()
    const stubborn = new ScriptedProvider([
      { toolCalls: [{ name: 'fill_box', args: { from: [0, 0, 0], to: [1, 0, 1], block: 'stone' } }] },
    ])
    const provider2 = {
      id: 'stubborn',
      model: 'stubborn',
      supportsImages: false,
      chat: async (request: Parameters<typeof stubborn.chat>[0]) => {
        // 第一轮调工具，之后一直说"我做完了"
        if (request.messages.some((m) => m.role === 'tool')) {
          return { text: '我做完了。', toolCalls: [], usage: { in: 1, out: 1 }, finishReason: 'stop' }
        }
        return stubborn.chat(request)
      },
    }
    const state2 = await runAgent(
      {
        provider: provider2,
        registry: session2.registry,
        ctx: session2.ctx,
        system: session2.buildSystem(),
        maxNudges: 2,
      },
      '盖',
    )
    expect(state2.stopReason).toBe('unverified')
    expect(state2.finalText).toContain('做完了')
  })

  it('requireVerification: false 时不拦截（老行为）', async () => {
    const session = makeSession()
    const provider = new ScriptedProvider([
      { toolCalls: [{ name: 'fill_box', args: { from: [0, 0, 0], to: [1, 0, 1], block: 'stone' } }] },
      { text: '完成。' },
    ])
    const state = await run(session, provider, { requireVerification: false })
    expect(state.stopReason).toBe('completed')
  })

  it('纯读操作不触发闸门', async () => {
    const session = makeSession()
    const provider = new ScriptedProvider([
      { toolCalls: [{ name: 'measure', args: {} }] },
      { toolCalls: [{ name: 'slice', args: { axis: 'y', index: 0, x: [0, 4], z: [0, 4] } }] },
      { text: '没什么可做的。' },
    ])
    const state = await run(session, provider)
    expect(state.stopReason).toBe('completed')
  })
})

describe('录制 / 回放（VCR）', () => {
  const script = [
    { toolCalls: [{ name: 'fill_box', args: { from: [0, 0, 0], to: [3, 0, 3], block: 'stone' } }] },
    { text: '地板铺好了。' },
  ]

  async function record(): Promise<RecordedExchange[]> {
    const session = makeSession()
    const exchanges: RecordedExchange[] = []
    const provider = new RecordingProvider(
      new ScriptedProvider(script),
      (exchange) => exchanges.push(exchange),
      () => new Date('2026-01-01T00:00:00.000Z'),
    )
    await run(session, provider, { requireVerification: false })
    return exchanges
  }

  it('记录每次交互的请求与响应', async () => {
    const exchanges = await record()
    expect(exchanges).toHaveLength(2)
    expect(exchanges[0]!.turn).toBe(1)
    expect(exchanges[0]!.meta.provider).toBe('scripted')
    expect(exchanges[0]!.meta.at).toBe('2026-01-01T00:00:00.000Z')
    expect(exchanges[0]!.response.toolCalls[0]!.name).toBe('fill_box')
    expect(exchanges[0]!.request.tools).toContain('fill_box')
    expect(exchanges[0]!.request.system).toContain('VERIFICATION DISCIPLINE')
  })

  it('图像只记数量与哈希，不把 PNG 塞进录音', async () => {
    const session = makeSession()
    const exchanges: RecordedExchange[] = []
    const provider = new RecordingProvider(
      new ScriptedProvider([
        { toolCalls: [{ name: 'fill_box', args: { from: [0, 0, 0], to: [3, 3, 3], block: 'stone' } }] },
        { toolCalls: [{ name: 'screenshot', args: { width: 120, height: 90 } }] },
        { text: 'ok' },
      ]),
      (exchange) => exchanges.push(exchange),
    )
    await run(session, provider, { requireVerification: false })
    const withImages = exchanges[2]!.request.messages.find((m) => m.images !== undefined)
    expect(withImages?.images?.[0]).toHaveProperty('id')
    expect(withImages?.images?.[0]).toHaveProperty('bytes')
    expect(JSON.stringify(withImages)).not.toContain('base64')
  })

  it('JSONL 往返', async () => {
    const exchanges = await record()
    const restored = exchangesFromJsonl(exchangesToJsonl(exchanges))
    expect(restored).toEqual(exchanges)
  })

  it('回放产生同样的对话与同样的世界', async () => {
    const exchanges = await record()
    const session = makeSession()
    const provider = new ReplayProvider(exchanges)
    const state = await run(session, provider, { requireVerification: false })
    expect(state.finalText).toBe('地板铺好了。')
    expect(session.store.getBlockString({ x: 0, y: 0, z: 0 })).toBe('minecraft:stone')
    expect(session.store.revision).toBe(1)
  })

  it('录音放完还继续要 → 报错说明录音过期', async () => {
    const exchanges = await record()
    const session = makeSession()
    const provider = new ReplayProvider(exchanges)
    // 强制多走一轮：禁用闸门并让它一直调工具
    await expect(
      run(session, provider, { requireVerification: false }),
    ).resolves.toBeDefined()

    const session2 = makeSession()
    const replay2 = new ReplayProvider(exchanges)
    await run(session2, replay2, { requireVerification: false })
    // 第二次回放同一个 provider，已耗尽——循环不抛异常，而是如实报告 error
    const exhausted = await run(session2, replay2, { requireVerification: false })
    expect(exhausted.stopReason).toBe('error')
    expect(exhausted.error).toContain('录音')
  })

  it('录音里的工具在当前版本不存在时明确报错（工具集变了）', async () => {
    const exchanges = await record()
    const tampered: RecordedExchange[] = [
      { ...exchanges[0]!, request: { ...exchanges[0]!.request, tools: ['ancient_tool', 'fill_box'] } },
    ]
    const session = makeSession()
    const provider = new ReplayProvider(tampered)
    const broken = await run(session, provider, { requireVerification: false })
    expect(broken.stopReason).toBe('error')
    expect(broken.error).toContain('当前不存在的工具')
  })

  it('回放会暴露"轮数对不上"——这正是录音过期的信号', async () => {
    const exchanges = await record()
    const session = makeSession()
    const provider = new ReplayProvider(exchanges)
    // 第一次正常
    await run(session, provider, { requireVerification: false })
    expect(provider.remaining).toBe(0)
    // 再走一轮：录音已空
    const session2 = makeSession()
    const replay = new ReplayProvider(exchanges)
    await run(session2, replay, { requireVerification: false })
    const stale = await run(session2, replay, { requireVerification: false })
    expect(stale.stopReason).toBe('error')
    expect(stale.error).toContain('已经走到第 3 轮')
  })
})

describe('黄金任务的程序化验收', () => {
  it('5 个任务都有 id / 需求 / 验收项', () => {
    expect(GOLDEN_TASKS).toHaveLength(5)
    for (const task of GOLDEN_TASKS) {
      expect(task.id.length).toBeGreaterThan(0)
      expect(task.goal.length).toBeGreaterThan(10)
      expect(task.checks.length).toBeGreaterThan(0)
    }
    expect(findTask('lighthouse')).toBeDefined()
    expect(findTask('nope')).toBeUndefined()
  })

  it('空世界在所有任务上都不通过（验收不是恒真）', () => {
    const store = new AgentSession({ volume: GOLDEN_TASKS[0]!.volume, plain: true }).store
    for (const task of GOLDEN_TASKS) {
      const evaluation = evaluateTask(task, store)
      expect(evaluation.achieved, `${task.id} 不该通过`).toBe(false)
      expect(evaluation.passed).toBeLessThan(evaluation.total)
    }
  })

  it('手搭的合格小屋能通过小屋任务', () => {
    const task = findTask('hut')!
    const session = new AgentSession({ volume: task.volume, plain: true })
    const store = session.store
    const rect = [
      { x: 4, z: 4 },
      { x: 13, z: 4 },
      { x: 13, z: 13 },
      { x: 4, z: 13 },
    ]
    const P = (name: string): number => store.palette.indexOf(name)
    // 地板
    store.write((v) => forEachExtrude(rect, { baseY: 0, height: 1 }, v), P('minecraft:oak_planks'), { confirm: true })
    // 墙
    store.write(
      (v) => forEachExtrude(rect, { baseY: 1, height: 4, hollow: true, capTop: false, capBottom: false }, v),
      P('minecraft:stone_bricks'),
      { confirm: true },
    )
    // 南面门洞（净高 2）
    store.write((v) => v(8, 1, 4), 0, { mode: 'destroy', confirm: true })
    store.write((v) => v(8, 2, 4), 0, { mode: 'destroy', confirm: true })
    // 东西两面各一扇窗
    store.write((v) => v(4, 2, 8), P('minecraft:glass'), { confirm: true })
    store.write((v) => v(13, 2, 8), P('minecraft:glass'), { confirm: true })
    // 人字形屋顶
    store.write(
      (v) =>
        forEachExtrude(rect, { baseY: 5, height: 3, hollow: true, capBottom: false, capTop: true }, v),
      P('minecraft:spruce_planks'),
      { confirm: true },
    )

    const evaluation = evaluateTask(task, store)
    for (const result of evaluation.results) {
      expect(result.pass, `${result.label}${result.detail !== undefined ? ` → ${result.detail}` : ''}`).toBe(true)
    }
    expect(evaluation.achieved).toBe(true)
  })

  it('验收会指出具体哪一项不过，而不是只说"失败"', () => {
    const task = findTask('tower')!
    const session = new AgentSession({ volume: task.volume, plain: true })
    // 只放一格
    session.store.setBlock({ x: 5, y: 5, z: 5 }, 'minecraft:stone')
    const evaluation = evaluateTask(task, session.store)
    const failed = evaluation.results.filter((r) => !r.pass)
    expect(failed.length).toBeGreaterThan(0)
    for (const result of failed) {
      expect(result.detail, `${result.label} 应当有具体说明`).toBeDefined()
    }
  })

  it('evaluateTask 带上 op 数', () => {
    const task = findTask('hut')!
    const session = new AgentSession({ volume: task.volume, plain: true })
    const evaluation = evaluateTask(task, session.store, 7)
    expect(evaluation.stats.ops).toBe(7)
  })
})
