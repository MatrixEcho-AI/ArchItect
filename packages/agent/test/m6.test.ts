import { measure } from '@architect/core'
import { describe, expect, it } from 'vitest'

import { AgentSession } from '../src/session.js'
import { runAgent } from '../src/loop.js'
import { ScriptedProvider } from '../src/providers/scripted.js'
import type { AgentEvent } from '../src/loop.js'

/**
 * M6 的端到端验收：**agent 用高级编辑工具盖出一座对称建筑**。
 *
 * 这些测试不联网、不花钱，断言的是 plan §15 里 M6 那行真正要看的东西：
 * 批处理真的把多个 op 压成了一个 revision；复制/旋转真的把朝向一起带走了；
 * 镜像之后对称的那一半是**朝向正确**的，而不是"看起来对称、楼梯全朝同一边"。
 *
 * 最后一条是最容易假装通过的——只看方块数量和平面对称性，错的朝向完全看不出来。
 * 所以下面每一条都断言到具体的 state 字符串。
 */

const VOLUME = { min: { x: 0, y: 0, z: 0 }, max: { x: 31, y: 31, z: 31 } }

function makeSession(): AgentSession {
  return new AgentSession({ volume: VOLUME, plain: true })
}

const blockAt = (session: AgentSession, x: number, y: number, z: number): string =>
  session.store.getBlockString({ x, y, z }).replace('minecraft:', '')

/** 跑一个剧本，返回事件与结束原因。 */
async function run(
  session: AgentSession,
  script: ConstructorParameters<typeof ScriptedProvider>[0],
  goal = '造一座对称的小屋',
): Promise<{ events: AgentEvent[]; stopReason: string; toolNames: string[] }> {
  const provider = new ScriptedProvider(script)
  const events: AgentEvent[] = []
  const state = await runAgent(
    {
      provider,
      registry: session.registry,
      ctx: session.ctx,
      system: session.buildSystem(),
      stateLine: session.buildStateLine(),
      onEvent: (event) => events.push(event),
    },
    goal,
  )
  const toolNames = events
    .filter((event): event is Extract<AgentEvent, { type: 'tool_call' }> => event.type === 'tool_call')
    .map((event) => event.name)
  return { events, stopReason: state.stopReason, toolNames }
}

describe('M6 端到端：批处理', () => {
  it('**一次 run_batch 只花一个 revision**，而逐个调用要花四个', async () => {
    const session = makeSession()
    const { stopReason } = await run(session, [
      {
        toolCalls: [
          {
            name: 'run_batch',
            args: {
              ops: [
                { tool: 'fill_box', args: { from: [0, 0, 0], to: [7, 0, 7], block: 'minecraft:stone' } },
                { tool: 'fill_box', args: { from: [0, 1, 0], to: [7, 1, 0], block: 'minecraft:oak_planks' } },
                { tool: 'fill_box', args: { from: [0, 1, 7], to: [7, 1, 7], block: 'minecraft:oak_planks' } },
                { tool: 'place_block', args: { pos: [3, 1, 3], block: 'minecraft:torch' } },
              ],
              confirm: true,
            },
          },
        ],
      },
      {
        toolCalls: [
          {
            name: 'verify',
            args: { claims: [{ check: 'block_at', pos: [3, 1, 3], expect: 'minecraft:torch' }] },
          },
        ],
      },
      { text: '地基和两面墙好了。' },
    ])

    expect(stopReason).toBe('completed')
    // 4 个 op，但世界只涨了 1 版
    expect(session.store.revision).toBe(1)
    expect(session.log.length).toBe(1)
    expect(session.log.all()[0]?.tool).toBe('run_batch')
    const stats = measure(session.store)
    // 地板 8x8=64 + 两排墙各 8 格 = 16 + 火把 1
    expect(stats.blocks).toBe(64 + 8 + 8 + 1)
  })

  it('批处理里一个 op 写错，整批不落盘，错误回灌给模型', async () => {
    const session = makeSession()
    const { events } = await run(session, [
      {
        toolCalls: [
          {
            name: 'run_batch',
            args: {
              ops: [
                { tool: 'fill_box', args: { from: [0, 0, 0], to: [7, 0, 7], block: 'minecraft:stone' } },
                { tool: 'fill_box', args: { from: [0, 1, 0], to: [7, 1, 7], block: 'minecraft:oak_plank' } },
              ],
              confirm: true,
            },
          },
        ],
      },
      { text: '我改一下方块名。' },
    ])

    expect(session.store.revision).toBe(0)
    expect(session.store.stats().blocks).toBe(0)
    const toolResult = events.find((event) => event.type === 'tool_result')
    expect(toolResult).toBeDefined()
    expect(JSON.stringify(toolResult)).toContain('UNKNOWN_BLOCK')
  })
})

