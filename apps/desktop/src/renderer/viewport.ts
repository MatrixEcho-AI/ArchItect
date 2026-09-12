/**
 * 桌面视口：**three.js（WebGL）+ 一层 2D 叠加层**。
 *
 * ## 为什么主进程里那套软件光栅器不用于这里
 *
 * 软件光栅器存在的理由是**确定性**：CI、无 GPU 的服务器、golden 测试都要可复现。
 * 交互视口的诉求正相反——要跟手、要抗锯齿、要纹理在斜视角下不闪。这两件事
 * 最好由不同的东西来做：
 *
 * | | 渲染进程（这个文件） | 主进程的软件光栅器 |
 * |---|---|---|
 * | 谁在用 | 交互视口 + **桌面端模型收到的截图** | CLI、CI、无窗口时的兜底 |
 * | 帧率 | 60 fps（GPU） | 一次一张，慢无所谓 |
 * | 抗锯齿 | 离屏超采样 2×（窗口本身开 MSAA） | 无 |
 * | 纹理过滤 | 最近邻、不生成 mipmap（和游戏一致） | 最近邻 |
 * | 确定性 | 不要求（不同 GPU 有差异） | **要求**（golden 测试） |
 *
 * 模型那一枪走的是 `capture()`——同一个场景、同一个 `applyCamera`，
 * 只是渲染到离屏 target 而不是窗口。所以"用户拖出来的画面"和"模型看到的画面"
 * 是同一套渲染器（D-50），而不是同一份几何的两种画法。
 *
 * 但**几何是同一份**：都吃 mesher 的输出（世界坐标 + UV + AO 顶点色），
 * 相机也共用 `cameraBasis`。所以换后端不会换构图。
 *
 * ## 光照为什么不用 three 的灯
 *
 * 原版 Minecraft 的明暗是**逐方向常量**（顶 1.0 / 底 0.5 / 南北 0.8 / 东西 0.6）
 * 乘 AO，与"太阳在哪"无关。用平行光去凑只会得到一个"看起来挺立体但和游戏对不上"
 * 的结果。所以明暗在 CPU 侧按法线烘进顶点色，材质用 `MeshBasicMaterial`——
 * 没有灯，但每一面的亮度就是游戏里的那个值。
 */

import {
  buildOpaqueTileTable,
  cameraBasis,
  Canvas as OverlayCanvas,
  clampFreeElevation,
  drawOverlays,
  fitCamera,
  tileIndex,
  tilesPerRowOf,
} from '@architect/render/browser'
import type { CameraSpec, OverlayOptions, TextureAtlas } from '@architect/render/browser'
import * as THREE from 'three'

/**
 * 视口清屏色。
 *
 * **必须与 `viewport-shell.ts` 的 `VIEWPORT_CLEAR` 是同一个数**，这里刻意再写一遍
 * 而不是 import：那两个文件本来就互相引用（shell 用 `Viewport`），`Viewport` 要是
 * 反过来 import shell 就成了循环，而循环在这里会踩 TDZ——模块求值到一半常量还没
 * 初始化。一个数字换掉一条循环依赖，值当；`grep VIEWPORT_CLEAR` 能把两处一起找出来。
 */
const VIEWPORT_CLEAR = 0xf5f6f8


export interface ScenePayload {
  revision: number
  positions: Float32Array
  normals: Float32Array
  colors: Float32Array
  uvs: Float32Array
  indices: Uint32Array
  atlas: { size: number; data: Uint8Array }
  bounds?: { min: [number, number, number]; max: [number, number, number] }
  volume: { min: [number, number, number]; max: [number, number, number] }
}

/** 原版方向明暗。与 `raster.ts` 的 `FACE_SHADE` 必须是同一组数字。 */
const FACE_SHADE = { up: 1.0, down: 0.5, z: 0.8, x: 0.6 } as const

