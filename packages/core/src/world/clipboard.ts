import { MAX_BLOCK_ENTITIES } from '../entity/blockentities.js'
import { MAX_ENTITIES } from '../entity/store.js'
import { cellKey } from '../entity/types.js'
import type { BlockEntityChange, EntityChange, PlacedBlockEntity, PlacedEntity, SparseWrite } from '../entity/types.js'
import type { BlockRegistry } from '../registry.js'
import { remapStateId, remapRotationStep, transformLocalPoint, transformLocalPointF, transformLocalY, transformedSize } from '../transform.js'
import type { MirrorAxis, RotateDegrees, Size3, Transform } from '../transform.js'
import type { Pos } from '../types.js'
import type { LayeredWriteResult, WorldStore, WriteMode } from './store.js'

/**
 * 区域复制粘贴。
 *
 * 与 `symmetrize` 的差别：`symmetrize` 是**就地**沿一个平面镜像（源和目标共享同一个工区），
 * 这里是**搬运**——把一块区域取下来，换个地方放，还可以转个角度、翻个面。
 *
 * ## 三件事必须一起做，只做一件就是错的
 *
 * 1. **坐标搬家**——绕区域中心旋转/镜像，再整体平移到锚点。
 * 2. **朝向重映射**——楼梯的 `facing`、门的 `hinge`、告示牌的 `rotation` 都要跟着变。
 *    这一条由 `../transform.js` 负责，与坐标用的是同一个矩阵。
 * 3. **另外两层跟着走**（plan D-87）——一座码头上的船、一个箱子里的东西都是
 *    "这块区域的一部分"。只搬方块的话，复制一座仓库得到的是**一排空箱子**，
 *    而这件事不会报错。所以实体与方块实体也是剪贴板的一部分。
 *
 * 区域中心的口径对齐整数：奇数尺寸中心落在某一格上，偶数尺寸落在两格之间，
 * `size-1-p` 两种情况下都精确给出互补格，**不会产生半格**。
 */

/** 剪贴板里的一格。`x/y/z` 是**相对于区域最小角**的局部坐标。 */
export interface ClipCell {
  x: number
  y: number
  z: number
  /** 全局 state id。存它而不是字符串，是为了粘贴时不必再解析一遍。 */
  stateId: number
}

/**
 * 剪贴板里的一个实体。
 *
 * 存的是**去掉 id 的模板**加**浮点局部坐标**：id 必须在粘贴时按新版本重新分配
 * （同一个剪贴板可以贴很多次，每次都得到独立的对象，见 plan D-80），
 * 位置则不能量化到格——船停在半格上是常态，按格存会把它挪到墙角。
 */
export interface ClipEntity {
  x: number
  y: number
  z: number
  entity: Omit<PlacedEntity, 'id'>
}

/** 剪贴板里的一个方块实体。局部坐标是**整数格**（它与方块同格）。 */
export interface ClipBlockEntity {
  x: number
  y: number
  z: number
  kind: string
  data: Record<string, unknown>
}

export interface ClipRegion {
  /** 源区域的最小角（仅作记录，供工具回显）。 */
  origin: Pos
  /** 源区域尺寸。 */
  size: Size3
  /** **只含非空气格**——复制一整块空气没有意义，而且能让剪贴板小得多。 */
  cells: ClipCell[]
  /** 区域内的实体（浮点局部坐标）。 */
  entities: ClipEntity[]
  /** 区域内的方块实体（整数局部坐标），只含**方块真的被复制了**的那些格。 */
  blockEntities: ClipBlockEntity[]
}

/** 把 `from`/`to` 任意角归一化成最小/最大角。 */
export function normalizeBox(a: Pos, b: Pos): { min: Pos; max: Pos } {
  return {
    min: { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), z: Math.min(a.z, b.z) },
    max: { x: Math.max(a.x, b.x), y: Math.max(a.y, b.y), z: Math.max(a.z, b.z) },
  }
}

export interface CopyOptions {
  /** 只复制这些方块名；省略表示全部非空气。 */
  only?: readonly string[]
  /** 超过这个格数就拒绝复制（防止把整个工区塞进内存）。 */
  maxCells?: number
}

export const COPY_CELL_LIMIT = 200_000
/** 一次复制最多带走几个实体 / 方块实体。与写入侧的硬上限同一个数量级。 */
export const COPY_ENTITY_LIMIT = 4096
export const COPY_BLOCK_ENTITY_LIMIT = 65536

