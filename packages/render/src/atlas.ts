/**
 * 方块纹理图集（texture atlas）。
 *
 * 转写自 prismarine-viewer 的 `viewer/lib/atlas.js`（MIT 许可），原文件：
 * `node_modules/.pnpm/prismarine-viewer@1.33.0/node_modules/prismarine-viewer/viewer/lib/atlas.js`
 *
 * 为什么重写而不是直接用原版：原版依赖原生 `canvas`（node-canvas）来合成大图，
 * 那是个需要本地编译的二进制依赖，在纯 JS 的运行环境里装不上；这里改用仓库里
 * 已有的纯 JS PNG 解码器（`./png.js`）手工拷贝像素，产出的索引与原版 atlas.json
 * 逐字段兼容，vendored mesher 可以原样消费。
 *
 * 之所以要有图集：只看平均色时 `stone` 与 `stone_bricks` 都是 ~122 的灰，
 * 渲染出来一模一样；把真实纹理按 UV 采样进去，砖缝和石面才有区别。
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import minecraftAssets from 'minecraft-assets'

import { TILE_SIZE } from './atlas-format.js'
import type { AtlasIndexEntry, TextureAtlas } from './atlas-format.js'
import { decodePng } from './png.js'

export type { AtlasIndexEntry, TextureAtlas }

const MISSING_TEXTURE_FILE = 'missing_texture.png'
const MISSING_TEXTURE_NAME = 'missing_texture'
/** 缺失纹理的棋盘格边长（像素）。8 = 16×16 里 2×2 格，就是 Minecraft missingno 的样子。 */
const MISSING_CELL = 8

/**
 * 版本 → 图集。
 *
 * 必须缓存：1.21.4 有 1040 个 tile，每次调用都要读盘 + 解压 + 逐像素拷贝，
 * 一秒左右的纯浪费；而且渲染器与测试会把「同一个版本拿到同一个对象」当作
 * 廉价的失效判据（atlas 身份不变就不必重建 GPU 纹理）。
 */
const ATLAS_CACHE = new Map<string, TextureAtlas>()

/** 2 的幂，prismarine 原版的位运算实现，保持同样语义（0 → 1）。 */
function nextPowerOfTwo(n: number): number {
  if (n === 0) return 1
  n--
  n |= n >> 1
  n |= n >> 2
  n |= n >> 4
  n |= n >> 8
  n |= n >> 16
  return n + 1
}

/**
 * 文件名 → 纹理名。
 *
 * 只砍掉结尾的 `.png`，不用 `path.parse().name`、更不用 `split('.')[0]`：
 * 后两者会把名字中间的点和后缀一起吃掉（`oak.log` → `oak`）。1.21.4 的 1039 个
 * 方块纹理恰好都不带点，所以与 prismarine 的 `split('.')[0]` 结果一致，
 * 但这里的选择对将来的资源包更安全。
 */
function textureName(file: string): string {
  return file.endsWith('.png') ? file.slice(0, -'.png'.length) : file
}

/**
 * 自己画一张 16×16 的「缺失纹理」（洋红/黑棋盘格）。
 *
 * prismarine 是从它自己的 `viewer/lib/missing_texture.png` 读的，但那是读取
 * 另一个包内部的私有文件：prismarine-viewer 在这里只是 devDependency，
 * 发布产物里未必存在，跨包读私有路径也随时会被上游改掉。图案本身是
 * Minecraft missingno 的经典样式，画出来视觉等价，且没有任何外部依赖。
 */
function createMissingTextureTile(): Uint8Array {
  const tile = new Uint8Array(TILE_SIZE * TILE_SIZE * 4)
  for (let y = 0; y < TILE_SIZE; y++) {
    for (let x = 0; x < TILE_SIZE; x++) {
      const magenta = ((x / MISSING_CELL) | 0) + ((y / MISSING_CELL) | 0)
      const offset = (y * TILE_SIZE + x) * 4
      const isMagenta = magenta % 2 === 0
      tile[offset] = isMagenta ? 255 : 0
      tile[offset + 1] = 0
      tile[offset + 2] = isMagenta ? 255 : 0
      tile[offset + 3] = 255
    }
  }
  return tile
}

