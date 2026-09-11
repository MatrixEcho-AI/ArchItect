import { initI18n, onLocaleChange, setLocale, t } from '@architect/i18n'
import {
  clampFreeElevation,
  DEFAULT_FOV,
  fitPerspective,
  orientationFromEye,
} from '@architect/render/browser'

import { cacheShare } from './format.js'
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
import type { FrameSink, SceneViewport, SoftwareFrame, ViewportCamera } from './viewport.js'
import type { MessageKey } from '@architect/i18n'
import type { CameraSpec, OverlayOptions } from '@architect/render/browser'

/**
 * 渲染进程：**一个哑视图**。
 *
 * 它不持有世界、不跑体素逻辑、不打包任何 workspace 包进浏览器——
 * 所有的渲染和编辑都在主进程完成，这里只要 PNG、文本和事件。
 * 代价是交互有 IPC 往返，但换来了极简的构建（不需要前端打包器）。
 *
 * 唯一的例外是 `@architect/i18n`：它没有 Node 依赖，被打进这份 bundle 里，
 * 这样文案切换是即时的，不需要为了翻一句话去往返一趟主进程。
 */

// ── 主进程传过来的数据类型（与 studio.ts / chat.ts 对齐） ──────────────────────

interface StudioState {
  projectPath?: string
  name: string
  minecraftVersion: string
  revision: number
  totalOps: number
  blocks: number
  bounds?: { min: [number, number, number]; max: [number, number, number] }
  volume: { min: [number, number, number]; max: [number, number, number] }
  paletteSize: number
  ops: Array<{ rev: number; tool: string; changed: number; ts: string; source: string }>
  histogram: Array<{ block: string; count: number; percent: number }>
  /** 一次性提示（崩溃恢复之类）。主进程读过就没了，所以界面要自己留住。 */
  notice?: string
  /**
   * 有一份崩溃前的草稿等着处理。**它不是提示，是一个待办**——
   * 主进程会把草稿一直留着，直到用户点了恢复或丢掉。
   */
  recovery?: { ops: number; basePath?: string; baseExists: boolean }
  /** 游标前面还有内容（可以撤销）。 */
  canUndo: boolean
  /** 游标后面还有内容（可以重做）。 */
  canRedo: boolean
  /** 游标停在最新版本之前 —— 此时**不能让模型改**（它的第一笔会截断后面的步骤）。 */
  behindTip: boolean
  /** 当前用的纹理来源（形状与状态里那个字段一一对应）。 */
  texture: { kind: string; detail: string; fellBackFrom?: string }
  /** 会话相机（`set_camera` 或机位面板设的）。界面只读显示，不自动改用户的视角。 */
  camera?: {
    azimuth?: number
    elevation?: number
    roll?: number
    scale?: number
    eye?: [number, number, number]
    lookAt?: [number, number, number]
  }
}

/** 一条编辑记录的细节（主进程按需给，不跟着每次状态推）。 */
interface OpDetailView {
  rev: number
  id: string
  tool: string
  args: unknown
  ts: string
  source: string
  actor: string
  result: { changed: number; overwrittenNonAir: number; clipped: number }
}

interface ChatMessageView {
  id: number
  role: 'user' | 'assistant' | 'tool'
  text: string
  toolName?: string
  toolOk?: boolean
  args?: string
  imageId?: string
  imageRevision?: number
  imageView?: string
  gate?: boolean
  /** 这一轮失败了（请求报错 / 空回复 / 撞上输出上限）。画红，别让用户以为是"没反应"。 */
  failed?: boolean
  /** 这一条正在流式生成：末尾画一个光标，字是**边收边画**的。 */
  streaming?: boolean
  /** 还在思考、正文没开始时，已经生成的思维链字符数（只给数字，不给内容）。 */
  thinking?: number
}

interface ChatView {
  running: boolean
  messages: ChatMessageView[]
  usage: { in: number; out: number; cachedIn: number; turns: number; toolCalls: number; screenshots: number }
  costUsd?: number
  stopReason?: string
  error?: string
  /** 被预算刹住的原因（如果有）。**不是故障**，界面要说清楚。 */
  budgetStop?: string
  ready: boolean
  blocking: string[]
}

interface ProviderView {
  id: string
  preset: string
  kind: string
  baseURL: string
  apiKeyRef: string
  model: string
  capabilities: {
    vision: boolean
    toolCalling: string
    promptCache: string
    imageTokenCost?: number
    contextWindow?: number
    source: string
    probedAt?: string
  }
  cost?: { inPerMTok: number; outPerMTok: number; cacheReadPerMTok?: number }
  hasKey: boolean
  envName?: string
}

interface SettingsView {
  activeId: string
  providers: ProviderView[]
  budget?: { maxUsd?: number; maxTokensOut?: number; maxTurns?: number }
  locale: 'zh-CN' | 'en-US'
  ui: { view?: string; requireVerification?: boolean }
  secrets: { location: string; encrypted: boolean }
  issues: Array<{ field: string; message: string }>
}

type ProbeStep =
  | { type: 'models'; count: number; models: string[] }
  | { type: 'model'; model: string; matched?: string; guessed?: boolean }
  | { type: 'text'; ok: boolean; tokensIn?: number; error?: string }
  | { type: 'tools'; mode: string }
  | { type: 'vision'; vision: boolean; imageTokenCost?: number; error?: string }
  | { type: 'capabilities'; capabilities: ProviderView['capabilities'] }
  | { type: 'error'; error: string }

interface DiscoveryResult {
  ok: boolean
  config: ProviderView
  models: string[]
  steps: ProbeStep[]
  error?: string
}

type StudioEvent =
  | { type: 'chat'; view: ChatView }
  | { type: 'settings'; view: SettingsView }
  | { type: 'state'; state: StudioState }

interface ArchitectBridge {
  state(): Promise<StudioState>
  measureText(): Promise<string>
  opDetail(rev: number): Promise<OpDetailView | undefined>
  newProject(): Promise<StudioState>
  open(): Promise<StudioState | undefined>
  save(path?: string): Promise<string | undefined>
  seek(revision: number): Promise<StudioState>
  seekLatest(): Promise<StudioState>
  /** 崩溃恢复：打开草稿的基准工程，把没保存的那几步接上去。 */
  applyRecovery(): Promise<StudioState>
  /** 崩溃恢复：明确丢掉那份草稿。 */
  discardRecovery(): Promise<StudioState>
  /** 撤销 / 重做：**游标前后移动**，不是打反向补丁（plan §6）。 */
  undo(): Promise<StudioState>
  redo(): Promise<StudioState>
  shoot(request: { view: string; width: number; height: number; highlightLast?: boolean }): Promise<{
    png: Uint8Array
    view: string
    revision: number
  }>
  /** three.js 视口的几何与图集（网格按 revision 缓存，图集只发一次）。 */
  scene(): Promise<{
    revision: number
    positions: Float32Array
    normals: Float32Array
    colors: Float32Array
    uvs: Float32Array
    indices: Uint32Array
    atlas: { size: number; data: Uint8Array }
    bounds?: { min: [number, number, number]; max: [number, number, number] }
    volume: { min: [number, number, number]; max: [number, number, number] }
  }>
  /** 预设机位的角度（唯一真相在主进程的 `VIEW_PRESETS`）。 */
  viewPresets(): Promise<Record<string, { azimuth: number; elevation: number }>>
  /**
   * 机位面板 → 会话相机。传 `null` 复原。
   *
   * 写的是 `set_camera` 工具用的那个字段，所以打开「模型用这个机位」之后，
   * 用户看到的就是模型接下来看到的（人机共用机位）。
   */
  setCamera(
    camera: {
      azimuth?: number
      elevation?: number
      roll?: number
      scale?: number
      eye?: [number, number, number]
      lookAt?: [number, number, number]
    } | null,
  ): Promise<StudioState>
  slice(request: { axis: 'x' | 'y' | 'z'; index: number }): Promise<string>
  /** 屏幕像素 → 世界里的那一格（`null` = 点到天空）。 */
  pick(request: {
    azimuth: number
    elevation: number
    roll?: number
    scale?: number
    target?: [number, number, number]
    /** 透视（第一人称）：射线从相机位置出发。不给就是正交射线。 */
    perspective?: { eye: [number, number, number]; fov: number }
    width: number
    height: number
    x: number
    y: number
  }): Promise<{
    block: [number, number, number]
    place: [number, number, number]
    normal: [number, number, number]
    blockId: string
    placeInVolume: boolean
  } | null>
  /** 人改一格。和模型改的走同一条日志、同一套重放。 */
  edit(request: { pos: [number, number, number]; block?: string; mode: 'place' | 'break' }): Promise<StudioState>
  /** 调色板搜索。 */
  blocks(query: string): Promise<string[]>
  /** 没有 WebGL 时用它要帧（软件视口）。有 WebGL 时一次都不会调。 */
  viewport(request: {
    azimuth: number
    elevation: number
    roll?: number
    scale?: number
    target?: [number, number, number]
    /** 透视（第一人称）：相机站在 `eye`。不给就是正交等轴测。 */
    perspective?: { eye: [number, number, number]; fov: number }
    width: number
    height: number
    draft?: boolean
  }): Promise<{
    pixels: Uint8Array
    width: number
    height: number
    revision: number
    ms: number
  }>
  demo(): Promise<StudioState>
  exportModel(format: string, suggestedName?: string): Promise<{ paths: string[]; summary: string } | undefined>
  importModel(): Promise<
    | {
        state: StudioState
        summary: string
        unknown: Array<{ name: string; count: number; suggestions: string[] }>
        renamed: Array<{ from: string; to: string; count: number }>
        skipped: number
      }
    | undefined
  >

  settings(): Promise<SettingsView>
  saveProvider(config: unknown, apiKeyPlain?: string): Promise<SettingsView>
  removeProvider(id: string): Promise<SettingsView>
  addProvider(preset: string): Promise<SettingsView>
  setActive(id: string): Promise<SettingsView>
  setBudget(budget: unknown): Promise<SettingsView>
  setLocale(locale: string): Promise<SettingsView>
  setUi(patch: unknown): Promise<SettingsView>
  testConnection(input: unknown): Promise<DiscoveryResult>

  chat(): Promise<ChatView>
  send(text: string): Promise<ChatView>
  stop(): Promise<ChatView>
  clearChat(): Promise<ChatView>
  chatImage(id: string): Promise<Uint8Array | undefined>

  subscribe(listener: (event: StudioEvent) => void): () => void
  ready(report: { ok: boolean; detail: string }): Promise<void>
}

