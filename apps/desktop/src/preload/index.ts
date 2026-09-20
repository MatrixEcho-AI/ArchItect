import { contextBridge, ipcRenderer } from 'electron'

import type { ExportFormat } from '../shared/export-formats.js'

/**
 * 渲染进程能看到的全部能力。
 *
 * 刻意做得很窄：渲染进程拿不到 Node、拿不到文件系统、**拿不到 API key**。
 * 所有能力都要经过主进程的具名通道。
 *
 * 密钥相关的通道是**只写不读**的：`saveProvider` 可以带上明文让主进程存进钥匙串，
 * 但没有任何一条通道能把它读回来。
 */
export interface IpcResult<T> {
  ok: boolean
  value?: T
  error?: string
}

async function call<T>(channel: string, ...args: unknown[]): Promise<T> {
  const result = (await ipcRenderer.invoke(channel, ...args)) as IpcResult<T>
  if (!result.ok) throw new Error(result.error ?? `${channel} 失败`)
  return result.value as T
}

export interface StudioBridge {
  state(): Promise<unknown>
  measureText(): Promise<string>
  /** 一条编辑记录的细节（工具参数、改动量、来源）。 */
  opDetail(rev: number): Promise<unknown>
  /** 当前用的纹理来源（用户自己的 Minecraft / 指定资源包 / 平均色兜底）。 */
  textureInfo(): Promise<{ kind: string; detail: string; fellBackFrom?: string }>
  newProject(volume?: unknown): Promise<unknown>
  open(): Promise<unknown | undefined>
  save(path?: string): Promise<string | undefined>
  seek(revision: number): Promise<unknown>
  seekLatest(): Promise<unknown>
  /** 崩溃恢复：打开草稿的基准工程，把没保存的那几步接上去。 */
  applyRecovery(): Promise<unknown>
  /** 崩溃恢复：明确丢掉那份草稿（不恢复，也不再提示）。 */
  discardRecovery(): Promise<unknown>
  /** 撤销：游标退一格 + 重放。**不写日志**，所以时间线与 `.mcai` 往返保持一致。 */
  undo(): Promise<unknown>
  /** 重做：游标进一格。只在撤销之后有意义。 */
  redo(): Promise<unknown>
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
  viewPresets(): Promise<Record<string, { azimuth: number; elevation: number }>>
  /**
   * 把界面上定下的机位交给主进程的会话，让**模型也从这里看**。
   *
   * 传 `null` 复原。和 `set_camera` 工具写的是同一个字段——所以用户和模型
   * 可以共用同一个机位，而不是各看各的。
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
  ): Promise<unknown>
  shoot(request: { view: string; width: number; height: number; highlightLast?: boolean }): Promise<{
    png: Uint8Array
    view: string
    revision: number
  }>
  /**
   * **没有 WebGL 时**用它要一帧：主进程的软件光栅器画完给原始 RGBA。
   *
   * 返回原始像素而不是 PNG，理由和从前一样：拖动时每帧编一次 PNG 再解一次纯属白花。
   */
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
    /** 拖动中：半分辨率 + 不画叠加层。 */
    draft?: boolean
  }): Promise<{
    pixels: Uint8Array
    width: number
    height: number
    revision: number
    scale: number
    target: [number, number, number]
    meshed: boolean
    ms: number
  }>
  /** 屏幕像素 → 世界里的那一格。`null` = 点到天空。 */
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
  /** 人改一格（放置 / 挖掉）。和模型改的走同一条日志与重放。 */
  edit(request: {
    pos: [number, number, number]
    block?: string
    mode: 'place' | 'break'
  }): Promise<unknown>
  /** 调色板搜索：`minecraft-data` 里名字含 `query` 的方块（最多 60 条）。 */
  blocks(query: string): Promise<string[]>
  slice(request: {
    axis: 'x' | 'y' | 'z'
    index: number
    x?: [number, number]
    y?: [number, number]
    z?: [number, number]
  }): Promise<string>
  demo(): Promise<unknown>

  /** 导出成交换格式。省略 suggestedName 时主进程按当前工程名给默认值。 */
  exportModel(format: ExportFormat, suggestedName?: string): Promise<{ paths: string[]; summary: string } | undefined>
  /** 导入外部 schematic（会替换当前工程）。 */
  importModel(): Promise<
    | {
        state: unknown
        summary: string
        unknown: Array<{ name: string; count: number; suggestions: string[] }>
        renamed: Array<{ from: string; to: string; count: number }>
        skipped: number
      }
    | undefined
  >

  // 设置（密钥只写不读）
  settings(): Promise<unknown>
  saveProvider(config: unknown, apiKeyPlain?: string): Promise<unknown>
  removeProvider(id: string): Promise<unknown>
  addProvider(preset: string): Promise<unknown>
  setActive(id: string): Promise<unknown>
  setActiveModel(providerId: string, modelId: string): Promise<unknown>
  setLocale(locale: string): Promise<unknown>
  setUi(patch: unknown): Promise<unknown>
  testConnection(input: unknown): Promise<unknown>

  // 对话
  chat(): Promise<unknown>
  send(text: string, images?: unknown): Promise<unknown>
  stop(): Promise<unknown>
  clearChat(): Promise<unknown>
  chatImage(id: string): Promise<Uint8Array | undefined>
  attachment(id: string): Promise<unknown>
  pickImages(): Promise<unknown>
  grabViewport(request: unknown): Promise<unknown>

  /** 订阅主进程推送（对话进度、世界变化）。返回取消订阅的函数。 */
  subscribe(listener: (event: unknown) => void): () => void

  /** 首次渲染完成后回报主进程——GUI 冒烟测试靠它判定整条链路通了。 */
  ready(report: { ok: boolean; detail: string }): Promise<void>
}

