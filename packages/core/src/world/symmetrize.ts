import { MAX_BLOCK_ENTITIES } from '../entity/blockentities.js'
import { MAX_ENTITIES } from '../entity/store.js'
import type { BlockEntityChange, EntityChange, PlacedBlockEntity, PlacedEntity } from '../entity/types.js'
import { remapRotationStep, remapStateId } from '../transform.js'
import type { Pos } from '../types.js'
import type { LayeredWriteResult, WorldStore, WriteOptions } from './store.js'

export type Axis = 'x' | 'y' | 'z'

export interface SymmetrizeOptions extends WriteOptions {
  axis: Axis
  /**
   * 镜像平面所在的坐标。**平面过该格的中心**，所以 `coordinate` 那一格的镜像是它自己，
   * 源半区 `coordinate-1` 会映到 `coordinate+1`。
   */
  coordinate: number
  /** 哪一侧是源：`negative` = 坐标小于 `coordinate` 的一侧。 */
  source: 'negative' | 'positive'
  /** 先把目标侧清空再镜像（默认 `true`）。`false` 则是"只补空缺"。 */
  clear?: boolean
  /**
   * 镜像时是否重映射方块朝向（默认 `true`）。
   *
   * 关掉它只在"我想故意保留原朝向"时有意义——正常用法下**必须开着**：
   * 一座朝东的楼梯原样映到西半边，会立刻变成嵌在墙里的错块。
   */
  remapStates?: boolean
  /**
   * 镜像时是否连带搬运实体与方块实体的**数据**（默认 `true`）。
   *
   * 只搬方块的话，一座挂着告示牌的墙镜像出来是**光秃秃的另一半**，
   * 停在码头上的船也不会过去——而这两件事都不会报错。
   */
  carryEntities?: boolean
}

const axisValue = (p: Pos, axis: Axis): number => (axis === 'x' ? p.x : axis === 'y' ? p.y : p.z)

const withAxis = (p: Pos, axis: Axis, value: number): Pos =>
  axis === 'x' ? { x: value, y: p.y, z: p.z } : axis === 'y' ? { x: p.x, y: value, z: p.z } : { x: p.x, y: p.y, z: value }

const posKey = (p: Pos): string => `${p.x},${p.y},${p.z}`

/** 实体/方块实体在镜像下的落点：整格 `v → 2c-v`，点 `p → 2c+1-p`（见下面的说明）。 */
const mirrorCell = (v: number, coordinate: number): number => 2 * coordinate - v
const mirrorPoint = (v: number, coordinate: number): number => 2 * coordinate + 1 - v

/**
 * 沿一个平面镜像，**把源半区复制到目标半区**。
 *
 * 这是对称建筑省一半工作量的关键工具：只造一半，然后 `symmetrize` 出另一半。
 * 与 `fill_*` 不同，它是**搬运**——每格的方块原样复制（材质分布、方块种类都保留），
 * 不是刷成单一材质。
 *
 * ## 三件事一起做（plan D-87）
 *
 * 1. **朝向重映射**（`remapStates` 默认开）：朝东的楼梯映到对面就变成朝西，
 *    门的合页左右互换，告示牌的 `rotation` 走到镜面对称的那一档。这条靠
 *    `../transform.js` 里的矩阵实现——平移镜像在方块状态上的作用与在坐标上的作用是
 *    **同一个事实**，各写一套迟早会对不上。
 * 2. **实体跟着走**：源半区的实体映到目标半区，`yaw` 走与 `rotation` 同一个函数。
 * 3. **方块实体的数据跟着走**：箱子里的东西、告示牌上的字。它寄生于方块，
 *    所以只在**那一格真的被写成了源方块**时才搬（`clear: false` 会跳过占着的格子）。
 *
 * 目标侧原有的实体在 `clear: true`（默认）下会被删掉——"以源半区为准"就是它的语义。
 * `clear: false`（只补空缺）**不删**任何东西，只往镜像格是空气的地方补。
 *
 * 已知的不可表示情形（如实保留而不是造一个非法状态）：`wall`/玻璃板的 `up`
 * 没有配对的 `down`；`jigsaw` 的 `orientation` 只声明了 24 种组合中的 12 种；
 * 漏斗的 `facing` 没有 `up`。这些格子的朝向会被保留而不是"猜一个"。
 */
