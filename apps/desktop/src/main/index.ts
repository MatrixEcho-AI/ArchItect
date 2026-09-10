import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { detectLocale, initI18n, setLocale, t } from '@architect/i18n'
import type { Budget, PresetKey, ProviderConfig, ProviderSettings } from '@architect/agent'
import { app, BrowserWindow, dialog as desktopDialog, ipcMain, safeStorage, shell } from 'electron'

import { openProject } from '@architect/mcai'

import { AutosaveService } from './services/autosave.js'
import type { StudioEvent, TestConnectionInput } from './services/chat.js'
import type { Cipher } from './services/settings.js'
import { createSecretStore, loadSettings, saveSettings, secretsFile, settingsFile } from './services/settings.js'
import { StudioService } from './services/studio.js'
import type { ExportFormat, ShootRequest, SliceRequest } from './services/studio.js'

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
  autosave?.retarget('active', state.name, path)
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
    process.stderr.write(`打开 ${path} 失败：${error instanceof Error ? error.message : String(error)}\n`)
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
  initI18n({ locale: loaded.settings.locale ?? detectLocale() })

  const secrets = createSecretStore(secretsFile(app.getPath('userData')), keychain)
  studio = new StudioService({ chat: { settings: loaded.settings, secrets } })
  studio.chat.setIssues([...loaded.issues])
  studio.onEvent((event) => pushEvent(event))
  studioReady = true

  // 崩溃恢复：WAL 只记"上次保存之后"的 op，所以文件很小，写盘与工区大小无关
  autosave = new AutosaveService({
    dir: join(app.getPath('userData'), 'autosave'),
    projectId: 'active',
    name: studio.state().name,
  })
  studio.attachAutosave(autosave)
  studio.recover()
  autosaveTimer = setInterval(() => {
    try {
      studio.autosaveNow()
    } catch (error) {
      // 写 WAL 失败不该影响用户继续编辑，但必须让人知道
      process.stderr.write(`自动保存失败：${error instanceof Error ? error.message : String(error)}\n`)
    }
  }, AUTOSAVE_INTERVAL_MS)
  // 定时器不该把进程钉住（关窗时 Node 要能退出）
  autosaveTimer.unref?.()
}

function pushEvent(event: StudioEvent): void {
  if (mainWindow === undefined || mainWindow.isDestroyed()) return
  mainWindow.webContents.send('studio:event', event)
}

