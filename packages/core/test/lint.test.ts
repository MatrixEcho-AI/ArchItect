import { describe, expect, it } from 'vitest'

import { forEachBox } from '../src/geometry/box.js'
import { lintStructure } from '../src/inspect/lint.js'
import type { LintFinding, LintFindingId, LintReport } from '../src/inspect/lint.js'
import type { PlacedBlockEntity, PlacedEntity } from '../src/entity/types.js'
import type { Bounds, Pos } from '../src/types.js'
import { WorldStore } from '../src/world/store.js'

/**
 * 建筑 linter 的测试。
 *
 * fixture 全部用 `WorldStore` + 几何算子**在代码里搭出来**，刻意包含全部七类问题；
 * 断言按稳定的 finding id 做，计数只在语义明确的地方写死。
 */

const volume: Bounds = { min: { x: 0, y: 0, z: 0 }, max: { x: 31, y: 31, z: 31 } }

const makeStore = (): WorldStore => new WorldStore({ minecraftVersion: '1.21.4', volume })

type BoxMode = 'solid' | 'hollow' | 'outline'

function fill(store: WorldStore, from: Pos, to: Pos, block: string, mode: BoxMode = 'solid'): void {
  store.write((v) => forEachBox(from, to, mode, v), store.palette.indexOf(block), { confirm: true })
}

function clear(store: WorldStore, from: Pos, to: Pos): void {
  store.write((v) => forEachBox(from, to, 'solid', v), 0, { mode: 'destroy', confirm: true })
}

function finding(report: LintReport, id: LintFindingId): LintFinding | undefined {
  return report.findings.find((entry) => entry.id === id)
}

const PLANKS = 'minecraft:oak_planks'
const BRICKS = 'minecraft:stone_bricks'

/**
 * 刻意包含全部七类问题的世界：
 *
 * - 9×9 的**密封小屋**：地板 + 四面墙 + 屋顶；内部加一片假天花板制造 1 格净高的爬行空间
 *   （headroom）。
 * - 5×5 的**棚子**：南墙开一个 1 格高的洞（doorway），内部因此和外面连通（leaky）。
 * - 一段**地面平台 + 高处的横板**：横板同一列下方有平台所以不算悬空，但 y-1 层附近没有任何支撑
 *   （cantilever）。
 * - **孤立方块** (4,4,12)：同列下方什么都没有（floating）；它又刚好离小屋屋顶 4 格，
 *   所以不触发悬挑。
 * - 一个单独使用的 `diamond_block`（palette 的「少于 3 格」）。
 * - 整体左右/前后都不对称（symmetry）。
 *
 * 期望计数：floating=1、cantilever=4、doorway=1、headroom=7、leaky=27、palette=3。
 */
