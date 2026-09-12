import { DEFAULT_HARD_LIMIT } from '@architect/core'

import { compoundFromJson, compoundToJson } from './json-nbt.js'
import {
  asByteArray,
  asCompound,
  asCompoundList,
  asInt,
  asIntArray,
  asNumberList,
  asString,
  byteArray,
  child,
  compound,
  compoundList,
  int,
  intArray,
  list,
  readNbt,
  short,
  string,
  writeNbt,
} from './nbt.js'
import type { NbtTree, Tag } from './nbt.js'

/**
 * Sponge Schematic（`.schem`）读写。
 *
 * 这是 M7 的主交付物：**导出的文件要能在游戏里逐格还原**，所以布局必须严格按规范，
 * 不能"差不多能用"。两条最容易搞错的地方：
 *
 * 1. **索引顺序**是 `x + z*Width + y*Width*Length`——**y 在最外层**。
 *    写成 `x + z*Width + y*Height*Width`（或把 y 放最内层）都能自洽地往返，
 *    但游戏里读出来会整体错位。这是本模块唯一无法靠自测发现的错误，
 *    所以下面有专门的测试把顺序钉死在手算的期望值上。
 * 2. **v2 与 v3 的 `Data` 编码不同**：v2 是定宽 2 字节大端，v3 是 **VarInt**。
 *    写用 v3（1.20+ 的规范），读要两种都认——网上的 `.schem` 大多数还是 v2。
 *
 * 调色板的键就是**方块状态字符串**，而且和我们的规范形式完全一致
 * （`minecraft:oak_stairs[facing=north,half=bottom,...]`），所以两边几乎零转换。
 * 属性顺序无所谓：解析时按 `key=value` 读，不依赖顺序。
 */

/** 一个方块位置与它的状态字符串。 */
export interface SchematicBlock {
  x: number
  y: number
  z: number
  /** 规范状态字符串，如 `minecraft:oak_stairs[facing=north]`。 */
  state: string
}

/**
 * 一个实体（Sponge 规范里的 `Entity Object`）。
 *
 * **位置与方块同一个口径**：相对原理图原点，不含 `Offset`（规范原文：
 * "relative to the `[0, 0, 0]` position of the schematic (without the offset applied)"）。
 */
export interface SchematicEntity {
  /** 实体类型，Resource Location（`minecraft:oak_boat`）。 */
  id: string
  /** `double[3]`。 */
  pos: [number, number, number]
  /**
   * 附加数据，**已经是 JSON 形状**（NBT 类型用 `{"__nbt":…}` 标注保留，见 `json-nbt.ts`）。
   *
   * 读进来时 v3 的 `Data`、v2 的 `Extra` 与 v2 的内联写法会合并成这一个对象；
   * 写出去时统一放在 v3 的 `Data` 下。`Rotation` 就在这里面——**它不是独立字段**。
   */
  data: Record<string, unknown>
}

/**
 * 一个方块实体（`BlockEntity Object`）。
 *
 * `id` 是**方块实体**的类型，不是方块名：`oak_sign` 方块的方块实体是 `minecraft:sign`、
 * `white_banner` 是 `minecraft:banner`、`player_head` 是 `minecraft:skull`。写错这个字段
 * 的表现是"方块在、附加数据没了"。
 */
export interface SchematicBlockEntity {
  /** `integer[3]`。 */
  pos: [number, number, number]
  id: string
  data: Record<string, unknown>
}

export interface SchematicData {
  /** `[宽度(x), 高度(y), 长度(z)]`。 */
  size: [number, number, number]
  /** 源文件里的原点偏移（`Offset`）。粘贴时用不到，但保留以便无损往返。 */
  offset: [number, number, number]
  /** **只含非空气格**。空气占绝大多数，稀疏存省内存也省时间。 */
  blocks: SchematicBlock[]
  /**
   * `Entities`。老文件没有这个字段——那时候也没有实体层，缺失与空数组是同一件事。
   */
  entities?: SchematicEntity[]
  /** `BlockEntities`（v3 在 `Blocks` 里、v2 在根上）。缺失同样当空。 */
  blockEntities?: SchematicBlockEntity[]
  /** 源文件的 `DataVersion`。缺失表示不是 Sponge 格式或没写。 */
  dataVersion?: number
  /** 源文件的 `Version`（2 或 3）。 */
  formatVersion?: number
  metadata?: Record<string, string>
  /** 原始调色板里的方块状态字符串（含空气），诊断用。 */
  palette?: string[]
}

