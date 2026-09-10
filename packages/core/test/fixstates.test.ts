import { describe, expect, it } from 'vitest'

import { stateIdToProperties } from '../src/state.js'
import { fixStates } from '../src/world/fixstates.js'
import { WorldStore } from '../src/world/store.js'
import type { Bounds, Pos, Properties } from '../src/types.js'

/**
 * `fix_states` 的验收测试。
 *
 * 三条硬要求都在这里：**幂等**、**整趟只花一个 revision**、**只碰该碰的属性**
 * （`waterlogged` 原样保留）。另外每条规则都配了一段**能在世界坐标里复述**的几何说明，
 * 说明见每个 `it` 的注释。
 */

const volume: Bounds = { min: { x: -8, y: 0, z: -8 }, max: { x: 24, y: 20, z: 24 } }

const makeStore = (): WorldStore => new WorldStore({ minecraftVersion: '1.21.4', volume })

function propsAt(store: WorldStore, pos: Pos): Properties {
  const stateId = store.getBlockStateId(pos)
  const block = store.registry.blockByStateId(stateId)
  if (block === undefined) throw new Error(`no block at ${pos.x},${pos.y},${pos.z}`)
  return stateIdToProperties(block, stateId)
}

function fenceLine(store: WorldStore, length: number): void {
  for (let x = 0; x < length; x++) store.setBlock({ x, y: 0, z: 0 }, 'minecraft:oak_fence')
}

