import {
  clampFreeElevation,
  DEFAULT_FOV,
  fitPerspective,
  orientationFromEye,
} from '@architect/render/browser'

import {
  createFreeCamera,
  dragUnitFor,
  forwardOf,
  FOV_RANGE,
  lookAtFrom,
  moveStep,
  place,
  turn,
  zoom,
} from './freecamera.js'
import { SoftwareViewport, Viewport } from './viewport.js'
import type { FreeCamera } from './freecamera.js'
import type { CaptureAnswer, CaptureShotRequest, ScenePayload, StudioState } from './types.js'
import type { CameraSpec, OverlayOptions } from '@architect/render/browser'
import type { MessageKey } from '@architect/i18n'
import type { FrameSink, SceneViewport, SoftwareFrame, ViewportCamera } from './viewport.js'

/**
 * **视口与相机**：React 树之外的那一半。
 *
 * 为什么不做成组件状态：这里的东西全是**命令式且高频**的——WebGL 上下文只能建一次、
 * 拖动要按帧合流、WASD 要按 `requestAnimationFrame` 连续推进。把它们塞进 `useState`
 * 会让每移动一个像素就重渲染一整棵树，而画布本身一个字节都没变。
 *
 * 所以分工是死的：**这个类持有"用户在看的那个视角"，React 只持有"界面该显示什么"**。
 * 两者通过三个口子通信：
 *   - `onCameraChanged`：相机动了（拖动 / 走动 / 滚轮）→ React 刷新机位字段与状态行
 *   - `onState`：`setCamera` 的返回值（主进程算出来的新状态）→ React 更新左栏
 *   - `onStatus`：一行状态文字（走 `setStatus` 那条路）
 *
 * ⚠️ 相机的**位置**是真的（D-76 的透视投影）：`place()` 之后它就是"你站在哪"，
 * 拖动只改朝向（`turn`），WASD 改位置（`moveStep`），空格 / Shift 沿世界 Y 升降。
 * 这套语义有一整组测试钉着（`test/freecamera.test.ts` 与 gui-smoke 的 wasd-move），
 * 搬进类里时**一个符号都没动**。
 */

/**
 * 场景底色。**浅色主题下这张画布是浅的**，取 antd 的 `colorBgLayout` 一档。
 *
 * 它必须与 `viewport.ts` 里 WebGL 的 `setClearColor` 是同一个数：两处不一致的话，
 * 稀疏区域（没有方块的地方）会随渲染路径在两个颜色之间闪。
 */
export const VIEWPORT_CLEAR = 0xf5f6f8

/**
 * 把软件帧贴到**叠加层**画布上。
 *
 * 为什么是叠加层而不是下面那张 WebGL 画布：没有 WebGL 时后者连 2D 上下文都拿不到。
 * 叠加层本来就是 2D 的、尺寸完全一样、还在最上面，所以软件模式下由它整帧顶替。
 *
 * **画布的像素尺寸由 `resize` 定**，不是由帧大小定：草稿帧是降过分辨率的，
 * 让它去改画布尺寸会让"拖动中"和"松手后"两块缓冲来回换，画面会跳。
 * 帧比画布小时用 `drawImage` 放大回去，而且**关掉插值**——像素画放大本来就该是硬边。
 */
class CanvasFrameSink implements FrameSink {
  private readonly scratch = document.createElement('canvas')
  private width = 1
  private height = 1

  constructor(private readonly canvas: HTMLCanvasElement) {}

  resize(width: number, height: number): void {
    this.width = Math.max(1, Math.floor(width))
    this.height = Math.max(1, Math.floor(height))
    if (this.canvas.width !== this.width || this.canvas.height !== this.height) {
      this.canvas.width = this.width
      this.canvas.height = this.height
    }
  }

  blit(frame: SoftwareFrame): void {
    const target = this.canvas.getContext('2d')
    const scratch = this.scratch.getContext('2d')
    if (target === null || scratch === null) return
    if (this.scratch.width !== frame.width || this.scratch.height !== frame.height) {
      this.scratch.width = frame.width
      this.scratch.height = frame.height
    }
    scratch.putImageData(
      new ImageData(new Uint8ClampedArray(frame.pixels), frame.width, frame.height),
      0,
      0,
    )
    target.imageSmoothingEnabled = false
    target.drawImage(this.scratch, 0, 0, frame.width, frame.height, 0, 0, this.width, this.height)
  }
}

