import { describe, expect, it } from 'vitest'

import { AIR, Palette } from '../src/palette.js'
import { loadRegistry } from '../src/registry.js'
import { stateIdToString } from '../src/state.js'
import { createChunkColumn } from '../src/world/column.js'

const registry = loadRegistry('1.21.4')

describe('Palette 双层映射', () => {
  it('索引 0 恒为 air', () => {
    const palette = new Palette(registry)
    expect(palette.size).toBe(1)
    expect(palette.stateString(0)).toBe(AIR)
    expect(palette.indexOf('minecraft:air')).toBe(0)
  })

  it('等价写法（顺序不同 / 省略默认属性）落到同一索引', () => {
    const palette = new Palette(registry)
    const a = palette.indexOf('oak_stairs[facing=east]')
    const b = palette.indexOf(
      'minecraft:oak_stairs[waterlogged=false,shape=straight,half=bottom,facing=east]',
    )
    expect(a).toBe(b)
    expect(palette.size).toBe(2)
    expect(palette.stateString(a)).toBe(
      'minecraft:oak_stairs[facing=east,half=bottom,shape=straight,waterlogged=false]',
    )
  })

  it('toGlobalStateIds 的每一项都能反查回同一个方块', () => {
    const palette = new Palette(registry)
    for (const s of ['minecraft:stone', 'oak_stairs[facing=east]', 'water[level=3]']) palette.indexOf(s)
    const table = palette.toGlobalStateIds()
    expect(table).toHaveLength(palette.size)
    for (let i = 0; i < palette.size; i++) {
      const stateId = table[i]!
      const block = registry.blockByStateId(stateId)!
      expect(stateIdToString(block, stateId)).toBe(palette.stateString(i))
    }
  })

  it('toGlobalStateIds 会缓存，且新增条目后失效重建', () => {
    const palette = new Palette(registry)
    palette.indexOf('minecraft:stone')
    const first = palette.toGlobalStateIds()
    expect(palette.toGlobalStateIds()).toBe(first)
    palette.indexOf('minecraft:dirt')
    const second = palette.toGlobalStateIds()
    expect(second).not.toBe(first)
    expect(second).toHaveLength(3)
  })

  it('toJSON / fromJSON 往返一致（含手改过的非规范写法）', () => {
    const palette = new Palette(registry)
    palette.indexOf('minecraft:stone')
    palette.indexOf('oak_stairs[facing=west]')
    const json = palette.toJSON()
    expect(json.minecraftVersion).toBe('1.21.4')

    const restored = Palette.fromJSON(registry, json)
    expect(restored.strings()).toEqual(palette.strings())

    const handEdited = Palette.fromJSON(registry, {
      entries: [AIR, 'stone', 'oak_stairs[half=top,facing=south]'],
    })
    expect(handEdited.size).toBe(3)
    expect(handEdited.stateString(2)).toBe(
      'minecraft:oak_stairs[facing=south,half=top,shape=straight,waterlogged=false]',
    )
  })

  it('fromGlobalStateIds 与 indexOf 得到同一张表', () => {
    const stairs = registry.blockByName('oak_stairs')!
    const ids = [0, registry.blockByName('stone')!.defaultState, stairs.defaultState]
    const fromIds = Palette.fromGlobalStateIds(registry, ids)
    const fromStrings = new Palette(registry)
    for (const id of ids) fromStrings.indexOf(stateIdToString(registry.blockByStateId(id)!, id))
    expect(fromIds.strings()).toEqual(fromStrings.strings())
  })

  it('越界索引与未知方块都报错', () => {
    const palette = new Palette(registry)
    expect(() => palette.stateString(5)).toThrow(RangeError)
    expect(() => palette.indexOf('minecraft:not_a_block')).toThrow()
  })
})

describe('与 prismarine-chunk 的集成（内存层）', () => {
  it('ChunkColumn 接受普通 {x,y,z}，且调色板索引能落进世界', () => {
    const palette = new Palette(registry)
    const stone = palette.indexOf('minecraft:stone')
    const table = palette.toGlobalStateIds()

    const column = createChunkColumn('1.21.4')
    column.setBlockStateId({ x: 3, y: 70, z: 5 }, table[stone]!)
    column.setBlockStateId({ x: 3, y: -60, z: 5 }, table[stone]!)

    expect(column.getBlockStateId({ x: 3, y: 70, z: 5 })).toBe(table[stone])
    expect(column.getBlockStateId({ x: 3, y: -60, z: 5 })).toBe(table[stone])
    // 未写入的地方是 air（stateId 0）
    expect(column.getBlockStateId({ x: 4, y: 70, z: 5 })).toBe(0)
  })
})