describe('connect：栅栏 / 墙 / 玻璃板的连接值', () => {
  it('(a) 一条全默认的栅栏线会被连满：两端只连内侧，中间两侧都连', () => {
    const store = makeStore()
    fenceLine(store, 5)

    const result = fixStates(store)

    expect(result.ok).toBe(true)
    expect(result.fix.changed).toBe(5)
    expect(result.fix.byRule.connect).toBe(5)
    expect(result.fix.scanned).toBeGreaterThanOrEqual(5)

    const sides = (x: number): [unknown, unknown, unknown, unknown] => {
      const p = propsAt(store, { x, y: 0, z: 0 })
      return [p.east, p.west, p.north, p.south]
    }
    expect(sides(0)).toEqual([true, false, false, false])
    expect(sides(1)).toEqual([true, true, false, false])
    expect(sides(2)).toEqual([true, true, false, false])
    expect(sides(3)).toEqual([true, true, false, false])
    expect(sides(4)).toEqual([false, true, false, false])
  })

  it('(b) 孤立的栅栏柱四个方向都不连（默认值本来就对，所以不产生任何修改）', () => {
    const store = makeStore()
    store.setBlock({ x: 0, y: 0, z: 0 }, 'minecraft:oak_fence')

    const result = fixStates(store)

    expect(result.ok).toBe(true)
    expect(result.fix.changed).toBe(0)
    expect(result.fix.byRule.connect).toBe(0)
    const p = propsAt(store, { x: 0, y: 0, z: 0 })
    expect([p.east, p.west, p.north, p.south]).toEqual([false, false, false, false])
  })

  it('墙用 none/low/tall：连到墙或实心方块都是 tall，连不到就是 none', () => {
    const store = makeStore()
    store.setBlock({ x: 0, y: 0, z: 0 }, 'minecraft:cobblestone_wall')
    store.setBlock({ x: 1, y: 0, z: 0 }, 'minecraft:cobblestone_wall')
    store.setBlock({ x: 2, y: 0, z: 0 }, 'minecraft:stone') // 整格实心

    const result = fixStates(store)

    expect(propsAt(store, { x: 0, y: 0, z: 0 }).east).toBe('tall') // 连到同家族的墙
    expect(propsAt(store, { x: 0, y: 0, z: 0 }).west).toBe('none')
    expect(propsAt(store, { x: 1, y: 0, z: 0 }).west).toBe('tall')
    expect(propsAt(store, { x: 1, y: 0, z: 0 }).east).toBe('tall') // 连到实心方块
    expect(result.fix.byRule.connect).toBe(2) // 两条墙各是一格
  })

  it('家族不串味：栅栏不会连到墙上，但会连到整格实心方块（玻璃 / 石头）', () => {
    const store = makeStore()
    store.setBlock({ x: 0, y: 0, z: 0 }, 'minecraft:oak_fence')
    store.setBlock({ x: 1, y: 0, z: 0 }, 'minecraft:cobblestone_wall')
    store.setBlock({ x: 0, y: 0, z: 1 }, 'minecraft:glass')

    fixStates(store)

    // 栅栏的东边是墙 → 不连；南边是玻璃（整格实心）→ 连。
    expect(propsAt(store, { x: 0, y: 0, z: 0 }).east).toBe(false)
    expect(propsAt(store, { x: 0, y: 0, z: 0 }).south).toBe(true)
    // 墙的东边是栅栏 → 不连。
    expect(propsAt(store, { x: 1, y: 0, z: 0 }).west).toBe('none')
  })

  it('玻璃板互相连接，并且连到同材质的整格方块', () => {
    const store = makeStore()
    store.setBlock({ x: 0, y: 0, z: 0 }, 'minecraft:glass_pane')
    store.setBlock({ x: 1, y: 0, z: 0 }, 'minecraft:iron_bars')
    store.setBlock({ x: 0, y: 0, z: 1 }, 'minecraft:glass')

    fixStates(store)

    expect(propsAt(store, { x: 0, y: 0, z: 0 }).east).toBe(true) // 玻璃板 ↔ 铁栏杆同家族
    expect(propsAt(store, { x: 0, y: 0, z: 0 }).south).toBe(true) // 连到整格玻璃
  })

  it('绝不改动 waterlogged', () => {
    const store = makeStore()
    store.setBlock({ x: 0, y: 0, z: 0 }, 'minecraft:oak_fence[waterlogged=true]')
    store.setBlock({ x: 1, y: 0, z: 0 }, 'minecraft:oak_fence[waterlogged=true]')

    fixStates(store)

    expect(propsAt(store, { x: 0, y: 0, z: 0 }).waterlogged).toBe(true)
    expect(propsAt(store, { x: 1, y: 0, z: 0 }).waterlogged).toBe(true)
    expect(propsAt(store, { x: 0, y: 0, z: 0 }).east).toBe(true)
  })

  it('wall_up：上方是整格实心方块时收掉中心柱，上方是空气或墙时保留', () => {
    const store = makeStore()
    store.setBlock({ x: 0, y: 0, z: 0 }, 'minecraft:cobblestone_wall') // 上方空气，默认 up=true
    store.setBlock({ x: 2, y: 0, z: 0 }, 'minecraft:cobblestone_wall')
    store.setBlock({ x: 2, y: 1, z: 0 }, 'minecraft:stone') // 把它盖住

    const result = fixStates(store)

    expect(propsAt(store, { x: 0, y: 0, z: 0 }).up).toBe(true)
    expect(propsAt(store, { x: 2, y: 0, z: 0 }).up).toBe(false)
    expect(result.fix.byRule.wall_up).toBe(1)
  })
})