function buildProblemWorld(store: WorldStore): void {
  // ── 密封小屋 x0..8 / z0..8 ─────────────────────────────────────
  fill(store, { x: 0, y: 0, z: 0 }, { x: 8, y: 0, z: 8 }, PLANKS) // 地板
  fill(store, { x: 0, y: 1, z: 0 }, { x: 8, y: 2, z: 0 }, BRICKS) // 北墙
  fill(store, { x: 0, y: 1, z: 8 }, { x: 8, y: 2, z: 8 }, BRICKS) // 南墙
  fill(store, { x: 0, y: 1, z: 1 }, { x: 0, y: 2, z: 7 }, BRICKS) // 西墙
  fill(store, { x: 8, y: 1, z: 1 }, { x: 8, y: 2, z: 7 }, BRICKS) // 东墙
  fill(store, { x: 0, y: 3, z: 0 }, { x: 8, y: 3, z: 8 }, BRICKS) // 屋顶
  fill(store, { x: 1, y: 2, z: 1 }, { x: 2, y: 2, z: 3 }, BRICKS) // 假天花板：制造 1 格净高

  // ── 棚子 x12..16 / z0..4，南墙一个 1 格高的门洞 ─────────────────
  fill(store, { x: 12, y: 0, z: 0 }, { x: 16, y: 0, z: 4 }, PLANKS)
  fill(store, { x: 12, y: 1, z: 0 }, { x: 16, y: 2, z: 0 }, BRICKS)
  fill(store, { x: 12, y: 1, z: 4 }, { x: 16, y: 2, z: 4 }, BRICKS)
  fill(store, { x: 12, y: 1, z: 1 }, { x: 12, y: 2, z: 3 }, BRICKS)
  fill(store, { x: 16, y: 1, z: 1 }, { x: 16, y: 2, z: 3 }, BRICKS)
  fill(store, { x: 12, y: 3, z: 0 }, { x: 16, y: 3, z: 4 }, BRICKS)
  clear(store, { x: 14, y: 1, z: 0 }, { x: 14, y: 1, z: 0 })

  // ── 平台 + 高处横板：制造悬挑 ─────────────────────────────────
  fill(store, { x: 20, y: 0, z: 20 }, { x: 23, y: 0, z: 20 }, BRICKS)
  fill(store, { x: 20, y: 3, z: 20 }, { x: 23, y: 3, z: 20 }, BRICKS)

  // ── 悬空方块（同列下方为空，且 y-1 层 4 格处有小屋顶 → 不算悬挑） ─
  fill(store, { x: 4, y: 4, z: 12 }, { x: 4, y: 4, z: 12 }, BRICKS)

  // ── 只出现一次的材料 ─────────────────────────────────────────
  fill(store, { x: 28, y: 0, z: 4 }, { x: 28, y: 0, z: 4 }, 'minecraft:diamond_block')
}

/** 干净小屋：密封、对称、层高 2，没有任何 error/warn。 */
function buildCleanHut(store: WorldStore): void {
  fill(store, { x: 0, y: 0, z: 0 }, { x: 4, y: 0, z: 4 }, PLANKS)
  fill(store, { x: 0, y: 1, z: 0 }, { x: 4, y: 2, z: 0 }, BRICKS)
  fill(store, { x: 0, y: 1, z: 4 }, { x: 4, y: 2, z: 4 }, BRICKS)
  fill(store, { x: 0, y: 1, z: 1 }, { x: 0, y: 2, z: 3 }, BRICKS)
  fill(store, { x: 4, y: 1, z: 1 }, { x: 4, y: 2, z: 3 }, BRICKS)
  fill(store, { x: 0, y: 3, z: 0 }, { x: 4, y: 3, z: 4 }, BRICKS)
}

