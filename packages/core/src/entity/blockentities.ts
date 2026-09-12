import type { Hash } from 'node:crypto'

import type { Pos } from '../types.js'
import { canonicalJson } from './canonical.js'
import { blockEntityKey, cellKey } from './types.js'
import type { BlockEntityChange, PlacedBlockEntity } from './types.js'

/**
 * 方块实体数量的硬上限。
 *
 * 方块实体是**一格最多一个**，所以这个数字就是"最多有多少格挂着附加数据"。
 * 与实体的 4096 不是一个量级（那个是对象，这个是格子上的注解），但也得有个头：
 * 世界没有可写边界（D-10），没有上限的话一份构造出来的 `.mcai` 能让打开
 * 这件事本身变成 OOM。
 */
export const MAX_BLOCK_ENTITIES = 65536

/**
 * 方块实体层：世界里的稀疏注解，键是位置，一格最多一个。
 *
 * **它是寄生的。** 方块被换成不带方块实体的类型，它就随之消失——而这件事
 * 不由这个类自己判断，是 `WorldStore.writeBlocks` 在写方块时顺手剪掉的
 * （plan D-81：只有那里同时知道"哪个格子被改了"和"这个格子上原本挂着什么"）。
 * 这个类只负责存取与差分，不负责决定谁该消失。
 */
export class BlockEntityStore {
  private readonly byPos = new Map<string, PlacedBlockEntity>()

  get size(): number {
    return this.byPos.size
  }

  at(pos: Pos): PlacedBlockEntity | undefined {
    return this.byPos.get(blockEntityKey(pos))
  }

  has(pos: Pos): boolean {
    return this.byPos.has(blockEntityKey(pos))
  }

  /**
   * 全部方块实体，**按 y → z → x 的数值序**。
   *
   * 排序是给哈希用的（同一份数据必须每次遍历出同样的字节序列），
   * 所以只要**确定**就够了。这里选数值序而不是键的字典序，是因为字典序会把
   * `10,0,0` 排在 `2,0,0` 前面——那对哈希没影响，但界面上一眼就看得出别扭。
   */
  list(): readonly PlacedBlockEntity[] {
    return [...this.byPos.values()].sort((a, b) => a.y - b.y || a.z - b.z || a.x - b.x)
  }

  /** 放入或整体替换。没有变化时返回 `undefined`。 */
  set(entity: PlacedBlockEntity): BlockEntityChange | undefined {
    const key = blockEntityKey(entity)
    const before = this.byPos.get(key)
    if (before !== undefined && canonicalJson(before) === canonicalJson(entity)) return undefined
    if (before === undefined) this.assertCapacity(1)
    this.byPos.set(key, entity)
    return { key, before, after: entity }
  }

  /** 按坐标删除（不给 `Pos` 对象，见 `cellKey` 的说明）。 */
  removeAt(x: number, y: number, z: number): BlockEntityChange | undefined {
    const key = cellKey(x, y, z)
    const before = this.byPos.get(key)
    if (before === undefined) return undefined
    this.byPos.delete(key)
    return { key, before }
  }

  remove(pos: Pos): BlockEntityChange | undefined {
    return this.removeAt(pos.x, pos.y, pos.z)
  }

  /**
   * 把一串差分应用上去。与 `EntityStore.applyChanges` 同样纯机械：
   * `after` 缺席就是删除，否则整体置为 `after`。
   */
  applyChanges(changes: Iterable<BlockEntityChange>): void {
    for (const change of changes) {
      const { after } = change
      if (after === undefined) {
        this.byPos.delete(change.key)
        continue
      }
      const key = blockEntityKey(after)
      if (key !== change.key) {
        throw new RangeError(
          `Block entity change key ${change.key} does not match after position ${key} (the change set is inconsistent)`,
        )
      }
      if (!this.byPos.has(key)) this.assertCapacity(1)
      this.byPos.set(key, after)
    }
  }

  clear(): void {
    this.byPos.clear()
  }

  /** 前缀 `blockentity:` 让这一段的字节不会与方块层、实体层的任何一段重合。 */
  hashInto(hash: Hash): void {
    for (const entity of this.list()) {
      hash.update(`blockentity:${blockEntityKey(entity)}\n`)
      hash.update(canonicalJson(entity))
      hash.update('\n')
    }
  }

  toJSON(): PlacedBlockEntity[] {
    return [...this.list()]
  }

  /** 从一份完整列表恢复（清空当前内容）。打开工程时用。 */
  fromJSON(entities: Iterable<PlacedBlockEntity>): void {
    this.clear()
    const list = [...entities]
    this.assertCapacity(list.length)
    for (const entity of list) {
      if (typeof entity?.kind !== 'string' || entity.kind.length === 0) {
        throw new RangeError(`Block entity at ${blockEntityKey(entity)} has no kind`)
      }
      this.byPos.set(blockEntityKey(entity), entity)
    }
  }

  private assertCapacity(adding: number): void {
    if (this.byPos.size + adding > MAX_BLOCK_ENTITIES) {
      throw new RangeError(
        `BlockEntityStore would hold ${this.byPos.size + adding} entries, over the ${MAX_BLOCK_ENTITIES} limit`,
      )
    }
  }
}
