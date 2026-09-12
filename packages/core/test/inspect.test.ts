import { describe, expect, it } from 'vitest'

import { forEachBox } from '../src/geometry/box.js'
import { DEFAULT_MAX_SLICE_CELLS, renderSlice } from '../src/inspect/ascii.js'
import { formatMeasure, measure, volumeOf } from '../src/inspect/measure.js'
import { WorldStore } from '../src/world/store.js'
import type { Bounds } from '../src/types.js'

const volume: Bounds = { min: { x: 0, y: 0, z: 0 }, max: { x: 15, y: 15, z: 15 } }
const makeStore = (v: Bounds = volume): WorldStore =>
  new WorldStore({ minecraftVersion: '1.21.4', volume: v })

/** 从渲染结果里取某一行的字符（去掉左侧标号）。 */
function rowAt(text: string, label: number): string {
  const line = text
    .split('\n')
    .find((l) => new RegExp(`\\|.*\\|$`).test(l) && Number(l.trim().split('|')[0]!.split(/\s+/).pop()) === label)
  if (line === undefined) throw new Error(`找不到行 ${label}`)
  return line.split('|')[1]!
}

describe('ASCII 切片', () => {
  it('平面图：列是 x、行是 z，行号自上而下递增', () => {
    // 显式给范围，这条测的是**坐标映射**（列 = x、行 = z、行号往下增），
    // 与"默认范围取多大"无关——默认范围现在跟着内容走（见下面那条）。
    const store = makeStore()
    store.setBlock({ x: 3, y: 5, z: 7 }, 'minecraft:stone')
    const result = renderSlice(store, { axis: 'y', index: 5, range: { x: [0, 15], z: [0, 15] } })
    expect(result.columnAxis).toBe('x')
    expect(result.rowAxis).toBe('z')
    expect(result.columns).toBe(16)
    expect(result.rows).toBe(16)
    expect(rowAt(result.text, 7)[3]).not.toBe('.')
    expect(rowAt(result.text, 6)).toBe('.'.repeat(16))
  })

  it('**默认范围跟着内容走**，而不是老工区', () => {
    // 世界没有可写边界了，所以 X/Z 的默认范围不能再用 `store.volume`：
    // 建在老工区之外的东西会被整片截掉。这里把方块放在工区之外，
    // 默认切片必须把它画出来。
    const store = makeStore({ min: { x: 0, y: 0, z: 0 }, max: { x: 15, y: 15, z: 15 } })
    store.setBlock({ x: 100, y: 5, z: 120 }, 'minecraft:stone')
    const result = renderSlice(store, { axis: 'y', index: 5 })
    expect(result.columns).toBe(1)
    expect(result.rows).toBe(1)
    expect(result.legend.some((entry) => entry.block === 'minecraft:stone')).toBe(true)
  })

  it('立面图：行号自上而下递减，且**标号与实际取样一致**（回归）', () => {
    const store = makeStore()
    // 只在 y=0 放一格；如果标号与取样错位，它就会出现在标着 y=3 的那一行
    store.setBlock({ x: 5, y: 0, z: 5 }, 'minecraft:stone')
    const result = renderSlice(store, { axis: 'x', index: 5, range: { z: [4, 6], y: [0, 3] } })
    expect(result.rowAxis).toBe('y')
    expect(result.columnAxis).toBe('z')
    expect(result.rows).toBe(4)

    const stoneGlyph = result.legend.find((e) => e.block === 'minecraft:stone')!.glyph
    expect(rowAt(result.text, 0)).toContain(stoneGlyph)
    expect(rowAt(result.text, 3)).toBe('.'.repeat(3))

    // 第一行必须是最高的 y
    const firstRow = result.text.split('\n').find((l) => l.includes('|') && l.includes('y'))!
    expect(Number(firstRow.trim().split('|')[0]!.split(/\s+/).pop())).toBe(3)
  })

  it('空气固定用 `.`，其余方块按出现次数从多到少分配字形', () => {
    const store = makeStore()
    for (let x = 0; x < 8; x++) store.setBlock({ x, y: 0, z: 0 }, 'minecraft:stone')
    for (let x = 0; x < 3; x++) store.setBlock({ x, y: 0, z: 1 }, 'minecraft:dirt')
    store.setBlock({ x: 0, y: 0, z: 2 }, 'minecraft:glass')

    const result = renderSlice(store, { axis: 'y', index: 0, range: { x: [0, 15], z: [0, 15] } })
    expect(result.legend[0]!.block).toBe('minecraft:air')
    expect(result.legend[0]!.glyph).toBe('.')
    expect(result.legend[1]!.block).toBe('minecraft:stone')
    expect(result.legend[1]!.glyph).toBe('#')
    expect(result.legend[2]!.block).toBe('minecraft:dirt')
    expect(result.legend[3]!.block).toBe('minecraft:glass')
  })

  it('图例带完整规范状态串与计数', () => {
    const store = makeStore()
    store.setBlock({ x: 1, y: 1, z: 1 }, 'oak_stairs[facing=east]')
    const result = renderSlice(store, { axis: 'y', index: 1, range: { x: [0, 3], z: [0, 3] } })
    const entry = result.legend.find((e) => e.block.startsWith('minecraft:oak_stairs'))!
    expect(entry.block).toBe(
      'minecraft:oak_stairs[facing=east,half=bottom,shape=straight,waterlogged=false]',
    )
    expect(entry.count).toBe(1)
  })

  it('range 限制生效', () => {
    const store = makeStore()
    const result = renderSlice(store, {
      axis: 'y',
      index: 0,
      range: { x: [4, 9], z: [2, 5] },
    })
    expect(result.columns).toBe(6)
    expect(result.rows).toBe(4)
    expect(result.extent).toEqual({
      min: { x: 4, y: 0, z: 2 },
      max: { x: 9, y: 0, z: 5 },
    })
  })

  it('range 的端点顺序任意', () => {
    const a = renderSlice(makeStore(), { axis: 'y', index: 0, range: { x: [9, 4] } })
    const b = renderSlice(makeStore(), { axis: 'y', index: 0, range: { x: [4, 9] } })
    expect(a.text).toBe(b.text)
  })

  it('超过单元格上限时报错并说明当前规模（不静默截断）', () => {
    const big = makeStore({ min: { x: 0, y: 0, z: 0 }, max: { x: 255, y: 255, z: 255 } })
    expect(() => renderSlice(big, { axis: 'y', index: 0 })).toThrow(/exceeding the limit/)
    expect(() => renderSlice(big, { axis: 'y', index: 0 })).toThrow(/Shrink the range/)
    expect(() =>
      renderSlice(big, { axis: 'y', index: 0, range: { x: [0, 63], z: [0, 63] } }),
    ).not.toThrow()
  })

  it('默认单元格上限是 4096', () => {
    expect(DEFAULT_MAX_SLICE_CELLS).toBe(4096)
  })

  it('切片平面外的 index 渲染成全空气而不是报错', () => {
    const store = makeStore()
    store.setBlock({ x: 1, y: 1, z: 1 }, 'minecraft:stone')
    const result = renderSlice(store, { axis: 'y', index: 99, range: { x: [0, 3], z: [0, 3] } })
    expect(result.text).toContain('.'.repeat(4))
    expect(result.legend).toHaveLength(1)
    expect(result.legend[0]!.block).toBe('minecraft:air')
  })

  it('自定义字形会被采用', () => {
    const store = makeStore()
    store.setBlock({ x: 0, y: 0, z: 0 }, 'minecraft:stone')
    const block = store.getBlockString({ x: 0, y: 0, z: 0 })
    const result = renderSlice(store, {
      axis: 'y',
      index: 0,
      range: { x: [0, 1], z: [0, 0] },
      glyphs: { [block]: '@' },
    })
    expect(rowAt(result.text, 0)).toBe('@.')
  })

  it('输出含表头、图例与列标尺', () => {
    const result = renderSlice(makeStore(), { axis: 'y', index: 3, range: { x: [0, 9], z: [0, 2] } })
    expect(result.text).toContain('slice(axis=y, index=3)')
    expect(result.text).toContain('x[0..9]')
    expect(result.text).toContain('legend:')
    expect(result.text).toContain('x→')
  })
})

