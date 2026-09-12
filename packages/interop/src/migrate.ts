import { propertiesToStateId, propertyValueAt, stateIdToProperties } from '@architect/core'
import type { BlockRegistry, Properties, PropertyValue } from '@architect/core'

/**
 * 跨版本方块迁移。
 *
 * `.schem` 里带 `DataVersion`，但它只告诉你"这是哪个版本写的"，**不会帮你改方块**。
 * 从 1.13 到 1.21 的扁平化改名、1.17 的 `grass_path`→`dirt_path`、1.20.3 的
 * `grass`→`short_grass`……一个都逃不掉。
 *
 * ## 策略：三层，逐层降级，**永不静默丢东西**
 *
 * 1. **精确命中**：当前注册表里有这个名字 → 直接用。
 * 2. **显式改名表**：`MIGRATIONS` 里查得到 → 换名字，属性按新方块自己的声明**逐项过滤**。
 * 3. **认不出来 → 记进 `unknown` 并给出候选**。**绝不静默替换成空气**——
 *    一个"看起来导进去了但少了半面墙"的工程，比一个明确报错难查一百倍。
 *
 * 为什么不做一张覆盖全部方块的静态表：那份表永远不完整，而且每加一个版本就要维护一次。
 * 名字对不上的时候，**如实报告 + 给候选**比假装成功有用得多。
 */

export interface Migration {
  /** 源名字（不带 `minecraft:`）。 */
  from: string
  /** 目标名字（不带 `minecraft:`）。 */
  to: string
  /** 版本说明，只用于报告。 */
  note?: string
}

/**
 * 显式改名表。
 *
 * 只收**我有把握**的条目。宁可漏掉一条让用户看到候选，也不要写错一条导致
 * 一个看似成功、实际错位的导入。
 */
export const MIGRATIONS: readonly Migration[] = [
  // 1.14 扁平化：告示牌与床按材质拆开
  { from: 'sign', to: 'oak_sign', note: '1.14 flattened signs' },
  { from: 'wall_sign', to: 'oak_wall_sign', note: '1.14 flattened signs' },
  { from: 'bed', to: 'red_bed', note: '1.14 flattened beds' },
  { from: 'wooden_door', to: 'oak_door', note: '1.14 flattened doors' },
  { from: 'wooden_slab', to: 'oak_slab', note: '1.14 flattened slabs' },
  { from: 'wooden_stairs', to: 'oak_stairs', note: '1.14 flattened stairs' },
  { from: 'wooden_button', to: 'oak_button', note: '1.14 flattened buttons' },
  { from: 'wooden_pressure_plate', to: 'oak_pressure_plate', note: '1.14 flattened pressure plates' },
  { from: 'trapdoor', to: 'oak_trapdoor', note: '1.14 flattened trapdoors' },
  { from: 'fence', to: 'oak_fence', note: '1.14 flattened fences' },
  { from: 'fence_gate', to: 'oak_fence_gate', note: '1.14 flattened fence gates' },
  { from: 'stone_slab', to: 'smooth_stone_slab', note: '1.14 split stone slabs' },
  { from: 'brick_block', to: 'bricks', note: '1.14 renames' },
  { from: 'nether_brick', to: 'nether_bricks', note: '1.14 renames' },
  { from: 'nether_brick_fence', to: 'nether_brick_fence', note: 'unchanged in 1.21' },
  { from: 'hard_clay', to: 'terracotta', note: '1.14 renames' },
  { from: 'stained_hardened_clay', to: 'white_terracotta', note: '1.14 renames (colour lost)' },
  { from: 'grass_path', to: 'dirt_path', note: '1.17 rename' },
  { from: 'grass', to: 'short_grass', note: '1.20.3 rename' },
  { from: 'cauldron', to: 'cauldron', note: 'unchanged' },
  { from: 'lit_furnace', to: 'furnace', note: '1.13 block state → property' },
  { from: 'lit_pumpkin', to: 'jack_o_lantern', note: '1.13 rename' },
  { from: 'redstone_lamp_lit', to: 'redstone_lamp', note: '1.13 block state → property' },
  { from: 'repeater', to: 'repeater', note: 'unchanged' },
  { from: 'cobblestone_wall', to: 'cobblestone_wall', note: 'unchanged' },
]

