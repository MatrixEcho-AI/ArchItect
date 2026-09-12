import type { Bounds, Pos } from '@architect/core'

import { cameraBasis, projectPoint } from './camera.js'
import type { CameraSpec, CameraBasis } from './camera.js'
import { Canvas } from './canvas.js'
import { CHAR_HEIGHT, CHAR_WIDTH, glyphFor } from './font.js'
import type { Rgb } from './png.js'

export interface Marker {
  pos: Pos
  label?: string
  color?: Rgb
}

export interface OverlayOptions {
  /** 在内容底面画坐标网格 + 数字刻度。 */
  ruler?: boolean
  /** 网格步长；默认自动（让刻度数落在 4~9 之间）。 */
  rulerStep?: number
  /**
   * 标尺网格向外扩张的格数，默认 4。
   *
   * 网格在 `y = bounds.min.y`。如果它正好和内容底面重合，就会被地板**完全盖住**
   * （画家算法里后画的赢），等于白画。往外扩一圈才能在模型周围露出来。
   */
  rulerPadding?: number
  /** 左下角坐标轴指示器。 */
  axisGizmo?: boolean
  /** 工区线框（可写边界）。 */
  volumeBox?: Bounds
  /** 高亮区域——**上次编辑的影响范围**，让 LLM 看见自己刚改了什么。 */
  highlight?: Bounds
  highlightColor?: Rgb
  /** 标记点（LLM 用来指认"这里"）。 */
  markers?: Marker[]
  /** 左上角信息行。 */
  caption?: string[]
}

export const OVERLAY_COLORS = {
  rulerLine: { r: 86, g: 108, b: 134 },
  rulerLabel: { r: 214, g: 228, b: 244 },
  axisX: { r: 232, g: 84, b: 84 },
  axisY: { r: 118, g: 208, b: 106 },
  axisZ: { r: 96, g: 148, b: 240 },
  volume: { r: 92, g: 200, b: 214 },
  highlight: { r: 255, g: 164, b: 64 },
  caption: { r: 236, g: 240, b: 248 },
} as const

export interface TextStyle {
  scale?: number
  /** 在文字周围画一圈暗色描边，保证叠在模型上也能看清。默认 `true`。 */
  outline?: boolean
}

/** 用位图字体画一段文字。 */
export function drawText(
  canvas: Canvas,
  text: string,
  x: number,
  y: number,
  color: Rgb,
  style: TextStyle = {},
): void {
  const scale = Math.max(1, Math.floor(style.scale ?? 1))
  if (style.outline !== false) {
    const outline = { r: 12, g: 14, b: 18 }
    for (const [dx, dy] of [
      [-scale, 0],
      [scale, 0],
      [0, -scale],
      [0, scale],
    ] as const) {
      drawTextRaw(canvas, text, x + dx, y + dy, outline, scale)
    }
  }
  drawTextRaw(canvas, text, x, y, color, scale)
}

function drawTextRaw(
  canvas: Canvas,
  text: string,
  x: number,
  y: number,
  color: Rgb,
  scale: number,
): void {
  let cursor = x
  for (const char of text) {
    const glyph = glyphFor(char)
    for (let row = 0; row < glyph.height; row++) {
      const bits = glyph.rows[row] ?? 0
      for (let col = 0; col < glyph.width; col++) {
        if ((bits & (1 << (glyph.width - 1 - col))) === 0) continue
        for (let sy = 0; sy < scale; sy++) {
          for (let sx = 0; sx < scale; sx++) {
            canvas.blend(cursor + col * scale + sx, y + row * scale + sy, color, 1)
          }
        }
      }
    }
    cursor += CHAR_WIDTH * scale
  }
}

/** 由内容尺寸自动挑一个"刻度数在 4~9 之间"的步长。 */
export function autoRulerStep(extent: number): number {
  const candidates = [1, 2, 4, 5, 8, 10, 16, 20, 32, 50, 64, 100, 128, 200, 256]
  for (const step of candidates) {
    if (extent / step <= 9) return step
  }
  return candidates[candidates.length - 1]!
}

/**
 * 投影出来的点能不能画。
 *
 * 透视投影下"在相机后面"的点会交出 `NaN`（除以负数会翻到画面另一侧），
 * 画上去就是一条横穿全屏的线。正交投影不会出现这种情况，所以这个判据对它是恒真的。
 */
function onScreen(point: { x: number; y: number }): boolean {
  return Number.isFinite(point.x) && Number.isFinite(point.y)
}

/**
 * 画叠加层。
 *
 * 这是把 2D 图变成**可用空间信息**的最廉价手段（plan §2/D4）：
 * 没有坐标标尺，LLM 只能对着图猜；有了标尺 + 高亮，它才能把"画面上的位置"映射回"世界坐标"。
 *
 * 所有 3D 元素都走同一个 `projectPoint`，所以和方块渲染严格对齐。
 */
