import { AIR_STATE_ID } from '@architect/core'
import type { Bounds, ShapeBox, WorldStore } from '@architect/core'

import { cameraBasis, projectPoint } from './camera.js'
import type { CameraSpec, CameraBasis, Vec3 } from './camera.js'
import { Canvas } from './canvas.js'
import type { ColorResolver } from './colors.js'
import { drawOverlayGrid, drawOverlays } from './overlay.js'
import type { OverlayOptions } from './overlay.js'

interface Face {
  /** 面法线（指向方块外部）。 */
  normal: Vec3
  /** 四个角，按方块单位立方体的偏移。 */
  corners: ReadonlyArray<Vec3>
  /** 该面是否**贴在方块边界**上——只有贴边的面才可能被整立方体邻居挡住。 */
  flush: boolean
}

/**
 * 无碰撞形状的方块（火把、植物、告示牌、雪）用一个居中细柱代替。
 * 不这样处理它们会**完全不显示**，比显示得不精确更糟。
 */
const SHAPELESS_FALLBACK: ShapeBox = [0.375, 0, 0.375, 0.625, 0.625, 0.625]

/**
 * 由一个碰撞盒生成 6 个面。
 *
 * `flush` 是关键：只有贴着方块边界的面才需要做邻居剔除。楼梯中间那级台阶的侧面
 * 即使旁边是实心方块也不该被剔除——它是**看得见**的。
 */
function boxFaces(box: ShapeBox): Face[] {
  const [x0, y0, z0, x1, y1, z1] = box
  const c = (x: number, y: number, z: number): Vec3 => ({ x, y, z })
  return [
    {
      normal: { x: 1, y: 0, z: 0 },
      flush: x1 >= 1,
      corners: [c(x1, y0, z0), c(x1, y1, z0), c(x1, y1, z1), c(x1, y0, z1)],
    },
    {
      normal: { x: -1, y: 0, z: 0 },
      flush: x0 <= 0,
      corners: [c(x0, y0, z1), c(x0, y1, z1), c(x0, y1, z0), c(x0, y0, z0)],
    },
    {
      normal: { x: 0, y: 1, z: 0 },
      flush: y1 >= 1,
      corners: [c(x0, y1, z0), c(x0, y1, z1), c(x1, y1, z1), c(x1, y1, z0)],
    },
    {
      normal: { x: 0, y: -1, z: 0 },
      flush: y0 <= 0,
      corners: [c(x0, y0, z1), c(x0, y0, z0), c(x1, y0, z0), c(x1, y0, z1)],
    },
    {
      normal: { x: 0, y: 0, z: 1 },
      flush: z1 >= 1,
      corners: [c(x1, y0, z1), c(x1, y1, z1), c(x0, y1, z1), c(x0, y0, z1)],
    },
    {
      normal: { x: 0, y: 0, z: -1 },
      flush: z0 <= 0,
      corners: [c(x0, y0, z0), c(x0, y1, z0), c(x1, y1, z0), c(x1, y0, z0)],
    },
  ]
}

export interface RenderOptions {
  camera: CameraSpec
  resolve: ColorResolver
  background?: { r: number; g: number; b: number }
  /** 光照方向（会归一化）。默认从左上前方。 */
  light?: Vec3
  /**
   * 剔除被邻接方块挡住的面。默认 `true`。
   * **非空气一律当作不透明**——所以玻璃幕墙只会画出朝外的面（可接受，且更快）。
   */
  cullOccluded?: boolean
  /**
   * 叠加层：坐标标尺、坐标轴、工区线框、上次编辑高亮、标记点、信息面板。
   *
   * **给 LLM 的图必须开**（plan §2/D4）——没有坐标标尺，模型只能对着画面猜位置。
   * 传 `false` 关掉（做纯净的展示图或 golden 测试时用）。
   */
  overlays?: OverlayOptions | false
}

export interface RenderResult {
  canvas: Canvas
  /** 参与绘制的方块数（至少有一个可见面）。 */
  blocks: number
  /** 实际绘制的面数。 */
  faces: number
  /** 内容包围盒；空世界为 `undefined`。 */
  bounds: Bounds | undefined
}

const DEFAULT_LIGHT: Vec3 = { x: -0.45, y: 0.82, z: -0.35 }

/**
 * 背面判定的容差。
 *
 * `elevation: 90` 时 `cos(90°)` 是 `6.12e-17` 而不是 0，于是"恰好侧对相机"的面
 * 会被算出 `dot = -6e-17 < 0` 而误判为可见——它投影出来是零面积，
 * 画不出东西却会污染面数统计。所以把接近 0 的点积一律当作背面。
 */
const BACKFACE_EPSILON = 1e-9

/**
 * 纯 JS 的**等轴测软件光栅器**（正交投影 + 画家算法）。
 *
 * 它存在的理由不是画得好看，而是**确定性**：
 * WebGL 在不同 GPU 上有细微差异，做不了像素级 golden 测试；软件光栅器完全可复现。
 * 同时它也是无 GPU 环境（CI、无显示器的服务器）的兜底路径。
 *
 * 给 LLM 的正式评审图应该走交互视口那套渲染器，但两者共用同一份相机与颜色代码。
 */
