/**
 * 渲染进程与主进程之间的**数据形状**，以及渲染进程那一侧的 `window.architect` 契约。
 *
 * 这些形状**不是**渲染进程定义的：唯一真相在主进程（`services/studio.ts`、
 * `services/chat.ts`、`services/settings.ts`）与 `preload/index.ts` 暴露的通道上。
 * 搬到这里只是为了让组件与 hook 都能引用同一份声明，而不是各自抄一遍——
 * 抄一遍的后果是主进程改一个字段名时，只有一半的调用点会编译失败。
 */

// ── 世界与工程状态 ────────────────────────────────────────────────────────────

export interface StudioState {
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
  camera?: SessionCamera
}

/** 会话相机：`set_camera` 工具与机位面板写的是**同一个字段**（人机共用机位）。 */
export interface SessionCamera {
  azimuth?: number
  elevation?: number
  roll?: number
  scale?: number
  eye?: [number, number, number]
  lookAt?: [number, number, number]
}

/** 一条编辑记录的细节（主进程按需给，不跟着每次状态推）。 */
export interface OpDetailView {
  rev: number
  id: string
  tool: string
  args: unknown
  ts: string
  source: string
  actor: string
  result: { changed: number; overwrittenNonAir: number; clipped: number }
}

// ── 对话 ──────────────────────────────────────────────────────────────────────

export interface ChatMessageView {
  id: number
  role: 'user' | 'assistant' | 'tool'
  text: string
  toolName?: string
  toolOk?: boolean
  args?: string
  imageId?: string
  imageRevision?: number
  imageView?: string
  /** 工具调用的**完整返回**（给折叠展开用）。与 `text` 是两份：那是默认显示的一行摘要。 */
  toolResult?: string
  gate?: boolean
  /** 这一轮失败了（请求报错 / 空回复 / 撞上输出上限）。画红，别让用户以为是"没反应"。 */
  failed?: boolean
  /** 这一条正在流式生成：末尾画一个光标，字是**边收边画**的。 */
  streaming?: boolean
  /** 流式期间模型吐出的**思维链正文**。界面上收成一行，点开才展开（见 `chat-panel.tsx`）。 */
  thinking?: string
}

export interface ChatUsageView {
  in: number
  out: number
  cachedIn: number
  turns: number
  toolCalls: number
  screenshots: number
}

export interface ChatView {
  running: boolean
  messages: ChatMessageView[]
  usage: ChatUsageView
  costUsd?: number
  stopReason?: string
  error?: string
  /** 被预算刹住的原因（如果有）。**不是故障**，界面要说清楚。 */
  budgetStop?: string
  ready: boolean
  blocking: string[]
}

// ── 设置 ──────────────────────────────────────────────────────────────────────