function persistSettings(): void {
  saveSettings(settingsPath(), studio.chat.settingsValue)
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1360,
    height: 880,
    minWidth: 960,
    minHeight: 600,
    title: 'ArchItect',
    backgroundColor: '#1a1c22',
    show: false,
    webPreferences: {
      preload: join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  })

  mainWindow.once('ready-to-show', () => mainWindow?.show())
  // 外部链接走系统浏览器，不在应用内开新窗口
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url)
    return { action: 'deny' }
  })

  // 窗口一渲染好就把系统要求打开的那个工程装进去
  mainWindow.webContents.once('did-finish-load', () => {
    void consumePendingOpen()
  })

  // `--open-settings` 让窗口直接带着设置面板起来，便于抓图做视觉检查
  void mainWindow.loadFile(join(__dirname, 'renderer', 'index.html'), {
    ...(process.argv.includes('--open-settings') ? { hash: 'settings' } : {}),
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

  handle('studio:new', (volume?: Parameters<StudioService['newProject']>[0]) => {
    const state = studio.newProject(volume)
    // 新工程不该继承上一个工程的草稿
    autosave?.retarget('active', state.name)
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
    autosave?.retarget('active', state.name, path)
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

  handle('studio:demo', () => studio.demo())
  handle('studio:seek', (revision: number) => studio.seek(revision))
  handle('studio:seekLatest', () => studio.seekLatest())

  // 截图：返回 PNG 字节（IPC 用结构化克隆传 Buffer 没问题）
  handle('studio:shoot', (request: ShootRequest) => {
    const { png, view, revision } = studio.shoot(request)
    return { png: Buffer.from(png), view, revision }
  })

  handle('studio:slice', (request: SliceRequest) => studio.slice(request))

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
  handle('settings:setBudget', (budget: Budget | undefined) => {
    const view = studio.chat.setBudget(budget)
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
  handle('settings:test', (input: TestConnectionInput) => studio.testConnection(input))

  // ── 对话 ────────────────────────────────────────────────────────────────────
  handle('chat:view', () => studio.chatView())
  handle('chat:send', (text: string) => studio.send(text))
  handle('chat:stop', () => studio.stop())
  handle('chat:clear', () => studio.clearChat())
  handle('chat:image', (id: string) => {
    const png = studio.chatImage(id)
    return png === undefined ? undefined : Buffer.from(png)
  })

  // 渲染进程的"首次渲染完成"回报。GUI 冒烟测试等它。
  ipcMain.handle('studio:ready', (_event, report: { ok: boolean; detail: string }) => {
    process.stdout.write(`[renderer] ${report.ok ? 'READY' : 'FAILED'}: ${report.detail}\n`)
    if (guiSmoke) setTimeout(() => app.exit(report.ok ? 0 : 1), 50)
    if (capturePath !== undefined) {
      // 等一下让首帧真的画上，然后抓窗口
      setTimeout(() => {
        void mainWindow?.webContents
          .capturePage()
          .then((image) => writeFile(capturePath, image.toPNG()))
          .then(() => {
            process.stdout.write(`已抓取窗口 → ${capturePath}\n`)
            app.exit(0)
          })
          .catch((error: unknown) => {
            process.stderr.write(`抓取失败：${String(error)}\n`)
            app.exit(1)
          })
      }, 900)
    }
    return { ok: true, value: undefined }
  })
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
  lines.push(`demo: rev ${state.revision} / op ${state.totalOps} / ${state.blocks} 方块`)

  const shot = service.shoot({ view: 'iso_ne', width: 320, height: 240 })
  lines.push(`shoot: ${shot.png.length} 字节 PNG, revision ${shot.revision}`)

  const back = service.seek(Math.max(0, state.revision - 3))
  lines.push(`seek(${state.revision - 3}): rev ${back.revision} / ${back.blocks} 方块`)
  service.seekLatest()
  lines.push(`seekLatest: rev ${service.state().revision}`)

  const slice = service.slice({ axis: 'y', index: 1, x: [0, 15], z: [0, 15] })
  lines.push(`slice: ${slice.split('\n').length} 行`)

  // 设置 / 对话链路（不联网，只验证形状与默认值）
  lines.push(`settings: ${service.settingsView().providers.length} 个 provider, active=${service.settingsView().activeId}`)

  // 自动保存 + 崩溃恢复：**走真实的文件系统路径**（临时目录里的一卷真 WAL）
  {
    const os = await import('node:os')
    const path = await import('node:path')
    const fs = await import('node:fs/promises')
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'architect-autosave-'))
    const savePath = path.join(dir, 'crash.mcai')

    const live = new StudioService({ plain: true })
    const wal = new AutosaveService({ dir, projectId: 'active', name: '崩溃恢复冒烟' })
    live.attachAutosave(wal)
    live.demo()
    await live.save(savePath)

    // 保存之后再改两格（模拟"用户还在改，然后进程被杀"）
    const store = live.agentSession.store
    for (const x of [20, 21]) {
      const result = store.write((emit) => emit(x, 5, 20), store.palette.indexOf('minecraft:gold_block'), {
        confirm: true,
      })
      live.agentSession.log.record(result, {
        tool: 'place_block',
        args: { pos: [x, 5, 20] },
        source: 'user',
        actor: 'user',
      })
    }
    const journaled = live.autosaveNow()
    const expectedHash = store.contentHash()

    // —— 模拟崩溃：换一个全新的实例去读磁盘上剩下的东西 ——
    const reopened = new AutosaveService({ dir, projectId: 'active', name: '崩溃恢复冒烟' })
    const pending = reopened.pending()
    if (pending === undefined) throw new Error('WAL 里应当有可恢复的 op')
    const { project, store: restored } = openProject(new Uint8Array(await fs.readFile(savePath)))
    for (const op of pending.ops) restored.applyPatch(op.patch)
    restored.setRevision(project.manifest.revision + pending.ops.length)

    const recovered = restored.contentHash() === expectedHash
    lines.push(
      `autosave: 记下 ${journaled} 条 op，崩溃后恢复 ${pending.ops.length} 条 → ` +
        `rev ${restored.revision} / ${restored.stats().blocks} 方块 / hash ${recovered ? '一致' : '不一致'}`,
    )
    if (!recovered) throw new Error('崩溃恢复后的世界与崩溃前不一致')
    await fs.rm(dir, { recursive: true, force: true })
  }
  lines.push(`chat: ready=${service.chatView().ready} blocking=${service.chatView().blocking.length}`)

  const os = await import('node:os')
  const path = await import('node:path')
  const fs = await import('node:fs/promises')
  const tmp = path.join(os.tmpdir(), `architect-smoke-${Date.now()}.mcai`)
  await service.save(tmp)
  const reopened = await service.open(tmp)
  lines.push(`save+open: ${(await fs.stat(tmp)).size} 字节 → rev ${reopened.revision} / ${reopened.blocks} 方块`)
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
    `import schem: ${imported.summary} · 工程 ${before} → ${imported.state.blocks} 方块` +
      (imported.unknown.length > 0 ? ` · ${imported.unknown.length} 种未知` : ''),
  )
  if (imported.state.blocks === 0) throw new Error('导入 .schem 后世界是空的')
  await fs.rm(dir, { recursive: true, force: true })

  process.stdout.write(`SMOKE OK\n${lines.map((l) => `  ${l}`).join('\n')}\n`)
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
if (smokeIndex >= 0) {
  void runSmoke()
    .then(() => app.exit(0))
    .catch((error: unknown) => {
      process.stderr.write(`SMOKE FAILED: ${error instanceof Error ? error.stack : String(error)}\n`)
      app.exit(1)
    })
}

void app.whenReady().then(() => {
  if (smokeIndex >= 0) return
  initStudio()
  // --demo：启动时先生成示例小屋，便于抓图/演示
  if (process.argv.includes('--demo')) studio.demo()
  registerIpc()
  createWindow()

  // 首次启动把设置里的问题（比如设置文件坏过）告诉用户，而不是静默吞掉
  if (settingsLoad.fresh === false && settingsLoad.issues.length > 0) {
    process.stderr.write(`设置文件有 ${settingsLoad.issues.length} 个问题\n`)
  }

  // GUI 冒烟：窗口 + preload + 渲染进程 + IPC + 渲染全链路，10 秒内没回报就算失败
  if (guiSmoke || capturePath !== undefined) {
    setTimeout(() => {
      process.stderr.write('GUI 超时：渲染进程没有回报\n')
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
