import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import { initI18n, resolveLocale, setLocale, t } from '@architect/i18n'
import type { LlmImage, PresetKey, ProviderConfig, ProviderSettings, ShotInput } from '@architect/agent'
import { app, BrowserWindow, dialog as desktopDialog, ipcMain, safeStorage, shell } from 'electron'

import { VIEW_PRESETS } from '@architect/render'
// 内置资源包（真实纹理）。**不走 `@architect/render` 的默认导出**：`minecraft-assets`
// 是 352 MB 的运行时依赖，esbuild 必须把它标成 external，所以只有主进程这个入口
// 该知道怎么引它（见 packages/render/src/assets.ts）。
import { assetsTexturePack } from '@architect/render/assets'

import { AutosaveService } from './services/autosave.js'
import type { StudioEvent, TestConnectionInput } from './services/chat.js'
import type { Cipher } from './services/settings.js'
import { autosaveDirFor, debugFlagNames, isDiagnosticRun } from './services/diagnostics.js'
import { IMAGE_FILE_FILTERS, readPickedImages } from './services/image-input.js'
import { createSecretStore, loadSettings, saveSettings, secretsFile, settingsFile } from './services/settings.js'
import { StudioService } from './services/studio.js'
import type {
  EditBlockRequest,
  ExportFormat,
  PickRequest,
  ShootRequest,
  SliceRequest,
  ViewportRequest,
} from './services/studio.js'

/** 按扩展名（或 `--format` 的值）判断要导成什么。 */
function formatOf(value: string): ExportFormat {
  const lower = value.toLowerCase()
  if (lower === 'litematic' || lower.endsWith('.litematic')) return 'litematic'
  if (lower === 'obj' || lower.endsWith('.obj')) return 'obj'
  return 'schem'
}

const extensionOf = (format: ExportFormat): string => (format === 'schem' ? 'schem' : format)

function filterOf(format: ExportFormat): { name: string; extensions: string[] } {
  if (format === 'litematic') return { name: t('dialog.litematicFilter'), extensions: ['litematic'] }
  if (format === 'obj') return { name: t('dialog.objFilter'), extensions: ['obj'] }
  return { name: t('dialog.schemFilter'), extensions: ['schem'] }
}

/**
 * Electron 主进程。
 *
 * **世界的唯一持有者**：渲染进程通过 IPC 要渲染好的 PNG 和文本，自己不跑体素逻辑。
 * 这样渲染进程不用打包任何 workspace 包进浏览器，也就不需要前端打包器，
 * 更绕开了 `core` 里 `node:crypto` 这类 Node-only 依赖。
 *
 * 这里只做"接线"，所有实际逻辑在 `StudioService` / `ChatController` 里，
 * 那两个类不依赖 Electron、可被 vitest 直接测。
 */

/**
 * 系统钥匙串。
 *
 * `isEncryptionAvailable()` 为假时**拒绝存储**（`createSecretStore` 里的策略），
 * 而不是退回明文——D-13 的红线是"绝不落明文"，不是"尽量加密"。
 */
const keychain: Cipher = {
  available: () => safeStorage.isEncryptionAvailable(),
  encrypt: (plaintext) => safeStorage.encryptString(plaintext),
  decrypt: (ciphertext) => safeStorage.decryptString(ciphertext),
}

let studio: StudioService
/**
 * `studio` 是否已经建好。
 *
 * 用显式标志而不是 `studio === undefined`：后者在类型上永远为假（声明类型不是可空的），
 * 于是"还没初始化"这条真实存在的路径在类型层面被抹掉了。`open-file` 会在 `ready`
 * 之前触发，这个分支是真的会走到的。
 */
let studioReady = false
let settingsLoad: { settings: ProviderSettings; issues: readonly unknown[]; fresh: boolean }
let mainWindow: BrowserWindow | undefined
/**
 * 系统要求打开的 `.mcai`，此时窗口可能还没建好。
 *
 * `open-file`（macOS 双击）**会在 `ready` 之前触发**，所以不能在里面直接开工程——
 * 只能先记下来，等 `whenReady` 之后再消费。argv（Windows/Linux 与命令行启动）
 * 走的是同一条路。
 */
let pendingOpenPath: string | undefined

/** 从命令行参数里挑出 `.mcai` 路径。 */
function projectPathFromArgv(argv: readonly string[]): string | undefined {
  return argv.slice(1).find((arg) => arg.toLowerCase().endsWith('.mcai') && !arg.startsWith('-'))
}

/**
 * 打开一个 `.mcai` 并让界面跟上。
 *
 * 三处入口共用：macOS 双击、Windows/Linux 的 argv、以及第二次启动的
 * `second-instance`。**只写一份**，否则三条路径迟早会走歪。
 */
async function openProjectPath(path: string): Promise<void> {
  const state = await studio.open(path)
  autosave?.retarget('active', state.name, path, state.revision)
  pushEvent({ type: 'state', state })
  mainWindow?.show()
  mainWindow?.focus()
}

/** 消费待打开的路径（窗口建好之后调）。 */
async function consumePendingOpen(): Promise<void> {
  const path = pendingOpenPath
  pendingOpenPath = undefined
  if (path === undefined) return
  try {
    await openProjectPath(path)
  } catch (error) {
    process.stderr.write(`Could not open ${path}: ${error instanceof Error ? error.message : String(error)}\n`)
  }
}
let autosave: AutosaveService | undefined
let autosaveTimer: NodeJS.Timeout | undefined

/** 自动保存的间隔。够密（丢不了几步）又不至于每改一格就写一次盘。 */
const AUTOSAVE_INTERVAL_MS = 5000

function settingsPath(): string {
  return settingsFile(app.getPath('userData'))
}

/** 建好工作台：读设置 → 起 i18n → 接密钥库 → 接事件推送。 */
function initStudio(): void {
  const loaded = loadSettings(settingsPath())
  settingsLoad = loaded
  // `app.getLocale()` 是系统**显示语言**，比 ICU 的默认区域更贴近用户的选择
  initI18n({ locale: loaded.settings.locale ?? resolveLocale(app.getLocale()) })

  const secrets = createSecretStore(secretsFile(app.getPath('userData')), keychain)
  studio = new StudioService({
    chat: { settings: loaded.settings, secrets },
    // 默认纹理 = 内置资源包（用户装完就有真实纹理）。想用自己的材质包/客户端 jar 时，
    // 由 texturepack.ts 里那几种来源接管（CLI 的 --textures，或 ARCHITECT_MINECRAFT_DIR）
    texturePackFor: (version) => assetsTexturePack(version),
  })
  studio.chat.setIssues([...loaded.issues])
  studio.onEvent((event) => pushEvent(event))
  studioReady = true

  // 崩溃恢复：WAL 只记"上次保存之后"的 op，所以文件很小，写盘与工区大小无关
  autosave = new AutosaveService({
    // 诊断跑（--demo / --capture / 各种 *-test）用**独立目录**：它们也会真的编辑世界，
    // 混进用户自己的草稿里就会在下次启动时弹一条"上次有 N 步没保存"——而那是调试垃圾
    dir: autosaveDirFor(app.getPath('userData'), process.argv, new Set(debugFlagNames(process.argv))),
    projectId: 'active',
    name: studio.state().name,
  })
  studio.attachAutosave(autosave)
  // 诊断跑不提示恢复：那个目录里躺的是**上一次调试跑**留下的草稿，
  // 弹出来只会让人以为"应用出问题了"（截图里也会多一条没人关心的横幅）
  if (!isDiagnosticRun(process.argv, new Set(debugFlagNames(process.argv)))) studio.recover()
  autosaveTimer = setInterval(() => {
    try {
      studio.autosaveNow()
    } catch (error) {
      // 写 WAL 失败不该影响用户继续编辑，但必须让人知道
      process.stderr.write(`Autosave failed: ${error instanceof Error ? error.message : String(error)}\n`)
    }
  }, AUTOSAVE_INTERVAL_MS)
  // 定时器不该把进程钉住（关窗时 Node 要能退出）
  autosaveTimer.unref?.()
}

function pushEvent(event: StudioEvent): void {
  if (mainWindow === undefined || mainWindow.isDestroyed()) return
  mainWindow.webContents.send('studio:event', event)
}

/**
 * 渲染进程是否已经回报"首帧画好了"（`studio:ready`）。
 *
 * 在它之前不发截图请求：那时渲染进程手里还没有场景，问也是白问。
 * 主进程的 `--smoke`（无窗口）永远走不到这里，于是自动落到软件光栅器上。
 */
let rendererReady = false

/**
 * 离屏截图的超时。渲染进程正常 10~60 ms 就回来了，这里是**防挂死**，不是性能预算：
 * 渲染进程卡住时宁可退回软件光栅器，也不能让一轮对话停在这里。
 */
const SHOT_TIMEOUT_MS = 8000

/**
 * 把一枪交给渲染进程里的 three.js 画（模型的眼睛）。
 *
 * 方向是**主进程 → 渲染进程**，而 `ipcRenderer.invoke` 只能反过来，所以走
 * `executeJavaScript`：它会 await 页面里那个函数返回的 Promise，把结果
 * （PNG 的 data URL，或者一个 `{ error }`）带回来。省掉了自己造一套请求/应答
 * id 表，也就没有"哪个 id 对应哪个 Promise"这类会泄漏的状态。
 *
 * **拿不到就抛，让会话记下原因并退回软件光栅器**。抛而不是返回 `undefined`
 * 是有意的：渲染进程知道"这台机器没有 WebGL"，主进程不知道。原因会一路带到
 * `renderFallback`，再由 `--gui-smoke` / `--shot` 把原话打出来——
 * **那是诊断路径，不是界面文案**：界面上的"现在用软件视口"由渲染进程自己
 * 按 `viewport.softwareMode` 显示（它才知道自己有没有 WebGL）。
 */
