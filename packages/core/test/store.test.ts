import { describe, expect, it } from 'vitest'

import { forEachBox } from '../src/geometry/box.js'
import { forEachLine } from '../src/geometry/line.js'
import { posKey } from '../src/types.js'
import { ChangeSet } from '../src/world/changeset.js'
import { DEFAULT_CONFIRM_THRESHOLD, WorldStore } from '../src/world/store.js'
import type { Bounds, Pos } from '../src/types.js'

const volume: Bounds = { min: { x: 0, y: 0, z: 0 }, max: { x: 31, y: 31, z: 31 } }

function makeStore(v: Bounds = volume): WorldStore {
  return new WorldStore({ minecraftVersion: '1.21.4', volume: v })
}

/** 把几何算子的产出喂给 store。 */
const box = (from: Pos, to: Pos, mode: 'solid' | 'hollow' | 'outline' = 'solid') =>
  (visit: (x: number, y: number, z: number) => void) => forEachBox(from, to, mode, visit)

describe('ChangeSet', () => {
  it('push / at / bounds', () => {
    const set = new ChangeSet(2)
    set.push(1, 2, 3, 0, 5)
    set.push(-1, 9, 4, 7, 0)
    expect(set.length).toBe(2)
    expect(set.at(0)).toEqual({ pos: { x: 1, y: 2, z: 3 }, from: 0, to: 5 })
    expect(set.bounds()).toEqual({ min: { x: -1, y: 2, z: 3 }, max: { x: 1, y: 9, z: 4 } })
  })

  it('自动扩容，容量翻倍后内容不丢', () => {
    const set = new ChangeSet(2)
    for (let i = 0; i < 1000; i++) set.push(i, i, i, 0, 1)
    expect(set.length).toBe(1000)
    expect(set.capacity).toBeGreaterThanOrEqual(1000)
    expect(set.at(999).pos).toEqual({ x: 999, y: 999, z: 999 })
  })

  it('inverted 交换 from/to', () => {
    const set = new ChangeSet()
    set.push(1, 1, 1, 3, 9)
    const inv = set.inverted()
    expect(inv.at(0).from).toBe(9)
    expect(inv.at(0).to).toBe(3)
  })

  it('空集合的 bounds 是 undefined', () => {
    expect(new ChangeSet().bounds()).toBeUndefined()
  })

  it('toBuffer / fromBuffer 往返', () => {
    const set = new ChangeSet()
    for (let i = 0; i < 500; i++) set.push(i - 100, i, -i, i % 7, (i * 3) % 11)
    const restored = ChangeSet.fromBuffer(set.toBuffer())
    expect(restored.length).toBe(set.length)
    for (let i = 0; i < set.length; i++) {
      expect(restored.at(i)).toEqual(set.at(i))
    }
  })
})

describe('WorldStore 基本读写', () => {
  it('未分配的地方是空气，且不因读而分配内存', () => {
    const store = makeStore()
    expect(store.getBlockStateId({ x: 5, y: 5, z: 5 })).toBe(0)
    expect(store.getBlockString({ x: 5, y: 5, z: 5 })).toBe('minecraft:air')
    expect(store.isAir({ x: 5, y: 5, z: 5 })).toBe(true)
    expect(store.allocatedColumns).toBe(0)
  })

  it('写入后能读回正确的规范状态字符串', () => {
    const store = makeStore()
    store.setBlock({ x: 5, y: 5, z: 5 }, 'oak_stairs[facing=east]')
    expect(store.getBlockString({ x: 5, y: 5, z: 5 })).toBe(
      'minecraft:oak_stairs[facing=east,half=bottom,shape=straight,waterlogged=false]',
    )
    expect(store.allocatedColumns).toBe(1)
    expect(store.revision).toBe(1)
  })

  it('chunk 列惰性分配：写空气不会分配', () => {
    const store = makeStore()
    store.write(box({ x: 1, y: 1, z: 1 }, { x: 1, y: 1, z: 1 }), store.palette.indexOf('minecraft:stone'))
    expect(store.allocatedColumns).toBe(1)
    store.write(box({ x: 1, y: 1, z: 1 }, { x: 1, y: 1, z: 1 }), 0, { mode: 'destroy', confirm: true })
    expect(store.allocatedColumns).toBe(1) // 列仍然在，只是内容变空
    expect(store.isAir({ x: 1, y: 1, z: 1 })).toBe(true)
  })

  it('跨 chunk 边界写入会分配多列', () => {
    const store = makeStore()
    store.write(box({ x: 15, y: 5, z: 15 }, { x: 16, y: 5, z: 16 }), store.palette.indexOf('minecraft:stone'), {
      confirm: true,
    })
    expect(store.allocatedColumns).toBe(4)
  })
})

