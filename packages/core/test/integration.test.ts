import { describe, expect, it } from 'vitest'

import { forEachBox } from '../src/geometry/box.js'
import { forEachLine } from '../src/geometry/line.js'
import { forEachPlane } from '../src/geometry/plane.js'
import { forEachExtrude } from '../src/geometry/polygon.js'
import { WorldStore } from '../src/world/store.js'
import { symmetrize } from '../src/world/symmetrize.js'
import type { Bounds, Pos } from '../src/types.js'

/**
 * 端到端：只用内核提供的几何算子盖一座房子。
 *
 * 这个文件不测某个函数对不对，而是测**这些工具能不能组合出一个真建筑**——
 * 也就是 M1 的验收标准。
 */

const volume: Bounds = { min: { x: -10, y: 0, z: -10 }, max: { x: 30, y: 30, z: 30 } }

const makeStore = (): WorldStore => new WorldStore({ minecraftVersion: '1.21.4', volume })

const rect = (
  x0: number,
  z0: number,
  x1: number,
  z1: number,
): Array<{ x: number; z: number }> => [
  { x: x0, z: z0 },
  { x: x1, z: z0 },
  { x: x1, z: z1 },
  { x: x0, z: z1 },
]

/** 房子的外框 0..10，墙厚 1，层高 5。 */
const FOOTPRINT = rect(0, 0, 10, 10)

function buildHouse(store: WorldStore): void {
  const planks = store.palette.indexOf('minecraft:oak_planks')
  const bricks = store.palette.indexOf('minecraft:stone_bricks')
  const glass = store.palette.indexOf('minecraft:glass')

  // 1. 地板（实心一层）
  store.write((v) => forEachExtrude(FOOTPRINT, { baseY: 0, height: 1 }, v), planks, { confirm: true })

  // 2. 墙（空心挤出，不封顶封底）
  store.write(
    (v) => forEachExtrude(FOOTPRINT, { baseY: 1, height: 4, hollow: true, capTop: false, capBottom: false }, v),
    bricks,
    { confirm: true },
  )

  // 3. 门：南墙 z=0 上开 1×2 的洞
  store.write((v) => forEachBox({ x: 5, y: 1, z: 0 }, { x: 5, y: 2, z: 0 }, 'solid', v), 0, {
    mode: 'destroy',
    confirm: true,
  })

  // 4. 窗：东西墙各一扇 2×1
  store.write((v) => forEachBox({ x: 0, y: 3, z: 4 }, { x: 0, y: 3, z: 5 }, 'solid', v), glass, {
    mode: 'replace',
    confirm: true,
  })

  // 5. 尖顶：两片斜面在 y=5 交汇，跨 z 方向
  const eavesY = 4
  const ridgeY = 8
  store.write(
    (v) => forEachPlane({ x: 0, y: eavesY, z: 0 }, { x: 10, y: eavesY, z: 0 }, { x: 5, y: ridgeY, z: 5 }, {}, v),
    bricks,
    { confirm: true },
  )
  store.write(
    (v) => forEachPlane({ x: 0, y: eavesY, z: 10 }, { x: 10, y: eavesY, z: 10 }, { x: 5, y: ridgeY, z: 5 }, {}, v),
    bricks,
    { confirm: true },
  )

  // 6. 烟囱：对角批量填充的圆柱
  store.write(
    (v) => forEachLine({ x: 8, y: 5, z: 8 }, { x: 8, y: 12, z: 8 }, { radius: 1, hollow: true }, v),
    bricks,
    { confirm: true },
  )
}