async function captureInRenderer(input: ShotInput): Promise<Uint8Array | undefined> {
  const win = mainWindow
  if (!rendererReady || win === undefined || win.isDestroyed()) {
    throw new Error('The renderer is not ready yet, so the software rasterizer takes this shot')
  }
  let answer: unknown
  try {
    answer = await Promise.race([
      win.webContents.executeJavaScript(`window.__architectCaptureShot?.(${JSON.stringify(input)}) ?? null`),
      new Promise((resolve) => setTimeout(() => resolve('timeout'), SHOT_TIMEOUT_MS)),
    ])
  } catch (error) {
    process.stderr.write(`GPU capture channel failed: ${error instanceof Error ? error.message : String(error)}\n`)
    throw new Error('The capture channel to the renderer is gone, so the software rasterizer takes this shot')
  }
  if (answer === 'timeout') throw new Error(`The renderer did not answer within ${SHOT_TIMEOUT_MS}ms, so the software rasterizer takes this shot`)
  if (typeof answer === 'object' && answer !== null) {
    if ('error' in answer) {
      // 渲染进程明确说了"我画不了"，并给了原因（没有 WebGL、场景版本对不上……）
      throw new Error(String((answer as { error: unknown }).error))
    }
    if ('dataUrl' in answer) {
      const dataUrl = String((answer as { dataUrl: unknown }).dataUrl)
      const comma = dataUrl.indexOf(',')
      if (comma < 0) throw new Error('The renderer did not return a PNG')
      return new Uint8Array(Buffer.from(dataUrl.slice(comma + 1), 'base64'))
    }
  }
  throw new Error('The renderer returned no capture')
}

function persistSettings(): void {
  saveSettings(settingsPath(), studio.chat.settingsValue)
}

/**
 * 渲染进程交上来的附图（base64 data URL）。
 *
 * 走 base64 而不是让渲染进程把 `Uint8Array` 直接递过来：`ipcRenderer.invoke` 的
 * 结构化克隆**确实**支持 typed array，但界面手里的本来就是一张 data URL
 * （缩略图要它），再转一次字节只是白绕。主进程解回来再算内容哈希。
 */
interface ChatImageInput {
  dataUrl: string
  mimeType: string
}

/** data URL → `LlmImage`。去掉 `data:...;base64,` 前缀再解 base64。 */
function toLlmImage(input: ChatImageInput): LlmImage {
  const comma = input.dataUrl.indexOf(',')
  const base64 = comma >= 0 ? input.dataUrl.slice(comma + 1) : input.dataUrl
  return { png: new Uint8Array(Buffer.from(base64, 'base64')), mimeType: input.mimeType }
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1360,
    height: 880,
    minWidth: 960,
    minHeight: 600,
    title: 'ArchItect',
    backgroundColor: '#ffffff',
    show: false,
    webPreferences: {
      preload: join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  })

  mainWindow.once('ready-to-show', () => mainWindow?.show())
  // 模型截图接上渲染进程里的 three.js。**接在这里而不是 `initStudio`**：
  // 工作台先建、窗口后建，接早了那时还没有窗口可问。
  // 渲染进程还没 `ready` 时 `captureInRenderer` 会自己返回 undefined，
  // 会话就退回软件光栅器——所以顺序上早接不会有副作用。
  studio.attachShotBridge({ capture: captureInRenderer })
  // 外部链接走系统浏览器，不在应用内开新窗口
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url)
    return { action: 'deny' }
  })
  /**
   * **普通 `<a href>` 的点击也要拦住。**
   *
   * `setWindowOpenHandler` 只管 `window.open` / `target=_blank`；直接点一个
   * `<a href="https://…">` 会让**这个窗口自己导航过去**。这是个单页应用，
   * 导航走之后没有历史可回——用户看到的是一个白屏的应用，只能重启。
   *
   * 链接现在会出现在对话里（模型写的说明常带文档地址），所以这条从"理论上该有"
   * 变成了"点一下就会遇到"。判据是按 URL 而不是按"是不是我们自己的页面"：
   * 只要不是 `file:` 起的本地页面，一律交给系统浏览器。
   */
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (url.startsWith('file://')) return
    event.preventDefault()
    void shell.openExternal(url)
  })

  // 窗口一渲染好就把系统要求打开的那个工程装进去
  mainWindow.webContents.once('did-finish-load', () => {
    void consumePendingOpen()
  })

  // 诊断开关通过 **hash 列表**传进渲染进程（渲染进程读不到 argv）。
  //
  // 之所以是列表而不是"一个 flag 一个 hash"：这些开关**需要能叠加**——
  // `--no-webgl --drag-test` 验的是"没有 WebGL 时拖动还能不能用"，
  // 而 spread 写法里后一个会把前一个覆盖掉（真机上就吃过这个亏：抓出来的图
  // 看着没拖动过，其实是 drag-test 被 no-webgl 顶掉了）。
  // 开关的**定义**在 diagnostics.ts（一处定义、两处使用：渲染进程读 hash 合成事件，
  // 主进程据此把草稿写到独立目录）
  const debugFlags = debugFlagNames(process.argv)

  void mainWindow.loadFile(join(__dirname, 'renderer', 'index.html'), {
    ...(debugFlags.length > 0 ? { hash: debugFlags.join(',') } : {}),
  })
}

