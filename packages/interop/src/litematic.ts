import type { Bounds, WorldStore } from '@architect/core'

import {
  asCompound,
  asInt,
  asString,
  asCompoundList,
  asUnsignedLongArray,
  child,
  compound,
  compoundList,
  int,
  long,
  longArray,
  readNbt,
  string,
  writeNbt,
} from './nbt.js'
import type { NbtTree, Tag } from './nbt.js'
import { DATA_VERSION_1_21_4 } from './schematic.js'
import type { SchematicBlock, SchematicData } from './schematic.js'

/**
 * Litematica（`.litematic`）读写。
 *
 * ## 位打包是这里唯一有难度的东西，而且**两代格式不兼容**
 *
 * `BlockStates` 是一个 long 数组，每格占 `max(2, ceil(log2(调色板大小)))` 位。
 *
 * - **Version >= 4（新式，我们写 v6）**：每格必须完整落在一个 long 里，
 *   `longIndex = i / entriesPerLong`，`offset = (i % entriesPerLong) * bits`。
 * - **Version < 4（老式）**：整个数组当成一条连续位流，一个条目可以跨 long 边界。
 *
 * ## 另一个坑：位模式必须按**无符号**处理
 *
 * 64 位里最高位经常被用上（调色板够大时，或者最后一个 long 的高位有残留）。
 * 用带符号右移会把索引变成负数——这个 bug 只在特定调色板大小下才出现，
 * 所以测试必须**把调色板撑到触发它的规模**（见 `litematic.test.ts`）。
 */

export interface LitematicRegion {
  /** 区域里的方块（局部坐标 0 起）。 */
  blocks: SchematicBlock[]
  size: [number, number, number]
  /** 区域原点（`Position`），通常是负坐标。 */
  position: [number, number, number]
}

export interface LitematicData {
  version?: number
  mcDataVersion?: number
  regions: LitematicRegion[]
  name?: string
  author?: string
}

export interface WriteLitematicInput {
  regions: Array<{
    name?: string
    blocks: Iterable<SchematicBlock>
    size: [number, number, number]
    position?: [number, number, number]
  }>
  name?: string
  author?: string
  description?: string
  mcDataVersion?: number
}

/** Litematica 的位宽下限是 2：调色板只有 1 项时也不写 0 位。 */
export const bitsFor = (paletteSize: number): number =>
  Math.max(2, Math.ceil(Math.log2(Math.max(1, paletteSize))))

/**
 * 新式紧凑打包：每格完整落在一个 long 内。
 *
 * 返回的是**有符号** 64 位——NBT 的 long 就是有符号的，高位被用上时
 * 无符号位模式会被 `writeUncompressed` 直接拒掉（`ERR_OUT_OF_RANGE`）。
 * 在这里收口，调用方不必再想着转换。
 */
export function packBlockStates(indices: readonly number[], paletteSize: number): bigint[] {
  const bits = bitsFor(paletteSize)
  const perLong = Math.floor(64 / bits)
  const longs = new Array<bigint>(Math.ceil(indices.length / perLong)).fill(0n)
  for (let i = 0; i < indices.length; i++) {
    const value = BigInt.asUintN(bits, BigInt(indices[i]!))
    const longIndex = Math.floor(i / perLong)
    const offset = BigInt((i % perLong) * bits)
    longs[longIndex] = BigInt.asUintN(64, longs[longIndex]! | (value << offset))
  }
  return longs.map((word) => BigInt.asIntN(64, word))
}

/** 解包。**必须走无符号路径**，否则最高位会被当成符号位。 */
export function unpackBlockStates(longs: readonly bigint[], count: number, paletteSize: number): number[] {
  const bits = bitsFor(paletteSize)
  const perLong = Math.floor(64 / bits)
  const mask = (1n << BigInt(bits)) - 1n
  const out = new Array<number>(count).fill(0)
  for (let i = 0; i < count; i++) {
    const raw = longs[Math.floor(i / perLong)]
    if (raw === undefined) break
    const offset = BigInt((i % perLong) * bits)
    out[i] = Number((BigInt.asUintN(64, raw) >> offset) & mask)
  }
  return out
}