export interface ViewportCamera {
  azimuth: number
  elevation: number
  roll: number
  /** 每格像素。正交投影用；透视投影下由 `perspective.eye/fov` 决定（这个值被忽略）。 */
  scale: number
  /**
   * 给了它 = **透视投影**（第一人称）：相机站在 `eye`，`fov` 是垂直视场角。
   *
   * 交互动视口走这条；模型截图不给它（正交等轴测，见 `CameraSpec.perspective`）。
   */
  perspective?: { eye: [number, number, number]; fov: number }
  /**
   * **画面中心**（世界坐标）。省略 = 内容包围盒中心。
   *
   * 它和角度一起决定成像：正交投影下，观察方向 + 落在画面正中的那个点就是全部，
   * 相机沿视线挪多远都不改画面（`applyCamera` 里那个 2000 正是这么用的）。
   *
   * 交互相机因此把"相机在哪"（`main.ts` 里的 `camera.eye`）自己算成这一个点传进来：
   * 转头时位置不变、画面中心跟着转到新视线上，这就是"像游戏里一样原地转头"
   * 与"绕着目标转"的全部差别（前者画面会平移，后者不会）。
   */
  target?: [number, number, number]
}

/** 一次离屏截图的请求。相机由主进程解算好，渲染进程不重新取景。 */
export interface CaptureRequest {
  camera: CameraSpec
  width: number
  height: number
  /** 叠加层选项，和软件光栅器那份**是同一份**（标尺、坐标轴、高亮框、信息行）。 */
  overlays: OverlayOptions
}

/** 离屏截图内部用的超采样倍率。 */
const CAPTURE_SUPERSAMPLE = 2

/**
 * 视口的共同接口。**两个实现**：`Viewport`（three.js）与 `SoftwareViewport`（主进程的软件光栅器）。
 *
 * 为什么要两个：`new THREE.WebGLRenderer()` 在**没有 WebGL 的机器上直接抛异常**
 * （虚拟机、远程桌面、驱动被禁、`--disable-gpu`），而这一抛会把整个界面带走——
 * 连"描述需求"的输入框都点不了。所以拿不到 WebGL 时必须还能用，只是慢一点、糊一点。
 *
 * `capture` 只有 GPU 实现有：软件模式下模型截图**不绕这一圈**，主进程本来就能画
 * （而且画得和这里一模一样——都是软件光栅器），多一次往返只是白花。
 */
export interface SceneViewport {
  setRevision(revision: number): void
  setScene(payload: ScenePayload): void
  resize(cssWidth: number, cssHeight: number, pixelRatio: number): void
  /** `draft`：拖动中。GPU 忽略它，软件实现会降到半分辨率并跳过叠加层。 */
  render(view: ViewportCamera, options?: { draft?: boolean }): void
  capture?(request: CaptureRequest): string
  /**
   * **只给诊断用**：当前场景里画着多少三角形。
   *
   * 为什么值得有一个探针：`SceneViewport` 的真实状态（GPU 里的 mesh）在 DOM 上
   * **完全不可见**——"新建之后画布没清空"这类 bug，从截图上看不出来（视角变了、
   * 房子变小了，都可能是正常的），而读 DOM 也读不到。把三角形数报出来，
   * "清干净了没有"就变成一个能断言的数字。
   */
  debugScene?(): { meshes: number; triangles: number }
}

/** 让主进程画一帧。由 `main.ts` 接到 `studio:viewport` 上。 */
export type SoftwareFrameRequest = {
  azimuth: number
  elevation: number
  roll: number
  scale?: number
  target?: [number, number, number]
  width: number
  height: number
  draft: boolean
}

export interface SoftwareFrame {
  pixels: Uint8Array
  width: number
  height: number
  revision: number
  ms: number
}

/**
 * 一帧画完了往哪儿放。
 *
 * 抽成接口是为了让 `SoftwareViewport` **不碰 DOM**——它全部的复杂度都在
 * "请求合并""草稿降分辨率""同帧去重"上，那几件事在 Node 里能直接测
 * （见 `test/viewport.test.ts`）。
 */
export interface FrameSink {
  /** 视口尺寸（CSS 像素）。软件帧可能比它小——草稿帧是降过分辨率的。 */
  resize(width: number, height: number): void
  blit(frame: SoftwareFrame): void
}

/**
 * 软件视口拖动时把分辨率降到几分之一。
 *
 * 软件光栅化的成本与像素数成正比，2 就是 4 倍——**这是拖动能不能用的分水岭**。
 * 降下来的像素由 `FrameSink` 用最近邻放大回去。
 */
const DRAFT_DOWNSCALE = 2

