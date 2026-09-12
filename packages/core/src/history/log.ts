import type { BlockEntityChange, EntityChange } from '../entity/types.js'
import { ChangeSet } from '../world/changeset.js'
import { makeOp } from './editop.js'
import type { EditOp, EditOpRecord, MakeOpOptions, SparseWrite } from './editop.js'
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

  /**
   * 由一次成功写入记录一个 op。
   *
   * 给了 `options.worldRevision` 时顺带守两条不变式（见 `MakeOpOptions`）：
   * 在历史版本上写入先**截断**（从那里分叉），并校验新 op 的编号与世界的版本一致。
   * 这两条一旦破掉，日志里就会出现两条同号 op，而 `revision` 与 `log.length`
   * 再也对不上——重放、时间线、`.mcai` 往返会同时坏掉，且坏得很安静。
   *
   * `sparse` 是那两层稀疏数据里**工具主动写**的部分——方块实体是寄生的、
   * 剪除差分跟着 `result` 回来，而实体层根本不由 `WorldStore` 写，所以这部分
   * 只能由调用方交进来。来源不同，就在签名上分开（见 `SparseWrite`）。
   *
   * `result` 可以为 `undefined`，意思是**这一笔没有方块写入**（只动稀疏层）。
   * 不这么设计的话，调用方得去造一个空的 `WriteResult` 来占位——而那种占位物
   * 迟早会被人图省事填上一个真的结果，于是日志里记下一笔并不存在的方块改动。
   */
  record(
    result: WriteResult | undefined,
    options: MakeOpOptions,
    sparse: SparseWrite = {},
  ): EditOp | undefined {
    // 失败的写入（TOO_LARGE / NEEDS_CONFIRM）不记 op，也不消耗版本号
    if (result !== undefined && !result.ok) return undefined
    const patch = result?.changeSet ?? new ChangeSet(1)
    /**
     * 方块实体层有**两个**来源，必须加起来：
     * - `result.blockEntityChanges` —— 方块写入顺手剪掉的（寄生那一条，D-81）；
     * - `sparse.blockEntities` —— 工具主动写的（给箱子塞东西、给告示牌写字）。
     *
     * 只取其中一个的话，要么剪除丢失、要么主动写入丢失，两种都是安静的数据丢失。
     * 顺序也有意义：剪除在前、主动在后，于是"把一个满箱子换成另一个满箱子"
     * （同一个位置上先删后建）得到的是后者。
     */
    const blockEntityChanges = [...(result?.blockEntityChanges ?? []), ...(sparse.blockEntities ?? [])]
    const entityChanges = sparse.entities ?? []
    /**
     * **三层都空才算空操作。**
     *
     * 这里以前只看 `changeSet.length`。那样的话"只放一条船、不动方块"会**直接
     * 返回 undefined**：op 不落盘，于是撤销没有、重放没有、`.mcai` 里没有，
     * 而界面的重画判据（`session.log.length` 变了没有）也不会触发——四处一起静默失效。
     */
    if (patch.length === 0 && blockEntityChanges.length === 0 && entityChanges.length === 0) {
      return undefined
    }
    const worldRevision = options.worldRevision
    if (worldRevision !== undefined && worldRevision - 1 < this.ops.length) {
      this.truncate(worldRevision - 1)
    }
    const rev = this.ops.length + 1
    if (worldRevision !== undefined && rev !== worldRevision) {
      throw new EditLogError(
        `写入后世界在 rev ${worldRevision}，但日志里下一条只能是 rev ${rev}——` +
          `游标与日志脱节了（宿主忘了传 worldRevision，或者世界被绕过日志改过）`,
      )
    }
    const op = makeOp(rev, { patch, blockEntityChanges, entityChanges }, {
      changed: result?.changed ?? 0,
      overwrittenNonAir: result?.overwrittenNonAir ?? 0,
      clipped: result?.clipped ?? 0,
      ...(blockEntityChanges.length > 0 ? { blockEntitiesChanged: blockEntityChanges.length } : {}),
      ...(entityChanges.length > 0 ? { entitiesChanged: entityChanges.length } : {}),
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

  /**
   * **从某个版本之后截断**，返回丢掉的 op 数。
   *
   * 只在一种情况下用：**在历史版本上继续编辑**。游标退到 rev 3 之后又写了一笔，
   * 那条新 op 要占 rev 4，而 rev 4 已经被旧的那条占了——不截断的话日志里会出现
   * 两条 `rev: 4`，`revision` 与 `log.length` 就此脱节，重放与 `.mcai` 往返全对不上。
   *
   * 这是"从这里分叉"的**简化版**：被丢弃的支线**真的没了**。
   * plan §6 里那种"分支记在同一个 jsonl、用 `branch` 字段区分"的完整形态需要
   * 格式支持，还没做（见 §17.2 待定）。
   */
  truncate(revision: number): number {
    const keep = Math.max(0, Math.min(Math.floor(revision), this.ops.length))
    const dropped = this.ops.length - keep
    if (dropped > 0) this.ops.length = keep
    return dropped
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

  /**
   * 完整性自检：rev 连续、id 与 rev 匹配、patch 长度与 result.changed 一致，
   * 以及两个稀疏层的条数与 `result` 里申报的数字一致。
   *
   * 后两条是这次新增的：`result` 里的计数**只是给人和界面看的**，
   * 真相是差分数组本身。两边一旦不一致，说明有人手改了其中一份——
   * 而"计数说是 3 条、实际只有 2 条"这种偏差会让界面上的编辑记录与
   * 实际重放出来的世界对不上。
   */
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
      const blockEntities = op.blockEntityChanges?.length ?? 0
      if (blockEntities !== (op.result.blockEntitiesChanged ?? 0)) {
        problems.push(
          `op ${i + 1} carries ${blockEntities} block entity changes, but result.blockEntitiesChanged=${op.result.blockEntitiesChanged ?? 0}`,
        )
      }
      const entities = op.entityChanges?.length ?? 0
      if (entities !== (op.result.entitiesChanged ?? 0)) {
        problems.push(
          `op ${i + 1} carries ${entities} entity changes, but result.entitiesChanged=${op.result.entitiesChanged ?? 0}`,
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
  // 空数组不写：老 op 读回来本来就是 `undefined`，语义与 `[]` 相同，
  // 少一段字节。反过来，读方必须把"缺席"与"空"当同一件事。
  if (op.blockEntityChanges !== undefined && op.blockEntityChanges.length > 0) {
    record.blockEntityChanges = [...op.blockEntityChanges]
  }
  if (op.entityChanges !== undefined && op.entityChanges.length > 0) {
    record.entityChanges = [...op.entityChanges]
  }
  return record
}

/**
 * 单个 op 里稀疏层条数的上限。
 *
 * 这是**读方的加固**，不是写入方的约束：实体层自己的上限是 4096，方块实体是 65536，
 * 而一份构造出来的 `.mcai` 可以让 `entityChanges` 是一个十亿条的数组——
 * 那时的后果不是"世界不对"，是打开工程这件事本身把内存打爆。
 * 与 `snapshot.ts` 的 256 MB 上限是同一类防线。
 */
const MAX_CHANGES_PER_OP = 65536

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
  const blockEntities = decodeChanges<BlockEntityChange>(record.blockEntityChanges, 'blockEntityChanges', record.id)
  if (blockEntities !== undefined) op.blockEntityChanges = blockEntities
  const entities = decodeChanges<EntityChange>(record.entityChanges, 'entityChanges', record.id)
  if (entities !== undefined) op.entityChanges = entities
  return op
}

/**
 * 校验并取出一个稀疏层的差分数组。
 *
 * 只查"是不是数组、有没有 key、条数有没有超"——**不查 `before`/`after` 的内容**。
 * 内容的校验属于各层自己的 `applyChanges`（它要知道键与载荷是否自洽），
 * 放在这里会把同一件事写两遍。
 */
function decodeChanges<T>(value: unknown, field: string, opId: string): T[] | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value)) {
    throw new EditLogError(`op ${opId} has a non-array ${field}`)
  }
  if (value.length > MAX_CHANGES_PER_OP) {
    throw new EditLogError(
      `op ${opId} carries ${value.length} ${field} entries, over the ${MAX_CHANGES_PER_OP} limit`,
    )
  }
  for (const entry of value) {
    if (entry === null || typeof entry !== 'object' || typeof (entry as { key?: unknown }).key !== 'string') {
      throw new EditLogError(`op ${opId} has a ${field} entry without a string key`)
    }
  }
  return value as T[]
}
