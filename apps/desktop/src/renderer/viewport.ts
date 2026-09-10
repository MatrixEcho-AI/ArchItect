/**
 * 桌面视口：**three.js（WebGL）+ 一层 2D 叠加层**。
 *
 * ## 为什么主进程里那套软件光栅器不用于这里
 *
 * 软件光栅器存在的理由是**确定性**：CI、无 GPU 的服务器、golden 测试都要可复现。
 * 交互视口的诉求正相反——要跟手、要抗锯齿、要纹理在斜视角下不闪。这两件事
 * 最好由不同的东西来做：
 *
 * | | 交互视口（这个文件） | 模型截图 / CLI（软件光栅器） |
 * |---|---|---|
 * | 帧率 | 60 fps（GPU） | 一次一张，慢无所谓 |
 * | 抗锯齿 | MSAA | 无 |
 * | 纹理过滤 | mipmap + 各向异性 | 最近邻 |
 * | 确定性 | 不要求（不同 GPU 有差异） | **要求**（golden 测试） |
 *
 * 但**几何是同一份**：都吃 mesher 的输出（世界坐标 + UV + AO 顶点色），
 * 相机也共用 `cameraBasis`。所以视口里看到的和模型看到的是同一个世界，
 * 只是画法不同。
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
  drawOverlays,
  fitCamera,
  tileIndex,
  tilesPerRowOf,
} from '@architect/render/browser'
import type { CameraSpec, TextureAtlas } from '@architect/render/browser'
import * as THREE from 'three'

interface ScenePayload {
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
  /** 每格像素。 */
  scale: number
}

/**
 * 一个 three.js 视口。
 *
 * 生命周期：`mount()` 一次 → `setScene()` 每次版本变化 → `render()` 相机变化时调用。
 */
export class Viewport {
  private readonly renderer: THREE.WebGLRenderer
  private readonly scene = new THREE.Scene()
  private readonly camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 10_000)
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
    if (ctx === null) throw new Error('拿不到 2D 上下文')
    this.overlayCtx = ctx
    this.renderer = new THREE.WebGLRenderer({ canvas: glCanvas, antialias: true, alpha: false })
    this.renderer.setClearColor(0x1a1c22, 1)
    this.overlay = new OverlayCanvas(1, 1)
    this.scene.background = new THREE.Color(0x1a1c22)
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

  /** 相机与画布尺寸变化后重画。 */
  render(view: ViewportCamera): void {
    const bounds = this.bounds ?? {
      min: this.volume.min,
      max: this.volume.max,
    }
    const box = {
      min: { x: bounds.min[0], y: bounds.min[1], z: bounds.min[2] },
      max: { x: bounds.max[0], y: bounds.max[1], z: bounds.max[2] },
    }
    const angles = { azimuth: view.azimuth, elevation: clamp(view.elevation, 1, 89) }
    // 自动取景由渲染层的 `fitCamera` 算——和软件光栅器、和模型截图用的是同一份，
    // 所以三方看到的取景完全一致
    const fitted = fitCamera(box, angles, this.width, this.height)
    const spec: CameraSpec = {
      ...fitted,
      roll: view.roll,
      ...(view.scale > 0 ? { scale: view.scale } : {}),
    }

    const basis = cameraBasis(spec)
    const distance = 2000
    this.camera.position.set(
      spec.target.x - basis.forward.x * distance,
      spec.target.y - basis.forward.y * distance,
      spec.target.z - basis.forward.z * distance,
    )
    this.camera.up.set(basis.up.x, basis.up.y, basis.up.z)
    this.camera.lookAt(spec.target.x, spec.target.y, spec.target.z)

    const halfW = this.width / 2 / spec.scale
    const halfH = this.height / 2 / spec.scale
    this.camera.left = -halfW
    this.camera.right = halfW
    this.camera.top = halfH
    this.camera.bottom = -halfH
    this.camera.near = 1
    this.camera.far = distance * 2
    this.camera.updateProjectionMatrix()

    this.renderer.render(this.scene, this.camera)
    this.drawOverlay(spec, basis)
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

/** 法线 → 原版方向明暗。与 `raster.ts` 的判据一致（主轴）。 */
function shadeFor(nx: number, ny: number, nz: number): number {
  const ax = Math.abs(nx)
  const ay = Math.abs(ny)
  const az = Math.abs(nz)
  if (ay >= ax && ay >= az) return ny >= 0 ? FACE_SHADE.up : FACE_SHADE.down
  if (az >= ax) return FACE_SHADE.z
  return FACE_SHADE.x
}

const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v)