/**
 * 这台机器有没有可用的 WebGL。
 *
 * 用一个**一次性的探针画布**，不碰真正的视口画布：three 的构造函数会独占那张画布，
 * 拿它试错的话失败之后就再也拿不到干净的上下文了。
 */
function webglAvailable(): boolean {
  try {
    const probe = document.createElement('canvas')
    return probe.getContext('webgl2') !== null || probe.getContext('webgl') !== null
  } catch {
    return false
  }
}

/** 用户手填过、且**方向没变**的那组 eye/lookAt（见 `syncFields` 的注释）。 */
interface TypedEye {
  eye: [number, number, number]
  lookAt: [number, number, number]
  azimuth: number
  elevation: number
}

export interface ViewportShellOptions {
  canvas: HTMLCanvasElement
  overlay: HTMLCanvasElement
  /** `location.hash` 里的诊断开关（`no-webgl` 会让这里强制走软件视口）。 */
  debugFlags: ReadonlySet<string>
  /**
   * 机位字段的**读取器**：React 那边持有输入框的当前值，这里只在"应用"时问它要一次。
   *
   * 反过来由 React 通过 `cameraSnapshot()` 拉取要显示的值。这个方向是刻意的：
   * 相机是权威，字段是它的单向镜。
   */
  /** 相机变了（拖动 / 走动 / 滚轮 / 应用字段）→ 让 React 刷新显示。 */
  onCameraChanged: () => void
  /** `setCamera` 回来的新状态。 */
  onState: (state: StudioState) => void
  /**
   * 一行状态文字。**给的是 i18n 的键，不是成品文案**：
   * 这个类是 React 树之外的一层，不该知道当前是哪国语言（语言切换要即时生效，
   * 而外壳只在构造时拿到一次回调）。翻译在 `App` 那一侧做。
   */
  onStatus: (key: MessageKey) => void
}

export class ViewportShell {
  private readonly camera: FreeCamera = createFreeCamera({
    azimuth: 45,
    elevation: 35,
    fov: DEFAULT_FOV,
  })
  private readonly sink: CanvasFrameSink
  private viewport: SceneViewport
  /** 当前视口是不是软件实现（状态栏要说实话，模型截图那条路也跟着它走）。 */
  readonly software: boolean
  /** 视口的 CSS 尺寸。透视取景（相机该站在哪儿）要按它算。 */
  private viewSize = { width: 1, height: 1 }
  private sceneRevision = -1
  /** 预设机位的角度由主进程给（`VIEW_PRESETS` 是唯一真相）。 */
  private readonly presetAngles = new Map<string, { azimuth: number; elevation: number }>()
  /** 画一帧的节流：pointermove 的频率远高于屏幕刷新。 */
  private frameQueued = false
  /** 本次排队的是不是"草稿帧"（拖动中）。GPU 那条路忽略它。 */
  private frameDraft = false
  /** 草稿帧之后补一张全分辨率的那一枪。 */
  private refineTimer: number | undefined
  /** 机位面板有没有把机位同步给模型（会话相机）。 */
  private camShared = false
  /** 推机位给主进程的节流句柄：拖动时每个 pointermove 都推一次会白写几百次 IPC。 */
  private pushTimer: number | undefined
  /** 相机换过工程没有：换了就回到"框住内容"的默认取景。 */
  private projectKey: string | undefined
  private typedEye: TypedEye | undefined
  private current: StudioState | undefined
  private sessionView = 'iso_ne'

  constructor(private readonly options: ViewportShellOptions) {
    this.sink = new CanvasFrameSink(options.overlay)
    const useGpu = !options.debugFlags.has('no-webgl') && webglAvailable()
    let gpu: Viewport | undefined
    if (useGpu) {
      try {
        gpu = new Viewport(options.canvas, options.overlay)
      } catch (error) {
        // three 的构造函数抛了也要能继续：兜底那条路就是为这种情况准备的
        console.warn('WebGL init failed, falling back to the software viewport:', error)
      }
    }
    this.software = gpu === undefined
    this.viewport =
      gpu ?? new SoftwareViewport(this.sink, (request) => window.architect.viewport(request))
  }

  // ── 状态同步 ────────────────────────────────────────────────────────────────

