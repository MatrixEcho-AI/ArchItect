import { initI18n, onLocaleChange, setLocale, t } from '@architect/i18n'
import { eyeFromOrientation, orientationFromEye } from '@architect/render/browser'

import { cacheShare } from './format.js'
import { SoftwareViewport, Viewport } from './viewport.js'
import type { FrameSink, SceneViewport, SoftwareFrame } from './viewport.js'
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
const camScale = el<HTMLInputElement>('cam-scale')
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

let viewport: SceneViewport | undefined
/**
 * 相机状态。`scale <= 0` 表示自动取景，`target` 省略表示注视内容中心。
 *
 * **这是"用户在看的那个机位"**，和主进程会话里的相机（`set_camera` / 机位面板写的那份）
 * 是两个东西：拖动只改这一份，只有勾了「模型用这个机位」才会推过去。
 * 分开是有意的——用户随手转两下不该悄悄改掉模型下一张截图的机位。
 */
const camera: { azimuth: number; elevation: number; roll: number; scale: number; target?: [number, number, number] } = {
  azimuth: 45,
  elevation: 35,
  roll: 0,
  scale: 0,
}
/** 机位面板有没有把机位同步给模型（会话相机）。 */
let camShared = false
/** 推机位给主进程的节流句柄：拖动时每个 pointermove 都推一次会白写几百次 IPC。 */
let camPushTimer: number | undefined
/**
 * 由角度反推"相机位置"时用的虚构距离。
 *
 * 正交投影下**相机到注视点的距离完全不影响成像**，所以这个数只是为了让面板上有个
 * 能显示、能编辑的位置。面板下方的提示把这一点写明了，避免用户以为"放远了会变小"。
 */
const CAMERA_PROBE_DISTANCE = 64

/**
 * 会话相机 → 一行给人看的文字。
 *
 * 和 `shotCameraLabel` 的口径一致（那一个进的是对话档案，这一个进的是面板），
 * 所以用户在这一行看到的标签，就是事后在档案里能对上的那一个。
 */
function describeModelCamera(camera: StudioState['camera']): string {
  if (camera === undefined) return t('panel.info.cameraDefault')
  const parts: string[] = []
  if (camera.eye !== undefined && camera.lookAt !== undefined) {
    parts.push(`eye(${camera.eye.map((v) => Math.round(v)).join(',')})→(${camera.lookAt.map((v) => Math.round(v)).join(',')})`)
  } else {
    if (camera.azimuth !== undefined) parts.push(`az${Math.round(camera.azimuth)}`)
    if (camera.elevation !== undefined) parts.push(`el${Math.round(camera.elevation)}`)
    if (camera.lookAt !== undefined) parts.push(`→(${camera.lookAt.map((v) => Math.round(v)).join(',')})`)
  }
  if (camera.roll !== undefined && camera.roll !== 0) parts.push(`rl${Math.round(camera.roll)}`)
  if (camera.scale !== undefined) parts.push(`z${camera.scale}`)
  return parts.length > 0 ? parts.join(' ') : t('panel.info.cameraDefault')
}

/** 预设机位的角度由主进程给（`VIEW_PRESETS` 是唯一真相）。 */
const presetAngles = new Map<string, { azimuth: number; elevation: number }>()
/** 当前场景对应的 revision，用来判断要不要重新拉几何。 */
let sceneRevision = -1
/** 画一帧的节流：pointermove 的频率远高于屏幕刷新。 */
let frameQueued = false
/** 自动取景下真实的缩放值，滚轮第一次缩放时拿它当基准。 */
let lastScale = 1

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
  camera.elevation = angles.elevation
  camera.roll = 0
  camera.scale = 0
  // 预设机位一律回到"看内容中心"，否则上一轮定的注视点会把建筑挤到画面外
  camera.target = undefined
  // 换机位就丢掉"用户手填的 eye"——方向变了，那三个数不再代表当前朝向
  camTypedEye = undefined
}