export function drawOverlays(
  canvas: Canvas,
  camera: CameraSpec,
  basis: CameraBasis | undefined,
  contentBounds: Bounds,
  options: OverlayOptions,
): void {
  const active = basis ?? cameraBasis(camera)

  if (options.ruler !== false) {
    drawRulerLabels(canvas, camera, active, contentBounds, options)
  }
  if (options.volumeBox !== undefined) {
    drawBoxEdges(canvas, camera, active, options.volumeBox, OVERLAY_COLORS.volume)
  }
  if (options.highlight !== undefined) {
    drawBoxEdges(
      canvas,
      camera,
      active,
      options.highlight,
      options.highlightColor ?? OVERLAY_COLORS.highlight,
    )
  }
  for (const marker of options.markers ?? []) drawMarker(canvas, camera, active, marker)
  if (options.axisGizmo !== false) drawAxisGizmo(canvas, active)
  if (options.caption !== undefined) drawCaption(canvas, options.caption)
}

function rulerStepFor(bounds: Bounds, options: OverlayOptions): number {
  return (
    options.rulerStep ??
    autoRulerStep(Math.max(bounds.max.x - bounds.min.x, bounds.max.z - bounds.min.z))
  )
}

/** 标尺网格的实际范围（比内容底面外扩一圈，见 `rulerPadding`）。 */
function rulerRect(bounds: Bounds, options: OverlayOptions): {
  y: number
  x0: number
  x1: number
  z0: number
  z1: number
  step: number
} {
  const pad = Math.max(0, Math.floor(options.rulerPadding ?? 4))
  return {
    y: bounds.min.y,
    x0: bounds.min.x - pad,
    x1: bounds.max.x + 1 + pad,
    z0: bounds.min.z - pad,
    z1: bounds.max.z + 1 + pad,
    step: rulerStepFor(bounds, options),
  }
}

/**
 * 标尺网格（**画在方块之前**）。
 *
 * 网格在地面 `y = bounds.min.y` 上，属于场景的一部分，必须被方块遮挡——
 * 否则那些线会横穿建筑表面，看起来像模型裂了。
 * 刻度数字则在方块之上（见 `drawRulerLabels`），保证始终可读。
 */
export function drawOverlayGrid(
  canvas: Canvas,
  camera: CameraSpec,
  basis: CameraBasis | undefined,
  bounds: Bounds,
  options: OverlayOptions,
): void {
  if (options.ruler === false) return
  const active = basis ?? cameraBasis(camera)
  const { y, x0, x1, z0, z1, step } = rulerRect(bounds, options)

  for (let x = Math.ceil(x0 / step) * step; x <= x1; x += step) {
    const a = projectPoint({ x, y, z: z0 }, camera, active)
    const b = projectPoint({ x, y, z: z1 }, camera, active)
    if (!onScreen(a) || !onScreen(b)) continue
    canvas.drawLine(a.x, a.y, b.x, b.y, OVERLAY_COLORS.rulerLine, 0.6)
  }
  for (let z = Math.ceil(z0 / step) * step; z <= z1; z += step) {
    const a = projectPoint({ x: x0, y, z }, camera, active)
    const b = projectPoint({ x: x1, y, z }, camera, active)
    if (!onScreen(a) || !onScreen(b)) continue
    canvas.drawLine(a.x, a.y, b.x, b.y, OVERLAY_COLORS.rulerLine, 0.6)
  }
}

/** 标尺的刻度数字（**画在方块之后**，保证可读）。 */
function drawRulerLabels(
  canvas: Canvas,
  camera: CameraSpec,
  basis: CameraBasis,
  bounds: Bounds,
  options: OverlayOptions,
): void {
  const { y, x0, x1, z0, z1, step } = rulerRect(bounds, options)

  // 标注要放在**离相机最近**的那条边上。
  // 放在远侧边的话，投影后那条边会落到画面上方、压在模型上，
  // 看起来像数字悬浮在屋顶上。近侧边在前方，读数才自然。
  const depthAt = (x: number, z: number): number =>
    projectPoint({ x, y, z }, camera, basis).depth
  const nearZ = depthAt(x0, z0) <= depthAt(x0, z1) ? z0 : z1
  const nearX = depthAt(x0, z0) <= depthAt(x1, z0) ? x0 : x1

  for (let x = Math.ceil(x0 / step) * step; x <= x1; x += step) {
    const p = projectPoint({ x, y, z: nearZ }, camera, basis)
    if (!onScreen(p)) continue
    const text = String(x)
    const outward = nearZ === z0 ? 4 : -CHAR_HEIGHT - 4
    drawText(canvas, text, p.x - (text.length * CHAR_WIDTH) / 2, p.y + outward, OVERLAY_COLORS.rulerLabel)
  }
  for (let z = Math.ceil(z0 / step) * step; z <= z1; z += step) {
    const p = projectPoint({ x: nearX, y, z }, camera, basis)
    if (!onScreen(p)) continue
    const text = String(z)
    const outward = nearX === x0 ? -text.length * CHAR_WIDTH - 4 : 4
    drawText(canvas, text, p.x + outward, p.y - CHAR_HEIGHT / 2, OVERLAY_COLORS.rulerLabel)
  }
}

