import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import minecraftAssets from 'minecraft-assets'
import { describe, expect, it } from 'vitest'

import { buildTextureAtlas, MISSING_TEXTURE_NAME, TILE_SIZE } from '../src/atlas.js'
import { assetsTexturePack } from '../src/assets.js'
import type { AtlasIndexEntry } from '../src/atlas.js'
import { decodePng } from '../src/png.js'

const VERSION = '1.21.4'

/**
 * 整个文件共用一张图集：构建一次要解 1040 张 PNG（约 1 秒），
 * 而 `buildTextureAtlas` 有模块级缓存，后续用例都是零成本。
 */
const atlas = buildTextureAtlas(VERSION, assetsTexturePack(VERSION))

const loadAssets = minecraftAssets as unknown as (version: string) => { directory: string }
const assetsDirectory = loadAssets(VERSION).directory

function entryOf(name: string): AtlasIndexEntry {
  const entry = atlas.textures[name]
  if (entry === undefined) throw new Error(`图集里没有纹理 "${name}"`)
  return entry
}

interface Rect {
  x0: number
  y0: number
  x1: number
  y1: number
}

function rectOf(entry: AtlasIndexEntry): Rect {
  return { x0: entry.u, y0: entry.v, x1: entry.u + entry.su, y1: entry.v + entry.sv }
}

function overlaps(a: Rect, b: Rect): boolean {
  return a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1
}

/**
 * 按索引从图集里取出一个 tile。刻意走 `u/v/su/sv` 而不是另算偏移：
 * mesher 将来就是按这套归一化坐标采样的，测试要走同一条路径才有意义。
 */
function tilePixels(entry: AtlasIndexEntry): Uint8Array {
  const x = Math.round(entry.u * atlas.size)
  const y = Math.round(entry.v * atlas.size)
  const width = Math.round(entry.su * atlas.size)
  const height = Math.round(entry.sv * atlas.size)
  const out = new Uint8Array(width * height * 4)
  for (let row = 0; row < height; row++) {
    const start = ((y + row) * atlas.size + x) * 4
    out.set(atlas.data.subarray(start, start + width * 4), row * width * 4)
  }
  return out
}

/** 不透明像素的平均色，用来证明「平均色几乎一样、纹理内容差很多」。 */
function averageRgb(pixels: Uint8Array): { r: number; g: number; b: number } {
  let r = 0
  let g = 0
  let b = 0
  let count = 0
  for (let i = 0; i < pixels.length / 4; i++) {
    const alpha = pixels[i * 4 + 3]!
    if (alpha === 0) continue
    r += pixels[i * 4]!
    g += pixels[i * 4 + 1]!
    b += pixels[i * 4 + 2]!
    count++
  }
  if (count === 0) return { r: 0, g: 0, b: 0 }
  return { r: Math.round(r / count), g: Math.round(g / count), b: Math.round(b / count) }
}

function distinctColors(pixels: Uint8Array): Set<string> {
  const colors = new Set<string>()
  for (let i = 0; i < pixels.length / 4; i++) {
    colors.add(`${pixels[i * 4]},${pixels[i * 4 + 1]},${pixels[i * 4 + 2]},${pixels[i * 4 + 3]}`)
  }
  return colors
}