describe('stairs：楼梯 shape', () => {
  it('(e) 凸角 outer_left：朝北的楼梯，正前方是一格朝西的同半格楼梯', () => {
    const store = makeStore()
    // 几何：S 在 (0,0,0) 朝北，N 在 S 正前方 (0,0,-1) 朝西，正东 (1,0,0) 是空气。
    // 香草规则第 1 条命中：正前方邻居朝向与自身垂直（X 轴 vs Z 轴），
    // 且 N 朝向的反方向那一格 (1,0,0) 不是同向楼梯 → 凸角；
    // 朝西正是朝北的「逆时针邻向」（北→西）→ outer_left。
    // 用注册表的碰撞盒核对：outer_left 的上半格是西北象限，正好接上 N 的（朝西的）西半格踏面。
    store.setBlock({ x: 0, y: 0, z: 0 }, 'minecraft:oak_stairs[facing=north,half=bottom]')
    store.setBlock({ x: 0, y: 0, z: -1 }, 'minecraft:oak_stairs[facing=west,half=bottom]')

    const result = fixStates(store)

    expect(propsAt(store, { x: 0, y: 0, z: 0 }).shape).toBe('outer_left')
    expect(propsAt(store, { x: 0, y: 0, z: -1 }).shape).toBe('straight')
    expect(result.fix.byRule.stairs).toBe(1)
  })

  it('凹角 inner_left：朝北的楼梯，正后方是一格朝西的同半格楼梯', () => {
    const store = makeStore()
    // 几何：S 在 (0,0,0) 朝北，正前方 (0,0,-1) 是空气；正后方 (0,0,1) 是朝西的楼梯 B。
    // 第 1 条不成立（前方没楼梯），第 2 条命中：B 朝向与自身垂直，
    // 且 B 朝向那一格 (0,0,-1) 不是同向楼梯 → 凹角；朝西是逆时针邻向 → inner_left。
    // 核对碰撞盒：inner_left 的「西侧长条」正好接上 B 的西半格踏面。
    store.setBlock({ x: 0, y: 0, z: 0 }, 'minecraft:oak_stairs[facing=north,half=bottom]')
    store.setBlock({ x: 0, y: 0, z: 1 }, 'minecraft:oak_stairs[facing=west,half=bottom]')

    fixStates(store)

    expect(propsAt(store, { x: 0, y: 0, z: 0 }).shape).toBe('inner_left')
    expect(propsAt(store, { x: 0, y: 0, z: 1 }).shape).toBe('straight')
  })

  it('一条直楼梯保持 straight，不会因为并排而乱改', () => {
    const store = makeStore()
    for (let x = 0; x < 3; x++) store.setBlock({ x, y: 0, z: 0 }, 'minecraft:oak_stairs[facing=north,half=bottom]')

    const result = fixStates(store)

    expect(result.fix.changed).toBe(0)
    for (let x = 0; x < 3; x++) expect(propsAt(store, { x, y: 0, z: 0 }).shape).toBe('straight')
  })

  it('半格不同的楼梯不拼角', () => {
    const store = makeStore()
    store.setBlock({ x: 0, y: 0, z: 0 }, 'minecraft:oak_stairs[facing=north,half=bottom]')
    store.setBlock({ x: 0, y: 0, z: -1 }, 'minecraft:oak_stairs[facing=west,half=top]')

    fixStates(store)

    expect(propsAt(store, { x: 0, y: 0, z: 0 }).shape).toBe('straight')
  })
})

describe('embedded_partial：原 slab_double 的替代规则', () => {
  it('被六个整格实心方块包住的半砖只报告、不修改', () => {
    const store = makeStore()
    // 3×3×3 石头（y 0..2），中心 (0,1,0) 换成下半砖：六个面全被实心方块挡住，
    // 这块砖看不见也走不进去。
    for (let x = -1; x <= 1; x++) {
      for (let y = 0; y <= 2; y++) {
        for (let z = -1; z <= 1; z++) store.setBlock({ x, y, z }, 'minecraft:stone')
      }
    }
    store.setBlock({ x: 0, y: 1, z: 0 }, 'minecraft:oak_slab[type=bottom]')
    const before = store.getBlockString({ x: 0, y: 1, z: 0 })

    const result = fixStates(store)

    expect(result.fix.byRule.embedded_partial).toBe(1)
    expect(result.fix.embeddedSample).toEqual([{ x: 0, y: 1, z: 0 }])
    expect(store.getBlockString({ x: 0, y: 1, z: 0 })).toBe(before) // 原样保留
  })

  it('type=double 的半砖本身就是整格，不算被埋', () => {
    const store = makeStore()
    for (let x = -1; x <= 1; x++) {
      for (let y = 0; y <= 2; y++) {
        for (let z = -1; z <= 1; z++) store.setBlock({ x, y, z }, 'minecraft:stone')
      }
    }
    store.setBlock({ x: 0, y: 1, z: 0 }, 'minecraft:oak_slab[type=double]')

    const result = fixStates(store)

    expect(result.fix.byRule.embedded_partial).toBe(0)
  })
})