describe('M6 端到端：镜像与朝向', () => {
  it('**只造一半，symmetrize 出另一半，且楼梯朝向是镜像过的**', async () => {
    const session = makeSession()
    const { stopReason } = await run(session, [
      {
        toolCalls: [
          {
            name: 'run_batch',
            args: {
              ops: [
                // 在 x < 8 一侧铺地板
                { tool: 'fill_box', args: { from: [0, 0, 0], to: [7, 0, 7], block: 'minecraft:stone_bricks' } },
                // 一座朝东的楼梯（朝向 +X 那一侧 = 待镜像的那一侧）
                { tool: 'place_block', args: { pos: [5, 1, 3], block: 'minecraft:oak_stairs[facing=east]' } },
              ],
              confirm: true,
            },
          },
        ],
      },
      {
        toolCalls: [
          { name: 'symmetrize', args: { axis: 'x', coordinate: 8, source: 'negative', confirm: true } },
        ],
      },
      {
        toolCalls: [
          // 镜像后的楼梯应当在 x = 2*8-5 = 11，并且**朝西**
          {
            name: 'verify',
            args: {
              claims: [
                // 源格在 x=5，镜像到 2*8-5 = 11；两边朝向必须相反
                { check: 'block_at', pos: [11, 1, 3], expect: 'minecraft:oak_stairs[facing=west]' },
                { check: 'block_at', pos: [5, 1, 3], expect: 'minecraft:oak_stairs[facing=east]' },
              ],
            },
          },
        ],
      },
      { text: '两边都朝外，符合对称。' },
    ])

    expect(stopReason).toBe('completed')
    expect(blockAt(session, 11, 1, 3)).toContain('facing=west')
    expect(blockAt(session, 5, 1, 3)).toContain('facing=east')
    // 地板镜像后是完整的 16x8
    expect(session.store.stats().blocks).toBe(16 * 8 + 2)
  })

  it('镜像一座门：合页左右互换', async () => {
    const session = makeSession()
    await run(session, [
      {
        toolCalls: [
          { name: 'place_block', args: { pos: [1, 1, 1], block: 'minecraft:oak_door[facing=north,hinge=left,half=lower]' } },
          { name: 'symmetrize', args: { axis: 'x', coordinate: 4, source: 'negative', confirm: true } },
        ],
      },
      { text: '好了。' },
    ])
    // 1 → 2*4-1 = 7
    expect(blockAt(session, 7, 1, 1)).toContain('hinge=right')
    expect(blockAt(session, 7, 1, 1)).toContain('facing=north')
  })
})

describe('M6 端到端：复制旋转一座塔', () => {
  it('**同一块复制四次转四个角，楼梯朝向各不相同**', async () => {
    const session = makeSession()
    const { stopReason } = await run(session, [
      {
        toolCalls: [
          {
            name: 'run_batch',
            args: {
              ops: [
                // 1x1 的"塔角"：一块朝北的楼梯 + 一根柱子
                { tool: 'place_block', args: { pos: [0, 0, 0], block: 'minecraft:oak_stairs[facing=north]' } },
                { tool: 'place_block', args: { pos: [0, 1, 0], block: 'minecraft:stone_bricks' } },
              ],
              confirm: true,
            },
          },
        ],
      },
      { toolCalls: [{ name: 'copy_region', args: { from: [0, 0, 0], to: [0, 1, 0] } }] },
      {
        toolCalls: [
          {
            name: 'run_batch',
            args: {
              ops: [
                { tool: 'paste_region', args: { at: [8, 0, 0], rotate: 90 } },
                { tool: 'paste_region', args: { at: [8, 0, 8], rotate: 180 } },
                { tool: 'paste_region', args: { at: [0, 0, 8], rotate: 270 } },
              ],
              confirm: true,
            },
          },
        ],
      },
      {
        toolCalls: [
          {
            name: 'verify',
            args: {
              claims: [
                { check: 'block_at', pos: [8, 0, 0], expect: 'minecraft:oak_stairs[facing=east]' },
                { check: 'block_at', pos: [8, 0, 8], expect: 'minecraft:oak_stairs[facing=south]' },
                { check: 'block_at', pos: [0, 0, 8], expect: 'minecraft:oak_stairs[facing=west]' },
              ],
            },
          },
        ],
      },
      { text: '四个角都朝外。' },
    ])

    expect(stopReason).toBe('completed')
    expect(blockAt(session, 8, 0, 0)).toContain('facing=east')
    expect(blockAt(session, 8, 0, 8)).toContain('facing=south')
    expect(blockAt(session, 0, 0, 8)).toContain('facing=west')
    // 柱子也一起复制过来了
    expect(blockAt(session, 8, 1, 0)).toBe('stone_bricks')
    expect(blockAt(session, 0, 1, 8)).toBe('stone_bricks')
  })

  it('replace_blocks 一次性给整栋楼换材质，不重建', async () => {
    const session = makeSession()
    const { stopReason } = await run(session, [
      {
        toolCalls: [
          {
            name: 'run_batch',
            args: {
              ops: [
                { tool: 'fill_box', args: { from: [0, 0, 0], to: [7, 0, 7], block: 'minecraft:oak_planks' } },
                { tool: 'fill_box', args: { from: [0, 1, 0], to: [7, 3, 0], block: 'minecraft:oak_log' } },
              ],
              confirm: true,
            },
          },
        ],
      },
      {
        toolCalls: [
          {
            name: 'replace_blocks',
            args: {
              from: [0, 0, 0],
              to: [7, 3, 7],
              blocks: ['oak_planks', 'oak_log'],
              with: 'minecraft:spruce_planks',
              confirm: true,
            },
          },
        ],
      },
      { toolCalls: [{ name: 'verify', args: { claims: [{ check: 'block_at', pos: [0, 0, 0], expect: 'minecraft:spruce_planks' }] } }] },
      { text: '换成云杉了。' },
    ])

    expect(stopReason).toBe('completed')
    expect(blockAt(session, 0, 0, 0)).toBe('spruce_planks')
    expect(blockAt(session, 0, 3, 0)).toBe('spruce_planks')
    // 只有两步改动世界（批量铺 + 换材质）
    expect(session.log.length).toBe(2)
  })
})

