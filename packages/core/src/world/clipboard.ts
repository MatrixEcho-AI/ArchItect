import type { BlockRegistry } from '../registry.js'
import { remapStateId, transformLocalPoint, transformLocalY, transformedSize } from '../transform.js'
import type { MirrorAxis, RotateDegrees, Size3, Transform } from '../transform.js'
import type { Pos } from '../types.js'
import type { WorldStore, WriteMode, WriteResult } from './store.js'

/**
 * 区域复制粘贴。
 *
 * 与 `symmetrize` 的差别：`symmetrize` 是**就地**沿一个平面镜像（源和目标共享同一个工区），
 * 这里是**搬运**——把一块区域取下来，换个地方放，还可以转个角度、翻个面。
 *
 * 两件事必须一起做，只做一件就是错的：
 *
 * 1. **坐标搬家**——绕区域中心旋转/镜像，再整体平移到锚点。
 * 2. **朝向重映射**——楼梯的 `facing`、门的 `hinge`、告示牌的 `rotation` 都要跟着变。
 *    这一条由 `../transform.js` 负责，与坐标用的是同一个矩阵。
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

export interface ClipRegion {
  /** 源区域的最小角（仅作记录，供工具回显）。 */
  origin: Pos
  /** 源区域尺寸。 */
  size: Size3
  /** **只含非空气格**——复制一整块空气没有意义，而且能让剪贴板小得多。 */
  cells: ClipCell[]
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

/** 取下一块区域。**只读**，不产生 revision。 */
export function copyRegion(store: WorldStore, from: Pos, to: Pos, options: CopyOptions = {}): ClipRegion {
  const { min, max } = normalizeBox(from, to)
  const size: Size3 = [max.x - min.x + 1, max.y - min.y + 1, max.z - min.z + 1]
  const only = options.only !== undefined ? new Set(options.only.map((name) => name.replace(/^minecraft:/, ''))) : undefined
  const limit = options.maxCells ?? COPY_CELL_LIMIT

  const cells: ClipCell[] = []
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
      }
    }
  }
  if (cells.length > limit) {
    throw new RangeError(`区域里有 ${cells.length} 个非空气方块，超过复制上限 ${limit}；请缩小范围或加 only 过滤`)
  }
  return { origin: min, size, cells }
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

/** 把剪贴板贴到 `at`（新区域的**最小角**落在 `at`）。 */
export function pasteRegion(
  store: WorldStore,
  clip: ClipRegion,
  at: Pos,
  options: PasteOptions = {},
): WriteResult {
  const transform: Transform = {}
  if (options.rotate !== undefined) transform.rotate = options.rotate
  if (options.mirror !== undefined) transform.mirror = options.mirror
  const offset = options.offset ?? { x: 0, y: 0, z: 0 }
  const target = { x: at.x + offset.x, y: at.y + offset.y, z: at.z + offset.z }

  const cells = planPaste(store.registry, clip, target, transform)
  return store.writeBlocks(
    (emit) => {
      for (const cell of cells) emit(cell.x, cell.y, cell.z, store.blockIndexForStateId(cell.stateId))
    },
    {
      mode: options.mode ?? 'replace',
      confirm: options.confirm === true,
      ...(options.confirmThreshold !== undefined ? { confirmThreshold: options.confirmThreshold } : {}),
      ...(options.hardLimit !== undefined ? { hardLimit: options.hardLimit } : {}),
    },
  )
}
