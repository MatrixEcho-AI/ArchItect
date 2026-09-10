/** XZ 平面上的一个格坐标（水平面轮廓用）。 */
export interface Pos2 {
  x: number
  z: number
}

/** 多边形顶点的格坐标 → 稳定的打包键（支持负数），避免分配字符串。 */
const packKey = (x: number, z: number): number => (x + 0x8000) * 0x10000 + (z + 0x8000)

/**
 * 多边形覆盖的整数格（**含边界**）。
 *
 * 语义与 `fill_box` 一致：**顶点就是方块坐标**。所以矩形 `(0,0)-(4,4)` 覆盖 5×5 = 25 格，
 * 而不是格心采样给出的 4×4 = 16 格。
 *
 * 实现是「格心扫描线填充 ∪ 边线走格」：
 * 纯格心采样会漏掉恰好落在多边形边上的那一圈方块（对建筑来说那正是**墙**），
 * 所以必须把边界补回来。
 */
export function forEachPolygonFill(
  polygon: readonly Pos2[],
  visit: (x: number, z: number) => void,
): void {
  if (polygon.length < 3) return

  const emitted = new Set<number>()
  const emit = (x: number, z: number): void => {
    const key = packKey(x, z)
    if (emitted.has(key)) return
    emitted.add(key)
    visit(x, z)
  }

  // 1. 内部：格心扫描线
  let minZ = Number.POSITIVE_INFINITY
  let maxZ = Number.NEGATIVE_INFINITY
  for (const p of polygon) {
    if (p.z < minZ) minZ = p.z
    if (p.z > maxZ) maxZ = p.z
  }

  const crossings: number[] = []
  for (let z = minZ; z <= maxZ; z++) {
    const zc = z + 0.5
    crossings.length = 0
    for (let i = 0; i < polygon.length; i++) {
      const a = polygon[i]!
      const b = polygon[(i + 1) % polygon.length]!
      // 半开区间 [a.z, b.z)，顶点处不重复计数
      if ((a.z <= zc && b.z > zc) || (b.z <= zc && a.z > zc)) {
        const t = (zc - a.z) / (b.z - a.z)
        crossings.push(a.x + t * (b.x - a.x))
      }
    }
    crossings.sort((p, q) => p - q)
    for (let i = 0; i + 1 < crossings.length; i += 2) {
      const from = Math.ceil(crossings[i]! - 0.5)
      const to = Math.floor(crossings[i + 1]! - 0.5)
      for (let x = from; x <= to; x++) emit(x, z)
    }
  }

  // 2. 边界：补齐格心判定漏掉的边上的方块
  for (let i = 0; i < polygon.length; i++) {
    forEachLine2D(polygon[i]!, polygon[(i + 1) % polygon.length]!, emit)
  }
}

/** 多边形轮廓（闭合边上的整数格，已去重）。 */
export function forEachPolygonOutline(
  polygon: readonly Pos2[],
  visit: (x: number, z: number) => void,
): void {
  if (polygon.length === 0) return
  const seen = new Set<number>()
  const emit = (x: number, z: number): void => {
    // 用 32 位打包做去重键，避免分配字符串
    const key = ((x + 0x8000) << 16) | ((z + 0x8000) & 0xffff)
    if (seen.has(key)) return
    seen.add(key)
    visit(x, z)
  }
  for (let i = 0; i < polygon.length; i++) {
    const a = polygon[i]!
    const b = polygon[(i + 1) % polygon.length]!
    forEachLine2D(a, b, emit)
  }
}

/** 2D Bresenham（含两端点）。 */
export function forEachLine2D(
  from: Pos2,
  to: Pos2,
  visit: (x: number, z: number) => void,
): void {
  let x = from.x
  let z = from.z
  const dx = Math.abs(to.x - x)
  const dz = Math.abs(to.z - z)
  const sx = x < to.x ? 1 : -1
  const sz = z < to.z ? 1 : -1
  let error = dx - dz
  for (;;) {
    visit(x, z)
    if (x === to.x && z === to.z) break
    const doubled = 2 * error
    if (doubled > -dz) {
      error -= dz
      x += sx
    }
    if (doubled < dx) {
      error += dx
      z += sz
    }
  }
}

export interface ExtrudeOptions {
  /** 底面所在的 Y。 */
  baseY: number
  /** 挤出高度（格数，>= 1）。 */
  height: number
  /**
   * 只挤出多边形**轮廓**（做墙体），内部留空。
   * `false`（默认）挤出实心柱体。
   */
  hollow?: boolean
  /** 空心时是否封顶，默认 `true`。 */
  capTop?: boolean
  /** 空心时是否封底，默认 `true`。 */
  capBottom?: boolean
}

/**
 * 把 XZ 平面的多边形沿 **+Y 挤出**。
 *
 * 这是效率最高的一类工具：画一层平面图，直接长成建筑。
 * 想让建筑"有墙有地板有屋顶"，用 `hollow: true`（墙）+ `capBottom`/`capTop`（楼板/屋顶）。
 *
 * 只支持沿 Y 挤出——斜面和任意轴的情况用 `forEachPlane` / `forEachLine`。
 */
export function forEachExtrude(
  polygon: readonly Pos2[],
  options: ExtrudeOptions,
  visit: (x: number, y: number, z: number) => void,
): void {
  const height = Math.floor(options.height)
  if (polygon.length < 3 || height < 1) return

  const hollow = options.hollow === true
  const capTop = options.capTop !== false
  const capBottom = options.capBottom !== false

  const outline: Pos2[] = []
  const fill: Pos2[] = []
  forEachPolygonOutline(polygon, (x, z) => outline.push({ x, z }))
  if (!hollow || capTop || capBottom) {
    forEachPolygonFill(polygon, (x, z) => fill.push({ x, z }))
  }

  const topY = options.baseY + height - 1
  for (let y = options.baseY; y <= topY; y++) {
    const isCap = (y === options.baseY && capBottom) || (y === topY && capTop)
    const layer = hollow && !isCap ? outline : fill
    for (const p of layer) visit(p.x, y, p.z)
  }
}

/** 多边形的内格数（用于预算检查，不枚举）。 */
export function polygonFillCount(polygon: readonly Pos2[]): number {
  let count = 0
  forEachPolygonFill(polygon, () => count++)
  return count
}

/** 多边形轮廓的格数（用于预算检查，不枚举）。 */
export function polygonOutlineCount(polygon: readonly Pos2[]): number {
  let count = 0
  forEachPolygonOutline(polygon, () => count++)
  return count
}
