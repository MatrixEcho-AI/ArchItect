import prismarineChunk from 'prismarine-chunk'

import type { Pos } from '../types.js'

/**
 * `ChunkColumn` 的最小接口。
 *
 * ⚠️ **x 和 z 必须是区块本地坐标 0..15，不是世界坐标。**
 *
 * 上游的索引计算是位运算：
 * ```js
 * getSectionBlockIndex = (((y - minY) & 15) << 8) | (pos.z << 4) | pos.x
 * ```
 * **x/z 完全没有掩码**。传世界坐标（x ≥ 16）会让 `(z << 4) | x` 发生**位重叠**：
 * 写 `(16, 20, 16)` 与读 `(16, 20, 17)` 会落到同一个索引 1296。
 * 危险之处在于"写进去再读出来"仍然自洽，所以这个 bug 不会自己暴露——
 * 但邻居格会被静默污染。
 *
 * `WorldStore` 负责做 world → local 的转换；直接用这个接口时务必自己转。
 */
export interface ChunkColumn {
  setBlockStateId(pos: Pos, stateId: number): void
  getBlockStateId(pos: Pos): number
}

/** 世界坐标 → 区块本地坐标（0..15）。 */
export function toColumnLocal(value: number): number {
  return value & 15
}

/** 把世界坐标折成 `ChunkColumn` 接受的本地坐标。 */
export function toColumnPos(pos: Pos): Pos {
  return { x: toColumnLocal(pos.x), y: pos.y, z: toColumnLocal(pos.z) }
}

export interface ChunkColumnOptions {
  minY: number
  worldHeight: number
}

export type ChunkColumnConstructor = new (options: ChunkColumnOptions) => ChunkColumn

/** 1.18+ 的 vanilla 世界高度范围。 */
export const VANILLA_MIN_Y = -64
export const VANILLA_WORLD_HEIGHT = 384

const constructors = new Map<string, ChunkColumnConstructor>()

/** 取某版本的 `ChunkColumn` 构造器。同一版本只解析一次。 */
export function chunkColumnConstructor(minecraftVersion: string): ChunkColumnConstructor {
  const cached = constructors.get(minecraftVersion)
  if (cached !== undefined) return cached
  const load = prismarineChunk as unknown as (version: string) => ChunkColumnConstructor
  const ctor = load(minecraftVersion)
  if (typeof ctor !== 'function') {
    throw new Error(`prismarine-chunk does not support version "${minecraftVersion}"`)
  }
  constructors.set(minecraftVersion, ctor)
  return ctor
}

/** 建一个新 chunk 列。 */
export function createChunkColumn(
  minecraftVersion: string,
  options: ChunkColumnOptions = { minY: VANILLA_MIN_Y, worldHeight: VANILLA_WORLD_HEIGHT },
): ChunkColumn {
  const Ctor = chunkColumnConstructor(minecraftVersion)
  return new Ctor(options)
}
