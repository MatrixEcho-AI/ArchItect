import type { Pos } from '../types.js'

export interface PlaneOptions {
  /**
   * 厚度（格）。默认 1 —— 刚好一层方块。
   * 判定用格心到平面的距离，所以 `thickness: 1` → 半厚 0.5，轴对齐时恰好一层。
   */
  thickness?: number
  /**
   * 限制在三角形 `p1p2p3` 内部。
   * `false`（默认）表示**充满三点包围盒的整片斜面**——做屋顶时这才是想要的。
   */
  triangle?: boolean
}

interface Vec3 {
  x: number
  y: number
  z: number
}

const sub = (a: Vec3, b: Vec3): Vec3 => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z })
const cross = (a: Vec3, b: Vec3): Vec3 => ({
  x: a.y * b.z - a.z * b.y,
  y: a.z * b.x - a.x * b.z,
  z: a.x * b.y - a.y * b.x,
})
const dot = (a: Vec3, b: Vec3): number => a.x * b.x + a.y * b.y + a.z * b.z
const length = (a: Vec3): number => Math.sqrt(dot(a, a))

/** 格心坐标。 */
const center = (p: Pos): Vec3 => ({ x: p.x + 0.5, y: p.y + 0.5, z: p.z + 0.5 })

/**
 * 三点确定的**任意斜面**——斜屋顶、斜撑、非轴对齐墙面。
 *
 * 平面过三个点的**格心**。默认行为是"把三点包围盒内的整片斜面填满"，
 * 而不是只填那个三角形——因为屋顶通常要盖住整个footprint。
 * 要三角形就传 `triangle: true`。
 *
 * 三点共线时抛错（无法确定平面）。
 */
export function forEachPlane(
  p1: Pos,
  p2: Pos,
  p3: Pos,
  options: PlaneOptions,
  visit: (x: number, y: number, z: number) => void,
): void {
  const a = center(p1)
  const b = center(p2)
  const c = center(p3)

  const normal = cross(sub(b, a), sub(c, a))
  const normalLength = length(normal)
  if (normalLength === 0) {
    throw new RangeError('The three points are collinear, cannot determine a plane')
  }

  const thickness = Math.max(1, options.thickness ?? 1)
  const half = thickness / 2

  // 区域严格限制在**三点的包围盒**内：平面是无限的，不裁剪就会铺满整个世界。
  // 厚度只影响法线方向，不用来扩张包围盒。
  const minX = Math.min(p1.x, p2.x, p3.x)
  const maxX = Math.max(p1.x, p2.x, p3.x)
  const minY = Math.min(p1.y, p2.y, p3.y)
  const maxY = Math.max(p1.y, p2.y, p3.y)
  const minZ = Math.min(p1.z, p2.z, p3.z)
  const maxZ = Math.max(p1.z, p2.z, p3.z)

  const wantTriangle = options.triangle === true

  for (let x = minX; x <= maxX; x++) {
    for (let y = minY; y <= maxY; y++) {
      for (let z = minZ; z <= maxZ; z++) {
        const p = center({ x, y, z })
        const distance = Math.abs(dot(normal, sub(p, a))) / normalLength
        if (distance > half) continue
        if (wantTriangle && !insideTriangle(p, a, b, c, normal)) continue
        visit(x, y, z)
      }
    }
  }
}

/** 点是否落在三角形内（含边界）。用三条边的叉积同号判定。 */
function insideTriangle(p: Vec3, a: Vec3, b: Vec3, c: Vec3, normal: Vec3): boolean {
  const s1 = dot(cross(sub(b, a), sub(p, a)), normal)
  const s2 = dot(cross(sub(c, b), sub(p, b)), normal)
  const s3 = dot(cross(sub(a, c), sub(p, c)), normal)
  const allNonNegative = s1 >= 0 && s2 >= 0 && s3 >= 0
  const allNonPositive = s1 <= 0 && s2 <= 0 && s3 <= 0
  return allNonNegative || allNonPositive
}

/** 把方向向量归一化成"从 from 看 to 的单位方向"，供 `raycast` 之类的工具复用。 */
export function direction(from: Pos, to: Pos): Vec3 {
  const d = sub(center(to), center(from))
  const len = length(d)
  return len === 0 ? { x: 0, y: 0, z: 0 } : { x: d.x / len, y: d.y / len, z: d.z / len }
}
