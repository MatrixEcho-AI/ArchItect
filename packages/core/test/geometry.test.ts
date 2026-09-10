import { describe, expect, it } from 'vitest'

import {
  boundsIntersect,
  boxCount,
  boxPositions,
  forEachBox,
  normalizeBounds,
} from '../src/geometry/box.js'
import { bresenham3D, linePositions } from '../src/geometry/line.js'
import { posKey } from '../src/types.js'
import type { BoxMode } from '../src/geometry/box.js'
import type { Pos } from '../src/types.js'

const key = (p: Pos): string => posKey(p)

describe('3D Bresenham 直线', () => {
  it('单点', () => {
    expect(bresenham3D({ x: 1, y: 2, z: 3 }, { x: 1, y: 2, z: 3 })).toEqual([{ x: 1, y: 2, z: 3 }])
  })

  it('轴对齐：n 格长产生 n+1 个点且严格共线', () => {
    const points = bresenham3D({ x: 0, y: 0, z: 0 }, { x: 5, y: 0, z: 0 })
    expect(points).toHaveLength(6)
    expect(points.every((p) => p.y === 0 && p.z === 0)).toBe(true)
    expect(points.map((p) => p.x)).toEqual([0, 1, 2, 3, 4, 5])
  })

  it('完美对角线：步数等于主分量', () => {
    const points = bresenham3D({ x: 0, y: 0, z: 0 }, { x: 15, y: 15, z: 15 })
    expect(points).toHaveLength(16)
    expect(points.every((p, i) => p.x === i && p.y === i && p.z === i)).toBe(true)
  })

  it('起点终点都在线上（端点必须命中）', () => {
    const cases: Array<[Pos, Pos]> = [
      [{ x: 0, y: 4, z: 0 }, { x: 15, y: 19, z: 15 }],
      [{ x: -3, y: 0, z: 7 }, { x: 9, y: 12, z: -5 }],
      [{ x: 0, y: 0, z: 0 }, { x: 1, y: 7, z: 2 }],
      [{ x: 5, y: 5, z: 5 }, { x: -5, y: -5, z: -5 }],
    ]
    for (const [from, to] of cases) {
      const points = bresenham3D(from, to)
      expect(key(points[0]!), `${key(from)}..${key(to)} 起点`).toBe(key(from))
      expect(key(points[points.length - 1]!), `${key(from)}..${key(to)} 终点`).toBe(key(to))
    }
  })

  it('反向走同一条线（点集相同）', () => {
    const forward = bresenham3D({ x: 0, y: 0, z: 0 }, { x: 15, y: 19, z: 15 })
    const backward = bresenham3D({ x: 15, y: 19, z: 15 }, { x: 0, y: 0, z: 0 })
    expect(new Set(backward.map(key))).toEqual(new Set(forward.map(key)))
  })

  it('相邻点必为 26-邻接（步长不超过 1 格）', () => {
    const points = bresenham3D({ x: 0, y: 0, z: 0 }, { x: 13, y: 5, z: -9 })
    for (let i = 1; i < points.length; i++) {
      const a = points[i - 1]!
      const b = points[i]!
      expect(Math.max(Math.abs(b.x - a.x), Math.abs(b.y - a.y), Math.abs(b.z - a.z))).toBe(1)
    }
  })
})

