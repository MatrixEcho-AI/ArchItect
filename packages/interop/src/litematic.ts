import { DEFAULT_HARD_LIMIT } from '@architect/core'
import type { Bounds, WorldStore } from '@architect/core'

import { collectSparse, exportBoundsOf } from './collect.js'
import { compoundFromJson, compoundToJson } from './json-nbt.js'
import {
  asCompound,
  asInt,
  asNumberList,
  asString,
  asCompoundList,
  asUnsignedLongArray,
  child,
  compound,
  compoundList,
  int,
  list,
  long,
  longArray,
  readNbt,
  string,
  writeNbt,
} from './nbt.js'
import type { NbtTree, Tag } from './nbt.js'
import { DATA_VERSION_1_21_4 } from './schematic.js'
import type {
  SchematicBlock,
  SchematicBlockEntity,
  SchematicData,
  SchematicEntity,
} from './schematic.js'

/**
 * Litematica（`.litematic`）读写。
 *
 * ## 位打包：一条**连续位流**，条目可以跨 long 边界
 *
 * `BlockStates` 是一个 long 数组，每格占 `max(2, ceil(log2(调色板大小)))` 位。
 * Litematica 把整个数组当成**一条连续的位流**：第 i 格占全局位区间
 * `[i*bits, (i+1)*bits)`，数组长度是 `ceil(count * bits / 64)`。一条目跨越
 * long 边界是**正常情况**，不是例外。
 *
 * 权威依据（两代实现都是同一个算法，删改时请对着它核）：
 *
 * - `LitematicaBitArray`（1.21.1 线）：
 *   `longArray = new long[roundUp(arraySize * bitsPerEntry, 64) / 64]`，
 *   `getAt`/`setAt` 在 `startArrIndex != endArrIndex` 时把两条 long 拼起来。
 * - `TightLongBackedIntArray`（重写线）：
 *   `getRequiredArrayLength = roundUp(arraySize * bitsPerEntry, 64) / 64`，同一套拼接。
 *
 * ## 这里写错过一次，而且**自测完全测不出来**
 *
 * 曾经的实现是"每格完整落在一个 long 内"：`perLong = 64 / bits`，
 * `longIndex = i / perLong`，`offset = (i % perLong) * bits`。
 * 它看起来更简单，**而且恰好是 Minecraft 原版 `BitArray`（区块调色板）的布局**——
 * 但 Litematica 从来不是这么写的。这个错误的形状极其隐蔽：
 *
 * - 自己的 pack/unpack 往返**完全自洽**，所以任何"写进去再读回来"的测试都绿；
 * - 它与正确布局在 **`bits` 整除 64 时逐位相同**（即 `bits ∈ {2,4,8,16,32}`），
 *   而这恰好是调色板只有 1–4 项（`bits=2`）或 5–16 项（`bits=4`）的情形——
 *   也就是仓库里那些测试样例的规模；
 * - 一旦调色板超过 16 项（`bits >= 5`，**任何真实建筑**），索引从 `perLong` 起
 *   全部错位，Litematica 读出来是一片错方块。
 *
 * 所以判据不能是"往返一致"，只能是"与独立算出的位流逐位相同"——
 * 见 `formats.test.ts` 里的 `referencePack`（逐位参考实现）。
 * 这与 `plan.md` 附录 E 开头那句"往返是自洽的，错的是和别人对不对得上"是同一条教训。
 *
 * ## 另一个坑：位模式必须按**无符号**处理
 *
 * 64 位里最高位经常被用上（调色板够大时，或者最后一个 long 的高位有残留）。
 * 用带符号右移会把索引变成负数——这个 bug 只在特定调色板大小下才出现，
 * 所以测试必须**把调色板撑到触发它的规模**（见 `formats.test.ts`）。
 */