const MIGRATION_BY_NAME = new Map<string, Migration>()
for (const migration of MIGRATIONS) {
  if (migration.from !== migration.to) MIGRATION_BY_NAME.set(migration.from, migration)
}

export type MigrationOutcome =
  | { kind: 'exact'; state: string }
  | { kind: 'renamed'; state: string; from: string; fromVersion?: number }
  | { kind: 'unknown'; from: string; suggestions: string[] }

const NAME_PATTERN = /^(?:minecraft:)?([a-z0-9_]+)(?:\[([^\]]*)\])?$/

/** 拆出方块名与属性。属性值按字面读，交给 `propertiesToStateId` 去解释。 */
export function parseStateString(state: string): { name: string; properties: Properties } | undefined {
  const match = NAME_PATTERN.exec(state.trim())
  if (match === null) return undefined
  const properties: Properties = {}
  for (const pair of (match[2] ?? '').split(',')) {
    const trimmed = pair.trim()
    if (trimmed.length === 0) continue
    const eq = trimmed.indexOf('=')
    if (eq <= 0) continue
    const key = trimmed.slice(0, eq).trim()
    const raw = trimmed.slice(eq + 1).trim()
    properties[key] = raw === 'true' ? true : raw === 'false' ? false : /^-?\d+$/.test(raw) ? Number(raw) : raw
  }
  return { name: match[1]!, properties }
}

/**
 * 把一个状态字符串迁移到当前注册表能表达的形式。
 *
 * 改名之后**只保留目标方块自己声明的属性**，其余的从它的默认状态继承——
 * 这比"照搬全部属性然后抛错"安全：`wooden_door[facing=north]` → `oak_door[facing=north]`
 * 会丢掉 1.14 不再存在的 `powered`，而不是整个导入失败。
 */
export function migrateState(
  registry: BlockRegistry,
  state: string,
  fromVersion?: number,
): MigrationOutcome {
  const parsed = parseStateString(state)
  if (parsed === undefined) {
    return { kind: 'unknown', from: state, suggestions: [] }
  }

  const direct = registry.blockByName(parsed.name)
  if (direct !== undefined) {
    return { kind: 'exact', state: canonicalize(direct, parsed.properties) }
  }

  const migration = MIGRATION_BY_NAME.get(parsed.name)
  if (migration !== undefined) {
    const target = registry.blockByName(migration.to)
    if (target !== undefined) {
      const outcome: MigrationOutcome = {
        kind: 'renamed',
        state: canonicalize(target, parsed.properties),
        from: parsed.name,
      }
      if (fromVersion !== undefined) outcome.fromVersion = fromVersion
      return outcome
    }
  }

  return { kind: 'unknown', from: parsed.name, suggestions: suggestNames(registry, parsed.name) }
}

/** 用目标方块自己的声明过滤属性，然后编码成规范串。 */
function canonicalize(block: NonNullable<ReturnType<BlockRegistry['blockByName']>>, properties: Properties): string {
  const declared = new Set(block.states.map((property) => property.name))
  const filtered: Properties = {}
  // 目标方块的**默认状态**：属性值对不上时从这里取。
  const defaults = stateIdToProperties(block, block.defaultState)
  for (const [key, value] of Object.entries(properties)) {
    if (!declared.has(key)) continue
    const coerced = coerce(block, key, value)
    if (coerced !== undefined) {
      filtered[key] = coerced
      continue
    }
    // `coerce` 说「目标方块不接受这个值」时，按它的注释应当**让它从默认状态继承**。
    // 「不传」在编码层表达不出来（`propertiesToStateId` 要一份完整的属性表），所以
    // 这里显式补上——但补的必须是**默认状态里的值**，不是声明表的第一项：楼梯的
    // `half` 声明表里 `top` 在前，而默认状态是 `bottom`，用前者会把楼梯整个翻个面。
    // 默认状态里没有这一项才退回声明表第一项（最后手段，只为让属性表完整）。
    const property = block.states.find((entry) => entry.name === key)
    const fallback = defaults[key] ?? (property === undefined ? undefined : propertyValueAt(property, 0))
    if (fallback !== undefined) filtered[key] = fallback
  }
  const stateId = propertiesToStateId(block, filtered)
  const full = stateIdToProperties(block, stateId)
  const keys = Object.keys(full).sort()
  if (keys.length === 0) return `minecraft:${block.name}`
  return `minecraft:${block.name}[${keys.map((k) => `${k}=${String(full[k])}`).join(',')}]`
}

