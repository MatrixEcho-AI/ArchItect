import type { Pos } from '../types.js'

/**
 * 一个放进世界里的实体（船、矿车、盔甲架……）。
 *
 * 它与方块层的关系是**没有关系**：位置是浮点的、一格可以叠任意多个、
 * 不占 palette、不参与网格化。见 plan §18.2 的三层表。
 */
export interface PlacedEntity {
  /**
   * 工程内稳定 id，形如 `e_3_1`（= 第 3 个 revision 里创建的第 1 个）。
   *
   * **由写入方分配并写进差分**，而不是让读取方"按顺序发号"。这样 replay 是纯机械应用，
   * 不需要持久化一个"下一个号是多少"的计数器——而计数器一旦要持久化，就得处理
   * "在历史版本上编辑、日志被截断之后它该回退到哪"（plan D-80）。
   */
  id: string
  /** 规范实体类型串，如 `minecraft:oak_boat`。**版本无关层**，对齐 palette 的思路。 */
  type: string
  /** 世界坐标，**精确 double**。工具层把它量化到 1/16 格，存储层不量化。 */
  x: number
  y: number
  z: number
  /** 朝向，0..15（每步 22.5°）。命名朝向（north/south…）在工具层映射到这里。 */
  yaw: number
  pitch?: number
  /** 按类型封闭 schema 校验的附加数据（盔甲架姿势、展示框里的物品……）。 */
  data?: Record<string, unknown>
}

/**
 * 一个挂在方块上的**方块实体**（告示牌文字、旗帜图案、箱子内容……）。
 *
 * 与 `PlacedEntity` 的两处根本差别，也是它必须单独一层的理由：
 * - 键是**位置**而不是 id，一格最多一个；
 * - 它是**寄生的**：方块被换成不带方块实体的类型，它就随之消失。
 *   所以它的差分必须由 `WorldStore.writeBlocks` 产出（只有那里同时知道
 *   "哪个格子被改了"和"这个格子上原本挂着什么"），见 plan D-81。
 */
export interface PlacedBlockEntity {
  x: number
  y: number
  z: number
  /** 种类：`sign` / `hanging_sign` / `chest` / `banner` / `skull` / `decorated_pot`…… */
  kind: string
  /** 该种类的负载。空对象表示"有方块实体但全是默认值"，这种状态不该被存下来。 */
  data: Record<string, unknown>
}

/**
 * 稀疏层的差分条目——**方块实体与实体共用这一个形状**，只有键的类型不同
 * （位置 vs id）。少一个概念，而不是多一个。
 *
 * 语义与 `ChangeSet` 的 `from/to` 同构：
 * - `after` 缺席 = 这一条是**删除**；
 * - `before` 缺席 = 这一条是**新增**；
 * - 反演 = 交换两者（见 `invertChanges`），所以撤销不需要任何额外记账。
 *
 * **是全量记录，不是字段补丁。** 一条实体改动携带完整的 `PlacedEntity`，
 * 而不是"把 yaw 从 3 改成 7"。稀疏层的规模是几十到几千，省不下什么，
 * 但"补丁套补丁"会在 replay 时把顺序变成一个隐蔽的依赖。
 */
export interface KeyedChange<T> {
  key: string
  before?: T
  after?: T
}

export type EntityChange = KeyedChange<PlacedEntity>
export type BlockEntityChange = KeyedChange<PlacedBlockEntity>

/**
 * 一次写入里**工具主动写**的稀疏层部分（plan D-87）。
 *
 * 与 `WriteResult.blockEntityChanges` 的分工是这套记账最容易搞错的一处：
 *
 * - **剪除**那一半只有 `WorldStore` 知道（"这个格子上原本挂着什么"），所以它跟着
 *   `writeBlocks` 的返回值回来；
 * - **主动写**那一半只有工具知道（实体全是工具放的；方块实体里"给箱子塞东西、
 *   给告示牌写字"也是）。方块实体因此**两个来源都有**，`EditLog.record` 必须相加。
 *
 * 放在 `entity/` 而不是 `history/`：`WorldStore` 自己就要用它（`applySparse` /
 * `writeLayered`），而 `history/` 是**依赖** `world/` 的那一层，反过来引会成环。
 */
export interface SparseWrite {
  entities?: readonly EntityChange[]
  blockEntities?: readonly BlockEntityChange[]
}

/**
 * 把几笔稀疏层差分按给定顺序拼成一笔。
 *
 * 用在 `run_batch`：批处理把多个 `paste_region` 的实体意图攒起来，
 * 在**合并后的那一次方块写入之后**统一落盘。**顺序生效**——后面的 op 写同一个
 * 格子时覆盖前面的，与批处理对方块的语义一致。
 */
export function mergeSparse(writes: readonly SparseWrite[]): SparseWrite {
  const entities: EntityChange[] = []
  const blockEntities: BlockEntityChange[] = []
  for (const write of writes) {
    if (write.entities !== undefined) entities.push(...write.entities)
    if (write.blockEntities !== undefined) blockEntities.push(...write.blockEntities)
  }
  return { entities, blockEntities }
}

/**
 * 反演一串差分：**逐条交换 before/after，并把顺序整体倒过来**。
 *
 * 顺序也要倒，不是洁癖：`[c1, c2]` 的逆是 `[c2⁻¹, c1⁻¹]`，不是 `[c1⁻¹, c2⁻¹]`。
 * 差分的键**允许重复**——同一个格子上"先剪除旧的、再写入新的"（把一个满箱子
 * 换成另一个满容器）就是两条同键记录，反演后同一个键会被应用两次。
 * 顺序错了的表现是：撤销之后那个格子上**内容凭空消失**（该恢复成旧的那份，
 * 结果被后一条删掉了）。这条是写测试时撞出来的，不是想出来的。
 */
export function invertChanges<T>(changes: readonly KeyedChange<T>[]): KeyedChange<T>[] {
  const out: KeyedChange<T>[] = []
  for (let i = changes.length - 1; i >= 0; i--) {
    const change = changes[i]!
    out.push({ key: change.key, before: change.after, after: change.before })
  }
  return out
}

/**
 * 格键：世界坐标（整数格）→ 字符串。
 *
 * 单独一个函数是为了**不分配 `Pos` 对象**——`writeBlocks` 的剪除循环要按格查索引，
 * 而那个循环可能跑上百万次。`posKey({x,y,z})` 每次都造一个小对象，在热路径上
 * 就是上百万个可以避免的分配。
 */
export function cellKey(x: number, y: number, z: number): string {
  return `${x},${y},${z}`
}

/** 方块实体的键：世界坐标 → 它所在的那一格。 */
export function blockEntityKey(pos: Pos): string {
  return cellKey(pos.x, pos.y, pos.z)
}

/** 实体所在的那一格（浮点位置向下取整）。位置索引与 `slice` 的标注都用这个口径。 */
export function cellOf(entity: PlacedEntity): Pos {
  return { x: Math.floor(entity.x), y: Math.floor(entity.y), z: Math.floor(entity.z) }
}