export function renderIsometric(store: WorldStore, options: RenderOptions): RenderResult {
  const { camera, resolve } = options
  const canvas = new Canvas(camera.width, camera.height, options.background ?? { r: 26, g: 28, b: 34 })
  const basis = cameraBasis(camera)
  const light = normalize(options.light ?? DEFAULT_LIGHT)
  const cullOccluded = options.cullOccluded !== false

  interface Part {
    box: ShapeBox
    depth: number
    faces: Face[]
  }

  interface VisibleBlock {
    x: number
    y: number
    z: number
    depth: number
    parts: Part[]
    appearance: { r: number; g: number; b: number; a: number }
  }

  const visible: VisibleBlock[] = []
  let contentBounds: Bounds | undefined

  store.forEachNonAir((x, y, z, stateId) => {
    if (contentBounds === undefined) {
      contentBounds = { min: { x, y, z }, max: { x, y, z } }
    } else {
      const b = contentBounds
      if (x < b.min.x) b.min.x = x
      if (x > b.max.x) b.max.x = x
      if (y < b.min.y) b.min.y = y
      if (y > b.max.y) b.max.y = y
      if (z < b.min.z) b.min.z = z
      if (z > b.max.z) b.max.z = z
    }

    // 用**碰撞盒**而不是整立方体：楼梯是两块、栅栏是细柱、门是薄板。
    // 69.8% 的 block state 不是整立方体，而建筑师最常用的方块全在其中——
    // 把它们渲成实心立方体会给 LLM 错误反馈（栅栏看起来像墙）。
    const shapes = store.registry.shapesOf(stateId)
    const boxes = shapes.length > 0 ? shapes : [SHAPELESS_FALLBACK]

    const parts: Part[] = []
    for (const box of boxes) {
      const faces: Face[] = []
      for (const face of boxFaces(box)) {
        // 背向（含恰好侧向）相机的面不画
        if (dot(face.normal, basis.forward) >= -BACKFACE_EPSILON) continue
        // 只有**贴边**的面才可能被整立方体邻居挡住
        if (cullOccluded && face.flush) {
          const neighbour = store.getBlockStateId({
            x: x + face.normal.x,
            y: y + face.normal.y,
            z: z + face.normal.z,
          })
          if (neighbour !== AIR_STATE_ID && store.registry.isFullCube(neighbour)) continue
        }
        faces.push(face)
      }
      if (faces.length === 0) continue
      const boxCenter: Vec3 = {
        x: x + (box[0] + box[3]) / 2,
        y: y + (box[1] + box[4]) / 2,
        z: z + (box[2] + box[5]) / 2,
      }
      parts.push({ box, depth: projectPoint(boxCenter, camera, basis).depth, faces })
    }
    if (parts.length === 0) return

    const block = store.registry.blockByStateId(stateId)
    const appearance = resolve(block?.name ?? 'unknown')
    const center: Vec3 = { x: x + 0.5, y: y + 0.5, z: z + 0.5 }
    const depth = projectPoint(center, camera, basis).depth
    // 同一方块内部的多个盒子也要按深度排（楼梯的两级台阶相对相机的远近不同）
    parts.sort((a, b) => b.depth - a.depth)
    visible.push({ x, y, z, depth, parts, appearance })
  })

  // 标尺网格属于地面，必须在方块**之前**画，否则线会横穿建筑表面
  const overlays = options.overlays
  if (overlays !== undefined && overlays !== false) {
    const gridAnchor = contentBounds ?? overlays.volumeBox
    if (gridAnchor !== undefined) drawOverlayGrid(canvas, camera, basis, gridAnchor, overlays)
  }

  // 画家算法：远的先画
  visible.sort((a, b) => b.depth - a.depth)

  let facesDrawn = 0
  for (const block of visible) {
    for (const part of block.parts) {
      for (const face of part.faces) {
        const projected = face.corners.map((corner) =>
          projectPoint(
            { x: block.x + corner.x, y: block.y + corner.y, z: block.z + corner.z },
            camera,
            basis,
          ),
        )
        const shade = shadeFor(face.normal, light)
        canvas.fillConvexPolygon(
          projected,
          {
            r: clampByte(block.appearance.r * shade),
            g: clampByte(block.appearance.g * shade),
            b: clampByte(block.appearance.b * shade),
          },
          block.appearance.a,
        )
        facesDrawn++
      }
    }
  }

  // 其余叠加层画在所有方块之上
  if (overlays !== undefined && overlays !== false) {
    // 空世界时用 volumeBox 兜底，这样"还没建东西"也能看到可写边界与标尺
    const anchor = contentBounds ?? overlays.volumeBox
    if (anchor !== undefined) drawOverlays(canvas, camera, basis, anchor, overlays)
  } else if (overlays === undefined) {
    // 默认：内容非空时开一套标准叠加层
    if (contentBounds !== undefined) drawOverlays(canvas, camera, basis, contentBounds, {})
  }

  return { canvas, blocks: visible.length, faces: facesDrawn, bounds: contentBounds }
}

/** 半球光照：环境项 + 定向漫反射，夹在 [0,1]。 */
function shadeFor(normal: Vec3, light: Vec3): number {
  const ambient = 0.42
  const diffuse = 0.58
  const lambert = Math.max(0, dot(normal, light))
  return Math.min(1, ambient + diffuse * lambert)
}

function dot(a: Vec3, b: Vec3): number {
  return a.x * b.x + a.y * b.y + a.z * b.z
}

function normalize(v: Vec3): Vec3 {
  const length = Math.hypot(v.x, v.y, v.z)
  return length === 0 ? { x: 0, y: 1, z: 0 } : { x: v.x / length, y: v.y / length, z: v.z / length }
}

function clampByte(value: number): number {
  return value < 0 ? 0 : value > 255 ? 255 : Math.round(value)
}

/** 只用来让 `CameraBasis` 类型在外部可见。 */
export type { CameraBasis }