export function writeLitematic(input: WriteLitematicInput): Uint8Array {
  const regions: NbtTree = {}
  let totalBlocks = 0
  let totalVolume = 0
  const enclosing = { x: 0, y: 0, z: 0 }

  for (const [index, region] of input.regions.entries()) {
    const [width, height, length] = region.size
    const position = region.position ?? [0, 0, 0]

    // 调色板：`{ Name, Properties }` 的对象数组，第 0 项固定是空气
    const paletteEntries: Array<{ name: string; properties: Record<string, string> }> = [
      { name: 'minecraft:air', properties: {} },
    ]
    const paletteIndex = new Map<string, number>([['minecraft:air', 0]])
    const indices = new Int32Array(width * height * length)

    for (const block of region.blocks) {
      if (block.state === 'minecraft:air') continue
      if (block.x < 0 || block.x >= width || block.y < 0 || block.y >= height || block.z < 0 || block.z >= length) {
        throw new RangeError(`方块 (${block.x},${block.y},${block.z}) 超出区域尺寸 ${width}x${height}x${length}`)
      }
      let slot = paletteIndex.get(block.state)
      if (slot === undefined) {
        slot = paletteEntries.length
        paletteEntries.push(splitState(block.state))
        paletteIndex.set(block.state, slot)
      }
      // 与 .schem 同样的顺序：x + z*Width + y*Width*Length
      indices[block.x + block.z * width + block.y * width * length] = slot
      totalBlocks++
    }
    totalVolume += width * height * length

    // 元素是**裸字段表**，不是 compound 标签——见 `compoundList` 的说明
    const paletteTags: NbtTree[] = paletteEntries.map((entry) => {
      const properties: NbtTree = {}
      for (const [key, value] of Object.entries(entry.properties)) properties[key] = string(value)
      return { Name: string(entry.name), Properties: compound(properties) }
    })

    regions[region.name ?? `Region ${index + 1}`] = compound({
      Position: compound({ x: int(position[0]), y: int(position[1]), z: int(position[2]) }),
      Size: compound({ x: int(width), y: int(height), z: int(length) }),
      BlockStatePalette: compoundList(paletteTags),
      BlockStates: longArray(packBlockStates([...indices], paletteEntries.length)),
      Entities: compoundList([]),
      TileEntities: compoundList([]),
      PendingBlockTicks: compoundList([]),
      PendingFluidTicks: compoundList([]),
    })
    enclosing.x = Math.max(enclosing.x, width)
    enclosing.y = Math.max(enclosing.y, height)
    enclosing.z = Math.max(enclosing.z, length)
  }

  // 时间戳固定为 0：同样的世界必须导出**逐字节相同**的文件，
  // 否则"导出是否稳定"这件事就没法测，也没法做内容寻址。
  const metadata: NbtTree = {
    Name: string(input.name ?? 'ArchItect build'),
    Author: string(input.author ?? 'ArchItect'),
    Description: string(input.description ?? ''),
    RegionCount: int(input.regions.length),
    TotalBlocks: int(totalBlocks),
    TotalVolume: int(totalVolume),
    TimeCreated: long(0n),
    TimeModified: long(0n),
    EnclosingSize: compound({ x: int(enclosing.x), y: int(enclosing.y), z: int(enclosing.z) }),
  }

  return writeNbt({
    Version: int(6),
    SubVersion: int(1),
    MinecraftDataVersion: int(input.mcDataVersion ?? DATA_VERSION_1_21_4),
    Metadata: compound(metadata),
    Regions: compound(regions),
  })
}

export async function readLitematic(bytes: Uint8Array): Promise<LitematicData> {
  const root = await readNbt(bytes)
  // `NBT` 的根是 `{ name, value }`，字段在 `value` 里——用 `child()` 取，别直接下标
  const version = asInt(child(root, 'Version'), 0)
  const regionsTree = asCompound(child(root, 'Regions'))
  if (regionsTree === undefined) throw new Error('不是合法的 .litematic：缺少 Regions')

  const regions: LitematicRegion[] = []
  for (const [regionName, regionTag] of Object.entries(regionsTree)) {
    const region = asCompound(regionTag)
    if (region === undefined) continue
    const sizeTag = asCompound(region['Size'])
    const size: [number, number, number] = [
      Math.abs(asInt(sizeTag?.['x'], 1)),
      Math.abs(asInt(sizeTag?.['y'], 1)),
      Math.abs(asInt(sizeTag?.['z'], 1)),
    ]
    const position = readPosition(asCompound(region['Position']))

    const palette = readPalette(region['BlockStatePalette'])
    const longs = asUnsignedLongArray(region['BlockStates'])
    if (longs === undefined) throw new Error(`区域 ${regionName} 缺少 BlockStates`)

    const count = size[0] * size[1] * size[2]
    const indices = unpackBlockStates(longs, count, palette.length)

    const blocks: SchematicBlock[] = []
    for (let i = 0; i < count; i++) {
      const slot = indices[i]!
      if (slot === 0) continue
      const state = palette[slot]
      if (state === undefined || state === 'minecraft:air') continue
      const y = Math.floor(i / (size[0] * size[2]))
      const rest = i - y * size[0] * size[2]
      const z = Math.floor(rest / size[0])
      const x = rest - z * size[0]
      blocks.push({ x, y, z, state })
    }
    regions.push({ blocks, size, position })
  }

  const metadata = asCompound(child(root, 'Metadata'))
  const result: LitematicData = { regions, version }
  const mcDataVersion = child(root, 'MinecraftDataVersion')
  if (mcDataVersion !== undefined) result.mcDataVersion = asInt(mcDataVersion)
  const name = asString(metadata?.['Name'])
  if (name.length > 0) result.name = name
  const author = asString(metadata?.['Author'])
  if (author.length > 0) result.author = author
  return result
}