const bridge: StudioBridge = {
  state: () => call('studio:state'),
  measureText: () => call('studio:measureText'),
  opDetail: (rev) => call('studio:opDetail', rev),
  textureInfo: () => call('studio:textureInfo'),
  newProject: (volume) => call('studio:new', volume),
  open: () => call('studio:open'),
  save: (path) => call('studio:save', path),
  seek: (revision) => call('studio:seek', revision),
  seekLatest: () => call('studio:seekLatest'),
  applyRecovery: () => call('studio:applyRecovery'),
  discardRecovery: () => call('studio:discardRecovery'),
  undo: () => call('studio:undo'),
  redo: () => call('studio:redo'),
  shoot: (request) => call('studio:shoot', request),
  scene: () => call('studio:scene'),
  viewPresets: () => call('studio:viewPresets'),
  setCamera: (camera) => call('studio:setCamera', camera),
  viewport: (request) => call('studio:viewport', request),
  slice: (request) => call('studio:slice', request),
  pick: (request) => call('studio:pick', request),
  edit: (request) => call('studio:edit', request),
  blocks: (query) => call('studio:blocks', query),
  demo: () => call('studio:demo'),
  exportModel: (format, suggestedName) => call('studio:export', format, suggestedName),
  importModel: () => call('studio:import'),

  settings: () => call('settings:get'),
  saveProvider: (config, apiKeyPlain) => call('settings:saveProvider', config, apiKeyPlain),
  removeProvider: (id) => call('settings:removeProvider', id),
  addProvider: (preset) => call('settings:addProvider', preset),
  setActive: (id) => call('settings:setActive', id),
  setActiveModel: (providerId, modelId) => call('settings:setActiveModel', providerId, modelId),
  setLocale: (locale) => call('settings:setLocale', locale),
  setUi: (patch) => call('settings:setUi', patch),
  testConnection: (input) => call('settings:test', input),

  chat: () => call('chat:view'),
  send: (text, images) => call('chat:send', text, images),
  stop: () => call('chat:stop'),
  clearChat: () => call('chat:clear'),
  chatImage: (id) => call('chat:image', id),
  attachment: (id) => call('chat:attachment', id),
  pickImages: () => call('chat:pickImages'),
  grabViewport: (request) => call('chat:grabViewport', request),

  subscribe: (listener) => {
    // 包一层：渲染进程永远拿不到 IpcRendererEvent（它带着 sender，能反向拿到底层对象）
    const handler = (_event: unknown, payload: unknown): void => listener(payload)
    ipcRenderer.on('studio:event', handler)
    return () => {
      ipcRenderer.off('studio:event', handler)
    }
  },

  ready: (report) => call('studio:ready', report),
}

contextBridge.exposeInMainWorld('architect', bridge)