describe('measure', () => {
  it('空世界', () => {
    const result = measure(makeStore())
    expect(result.bounds).toBeUndefined()
    expect(result.size).toBeUndefined()
    expect(result.blocks).toBe(0)
    expect(result.histogram).toEqual([])
    expect(formatMeasure(result)).toContain('The world is empty')
  })

  it('包围盒、尺寸与直方图', () => {
    const store = makeStore()
    store.setBlock({ x: 2, y: 1, z: 3 }, 'minecraft:stone')
    store.setBlock({ x: 5, y: 4, z: 7 }, 'minecraft:stone')
    store.setBlock({ x: 3, y: 2, z: 4 }, 'minecraft:dirt')

    const result = measure(store)
    expect(result.bounds).toEqual({ min: { x: 2, y: 1, z: 3 }, max: { x: 5, y: 4, z: 7 } })
    expect(result.size).toEqual({ x: 4, y: 4, z: 5 })
    expect(result.blocks).toBe(3)
    expect(result.histogram[0]!.block).toBe('minecraft:stone')
    expect(result.histogram[0]!.count).toBe(2)
    expect(result.histogram[0]!.percent).toBeCloseTo(66.7, 1)
  })

  it('formatMeasure 有界输出（方块种类多时折叠）', () => {
    const store = makeStore()
    const names = ['stone', 'dirt', 'glass', 'oak_planks', 'bricks', 'sand', 'gravel', 'clay',
      'oak_log', 'spruce_log', 'birch_log', 'jungle_log', 'acacia_log', 'dark_oak_log', 'mangrove_log']
    names.forEach((name, i) => store.setBlock({ x: i, y: 0, z: 0 }, `minecraft:${name}`))
    const text = formatMeasure(measure(store))
    expect(text).toContain('blocks: 15')
    expect(text).toContain('3 more block types')
  })

  it('volumeOf 返回工区体积', () => {
    expect(volumeOf(makeStore())).toBe(16 * 16 * 16)
  })

  it('hollow 盒子的直方图正确', () => {
    const store = makeStore()
    store.write(
      (v) => forEachBox({ x: 0, y: 0, z: 0 }, { x: 3, y: 3, z: 3 }, 'hollow', v),
      store.palette.indexOf('minecraft:stone'),
      { confirm: true },
    )
    const result = measure(store)
    expect(result.blocks).toBe(4 * 4 * 4 - 2 * 2 * 2)
    expect(result.histogram).toHaveLength(1)
    expect(result.histogram[0]!.percent).toBe(100)
  })
})