// ── 机位面板 ──────────────────────────────────────────────────────────────────
//
// 拖动已经能转角度，这里补的是**精确输入**与**自定义注视点**。三件事值得写清楚：
//
// 1. 字段是**单向镜**：相机变了就刷新字段（拖动时也跟着变），但用户正在这个面板里
//    打字时不刷新——否则每敲一个字符都被改写回去。
// 2. `eye` 只提供**方向**。正交投影下距离不影响成像（D-46），所以由角度反推出的
//    `eye` 与用户填的 `eye` 不在同一条射线上也没关系，只有方向一致就够了。
// 3. 勾了「模型用这个机位」才推给主进程。推的是**角度 + 注视点**，不是 eye——因为
//    会话相机是角度语义的（`set_camera` 也一样），eye 反解成角度是信息无损的，
//    反过来则要凭空造一个距离。

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

const cameraTarget = (): [number, number, number] => camera.target ?? contentCenter()
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
  const target = cameraTarget()
  const eye = eyeFromOrientation(
    {
      target: { x: target[0], y: target[1], z: target[2] },
      azimuth: camera.azimuth,
      elevation: camera.elevation,
      roll: camera.roll,
      scale: 1,
      width: 1,
      height: 1,
    },
    CAMERA_PROBE_DISTANCE,
  )
  camAz.value = round1(camera.azimuth)
  camElev.value = round1(camera.elevation)
  camRoll.value = round1(camera.roll)
  camScale.value = camera.scale > 0 ? round1(camera.scale) : ''

  // 方向和注视点都还是用户填的那一组时，保留他填的数字（见 `camTypedEye`）
  const typed = camTypedEye
  const keepTyped =
    typed !== undefined &&
    Math.abs(typed.azimuth - camera.azimuth) < 1e-6 &&
    Math.abs(typed.elevation - camera.elevation) < 1e-6 &&
    typed.lookAt.every((value, index) => Math.abs(value - target[index]!) < 1e-6)
  if (!keepTyped) camTypedEye = undefined
  const eyeValues: [number, number, number] = keepTyped ? typed.eye : [eye.x, eye.y, eye.z]
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
  const scaleRaw = readNum(camScale, 0)
  const scale = scaleRaw > 0 ? clamp(scaleRaw, 0.5, 120) : 0

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
      camera.elevation = clamp(oriented.elevation, 1, 89)
    } catch {
      // 两点重合，朝向无法确定
      setStatus(t('viewport.cam.invalid'))
      return false
    }
    camera.target = [look[0]!, look[1]!, look[2]!]
    camTypedEye = {
      eye: [eye[0]!, eye[1]!, eye[2]!],
      lookAt: [look[0]!, look[1]!, look[2]!],
      azimuth: camera.azimuth,
      elevation: camera.elevation,
    }
  } else {
    camera.azimuth = readNum(camAz, camera.azimuth)
    camera.elevation = clamp(readNum(camElev, camera.elevation), 1, 89)
    camera.target = undefined
    camTypedEye = undefined
  }

  camera.roll = roll
  camera.scale = scale
  viewSelect.value = 'free'
  return true
}