/** 统一的 IPC 包装：把异常转成 `{ ok:false, error }`，不让渲染进程看到裸栈。 */
function handle<T>(channel: string, fn: (...args: never[]) => T | Promise<T>): void {
  ipcMain.handle(channel, async (_event, ...args) => {
    try {
      return { ok: true, value: await fn(...(args as never[])) }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  })
}

function registerIpc(): void {
  handle('studio:state', () => studio.state())
  // 界面拿它显示"当前打开的是哪个文件"；也方便测试断言
  handle('studio:projectPath', () => studio.state().projectPath ?? null)
  handle('studio:measureText', () => studio.measureText())
  // 工具调用检查器点开某一步时用（按需取，不跟着每次 state 推）
  handle('studio:opDetail', (rev: number) => studio.opDetail(rev))
  handle('studio:textureInfo', () => studio.textureInfo())

  handle('studio:new', (volume?: Parameters<StudioService['newProject']>[0]) => {
    const state = studio.newProject(volume)
    // 新工程不该继承上一个工程的草稿
    autosave?.retarget('active', state.name, undefined, state.revision)
    return state
  })

  handle('studio:open', async () => {
    const result = await desktopDialog.showOpenDialog({
      title: t('dialog.openProject'),
      filters: [{ name: t('dialog.projectFilter'), extensions: ['mcai'] }],
      properties: ['openFile'],
    })
    if (result.canceled || result.filePaths.length === 0) return undefined
    const path = result.filePaths[0]!
    const state = await studio.open(path)
    // 换了工程就换一卷 WAL：旧草稿属于旧工程，混在一起会恢复出莫名其妙的东西
    autosave?.retarget('active', state.name, path, state.revision)
    return state
  })

  handle('studio:save', async (path?: string) => {
    let target = path
    if (target === undefined) {
      const result = await desktopDialog.showSaveDialog({
        title: t('dialog.saveProject'),
        defaultPath: `${studio.state().name}.mcai`,
        filters: [{ name: t('dialog.projectFilter'), extensions: ['mcai'] }],
      })
      if (result.canceled || result.filePath === undefined) return undefined
      target = result.filePath
    }
    return studio.save(target)
  })

  // 崩溃恢复的两个动作。**必须有能点的地方**：以前这里只有一句提示，
  // 说"打开那个工程即可在此基础上继续"——而那句话在代码里根本做不到。
  handle('studio:applyRecovery', async () => {
    const state = await studio.applyRecovery()
    // 恢复等于换了一个工程（打开基准 + 重放），WAL 跟着换到新基准上
    autosave?.retarget('active', state.name, state.projectPath, state.revision)
    return state
  })

  handle('studio:discardRecovery', () => studio.discardRecovery())

  // 导出到交换格式（M7）。文件对话框 + 写盘在主进程，字节在 StudioService 里算。
  handle('studio:export', async (format: string, suggestedName?: string) => {
    const kind = formatOf(format)
    const result = desktopDialog.showSaveDialogSync({
      title: t('dialog.exportTitle'),
      defaultPath: suggestedName ?? `${studio.state().name}.${extensionOf(kind)}`,
      filters: [filterOf(kind)],
    })
    const target = result ?? undefined
    if (target === undefined) return undefined
    const chosen = formatOf(target)
    const exported = studio.exportModel(chosen, target)
    await Promise.all(exported.files.map((file) => writeFile(file.name, file.bytes)))
    return { paths: exported.files.map((file) => file.name), summary: exported.summary }
  })

  handle('studio:import', async () => {
    const picked = desktopDialog.showOpenDialogSync({
      title: t('dialog.importTitle'),
      filters: [{ name: t('dialog.schematicFilter'), extensions: ['schem', 'schematic', 'litematic'] }],
      properties: ['openFile'],
    })
    const path = picked?.[0]
    if (path === undefined) return undefined
    return studio.importModel(path)
  })

  // 预设机位的角度：`VIEW_PRESETS` 是唯一真相，渲染进程不抄一份（抄了就会漂移）
  handle('studio:viewPresets', () => VIEW_PRESETS)

  // 没有 WebGL 时渲染进程用它要帧：主进程的软件光栅器画完直接给 RGBA。
  // 这条通道**同时是那条路的唯一入口**，所以它必须和 `studio:scene` 一样能拿到
  // 最新的世界——`studio.viewport()` 内部按 revision 缓存网格。
  handle('studio:viewport', (request: ViewportRequest) => {
    const frame = studio.viewport(request)
    return { ...frame, pixels: Buffer.from(frame.pixels) }
  })

  handle('studio:demo', () => studio.demo())
  handle('studio:seek', (revision: number) => studio.seek(revision))
  handle('studio:seekLatest', () => studio.seekLatest())
  // 撤销/重做是**游标移动**（plan §6），不是"打一个反向补丁"——所以它和 seek 是同一族操作
  handle('studio:undo', () => studio.undo())
  handle('studio:redo', () => studio.redo())
  // 界面上的机位面板：把用户定的机位交给会话，让模型从同一个位置看（D-52）。
  // `null` = 复原。这是**人在环路里唯一一条直接的相机通路**——其余全归模型。
  handle('studio:setCamera', (camera: Parameters<StudioService['setCamera']>[0]) => studio.setCamera(camera))

  // 截图：返回 PNG 字节（IPC 用结构化克隆传 Buffer 没问题）
  handle('studio:shoot', async (request: ShootRequest) => {
    const { png, view, revision } = await studio.shoot(request)
    return { png: Buffer.from(png), view, revision }
  })

  // three.js 视口的几何与图集（一次性；网格按 revision 缓存）
  handle('studio:scene', () => studio.scene())

  handle('studio:slice', (request: SliceRequest) => studio.slice(request))

  // ── 人手接管（点哪儿改哪儿） ────────────────────────────────────────────────
  // 拾取与编辑都走主进程：那里才有世界与网格，而且**软件视口也要能用**
  // （没有 WebGL 时渲染进程根本没有 three 场景可以 raycast）。
  handle('studio:pick', (request: PickRequest) => studio.pick(request) ?? null)
  handle('studio:edit', (request: EditBlockRequest) => studio.editBlock(request))
  handle('studio:blocks', (query: string) => studio.blocks(query))

  // ── 设置 ────────────────────────────────────────────────────────────────────
  handle('settings:get', () => studio.settingsView())
  handle('settings:saveProvider', (config: ProviderConfig, apiKeyPlain?: string) => {
    const view = studio.chat.saveProvider(config, apiKeyPlain)
    persistSettings()
    return view
  })
  handle('settings:removeProvider', (id: string) => {
    const view = studio.chat.removeProvider(id)
    persistSettings()
    return view
  })
  handle('settings:addProvider', (preset: PresetKey) => {
    const view = studio.chat.addProvider(preset)
    persistSettings()
    return view
  })
  handle('settings:setActive', (id: string) => {
    const view = studio.chat.setActive(id)
    persistSettings()
    return view
  })
  handle('settings:setLocale', (locale: 'zh-CN' | 'en-US') => {
    const view = studio.chat.setLocale(locale)
    setLocale(locale)
    persistSettings()
    return view
  })
  handle('settings:setUi', (patch: { view?: string; requireVerification?: boolean }) => {
    const view = studio.chat.setUi(patch)
    persistSettings()
    return view
  })
  // 探针会把**量出来的能力**写回配置（见 ChatController.testConnection），所以这里
  // 必须落盘：不然重启之后 `vision` 又回落到预设的 false，图再次被静默丢掉。
  handle('settings:test', async (input: TestConnectionInput) => {
    const result = await studio.testConnection(input)
    persistSettings()
    return result
  })

  // ── 对话 ────────────────────────────────────────────────────────────────────
  handle('chat:view', () => studio.chatView())
  handle('chat:send', (text: string, images: ChatImageInput[] | undefined) =>
    studio.send(text, images?.map(toLlmImage)),
  )
  handle('chat:stop', () => studio.stop())
  handle('chat:clear', () => studio.clearChat())
  handle('chat:image', (id: string) => {
    const png = studio.chatImage(id)
    return png === undefined ? undefined : Buffer.from(png)
  })
  // 用户附图的字节（历史消息里那些缩略图）。与 `chat:image` 分开：那是截图表，
  // 这里是不参与 `retainHistory` 剪枝的附图（见 `ChatController.attachments`）。
  handle('chat:attachment', (id: string) => {
    const image = studio.chatAttachment(id)
    if (image === undefined) return undefined
    return { png: Buffer.from(image.png), mimeType: image.mimeType }
  })

  // ── 插图（两个入口：选文件 / 采集视口） ───────────────────────────────────────
  /**
   * 打开系统文件选择框，把选中的图片读成可用作插图的数据。
   *
   * **取消不是错误**：返回空数组，界面什么都不做。返回 `canceled` 让调用方能区分
   * "用户点了取消"与"一个文件都没选上"（后者要报错）。
   */
  handle('chat:pickImages', async () => {
    const win = mainWindow
    if (win === undefined || win.isDestroyed()) return { images: [], rejected: [], canceled: true }
    const picked = await desktopDialog.showOpenDialog(win, {
      title: t('image.pickTitle'),
      buttonLabel: t('image.pickButton'),
      properties: ['openFile', 'multiSelections'],
      filters: IMAGE_FILE_FILTERS,
    })
    if (picked.canceled || picked.filePaths.length === 0) {
      return { images: [], rejected: [], canceled: true }
    }
    return { ...(await readPickedImages(picked.filePaths)), canceled: false }
  })

  /**
   * **采集当前视口**：渲染进程把它此刻的相机发过来，主进程按那个机位出一张图。
   *
   * 相机从渲染进程来（它才知道用户拖到了哪儿），渲染从主进程走（复用 `screenshot`
   * 工具那条链：GPU 优先、拿不到回落软件光栅器）。返回 PNG 字节，界面存下来当附图。
   */
  handle('chat:grabViewport', async (request: { camera: unknown; view: string; width: number; height: number }) => {
    const shot = await studio.grabViewport({
      camera: request.camera as never,
      view: request.view,
      width: request.width,
      height: request.height,
    })
    // 存进附图表的**同时**把它算成 id 交给界面：界面拿 id 画缩略图（走 chat:attachment），
    // 而发送时用的也是这个 id，所以"采到的就是发出去的那张"。
    const id = studio.storeChatAttachment({ png: shot.png, mimeType: 'image/png' })
    return { id, view: shot.view, revision: shot.revision, bytes: shot.png.length }
  })

  // 渲染进程的"首次渲染完成"回报。GUI 冒烟测试等它。
  ipcMain.handle('studio:ready', (_event, report: { ok: boolean; detail: string }) => {
    process.stdout.write(`[renderer] ${report.ok ? 'READY' : 'FAILED'}: ${report.detail}\n`)
    // 从这一刻起才允许把截图请求发给渲染进程
    rendererReady = report.ok
    if (guiSmoke) {
      void (async () => {
        const result = await assertGpuShot(report)
        process.stdout.write(`[gui-smoke] ${result.ok ? 'OK' : 'FAILED'}: ${result.detail}\n`)
        // 渲染进程里那些**只有 DOM 能回答**的问题：时间线拖得动吗、编辑记录点得开吗、
        // 模板填得进输入框吗。以前这些全靠人肉看，现在一条条断言出来。
        const shooter = mainWindow
        // **注入脚本里的异常要看得见。** 不接这一层的话，渲染进程里任何一处抛出都只会
        // 变成主进程这边一句"渲染进程没有回报"+ 整条冒烟超时，而真正的原因（哪一行）
        // 一个字都看不到。这个坑踩过一次：为了找一行 `undefined` 花了四轮。
        const checks =
          shooter === undefined || shooter.isDestroyed()
            ? []
            : await assertGuiPanels(shooter).catch((error: unknown): GuiCheck[] => [
                {
                  name: 'gui-panels-crashed',
                  ok: false,
                  detail: error instanceof Error ? error.message : String(error),
                },
              ])
        let failed = !result.ok
        for (const check of checks) {
          process.stdout.write(`[gui-smoke] ${check.ok ? '✓' : '✗'} ${check.name}: ${check.detail}\n`)
          if (!check.ok) failed = true
        }
        setTimeout(() => app.exit(failed ? 1 : 0), 50)
      })()
    }
    // `--shot <png>`：把**模型看到的那张图**原样写下来再退出。
    // 抓窗口得到的是用户的视口，这个得到的才是模型的眼睛——两者的差别
    // （叠加层、尺寸、是否 GPU）只有落在文件上才比得出来。
    if (shotPath !== undefined) {
      void assertGpuShot(report)
        .then(async (result) => {
          process.stdout.write(`[shot] ${result.ok ? 'OK' : 'FAILED'}: ${result.detail}\n`)
          if (result.png === undefined) {
            app.exit(1)
            return
          }
          // 路径是调用方给的，父目录可能还不存在——`writeFile` 自己不会建。
          await mkdir(dirname(shotPath), { recursive: true })
          await writeFile(shotPath, result.png)
          process.stdout.write(`wrote the model-view screenshot → ${shotPath}\n`)
          app.exit(result.ok ? 0 : 1)
        })
        .catch((error: unknown) => {
          // 这一条以前没有 catch：写盘失败会变成未处理的 rejection，
          // 而退出码也不是 1（`--capture` 那条一直有 catch，两条不一致）
          process.stderr.write(`screenshot write failed: ${String(error)}\n`)
          app.exit(1)
        })
    }
    if (capturePath !== undefined) {
      // 等一下让首帧真的画上，然后抓窗口
      setTimeout(() => {
        void mainWindow?.webContents
          .capturePage()
          .then(async (image) => {
            await mkdir(dirname(capturePath), { recursive: true })
            return writeFile(capturePath, image.toPNG())
          })
          .then(() => {
            process.stdout.write(`captured the window → ${capturePath}\n`)
            app.exit(0)
          })
          .catch((error: unknown) => {
            process.stderr.write(`capture failed: ${String(error)}\n`)
            app.exit(1)
          })
        /**
         * 等界面真的画上再抓。
         *
         * 原来是 900ms，不够：`ready` 只是"渲染进程报了到"，此后 React 还要提交首次
         * 渲染、antd 的 CSS-in-JS 还要注入样式、字体还要回流。抓早了会抓到一张
         * **半成品**——实测表现为"对话卡片的边框与底色都没上"，看起来像样式写错了，
         * 而其实是抓图时机的问题。这类假象特别费时间，所以宁可多等。
         */
      }, 2000)
    }
    return { ok: true, value: undefined }
  })
}

/** 一条 DOM 断言的结论。 */
interface GuiCheck {
  name: string
  ok: boolean
  detail: string
}

/**
 * **渲染进程里那些只有 DOM 能回答的问题**。
 *
 * 这一层以前是空的：`pnpm test` 里 0 个 electron 引用，时间线、编辑记录、模板
 * 全靠人肉点一遍。而它们恰好是 M5 的验收条目（"拖动时间线能看到历史状态"）。
 *
 * 做法是在页面里跑一小段脚本并**真的派发事件**（点、拖），而不是读内部状态——
 * 读状态只能证明"数据对"，证明不了"用户点得动"。断言失败时把实际文本带回来，
 * 免得只看到一句"失败了"。
 */
async function assertGuiPanels(target: BrowserWindow): Promise<GuiCheck[]> {
  const script = `(async () => {
    const results = [];
    const check = (name, ok, detail) => results.push({ name, ok: Boolean(ok), detail: String(detail ?? '') });
    // 拖时间线会走 rAF 合流，所以要等两帧再读结果
    const frames = () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    // 点击之后要走「IPC 往返 → seek → 重画」好几步，等固定帧数会飘。这里轮询等条件成立。
    const waitFor = async (predicate, timeoutMs = 1500) => {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if (predicate()) return true;
        await frames();
      }
      return false;
    };
    /**
     * **把值写进一个 React 管的输入框。**
     *
     * ⚠️ 整段脚本是 TS 模板字符串：**注释里不能出现反引号**（会把字符串提前闭合，
     * 症状是 tsc 报 "',' expected"）。
     *
     * 不能直接给 node.value 赋值：React 在节点上挂了一个 value tracker，直接赋值会把
     * tracker 一起写脏，于是它判定"值没变"并**丢掉**随后的 input 事件，onChange 不触发。
     * （真机症状：滑杆写成了 3，但界面上的 rev 标签一动不动，值还被 effect 同步回 8。）
     *
     * 走原型上的原生 setter、再把 tracker 抹掉，React 才会认为这是一次真实变化。
     * 这是自动化里驱动受控组件的标准做法；真用户拖动不受影响（那是元素自身的值变化）。
     */
    const setNativeValue = (node, value) => {
      const proto = node instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : node instanceof HTMLSelectElement
          ? HTMLSelectElement.prototype
          : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
      if (setter) setter.call(node, value);
      else node.value = value;
      if (node._valueTracker) node._valueTracker.setValue(undefined);
    };

    const ops = document.querySelectorAll('#ops li.op');
    check('ops-list', ops.length > 0, ops.length + ' clickable edit records');

    const label = document.querySelector('#rev-label');
    const scrub = document.querySelector('#scrub');
    const before = label ? label.textContent : '';
    // 时间线在旧标记里是原生 range，换 React 之后若滑杆被换成受控组件、或 id 落到
    // 别处去了，这里会读到 undefined / NaN。把"它到底是什么"写进断言消息，
    // 比只报一句"没拖动"省一整轮排查。
    const shape =
      scrub === null
        ? 'no #scrub'
        : scrub.tagName.toLowerCase() + ' max=' + scrub.max + ' disabled=' + String(scrub.disabled);
    const target = Math.max(0, Math.min(Number(scrub === null ? 0 : scrub.max) - 1, 3));
    if (scrub !== null) {
      setNativeValue(scrub, String(target));
      scrub.dispatchEvent(new Event('input', { bubbles: true }));
    }
    /**
     * **轮询等结果，不等固定帧数。**
     *
     * 拖时间线是一条异步链：input 事件 → requestAnimationFrame 合流 → IPC seek →
     * 主进程重放 → 推回新状态 → React 重渲染。等两帧在空闲机器上够，但在首屏还在
     * 解码截图（--demo 现在载入的是带一张图的示例工程）时就不够——实测偶发红。
     * 这个脚本里已经有 waitFor，用它才是对的写法。
     */
    const labelChanged = await waitFor(
      () => label !== null && label.textContent !== before && label.textContent.includes(String(target)),
    );
    check(
      'timeline-drag',
      labelChanged,
      '"' + before + '" → "' + (label ? label.textContent : '?') + '" (dragged to rev ' + target +
        '; read back ' + shape + ')',
    );

    /**
     * **对话栏的拖拽条在**，而且真能改宽度。
     *
     * 合成一次 pointerdown/pointermove/pointerup 走完整的拖动路径：这条不需要任何
     * 原生对话框，所以是能诚实测的。判据是 Sider 的宽度真的变了——只断言
     * "元素在"的话，把 onPointerDown 删掉它照样绿。
     *
     * ⚠️ **必须 waitFor 轮询，不能派发完立刻读**：React 的状态更新是异步的，
     * 派发完那一刻 DOM 上还是旧宽度（实测读到的仍是 330，而 Sider 的 inline style
     * 已经是 420 了）。这与"拖动没生效"长得一模一样，只是差一帧。
     */
    const resizer = document.querySelector('#chat-resizer');
    const sider = resizer === null ? null : resizer.closest('.ant-layout-sider');
    // ⚠️ 这里**不能写 TS 类型标注**：整段脚本是拼成字符串发给渲染进程当普通 JS 跑的，
    // 一个 ": number" 就会让 executeJavaScript 直接解析失败，而报出来的只有一句
    // "Script failed to execute" —— 找这个花了四轮。这段里的每一行都必须是合法 JS。
    const siderWidth = () => (sider === null ? 0 : Math.round(sider.getBoundingClientRect().width));
    const widthBefore = siderWidth();
    if (resizer !== null) {
      const startX = resizer.getBoundingClientRect().left + 2;
      resizer.dispatchEvent(new PointerEvent('pointerdown', { clientX: startX, bubbles: true }));
      window.dispatchEvent(new PointerEvent('pointermove', { clientX: startX - 90, bubbles: true }));
      window.dispatchEvent(new PointerEvent('pointerup', { clientX: startX - 90, bubbles: true }));
    }
    const grew = await waitFor(() => siderWidth() > widthBefore + 60, 1000);
    check(
      'chat-resizer',
      resizer !== null && grew,
      resizer === null ? 'no #chat-resizer' : 'width ' + widthBefore + ' → ' + siderWidth() + ' (dragged 90px left)',
    );

    const items = document.querySelectorAll('#ops li.op');
    if (items.length > 1) items[1].click();
    // ⚠️ **查询必须在轮询的判据里，不能在点击之前先查一次。**
    //
    // 这里原来是查一次 #op-detail 存进变量、然后拿那个变量去轮询。
    // 在旧标记时代成立（元素一开始就在 index.html 里，点击前就查得到），
    // 但点开一条编辑记录是**异步 + 条件渲染**的：点下去那一刻元素还不存在，
    // 于是那个变量永远是 null，轮询多少次都没用，断言必然红。
    // 这正是"断言跟着 DOM 契约一起搬"时最容易漏的一类。
    // （注意这段脚本整个是 TS 模板字符串：注释里不能出现反引号。）
    let detailChars = 0;
    const detailReady = await waitFor(() => {
      const node = document.querySelector('#op-detail');
      if (node === null || node.classList.contains('hidden')) return false;
      const text = node.textContent.replace(/\\s+/g, ' ').trim();
      if (text.length === 0) return false;
      detailChars = text.length;
      return true;
    });
    check(
      'op-detail',
      detailReady,
      detailReady ? 'expanded to ' + detailChars + ' chars' : 'waited 1.5s and never found #op-detail (or it was empty)',
    );

    // 需求模板行已按要求删除（M8 里"模板填得进输入框"那条随之作废）：
    // 这里退一步，只断言输入框还在接线上
    const input = document.querySelector('#chat-input');
    check('chat-input', input !== null, input === null ? 'no #chat-input' : 'input present');

    /**
     * **输入区是一个盒子：发送钮和两个插图入口都在它里面**（用户拿 DeepSeek harness
     * 的输入框对照过来的要求）。以前发送是框外一行里带文字的按钮。
     *
     * 判据用**几何包含**而不是"DOM 里是不是兄弟节点"：#btn-send 是 .composer
     * 的后代这件事，看一眼 JSX 就知道；真正会坏的是**视觉上掉出去**——盒子加了
     * 内边距、那一行换行了、或者按钮被 margin 顶到框外，这时代码结构一切正常
     * 而界面上按钮又回到了框外。所以量矩形。
     *
     * #chat-input 的 resize 必须是 none："不可人工调节"在 CSS 层只有这一个开关
     * （antd 的 autoSize 已经不画拖拽角了，所以这条守的是回归）。
     */
    /**
     * **输入框真的会自己长高。**
     *
     * 单独一条断言，因为 autoSize 是那种"看着配了、其实没生效"的东西：它靠 antd
     * 量一次 scrollHeight 再写高度，任何一个环节断了都只表现为"高度不变"，而
     * 界面上那一栏还是原样——没有任何报错。所以这里**真往里打字再量**。
     *
     * 写成 React 认的那种输入：textarea.value = x 不会触发 React 的 onChange
     * （它有自己的值跟踪），必须走原型上的 setter 再补一个 input 事件。
     * 测完清空恢复，免得影响后面几条断言。
     */
    let grewBy = NaN;
    if (input !== null) {
      const before = input.getBoundingClientRect().height;
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLTextAreaElement.prototype,
        'value',
      ).set;
      setter.call(input, ('x' + String.fromCharCode(10)).repeat(12));
      input.dispatchEvent(new Event('input', { bubbles: true }));
      await frames();
      grewBy = Math.round((input.getBoundingClientRect().height - before) * 10) / 10;
      setter.call(input, '');
      input.dispatchEvent(new Event('input', { bubbles: true }));
      await frames();
    }
    const maxHeight = input === null ? NaN : parseFloat(getComputedStyle(input).maxHeight);
    check(
      'composer-autogrow',
      Number.isFinite(grewBy) &&
        grewBy > 0 &&
        Number.isFinite(maxHeight) &&
        input !== null &&
        input.getBoundingClientRect().height <= maxHeight,
      Number.isFinite(grewBy)
        ? 'grew ' + grewBy + 'px after 12 lines / max ' + (Number.isFinite(maxHeight) ? maxHeight + 'px' : 'unreadable')
        : 'could not read the input box',
    );

    const composer = document.querySelector('.composer');
    const sendBtn = document.querySelector('#btn-send');
    const inside =
      composer !== null && sendBtn !== null
        ? (() => {
            const box = composer.getBoundingClientRect();
            const btn = sendBtn.getBoundingClientRect();
            return (
              btn.left >= box.left && btn.right <= box.right && btn.top >= box.top && btn.bottom <= box.bottom
            );
          })()
        : false;
    check(
      'composer-holds-controls',
      inside &&
        input !== null &&
        getComputedStyle(input).resize === 'none' &&
        sendBtn !== null &&
        sendBtn.textContent === '' &&
        sendBtn.querySelector('svg') !== null,
      composer === null
        ? 'no .composer'
        : sendBtn === null
          ? 'no #btn-send'
          : 'box ' + Math.round(composer.getBoundingClientRect().width) + 'px wide / send button inside=' + inside +
            ' / button ' + Math.round(sendBtn.getBoundingClientRect().width) + 'px round=' + (getComputedStyle(sendBtn).borderRadius === '50%') +
            ' / text="' + sendBtn.textContent + '" icon=' + (sendBtn.querySelector('svg') !== null) +
            ' / input resize=' + (input === null ? 'n/a' : getComputedStyle(input).resize),
    );

    /**
     * **插图的两个入口。**
     *
     * 三条断言：在、带 aria-label、待发区那个容器在。
     *
     * **可用性不硬断言**：这两个按钮在"正在生成"与"停在历史版本"时是禁用的（locked），
     * 而冒烟跑到这里时这两件事**都成立**：demo 那一轮可能还在飞，而这个脚本自己刚刚
     * 把时间线拖到 rev 3（timeline-drag 那一条），世界停在 rev 7 —— 于是
     * state.behindTip 为真。第一版硬断言 disabled===false，等于拿两个与本次改动
     * 无关的状态判了红。所以这里读一次真实状态，只在**本该可用**时要求它可用。
     *
     * 也**不点它们**：文件选择框是原生对话框，点下去会把冒烟测试挂在那儿等人
     * （CI 里就是永久卡住）。真实行为由 chat.test.ts 与 image-input.test.ts 覆盖。
     *
     * #pending-images 必须**存在**（没图时带 hidden）：那是"图进没进待发区"唯一能读的证据。
     */
    const attach = document.querySelector('#btn-attach-image');
    const grab = document.querySelector('#btn-grab-viewport');
    const pending = document.querySelector('#pending-images');
    const chatView = await window.architect.chat();
    const studioState = await window.architect.state();
    const busy = chatView.running === true;
    const behind = studioState.behindTip === true;
    check(
      'attach-buttons',
      attach !== null &&
        grab !== null &&
        pending !== null &&
        attach.getAttribute('aria-label') !== null &&
        grab.getAttribute('aria-label') !== null &&
        (busy || behind || (attach.disabled === false && grab.disabled === false)),
      'insert image=' + (attach === null ? 'missing' : 'present') +
        ' / capture viewport=' + (grab === null ? 'missing' : 'present') +
        ' / pending area=' + (pending === null ? 'missing' : 'present') +
        ' / ' +
        (busy
          ? 'generating (disabled by design)'
          : behind
            ? 'on a historical revision (disabled by design)'
            : attach.disabled === false
              ? 'idle and enabled'
              : 'idle but disabled'),
    );

    /**
     * **粘贴的接线还在。**
     *
     * 只断言输入框带着那个标记，不验行为——原因见上面那段的注释：合成 paste 事件
     * 会把渲染进程弄崩，一个把自己弄红的测试比没有测试更糟。
     */
    check(
      'paste-bound',
      input !== null && input.getAttribute('data-paste-bound') === '1',
      input === null
        ? 'no #chat-input'
        : (input.getAttribute('data-paste-bound') === '1' ? 'bound on the input box' : 'marker lost'),
    );

    // 恢复条：**有草稿才显示**。这里不能硬断言"一定是隐藏的"——
    // 上一次跑留下的草稿本来就该让这个条亮着；要断言的是"显示与否跟状态一致"。
    const state = await window.architect.state();
    const recovery = document.querySelector('#recovery');
    const shown = recovery !== null && !recovery.classList.contains('hidden');
    const hasDraft = state.recovery !== undefined;
    check(
      'recovery-banner',
      recovery !== null && shown === hasDraft,
      (hasDraft ? state.recovery.ops + ' draft step(s)' : 'no draft') + ', bar ' + (shown ? 'shown' : 'hidden'),
    );
    if (hasDraft) {
      const apply = document.querySelector('#btn-recover');
      const discard = document.querySelector('#btn-discard-recovery');
      check(
        'recovery-buttons',
        apply !== null && discard !== null && apply.disabled === !state.recovery.baseExists,
        'recover ' + (apply.disabled ? 'disabled' : 'enabled') + ' / discard present=' + (discard !== null),
      );
    }

    /**
     * **卡片配色真的生效了吗。**
     *
     * 这一条拦的是一类**静默失效**：styles.css 里那些 var(--ant-color-*-bg) 全部来自
     * antd 的 CSS 变量模式，而**变量不存在时 CSS 不报错**——它只是回落到继承值，
     * 于是"卡片按角色着色"变成"所有卡片一个色"，从截图上看只像配色不好看，
     * 看不出是配置错了。单元测试也拦不住：jsdom 不算样式。
     *
     * 所以判据放在真页面里：读一张真卡片的计算背景色，必须与**页面背景**不同。
     *
     * （注意这段脚本整个是 TS 模板字符串：上面注释里不能出现反引号。）
     */
    const bodies = document.querySelectorAll('#messages li.msg');
    if (bodies.length > 0) {
      const card = getComputedStyle(bodies[0]);
      const cardBg = card.backgroundColor;
      // 判据：卡片底色**必须真的被画出来**（不是透明的）。透明就说明那些
      // var(--ant-color-*-bg) 没解析出来——见 theme.ts 里 cssVar 那段注释。
      check(
        'card-colors',
        cardBg !== '' && cardBg !== 'rgba(0, 0, 0, 0)' && cardBg !== 'transparent',
        'card background ' + cardBg + ' / left border ' + card.borderLeftColor,
      );
    }

    // 成本读数按要求从界面上隐藏了（#cost 带 hidden，见 index.html），
    // 元素与写入点都还在——这里断言的是"接线没被拆掉"，一条 class 就能改回可见
    const cost = document.querySelector('#cost');
    check('cost-element', cost !== null, cost === null ? 'no #cost' : 'text "' + cost.textContent + '"');

    /**
     * **标题行那串读数里的币种必须与当前价格表一致**（用户报的："我改了货币，
     * 右上角还是 USD"）。
     *
     * 只读不改：拿设置里当前 provider 的价格表币种，去比 #chat-usage 里那串字。
     * 价格表没配的 provider（表盘只显示 token 数）直接放行——那时候没有币种可对。
     *
     * 它**拦不住"改完设置、读数没刷新"那一类**（那是事件推送的问题，启动时读数总是
     * 新算的），那条由 chat.test.ts 的"每个设置改动推两条"钉住。
     */
    const liveForCost = await window.architect.settings();
    const activeForCost = liveForCost.providers.find((p) => p.id === liveForCost.activeId);
    const tableForCost =
      activeForCost === undefined
        ? undefined
        : (activeForCost.costs?.[activeForCost.model] ?? activeForCost.cost);
    const wantCurrency = tableForCost === undefined ? undefined : (tableForCost.currency ?? 'USD');
    const usageLine = document.querySelector('#chat-usage');
    check(
      'cost-currency-matches-table',
      wantCurrency === undefined ||
        (usageLine !== null && (usageLine.textContent ?? '').includes(wantCurrency)),
      wantCurrency === undefined
        ? 'the active provider has no price table (the meter reports tokens only)'
        : 'price currency ' + wantCurrency + ' / reading "' + (usageLine === null ? '' : usageLine.textContent) + '"',
    );

    /**
     * **对话标题必须是一行**（用户报的："你看看这个顶部你不觉得丑吗"）。
     *
     * 判据是量出来的高度，不是"看起来对不对"：那一行里标题和右边那串用量读数抢宽度，
     * 读数更长，而标题原来没有 flex: none——于是它被压到比"对话"两个字还窄，
     * 两个字各占一行，标题变成一竖条。这种布局事故截图上很显眼，但它既不会报错，
     * 也不会让任何数据变错，所以只有量高度才拦得住。
     *
     * 阈值来自真机实测（960 与 1360 两种窗宽、用户那串长读数）：
     * 一行 h=19（antd 的行高），两行 h=39。取 28 是两者中间。
     *
     * ⚠️ 别改用 getClientRects().length 判行数：块级元素换行之后**仍然只返回 1 个
     * rect**（实测两行时也是 1），那样写会得到一个永远为真的断言。
     * （这段脚本整个是 TS 模板字符串：注释里不能出现反引号。）
     */
    const chatTitle = document.querySelector('.chat-head h2');
    const titleHeight = chatTitle === null ? 0 : chatTitle.getBoundingClientRect().height;
    check(
      'chat-head-one-line',
      chatTitle !== null && titleHeight > 0 && titleHeight < 28,
      chatTitle === null
        ? 'no .chat-head h2'
        : 'height ' + Math.round(titleHeight) + 'px / text "' + chatTitle.textContent + '"',
    );

    // **设置入口在右上角、而且是齿轮**（用户报过一次"设置按钮没了，配不了模型 API"）。
    // 四条一起断言：存在、没带 hidden、antd 图标真的渲染出了 svg、以及它贴着顶栏右缘。
    // 最后一条才是"右上角"——只看可见性的话，它缩在左边那堆按钮中间也算过。
    const settings = document.querySelector('#btn-settings');
    const header = document.querySelector('.ant-layout-header');
    const gapRight =
      settings === null || header === null
        ? NaN
        : Math.round(header.getBoundingClientRect().right - settings.getBoundingClientRect().right);
    check(
      'settings-visible',
      settings !== null &&
        !settings.classList.contains('hidden') &&
        settings.querySelector('svg') !== null &&
        Number.isFinite(gapRight) &&
        gapRight < 24,
      settings === null
        ? 'no #btn-settings'
        : (settings.classList.contains('hidden') ? 'hidden' : 'visible') +
          ' / icon ' + (settings.querySelector('svg') === null ? 'missing' : 'present') +
          ' / from the toolbar right edge ' + (Number.isFinite(gapRight) ? gapRight + 'px' : 'could not read the toolbar'),
    );

    // **顶栏里的按钮必须纵向居中**（用户报的："工具按钮为什么靠到顶了"）。
    //
    // 判据是"上下的留白一不一样"，不是"按钮有没有在顶栏里"——后者在跑偏 14px 时
    // 照样为真。量的是**头尾两个图标按钮**（最左的 #btn-new、最右的 #btn-settings），
    // 因为跑偏只可能来自容器的 align-items，而它一次会影响整行；取两个是为了
    // 顺带钉住"行内所有元素同高同位"，万一以后有人给某一个元素单独加 align-self。
    //
    // 为什么会跑偏（留给下一个改这儿的人）：写成 align="stretch" 时，antd 输出
    // align-items: stretch，24px 的小按钮被拉满整条 38px，图标于是贴上沿——
    // 实测 topGap=0 / botGap=14。而 settings-visible（量右缘距离）两种写法都过，
    // 所以这条断言是**唯一**拦得住它的东西。
    const centeredIds = ['btn-new', 'btn-settings'];
    const centering = centeredIds
      .map((id) => document.querySelector('#' + id))
      .filter((el) => el !== null)
      .map((el) => {
        const box = el.getBoundingClientRect();
        const bar = header === null ? null : header.getBoundingClientRect();
        return {
          top: Math.round(box.top - (bar === null ? 0 : bar.top)),
          bottom: Math.round((bar === null ? 0 : bar.bottom) - box.bottom),
        };
      });
    const centered =
      centering.length === centeredIds.length &&
      centering.every(
        (box) => box.top > 0 && box.bottom > 0 && Math.abs(box.top - box.bottom) <= 1,
      );
    check(
      'toolbar-centered',
      centered,
      centering.length === 0
        ? 'not one icon button could be read'
        : centering
            .map((box, at) => centeredIds[at] + ' above ' + box.top + 'px / below ' + box.bottom + 'px')
            .join('，'),
    );

    /**
     * **模型设置是"列表 + 展开编辑"**（用户拿 DeepSeek harness 的配置对照过来的要求）：
     * 一行一个 provider、带状态点、点「编辑」才展开表单，底下压着「自定义设置」。
     *
     * 这里**不点「添加」**：addProvider 会往真实设置文件里加一条并落盘，而冒烟测试
     * 不该改用户的配置（demo 跑的是他本机的设置）。所以加号按钮只做存在性断言，
     * 新增那条链路由 chat.test.ts 覆盖。展开看表单是纯界面操作，不落盘。
     *
     * **展开后必须能读到 #cfg-baseurl / #cfg-model / #btn-add-price**（在
     * 「自定义设置」里）：地址、模型名与按模型的价格表就是这次要保住的东西，
     * 折叠着不查的话，把整块删掉也能过。
     *
     * 它**不点「保存」**：那会发起一次真实的网络探测（挑模型那一步会在服务端花掉
     * 一次调用），用户这台机器上连的可能是真端点。保存那条路只能靠单元测试与人工验。
     */
    const settingsBtn = document.querySelector('#btn-settings');
    if (settingsBtn !== null && settingsBtn.disabled !== true) {
      settingsBtn.click();
      for (let i = 0; i < 8; i++) await frames();
      const modal = document.querySelector('.ant-modal');
      const cards = document.querySelectorAll('.provider-card');
      check(
        'settings-provider-list',
        modal !== null &&
          cards.length > 0 &&
          document.querySelector('#btn-add-deepseek') !== null &&
          document.querySelector('#btn-add-custom') !== null &&
          document.querySelector('#btn-add-openai') === null &&
          document.querySelector('#btn-add-ollama') === null &&
          document.querySelector('#btn-test') === null &&
          document.querySelector('#probe-log') === null,
        modal === null
          ? 'the dialog did not open'
          : cards.length + ' provider rows' +
              ' / add buttons ' +
              (['btn-add-deepseek', 'btn-add-custom'].every(
                (id) => document.querySelector('#' + id) !== null,
              )
                ? 'DeepSeek and Custom present'
                : 'missing') +
              (document.querySelector('#btn-add-openai') === null &&
              document.querySelector('#btn-add-ollama') === null
                ? ' (OpenAI and Ollama removed)'
                : ' (OpenAI and Ollama still there)') +
              ' / test button ' + (document.querySelector('#btn-test') === null ? 'removed' : 'still there') +
              ' / probe log ' + (document.querySelector('#probe-log') === null ? 'removed' : 'still there'),
      );

      // 展开第一条（点它自己的「编辑」，不是点卡片——点卡片是"换成用它"）
      const firstEdit = document.querySelector('.provider-card .ant-btn[id^="btn-edit-"]');
      if (firstEdit !== null) firstEdit.click();
      const expanded = await waitFor(() => document.querySelector('#cfg-key') !== null);
      check(
        'settings-provider-form',
        expanded &&
          document.querySelector('#cfg-preset') !== null &&
          document.querySelector('#btn-advanced') !== null &&
          document.querySelector('#cfg-baseurl') === null,
        expanded
          ? 'form expanded, custom settings collapsed by default=' + (document.querySelector('#cfg-baseurl') === null)
          : 'clicked Edit but the form did not appear',
      );

      const advanced = document.querySelector('#btn-advanced');
      if (advanced !== null) advanced.click();
      const openedAdvanced = await waitFor(() => document.querySelector('#btn-add-price') !== null);
      check(
        'settings-provider-advanced',
        openedAdvanced &&
          document.querySelector('#cfg-baseurl') !== null &&
          document.querySelector('#cfg-model') !== null &&
          document.querySelector('#btn-add-price') !== null &&
          document.querySelector('#cfg-currency') !== null &&
          document.querySelector('#cfg-usd') === null &&
          document.querySelector('#cfg-turns') === null,
        openedAdvanced
          ? 'endpoint / model / add price row / currency all present' +
              ' / usage cap ' +
              (document.querySelector('#cfg-usd') === null && document.querySelector('#cfg-turns') === null
                ? 'removed'
                : 'still there')
          : 'expanded the custom settings but found no price table or endpoint field',
      );

      const cancel = document.querySelector('#btn-settings-cancel');
      if (cancel !== null) cancel.click();
      for (let i = 0; i < 8; i++) await frames();
    }

    /**
     * **模型选择器在输入框里、发送按钮左边**（用户拿 DeepSeek harness 的输入框对照的要求）。
     *
     * 判据是**几何位置**而不是"存在"：#model-picker 在 DOM 里存在很容易，
     * 而"它在不在发送钮左边、在不在输入框内"才是这条要求的内容——顺序写反
     * （放到发送钮右边）或者被挤到框外，都只有量位置才拦得住。
     */
    /**
     * ⚠️ id 被 antd 放到了**内部那个 input** 上（role=combobox），不是组件根：
     * 拿它读 textContent 永远是空的、innerHTML 也是空——第一版就是这么写的，
     * 于是"选择器显示了什么"这条量出来是 ""，看着像模型名没渲染出来。
     * 文本与几何都要读 .ant-select 那一层。
     */
    const pickerInput = document.querySelector('#model-picker');
    const picker = pickerInput === null ? null : pickerInput.closest('.ant-select');
    const sendBtn2 = document.querySelector('#btn-send');
    const composerBox = document.querySelector('.composer');
    const pickerOk =
      picker !== null && sendBtn2 !== null && composerBox !== null
        ? (() => {
            const box = composerBox.getBoundingClientRect();
            const p = picker.getBoundingClientRect();
            const b = sendBtn2.getBoundingClientRect();
            return p.right <= b.left && p.left >= box.left && p.right <= box.right;
          })()
        : false;
    check(
      'composer-model-picker',
      pickerOk,
      picker === null
        ? 'no #model-picker'
        : 'picker ' + (sendBtn2 === null ? '?' : pickerOk ? 'left of the send button, inside the box' : 'wrong position') +
            ' / shows "' + (picker.textContent ?? '').trim() + '"',
    );

    // 挡住发送的时候，必须有一条**能直接解决问题的路**（不然新用户第一屏就卡住）
    const blocking = document.querySelector('#blocking');
    const blocked = blocking !== null && !blocking.classList.contains('hidden');
    const action = document.querySelector('#blocking-settings');
    check(
      'blocking-actionable',
      blocked ? action !== null : true,
      blocked ? 'blocked, with a button that opens settings' : 'not blocked (a model is configured)',
    );

    // **WASD 真的在移动相机**。
    // 断言的是那行隐藏的状态行——它是渲染进程里唯一读得到的相机快照，相机落地之后
    // 会写上"位置 x,y,z"。所以走一步、再走一步，那三个数必须跟着变。
    // 走的是真实的键盘事件路径（window 上的 keydown/keyup），不是调内部函数。
    const status = document.querySelector('#status');
    const walk = async (key, steps) => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
      for (let i = 0; i < steps; i++) await frames();
      window.dispatchEvent(new KeyboardEvent('keyup', { key, bubbles: true }));
      await frames();
      return status === null ? '' : status.textContent;
    };
    const positionOf = (text) => {
      const found = /(-?\\d+),(-?\\d+),(-?\\d+)/.exec(text);
      return found === null ? null : found.slice(1).join(',');
    };
    const afterW = positionOf(await walk('w', 8));
    const afterA = positionOf(await walk('a', 8));
    check(
      'wasd-move',
      afterW !== null && afterA !== null && afterW !== afterA,
      'camera position ' + afterW + ' → (after A)' + afterA,
    );

    // **空格上升 / Shift 下降**：同一条真实键盘路径。
    // 断言三件事一起：Y 真的变了、升与降方向相反、以及**X/Z 一动不动**。
    // 最后一条才是重点——要是有人把空格接到"沿视线飞"（forward）上，抬头状态下
    // 水平位置会跟着跑，这条立刻红。所以它和 wasd-move 不是重复的。
    // （注意这段脚本整个是 TS 模板字符串：注释里不能出现反引号。）
    const partsOf = (text) => {
      const at = positionOf(text);
      return at === null ? null : at.split(',');
    };
    const yOf = (text) => {
      const parts = partsOf(text);
      return parts === null ? null : Number(parts[1]);
    };
    const xzOf = (text) => {
      const parts = partsOf(text);
      return parts === null ? null : parts[0] + ',' + parts[2];
    };
    const resting = status === null ? '' : status.textContent;
    const rose = await walk(' ', 12);
    const sank = await walk('shift', 12);
    check(
      'space-shift-vertical',
      yOf(resting) !== null &&
        yOf(rose) > yOf(resting) &&
        yOf(sank) < yOf(rose) &&
        xzOf(rose) === xzOf(resting) &&
        xzOf(sank) === xzOf(resting),
      'Y ' + yOf(resting) + ' → (Space) ' + yOf(rose) + ' → (Shift) ' + yOf(sank) +
        ', horizontal position held at ' + xzOf(rose),
    );

    // **拖动 = 原地转头**：角度变了，位置一动不动。
    // 以前拖动是"绕着画面中心转"（位置在这套语义里根本不存在），现在相机有一个真实位置，
    // 拖动只改朝向——所以这条断言同时钉住了"拖动仍然能转"和"转的时候人不跟着飞"。
    //
    // **方向也要钉住**：往右拖 = 画面跟着手往右走 = 相机**左**转（方位角增大）。
    // 这条只能在这里验，因为"dx 有没有被取反"发生在事件接线里，单元测试测不到；
    // 而枢轴从"绕中心"换成"原地转头"时，正是这一步把方向悄悄弄反的。
    const poseOf = (text) => {
      const angles = /(-?\\d+)°[^\\d-]*(-?\\d+)°/.exec(text);
      const at = /(-?\\d+),(-?\\d+),(-?\\d+)/.exec(text);
      return {
        azimuth: angles === null ? null : Number(angles[1]),
        position: at === null ? null : at.slice(1).join(','),
      };
    };
    const overlay = document.querySelector('#overlay');
    const rect = overlay.getBoundingClientRect();
    const send = (type, x, y) =>
      overlay.dispatchEvent(
        new PointerEvent(type, {
          pointerId: 7,
          button: 0,
          buttons: type === 'pointerup' ? 0 : 1,
          clientX: x,
          clientY: y,
          bubbles: true,
        }),
      );
    const beforeTurn = poseOf(status === null ? '' : status.textContent);
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    send('pointerdown', cx, cy);
    for (let i = 1; i <= 4; i++) send('pointermove', cx + i * 12, cy + i * 3);
    send('pointerup', cx + 48, cy + 12);
    await frames();
    const afterTurn = poseOf(status === null ? '' : status.textContent);
    check(
      'drag-turn-in-place',
      beforeTurn.position !== null &&
        beforeTurn.position === afterTurn.position &&
        beforeTurn.azimuth !== afterTurn.azimuth &&
        afterTurn.azimuth > beforeTurn.azimuth,
      'azimuth ' + beforeTurn.azimuth + '° → ' + afterTurn.azimuth + '° (dragging right turns left, so the angle grows), position held at ' + beforeTurn.position,
    );
    return results;
  })()`
  const raw = (await target.webContents.executeJavaScript(script)) as GuiCheck[]
  return raw
}

/**
 * GUI 冒烟里最重要的一条：**模型的眼睛真的走渲染进程的 three.js 了吗**。
 *
 * 只断言"截图能出来"是不够的——回落路径同样出图，而回落意味着用户看到的是
 * GPU 版、模型看到的是软件版，正是这一版要消灭的那种不一致。
 * 所以这里要一枪，并断言**没有回落**（回落时 `renderFallback` 会被写上原因）。
 *
 * 顺带把 PNG 带回去：`--shot` 要把它写到盘上给人看。
 */
async function assertGpuShot(report: {
  ok: boolean
  detail: string
}): Promise<{ ok: boolean; detail: string; png?: Uint8Array }> {
  if (!report.ok) return { ok: false, detail: `the renderer itself failed: ${report.detail}` }
  try {
    const image = await studio.shoot({ view: 'iso_ne', width: 512, height: 384 })
    const fallback = studio.renderFallback
    if (fallback !== undefined) return { ok: false, detail: `fell back to the software rasterizer: ${fallback}` }
    const isPng = image.png[0] === 0x89 && image.png[1] === 0x50 && image.png[2] === 0x4e && image.png[3] === 0x47
    if (!isPng) return { ok: false, detail: `what came back is not a PNG (first 4 bytes ${[...image.png.slice(0, 4)].join(',')})` }
    return {
      ok: true,
      png: image.png,
      detail: `screenshot ${image.png.length} bytes PNG, revision ${image.revision}, camera ${image.view}`,
    }
  } catch (error) {
    return { ok: false, detail: `the screenshot threw: ${error instanceof Error ? error.message : String(error)}` }
  }
}

/**
 * 冒烟模式：不建窗口，把整条主进程链路跑一遍然后退出。
 *
 * 存在的理由是**打包后才会暴露的问题**：`minecraft-data` 与 `minecraft-assets`
 * 被标成 external，运行时靠 Node require——只有真的跑一次才知道路径对不对。
 */
async function runSmoke(): Promise<void> {
  const lines: string[] = []
  const service = new StudioService()
  const state = service.demo()
  lines.push(`demo: rev ${state.revision} / op ${state.totalOps} / ${state.blocks} blocks`)

  const shot = await service.shoot({ view: 'iso_ne', width: 320, height: 240 })
  // 冒烟模式没有窗口，所以这一枪必然是软件光栅器画的——把"确实回落了"也报出来，
  // 否则以后有人改了回落条件，这里会静默变成别的东西
  lines.push(`shoot: ${shot.png.length} bytes PNG, revision ${shot.revision} (no window → software rasterizer)`)

  const back = service.seek(Math.max(0, state.revision - 3))
  lines.push(`seek(${state.revision - 3}): rev ${back.revision} / ${back.blocks} blocks`)
  service.seekLatest()
  lines.push(`seekLatest: rev ${service.state().revision}`)

  const slice = service.slice({ axis: 'y', index: 1, x: [0, 15], z: [0, 15] })
  lines.push(`slice: ${slice.split('\n').length} lines`)

  // 设置 / 对话链路（不联网，只验证形状与默认值）
  lines.push(`settings: ${service.settingsView().providers.length} providers, active=${service.settingsView().activeId}`)

  // 自动保存 + 崩溃恢复：**走真实的文件系统路径**（临时目录里的一卷真 WAL）
  {
    const os = await import('node:os')
    const path = await import('node:path')
    const fs = await import('node:fs/promises')
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'architect-autosave-'))
    const savePath = path.join(dir, 'crash.mcai')

    const live = new StudioService({ plain: true })
    const wal = new AutosaveService({ dir, projectId: 'active', name: 'crash-recovery smoke' })
    live.attachAutosave(wal)
    live.demo()
    await live.save(savePath)

    // 保存之后再改两格（模拟"用户还在改，然后进程被杀"）
    const store = live.agentSession.store
    for (const x of [20, 21]) {
      live.agentSession.applyEdit('place_block', { pos: [x, 5, 20] }, () =>
        store.write((emit) => emit(x, 5, 20), store.palette.indexOf('minecraft:gold_block'), {
          confirm: true,
        }),
      )
    }
    const journaled = live.autosaveNow()
    const expectedHash = store.contentHash()

    // —— 模拟崩溃：换一个**全新的工作台**，走产品里那条恢复路径 ——
    // （不是在这里手写 applyPatch 循环：那样只能证明 WAL 的内容对，
    //   证明不了"界面点一下恢复真的能拿回世界"——而那才是用户要的）
    const after = new StudioService({ plain: true })
    const reopened = new AutosaveService({ dir, projectId: 'active', name: 'crash-recovery smoke' })
    after.attachAutosave(reopened)
    const summary = after.recover()
    if (summary === undefined) throw new Error('the WAL should hold a recoverable op')
    const recoveredState = await after.applyRecovery()
    const restored = after.agentSession.store

    const recovered = restored.contentHash() === expectedHash
    lines.push(
      `autosave: wrote ${journaled} ops → after a crash recover() reports ${summary.ops} → ` +
        `after applyRecovery() rev ${restored.revision} / ${restored.stats().blocks} blocks / ` +
        `hash ${recovered ? 'matches' : 'differs'} / pending ${recoveredState.recovery === undefined ? 'cleared' : 'still there'}`,
    )
    if (!recovered) throw new Error('the recovered world does not match the world before the crash')
    if (recoveredState.recovery !== undefined) throw new Error('recovery should not leave a pending journal behind')
    await fs.rm(dir, { recursive: true, force: true })
  }
  lines.push(`chat: ready=${service.chatView().ready} blocking=${service.chatView().blocking.length}`)

  // ── 交互视口（拖动旋转） ────────────────────────────────────────────────────
  //
  // 拖得动的前提是"每帧只做光栅化"：网格化按 revision 缓存，转角度不该重建网格。
  // 这里量的就是这件事——首帧建网格，第二帧必须命中缓存，否则拖动会卡在 ~200 ms/帧。
  const first = service.viewport({ azimuth: 45, elevation: 35, width: 900, height: 640, draft: true })
  const t1 = Date.now()
  const second = service.viewport({ azimuth: 75, elevation: 50, width: 900, height: 640, draft: true })
  const warm = Date.now() - t1
  lines.push(
    `viewport: first frame ${first.ms}ms (meshed ${first.meshed ? 'yes' : 'no'}) → ${warm}ms after turning 30°` +
      `(meshed ${second.meshed ? 'yes' : 'no'}) · ${second.width}x${second.height} · ${second.pixels.length} bytes`,
  )
  if (second.meshed) throw new Error('a new angle should not rebuild the mesh; the mesh cache is not working')
  if (second.pixels.length !== second.width * second.height * 4) throw new Error('the pixel buffer has the wrong length')
  // 图里得真有东西，而且转 30° 之后画出来的**必须不一样**——
  // 只断言"没抛异常"的话，一个永远返回背景色的实现也能过
  const painted = countPainted(first.pixels)
  const painted2 = countPainted(second.pixels)
  let changed = 0
  for (let i = 0; i < first.pixels.length; i += 4) {
    if (first.pixels[i] !== second.pixels[i] || first.pixels[i + 1] !== second.pixels[i + 1]) changed++
  }
  lines.push(`  image: shaded pixels ${painted} → ${painted2}, ${((changed / (first.width * first.height)) * 100).toFixed(1)}% changed after turning`)
  if (painted < 1000) throw new Error('the viewport is nearly empty; nothing was drawn')
  if (changed / (first.width * first.height) < 0.02) throw new Error('the image barely changed after turning 30°; the camera is not wired up')

  const os = await import('node:os')
  const path = await import('node:path')
  const fs = await import('node:fs/promises')
  const tmp = path.join(os.tmpdir(), `architect-smoke-${Date.now()}.mcai`)
  await service.save(tmp)
  const reopened = await service.open(tmp)
  lines.push(`save+open: ${(await fs.stat(tmp)).size} bytes → rev ${reopened.revision} / ${reopened.blocks} blocks`)
  await fs.rm(tmp, { force: true })

  // ── 导出/导入闭环（M7） ─────────────────────────────────────────────────────
  //
  // 光"能产出字节"不算过：这里每个格式都真的写盘，再把 `.schem` 读回来，
  // 确认导入后世界里确实有那么多方块。导出按钮背后的代码路径与冒烟用的是同一条。
  const dir = path.join(os.tmpdir(), `architect-export-${Date.now()}`)
  await fs.mkdir(dir, { recursive: true })
  for (const format of ['schem', 'litematic', 'obj'] as const) {
    const exported = service.exportModel(format, path.join(dir, `smoke.${format === 'litematic' ? 'litematic' : format}`))
    for (const file of exported.files) await fs.writeFile(file.name, file.bytes)
    const sizes = await Promise.all(
      exported.files.map(async (file) => `${path.basename(file.name)} ${(await fs.stat(file.name)).size}B`),
    )
    lines.push(`export ${format}: ${sizes.join(' + ')} · ${exported.summary}`)
  }
  const before = service.state().blocks
  const imported = await service.importModel(path.join(dir, 'smoke.schem'))
  lines.push(
    `import schem: ${imported.summary} · project ${before} → ${imported.state.blocks} blocks` +
      (imported.unknown.length > 0 ? ` · ${imported.unknown.length} unknown type(s)` : ''),
  )
  if (imported.state.blocks === 0) throw new Error('the world is empty after importing a .schem')
  await fs.rm(dir, { recursive: true, force: true })

  process.stdout.write(`SMOKE OK\n${lines.map((l) => `  ${l}`).join('\n')}\n`)
}

