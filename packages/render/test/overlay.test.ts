import { forEachBox, forEachExtrude, WorldStore } from '@architect/core'
import type { Bounds } from '@architect/core'
import { describe, expect, it } from 'vitest'

import { cameraBasis, fitCamera, presetAngles } from './../src/camera.js'
import { Canvas } from '../src/canvas.js'
import { autoRulerStep, drawOverlays, drawOverlayGrid, drawText, OVERLAY_COLORS } from '../src/overlay.js'
import { renderIsometric } from '../src/isometric.js'
import { createFallbackColorResolver } from '../src/colors.js'
import { CHAR_HEIGHT, glyphFor, isRenderable, sanitizeForFont, textWidth } from '../src/font.js'

const BG = { r: 26, g: 28, b: 34 }
const HOUSE: Bounds = { min: { x: 2, y: 0, z: 2 }, max: { x: 13, y: 13, z: 13 } }

const volume: Bounds = { min: { x: 0, y: 0, z: 0 }, max: { x: 15, y: 15, z: 15 } }
const cameraFor = (bounds: Bounds, preset: 'iso_ne' | 'top' | 'front' = 'iso_ne'): ReturnType<typeof fitCamera> =>
  fitCamera(bounds, presetAngles(preset), 480, 360)

/** 在画布上统计某个颜色附近的像素数。 */
function countNear(canvas: Canvas, color: { r: number; g: number; b: number }, tolerance = 24): number {
  let n = 0
  for (let i = 0; i < canvas.width * canvas.height; i++) {
    if (
      Math.abs(canvas.data[i * 4]! - color.r) <= tolerance &&
      Math.abs(canvas.data[i * 4 + 1]! - color.g) <= tolerance &&
      Math.abs(canvas.data[i * 4 + 2]! - color.b) <= tolerance
    ) {
      n++
    }
  }
  return n
}

describe('Canvas.blend 的坐标取整（回归）', () => {
  it('小数坐标必须真的写进去', () => {
    // TypedArray[小数下标] 在 JS 里既不报错也不写入。
    // 投影出来的坐标几乎总是小数，所以不取整的话整块文字会静默消失。
    const canvas = new Canvas(8, 8, { r: 0, g: 0, b: 0 })
    canvas.blend(3.62, 4.29, { r: 255, g: 0, b: 0 }, 1)
    expect(canvas.data[(4 * 8 + 3) * 4]).toBe(255)
  })

  it('负数与越界坐标被安全忽略', () => {
    const canvas = new Canvas(4, 4, { r: 0, g: 0, b: 0 })
    expect(() => canvas.blend(-1.5, 2.2, { r: 255, g: 255, b: 255 }, 1)).not.toThrow()
    expect(() => canvas.blend(9.9, 2.2, { r: 255, g: 255, b: 255 }, 1)).not.toThrow()
    expect(canvas.data[0]).toBe(0)
  })
})

describe('位图字体', () => {
  it('已知字形存在，未知字符用占位块', () => {
    expect(glyphFor('5').rows).toHaveLength(7)
    expect(glyphFor('a').rows).toEqual(glyphFor('A').rows)
    expect(glyphFor('中').rows).not.toEqual(glyphFor(' ').rows)
  })

  it('drawText 真的产出像素', () => {
    const canvas = new Canvas(64, 16, { r: 0, g: 0, b: 0 })
    drawText(canvas, '123', 2, 2, { r: 255, g: 255, b: 255 })
    let bright = 0
    for (let i = 0; i < 64 * 16; i++) if (canvas.data[i * 4]! > 200) bright++
    expect(bright).toBeGreaterThan(20)
  })

  it('小数坐标下 drawText 仍然可见（回归）', () => {
    const canvas = new Canvas(64, 16, { r: 0, g: 0, b: 0 })
    drawText(canvas, '8', 12.6, 3.4, { r: 255, g: 255, b: 255 })
    let bright = 0
    for (let i = 0; i < 64 * 16; i++) if (canvas.data[i * 4]! > 200) bright++
    expect(bright).toBeGreaterThan(5)
  })

  it('CJK 没有字形，会被 sanitizeForFont 转义（否则渲染成一排方块）', () => {
    expect(isRenderable('A')).toBe(true)
    expect(isRenderable('中')).toBe(false)
    expect(sanitizeForFont('海边小屋 REV 5')).toBe('???? REV 5')
    expect(sanitizeForFont('plain ascii')).toBe('plain ascii')
  })

  it('textWidth 随长度线性增长', () => {
    expect(textWidth('12')).toBeGreaterThan(textWidth('1'))
    expect(textWidth('')).toBe(0)
  })
})