describe('WorldStore 工区约束', () => {
  it('工区外的方块被裁剪并计数，而不是静默丢弃', () => {
    const store = makeStore({ min: { x: 0, y: 0, z: 0 }, max: { x: 7, y: 7, z: 7 } })
    const result = store.write(
      box({ x: 0, y: 0, z: 0 }, { x: 15, y: 15, z: 15 }),
      store.palette.indexOf('minecraft:stone'),
      { confirm: true },
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.changed).toBe(8 * 8 * 8)
    expect(result.clipped).toBe(16 * 16 * 16 - 8 * 8 * 8)
  })

  it('Y 超出世界高度也算裁剪', () => {
    const store = makeStore({ min: { x: 0, y: -80, z: 0 }, max: { x: 3, y: 400, z: 3 } })
    // 世界高度是 -64..319，工区被夹到该范围
    expect(store.volume.min.y).toBe(-64)
    expect(store.volume.max.y).toBe(319)
  })
})

describe('WorldStore 写入模式', () => {
  const fill100 = (store: WorldStore, block: string, mode?: 'keep' | 'overlay' | 'destroy') =>
    store.write(box({ x: 0, y: 0, z: 0 }, { x: 9, y: 9, z: 9 }), store.palette.indexOf(block), {
      mode,
      confirm: true,
    })

  it('keep 不覆盖已有方块', () => {
    const store = makeStore()
    fill100(store, 'minecraft:stone')
    const result = fill100(store, 'minecraft:dirt', 'keep')
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.changed).toBe(0)
    expect(store.getBlockString({ x: 5, y: 5, z: 5 })).toBe('minecraft:stone')
  })

  it('keep 只填空气部分', () => {
    const store = makeStore()
    store.setBlock({ x: 5, y: 5, z: 5 }, 'minecraft:stone')
    const result = fill100(store, 'minecraft:dirt', 'keep')
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.changed).toBe(999)
    expect(store.getBlockString({ x: 5, y: 5, z: 5 })).toBe('minecraft:stone')
    expect(store.getBlockString({ x: 0, y: 0, z: 0 })).toBe('minecraft:dirt')
  })

  it('overlay 只覆盖非空气（给结构上色）', () => {
    const store = makeStore()
    store.write(box({ x: 0, y: 0, z: 0 }, { x: 4, y: 4, z: 4 }), store.palette.indexOf('minecraft:stone'), {
      confirm: true,
    })
    const result = fill100(store, 'minecraft:dirt', 'overlay')
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.changed).toBe(5 * 5 * 5)
    expect(store.getBlockString({ x: 0, y: 0, z: 0 })).toBe('minecraft:dirt')
    expect(store.getBlockString({ x: 9, y: 9, z: 9 })).toBe('minecraft:air')
  })

  it('destroy 把命中方块变空气', () => {
    const store = makeStore()
    fill100(store, 'minecraft:stone')
    const result = fill100(store, 'minecraft:dirt', 'destroy')
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.changed).toBe(1000)
    expect(store.isAir({ x: 5, y: 5, z: 5 })).toBe(true)
  })

  it('写入相同方块是 no-op（不产生 revision）', () => {
    const store = makeStore()
    fill100(store, 'minecraft:stone')
    const before = store.revision
    const result = fill100(store, 'minecraft:stone')
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.changed).toBe(0)
    expect(store.revision).toBe(before)
  })
})

