/**
 * 带纹理的三角形光栅器（正交投影 + z-buffer）。
 *
 * ## 为什么不用画家算法了
 *
 * 纯色路径用的是"按方块中心深度排序 + 扫描线填凸多边形"，对整立方体的方块够用。
 * 一旦几何变成**原版方块模型**（栅栏的细柱、玻璃板的薄片、楼梯的两级台阶、
 * 火把的十字面），画家算法就崩了：这些几何互相穿插，按方块中心排序会得到
 * "近处的栅栏被远处的地面盖住"这种结果。z-buffer 按像素决胜负，不需要排序，
 * 也不会因为相机角度变化而换一种错法。
 *
 * ## 为什么仿射插值就够了
 *
 * 相机是**正交投影**：屏幕坐标是模型坐标的线性函数，所以屏幕空间的线性插值
 * 正好等于三维空间的线性插值——**不需要透视校正**。透视投影才需要除以 w。
 *
 * ## 光照怎么和游戏对齐
 *
 * 分三层，乘在一起：
 *
 * 1. **方向明暗**：原版的固定常量（顶 1.0 / 底 0.5 / 南北 0.8 / 东西 0.6）。
 *    这是 `BlockModelRenderer` 里那张 `[0.5, 1.0, 0.8, 0.6]` 表，和阳光无关。
 * 2. **环境光遮蔽（AO）**：由 mesher 逐顶点算好放在 `colors` 里
 *    （`(ao + 1) / 4`，取值 0.25 / 0.5 / 0.75 / 1.0）。
 * 3. **生物群系着色**：也在 `colors` 里（草/树叶/水的 `tintindex` 面）。
 *
 * 没有再叠一层"太阳方向"——那是 prismarine-viewer 用 three.js 的做法
 * （环境光 0xcccccc + 一盏平行光），它**不是原版的样子**。原版就是上面三层。
 */

import { cameraBasis, projectPoint } from './camera.js'
import type { CameraSpec } from './camera.js'
import type { Canvas } from './canvas.js'
import { buildOpaqueTileTable, sampleAtlas, tileIndex, tilesPerRowOf } from './atlas-format.js'
import type { TextureAtlas } from './atlas-format.js'
import type { WorldGeometry } from './mesher.js'

/**
 * 原版的方向明暗表。
 *
 * 唯一真相是 `net.minecraft.client.renderer.block.ModelBlockRenderer` 里的
 * `getShade`：底面 0.5、顶面 1.0、南北 0.8、东西 0.6。**不要**按法线和光线
 * 方向做点积来"更物理"——原版根本不是这么算的，那样出来的明暗关系和游戏对不上。
 */
const FACE_SHADE = { up: 1.0, down: 0.5, z: 0.8, x: 0.6 } as const

/** alpha 高于这个值当不透明处理（直接写，可写深度）。 */
const OPAQUE_ALPHA = 0.99

/** alpha 低于这个值直接丢弃（原版的 alpha test，用来抠出树叶/铁栏杆/玻璃的空心）。 */
const CUTOUT_ALPHA = 0.02

export interface RasterStats {
  /** 提交的三角形数（背面剔除之后）。 */
  triangles: number
  /** 真正写进像素的三角形数（被 z-buffer 全部挡掉的不算）。 */
  drawn: number
}

/**
 * 把网格化后的世界画到 `canvas` 上。
 *
 * `canvas` 必须已经被背景色填过——这里**不清屏**，因为画地面标尺要在方块之前。
 */
