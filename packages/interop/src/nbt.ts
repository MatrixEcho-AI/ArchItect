import { gzipSync, gunzipSync } from 'node:zlib'

import { parse, parseUncompressed, writeUncompressed } from 'prismarine-nbt'
import type { NBT, TagType, Tags } from 'prismarine-nbt'

/**
 * NBT 的一层薄封装。
 *
 * `prismarine-nbt` 是生态里唯一被广泛验证的实现，直接用它是正确的取舍——
 * 但它的**入参和出参形状不对称**，这个不对称必须在一处收口，不能散到各个格式里：
 *
 * | | long 的表示 |
 * |---|---|
 * | 写（入参） | **有符号 BigInt**（超过 2^63-1 会直接抛 ERR_OUT_OF_RANGE）|
 * | 读（出参） | `[hi, lo]` 两个**有符号 32 位**整数 |
 *
 * `.litematic` 的位打包会把 64 位当成位容器用，必然要碰到最高位，
 * 所以"无符号位模式 ↔ 有符号 BigInt"的转换是这里的核心职责。
 */

export type Tag = Tags[TagType]
export type Compound = Tags[TagType.Compound]

/** 外部传进来的整棵树。写出去时用。 */
export type NbtTree = Record<string, Tag>

// ── 构造：让格式代码读起来接近 NBT 自己的写法 ──────────────────────────────────

export const int = (value: number): Tags[TagType.Int] => ({ type: 'int', value: Math.trunc(value) })
export const short = (value: number): Tags[TagType.Short] => ({ type: 'short', value: Math.trunc(value) })
export const byte = (value: number): Tags[TagType.Byte] => ({ type: 'byte', value: Math.trunc(value) })
export const double = (value: number): Tags[TagType.Double] => ({ type: 'double', value })
export const string = (value: string): Tags[TagType.String] => ({ type: 'string', value })
export const compound = (value: NbtTree): Compound =>
  ({ type: 'compound', value }) as unknown as Compound
export const byteArray = (value: readonly number[]): Tags[TagType.ByteArray] => ({
  type: 'byteArray',
  // NBT 的 byte 是**有符号**的，而我们的调色板索引是 0..255
  value: [...value].map((v) => (v > 127 ? v - 256 : v)),
})
export const intArray = (value: readonly number[]): Tags[TagType.IntArray] => ({ type: 'intArray', value: [...value] })

/**
 * NBT 的 long 是**有符号**的；这里接受无符号位模式并转换。
 *
 * 两处 `as unknown as` 是必要的：`prismarine-nbt` 的类型把 long 描述成
 * `[number, number]`（那是**解析输出**的形状），而**写入时要的是 BigInt**。
 * 类型的这个不对称是上游的疏忽，收口在这里比散到每个调用点好。
 */
export const long = (bits: bigint): Tags[TagType.Long] =>
  ({ type: 'long', value: BigInt.asIntN(64, bits) }) as unknown as Tags[TagType.Long]

export const longArray = (values: readonly bigint[]): Tags[TagType.LongArray] =>
  ({
    type: 'longArray',
    value: values.map((v) => BigInt.asIntN(64, v)),
  }) as unknown as Tags[TagType.LongArray]

/**
 * 标量列表（int / string / byte …）。元素是**裸值**，不是 `{type, value}` 包装。
 */
export function list<T extends Tag>(type: string, value: readonly T[]): Tags[TagType.List] {
  return { type: 'list', value: { type: type as TagType, value: [...value] } } as Tags[TagType.List]
}

/**
 * **复合列表**（`.litematic` 的 `BlockStatePalette` 就是它）。
 *
 * NBT 的列表里，元素类型字节已经说明了"每个元素是一个 compound"，
 * 所以元素**直接写字段表**，不再套一层 `{type:'compound', value}`。多套一层的话
 * 序列化结果会变成"字段名叫 type 和 value 的 compound"——文件看起来写成功了，
 * 读回来却整个错位。这个坑只有对着字节看才能发现。
 */
export function compoundList(entries: readonly NbtTree[]): Tags[TagType.List] {
  return {
    type: 'list',
    value: { type: 'compound' as TagType, value: [...entries] },
  } as unknown as Tags[TagType.List]
}

/**
 * 读复合列表。**两种形状都认**——上游解析器给的是裸字段表，
 * 但手写/别处构造的树可能是包装过的，这里统一成裸字段表。
 */
export function asCompoundList(tag: Tag | undefined): Array<Record<string, Tag | undefined>> {
  if (tag === undefined || tag.type !== 'list') return []
  const entries = tag.value.value as unknown[]
  return entries.map((entry) => {
    if (entry !== null && typeof entry === 'object' && (entry as { type?: string }).type === 'compound') {
      return (entry as { value: Record<string, Tag | undefined> }).value
    }
    return entry as Record<string, Tag | undefined>
  })
}