export interface WriteSchematicInput {
  size: [number, number, number]
  blocks: Iterable<SchematicBlock>
  /** 实体（写进根的 `Entities`）。省略 = 不写这个字段。 */
  entities?: Iterable<SchematicEntity>
  /** 方块实体（写进 `Blocks.BlockEntities`）。省略 = 不写这个字段。 */
  blockEntities?: Iterable<SchematicBlockEntity>
  /** 写进文件的 `DataVersion`。1.21.4 = 4189。 */
  dataVersion: number
  metadata?: Record<string, string>
  offset?: [number, number, number]
}

/** 1.21.4 的 DataVersion。导出的文件靠它告诉游戏"这是哪个版本的方块表"。 */
export const DATA_VERSION_1_21_4 = 4189

/**
 * 写 Sponge v3。
 *
 * v3 相对 v2 的差别只有两处：`Version=3`、`Data` 用 VarInt；`PaletteMax` 不再需要。
 * 其余（尺寸、偏移、调色板、索引顺序）一模一样。
 */
export function writeSpongeSchematic(input: WriteSchematicInput): Uint8Array {
  const [width, height, length] = input.size
  if (width <= 0 || height <= 0 || length <= 0) {
    throw new RangeError(`尺寸必须为正：收到 ${width}x${height}x${length}`)
  }

  // 调色板：第 0 项固定是空气，和游戏工具的惯例一致
  const palette: string[] = ['minecraft:air']
  const paletteIndex = new Map<string, number>([['minecraft:air', 0]])
  const indices = new Int32Array(width * height * length)

  for (const block of input.blocks) {
    if (block.state === 'minecraft:air' || block.state === 'air') continue
    if (block.x < 0 || block.x >= width || block.y < 0 || block.y >= height || block.z < 0 || block.z >= length) {
      throw new RangeError(
        `方块 (${block.x},${block.y},${block.z}) 超出声明尺寸 ${width}x${height}x${length}`,
      )
    }
    let index = paletteIndex.get(block.state)
    if (index === undefined) {
      index = palette.length
      palette.push(block.state)
      paletteIndex.set(block.state, index)
    }
    // ⚠️ y 在最外层：x + z*Width + y*Width*Length
    indices[block.x + block.z * width + block.y * width * length] = index
  }

  const paletteTree: NbtTree = {}
  for (const [name, index] of paletteIndex) paletteTree[name] = int(index)

  const metadata: NbtTree = {}
  for (const [key, value] of Object.entries(input.metadata ?? {})) metadata[key] = string(value)

  /**
   * 实体与方块实体。三处**照记忆写必错**的地方，全部按规范原文（`schematic-3.md`）钉死：
   *
   * 1. `Entities` 在**根**上，而 `BlockEntities` 在 **`Blocks` 里面**——v2 是两者都在根上。
   * 2. 附加数据的键 v3 是 **`Data`**、v2 是 **`Extra`**；而且 v2 的实体附加数据是**内联**的
   *    （`Motion`/`Rotation` 与 `Pos`/`Id` 平级），v3 才嵌在一个子 compound 下。
   * 3. `Rotation` **不是**必须字段，它只是附加数据的一部分。
   *
   * 空的列表不写字段：这两个在规范里都没有 "Required" 标记，而没有实体的原理图
   * 不该凭空多两个空列表。
   */
  const entityTags = [...(input.entities ?? [])].map((entity) =>
    entityTagOf(entity.pos, entity.id, entity.data),
  )
  const blockEntityTags = [...(input.blockEntities ?? [])].map((entity) =>
    blockEntityTagOf(entity.pos, entity.id, entity.data),
  )

  const schematic: NbtTree = {
    Version: int(3),
    DataVersion: int(input.dataVersion),
    Width: short(width),
    Height: short(height),
    Length: short(length),
    Offset: intArray(input.offset ?? [0, 0, 0]),
    Blocks: compound({
      Palette: compound(paletteTree),
      Data: byteArray(encodeVarints(indices)),
      ...(blockEntityTags.length > 0 ? { BlockEntities: compoundList(blockEntityTags) } : {}),
    }),
  }
  if (entityTags.length > 0) schematic['Entities'] = compoundList(entityTags)
  if (Object.keys(metadata).length > 0) schematic['Metadata'] = compound(metadata)

  return writeNbt({ Schematic: compound(schematic) })
}

/** 实体的 `Pos` 是 `double[3]`——在 NBT 里是 **double 列表**，不是 IntArray。 */
function entityTagOf(
  pos: [number, number, number],
  id: string,
  data: Record<string, unknown>,
): NbtTree {
  return withData({ Pos: list('double', pos), Id: string(id) }, data)
}

/** 方块实体的 `Pos` 是 `integer[3]`——在 NBT 里是 **IntArray**。 */
function blockEntityTagOf(
  pos: [number, number, number],
  id: string,
  data: Record<string, unknown>,
): NbtTree {
  return withData({ Pos: intArray(pos), Id: string(id) }, data)
}

