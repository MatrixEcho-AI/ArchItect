import { invertChanges } from '../entity/types.js'
import type { WorldStore } from '../world/store.js'
import type { EditOp } from './editop.js'
import type { EditLog } from './log.js'

/**
 * 把一条 op **正向**应用到一个世界上——三层一起（plan §18.2）。
 *
 * 为什么三层要在一个函数里：一次工具调用的净效果就是一条 op，而 op 的语义是
 * "这个版本相对上一个版本变了什么"。分开应用的话，调用方迟早会在某个分支上
 * 只应用其中的一两层，而那种偏差的表现是"重放之后世界看起来差不多"——
 * 差的是几个对象，不是一堵墙。`verifyReplay` 会因此报一个没有指向的失败。
 *
 * 顺序：方块 → 方块实体 → 实体。方块实体那一段是**剪除**差分（方块被写掉，
 * 挂在它上面的东西随之消失），所以它天然跟在方块之后；记录时也是这个顺序。
 * `applyPatch` 刻意**不做**剪除——重放要照着记录应用，而不是重新推导一遍，
 * 否则"当时为什么少了这条"就取决于当下的代码而不是当时的日志。
 */
export function applyOp(store: WorldStore, op: EditOp): void {
  store.applyPatch(op.patch)
  if (op.blockEntityChanges !== undefined) store.blockEntities.applyChanges(op.blockEntityChanges)
  if (op.entityChanges !== undefined) store.entities.applyChanges(op.entityChanges)
}

/**
 * 把一条 op **反向**应用（撤销）。
 *
 * 与 `applyOp` 严格互逆：差分的 `before`/`after` 一交换，同一个 `applyChanges`
 * 就把世界放回上一个版本——**撤销不需要任何额外的记账**，这是选
 * `{key, before, after}` 这个形状换来的（plan D-79）。
 *
 * 顺序取正向的**逆序**。这一层现在没有实际影响（三层的应用都是纯赋值，
 * `applyPatch` 也不剪除），但它是"逆操作按逆序做"这条更基本的规矩，
 * 将来某一层开始互相依赖时不会突然出错。
 */
export function applyOpInverted(store: WorldStore, op: EditOp): void {
  if (op.entityChanges !== undefined) store.entities.applyChanges(invertChanges(op.entityChanges))
  if (op.blockEntityChanges !== undefined) {
    store.blockEntities.applyChanges(invertChanges(op.blockEntityChanges))
  }
  store.applyPatch(op.patch.inverted())
}

/**
 * 把 op 流从零重放进 store（会先清空）。
 *
 * @param revision 目标版本（含）。省略则重放到最新。
 * @returns 实际到达的版本号
 */
export function replayTo(store: WorldStore, log: EditLog, revision?: number): number {
  const target = clampRevision(revision ?? log.length, log.length)
  store.clear()
  for (let i = 0; i < target; i++) {
    applyOp(store, log.at(i)!)
  }
  store.setRevision(target)
  return target
}

/**
 * 时间线引擎：在 op 流上来回移动。
 *
 * **游标就是 `store.revision`**，这个类不另存一份（早期存过，代价见 `get revision`）。
 *
 * 往前（revision 增大）是增量的，只补应用缺的 op；
 * 往后退才需要从头重建。配上 `base.mcvox` 快照与周期性 checkpoint 后，
 * 往后退也能从最近快照开始，而不是每次 O(n)。
 */
export class ReplaySession {
  constructor(
    /** 由本 session 驱动的世界。UI 直接渲染它。 */
    readonly store: WorldStore,
    readonly log: EditLog,
  ) {}

  /**
   * 当前已重放到的版本。
   *
   * **直接读 `store.revision`，不另存一份游标**。早期这里有第二个 `cursor` 字段，
   * 后果是"世界上明明写着 rev 7、游标还停在 3"这类双真相：撤销、时间旅行、
   * 撤销之后再编辑，各自改动一份，谁都不知道对方干了什么。
   * 现在**游标只有一个**，就在世界上（`store.revision`）。
   */
  get revision(): number {
    return this.store.revision
  }

  /** op 流的总长度。游标的上界。 */
  get length(): number {
    return this.log.length
  }

  /** 游标在最新版本上（没有"未来"可以被丢弃）。 */
  get atTip(): boolean {
    return this.store.revision >= this.log.length
  }

  get canUndo(): boolean {
    return this.store.revision > 0
  }

  get canRedo(): boolean {
    return this.store.revision < this.log.length
  }

  /**
   * **撤销 = 游标退一格**（plan §6）。
   *
   * 不产生新 op、不动日志：往后移动靠重放。往回是 O(n) 的全量重建
   * （`.mcai` 里的 checkpoint 是将来把这一步变成 O(1) 的地方）。
   */
  undo(): number {
    return this.seek(this.store.revision - 1)
  }

  /** **重做 = 游标进一格**。 */
  redo(): number {
    return this.seek(this.store.revision + 1)
  }

  /**
   * 跳到目标版本。
   *
   * **往后退逐条反向应用**（`ChangeSet.inverted()` + 两个稀疏层的反演），
   * 不是"清空再从头放一遍"。两者在"rev 0 就是空世界"时结果一样，
   * 但只要有**基准内容，rev 0 就不是空的**：
   *
   * - 导入的工程（`.schem` / `.litematic`）：rev 0 = 导入进来的内容；
   * - 从导入的工程存出来的 `.mcai`：快照里有内容，而游标可以从 0 开始。
   *
   * 用 `clear()` 的话，用户"撤销到最开始"会把导进来的东西**整栋删掉**——
   * 那是数据丢失，不是撤销。反向应用只碰被改动过的格子，顺带还更快
   * （不必把整个 op 流从头放一遍）。
   */
  seek(revision: number): number {
    const target = clampRevision(revision, this.log.length)
    while (this.store.revision > target) {
      applyOpInverted(this.store, this.log.at(this.store.revision - 1)!)
      this.store.setRevision(this.store.revision - 1)
    }
    while (this.store.revision < target) {
      applyOp(this.store, this.log.at(this.store.revision)!)
      this.store.setRevision(this.store.revision + 1)
    }
    this.store.setRevision(target)
    return target
  }

  /** 回到最新。 */
  seekLatest(): number {
    return this.seek(this.log.length)
  }
}

/**
 * 校验重放不变式：**增量构建的结果必须与 replay 的结果逐格相等**。
 *
 * 这是 M2 最重要的一条断言，由测试与"打开项目时的自检"共用。
 *
 * 比较的是 `contentHash()`，而它覆盖三层（D-86）——所以这条断言同时管住了
 * "实体有没有进日志"：漏记一条实体 op 的话，重放出来的世界会比活的那个少几个对象，
 * 哈希立刻不等。早先三种比较（非空、尺寸、方块计数）对这种情况一律放行。
 */
export function verifyReplay(
  live: WorldStore,
  log: EditLog,
  rebuild: WorldStore,
): { ok: boolean; liveHash: string; replayedHash: string; revision: number } {
  const revision = replayTo(rebuild, log)
  const liveHash = live.contentHash()
  const replayedHash = rebuild.contentHash()
  return { ok: liveHash === replayedHash, liveHash, replayedHash, revision }
}

function clampRevision(revision: number, max: number): number {
  if (!Number.isFinite(revision)) return max
  return Math.max(0, Math.min(Math.floor(revision), max))
}