/**
 * 把当前机位推给主进程的会话——**模型接下来的截图就从这里看**。
 *
 * 只在勾了「模型用这个机位」时推，并且节流。推的是角度 + 注视点（见本节开头第 3 条）。
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
        ...(camera.target !== undefined ? { lookAt: camera.target } : {}),
        ...(camera.scale > 0 ? { scale: camera.scale } : {}),
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

  for (const input of [camAz, camElev, camRoll, camScale, ...camEyeFields, ...camLookFields]) {
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
    azimuth: camera.azimuth,
    elevation: camera.elevation,
    roll: camera.roll,
    ...(camera.scale > 0 ? { scale: camera.scale } : {}),
    ...(camera.target !== undefined ? { target: camera.target } : {}),
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
    if (current.blocks === 0) {
      empty.classList.add('show')
      return
    }
    empty.classList.remove('show')
    viewport.render(camera, { draft: isDraft })
    if (isDraft) {
      if (refineTimer !== undefined) window.clearTimeout(refineTimer)
      refineTimer = window.setTimeout(() => {
        refineTimer = undefined
        requestFrame()
      }, 180)
    }
    // 机位面板是相机的**单向镜**：拖动时数字跟着变，但用户正在面板里打字时不覆盖
    syncCameraFields()
    setStatus(
      t('viewport.status', {
        az: camera.azimuth.toFixed(0),
        el: camera.elevation.toFixed(0),
        ms: softwareViewport ? 'CPU' : 'GPU',
      }) + (camShared ? ` · ${t('viewport.cam.sharedShort')}` : ''),
    )
  })
}

/** 与旧路径同名：程序化刷新（换版本、打开工程…）都走它。 */
async function shoot(): Promise<void> {
  await syncScene()
  requestFrame()
}

const clamp = (value: number, lo: number, hi: number): number => (value < lo ? lo : value > hi ? hi : value)

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
    // 往右拖 = 场景往右转；向下拖 = 从上往下看。
    // 灵敏度按视口高度归一：固定 °/px 在窄窗口里会转得太快。
    const unit = 360 / Math.max(320, surface.clientHeight)
    camera.azimuth -= dx * unit
    camera.elevation = clamp(camera.elevation + dy * unit * 0.8, 1, 89)
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
      // 指数缩放：每格 1.0015^Δy，滚一格（~100）约 ±16%，手感上比较均匀
      const base = camera.scale > 0 ? camera.scale : lastScale
      camera.scale = clamp(base * Math.exp(-event.deltaY * 0.0015), 0.5, 120)
      requestFrame(true)
    },
    { passive: false },
  )

  surface.addEventListener('dblclick', () => {
    camera.scale = 0
    camera.roll = 0
    // 注视点也一起回内容中心：双击是"我转晕了，回到默认取景"
    camera.target = undefined
    requestFrame()
  })

  // 容器尺寸变化 → 重设绘制尺寸。用 ResizeObserver 而不是 window.resize：
  // 侧栏折叠、对话框打开也会改变视口大小，而 window 尺寸没变。
  const observer = new ResizeObserver(() => {
    if (viewport === undefined) return
    const rect = overlayCanvas.getBoundingClientRect()
    if (rect.width < 1 || rect.height < 1) return
    viewport.resize(rect.width, rect.height, window.devicePixelRatio || 1)
    requestFrame()
  })
  observer.observe(overlayCanvas)
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

  const rows: Array<[string, string]> = [
    [t('panel.info.name'), next.name],
    [t('panel.info.revision'), `${next.revision} / ${next.totalOps}`],
    [t('panel.info.blocks'), String(next.blocks)],
    [t('panel.info.palette'), String(next.paletteSize)],
    [t('panel.info.minecraft'), next.minecraftVersion],
  ]
  if (next.bounds !== undefined) {
    const [a, b] = [next.bounds.min, next.bounds.max]
    rows.push([t('panel.info.bounds'), `${a.join(',')} … ${b.join(',')}`])
  }
  if (next.projectPath !== undefined) {
    rows.push([t('panel.info.file'), next.projectPath.split('/').pop() ?? ''])
  }
  // 模型当前会从哪个机位截图。**只读**：自动把用户的视角改到模型那边会很难解释
  // （"我只是想让模型看看，结果我自己的画面被拽走了"）。
  rows.push([t('panel.info.camera'), describeModelCamera(next.camera)])
  rows.push([t('panel.info.textures'), describeTextureSource(next.texture)])
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
  el<HTMLButtonElement>('btn-latest').disabled = next.behindTip
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
 * 需求模板（M8「5 分钟产出第一座建筑」最直接的一步）。
 *
 * 以前模板只躺在 `docs/prompt-library.md` 里——用户得离开应用去复制粘贴。
 * 文案走 i18n（换语言时模板也跟着换），四个模板对应文档里的四类。
 */
