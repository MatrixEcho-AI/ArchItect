import type { Pos } from '../types.js'

export interface LineOptions {
  /** 0（默认）= 单格粗的线；> 0 时生成以该线为轴、半径 radius 的圆柱。 */
  radius?: number
  /**
   * 半径沿线插值 `[起点半径, 终点半径]`，覆盖 `radius`。
   * 用于做锥形（塔尖、尖顶、树干收分）：`taper: [3, 0]`。
   */
  taper?: readonly [number, number]
  /** 沿线每隔 step 格采样一次（脚手架、栅栏柱）。默认 1。 */
  step?: number
  /** 只保留外壳（半径 > 0 时有效）。 */
  hollow?: boolean
}

/** 逐格访问 3D Bresenham 直线上的整数格。 */
export function forEachBresenham(
  from: Pos,
  to: Pos,
  visit: (x: number, y: number, z: number) => void,
): void {
  let x = from.x
  let y = from.y
  let z = from.z
  const dx = Math.abs(to.x - x)
  const dy = Math.abs(to.y - y)
  const dz = Math.abs(to.z - z)
  const sx = x < to.x ? 1 : -1
  const sy = y < to.y ? 1 : -1
  const sz = z < to.z ? 1 : -1

  if (dx >= dy && dx >= dz) {
    let p1 = 2 * dy - dx
    let p2 = 2 * dz - dx
    for (;;) {
      visit(x, y, z)
      if (x === to.x) break
      if (p1 >= 0) {
        y += sy
        p1 -= 2 * dx
      }
      if (p2 >= 0) {
        z += sz
        p2 -= 2 * dx
      }
      p1 += 2 * dy
      p2 += 2 * dz
      x += sx
    }
    return
  }
  if (dy >= dx && dy >= dz) {
    let p1 = 2 * dx - dy
    let p2 = 2 * dz - dy
    for (;;) {
      visit(x, y, z)
      if (y === to.y) break
      if (p1 >= 0) {
        x += sx
        p1 -= 2 * dy
      }
      if (p2 >= 0) {
        z += sz
        p2 -= 2 * dy
      }
      p1 += 2 * dx
      p2 += 2 * dz
      y += sy
    }
    return
  }
  let p1 = 2 * dy - dz
  let p2 = 2 * dx - dz
  for (;;) {
    visit(x, y, z)
    if (z === to.z) break
    if (p1 >= 0) {
      y += sy
      p1 -= 2 * dz
    }
    if (p2 >= 0) {
      x += sx
      p2 -= 2 * dz
    }
    p1 += 2 * dy
    p2 += 2 * dx
    z += sz
  }
}

/** 直线上的整数格。 */
export function bresenham3D(from: Pos, to: Pos): Pos[] {
  const points: Pos[] = []
  forEachBresenham(from, to, (x, y, z) => points.push({ x, y, z }))
  return points
}

interface Segment {
  x0: number
  y0: number
  z0: number
  dx: number
  dy: number
  dz: number
  lengthSq: number
  length: number
}

function makeSegment(from: Pos, to: Pos): Segment {
  const dx = to.x - from.x
  const dy = to.y - from.y
  const dz = to.z - from.z
  const lengthSq = dx * dx + dy * dy + dz * dz
  return { x0: from.x, y0: from.y, z0: from.z, dx, dy, dz, lengthSq, length: Math.sqrt(lengthSq) }
}

/**
 * 点 `(x,y,z)` 到线段的距离，以及在线段上的归一化投影参数 `t ∈ [0,1]`。
 * 距离按**格心**计算（点坐标 +0.5），这样对称的圆柱不会偏一格。
 */
function distanceToSegment(
  segment: Segment,
  x: number,
  y: number,
  z: number,
): { distance: number; t: number } {
  const px = x + 0.5 - (segment.x0 + 0.5)
  const py = y + 0.5 - (segment.y0 + 0.5)
  const pz = z + 0.5 - (segment.z0 + 0.5)
  if (segment.lengthSq === 0) {
    return { distance: Math.sqrt(px * px + py * py + pz * pz), t: 0 }
  }
  const t = Math.max(0, Math.min(1, (px * segment.dx + py * segment.dy + pz * segment.dz) / segment.lengthSq))
  const cx = segment.dx * t - px
  const cy = segment.dy * t - py
  const cz = segment.dz * t - pz
  return { distance: Math.sqrt(cx * cx + cy * cy + cz * cz), t }
}

/**
 * 直线 / 圆柱上的整数格。
 *
 * `radius === 0` 时退化为纯 Bresenham 直线（此时 `taper` 无意义）。
 * `radius > 0` 时以线为轴生成圆柱，半径按 `taper` 沿参数 t 线性插值。
 * `hollow` 只保留一格外壳。
 */
export function linePositions(from: Pos, to: Pos, options: LineOptions = {}): Pos[] {
  const points: Pos[] = []
  forEachLine(from, to, options, (x, y, z) => points.push({ x, y, z }))
  return points
}

/** `linePositions` 的零分配版本。 */
export function forEachLine(
  from: Pos,
  to: Pos,
  options: LineOptions,
  visit: (x: number, y: number, z: number) => void,
): void {
  const step = Math.max(1, Math.floor(options.step ?? 1))
  const radiusStart = options.taper !== undefined ? options.taper[0] : (options.radius ?? 0)
  const radiusEnd = options.taper !== undefined ? options.taper[1] : (options.radius ?? 0)

  if (radiusStart <= 0 && radiusEnd <= 0) {
    let index = 0
    forEachBresenham(from, to, (x, y, z) => {
      if (index % step === 0) visit(x, y, z)
      index++
    })
    return
  }

  const segment = makeSegment(from, to)
  const maxRadius = Math.max(radiusStart, radiusEnd)
  const pad = Math.ceil(maxRadius) + 1

  // 半径沿 t 的插值函数
  const radiusAt = (t: number): number => radiusStart + (radiusEnd - radiusStart) * t
  const inside = (x: number, y: number, z: number): boolean => {
    const { distance, t } = distanceToSegment(segment, x, y, z)
    return distance <= radiusAt(t)
  }

  const minX = Math.min(from.x, to.x) - pad
  const maxX = Math.max(from.x, to.x) + pad
  const minY = Math.min(from.y, to.y) - pad
  const maxY = Math.max(from.y, to.y) + pad
  const minZ = Math.min(from.z, to.z) - pad
  const maxZ = Math.max(from.z, to.z) + pad

  const sampled = step > 1

  for (let x = minX; x <= maxX; x++) {
    for (let y = minY; y <= maxY; y++) {
      for (let z = minZ; z <= maxZ; z++) {
        if (!inside(x, y, z)) continue
        if (options.hollow === true) {
          const shellOnly =
            !inside(x + 1, y, z) ||
            !inside(x - 1, y, z) ||
            !inside(x, y + 1, z) ||
            !inside(x, y - 1, z) ||
            !inside(x, y, z + 1) ||
            !inside(x, y, z - 1)
          if (!shellOnly) continue
        }
        if (sampled && segment.length > 0) {
          const { t } = distanceToSegment(segment, x, y, z)
          if (Math.floor(t * segment.length) % step !== 0) continue
        }
        visit(x, y, z)
      }
    }
  }
}
