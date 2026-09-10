import type { BlockRegistry } from './registry.js'
import type { BlockProperty, BlockType, Properties, PropertyValue } from './types.js'

export class StateError extends Error {
  override readonly name = 'StateError'
}

/**
 * 全局 block state id 的编解码。
 *
 * 规则（已在 1.21.4 上对全部 27 484 个 state 全量验证，往返零失配）：
 *
 *   全局 stateId = block.minStateId + Σ(属性序号 × 权重)
 *   权重按 `block.states` **逆序**做混合进制 —— 最后一个属性变化最快。
 *
 * 三个必须遵守的约束（每一条都对应一个实测复现过的坑）：
 *
 * 1. **bool 是反的**：`propertyValueAt` 的索引 0 表示 `true`、1 表示 `false`。
 * 2. **缺省属性从 `defaultState` 继承，不能用 `values[0]`**。
 *    713 个带属性的方块里有 566 个的 `defaultState !== minStateId`；
 *    且 `oak_stairs.half.values = ["top","bottom"]` 而默认是 `bottom`。
 * 3. **相等性一律比较 stateId，绝不比较字符串**——属性顺序在生态里没有统一约定。
 */

/**
 * 属性序号 → 属性值。
 *
 * **`values` 数组是载荷，不是装饰**：136 个 `int` 属性里有 35 个的 `values` 并非 `0..n-1`
 * （`oak_leaves.distance` 是 `["1".."7"]`、`snow.layers` 是 `["1".."8"]`、`candle.candles` 是 `["1".."4"]`）。
 * 因此必须走 `values[index]` 而不是直接返回序号——用序号会让 `distance=7` 静默变成 `distance=6`。
 *
 * 与 prismarine-block 的唯一差别：`int` 类属性返回**数字**而非字符串
 * （`water.level` 返回 `0` 而不是 `"0"`）。规范化输出一致，但类型更正确。
 *
 * **bool 的索引 0 表示 `true`**（与直觉相反，这是 provider 的约定）。
 */
export function propertyValueAt(property: BlockProperty, index: number): PropertyValue {
  if (property.type === 'bool') return index === 0
  const raw = property.values?.[index]
  if (raw === undefined) {
    if (property.type === 'int') return index
    throw new StateError(`${property.name}: index ${index} is outside the value range [0, ${property.num_values})`)
  }
  return property.type === 'int' ? Number(raw) : raw
}

/** 属性值 → 属性序号。`propertyValueAt` 的逆运算。 */
export function propertyIndexOf(property: BlockProperty, value: PropertyValue): number {
  if (property.type === 'bool') {
    if (value === true || value === 'true') return 0
    if (value === false || value === 'false') return 1
    throw new StateError(`${property.name}: "${String(value)}" is not a valid boolean`)
  }
  if (property.values !== undefined) {
    const index = property.values.indexOf(String(value))
    if (index < 0) {
      throw new StateError(
        `${property.name}: "${String(value)}" is not a valid value, options: ${property.values.join(' | ')}`,
      )
    }
    return index
  }
  if (property.type === 'int') {
    const numeric = Number(value)
    if (!Number.isInteger(numeric) || numeric < 0 || numeric >= property.num_values) {
      throw new StateError(`${property.name}: ${String(value)} is outside the integer value range [0, ${property.num_values})`)
    }
    return numeric
  }
  throw new StateError(`${property.name}: cannot map "${String(value)}" to a property index`)
}

/** 全局 stateId → 完整属性集。 */
export function stateIdToProperties(block: BlockType, stateId: number): Properties {
  if (stateId < block.minStateId || stateId > block.maxStateId) {
    throw new StateError(
      `state id ${stateId} does not belong to ${block.name} (range ${block.minStateId}..${block.maxStateId})`,
    )
  }
  let data = stateId - block.minStateId
  const properties: Properties = {}
  for (let i = block.states.length - 1; i >= 0; i--) {
    const property = block.states[i]!
    properties[property.name] = propertyValueAt(property, data % property.num_values)
    data = Math.floor(data / property.num_values)
  }
  return properties
}

