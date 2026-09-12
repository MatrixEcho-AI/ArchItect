import { TILE_SIZE } from './atlas-format.js'
import type { AtlasIndexEntry, TextureAtlas } from './atlas-format.js'
import { Canvas, encodePng } from './canvas.js'
import { decodePng } from './png.js'
import type { TexturePack } from './texturepack.js'

/**
 * **实体图集**：一张等大 tile 网格，但 tile 尺寸由内容决定，而不是写死 16。
 *
 * 为什么不是货架装箱的任意矩形：光栅器的"不透明 / 半透明"判据是
 * "重心 UV → tile 序号 → 查表"，而那个查表假设**等大网格**。任意矩形会让重心
 * 落到一个毫不相干的格子上，判据变成随机——症状是"玻璃后面的东西时有时无"。
 * 等大网格 + 可变的 tile 尺寸既让 128×64 的船贴图装得进来，又不动那条判据。
 *
 * 两条与方块图集不同的地方：
 *
 * 1. **tile 尺寸按内容取**：等于这批贴图里最大的那条边长向上取到 2 的幂。
 *    一个只有船的场景是 128，来一条末影龙就是 256（内存 4 MB / 16 MB）。
 * 2. **tile 里塞不满是常态**（128×64 的贴图放进 128×128 的 tile），所以
 *    `tileExtents` 必须逐 tile 记下真实尺寸——否则那块空白（alpha=0）
 *    会把整条船判成半透明。
 */

/** 兜底盒用的贴图名。它不是从资源包读的，是这个模块自己画的中性灰。 */
export const ENTITY_FALLBACK_TEXTURE = '__fallback_entity'

export interface EntityAtlas {
  atlas: TextureAtlas
  /** 请求了但读不到或解不开的贴图路径。**如实报出来**，不静默填黑。 */
  missing: string[]
}

/** 图集边长的上限。超过就报错，而不是悄悄吃掉 64 MB。 */
const MAX_ATLAS_SIZE = 4096

const nextPowerOfTwo = (value: number): number => {
  let size = 1
  while (size < value) size *= 2
  return size
}

/**
 * 按需要用到的那批贴图建一张实体图集。
 *
 * `paths` 里出现 `ENTITY_FALLBACK_TEXTURE` 时会附带一块自己画的灰 tile
 * （兜底盒没有自己的贴图，但光栅器总得采到点什么）。
 */
export function buildEntityAtlas(pack: TexturePack, paths: readonly string[]): EntityAtlas {
  const wanted = [...new Set(paths)].sort()
  const missing: string[] = []
  const images: Array<{ path: string; width: number; height: number; data: Uint8Array }> = []

  for (const path of wanted) {
    if (path === ENTITY_FALLBACK_TEXTURE) {
      images.push(fallbackImage())
      continue
    }
    const bytes = pack.read(path)
    if (bytes === undefined) {
      missing.push(path)
      continue
    }
    try {
      const image = decodePng(bytes)
      images.push({ path, width: image.width, height: image.height, data: image.data })
    } catch {
      missing.push(path)
    }
  }

  // 兜底 tile 永远在 0 号位：与方块图集的 missing_texture 一个位置约定，
  // 也让"一个能画的实体都没有"时仍然有一张合法的图集
  if (!images.some((image) => image.path === ENTITY_FALLBACK_TEXTURE)) images.unshift(fallbackImage())

  const tileSize = Math.max(TILE_SIZE, nextPowerOfTwo(Math.max(...images.map((i) => Math.max(i.width, i.height)))))
  const tilesPerRow = nextPowerOfTwo(Math.ceil(Math.sqrt(images.length)))
  const size = tilesPerRow * tileSize
  if (size > MAX_ATLAS_SIZE) {
    throw new RangeError(
      `实体图集需要 ${size}×${size}（${images.length} 张、最大的 ${tileSize}px），超过上限 ${MAX_ATLAS_SIZE}。`,
    )
  }

  const data = new Uint8Array(size * size * 4)
  const textures: Record<string, AtlasIndexEntry> = {}
  const tileExtents = new Int32Array(tilesPerRow * tilesPerRow * 2)

  for (let i = 0; i < images.length; i++) {
    const image = images[i]!
    const x = (i % tilesPerRow) * tileSize
    const y = Math.floor(i / tilesPerRow) * tileSize
    // `su`/`sv` 用**贴图自己的**尺寸，不是 tile 尺寸：模型的 UV 是纹理空间的
    // 归一化坐标，映射到 tile 时会自己撑满，不需要这里替它拉伸
    textures[image.path] = {
      u: x / size,
      v: y / size,
      su: image.width / size,
      sv: image.height / size,
    }
    tileExtents[i * 2] = image.width
    tileExtents[i * 2 + 1] = image.height

    for (let row = 0; row < image.height; row++) {
      const source = row * image.width * 4
      data.set(
        image.data.subarray(source, source + image.width * 4),
        ((y + row) * size + x) * 4,
      )
    }
  }

  return {
    atlas: { size, data, textures, tileSize, tileExtents, source: pack.id },
    missing,
  }
}

/** 兜底 tile：中性灰（与"未知方块"同一个取色，见 colors.ts）。 */
function fallbackImage(): { path: string; width: number; height: number; data: Uint8Array } {
  const canvas = new Canvas(TILE_SIZE, TILE_SIZE, { r: 150, g: 150, b: 150 })
  const png = encodePng(canvas)
  const image = decodePng(png)
  return { path: ENTITY_FALLBACK_TEXTURE, width: image.width, height: image.height, data: image.data }
}
