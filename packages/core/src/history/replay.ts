import type { WorldStore } from '../world/store.js'
import type { EditLog } from './log.js'

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
    store.applyPatch(log.at(i)!.patch)
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

  /** 跳到目标版本。 */
  seek(revision: number): number {
    const target = clampRevision(revision, this.log.length)
    if (target < this.store.revision) {
      // 往后退只能从头重建：op 是"结果"而不是"逆操作"，没有便宜的退路
      this.store.clear()
    }
    while (this.store.revision < target) {
      this.store.applyPatch(this.log.at(this.store.revision)!.patch)
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