/** 数一数有多少像素不是背景色（用来判断"图里真有东西"）。 */
function countPainted(pixels: Uint8Array): number {
  let n = 0
  for (let i = 0; i < pixels.length; i += 4) {
    if (pixels[i] !== 26 || pixels[i + 1] !== 28 || pixels[i + 2] !== 34) n++
  }
  return n
}

// ── 双击 `.mcai` 打开（M5 验收：fileAssociations + open-file） ────────────────
//
// `open-file` **必须在 `whenReady` 之前注册**，否则 macOS 上第一次双击会丢掉事件。
app.on('open-file', (event, path) => {
  event.preventDefault()
  if (!studioReady || mainWindow === undefined) {
    pendingOpenPath = path
    return
  }
  void openProjectPath(path)
})

// 命令行/资源管理器传入的路径（Windows、Linux，以及 `ArchItect foo.mcai`）
pendingOpenPath = projectPathFromArgv(process.argv)

// 第二次启动不要开第二个窗口：把焦点还给已有窗口，并在那里打开文件
const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', (_event, argv) => {
    const path = projectPathFromArgv(argv)
    if (path !== undefined && studioReady) void openProjectPath(path)
    else {
      mainWindow?.show()
      mainWindow?.focus()
    }
  })
}

const smokeIndex = process.argv.indexOf('--smoke')
const guiSmoke = process.argv.includes('--gui-smoke')
/** `--capture <path>`：窗口渲染完成后把窗口本身抓成 PNG 再退出。不需要系统截屏权限。 */
const captureIndex = process.argv.indexOf('--capture')
const capturePath = captureIndex >= 0 ? process.argv[captureIndex + 1] : undefined
/**
 * `--shot <path>`：把**模型视角**的那张截图写到盘上再退出。
 *
 * 和 `--capture` 是两件事：那个抓的是用户的视口，这个走的是 `ctx.shoot` ——也就是
 * 模型真正收到的那张图（尺寸、叠加层、用哪条渲染路径都和它一致）。
 * 排查"模型为什么看错了"时，先看这张图，而不是看窗口。
 */