/**
 * 一个 three.js 视口。
 *
 * 生命周期：`mount()` 一次 → `setScene()` 每次版本变化 → `render()` 相机变化时调用。
 */
export class Viewport implements SceneViewport {
  private readonly renderer: THREE.WebGLRenderer
  private readonly scene = new THREE.Scene()
  private readonly ortho = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 10_000)
  private readonly perspective = new THREE.PerspectiveCamera(70, 1, 0.1, 4000)
  /** 这一帧用的是哪台相机（由 `applyCamera` 按投影方式选）。 */
  private active: THREE.Camera = this.ortho
  private overlay: OverlayCanvas
  private grid?: THREE.LineSegments
  private readonly overlayCtx: CanvasRenderingContext2D
  private opaque?: THREE.Mesh
  private translucent?: THREE.Mesh
  private texture?: THREE.DataTexture
  private bounds?: { min: [number, number, number]; max: [number, number, number] }
  private volume: { min: [number, number, number]; max: [number, number, number] } = {
    min: [0, 0, 0],
    max: [0, 0, 0],
  }
  private width = 1
  private height = 1

  constructor(glCanvas: HTMLCanvasElement, private readonly overlayCanvas: HTMLCanvasElement) {
    const ctx = overlayCanvas.getContext('2d')
    if (ctx === null) throw new Error('Could not get a 2D context')
    this.overlayCtx = ctx
    this.renderer = new THREE.WebGLRenderer({ canvas: glCanvas, antialias: true, alpha: false })
    this.renderer.setClearColor(VIEWPORT_CLEAR, 1)
    this.overlay = new OverlayCanvas(1, 1)
    this.scene.background = new THREE.Color(VIEWPORT_CLEAR)
  }

  /** 尺寸跟着容器走（含设备像素比），返回 CSS 像素尺寸。 */
  resize(cssWidth: number, cssHeight: number, pixelRatio: number): void {
    const w = Math.max(1, Math.floor(cssWidth))
    const h = Math.max(1, Math.floor(cssHeight))
    this.width = w
    this.height = h
    this.renderer.setPixelRatio(pixelRatio)
    this.renderer.setSize(w, h, false)
    this.overlayCanvas.width = w
    this.overlayCanvas.height = h
    // `Canvas` 没有 resize（它是一个定尺寸的像素缓冲），尺寸变了就换一个
    if (this.overlay.width !== w || this.overlay.height !== h) this.overlay = new OverlayCanvas(w, h)
  }

  /** 诊断探针：场景里还剩几个 mesh、多少三角形。 */
  debugScene(): { meshes: number; triangles: number } {
    let meshes = 0
    let triangles = 0
    for (const mesh of [this.opaque, this.translucent]) {
      if (mesh === undefined) continue
      meshes += 1
      triangles += (mesh.geometry.getIndex()?.count ?? 0) / 3
    }
    return { meshes, triangles }
  }

  /**
   * 换一份几何。
   *
   * 图集只在第一次（或尺寸变了）上传成 GPU 纹理：4 MB 的 RGBA 每帧重传是纯浪费。
   * 索引按"这张纹理是否全不透明"分成两个 mesh——不透明的可以写深度、不用混合，
   * 半透明的按深度排序后混合。混在一起画的话，玻璃后面的东西会时有时无。
   */
  setScene(payload: ScenePayload): void {
    this.bounds = payload.bounds
    this.volume = payload.volume
    this.rebuildGrid()

    if (this.texture === undefined || this.texture.image.width !== payload.atlas.size) {
      const texture = new THREE.DataTexture(
        new Uint8Array(payload.atlas.data),
        payload.atlas.size,
        payload.atlas.size,
        THREE.RGBAFormat,
      )
      texture.magFilter = THREE.NearestFilter
      texture.minFilter = THREE.NearestFilter
      texture.generateMipmaps = false
      texture.colorSpace = THREE.SRGBColorSpace
      texture.needsUpdate = true
      this.texture?.dispose()
      this.texture = texture
    }

    const atlas: TextureAtlas = {
      size: payload.atlas.size,
      data: payload.atlas.data,
      textures: {},
    }
    const tilesPerRow = tilesPerRowOf(atlas)
    const opaqueTiles = buildOpaqueTileTable(atlas)

    // 顶点色 = AO × 生物群系着色 × **方向明暗**。明暗按法线烘进来，
    // 这样材质可以是不带灯的 MeshBasicMaterial，而每一面的亮度就是原版那个值。
    const vertexCount = payload.positions.length / 3
    const colors = new Float32Array(vertexCount * 3)
    for (let i = 0; i < vertexCount; i++) {
      const shade = shadeFor(payload.normals[i * 3]!, payload.normals[i * 3 + 1]!, payload.normals[i * 3 + 2]!)
      colors[i * 3] = payload.colors[i * 3]! * shade
      colors[i * 3 + 1] = payload.colors[i * 3 + 1]! * shade
      colors[i * 3 + 2] = payload.colors[i * 3 + 2]! * shade
    }

    const opaqueIndices: number[] = []
    const translucentIndices: number[] = []
    for (let t = 0; t < payload.indices.length; t += 3) {
      const i0 = payload.indices[t]!
      const i1 = payload.indices[t + 1]!
      const i2 = payload.indices[t + 2]!
      const uc = (payload.uvs[i0 * 2]! + payload.uvs[i1 * 2]! + payload.uvs[i2 * 2]!) / 3
      const vc = (payload.uvs[i0 * 2 + 1]! + payload.uvs[i1 * 2 + 1]! + payload.uvs[i2 * 2 + 1]!) / 3
      const target = opaqueTiles[tileIndex(uc, vc, tilesPerRow)] === 1 ? opaqueIndices : translucentIndices
      target.push(i0, i1, i2)
    }

    this.disposeMeshes()
    // 顶点属性四份 mesh 共用（两块几何体的 position/normal/color/uv 完全相同）
    const make = (indices: number[], material: THREE.Material): THREE.Mesh => {
      const geometry = new THREE.BufferGeometry()
      geometry.setAttribute('position', new THREE.BufferAttribute(payload.positions, 3))
      geometry.setAttribute('normal', new THREE.BufferAttribute(payload.normals, 3))
      geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3))
      geometry.setAttribute('uv', new THREE.BufferAttribute(payload.uvs, 2))
      geometry.setIndex(indices)
      const mesh = new THREE.Mesh(geometry, material)
      // mesher 的三角形绕向会跟着 AO 翻转（见 vendored models.js），
      // 开背面剔除会随机吃掉一半的面，所以两面都画：背面本来也被正面挡住
      mesh.frustumCulled = false
      this.scene.add(mesh)
      return mesh
    }

    const base = {
      map: this.texture,
      vertexColors: true,
      side: THREE.DoubleSide,
      // 我们的纹理是近邻采样的像素材质，不要各向异性平滑
      fog: false,
    }
    this.opaque = make(
      opaqueIndices,
      new THREE.MeshBasicMaterial({ ...base, alphaTest: 0.5, transparent: false }),
    )
    this.translucent = make(
      translucentIndices,
      new THREE.MeshBasicMaterial({ ...base, transparent: true, depthWrite: false, alphaTest: 0.02 }),
    )
  }

  /** 相机与画布尺寸变化后重画。`draft` 在 GPU 这条路上没有意义（一帧就几毫秒）。 */
  render(view: ViewportCamera, _options?: { draft?: boolean }): void {
    const bounds = this.bounds ?? {
      min: this.volume.min,
      max: this.volume.max,
    }
    const box = {
      min: { x: bounds.min[0], y: bounds.min[1], z: bounds.min[2] },
      max: { x: bounds.max[0], y: bounds.max[1], z: bounds.max[2] },
    }
    const angles = { azimuth: view.azimuth, elevation: clampFreeElevation(view.elevation) }
    // 自动取景由渲染层算——和软件光栅器、和模型截图用的是同一份口径
    // （正交是一个缩放系数，透视是"相机该站在哪儿"，见 `fitCamera` / `fitPerspective`）
    const fitted = fitCamera(box, angles, this.width, this.height)
    const spec: CameraSpec = {
      ...fitted,
      roll: view.roll,
      // 自定义注视点只挪画面中心（正交）**不改缩放**；透视下画面中心由位置与朝向决定
      ...(view.target !== undefined ? { target: { x: view.target[0], y: view.target[1], z: view.target[2] } } : {}),
      ...(view.scale > 0 ? { scale: view.scale } : {}),
      // **透视：相机位置由调用方给**（用户走到哪儿就是哪儿），这里**不重新取景**——
      // 自动取景会把相机放回"框住内容"的地方，用户一走就被拽回去
      ...(view.perspective !== undefined
        ? {
            perspective: {
              eye: { x: view.perspective.eye[0], y: view.perspective.eye[1], z: view.perspective.eye[2] },
              fov: view.perspective.fov,
            },
          }
        : {}),
    }

    const basis = this.applyCamera(spec)
    this.renderer.render(this.scene, this.active)
    this.drawOverlay(spec, basis)
  }

  /**
   * **离屏渲一张给模型看的图**，返回 PNG 的 data URL。
   *
   * 和交互视口的差别只有三点，但每一点都有理由：
   *
   * 1. **尺寸由请求指定**，不是窗口的。模型要 1024×768 就是 1024×768，
   *    不会因为用户把窗口拖窄就跟着变——同一轮对话里的两张图必须能直接对比。
   * 2. **超采样 `CAPTURE_SUPERSAMPLE` 倍再缩回去**。three 的 MSAA render target
   *    在隐藏窗口里的 resolve 行为依驱动而异（不同机器的抗锯齿效果不一致），
   *    而"画大再缩"是纯软件的一步，任何驱动都一样。代价只有一次 drawImage。
   * 3. **叠加层画在缩回之后的 1× 画布上**：标尺数字和标题是位图字体，
   *    跟着一起缩会糊成一片。软件光栅器那条路也是先画方块后写文字，语义一致。
   *
   * 画完把渲染器的 render target 与尺寸还原——截一张图不该改变用户正在看的画面。
   */
  capture(request: CaptureRequest): string {
    const width = Math.max(1, Math.round(request.width))
    const height = Math.max(1, Math.round(request.height))
    const hiW = width * CAPTURE_SUPERSAMPLE
    const hiH = height * CAPTURE_SUPERSAMPLE

    const previousTarget = this.renderer.getRenderTarget()
    const target = new THREE.WebGLRenderTarget(hiW, hiH, {
      minFilter: THREE.NearestFilter,
      magFilter: THREE.NearestFilter,
      depthBuffer: true,
    })

    // 相机规格是主进程解算好的：连 width/height 都带着，所以投影矩阵直接用它的
    this.applyCamera(request.camera)
    this.renderer.setRenderTarget(target)
    this.renderer.render(this.scene, this.active)

    const raw = new Uint8Array(hiW * hiH * 4)
    this.renderer.readRenderTargetPixels(target, 0, 0, hiW, hiH, raw)
    this.renderer.setRenderTarget(previousTarget)
    target.dispose()

    // WebGL 的原点在左下、ImageData 在左上，逐行翻过来
    const rowBytes = hiW * 4
    const hi = document.createElement('canvas')
    hi.width = hiW
    hi.height = hiH
    const hiCtx = hi.getContext('2d')
    if (hiCtx === null) throw new Error('Could not get a 2D context')
    const image = hiCtx.createImageData(hiW, hiH)
    for (let y = 0; y < hiH; y++) {
      const from = (hiH - 1 - y) * rowBytes
      image.data.set(raw.subarray(from, from + rowBytes), y * rowBytes)
    }
    hiCtx.putImageData(image, 0, 0)

    const out = document.createElement('canvas')
    out.width = width
    out.height = height
    const ctx = out.getContext('2d')
    if (ctx === null) throw new Error('Could not get a 2D context')
    ctx.imageSmoothingEnabled = true
    ctx.imageSmoothingQuality = 'high'
    ctx.drawImage(hi, 0, 0, width, height)

    // 叠加层单独一张透明画布，再 alpha 合成上去。
    // **不能直接 putImageData**：那会把 3D 那张图的像素连同 alpha 一起覆盖掉，
    // 叠加层的空白处会把画面擦成透明。
    const bounds = this.bounds ?? { min: this.volume.min, max: this.volume.max }
    const box = {
      min: { x: bounds.min[0], y: bounds.min[1], z: bounds.min[2] },
      max: { x: bounds.max[0], y: bounds.max[1], z: bounds.max[2] },
    }
    const overlay = new OverlayCanvas(width, height)
    overlay.data.fill(0)
    drawOverlays(overlay, request.camera, cameraBasis(request.camera), box, request.overlays)
    const layer = document.createElement('canvas')
    layer.width = width
    layer.height = height
    const layerCtx = layer.getContext('2d')
    if (layerCtx === null) throw new Error('Could not get a 2D context')
    layerCtx.putImageData(new ImageData(new Uint8ClampedArray(overlay.data), width, height), 0, 0)
    ctx.drawImage(layer, 0, 0)

    return out.toDataURL('image/png')
  }

  /**
   * 把一份**完整**的相机规格装进 three 的正交相机。
   *
   * 交互与离屏截图共用它，所以"用户拖到的角度"和"模型看到的角度"不是两套代码。
   * 正交投影下 `eye` 与 `target` 的距离不影响成像（只决定裁剪面），
   * 取一个足够远的固定值即可。
   */
  private applyCamera(spec: CameraSpec): ReturnType<typeof cameraBasis> {
    const basis = cameraBasis(spec)
    if (spec.perspective !== undefined) {
      // **第一人称**：相机就站在 `eye`，朝 `forward` 看。近裁剪面取 0.1，
      // 和软件光栅器那条路（`PERSPECTIVE_NEAR`）保持一致——两条路的裁剪位置不一样的话，
      // "贴着墙站"时 GPU 与兜底视口会画出不同的东西。
      const eye = spec.perspective.eye
      const camera = this.perspective
      camera.position.set(eye.x, eye.y, eye.z)
      camera.up.set(basis.up.x, basis.up.y, basis.up.z)
      camera.lookAt(eye.x + basis.forward.x, eye.y + basis.forward.y, eye.z + basis.forward.z)
      camera.fov = spec.perspective.fov
      camera.aspect = spec.width / Math.max(1, spec.height)
      camera.near = 0.1
      camera.far = 4000
      camera.updateProjectionMatrix()
      this.active = camera
      return basis
    }

    const camera = this.ortho
    // 正交：沿视线后退一个足够远的固定距离（正交投影下距离不影响成像，只决定裁剪面）
    const distance = 2000
    camera.position.set(
      spec.target.x - basis.forward.x * distance,
      spec.target.y - basis.forward.y * distance,
      spec.target.z - basis.forward.z * distance,
    )
    camera.up.set(basis.up.x, basis.up.y, basis.up.z)
    camera.lookAt(spec.target.x, spec.target.y, spec.target.z)

    const halfW = spec.width / 2 / spec.scale
    const halfH = spec.height / 2 / spec.scale
    camera.left = -halfW
    camera.right = halfW
    camera.top = halfH
    camera.bottom = -halfH
    camera.near = 1
    camera.far = distance * 2
    camera.updateProjectionMatrix()
    this.active = camera
    return basis
  }

  /** 叠加层：标尺、坐标轴、工区线框、信息文字。投影与主进程渲染完全一致。 */
  private drawOverlay(spec: CameraSpec, basis: ReturnType<typeof cameraBasis>): void {
    const ctx = this.overlayCtx
    ctx.clearRect(0, 0, this.overlayCanvas.width, this.overlayCanvas.height)
    const bounds = this.bounds
    if (bounds === undefined) return
    const box = {
      min: { x: bounds.min[0], y: bounds.min[1], z: bounds.min[2] },
      max: { x: bounds.max[0], y: bounds.max[1], z: bounds.max[2] },
    }
    const options = {
      ruler: true,
      axisGizmo: true,
      volumeBox: {
        min: { x: this.volume.min[0], y: this.volume.min[1], z: this.volume.min[2] },
        max: { x: this.volume.max[0], y: this.volume.max[1], z: this.volume.max[2] },
      },
      caption: [
        `REV ${this.revision}  AZ ${spec.azimuth.toFixed(0)}  EL ${spec.elevation.toFixed(0)}${spec.roll !== undefined && spec.roll !== 0 ? `  RL ${spec.roll.toFixed(0)}` : ''}`,
        `BOUNDS ${bounds.min.join(',')}..${bounds.max.join(',')}`,
      ],
    }
    this.overlay.clear({ r: 0, g: 0, b: 0 })
    this.overlay.data.fill(0)
    // **地面网格不画在 2D 叠加层上**：叠加层永远在最上面，格线会横穿建筑表面
    // （真机上就是这个观感）。网格改成 three 里的 3D 线段，参与深度测试，
    // 于是它天然被方块挡住——和软件光栅器"先画地面再画方块"的顺序一致。
    drawOverlays(this.overlay, spec, basis, box, options)
    ctx.putImageData(
      new ImageData(new Uint8ClampedArray(this.overlay.data), this.width, this.height),
      0,
      0,
    )
  }

  private revision = 0

  setRevision(revision: number): void {
    this.revision = revision
  }

  /**
   * 地面标尺网格，**画成 3D 线段**。
   *
   * 不放进 2D 叠加层的理由见 `drawOverlay`。线段放在内容底面上，间隔与原版
   * 标尺一致（每 4 格一条），颜色压得很暗——它是参考线，不该抢建筑的注意力。
   */
  private rebuildGrid(): void {
    if (this.grid !== undefined) {
      this.scene.remove(this.grid)
      this.grid.geometry.dispose()
      ;(this.grid.material as THREE.Material).dispose()
      this.grid = undefined
    }
    const bounds = this.bounds
    if (bounds === undefined) return
    const step = 4
    const y = bounds.min[1] - 0.01
    const [x0, z0] = [bounds.min[0] - 4, bounds.min[2] - 4]
    const [x1, z1] = [bounds.max[0] + 5, bounds.max[2] + 5]
    const points: number[] = []
    for (let x = Math.ceil(x0 / step) * step; x <= x1; x += step) {
      points.push(x, y, z0, x, y, z1)
    }
    for (let z = Math.ceil(z0 / step) * step; z <= z1; z += step) {
      points.push(x0, y, z, x1, y, z)
    }
    const geometry = new THREE.BufferGeometry()
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(points, 3))
    this.grid = new THREE.LineSegments(
      geometry,
      new THREE.LineBasicMaterial({ color: 0x3a4a63, transparent: true, opacity: 0.75 }),
    )
    this.grid.frustumCulled = false
    this.scene.add(this.grid)
  }

  private disposeMeshes(): void {
    for (const mesh of [this.opaque, this.translucent]) {
      if (mesh === undefined) continue
      this.scene.remove(mesh)
      mesh.geometry.dispose()
      ;(mesh.material as THREE.Material).dispose()
    }
    this.opaque = undefined
    this.translucent = undefined
  }
}

