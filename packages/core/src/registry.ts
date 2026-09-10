import minecraftData from 'minecraft-data'

import type { BlockProperty, BlockType } from './types.js'

/** minecraft-data 原始 block 记录的形状（上游没有类型声明）。 */
interface RawBlock {
  id: number
  name: string
  minStateId: number
  maxStateId: number
  defaultState: number
  states?: BlockProperty[]
}

interface RawData {
  blocksArray: RawBlock[]
  blocksByName: Record<string, RawBlock>
  blocksByStateId: Record<string, RawBlock>
  blockCollisionShapes?: RawShapes
}

interface RawShapes {
  /** 方块名 → 形状 id，或按 state 序号索引的形状 id 数组。 */
  blocks: Record<string, number | number[]>
  /** 形状 id → 碰撞盒列表 `[x0,y0,z0,x1,y1,z1]`（0..1 归一化）。 */
  shapes: Record<string, number[][]>
}

/** 一个归一化的轴对齐盒 `[x0,y0,z0,x1,y1,z1]`（分量都在 0..1）。 */
export type ShapeBox = readonly [number, number, number, number, number, number]

export interface BlockRegistry {
  readonly minecraftVersion: string
  /** 该版本最大的全局 block state id（含）。 */
  readonly maxStateId: number
  readonly blockCount: number
  readonly blockNames: readonly string[]
  blockByName(name: string): BlockType | undefined
  blockByStateId(stateId: number): BlockType | undefined
  /**
   * 该 state 的**碰撞盒**列表（0..1 归一化）。空数组表示无碰撞形状（火把、植物、告示牌）。
   *
   * 用它代替"所有方块都是一个整立方体"来做渲染：楼梯是两块、栅栏是细柱、门是薄板。
   * 注意这是**碰撞**形状不是**视觉**形状——栅栏少了连接的横杆，但比整块实心墙接近得多。
   */
  shapesOf(stateId: number): readonly ShapeBox[]
  /** 是否是占满整格的实心立方体（用于面剔除的快速判断）。 */
  isFullCube(stateId: number): boolean
}

const cache = new Map<string, BlockRegistry>()

/**
 * 载入某版本的方块注册表。
 *
 * 全局 state id 是**版本相关**的（1.21.4 的 136 是 oak_log，1.16.5 的 136 不是），
 * 所以注册表必须按版本构造，且 `.mcai` 里存的是规范字符串而不是 state id。
 */
export function loadRegistry(minecraftVersion: string): BlockRegistry {
  const cached = cache.get(minecraftVersion)
  if (cached !== undefined) return cached

  const load = minecraftData as unknown as (version: string) => RawData
  const data = load(minecraftVersion)
  if (data === undefined || !Array.isArray(data.blocksArray)) {
    throw new Error(`minecraft-data has no data for version "${minecraftVersion}"`)
  }

  const blocksByName = new Map<string, BlockType>()
  const byStateId: BlockType[] = []
  let maxStateId = 0

  for (const raw of data.blocksArray) {
    const block: BlockType = {
      id: raw.id,
      name: raw.name,
      minStateId: raw.minStateId,
      maxStateId: raw.maxStateId,
      defaultState: raw.defaultState,
      states: raw.states ?? [],
    }
    blocksByName.set(block.name, block)
    if (block.maxStateId > maxStateId) maxStateId = block.maxStateId
  }

  // stateId -> BlockType 的稠密查表（27 866 项，O(1)），用于热路径。
  const stateToBlock = new Array<BlockType | undefined>(maxStateId + 1)
  for (const block of blocksByName.values()) {
    for (let s = block.minStateId; s <= block.maxStateId; s++) stateToBlock[s] = block
  }
  for (let s = 0; s <= maxStateId; s++) {
    const b = stateToBlock[s]
    if (b === undefined) throw new Error(`state id ${s} has no block (there is a hole in the ${minecraftVersion} data)`)
    byStateId[s] = b
  }

  // 形状表：按 stateId 索引。绝大多数 state 共享少数几个形状对象，所以是引用复制，不占额外内存。
  const shapesByState = new Array<readonly ShapeBox[]>(maxStateId + 1).fill(EMPTY_SHAPES)
  const fullCubeFlags = new Uint8Array(maxStateId + 1)
  const rawShapes = data.blockCollisionShapes
  if (rawShapes !== undefined) {
    for (const block of blocksByName.values()) {
      const entry = rawShapes.blocks[block.name]
      if (entry === undefined) continue
      const count = block.maxStateId - block.minStateId + 1
      for (let ordinal = 0; ordinal < count; ordinal++) {
        const shapeId = Array.isArray(entry) ? (entry[ordinal] ?? entry[0]) : entry
        const boxes = shapeId === undefined ? [] : toShapeBoxes(rawShapes.shapes[shapeId])
        const stateId = block.minStateId + ordinal
        shapesByState[stateId] = boxes
        fullCubeFlags[stateId] = boxes.length === 1 && isUnitCube(boxes[0]!) ? 1 : 0
      }
    }
  }

  const registry: BlockRegistry = {
    minecraftVersion,
    maxStateId,
    blockCount: blocksByName.size,
    blockNames: [...blocksByName.keys()].sort(),
    blockByName: (name) => blocksByName.get(name.replace(/^minecraft:/, '')),
    blockByStateId: (stateId) => (stateId >= 0 && stateId <= maxStateId ? byStateId[stateId] : undefined),
    shapesOf: (stateId) =>
      stateId >= 0 && stateId <= maxStateId ? shapesByState[stateId]! : EMPTY_SHAPES,
    isFullCube: (stateId) => (stateId >= 0 && stateId <= maxStateId ? fullCubeFlags[stateId] === 1 : false),
  }

  cache.set(minecraftVersion, registry)
  return registry
}

const EMPTY_SHAPES: readonly ShapeBox[] = []

function toShapeBoxes(raw: number[][] | undefined): readonly ShapeBox[] {
  if (raw === undefined) return EMPTY_SHAPES
  return raw.map((box) => [
    box[0] ?? 0,
    box[1] ?? 0,
    box[2] ?? 0,
    box[3] ?? 1,
    box[4] ?? 1,
    box[5] ?? 1,
  ] as const)
}

function isUnitCube(box: ShapeBox): boolean {
  return box[0] === 0 && box[1] === 0 && box[2] === 0 && box[3] === 1 && box[4] === 1 && box[5] === 1
}
