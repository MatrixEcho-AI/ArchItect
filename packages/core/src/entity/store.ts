import type { Hash } from 'node:crypto'

import type { Bounds, Pos } from '../types.js'
import { posKey } from '../types.js'
import { canonicalJson } from './canonical.js'
import { cellOf } from './types.js'
import type { EntityChange, PlacedEntity } from './types.js'

/**
 * 实体数量的硬上限。
 *
 * 实体类型不设白名单（plan D-83），所以约束只能落在别处：类型串走注册表校验、
 * `data` 走封闭 schema、**数量走这个上限**。没有它的话，一个跑歪的循环
 * （模型自己写的 loop、或者 `run_batch` 的组合）能在内存和 `.mcai` 里堆出任意多对象，
 * 而 `ChangeSet` 那条"上百万格"的防线在这里不成立——实体不是格网。
 */
export const MAX_ENTITIES = 4096

/**
 * 实体层：世界里的稀疏对象，键是 id，一格可以叠任意多个。
 *
 * 与 `WorldStore` 的关系是并列的（`WorldStore.entities` 持有它），不是从属的：
 * 方块层是稠密格网 + palette，这里是稀疏 map + 位置索引。唯一的交汇点是
 * `contentHash()` 与"三层同时应用一个 op"（见 `history/replay.ts`）。
 *
 * **位置索引是近似查询用的**，不是真相：`at(pos)` 按 `floor` 取格，所以
 * 悬在格边界上的实体只会出现在一格的结果里。它是 `remove_entity` 的区域选择
 * 与 `slice` 的标注要用的东西，不作为不变式。
 */
export class EntityStore {
  private readonly byId = new Map<string, PlacedEntity>()
  /** 格键 → 该格里的实体 id。**只增不减地记格键，但格内集合是精确的。** */
  private readonly byCell = new Map<string, Set<string>>()
  /** `allocateId` 的游标：只服务于**正在写的这一笔**，不参与事件溯源。 */
  private allocationRevision = -1
  private allocationSeq = 0

  get size(): number {
    return this.byId.size
  }

  /**
   * 分配一个新 id：`e_<revision>_<n>`。
   *
   * `n` 在同一 revision 内递增，revision 一变就重置。截断分叉之后重新写同一个
   * revision 时号会重叠，所以这里跳过已存在的 id——重放不变式（D-58 的
   * `worldRevision` 校验）本来就该保证那种情况不会发生，但这条保险很便宜，
   * 而 id 撞车的后果（两个不同的东西共用一个身份）很难查。
   */
  allocateId(revision: number): string {
    if (revision !== this.allocationRevision) {
      this.allocationRevision = revision
      this.allocationSeq = 0
    }
    let id: string
    do {
      id = `e_${revision}_${++this.allocationSeq}`
    } while (this.byId.has(id))
    return id
  }

  get(id: string): PlacedEntity | undefined {
    return this.byId.get(id)
  }

