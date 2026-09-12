import minecraftData from 'minecraft-data'

/**
 * 实体类型注册表。
 *
 * **实体不设白名单**（plan D-83）：类型空间由 Minecraft 版本决定，不由我们挑选。
 * 但 D8 那条"把约束放在工具层、不放在 prompt 里求 LLM 自觉"依然成立，所以补上的是
 * 另外三条——**只认这个版本真的有的类型**（这里）、`data` 必须能变成 NBT、
 * 以及数量上限。三者里只有第一条需要一张表。
 *
 * 数据来自 `minecraft-data` 的 `entitiesByName`（1.21.4 有 149 项），与方块注册表
 * 同一个来源，但**刻意不塞进 `BlockRegistry`**：那个接口的名字与语义都是方块的，
 * 把实体塞进去会让两边都开始撒谎。
 */
export interface EntityRegistry {
  readonly minecraftVersion: string
  /** 该版本全部实体类型，**规范串**（带 `minecraft:` 前缀），已排序。 */
  readonly names: readonly string[]
  readonly count: number
  has(name: string): boolean
  /**
   * 认不出时的候选（先按名字长度、再按字母序——与 `search_blocks` 同一个口径：
   * 短的在前，因为 LLM 打错的通常是一个短名的变体）。
   */
  suggest(name: string, limit?: number): string[]
  /** 碰撞盒尺寸 `[宽, 高]`（格）。渲染的兜底盒与将来的 linter 用。 */
  sizeOf(name: string): { width: number; height: number } | undefined
}

/** `minecraft-data` 的实体记录（上游没有类型声明）。 */
interface RawEntity {
  name: string
  width?: number
  height?: number
}

interface RawData {
  entitiesByName?: Record<string, RawEntity>
}

const cache = new Map<string, EntityRegistry>()

/** 归一化：文件的两种写法（带不带命名空间）落到同一个键上。 */
export function normalizeEntityName(name: string): string {
  const trimmed = name.trim()
  return trimmed.includes(':') ? trimmed : `minecraft:${trimmed}`
}

/** 载入某版本的实体注册表。与 `loadRegistry` 一样按版本缓存。 */
export function loadEntityRegistry(minecraftVersion: string): EntityRegistry {
  const cached = cache.get(minecraftVersion)
  if (cached !== undefined) return cached

  const data = minecraftData(minecraftVersion) as unknown as RawData
  const byName = new Map<string, RawEntity>()
  for (const [key, entity] of Object.entries(data.entitiesByName ?? {})) {
    byName.set(normalizeEntityName(entity.name ?? key), entity)
  }
  const names = [...byName.keys()].sort()

  const registry: EntityRegistry = {
    minecraftVersion,
    names,
    count: names.length,
    has(name) {
      return byName.has(normalizeEntityName(name))
    },
    suggest(name, limit = 5) {
      const wanted = normalizeEntityName(name).slice('minecraft:'.length)
      const parts = wanted.split('_').filter((part) => part.length > 0)
      const scored: Array<{ name: string; score: number }> = []
      for (const candidate of names) {
        const short = candidate.slice('minecraft:'.length)
        let score = 0
        if (short === wanted) score = 3
        else if (short.includes(wanted) || (wanted.length > 2 && wanted.includes(short))) score = 2
        else if (parts.some((part) => part.length > 2 && short.includes(part))) score = 1
        if (score > 0) scored.push({ name: candidate, score })
      }
      return scored
        .sort((a, b) => b.score - a.score || a.name.length - b.name.length || a.name.localeCompare(b.name))
        .slice(0, limit)
        .map((entry) => entry.name)
    },
    sizeOf(name) {
      const entity = byName.get(normalizeEntityName(name))
      if (entity === undefined) return undefined
      return { width: entity.width ?? 0.6, height: entity.height ?? 1.8 }
    },
  }

  cache.set(minecraftVersion, registry)
  return registry
}
