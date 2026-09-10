import { ChangeSet } from '../world/changeset.js'
import { makeOp } from './editop.js'
import type { EditOp, EditOpRecord, MakeOpOptions } from './editop.js'
import type { WriteResult } from '../world/store.js'

export class EditLogError extends Error {
  override readonly name = 'EditLogError'
}

/**
 * 追加式编辑事件日志 —— `.mcai` 里 `history/edits.jsonl` 的内存形态。
 *
 * **只追加，不修改**（plan §9.2 Regime A）：这条纪律同时服务于两个目的——
 * 事件溯源的正确性，以及让对话上下文的前缀缓存不被打破。
 */
export class EditLog {
  private readonly ops: EditOp[] = []

  get length(): number {
    return this.ops.length
  }

  /** 当前版本号 = op 数量。 */
  get revision(): number {
    return this.ops.length
  }

  append(op: EditOp): void {
    if (op.rev !== this.ops.length + 1) {
      throw new EditLogError(`op #${op.id} has rev=${op.rev}, expected ${this.ops.length + 1}`)
    }
    this.ops.push(op)
  }

  /** 由一次成功写入记录一个 op。 */
  record(result: WriteResult, options: MakeOpOptions): EditOp | undefined {
    if (!result.ok || result.changeSet.length === 0) return undefined
    const op = makeOp(this.ops.length + 1, result.changeSet, {
      changed: result.changed,
      overwrittenNonAir: result.overwrittenNonAir,
      clipped: result.clipped,
    }, options)
    this.ops.push(op)
    return op
  }

  /** 0-based 取用。 */
  at(index: number): EditOp | undefined {
    return this.ops[index]
  }

  /** 1-based 取用（与 `rev` 一致）。 */
  byRevision(rev: number): EditOp | undefined {
    return this.ops[rev - 1]
  }

  all(): readonly EditOp[] {
    return this.ops
  }

  /** `rev <= revision` 的全部 op（含）。replay 到某个历史点用它。 */
  upTo(revision: number): EditOp[] {
    return this.ops.slice(0, Math.max(0, Math.min(revision, this.ops.length)))
  }

  /** 同一次 LLM 响应的全部 op，用于整轮回滚。 */
  byCorrelation(correlationId: string): EditOp[] {
    return this.ops.filter((op) => op.correlationId === correlationId)
  }

  /** 序列化成 `edits.jsonl`（每行一个 JSON，patch 为 base64）。 */
  toJSONL(): string {
    if (this.ops.length === 0) return ''
    return this.ops.map((op) => JSON.stringify(encodeEditOp(op))).join('\n') + '\n'
  }

  /**
   * 从 `edits.jsonl` 恢复。
   *
   * 对**损坏的行**采取"截断而非报错"的策略：事件日志是追加写的，
   * 崩溃时最后一行可能只写了一半。丢到最后一行是正确行为，丢中间的行才是事故。
   */
  static fromJSONL(text: string): { log: EditLog; droppedTail: number } {
    const log = new EditLog()
    const lines = text.split('\n')
    let droppedTail = 0
    let truncated = false

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!.trim()
      if (line.length === 0) continue
      if (truncated) {
        droppedTail++
        continue
      }
      let record: EditOpRecord
      try {
        record = JSON.parse(line) as EditOpRecord
      } catch {
        // 只在最后一行容忍解析失败（写到一半）
        if (i === lines.length - 1 || lines.slice(i + 1).every((l) => l.trim() === '')) {
          truncated = true
          droppedTail++
          continue
        }
        throw new EditLogError(`edits.jsonl line ${i + 1} is not valid JSON and is not the end of the file (log is corrupted)`)
      }
      log.append(decodeEditOp(record))
    }

    return { log, droppedTail }
  }

  /** 完整性自检：rev 连续、id 与 rev 匹配、patch 长度与 result.changed 一致。 */
  validate(): string[] {
    const problems: string[] = []
    for (let i = 0; i < this.ops.length; i++) {
      const op = this.ops[i]!
      const expectedRev = i + 1
      if (op.rev !== expectedRev) problems.push(`op ${i + 1} has rev=${op.rev}, expected ${expectedRev}`)
      if (op.id !== `op_${String(expectedRev).padStart(6, '0')}`) {
        problems.push(`op ${i + 1} has id=${op.id}, which does not match rev`)
      }
      if (op.patch.length !== op.result.changed) {
        problems.push(
          `op ${i + 1} patch has ${op.patch.length} cells, but result.changed=${op.result.changed}`,
        )
      }
    }
    return problems
  }
}

/**
 * 内存形态 → 磁盘形态。
 *
 * **导出是为了让别处也能写出同一份磁盘表示。** WAL（`packages/mcai/src/wal.ts`）
 * 要单独追加 op，如果它自己 `JSON.stringify(op)`，`patch`（一个 `ChangeSet` 对象）
 * 会被序列化成普通对象，读回来直接崩——磁盘上 op 的形状**只能有一个真相**。
 */
export function encodeEditOp(op: EditOp): EditOpRecord {
  const record: EditOpRecord = {
    id: op.id,
    rev: op.rev,
    ts: op.ts,
    source: op.source,
    actor: op.actor,
    tool: op.tool,
    args: op.args,
    result: op.result,
    patch: op.patch.toBuffer().toString('base64'),
  }
  if (op.correlationId !== undefined) record.correlationId = op.correlationId
  return record
}

/** 磁盘形态 → 内存形态。与 `encodeEditOp` 配对。 */
export function decodeEditOp(record: EditOpRecord): EditOp {
  const op: EditOp = {
    id: record.id,
    rev: record.rev,
    ts: record.ts,
    source: record.source,
    actor: record.actor,
    tool: record.tool,
    args: record.args,
    result: record.result,
    patch: ChangeSet.fromBuffer(Buffer.from(record.patch, 'base64')),
  }
  if (record.correlationId !== undefined) op.correlationId = record.correlationId
  return op
}