describe('WorldStore dry-run 预算（plan §9.4 机制 3）', () => {
  it('超过阈值时返回 NEEDS_CONFIRM 且不落盘', () => {
    const store = makeStore()
    const blockIndex = store.palette.indexOf('minecraft:stone')
    const result = store.write(box({ x: 0, y: 0, z: 0 }, { x: 31, y: 31, z: 31 }), blockIndex, {
      confirmThreshold: 1000,
    })

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toBe('NEEDS_CONFIRM')
    expect(result.preview.willChange).toBe(32 * 32 * 32)
    expect(result.preview.willOverwriteNonAir).toBe(0)
    expect(result.preview.sample).toHaveLength(20)
    // 没有落盘
    expect(store.revision).toBe(0)
    expect(store.allocatedColumns).toBe(0)
    expect(store.isAir({ x: 5, y: 5, z: 5 })).toBe(true)
  })

  it('preview 报告被覆盖方块的分类与数量', () => {
    const store = makeStore()
    store.write(box({ x: 0, y: 0, z: 0 }, { x: 9, y: 9, z: 9 }), store.palette.indexOf('minecraft:stone'), {
      confirm: true,
    })
    store.write(
      box({ x: 0, y: 0, z: 0 }, { x: 4, y: 4, z: 4 }),
      store.palette.indexOf('minecraft:oak_planks'),
      { confirm: true },
    )
    const result = store.write(
      box({ x: 0, y: 0, z: 0 }, { x: 9, y: 9, z: 9 }),
      store.palette.indexOf('minecraft:dirt'),
      { confirmThreshold: 100 },
    )
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toBe('NEEDS_CONFIRM')
    expect(result.preview.willChange).toBe(1000)
    expect(result.preview.willOverwriteNonAir).toBe(1000)
    expect(result.preview.overwriteBreakdown).toEqual({ 'oak_planks': 125, 'stone': 875 })
  })

  it('confirm:true 后正常提交', () => {
    const store = makeStore()
    const result = store.write(
      box({ x: 0, y: 0, z: 0 }, { x: 31, y: 31, z: 31 }),
      store.palette.indexOf('minecraft:stone'),
      { confirm: true },
    )
    expect(result.ok).toBe(true)
    expect(store.revision).toBe(1)
  })

  it('触到硬上限直接 TOO_LARGE', () => {
    const store = makeStore()
    const result = store.write(
      box({ x: 0, y: 0, z: 0 }, { x: 31, y: 31, z: 31 }),
      store.palette.indexOf('minecraft:stone'),
      { confirm: true, hardLimit: 500 },
    )
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toBe('TOO_LARGE')
    expect(result.preview.truncated).toBe(true)
    expect(store.revision).toBe(0)
  })

  it('默认阈值就是 50 000', () => {
    expect(DEFAULT_CONFIRM_THRESHOLD).toBe(50_000)
  })
})

describe('WorldStore 撤销 / 重做', () => {
  it('undo 精确还原到上一状态', () => {
    const store = makeStore()
    store.write(box({ x: 0, y: 0, z: 0 }, { x: 4, y: 4, z: 4 }), store.palette.indexOf('minecraft:stone'), {
      confirm: true,
    })
    const snapshot = (): string[] => {
      const out: string[] = []
      for (let x = 0; x < 6; x++)
        for (let y = 0; y < 6; y++) for (let z = 0; z < 6; z++) out.push(store.getBlockString({ x, y, z }))
      return out
    }
    const before = snapshot()
    store.write(box({ x: 0, y: 0, z: 0 }, { x: 9, y: 9, z: 9 }), store.palette.indexOf('minecraft:dirt'), {
      confirm: true,
    })
    expect(snapshot()).not.toEqual(before)
    expect(store.undo()).toBe(1000)
    expect(snapshot()).toEqual(before)
  })

  it('redo 重放撤销掉的操作', () => {
    const store = makeStore()
    store.setBlock({ x: 1, y: 1, z: 1 }, 'minecraft:stone')
    store.setBlock({ x: 2, y: 2, z: 2 }, 'minecraft:dirt')
    store.undo()
    expect(store.isAir({ x: 2, y: 2, z: 2 })).toBe(true)
    expect(store.redo()).toBe(1)
    expect(store.getBlockString({ x: 2, y: 2, z: 2 })).toBe('minecraft:dirt')
  })

  it('新编辑会清空 redo 栈', () => {
    const store = makeStore()
    store.setBlock({ x: 1, y: 1, z: 1 }, 'minecraft:stone')
    store.undo()
    expect(store.canRedo).toBe(true)
    store.setBlock({ x: 3, y: 3, z: 3 }, 'minecraft:dirt')
    expect(store.canRedo).toBe(false)
  })

  it('连续 undo 到空，再 undo 返回 0', () => {
    const store = makeStore()
    store.setBlock({ x: 1, y: 1, z: 1 }, 'minecraft:stone')
    store.setBlock({ x: 2, y: 2, z: 2 }, 'minecraft:stone')
    expect(store.undo()).toBe(1)
    expect(store.undo()).toBe(1)
    expect(store.undo()).toBe(0)
    expect(store.canUndo).toBe(false)
  })

  it('撤销也走工区约束：不会把工区外的东西写坏', () => {
    const store = makeStore({ min: { x: 0, y: 0, z: 0 }, max: { x: 3, y: 3, z: 3 } })
    store.write(box({ x: 0, y: 0, z: 0 }, { x: 9, y: 9, z: 9 }), store.palette.indexOf('minecraft:stone'), {
      confirm: true,
    })
    expect(store.isAir({ x: 0, y: 0, z: 0 })).toBe(false)
    store.undo()
    expect(store.isAir({ x: 0, y: 0, z: 0 })).toBe(true)
  })
})

