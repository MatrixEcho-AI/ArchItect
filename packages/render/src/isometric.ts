import { AIR_STATE_ID } from '@architect/core'
import type { Bounds, ShapeBox, WorldStore } from '@architect/core'

import { cameraBasis, projectPoint } from './camera.js'
import type { CameraSpec, CameraBasis, Vec3 } from './camera.js'
import { Canvas } from './canvas.js'
import type { ColorResolver } from './colors.js'
import { drawOverlayGrid, drawOverlays } from './overlay.js'
import type { OverlayOptions } from './overlay.js'
import { loadRenderData, meshWorld } from './mesher.js'
import type { TexturePack } from './texturepack.js'
import { rasterize } from './raster.js'

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
  /**
   * 纯色解析器。**只在没有 `atlas` 时用**——它给每个方块一个平均色，
   * 材料区分度很低（`stone_bricks` 和 `stone` 的平均色只差 4/255）。
   */
  resolve: ColorResolver
  /**
   * 走**和游戏一致的纹理渲染**：真实方块模型（含栅栏/楼梯/玻璃板/门）+ 逐面纹理
   * + 原版方向明暗 + AO。
   *
   * 关掉时走纯色快路径（按方块平均色填面），用途是 `--plain`（CI 与 golden 测试
   * 要逐字节确定性）和 OBJ 导出。**两条路径都保留**：golden 测试靠纯色路径的
   * 稳定性，给人看和给模型看的图靠纹理路径。
   */
  textured?: boolean
  /**
   * 纹理来源（`textured: true` 时必给）。
   *
   * 不给就是"没有纹理"：图集里只剩缺失纹理那一格，画面会变成一片洋红棋盘格——
   * 所以调用方永远应该给一个（最差是 `bakedColorTexturePack()` 的平均色）。
   * 这里不做隐式兜底：悄悄换一套纹理比报错难查得多。
   */
  textures?: TexturePack
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
 * 同时它也是无 GPU 环境（CLI、CI、无显示器的服务器）的兜底路径。
 *
 * 桌面端模型收到的图**默认不从这里出**——那是渲染进程里 three.js 画的
 * （见 `AgentSession` 的 `render` 注入点）。但两者共用同一份相机、同一份叠加层
 * 选项与同一套颜色代码，所以换后端不会换构图（D-50）。
 */
export function renderIsometric(store: WorldStore, options: RenderOptions): RenderResult {
  if (options.textured === true) return renderTextured(store, options)

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

/**
 * **纹理渲染路径**：真实方块模型 + 逐面纹理 + 原版光照。
 *
 * 和纯色路径的差别不只是"贴了图"：
 *
 * | | 纯色路径 | 纹理路径 |
 * |---|---|---|
 * | 几何 | 碰撞盒（栅栏是一根柱子，没有横杆） | 原版方块模型（栅栏按邻居连长横杆） |
 * | 颜色 | 整张纹理的平均色 | 逐像素采样真实纹理 |
 * | 遮挡 | 画家算法按方块中心排序 | 三角形 z-buffer |
 * | 光照 | 自定义半球光 | 原版方向明暗 × AO × 生物群系着色 |
 *
 * 之所以两条都留着，是因为纯色路径**逐字节可复现**（golden 测试用它），
 * 而纹理路径才是"和游戏里看到的一样"。`--plain` 切换。
 */
function renderTextured(store: WorldStore, options: RenderOptions): RenderResult {
  const { camera } = options
  const canvas = new Canvas(camera.width, camera.height, options.background ?? { r: 26, g: 28, b: 34 })
  const basis = cameraBasis(camera)

  // 图集与方块状态按版本缓存：首次约 1 秒，之后是查表。
  // 一次会话要截很多张图，绝不能每张都重新解码 1040 张纹理。
  const pack = options.textures
  // 不给来源时**必须响亮地失败**：隐式退成"空资源包"会得到一张只有缺失纹理的图集，
  // 整个建筑变成一片洋红棋盘格——那比抛错难查得多（而且看起来像"渲染坏了"）
  if (pack === undefined || pack.blockTiles().length === 0) {
    // 空来源（没给、或给了一个一张方块纹理都没有的包）必须**响亮地失败**：
    // 图集里只剩缺失纹理那一格，整个建筑会变成一片洋红棋盘格，而且往下还会在
    // vendored 的模型解析里炸出一句 `"undefined" is not valid JSON`——那句话
    // 指向的是症状不是原因。这里直接把原因说出来。
    throw new Error(
      `textured 渲染需要一个有方块纹理的来源（options.textures，当前 ${pack === undefined ? '没给' : `给了 ${pack.id}，但 blockTiles 是空的`}）——见 texturepack.ts`,
    )
  }
  const data = loadRenderData(store.registry.minecraftVersion, pack)

  // 标尺网格属于地面，必须画在方块之前，否则线会横穿建筑表面
  const contentBounds = store.contentBounds()
  const overlays = options.overlays
  if (overlays !== undefined && overlays !== false) {
    const gridAnchor = contentBounds ?? overlays.volumeBox
    if (gridAnchor !== undefined) drawOverlayGrid(canvas, camera, basis, gridAnchor, overlays)
  }

  const geometry = meshWorld(store, data)
  const stats = rasterize(geometry, { camera, atlas: data.atlas, canvas })

  let blocks = 0
  store.forEachNonAir(() => {
    blocks++
  })

  if (overlays !== undefined && overlays !== false) {
    const anchor = contentBounds ?? overlays.volumeBox
    if (anchor !== undefined) drawOverlays(canvas, camera, basis, anchor, overlays)
  } else if (overlays === undefined) {
    if (contentBounds !== undefined) drawOverlays(canvas, camera, basis, contentBounds, {})
  }

  return { canvas, blocks, faces: stats.drawn, bounds: contentBounds }
}