describe('analyze_structure：建筑 linter', () => {
  it('刻意包含全部七类问题的世界：每一项都能按 id 抓到，计数正确', () => {
    const store = makeStore()
    buildProblemWorld(store)

    const report = lintStructure(store)

    const floating = finding(report, 'floating')
    expect(floating).toBeDefined()
    expect(floating!.severity).toBe('error')
    expect(floating!.count).toBe(1)
    expect(floating!.samples).toEqual([{ x: 4, y: 4, z: 12 }])
    // 悬空的说明必须如实写出"空碰撞形状的方块被排除"
    expect(floating!.summary).toContain('collision shape list is empty')

    const cantilever = finding(report, 'cantilever')
    expect(cantilever).toBeDefined()
    expect(cantilever!.severity).toBe('warn')
    expect(cantilever!.count).toBe(4) // 平台上方那 4 格横板
    expect(cantilever!.samples.every((p) => p.y === 3)).toBe(true)

    const doorway = finding(report, 'doorway')
    expect(doorway).toBeDefined()
    // doorway 是 warn：这道检查分不清有意的通道和故意开的小窗
    expect(doorway!.severity).toBe('warn')
    expect(doorway!.count).toBe(1)
    expect(doorway!.samples).toEqual([{ x: 14, y: 1, z: 0 }])

    const headroom = finding(report, 'headroom')
    expect(headroom).toBeDefined()
    expect(headroom!.severity).toBe('warn')
    expect(headroom!.count).toBe(7) // 假天花板下方 6 格 + 门洞下方 1 格

    const leaky = finding(report, 'leaky')
    expect(leaky).toBeDefined()
    expect(leaky!.severity).toBe('warn')
    expect(leaky!.count).toBe(27) // 棚子内部 18 + 门洞 1 + 平台夹层 8

    const palette = finding(report, 'palette')
    expect(palette).toBeDefined()
    expect(palette!.severity).toBe('info')
    expect(palette!.count).toBe(3) // oak_planks / stone_bricks / diamond_block
    expect(palette!.summary).toContain('diamond_block')
    expect(palette!.summary).toContain('fewer than 3 cells')

    const symmetry = finding(report, 'symmetry')
    expect(symmetry).toBeDefined()
    expect(symmetry!.severity).toBe('info')
    expect(symmetry!.count).toBeGreaterThan(0)

    // 每条 finding 的样本都不超过 8 个
    for (const entry of report.findings) expect(entry.samples.length).toBeLessThanOrEqual(8)

    // score 公式：floating 1×2（error）+ doorway 1×1 + cantilever 4×1 + headroom 7×1 + leaky 封顶 15 = 29
    expect(report.score).toBe(71)
  })

  it('干净的小屋没有任何 error/warn，score 100，且给出调色板与对称性信息', () => {
    const store = makeStore()
    buildCleanHut(store)

    const report = lintStructure(store)
    const bad = report.findings.filter((entry) => entry.severity !== 'info')
    expect(bad.map((entry) => `${entry.id}:${entry.count}`)).toEqual([])
    expect(report.score).toBe(100)

    const symmetry = finding(report, 'symmetry')
    expect(symmetry).toBeDefined()
    expect(symmetry!.count).toBe(0)
    expect(symmetry!.summary).toContain('100%')

    const palette = finding(report, 'palette')
    expect(palette).toBeDefined()
    expect(palette!.count).toBe(2)

    expect(report.blocks).toBeGreaterThan(0)
    // 密封的小屋不该被判漏水
    expect(finding(report, 'leaky')).toBeUndefined()
  })

  it('悬空用整列判据：同列下方有东西就不算悬空', () => {
    const store = makeStore()
    fill(store, { x: 5, y: 0, z: 5 }, { x: 5, y: 0, z: 7 }, PLANKS)
    fill(store, { x: 5, y: 4, z: 5 }, { x: 5, y: 4, z: 5 }, BRICKS)

    const report = lintStructure(store)
    expect(finding(report, 'floating')).toBeUndefined()
  })

  it('空碰撞形状的方块（火把、植物）不算悬空、也不算悬挑', () => {
    const store = makeStore()
    store.setBlock({ x: 5, y: 5, z: 5 }, 'minecraft:torch')
    store.setBlock({ x: 8, y: 5, z: 8 }, 'minecraft:oak_sapling')

    const report = lintStructure(store)
    expect(finding(report, 'floating')).toBeUndefined()
    expect(finding(report, 'cantilever')).toBeUndefined()
    // 它们仍然计入调色板
    expect(finding(report, 'palette')!.count).toBe(2)
  })

  it('**完整的门上方压着墙不算问题**（回归：判据方向曾经是反的）', () => {
    const store = makeStore()
    fill(store, { x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 0 }, PLANKS)
    store.setBlock({ x: 0, y: 1, z: 0 }, 'minecraft:oak_door[half=lower,facing=south]')
    store.setBlock({ x: 0, y: 2, z: 0 }, 'minecraft:oak_door[half=upper,facing=south]')
    // 门上面当然是墙——所有正常门都这样
    fill(store, { x: 0, y: 3, z: 0 }, { x: 0, y: 3, z: 0 }, BRICKS)

    expect(finding(lintStructure(store), 'doorway')).toBeUndefined()
  })

  it('**残门**（下半扇上面不是上半扇）算 doorway 问题', () => {
    const store = makeStore()
    fill(store, { x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 0 }, PLANKS)
    store.setBlock({ x: 0, y: 1, z: 0 }, 'minecraft:oak_door[half=lower,facing=south]')
    // 上半扇缺失
    fill(store, { x: 0, y: 3, z: 0 }, { x: 0, y: 3, z: 0 }, BRICKS)

    const doorway = finding(lintStructure(store), 'doorway')
    expect(doorway).toBeDefined()
    expect(doorway!.samples).toContainEqual({ x: 0, y: 1, z: 0 })
  })

  it('doorway 是 warn 而不是 error：分不清"有意的通道"和"小窗"，不该拦闸门', () => {
    const store = makeStore()
    fill(store, { x: 0, y: 0, z: 0 }, { x: 4, y: 0, z: 0 }, PLANKS)
    fill(store, { x: 0, y: 1, z: 0 }, { x: 4, y: 3, z: 0 }, BRICKS)
    // 墙上开一个 1 格高的洞——像个小窗，也像一条太矮的通道
    clear(store, { x: 2, y: 2, z: 0 }, { x: 2, y: 2, z: 0 })

    const doorway = finding(lintStructure(store), 'doorway')
    expect(doorway?.severity).toBe('warn')
    expect(doorway?.samples).toContainEqual({ x: 2, y: 2, z: 0 })
    // 它不进 error，所以不会把完成闸门卡死
    expect(lintStructure(store).findings.filter((f) => f.severity === 'error')).toEqual([])
  })

  it('samples 有上限（≤8）且与遍历顺序无关（确定性）', () => {
    const store = makeStore()
    fill(store, { x: 0, y: 10, z: 0 }, { x: 19, y: 10, z: 0 }, BRICKS)

    // 显式给一个包含地面的范围：默认 range 的最低一层会被当作"地面"而豁免
    const options = { region: volume }
    const first = lintStructure(store, options)
    const second = lintStructure(store, options)
    expect(first).toEqual(second)

    const floating = finding(first, 'floating')!
    expect(floating.count).toBe(20)
    expect(floating.samples).toHaveLength(8)
    // 按 (y,x,z) 取最小的 8 个 → x = 0..7
    expect(floating.samples.map((p) => p.x)).toEqual([0, 1, 2, 3, 4, 5, 6, 7])
  })

  it('阈值选项生效：maxOverhang / minDoorClearance / minHeadroom', () => {
    const bigOverhang = makeStore()
    buildProblemWorld(bigOverhang)
    const tolerant = lintStructure(bigOverhang, { maxOverhang: 20 })
    expect(finding(tolerant, 'cantilever')).toBeUndefined()

    const strictDoor = makeStore()
    buildProblemWorld(strictDoor)
    const noDoorCheck = lintStructure(strictDoor, { minDoorClearance: 1 })
    expect(finding(noDoorCheck, 'doorway')).toBeUndefined()

    const laxHeadroom = makeStore()
    buildProblemWorld(laxHeadroom)
    const noHeadroomCheck = lintStructure(laxHeadroom, { minHeadroom: 1 })
    expect(finding(noHeadroomCheck, 'headroom')).toBeUndefined()
  })

  it('region 选项把分析限制在给定范围内', () => {
    const store = makeStore()
    buildProblemWorld(store)

    const region: Bounds = { min: { x: 12, y: 0, z: 0 }, max: { x: 16, y: 3, z: 4 } }
    const report = lintStructure(store, { region })
    expect(report.region).toEqual(region)
    expect(report.blocks).toBe(81) // 棚子去掉 1 格门洞
    expect(finding(report, 'floating')).toBeUndefined() // 小屋外的悬空方块被排除
    expect(finding(report, 'doorway')!.count).toBe(1)
    expect(finding(report, 'headroom')!.count).toBe(1)
    expect(finding(report, 'cantilever')).toBeUndefined()
  })

  it('score 随 error 递减：孤立方块同时是 floating(error) + cantilever(warn) → 97', () => {
    const store = makeStore()
    fill(store, { x: 10, y: 8, z: 10 }, { x: 10, y: 8, z: 10 }, BRICKS)
    const report = lintStructure(store, { region: volume })
    expect(finding(report, 'floating')!.count).toBe(1)
    // 孤立方块 y-1 层附近也没有支撑，所以同时命中 cantilever
    expect(finding(report, 'cantilever')!.count).toBe(1)
    // 100 - min(30, 2×1) - min(15, 1×1) = 97
    expect(report.score).toBe(97)
  })

  it('空世界：没有 findings、满分、region 回落到工区', () => {
    const report = lintStructure(makeStore())
    expect(report.blocks).toBe(0)
    expect(report.findings).toEqual([])
    expect(report.score).toBe(100)
    expect(report.region).toEqual(volume)
  })
})