describe('M6：完成闸门把批处理也算作"改过东西"', () => {
  it('只调 run_batch 就声称完成 → 会被要求先 verify', async () => {
    const session = makeSession()
    const { events, stopReason } = await run(session, [
      {
        toolCalls: [
          {
            name: 'run_batch',
            args: {
              ops: [{ tool: 'fill_box', args: { from: [0, 0, 0], to: [3, 0, 3], block: 'minecraft:stone' } }],
              confirm: true,
            },
          },
        ],
      },
      { text: '我盖好了。' },
      { text: '好吧，我核对了。' },
    ])
    expect(events.filter((event) => event.type === 'nudge').length).toBeGreaterThan(0)
    expect(stopReason).toBe('unverified')
  })
})

describe('M6 端到端：linter 抓出预埋的结构问题并指导修复', () => {
  it('**建 → 体检 → 修 → 再体检 → 通过**，闸门只在问题清零后才放行', async () => {
    const session = makeSession()
    const { stopReason, events } = await run(session, [
      {
        toolCalls: [
          {
            name: 'run_batch',
            args: {
              ops: [
                // 一间 5x5 的密封小屋：地板 + 四面墙 + 屋顶。
                // 墙必须用 extrude(hollow) 而不是 fill_box(mode=hollow)——后者的"外壳"
                // 包含整个顶面和底面，3 格高的盒子掏完只剩 1 格净高，那不是房子。
                { tool: 'fill_box', args: { from: [0, 0, 0], to: [4, 0, 4], block: 'minecraft:oak_planks' } },
                {
                  tool: 'extrude',
                  args: {
                    points: [[0, 0], [4, 0], [4, 4], [0, 4]],
                    baseY: 1,
                    height: 3,
                    block: 'minecraft:stone_bricks',
                    hollow: true,
                    capTop: false,
                    capBottom: false,
                  },
                },
                { tool: 'fill_box', args: { from: [0, 4, 0], to: [4, 4, 4], block: 'minecraft:birch_planks' } },
                // 墙上开一个 1 格高的洞 → linter 会提醒（warn，不拦闸门）
                { tool: 'erase', args: { from: [2, 1, 0], to: [2, 1, 0] } },
                // 一间堵死的门：上半扇上面还压着方块
                { tool: 'place_block', args: { pos: [0, 1, 2], block: 'minecraft:oak_door[facing=east,half=lower]' } },
                { tool: 'place_block', args: { pos: [0, 2, 2], block: 'minecraft:oak_door[facing=east,half=upper]' } },
                // 一块完全悬空的平台，扔在远处
                { tool: 'fill_box', args: { from: [12, 8, 12], to: [14, 8, 14], block: 'minecraft:gold_block' } },
              ],
              confirm: true,
            },
          },
        ],
      },
      // 第一次体检：发现问题
      { toolCalls: [{ name: 'analyze_structure', args: {} }] },
      { text: '有三个问题，我来修。' },
      // 修：把洞开够高（变成能走人的门），并拿掉那块悬空平台
      {
        toolCalls: [
          {
            name: 'run_batch',
            args: {
              ops: [
                { tool: 'erase', args: { from: [2, 2, 0], to: [2, 2, 0] } },
                { tool: 'erase', args: { from: [12, 8, 12], to: [14, 8, 14] } },
              ],
              confirm: true,
            },
          },
        ],
      },
      // 第二次体检：干净了，闸门放行
      { toolCalls: [{ name: 'analyze_structure', args: {} }] },
      { text: '结构检查通过，门也能走过去了。' },
    ])

    expect(stopReason).toBe('completed')
    const analyses = events.filter(
      (event): event is Extract<AgentEvent, { type: 'tool_result' }> =>
        event.type === 'tool_result' && event.name === 'analyze_structure',
    )
    expect(analyses).toHaveLength(2)

    // 第一次：悬空平台必须被报出来（这正是默认 region = 内容包围盒时最容易漏的那种）
    const first = analyses[0]!
    expect(first.result.data?.['errors']).toBeGreaterThan(0)
    const firstFindings = first.result.data?.['findings'] as Array<{ id: string; count: number }>
    expect(firstFindings.some((entry) => entry.id === 'floating' && entry.count === 9)).toBe(true)
    expect(firstFindings.some((entry) => entry.id === 'doorway')).toBe(true)
    // 第二次：error 清零
    const second = analyses[1]!
    expect(second.result.data?.['errors']).toBe(0)
    expect(second.result.data?.['readback']).toBe(true)
    expect(second.result.data?.['score'] as number).toBeGreaterThan(first.result.data?.['score'] as number)

    // linter 是只读的：跑两次都没涨 revision
    const before = session.store.revision
    await session.registry.call(session.ctx, 'analyze_structure', {})
    expect(session.store.revision).toBe(before)
  })

  it('**吊挂物不算悬空**：下面空着但上面挂着是合法的（灯笼、链子、挂式告示牌）', async () => {
    const session = makeSession()
    // 一根柱子撑起一根横梁，再从横梁上吊下链子和灯笼。
    // 关键：灯笼那一列**下面全是空气**，它唯一的支撑来自正上方——
    // 只看下方的判据会把它误报成悬空（而悬空是 error，会把闸门卡死）。
    const call = (args: Record<string, unknown>, name = 'place_block') =>
      session.registry.call(session.ctx, name, args)
    await call({ from: [0, 0, 0], to: [0, 4, 0], block: 'minecraft:oak_log', confirm: true }, 'fill_box')
    await call({ from: [0, 5, 0], to: [1, 5, 0], block: 'minecraft:oak_planks', confirm: true }, 'fill_box')
    await call({ pos: [1, 4, 0], block: 'minecraft:chain[axis=y]' })
    await call({ pos: [1, 3, 0], block: 'minecraft:lantern[hanging=true]' })

    const report = await call({}, 'analyze_structure')
    expect(report.ok).toBe(true)
    expect(report.data?.['errors']).toBe(0)
    expect(report.data?.['readback']).toBe(true)
    const findings = report.data?.['findings'] as Array<{ id: string }>
    expect(findings.some((entry) => entry.id === 'floating')).toBe(false)

    // 对照：把链子拿掉，灯笼就真的悬空了 → 必须报出来
    await call({ from: [1, 4, 0], to: [1, 4, 0] }, 'erase')
    const after = await call({}, 'analyze_structure')
    expect(after.data?.['errors']).toBe(1)
  })

  it('修掉悬空之后 linter 的 floating 消失，score 回升', async () => {
    const session = makeSession()
    await run(session, [
      {
        toolCalls: [
          {
            name: 'run_batch',
            args: {
              ops: [
                { tool: 'fill_box', args: { from: [12, 8, 12], to: [14, 8, 14], block: 'minecraft:gold_block' } },
              ],
              confirm: true,
            },
          },
        ],
      },
      { text: '先记下来。' },
    ])

    const before = await session.registry.call(session.ctx, 'analyze_structure', {})
    const beforeScore = before.data?.['score'] as number
    const beforeFindings = before.data?.['findings'] as Array<{ id: string }>
    expect(beforeFindings.some((entry) => entry.id === 'floating')).toBe(true)

    // 从平台往下打一根柱子撑到地面
    await session.registry.call(session.ctx, 'fill_box', {
      from: [13, 0, 13],
      to: [13, 7, 13],
      block: 'minecraft:oak_log',
      confirm: true,
    })

    const after = await session.registry.call(session.ctx, 'analyze_structure', {})
    const afterFindings = after.data?.['findings'] as Array<{ id: string; count: number }>
    // 只剩中间那一列有支撑了
    const floating = afterFindings.find((entry) => entry.id === 'floating')
    expect(floating?.count).toBe(8)
    expect(after.data?.['score'] as number).toBeGreaterThan(beforeScore)
  })
})