/** 附加数据只在**非空**时写 `Data`：规范说它是可选的，空 compound 是噪音。 */
function withData(head: NbtTree, data: Record<string, unknown>): NbtTree {
  const payload = compoundFromJson(data)
  if (Object.keys(payload).length === 0) return head
  return { ...head, Data: compound(payload) }
}

/** 读 `.schem`。**v2 与 v3 都认**，也认未压缩的输入。 */
export async function readSpongeSchematic(bytes: Uint8Array): Promise<SchematicData> {
  const root = await readNbt(bytes)
  const schematic = asCompound(child(root, 'Schematic'))
  if (schematic === undefined) {
    // 也可能是 v1 的老布局：Palette / BlockData 直接挂在根上
    if (child(root, 'Palette') !== undefined) {
      throw new Error(
        '这是 Sponge v1 格式（Palette/BlockData 在根上），本工具只支持 v2/v3。' +
          '用 WorldEdit `//schem save` 重新导出一次即可升级到 v3。',
      )
    }
    throw new Error('不是合法的 .schem：根标签里没有 Schematic 复合标签')
  }

  const version = asInt(schematic['Version'], 0)
  const width = asInt(schematic['Width'])
  const height = asInt(schematic['Height'])
  const length = asInt(schematic['Length'])
  if (width <= 0 || height <= 0 || length <= 0) {
    throw new Error(`.schem 尺寸非法：${width}x${height}x${length}`)
  }

  const blocksTag = asCompound(schematic['Blocks'])
  if (blocksTag === undefined) throw new Error('.schem 缺少 Blocks 复合标签')
  const paletteTree = asCompound(blocksTag['Palette'])
  if (paletteTree === undefined) throw new Error('.schem 缺少 Blocks.Palette')

  const palette: string[] = []
  for (const [name, indexTag] of Object.entries(paletteTree)) {
    const index = asInt(indexTag, -1)
    if (index >= 0) palette[index] = name
  }

  const data = asByteArray(blocksTag['Data'])
  if (data === undefined) throw new Error('.schem 缺少 Blocks.Data')

  // v3 是 VarInt，v2 是定宽 2 字节大端。版本号缺失时按 v2 试——
  // 老文件里 Version 字段本来就可能没有。
  // **在展开 Data 之前**先卡体积。否则一个声明 1×1×1、却塞了一大坨 Data 的文件会先被
  // 整段解码出来——`importSchematicInto` 里那道守卫是之后才走到的，而且解码出来的
  // 数值数组比输入本身更占内存。上限与那一道用同一个：单次写入的硬上限。
  const expected = width * height * length
  if (expected > DEFAULT_HARD_LIMIT) {
    throw new Error(
      `.schem 声明了 ${width}x${height}x${length} = ${expected} 格，超过单次写入上限 ${DEFAULT_HARD_LIMIT} 格`,
    )
  }

  const indices = version >= 3 ? decodeVarints(data) : decodeFixed16(data)

  const offsetRaw = asIntArray(schematic['Offset'])
  const offset: [number, number, number] = [
    offsetRaw?.[0] ?? 0,
    offsetRaw?.[1] ?? 0,
    offsetRaw?.[2] ?? 0,
  ]

  const blocks: SchematicBlock[] = []
  const limit = Math.min(indices.length, expected)
  for (let i = 0; i < limit; i++) {
    const index = indices[i]!
    if (index === 0) continue
    const state = palette[index]
    if (state === undefined) continue
    if (state === 'minecraft:air' || state === 'air') continue
    const y = Math.floor(i / (width * length))
    const rest = i - y * width * length
    const z = Math.floor(rest / width)
    const x = rest - z * width
    blocks.push({ x, y, z, state })
  }

  /**
   * 实体与方块实体。**三个版本差异都要认**（规范 v2 与 v3）：
   * - `BlockEntities` 的位置：v3 在 `Blocks` 里、v2 在**根**上；
   * - 附加数据的键：v3 是 `Data`、v2 是 `Extra`；
   * - v2 的附加数据是**内联**的（与 `Pos`/`Id` 平级），v3 嵌在 `Data` 下。
   *
   * 所以两种位置、两个键名、内联与嵌套**全都收**，合并成一份 `data`。
   * 多认一种写法比按规范严格拒绝更符合 §6 那套读方容忍度；而它不会掩盖结构错误——
   * `Id` 或 `Pos` 缺失的条目仍然被跳过（数量对不上时在 `ImportResult` 里看得出来）。
   */
  const entities = readEntities(schematic['Entities'])
  const blockEntities = readBlockEntities(blocksTag['BlockEntities'] ?? schematic['BlockEntities'])

  const dataVersion = schematic['DataVersion']
  const metadataTree = asCompound(schematic['Metadata'])
  const metadata: Record<string, string> = {}
  for (const [key, tag] of Object.entries(metadataTree ?? {})) {
    const value = asString(tag)
    if (value.length > 0) metadata[key] = value
  }

  const result: SchematicData = {
    size: [width, height, length],
    offset,
    blocks,
    entities,
    blockEntities,
    palette,
    formatVersion: version,
  }
  if (dataVersion !== undefined) result.dataVersion = asInt(dataVersion)
  if (Object.keys(metadata).length > 0) result.metadata = metadata
  return result
}