const shotIndex = process.argv.indexOf('--shot')
const shotPath = shotIndex >= 0 ? process.argv[shotIndex + 1] : undefined
if (smokeIndex >= 0) {
  void runSmoke()
    .then(() => app.exit(0))
    .catch((error: unknown) => {
      process.stderr.write(`SMOKE FAILED: ${error instanceof Error ? error.stack : String(error)}\n`)
      app.exit(1)
    })
}

/**
 * `--demo` 的两种填法（见调用点的注释）：先试示例工程，失败则脚本化生成。
 *
 * 路径从 `__dirname` 往上找仓库根：打包后 `dist/` 在 `apps/desktop/` 下，
 * 而 `examples/` 在仓库根——**打包版里没有这个目录**，那时自然会落到 `demo()`。
 * 这是刻意的：演示数据不该进安装包。
 */
async function loadExampleOrDemo(): Promise<void> {
  const candidates = [
    join(__dirname, '..', '..', '..', 'examples', 'forest-hut.mcai'),
    join(__dirname, '..', '..', 'examples', 'forest-hut.mcai'),
  ]
  for (const candidate of candidates) {
    try {
      await studio.open(candidate)
      process.stdout.write(`[demo] loaded the example project ${candidate}\n`)
      return
    } catch {
      // 换下一个候选；都没有就走脚本化生成
    }
  }
  studio.demo()
  process.stdout.write('[demo] no example project found; building the hut from the script instead\n')
}

