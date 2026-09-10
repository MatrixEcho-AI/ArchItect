import minecraftAssets from 'minecraft-assets'

import { averageColor, decodeDataUri } from './png.js'

export interface Appearance {
  r: number
  g: number
  b: number
  /** 0..1，来自纹理的平均不透明度（玻璃 ≈ 0.25）。 */
  a: number
}

export type ColorResolver = (blockName: string) => Appearance

interface AssetsEntry {
  name?: string
  texture?: string
}

interface Assets {
  textureContent: Record<string, AssetsEntry>
}

/**
 * 基于 Minecraft 资源包纹理的方块颜色表。
 *
 * 每种方块取 16×16 纹理的**平均色**（全透明像素排除，其余按 alpha 加权）。
 * 只在真正用到时才解码，之后缓存——1480 张纹理全解一遍太慢，而一个工程通常只用几十种方块。
 *
 * 已知局限：`water` / `grass_block` / `leaves` 这类方块在游戏里会被**生物群系着色**，
 * 纹理本身是灰度的，所以这里的颜色会偏灰。带生物群系着色是后续的事。
 */
export function createAssetColorResolver(minecraftVersion: string): ColorResolver {
  const load = minecraftAssets as unknown as (version: string) => Assets
  const assets = load(minecraftVersion)
  if (assets === undefined || typeof assets.textureContent !== 'object') {
    throw new Error(`minecraft-assets 没有版本 "${minecraftVersion}" 的纹理`)
  }
  const cache = new Map<string, Appearance>()

  return (blockName: string): Appearance => {
    const key = blockName.replace(/^minecraft:/, '')
    const cached = cache.get(key)
    if (cached !== undefined) return cached
    const appearance = resolveAppearance(assets, key)
    cache.set(key, appearance)
    return appearance
  }
}

/**
 * 后缀 → 候选基名列表。
 *
 * 墙、栅栏、台阶、门这些方块在资源包里没有独立纹理（它们是引用基础材质的模型），
 * 所以要回退到基础方块上取色。**候选要有多个**：`oak_fence` 剥掉 `_fence` 得到 `oak`，
 * 而资源包里没有 `oak`——得再试 `oak_planks`。只试一个候选的话栅栏会变成灰色。
 */
const SUFFIX_FALLBACKS: ReadonlyArray<readonly [string, (base: string) => string[]]> = [
  ['_fence_gate', (b) => [`${b}_planks`, b]],
  ['_fence', (b) => [`${b}_planks`, b]],
  ['_stairs', (b) => [b, `${b}s`]],
  ['_slab', (b) => [b, `${b}s`]],
  ['_wall', (b) => [b, `${b}s`]],
  ['_door', (b) => [`${b}_planks`, b]],
  ['_trapdoor', (b) => [`${b}_planks`, b]],
  ['_pane', (b) => [b]],
  ['_button', (b) => [`${b}_planks`, b]],
  ['_pressure_plate', (b) => [`${b}_planks`, b]],
  ['_hanging_sign', (b) => [`${b}_planks`, b]],
  ['_sign', (b) => [`${b}_planks`, b]],
  ['_carpet', (b) => [`${b}_wool`, b]],
  ['_banner', (b) => [`${b}_wool`, b]],
]

/** 后缀剥离救不回来的少数方块，手工指一个"看起来就是它"的材质。 */
const TEXTURE_ALIASES: Record<string, string> = {
  glass_pane: 'glass',
  iron_bars: 'iron_block',
  vine: 'oak_leaves',
  pink_petals: 'pink_tulip',
  chiseled_bookshelf: 'bookshelf',
  mushroom_stem: 'brown_mushroom_block',
  brown_mushroom_block: 'brown_mushroom',
  red_mushroom_block: 'red_mushroom',
  bamboo: 'bamboo_block',
  chorus_plant: 'chorus_flower',
  tuff_brick_wall: 'tuff_bricks',
  tuff_wall: 'tuff',
  polished_tuff_wall: 'polished_tuff',
}

/**
 * 未知方块的颜色。
 *
 * 用**中性灰**而不是哈希随机色：随机色会让一堵墙变成紫色，
 * LLM 会据此建立错误的心智模型（"我选了紫色的方块吗？"）。
 * 灰色诚实地表达"这个材质的真实样貌我们不知道"。
 */
const UNKNOWN_APPEARANCE: Appearance = { r: 150, g: 150, b: 150, a: 1 }

function resolveAppearance(assets: Assets, key: string): Appearance {
  const direct = lookup(assets, key)
  if (direct !== undefined) return direct

  for (const [suffix, candidates] of SUFFIX_FALLBACKS) {
    if (!key.endsWith(suffix)) continue
    for (const candidate of candidates(key.slice(0, -suffix.length))) {
      const found = lookup(assets, candidate)
      if (found !== undefined) return found
    }
  }

  const alias = TEXTURE_ALIASES[key]
  if (alias !== undefined) {
    const aliased = lookup(assets, alias)
    if (aliased !== undefined) return aliased
  }

  return UNKNOWN_APPEARANCE
}

function lookup(assets: Assets, key: string): Appearance | undefined {
  const entry = assets.textureContent[key]
  // 必须判 `string` 而不是 `!== undefined`：minecraft-assets 里有些方块（技术方块、
  // 纯逻辑方块）的 texture 是 **null**，放行 null 会让 decodeDataUri 直接崩掉整个渲染。
  if (typeof entry?.texture !== 'string') return undefined
  const average = averageColor(decodeDataUri(entry.texture))
  return { r: average.r, g: average.g, b: average.b, a: average.alpha / 255 }
}

/**
 * 确定性的兜底颜色：由方块名哈希到 HSL 再转 RGB。
 *
 * 用途有两个——资源包缺失时不至于渲染成一片黑，以及让 golden 测试不依赖资源包。
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

/** 完全不依赖资源包的颜色解析器（确定性，供 CI 与 golden 测试使用）。 */
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
