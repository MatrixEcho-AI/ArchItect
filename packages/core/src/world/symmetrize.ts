import { remapStateId } from '../transform.js'
import type { Pos } from '../types.js'
import type { WorldStore, WriteOptions, WriteResult } from './store.js'

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
}

const axisValue = (p: Pos, axis: Axis): number => (axis === 'x' ? p.x : axis === 'y' ? p.y : p.z)

const withAxis = (p: Pos, axis: Axis, value: number): Pos =>
  axis === 'x' ? { x: value, y: p.y, z: p.z } : axis === 'y' ? { x: p.x, y: value, z: p.z } : { x: p.x, y: p.y, z: value }

const posKey = (p: Pos): string => `${p.x},${p.y},${p.z}`

/**
 * 沿一个平面镜像，**把源半区复制到目标半区**。
 *
 * 这是对称建筑省一半工作量的关键工具：只造一半，然后 `symmetrize` 出另一半。
 * 与 `fill_*` 不同，它是**搬运**——每格的方块原样复制（材质分布、方块种类都保留），
 * 不是刷成单一材质。
 *
 * **朝向会一起重映射**（`remapStates` 默认开）：朝东的楼梯映到对面就变成朝西，
 * 门的合页左右互换，告示牌的 `rotation` 走到镜面对称的那一档。这条靠
 * `../transform.js` 里的矩阵实现——平移镜像在方块状态上的作用与在坐标上的作用是
 * **同一个事实**，各写一套迟早会对不上。
 *
 * 已知的不可表示情形（如实保留而不是造一个非法状态）：`wall`/玻璃板的 `up`
 * 没有配对的 `down`；`jigsaw` 的 `orientation` 只声明了 24 种组合中的 12 种；
 * 漏斗的 `facing` 没有 `up`。这些格子的朝向会被保留而不是"猜一个"。
 */
export function symmetrize(store: WorldStore, options: SymmetrizeOptions): WriteResult {
  const { axis, coordinate, source } = options
  const clear = options.clear !== false
  const remapStates = options.remapStates !== false
  const sourceSign = source === 'negative' ? -1 : 1
  // 镜面垂直于 axis，所以状态重映射就是"沿这根轴翻转"
  const transform = { mirror: axis }

  // null 表示"抹成空气"
  const plan = new Map<string, number | null>()

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
    const mirrored = withAxis({ x, y, z }, axis, 2 * coordinate - v)
    // clear=false 的语义是"只补空缺"：目标格已有东西就不动它
    if (!clear && !store.isAir(mirrored)) return
    const state = remapStates ? remapStateId(store.registry, stateId, transform) : stateId
    plan.set(posKey(mirrored), store.blockIndexForStateId(state))
  })

  return store.writeBlocks(
    (emit) => {
      for (const [key, blockIndex] of plan) {
        const [x, y, z] = key.split(',').map(Number) as [number, number, number]
        emit(x, y, z, blockIndex ?? 0)
      }
    },
    { ...options, mode: 'replace' },
  )
}