describe('悬空判据：地面是工区底板，不是分析范围的底（回归）', () => {
  it('**一块孤零零的悬空平台必须被抓到**——它自己就是内容包围盒的最低层', () => {
    const store = makeStore()
    // 在 y=10 凭空铺一块 5x5 的平台，下面什么都没有。
    // 默认分析范围是内容包围盒，其 min.y 恰好是 10；如果拿"范围最低层"当地面，
    // 这里就会报 0 块悬空——而那正是这个检查唯一该抓到的情形。
    fill(store, { x: 2, y: 10, z: 2 }, { x: 6, y: 10, z: 6 }, PLANKS)

    const report = lintStructure(store)
    const floating = finding(report, 'floating')
    expect(floating).toBeDefined()
    expect(floating?.severity).toBe('error')
    // 25 根柱子，每根的最低格都没有支撑
    expect(floating?.count).toBe(25)
    expect(floating?.samples.length).toBeGreaterThan(0)
    expect(report.score).toBeLessThan(100)
  })

  it('架在柱子上的平台不报悬空（整列判据）', () => {
    const store = makeStore()
    fill(store, { x: 2, y: 0, z: 2 }, { x: 2, y: 9, z: 2 }, BRICKS)
    fill(store, { x: 2, y: 10, z: 2 }, { x: 6, y: 10, z: 6 }, PLANKS)

    const report = lintStructure(store)
    // 只有 (2,2) 那一列有柱子；其余 24 列仍然悬空
    expect(finding(report, 'floating')?.count).toBe(24)
  })

  it('坐在工区底板上的建筑不算悬空', () => {
    const store = makeStore()
    fill(store, { x: 0, y: 0, z: 0 }, { x: 7, y: 0, z: 7 }, PLANKS)
    fill(store, { x: 0, y: 1, z: 0 }, { x: 7, y: 3, z: 0 }, BRICKS)
    const report = lintStructure(store)
    expect(finding(report, 'floating')).toBeUndefined()
  })

  it('**只分析上半截时，下面（范围之外）的楼板仍然算支撑**', () => {
    const store = makeStore()
    fill(store, { x: 0, y: 0, z: 0 }, { x: 7, y: 4, z: 7 }, BRICKS)
    fill(store, { x: 0, y: 5, z: 0 }, { x: 7, y: 5, z: 7 }, PLANKS)

    // 只分析 y=5..5：那一层的最低格在 y=5，但它下面 y=0..4 全是实心
    const report = lintStructure(store, { region: { min: { x: 0, y: 5, z: 0 }, max: { x: 7, y: 5, z: 7 } } })
    expect(finding(report, 'floating')).toBeUndefined()
  })

  it('region 之外的悬空方块不计入（范围真的生效）', () => {
    const store = makeStore()
    fill(store, { x: 20, y: 10, z: 20 }, { x: 22, y: 10, z: 22 }, PLANKS)
    fill(store, { x: 0, y: 0, z: 0 }, { x: 4, y: 0, z: 4 }, BRICKS)

    const report = lintStructure(store, { region: { min: { x: 0, y: 0, z: 0 }, max: { x: 8, y: 8, z: 8 } } })
    expect(finding(report, 'floating')).toBeUndefined()
  })
})

