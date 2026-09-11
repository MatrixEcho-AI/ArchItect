import { loadBakedBlockMap } from './baked.js'
import type { BakedBlockMap } from './baked.js'
import { averageColor, decodePng } from './png.js'
import type { TexturePack } from './texturepack.js'

export interface Appearance {
  r: number
  g: number
  b: number
  /** 0..1，来自纹理的平均不透明度（玻璃 ≈ 0.25）。 */
  a: number
}

export type ColorResolver = (blockName: string) => Appearance

/**
 * 基于**资源包纹理**的方块颜色表，读不到就退回**烘好的平均色**。
 *
 * 三级台阶，任何一级都不至于渲染成一片黑或一片洋红：
 *
 * 1. 资源包里有这张纹理 → 现场解码算平均色（用户换了自己的材质包，颜色也跟着变）；
 * 2. 没有 → 用 `bake.ts` 烘出来的平均色（形状、UV、明暗全对，只是没有花纹）；
 * 3. 连平均色都没有（技术方块、新方块）→ 中性灰，见 `UNKNOWN_APPEARANCE`。
 *
 * 平均色按需解码并缓存：一个工程通常只用几十种方块，而 1.21.4 有 1000 多张纹理，
 * 全解一遍要好几秒。
 *
 * **方块名 → 纹理路径**的反查表是烘好的（`data/<版本>/blockmap.json`）。
 * 它来自 `minecraft-assets` 的 `getTexture()`——那里面是原版那套回退
 * （`oak_fence` → `oak_planks`、`glass_pane` → `glass`），比手写一堆后缀规则准得多。
 */
export function createPackColorResolver(minecraftVersion: string, pack: TexturePack): ColorResolver {
  const baked = loadBakedBlockMap(minecraftVersion)
  const cache = new Map<string, Appearance>()

  return (blockName: string): Appearance => {
    const key = blockName.replace(/^minecraft:/, '')
    const cached = cache.get(key)
    if (cached !== undefined) return cached
    const appearance = appearanceOf(key, pack, baked)
    cache.set(key, appearance)
    return appearance
  }
}

/** 先按烘好的反查表找那张纹理，再退回"方块名就是纹理名"。 */
function appearanceOf(key: string, pack: TexturePack, baked: BakedBlockMap): Appearance {
  const path = baked.textures[key]
  const candidates = path !== undefined ? [path] : [`block/${key}`]
  for (const candidate of candidates) {
    const bytes = pack.read(candidate)
    if (bytes === undefined) continue
    try {
      const average = averageColor(decodePng(bytes))
      return { r: average.r, g: average.g, b: average.b, a: average.alpha / 255 }
    } catch {
      // 单张纹理解不开不该让整栋建筑渲染不出来：往下走，用烘好的平均色
      break
    }
  }
  return bakedAppearance(baked, key)
}

/** 烘好的平均色（`[r, g, b, a]`，alpha 是 0..255）。 */
function bakedAppearance(baked: BakedBlockMap, key: string): Appearance {
  const color = baked.colors[key]
  if (color === undefined) return UNKNOWN_APPEARANCE
  return { r: color[0] ?? 0, g: color[1] ?? 0, b: color[2] ?? 0, a: (color[3] ?? 255) / 255 }
}

/**
 * 未知方块的颜色。
 *
 * 用**中性灰**而不是哈希随机色：随机色会让一堵墙变成紫色，
 * LLM 会据此建立错误的心智模型（"我选了紫色的方块吗？"）。
 * 灰色诚实地表达"这个材质的真实样貌我们不知道"。
 */
const UNKNOWN_APPEARANCE: Appearance = { r: 150, g: 150, b: 150, a: 1 }

/**
 * 确定性的兜底颜色：由方块名哈希到 HSL 再转 RGB。
 *
 * 用途有两个——资源包与平均色都没有时不至于渲染成一片黑，以及让 golden 测试
 * 不依赖任何资源包（`--plain`）。
 */
export function fallbackAppearance(blockName: string): Appearance {
  let hash = 0x811c9dc5
  for (let i = 0; i < blockName.length; i++) {
    hash ^= blockName.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  const hue = (hash % 360) / 360
  const saturation = 0.35 + ((hash >>> 9) % 40) / 100
  const lightness = 0.35 + ((hash >>> 17) % 30) / 100
  const { r, g, b } = hslToRgb(hue, saturation, lightness)
  return { r, g, b, a: 1 }
}

/** 完全不依赖任何资源的颜色解析器（确定性，供 CI 与 golden 测试使用）。 */
export function createFallbackColorResolver(): ColorResolver {
  const cache = new Map<string, Appearance>()
  return (blockName: string): Appearance => {
    const key = blockName.replace(/^minecraft:/, '')
    let cached = cache.get(key)
    if (cached === undefined) {
      cached = fallbackAppearance(key)
      cache.set(key, cached)
    }
    return cached
  }
}

function hslToRgb(h: number, s: number, l: number): { r: number; g: number; b: number } {
  const c = (1 - Math.abs(2 * l - 1)) * s
  const x = c * (1 - Math.abs(((h * 6) % 2) - 1))
  const m = l - c / 2
  let r = 0
  let g = 0
  let b = 0
  const sector = Math.floor(h * 6) % 6
  if (sector === 0) [r, g, b] = [c, x, 0]
  else if (sector === 1) [r, g, b] = [x, c, 0]
  else if (sector === 2) [r, g, b] = [0, c, x]
  else if (sector === 3) [r, g, b] = [0, x, c]
  else if (sector === 4) [r, g, b] = [x, 0, c]
  else [r, g, b] = [c, 0, x]
  return {
    r: Math.round((r + m) * 255),
    g: Math.round((g + m) * 255),
    b: Math.round((b + m) * 255),
  }
}