/**
 * **没有 WebGL 时的视口**：让主进程用软件光栅器画，渲染进程只负责把 RGBA 贴上去。
 *
 * 它存在的唯一理由是**不能让界面打不开**。`new THREE.WebGLRenderer()` 在没有 WebGL
 * 的机器上会抛，而这一抛会连带把对话面板一起带走——用户连"描述需求"都做不到。
 * 慢和糊都可以忍，用不了不行。
 *
 * 代价说清楚：
 * - 每帧要走一趟 IPC（~0.3–2.5 MB 的结构化克隆），拖动时降到 1/2 边长（1/4 像素）并跳过叠加层
 * - 无抗锯齿（软件光栅器本来就没有）
 * - **模型截图不从这里走**：主进程自己就是软件光栅器，绕这一圈只是白花
 *
 * 三件事值得单独说：
 *
 * 1. **请求要合并**。拖动时 pointermove 比光栅化快得多，排队的结果是画面越拖越落后
 *    （"橡皮筋"）。所以同一时刻只允许一个请求在飞，飞行途中来的新相机只保留最新那个。
 * 2. **相同的帧不要重画**。每次状态事件（对话多一条消息、自动保存）都会催一次重绘，
 *    而同一个版本 + 同一个尺寸 + 同一个机位的图是逐像素一样的。
 * 3. **过期帧要丢**。尺寸在飞行途中变了的话，落笔的坐标就错了。
 */
