import { EditLog, ReplaySession, WorldStore } from '@architect/core'
import type { Bounds, Pos } from '@architect/core'
import { describe, expect, it } from 'vitest'

import { describeIssues, validateArgs } from '../src/schema.js'
import { analyzeStructureTool } from '../src/tools/analyze.js'
import type { ScreenshotRequest, ToolContext, ToolImage } from '../src/types.js'

/**
 * `analyze_structure` 工具层的测试。
 *
 * 重点是三件事：
 * 1. 它是**只读**的——不写方块、不递增 revision、不记 EditOp，也不碰截图注入点；
 * 2. 返回的文本是给 LLM 读的英文紧凑结果（样本坐标有上限）；
 * 3. `from` / `to` 参数和缺省行为符合契约。
 */

const volume: Bounds = { min: { x: 0, y: 0, z: 0 }, max: { x: 31, y: 31, z: 31 } }

const PLANKS = 'minecraft:oak_planks'
const BRICKS = 'minecraft:stone_bricks'

function makeContext(): ToolContext {
  const store = new WorldStore({ minecraftVersion: '1.21.4', volume })
  const log = new EditLog()
  return {
    store,
    log,
    history: new ReplaySession(store, log),
    clipboard: {},
    correlationId: 'turn_1',
    // 只读工具一旦写入就会被发现：这两个注入点直接抛错。
    record: () => {
      throw new Error('analyze_structure must not record an EditOp')
    },
    shoot: (_request: ScreenshotRequest): ToolImage => {
      throw new Error('analyze_structure must not take a screenshot')
    },
  }
}

function fill(store: WorldStore, from: Pos, to: Pos, block: string): void {
  store.write(
    (visit) => {
      for (let x = from.x; x <= to.x; x++) {
        for (let y = from.y; y <= to.y; y++) {
          for (let z = from.z; z <= to.z; z++) visit(x, y, z)
        }
      }
    },
    store.palette.indexOf(block),
    { confirm: true },
  )
}

/** 密封、对称、层高 2 的小屋：linter 应当零 error / 零 warn。 */
function buildCleanHut(store: WorldStore): void {
  fill(store, { x: 0, y: 0, z: 0 }, { x: 4, y: 0, z: 4 }, PLANKS)
  fill(store, { x: 0, y: 1, z: 0 }, { x: 4, y: 2, z: 0 }, BRICKS)
  fill(store, { x: 0, y: 1, z: 4 }, { x: 4, y: 2, z: 4 }, BRICKS)
  fill(store, { x: 0, y: 1, z: 1 }, { x: 0, y: 2, z: 3 }, BRICKS)
  fill(store, { x: 4, y: 1, z: 1 }, { x: 4, y: 2, z: 3 }, BRICKS)
  fill(store, { x: 0, y: 3, z: 0 }, { x: 4, y: 3, z: 4 }, BRICKS)
}