  /** 主进程推来一份新状态。换工程时把相机丢掉、回到自动取景。 */
  setState(state: StudioState): void {
    const previous = this.current
    this.current = state
    const key = `${state.name}\u0000${state.projectPath ?? ''}`
    if (key !== this.projectKey) {
      this.projectKey = key
      // **位置是真实的点了**，不重置的话上一座建筑里走到的那个位置会把新打开的东西
      // 留在画面外，看上去像"打开失败了"
      delete this.camera.eye
      this.typedEye = undefined
      this.options.onCameraChanged()
    }
    /**
     * **换了世界就把几何重新同步一遍再画。**
     *
     * 这里是"新建之后画布没清空"的修复，而这个 bug 的关键在于**调用的是哪个方法**：
     * `requestFrame()` 只把**当前已有的 mesh** 重画一遍，它从不问主进程要新几何；
     * 拉几何只发生在 `shoot()` 里（`syncScene()` + 排帧）。
     *
     * 而"世界换了"这条消息是通过 React 的 effect 走到这里的（界面拿到新状态 →
     * `shell.setState`），这条路上**没有别人会去拉几何**：`App.afterState` 里那次
     * `shoot()` 跑在 React 提交之前，读到的还是上一份状态，于是因为"版本没变"早退。
     * 两边合起来的表现就是：状态、左栏、时间线、对话全对了，**画布上老房子一直挂着**
     * （实测诊断数字 `1394→1394 三角形`）。
     *
     * 把"状态换了"本身当成需要重拉几何的事件，就不再依赖调用顺序。
     * 同一版本内的推送（比如只多了条对话）只排一帧，不白拉一次几 MB 的几何。
     */
    if (previous === undefined || previous.revision !== state.revision) {
      this.sceneRevision = -1
      void this.shoot()
    } else {
      this.requestFrame()
    }
  }

  /** 当前工程名对应的 UI 机位预设（下拉框那个值）。 */
  setSessionView(view: string): void {
    this.sessionView = view
  }

  async loadPresets(): Promise<void> {
    try {
      for (const [key, value] of Object.entries(await window.architect.viewPresets())) {
        this.presetAngles.set(key, value)
      }
      this.applyPreset(this.sessionView)
    } catch {
      // 拿不到预设角度不影响拖动，只是下拉框不改变视角
    }
  }

  /** 选中一个预设机位。`free`（拖动留下的状态）不是预设，不动相机。 */
  applyPreset(name: string): void {
    const angles = this.presetAngles.get(name)
    if (angles === undefined) return
    this.camera.azimuth = angles.azimuth
    this.camera.elevation = clampFreeElevation(angles.elevation)
    this.camera.roll = 0
    // 预设机位一律回到**"框住内容"**：位置丢掉，交给自动取景重新算站在哪儿
    delete this.camera.eye
    // 换机位就丢掉"用户手填的 eye"——方向变了，那三个数不再代表当前朝向
    this.typedEye = undefined
  }

  // ── 相机的几何 ──────────────────────────────────────────────────────────────

  /** 内容中心。和 `fitCamera` 用的是同一个式子（+1 是"方块占一格"的补偿）。 */
  private contentCenter(): [number, number, number] {
    const bounds = this.current?.bounds
    if (bounds === undefined) return [0, 0, 0]
    return [
      (bounds.min[0] + bounds.max[0] + 1) / 2,
      (bounds.min[1] + bounds.max[1] + 1) / 2,
      (bounds.min[2] + bounds.max[2] + 1) / 2,
    ]
  }

  /**
   * 自动取景：**相机该站在哪儿**（透视投影下距离决定大小，所以这件事必须算）。
   *
   * 用渲染层的 `fitPerspective`：它把包围盒的八个角点塞进视锥，解出恰好框住的距离。
   * 拿不到内容（空世界）时退到一个固定的站位。
   */
  private fittedEye(): [number, number, number] {
    /**
     * **取景框住的是 `frame`**（参考区域 ∪ 内容包围盒），不是裸的内容包围盒。
     *
     * 裸内容包围盒会被一个远处的方块撑到极大：往 (100,5,100) 放一块石头，相机为了把它
     * 和 32³ 的小屋一起框进去，会把整座小屋缩成一个绿点。`frame` 由主进程算好送过来，
     * 见 `StudioService.frameBounds`。
     *
     * 旧状态快照里没有这个字段（它是后加的），所以留 `bounds ?? volume` 兜底。
     */
    const bounds = this.current?.frame ?? this.current?.bounds ?? this.current?.volume
    const angles = {
      azimuth: this.camera.azimuth,
      elevation: clampFreeElevation(this.camera.elevation),
    }
    if (bounds === undefined) {
      const forward = forwardOf(this.camera)
      return [forward[0] * -32, forward[1] * -32, forward[2] * -32]
    }
    const box = {
      min: { x: bounds.min[0], y: bounds.min[1], z: bounds.min[2] },
      max: { x: bounds.max[0], y: bounds.max[1], z: bounds.max[2] },
    }
    const spec = fitPerspective(box, angles, {
      fov: this.camera.fov,
      width: this.viewSize.width,
      height: this.viewSize.height,
      roll: this.camera.roll,
    })
    const eye = spec.perspective!.eye
    return [eye.x, eye.y, eye.z]
  }