export class SoftwareViewport implements SceneViewport {
  /**
   * 软件视口**不持有场景**——几何一直在主进程中，它每帧去要一张画好的图。
   * 所以这里如实报 0：它的"清空"由主进程的光栅器负责（那边按空世界画）。
   */
  debugScene(): { meshes: number; triangles: number } {
    return { meshes: 0, triangles: 0 }
  }

  private width = 1
  private height = 1
  private revision = -1
  private pending: { view: ViewportCamera; draft: boolean } | undefined
  private pumping = false
  private disposed = false
  /** 上一次**真的贴上去了**的帧指纹（版本 + 尺寸 + 草稿与否 + 机位）。 */
  private lastDrawn: string | undefined
  /** 已经贴上去的帧数，给状态栏与测试看。 */
  frames = 0
  /** 草稿帧降过分辨率，测试用它断言"拖动真的省了像素"。 */
  lastRequestSize: { width: number; height: number } | undefined

  constructor(
    private readonly sink: FrameSink,
    private readonly requestFrame: (request: SoftwareFrameRequest) => Promise<SoftwareFrame>,
  ) {}

  setRevision(revision: number): void {
    this.revision = revision
  }

  setScene(payload: ScenePayload): void {
    // 几何留在主进程——这里只需要知道版本变了，下一帧自然会拉新的
    this.revision = payload.revision
  }