/**
 * `--md-test`：往对话里塞一条覆盖各种 markdown 块的模型回复 + 一条工具调用。
 *
 * 目的是把"模型回复渲染成什么样"变成一张**能反复看的图**：标题、列表、表格、
 * 行内代码、代码块、引用、链接、长 URL（窄栏溢出的主要风险）都放进去。
 * 真的跑一轮模型要花钱、要联网，而且每次写的内容都不一样，没法当样本。
 */
function seedMarkdownSample(): void {
  // 逐行 push：中文写在 `lines.push(` 的参数位置上，i18n 那条测试按"离开发者出口
  // 几行内"判归属，这样它才认得出来这是诊断夹具而不是界面文案
  const lines: string[] = []
  lines.push('## Design notes')
  lines.push('')
  lines.push('This is how I will approach the **forest hut**:')
  lines.push('')
  lines.push('1. Lay the foundation with `minecraft:cobblestone`')
  lines.push('2. Raise the walls, mostly `minecraft:spruce_planks`')
  lines.push('3. Finish with a pitched roof, eaves overhanging by one block')
  lines.push('')
  lines.push('| Part | Material | Size |')
  lines.push('|------|------|------|')
  lines.push('| Foundation | Cobblestone | 9×9 |')
  lines.push('| Walls | Spruce planks | 4 high |')
  lines.push('| Roof | Dark oak | 1 overhang |')
  lines.push('')
  lines.push('> The doorway needs at least 2 blocks of clearance, or `analyze_structure` reports `doorway`.')
  lines.push('')
  lines.push('A long block id, to test overflow in a narrow column:')
  lines.push('`minecraft:spruce_stairs[facing=north,half=bottom,shape=straight,waterlogged=false]`')
  lines.push('')
  lines.push('```json')
  lines.push('{ "check": "block_at", "pos": [8, 1, 4], "expect": "minecraft:spruce_door" }')
  lines.push('```')
  lines.push('')
  lines.push('Reference: [Minecraft Wiki](https://minecraft.wiki/w/Stairs)')
  const markdown = lines.join('\n')
  studio.chat.seedDiagnosticMessage(
    markdown,
    'fill_box',
    '{"from":[4,0,4],"to":[12,0,12],"block":"minecraft:cobblestone"}',
    'changed 81 cells, bounds (4,0,4)..(12,0,12). revision 1.\noverwritten: 0, clipped: 0',
  )
}