/** 取下一块区域。**只读**，不产生 revision。 */
export function copyRegion(store: WorldStore, from: Pos, to: Pos, options: CopyOptions = {}): ClipRegion {
  const { min, max } = normalizeBox(from, to)
  const size: Size3 = [max.x - min.x + 1, max.y - min.y + 1, max.z - min.z + 1]
  const only = options.only !== undefined ? new Set(options.only.map((name) => name.replace(/^minecraft:/, ''))) : undefined
  const limit = options.maxCells ?? COPY_CELL_LIMIT

  const cells: ClipCell[] = []
  /** 真的进了剪贴板的格。方块实体只跟着这些格走（见下面的说明）。 */
  const copied = new Set<string>()
  for (let y = min.y; y <= max.y; y++) {
    for (let z = min.z; z <= max.z; z++) {
      for (let x = min.x; x <= max.x; x++) {
        const stateId = store.getBlockStateId({ x, y, z })
        if (stateId === 0) continue
        if (only !== undefined) {
          const name = store.registry.blockByStateId(stateId)?.name
          if (name === undefined || !only.has(name)) continue
        }
        cells.push({ x: x - min.x, y: y - min.y, z: z - min.z, stateId })
        copied.add(cellKey(x, y, z))
      }
    }
  }
  if (cells.length > limit) {
    throw new RangeError(`区域里有 ${cells.length} 个非空气方块，超过复制上限 ${limit}；请缩小范围或加 only 过滤`)
  }

  // 另外两层。两处刻意的取舍：
  //
  // - **`only` 给了就不带实体**。`only` 是一个方块名过滤器（"只要屋顶"），
  //   而实体没有方块名可筛——带了的话"只要屋顶"会顺走停在屋顶上的船。
  //   方块实体反过来：它属于那一格，方块被复制了它就跟着，被 `only` 滤掉就留下。
  // - **判据是"落在哪一格"**（`floor`），与 `list_entities` / `remove_entity`
  //   的区域形态同一个口径。否则会出现"在切片图上看得见它、却复制不走它"。
  const blockEntities = collectBlockEntities(store, min, max, copied)
  const entities = only !== undefined ? [] : collectEntities(store, min, max, { x: min.x, y: min.y, z: min.z })

  if (entities.length > COPY_ENTITY_LIMIT) {
    throw new RangeError(`区域里有 ${entities.length} 个实体，超过复制上限 ${COPY_ENTITY_LIMIT}`)
  }
  if (blockEntities.length > COPY_BLOCK_ENTITY_LIMIT) {
    throw new RangeError(`区域里有 ${blockEntities.length} 个方块实体，超过复制上限 ${COPY_BLOCK_ENTITY_LIMIT}`)
  }

  return { origin: min, size, cells, entities, blockEntities }
}

/** 区域内的方块实体，局部坐标。**只收方块真的被复制了的格**。 */
function collectBlockEntities(
  store: WorldStore,
  min: Pos,
  max: Pos,
  copied: ReadonlySet<string>,
): ClipBlockEntity[] {
  const target = store.blockEntities
  if (target.size === 0) return []
  const out: ClipBlockEntity[] = []
  for (const entry of target.list()) {
    if (entry.x < min.x || entry.x > max.x) continue
    if (entry.y < min.y || entry.y > max.y) continue
    if (entry.z < min.z || entry.z > max.z) continue
    if (!copied.has(cellKey(entry.x, entry.y, entry.z))) continue
    out.push({
      x: entry.x - min.x,
      y: entry.y - min.y,
      z: entry.z - min.z,
      kind: entry.kind,
      data: entry.data,
    })
  }
  return out
}

/** 区域内的实体，局部**浮点**坐标。 */
function collectEntities(store: WorldStore, min: Pos, max: Pos, origin: Pos): ClipEntity[] {
  const source = store.entities
  if (source.size === 0) return []
  const out: ClipEntity[] = []
  for (const entity of source.inBounds({ min, max })) {
    const { id: _id, ...template } = entity
    out.push({
      x: entity.x - origin.x,
      y: entity.y - origin.y,
      z: entity.z - origin.z,
      entity: template,
    })
  }
  return out
}

/** 粘贴后的**新尺寸**（90°/270° 会把水平两轴换位）。 */
export function clipPasteSize(clip: ClipRegion, transform: Transform): Size3 {
  return transformedSize(clip.size, transform)
}

/**
 * 算出每一格粘到哪、粘成什么。**纯函数，不碰世界**。
 *
 * 返回的顺序是确定的：先按变换后的 `y`、再 `z`、再 `x` 排序，
 * 这样批处理与单独调用产生的格序一致，撤销栈与 diff 也就一致。
 */