export interface LitematicRegion {
  /** 区域里的方块（局部坐标 0 起）。 */
  blocks: SchematicBlock[]
  size: [number, number, number]
  /** 区域原点（`Position`），通常是负坐标。 */
  position: [number, number, number]
  /** 实体，位置**相对区域原点**（与 `.schem` 用同一个中间表示）。 */
  entities?: SchematicEntity[]
  /** 方块实体，位置相对区域原点。 */
  blockEntities?: SchematicBlockEntity[]
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
    entities?: Iterable<SchematicEntity>
    blockEntities?: Iterable<SchematicBlockEntity>
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
 * 位流要几条 long：`ceil(count * bits / 64)`。
 *
 * 就是 Litematica 的 `roundUp(arraySize * bitsPerEntry, 64) / 64`——**紧凑**，
 * 末尾不补到整 long。补整是原版 `BitArray`（区块调色板）的做法，不是这个格式的。
 */
function longCountFor(count: number, bits: number): number {
  return Math.ceil((count * bits) / 64)
}

/**
 * 打包成 Litematica 的 `BlockStates`：**一条连续位流**，条目可跨 long 边界。
 *
 * 逐条照 `LitematicaBitArray.setAt` 的语义实现：把第 i 格写到全局位位置
 * `i * bits`；一条目横跨两条 long 时，低位留在开始那条，溢出的高位进下一条
 * （下一条的低 `bits - endOffset` 位先清掉再放进去）。
 *
 * 返回的是**有符号** 64 位——NBT 的 long 就是有符号的，高位被用上时
 * 无符号位模式会被 `writeUncompressed` 直接拒掉（`ERR_OUT_OF_RANGE`）。
 * 在这里收口，调用方不必再想着转换。
 */
export function packBlockStates(indices: readonly number[], paletteSize: number): bigint[] {
  const bits = bitsFor(paletteSize)
  const width = BigInt(bits)
  const mask = (1n << width) - 1n
  const longs = new Array<bigint>(longCountFor(indices.length, bits)).fill(0n)

  for (let i = 0; i < indices.length; i++) {
    const value = BigInt(indices[i]!) & mask
    const startOffset = BigInt(i) * width
    const startArrIndex = Number(startOffset >> 6n)
    // 最后一位落在哪条 long 上；与 `startArrIndex` 不同就说明这一格跨了边界
    const endArrIndex = Number(((BigInt(i) + 1n) * width - 1n) >> 6n)
    const startBitOffset = Number(startOffset & 63n)

    longs[startArrIndex] = BigInt.asUintN(
      64,
      longs[startArrIndex]! | (value << BigInt(startBitOffset)),
    )

    if (startArrIndex !== endArrIndex) {
      const endOffset = 64 - startBitOffset
      const keep = BigInt(bits - endOffset)
      const cleared = (BigInt.asUintN(64, longs[endArrIndex]!) >> keep) << keep
      longs[endArrIndex] = BigInt.asUintN(64, cleared | (value >> BigInt(endOffset)))
    }
  }

  return longs.map((word) => BigInt.asIntN(64, word))
}

/**
 * 解包。**必须走无符号路径**，否则最高位会被当成符号位。
 *
 * 读到的 long 比声明的格子数少时（文件被截断）**补 0 而不是抛错**——这条是明写
 * 的行为，有测试盯着（`formats.test.ts`）。
 */
export function unpackBlockStates(
  longs: readonly bigint[],
  count: number,
  paletteSize: number,
): number[] {
  const bits = bitsFor(paletteSize)
  const width = BigInt(bits)
  const mask = (1n << width) - 1n
  const out = new Array<number>(count).fill(0)

  for (let i = 0; i < count; i++) {
    const startOffset = BigInt(i) * width
    const startArrIndex = Number(startOffset >> 6n)
    const endArrIndex = Number(((BigInt(i) + 1n) * width - 1n) >> 6n)
    const startBitOffset = Number(startOffset & 63n)

    const low = longs[startArrIndex]
    if (low === undefined) break
    const lowBits = BigInt.asUintN(64, low) >> BigInt(startBitOffset)

    if (startArrIndex === endArrIndex) {
      out[i] = Number(lowBits & mask)
      continue
    }

    const high = longs[endArrIndex]
    if (high === undefined) break
    const endOffset = 64 - startBitOffset
    out[i] = Number((lowBits | (BigInt.asUintN(64, high) << BigInt(endOffset))) & mask)
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
      // 与 `.schem` 同样的顺序：x + z*Width + y*Width*Length
      indices[block.x + block.z * width + block.y * width * length] = slot
      totalBlocks++
    }
    totalVolume += width * height * length

    /**
     * 两层稀疏数据。**两处与 Sponge 不同的约定**，取自 Litematica 自己的序列化代码
     * （`LitematicaSchematic.getEntitiesAsListData` / `getBlockEntitiesAsListData`）：
     *
     * - 键是**小写 `id`**（原版实体/方块实体的 NBT 就叫这个），不是 Sponge 的 `Id`；
     * - 实体的位置写 `Pos` = **double 列表**，而方块实体的位置写 **`x`/`y`/`z` 三个 int**
     *   （`DataTypeUtils.putVec3i`），**不是** Sponge 那种 `Pos` 数组。
     *
     * 两个列表都**总是写**（哪怕空）——Litematica 就是这么干的，而 `.litematic`
     * 的读方不一定容忍缺字段。
     */
    const entityTags: NbtTree[] = [...(region.entities ?? [])].map((entity) => ({
      ...compoundFromJson(entity.data),
      id: string(entity.id),
      Pos: list('double', entity.pos),
    }))
    const tileEntityTags: NbtTree[] = [...(region.blockEntities ?? [])].map((entity) => ({
      ...compoundFromJson(entity.data),
      id: string(entity.id),
      x: int(entity.pos[0]),
      y: int(entity.pos[1]),
      z: int(entity.pos[2]),
    }))

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
      Entities: compoundList(entityTags),
      TileEntities: compoundList(tileEntityTags),
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
  // 跨区域的总量预算：单区域的上限挡不住「很多个刚好不超限的区域」。
  let totalCells = 0
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

    // **先算账，再取数据。** `count` 来自文件声明的 `Size`，而下面那行会把文件里的
    // `BlockStates` 整段物化成 BigInt 数组——检查放在那之后等于没检查。
    //
    // 也别把这道守卫塞进 `unpackBlockStates`：它「读到超出长度的位置补 0 而不是
    // 抛错」是明写的行为，有测试盯着（formats.test.ts）。
    const count = size[0] * size[1] * size[2]
    if (count > DEFAULT_HARD_LIMIT) {
      throw new Error(
        `Litematica: 区域 ${regionName} 声明了 ${size.join('x')} = ${count} 格，` +
          `超过单次写入上限 ${DEFAULT_HARD_LIMIT} 格`,
      )
    }
    // 单区域不超限还不够：一个文件可以声明很多个「刚好不超」的区域，而导入最终只用
    // `regions[0]`——内存会随区域数线性涨，用一个很小的文件就能堆上去。
    totalCells += count
    if (totalCells > DEFAULT_HARD_LIMIT) {
      throw new Error(
        `Litematica: 各区域合计 ${totalCells} 格，超过单次写入上限 ${DEFAULT_HARD_LIMIT} 格`,
      )
    }

    const palette = readPalette(region['BlockStatePalette'])
    const longs = asUnsignedLongArray(region['BlockStates'])
    if (longs === undefined) throw new Error(`区域 ${regionName} 缺少 BlockStates`)

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
    regions.push({
      blocks,
      size,
      position,
      entities: readLitematicEntities(region['Entities']),
      blockEntities: readLitematicBlockEntities(region['TileEntities']),
    })
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

/** 从世界导出（单区域，内容包围盒与两层稀疏数据的并集就是那个区域）。 */
export function exportLitematic(store: WorldStore, options: ExportLitematicOptions = {}): Uint8Array {
  return exportLitematicDetailed(store, options).bytes
}

/**
 * 与 `exportLitematic` 相同，但把两层稀疏数据的数量、以及"附加数据转不成 NBT"的
 * 原因一起交出来。
 *
 * 为什么要有这一版：`.schem` 那条路（`exportSchematic`）本来就是这么返回的，
 * 两种格式该一致；而"转不了就说出来"是这个仓库对互操作的硬要求——
 * JSON 分不出 byte/short/int/float/double，猜出来的文件在游戏里是错的。
 */
export function exportLitematicDetailed(
  store: WorldStore,
  options: ExportLitematicOptions = {},
): { bytes: Uint8Array; size: [number, number, number]; entities: number; blockEntities: number; problems: string[] } {
  const region = options.region ?? exportBoundsOf(store)
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
  const { entities, blockEntities, problems } = collectSparse(store, region)
  const bytes = writeLitematic({
    regions: [{ name: 'Region 1', blocks, size, position: [0, 0, 0], entities, blockEntities }],
    ...(options.name !== undefined ? { name: options.name } : {}),
    ...(options.author !== undefined ? { author: options.author } : {}),
    ...(options.mcDataVersion !== undefined ? { mcDataVersion: options.mcDataVersion } : {}),
  })
  return { bytes, size, entities: entities.length, blockEntities: blockEntities.length, problems }
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
  // 两层稀疏数据跟着走：`.schem` 与 `.litematic` 共用同一个导入器，
  // 少带一层就等于"从 .litematic 导入时实体不见了"
  if (region.entities !== undefined && region.entities.length > 0) output.entities = region.entities
  if (region.blockEntities !== undefined && region.blockEntities.length > 0) {
    output.blockEntities = region.blockEntities
  }
  return output
}

/**
 * `.litematic` 的实体列表。
 *
 * v1 是**包装**形状：`{ Pos: …, EntityData: { <原版实体 NBT> } }`；v2+ 把位置直接写进
 * 实体自己的 NBT（`LitematicaSchematic.readEntities_v1` / `readEntities_v2` 的区别）。
 * 两种都认——v1 的文件还在流通，而认错的代价是"实体一个都没导入"。
 */
function readLitematicEntities(tag: Tag | undefined): SchematicEntity[] {
  const out: SchematicEntity[] = []
  for (const entry of asCompoundList(tag)) {
    const wrapper = asCompound(entry['EntityData'])
    const source = wrapper ?? entry
    const id = readId(source)
    const pos = asNumberList(entry['Pos']) ?? asNumberList(source['Pos'])
    if (id.length === 0 || pos === undefined || pos.length !== 3) continue
    // 位置是元数据，不该同时留在附加数据里——否则模型会看到两份位置
    out.push({ id, pos: [pos[0]!, pos[1]!, pos[2]!], data: extraOf(source, ['id', 'Id', 'Pos']) })
  }
  return out
}

/** 方块实体的位置是 `x`/`y`/`z` 三个 int（v1 的外层包装也是），也接受 `Pos` 两种容器。 */
function readLitematicBlockEntities(tag: Tag | undefined): SchematicBlockEntity[] {
  const out: SchematicBlockEntity[] = []
  for (const entry of asCompoundList(tag)) {
    const wrapper = asCompound(entry['TileNBT'])
    const source = wrapper ?? entry
    const id = readId(source)
    const pos = readBlockPosition(entry) ?? readBlockPosition(source)
    if (id.length === 0 || pos === undefined) continue
    out.push({ id, pos, data: extraOf(source, ['id', 'Id', 'Pos', 'x', 'y', 'z']) })
  }
  return out
}

/** 原版 NBT 用小写 `id`；大写的写法也认，免得一个大小写差异让整份文件"没有实体"。 */
function readId(entry: Record<string, Tag | undefined>): string {
  const lower = asString(entry['id'])
  return lower.length > 0 ? lower : asString(entry['Id'])
}

function readBlockPosition(entry: Record<string, Tag | undefined>): [number, number, number] | undefined {
  if (entry['x'] !== undefined && entry['y'] !== undefined && entry['z'] !== undefined) {
    return [asInt(entry['x']), asInt(entry['y']), asInt(entry['z'])]
  }
  const pos = asNumberList(entry['Pos'])
  if (pos !== undefined && pos.length === 3) {
    return [Math.trunc(pos[0]!), Math.trunc(pos[1]!), Math.trunc(pos[2]!)]
  }
  return undefined
}

/** 一条记录里除元数据之外的附加数据（摊平成一份 JSON）。 */
function extraOf(
  source: Record<string, Tag | undefined>,
  reserved: readonly string[],
): Record<string, unknown> {
  const inline: Record<string, Tag | undefined> = {}
  for (const [key, tag] of Object.entries(source)) {
    if (reserved.includes(key)) continue
    inline[key] = tag
  }
  return compoundToJson(inline)
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