  /** 相机位置（落地了就是它自己，没落地就是自动取景算出来的那个点）。 */
  eye(): [number, number, number] {
    return this.camera.eye ?? this.fittedEye()
  }

  /**
   * 相机看向的那个点（距离取"到内容中心那么远"）。
   *
   * 它只有一个用途：**推给模型当 `lookAt`**，以及机位面板里显示/编辑"注视点"。
   * 成像不看它——透视投影只认位置与朝向。
   */
  lookAt(): [number, number, number] {
    const eye = this.eye()
    const center = this.contentCenter()
    const distance = Math.max(
      1,
      Math.hypot(center[0] - eye[0], center[1] - eye[1], center[2] - eye[2]),
    )
    return lookAtFrom({ ...this.camera, eye }, distance)
  }

  /** 交给渲染层 / 拾取的那一份相机（透视：位置 + 朝向 + 视场角）。 */
  viewportCamera(): ViewportCamera {
    return {
      azimuth: this.camera.azimuth,
      elevation: clampFreeElevation(this.camera.elevation),
      roll: this.camera.roll,
      scale: 0,
      perspective: { eye: this.eye(), fov: this.camera.fov },
    }
  }

  /** 相机是否已经"落地"（`WASD` 走过、或从坐标应用过）。状态行据此换一种说法。 */
  get settled(): boolean {
    return this.camera.eye !== undefined
  }

  /** 当前角度，给状态行与自动化断言用。 */
  angles(): { azimuth: number; elevation: number } {
    return { azimuth: this.camera.azimuth, elevation: this.camera.elevation }
  }

  /**
   * 把相机**落到一个具体位置上**（第一次转头 / 按 WASD 时）。
   *
   * 落点用的是自动取景算出来的站法：站在那个点上，内容刚好框进画面。落点之后
   * 相机就归用户了——转头只改朝向、WASD 只改位置，自动取景不再插手中途。
   * （换预设、双击、"按角度"应用都会把位置丢掉，重新自动取景。）
   */
  private settle(): void {
    if (this.camera.eye !== undefined) return
    place(this.camera, this.fittedEye())
  }

  /**
   * 机位面板要显示的那一组数：角度 + 位置 + 注视点，**已经格式化好**。
   *
   * 单向镜的规则在这一处实现：相机变了就刷新字段，但用户正在面板里打字时不刷新
   * （调用方用 `cameraPanelBusy()` 判断）。见 `TypedEye` 的注释。
   */
  cameraFields(): {
    azimuth: string
    elevation: string
    roll: string
    fov: string
    eye: [string, string, string]
    lookAt: [string, string, string]
  } {
    const target = this.lookAt()
    const typed = this.typedEye
    const keep =
      typed !== undefined &&
      Math.abs(typed.azimuth - this.camera.azimuth) < 1e-6 &&
      Math.abs(typed.elevation - this.camera.elevation) < 1e-6 &&
      typed.lookAt.every((value, index) => Math.abs(value - target[index]!) < 1e-6)
    if (!keep) this.typedEye = undefined
    const eye = keep ? typed.eye : this.eye()
    const look = keep ? typed.lookAt : target
    const round = (value: number): string => String(Math.round(value * 10) / 10)
    return {
      azimuth: round(this.camera.azimuth),
      elevation: round(this.camera.elevation),
      roll: round(this.camera.roll),
      fov: round(this.camera.fov),
      eye: [round(eye[0]), round(eye[1]), round(eye[2])],
      lookAt: [round(look[0]), round(look[1]), round(look[2])],
    }
  }