export function planPaste(
  registry: BlockRegistry,
  clip: ClipRegion,
  at: Pos,
  transform: Transform,
): Array<{ x: number; y: number; z: number; stateId: number }> {
  const out: Array<{ x: number; y: number; z: number; stateId: number }> = []
  for (const cell of clip.cells) {
    const [lx, ly, lz] = transformLocalPoint([cell.x, cell.y, cell.z], clip.size, transform)
    const ty = transformLocalY(ly, clip.size[1], transform)
    out.push({
      x: at.x + lx,
      y: at.y + ty,
      z: at.z + lz,
      stateId: remapStateId(registry, cell.stateId, transform),
    })
  }
  out.sort((a, b) => a.y - b.y || a.z - b.z || a.x - b.x)
  return out
}

/**
 * 粘贴时另外两层各自落到哪。
 *
 * **方块实体的判据需要一个"源方块"**：它搬过去之后，那一格必须真的被写成了
 * 源方块（`mode: keep` 遇到占着的格子会跳过）。所以这里把源格的 stateId 一起记下来，
 * 落地之后逐格比对——否则"往石头上贴一座带箱子的仓库"会往石头里塞一份箱子内容。
 */
export interface PendingBlockEntity {
  x: number
  y: number
  z: number
  /** 那一格**应该**被写成什么（变换后的 stateId）。落地后比对用。 */
  stateId: number
  kind: string
  data: Record<string, unknown>
}

export interface PendingEntity {
  x: number
  y: number
  z: number
  entity: Omit<PlacedEntity, 'id'>
}

export interface PasteSparsePlan {
  entities: PendingEntity[]
  blockEntities: PendingBlockEntity[]
}

/**
 * 另外两层的落点。**纯函数**（只读世界来算"那一格的源方块是什么"），不产生改动。
 *
 * 单独导出来是给 `run_batch` 用的：批处理要把多个 `paste_region` 的稀疏层意图
 * 攒起来、在**合并后的那一次方块写入之后**统一落盘。共用这个函数是
 * "批处理里粘贴的实体落点与单独粘贴完全一致"的全部保证。
 */
export function planPasteSparse(
  store: WorldStore,
  clip: ClipRegion,
  target: Pos,
  transform: Transform,
): PasteSparsePlan {
  const height = clip.size[1]
  const entities: PendingEntity[] = clip.entities.map((entry) => {
    const [lx, ly, lz] = transformLocalPointF([entry.x, entry.y, entry.z], clip.size, transform)
    return {
      x: target.x + lx,
      y: target.y + ly,
      z: target.z + lz,
      entity: remapEntity(entry.entity, transform),
    }
  })

  const blockEntities: PendingBlockEntity[] = []
  for (const entry of clip.blockEntities) {
    const sourceStateId = store.getBlockStateId({
      x: clip.origin.x + entry.x,
      y: clip.origin.y + entry.y,
      z: clip.origin.z + entry.z,
    })
    const [lx, ly, lz] = transformLocalPoint([entry.x, entry.y, entry.z], clip.size, transform)
    const ty = transformLocalY(ly, height, transform)
    blockEntities.push({
      x: target.x + lx,
      y: target.y + ty,
      z: target.z + lz,
      stateId: remapStateId(store.registry, sourceStateId, transform),
      kind: entry.kind,
      data: entry.data,
    })
  }

  return { entities, blockEntities }
}

/**
 * 把"另外两层的落点"翻成 `writeLayered` 要的回调。
 *
 * 这个回调**在方块已经落盘之后**执行，所以它能看到写入后的世界：
 * 方块实体只在那一格真的被写成了源方块时才搬（`keep` / `overlay` 会跳过占着的格子），
 * 否则"往石头上贴一座带箱子的仓库"会往石头里塞一份箱子内容。
 */
export function pasteSparseWriter(
  store: WorldStore,
  plan: PasteSparsePlan,
  revision: number,
): () => SparseWrite {
  return () => {
    const blockEntityChanges: BlockEntityChange[] = []
    for (const entry of plan.blockEntities) {
      if (store.getBlockStateId({ x: entry.x, y: entry.y, z: entry.z }) !== entry.stateId) continue
      const change = store.blockEntities.set({
        x: entry.x,
        y: entry.y,
        z: entry.z,
        kind: entry.kind,
        data: entry.data,
      } satisfies PlacedBlockEntity)
      if (change !== undefined) blockEntityChanges.push(change)
    }

    const entityChanges: EntityChange[] = []
    for (const entry of plan.entities) {
      const change = store.entities.set({
        ...entry.entity,
        id: store.entities.allocateId(revision),
        x: entry.x,
        y: entry.y,
        z: entry.z,
      })
      if (change !== undefined) entityChanges.push(change)
    }

    return { entities: entityChanges, blockEntities: blockEntityChanges }
  }
}

