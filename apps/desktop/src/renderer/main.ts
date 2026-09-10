import { initI18n, onLocaleChange, setLocale, t } from '@architect/i18n'
import { eyeFromOrientation, orientationFromEye } from '@architect/render/browser'

import { Viewport } from './viewport.js'
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
  ops: Array<{ rev: number; tool: string; changed: number; ts: string }>
  histogram: Array<{ block: string; count: number; percent: number }>
  /** 一次性提示（崩溃恢复之类）。主进程读过就没了，所以界面要自己留住。 */
  notice?: string
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
  newProject(): Promise<StudioState>
  open(): Promise<StudioState | undefined>
  save(path?: string): Promise<string | undefined>
  seek(revision: number): Promise<StudioState>
  seekLatest(): Promise<StudioState>
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
     * 返回 `null` 表示"这一枪我画不了"（版本对不上、只要纯色路径），主进程会退回
     * 软件光栅器。
     */
    __architectCaptureShot?: (request: CaptureShotRequest) => Promise<string | null>
  }
}

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

// ── 视口：three.js（WebGL） ───────────────────────────────────────────────────
//
// 方块在渲染进程用 WebGL 画（MSAA 抗锯齿、mipmap、60 fps），标尺/坐标轴/文字由
// `viewport.ts` 里那层 2D 画布负责。世界与几何仍然来自主进程——渲染进程不跑
// 体素逻辑，只收一份「带 UV 的三角形 + 图集」（见 `StudioService.scene()`）。
//
// 早先是"每帧走一趟 IPC 拿回 RGBA"，那样既没有抗锯齿、拖动时还得降分辨率。
// 换成 GPU 之后不再需要在画质与帧率之间二选一。
//
// 注意这与模型走的**软件光栅器**不是同一套：那条路要的是可复现（CI 与 golden
// 测试没有 GPU），这条要的是好看。但几何与相机是同一份，所以两边看到的是同一个世界。

let viewport: Viewport | undefined
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

/**
 * 拉一次几何（只在 revision 变化时）。
 *
 * 拖动本身**完全不走 IPC**——这是换成 WebGL 之后最直接的收益。
 */