describe('WorldStore 统计与集成', () => {
  it('stats 与实际写入一致', () => {
    const store = makeStore()
    store.write(box({ x: 0, y: 0, z: 0 }, { x: 3, y: 3, z: 3 }, 'hollow'), store.palette.indexOf('minecraft:stone'), {
      confirm: true,
    })
    const stats = store.stats()
    expect(stats.blocks).toBe(4 * 4 * 4 - 2 * 2 * 2)
    expect(stats.columns).toBe(1)
    expect(stats.approximateBytes).toBeGreaterThan(0)
  })

  it('contentBounds 忽略空气', () => {
    const store = makeStore()
    store.setBlock({ x: 3, y: 4, z: 5 }, 'minecraft:stone')
    store.setBlock({ x: 10, y: 1, z: 2 }, 'minecraft:stone')
    expect(store.contentBounds()).toEqual({
      min: { x: 3, y: 1, z: 2 },
      max: { x: 10, y: 4, z: 5 },
    })
  })

  it('contentBounds 在空世界返回 undefined', () => {
    expect(makeStore().contentBounds()).toBeUndefined()
  })

  it('对角批量填充落进世界：锥形塔尖', () => {
    const store = makeStore({ min: { x: 0, y: 0, z: 0 }, max: { x: 15, y: 40, z: 15 } })
    const result = store.write(
      (visit) =>
        forEachLine({ x: 8, y: 0, z: 8 }, { x: 8, y: 39, z: 8 }, { taper: [3, 0], hollow: true }, visit),
      store.palette.indexOf('minecraft:dark_prismarine'),
      { confirm: true },
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return

    // hollow 是空心壳：一行穿过圆心只有两堵墙，计数恒为 2。
    // 所以量外廓跨度（max - min），不是格子数。
    const extentAt = (y: number): number => {
      let lo = Number.POSITIVE_INFINITY
      let hi = Number.NEGATIVE_INFINITY
      for (let x = 0; x < 16; x++) {
        if (!store.isAir({ x, y, z: 8 })) {
          if (x < lo) lo = x
          if (x > hi) hi = x
        }
      }
      return hi - lo + 1
    }
    expect(extentAt(0)).toBe(7) // 底半径 3 → 7 格粗
    expect(extentAt(0)).toBeGreaterThan(extentAt(20))
    expect(extentAt(20)).toBeGreaterThan(extentAt(38))
    // 空心：中轴下方不该有方块
    expect(store.isAir({ x: 8, y: 10, z: 8 })).toBe(true)
  })

  it('对角线梁：两点之间每一格都被填上', () => {
    const store = makeStore()
    store.write(
      (visit) => forEachLine({ x: 0, y: 0, z: 0 }, { x: 20, y: 20, z: 20 }, {}, visit),
      store.palette.indexOf('minecraft:oak_log'),
      { confirm: true },
    )
    for (let i = 0; i <= 20; i++) {
      expect(store.getBlockString({ x: i, y: i, z: i }), `轴点 ${i}`).toBe('minecraft:oak_log[axis=y]')
    }
    expect(store.stats().blocks).toBe(21)
  })

  it('跨 chunk 写入不串味（ChunkColumn 的 x/z 位重叠陷阱）', () => {
    // 上游索引是 (((y-minY)&15)<<8) | (z<<4) | x，x/z 完全不掩码。
    // 若把世界坐标直接传进去，(z<<4)|x 会位重叠：(16,20,16) 与 (16,20,17) 落到同一索引。
    const store = makeStore({ min: { x: 0, y: 0, z: 0 }, max: { x: 40, y: 40, z: 40 } })
    const positions: Pos[] = [
      { x: 0, y: 20, z: 0 },
      { x: 15, y: 20, z: 15 },
      { x: 16, y: 20, z: 16 },
      { x: 31, y: 20, z: 31 },
      { x: 16, y: 20, z: 0 },
      { x: 0, y: 20, z: 16 },
      { x: 20, y: 20, z: 20 },
    ]
    for (const p of positions) store.setBlock(p, 'minecraft:stone')

    const actual = new Set<string>()
    store.forEachNonAir((x, y, z) => actual.add(posKey({ x, y, z })))
    expect(actual).toEqual(new Set(positions.map(posKey)))

    // 直接盯住会串味的那几个邻居
    expect(store.isAir({ x: 16, y: 20, z: 17 })).toBe(true)
    expect(store.isAir({ x: 17, y: 20, z: 16 })).toBe(true)
    expect(store.isAir({ x: 0, y: 20, z: 1 })).toBe(true)
  })

  it('跨 4 个 chunk 的块，边界格数正确', () => {
    const store = makeStore({ min: { x: 0, y: 0, z: 0 }, max: { x: 31, y: 3, z: 31 } })
    store.write(box({ x: 14, y: 0, z: 14 }, { x: 17, y: 0, z: 17 }), store.palette.indexOf('minecraft:stone'), {
      confirm: true,
    })
    expect(store.stats().blocks).toBe(4 * 4)
    expect(store.allocatedColumns).toBe(4)
    for (const x of [14, 15, 16, 17]) {
      for (const z of [14, 15, 16, 17]) {
        expect(store.getBlockString({ x, y: 0, z }), `${x},0,${z}`).toBe('minecraft:stone')
      }
    }
  })

  it('写入的方块坐标集合与几何算子完全一致', () => {
    const store = makeStore()
    const expected = new Set<string>()
    forEachBox({ x: 2, y: 3, z: 4 }, { x: 7, y: 8, z: 9 }, 'outline', (x, y, z) =>
      expected.add(posKey({ x, y, z })),
    )
    store.write(box({ x: 2, y: 3, z: 4 }, { x: 7, y: 8, z: 9 }, 'outline'), store.palette.indexOf('minecraft:stone'), {
      confirm: true,
    })
    const actual = new Set<string>()
    store.forEachNonAir((x, y, z) => actual.add(posKey({ x, y, z })))
    expect(actual).toEqual(expected)
  })
})

describe('writeBlocks：生产者中途扩充调色板', () => {
  it('**边写边加新方块不会炸**（回归：查表曾在 produce 之前定格）', () => {
    const store = new WorldStore({ minecraftVersion: '1.21.4', volume })
    // 这个世界此前只有 air；生产者第一次调用 blockIndexForStateId 就会把新方块加进调色板
    const wallId = store.registry.blockByName('cobblestone_wall')!.defaultState
    const fenceId = store.registry.blockByName('oak_fence')!.defaultState

    const result = store.writeBlocks((emit) => {
      // 注意：**在 produce 内部**取索引，也就是在 writeBlocks 已经定格查表之后
      emit(0, 0, 0, store.blockIndexForStateId(wallId))
      emit(1, 0, 0, store.blockIndexForStateId(fenceId))
      emit(2, 0, 0, store.blockIndexForStateId(wallId))
    })

    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('unreachable')
    expect(result.changed).toBe(3)
    expect(store.getBlockString({ x: 0, y: 0, z: 0 })).toContain('cobblestone_wall')
    expect(store.getBlockString({ x: 1, y: 0, z: 0 })).toContain('oak_fence')
    expect(store.getBlockString({ x: 2, y: 0, z: 0 })).toContain('cobblestone_wall')
    // 调色板只涨了两项（空气之外）
    expect(store.palette.size).toBe(3)
  })

  it('同一轮里重复引用同一个新方块不会重复入表', () => {
    const store = new WorldStore({ minecraftVersion: '1.21.4', volume })
    const id = store.registry.blockByName('stone')!.defaultState
    store.writeBlocks((emit) => {
      for (let x = 0; x < 5; x++) emit(x, 0, 0, store.blockIndexForStateId(id))
    })
    expect(store.palette.size).toBe(2)
  })

  it('越界的下标仍然如实报错', () => {
    const store = new WorldStore({ minecraftVersion: '1.21.4', volume })
    expect(() => store.writeBlocks((emit) => emit(0, 0, 0, 999))).toThrow(/Palette index 999/)
  })
})