function readEntities(tag: Tag | undefined): SchematicEntity[] {
  const out: SchematicEntity[] = []
  for (const entry of asCompoundList(tag)) {
    const id = asString(entry['Id'])
    const pos = asNumberList(entry['Pos'])
    if (id.length === 0 || pos === undefined || pos.length !== 3) continue
    out.push({ id, pos: [pos[0]!, pos[1]!, pos[2]!], data: extraDataOf(entry) })
  }
  return out
}

function readBlockEntities(tag: Tag | undefined): SchematicBlockEntity[] {
  const out: SchematicBlockEntity[] = []
  for (const entry of asCompoundList(tag)) {
    const id = asString(entry['Id'])
    const pos = asNumberList(entry['Pos'])
    if (id.length === 0 || pos === undefined || pos.length !== 3) continue
    out.push({ id, pos: [Math.trunc(pos[0]!), Math.trunc(pos[1]!), Math.trunc(pos[2]!)], data: extraDataOf(entry) })
  }
  return out
}

/**
 * 一条实体/方块实体记录里的附加数据。
 *
 * `Pos` 与 `Id` 是规范规定的字段，剩下的全是附加数据；v3 再额外把它们收进一个
 * `Data` 子 compound。这里把**内联的其余字段**与 `Data`/`Extra` 两个名字的子
 * compound 合并成一份 JSON——两个键名都认，是因为规范正文写 `Extra`（v2）、
 * 而 v2 的示例是内联的，两处不一致，照哪一处都会漏掉另一种写法的文件。
 */
function extraDataOf(entry: Record<string, Tag | undefined>): Record<string, unknown> {
  const inline: Record<string, Tag | undefined> = {}
  for (const [key, tag] of Object.entries(entry)) {
    if (key === 'Pos' || key === 'Id' || key === 'Data' || key === 'Extra') continue
    inline[key] = tag
  }
  const out = compoundToJson(inline)
  for (const key of ['Data', 'Extra']) {
    const nested = asCompound(entry[key])
    if (nested !== undefined) Object.assign(out, compoundToJson(nested))
  }
  return out
}

// ── VarInt 与定宽编码 ─────────────────────────────────────────────────────────

/**
 * 标准的 LEB128 无符号 VarInt（每字节低 7 位，最高位是继续标志）。
 *
 * 用二进制补码的负数会被当成"没完没了"的序列——索引永远非负，所以这里不接受负数。
 */
export function encodeVarints(values: ArrayLike<number>): number[] {
  const out: number[] = []
  for (let i = 0; i < values.length; i++) {
    let value = values[i]!
    if (value < 0) throw new RangeError(`VarInt 不接受负数：${value}`)
    for (;;) {
      const chunk = value & 0x7f
      value >>>= 7
      if (value === 0) {
        out.push(chunk)
        break
      }
      out.push(chunk | 0x80)
    }
  }
  return out
}

export function decodeVarints(bytes: readonly number[]): number[] {
  const out: number[] = []
  let shift = 0
  let current = 0
  for (const byte of bytes) {
    current |= (byte & 0x7f) << shift
    if ((byte & 0x80) === 0) {
      out.push(current >>> 0)
      current = 0
      shift = 0
      continue
    }
    shift += 7
    if (shift > 28) throw new Error('VarInt 超过 5 字节——数据可能不是 v3 编码')
  }
  return out
}

/** v2：每格两个字节，大端。 */
function decodeFixed16(bytes: readonly number[]): number[] {
  const out: number[] = []
  for (let i = 0; i + 1 < bytes.length; i += 2) {
    out.push(((bytes[i]! << 8) | bytes[i + 1]!) & 0xffff)
  }
  return out
}

/** 供测试与诊断：从原始 NBT 树里取一个标签。 */
export function peekTag(tree: NbtTree, path: readonly string[]): Tag | undefined {
  let current: Tag | undefined = { type: 'compound', value: tree } as unknown as Tag
  for (const key of path) {
    current = child(current, key)
    if (current === undefined) return undefined
  }
  return current
}