/**
 * 属性集 → 全局 stateId。
 *
 * 只传部分属性是允许的：**缺的那些从 `defaultState` 继承**，然后用传入的覆盖。
 * 这是本文件最容易写错的地方——用 `values[0]` 补缺省会静默产生错误的方块
 * （`oak_stairs[facing=east]` 会变成 `half=top` 而不是 `half=bottom`）。
 */
export function propertiesToStateId(block: BlockType, overrides: Properties = {}): number {
  const full: Properties =
    block.states.length > 0 ? stateIdToProperties(block, block.defaultState) : {}

  for (const [name, value] of Object.entries(overrides)) {
    if (!block.states.some((s) => s.name === name)) {
      const known = block.states.map((s) => s.name).join(', ')
      throw new StateError(
        `${block.name} has no property "${name}"${known ? `, it has: ${known}` : ' (it has no properties)'}`,
      )
    }
    full[name] = value
  }

  let data = 0
  let offset = 1
  for (let i = block.states.length - 1; i >= 0; i--) {
    const property = block.states[i]!
    data += offset * propertyIndexOf(property, full[property.name]!)
    offset *= property.num_values
  }
  return block.minStateId + data
}

/**
 * 属性集 → 规范字符串。
 *
 * 规范形式：**属性名字母序 + 输出全部属性（不省略默认值）**。
 * 这样字符串自包含、可离线 diff、可做集合去重，不依赖注册表也能读懂。
 */
export function formatState(block: BlockType, properties: Properties): string {
  const keys = Object.keys(properties).sort()
  if (keys.length === 0) return `minecraft:${block.name}`
  const body = keys.map((k) => `${k}=${String(properties[k])}`).join(',')
  return `minecraft:${block.name}[${body}]`
}

/** 全局 stateId → 规范字符串。 */
export function stateIdToString(block: BlockType, stateId: number): string {
  return formatState(block, stateIdToProperties(block, stateId))
}

const STATE_PATTERN = /^(?:minecraft:)?([a-z0-9_]+)(?:\[([^\]]*)\])?$/

export interface ParsedState {
  block: BlockType
  stateId: number
  properties: Properties
  canonical: string
}

/**
 * 规范（或任意顺序、任意省略）的 state 字符串 → 方块 + stateId。
 *
 * **解析与属性顺序无关**：按属性名匹配，不按位置。
 * 未出现的属性从 `defaultState` 继承（见 `propertiesToStateId`）。
 */
export function parseState(registry: BlockRegistry, input: string): ParsedState {
  const trimmed = input.trim()
  const match = STATE_PATTERN.exec(trimmed)
  if (match === null) {
    throw new StateError(`Cannot parse block state "${input}", expected a form like minecraft:oak_stairs[facing=north]`)
  }
  const name = match[1]!
  const block = registry.blockByName(name)
  if (block === undefined) {
    throw new StateError(`Unknown block "minecraft:${name}" (version ${registry.minecraftVersion})`)
  }

  const overrides: Properties = {}
  const body = match[2]
  if (body !== undefined && body.length > 0) {
    for (const pair of body.split(',')) {
      const eq = pair.indexOf('=')
      if (eq <= 0) throw new StateError(`"${pair}" in block state "${input}" is not key=value`)
      const key = pair.slice(0, eq).trim()
      const raw = pair.slice(eq + 1).trim()
      overrides[key] = coercePropertyValue(block, key, raw)
    }
  }

  const stateId = propertiesToStateId(block, overrides)
  const properties = stateIdToProperties(block, stateId)
  return { block, stateId, properties, canonical: formatState(block, properties) }
}

function coercePropertyValue(block: BlockType, name: string, raw: string): PropertyValue {
  const property = block.states.find((s) => s.name === name)
  if (property === undefined) return raw
  if (property.type === 'bool') {
    if (raw === 'true') return true
    if (raw === 'false') return false
    throw new StateError(`${block.name}.${name} expects true/false, got "${raw}"`)
  }
  if (property.type === 'int') {
    const n = Number(raw)
    if (!Number.isInteger(n)) throw new StateError(`${block.name}.${name} expects an integer, got "${raw}"`)
    return n
  }
  return raw
}