export function symmetrize(store: WorldStore, options: SymmetrizeOptions): LayeredWriteResult {
  const { axis, coordinate, source } = options
  const clear = options.clear !== false
  const remapStates = options.remapStates !== false
  const carry = options.carryEntities !== false
  const sourceSign = source === 'negative' ? -1 : 1
  // 镜面垂直于 axis，所以状态重映射就是"沿这根轴翻转"
  const transform = { mirror: axis }

  // null 表示"抹成空气"
  const plan = new Map<string, number | null>()
  /** 方块实体要落到哪：目标格 + 那一格**应该**被写成什么（落地后比对用）。 */
  const blockEntityPlan: Array<{ at: Pos; stateId: number; kind: string; data: Record<string, unknown> }> = []
  /** 实体的落点（浮点）。 */
  const entityPlan: Array<{ x: number; y: number; z: number; entity: Omit<PlacedEntity, 'id'> }> = []
  const removedEntities: EntityChange[] = []

  /**
   * 在源侧？
   *
   * 判据与上面方块那一圈**逐字相同**（`(v - coordinate) * sourceSign > 0`）：
   * `sourceSign` 是 `negative → -1`，所以它等价于"`negative` 时 `v < coordinate`"，
   * 与文档里那句"源半区是坐标小于 `coordinate` 的一侧"一致。
   * 用**格**判（`floor`），与 `list_entities` / `remove_entity` 的区域形态同一个口径。
   */
  const onSourceSide = (v: number): boolean => (v - coordinate) * sourceSign > 0

  if (clear) {
    store.forEachNonAir((x, y, z) => {
      const v = axisValue({ x, y, z }, axis)
      if ((v - coordinate) * sourceSign >= 0) return // 只清目标侧（含平面本身之外）
      plan.set(`${x},${y},${z}`, null)
    })
  }

  store.forEachNonAir((x, y, z, stateId) => {
    const v = axisValue({ x, y, z }, axis)
    if ((v - coordinate) * sourceSign <= 0) return // 只搬源侧
    const mirrored = withAxis({ x, y, z }, axis, mirrorCell(v, coordinate))
    // clear=false 的语义是"只补空缺"：目标格已有东西就不动它
    if (!clear && !store.isAir(mirrored)) return
    const state = remapStates ? remapStateId(store.registry, stateId, transform) : stateId
    plan.set(posKey(mirrored), store.blockIndexForStateId(state))
  })

  if (carry) {
    // ── 方块实体：数据跟着方块走 ──────────────────────────────────
    //
    // 目标侧原有的那些**不用管**：`clear` 会把那些格子写成空气，
    // `writeBlocks` 顺手把它们剪掉了（寄生语义，见 `WorldStore.pruneBlockEntities`）。
    for (const entry of store.blockEntities.list()) {
      const v = axisValue(entry, axis)
      if (!onSourceSide(v)) continue
      const target = withAxis(entry, axis, mirrorCell(v, coordinate))
      if (!clear && !store.isAir(target)) continue
      const sourceStateId = store.getBlockStateId({ x: entry.x, y: entry.y, z: entry.z })
      blockEntityPlan.push({
        at: target,
        stateId: remapStates
          ? remapStateId(store.registry, sourceStateId, transform)
          : sourceStateId,
        kind: entry.kind,
        // `data` 原样：1.21.4 里方块实体的朝向都在方块状态上，NBT 里没有方向量
        data: entry.data,
      })
    }

    // ── 实体 ────────────────────────────────────────────────────
    for (const entity of store.entities.list()) {
      const cell = { x: Math.floor(entity.x), y: Math.floor(entity.y), z: Math.floor(entity.z) }
      const v = axisValue(cell, axis)
      if (clear && !onSourceSide(v)) {
        // 目标侧原有的实体：`clear` 的语义是"以源半区为准"
        const change = store.entities.remove(entity.id)
        if (change !== undefined) removedEntities.push(change)
        continue
      }
      if (!onSourceSide(v)) continue
      const mirroredCell = withAxis(cell, axis, mirrorCell(v, coordinate))
      if (!clear && !store.isAir(mirroredCell)) continue
      const { id: _id, ...template } = entity
      entityPlan.push({
        x: axis === 'x' ? mirrorPoint(entity.x, coordinate) : entity.x,
        y: axis === 'y' ? mirrorPoint(entity.y, coordinate) : entity.y,
        z: axis === 'z' ? mirrorPoint(entity.z, coordinate) : entity.z,
        entity: remapEntity(template, transform, axis),
      })
    }

    // 容量预检要**在写方块之前**做：写到一半才抛的话方块已经落盘而这一笔没有 op
    if (store.entities.size + entityPlan.length > MAX_ENTITIES) {
      throw new RangeError(
        `镜像会带进 ${entityPlan.length} 个实体，世界将超过上限 ${MAX_ENTITIES}；请缩小工区或先删掉一些实体`,
      )
    }
    if (store.blockEntities.size + blockEntityPlan.length > MAX_BLOCK_ENTITIES) {
      throw new RangeError(`镜像会带进 ${blockEntityPlan.length} 个方块实体，世界将超过上限 ${MAX_BLOCK_ENTITIES}`)
    }
  }

  // 新实体的 id 按这一笔产生的版本发号（`writeLayered` 至多推进一格）
  const revision = store.revision + 1

  return store.writeLayered(
    (emit) => {
      for (const [key, blockIndex] of plan) {
        const [x, y, z] = key.split(',').map(Number) as [number, number, number]
        emit(x, y, z, blockIndex ?? 0)
      }
    },
    () => {
      const blockEntityChanges: BlockEntityChange[] = []
      for (const entry of blockEntityPlan) {
        // 那一格真的被写成了源方块才搬数据
        if (store.getBlockStateId(entry.at) !== entry.stateId) continue
        const change = store.blockEntities.set({
          x: entry.at.x,
          y: entry.at.y,
          z: entry.at.z,
          kind: entry.kind,
          data: entry.data,
        } satisfies PlacedBlockEntity)
        if (change !== undefined) blockEntityChanges.push(change)
      }
      const entityChanges: EntityChange[] = [...removedEntities]
      for (const entry of entityPlan) {
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
    },
    { ...options, mode: 'replace' },
  )
}

/**
 * 把实体的朝向过一遍镜像。
 *
 * `yaw` 与方块的 `rotation` 是同一套档位（0 = 南、每格 22.5°、俯视顺时针），
 * 所以走同一个函数——镜像一座码头时船的艏向必须与楼梯的朝向**同时**对。
 * `pitch` 只在竖直镜像下取反：上下翻了，抬头就变成低头。
 */
function remapEntity(
  entity: Omit<PlacedEntity, 'id'>,
  transform: { mirror: Axis },
  axis: Axis,
): Omit<PlacedEntity, 'id'> {
  const yaw = remapRotationStep(Math.round(entity.yaw), transform)
  if (entity.pitch === undefined) return { ...entity, yaw }
  const pitch = axis === 'y' ? -entity.pitch : entity.pitch
  return { ...entity, yaw, pitch }
}