export interface ExportLitematicOptions {
  region?: Bounds
  name?: string
  author?: string
  mcDataVersion?: number
}

/** 从世界导出（单区域，内容包围盒就是那个区域）。 */
export function exportLitematic(store: WorldStore, options: ExportLitematicOptions = {}): Uint8Array {
  const region = options.region ?? store.contentBounds()
  if (region === undefined) throw new Error('世界是空的，没有可导出的内容')
  const size: [number, number, number] = [
    region.max.x - region.min.x + 1,
    region.max.y - region.min.y + 1,
    region.max.z - region.min.z + 1,
  ]
  const blocks: SchematicBlock[] = []
  for (let y = region.min.y; y <= region.max.y; y++) {
    for (let z = region.min.z; z <= region.max.z; z++) {
      for (let x = region.min.x; x <= region.max.x; x++) {
        const state = store.getBlockString({ x, y, z })
        if (state === 'minecraft:air') continue
        blocks.push({ x: x - region.min.x, y: y - region.min.y, z: z - region.min.z, state })
      }
    }
  }
  return writeLitematic({
    regions: [{ name: 'Region 1', blocks, size, position: [0, 0, 0] }],
    ...(options.name !== undefined ? { name: options.name } : {}),
    ...(options.author !== undefined ? { author: options.author } : {}),
    ...(options.mcDataVersion !== undefined ? { mcDataVersion: options.mcDataVersion } : {}),
  })
}

/** `.litematic` → 与 `.schem` 通用的中间表示，这样导入逻辑只有一份。 */
export function litematicToSchematicData(data: LitematicData): SchematicData {
  const region = data.regions[0]
  if (region === undefined) throw new Error('.litematic 里没有区域')
  const output: SchematicData = {
    size: region.size,
    offset: region.position,
    blocks: region.blocks,
    formatVersion: data.version,
  }
  if (data.mcDataVersion !== undefined) output.dataVersion = data.mcDataVersion
  return output
}

// ── 内部 ──────────────────────────────────────────────────────────────────────

function readPosition(tag: Record<string, Tag | undefined> | undefined): [number, number, number] {
  return [asInt(tag?.['x'], 0), asInt(tag?.['y'], 0), asInt(tag?.['z'], 0)]
}

/** `BlockStatePalette` → 规范状态字符串数组（属性按名字排序，与我们的规范形式一致）。 */
function readPalette(tag: Tag | undefined): string[] {
  return asCompoundList(tag).map((record) => {
    const name = asString(record['Name'], 'minecraft:air')
    const normalized = name.startsWith('minecraft:') ? name : `minecraft:${name}`
    const properties = asCompound(record['Properties'])
    const pairs = Object.entries(properties ?? {})
      .map(([key, value]) => [key, asString(value)] as const)
      .filter(([, value]) => value.length > 0)
      .sort((a, b) => a[0].localeCompare(b[0]))
    if (pairs.length === 0) return normalized
    return `${normalized}[${pairs.map(([key, value]) => `${key}=${value}`).join(',')}]`
  })
}

/** `minecraft:oak_stairs[facing=north,half=bottom]` → `{name, properties}`。 */
function splitState(state: string): { name: string; properties: Record<string, string> } {
  const match = /^(?:minecraft:)?([a-z0-9_]+)(?:\[([^\]]*)\])?$/.exec(state.trim())
  if (match === null) return { name: state, properties: {} }
  const properties: Record<string, string> = {}
  for (const pair of (match[2] ?? '').split(',')) {
    const trimmed = pair.trim()
    if (trimmed.length === 0) continue
    const eq = trimmed.indexOf('=')
    if (eq <= 0) continue
    properties[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim()
  }
  return { name: `minecraft:${match[1]!}`, properties }
}
