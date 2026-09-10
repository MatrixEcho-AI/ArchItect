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
 *
 * ## 为什么"记到第几条"要用下标 + 内容双重判据
 *
 * 下标（`journaled`）足够应付"只追加"的常态，但**编辑日志并不是只追加的**：
 * 用户在时间线上退回去继续改，`EditLog.record` 会把后面几条**截断丢掉**，
 * 新的 op 会顶替它们的编号。此时"日志长度"可能回到原来那个数，而下标判据
 * 会以为"没有新东西"——于是最新的一步没进 WAL，崩溃后就丢了。
 * 所以这里额外记住**写进 WAL 的那几条 op 本身**：每次 journal 都核对日志里
 * 那一段还是不是原样，不是就整卷重写（WAL 只能追加，改不了历史）。
 */
export interface AutosaveOptions {
  /** WAL 存放目录（桌面端是 `userData/autosave/`）。 */
  dir: string
  projectId: string
  name: string
  projectPath?: string
  /** 基准的**世界版本号**（刚打开的工程就是它的 `manifest.revision`）。 */
  baseRevision?: number
  /** 注入时钟。 */
  now?: () => string
}

export interface PendingRecovery {
  header: WalHeader
  ops: EditOp[]
  /** 基准工程还在不在。不在的话只能"没有基准地恢复"（从空世界重放全部 op）。 */
  baseExists: boolean
}

/**
 * 两条 op 是不是"同一个东西"。
 *
 * 比 `rev` + **编码后的 patch**，不比整个 op：`tool` / `source` / `ts` 变了对世界
 * 没有任何影响，而**内容**变了就说明日志那一段被换掉了（在历史版本上继续编辑），
 * 那时 WAL 里对应的那条已经不成立。
 *
 * 为什么不直接 `JSON.stringify(op.patch)`：`patch` 是个 `ChangeSet` 实例，
 * 同一个内容从磁盘读回来之后内部表示可能不同（列式 buffer vs 内存态），
 * 比序列化结果会在"根本没变"的时候报"变了"——于是每次自动保存都整卷重写。
 */
function sameOp(a: EditOp | undefined, b: EditOp): boolean {
  if (a === undefined || a.rev !== b.rev) return false
  return a.patch.toBuffer().equals(b.patch.toBuffer())
}

export class AutosaveService {
  private wal: WriteAheadLog
  private readonly dir: string
  private readonly projectId: string
  private readonly now: () => string
  /**
   * 当前这卷 WAL 的**基准世界版本号**。
   *
   * 它同时是两个东西的锚：`pendingOps` 用它筛出"基准之后"的 op，
   * 恢复时又用它算最终游标。所以它必须与**工程文件里那个 revision** 对齐，
   * 而不是"上次调用本类时的 log.length"。
   */
  private baseRevision = 0
  /** 已经写进 WAL 的那几条 op（基准之后的那一段），顺序与日志一致。 */
  private recorded: EditOp[] = []
  private projectPath: string | undefined

  constructor(options: AutosaveOptions) {
    this.dir = options.dir
    this.projectId = options.projectId
    this.now = options.now ?? (() => new Date().toISOString())
    this.projectPath = options.projectPath
    this.baseRevision = options.baseRevision ?? 0
    this.wal = this.openWal(this.baseRevision, options.name, options.projectPath)

    // **接管一个已经存在的草稿**：上一次进程留下的 WAL 还在盘上。
    // 不接管的话，接下来的 journal 会把那几条又写一遍，恢复时就会重放两遍
    // （多数方块操作恰好幂等，所以症状只是"有时候恢复出来的世界不对"）。
    const existing = this.wal.read()
    if (existing !== undefined) {
      this.baseRevision = existing.header.baseRevision
      this.recorded = pendingOps(existing)
      if (existing.header.projectPath !== undefined) this.projectPath = existing.header.projectPath
    }
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

  /** 已经记进 WAL 的 op 条数。 */
  get journaledCount(): number {
    return this.recorded.length
  }

  /** 这一卷 WAL 的基准世界版本号（= 工程文件里的 `revision`）。 */
  get baseRevisionValue(): number {
    return this.baseRevision
  }

  /**
   * 把日志里**基准之后**、还没记过的那几条 op 追加进 WAL，返回这次追加的条数。
   *
   * 判据是 **op 自己的 `rev`**（`rev > 基准`），不是"日志的第几条"。
   * 下标在这里会骗人：用户在时间线上退回去继续改时 `EditLog` 会**截断**日志，
   * 新的 op 顶替旧的编号，日志长度可能回到原来那个数——下标判据会以为
   * "没有新东西"，于是最新的一步根本没进 WAL，崩溃后就丢了。
   *
   * 已经写下的那几条还会**逐条核对内容**：日志里那一段被换掉过（撤销到保存点
   * 之后又改了别的）就整卷重写——WAL 只能追加，改不了历史。
   *
   * **它做不到的一件事（已知限制）**：退回到**保存点之前**再改。那时新 op 的编号
   * 落在基准里面，而基准已经是一个写好的文件了——要留住它只能再保存一次。
   * 这种情况下 `journal` 不会硬塞，而是把已经不成立的草稿清掉。
   */
  journal(log: EditLog): number {
    const all = log.all()
    const tail = all.filter((op) => op.rev > this.baseRevision)

    const intact =
      this.recorded.length === 0 ||
      (tail.length >= this.recorded.length &&
        this.recorded.every((op, index) => sameOp(tail[index], op)))

    if (!intact) {
      this.wal.reset(this.baseRevision, this.projectPath)
      this.recorded = []
    }

    const fresh = tail.slice(this.recorded.length)
    if (fresh.length === 0) return 0
    this.wal.appendAll(fresh)
    this.recorded.push(...fresh)
    return fresh.length
  }

  /** 保存成功后调用：基准推进、WAL 清空。 */
  onSaved(revision: number, projectPath?: string, journaled?: number): void {
    if (projectPath !== undefined) this.projectPath = projectPath
    this.baseRevision = revision
    this.wal.reset(revision, this.projectPath)
    this.recorded = []
    void journaled
  }

  /**
   * 打开另一个工程 / 新建工程时切换目标。
   *
   * `baseRevision` 必须是**刚打开的那个工程的世界版本号**。传 0 会让下一次恢复
   * 把工程文件里已有的 op 又重放一遍——这类 bug 的症状是"有时候恢复出来的世界
   * 不对"，所以这里不给默认值兜底。
   */
  retarget(projectId: string, name: string, projectPath: string | undefined, baseRevision: number): void {
    this.projectPath = projectPath
    this.baseRevision = baseRevision
    this.wal = this.openWal(baseRevision, name, projectPath)
    this.recorded = []
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

  /** 恢复完成之后清空：基准推到最新，草稿不再存在。 */
  clear(revision: number): void {
    this.baseRevision = revision
    this.wal.reset(revision, this.projectPath)
    this.recorded = []
  }

  /** 用户明确说"不要这份草稿"。 */
  discard(): void {
    this.wal.discard()
    // 卷没了，但基准还在：下次开写时把基准之后的 op 重新记一遍
    this.recorded = []
  }
}