export interface ProviderView {
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

export interface SettingsView {
  activeId: string
  providers: ProviderView[]
  budget?: { maxUsd?: number; maxTokensOut?: number; maxTurns?: number }
  locale: 'zh-CN' | 'en-US'
  ui: { view?: string; requireVerification?: boolean }
  secrets: { location: string; encrypted: boolean }
  issues: Array<{ field: string; message: string }>
}

export type ProbeStep =
  | { type: 'models'; count: number; models: string[] }
  | { type: 'model'; model: string; matched?: string; guessed?: boolean }
  | { type: 'text'; ok: boolean; tokensIn?: number; error?: string }
  | { type: 'tools'; mode: string }
  | { type: 'vision'; vision: boolean; imageTokenCost?: number; error?: string }
  | { type: 'capabilities'; capabilities: ProviderView['capabilities'] }
  | { type: 'error'; error: string }

export interface DiscoveryResult {
  ok: boolean
  config: ProviderView
  models: string[]
  steps: ProbeStep[]
  error?: string
}

// ── 主进程推送 ────────────────────────────────────────────────────────────────

export type StudioEvent =
  | { type: 'chat'; view: ChatView }
  | { type: 'settings'; view: SettingsView }
  | { type: 'state'; state: StudioState }

// ── preload 暴露的桥 ──────────────────────────────────────────────────────────

/** 一张给模型看的图：要么是 PNG 的 data URL，要么是**画不了的原因**。 */
export type CaptureAnswer = { dataUrl: string } | { error: string }

/** 主进程发来的离屏截图请求。字段与 `@architect/agent` 的 `ShotInput` 对齐。 */
export interface CaptureShotRequest {
  camera: unknown
  view: string
  revision: number
  width: number
  height: number
  overlays: unknown
  /** three.js 这条路只有纹理渲染，所以 `false` 时直接拒收。 */
  textured: boolean
}

/** three.js 视口拿到的几何与图集。 */
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

/** 软件视口要帧的请求。 */
export interface ViewportRequest {
  azimuth: number
  elevation: number
  roll?: number
  scale?: number
  target?: [number, number, number]
  /** 透视（第一人称）：相机站在 `eye`。不给就是正交等轴测。 */
  perspective?: { eye: [number, number, number]; fov: number }
  width: number
  height: number
  /** 拖动中：半分辨率 + 不画叠加层。 */
  draft?: boolean
}

export interface ViewportFrame {
  pixels: Uint8Array
  width: number
  height: number
  revision: number
  scale: number
  target: [number, number, number]
  meshed: boolean
  ms: number
}

export interface PickResult {
  block: [number, number, number]
  place: [number, number, number]
  normal: [number, number, number]
  blockId: string
  placeInVolume: boolean
}

export interface PickRequest {
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
}

export interface ArchitectBridge {
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
  scene(): Promise<ScenePayload>
  /** 预设机位的角度（唯一真相在主进程的 `VIEW_PRESETS`）。 */
  viewPresets(): Promise<Record<string, { azimuth: number; elevation: number }>>
  /**
   * 机位面板 → 会话相机。传 `null` 复原。
   *
   * 写的是 `set_camera` 工具用的那个字段，所以打开「模型用这个机位」之后，
   * 用户看到的就是模型接下来看到的（人机共用机位）。
   */
  setCamera(camera: SessionCamera | null): Promise<StudioState>
  slice(request: { axis: 'x' | 'y' | 'z'; index: number }): Promise<string>
  /** 屏幕像素 → 世界里的那一格（`null` = 点到天空）。 */
  pick(request: PickRequest): Promise<PickResult | null>
  /** 人改一格。和模型改的走同一条日志、同一套重放。 */
  edit(request: {
    pos: [number, number, number]
    block?: string
    mode: 'place' | 'break'
  }): Promise<StudioState>
  /** 调色板搜索。 */
  blocks(query: string): Promise<string[]>
  /** 没有 WebGL 时用它要帧。有 WebGL 时一次都不会调。 */
  viewport(request: ViewportRequest): Promise<ViewportFrame>
  demo(): Promise<StudioState>
  exportModel(
    format: string,
    suggestedName?: string,
  ): Promise<{ paths: string[]; summary: string } | undefined>
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

  // 设置（密钥只写不读）
  settings(): Promise<SettingsView>
  saveProvider(config: unknown, apiKeyPlain?: string): Promise<SettingsView>
  removeProvider(id: string): Promise<SettingsView>
  addProvider(preset: string): Promise<SettingsView>
  setActive(id: string): Promise<SettingsView>
  setBudget(budget: unknown): Promise<SettingsView>
  setLocale(locale: string): Promise<SettingsView>
  setUi(patch: unknown): Promise<SettingsView>
  testConnection(input: unknown): Promise<DiscoveryResult>

  // 对话
  chat(): Promise<ChatView>
  send(text: string): Promise<ChatView>
  stop(): Promise<ChatView>
  clearChat(): Promise<ChatView>
  chatImage(id: string): Promise<Uint8Array | undefined>

  /** 订阅主进程推送（对话进度、世界变化）。返回取消订阅的函数。 */
  subscribe(listener: (event: StudioEvent) => void): () => void

  /** 首次渲染完成后回报主进程——GUI 冒烟测试靠它判定整条链路通了。 */
  ready(report: { ok: boolean; detail: string }): Promise<void>
}

declare global {
  interface Window {
    architect: ArchitectBridge
    /**
     * **主进程用来要一张给模型看的图**（`webContents.executeJavaScript` 调它）。
     *
     * 之所以挂在 `window` 上而不是走 IPC 通道：方向是主 → 渲染，而 `ipcRenderer.invoke`
     * 只能渲染 → 主。`executeJavaScript` 会 await 这个函数返回的 Promise 并把结果
     * （PNG 的 data URL）带回主进程，一行就够，不需要自己造一套请求/应答 id 表。
     *
     * 画不了时返回**带原因的 `{ error }`**，主进程会记进 `renderFallback` 再退回
     * 软件光栅器——"这台机器有没有 WebGL"只有渲染进程知道。
     */
    __architectCaptureShot?: (request: CaptureShotRequest) => Promise<CaptureAnswer>
  }
}
