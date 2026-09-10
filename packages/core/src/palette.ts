import type { BlockRegistry } from './registry.js'
import { parseState, stateIdToString } from './state.js'

export const AIR = 'minecraft:air'
export const AIR_STATE_ID = 0

/**
 * 双层调色板：**磁盘层（版本无关）与内存层（生态原生）之间的转换表**。
 *
 * - 磁盘层：`.mcai` 的 `palette.json` 存**规范状态字符串**的有序表；`base.mcvox` 每格存本地索引。
 *   这一层跨 Minecraft 版本可迁移——同一个字符串在 1.16 和 1.21 都指向同一个方块。
 * - 内存层：`prismarine-chunk` 的 `ChunkColumn` 每格存**全局 stateId**（uint16）。
 *   这一层与渲染 / 导出 / 协议零转换，但**版本相关**。
 *
 * `toGlobalStateIds()` 生成的查表就是两者之间的桥，打开项目时构建一次。
 */
export class Palette {
  private readonly entries: string[] = [AIR]
  private readonly byString = new Map<string, number>([[AIR, 0]])
  private globalCache: Uint16Array | undefined

  constructor(private readonly registry: BlockRegistry) {}

  get size(): number {
    return this.entries.length
  }

  /** 有序的规范状态字符串表，直接对应 `palette.json` 的 `entries`。 */
  strings(): readonly string[] {
    return this.entries
  }

  /** 本地索引 → 规范状态字符串。 */
  stateString(index: number): string {
    const value = this.entries[index]
    if (value === undefined) throw new RangeError(`Palette index ${index} out of range (size=${this.entries.length})`)
    return value
  }

  /**
   * 规范状态字符串 → 本地索引。不存在则追加。
   *
   * 入参会先 `parseState` 规范化，所以传 `oak_stairs[facing=east]` 和
   * `minecraft:oak_stairs[facing=north,half=bottom,shape=straight,waterlogged=false,facing=east]`
   * 这类等价写法会落到同一个索引上。
   */
  indexOf(stateString: string): number {
    const parsed = parseState(this.registry, stateString)
    return this.indexOfCanonical(parsed.canonical)
  }

  /** 已规范化的字符串 → 本地索引。热路径用，跳过解析。 */
  indexOfCanonical(canonical: string): number {
    const existing = this.byString.get(canonical)
    if (existing !== undefined) return existing
    const index = this.entries.length
    this.entries.push(canonical)
    this.byString.set(canonical, index)
    this.globalCache = undefined
    return index
  }

  /** 本地索引 → 全局 stateId 的查表（uint16）。构建一次后缓存。 */
  toGlobalStateIds(): Uint16Array {
    if (this.globalCache !== undefined) return this.globalCache
    const table = new Uint16Array(this.entries.length)
    for (let i = 0; i < this.entries.length; i++) {
      const { stateId } = parseState(this.registry, this.entries[i]!)
      if (stateId > 0xffff) {
        throw new RangeError(
          `${this.entries[i]} has stateId ${stateId} beyond uint16 — this version's state space overflows the one-cell storage assumption`,
        )
      }
      table[i] = stateId
    }
    this.globalCache = table
    return table
  }

  /** 由一组全局 stateId 反向构建调色板（导入 / 从 ChunkColumn 提取时用）。 */
  static fromGlobalStateIds(registry: BlockRegistry, stateIds: Iterable<number>): Palette {
    const palette = new Palette(registry)
    for (const stateId of stateIds) {
      const block = registry.blockByStateId(stateId)
      if (block === undefined) throw new RangeError(`Unknown stateId ${stateId} (version ${registry.minecraftVersion})`)
      palette.indexOfCanonical(stateIdToString(block, stateId))
    }
    return palette
  }

  /** 序列化为 `palette.json` 的负载。 */
  toJSON(): { minecraftVersion: string; entries: string[] } {
    return { minecraftVersion: this.registry.minecraftVersion, entries: [...this.entries] }
  }

  /** 从 `palette.json` 的负载恢复。字符串会重新规范化，兼容手改过的文件。 */
  static fromJSON(registry: BlockRegistry, payload: { entries: readonly string[] }): Palette {
    const palette = new Palette(registry)
    for (const entry of payload.entries) palette.indexOf(entry)
    return palette
  }
}
