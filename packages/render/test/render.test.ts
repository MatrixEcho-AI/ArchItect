import { forEachBox, forEachExtrude, forEachLine, forEachPlane, WorldStore } from '@architect/core'
import type { Bounds } from '@architect/core'
import { describe, expect, it } from 'vitest'

import {
  basisFromAngles,
  cameraBasis,
  clampFreeElevation,
  fitCamera,
  fitPerspective,
  presetAngles,
  projectPoint,
  VIEW_PRESETS,
} from '../src/camera.js'
import { screenRay } from '../src/pick.js'
import { Canvas, encodePng } from '../src/canvas.js'
import { createFallbackColorResolver, fallbackAppearance } from '../src/colors.js'
import { renderIsometric } from '../src/isometric.js'
import { averageColor, decodeBase64, decodePng, PngError } from '../src/png.js'

const BG = { r: 26, g: 28, b: 34 }
const volume: Bounds = { min: { x: 0, y: 0, z: 0 }, max: { x: 15, y: 15, z: 15 } }
const makeStore = (): WorldStore => new WorldStore({ minecraftVersion: '1.21.4', volume })

/** 非背景像素的包围盒。 */
function contentBox(canvas: Canvas): { minX: number; maxX: number; minY: number; maxY: number } {
  let minX = canvas.width
  let maxX = -1
  let minY = canvas.height
  let maxY = -1
  for (let y = 0; y < canvas.height; y++) {
    for (let x = 0; x < canvas.width; x++) {
      const o = (y * canvas.width + x) * 4
      if (
        canvas.data[o] !== BG.r ||
        canvas.data[o + 1] !== BG.g ||
        canvas.data[o + 2] !== BG.b
      ) {
        if (x < minX) minX = x
        if (x > maxX) maxX = x
        if (y < minY) minY = y
        if (y > maxY) maxY = y
      }
    }
  }
  return { minX, maxX, minY, maxY }
}

describe('base64 解码', () => {
  it('与 Node Buffer 逐字节一致（回归：累加器高位未清）', () => {
    const cases = [
      'aGVsbG8=',
      'aGVsbG8gd29ybGQ=',
      'iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAAAAAA6mKC9AAAAZElEQVR42jWNsQ0AMQjEGJcB3HsEr/xSkncBOgkfUyXIguoo4mEXGdkFFvBdlGmpwKCAWIWOeYFladCK4n2BXZZn6vR3dsXRfLnKWfFoXmtUrX81AiboaZ9u4I1G8KdqPICl6AdyLn2NfcJFIAAAAABJRU5ErkJggg==',
      'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=',
    ]
    for (const input of cases) {
      const mine = decodeBase64(input)
      const theirs = new Uint8Array(Buffer.from(input, 'base64'))
      expect(mine.length, input.slice(0, 16)).toBe(theirs.length)
      expect([...mine]).toEqual([...theirs])
    }
  })

  it('长输入不会在 32 位溢出处出错', () => {
    const raw = new Uint8Array(4096)
    for (let i = 0; i < raw.length; i++) raw[i] = (i * 37) & 0xff
    const b64 = Buffer.from(raw).toString('base64')
    expect([...decodeBase64(b64)]).toEqual([...raw])
  })
})

describe('PNG 编解码', () => {
  it('encodePng → decodePng 逐像素一致', () => {
    const canvas = new Canvas(37, 23)
    for (let i = 0; i < 37 * 23; i++) {
      canvas.data[i * 4] = (i * 7) & 0xff
      canvas.data[i * 4 + 1] = (i * 13) & 0xff
      canvas.data[i * 4 + 2] = (i * 29) & 0xff
      canvas.data[i * 4 + 3] = 255
    }
    const decoded = decodePng(encodePng(canvas))
    expect(decoded.width).toBe(37)
    expect(decoded.height).toBe(23)
    expect([...decoded.data]).toEqual([...canvas.data])
  })

  it('拒绝非 PNG 输入', () => {
    expect(() => decodePng(new Uint8Array(64))).toThrow(PngError)
    expect(() => decodePng(new Uint8Array(64))).toThrow(/signature/)
  })

  it('拒绝截断的 PNG', () => {
    const canvas = new Canvas(8, 8)
    const png = encodePng(canvas)
    expect(() => decodePng(png.subarray(0, 20))).toThrow()
  })

  it('averageColor 排除全透明像素', () => {
    const image = { width: 2, height: 1, data: new Uint8Array([255, 0, 0, 255, 0, 255, 0, 0]) }
    const average = averageColor(image)
    expect(average).toEqual({ r: 255, g: 0, b: 0, alpha: 128 })
  })

  it('averageColor 对全透明图像返回 alpha 0', () => {
    const image = { width: 1, height: 1, data: new Uint8Array([10, 20, 30, 0]) }
    expect(averageColor(image).alpha).toBe(0)
  })
})

