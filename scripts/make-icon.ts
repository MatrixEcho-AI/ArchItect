import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { Canvas, encodePng } from '@architect/render'

/**
 * 生成应用图标（`apps/desktop/build/icon.png`，1024×1024）。
 *
 * 为什么自己画而不是随便找一张：图标要能和界面对得上——同一个等轴测视角、
 * 同一套配色（`--bg` / `--accent`），所以**用渲染包自己的 Canvas**画，
 * 而不是塞一个二进制图片进仓库（那样没人能改，也没人知道它是怎么来的）。
 *
 * 形状是"一块等轴测方块"：ArchItect 做的是方块建筑，这个形状既是最小单位
 * 也是整个产品的缩写。三个面分别用亮/中/暗三档同色系，符合等轴测的明暗约定。
 *
 * 各平台要的尺寸不同（mac 是 icns、win 是 ico、linux 是 png），
 * electron-builder 能从一张 ≥512 的 PNG 自己转，所以仓库里只留这一张源图。
 */
const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const out = join(root, 'apps/desktop/build/icon.png')

const SIZE = 1024
/** 与界面同一套颜色（`apps/desktop/src/renderer/style.css`）。 */
const HEX = { bg: [26, 28, 34] as const, accent: [92, 200, 214] as const }

/** 顶点按等轴测投影到画布（2:1 菱形，和游戏里的观感一致）。 */
function project(x: number, y: number, z: number): { x: number; y: number } {
  const scale = SIZE * 0.36
  return {
    x: SIZE / 2 + (x - z) * scale,
    y: SIZE / 2 + (x + z) * scale * 0.5 - y * scale,
  }
}

const canvas = new Canvas(SIZE, SIZE, { r: 0, g: 0, b: 0 })
// 背景：整块不透明，深色底 + 一点点提亮，免得在浅色桌面上"飘"
for (let i = 0; i < SIZE * SIZE; i++) {
  const o = i * 4
  canvas.data[o] = HEX.bg[0]
  canvas.data[o + 1] = HEX.bg[1]
  canvas.data[o + 2] = HEX.bg[2]
  canvas.data[o + 3] = 255
}

/** 把一个面填成純色（多边形一定是凸的：三个面都是四边形/三角形）。 */
function face(points: Array<[number, number, number]>, shade: number): void {
  canvas.fillConvexPolygon(
    points.map(([x, y, z]) => project(x, y, z)),
    {
      r: Math.round(HEX.accent[0] * shade),
      g: Math.round(HEX.accent[1] * shade),
      b: Math.round(HEX.accent[2] * shade),
    },
  )
}

// 一个 1×1×1 的方块，略微离开原点居中；三面明暗照搬原版方向明暗的比例
face([[0, 1, 0], [1, 1, 0], [1, 1, 1], [0, 1, 1]], 1.0) // 顶
// 可见的两个侧面：**x=1 朝右下、z=1 朝左下**。x=0 / z=0 那两个是背面，
// 画上去会盖住顶面（第一版就画错了，图标看起来像个缺角六边形）
face([[1, 0, 0], [1, 0, 1], [1, 1, 1], [1, 1, 0]], 0.72) // 右
face([[0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 1, 1]], 0.5) // 左

// 描一圈同色亮边，让它在深色背景上不糊成一团
const outline = [
  [0, 1, 0],
  [1, 1, 0],
  [1, 0, 0],
  [1, 0, 1],
  [0, 0, 1],
  [0, 1, 1],
] as Array<[number, number, number]>
for (let i = 0; i < outline.length; i++) {
  const from = project(...outline[i]!)
  const to = project(...outline[(i + 1) % outline.length]!)
  for (let t = 0; t <= 1; t += 0.002) {
    const x = from.x + (to.x - from.x) * t
    const y = from.y + (to.y - from.y) * t
    for (let dx = -3; dx <= 3; dx++) {
      for (let dy = -3; dy <= 3; dy++) {
        if (dx * dx + dy * dy > 9) continue
        const o = (Math.round(y + dy) * SIZE + Math.round(x + dx)) * 4
        if (o < 0 || o >= canvas.data.length) continue
        canvas.data[o] = 255
        canvas.data[o + 1] = 255
        canvas.data[o + 2] = 255
        canvas.data[o + 3] = 255
      }
    }
  }
}

mkdirSync(dirname(out), { recursive: true })
writeFileSync(out, encodePng(canvas))
console.log(`已生成 ${out.slice(root.length + 1)}（${SIZE}×${SIZE}）`)
