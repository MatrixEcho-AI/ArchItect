import type { Bounds, Pos } from '../types.js'

export type BoxMode =
  /** 实心。 */
  | 'solid'
  /** 只保留外壳（内部为空气）。 */
  | 'hollow'
  /** 只保留 12 条棱。 */
  | 'outline'

/** 规范化闭区间（两个角点的顺序任意）。 */
export function normalizeBounds(a: Pos, b: Pos): Bounds {
  return {
    min: { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), z: Math.min(a.z, b.z) },
    max: { x: Math.max(a.x, b.x), y: Math.max(a.y, b.y), z: Math.max(a.z, b.z) },
  }
}

export function boundsSize(bounds: Bounds): Pos {
  return {
    x: bounds.max.x - bounds.min.x + 1,
    y: bounds.max.y - bounds.min.y + 1,
    z: bounds.max.z - bounds.min.z + 1,
  }
}

export function boundsVolume(bounds: Bounds): number {
  const size = boundsSize(bounds)
  return size.x * size.y * size.z
}

export function boundsContain(bounds: Bounds, pos: Pos): boolean {
  return (
    pos.x >= bounds.min.x &&
    pos.x <= bounds.max.x &&
    pos.y >= bounds.min.y &&
    pos.y <= bounds.max.y &&
    pos.z >= bounds.min.z &&
    pos.z <= bounds.max.z
  )
}

/** 两个闭区间的交集；无交集返回 `undefined`。 */
export function boundsIntersect(a: Bounds, b: Bounds): Bounds | undefined {
  const min = {
    x: Math.max(a.min.x, b.min.x),
    y: Math.max(a.min.y, b.min.y),
    z: Math.max(a.min.z, b.min.z),
  }
  const max = {
    x: Math.min(a.max.x, b.max.x),
    y: Math.min(a.max.y, b.max.y),
    z: Math.min(a.max.z, b.max.z),
  }
  return min.x > max.x || min.y > max.y || min.z > max.z ? undefined : { min, max }
}

/**
 * 逐格访问轴对齐长方体。
 *
 * - `solid`：全部格子
 * - `hollow`：表面（任一轴坐标落在边界上）
 * - `outline`：12 条棱（**至少两个**轴坐标落在边界上）
 *
 * 退化维度（size 为 1）天然满足"落在边界上"，所以 1×1×N 的 `hollow` 就是那条线本身、
 * `outline` 也是那条线本身——不需要特判。
 */
export function forEachBox(
  from: Pos,
  to: Pos,
  mode: BoxMode,
  visit: (x: number, y: number, z: number) => void,
): void {
  const { min, max } = normalizeBounds(from, to)
  for (let x = min.x; x <= max.x; x++) {
    const onX = x === min.x || x === max.x
    for (let y = min.y; y <= max.y; y++) {
      const onY = y === min.y || y === max.y
      for (let z = min.z; z <= max.z; z++) {
        const onZ = z === min.z || z === max.z
        if (mode === 'hollow' && !(onX || onY || onZ)) continue
        if (mode === 'outline' && !((onX && onY) || (onY && onZ) || (onX && onZ))) continue
        visit(x, y, z)
      }
    }
  }
}

/** 长方体内的整数格。 */
export function boxPositions(from: Pos, to: Pos, mode: BoxMode = 'solid'): Pos[] {
  const positions: Pos[] = []
  forEachBox(from, to, mode, (x, y, z) => positions.push({ x, y, z }))
  return positions
}

/** `mode` 下长方体的格子数（不枚举，用于预算检查）。 */
export function boxCount(from: Pos, to: Pos, mode: BoxMode): number {
  const { min, max } = normalizeBounds(from, to)
  const sx = max.x - min.x + 1
  const sy = max.y - min.y + 1
  const sz = max.z - min.z + 1
  if (mode === 'solid') return sx * sy * sz
  if (mode === 'hollow') {
    return sx * sy * sz - Math.max(0, sx - 2) * Math.max(0, sy - 2) * Math.max(0, sz - 2)
  }
  // outline：至少两个轴坐标落在边界上。
  // 注意 size 为 1 时该轴**所有**坐标都算在边界上（min === max），所以取 1 而不是 0。
  const onX = sx === 1 ? 1 : 2
  const onY = sy === 1 ? 1 : 2
  const onZ = sz === 1 ? 1 : 2
  return onX * onY * sz + onY * onZ * sx + onX * onZ * sy - 2 * onX * onY * onZ
}