/**
 * 解码一张纹理并裁出左上角 16×16。
 *
 * 只取左上角是有意的：动画纹理（水、熔岩、火焰）在资源包里是 16×64 / 16×512
 * 这样的**竖向帧条**，第一帧就在左上角，静态渲染取它即可。
 * 比 16×16 更小的纹理极少，但也不能因为越界读就把整张图集搞崩——不足的部分留透明。
 */
function readTilePixels(file: string): Uint8Array {
  const image = decodePng(readFileSync(file))
  const tile = new Uint8Array(TILE_SIZE * TILE_SIZE * 4)
  const copyWidth = Math.min(TILE_SIZE, image.width)
  const copyHeight = Math.min(TILE_SIZE, image.height)
  for (let y = 0; y < copyHeight; y++) {
    const sourceStart = y * image.width * 4
    tile.set(image.data.subarray(sourceStart, sourceStart + copyWidth * 4), y * TILE_SIZE * 4)
  }
  return tile
}

/** 把一块 16×16 的 tile 拷进图集。按行整体 `set`，比逐像素快得多。 */
function blitTile(
  target: Uint8Array,
  size: number,
  x: number,
  y: number,
  tile: Uint8Array,
): void {
  for (let row = 0; row < TILE_SIZE; row++) {
    const sourceStart = row * TILE_SIZE * 4
    target.set(
      tile.subarray(sourceStart, sourceStart + TILE_SIZE * 4),
      ((y + row) * size + x) * 4,
    )
  }
}

/**
 * 为某个 Minecraft 版本构建纹理图集（结果缓存，同一版本返回同一个对象）。
 *
 * 与 prismarine 原版的一处**有意差异**：文件名来自 `readdirSync` 之后要 `sort`。
 * 原版直接用 readdirSync 的原始顺序，而那个顺序依赖文件系统（同一份资源包在
 * ext4、APFS、打包成 asar 之后都可能不同），会让 UV 索引在不同机器上漂移，
 * 渲染产物和 golden 测试就没法复现了。排序换来确定性的 tile 分配。
 */
export function buildTextureAtlas(minecraftVersion: string): TextureAtlas {
  const cached = ATLAS_CACHE.get(minecraftVersion)
  if (cached !== undefined) return cached

  const load = minecraftAssets as unknown as (version: string) => { directory?: string }
  const directory = load(minecraftVersion)?.directory
  if (typeof directory !== 'string') {
    throw new Error(`minecraft-assets 没有版本 "${minecraftVersion}" 的资源包目录`)
  }

  const blocksDirectory = join(directory, 'blocks')
  // 只收 .png：资源包里同名的 .png.mcmeta（动画帧声明）会被这个 filter 自然排除。
  const files = readdirSync(blocksDirectory)
    .filter((file) => file.endsWith('.png'))
    .sort()
  // missing_texture 永远排在 tile 0：vendored mesher 把它当作「找不到纹理」的兜底索引。
  const orderedFiles = [MISSING_TEXTURE_FILE, ...files]

  const tilesPerRow = nextPowerOfTwo(Math.ceil(Math.sqrt(orderedFiles.length)))
  const size = tilesPerRow * TILE_SIZE
  const data = new Uint8Array(size * size * 4)
  const textures: Record<string, AtlasIndexEntry> = {}
  const decodeFailures: string[] = []
  const missingTile = createMissingTextureTile()

  for (let i = 0; i < orderedFiles.length; i++) {
    const file = orderedFiles[i]!
    const x = (i % tilesPerRow) * TILE_SIZE
    const y = Math.floor(i / tilesPerRow) * TILE_SIZE
    textures[textureName(file)] = {
      u: x / size,
      v: y / size,
      su: TILE_SIZE / size,
      sv: TILE_SIZE / size,
    }

    let tile = missingTile
    if (i > 0) {
      try {
        tile = readTilePixels(join(blocksDirectory, file))
      } catch {
        // 单张纹理坏掉不该让整个建筑渲染不出来：填成缺失纹理并记录名字，
        // 让调用方（或日志）能说出到底是哪几个文件有问题。
        tile = missingTile
        decodeFailures.push(textureName(file))
      }
    }
    blitTile(data, size, x, y, tile)
  }

  const atlas: TextureAtlas = { size, data, textures }
  if (decodeFailures.length > 0) atlas.decodeFailures = decodeFailures
  ATLAS_CACHE.set(minecraftVersion, atlas)
  return atlas
}

export { MISSING_TEXTURE_NAME, TILE_SIZE }