describe('端到端：用几何算子盖一座房子', () => {
  it('地基、墙、门、窗、尖顶、烟囱都能落进世界', () => {
    const store = makeStore()
    buildHouse(store)

    const stats = store.stats()
    expect(stats.blocks).toBeGreaterThan(200)

    // 地板：22:00 位置的整层
    expect(store.getBlockString({ x: 5, y: 0, z: 5 })).toContain('oak_planks')
    // 墙：南墙
    expect(store.getBlockString({ x: 3, y: 2, z: 0 })).toContain('stone_bricks')
    // 门洞：净高 2
    expect(store.isAir({ x: 5, y: 1, z: 0 })).toBe(true)
    expect(store.isAir({ x: 5, y: 2, z: 0 })).toBe(true)
    expect(store.isAir({ x: 5, y: 3, z: 0 })).toBe(false)
    // 窗
    expect(store.getBlockString({ x: 0, y: 3, z: 4 })).toBe('minecraft:glass')
    // 内部是空的
    expect(store.isAir({ x: 5, y: 2, z: 5 })).toBe(true)
    // 烟囱是空心的
    expect(store.isAir({ x: 8, y: 8, z: 8 })).toBe(true)
    expect(store.isAir({ x: 7, y: 8, z: 8 })).toBe(false)
  })

  it('屋顶是斜的：越靠屋脊越高', () => {
    const store = makeStore()
    buildHouse(store)

    const roofYAt = (z: number): number => {
      for (let y = 20; y >= 0; y--) if (!store.isAir({ x: 5, y, z })) return y
      return -1
    }
    const eaves = roofYAt(0)
    const mid = roofYAt(3)
    const ridge = roofYAt(5)

    expect(eaves).toBeGreaterThan(0)
    expect(mid).toBeGreaterThan(eaves)
    expect(ridge).toBeGreaterThan(mid)
  })

  it('门洞净高满足可通行规范（plan §9.3 completion checklist）', () => {
    const store = makeStore()
    buildHouse(store)
    let clearance = 0
    for (let y = 1; y < 10; y++) {
      if (store.isAir({ x: 5, y, z: 0 })) clearance++
      else break
    }
    expect(clearance).toBeGreaterThanOrEqual(2)
  })

  it('整座房子可以一次撤销到底', () => {
    const store = makeStore()
    const empty = store.stats().blocks
    buildHouse(store)
    expect(store.stats().blocks).toBeGreaterThan(200)

    let guard = 0
    while (store.canRevertLastWrite && guard++ < 100) store.revertLastWrite()
    expect(store.stats().blocks).toBe(empty)
  })

  it('对称方案：只造一半 + symmetrize，得到对称的院子', () => {
    const store = makeStore()
    const bricks = store.palette.indexOf('minecraft:stone_bricks')

    // 只造 x 0..7 的那一半（坐标平面 x=8）
    store.write(
      (v) =>
        forEachExtrude(rect(0, 0, 7, 12), { baseY: 0, height: 1 }, v),
      bricks,
      { confirm: true },
    )
    store.write(
      (v) => forEachLine({ x: 2, y: 1, z: 6 }, { x: 2, y: 4, z: 6 }, { radius: 1 }, v),
      store.palette.indexOf('minecraft:oak_log'),
      { confirm: true },
    )

    symmetrize(store, { axis: 'x', coordinate: 8, source: 'negative', confirm: true })

    // 镜像后逐格检查左右对称
    let mismatches = 0
    for (let dx = 0; dx <= 7; dx++) {
      for (let y = 0; y <= 5; y++) {
        for (let z = 0; z <= 12; z++) {
          const left = store.getBlockString({ x: 7 - dx, y, z })
          const right = store.getBlockString({ x: 9 + dx, y, z })
          if (left !== right) mismatches++
        }
      }
    }
    expect(mismatches).toBe(0)
  })

  it('大操作会先要确认（dry-run），确认后才落盘', () => {
    const store = makeStore()
    const bricks = store.palette.indexOf('minecraft:stone_bricks')

    const probe = store.write(
      (v) => forEachBox({ x: 0, y: 0, z: 0 }, { x: 20, y: 20, z: 20 }, 'solid', v),
      bricks,
      { confirmThreshold: 1000 },
    )
    expect(probe.ok).toBe(false)
    if (!probe.ok) {
      expect(probe.reason).toBe('NEEDS_CONFIRM')
      expect(probe.preview.willChange).toBe(21 * 21 * 21)
      expect(probe.preview.sample).toHaveLength(20)
    }
    expect(store.revision).toBe(0)

    // LLM 看过预览后显式确认
    const confirmed = store.write(
      (v) => forEachBox({ x: 0, y: 0, z: 0 }, { x: 20, y: 20, z: 20 }, 'solid', v),
      bricks,
      { confirmThreshold: 1000, confirm: true },
    )
    expect(confirmed.ok).toBe(true)
    expect(store.revision).toBe(1)
  })

  it('每一步都产生可读回的状态：编辑 → 读回 → 判定', () => {
    // 模拟 plan §9.4 的「写后读」闭环
    const store = makeStore()
    const bricks = store.palette.indexOf('minecraft:stone_bricks')

    const write = store.write(
      (v) => forEachBox({ x: 0, y: 0, z: 0 }, { x: 4, y: 2, z: 4 }, 'hollow', v),
      bricks,
      { confirm: true },
    )
    expect(write.ok).toBe(true)

    // verify 的等价物：逐条 claim 判定
    const claims: Array<[Pos, boolean]> = [
      [{ x: 0, y: 1, z: 0 }, false], // 表面 → 非空气
      [{ x: 4, y: 2, z: 4 }, false], // 角 → 非空气
      [{ x: 2, y: 1, z: 2 }, true], // 内部 → 空气
    ]
    for (const [pos, shouldBeAir] of claims) {
      expect(store.isAir(pos), `${pos.x},${pos.y},${pos.z}`).toBe(shouldBeAir)
    }
  })
})
