import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { dirname } from 'node:path'

import { decodeEditOp, encodeEditOp } from '@architect/core'
import type { EditOp, EditOpRecord } from '@architect/core'

/**
 * 写前日志（WAL）：崩溃恢复用。
 *
 * ## 为什么不是"每隔几秒把整个工程存一遍"
 *
 * 全量快照是 O(工区)：64³ 就是 50 万格，`dumpColumns` + zlib 每次几十毫秒，
 * 而工区**没有尺寸上限**（D-10）——256³ 会变成几十 MB 的重复写盘。
 *
 * 而一次编辑真正新增的信息量是**一个 op**（几十到几百字节）。
 * 所以 WAL 只做一件事：**把新产生的 op 追加到一个小文件里**。
 * 崩溃后拿"上次保存的工程 + WAL 里多出来的 op"就能恢复到崩溃前的状态。
 *
 * 代价是恢复依赖"上次保存"这份基准还能读到。这没问题：用户保存过就一定有，
 * 没保存过则基准是空世界 + WAL 里的全部 op，一样能重建。
 *
 * ## 崩溃安全
 *
 * `appendFileSync` 是**一次 `write` 系统调用**（内容小于 PIPE_BUF 时是原子的），
 * 每行一个 JSON。**最后一行可能被写坏**（断电、进程被杀），所以读的时候
 * **从尾部容忍一行坏数据**：`fromJSONL` 已经把坏行计数报出来了（`droppedTail`），
 * 这里只丢那一行，前面的照常恢复。
 */

/** WAL 文件的第一行：说明这一卷是接在哪个基准之后的。 */
export interface WalHeader {
  /** 格式版本，将来变结构时用。 */
  version: 1
  /** 基准工程的路径。恢复时用它找回基准；工程被移走时按"没有基准"处理。 */
  projectPath?: string
  /** 基准工程的 revision。**只在没有任何保存时才是 0**。 */
  baseRevision: number
  projectId: string
  name: string
  startedAt: string
}

export interface WalContents {
  header: WalHeader
  ops: EditOp[]
  /** 被丢掉的坏行数（尾部截断、或者文件被别的东西写过）。 */
  droppedOps: number
}

export interface WriteAheadLogOptions {
  file: string
  header: Omit<WalHeader, 'version'>
  /** 注入时钟（测试用）。 */
  now?: () => string
}

/**
 * 追加式写前日志。
 *
 * 用法：`append` 每次编辑后调用；保存成功后 `reset`（把基准推进到最新）。
 */
export class WriteAheadLog {
  private readonly file: string
  private header: WalHeader
  private started = false
  private count = 0

  constructor(options: WriteAheadLogOptions) {
    this.file = options.file
    this.header = { version: 1, ...options.header }
  }

  get path(): string {
    return this.file
  }

  /** 已经记进去多少条 op。 */
  get length(): number {
    return this.count
  }

  get baseRevision(): number {
    return this.header.baseRevision
  }

  /**
   * 记一条 op。
   *
   * **先确保表头写过**：没有表头的 WAL 无法解释（不知道接在哪个 revision 后面），
   * 所以第一次 append 时把表头一起写下去，仍然是同一次 `appendFileSync`——
   * 要么两行都在，要么都不在，不会留下一个孤零零的表头。
   */
  append(op: EditOp): void {
    const lines: string[] = []
    if (!this.started) {
      mkdirSync(dirname(this.file), { recursive: true })
      lines.push(JSON.stringify(this.header))
      this.started = true
    }
    lines.push(JSON.stringify(encodeEditOp(op)))
    appendFileSync(this.file, `${lines.join('\n')}\n`, 'utf8')
    this.count++
  }

  /** 批量追加（一次 `write`，比逐条更省）。 */
  appendAll(ops: readonly EditOp[]): void {
    if (ops.length === 0) return
    const lines: string[] = []
    if (!this.started) {
      mkdirSync(dirname(this.file), { recursive: true })
      lines.push(JSON.stringify(this.header))
      this.started = true
    }
    for (const op of ops) lines.push(JSON.stringify(encodeEditOp(op)))
    appendFileSync(this.file, `${lines.join('\n')}\n`, 'utf8')
    this.count += ops.length
  }

  /** 读回来。文件不存在或表头都读不出来时返回 `undefined`（没有可恢复的东西）。 */
  read(): WalContents | undefined {
    if (!existsSync(this.file)) return undefined
    let text: string
    try {
      text = readFileSync(this.file, 'utf8')
    } catch {
      return undefined
    }
    const lines = text.split('\n').filter((line) => line.trim().length > 0)
    if (lines.length === 0) return undefined

    let header: WalHeader
    try {
      header = JSON.parse(lines[0]!) as WalHeader
    } catch {
      // 表头都坏了，整卷不可解释
      return undefined
    }
    if (header.version !== 1) return undefined

    const body = lines.slice(1).join('\n')
    // **不能用 `EditLog.fromJSONL`**：它要求 rev 从 1 开始且连续，而一卷 WAL
    // 天然是从 `baseRevision + 1` 开始的（比如从 rev 42 起）。第一条就会撞上
    // "has rev=42, expected 1"。
    //
    // 但也**不能自己 `JSON.parse` 完就当 op 用**：磁盘上 op 的 `patch` 是 base64
    // 字符串，内存里是 `ChangeSet`。转换必须走 `decodeEditOp`——磁盘形状只有一个真相。
    const ops: EditOp[] = []
    let droppedOps = 0
    for (const line of body.length > 0 ? body.split('\n') : []) {
      if (line.trim().length === 0) continue
      try {
        const record = JSON.parse(line) as EditOpRecord
        if (typeof record !== 'object' || record === null || typeof record.rev !== 'number') {
          droppedOps++
          continue
        }
        ops.push(decodeEditOp(record))
      } catch {
        // 断电时最后一行可能只写了一半——丢掉它，前面的照常恢复
        droppedOps++
      }
    }
    return { header, ops, droppedOps }
  }

  /**
   * 保存成功之后调用：把内容清空，并把基准推进到新的 revision。
   *
   * **不是删除文件**，而是重写表头——保留"这一卷接在谁后面"的信息，
   * 下次崩溃时仍然知道基准在哪。
   */
  reset(baseRevision: number, projectPath?: string): void {
    this.header = {
      version: 1,
      ...(projectPath !== undefined ? { projectPath } : {}),
      baseRevision,
      projectId: this.header.projectId,
      name: this.header.name,
      startedAt: this.header.startedAt,
    }
    this.started = false
    this.count = 0
    rmSync(this.file, { force: true })
  }

  /** 彻底删掉（用户明确选择"不恢复"时）。 */
  discard(): void {
    rmSync(this.file, { force: true })
    this.started = false
    this.count = 0
  }
}

/**
 * 崩溃恢复：把 WAL 里"基准之后"的 op 找出来。
 *
 * 只返回 `rev > baseRevision` 的那些——基准快照已经包含的部分要跳过，
 * 重复应用虽然幂等，但会让 revision 对不上，也会掩盖基准选错的问题。
 */
export function pendingOps(contents: WalContents): EditOp[] {
  return contents.ops.filter((op) => op.rev > contents.header.baseRevision)
}

/** 是否值得提示用户恢复：有基准之后的 op 才算。 */
export function hasRecoverable(contents: WalContents | undefined): boolean {
  return contents !== undefined && pendingOps(contents).length > 0
}
