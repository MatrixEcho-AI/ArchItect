import { describe, expect, it } from 'vitest'

import { forEachPlane } from '../src/geometry/plane.js'
import {
  forEachExtrude,
  forEachPolygonFill,
  forEachPolygonOutline,
  polygonFillCount,
  polygonOutlineCount,
} from '../src/geometry/polygon.js'
import { posKey } from '../src/types.js'
import type { Pos2 } from '../src/geometry/polygon.js'
import type { Pos } from '../src/types.js'

const key = (p: { x: number; y?: number; z: number }): string => posKey({ x: p.x, y: p.y ?? 0, z: p.z })
const collect = (fn: (visit: (x: number, z: number) => void) => void): Set<string> => {
  const out = new Set<string>()
  fn((x, z) => out.add(key({ x, z })))
  return out
}
const collect3 = (fn: (visit: (x: number, y: number, z: number) => void) => void): Set<string> => {
  const out = new Set<string>()
  fn((x, y, z) => out.add(posKey({ x, y, z })))
  return out
}

const rect = (x0: number, z0: number, x1: number, z1: number): Pos2[] => [
  { x: x0, z: z0 },
  { x: x1, z: z0 },
  { x: x1, z: z1 },
  { x: x0, z: z1 },
]

const L_SHAPE: Pos2[] = [
  { x: 0, z: 0 },
  { x: 4, z: 0 },
  { x: 4, z: 2 },
  { x: 2, z: 2 },
  { x: 2, z: 4 },
  { x: 0, z: 4 },
]

describe('多边形扫描线填充', () => {
  it('矩形填满', () => {
    expect(collect((v) => forEachPolygonFill(rect(0, 0, 4, 4), v)).size).toBe(25)
  })

  it('凸多边形（三角形）', () => {
    const triangle: Pos2[] = [
      { x: 0, z: 0 },
      { x: 4, z: 0 },
      { x: 0, z: 4 },
    ]
    // 直角边 4 的等腰直角三角形，按格心判定
    const filled = collect((v) => forEachPolygonFill(triangle, v))
    expect(filled.size).toBeGreaterThan(0)
    expect(filled.size).toBeLessThan(25)
    expect(filled.has('0,0,0')).toBe(true) // 直角顶点
  })

  it('凹多边形（L 形）不会把缺口填上', () => {
    const filled = collect((v) => forEachPolygonFill(L_SHAPE, v))
    // 含边界：12 格内部 + 9 格边线 = 21
    expect(filled.size).toBe(21)
    expect(filled.has('3,0,3')).toBe(false) // 缺口内部
    expect(filled.has('0,0,0')).toBe(true) // 角
    expect(filled.has('3,0,0')).toBe(true) // 底边
    expect(filled.has('1,0,3')).toBe(true) // 竖臂
    expect(filled.has('3,0,2')).toBe(true) // 落在凹角边上，算覆盖
  })

  it('点数不足 3 不产生任何格', () => {
    expect(collect((v) => forEachPolygonFill([{ x: 0, z: 0 }, { x: 3, z: 3 }], v)).size).toBe(0)
  })

  it('polygonFillCount 与真实枚举一致', () => {
    expect(polygonFillCount(rect(0, 0, 4, 4))).toBe(25)
    expect(polygonFillCount(L_SHAPE)).toBe(21)
    expect(polygonFillCount(rect(-3, -2, 3, 2))).toBe(7 * 5)
  })
})

describe('多边形轮廓', () => {
  it('矩形轮廓是周长格数', () => {
    expect(collect((v) => forEachPolygonOutline(rect(0, 0, 4, 4), v)).size).toBe(16)
  })

  it('轮廓是闭合的：四个角都在', () => {
    const outline = collect((v) => forEachPolygonOutline(rect(0, 0, 4, 4), v))
    for (const corner of ['0,0,0', '4,0,0', '4,0,4', '0,0,4']) {
      expect(outline.has(corner), corner).toBe(true)
    }
  })

  it('轮廓不含内部格', () => {
    const outline = collect((v) => forEachPolygonOutline(rect(0, 0, 4, 4), v))
    expect(outline.has('2,0,2')).toBe(false)
  })

  it('polygonOutlineCount 与真实枚举一致', () => {
    expect(polygonOutlineCount(rect(0, 0, 4, 4))).toBe(16)
    expect(polygonOutlineCount(L_SHAPE)).toBe(
      collect((v) => forEachPolygonOutline(L_SHAPE, v)).size,
    )
  })
})