declare global {
  interface Window {
    architect: ArchitectBridge
    /**
     * **主进程用来要一张给模型看的图**（`webContents.executeJavaScript` 调它）。
     *
     * 之所以挂在 window 上而不是走 IPC 通道：方向是主 → 渲染，而 `ipcRenderer.invoke`
     * 只能渲染 → 主。`executeJavaScript` 会 await 这个函数返回的 Promise 并把结果
     * （PNG 的 data URL）带回主进程，一行就够，不需要自己造一套请求/应答 id 表。
     *
     * 画不了时返回**带原因的 `{ error }`**，主进程会记进 `renderFallback` 再退回
     * 软件光栅器——"这台机器有没有 WebGL"只有渲染进程知道。
     */
    __architectCaptureShot?: (request: CaptureShotRequest) => Promise<CaptureAnswer>
  }
}

/**
 * 离屏截图的结果：要么是一张 PNG 的 data URL，要么是**画不了的原因**。
 *
 * 带原因而不是裸 `null`：主进程要拿它解释"图为什么忽然变糊了"。
 */
type CaptureAnswer = { dataUrl: string } | { error: string }

/** 主进程发来的离屏截图请求。字段与 `@architect/agent` 的 `ShotInput` 对齐。 */
interface CaptureShotRequest {
  camera: CameraSpec
  view: string
  revision: number
  width: number
  height: number
  overlays: OverlayOptions
  /** three.js 这条路只有纹理渲染，所以 `false` 时直接拒收。 */
  textured: boolean
}


const el = <T extends HTMLElement>(id: string): T => {
  const found = document.getElementById(id)
  if (found === null) throw new Error(`缺少元素 #${id}`)
  return found as T
}

const canvas = el<HTMLCanvasElement>('canvas')
const overlayCanvas = el<HTMLCanvasElement>('overlay')
const statusEl = el('status')
const empty = el('empty')
const scrub = el<HTMLInputElement>('scrub')
const revLabel = el('rev-label')
const viewSelect = el<HTMLSelectElement>('view')
const camMode = el<HTMLSelectElement>('cam-mode')
const camAngle = el('cam-angle')
const camEye = el('cam-eye')
const camAz = el<HTMLInputElement>('cam-az')
const camElev = el<HTMLInputElement>('cam-el')
const camRoll = el<HTMLInputElement>('cam-roll')
const camFov = el<HTMLInputElement>('cam-scale')
const camEyeFields = [el<HTMLInputElement>('cam-ex'), el<HTMLInputElement>('cam-ey'), el<HTMLInputElement>('cam-ez')]
const camLookFields = [el<HTMLInputElement>('cam-lx'), el<HTMLInputElement>('cam-ly'), el<HTMLInputElement>('cam-lz')]
const camShare = el<HTMLInputElement>('cam-share')
const editModeInput = el<HTMLInputElement>('edit-mode')
const blockSearch = el<HTMLInputElement>('block-search')
const paletteMatches = el<HTMLUListElement>('palette-matches')
const paletteUsed = el<HTMLUListElement>('palette-used')
const paletteCurrent = el('palette-current')
const messagesEl = el<HTMLOListElement>('messages')
const blockingEl = el('blocking')
const noticeEl = el('notice')
const chatInput = el<HTMLTextAreaElement>('chat-input')
const sendButton = el<HTMLButtonElement>('btn-send')
const stopButton = el<HTMLButtonElement>('btn-stop')
const usageEl = el('chat-usage')
const costEl = el('cost')
const settingsDialog = el<HTMLDialogElement>('settings-dialog')

let current: StudioState | undefined
let chat: ChatView | undefined
let settings: SettingsView | undefined
let view = 'iso_ne'
/** 截图 blob 缓存：同一张图不重复走 IPC，也不重复建 objectURL。 */
const imageUrls = new Map<string, string>()
/** 正在设置里编辑的 provider（可能与当前生效的那个不同）。 */
let editing: ProviderView | undefined

// ── i18n ──────────────────────────────────────────────────────────────────────

/** 把 `data-i18n` / `data-i18n-placeholder` 的静态文案刷一遍。 */
function applyStaticText(): void {
  for (const node of document.querySelectorAll<HTMLElement>('[data-i18n]')) {
    const key = node.dataset['i18n']
    if (key !== undefined) node.textContent = t(key as MessageKey)
  }
  for (const node of document.querySelectorAll<HTMLElement>('[data-i18n-placeholder]')) {
    const key = node.dataset['i18nPlaceholder']
    if (key !== undefined) node.setAttribute('placeholder', t(key as MessageKey))
  }
  for (const node of document.querySelectorAll<HTMLElement>('[data-i18n-title]')) {
    const key = node.dataset['i18nTitle']
    if (key !== undefined) node.setAttribute('title', t(key as MessageKey))
  }
}

const presetLabel = (preset: string): string => t(`settings.presets.${preset}` as MessageKey)

// ── 状态与错误 ────────────────────────────────────────────────────────────────

/**
 * 一行状态文字。
 *
 * ⚠️ **状态行按要求从界面上隐藏了**（`#status` 带 `hidden`，见 index.html），所以现在
 * 这些字**看不见**——包括「本轮结束（reason）」和各种机位提示。
 * 「思考中…」**不再靠这里**：它现在是对话列表里的一条（主进程在 `turn` 事件上落一条
 * 流式占位，见 `ChatController.openStream`），逐字输出也长在那一条上。
 * 真正的失败反馈同样不靠它：失败的回合会在对话里落一条红色消息（见 `renderChat`/`ChatController.fail`），
 * 那条**仍然可见**。要恢复状态行：去掉 index.html 上的那个 `hidden`。
 */
function setStatus(text: string): void {
  statusEl.textContent = text
}

async function guard<T>(label: string, fn: () => Promise<T>): Promise<T | undefined> {
  try {
    setStatus(t('app.busy', { label }))
    const result = await fn()
    setStatus(t('app.ready'))
    return result
  } catch (error) {
    setStatus(t('app.failed', { label, message: error instanceof Error ? error.message : String(error) }))
    return undefined
  }
}

// ── 视口：three.js（WebGL），拿不到 WebGL 就退回软件光栅器 ─────────────────────
//
// 方块默认在渲染进程用 WebGL 画（MSAA 抗锯齿、mipmap、60 fps），标尺/坐标轴/文字由
// `viewport.ts` 里那层 2D 画布负责。世界与几何仍然来自主进程——渲染进程不跑
// 体素逻辑，只收一份「带 UV 的三角形 + 图集」（见 `StudioService.scene()`）。
//
// 早先是"每帧走一趟 IPC 拿回 RGBA"，那样既没有抗锯齿、拖动时还得降分辨率。
// 换成 GPU 之后不再需要在画质与帧率之间二选一。
//
// **但没有 WebGL 的机器上必须还能用**（虚拟机、远程桌面、驱动被禁）：
// `new THREE.WebGLRenderer()` 会直接抛，而这一抛会连同对话面板一起带走，
// 用户连"描述需求"都做不到。所以拿不到 WebGL 时换成软件视口——慢、糊、
// 拖动降分辨率，但能干活，而且**模型截图那条路本来就还是软件光栅器**。

/**
 * 这台机器有没有可用的 WebGL。
 *
 * 用一个**一次性的探针画布**，不碰真正的视口画布：three 的构造函数会独占
 * `#canvas`，拿它试错的话失败之后就再也拿不到干净的上下文了。
 */
function webglAvailable(): boolean {
  try {
    const probe = document.createElement('canvas')
    return probe.getContext('webgl2') !== null || probe.getContext('webgl') !== null
  } catch {
    return false
  }
}

/**
 * 把软件帧贴到**叠加层**画布上。
 *
 * 为什么是叠加层而不是 `#canvas`：后者是 WebGL 画布，没有 WebGL 时它连 2D 上下文
 * 都拿不到。叠加层本来就是 2D 的、尺寸完全一样、还在最上面，所以软件模式下由它整帧顶替。
 *
 * **画布的像素尺寸由这里定**（`resize`），不是由帧大小定：草稿帧是降过分辨率的，
 * 让它去改画布尺寸会让"拖动中"和"松手后"两块缓冲来回换，画面会跳。
 * 帧比画布小时用 `drawImage` 放大回去，而且**关掉插值**——像素画放大本来就该是硬边。
 */
class CanvasFrameSink implements FrameSink {
  private readonly scratch = document.createElement('canvas')
  private width = 1
  private height = 1

  resize(width: number, height: number): void {
    this.width = Math.max(1, Math.floor(width))
    this.height = Math.max(1, Math.floor(height))
    if (overlayCanvas.width !== this.width || overlayCanvas.height !== this.height) {
      overlayCanvas.width = this.width
      overlayCanvas.height = this.height
    }
  }

