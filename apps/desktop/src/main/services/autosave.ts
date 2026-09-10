import { existsSync } from 'node:fs'
import { join } from 'node:path'

import type { EditLog, EditOp } from '@architect/core'
import { pendingOps, WriteAheadLog } from '@architect/mcai'
import type { WalHeader } from '@architect/mcai'

/**
 * 自动保存 / 崩溃恢复。
 *
 * ## 为什么是 WAL 而不是"每隔几秒存一遍整个工程"
 *
 * 全量快照是 O(工区)：64³ 就是 50 万格，`dumpColumns` + zlib 每次几十毫秒，
 * 而工区**没有尺寸上限**（D-10）——256³ 会变成几十 MB 的重复写盘。
 * 而一次编辑真正新增的信息量是**一个 op**（几十到几百字节）。
 *
 * 所以这里只做一件事：把**新产生的 op**追加到一个小文件里。
 * 崩溃后拿"上次保存的工程 + WAL 里多出来的 op"就能恢复到崩溃前的状态。
 * 没保存过也不怕：基准是空世界，WAL 里的全部 op 一样能重建。
 *
 * ## 与保存的关系
 *
 * 保存成功后 `onSaved()` 会把基准推进到最新（WAL 清空、表头记住新的 revision）。
 * 所以 WAL 里的内容**永远只有"上次保存之后"的那一段**，长度与保存频率成正比，
 * 与工区大小无关。
 */
export interface AutosaveOptions {
  /** WAL 存放目录（桌面端是 `userData/autosave/`）。 */
  dir: string
  projectId: string
  name: string
  projectPath?: string
  /** 注入时钟。 */
  now?: () => string
}

export interface PendingRecovery {
  header: WalHeader
  ops: EditOp[]
  /** 基准工程还在不在。不在的话只能"没有基准地恢复"（从空世界重放全部 op）。 */
  baseExists: boolean
}

export class AutosaveService {
  private wal: WriteAheadLog
  private readonly dir: string
  private readonly projectId: string
  private readonly now: () => string
  /** 已经记进 WAL 的 op 条数（按 `EditLog` 里的下标算）。 */
  private journaled = 0
  private projectPath: string | undefined

  constructor(options: AutosaveOptions) {
    this.dir = options.dir
    this.projectId = options.projectId
    this.now = options.now ?? (() => new Date().toISOString())
    this.projectPath = options.projectPath
    this.wal = this.openWal(0, options.name, options.projectPath)
  }

  private openWal(baseRevision: number, name: string, projectPath: string | undefined): WriteAheadLog {
    return new WriteAheadLog({
      file: join(this.dir, `${this.projectId}.wal`),
      header: {
        baseRevision,
        projectId: this.projectId,
        name,
        startedAt: this.now(),
        ...(projectPath !== undefined ? { projectPath } : {}),
      },
    })
  }

  get file(): string {
    return this.wal.path
  }

  get journaledCount(): number {
    return this.journaled
  }

  /**
   * 把日志里**还没记过**的 op 追加进 WAL。
   *
   * 靠下标去重而不是靠 rev：`EditLog` 是只追加的，所以"上次记到第几条"
   * 是一个可靠的游标。返回这一次实际追加的条数。
   */
  journal(log: EditLog): number {
    const all = log.all()
    if (all.length <= this.journaled) return 0
    const fresh = all.slice(this.journaled)
    this.wal.appendAll(fresh)
    this.journaled = all.length
    return fresh.length
  }

  /** 保存成功后调用：基准推进、WAL 清空。 */
  onSaved(revision: number, projectPath?: string, journaled?: number): void {
    if (projectPath !== undefined) this.projectPath = projectPath
    this.wal.reset(revision, this.projectPath)
    // 保存时世界与日志是一起写的，所以游标直接对齐到当前长度
    this.journaled = journaled ?? this.journaled
  }

  /** 打开另一个工程 / 新建工程时切换目标。 */
  retarget(projectId: string, name: string, projectPath?: string): void {
    this.wal = this.openWal(0, name, projectPath)
    this.journaled = 0
    void projectId
  }

  /** 有没有可恢复的内容。没有基准、也没有 op 时返回 `undefined`。 */
  pending(): PendingRecovery | undefined {
    const contents = this.wal.read()
    if (contents === undefined) return undefined
    const ops = pendingOps(contents)
    if (ops.length === 0) return undefined
    return {
      header: contents.header,
      ops,
      baseExists: contents.header.projectPath !== undefined && existsSync(contents.header.projectPath),
    }
  }

  /** 恢复完成 / 用户拒绝之后清空。 */
  clear(revision: number): void {
    this.wal.reset(revision, this.projectPath)
    this.journaled = 0
  }

  /** 用户明确说"不要这份草稿"。 */
  discard(): void {
    this.wal.discard()
    this.journaled = 0
  }
}