  /**
   * 把界面上填的一组数应用回相机。返回是否成功（坐标不完整时不改相机）。
   *
   * `mode === 'eye'` = "相机站在 eye、看向 lookAt"（位置就是用户填的那个点）；
   * `mode === 'angle'` = "从这些角度框住内容"（位置丢掉，和预设机位同一个语义）。
   */
  applyFields(input: {
    mode: 'angle' | 'eye'
    azimuth: string
    elevation: string
    roll: string
    fov: string
    eye: [string, string, string]
    lookAt: [string, string, string]
  }): boolean {
    const num = (value: string, fallback: number): number => {
      const parsed = Number(value)
      return value.trim().length > 0 && Number.isFinite(parsed) ? parsed : fallback
    }
    const roll = num(input.roll, this.camera.roll)
    this.camera.fov = Math.min(
      FOV_RANGE.max,
      Math.max(FOV_RANGE.min, num(input.fov, this.camera.fov)),
    )

    if (input.mode === 'eye') {
      const eye = input.eye.map(Number)
      const look = input.lookAt.map(Number)
      if ([...eye, ...look].some((value) => !Number.isFinite(value))) {
        this.options.onStatus('viewport.cam.invalid')
        return false
      }
      try {
        const oriented = orientationFromEye(
          { x: eye[0]!, y: eye[1]!, z: eye[2]! },
          { x: look[0]!, y: look[1]!, z: look[2]! },
        )
        this.camera.azimuth = oriented.azimuth
        this.camera.elevation = clampFreeElevation(oriented.elevation)
      } catch {
        // 两点重合，朝向无法确定
        this.options.onStatus('viewport.cam.invalid')
        return false
      }
      place(this.camera, [eye[0]!, eye[1]!, eye[2]!])
      this.typedEye = {
        eye: [eye[0]!, eye[1]!, eye[2]!],
        lookAt: [look[0]!, look[1]!, look[2]!],
        azimuth: this.camera.azimuth,
        elevation: this.camera.elevation,
      }
    } else {
      this.camera.azimuth = num(input.azimuth, this.camera.azimuth)
      this.camera.elevation = clampFreeElevation(num(input.elevation, this.camera.elevation))
      delete this.camera.eye
      this.typedEye = undefined
    }

    this.camera.roll = roll
    this.options.onCameraChanged()
    this.pushCamera()
    this.requestFrame()
    return true
  }

  /** 双击 / 复位：回到默认取景（位置丢掉、视场角回默认）。 */
  resetToPreset(preset: string): void {
    this.applyPreset(preset)
    this.typedEye = undefined
    this.options.onCameraChanged()
    this.requestFrame()
    this.pushCamera()
  }

  // ── 人机共用机位 ────────────────────────────────────────────────────────────

  get shared(): boolean {
    return this.camShared
  }

  /**
   * 勾 / 取消「模型用这个机位」。
   *
   * 取消时推 `null` 复原，并且**反馈要说清楚**：用户勾了共享却看不到任何确认，
   * 就不知道模型到底看的是哪儿。
   */
  setShared(shared: boolean): void {
    this.camShared = shared
    if (shared) {
      this.pushCamera()
      this.options.onStatus('viewport.cam.shared')
    } else {
      void window.architect.setCamera(null).then(this.options.onState)
      this.options.onStatus('viewport.cam.unshared')
    }
    this.requestFrame()
  }

  /**
   * 把当前机位推给主进程的会话——**模型接下来的截图就从这里看**。
   *
   * 只在勾了共享时推，并且节流。推的是**位置 + 注视点**：会话相机支持这两个字段，
   * 而且它们正是"我站在这里、看那边"的完整描述。模型自己的截图仍是正交等轴测（D-76），
   * 所以它看到的是**同一个方向**上的另一种画法。
   */
  private pushCamera(): void {
    if (!this.camShared) return
    if (this.pushTimer !== undefined) window.clearTimeout(this.pushTimer)
    this.pushTimer = window.setTimeout(() => {
      this.pushTimer = undefined
      void window.architect
        .setCamera({
          azimuth: this.camera.azimuth,
          elevation: this.camera.elevation,
          roll: this.camera.roll,
          eye: this.eye(),
          lookAt: this.lookAt(),
        })
        // 把主进程回来的状态交回 React，「模型机位」那一行才会立刻变——
        // 否则用户勾了共享却看不到任何确认
        .then(this.options.onState)
    }, 120)
  }

