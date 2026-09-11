import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { bakeBlockMap, bakeRenderJson } from '../src/bake.js'
import {
  BAKED_FORMAT,
  bakedDataRoot,
  bakedVersions,
  loadBakedBlockMap,
  loadBakedRenderData,
} from '../src/baked.js'

const VERSION = '1.21.4'

describe('烘好的渲染元数据：结构与来源', () => {
  it('数据目录里能找到它，而且格式版本对得上', () => {
    const data = loadBakedRenderData(VERSION)
    expect(data.format).toBe(BAKED_FORMAT)
    expect(data.version).toBe(VERSION)
    expect(Object.keys(data.blocksStates).length).toBeGreaterThan(1000)
    expect(Object.keys(data.blocksModels).length).toBeGreaterThan(1000)
    expect(bakedVersions()).toContain(VERSION)
  })

  it('反查表与平均色：方块名 → 纹理路径 → 颜色', () => {
    const map = loadBakedBlockMap(VERSION)
    expect(map.textures['stone']).toBe('block/stone')
    // 派生方块要走原版那套回退：栅栏没有自己的纹理，用木板的
    expect(map.textures['oak_fence']).toBe('block/oak_planks')
    expect(map.tiles.length).toBeGreaterThan(1000)
    // 颜色是 0..255 的四个分量
    const stone = map.colors['stone']!
    expect(stone).toHaveLength(4)
    for (const channel of stone) expect(channel).toBeGreaterThanOrEqual(0)
    expect(map.colors['air']).toBeUndefined()
  })

  it('**两次加载拿到同一个对象**（`prepareBlocksStates` 会原地改写它）', () => {
    expect(loadBakedRenderData(VERSION)).toBe(loadBakedRenderData(VERSION))
    expect(loadBakedBlockMap(VERSION)).toBe(loadBakedBlockMap(VERSION))
  })

  it('数据目录的候选路径里有"源码旁边"那一项（打包后还有 resources/data）', () => {
    expect(bakedDataRoot()).toContain('data')
  })
})

describe('烘焙是可复现的（`pnpm bake:check` 的测试版）', () => {
  it('**结构数据与提交进仓库的那份逐字节相同**（改了 minecraft-assets 就会在这里挂）', () => {
    const committed = readFileSync(join(bakedDataRoot(), VERSION, 'render.json'), 'utf8')
    expect(bakeRenderJson(VERSION)).toBe(committed)
  })

  it('反查表与平均色也逐字节相同', () => {
    const committed = readFileSync(join(bakedDataRoot(), VERSION, 'blockmap.json'), 'utf8')
    expect(bakeBlockMap(VERSION)).toBe(committed)
  })
})
