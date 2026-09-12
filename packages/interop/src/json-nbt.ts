import {
  byte,
  byteArray,
  compound,
  double,
  float,
  int,
  intArray,
  list,
  long,
  longArray,
  longToBigInt,
  short,
  string,
} from './nbt.js'
import type { NbtTree, Tag } from './nbt.js'

/**
 * JSON ↔ NBT。
 *
 * 世界的两层稀疏数据在我们的模型里是 **JSON**（`PlacedEntity.data`，模型手写、`.mcai` 存它），
 * 而 `.schem` / `.litematic` 里是 **NBT**。两种表示的信息量不一样：NBT 有 12 种数字类型
 * （byte/short/int/long/float/double + 三种定长数组），JSON 只有一个 `number`。
 * 所以"转一下"这件事没有唯一正确答案，必须有**写死的规则**。
 *
 * ## 规则
 *
 * 1. **NBT → JSON**：推断得出的类型写成裸 JSON（`int` → 数字、`string` → 字符串），
 *    推断不出来的写成 `<Annotation>`（`{"__nbt":"short","value":5}`）。
 *    `long` 写成十进制字符串——`BigInt` 过不了 `JSON.stringify`，而写成 number 会在
 *    超过 2^53 时**安静地改值**。
 * 2. **JSON → NBT**：整数 → `int`、非整数 → `double`、字符串 → `string`、
 *    布尔 → `byte`、数组 → `list`（元素类型取第一个元素的推断）、对象 → `compound`；
 *    带 `<Annotation>` 的按标注还原。
 *
 * 两条合起来的效果：**外部文件 → 我们 → 外部文件是无损的**（类型靠标注活下来），
 * 而模型手写的普通 JSON 也读得懂、写得出去。少了标注这一半，"导入一个真箱子再导出"
 * 会把 `Items[].count` 从 byte 变成 int——文件看起来成功，游戏里读出来是错的。
 */
export interface Annotation {
  __nbt: string
  value: unknown
}

const KEY = '__nbt'

/** 能否在 JSON 里"裸"表示某个 NBT 标量而不会在回程改变类型。 */
function isAnnotated(value: unknown): value is Annotation {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  return typeof record[KEY] === 'string' && 'value' in record
}

/** NBT compound → JSON 对象。 */
export function compoundToJson(tree: Record<string, Tag | undefined>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [key, tag] of Object.entries(tree)) {
    // NBT 允许空槽（`undefined`），JSON 里直接没有这个键
    if (tag === undefined) continue
    out[key] = nbtToJson(tag)
  }
  return out
}

/** JSON 对象 → NBT compound。 */
export function compoundFromJson(data: Record<string, unknown>): NbtTree {
  const tree: NbtTree = {}
  for (const [key, value] of Object.entries(data)) {
    if (value === undefined) continue
    tree[key] = jsonToNbt(value)
  }
  return tree
}

export function nbtToJson(tag: Tag): unknown {
  switch (tag.type) {
    case 'int':
      return tag.value
    case 'string':
      return tag.value
    case 'byte':
      return annotate('byte', tag.value)
    case 'short':
      return annotate('short', tag.value)
    case 'float':
      return annotate('float', tag.value)
    // 整数取值的 double 必须标注：裸写成 `5` 回程会被推断成 int
    case 'double':
      return Number.isInteger(tag.value) ? annotate('double', tag.value) : tag.value
    case 'long':
      return annotate('long', longToBigInt(tag.value).toString())
    case 'byteArray':
      return annotate('byteArray', [...tag.value])
    case 'intArray':
      return annotate('intArray', [...tag.value])
    case 'longArray':
      return annotate('longArray', tag.value.map((pair) => longToBigInt(pair).toString()))
    case 'list': {
      const elementType = tag.value.type as string
      const entries = tag.value.value as unknown[]
      return entries.map((entry) => listElementToJson(elementType, entry))
    }
    case 'compound':
      return compoundToJson(tag.value)
    default:
      return undefined
  }
}

/**
 * 列表元素的读取。
 *
 * `prismarine-nbt` 在这里有个**形状不对称**：标量列表的元素是裸值（`['a','b']`），
 * 复合列表的元素是裸字段表（`{Name: …}`）——都不是 `{type, value}` 包装。
 * 所以元素不能直接喂给 `nbtToJson`，得先按列表声明的元素类型还原。
 */
function listElementToJson(elementType: string, entry: unknown): unknown {
  if (elementType === 'compound') {
    return compoundToJson(entry as Record<string, Tag | undefined>)
  }
  if (elementType === 'list') {
    const nested = entry as { type: string; value: unknown[] }
    return nested.value.map((item) => listElementToJson(nested.type, item))
  }
  return scalarToJson(elementType, entry)
}

function scalarToJson(type: string, value: unknown): unknown {
  switch (type) {
    case 'int':
      return value
    case 'string':
      return value
    case 'byte':
      return annotate('byte', value)
    case 'short':
      return annotate('short', value)
    case 'float':
      return annotate('float', value)
    case 'double':
      return typeof value === 'number' && Number.isInteger(value)
        ? annotate('double', value)
        : value
    case 'long':
      return annotate('long', longToBigInt(value as [number, number]).toString())
    default:
      return value
  }
}

