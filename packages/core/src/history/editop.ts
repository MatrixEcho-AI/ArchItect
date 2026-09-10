import type { ChangeSet } from '../world/changeset.js'

/** 一次编辑的来源。 */
export type OpSource = 'llm' | 'user' | 'import' | 'system'

export interface EditOpResult {
  changed: number
  overwrittenNonAir: number
  clipped: number
}

/**
 * 一次编辑操作的完整记录。
 *
 * 这是 `.mcai` 里 `history/edits.jsonl` 的一行，也是**整个工程的真相来源**：
 * `base.mcvox` 快照 + op 流可以逐格重建任意历史版本。
 *
 * - `patch` 是**重建的唯一依据**（精确到每格的 from/to）。
 * - `tool` / `args` 只用于展示、"重新执行"与人类阅读，**replay 不依赖它们**。
 *   这样即使工具的实现后来变了，老工程依然能正确回放。
 */
export interface EditOp {
  /** 稳定 id，形如 `op_000001`。UI 用它引用某一步。 */
  id: string
  /** 1-based 序号，等于在 `edits.jsonl` 中的行号。 */
  rev: number
  /** ISO 8601 时间戳。 */
  ts: string
  source: OpSource
  /** 会话内的执行者标识，如 `assistant` / `user`。 */
  actor: string
  /** 工具名，如 `fill_box`。 */
  tool: string
  /** 工具参数（JSON 可序列化）。 */
  args: unknown
  result: EditOpResult
  /** 同一次 LLM 响应里的多个 op 共享，用于**整轮回滚**。 */
  correlationId?: string
  /** 精确的方块变更。 */
  patch: ChangeSet
}

export interface MakeOpOptions {
  source?: OpSource
  actor?: string
  tool: string
  args: unknown
  correlationId?: string
  /** 注入时间戳（测试用，保证可复现）。 */
  ts?: string
  /**
   * **这次写入之后世界所在的版本**（也就是 `store.revision`）。
   *
   * 给了它，`EditLog.record` 就会（a）在写入发生在历史版本上时先把日志截断到那里，
   * （b）校验新 op 的 `rev` 正好等于它。两条都是在守同一个不变式：
   * **游标、日志长度、op 编号三者必须一致**。
   *
   * 可选是为了不逼着每个测试夹具都填；但**宿主必须填**——不填就等于放弃这道防线，
   * 而放弃的后果是日志里出现两条 `rev: 4`，重放与 `.mcai` 往返全对不上。
   */
  worldRevision?: number
}

/** 由 `rev` 生成稳定 id。 */
export function opId(rev: number): string {
  return `op_${String(rev).padStart(6, '0')}`
}

/** 由一次写入的结果构造 `EditOp`。 */
export function makeOp(
  rev: number,
  patch: ChangeSet,
  result: EditOpResult,
  options: MakeOpOptions,
): EditOp {
  const op: EditOp = {
    id: opId(rev),
    rev,
    ts: options.ts ?? new Date().toISOString(),
    source: options.source ?? 'llm',
    actor: options.actor ?? 'assistant',
    tool: options.tool,
    args: options.args,
    result,
    patch,
  }
  if (options.correlationId !== undefined) op.correlationId = options.correlationId
  return op
}

/** `edits.jsonl` 里的一行（patch 用 base64）。 */
export interface EditOpRecord {
  id: string
  rev: number
  ts: string
  source: OpSource
  actor: string
  tool: string
  args: unknown
  result: EditOpResult
  correlationId?: string
  patch: string
}