  // ── 与视口的交互（拖动 / 滚轮 / 双击 / WASD / 尺寸） ─────────────────────────

  /**
   * 走多快（格/秒）：跟内容尺寸走。
   *
   * 固定速度在 8 格的小屋上刚好、在 200 格的城堡上就慢得没法用；反过来也一样。
   * 取内容包围球半径的一半，再兜一个下限——大约"两秒横穿自己的建筑"。
   */
  private walkSpeed(): number {
    const bounds = this.current?.bounds
    if (bounds === undefined) return 8
    const [dx, dy, dz] = [
      bounds.max[0] - bounds.min[0] + 1,
      bounds.max[1] - bounds.min[1] + 1,
      bounds.max[2] - bounds.min[2] + 1,
    ]
    return Math.max(6, Math.hypot(dx, dy, dz) / 4)
  }

  /**
   * 拖动一次（`dx`/`dy` 是本次指针位移）。
   *
   * 方向的定义在 `turn()` 里：往右拖 = 画面里的东西跟着手往右走（相机左转）。
   * 透视下"画面往哪边走"才是手感，角度本身的符号只是实现细节。
   */
  drag(dx: number, dy: number, altKey: boolean, viewportHeight: number): void {
    if (altKey) {
      // Alt + 拖动 = 滚转。不占额外按钮：滚转是偶尔用一次的调节
      this.camera.roll = (this.camera.roll + dx * 0.4) % 360
      this.requestFrame(true)
      return
    }
    // 灵敏度按视口高度归一（固定 °/px 在窄窗口里会转得太快），再乘一个整体手感系数；
    // 两个数都在 `dragUnitFor()` 里，改动它会同步影响"拖动 = 转多少度"的单元测试
    const unit = dragUnitFor(viewportHeight)
    // **先把相机落到一个位置上**：视角从此相对**相机自己**转（世界绕你摆）
    this.settle()
    turn(this.camera, dx, dy, unit)
    this.pushCamera()
    this.options.onCameraChanged()
    this.requestFrame(true)
  }

  /** 滚轮 = 改视场角（人不动，镜头变焦）。指数变化手感才均匀。 */
  wheel(deltaY: number): void {
    zoom(this.camera, deltaY)
    this.requestFrame(true)
    this.pushCamera()
    this.options.onCameraChanged()
  }

  /** 双击：我转晕了，回到默认取景。 */
  dblclick(): void {
    this.camera.roll = 0
    delete this.camera.eye
    this.camera.fov = DEFAULT_FOV
    this.typedEye = undefined
    this.requestFrame()
    this.pushCamera()
    this.options.onCameraChanged()
  }

  /** 按住的移动键集合变化时推进一帧。返回这一帧该不该继续。 */
  walk(held: ReadonlySet<string>, dt: number): void {
    this.settle()
    moveStep(this.camera, held, dt, this.walkSpeed())
    this.requestFrame(true)
  }

  /** 一次行走结束（所有键都松开了）：补一张全分辨率的，并把机位推给模型。 */
  walkEnded(): void {
    this.requestFrame()
    this.pushCamera()
  }

  /** 容器尺寸变了。用 `ResizeObserver` 喂进来。 */
  resize(width: number, height: number, pixelRatio: number): void {
    if (width < 1 || height < 1) return
    this.viewSize = { width, height }
    this.viewport.resize(width, height, pixelRatio)
    this.requestFrame()
  }

  // ── 画帧 ────────────────────────────────────────────────────────────────────

  /**
   * 拉一次几何（只在 revision 变化时）。
   *
   * 拖动本身**完全不走 IPC**——这是换成 WebGL 之后最直接的收益。
   */
  private async syncScene(): Promise<void> {
    const current = this.current
    if (current === undefined) return
    if (current.revision === this.sceneRevision) return
    if (this.software) {
      // 软件视口**不吃几何**——世界本来就在主进程手里。省掉一次几 MB 的传输
      // （顶点 + 索引 + 4 MB 图集），只把版本号记下来
      this.sceneRevision = current.revision
      this.viewport.setRevision(current.revision)
      return
    }
    const payload = await window.architect.scene()
    this.viewport.setRevision(payload.revision)
    this.viewport.setScene(payload)
    this.sceneRevision = payload.revision
  }

