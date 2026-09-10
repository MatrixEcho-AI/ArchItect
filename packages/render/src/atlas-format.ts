/**
 * 图集的**数据格式**与查询，不碰文件系统。
 *
 * 单独一个模块的理由：软件光栅器与浏览器里的 three.js 视口都要按 UV 判断
 * "这个面该走不透明通道还是半透明通道"，而 `atlas.ts` 会 `import 'node:fs'`——
 * 渲染进程（Chromium）里 import 到它就整包崩。把格式与查询放在这里，
 * 两边共用同一份判据，不会一边改了另一边忘了。
 */

/** 一张纹理在图集里的像素边长。Minecraft 的方块纹理就是 16×16。 */
export const TILE_SIZE = 16

/** 图集里一张纹理的归一化矩形。 */
export interface AtlasIndexEntry {
  u: number
  v: number
  su: number
  sv: number
}

export interface TextureAtlas {
  /** 图集边长（像素），等于 `tilesPerRow * TILE_SIZE`。 */
  size: number
  /** RGBA8，长度 = `size * size * 4`。 */
  data: Uint8Array
  /** 纹理名（不带 `.png`）→ 归一化矩形。 */
  textures: Record<string, AtlasIndexEntry>
  /** 解码失败的纹理名（如实报出来，不静默填黑）。 */
  decodeFailures?: string[]
}

/** 图集里一行放几个 tile。 */
export const tilesPerRowOf = (atlas: Pick<TextureAtlas, 'size'>): number => Math.round(atlas.size / TILE_SIZE)

/** 归一化 UV → tile 序号。越界会夹到合法范围（UV 恰好落在 1.0 上时会出现）。 */
export function tileIndex(u: number, v: number, tilesPerRow: number): number {
  const tx = Math.min(tilesPerRow - 1, Math.max(0, Math.floor(u * tilesPerRow)))
  const ty = Math.min(tilesPerRow - 1, Math.max(0, Math.floor(v * tilesPerRow)))
  return ty * tilesPerRow + tx
}

/**
 * 逐 tile 的"是否全不透明"表。
 *
 * 决定一个面走哪条渲染通道：全不透明的可以写深度、不混合；只要有一像素半透明
 * 就得按半透明处理。判错会出现的症状是"玻璃后面的东西时有时无"。
 */
export function buildOpaqueTileTable(atlas: Pick<TextureAtlas, 'size' | 'data'>): Uint8Array {
  const tiles = tilesPerRowOf(atlas)
  const table = new Uint8Array(tiles * tiles)
  for (let ty = 0; ty < tiles; ty++) {
    for (let tx = 0; tx < tiles; tx++) {
      let opaque = 1
      for (let y = 0; y < TILE_SIZE && opaque === 1; y++) {
        for (let x = 0; x < TILE_SIZE; x++) {
          const o = ((ty * TILE_SIZE + y) * atlas.size + tx * TILE_SIZE + x) * 4
          if (atlas.data[o + 3]! < 255) {
            opaque = 0
            break
          }
        }
      }
      table[ty * tiles + tx] = opaque
    }
  }
  return table
}

/**
 * 最近邻采样，**并夹到 tile 内部半个纹素**。
 *
 * 不夹的话，正好落在 tile 边界上的 UV 会采到隔壁纹理——症状是墙上出现一条
 * 别处纹理的彩线，而且只在特定缩放下出现（最难查的那类 bug）。
 */
export function sampleAtlas(
  atlas: Pick<TextureAtlas, 'size' | 'data'>,
  u: number,
  v: number,
): [number, number, number, number] {
  const size = atlas.size
  const half = 0.5 / size
  const eu = Math.min(1 - half, Math.max(half, u))
  const ev = Math.min(1 - half, Math.max(half, v))
  const x = Math.min(size - 1, Math.max(0, Math.floor(eu * size)))
  const y = Math.min(size - 1, Math.max(0, Math.floor(ev * size)))
  const o = (y * size + x) * 4
  return [atlas.data[o]!, atlas.data[o + 1]!, atlas.data[o + 2]!, atlas.data[o + 3]!]
}