describe('analyze_structure 工具', () => {
  it('元数据：read-only、英文说明、schema 是对象', () => {
    expect(analyzeStructureTool.name).toBe('analyze_structure')
    expect(analyzeStructureTool.mutating).toBe(false)
    expect(analyzeStructureTool.destructive).toBe(false)
    expect(analyzeStructureTool.parameters.type).toBe('object')
    // 面向 LLM 的说明必须是英文（不能混入中文注释里的汉字）
    expect(analyzeStructureTool.description).not.toMatch(/[\u4e00-\u9fff]/)
    expect(analyzeStructureTool.description).toContain('floating')
    expect(analyzeStructureTool.description).toContain('leaky')
  })

  it('干净小屋：score 100、无 error/warn，且不写世界、不记历史、不截图', async () => {
    const ctx = makeContext()
    buildCleanHut(ctx.store)
    const revisionBefore = ctx.store.revision
    const hashBefore = ctx.store.contentHash()

    const result = await analyzeStructureTool.execute(ctx, {})

    expect(result.ok).toBe(true)
    expect(result.data?.score).toBe(100)
    expect(result.data?.errors).toBe(0)
    expect(result.data?.warnings).toBe(0)
    expect(result.summary).toContain('score 100/100')
    expect(result.summary).not.toMatch(/[\u4e00-\u9fff]/)

    // 只读：世界哈希、revision、历史都没变
    expect(ctx.store.revision).toBe(revisionBefore)
    expect(ctx.store.contentHash()).toBe(hashBefore)
    expect(ctx.log.length).toBe(0)
  })

  it('问题世界：summary 里出现 ERROR/WARN 条目，data 里有结构化 findings 与样本', async () => {
    const ctx = makeContext()
    buildCleanHut(ctx.store)
    // 孤立方块（floating + cantilever）与墙上的 1 格高门洞（doorway）
    fill(ctx.store, { x: 12, y: 5, z: 12 }, { x: 12, y: 5, z: 12 }, BRICKS)
    fill(ctx.store, { x: 20, y: 0, z: 0 }, { x: 24, y: 0, z: 4 }, PLANKS)
    fill(ctx.store, { x: 20, y: 1, z: 0 }, { x: 24, y: 2, z: 0 }, BRICKS)
    fill(ctx.store, { x: 20, y: 1, z: 4 }, { x: 24, y: 2, z: 4 }, BRICKS)
    fill(ctx.store, { x: 20, y: 1, z: 1 }, { x: 20, y: 2, z: 3 }, BRICKS)
    fill(ctx.store, { x: 24, y: 1, z: 1 }, { x: 24, y: 2, z: 3 }, BRICKS)
    fill(ctx.store, { x: 20, y: 3, z: 0 }, { x: 24, y: 3, z: 4 }, BRICKS)
    ctx.store.write(
      (visit) => {
        visit(22, 1, 0)
      },
      0,
      { mode: 'destroy', confirm: true },
    )

    const result = await analyzeStructureTool.execute(ctx, {})
    expect(result.ok).toBe(true)

    const findings = result.data?.findings as Array<{
      id: string
      severity: string
      count: number
      summary: string
      samples: number[][]
    }>
    expect(Array.isArray(findings)).toBe(true)
    expect(findings.map((entry) => entry.id)).toContain('floating')
    expect(findings.map((entry) => entry.id)).toContain('doorway')
    expect(result.data?.errors as number).toBeGreaterThan(0)
    expect(result.summary).toContain('ERROR floating')
    expect(result.summary).toContain('samples:')

    for (const entry of findings) {
      expect(entry.samples.length).toBeLessThanOrEqual(8)
      expect(entry.summary).not.toMatch(/[\u4e00-\u9fff]/)
    }
  })

  it('输出成本有上限：几百个问题也不会让 summary 爆长', async () => {
    const ctx = makeContext()
    fill(ctx.store, { x: 0, y: 8, z: 0 }, { x: 19, y: 8, z: 9 }, BRICKS) // 200 个悬空方块

    // 显式把范围拉到地面，否则内容最低一层会被当作"地面"而豁免
    const result = await analyzeStructureTool.execute(ctx, { from: [0, 0, 0], to: [31, 31, 31] })
    expect(result.ok).toBe(true)

    const floating = (result.data?.findings as Array<{ id: string; count: number; samples: number[][] }>).find(
      (entry) => entry.id === 'floating',
    )
    expect(floating!.count).toBe(200)
    // 计数代替完整清单：样本封顶 8 个，整段文本保持在很短的量级
    expect(floating!.samples).toHaveLength(8)
    expect(result.summary.length).toBeLessThan(2200)
  })

  it('from/to 必须成对给出，且能限定分析范围', async () => {
    const ctx = makeContext()
    buildCleanHut(ctx.store)

    const bad = await analyzeStructureTool.execute(ctx, { from: [0, 0, 0] })
    expect(bad.ok).toBe(false)
    expect(bad.error?.code).toBe('INVALID_ARGS')
    expect(bad.summary).not.toMatch(/[\u4e00-\u9fff]/)

    const scoped = await analyzeStructureTool.execute(ctx, { from: [0, 0, 0], to: [4, 3, 4] })
    expect(scoped.ok).toBe(true)
    expect(scoped.data?.region).toEqual([
      [0, 0, 0],
      [4, 3, 4],
    ])
    expect(scoped.data?.score).toBe(100)
  })

  it('阈值参数透传到 linter', async () => {
    const ctx = makeContext()
    buildCleanHut(ctx.store)

    const result = await analyzeStructureTool.execute(ctx, {
      minHeadroom: 4,
      minDoorClearance: 3,
      maxOverhang: 1,
    })
    expect(result.ok).toBe(true)
    // 层高 2 的小屋在 minHeadroom=4 下会被判净高不足
    const findings = result.data?.findings as Array<{ id: string; count: number }>
    expect(findings.find((entry) => entry.id === 'headroom')!.count).toBeGreaterThan(0)
  })

  it('另外两层的问题也走同一条输出：实体嵌进方块、箱子负载挂在被换掉的方块上', async () => {
    const ctx = makeContext()
    buildCleanHut(ctx.store)
    // 实体：中心落在小屋地板（y=0）里面
    const placed = ctx.store.entities.set({
      id: 'e_1_1',
      type: 'minecraft:oak_boat',
      x: 2.5,
      y: 0.5,
      z: 2.5,
      yaw: 0,
    })
    ctx.store.commitSparse({ entities: [placed!] })
    // 方块实体：往一块木板的位置塞一个告示牌的负载（正常路径进不来，只有坏数据会）
    const orphan = ctx.store.blockEntities.set({
      x: 1,
      y: 0,
      z: 1,
      kind: 'minecraft:sign',
      data: { front_text: {} },
    })
    ctx.store.commitSparse({ blockEntities: [orphan!] })

    const result = await analyzeStructureTool.execute(ctx, {})
    expect(result.ok).toBe(true)
    const findings = result.data?.findings as Array<{ id: string; severity: string; count: number }>
    expect(findings.map((entry) => entry.id)).toContain('entity_embedded')
    expect(findings.find((entry) => entry.id === 'blockentity_orphan')?.severity).toBe('error')
    // 英文摘要 + 进得了完成闸门（error 非零）
    expect(result.summary).toContain('ERROR blockentity_orphan')
    expect(result.summary).toContain('WARN entity_embedded')
    expect(result.summary).not.toMatch(/[\u4e00-\u9fff]/)
    expect(result.data?.errors as number).toBeGreaterThan(0)
  })

  it('schema 校验复用同一份定义：未知参数会被拒绝并列出合法字段', () => {
    const validated = validateArgs(analyzeStructureTool.parameters, { nope: 1 })
    expect(validated.ok).toBe(false)
    if (!validated.ok) {
      const text = describeIssues(validated.issues)
      expect(text).toContain('nope')
      expect(text).toContain('from')
      expect(text).toContain('maxOverhang')
    }
  })
})
