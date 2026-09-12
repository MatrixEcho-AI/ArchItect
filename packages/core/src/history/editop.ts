import type { BlockEntityChange, EntityChange } from '../entity/types.js'
import type { ChangeSet } from '../world/changeset.js'

/** 一次编辑的来源。 */
export type OpSource = 'llm' | 'user' | 'import' | 'system'

export interface EditOpResult {
  changed: number
  overwrittenNonAir: number
  clipped: number
  /**
   * 方块实体层与实体层的变更条数。
   *
   * **可选**：`.mcai` 里老 op 没有这两个字段，读回来就是 `undefined`，
   * 语义等同于 0（那时候世界上根本没有这两层）。写成必填会让所有老工程
   * 在 `decodeEditOp` 上翻车——而那种翻车发生在 `fromJSONL` 的 `try` 之外，
   * 结果是**整份工程打不开**（见 plan §18.1 第 4 条）。
   */
  blockEntitiesChanged?: number
  entitiesChanged?: number
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
  /**
   * 精确的方块变更。
   *
   * **恒在，可以是空集。** 一条只放实体、不动方块的 op 也带一个长度为 0 的
   * `patch`——因为旧读方在 `patch` 缺席时会直接抛错，而那个抛错会让
   * **整份工程打不开**（plan D-78）。空集是那个约束下唯一安全的选择。
   */
  patch: ChangeSet
  /**
   * 方块实体层的变更（键 = 位置）。
   *
   * 由 `WorldStore.writeBlocks` 产出，不是工具层——因为它是**寄生**的：
   * `fill_box` 覆盖一个满箱子时，只有 store 知道那个格子上原本挂着东西。
   * 放到工具层收集的话，撤销之后箱子回来、里面的东西没了，而且是安静地没（D-81）。
   */
  blockEntityChanges?: BlockEntityChange[]
  /** 实体层的变更（键 = id）。由工具层产出——只有它知道自己放了什么。 */
  entityChanges?: EntityChange[]
}

/**
 * 一条 op 携带的全部负载。三个字段对应世界的三层（plan §18.2）。
 *
 * 打包成一个对象而不是给 `makeOp` 加三个位置参数：调用点只有一个（`EditLog.record`），
 * 但读的人要一眼看出"这条 op 改了哪几层"。
 */
export interface OpPayload {
  patch: ChangeSet
  blockEntityChanges?: readonly BlockEntityChange[]
  entityChanges?: readonly EntityChange[]
}

/**
 * 一次写入里**工具主动写**的稀疏层差分（`EditLog.record` 的第三个参数）。
 *
 * 方块实体层只有一半在这里：**寄生剪除**那一半跟着 `WriteResult` 回来，
 * 因为只有 `WorldStore` 知道哪个格子上原本挂着东西（D-81）。这里放的是另一半——
 * 工具明确要写的东西：给箱子塞东西、给告示牌写字、往世界里放一条船。
 *
 * 实体层则**全在这里**：`WorldStore` 根本不知道工具放了什么。
 */
export interface SparseWrite {
  entities?: readonly EntityChange[]
  blockEntities?: readonly BlockEntityChange[]
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
  payload: OpPayload,
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
    patch: payload.patch,
  }
  if (options.correlationId !== undefined) op.correlationId = options.correlationId
  // 空的负载**不写成空数组**：`undefined` 表示"这一层没动"，而 `[]` 也会被
  // 当成没动，但前者在 JSONL 里少一段字节。老 op 读回来也正好是 `undefined`。
  if (payload.blockEntityChanges !== undefined && payload.blockEntityChanges.length > 0) {
    op.blockEntityChanges = [...payload.blockEntityChanges]
  }
  if (payload.entityChanges !== undefined && payload.entityChanges.length > 0) {
    op.entityChanges = [...payload.entityChanges]
  }
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
  /** 方块实体差分，纯 JSON（不是 base64）。老 op 没有这个字段。 */
  blockEntityChanges?: BlockEntityChange[]
  /** 实体差分，纯 JSON（不是 base64）。老 op 没有这个字段。 */
  entityChanges?: EntityChange[]
}