const TEMPLATE_KEYS = ['house', 'public', 'decor', 'fix'] as const

function renderTemplates(): void {
  const row = el('templates')
  row.title = t('chat.templates.hint')
  row.innerHTML = `<span class="label">${escapeHtml(t('chat.templates.label'))}</span>`
  for (const key of TEMPLATE_KEYS) {
    const button = document.createElement('button')
    button.type = 'button'
    button.className = 'mini'
    button.textContent = t(`chat.templates.${key}`).split('\n')[0]!.slice(0, 14)
    button.dataset['template'] = key
    button.addEventListener('click', () => {
      const input = el<HTMLTextAreaElement>('chat-input')
      input.value = t(`chat.templates.${key}`)
      input.focus()
      // 光标放到末尾：用户接下来要改的就是里面的数字与材质
      input.setSelectionRange(input.value.length, input.value.length)
    })
    row.append(button)
  }
}

/**
 * 纹理来源说人话。
 *
 * 为什么要在界面上写这一行：没有资源包时渲染**是对的但很平**（每格一块纯色），
 * 用户会以为"渲染坏了"。把来源说出来，"为什么我的石头没有纹理"就不用猜了。
 *
 * `kind` 是协议字段，所以这里用一张固定映射表而不是拼字符串——拼出来的键
 * 绕过了类型检查，写错了只会在运行时看到一个裸键。
 */
const TEXTURE_KINDS: Record<string, Parameters<typeof t>[0]> = {
  minecraft: 'panel.textureKind.minecraft',
  pack: 'panel.textureKind.pack',
  baked: 'panel.textureKind.baked',
  none: 'panel.textureKind.none',
}

function describeTextureSource(info: StudioState['texture']): string {
  const key = TEXTURE_KINDS[info.kind] ?? 'panel.textureKind.baked'
  const base = t(key)
  const detail = info.detail.length > 0 ? ` · ${info.detail.split(/[/\\]/).pop() ?? info.detail}` : ''
  if (info.fellBackFrom === undefined) return base + detail
  const from = TEXTURE_KINDS[info.fellBackFrom] ?? 'panel.textureKind.baked'
  return `${base}${detail}（${t('panel.textureFellBack', { from: t(from) })}）`
}

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
  if (next.running) setStatus(t('chat.thinking'))
  else if (next.budgetStop !== undefined) setStatus(next.budgetStop)
  else if (next.stopReason !== undefined) setStatus(t('chat.turnDone', { reason: next.stopReason }))

  // 滚到底部（正在生成时尤其重要）
  messagesEl.scrollTop = messagesEl.scrollHeight
}

function renderMessage(message: ChatMessageView): HTMLLIElement {
  const li = document.createElement('li')
  li.className = message.gate === true ? `${message.role} gate` : message.role
  li.dataset['messageId'] = String(message.id)

  const who = document.createElement('span')
  who.className = 'who'
  who.textContent =
    message.gate === true
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

  const body = document.createElement('div')
  body.textContent = message.text
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
  renderTemplates()

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

  el('btn-latest').addEventListener('click', () => {
    void guard(t('timeline.latest'), async () => {
      renderPanel(await window.architect.seekLatest())
      await shoot()
    })
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
  el('btn-chat-clear').addEventListener('click', () => {
    void guard(t('chat.clear'), async () => {
      for (const url of imageUrls.values()) URL.revokeObjectURL(url)
      imageUrls.clear()
      renderChat(await window.architect.clearChat())
    })
  })

  // ── 设置 ────────────────────────────────────────────────────────────────────
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
      renderTemplates()
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