function annotate(type: string, value: unknown): Annotation {
  return { [KEY]: type, value }
}

/**
 * 从 JSON 里取一个数字，**带标注的也认**。
 *
 * 为什么需要：`double` 列表里的整数值（`[180, 0]` 这样的旋转角）读回来是带标注的
 * `{__nbt:'double', value:180}`——因为裸写成 `180` 回程会变成 int。于是"读一个数"
 * 这件事不能只判 `typeof === 'number'`，否则看起来最普通的一个字段反而读不出来。
 */
export function numberFromJson(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (isAnnotated(value)) {
    const inner = value.value
    if (typeof inner === 'number' && Number.isFinite(inner)) return inner
    if (typeof inner === 'string' && inner.trim().length > 0) {
      const parsed = Number(inner)
      if (Number.isFinite(parsed)) return parsed
    }
  }
  return undefined
}

/** 转换不出来的值。**抛错而不是猜**——猜出来的文件在游戏里是错的，而这里看不出来。 */
export class NbtConversionError extends Error {
  override readonly name = 'NbtConversionError'
}

export function jsonToNbt(value: unknown): Tag {
  if (value === null) {
    // NBT 没有 null。JSON 的 null 多半是"没填"，写成空 compound 比编一个类型诚实
    throw new NbtConversionError('null 在 NBT 里没有对应类型')
  }
  if (isAnnotated(value)) return fromAnnotation(value)
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new NbtConversionError(`${value} 不是有限数字`)
    return Number.isInteger(value) ? int(value) : double(value)
  }
  if (typeof value === 'boolean') return byte(value ? 1 : 0)
  if (typeof value === 'string') return string(value)
  if (Array.isArray(value)) return listFromJson(value)
  if (typeof value === 'object') return compound(compoundFromJson(value as Record<string, unknown>))
  throw new NbtConversionError(`无法把 ${typeof value} 变成 NBT 标签`)
}

/**
 * 数组 → `list`。NBT 的列表**必须是同质的**。
 *
 * 数字数组要**整体**看，不能逐个推：`[189.3, 45]`（旋转角最常这么写）逐个推会得到
 * `double` 与 `int` 混在一起、直接抛错——而正确答案显然是"double 列表"。
 * 其余情况元素类型由第一个元素定，后面的不一致就抛错，不强行合并成字符串之类。
 */
function listFromJson(values: readonly unknown[]): Tag {
  if (values.length === 0) {
    // 空列表：NBT 用 TAG_End 当元素类型，游戏读得懂，也保留"这是个空列表"
    return list('end', [])
  }
  if (values.every((value) => typeof value === 'number' && Number.isFinite(value))) {
    const elementType = values.every((value) => Number.isInteger(value)) ? 'int' : 'double'
    return list(elementType, [...values])
  }
  const first = jsonToNbt(values[0])
  const elementType = first.type as string
  const entries: unknown[] = []
  for (let i = 0; i < values.length; i++) {
    const tag = jsonToNbt(values[i])
    if (tag.type !== first.type) {
      throw new NbtConversionError(
        `NBT 的列表必须是同质的：第 0 个元素是 ${first.type}，第 ${i} 个是 ${tag.type}`,
      )
    }
    // 列表元素写**裸值**（复合列表是裸字段表、标量列表是裸标量、嵌套列表是 `{type,value}`），
    // 见 `list` / `compoundList` 的说明——包装形状会让序列化器在深处抛错
    entries.push(tag.value)
  }
  return list(elementType, entries)
}

function fromAnnotation(annotation: Annotation): Tag {
  const { __nbt: type, value } = annotation
  switch (type) {
    case 'byte':
      return byte(asNumber(value, type))
    case 'short':
      return short(asNumber(value, type))
    case 'int':
      return int(asNumber(value, type))
    case 'float':
      return float(asNumber(value, type))
    case 'double':
      return double(asNumber(value, type))
    case 'long':
      return long(BigInt(String(value)))
    case 'string':
      return string(String(value))
    case 'byteArray':
      return byteArray(asNumberArray(value, type))
    case 'intArray':
      return intArray(asNumberArray(value, type))
    case 'longArray':
      return longArray(asArray(value, type).map((entry) => BigInt(String(entry))))
    default:
      throw new NbtConversionError(`不认识标注的类型 ${JSON.stringify(type)}`)
  }
}

function asNumber(value: unknown, type: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new NbtConversionError(`标注 ${type} 的值必须是有限数字，收到 ${JSON.stringify(value)}`)
  }
  return value
}

function asArray(value: unknown, type: string): unknown[] {
  if (!Array.isArray(value)) {
    throw new NbtConversionError(`标注 ${type} 的值必须是数组，收到 ${JSON.stringify(value)}`)
  }
  return value
}

function asNumberArray(value: unknown, type: string): number[] {
  return asArray(value, type).map((entry) => asNumber(entry, type))
}