// ── 读取：全部走"安全取值"，缺项/类型不符时给默认值而不是崩 ─────────────────────

export function child(tag: Tag | undefined, key: string): Tag | undefined {
  if (tag === undefined || tag.type !== 'compound') return undefined
  return tag.value[key]
}

export function asInt(tag: Tag | undefined, fallback = 0): number {
  if (tag === undefined) return fallback
  if (tag.type === 'int' || tag.type === 'short' || tag.type === 'byte') return tag.value
  if (tag.type === 'long') return Number(longToBigInt(tag.value))
  return fallback
}

export function asString(tag: Tag | undefined, fallback = ''): string {
  return tag !== undefined && tag.type === 'string' ? tag.value : fallback
}

/** 读出来的 compound。**值可能是 undefined**（NBT 允许空槽），调用方用 `child()` 取值。 */
export function asCompound(tag: Tag | undefined): Record<string, Tag | undefined> | undefined {
  return tag !== undefined && tag.type === 'compound' ? tag.value : undefined
}

/** 数组类标签统一成 `number[]`（byte 是有符号的，这里还原成 0..255）。 */
export function asByteArray(tag: Tag | undefined): number[] | undefined {
  if (tag === undefined) return undefined
  if (tag.type !== 'byteArray') return undefined
  return tag.value.map((v) => (v < 0 ? v + 256 : v))
}

export function asIntArray(tag: Tag | undefined): number[] | undefined {
  if (tag === undefined || tag.type !== 'intArray') return undefined
  return [...tag.value]
}

/** 读出来的 `[hi, lo]` → 有符号 64 位。 */
export function longToBigInt(value: readonly [number, number]): bigint {
  const [hi, lo] = value
  return BigInt.asIntN(64, (BigInt(hi) << 32n) + BigInt(lo >>> 0))
}

/** longArray 读出来是 `[hi,lo][]`；`.litematic` 的位打包需要原始位模式。 */
export function asLongArray(tag: Tag | undefined): bigint[] | undefined {
  if (tag === undefined || tag.type !== 'longArray') return undefined
  return tag.value.map((pair) => longToBigInt(pair))
}

/** longArray 的**无符号**位模式——位打包时必须用它，不能带符号右移。 */
export function asUnsignedLongArray(tag: Tag | undefined): bigint[] | undefined {
  return asLongArray(tag)?.map((v) => BigInt.asUintN(64, v))
}

// ── 编解码 ────────────────────────────────────────────────────────────────────

export interface ReadNbtOptions {
  /** 传入的是不是 gzip。省略时自动探测（NBT 头是 0x0a，gzip 是 0x1f 0x8b）。 */
  compressed?: boolean
}

const GZIP_MAGIC = 0x1f

/**
 * 解压后允许的最大字节数。
 *
 * `gunzipSync` 不传 `maxOutputLength` 时按 `buffer.kMaxLength` 兜底（等于不限制），
 * 而 `.schem` / `.litematic` 都是压缩过的：全零数据的压缩比约 1000×，一个几百 KB
 * 的文件就能解出几百 MB，撑死进程（V8 致命 OOM，不可捕获）。
 *
 * 这个值远大于任何真实原理图：单次写入的硬上限是 400 万格，密排也就十几 MB。
 */
const MAX_DECOMPRESSED_BYTES = 256 * 1024 * 1024

/**
 * 解析 NBT。**自动识别 gzip**——`.schem` 与 `.litematic` 都是 gzip 过的，
 * 但用户手动 `gunzip` 过、或者从某些工具里导出的未压缩版本也时常见到。
 */
export function readNbt(bytes: Uint8Array): Promise<NBT> {
  const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const compressed = bytes.length > 1 && bytes[0] === GZIP_MAGIC && bytes[1] === 0x8b
  if (compressed) {
    // 先解压再按未压缩解析：`parse()` 对未压缩输入会猜错格式的地方，
    // 明确走这条路更可控
    return parseUncompressedResult(gunzipSync(buffer, { maxOutputLength: MAX_DECOMPRESSED_BYTES }))
  }
  return parseUncompressedResult(buffer)
}

async function parseUncompressedResult(buffer: Buffer): Promise<NBT> {
  try {
    return parseUncompressed(buffer)
  } catch {
    // 兜底：让 prismarine-nbt 自己去认（它支持 big / little / littleVarint）
    const result = await parse(buffer)
    return result.parsed
  }
}

export interface WriteNbtOptions {
  /** 默认 gzip——游戏与第三方工具都按 gzip 读。 */
  compress?: boolean
  /** 根标签名。`.schem` 通常留空串。 */
  name?: string
}

export function writeNbt(tree: NbtTree, options: WriteNbtOptions = {}): Uint8Array {
  const value: NBT = { type: 'compound', name: options.name ?? '', value: tree }
  const raw = writeUncompressed(value, 'big')
  return options.compress === false ? new Uint8Array(raw) : new Uint8Array(gzipSync(raw))
}