describe('标尺', () => {
  it('autoRulerStep 让刻度数落在 4~9 之间', () => {
    for (const extent of [3, 7, 15, 31, 63, 127, 255]) {
      const step = autoRulerStep(extent)
      expect(Math.floor(extent / step), `extent=${extent}`).toBeLessThanOrEqual(9)
      expect(step).toBeGreaterThan(0)
    }
  })

  it('网格往外扩一圈（否则会被地板完全挡住）', () => {
    const cam = cameraFor(HOUSE)
    const basis = cameraBasis(cam)
    const tight = new Canvas(480, 360, BG)
    const wide = new Canvas(480, 360, BG)
    drawOverlayGrid(tight, cam, basis, HOUSE, { ruler: true, rulerPadding: 0 })
    drawOverlayGrid(wide, cam, basis, HOUSE, { ruler: true, rulerPadding: 6 })
    expect(countNear(wide, OVERLAY_COLORS.rulerLine, 40)).toBeGreaterThan(
      countNear(tight, OVERLAY_COLORS.rulerLine, 40),
    )
  })

  it('刻度数字画在模型之上（可读性优先）', () => {
    const cam = cameraFor(HOUSE)
    const canvas = new Canvas(480, 360, BG)
    drawOverlays(canvas, cam, cameraBasis(cam), HOUSE, { ruler: true, rulerStep: 2 })
    expect(countNear(canvas, OVERLAY_COLORS.rulerLabel, 16)).toBeGreaterThan(50)
  })

  it('ruler: false 时不画任何刻度', () => {
    const cam = cameraFor(HOUSE)
    const canvas = new Canvas(480, 360, BG)
    drawOverlays(canvas, cam, cameraBasis(cam), HOUSE, { ruler: false, axisGizmo: false })
    expect(countNear(canvas, OVERLAY_COLORS.rulerLabel, 16)).toBe(0)
  })
})

describe('叠加层其余元素', () => {
  it('坐标轴指示器', () => {
    const cam = cameraFor(HOUSE)
    const canvas = new Canvas(480, 360, BG)
    drawOverlays(canvas, cam, cameraBasis(cam), HOUSE, { ruler: false, axisGizmo: true })
    expect(countNear(canvas, OVERLAY_COLORS.axisX, 30)).toBeGreaterThan(5)
    expect(countNear(canvas, OVERLAY_COLORS.axisY, 30)).toBeGreaterThan(5)
    expect(countNear(canvas, OVERLAY_COLORS.axisZ, 30)).toBeGreaterThan(5)
  })

  it('工区线框与高亮框各自用不同颜色', () => {
    const cam = cameraFor(HOUSE)
    const canvas = new Canvas(480, 360, BG)
    drawOverlays(canvas, cam, cameraBasis(cam), HOUSE, {
      ruler: false,
      axisGizmo: false,
      volumeBox: volume,
      highlight: { min: { x: 2, y: 4, z: 2 }, max: { x: 13, y: 8, z: 13 } },
    })
    expect(countNear(canvas, OVERLAY_COLORS.volume, 30)).toBeGreaterThan(50)
    expect(countNear(canvas, OVERLAY_COLORS.highlight, 30)).toBeGreaterThan(50)
  })

  it('信息面板', () => {
    const cam = cameraFor(HOUSE)
    const canvas = new Canvas(480, 360, BG)
    drawOverlays(canvas, cam, cameraBasis(cam), HOUSE, {
      ruler: false,
      axisGizmo: false,
      caption: ['REV 7', 'SIZE 12x14x12'],
    })
    expect(countNear(canvas, OVERLAY_COLORS.caption, 16)).toBeGreaterThan(50)
  })

  it('标记点带标签', () => {
    const cam = cameraFor(HOUSE)
    const canvas = new Canvas(480, 360, BG)
    drawOverlays(canvas, cam, cameraBasis(cam), HOUSE, {
      ruler: false,
      axisGizmo: false,
      markers: [{ pos: { x: 7, y: 8, z: 7 }, label: 'RIDGE' }],
    })
    expect(countNear(canvas, OVERLAY_COLORS.highlight, 30)).toBeGreaterThan(20)
  })
})