/** 造一个同时触发 connect / wall_up / stairs / embedded_partial 的世界。 */
function buildMixedWorld(store: WorldStore): void {
  fenceLine(store, 4)

  store.setBlock({ x: 0, y: 0, z: 2 }, 'minecraft:cobblestone_wall')
  store.setBlock({ x: 1, y: 0, z: 2 }, 'minecraft:cobblestone_wall')
  store.setBlock({ x: 1, y: 1, z: 2 }, 'minecraft:stone')

  store.setBlock({ x: 0, y: 0, z: 4 }, 'minecraft:oak_stairs[facing=north,half=bottom]')
  store.setBlock({ x: 0, y: 0, z: 3 }, 'minecraft:oak_stairs[facing=west,half=bottom]')

  for (let x = 10; x <= 12; x++) {
    for (let y = 0; y <= 2; y++) {
      for (let z = 0; z <= 2; z++) store.setBlock({ x, y, z }, 'minecraft:stone')
    }
  }
  store.setBlock({ x: 11, y: 1, z: 1 }, 'minecraft:oak_slab[type=bottom]')
}

describe('不变式：幂等 + 一个 revision', () => {
  it('(c) 幂等：第二次跑 changed=0，revision 与世界哈希都不变', () => {
    const store = makeStore()
    buildMixedWorld(store)

    const first = fixStates(store)
    expect(first.ok).toBe(true)
    expect(first.fix.changed).toBeGreaterThan(0)
    expect(first.fix.byRule.connect).toBeGreaterThan(0)
    expect(first.fix.byRule.wall_up).toBeGreaterThan(0)
    expect(first.fix.byRule.stairs).toBeGreaterThan(0)
    expect(first.fix.byRule.embedded_partial).toBe(1)

    const revision = store.revision
    const hash = store.contentHash()

    const second = fixStates(store)
    expect(second.ok).toBe(true)
    expect(second.fix.changed).toBe(0)
    expect(second.fix.byRule.connect).toBe(0)
    expect(second.fix.byRule.wall_up).toBe(0)
    expect(second.fix.byRule.stairs).toBe(0)
    expect(second.fix.byRule.embedded_partial).toBe(1) // 只报告，永远不改，所以每次都能报出来
    expect(store.revision).toBe(revision)
    expect(store.contentHash()).toBe(hash)
  })

  it('(d) 整趟修正只花一个 revision，一次 undo 完全回滚', () => {
    const store = makeStore()
    buildMixedWorld(store)
    const before = store.contentHash()
    const revision = store.revision

    const result = fixStates(store)

    expect(result.ok).toBe(true)
    expect(result.fix.changed).toBeGreaterThan(1)
    expect(store.revision).toBe(revision + 1) // 不是每格一个 revision

    expect(store.undo()).toBe(result.fix.changed)
    expect(store.contentHash()).toBe(before)
  })

  it('region 只修正区域内的格子，区域外原样保留', () => {
    const store = makeStore()
    fenceLine(store, 4)

    const result = fixStates(store, { region: { min: { x: 0, y: 0, z: 0 }, max: { x: 1, y: 0, z: 0 } } })

    expect(result.fix.changed).toBe(2) // 只动了 x=0/1
    expect(propsAt(store, { x: 0, y: 0, z: 0 }).east).toBe(true)
    expect(propsAt(store, { x: 1, y: 0, z: 0 }).east).toBe(true) // 邻居在区域外也照样读
    expect(propsAt(store, { x: 2, y: 0, z: 0 }).east).toBe(false) // 区域外没动
    expect(propsAt(store, { x: 2, y: 0, z: 0 }).west).toBe(false)
  })

  it('dry-run（超过 confirmThreshold 且没 confirm）不落盘：changed=0 且 revision 不变，但报告仍给出规则计数', () => {
    const store = makeStore()
    fenceLine(store, 4)
    const revision = store.revision

    const result = fixStates(store, { confirmThreshold: 1 })

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe('NEEDS_CONFIRM')
    expect(result.fix.changed).toBe(0)
    expect(result.fix.byRule.connect).toBe(4)
    expect(store.revision).toBe(revision)
  })
})