  /** 全部实体，**按 id 排序**（`contentHash` 与 `.mcai` 往返都依赖这个顺序确定）。 */
  list(): readonly PlacedEntity[] {
    return [...this.byId.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  }

  /** 落在这一格里的实体（按 id 排序）。 */
  at(pos: Pos): readonly PlacedEntity[] {
    const ids = this.byCell.get(posKey(pos))
    if (ids === undefined || ids.size === 0) return []
    return [...ids]
      .map((id) => this.byId.get(id))
      .filter((entity): entity is PlacedEntity => entity !== undefined)
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  }

  /**
   * 落在这个闭区间里的实体（按 id 排序）。
   *
   * 判据是**所在的格**在区间内，与 `at()` 同一个口径——区域选择（`remove_entity`
   * 的区域形态）必须与按格查询给出同样的答案，否则"我在这一格上看得见它，
   * 却删不掉它"。
   */
  inBounds(bounds: Bounds): readonly PlacedEntity[] {
    const { min, max } = bounds
    return this.list().filter((entity) => {
      const cell = cellOf(entity)
      return (
        cell.x >= min.x && cell.x <= max.x &&
        cell.y >= min.y && cell.y <= max.y &&
        cell.z >= min.z && cell.z <= max.z
      )
    })
  }

  /**
   * 放入或整体替换一个实体。返回**实际发生的变更**；没有变化时返回 `undefined`
   * （与 `writeBlocks` 对"空操作不递增 revision"的态度一致）。
   */
  set(entity: PlacedEntity): EntityChange | undefined {
    const before = this.byId.get(entity.id)
    if (before !== undefined && canonicalJson(before) === canonicalJson(entity)) return undefined
    if (before === undefined) this.assertCapacity(1)
    this.put(entity)
    return { key: entity.id, before, after: entity }
  }

  /** 删除一个实体。不存在时返回 `undefined`。 */
  remove(id: string): EntityChange | undefined {
    const before = this.byId.get(id)
    if (before === undefined) return undefined
    this.drop(id, before)
    return { key: id, before }
  }

  /** 删除落在某个区域里的全部实体（`remove_entity` 的区域形态）。 */
  removeInBounds(bounds: Bounds): EntityChange[] {
    return this.inBounds(bounds).map((entity) => this.remove(entity.id)!)
  }

  /**
   * 把一串差分应用上去。**这是 replay / 打开工程的路径**，纯机械：
   * `after` 缺席就是删除，否则整体置为 `after`——不去推导、不去重新分配 id。
   *
   * 正因为是纯机械的，它必须校验 key 与 `after.id` 一致：差分里两者不一致意味着
   * 日志本身坏了，而坏掉的后果是"某个实体在被删除时删错了对象"，
   * 那是一个会一路安静地传播到导出文件的错误。
   */
  applyChanges(changes: Iterable<EntityChange>): void {
    for (const change of changes) {
      const { after } = change
      if (after === undefined) {
        const before = this.byId.get(change.key)
        if (before !== undefined) this.drop(change.key, before)
        continue
      }
      if (after.id !== change.key) {
        throw new RangeError(
          `Entity change key ${change.key} does not match after.id ${after.id} (the change set is inconsistent)`,
        )
      }
      const before = this.byId.get(change.key)
      if (before === undefined) this.assertCapacity(1)
      this.put(after)
    }
  }

  clear(): void {
    this.byId.clear()
    this.byCell.clear()
    this.allocationRevision = -1
    this.allocationSeq = 0
  }

  /**
   * 把内容喂给一个哈希。**顺序必须是确定的**，否则 `verifyReplay`
   * 会把"同一份数据的不同遍历顺序"报成"世界不一样了"。
   *
   * 前缀 `entity:` 让这一段的字节不会与方块层的任何一段重合。
   */
  hashInto(hash: Hash): void {
    for (const entity of this.list()) {
      hash.update(`entity:${entity.id}\n`)
      hash.update(canonicalJson(entity))
      hash.update('\n')
    }
  }

  toJSON(): PlacedEntity[] {
    return [...this.list()]
  }

  /** 从一份完整列表恢复（清空当前内容）。打开工程时用。 */
  fromJSON(entities: Iterable<PlacedEntity>): void {
    this.clear()
    const list = [...entities]
    this.assertCapacity(list.length)
    for (const entity of list) {
      if (typeof entity?.id !== 'string' || entity.id.length === 0) {
        throw new RangeError('Entity record has no id')
      }
      this.put(entity)
    }
  }

  private put(entity: PlacedEntity): void {
    const before = this.byId.get(entity.id)
    if (before !== undefined) {
      // 位置变了就把旧格的索引摘掉，否则 `at()` 会在旧地址上一直"看得见"它
      const oldCell = posKey(cellOf(before))
      const newCell = posKey(cellOf(entity))
      if (oldCell !== newCell) this.unindex(oldCell, entity.id)
    }
    this.byId.set(entity.id, entity)
    this.index(posKey(cellOf(entity)), entity.id)
  }

  private drop(id: string, entity: PlacedEntity): void {
    this.byId.delete(id)
    this.unindex(posKey(cellOf(entity)), id)
  }

  private index(cell: string, id: string): void {
    let ids = this.byCell.get(cell)
    if (ids === undefined) {
      ids = new Set()
      this.byCell.set(cell, ids)
    }
    ids.add(id)
  }

  private unindex(cell: string, id: string): void {
    const ids = this.byCell.get(cell)
    if (ids === undefined) return
    ids.delete(id)
    if (ids.size === 0) this.byCell.delete(cell)
  }

  private assertCapacity(adding: number): void {
    if (this.byId.size + adding > MAX_ENTITIES) {
      throw new RangeError(
        `EntityStore would hold ${this.byId.size + adding} entities, over the ${MAX_ENTITIES} limit`,
      )
    }
  }
}