  /**
   * **忽略设备像素比**。
   *
   * 软件光栅器的成本与像素数成正比，而 dpr=2 意味着 4 倍的工作量换一点点锐度。
   * 画布用 CSS 拉伸到实际尺寸，模糊一点可以接受。
   */
  resize(cssWidth: number, cssHeight: number, _pixelRatio: number): void {
    this.width = Math.max(1, Math.floor(cssWidth))
    this.height = Math.max(1, Math.floor(cssHeight))
    this.sink.resize(this.width, this.height)
  }

  render(view: ViewportCamera, options?: { draft?: boolean }): void {
    if (this.disposed) return
    this.pending = { view, draft: options?.draft === true }
    void this.pump()
  }

  dispose(): void {
    this.disposed = true
    this.pending = undefined
  }

  /** 这一帧的指纹。尺寸也在里面：改窗口大小必须重画。 */
  private frameKey(request: { view: ViewportCamera; draft: boolean }): string {
    const { view } = request
    return [
      this.revision,
      `${this.width}x${this.height}`,
      request.draft ? 'draft' : 'full',
      view.azimuth.toFixed(3),
      view.elevation.toFixed(3),
      view.roll.toFixed(3),
      view.scale.toFixed(3),
      view.target?.map((v) => v.toFixed(2)).join(',') ?? '-',
    ].join('|')
  }

