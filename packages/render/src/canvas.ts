import { zlibSync } from 'fflate'

import type { Rgb } from './png.js'

/** 一张 RGBA8 画布。 */
export class Canvas {
  readonly width: number
  readonly height: number
  readonly data: Uint8Array

  constructor(width: number, height: number, background: Rgb = { r: 0, g: 0, b: 0 }) {
    this.width = width
    this.height = height
    this.data = new Uint8Array(width * height * 4)
    this.clear(background)
  }

  clear(color: Rgb): void {
    for (let i = 0; i < this.width * this.height; i++) {
      this.data[i * 4] = color.r
      this.data[i * 4 + 1] = color.g
      this.data[i * 4 + 2] = color.b
      this.data[i * 4 + 3] = 255
    }
  }

  /**
   * 带 alpha 混合地写一个像素。
   *
   * ⚠️ 坐标会被**取整**。投影出来的坐标几乎总是小数，而 `TypedArray[小数下标]`
   * 在 JS 里既不报错也不写入——整块文字会静默消失，只在"为什么图上是空的"里体现出来。
   */
  blend(x: number, y: number, color: Rgb, alpha: number): void {
    const px = Math.floor(x)
    const py = Math.floor(y)
    if (px < 0 || py < 0 || px >= this.width || py >= this.height) return
    if (alpha <= 0) return
    const o = (py * this.width + px) * 4
    if (alpha >= 1) {
      this.data[o] = color.r
      this.data[o + 1] = color.g
      this.data[o + 2] = color.b
      this.data[o + 3] = 255
      return
    }
    const inv = 1 - alpha
    this.data[o] = Math.round(this.data[o]! * inv + color.r * alpha)
    this.data[o + 1] = Math.round(this.data[o + 1]! * inv + color.g * alpha)
    this.data[o + 2] = Math.round(this.data[o + 2]! * inv + color.b * alpha)
    this.data[o + 3] = 255
  }

  /**
   * 填充一个**凸多边形**（扫描线法）。
   *
   * 立方体的面投影后必然是凸四边形，所以不需要通用多边形三角化。
   */
  fillConvexPolygon(points: ReadonlyArray<{ x: number; y: number }>, color: Rgb, alpha = 1): void {
    if (points.length < 3) return
    let minY = Number.POSITIVE_INFINITY
    let maxY = Number.NEGATIVE_INFINITY
    for (const p of points) {
      if (p.y < minY) minY = p.y
      if (p.y > maxY) maxY = p.y
    }
    const y0 = Math.max(0, Math.ceil(minY))
    const y1 = Math.min(this.height - 1, Math.floor(maxY))
    const crossings: number[] = []

    for (let y = y0; y <= y1; y++) {
      const scan = y + 0.5
      crossings.length = 0
      for (let i = 0; i < points.length; i++) {
        const a = points[i]!
        const b = points[(i + 1) % points.length]!
        if (a.y === b.y) continue
        const lo = Math.min(a.y, b.y)
        const hi = Math.max(a.y, b.y)
        if (scan < lo || scan >= hi) continue
        crossings.push(a.x + ((scan - a.y) / (b.y - a.y)) * (b.x - a.x))
      }
      if (crossings.length < 2) continue
      crossings.sort((p, q) => p - q)
      for (let i = 0; i + 1 < crossings.length; i += 2) {
        const from = Math.max(0, Math.ceil(crossings[i]! - 0.5))
        const to = Math.min(this.width - 1, Math.floor(crossings[i + 1]! - 0.5))
        for (let x = from; x <= to; x++) this.blend(x, y, color, alpha)
      }
    }
  }

  /** 在最上层叠一个 1px 矩形边框（叠加层用）。 */
  strokeRect(x0: number, y0: number, x1: number, y1: number, color: Rgb, alpha = 1): void {
    const lo = { x: Math.min(x0, x1), y: Math.min(y0, y1) }
    const hi = { x: Math.max(x0, x1), y: Math.max(y0, y1) }
    for (let x = lo.x; x <= hi.x; x++) {
      this.blend(x, lo.y, color, alpha)
      this.blend(x, hi.y, color, alpha)
    }
    for (let y = lo.y; y <= hi.y; y++) {
      this.blend(lo.x, y, color, alpha)
      this.blend(hi.x, y, color, alpha)
    }
  }

  /** 画一条线段（坐标标尺、坐标轴用）。 */
  drawLine(
    x0: number,
    y0: number,
    x1: number,
    y1: number,
    color: Rgb,
    alpha = 1,
  ): void {
    let x = Math.round(x0)
    let y = Math.round(y0)
    const tx = Math.round(x1)
    const ty = Math.round(y1)
    const dx = Math.abs(tx - x)
    const dy = Math.abs(ty - y)
    const sx = x < tx ? 1 : -1
    const sy = y < ty ? 1 : -1
    let error = dx - dy
    for (;;) {
      this.blend(x, y, color, alpha)
      if (x === tx && y === ty) break
      const doubled = 2 * error
      if (doubled > -dy) {
        error -= dy
        x += sx
      }
      if (doubled < dx) {
        error += dx
        y += sy
      }
    }
  }
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  return table
})()

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]!) & 0xff]! ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function chunk(type: string, payload: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + payload.length)
  const view = new DataView(out.buffer)
  view.setUint32(0, payload.length)
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i)
  out.set(payload, 8)
  const crcInput = out.subarray(4, 8 + payload.length)
  view.setUint32(8 + payload.length, crc32(crcInput))
  return out
}

/** 把画布编码成 PNG（真彩 + alpha）。 */
export function encodePng(canvas: Canvas): Uint8Array {
  const { width, height, data } = canvas
  const raw = new Uint8Array((width * 4 + 1) * height)
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0 // filter: None
    raw.set(data.subarray(y * width * 4, (y + 1) * width * 4), y * (width * 4 + 1) + 1)
  }

  const ihdr = new Uint8Array(13)
  const ihdrView = new DataView(ihdr.buffer)
  ihdrView.setUint32(0, width)
  ihdrView.setUint32(4, height)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // color type RGBA
  ihdr[10] = 0
  ihdr[11] = 0
  ihdr[12] = 0

  const parts = [
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlibSync(raw, { level: 6 })),
    chunk('IEND', new Uint8Array(0)),
  ]
  let total = 0
  for (const part of parts) total += part.length
  const out = new Uint8Array(total)
  let offset = 0
  for (const part of parts) {
    out.set(part, offset)
    offset += part.length
  }
  return out
}