describe('纹理图集', () => {
  it('missing_texture 存在，而且永远是 tile 0（u=0,v=0）', () => {
    expect(MISSING_TEXTURE_NAME).toBe('missing_texture')
    const entry = entryOf(MISSING_TEXTURE_NAME)
    expect(entry.u).toBe(0)
    expect(entry.v).toBe(0)
    expect(entry.su).toBeCloseTo(TILE_SIZE / atlas.size)
    expect(entry.sv).toBeCloseTo(TILE_SIZE / atlas.size)
  })

  it('缺失纹理是自绘的洋红/黑棋盘格', () => {
    const pixels = tilePixels(entryOf(MISSING_TEXTURE_NAME))
    expect(pixels.length).toBe(TILE_SIZE * TILE_SIZE * 4)
    // 只有两种颜色，且是洋红与黑——和 Minecraft missingno 一致。
    expect([...distinctColors(pixels)].sort()).toEqual(['0,0,0,255', '255,0,255,255'])
    // 相邻格子颜色不同（棋盘格，而不是一整块纯色）：(0,0) 洋红，右移一个格宽后是黑。
    const at = (x: number, y: number): number => (y * TILE_SIZE + x) * 4
    expect([pixels[at(0, 0)], pixels[at(0, 0) + 1], pixels[at(0, 0) + 2]]).toEqual([255, 0, 255])
    expect([pixels[at(8, 0)], pixels[at(8, 0) + 1], pixels[at(8, 0) + 2]]).toEqual([0, 0, 0])
    expect([pixels[at(8, 8)], pixels[at(8, 8) + 1], pixels[at(8, 8) + 2]]).toEqual([255, 0, 255])
  })

  it('size 是 16 的整数倍，而且是 2 的幂', () => {
    expect(atlas.size % TILE_SIZE).toBe(0)
    expect(atlas.size).toBeGreaterThan(0)
    expect(atlas.size & (atlas.size - 1)).toBe(0)
    expect(atlas.data.length).toBe(atlas.size * atlas.size * 4)
  })

  it('每个 tile 的归一化矩形都落在 [0,1] 内', () => {
    for (const [name, entry] of Object.entries(atlas.textures)) {
      expect(entry.u, name).toBeGreaterThanOrEqual(0)
      expect(entry.v, name).toBeGreaterThanOrEqual(0)
      expect(entry.su, name).toBeGreaterThan(0)
      expect(entry.sv, name).toBeGreaterThan(0)
      expect(entry.u + entry.su, name).toBeLessThanOrEqual(1)
      expect(entry.v + entry.sv, name).toBeLessThanOrEqual(1)
    }
  })

  it('相邻 tile 不重叠（已知纹理两两互查 + 全图位置唯一）', () => {
    const known = ['missing_texture', 'stone', 'stone_bricks', 'oak_log', 'oak_planks', 'glass', 'dirt', 'sand']
    for (let i = 0; i < known.length; i++) {
      for (let j = i + 1; j < known.length; j++) {
        const a = rectOf(entryOf(known[i]!))
        const b = rectOf(entryOf(known[j]!))
        expect(overlaps(a, b), `${known[i]} 与 ${known[j]} 重叠`).toBe(false)
      }
    }
    // tile 尺寸统一时，「互不重叠」等价于「左上角位置两两不同」，
    // 这条能一次覆盖全部 1040 个 tile。
    const origins = new Set(Object.values(atlas.textures).map((entry) => `${entry.u},${entry.v}`))
    expect(origins.size).toBe(Object.keys(atlas.textures).length)
  })

  it('真实像素：stone_bricks 采到了砖缝，且与 stone 明显不同（本次改造的核心动机）', () => {
    // 解码失败会被填成缺失纹理，那样下面的断言会因为错误的原因通过——先排除这种情况。
    expect(atlas.decodeFailures ?? []).toEqual([])

    const bricks = tilePixels(entryOf('stone_bricks'))
    const stone = tilePixels(entryOf('stone'))
    expect(bricks.length).toBe(TILE_SIZE * TILE_SIZE * 4)
    expect(stone.length).toBe(TILE_SIZE * TILE_SIZE * 4)

    // 1) 不是单色：纯平均色渲染出来的图恰好只有一种颜色，这里必须是多种。
    expect(distinctColors(bricks).size).toBeGreaterThan(1)

    // 2) 两张纹理的平均色几乎一样（≈122 与 ≈126 的灰），
    //    但逐像素差异极大——这就是必须做纹理采样、而不是平均色的原因。
    const bricksAverage = averageRgb(bricks)
    const stoneAverage = averageRgb(stone)
    expect(Math.abs(bricksAverage.r - stoneAverage.r)).toBeLessThan(20)
    expect(Math.abs(bricksAverage.g - stoneAverage.g)).toBeLessThan(20)
    expect(Math.abs(bricksAverage.b - stoneAverage.b)).toBeLessThan(20)

    let different = 0
    for (let i = 0; i < TILE_SIZE * TILE_SIZE; i++) {
      const o = i * 4
      if (
        bricks[o] !== stone[o] ||
        bricks[o + 1] !== stone[o + 1] ||
        bricks[o + 2] !== stone[o + 2] ||
        bricks[o + 3] !== stone[o + 3]
      ) {
        different++
      }
    }
    const ratio = different / (TILE_SIZE * TILE_SIZE)
    expect(ratio).toBeGreaterThan(0.1)
  })

  it('动画纹理只取左上角第一帧', () => {
    const source = decodePng(readFileSync(join(assetsDirectory, 'blocks', 'water_still.png')))
    // water_still 是 16×512 的帧条，否则这条断言就失去意义了。
    expect(source.height).toBeGreaterThan(TILE_SIZE)

    const tile = tilePixels(entryOf('water_still'))
    let mismatches = 0
    for (let y = 0; y < TILE_SIZE; y++) {
      for (let x = 0; x < TILE_SIZE; x++) {
        const a = (y * TILE_SIZE + x) * 4
        const b = (y * source.width + x) * 4
        if (
          tile[a] !== source.data[b] ||
          tile[a + 1] !== source.data[b + 1] ||
          tile[a + 2] !== source.data[b + 2] ||
          tile[a + 3] !== source.data[b + 3]
        ) {
          mismatches++
        }
      }
    }
    expect(mismatches).toBe(0)
  })

  it('缓存：同一版本第二次调用返回同一个对象', () => {
    const again = buildTextureAtlas(VERSION, assetsTexturePack(VERSION))
    expect(again).toBe(atlas)
    expect(Object.keys(again.textures)).toEqual(Object.keys(atlas.textures))
    expect(again.data).toBe(atlas.data)
  })

  it('1.21.4 解出 1000+ 张纹理', () => {
    expect(Object.keys(atlas.textures).length).toBeGreaterThanOrEqual(1000)
  })
})