  private async pump(): Promise<void> {
    if (this.pumping) return
    this.pumping = true
    try {
      while (this.pending !== undefined && !this.disposed) {
        const next = this.pending
        this.pending = undefined
        const key = this.frameKey(next)
        if (key === this.lastDrawn) continue
        // 拖动时降分辨率：画完由 sink 放大回去
        const divisor = next.draft ? DRAFT_DOWNSCALE : 1
        const width = Math.max(1, Math.ceil(this.width / divisor))
        const height = Math.max(1, Math.ceil(this.height / divisor))
        this.lastRequestSize = { width, height }
        let frame: SoftwareFrame
        try {
          frame = await this.requestFrame({
            azimuth: next.view.azimuth,
            elevation: next.view.elevation,
            roll: next.view.roll,
            ...(next.view.scale > 0 ? { scale: next.view.scale } : {}),
            ...(next.view.target !== undefined ? { target: next.view.target } : {}),
            width,
            height,
            draft: next.draft,
          })
        } catch {
          // 主进程画不出来（世界刚被换掉之类）不该把循环卡死：丢掉这一帧等下一条。
          // 注意**不能**记进 `lastDrawn`——这一帧根本没画出来
          continue
        }
        // 飞行途中尺寸变了 → 这张的坐标已经不对了，丢掉
        if (frame.width !== width || frame.height !== height) continue
        this.sink.blit(frame)
        this.lastDrawn = key
        this.frames++
      }
    } finally {
      this.pumping = false
    }
  }
}

/** 法线 → 原版方向明暗。与 `raster.ts` 的判据一致（主轴）。 */
function shadeFor(nx: number, ny: number, nz: number): number {
  const ax = Math.abs(nx)
  const ay = Math.abs(ny)
  const az = Math.abs(nz)
  if (ay >= ax && ay >= az) return ny >= 0 ? FACE_SHADE.up : FACE_SHADE.down
  if (az >= ax) return FACE_SHADE.z
  return FACE_SHADE.x
}