/**
 * 把实体的**朝向**过一遍变换，其余字段原样。
 *
 * `yaw` 与方块的 `rotation` 是同一套档位（0 = 南，俯视顺时针），所以走同一个函数；
 * `pitch` 在竖直镜像下取反（上下翻了，抬头就变成低头）。
 * `data` **刻意不动**：1.21.4 里那几种方块实体的朝向都在方块状态上（已由
 * `remapStateId` 处理），实体 `data` 里没有方向量。将来若某个版本把朝向挪进 NBT，
 * 这里是那个必须改的地方——`plan.md` 的已知边界里记着这一条。
 */
function remapEntity(entity: Omit<PlacedEntity, 'id'>, transform: Transform): Omit<PlacedEntity, 'id'> {
  const yaw = remapRotationStep(Math.round(entity.yaw), transform)
  if (entity.pitch === undefined) return { ...entity, yaw }
  const pitch = transform.mirror === 'y' ? -entity.pitch : entity.pitch
  return { ...entity, yaw, pitch }
}

export interface PasteOptions {
  rotate?: RotateDegrees
  mirror?: MirrorAxis
  /** 把剪贴板整体平移一个偏移量（在 `at` 之外再挪）。 */
  offset?: Pos
  mode?: WriteMode
  confirm?: boolean
  confirmThreshold?: number
  hardLimit?: number
}

/**
 * 把剪贴板贴到 `at`（新区域的**最小角**落在 `at`）。
 *
 * 三层一起落，而且**只推进一格版本**——由 `writeLayered` 保证（见那里关于顺序的说明：
 * 方块先、稀疏层后，因为方块写入会顺手剪掉旧方块实体）。
 */
export function pasteRegion(
  store: WorldStore,
  clip: ClipRegion,
  at: Pos,
  options: PasteOptions = {},
): LayeredWriteResult {
  const transform: Transform = {}
  if (options.rotate !== undefined) transform.rotate = options.rotate
  if (options.mirror !== undefined) transform.mirror = options.mirror
  const offset = options.offset ?? { x: 0, y: 0, z: 0 }
  const target = { x: at.x + offset.x, y: at.y + offset.y, z: at.z + offset.z }

  const cells = planPaste(store.registry, clip, target, transform)
  const sparse = planPasteSparse(store, clip, target, transform)

  // **先校验容量再动世界。** 让 `set()` 在写入过程中抛的话，方块已经落盘了，
  // 而那一笔没有 op——撤销撤不掉、日志里也看不见（与 `place_entity` 同一条理由）。
  assertCapacity(store, sparse)

  // 新实体的 id 按**这一笔产生的那个版本**发号。版本在写入前算得出来：
  // `writeLayered` 至多推进一格，且 `planPasteSparse` 里没有任何写入。
  const revision = store.revision + 1

  return store.writeLayered(
    (emit) => {
      for (const cell of cells) emit(cell.x, cell.y, cell.z, store.blockIndexForStateId(cell.stateId))
    },
    pasteSparseWriter(store, sparse, revision),
    {
      mode: options.mode ?? 'replace',
      confirm: options.confirm === true,
      ...(options.confirmThreshold !== undefined ? { confirmThreshold: options.confirmThreshold } : {}),
      ...(options.hardLimit !== undefined ? { hardLimit: options.hardLimit } : {}),
    },
  )
}

/**
 * 容量预检。两层各有硬上限，超了要**在写方块之前**报错。
 *
 * 上限**从 `entity/` 里读**而不是在这里各写一个数字：抄一份的下场是两处慢慢漂开，
 * 而漂开的表现正是"预检通过、写入跑到一半才抛"——那是最坏的一种失败，
 * 方块已经落盘而这一笔没有 op。
 */
function assertCapacity(
  store: WorldStore,
  sparse: { entities: readonly unknown[]; blockEntities: readonly unknown[] },
): void {
  if (store.entities.size + sparse.entities.length > MAX_ENTITIES) {
    throw new RangeError(
      `粘贴会带进 ${sparse.entities.length} 个实体，世界将超过上限 ${MAX_ENTITIES}；请缩小区域或先删掉一些实体`,
    )
  }
  if (store.blockEntities.size + sparse.blockEntities.length > MAX_BLOCK_ENTITIES) {
    throw new RangeError(
      `粘贴会带进 ${sparse.blockEntities.length} 个方块实体，世界将超过上限 ${MAX_BLOCK_ENTITIES}`,
    )
  }
}