/** 浮点包围盒。实体这类东西不是整格的，所以角点也是浮点的。 */
export interface FloatBox {
  min: { x: number; y: number; z: number }
  max: { x: number; y: number; z: number }
}

/**
 * **整数包围盒**的 12 条棱。
 *
 * `max` 是闭区间的**格子**，所以远角要 `+1`——这是"格"与"坐标"之间的那一步。
 * 浮点盒没有这一步，见 `drawFloatBoxEdges`。
 */
export function drawBoxEdges(
  canvas: Canvas,
  camera: CameraSpec,
  basis: CameraBasis,
  box: Bounds,
  color: Rgb,
  alpha = 0.95,
): void {
  drawEdges(
    canvas,
    camera,
    basis,
    { x: box.min.x, y: box.min.y, z: box.min.z },
    { x: box.max.x + 1, y: box.max.y + 1, z: box.max.z + 1 },
    color,
    alpha,
  )
}

/**
 * **浮点包围盒**的 12 条棱——实体高亮用。
 *
 * 与整数那版的唯一差别是远角**不加 1**：`Bounds` 说的是"哪几格"（闭区间，所以
 * 远角要推到下一格的边界），而这里说的是"空间里的一个盒子"，两个角就是两个角。
 * 混用的话实体高亮会整体大出一格，而那种错看起来像"渲染偏了"。
 */
export function drawFloatBoxEdges(
  canvas: Canvas,
  camera: CameraSpec,
  basis: CameraBasis,
  box: FloatBox,
  color: Rgb,
  alpha = 0.95,
): void {
  drawEdges(canvas, camera, basis, box.min, box.max, color, alpha)
}

function drawEdges(
  canvas: Canvas,
  camera: CameraSpec,
  basis: CameraBasis,
  lo: { x: number; y: number; z: number },
  hi: { x: number; y: number; z: number },
  color: Rgb,
  alpha: number,
): void {
  const corners: Pos[] = []
  for (let i = 0; i < 8; i++) {
    corners.push({
      x: (i & 1) === 0 ? lo.x : hi.x,
      y: (i & 2) === 0 ? lo.y : hi.y,
      z: (i & 4) === 0 ? lo.z : hi.z,
    })
  }
  const screen = corners.map((c) => projectPoint(c, camera, basis))
  // 只连相差一个二进制位的角点，正好是 12 条棱
  for (let i = 0; i < 8; i++) {
    for (let j = i + 1; j < 8; j++) {
      const diff = i ^ j
      if (diff !== 1 && diff !== 2 && diff !== 4) continue
      if (!onScreen(screen[i]!) || !onScreen(screen[j]!)) continue
      canvas.drawLine(screen[i]!.x, screen[i]!.y, screen[j]!.x, screen[j]!.y, color, alpha)
    }
  }
}

function drawMarker(
  canvas: Canvas,
  camera: CameraSpec,
  basis: CameraBasis,
  marker: Marker,
): void {
  const color = marker.color ?? OVERLAY_COLORS.highlight
  const box: Bounds = { min: marker.pos, max: marker.pos }
  drawBoxEdges(canvas, camera, basis, box, color)
  if (marker.label !== undefined) {
    const p = projectPoint(
      { x: marker.pos.x + 0.5, y: marker.pos.y + 1.5, z: marker.pos.z + 0.5 },
      camera,
      basis,
    )
    if (onScreen(p)) drawText(canvas, marker.label, p.x + 2, p.y, color)
  }
}

/** 左下角的坐标轴指示器：用当前相机基把三根世界轴画出来。 */
function drawAxisGizmo(canvas: Canvas, basis: CameraBasis): void {
  const originX = 42
  const originY = canvas.height - 34
  const length = 22

  const axes: Array<{ dir: { x: number; y: number; z: number }; color: Rgb; label: string }> = [
    { dir: { x: 1, y: 0, z: 0 }, color: OVERLAY_COLORS.axisX, label: 'X' },
    { dir: { x: 0, y: 1, z: 0 }, color: OVERLAY_COLORS.axisY, label: 'Y' },
    { dir: { x: 0, y: 0, z: 1 }, color: OVERLAY_COLORS.axisZ, label: 'Z' },
  ]

  for (const axis of axes) {
    // 正交基投影：屏幕方向 = (dot(dir, right), -dot(dir, up))
    const sx = axis.dir.x * basis.right.x + axis.dir.y * basis.right.y + axis.dir.z * basis.right.z
    const sy = axis.dir.x * basis.up.x + axis.dir.y * basis.up.y + axis.dir.z * basis.up.z
    const endX = originX + sx * length
    const endY = originY - sy * length
    canvas.drawLine(originX, originY, endX, endY, axis.color)
    drawText(canvas, axis.label, endX + (sx >= 0 ? 3 : -9), endY - 3, axis.color)
  }
}

/** 左上角信息面板。 */
function drawCaption(canvas: Canvas, lines: readonly string[]): void {
  let y = 8
  for (const line of lines) {
    drawText(canvas, line, 8, y, OVERLAY_COLORS.caption)
    y += CHAR_HEIGHT + 2
  }
}