/**
 * 把源属性值掰成目标属性接受的形式。
 *
 * 跨版本时同一个属性名可能换了取值域（`facing` 基本都是那六个，但
 * `half` 在门上是 `upper/lower`、在楼梯上是 `top/bottom`）。对不上就**不传**，
 * 让它从默认状态继承——这比塞一个非法值然后抛错好。
 *
 * 返回 `undefined` 就是「不传」那个信号。以前这个函数的返回类型表达不了它，
 * 于是枚举那一条只能写成 `allowed.has(v) ? v : v`——一个恒等式，注释许诺的行为
 * 从来没发生过：越域的值会一路走到 `propertiesToStateId` 抛 `StateError`，
 * 让整次导入失败。
 */
function coerce(
  block: NonNullable<ReturnType<BlockRegistry['blockByName']>>,
  key: string,
  value: PropertyValue,
): PropertyValue | undefined {
  const property = block.states.find((entry) => entry.name === key)
  if (property === undefined) return value
  if (property.type === 'bool') {
    if (typeof value === 'boolean') return value
    return String(value) === 'true'
  }
  if (property.type === 'int') {
    const numeric = typeof value === 'number' ? value : Number(value)
    // 不是数字就别传：塞下去 `propertiesToStateId` 会抛，整次导入跟着失败
    if (!Number.isFinite(numeric)) return undefined
    // 取值域可能不是 0..n-1（`oak_leaves.distance` 是 1..7），越界就夹到区间里
    const known = new Set<number>()
    for (let i = 0; i < property.num_values; i++) {
      const candidate = propertyValueAt(property, i)
      if (typeof candidate === 'number') known.add(candidate)
    }
    if (known.has(Math.trunc(numeric))) return Math.trunc(numeric)
    return Math.min(...known)
  }
  const allowed = new Set<string>()
  for (let i = 0; i < property.num_values; i++) allowed.add(String(propertyValueAt(property, i)))
  // 取值域对不上 → 不传（枚举没有「夹到区间里」这种说法，`int` 那条才有）
  return allowed.has(String(value)) ? value : undefined
}

/**
 * 名字对不上时给候选。与 `resolveBlock` 同一套启发式，但**不报错**——
 * 导入时遇到不认识的方块是常态，不该中断整次导入。
 */
export function suggestNames(registry: BlockRegistry, name: string): string[] {
  const bare = name.replace(/^minecraft:/, '').toLowerCase()
  const tokens = bare.split('_').filter((token) => token.length > 1)
  const scored: Array<{ name: string; score: number }> = []
  for (const candidate of registry.blockNames) {
    let score = 0
    if (candidate.includes(bare)) score = 100
    else if (bare.includes(candidate)) score = 90
    else if (tokens.length > 0) {
      const parts = candidate.split('_')
      const hits = tokens.filter((token) => parts.some((part) => part.includes(token))).length
      if (hits === tokens.length) score = 50 + hits
    }
    if (score > 0) scored.push({ name: candidate, score })
  }
  scored.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name))
  return scored.slice(0, 5).map((entry) => `minecraft:${entry.name}`)
}