async function syncScene(): Promise<void> {
  if (current === undefined || viewport === undefined) return
  if (current.revision === sceneRevision) return
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
 * 几何；重拉回来**仍然**对不上，说明世界在请求飞行途中又变了——这时宁可返回 `null`
 * 让主进程退回软件光栅器，也**绝不能**把一张旧图当新图交出去：
 * 让模型拿着过期截图下结论是多轮视觉 agent 最隐蔽的 bug（plan §9.4）。
 */
async function captureShot(request: CaptureShotRequest): Promise<string | null> {
  if (viewport === undefined) return null
  // three.js 这条路只有纹理渲染，没有"平均色快路径"，所以纯色会话直接拒收
  if (!request.textured) return null
  if (sceneRevision !== request.revision) {
    const payload = await window.architect.scene()
    if (payload.revision !== request.revision) return null
    viewport.setRevision(payload.revision)
    viewport.setScene(payload)
    sceneRevision = payload.revision
  }
  return viewport.capture({
    camera: request.camera,
    width: request.width,
    height: request.height,
    overlays: request.overlays,
  })
}

/** 把一帧排到下一个动画帧。 */
function requestFrame(): void {
  if (frameQueued) return
  frameQueued = true
  requestAnimationFrame(() => {
    frameQueued = false
    if (viewport === undefined || current === undefined) return
    if (current.blocks === 0) {
      empty.classList.add('show')
      return
    }
    empty.classList.remove('show')
    viewport.render(camera)
    // 机位面板是相机的**单向镜**：拖动时数字跟着变，但用户正在面板里打字时不覆盖
    syncCameraFields()
    setStatus(
      t('viewport.status', {
        az: camera.azimuth.toFixed(0),
        el: camera.elevation.toFixed(0),
        ms: 'GPU',
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

  surface.addEventListener('pointerdown', (event) => {
    if (event.button !== 0) return
    dragging = true
    dragAt = { x: event.clientX, y: event.clientY }
    surface.setPointerCapture(event.pointerId)
    document.body.classList.add('dragging')
    // 拖过就说明用户要的是自由视角，下拉框不该再说"等轴测 东北"
    viewSelect.value = 'free'
  })

  surface.addEventListener('pointermove', (event) => {
    if (!dragging) return
    const dx = event.clientX - dragAt.x
    const dy = event.clientY - dragAt.y
    dragAt = { x: event.clientX, y: event.clientY }
    if (event.altKey) {
      // Alt + 拖动 = 滚转。不占额外按钮：滚转是偶尔用一次的调节
      camera.roll = (camera.roll + dx * 0.4) % 360
      requestFrame()
      return
    }
    // 往右拖 = 场景往右转；向下拖 = 从上往下看。
    // 灵敏度按视口高度归一：固定 °/px 在窄窗口里会转得太快。
    const unit = 360 / Math.max(320, surface.clientHeight)
    camera.azimuth -= dx * unit
    camera.elevation = clamp(camera.elevation + dy * unit * 0.8, 1, 89)
    requestFrame()
  })

  const endDrag = (event: PointerEvent): void => {
    if (!dragging) return
    dragging = false
    document.body.classList.remove('dragging')
    if (surface.hasPointerCapture(event.pointerId)) surface.releasePointerCapture(event.pointerId)
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
      requestFrame()
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

// ── 左侧面板 ──────────────────────────────────────────────────────────────────

function renderPanel(next: StudioState): void {
  current = next
  // 提示是一次性的（主进程读过就清），所以在这里留住，别让它被下一次状态刷新冲掉
  if (next.notice !== undefined) showNotice(next.notice)

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
  el('project-info').innerHTML = rows
    .map(([key, value]) => `<dt>${escapeHtml(key)}</dt><dd>${escapeHtml(value)}</dd>`)
    .join('')

  el('histogram').innerHTML = next.histogram
    .map(
      (entry) =>
        `<li><span>${escapeHtml(entry.block.replace('minecraft:', ''))}</span>` +
        `<span>${entry.count} · ${entry.percent}%</span></li>`,
    )
    .join('')

  el('ops').innerHTML = next.ops
    .slice()
    .reverse()
    .map(
      (op) =>
        `<li><span class="rev">${op.rev}</span><b>${escapeHtml(op.tool)}</b>` +
        `<span>${op.changed}</span></li>`,
    )
    .join('')

  scrub.max = String(next.totalOps)
  scrub.value = String(next.revision)
  revLabel.textContent = t('timeline.revision', { rev: next.revision, total: next.totalOps })
  const atHead = next.revision === next.totalOps
  el<HTMLButtonElement>('btn-latest').disabled = atHead
  scrub.disabled = next.totalOps === 0
}

/** 可关闭的横幅。**不自动消失**——它说的是"有一份未保存的草稿"，值得用户看第二眼。 */
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
  sendButton.disabled = next.running
  stopButton.classList.toggle('hidden', !next.running)
  chatInput.disabled = next.running

  if (next.blocking.length > 0) {
    blockingEl.classList.remove('hidden')
    blockingEl.innerHTML = `<b>${escapeHtml(t('chat.noProvider'))}</b><ul>${next.blocking
      .map((item) => `<li>${escapeHtml(item)}</li>`)
      .join('')}</ul>`
  } else {
    blockingEl.classList.add('hidden')
    blockingEl.innerHTML = ''
  }

  // 整列重建：消息是几十条量级，diff 不值得（也更不容易出错）
  messagesEl.replaceChildren(...next.messages.map(renderMessage))

  const parts = [
    t('cost.tokens', { in: next.usage.in, out: next.usage.out }),
    `${next.usage.turns} turns · ${next.usage.toolCalls} tools · ${next.usage.screenshots} shots`,
  ]
  usageEl.textContent = parts.join('   ')
  costEl.textContent =
    next.costUsd !== undefined
      ? t('cost.usd', { amount: next.costUsd.toFixed(4) })
      : next.usage.in > 0
        ? t('cost.noPrice')
        : ''
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

function wire(): void {
  viewport = new Viewport(canvas, overlayCanvas)
  wireViewport()
  wireCamera()

  el('btn-new').addEventListener('click', () => {
    void guard(t('menu.new'), async () => {
      renderPanel(await window.architect.newProject())
      await shoot()
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
    // 预设角度必须在第一帧之前拿到，否则首帧用的是写死的默认角度
    await loadPresets()
    renderSettings(initial)
    renderPanel(await window.architect.state())
    renderChat(await window.architect.chat())
    await shoot()
    // `#settings`：抓图/调试时直接把设置面板打开
    if (location.hash === '#settings') settingsDialog.showModal()
    // `#drag-test`：合成一次拖动，让"拖动"这条路径在自动抓图里也能被走到
    if (location.hash === '#drag-test') simulateDrag()
    // `#camera-test`：合成一次机位面板操作 + 共享给模型
    if (location.hash === '#camera-test') await simulateCameraPanel()
    await window.architect.ready({ ok: true, detail: `canvas ${canvas.width}x${canvas.height}` })
  } catch (error) {
    await window.architect.ready({
      ok: false,
      detail: error instanceof Error ? error.message : String(error),
    })
  }
}

void boot()