export function rasterize(
  geometry: WorldGeometry,
  options: { camera: CameraSpec; atlas: TextureAtlas; canvas: Canvas },
): RasterStats {
  const { camera, atlas, canvas } = options
  const basis = cameraBasis(camera)
  const width = canvas.width
  const height = canvas.height
  const count = geometry.vertices

  // ── 1. 顶点一次性投影 ──────────────────────────────────────────────────────
  // 投影是纯函数且每帧只算一次，放在三角形循环里重复算会白白多花 3 倍时间。
  const px = new Float32Array(count)
  const py = new Float32Array(count)
  const pz = new Float32Array(count)
  for (let i = 0; i < count; i++) {
    const p = projectPoint(
      {
        x: geometry.positions[i * 3]!,
        y: geometry.positions[i * 3 + 1]!,
        z: geometry.positions[i * 3 + 2]!,
      },
      camera,
      basis,
    )
    px[i] = p.x
    py[i] = p.y
    pz[i] = p.depth
  }

  // ── 2. 分类：不透明 / 半透明，背面剔除 ────────────────────────────────────
  const tileOpaque = buildOpaqueTileTable(atlas)
  const tilesPerRow = tilesPerRowOf(atlas)
  const opaque: number[] = []
  const translucent: number[] = []
  // 按**三角形序号**下标，不是 push——两轮绘制都要能按序号查回自己的明暗
  const faceShades: number[] = []
  const triCount = geometry.indices.length / 3

  for (let t = 0; t < triCount; t++) {
    const i0 = geometry.indices[t * 3]!
    const i1 = geometry.indices[t * 3 + 1]!
    const i2 = geometry.indices[t * 3 + 2]!

    // 背面剔除用**法线**而不是屏幕绕向：mesher 的绕向会跟着 AO 翻转而交换
    // （见 models.js 里 `aos[0] + aos[3] >= aos[1] + aos[2]` 那个分支），
    // 拿绕向当判据会把一半的顶面剔掉。
    const nx = geometry.normals[i0 * 3]!
    const ny = geometry.normals[i0 * 3 + 1]!
    const nz = geometry.normals[i0 * 3 + 2]!
    if (nx * basis.forward.x + ny * basis.forward.y + nz * basis.forward.z >= 0) continue

    const area = (px[i1]! - px[i0]!) * (py[i2]! - py[i0]!) - (px[i2]! - px[i0]!) * (py[i1]! - py[i0]!)
    if (area === 0) continue

    // 纹理块由 UV 重心决定：一个面的四个顶点一定落在同一张纹理里
    const uc = (geometry.uvs[i0 * 2]! + geometry.uvs[i1 * 2]! + geometry.uvs[i2 * 2]!) / 3
    const vc = (geometry.uvs[i0 * 2 + 1]! + geometry.uvs[i1 * 2 + 1]! + geometry.uvs[i2 * 2 + 1]!) / 3
    const tile = tileIndex(uc, vc, tilesPerRow)

    faceShades[t] = shadeFor(nx, ny, nz)
    if (tileOpaque[tile] === 1) opaque.push(t)
    else translucent.push(t)
  }

  // ── 3. 不透明先画（z-buffer 自己解决遮挡，不需要排序） ─────────────────────
  const depth = new Float32Array(width * height).fill(Number.POSITIVE_INFINITY)
  let drawn = 0
  for (const t of opaque) {
    if (drawTriangle(t, true)) drawn++
  }

  // ── 4. 半透明按深度从远到近画，只测试深度、不写深度 ────────────────────────
  // 不排序的话，玻璃后面先画的会挡住后画的（混合顺序不可交换）。
  translucent.sort((a, b) => triDepth(b) - triDepth(a))
  for (const t of translucent) {
    if (drawTriangle(t, false)) drawn++
  }

  return { triangles: opaque.length + translucent.length, drawn }

  // 闭包捕获上面的投影结果，避免把二十个参数在函数间传来传去
  function triDepth(t: number): number {
    return (
      (pz[geometry.indices[t * 3]!]! +
        pz[geometry.indices[t * 3 + 1]!]! +
        pz[geometry.indices[t * 3 + 2]!]!) /
      3
    )
  }

  function drawTriangle(t: number, writeDepth: boolean): boolean {
    const i0 = geometry.indices[t * 3]!
    const i1 = geometry.indices[t * 3 + 1]!
    const i2 = geometry.indices[t * 3 + 2]!

    const x0 = px[i0]!
    const y0 = py[i0]!
    const x1 = px[i1]!
    const y1 = py[i1]!
    const x2 = px[i2]!
    const y2 = py[i2]!
    const z0 = pz[i0]!
    const z1 = pz[i1]!
    const z2 = pz[i2]!

    const area = (x1 - x0) * (y2 - y0) - (x2 - x0) * (y1 - y0)
    if (area === 0) return false

    const minX = Math.max(0, Math.floor(Math.min(x0, x1, x2)))
    const maxX = Math.min(width - 1, Math.ceil(Math.max(x0, x1, x2)))
    const minY = Math.max(0, Math.floor(Math.min(y0, y1, y2)))
    const maxY = Math.min(height - 1, Math.ceil(Math.max(y0, y1, y2)))
    if (minX > maxX || minY > maxY) return false

    const shade = faceShades[t]!
    const invArea = 1 / area

    // 逐顶点纹理坐标与颜色
    const u0 = geometry.uvs[i0 * 2]!
    const v0 = geometry.uvs[i0 * 2 + 1]!
    const u1 = geometry.uvs[i1 * 2]!
    const v1 = geometry.uvs[i1 * 2 + 1]!
    const u2 = geometry.uvs[i2 * 2]!
    const v2 = geometry.uvs[i2 * 2 + 1]!
    const c0 = i0 * 3
    const c1 = i1 * 3
    const c2 = i2 * 3

    let touched = false
    for (let y = minY; y <= maxY; y++) {
      const sy = y + 0.5
      const row = y * width
      for (let x = minX; x <= maxX; x++) {
        const sx = x + 0.5
        // 边函数（重心坐标），同号即在三角形内
        // 边函数除以**带符号**的 area：两种绕向都自动落在 [0,1]，
        // 不需要按 area 的符号再翻一次（多翻一次会把三角形整个判成外部）
        const w0 = ((x1 - sx) * (y2 - sy) - (x2 - sx) * (y1 - sy)) * invArea
        const w1 = ((x2 - sx) * (y0 - sy) - (x0 - sx) * (y2 - sy)) * invArea
        const w2 = 1 - w0 - w1
        if (w0 < 0 || w1 < 0 || w2 < 0) continue

        const z = w0 * z0 + w1 * z1 + w2 * z2
        const di = row + x
        if (z >= depth[di]!) continue

        const u = w0 * u0 + w1 * u1 + w2 * u2
        const v = w0 * v0 + w1 * v1 + w2 * v2
        const texel = sampleAtlas(atlas, u, v)
        const alpha = texel[3] / 255
        if (alpha < CUTOUT_ALPHA) continue

        // 顶点色插值；三个顶点共享同一个方向明暗，所以 shade 是标量
        const r = (w0 * geometry.colors[c0]! + w1 * geometry.colors[c1]! + w2 * geometry.colors[c2]!) * shade
        const g = (w0 * geometry.colors[c0 + 1]! + w1 * geometry.colors[c1 + 1]! + w2 * geometry.colors[c2 + 1]!) * shade
        const b = (w0 * geometry.colors[c0 + 2]! + w1 * geometry.colors[c1 + 2]! + w2 * geometry.colors[c2 + 2]!) * shade

        const o = di * 4
        const sr = texel[0]! * r
        const sg = texel[1]! * g
        const sb = texel[2]! * b

        if (alpha >= OPAQUE_ALPHA) {
          canvas.data[o] = sr > 255 ? 255 : sr
          canvas.data[o + 1] = sg > 255 ? 255 : sg
          canvas.data[o + 2] = sb > 255 ? 255 : sb
          canvas.data[o + 3] = 255
          if (writeDepth) depth[di] = z
        } else {
          const inv = 1 - alpha
          canvas.data[o] = canvas.data[o]! * inv + sr * alpha
          canvas.data[o + 1] = canvas.data[o + 1]! * inv + sg * alpha
          canvas.data[o + 2] = canvas.data[o + 2]! * inv + sb * alpha
          canvas.data[o + 3] = 255
        }
        touched = true
      }
    }
    return touched
  }
}

/** 法线 → 原版方向明暗。按**主轴**判定，斜法线（原版模型里没有）落到最接近的档。 */
function shadeFor(nx: number, ny: number, nz: number): number {
  const ax = Math.abs(nx)
  const ay = Math.abs(ny)
  const az = Math.abs(nz)
  if (ay >= ax && ay >= az) return ny >= 0 ? FACE_SHADE.up : FACE_SHADE.down
  if (az >= ax) return FACE_SHADE.z
  return FACE_SHADE.x
}