void app.whenReady().then(async () => {
  if (smokeIndex >= 0) return
  initStudio()
  /**
   * `--demo`：启动时先把界面填上东西，便于抓图/演示。
   *
   * **优先载入仓库里的示例工程**（`examples/forest-hut.mcai`），载不到才退回
   * "脚本化生成一座小屋"。这个顺序是有理由的：示例工程里带着**对话记录与截图**
   * （22 条消息、1 张图），而 `studio.demo()` 只造方块、对话列是空的——于是
   * "抓一张图看看对话渲染成什么样"这件事一直做不到（卡片配色、思维链折叠、
   * 工具返回折叠、截图在对话里的样子，全都得靠一个真模型跑一轮才看得见）。
   *
   * 示例工程是**确定性生成的**（`pnpm example`，时间戳钉死），所以这条路也可复现。
   */
  if (process.argv.includes('--demo')) {
    // **等它载完再建窗口**：不然窗口会先按"空世界"渲染一帧，
    // 而 `--capture` 正好可能抓到那一帧（状态到位前的空对话列）。
    await loadExampleOrDemo()
  }
  // `--md-test`：往对话里塞一条 markdown 样本（只给诊断，不写进工程）
  if (process.argv.includes('--md-test')) seedMarkdownSample()
  registerIpc()
  createWindow()

  /**
   * **启动时给"还没测过能力"的 provider 补一次探针。**
   *
   * 真机事故：用户配好 API 之后从没点过"测试连接"，`settings.json` 里
   * `capabilities.vision` 就一直是预设的 `false`。而它是**唯一**决定图发不发给
   * 模型的开关——于是截图渲染成功、revision 也对，交付时却被换成一行
   * "(The current model does not support images; N screenshot(s) omitted)"。
   *
   * 设置面板里点一次"测试连接"能修好，但那是"碰巧点开设置"才有的运气。
   * 放在这里补测，配置就能自愈，不必等用户想起来。
   *
   * 三条边界：诊断跑不测（`--demo` / `--capture` 这些不等网络）、不阻塞建窗口
   * （探针要联网，几十秒都可能）、失败只写一行 stderr——**不能因为探测失败就弹窗**。
   */
  const diagnostic = isDiagnosticRun(process.argv, new Set(debugFlagNames(process.argv)))
  if (!diagnostic) {
    void studio
      .probeUnmeasured()
      .then((result) => {
        if (result === undefined) return
        persistSettings()
        process.stdout.write(
          `[probe] ${result.ok ? 'probed' : 'not reachable'} ${result.config.model}` +
            ` image input=${result.config.capabilities.vision ? 'supported' : 'unsupported'}\n`,
        )
      })
      .catch((error: unknown) => {
        process.stderr.write(`[probe] capability probe failed: ${error instanceof Error ? error.message : String(error)}\n`)
      })
  }

  // 首次启动把设置里的问题（比如设置文件坏过）告诉用户，而不是静默吞掉
  if (settingsLoad.fresh === false && settingsLoad.issues.length > 0) {
    process.stderr.write(`the settings file has ${settingsLoad.issues.length} issue(s)\n`)
  }

  // GUI 冒烟：窗口 + preload + 渲染进程 + IPC + 渲染全链路，10 秒内没回报就算失败
  if (guiSmoke || capturePath !== undefined || shotPath !== undefined) {
    setTimeout(() => {
      process.stderr.write('GUI timed out: the renderer never reported back\n')
      app.exit(1)
    }, 10000)
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (autosaveTimer !== undefined) clearInterval(autosaveTimer)
  // 退之前再落一次：定时器可能刚好差一个周期
  try {
    if (studioReady) studio.autosaveNow()
  } catch {
    // 退出路径上不要再抛
  }
  if (process.platform !== 'darwin') app.quit()
})

// 供测试/调试：允许外部替换 studio（不会在正常启动路径上触发）
export function __setStudio(service: StudioService): void {
  studio = service
}
