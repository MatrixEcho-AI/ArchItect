/**
 * **无界世界：网格化不再看工区。**
 *
 * 这一组钉的是这次改动的核心：原来 `meshWorld` 是按 `store.volume` 三重循环扫的，
 * 所以"工区外新建的东西"根本画不出来。现在它按"哪些段真的有方块"遍历，
 * 与坐标范围无关——但**原点不动**，`(0,0,0)` 仍然是有意义的那一点。
 *
 * 为什么必须用真世界（而不是喂一个假的段来源）：面剔除与 AO 都是 mesher 按世界坐标
 * 去读邻居的，而"相邻段里的方块把面挡住"这类事只有真存储能表达。
 */

import { WorldStore } from '@architect/core'
import { describe, expect, it } from 'vitest'

import { assetsTexturePack } from '../src/assets.js'
import { loadRenderData, meshWorld } from '../src/mesher.js'

const VERSION = '1.21.4'
/** 一个**小的**声明工区：老实现只会网格化这 16³。 */
const VOLUME = { min: { x: 0, y: 0, z: 0 }, max: { x: 15, y: 15, z: 15 } }

const data = loadRenderData(VERSION, assetsTexturePack(VERSION))

function storeWith(blocks: Array<[number, number, number, string]>): WorldStore {
  const store = new WorldStore({ minecraftVersion: VERSION, volume: VOLUME })
  for (const [x, y, z, name] of blocks) store.setBlock({ x, y, z }, `minecraft:${name}`)
  return store
}

describe('无界世界的网格化', () => {
  it('**声明工区之外的方块照样画得出来**', () => {
    // x=500 远在 0..15 之外。老实现这里会得到零顶点（扫不到那一段）。
    const inside = meshWorld(storeWith([[3, 3, 3, 'stone']]), data)
    const outside = meshWorld(storeWith([[500, 3, 500, 'stone']]), data)
    expect(inside.vertices).toBeGreaterThan(0)
    expect(outside.vertices).toBe(inside.vertices)
    // 顶点确实落在 x=500 附近（不是被平移回原点画的）
    expect(Math.max(...outside.positions.filter((_, i) => i % 3 === 0))).toBeGreaterThan(450)
  })

  it('负坐标一样（原点不动，只是坐标往两边延伸）', () => {
    const geometry = meshWorld(storeWith([[-500, 3, -500, 'stone']]), data)
    expect(geometry.vertices).toBeGreaterThan(0)
    expect(Math.min(...geometry.positions.filter((_, i) => i % 3 === 0))).toBeLessThan(-450)
  })

  it('**两个相隔很远的块都画出来**（遍历与非空段成正比，与跨度无关）', () => {
    const geometry = meshWorld(
      storeWith([
        [0, 3, 0, 'stone'],
        [9000, 3, 9000, 'stone'],
      ]),
      data,
    )
    const single = meshWorld(storeWith([[0, 3, 0, 'stone']]), data)
    // 两块各自一个立方体：顶点数是单块的两倍（相隔再远也不会互相剔除）
    expect(geometry.vertices).toBe(single.vertices * 2)
  })

  it('相邻段之间的面仍然按邻居剔除（跨段不能漏）', () => {
    // 两块紧挨着横跨 x=15/16 这条段边界：贴在一起的那两个面都该被剔除
    const separate = meshWorld(
      storeWith([
        [15, 3, 3, 'stone'],
        [16, 3, 3, 'stone'],
      ]),
      data,
    )
    const one = meshWorld(storeWith([[15, 3, 3, 'stone']]), data)
    // 每块 6 面；贴在一起之后各自少 1 面（共少 2 面），所以顶点数少于 2 倍
    expect(separate.vertices).toBeLessThan(one.vertices * 2)
    expect(separate.vertices).toBeGreaterThan(0)
  })

  it('空世界是零顶点（不是报错）', () => {
    const geometry = meshWorld(storeWith([]), data)
    expect(geometry.vertices).toBe(0)
    expect(geometry.indices.length).toBe(0)
  })
})