describe('叠加层与渲染器集成', () => {
  const house = (): WorldStore => {
    const store = new WorldStore({ minecraftVersion: '1.21.4', volume })
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

  it('默认开启标尺与坐标轴', () => {
    const store = house()
    const result = renderIsometric(store, {
      camera: cameraFor(store.contentBounds()!),
      resolve: createFallbackColorResolver(),
      background: BG,
    })
    expect(countNear(result.canvas, OVERLAY_COLORS.rulerLabel, 16)).toBeGreaterThan(50)
    expect(countNear(result.canvas, OVERLAY_COLORS.axisX, 30)).toBeGreaterThan(5)
  })

  it('overlays: false 得到纯净渲染', () => {
    const store = house()
    const plain = renderIsometric(store, {
      camera: cameraFor(store.contentBounds()!),
      resolve: createFallbackColorResolver(),
      background: BG,
      overlays: false,
    })
    const decorated = renderIsometric(store, {
      camera: cameraFor(store.contentBounds()!),
      resolve: createFallbackColorResolver(),
      background: BG,
    })
    expect(countNear(plain.canvas, OVERLAY_COLORS.rulerLabel, 16)).toBe(0)
    expect(countNear(decorated.canvas, OVERLAY_COLORS.rulerLabel, 16)).toBeGreaterThan(50)
  })

  it('网格画在方块之前，会被模型遮挡', () => {
    // 用一张只含网格的图和一张完整图对比：完整图里网格线像素应当更少
    const store = house()
    const bounds = store.contentBounds()!
    const cam = cameraFor(bounds)
    const gridOnly = new Canvas(cam.width, cam.height, BG)
    drawOverlayGrid(gridOnly, cam, cameraBasis(cam), bounds, { ruler: true })
    const full = renderIsometric(store, {
      camera: cam,
      resolve: createFallbackColorResolver(),
      background: BG,
      overlays: { ruler: true, axisGizmo: false },
    })
    const gridPixels = countNear(gridOnly, OVERLAY_COLORS.rulerLine, 40)
    const visibleAfterBlocks = countNear(full.canvas, OVERLAY_COLORS.rulerLine, 40)
    expect(gridPixels).toBeGreaterThan(0)
    expect(visibleAfterBlocks).toBeLessThan(gridPixels)
  })

  it('空世界只给 volumeBox 也能渲染叠加层', () => {
    const store = new WorldStore({ minecraftVersion: '1.21.4', volume })
    const result = renderIsometric(store, {
      camera: cameraFor(volume),
      resolve: createFallbackColorResolver(),
      background: BG,
      overlays: { volumeBox: volume },
    })
    expect(result.blocks).toBe(0)
    expect(countNear(result.canvas, OVERLAY_COLORS.volume, 30)).toBeGreaterThan(50)
  })

  it('叠加层不改变方块与面数', () => {
    const store = house()
    const cam = cameraFor(store.contentBounds()!)
    const withOverlay = renderIsometric(store, { camera: cam, resolve: createFallbackColorResolver(), background: BG })
    const without = renderIsometric(store, {
      camera: cam,
      resolve: createFallbackColorResolver(),
      background: BG,
      overlays: false,
    })
    expect(withOverlay.blocks).toBe(without.blocks)
    expect(withOverlay.faces).toBe(without.faces)
  })

  it('文字高度与行距常量可用', () => {
    expect(CHAR_HEIGHT).toBeGreaterThan(7)
  })
})