describe('挤出（extrude）', () => {
  it('实心柱体 = 截面积 × 高度', () => {
    const cells = collect3((v) => forEachExtrude(rect(0, 0, 4, 4), { baseY: 0, height: 3 }, v))
    expect(cells.size).toBe(25 * 3)
  })

  it('height=1 只出一层地面', () => {
    const cells = collect3((v) => forEachExtrude(rect(0, 0, 4, 4), { baseY: 0, height: 1 }, v))
    expect(cells.size).toBe(25)
    expect([...cells].every((k) => k.split(',')[1] === '0')).toBe(true)
  })

  it('空心 + 封顶封底 = 墙 + 楼板 + 屋顶', () => {
    const cells = collect3((v) =>
      forEachExtrude(rect(0, 0, 4, 4), { baseY: 0, height: 3, hollow: true }, v),
    )
    expect(cells.size).toBe(25 + 16 + 25) // 底 + 墙 + 顶
    // 中段内部是空的
    expect(cells.has('2,1,2')).toBe(false)
    // 中段墙上有格
    expect(cells.has('0,1,0')).toBe(true)
  })

  it('空心 + 不封顶封底 = 纯墙体', () => {
    const cells = collect3((v) =>
      forEachExtrude(rect(0, 0, 4, 4), {
        baseY: 0,
        height: 3,
        hollow: true,
        capTop: false,
        capBottom: false,
      }, v),
    )
    expect(cells.size).toBe(16 * 3)
    expect(cells.has('2,0,2')).toBe(false)
  })

  it('baseY 生效：从指定高度开始', () => {
    const cells = collect3((v) => forEachExtrude(rect(0, 0, 1, 1), { baseY: 10, height: 2 }, v))
    expect(cells.size).toBe(4 * 2)
    expect([...cells].every((k) => ['10', '11'].includes(k.split(',')[1]!))).toBe(true)
  })

  it('L 形挤出会保留缺口（不是把它填成方形）', () => {
    const cells = collect3((v) => forEachExtrude(L_SHAPE, { baseY: 0, height: 2 }, v))
    expect(cells.size).toBe(21 * 2)
    expect(cells.has('3,0,3')).toBe(false)
    expect(cells.has('3,1,3')).toBe(false)
  })

  it('高度 <= 0 不产出', () => {
    expect(collect3((v) => forEachExtrude(rect(0, 0, 4, 4), { baseY: 0, height: 0 }, v)).size).toBe(0)
    expect(collect3((v) => forEachExtrude(rect(0, 0, 4, 4), { baseY: 0, height: -3 }, v)).size).toBe(0)
  })

  it('点数不足 3 不产出；零面积多边形退化成轮廓', () => {
    expect(
      collect3((v) => forEachExtrude([{ x: 0, z: 0 }, { x: 3, z: 3 }], { baseY: 0, height: 3 }, v)).size,
    ).toBe(0)
    // 四个重合的点没有面积，只剩轮廓那一格 × 高度
    expect(collect3((v) => forEachExtrude(rect(0, 0, 0, 0), { baseY: 0, height: 2 }, v)).size).toBe(2)
  })
})

describe('任意斜面（fill_plane）', () => {
  const collectPlane = (
    p1: Pos,
    p2: Pos,
    p3: Pos,
    options: { thickness?: number; triangle?: boolean } = {},
  ): Set<string> => collect3((v) => forEachPlane(p1, p2, p3, options, v))

  it('轴对齐水平面 = 包围盒内的一层', () => {
    const cells = collectPlane({ x: 0, y: 5, z: 0 }, { x: 4, y: 5, z: 0 }, { x: 0, y: 5, z: 4 })
    expect(cells.size).toBe(5 * 5)
    expect([...cells].every((k) => k.split(',')[1] === '5')).toBe(true)
  })

  it('垂直面', () => {
    const cells = collectPlane({ x: 3, y: 0, z: 0 }, { x: 3, y: 4, z: 0 }, { x: 3, y: 0, z: 4 })
    expect(cells.size).toBe(5 * 5)
    expect([...cells].every((k) => k.startsWith('3,'))).toBe(true)
  })

  it('45 度斜面 y=z 在包围盒内铺开', () => {
    const cells = collectPlane({ x: 0, y: 0, z: 0 }, { x: 0, y: 5, z: 5 }, { x: 10, y: 0, z: 0 })
    expect(cells.size).toBeGreaterThan(0)
    // 每个格都应当近似满足 y ≈ z（格心意义下）
    for (const k of cells) {
      const [x, y, z] = k.split(',').map(Number) as [number, number, number]
      expect(Math.abs(y - z), `(${x},${y},${z})`).toBeLessThanOrEqual(1)
    }
  })

  it('thickness 变厚会包含更多格', () => {
    const p1 = { x: 0, y: 0, z: 0 }
    const p2 = { x: 0, y: 5, z: 5 }
    const p3 = { x: 10, y: 0, z: 0 }
    const thin = collectPlane(p1, p2, p3, { thickness: 1 })
    const thick = collectPlane(p1, p2, p3, { thickness: 3 })
    expect(thick.size).toBeGreaterThan(thin.size)
  })

  it('triangle:true 严格少于整片斜面', () => {
    const p1 = { x: 0, y: 0, z: 0 }
    const p2 = { x: 4, y: 0, z: 0 }
    const p3 = { x: 0, y: 0, z: 4 }
    const slab = collectPlane(p1, p2, p3)
    const tri = collectPlane(p1, p2, p3, { triangle: true })
    expect(tri.size).toBeLessThan(slab.size)
    expect(slab.size).toBe(5 * 5)
    // 三角形之外的点不该出现
    expect(tri.has(posKey({ x: 4, y: 0, z: 4 }))).toBe(false)
  })

  it('三点共线抛错', () => {
    expect(() =>
      collectPlane({ x: 0, y: 0, z: 0 }, { x: 1, y: 1, z: 1 }, { x: 2, y: 2, z: 2 }),
    ).toThrow(/collinear/)
  })
})
