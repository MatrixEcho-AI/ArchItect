/**
 * **把渲染元数据从 `minecraft-assets` 里烘出来**（只在开发/构建期跑）。
 *
 * 为什么要烘：`minecraft-assets` 把**每个版本**的整套资源包都装进了包里
 * （1.21.4 一个版本就是 3302 个文件），而渲染真正需要的只有三样东西——
 * 方块状态表、模型表、以及"方块名 → 纹理路径"的反查表。前两样是**结构数据**，
 * 加起来 2.3 MB；第三样是几百 KB 的字符串。真正占地方的是 6 万多个 PNG，
 * 那是**美术资源**，既不该由我们分发，也不该塞进安装包。
 *
 * 于是切成两半：
 *
 * - **构建期**（这里）：从 `minecraft-assets` 取出结构数据，写进 `data/<版本>/`。
 * - **运行期**（`texturepack.ts`）：纹理字节改成从**用户自己的 `.minecraft`** 里读，
 *   读不到就用这里烘出来的平均色画纯色。
 *
 * 产出必须**逐字节可复现**：同一个 `minecraft-assets` 版本烘两次结果必须一样，
 * 否则 `pnpm bake:check` 会一直报"过期"，而人会开始习惯性忽略它。
 * 所以：键排序、不写时间戳、不写绝对路径。
 */
import { readdirSync } from 'node:fs'
import { join } from 'node:path'

import assetsModule from 'minecraft-assets'

import { BAKED_FORMAT } from './baked.js'
import { averageColor, decodeDataUri } from './png.js'
import type { RgbaImage } from './png.js'

/** `minecraft-assets` 里我们用得到的部分（它没有类型声明，这里窄化一次）。 */
interface AssetsModule {
  directory?: string
  blocks?: Record<string, { texture?: string | null } | undefined>
  textureContent?: Record<string, { texture?: string | null } | undefined>
  blocksStates: unknown
  blocksModels: unknown
  version?: string
  getTexture?: (name: string) => string | null
}

function loadAssets(version: string): AssetsModule {
  const load = assetsModule as unknown as (v: string) => AssetsModule
  const assets = load(version)
  if (assets === undefined || assets === null) {
    throw new Error(`minecraft-assets 没有版本 "${version}"`)
  }
  return assets
}

/**
 * 纹理路径归一化。
 *
 * `minecraft-assets` 的 `getTexture()` 会同时吐出三种口径：`block/stone`、
 * `blocks/water_still`、`minecraft:blocks/stone`。资源包里的真实路径只有一种：
 * `assets/minecraft/textures/block/stone.png`。所以统一剥掉命名空间、
 * 把旧的复数 `blocks/`、`items/` 折成 `block/`、`item/`。
 *
 * `missingno` 是原版"纹理不存在"的占位图，不是真纹理，返回 undefined。
 */
export function normalizeTexturePath(raw: string | null | undefined): string | undefined {
  if (typeof raw !== 'string' || raw.length === 0) return undefined
  let path = raw.replace(/^minecraft:/, '')
  if (path === 'missingno' || path.endsWith('/missingno')) return undefined
  if (path.startsWith('blocks/')) path = `block/${path.slice('blocks/'.length)}`
  else if (path.startsWith('items/')) path = `item/${path.slice('items/'.length)}`
  return path
}

/**
 * 方块名 → 纹理路径。
 *
 * 用 `getTexture()` 而不是 `blocks[name].texture`：前者会做原版那套回退
 * （`oak_fence` → `oak_planks`、`glass_pane` → `glass`），后者对派生方块是 `null`。
 * 少数方块（`redstone_wire`）它直接抛异常，那时退回 `blocks[name].texture`。
 */
function texturePathOf(assets: AssetsModule, name: string): string | undefined {
  if (typeof assets.getTexture === 'function') {
    try {
      const resolved = normalizeTexturePath(assets.getTexture(name))
      if (resolved !== undefined) return resolved
    } catch {
      // 落到下面的直接字段
    }
  }
  return normalizeTexturePath(assets.blocks?.[name]?.texture)
}

/** 键排序后重新拼一个对象，让 `JSON.stringify` 的输出与插入顺序无关。 */
function sortKeys<T>(record: Record<string, T>): Record<string, T> {
  const sorted: Record<string, T> = {}
  for (const key of Object.keys(record).sort()) sorted[key] = record[key]!
  return sorted
}

/**
 * 结构数据（紧凑成一行）。
 *
 * 紧凑是有意的：这是 2.3 MB 的生成数据，**没有人会读 diff**，
 * 排版成多行只会让仓库里的这份文件变成几万行的噪声。可读的那部分
 * （反查表、颜色表）在 `blockmap.json` 里，那份是排过版的。
 */
export function bakeRenderJson(version: string): string {
  const assets = loadAssets(version)
  const payload = {
    format: BAKED_FORMAT,
    version,
    blocksStates: assets.blocksStates,
    blocksModels: assets.blocksModels,
  }
  return `${JSON.stringify(payload)}\n`
}

/**
 * 反查表与颜色表（排版过，能读 diff）。
 *
 * `colors` 存的是每种纹理的**平均色**，用来在没有资源包时画纯色。
 * 在构建期算一次，运行期就不必再解码 1480 张 PNG——那要好几秒。
 */
export function bakeBlockMap(version: string): string {
  const assets = loadAssets(version)

  const textures: Record<string, string> = {}
  for (const name of Object.keys(assets.blocks ?? {}).sort()) {
    const path = texturePathOf(assets, name)
    if (path !== undefined) textures[name] = path
  }

  const colors: Record<string, number[]> = {}
  for (const name of Object.keys(assets.textureContent ?? {}).sort()) {
    const entry = assets.textureContent?.[name]
    if (typeof entry?.texture !== 'string') continue
    let image: RgbaImage
    try {
      image = decodeDataUri(entry.texture)
    } catch {
      // 单张纹理解不开不该让整个烘焙失败：那种方块在纯色模式下会是灰的，
      // 而灰是这里最诚实的表达（见 colors.ts 的 UNKNOWN_APPEARANCE）。
      continue
    }
    const average = averageColor(image)
    colors[name] = [average.r, average.g, average.b, average.alpha]
  }

  // **图集要哪些 tile** 由资源包目录里的文件清单说了算（不是"有哪些方块的贴图"）。
  // 模型会引用一些不属于任何方块的纹理（`destroy_stage_*`、`missing_texture` 之类），
  // 只按方块反推的话会漏掉它们，最后在 mesher 里炸成一句看不懂的 JSON 报错。
  // 记下这份清单，平均色兜底（`bakedColorTexturePack`）才能给出**同一张图集**。
  const tiles = textureTiles(assets)
  const payload = { format: BAKED_FORMAT, version, tiles, textures, colors: sortKeys(colors) }
  return `${JSON.stringify(payload, null, 2)}\n`
}

/** 资源包 `blocks/` 目录里的全部纹理名（去扩展名、升序）——图集的 tile 清单。 */
function textureTiles(assets: AssetsModule): string[] {
  const directory = assets.directory
  if (typeof directory !== 'string') return []
  try {
    return readdirSync(join(directory, 'blocks'))
      .filter((file) => file.endsWith('.png'))
      .map((file) => file.slice(0, -'.png'.length))
      .sort()
  } catch {
    return []
  }
}

/** 这个版本能不能烘（`minecraft-assets` 有没有它）。 */
export function canBake(version: string): boolean {
  try {
    return loadAssets(version) !== undefined
  } catch {
    return false
  }
}