/**
 * 稀疏层（实体与方块实体）的五条判据（plan §18.9）。
 *
 * 每条都配**正例与反例**：附录 D 的教训是"判据含糊的检查会在两个方向上都出错"，
 * 只测正例的话，一条永远返回真的检查也能通过。
 */
describe('lint：实体与方块实体（另外两层）', () => {
  const boat = (id: string, x: number, y: number, z: number): PlacedEntity => ({
    id,
    type: 'minecraft:oak_boat',
    x,
    y,
    z,
    yaw: 0,
  })

  const put = (store: WorldStore, entity: PlacedEntity): void => {
    const change = store.entities.set(entity)
    if (change !== undefined) store.commitSparse({ entities: [change] })
  }

  const putBlockEntity = (store: WorldStore, entry: PlacedBlockEntity): void => {
    const change = store.blockEntities.set(entry)
    if (change !== undefined) store.commitSparse({ blockEntities: [change] })
  }

  it('`entity_embedded`：砌进方块里的实体报，站在地板上方的不报', () => {
    const store = makeStore()
    fill(store, { x: 0, y: 0, z: 0 }, { x: 7, y: 0, z: 7 }, PLANKS)
    // 正例：at.y 用了地板自己的那一层 → 实体中心落在地板里
    put(store, boat('e_1_1', 2.5, 0.5, 2.5))
    // 反例：站在地板**上方**的那一格
    put(store, boat('e_1_2', 4.5, 1.5, 4.5))

    // 显式给范围，让两个实体都落在分析范围内——否则上面那条反例会被
    // 归到 `entity_outside`，这里就变成了"没报出来是因为没看它"
    const bounds = { min: { x: 0, y: 0, z: 0 }, max: { x: 7, y: 2, z: 7 } }
    const report = lintStructure(store, { region: bounds })
    expect(finding(report, 'entity_embedded')?.count).toBe(1)
    expect(finding(report, 'entity_embedded')?.samples).toEqual([{ x: 2, y: 0, z: 2 }])
  })

  it('`entity_embedded` 的反例：水里的船不算"砌进墙里"（水没有碰撞盒）', () => {
    const store = makeStore()
    fill(store, { x: 0, y: 0, z: 0 }, { x: 7, y: 0, z: 7 }, 'minecraft:water')
    put(store, boat('e_1_1', 2.5, 0.5, 2.5))
    expect(finding(lintStructure(store), 'entity_embedded')).toBeUndefined()
  })

  it('`entity_duplicate`：同格同类型两次报，同格不同类型不报', () => {
    const store = makeStore()
    fill(store, { x: 0, y: 0, z: 0 }, { x: 7, y: 0, z: 7 }, PLANKS)
    put(store, boat('e_1_1', 2.5, 0.5, 2.5))
    put(store, boat('e_1_2', 2.7, 0.5, 2.5)) // 同一格、同一类型 → 重复
    put(store, { id: 'e_1_3', type: 'minecraft:armor_stand', x: 2.5, y: 0.5, z: 2.5, yaw: 0 })
    put(store, boat('e_1_4', 4.5, 0.5, 4.5)) // 另一格

    const report = lintStructure(store)
    expect(finding(report, 'entity_duplicate')?.count).toBe(1)
  })

  it('`entity_outside`：分析范围之外的实体被如实报出来，且不扣分（info）', () => {
    const store = makeStore()
    fill(store, { x: 0, y: 0, z: 0 }, { x: 7, y: 0, z: 7 }, PLANKS)
    put(store, boat('e_1_1', 20.5, 0.5, 20.5))
    // 范围默认取**方块**内容包围盒，所以界外的实体落在这一条里
    const report = lintStructure(store)
    const found = finding(report, 'entity_outside')
    expect(found?.count).toBe(1)
    expect(found?.severity).toBe('info')
    expect(report.score).toBe(100)
  })

  it('`blockentity_orphan`：方块换掉之后残留的方块实体是 error', () => {
    const store = makeStore()
    fill(store, { x: 0, y: 0, z: 0 }, { x: 7, y: 0, z: 7 }, PLANKS)
    // 反例：kind 与方块相符
    putBlockEntity(store, { x: 1, y: 1, z: 1, kind: 'minecraft:chest', data: { Items: [] } })
    fill(store, { x: 1, y: 1, z: 1 }, { x: 1, y: 1, z: 1 }, 'minecraft:chest')
    // 正例：直接往一块木板的位置塞一个 sign 的负载（正常路径进不来，只有坏数据会）
    putBlockEntity(store, { x: 2, y: 0, z: 2, kind: 'minecraft:sign', data: { front_text: {} } })

    const report = lintStructure(store)
    const found = finding(report, 'blockentity_orphan')
    expect(found?.severity).toBe('error')
    expect(found?.count).toBe(1)
    expect(found?.samples).toEqual([{ x: 2, y: 0, z: 2 }])
    expect(report.score).toBeLessThan(100)
  })

  it('`blockentity_empty`：空负载是 info，不扣分', () => {
    const store = makeStore()
    fill(store, { x: 0, y: 0, z: 0 }, { x: 7, y: 0, z: 0 }, 'minecraft:chest')
    putBlockEntity(store, { x: 1, y: 0, z: 0, kind: 'minecraft:chest', data: {} })
    putBlockEntity(store, { x: 2, y: 0, z: 0, kind: 'minecraft:chest', data: { Items: [] } })

    const report = lintStructure(store)
    const found = finding(report, 'blockentity_empty')
    expect(found?.severity).toBe('info')
    expect(found?.count).toBe(1)
    expect(report.score).toBe(100)
  })

  it('两条都**没有被报出来**时报告里没有这两个 id（不是"永远返回 0"）', () => {
    const store = makeStore()
    fill(store, { x: 0, y: 0, z: 0 }, { x: 3, y: 3, z: 3 }, BRICKS, 'hollow')
    const report = lintStructure(store)
    expect(report.findings.map((entry) => entry.id)).not.toContain('entity_embedded')
    expect(report.findings.map((entry) => entry.id)).not.toContain('blockentity_empty')
    expect(report.findings.map((entry) => entry.id)).not.toContain('entity_duplicate')
  })
})