  /**
   * 把一帧排到下一个动画帧。
   *
   * `draft` 只对软件视口有意义（半分辨率 + 不画叠加层）。连着拖时必须**合并**：
   * pointermove 的频率远高于光栅化，不合并就会排出一长串过期请求，画面越拖越落后。
   * 所以草稿帧之后要补一张全分辨率的（`refineTimer`），否则滚轮缩放会停在糊的那一帧上。
   */
  requestFrame(draft = false): void {
    if (draft) this.frameDraft = true
    if (this.frameQueued) return
    this.frameQueued = true
    requestAnimationFrame(() => {
      this.frameQueued = false
      const isDraft = this.frameDraft
      this.frameDraft = false
      if (this.current === undefined) return
      // **空世界也要照画一遍。**
      //
      // 以前这里是 `if (blocks === 0) { 显示提示; return }`——于是画布上原封不动留着
      // **上一帧**的像素：把时间线拖回 rev 0，用户看到的是"旧建筑没清掉"和"空世界提示"
      // 叠在一起。清画布是渲染器自己的事（它按 clearColor 擦），不该指望提示条去盖。
      this.viewport.render(this.viewportCamera(), { draft: isDraft })
      if (isDraft) {
        if (this.refineTimer !== undefined) window.clearTimeout(this.refineTimer)
        this.refineTimer = window.setTimeout(() => {
          this.refineTimer = undefined
          this.requestFrame()
        }, 180)
      }
      this.options.onCameraChanged()
    })
  }

  /** 程序化刷新（换版本、打开工程…）：先同步几何再画一帧。 */
  async shoot(): Promise<void> {
    await this.syncScene()
    this.requestFrame()
  }

  resizeToCurrent(): { width: number; height: number } {
    return this.viewSize
  }

  /** 诊断探针（见 `SceneViewport.debugScene` 的注释）。 */
  debugScene(): { meshes: number; triangles: number } {
    return this.viewport.debugScene?.() ?? { meshes: 0, triangles: 0 }
  }

  /**
   * **主进程要一张给模型看的图**：用渲染进程里的 three.js 画，把 PNG 交回去。
   *
   * 这是"模型的眼睛"和"用户的眼睛"共用的那一条路（D-47 的两条路径在这里合流：
   * 交互与模型截图共用 three.js，CLI/CI 仍然用可复现的软件光栅器）。
   *
   * **版本必须对得上**。主进程给的 `revision` 是它算这张图时世界的版本，而渲染进程
   * 这边的场景可能还停在几步之前（状态事件还在队列里没处理）。所以对不上就重拉一次
   * 几何；重拉回来**仍然**对不上，说明世界在请求飞行途中又变了——这时宁可拒收
   * 让主进程退回软件光栅器，也**绝不能**把一张旧图当新图交出去：
   * 让模型拿着过期截图下结论是多轮视觉 agent 最隐蔽的 bug（plan §9.4）。
   *
   * 拒收时**带上原因**（不是一个裸 `null`）：主进程把它一路记进 `renderFallback`，
   * 界面上才能说清楚"为什么图忽然变糊了"——而这台机器有没有 WebGL，只有渲染进程知道。
   */
  async capture(request: CaptureShotRequest): Promise<CaptureAnswer> {
    // three.js 这条路只有纹理渲染，没有"平均色快路径"，所以纯色会话直接拒收
    if (!request.textured) return { error: 'This shot asks for the flat-colour path, which only the software rasterizer has' }
    // 软件视口给不出比主进程更好的东西——**主进程自己就是软件光栅器**。
    // 绕这一圈只会白花一次 IPC，所以直接拒收，让它自己画。
    if (this.viewport.capture === undefined) {
      return { error: 'This machine has no usable WebGL, so the main process rasterizes the capture' }
    }
    if (this.sceneRevision !== request.revision) {
      const payload: ScenePayload = await window.architect.scene()
      if (payload.revision !== request.revision) {
        return {
          error: `渲染进程的场景还停在 rev ${payload.revision}，而这一枪要 rev ${request.revision}`,
        }
      }
      this.viewport.setRevision(payload.revision)
      this.viewport.setScene(payload)
      this.sceneRevision = payload.revision
    }
    return {
      dataUrl: this.viewport.capture({
        camera: request.camera as CameraSpec,
        width: request.width,
        height: request.height,
        overlays: request.overlays as OverlayOptions,
      }),
    }
  }
}