  blit(frame: SoftwareFrame): void {
    const target = overlayCanvas.getContext('2d')
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

/** 当前视口是不是软件实现（状态栏要说实话，模型截图那条路也跟着它走）。 */
let softwareViewport = false

/** 视口的 CSS 尺寸。透视取景（相机该站在哪儿）要按它算。 */
let viewSize = { width: 1, height: 1 }

let viewport: SceneViewport | undefined
/**
 * 交互相机：**第一人称透视相机**（位置 + 朝向 + 视场角，见 `freecamera.ts`）。
 *
 * `eye` 为空 = 还没落地（刚打开、选了预设机位）：由自动取景决定站在哪儿，
 * 第一次转头 / 按 WASD 时才定下来。
 *
 * **这是"用户在看的那个机位"**，和主进程会话里的相机（`set_camera` / 机位面板写的那份）
 * 是两个东西：拖动只改这一份，只有勾了「模型用这个机位」才会推过去。
 * 分开是有意的——用户随手转两下不该悄悄改掉模型下一张截图的机位。
 */
const camera: FreeCamera = createFreeCamera({ azimuth: 45, elevation: 35, fov: DEFAULT_FOV })
/** 机位面板有没有把机位同步给模型（会话相机）。 */
let camShared = false
/** 推机位给主进程的节流句柄：拖动时每个 pointermove 都推一次会白写几百次 IPC。 */
let camPushTimer: number | undefined
/** 相机换过工程没有：换了就回到"框住内容"的默认取景（见 `renderPanel`）。 */
let cameraProjectKey: string | undefined

/** 预设机位的角度由主进程给（`VIEW_PRESETS` 是唯一真相）。 */
const presetAngles = new Map<string, { azimuth: number; elevation: number }>()
/** 当前场景对应的 revision，用来判断要不要重新拉几何。 */
let sceneRevision = -1
/** 画一帧的节流：pointermove 的频率远高于屏幕刷新。 */
let frameQueued = false

async function loadPresets(): Promise<void> {
  try {
    for (const [key, value] of Object.entries(await window.architect.viewPresets())) {
      presetAngles.set(key, value)
    }
    applyPreset(view)
  } catch {
    // 拿不到预设角度不影响拖动，只是下拉框不改变视角
  }
}

function applyPreset(name: string): void {
  const angles = presetAngles.get(name)
  if (angles === undefined) return
  camera.azimuth = angles.azimuth
  camera.elevation = clampFreeElevation(angles.elevation)
  camera.roll = 0
  // 预设机位一律回到**"框住内容"**：位置丢掉，交给自动取景重新算站在哪儿
  delete camera.eye
  // 换机位就丢掉"用户手填的 eye"——方向变了，那三个数不再代表当前朝向
  camTypedEye = undefined
}

// ── 机位面板 ──────────────────────────────────────────────────────────────────
//
// 拖动已经能转角度，这里补的是**精确输入**与**自定义注视点**。三件事值得写清楚：
//
// 1. 字段是**单向镜**：相机变了就刷新字段（拖动时也跟着变），但用户正在这个面板里
//    打字时不刷新——否则每敲一个字符都被改写回去。
// 2. `eye` 是**真的相机位置**（透视投影下它决定成像，不像正交那样只是个方向）。
//    "按坐标"模式给的就是"站在 eye、看向 lookAt"；"按角度"模式则回到自动取景。
// 3. 勾了「模型用这个机位」才推给主进程：推 `eye` + `lookAt`（会话相机支持这两个字段），
//    于是模型看的是**同一个方向**。模型自己的截图仍是正交等轴测（见 D-76）。

/** 内容中心。和 `fitCamera` 用的是同一个式子（+1 是"方块占一格"的补偿）。 */
function contentCenter(): [number, number, number] {
  const bounds = current?.bounds
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
function fittedEye(): [number, number, number] {
  const bounds = current?.bounds ?? current?.volume
  const angles = { azimuth: camera.azimuth, elevation: clampFreeElevation(camera.elevation) }
  if (bounds === undefined) {
    const forward = forwardOf(camera)
    return [forward[0] * -32, forward[1] * -32, forward[2] * -32]
  }
  const box = {
    min: { x: bounds.min[0], y: bounds.min[1], z: bounds.min[2] },
    max: { x: bounds.max[0], y: bounds.max[1], z: bounds.max[2] },
  }
  const spec = fitPerspective(box, angles, {
    fov: camera.fov,
    width: viewSize.width,
    height: viewSize.height,
    roll: camera.roll,
  })
  const eye = spec.perspective!.eye
  return [eye.x, eye.y, eye.z]
}

/** 相机位置（落地了就是它自己，没落地就是自动取景算出来的那个点）。 */
const cameraEye = (): [number, number, number] => camera.eye ?? fittedEye()

/**
 * 相机看向的那个点（距离取"到内容中心那么远"）。
 *
 * 它只有一个用途：**推给模型当 `lookAt`**，以及机位面板里显示/编辑"注视点"。
 * 成像不看它——透视投影只认位置与朝向。
 */
function cameraLookAt(): [number, number, number] {
  const eye = cameraEye()
  const center = contentCenter()
  const distance = Math.max(
    1,
    Math.hypot(center[0] - eye[0], center[1] - eye[1], center[2] - eye[2]),
  )
  return lookAtFrom({ ...camera, eye }, distance)
}

/** 交给渲染层 / 拾取的那一份相机（透视：位置 + 朝向 + 视场角）。 */
function viewportCamera(): ViewportCamera {
  const eye = cameraEye()
  return {
    azimuth: camera.azimuth,
    elevation: clampFreeElevation(camera.elevation),
    roll: camera.roll,
    scale: 0,
    perspective: { eye, fov: camera.fov },
  }
}

/**
 * 把相机**落到一个具体位置上**（第一次转头 / 按 WASD 时）。
 *
 * 落点用的是自动取景算出来的站法：站在那个点上，内容刚好框进画面。落点之后
 * 相机就归用户了——转头只改朝向、WASD 只改位置，自动取景不再插手中途。
 * （换预设、双击、"按角度"应用都会把位置丢掉，重新自动取景。）
 */
function settleCamera(): void {
  if (camera.eye !== undefined) return
  place(camera, fittedEye())
}

const round1 = (value: number): string => String(Math.round(value * 10) / 10)
const readNum = (input: HTMLInputElement, fallback: number): number => {
  const value = Number(input.value)
  return input.value.trim().length > 0 && Number.isFinite(value) ? value : fallback
}

/**
 * 用户手填过、且**方向没变**的那组 eye/lookAt。
 *
 * 为什么需要它：正交投影下距离不影响成像，所以用户填的 `eye` 反解成角度之后，
 * 再按 64 格探针距离正解回来**不会是原来那三个数**。用户会看到自己输的
 * (40,30,40) 一按应用就变成 (45.3,35.3,48.8)——数学上等价，观感上像被改错了。
 * 所以只要方向和注视点还是他填的那一组，就把他的数字原样留在框里；
 * 一旦视角从别处变了（拖动、预设、复位），就丢掉它、按角度重算。
 */
let camTypedEye: {
  eye: [number, number, number]
  lookAt: [number, number, number]
  azimuth: number
  elevation: number
} | undefined

/** 用户正在机位面板里打字时，不要用相机状态去覆盖他。 */
function cameraPanelBusy(): boolean {
  const active = document.activeElement
  return active instanceof HTMLElement && active.closest('.camera') !== null
}

/** 相机 → 字段。 */
function syncCameraFields(): void {
  if (cameraPanelBusy()) return
  // 位置是真的：落了地就是相机当前位置（WASD 走到哪儿就是哪儿），没落地就是自动取景算出来的站法
  const eye = cameraEye()
  const target = cameraLookAt()
  camAz.value = round1(camera.azimuth)
  camElev.value = round1(camera.elevation)
  camRoll.value = round1(camera.roll)
  camFov.value = round1(camera.fov)

  // 方向和注视点都还是用户填的那一组时，保留他填的数字（见 `camTypedEye`）
  const typed = camTypedEye
  const keepTyped =
    typed !== undefined &&
    Math.abs(typed.azimuth - camera.azimuth) < 1e-6 &&
    Math.abs(typed.elevation - camera.elevation) < 1e-6 &&
    typed.lookAt.every((value, index) => Math.abs(value - target[index]!) < 1e-6)
  if (!keepTyped) camTypedEye = undefined
  const eyeValues: [number, number, number] = keepTyped ? typed.eye : eye
  const lookValues: [number, number, number] = keepTyped ? typed.lookAt : target
  camEyeFields.forEach((input, index) => {
    input.value = round1(eyeValues[index]!)
  })
  camLookFields.forEach((input, index) => {
    input.value = round1(lookValues[index]!)
  })
}

/** 字段 → 相机。返回是否成功（坐标不完整时不改相机）。 */
function applyCameraFields(): boolean {
  const roll = readNum(camRoll, camera.roll)
  camera.fov = Math.min(FOV_RANGE.max, Math.max(FOV_RANGE.min, readNum(camFov, camera.fov)))

  if (camMode.value === 'eye') {
    const eye = camEyeFields.map((input) => Number(input.value))
    const look = camLookFields.map((input) => Number(input.value))
    if ([...eye, ...look].some((value) => !Number.isFinite(value))) {
      setStatus(t('viewport.cam.invalid'))
      return false
    }
    try {
      const oriented = orientationFromEye(
        { x: eye[0]!, y: eye[1]!, z: eye[2]! },
        { x: look[0]!, y: look[1]!, z: look[2]! },
      )
      camera.azimuth = oriented.azimuth
      camera.elevation = clampFreeElevation(oriented.elevation)
    } catch {
      // 两点重合，朝向无法确定
      setStatus(t('viewport.cam.invalid'))
      return false
    }
    // "相机放这儿、盯着那儿看"：位置就是用户填的那个点（透视投影下它是真的位置）
    place(camera, [eye[0]!, eye[1]!, eye[2]!])
    camTypedEye = {
      eye: [eye[0]!, eye[1]!, eye[2]!],
      lookAt: [look[0]!, look[1]!, look[2]!],
      azimuth: camera.azimuth,
      elevation: camera.elevation,
    }
  } else {
    camera.azimuth = readNum(camAz, camera.azimuth)
    camera.elevation = clampFreeElevation(readNum(camElev, camera.elevation))
    // "按角度" = 从这些角度**框住内容**：位置丢掉，交给自动取景（和预设机位同一个语义）
    delete camera.eye
    camTypedEye = undefined
  }

  camera.roll = roll
  viewSelect.value = 'free'
  return true
}

/**
 * 把当前机位推给主进程的会话——**模型接下来的截图就从这里看**。
 *
 * 只在勾了「模型用这个机位」时推，并且节流。推的是**位置 + 注视点**——会话相机支持
 * 这两个字段（`SessionCamera.eye/lookAt`），而且它们正是"我站在这里、看那边"的完整描述。
 * 模型自己的截图仍是正交等轴测（D-76），所以它看到的是**同一个方向**上的另一种画法。
 */
function pushCamera(): void {
  if (!camShared) return
  if (camPushTimer !== undefined) window.clearTimeout(camPushTimer)
  camPushTimer = window.setTimeout(() => {
    camPushTimer = undefined
    void window.architect
      .setCamera({
        azimuth: camera.azimuth,
        elevation: camera.elevation,
        roll: camera.roll,
        eye: cameraEye(),
        lookAt: cameraLookAt(),
      })
      // 把主进程回来的状态画出来，「模型机位」那一行才会立刻变——
      // 否则用户勾了共享却看不到任何确认
      .then((state) => renderPanel(state))
  }, 120)
}

function wireCamera(): void {
  camMode.addEventListener('change', () => {
    const byEye = camMode.value === 'eye'
    camAngle.classList.toggle('hidden', byEye)
    camEye.classList.toggle('hidden', !byEye)
    // 换模式时字段是同一台相机，所以"应用"是个空操作——不会跳视角
    if (applyCameraFields()) {
      requestFrame()
      pushCamera()
    }
  })

  for (const input of [camAz, camElev, camRoll, camFov, ...camEyeFields, ...camLookFields]) {
    input.addEventListener('change', () => {
      if (!applyCameraFields()) return
      syncCameraFields()
      requestFrame()
      pushCamera()
    })
  }

  el('cam-apply').addEventListener('click', () => {
    if (!applyCameraFields()) return
    syncCameraFields()
    requestFrame()
    pushCamera()
    setStatus(t('viewport.cam.applied'))
  })

  el('cam-reset').addEventListener('click', () => {
    applyPreset(view === 'free' ? 'iso_ne' : view)
    if (view === 'free') viewSelect.value = 'iso_ne'
    camTypedEye = undefined
    syncCameraFields()
    requestFrame()
    camShare.checked = false
    camShared = false
    void window.architect.setCamera(null).then((state) => renderPanel(state))
    setStatus(t('viewport.cam.unshared'))
  })

  camShare.addEventListener('change', () => {
    camShared = camShare.checked
    if (camShared) {
      pushCamera()
      setStatus(t('viewport.cam.shared'))
    } else {
      void window.architect.setCamera(null).then((state) => renderPanel(state))
      setStatus(t('viewport.cam.unshared'))
    }
    requestFrame()
  })

  syncCameraFields()
}

// ── 调色板与"人手接管" ────────────────────────────────────────────────────────
//
// 这一块让**人**也能改世界：选一个方块，在视口里点一下放上去。
// 关键在于它和模型改的**完全同权**——都走 `editBlock` → `session.applyEdit` →
// 同一条 op 日志，所以撤销、时间线、导出、`.mcai` 保存全都是现成的，不用另做一遍。
//
// 拾取放在**主进程**：那里才有世界与网格，而且没有 WebGL 的兜底视口里根本没有
// three 场景可以 raycast。代价是每点一次走一趟 IPC——点一次的量级，不是每帧。

/** 编辑模式开关。关着的时候视口就是个纯视图（避免误点改掉东西）。 */
let editMode = false
/** 当前要放置的方块。空串表示还没选。 */
let currentBlock = ''

/** 把方块名显示得短一点：`minecraft:` 前缀和状态属性在人眼里是噪音。 */
const shortBlock = (name: string): string => name.replace(/^minecraft:/, '').replace(/\[.*\]$/, '')

function renderPaletteSelection(): void {
  paletteCurrent.textContent = currentBlock.length > 0 ? shortBlock(currentBlock) : '—'
  for (const item of paletteMatches.querySelectorAll('li')) {
    item.classList.toggle('active', item.dataset['block'] === currentBlock)
  }
  for (const item of paletteUsed.querySelectorAll('li')) {
    item.classList.toggle('active', item.dataset['block'] === currentBlock)
  }
}

/** "用过的"来自状态里的直方图（主进程已经算好了，不必再问一次）。 */
function renderPaletteUsed(): void {
  const entries = current?.histogram ?? []
  paletteUsed.replaceChildren(
    ...entries.map((entry) => {
      const item = document.createElement('li')
      item.textContent = `${shortBlock(entry.block)} ·${entry.count}`
      item.dataset['block'] = entry.block
      item.title = entry.block
      item.addEventListener('click', () => selectBlock(entry.block))
      return item
    }),
  )
  // 第一次拿到世界时给个默认值：用最多的那个方块，省掉"还得先选一个"这一步
  if (currentBlock.length === 0 && entries.length > 0) currentBlock = entries[0]!.block
  renderPaletteSelection()
}

function selectBlock(name: string): void {
  currentBlock = name
  renderPaletteSelection()
}

function renderPaletteMatches(matches: string[]): void {
  paletteMatches.replaceChildren(
    ...matches.map((name) => {
      const item = document.createElement('li')
      item.textContent = shortBlock(name)
      item.title = name
      item.dataset['block'] = name
      item.addEventListener('click', () => selectBlock(name))
      return item
    }),
  )
  renderPaletteSelection()
}

function wirePalette(): void {
  editModeInput.addEventListener('change', () => {
    editMode = editModeInput.checked
    document.body.classList.toggle('editing', editMode)
    setStatus(editMode ? t('palette.editMode') : t('app.ready'))
  })

  // 搜索节流：`studio:blocks` 要遍历 1095 个方块名，不值得每敲一个键问一次
  let timer: number | undefined
  blockSearch.addEventListener('input', () => {
    if (timer !== undefined) window.clearTimeout(timer)
    timer = window.setTimeout(() => {
      timer = undefined
      const query = blockSearch.value
      void window.architect.blocks(query).then(renderPaletteMatches)
    }, 160)
  })

  renderPaletteUsed()
}

/**
 * 视口里点了一下 → 选格 → 改世界。
 *
 * 三种手势，和体素编辑器里的惯例一致：
 * - 点一下 = 放置当前方块（放在**命中面的外侧**那一格）
 * - ⌥/Alt + 点 = 挖掉命中的那一格
 * - ⌘/Ctrl + 点 = 吸取命中那一格的方块，不改变世界
 *
 * 拖动过（超过几个像素）就不算点击——否则每次转视角都会顺手改掉一格。
 */
async function editAt(event: PointerEvent): Promise<void> {
  const rect = overlayCanvas.getBoundingClientRect()
  if (rect.width < 1 || rect.height < 1) return
  // 相机参数与画面用的是同一套口径：CSS 像素尺寸 + 渲染进程里的相机状态
  const hit = await window.architect.pick({
    ...viewportCamera(),
    width: Math.floor(rect.width),
    height: Math.floor(rect.height),
    x: event.clientX - rect.left,
    y: event.clientY - rect.top,
  })
  if (hit === null) {
    setStatus(t('palette.miss'))
    return
  }

  if (event.metaKey || event.ctrlKey) {
    selectBlock(hit.blockId)
    setStatus(t('palette.picked', { block: shortBlock(hit.blockId) }))
    return
  }

  const breaking = event.altKey || event.button === 2
  if (!breaking && !hit.placeInVolume) {
    setStatus(t('palette.outside'))
    return
  }
  const target = breaking ? hit.block : hit.place
  const state = await window.architect.edit({
    pos: target,
    ...(breaking ? {} : { block: currentBlock }),
    mode: breaking ? 'break' : 'place',
  })
  renderPanel(state)
  await shoot()
  setStatus(
    breaking
      ? t('palette.broke', { block: shortBlock(hit.blockId), pos: hit.block.join(',') })
      : t('palette.placed', { block: shortBlock(currentBlock), pos: target.join(',') }),
  )
}

/**
 * 拉一次几何（只在 revision 变化时）。
 *
 * 拖动本身**完全不走 IPC**——这是换成 WebGL 之后最直接的收益。
 */
async function syncScene(): Promise<void> {
  if (current === undefined || viewport === undefined) return
  if (current.revision === sceneRevision) return
  if (softwareViewport) {
    // 软件视口**不吃几何**——世界本来就在主进程手里。省掉一次几 MB 的传输
    // （顶点 + 索引 + 4 MB 图集），只把版本号记下来
    sceneRevision = current.revision
    viewport.setRevision(current.revision)
    return
  }
  const payload = await window.architect.scene()
  viewport.setRevision(payload.revision)
  viewport.setScene(payload)
  sceneRevision = payload.revision
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
async function captureShot(request: CaptureShotRequest): Promise<CaptureAnswer> {
  if (viewport === undefined) return { error: '视口还没建好，这一枪由软件光栅器画' }
  // three.js 这条路只有纹理渲染，没有"平均色快路径"，所以纯色会话直接拒收
  if (!request.textured) return { error: '这一枪要的是纯色路径，只有软件光栅器有' }
  // 软件视口给不出比主进程更好的东西——**主进程自己就是软件光栅器**。
  // 绕这一圈只会白花一次 IPC，所以直接拒收，让它自己画。
  if (viewport.capture === undefined) {
    return { error: '这台机器上没有可用的 WebGL，截图由主进程的软件光栅器完成' }
  }
  if (sceneRevision !== request.revision) {
    const payload = await window.architect.scene()
    if (payload.revision !== request.revision) {
      return { error: `渲染进程的场景还停在 rev ${payload.revision}，而这一枪要 rev ${request.revision}` }
    }
    viewport.setRevision(payload.revision)
    viewport.setScene(payload)
    sceneRevision = payload.revision
  }
  return {
    dataUrl: viewport.capture({
      camera: request.camera,
      width: request.width,
      height: request.height,
      overlays: request.overlays,
    }),
  }
}

/** 本次排队的是不是"草稿帧"（拖动中）。GPU 那条路忽略它。 */
let frameDraft = false
/** 草稿帧之后补一张全分辨率的那一枪。 */
let refineTimer: number | undefined

/**
 * 把一帧排到下一个动画帧。
 *
 * `draft` 只对软件视口有意义（半分辨率 + 不画叠加层）。连着拖时必须**合并**：
 * pointermove 的频率远高于光栅化，不合并就会排出一长串过期请求，画面越拖越落后。
 * 所以草稿帧之后要补一张全分辨率的（`refineTimer`），否则滚轮缩放会停在糊的那一帧上。
 */
function requestFrame(draft = false): void {
  if (draft) frameDraft = true
  if (frameQueued) return
  frameQueued = true
  requestAnimationFrame(() => {
    frameQueued = false
    const isDraft = frameDraft
    frameDraft = false
    if (viewport === undefined || current === undefined) return
    // **空世界也要照画一遍。**
    //
    // 以前这里是 `if (blocks === 0) { 显示提示; return }`——于是画布上原封不动留着
    // **上一帧**的像素：把时间线拖回 rev 0，用户看到的是"旧建筑没清掉"和"空世界提示"
    // 叠在一起。清画布是渲染器自己的事（它按 clearColor 擦），不该指望提示条去盖
    // （`.empty` 就是 positioned 的一行字，没有背景）。
    empty.classList.toggle('show', current.blocks === 0)
    viewport.render(viewportCamera(), { draft: isDraft })
    if (isDraft) {
      if (refineTimer !== undefined) window.clearTimeout(refineTimer)
      refineTimer = window.setTimeout(() => {
        refineTimer = undefined
        requestFrame()
      }, 180)
    }
    // 机位面板是相机的**单向镜**：拖动时数字跟着变，但用户正在面板里打字时不覆盖
    syncCameraFields()
    // 状态行是隐藏的（见 index.html），但它同时是**渲染进程里唯一能读到的相机快照**：
    // 相机落了地就把位置一起写进去（自动化的"WASD 真的移动了相机"就断言这一行）
    setStatus(
      (camera.eye !== undefined
        ? t('viewport.statusAt', {
            az: camera.azimuth.toFixed(0),
            el: camera.elevation.toFixed(0),
            pos: camera.eye.map((value) => Math.round(value)).join(','),
            ms: softwareViewport ? 'CPU' : 'GPU',
          })
        : t('viewport.status', {
            az: camera.azimuth.toFixed(0),
            el: camera.elevation.toFixed(0),
            ms: softwareViewport ? 'CPU' : 'GPU',
          })) + (camShared ? ` · ${t('viewport.cam.sharedShort')}` : ''),
    )
  })
}

/** 与旧路径同名：程序化刷新（换版本、打开工程…）都走它。 */
async function shoot(): Promise<void> {
  await syncScene()
  requestFrame()
}


function wireViewport(): void {
  if (viewport === undefined) return
  const surface = overlayCanvas
  let dragging = false
  let dragAt = { x: 0, y: 0 }
  /** 累计拖动距离。**用它区分"点击"和"转视角"**：手一抖就改掉一格是最烦人的事。 */
  let moved = 0
  /** 这次按下的是哪个键——松手时要按同一个键决定是放置还是挖掉。 */
  let button = 0

  surface.addEventListener('pointerdown', (event) => {
    // 右键也接：体素编辑器的惯例是右键挖掉。下面的 contextmenu 要一起挡掉
    if (event.button !== 0 && event.button !== 2) return
    dragging = true
    button = event.button
    moved = 0
    dragAt = { x: event.clientX, y: event.clientY }
    surface.setPointerCapture(event.pointerId)
    document.body.classList.add('dragging')
    // 拖过就说明用户要的是自由视角，下拉框不该再说"等轴测 东北"
    viewSelect.value = 'free'
  })

  surface.addEventListener('contextmenu', (event) => event.preventDefault())

  surface.addEventListener('pointermove', (event) => {
    if (!dragging) return
    const dx = event.clientX - dragAt.x
    const dy = event.clientY - dragAt.y
    dragAt = { x: event.clientX, y: event.clientY }
    moved += Math.abs(dx) + Math.abs(dy)
    if (event.altKey) {
      // Alt + 拖动 = 滚转。不占额外按钮：滚转是偶尔用一次的调节
      camera.roll = (camera.roll + dx * 0.4) % 360
      requestFrame(true)
      return
    }
    // 往右拖 = 画面里的东西跟着手往右走（相机左转）；往下拖 = 东西往下走（相机抬头）。
    // 方向的定义放在 `turn()` 里，注释也写在那儿——透视投影下"画面往哪边走"才是手感，
    // 角度本身的符号只是实现细节。
    // 灵敏度按视口高度归一（固定 °/px 在窄窗口里会转得太快），再乘一个整体手感系数；
    // 两个数都在 `dragUnitFor()` 里，改动它会同步影响"拖动 = 转多少度"的单元测试
    const unit = dragUnitFor(surface.clientHeight)
    // **先把相机落到一个位置上**：视角从此相对**相机自己**转（世界绕你摆）。
    // 不落点的话画面中心一直钉在内容中心，转起来就还是"绕建筑转"——就是这一步之前的行为
    settleCamera()
    turn(camera, dx, dy, unit)
    pushCamera()
    requestFrame(true)
  })

  const endDrag = (event: PointerEvent): void => {
    if (!dragging) return
    dragging = false
    document.body.classList.remove('dragging')
    if (surface.hasPointerCapture(event.pointerId)) surface.releasePointerCapture(event.pointerId)
    // 松手补一张全分辨率的：拖动中出的都是草稿帧
    requestFrame()
    // 编辑模式下"几乎没动"的一次按下 = 一次点击 → 改一格。
    // 阈值 4px：手抖的幅度，同时远小于"想转视角"的幅度
    if (editMode && event.type === 'pointerup' && event.button === button && moved <= 4) {
      void guard(t('palette.current'), () => editAt(event))
    }
  }
  surface.addEventListener('pointerup', endDrag)
  surface.addEventListener('pointercancel', endDrag)

  surface.addEventListener(
    'wheel',
    (event) => {
      event.preventDefault()
      // 透视投影下"缩放"= 改视场角（人不动，镜头变焦）。指数变化手感才均匀
      zoom(camera, event.deltaY)
      requestFrame(true)
      pushCamera()
    },
    { passive: false },
  )

  surface.addEventListener('dblclick', () => {
    camera.roll = 0
    // 位置丢掉、视场角回默认：双击是"我转晕了，回到默认取景"（重新框住内容）
    delete camera.eye
    camera.fov = DEFAULT_FOV
    camTypedEye = undefined
    requestFrame()
    pushCamera()
  })

  wireWalk();

  // 容器尺寸变化 → 重设绘制尺寸。用 ResizeObserver 而不是 window.resize：
  // 侧栏折叠、对话框打开也会改变视口大小，而 window 尺寸没变。
  const observer = new ResizeObserver(() => {
    if (viewport === undefined) return
    const rect = overlayCanvas.getBoundingClientRect()
    if (rect.width < 1 || rect.height < 1) return
    viewSize = { width: rect.width, height: rect.height }
    viewport.resize(rect.width, rect.height, window.devicePixelRatio || 1)
    requestFrame()
  })
  observer.observe(overlayCanvas)
}

/**
 * 走多快（格/秒）：跟内容尺寸走。
 *
 * 固定速度在 8 格的小屋上刚好、在 200 格的城堡上就慢得没法用；反过来也一样。
 * 取内容包围球半径的一半，再兜一个下限——大约"两秒横穿自己的建筑"。
 */
function walkSpeed(): number {
  const bounds = current?.bounds
  if (bounds === undefined) return 8
  const [dx, dy, dz] = [
    bounds.max[0] - bounds.min[0] + 1,
    bounds.max[1] - bounds.min[1] + 1,
    bounds.max[2] - bounds.min[2] + 1,
  ]
  return Math.max(6, Math.hypot(dx, dy, dz) / 4)
}

/**
 * **WASD / 空格 / Shift 移动视角**（像游戏里那样走）。
 *
 * 四件事决定了它为什么要单独一段：
 *
 * 1. **按住就连续走**，所以是个按帧推进的循环。键盘自动重复（~30 Hz，还有一段延迟）
 *    和帧率对不上，靠它驱动会一顿一顿的。
 * 2. **打字时不抢**。焦点在输入框/文本域/下拉框里就完全不接（它们吃字母键）；
 *    空格另有一条：焦点停在按钮上时归按钮，见下面 `keydown` 里的注释。
 * 3. **方向取自相机自己**：W/S 沿视线前后（抬头按 W 就是上升），A/D 水平横移，
 *    **空格上升 / Shift 下降**沿世界 Y（垂直电梯，见 `lift()`）。
 * 4. **速度随内容大小走**（按包围盒算）——200 格的城堡要走到天荒地老，而 12 格的
 *    小屋用同一个速度又能接受，所以不另设加速键，见 `walkSpeed()`。
 */
function wireWalk(): void {
  const held = new Set<string>()
  let frame: number | undefined
  let last = 0

  /** 移动键的键名（`event.key.toLowerCase()`）：空格是 `' '`，Shift 是 `'shift'`。 */
  const MOVE_KEYS = new Set(['w', 'a', 's', 'd', ' ', 'shift'])

  /**
   * **焦点在输入类控件上时不抢键**：字母键会被它们吃掉（下拉框也吃）。
   */
  const typing = (target: EventTarget | null): boolean =>
    target instanceof HTMLElement &&
    (target instanceof HTMLInputElement ||
      target instanceof HTMLTextAreaElement ||
      target instanceof HTMLSelectElement ||
      target.isContentEditable)

  const step = (now: number): void => {
    if (held.size === 0) {
      frame = undefined
      // 补一张全分辨率的（循环里出的都是草稿帧，软件视口那半分辨率得换掉）
      requestFrame()
      pushCamera()
      return
    }
    // 掉帧时不要把一步跳出去（切回来时 dt 会很大）
    const dt = Math.min(0.1, Math.max(0, (now - last) / 1000))
    last = now
    settleCamera()
    moveStep(camera, held, dt, walkSpeed())
    viewSelect.value = 'free'
    requestFrame(true)
    frame = requestAnimationFrame(step)
  }

  window.addEventListener('keydown', (event) => {
    if (event.metaKey || event.ctrlKey || event.altKey) return
    if (typing(event.target)) return
    const key = event.key.toLowerCase()
    if (!MOVE_KEYS.has(key)) return
    // **空格在按钮上归按钮**：焦点停在按钮上时按空格是"点它"，抢过来当"上升"就变成
    // "再发一次消息 / 再导出一次"。只让空格这一条：按钮不吃字母键，没理由因为焦点
    // 在按钮上就把 WASD 一起停掉。视口不可聚焦，所以在画面上点/拖一下（mousedown 会把
    // 焦点落回 body）之后空格就归相机了。
    if (key === ' ' && event.target instanceof HTMLButtonElement) return
    // 空格默认还会滚动页面。既然要拿它当"上升"，默认行为就得吃掉
    if (key === ' ') event.preventDefault()
    // 系统自动重复会把同一个键反复送进来：已经在走就什么都不用做
    if (held.has(key)) return
    held.add(key)
    if (frame === undefined) {
      last = performance.now()
      frame = requestAnimationFrame(step)
    }
  })

  const release = (event: KeyboardEvent): void => {
    held.delete(event.key.toLowerCase())
  }
  window.addEventListener('keyup', release)
  // 窗口失去焦点时按键的 keyup 收不到（切出去松的手），不清掉就会一直往前走
  window.addEventListener('blur', () => held.clear())
}

/**
 * 合成一次拖动（只给 `#drag-test` 用）。
 *
 * 目的是让"拖动"这条路径在自动抓图里也能被走到——不合成事件的话，
 * `--capture` 抓到的永远是静止的第一帧。
 */
function simulateDrag(): void {
  const send = (type: string, x: number, y: number): void => {
    overlayCanvas.dispatchEvent(
      new PointerEvent(type, {
        pointerId: 1,
        button: 0,
        buttons: type === 'pointerup' ? 0 : 1,
        clientX: x,
        clientY: y,
        bubbles: true,
      }),
    )
  }
  const rect = overlayCanvas.getBoundingClientRect()
  const cx = rect.left + rect.width / 2
  const cy = rect.top + rect.height / 2
  send('pointerdown', cx, cy)
  for (let i = 1; i <= 5; i++) send('pointermove', cx + i * 14, cy + i * 4)
}

/**
 * 合成一次"在机位面板里填坐标 + 共享给模型"（只给 `#camera-test` 用）。
 *
 * 走的全是真实的事件路径：切模式 → 填字段 → 点应用 → 勾共享。所以它验证的是
 * **人机共用机位**这条链路，而不是某个内部函数：主进程 `--shot` 拍出来的那张
 * 模型视角图，应该就是这个坐标拍出来的。
 *
 * 最后等一下节流的 120ms：不推过去的话，`--shot` 拍到的是旧机位。
 */
async function simulateCameraPanel(): Promise<void> {
  camMode.value = 'eye'
  camMode.dispatchEvent(new Event('change'))
  // 注视点故意挑在**远离内容中心**的地方（小屋中心约 (9,6,9)）：这样"模型真的用了
  // 这个机位"在图上表现为构图明显偏移，而不是"看起来差不多，大概生效了吧"
  const eye = [40, 30, 40]
  const look = [16, 6, 0]
  camEyeFields.forEach((input, index) => {
    input.value = String(eye[index])
  })
  camLookFields.forEach((input, index) => {
    input.value = String(look[index])
  })
  el('cam-apply').dispatchEvent(new MouseEvent('click'))
  camShare.checked = true
  camShare.dispatchEvent(new Event('change'))
  await new Promise((resolve) => setTimeout(resolve, 300))
}

/**
 * 合成一次"人手放一格"（只给 `#paint-test` 用）。
 *
 * 走的是**真实的指针事件**（按下 → 抬起，中间不动），所以它验的是整条链路：
 * 拖动阈值 → 拾取 IPC → 写世界 → 记 op → 重画。直接调 `editAt()` 会跳过阈值那一段，
 * 而"手一抖就改掉一格"正是最需要被验到的行为。
 */
async function simulatePaint(): Promise<void> {
  editModeInput.checked = true
  editModeInput.dispatchEvent(new Event('change'))
  const rect = overlayCanvas.getBoundingClientRect()
  const at = { x: rect.left + rect.width / 2, y: rect.top + rect.height * 0.62 }
  for (const type of ['pointerdown', 'pointerup'] as const) {
    overlayCanvas.dispatchEvent(
      new PointerEvent(type, {
        pointerId: 1,
        button: 0,
        buttons: type === 'pointerdown' ? 1 : 0,
        clientX: at.x,
        clientY: at.y,
        bubbles: true,
      }),
    )
  }
  // `pointerup` 里是 fire-and-forget 的，等它把 IPC 走完再让 `--capture` 抓图
  await new Promise((resolve) => setTimeout(resolve, 600))
}

/**
 * 合成一次撤销（只给 `#undo-test` 用）：走真实按钮那条路，抓"停在历史版本上"那张图。
 *
 * 这个状态值得能自动抓出来，因为它拦着一件会丢数据的事：此时让模型改，
 * 它的第一笔就会把后面的步骤截断。
 */
async function simulateUndo(): Promise<void> {
  renderPanel(await window.architect.undo())
  renderPanel(await window.architect.undo())
  await shoot()
}

// ── 左侧面板 ──────────────────────────────────────────────────────────────────

/**
 * 展开一条编辑记录的细节。
 *
 * 参数是**原样的 JSON**（不翻译、不美化过头）：用户在排查"模型这一步到底传了什么"，
 * 把 `args` 改写成人话反而会遮住真相（少了哪个字段、坐标写成了哪个数）。
 */
function renderOpDetail(detail: OpDetailView | undefined): void {
  const box = el('op-detail')
  if (detail === undefined) {
    box.classList.add('hidden')
    box.replaceChildren()
    return
  }
  box.classList.remove('hidden')
  const rows: Array<[string, string]> = [
    [t('panel.opDetail.source'), detail.source === 'user' ? t('panel.opDetail.sourceUser') : t('panel.opDetail.sourceLlm')],
    [t('panel.opDetail.args'), JSON.stringify(detail.args ?? {}).slice(0, 400)],
    [
      t('panel.opDetail.result'),
      t('panel.opDetail.resultLine', {
        changed: detail.result.changed,
        overwritten: detail.result.overwrittenNonAir,
        clipped: detail.result.clipped,
      }),
    ],
  ]
  box.innerHTML =
    `<b>${escapeHtml(t('panel.opDetail.title', { rev: detail.rev, tool: detail.tool }))}</b>` +
    `<button type="button" class="mini" id="op-detail-close">✕</button>` +
    `<dl>${rows
      .map(([key, value]) => `<dt>${escapeHtml(key)}</dt><dd>${escapeHtml(value)}</dd>`)
      .join('')}</dl>`
  el('op-detail-close').addEventListener('click', () => {
    box.classList.add('hidden')
  })
}

function renderPanel(next: StudioState): void {
  current = next
  // 提示是一次性的（主进程读过就清），所以在这里留住，别让它被下一次状态刷新冲掉
  if (next.notice !== undefined) showNotice(next.notice)
  renderRecovery(next.recovery)

  // **换工程 = 相机回到"框住内容"的默认取景**。位置是真实的点了，不重置的话
  // 上一座建筑里走到的那个位置会把新打开的东西留在画面外，看上去像"打开失败了"。
  const projectKey = `${next.name}\u0000${next.projectPath ?? ''}`
  if (projectKey !== cameraProjectKey) {
    cameraProjectKey = projectKey
    delete camera.eye
    camTypedEye = undefined
    syncCameraFields()
  }

  // **只留"这是什么工程、走到第几步、有多少方块"。** 调色板条目数、Minecraft 版本、
  // 包围盒、模型机位、纹理来源五行按要求**移除**了：它们是诊断信息，不是设计时要看的东西，
  // 常驻在左栏只是噪音。数据仍在 `StudioState` 上（`paletteSize` / `minecraftVersion` /
  // `bounds` / `camera` / `texture`），要恢复就是往这个数组里加回一行。
  const rows: Array<[string, string]> = [
    [t('panel.info.name'), next.name],
    [t('panel.info.revision'), `${next.revision} / ${next.totalOps}`],
    [t('panel.info.blocks'), String(next.blocks)],
  ]
  if (next.projectPath !== undefined) {
    rows.push([t('panel.info.file'), next.projectPath.split('/').pop() ?? ''])
  }
  el('project-info').innerHTML = rows
    .map(([key, value]) => `<dt>${escapeHtml(key)}</dt><dd>${escapeHtml(value)}</dd>`)
    .join('')

  // 调色板的"用过的"就是同一份直方图——一处算，两处用
  renderPaletteUsed()

  el('histogram').innerHTML = next.histogram
    .map(
      (entry) =>
        `<li><span>${escapeHtml(entry.block.replace('minecraft:', ''))}</span>` +
        `<span>${entry.count} · ${entry.percent}%</span></li>`,
    )
    .join('')

  // 编辑记录：**可点**。点一条就跳到那一步（时间线跟着走），并展开它的参数与改动量。
  // 这是"模型哪一步改坏了"最直接的入口——以前这里只有一行只读的字符串。
  el('ops').innerHTML = next.ops
    .slice()
    .reverse()
    .map(
      (op) =>
        `<li class="op${op.rev === next.revision ? ' current' : ''}${op.source === 'user' ? ' user' : ''}"` +
        ` data-rev="${op.rev}" title="${escapeHtml(t('panel.opDetail.hint'))}">` +
        `<span class="rev">${op.rev}</span><b>${escapeHtml(op.tool)}</b>` +
        `<span>${op.changed}</span></li>`,
    )
    .join('')
  for (const item of el('ops').querySelectorAll<HTMLElement>('li.op')) {
    item.addEventListener('click', () => {
      const rev = Number(item.dataset['rev'])
      if (!Number.isFinite(rev)) return
      void guard(t('panel.opDetail.title', { rev, tool: '' }), async () => {
        const detail = await window.architect.opDetail(rev)
        renderPanel(await window.architect.seek(rev))
        renderOpDetail(detail)
        await shoot()
      })
    })
  }

  scrub.max = String(next.totalOps)
  scrub.value = String(next.revision)
  revLabel.textContent = t('timeline.revision', { rev: next.revision, total: next.totalOps })
  // `#btn-latest`（回到最新）已按要求**删除**：回最新的路只剩"把时间线拖到最右端"与 ⌘⇧Z 重做，
  // 所以 behind-tip 的文案也一并改了（见 i18n 的 chat.behindTip）
  scrub.disabled = next.totalOps === 0

  // 撤销 / 重做 = 游标前后还有没有内容（不是"内存栈里还有没有东西"）
  el<HTMLButtonElement>('btn-undo').disabled = !next.canUndo
  el<HTMLButtonElement>('btn-redo').disabled = !next.canRedo

  // 停历史版本上时**不让发消息**：模型的第一笔改动会从历史分叉，
  // 把后面的几步截断丢掉——那是用户的工作，不能默默丢
  chatInput.disabled = next.behindTip || chat?.running === true
  sendButton.disabled = next.behindTip || chat?.running === true
  el('behind-tip').classList.toggle('hidden', !next.behindTip)
}

/** 可关闭的横幅。**不自动消失**——它说的是"有一份未保存的草稿"，值得用户看第二眼。 */
/**
 * 崩溃恢复的待办条。
 *
 * 为什么不是一句提示：**"上次有 3 步没保存"这件事只有配上动作才有意义**。
 * 以前这里只有一行字，还写着"打开那个工程即可在此基础上继续"——而草稿躺在磁盘上
 * 根本没人重放。现在两个按钮各对应主进程一个真实动作。
 *
 * 基准工程找不到时，"恢复"必须是禁用的：没有基准就没法知道该把这些 op 接到哪儿，
 * 硬接出来的世界不会是崩溃前的那个。
 */
/**
 * 需求模板行已按要求**删除**：`#templates` 的 markup、`TEMPLATE_KEYS`、`renderTemplates()`、
 * 两处调用点、以及 gui-smoke 里那条 `templates` 断言一起拆掉了。
 * 模板文案本身还在（`docs/prompt-library.md` 与 i18n 的 `chat.templates.*`），
 * 要恢复就把 markup 加回 index.html，再把这里那个函数接回来。
 */

function renderRecovery(recovery: StudioState['recovery']): void {
  const banner = el('recovery')
  if (recovery === undefined) {
    banner.classList.add('hidden')
    return
  }
  banner.classList.remove('hidden')
  el('recovery-detail').textContent = t('recovery.detail', {
    ops: String(recovery.ops),
    project: recovery.basePath ?? '—',
  })
  const apply = el('btn-recover') as HTMLButtonElement
  apply.disabled = !recovery.baseExists
  apply.title = recovery.baseExists ? '' : t('recovery.noBase')
}

function showNotice(text: string): void {
  noticeEl.classList.remove('hidden')
  noticeEl.replaceChildren()
  const body = document.createElement('b')
  body.textContent = text
  const close = document.createElement('button')
  close.type = 'button'
  close.className = 'mini'
  close.textContent = '✕'
  close.addEventListener('click', () => noticeEl.classList.add('hidden'))
  noticeEl.append(body, close)
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c,
  )
}

// ── 对话 ──────────────────────────────────────────────────────────────────────

function renderChat(next: ChatView): void {
  chat = next
  // 两道闸叠加：运行中不能发，停在历史版本上也不能发（`renderPanel` 也会设一次，
  // 两个渲染函数都会跑，所以两边都要把对方那个条件算进去，否则后跑的那个会把它抹掉）
  const locked = next.running || current?.behindTip === true
  sendButton.disabled = locked
  stopButton.classList.toggle('hidden', !next.running)
  chatInput.disabled = locked

  if (next.blocking.length > 0) {
    blockingEl.classList.remove('hidden')
    // 挡住发送的原因 + **一个能直接解决问题的按钮**。只说"到设置里去填"等于把用户丢在
    // 一个需要自己找路的地方——而这是新用户第一次打开应用时看到的第一屏（M8 的
    // "5 分钟产出第一座建筑"就卡在这儿）
    blockingEl.innerHTML =
      `<b>${escapeHtml(t('chat.noProvider'))}</b><ul>${next.blocking
        .map((item) => `<li>${escapeHtml(item)}</li>`)
        .join('')}</ul><button type="button" class="mini" id="blocking-settings">${escapeHtml(
        t('chat.openSettings'),
      )}</button>`
    el('blocking-settings').addEventListener('click', () => {
      if (settings !== undefined) renderSettings(settings)
      settingsDialog.showModal()
    })
  } else {
    blockingEl.classList.add('hidden')
    blockingEl.innerHTML = ''
  }

  // 整列重建：消息是几十条量级，diff 不值得（也更不容易出错）
  // 贴底才自动滚：流式生成时字一直在往下长，用户要是往上翻看早先的内容，
  // 每次重绘都把他拽回底部就等于不让人看
  const stick = messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight < 40
  messagesEl.replaceChildren(...next.messages.map(renderMessage))

  // 用量与花费。缓存命中那一项**只在 provider 报了的时候才显示**（见 format.ts）：
  // 98% 命中是这个 harness 成本结构里最重要的一个数字（§9.2 Regime A 就是为它选的），
  // 藏在 token 数里等于没显示
  const cache = cacheShare(next.usage)
  const parts = [
    t('cost.tokens', { in: next.usage.in, out: next.usage.out }),
    `${next.usage.turns} turns · ${next.usage.toolCalls} tools · ${next.usage.screenshots} shots`,
  ]
  if (cache !== undefined) {
    parts.push(t('cost.cached', { count: cache.count, percent: cache.percent }))
  }
  usageEl.textContent = parts.join('   ')
  const usd =
    next.costUsd !== undefined
      ? t('cost.usd', { amount: next.costUsd.toFixed(4) })
      : next.usage.in > 0
        ? t('cost.noPrice')
        : ''
  costEl.textContent =
    cache === undefined || usd.length === 0
      ? usd
      : `${usd} · ${t('cost.cachedShare', { percent: cache.percent })}`
  // 状态行是隐藏的；「思考中…」现在长在对话列表里（见 `renderMessage`）
  if (next.running) setStatus(t('chat.thinking'))
  else if (next.budgetStop !== undefined) setStatus(next.budgetStop)
  else if (next.stopReason !== undefined) setStatus(t('chat.turnDone', { reason: next.stopReason }))

  // 滚到底部（正在生成时尤其重要）
  if (stick) messagesEl.scrollTop = messagesEl.scrollHeight
}

function renderMessage(message: ChatMessageView): HTMLLIElement {
  const li = document.createElement('li')
  li.className = message.gate === true ? `${message.role} gate` : message.role
  li.dataset['messageId'] = String(message.id)
  // 只有流式的最后一条会画光标（CSS 挂在 `.streaming` 上，光标由 `::after` 补）
  if (message.streaming === true) li.classList.add('streaming')

  const who = document.createElement('span')
  who.className = 'who'
  who.textContent =
    message.failed === true
      ? t('chat.failed')
      : message.gate === true
        ? t('chat.nudge')
        : message.role === 'tool'
          ? `${t('chat.toolCall')} · ${message.toolName ?? ''}`
          : message.role === 'user'
            ? 'you'
            : t('app.name')
  li.append(who)

  if (message.args !== undefined && message.args !== '{}') {
    const tag = document.createElement('span')
    tag.className = 'tag'
    tag.textContent = message.args
    li.append(tag)
  }

  if (message.role === 'tool' && message.toolOk === false) li.classList.add('bad')
  // 失败的这一轮画红：它和"模型说了句话"必须一眼分得开
  if (message.failed === true) li.classList.add('bad')

  const body = document.createElement('div')
  if (message.streaming === true && message.text.length === 0) {
    // 正文一个字都还没来 = 模型在思考。**这条提示就长在对话列表里**，
    // 而不是顶栏那行看不见的状态。已经想了多少字也报出来：长思考时那是"它还活着"的证据。
    body.className = 'thinking'
    const count = message.thinking ?? 0
    body.textContent = count > 0 ? t('chat.thinkingLive', { count }) : t('chat.thinking')
  } else {
    body.textContent = message.text
  }
  li.append(body)

  if (message.imageId !== undefined) {
    const img = document.createElement('img')
    img.className = 'shot'
    img.alt = `rev ${message.imageRevision ?? '?'} ${message.imageView ?? ''}`
    img.addEventListener('click', () => img.classList.toggle('zoom'))
    void loadImage(message.imageId, img)
    li.append(img)
  }
  return li
}

async function loadImage(id: string, img: HTMLImageElement): Promise<void> {
  const cached = imageUrls.get(id)
  if (cached !== undefined) {
    img.src = cached
    return
  }
  try {
    const bytes = await window.architect.chatImage(id)
    if (bytes === undefined) return
    const url = URL.createObjectURL(new Blob([bytes as unknown as BlobPart], { type: 'image/png' }))
    imageUrls.set(id, url)
    img.src = url
  } catch {
    // 截图被缓存淘汰是正常的，静默跳过
  }
}

// ── 设置 ──────────────────────────────────────────────────────────────────────

function renderSettings(next: SettingsView): void {
  settings = next
  const select = el<HTMLSelectElement>('provider-select')
  select.replaceChildren(
    ...next.providers.map((provider) => {
      const option = document.createElement('option')
      option.value = provider.id
      option.textContent = `${provider.id}  ·  ${presetLabel(provider.preset)}`
      return option
    }),
  )
  const target = editing !== undefined && next.providers.some((p) => p.id === editing!.id)
    ? editing.id
    : next.activeId
  select.value = target
  loadFields(next.providers.find((p) => p.id === target))

  el<HTMLSelectElement>('cfg-locale').value = next.locale
  ;(el<HTMLInputElement>('cfg-usd')).value = next.budget?.maxUsd !== undefined ? String(next.budget.maxUsd) : ''
  ;(el<HTMLInputElement>('cfg-turns')).value =
    next.budget?.maxTurns !== undefined ? String(next.budget.maxTurns) : ''
}

/** 预设按钮：一键加一个实例（D-14 四项）。 */
function renderPresetButtons(): void {
  const row = el('preset-row')
  row.replaceChildren(
    ...['deepseek', 'openai', 'ollama', 'custom'].map((preset) => {
      const button = document.createElement('button')
      button.type = 'button'
      button.textContent = presetLabel(preset)
      button.addEventListener('click', () => {
        void guard(t('settings.addProvider'), async () => {
          const view = await window.architect.addProvider(preset)
          editing = view.providers.find((p) => p.id === view.activeId)
          renderSettings(view)
          setProbeLog(t('settings.llm.testing'))
        })
      })
      return button
    }),
  )
}

function loadFields(provider: ProviderView | undefined): void {
  editing = provider
  if (provider === undefined) return
  el<HTMLInputElement>('cfg-baseurl').value = provider.baseURL
  el<HTMLInputElement>('cfg-model').value = provider.model
  const key = el<HTMLInputElement>('cfg-key')
  key.value = ''
  key.placeholder = provider.hasKey
    ? t('settings.llm.keyPresent')
    : provider.envName !== undefined
      ? `env:${provider.envName}`
      : ''
}

function collectConfig(): { config: Record<string, unknown>; plain?: string } {
  const base = editing
  const keyPlain = el<HTMLInputElement>('cfg-key').value
  const config: Record<string, unknown> = {
    id: base?.id ?? 'custom',
    preset: base?.preset ?? 'custom',
    kind: base?.kind ?? 'openai-compatible',
    baseURL: el<HTMLInputElement>('cfg-baseurl').value.trim(),
    apiKeyRef: base?.apiKeyRef ?? '',
    model: el<HTMLInputElement>('cfg-model').value.trim(),
    capabilities: base?.capabilities ?? {
      vision: false,
      toolCalling: 'native',
      promptCache: 'none',
      source: 'preset',
    },
  }
  if (base?.cost !== undefined) config['cost'] = base.cost
  return keyPlain.trim().length > 0 ? { config, plain: keyPlain } : { config }
}

function setProbeLog(text: string): void {
  el('probe-log').textContent = text
}

async function runProbe(listOnly: boolean): Promise<void> {
  if (editing === undefined) return
  const { config, plain } = collectConfig()
  setProbeLog(t('settings.llm.testing'))
  try {
    const result = await window.architect.testConnection({
      preset: editing.preset,
      baseURL: config['baseURL'],
      model: config['model'],
      apiKeyRef: config['apiKeyRef'],
      ...(plain !== undefined ? { apiKeyPlain: plain } : {}),
      listOnly,
    })
    setProbeLog(describeProbe(result))
    // 探针挑出来的模型写回输入框——用户不用手抄
    if (result.config.model.length > 0) el<HTMLInputElement>('cfg-model').value = result.config.model
  } catch (error) {
    setProbeLog(error instanceof Error ? error.message : String(error))
  }
}

function describeProbe(result: DiscoveryResult): string {
  const lines: string[] = []
  for (const step of result.steps) {
    switch (step.type) {
      case 'models':
        lines.push(t('settings.llm.discovered', { count: step.count }))
        for (const model of step.models) lines.push(`    ${model}`)
        break
      case 'model':
        lines.push(
          `${t('settings.llm.model')}: ${step.model}` +
            (step.matched !== undefined ? `  (${step.matched})` : step.guessed === true ? '  (?)' : ''),
        )
        break
      case 'text':
        lines.push(step.ok ? `text ok (${step.tokensIn} in)` : `text failed: ${step.error}`)
        break
      case 'tools':
        lines.push(`tool calling: ${step.mode}`)
        break
      case 'vision':
        lines.push(
          step.vision
            ? `${t('settings.llm.vision')}: ${t('settings.llm.yesVision')}` +
                (step.imageTokenCost !== undefined
                  ? `  ${t('settings.llm.imageTokenCost')} ≈ ${step.imageTokenCost}`
                  : '')
            : `${t('settings.llm.vision')}: ${t('settings.llm.noVision')} — ${step.error ?? ''}`,
        )
        break
      case 'error':
        lines.push(`! ${step.error}`)
        break
      case 'capabilities':
        lines.push('')
        lines.push(`source: ${step.capabilities.source}   promptCache: ${step.capabilities.promptCache}`)
        if (step.capabilities.contextWindow !== undefined) {
          lines.push(`${t('settings.llm.contextWindow')}: ${step.capabilities.contextWindow}`)
        }
        break
      default:
        break
    }
  }
  lines.push('')
  lines.push(result.ok ? 'OK' : `FAILED: ${result.error ?? ''}`)
  return lines.join('\n')
}

// ── 接线 ──────────────────────────────────────────────────────────────────────

/**
 * 主进程传来的诊断开关（`location.hash` 里的逗号列表）。
 *
 * 渲染进程读不到 `process.argv`，所以这些开关只能这样传。做成列表是为了能**叠加**：
 * `--no-webgl --drag-test` 验的是"没有 WebGL 时拖动还能不能用"。
 */
const debugFlags = (): Set<string> =>
  new Set(location.hash.replace(/^#/, '').split(',').filter((flag) => flag.length > 0))

/**
 * 建视口。**GPU 优先，拿不到就退回软件光栅器**。
 *
 * `no-webgl` 是给自动抓图用的：没有 WebGL 的机器平时没法在 CI 上复现，
 * 这个开关让那条兜底路径可以被真的走到（也顺便让人肉验一次观感）。
 */
function createViewport(): SceneViewport {
  if (!debugFlags().has('no-webgl') && webglAvailable()) {
    try {
      return new Viewport(canvas, overlayCanvas)
    } catch (error) {
      // three 的构造函数抛了也要能继续：兜底那条路就是为这种情况准备的
      console.warn('WebGL 初始化失败，改用软件视口：', error)
    }
  }
  softwareViewport = true
  return new SoftwareViewport(new CanvasFrameSink(), (request) => window.architect.viewport(request))
}

function wire(): void {
  viewport = createViewport()
  wireViewport()
  wireCamera()
  wirePalette()

  el('btn-new').addEventListener('click', () => {
    void guard(t('menu.new'), async () => {
      renderPanel(await window.architect.newProject())
      await shoot()
    })
  })

  el('btn-recover').addEventListener('click', () => {
    void guard(t('recovery.apply'), async () => {
      renderPanel(await window.architect.applyRecovery())
      await shoot()
      setStatus(t('recovery.applied'))
    })
  })

  el('btn-discard-recovery').addEventListener('click', () => {
    void guard(t('recovery.discard'), async () => {
      renderPanel(await window.architect.discardRecovery())
      setStatus(t('recovery.discarded'))
    })
  })

  el('btn-open').addEventListener('click', () => {
    void guard(t('menu.open'), async () => {
      const state = await window.architect.open()
      if (state === undefined) return
      renderPanel(state)
      await shoot()
    })
  })

  el('btn-save').addEventListener('click', () => {
    void guard(t('menu.save'), async () => {
      const path = await window.architect.save()
      if (path !== undefined) {
        renderPanel(await window.architect.state())
        setStatus(`${t('menu.save')} → ${path}`)
      }
    })
  })

  el('btn-demo').addEventListener('click', () => {
    void guard(t('menu.demo'), async () => {
      renderPanel(await window.architect.demo())
      await shoot()
    })
  })

  el('btn-export').addEventListener('click', () => {
    void guard(t('menu.export'), async () => {
      // 扩展名决定格式；`.schem` / `.litematic` / `.obj` 三种
      const result = await window.architect.exportModel('schem')
      if (result === undefined) return // 用户取消
      showNotice(t('notice.exported', { count: result.paths.length, names: result.paths.join('、') }))
      setStatus(result.summary)
    })
  })

  el('btn-import').addEventListener('click', () => {
    void guard(t('menu.import'), async () => {
      const result = await window.architect.importModel()
      if (result === undefined) return // 用户取消
      renderPanel(result.state)
      // 认不出来的方块要如实说，别让用户以为全导进来了
      const parts = [t('notice.imported', { summary: result.summary })]
      if (result.renamed.length > 0) parts.push(t('notice.importRenamed', { count: result.renamed.length }))
      if (result.unknown.length > 0) {
        parts.push(
          t('notice.importSkipped', { count: result.unknown.length, cells: result.skipped }) +
            `\n${result.unknown
              .slice(0, 5)
              .map((entry) => `${entry.name} ×${entry.count}`)
              .join('、')}`,
        )
      }
      showNotice(parts.join('\n'))
      await shoot()
    })
  })

  viewSelect.addEventListener('change', () => {
    view = viewSelect.value
    void window.architect.setUi({ view })
    // "自由视角"只是拖动留下的状态，选它不改变相机
    applyPreset(view)
    void shoot()
  })

  // 撤销 / 重做：游标前后移动 + 重放。走的是和 seek 同一条路，
  // 所以拖时间线和按 ⌘Z 在语义上没有区别（plan §6）。
  el('btn-undo').addEventListener('click', () => {
    void guard(t('menu.undo'), async () => {
      renderPanel(await window.architect.undo())
      await shoot()
    })
  })
  el('btn-redo').addEventListener('click', () => {
    void guard(t('menu.redo'), async () => {
      renderPanel(await window.architect.redo())
      await shoot()
    })
  })
  // 快捷键：⌘Z / Ctrl+Z 撤销，⇧⌘Z / Ctrl+Shift+Z 重做。
  // **输入框里不抢**——在文本框里按 ⌘Z 应该是文本撤销，不是世界撤销。
  document.addEventListener('keydown', (event) => {
    if (!(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== 'z') return
    const active = document.activeElement
    if (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement) return
    event.preventDefault()
    const action = event.shiftKey ? window.architect.redo() : window.architect.undo()
    const label = event.shiftKey ? t('menu.redo') : t('menu.undo')
    void guard(label, async () => {
      renderPanel(await action)
      await shoot()
    })
  })

  // 时间线拖动：input 事件很密集，用 requestAnimationFrame 合流
  let pending: number | undefined
  scrub.addEventListener('input', () => {
    const revision = Number(scrub.value)
    revLabel.textContent = t('timeline.revision', { rev: revision, total: current?.totalOps ?? 0 })
    if (pending !== undefined) cancelAnimationFrame(pending)
    pending = requestAnimationFrame(() => {
      pending = undefined
      void guard(t('timeline.drag'), async () => {
        renderPanel(await window.architect.seek(revision))
        await shoot()
      })
    })
  })

  window.addEventListener('keydown', (event) => {
    if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement) return
    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
      const delta = event.key === 'ArrowLeft' ? -1 : 1
      const next = Math.max(0, Math.min(current?.totalOps ?? 0, (current?.revision ?? 0) + delta))
      if (next === current?.revision) return
      scrub.value = String(next)
      void guard(t('timeline.drag'), async () => {
        renderPanel(await window.architect.seek(next))
        await shoot()
      })
    }
  })

  // ── 对话 ────────────────────────────────────────────────────────────────────
  el<HTMLFormElement>('chat-form').addEventListener('submit', (event) => {
    event.preventDefault()
    void submitChat()
  })
  chatInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
      event.preventDefault()
      void submitChat()
    }
  })
  stopButton.addEventListener('click', () => {
    void guard(t('chat.stop'), async () => renderChat(await window.architect.stop()))
  })
  // 「清空」按钮已按要求**删除**（连 `chat.clear` 的入口一起）。
  // `ChatController.clear()` 与 IPC `chat:clear` 都还在，要恢复只要把按钮加回 index.html
  // 并接上这一句：`renderChat(await window.architect.clearChat())`

  // ── 设置 ────────────────────────────────────────────────────────────────────
  // 「设置」按钮按要求**从界面上隐藏**（`hidden`，见 index.html）。
  // 接线照旧：`#blocking-settings`（没配好模型时那条提示里的按钮）仍然会打开同一个对话框，
  // 所以"配置不全"这条路径不受影响；受影响的是**配好之后**没有入口再改设置。
  // 要把它找回来：去掉 index.html 上那个 `hidden`，或者在这里加一个快捷键（例：⌘, ）。
  el('btn-settings').addEventListener('click', () => {
    if (settings !== undefined) renderSettings(settings)
    settingsDialog.showModal()
  })
  el('btn-settings-cancel').addEventListener('click', () => settingsDialog.close())
  el('btn-settings-save').addEventListener('click', () => {
    void guard(t('settings.apply'), async () => {
      const { config, plain } = collectConfig()
      await window.architect.saveProvider(config, plain)
      const usd = Number(el<HTMLInputElement>('cfg-usd').value)
      const turns = Number(el<HTMLInputElement>('cfg-turns').value)
      const budget: Record<string, number> = {}
      if (Number.isFinite(usd) && usd > 0) budget['maxUsd'] = usd
      if (Number.isFinite(turns) && turns > 0) budget['maxTurns'] = turns
      const withBudget = await window.architect.setBudget(Object.keys(budget).length > 0 ? budget : undefined)
      renderSettings(withBudget)
      el<HTMLInputElement>('cfg-key').value = ''
      settingsDialog.close()
      setStatus(t('settings.llm.saved'))
    })
  })
  el('provider-select').addEventListener('change', () => {
    const id = el<HTMLSelectElement>('provider-select').value
    void guard(t('settings.preset'), async () => {
      const view = await window.architect.setActive(id)
      renderSettings(view)
    })
  })
  el('btn-remove-provider').addEventListener('click', () => {
    if (editing === undefined) return
    void guard(t('settings.removeProvider'), async () => {
      const view = await window.architect.removeProvider(editing!.id)
      editing = undefined
      renderSettings(view)
    })
  })
  el('cfg-locale').addEventListener('change', () => {
    const locale = el<HTMLSelectElement>('cfg-locale').value
    void guard(t('settings.language'), async () => {
      renderSettings(await window.architect.setLocale(locale))
    })
  })
  el('btn-test').addEventListener('click', () => void runProbe(false))
  el('btn-test-list').addEventListener('click', () => void runProbe(true))

  window.architect.subscribe((event) => {
    if (event.type === 'chat') renderChat(event.view)
    else if (event.type === 'settings') renderSettings(event.view)
    else if (event.type === 'state') {
      renderPanel(event.state)
      void shoot()
    }
  })
}

async function submitChat(): Promise<void> {
  const text = chatInput.value
  if (text.trim().length === 0) return
  chatInput.value = ''
  try {
    renderChat(await window.architect.send(text))
  } catch (error) {
    setStatus(error instanceof Error ? error.message : String(error))
  }
}

// ── 启动 ──────────────────────────────────────────────────────────────────────

async function boot(): Promise<void> {
  // 先挂上离屏截图钩子：主进程从 `ready` 之后就可能来要图，
  // 挂晚了会白丢一枪（那一枪会退回软件光栅器，图糊一点但不会错）
  window.__architectCaptureShot = captureShot
  try {
    const initial = await window.architect.settings()
    initI18n({ locale: initial.locale })
    applyStaticText()
    renderPresetButtons()
    onLocaleChange(() => {
      applyStaticText()
      renderPresetButtons()
      if (current !== undefined) renderPanel(current)
      if (chat !== undefined) renderChat(chat)
      if (settings !== undefined) renderSettings(settings)
    })
    setLocale(initial.locale)
    if (initial.ui.view !== undefined && initial.ui.view.length > 0) {
      view = initial.ui.view
      viewSelect.value = view
    }

    wire()
    // 软件视口是**降级**，不是常态：必须说出来，否则用户只会觉得"这软件怎么这么卡"
    if (softwareViewport) showNotice(t('viewport.softwareMode'))
    // 预设角度必须在第一帧之前拿到，否则首帧用的是写死的默认角度
    await loadPresets()
    renderSettings(initial)
    renderPanel(await window.architect.state())
    renderChat(await window.architect.chat())
    await shoot()
    // `#settings`：抓图/调试时直接把设置面板打开
    if (debugFlags().has('settings')) settingsDialog.showModal()
    // `#drag-test`：合成一次拖动，让"拖动"这条路径在自动抓图里也能被走到
    if (debugFlags().has('drag-test')) simulateDrag()
    // `#camera-test`：合成一次机位面板操作 + 共享给模型
    if (debugFlags().has('camera-test')) await simulateCameraPanel()
    if (debugFlags().has('undo-test')) await simulateUndo()
    if (debugFlags().has('paint-test')) await simulatePaint()
    await window.architect.ready({
      ok: true,
      detail: softwareViewport
        ? `软件视口 ${overlayCanvas.width}x${overlayCanvas.height}（没有 WebGL）`
        : `canvas ${canvas.width}x${canvas.height}`,
    })
  } catch (error) {
    await window.architect.ready({
      ok: false,
      detail: error instanceof Error ? error.message : String(error),
    })
  }
}

void boot()