describe('lint：`entity_outside` 的放宽（否则正常场景里每条都会被报）', () => {
  const put = (store: WorldStore, entity: PlacedEntity): void => {
    const change = store.entities.set(entity)
    if (change !== undefined) store.commitSparse({ entities: [change] })
  }

  it('**站在建筑顶上的实体不算"跑到范围外"**（默认范围是方块包围盒）', () => {
    const store = makeStore()
    fill(store, { x: 0, y: 0, z: 0 }, { x: 4, y: 0, z: 4 }, PLANKS)
    put(store, { id: 'e_1_1', type: 'minecraft:armor_stand', x: 2.5, y: 1.5, z: 2.5, yaw: 0 })
    expect(finding(lintStructure(store), 'entity_outside')).toBeUndefined()
  })

  it('**贴着建筑边缘外侧一格**也算在里面', () => {
    const store = makeStore()
    fill(store, { x: 0, y: 0, z: 0 }, { x: 4, y: 0, z: 4 }, PLANKS)
    put(store, { id: 'e_1_1', type: 'minecraft:oak_boat', x: 5.5, y: 0.5, z: 2.5, yaw: 0 })
    expect(finding(lintStructure(store), 'entity_outside')).toBeUndefined()
  })

  it('**远在界外**的实体照报', () => {
    const store = makeStore()
    fill(store, { x: 0, y: 0, z: 0 }, { x: 4, y: 0, z: 4 }, PLANKS)
    put(store, { id: 'e_1_1', type: 'minecraft:oak_boat', x: 12.5, y: 0.5, z: 2.5, yaw: 0 })
    expect(finding(lintStructure(store), 'entity_outside')?.count).toBe(1)
  })
})
