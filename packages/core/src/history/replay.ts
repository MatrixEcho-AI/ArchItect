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
 * 往前（revision 增大）是增量的，只补应用缺的 op；
 * 往后退才需要从头重建。配上 `base.mcvox` 快照与周期性 checkpoint 后，
 * 往后退也能从最近快照开始，而不是每次 O(n)。
 */
export class ReplaySession {
  private cursor: number

  constructor(
    /** 由本 session 驱动的世界。UI 直接渲染它。 */
    readonly store: WorldStore,
    readonly log: EditLog,
    /**
     * store 当前所处的版本。**默认取 `store.revision`**——
     * 刚从 `.mcai` 打开的世界已经重放到最新了，若这里从 0 开始，
     * `seek(3)` 会误判成"往前走"，在完整世界上再叠一遍（旧版本数据不会消失）。
     */
    startRevision: number = store.revision,
  ) {
    this.cursor = Math.max(0, Math.min(startRevision, log.length))
  }

  /** 当前已重放到的版本。 */
  get revision(): number {
    return this.cursor
  }

  /** 跳到目标版本。 */
  seek(revision: number): number {
    const target = clampRevision(revision, this.log.length)
    if (target < this.cursor) {
      this.store.clear()
      this.cursor = 0
    }
    while (this.cursor < target) {
      this.store.applyPatch(this.log.at(this.cursor)!.patch)
      this.cursor++
    }
    this.store.setRevision(this.cursor)
    return this.cursor
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