describe('Canvas', () => {
  it('填充凸多边形', () => {
    const canvas = new Canvas(16, 16, { r: 0, g: 0, b: 0 })
    canvas.fillConvexPolygon(
      [
        { x: 2, y: 2 },
        { x: 10, y: 2 },
        { x: 10, y: 10 },
        { x: 2, y: 10 },
      ],
      { r: 255, g: 0, b: 0 },
    )
    const at = (x: number, y: number): number => canvas.data[(y * 16 + x) * 4]!
    expect(at(5, 5)).toBe(255)
    expect(at(1, 1)).toBe(0)
    expect(at(11, 11)).toBe(0)
  })

  it('alpha 混合', () => {
    const canvas = new Canvas(1, 1, { r: 0, g: 0, b: 0 })
    canvas.blend(0, 0, { r: 255, g: 255, b: 255 }, 0.5)
    expect(canvas.data[0]).toBe(128)
  })

  it('画线段', () => {
    const canvas = new Canvas(8, 8, { r: 0, g: 0, b: 0 })
    canvas.drawLine(0, 0, 7, 7, { r: 255, g: 255, b: 255 })
    for (let i = 0; i < 8; i++) expect(canvas.data[(i * 8 + i) * 4]).toBe(255)
  })
})

describe('相机', () => {
  it('预设角度符合约定（0 度 = 从 +Z 看向 -Z，90 度 = 正俯视）', () => {
    expect(VIEW_PRESETS.front).toEqual({ azimuth: 0, elevation: 0 })
    expect(VIEW_PRESETS.top.elevation).toBe(90)
    expect(() => presetAngles('nope' as never)).toThrow(/Unknown camera preset/)
  })

  it('正视图的基向量正确', () => {
    const basis = cameraBasis({ target: { x: 0, y: 0, z: 0 }, azimuth: 0, elevation: 0, scale: 1, width: 100, height: 100 })
    expect(basis.right.x).toBeCloseTo(1)
    expect(basis.up.y).toBeCloseTo(1)
    expect(basis.forward.z).toBeCloseTo(-1) // 看向 -Z
  })

  it('俯视图的 forward 指向 -Y', () => {
    const basis = cameraBasis({ target: { x: 0, y: 0, z: 0 }, azimuth: 0, elevation: 90, scale: 1, width: 100, height: 100 })
    expect(basis.forward.y).toBeCloseTo(-1)
  })

  it('注视点投影到画布中心', () => {
    const cam = { target: { x: 5, y: 5, z: 5 }, azimuth: 45, elevation: 30, scale: 10, width: 200, height: 100 }
    const p = projectPoint(cam.target, cam, cameraBasis(cam))
    expect(p.x).toBeCloseTo(100)
    expect(p.y).toBeCloseTo(50)
  })

  it('**沿视线挪动画面中心不改成像**（自由相机的整套换算都建立在这一条上）', () => {
    const spec = (target: { x: number; y: number; z: number }) => ({
      target,
      azimuth: 35,
      elevation: 20,
      scale: 4,
      width: 200,
      height: 120,
    })
    const camera = spec({ x: 8, y: 6, z: 8 })
    const forward = cameraBasis(camera).forward
    // 沿视线挪 1000 格：屏幕坐标逐点相同，只有深度不同
    const shifted = spec({
      x: 8 + forward.x * 1000,
      y: 6 + forward.y * 1000,
      z: 8 + forward.z * 1000,
    })
    for (const point of [
      { x: 0, y: 0, z: 0 },
      { x: 15, y: 9, z: 3 },
      { x: -4, y: 30, z: 12 },
    ]) {
      const a = projectPoint(point, camera, cameraBasis(camera))
      const b = projectPoint(point, shifted, cameraBasis(shifted))
      expect(b.x).toBeCloseTo(a.x, 6)
      expect(b.y).toBeCloseTo(a.y, 6)
    }
  })

  it('交互相机允许抬头（负仰角），但夹在 ±89', () => {
    expect(clampFreeElevation(-40)).toBe(-40)
    expect(clampFreeElevation(120)).toBe(89)
    expect(clampFreeElevation(-120)).toBe(-89)
    // 抬头时 up 仍然是"往上的"（画面不会翻个个儿）
    const { forward, up } = basisFromAngles(0, -45)
    expect(forward.y).toBeGreaterThan(0)
    expect(up.y).toBeGreaterThan(0)
  })

  it('**透视投影：近大远小、在相机后面交回 NaN**', () => {
    const view = { eye: { x: 0, y: 0, z: 10 }, fov: 70 }
    const spec = {
      target: { x: 0, y: 0, z: 0 },
      azimuth: 0,
      elevation: 0,
      scale: 1,
      width: 400,
      height: 200,
      perspective: view,
    }
    const basis = cameraBasis(spec)
    // 视线正前方（az=0/el=0 → 看向 -Z）的点落在画面正中
    const centre = projectPoint({ x: 0, y: 0, z: 0 }, spec, basis)
    expect(centre.x).toBeCloseTo(200, 9)
    expect(centre.y).toBeCloseTo(100, 9)
    expect(centre.depth).toBeCloseTo(10, 9)

    // 同样的横向偏移，距离翻倍 → 屏幕偏移减半（这就是"近大远小"）
    const near = projectPoint({ x: 1, y: 0, z: 5 }, spec, basis) // 深度 5
    const far = projectPoint({ x: 1, y: 0, z: 0 }, spec, basis) // 深度 10
    expect(near.x - 200).toBeCloseTo(2 * (far.x - 200), 6)

    // 相机后面：除以负数会翻到另一侧，所以这里必须交回无效点
    const behind = projectPoint({ x: 0, y: 0, z: 20 }, spec, basis)
    expect(Number.isNaN(behind.x)).toBe(true)
    expect(behind.depth).toBeLessThan(0)
  })

  it('**透视的屏幕射线是"从相机出发穿过那个像素"**（投影→拾取的往返）', () => {
    const spec = {
      target: { x: 0, y: 0, z: 0 },
      azimuth: 35,
      elevation: 20,
      scale: 1,
      width: 400,
      height: 200,
      perspective: { eye: { x: 12, y: 8, z: 12 }, fov: 70 },
    }
    const basis = cameraBasis(spec)
    const point = { x: 3, y: 4, z: 5 }
    const projected = projectPoint(point, spec, basis)
    const ray = screenRay(spec, projected.x, projected.y)
    // 起点就是相机位置
    expect(ray.origin).toEqual(spec.perspective.eye)
    // 方向与"相机 → 那个点"同向
    const to = {
      x: point.x - ray.origin.x,
      y: point.y - ray.origin.y,
      z: point.z - ray.origin.z,
    }
    const length = Math.hypot(to.x, to.y, to.z)
    expect(ray.direction.x).toBeCloseTo(to.x / length, 6)
    expect(ray.direction.y).toBeCloseTo(to.y / length, 6)
    expect(ray.direction.z).toBeCloseTo(to.z / length, 6)
  })

  it('**fitPerspective 真的把包围盒框进画面**（八个角点都在画面内）', () => {
    const box: Bounds = { min: { x: 2, y: 0, z: 2 }, max: { x: 13, y: 13, z: 13 } }
    for (const [width, height] of [
      [240, 180],
      [180, 240],
      [400, 120],
    ] as const) {
      for (const angles of [
        { azimuth: 45, elevation: 30 },
        { azimuth: 0, elevation: 5 },
        { azimuth: 135, elevation: 70 },
      ]) {
        const spec = fitPerspective(box, angles, { fov: 70, width, height })
        const basis = cameraBasis(spec)
        for (let i = 0; i < 8; i++) {
          const corner = {
            x: (i & 1) === 0 ? box.min.x : box.max.x + 1,
            y: (i & 2) === 0 ? box.min.y : box.max.y + 1,
            z: (i & 4) === 0 ? box.min.z : box.max.z + 1,
          }
          const p = projectPoint(corner, spec, basis)
          const where = `${width}x${height} az${angles.azimuth}/el${angles.elevation} 角点 ${i}`
          expect(Number.isFinite(p.x), `${where} 在相机后面`).toBe(true)
          expect(p.x, `${where} 横着出画`).toBeGreaterThanOrEqual(0)
          expect(p.x, `${where} 横着出画`).toBeLessThanOrEqual(width)
          expect(p.y, `${where} 竖着出画`).toBeGreaterThanOrEqual(0)
          expect(p.y, `${where} 竖着出画`).toBeLessThanOrEqual(height)
        }
      }
    }
  })

  it('fitCamera 留出边距且内容不贴边（回归：Math.max 吃掉了 margin）', () => {
    const bounds: Bounds = { min: { x: 2, y: 0, z: 2 }, max: { x: 13, y: 13, z: 13 } }
    const W = 240
    const H = 180
    for (const preset of ['iso_ne', 'front', 'left', 'top'] as const) {
      const cam = fitCamera(bounds, presetAngles(preset), W, H)
      const basis = cameraBasis(cam)
      let minX = Number.POSITIVE_INFINITY
      let maxX = Number.NEGATIVE_INFINITY
      let minY = Number.POSITIVE_INFINITY
      let maxY = Number.NEGATIVE_INFINITY
      for (let i = 0; i < 8; i++) {
        const corner = {
          x: (i & 1) === 0 ? bounds.min.x : bounds.max.x + 1,
          y: (i & 2) === 0 ? bounds.min.y : bounds.max.y + 1,
          z: (i & 4) === 0 ? bounds.min.z : bounds.max.z + 1,
        }
        const p = projectPoint(corner, cam, basis)
        minX = Math.min(minX, p.x)
        maxX = Math.max(maxX, p.x)
        minY = Math.min(minY, p.y)
        maxY = Math.max(maxY, p.y)
      }
      expect(minX, `${preset} 左`).toBeGreaterThan(0)
      expect(maxX, `${preset} 右`).toBeLessThan(W)
      expect(minY, `${preset} 上`).toBeGreaterThan(0)
      expect(maxY, `${preset} 下`).toBeLessThan(H)
    }
  })

  it('fitCamera 的 margin 参数生效', () => {
    const bounds: Bounds = { min: { x: 0, y: 0, z: 0 }, max: { x: 9, y: 9, z: 9 } }
    const tight = fitCamera(bounds, presetAngles('iso_ne'), 200, 200, 0.01)
    const loose = fitCamera(bounds, presetAngles('iso_ne'), 200, 200, 0.3)
    expect(loose.scale).toBeLessThan(tight.scale)
  })
})