describe('对角批量填充：圆柱与收分', () => {
  const vertical = (radius: number, extra: Record<string, unknown> = {}): Pos[] =>
    linePositions({ x: 8, y: 0, z: 8 }, { x: 8, y: 20, z: 8 }, { radius, ...extra })
  /** y=10 处截面的 X 方向跨度（不是面积）。 */
  const width = (radius: number): number =>
    new Set(vertical(radius).filter((p) => p.y === 10).map((p) => p.x)).size
  /** y=10 处截面的格子数（圆盘面积）。 */
  const area = (radius: number): number => vertical(radius).filter((p) => p.y === 10).length

  it('radius=0 等价于纯直线', () => {
    expect(linePositions({ x: 0, y: 0, z: 0 }, { x: 4, y: 4, z: 4 })).toHaveLength(5)
    expect(width(0)).toBe(1)
  })

  it('整数 radius R 恰好给出 2R+1 格粗的柱体', () => {
    expect(width(1)).toBe(3)
    expect(width(2)).toBe(5)
    expect(width(3)).toBe(7)
  })

  it('截面是圆盘：R=1 是十字形（5 格），R=1.5 是 3x3（9 格）', () => {
    expect(area(1)).toBe(5)
    expect(area(1.5)).toBe(9)
    expect(area(2)).toBe(13)
    expect(area(1)).toBeLessThan(area(1.5))
    expect(area(1.5)).toBeLessThan(area(2))
  })

  it('taper 让半径沿轴单调收分（锥形塔尖）', () => {
    const points = linePositions({ x: 8, y: 0, z: 8 }, { x: 8, y: 20, z: 8 }, { taper: [3, 0] })
    const widthAt = (y: number): number =>
      new Set(points.filter((p) => p.y === y).map((p) => p.x)).size
    const widths = [0, 6, 12, 18, 20].map(widthAt)
    expect(widths[0]!).toBeGreaterThan(widths[2]!)
    expect(widths[2]!).toBeGreaterThan(widths[3]!)
    expect(widths[3]!).toBeGreaterThanOrEqual(widths[4]!)
  })

  it('hollow 只保留一格外壳', () => {
    const solid = vertical(3)
    const shell = vertical(3, { hollow: true })
    expect(shell.length).toBeLessThan(solid.length)
    const solidSet = new Set(solid.map(key))

    // 中段的中轴不在壳里；两端球冠上有，这是 capsule 的正确行为
    expect(shell.some((p) => p.x === 8 && p.z === 8 && p.y > 2 && p.y < 18)).toBe(false)

    // 壳上每格都必须至少有一个 6-邻域邻居落在实心体之外
    for (const p of shell) {
      const onSurface = [
        { x: p.x + 1, y: p.y, z: p.z },
        { x: p.x - 1, y: p.y, z: p.z },
        { x: p.x, y: p.y + 1, z: p.z },
        { x: p.x, y: p.y - 1, z: p.z },
        { x: p.x, y: p.y, z: p.z + 1 },
        { x: p.x, y: p.y, z: p.z - 1 },
      ].some((n) => !solidSet.has(key(n)))
      expect(onSurface, `${key(p)} 应当在实心体的表面上`).toBe(true)
    }
  })

  it('step 做稀疏采样（脚手架 / 栅栏柱）', () => {
    const all = vertical(0).length
    const sparse = linePositions({ x: 8, y: 0, z: 8 }, { x: 8, y: 20, z: 8 }, { step: 5 }).length
    expect(sparse).toBeLessThan(all)
    expect(sparse).toBeGreaterThan(1)
  })

  it('对角线圆柱是连通的（轴上的每一格都在集合里）', () => {
    const points = linePositions({ x: 0, y: 0, z: 0 }, { x: 20, y: 20, z: 20 }, { radius: 1 })
    const set = new Set(points.map(key))
    for (let i = 0; i <= 20; i++) {
      expect(set.has(posKey({ x: i, y: i, z: i })), `轴点 ${i}`).toBe(true)
    }
  })
})

describe('长方体填充', () => {
  it('solid 计数等于体积', () => {
    expect(boxPositions({ x: 0, y: 0, z: 0 }, { x: 3, y: 4, z: 5 }, 'solid')).toHaveLength(4 * 5 * 6)
  })

  it('角点顺序任意', () => {
    const a = boxPositions({ x: 5, y: 5, z: 5 }, { x: 0, y: 0, z: 0 })
    const b = boxPositions({ x: 0, y: 0, z: 0 }, { x: 5, y: 5, z: 5 })
    expect(new Set(a.map(key))).toEqual(new Set(b.map(key)))
  })

  it('boxCount 与真实枚举逐一吻合（含退化维度）', () => {
    const modes: BoxMode[] = ['solid', 'hollow', 'outline']
    for (let sx = 1; sx <= 5; sx++) {
      for (let sy = 1; sy <= 5; sy++) {
        for (let sz = 1; sz <= 5; sz++) {
          const from = { x: -2, y: 7, z: 3 }
          const to = { x: -2 + sx - 1, y: 7 + sy - 1, z: 3 + sz - 1 }
          for (const mode of modes) {
            let enumerated = 0
            forEachBox(from, to, mode, () => enumerated++)
            expect(boxCount(from, to, mode), `${sx}x${sy}x${sz} ${mode}`).toBe(enumerated)
          }
        }
      }
    }
  })

  it('hollow 的格子都在表面上，solid 的内部格不在其中', () => {
    const from = { x: 0, y: 0, z: 0 }
    const to = { x: 4, y: 4, z: 4 }
    const hollow = new Set(boxPositions(from, to, 'hollow').map(key))
    expect(hollow.has('0,0,0')).toBe(true)
    expect(hollow.has('4,4,4')).toBe(true)
    expect(hollow.has('2,2,2')).toBe(false) // 正中心
  })

  it('outline 只保留棱，面心不在其中', () => {
    const outline = new Set(
      boxPositions({ x: 0, y: 0, z: 0 }, { x: 4, y: 4, z: 4 }, 'outline').map(key),
    )
    expect(outline.has('0,0,0')).toBe(true) // 角
    expect(outline.has('2,0,0')).toBe(true) // 棱中
    expect(outline.has('2,2,0')).toBe(false) // 面心
    expect(outline.has('2,2,2')).toBe(false) // 体心
  })
})

describe('包围盒工具', () => {
  it('normalizeBounds 与 boundsIntersect', () => {
    const a = normalizeBounds({ x: 5, y: 5, z: 5 }, { x: 0, y: 0, z: 0 })
    expect(a).toEqual({ min: { x: 0, y: 0, z: 0 }, max: { x: 5, y: 5, z: 5 } })
    const b = normalizeBounds({ x: 3, y: 3, z: 3 }, { x: 9, y: 9, z: 9 })
    expect(boundsIntersect(a, b)).toEqual({ min: { x: 3, y: 3, z: 3 }, max: { x: 5, y: 5, z: 5 } })
    expect(
      boundsIntersect(a, normalizeBounds({ x: 6, y: 6, z: 6 }, { x: 7, y: 7, z: 7 })),
    ).toBeUndefined()
  })
})