describe('等轴测渲染', () => {
  const smallHouse = (): WorldStore => {
    const store = makeStore()
    const rect = [
      { x: 2, z: 2 },
      { x: 9, z: 2 },
      { x: 9, z: 9 },
      { x: 2, z: 9 },
    ]
    store.write((v) => forEachExtrude(rect, { baseY: 0, height: 1 }, v), store.palette.indexOf('minecraft:oak_planks'), { confirm: true })
    store.write(
      (v) => forEachExtrude(rect, { baseY: 1, height: 3, hollow: true, capTop: false, capBottom: false }, v),
      store.palette.indexOf('minecraft:stone_bricks'),
      { confirm: true },
    )
    store.write((v) => forEachBox({ x: 5, y: 1, z: 2 }, { x: 5, y: 2, z: 2 }, 'solid', v), 0, {
      mode: 'destroy',
      confirm: true,
    })
    return store
  }

  // 本文件测的是**渲染器本身**（取景、剔除、光照），所以关掉叠加层：
  // 标尺会刻意超出内容包围盒，混进来会干扰"模型是否贴边"这类断言。
  // 叠加层有自己的 overlay.test.ts。
  const render = (store: WorldStore, preset: 'iso_ne' | 'front' | 'top' = 'iso_ne'): ReturnType<typeof renderIsometric> => {
    const bounds = store.contentBounds() ?? { min: { x: 0, y: 0, z: 0 }, max: { x: 1, y: 1, z: 1 } }
    const camera = fitCamera(bounds, presetAngles(preset), 200, 160)
    return renderIsometric(store, { camera, resolve: createFallbackColorResolver(), background: BG, overlays: false })
  }

  it('空世界只画背景', () => {
    const result = render(makeStore())
    expect(result.blocks).toBe(0)
    expect(result.faces).toBe(0)
    expect(contentBox(result.canvas).maxX).toBe(-1)
  })

  it('房子的内容不贴边', () => {
    const result = render(smallHouse())
    const box = contentBox(result.canvas)
    expect(box.minX).toBeGreaterThan(0)
    expect(box.maxX).toBeLessThan(199)
    expect(box.minY).toBeGreaterThan(0)
    expect(box.maxY).toBeLessThan(159)
    expect(result.blocks).toBeGreaterThan(50)
  })

  it('确定性：同样输入产生完全相同的字节', () => {
    const a = render(smallHouse())
    const b = render(smallHouse())
    expect([...encodePng(a.canvas)]).toEqual([...encodePng(b.canvas)])
    expect(a.blocks).toBe(b.blocks)
    expect(a.faces).toBe(b.faces)
  })

  it('不同机位产生不同图像', () => {
    const store = smallHouse()
    const iso = encodePng(render(store, 'iso_ne').canvas)
    const top = encodePng(render(store, 'top').canvas)
    expect([...iso]).not.toEqual([...top])
  })

  it('剔除被遮挡的面：实心块的内部面不画', () => {
    const store = makeStore()
    store.write(
      (v) => forEachBox({ x: 0, y: 0, z: 0 }, { x: 3, y: 3, z: 3 }, 'solid', v),
      store.palette.indexOf('minecraft:stone'),
      { confirm: true },
    )
    const withCulling = renderIsometric(store, {
      camera: fitCamera(store.contentBounds()!, presetAngles('iso_ne'), 200, 160),
      resolve: createFallbackColorResolver(),
      background: BG,
      overlays: false,
    })
    const withoutCulling = renderIsometric(store, {
      camera: fitCamera(store.contentBounds()!, presetAngles('iso_ne'), 200, 160),
      resolve: createFallbackColorResolver(),
      background: BG,
      cullOccluded: false,
      overlays: false,
    })
    // 4³ 实心块的可见面数远少于 64×6
    expect(withCulling.faces).toBeLessThan(withoutCulling.faces)
    expect(withCulling.faces).toBeLessThan(64 * 3)
  })

  it('背向相机的面不画（俯视时看不到底面）', () => {
    const store = makeStore()
    store.setBlock({ x: 0, y: 0, z: 0 }, 'minecraft:stone')
    const result = renderIsometric(store, {
      camera: fitCamera(store.contentBounds()!, presetAngles('top'), 200, 160),
      resolve: createFallbackColorResolver(),
      background: BG,
      overlays: false,
    })
    // 正俯视只该看到顶面
    expect(result.faces).toBe(1)
  })

  it('斜面（屋顶）能正确渲染', () => {
    const store = makeStore()
    store.write(
      (v) => forEachPlane({ x: 2, y: 0, z: 2 }, { x: 9, y: 0, z: 2 }, { x: 5, y: 4, z: 5 }, {}, v),
      store.palette.indexOf('minecraft:spruce_planks'),
      { confirm: true },
    )
    const result = render(store)
    expect(result.faces).toBeGreaterThan(10)
    expect(contentBox(result.canvas).maxX).toBeGreaterThan(-1)
  })

  it('圆柱（对角填充）能正确渲染', () => {
    const store = makeStore()
    store.write(
      (v) => forEachLine({ x: 3, y: 0, z: 3 }, { x: 8, y: 10, z: 8 }, { radius: 1 }, v),
      store.palette.indexOf('minecraft:oak_log'),
      { confirm: true },
    )
    expect(render(store).faces).toBeGreaterThan(20)
  })

  it('内容包围盒与实际几何一致', () => {
    const store = smallHouse()
    const result = render(store)
    const expected = store.contentBounds()!
    expect(result.bounds).toEqual(expected)
  })
})

describe('兜底颜色', () => {
  it('确定性：同名同色', () => {
    expect(fallbackAppearance('minecraft:stone')).toEqual(fallbackAppearance('minecraft:stone'))
  })

  it('不同名不同色', () => {
    expect(fallbackAppearance('stone')).not.toEqual(fallbackAppearance('dirt'))
  })

  it('分量都在 0..255', () => {
    for (const name of ['stone', 'dirt', 'glass', 'a_very_long_block_name_here']) {
      const c = fallbackAppearance(name)
      for (const v of [c.r, c.g, c.b]) {
        expect(Number.isInteger(v)).toBe(true)
        expect(v).toBeGreaterThanOrEqual(0)
        expect(v).toBeLessThanOrEqual(255)
      }
    }
  })

  it('解析器带缓存', () => {
    const resolve = createFallbackColorResolver()
    expect(resolve('minecraft:stone')).toBe(resolve('minecraft:stone'))
  })
})
