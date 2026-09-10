import { readFile, writeFile } from 'node:fs/promises'

import { activeProvider, AgentSession, runAgent } from '@architect/agent'
import { forEachBox, forEachExtrude, forEachPlane, measure, ReplaySession, renderSlice } from '@architect/core'
import type { Bounds, SliceAxis } from '@architect/core'
import {
  DATA_VERSION_1_21_4,
  exportLitematic,
  exportObj,
  exportSchematic,
  importSchematicInto,
  litematicToSchematicData,
  readLitematic,
  readSpongeSchematic,
} from '@architect/interop'
import type { SchematicData } from '@architect/interop'
import { openProject, packProject } from '@architect/mcai'

import type { AutosaveService } from './autosave.js'
import { ChatController } from './chat.js'
import type { ChatOptions, ChatView, SettingsView, StudioEvent, TestConnectionInput } from './chat.js'
import { createMemorySecretStore } from './settings.js'

/** 传给渲染进程的完整状态快照。渲染进程不持有世界，它只是个视图。 */
export interface StudioState {
  projectPath?: string
  name: string
  minecraftVersion: string
  revision: number
  /** 历史里总共有多少步（时间线的上界）。 */
  totalOps: number
  blocks: number
  bounds?: { min: [number, number, number]; max: [number, number, number] }
  volume: { min: [number, number, number]; max: [number, number, number] }
  paletteSize: number
  ops: Array<{ rev: number; tool: string; changed: number; ts: string }>
  histogram: Array<{ block: string; count: number; percent: number }>
  /** 一次性的提示（崩溃恢复提醒之类）。读过就没了。 */
  notice?: string
}

/** 能导出成什么。GUI 的"导出…"按扩展名推断，也可以让用户显式选。 */
export type ExportFormat = 'schem' | 'litematic' | 'obj'

export interface ShootRequest {
  view: string
  width: number
  height: number
  /** 高亮某个区域；省略时高亮最后一次编辑。 */
  highlightLast?: boolean
}

export interface SliceRequest {
  axis: SliceAxis
  index: number
  x?: [number, number]
  y?: [number, number]
  z?: [number, number]
}

const opTuple = (b: Bounds): { min: [number, number, number]; max: [number, number, number] } => ({
  min: [b.min.x, b.min.y, b.min.z],
  max: [b.max.x, b.max.y, b.max.z],
})

/**
 * 主进程侧的工作台状态。
 *
 * **世界的唯一持有者**。渲染进程通过 IPC 拿渲染结果，不自己跑体素逻辑——
 * 这样渲染进程不需要打包任何 workspace 包进浏览器（绕开 `node:crypto` 之类的 Node-only 依赖），
 * 也不需要前端打包器。
 *
 * 这个类不依赖 Electron，所以可以直接用 vitest 测。
 */
export interface StudioOptions {
  volume?: Bounds
  minecraftVersion?: string
  plain?: boolean
  chat?: ChatOptions
}

export class StudioService {
  private session: AgentSession
  private replay: ReplaySession
  private projectPath?: string
  private projectName = '未命名项目'
  readonly chat: ChatController
  private emit: (event: StudioEvent) => void = () => {}
  private readonly plain: boolean
  private autosave?: AutosaveService
  /** 启动时从 WAL 恢复出来的提示（没有恢复过就是 undefined）。 */
  private notice: string | undefined

  constructor(options: StudioOptions = {}) {
    this.plain = options.plain ?? false
    const volume = options.volume ?? { min: { x: 0, y: 0, z: 0 }, max: { x: 31, y: 31, z: 31 } }
    this.session = new AgentSession({
      volume,
      ...(options.minecraftVersion !== undefined ? { minecraftVersion: options.minecraftVersion } : {}),
      plain: options.plain ?? false,
    })
    this.replay = new ReplaySession(this.session.store, this.session.log)

    this.chat = new ChatController(
      options.chat ?? { secrets: createMemorySecretStore() },
      // 每轮都重新读 this.session：newProject/open 会把它换成新的
      async (goal, provider, onEvent, shouldStop) => {
        // 用户设的花费上限要**真的刹车**，不能只记账。价格表来自当前 provider。
        const settings = this.chat.settingsValue
        const cost = activeProvider(settings)?.cost
        const state = await runAgent(
          {
            provider,
            registry: this.session.registry,
            ctx: this.session.ctx,
            system: this.session.buildSystem(),
            stateLine: this.session.buildStateLine(),
            onEvent,
            shouldStop,
            ...(settings.budget !== undefined ? { budget: settings.budget } : {}),
            ...(cost !== undefined ? { costTable: cost } : {}),
          },
          goal,
        )
        return {
          stopReason: state.stopReason,
          ...(state.error !== undefined ? { error: state.error } : {}),
          usage: state.usage,
        }
      },
    )
    // 世界被改动之后必须重建回放游标，否则向后 seek 会以为自己已经回退过
    this.chat.onAfterRun(() => {
      this.resetReplay()
      // 一轮结束时把这一步的 op 落进 WAL：agent 停下来时状态一定是齐的
      this.autosaveNow()
      this.emit({ type: 'state', state: this.state() })
    })
  }

  /** 接上自动保存。省略时（测试里）不做任何写盘。 */
  attachAutosave(service: AutosaveService): void {
    this.autosave = service
  }

  /**
   * 把新产生的 op 追加进 WAL。**没有新 op 时一次盘都不写。**
   *
   * 返回这一次记下了几条。定时器与"每轮结束"都调它——两个触发点是有意的：
   * 定时器保证长时间的单次工具调用也不会丢，轮末保证 agent 停下来时一定是齐的。
   */
  autosaveNow(): number {
    if (this.autosave === undefined) return 0
    return this.autosave.journal(this.session.log)
  }

  /** 保存成功后推进 WAL 基准。 */
  private commitAutosave(): void {
    if (this.autosave === undefined) return
    this.autosave.onSaved(this.session.log.length, this.projectPath, this.session.log.length)
  }

  /**
   * 启动时尝试从 WAL 恢复。
   *
   * 只在上次保存过的工程**还在原处**时自动恢复——基准丢了就说不清"恢复出来的
   * 是什么"，那种情况宁可如实说明也不要硬凑。
   */
  recover(): { restored: number; message: string } | undefined {
    if (this.autosave === undefined) return undefined
    const pending = this.autosave.pending()
    if (pending === undefined) return undefined
    if (!pending.baseExists) {
      const message =
        `上次会话有 ${pending.ops.length} 步未保存的改动，但基准工程已经不在原处` +
        `${pending.header.projectPath !== undefined ? `（${pending.header.projectPath}）` : ''}，无法安全恢复。`
      this.notice = message
      return { restored: 0, message }
    }
    const path = pending.header.projectPath!
    return {
      restored: pending.ops.length,
      message:
        `检测到上次会话有 ${pending.ops.length} 步未保存的改动（基准：${path.split('/').pop()}）。` +
        `打开那个工程即可在此基础上继续——也可以新建工程把这份草稿丢掉。`,
    }
  }

  /** 渲染进程要显示的提示（恢复提醒之类），读过一次就清掉。 */
  takeNotice(): string | undefined {
    const value = this.notice
    this.notice = undefined
    return value
  }

  /** 主进程用它把事件推给渲染进程。不注入时（测试里）事件就静静丢掉。 */
  onEvent(listener: (event: StudioEvent) => void): void {
    this.emit = listener
    this.chat.onEvent(listener)
  }

  // ── 对话与设置（都转发给 ChatController，Studio 只是它的宿主） ────────────────

  chatView(): ChatView {
    return this.chat.chatView()
  }

  send(text: string): ChatView {
    return this.chat.send(text)
  }

  stop(): ChatView {
    return this.chat.stop()
  }

  clearChat(): ChatView {
    return this.chat.clear()
  }

  chatImage(id: string): Uint8Array | undefined {
    return this.chat.capture(id)
  }

  settingsView(): SettingsView {
    return this.chat.settingsView()
  }

  testConnection(input: TestConnectionInput): ReturnType<ChatController['testConnection']> {
    return this.chat.testConnection(input)
  }

  get agentSession(): AgentSession {
    return this.session
  }

  /** 新建一个空工程。 */
  newProject(volume?: Bounds): StudioState {
    this.session = new AgentSession({
      volume: volume ?? this.session.store.volume,
    })
    this.replay = new ReplaySession(this.session.store, this.session.log)
    this.projectPath = undefined
    this.projectName = '未命名项目'
    return this.state()
  }

  /** 打开一个 `.mcai`。 */
  async open(path: string): Promise<StudioState> {
    const bytes = await readFile(path)
    const { project, store } = openProject(new Uint8Array(bytes))
    // 必须把工程的调色板交给新会话——快照里的索引是相对这张表编的
    this.session = new AgentSession({
      volume: store.volume,
      minecraftVersion: project.manifest.minecraftVersion,
      palette: project.palette,
    })
    // 把打开的世界装进 session（复用它的日志与工具上下文）
    const target = this.session.store
    target.restoreColumns(store.dumpColumns(), project.manifest.baseRevision)
    for (const op of project.log.all()) this.session.log.append(op)
    target.setRevision(project.manifest.revision)
    this.replay = new ReplaySession(target, this.session.log)
    this.projectPath = path
    this.projectName = project.manifest.name
    return this.state()
  }

  /** 保存工程；省略路径时写回原位。 */
  async save(path?: string): Promise<string> {
    const target = path ?? this.projectPath
    if (target === undefined) throw new Error('没有指定保存路径')
    // 对话记录与截图一起进工程文件——`.mcai` 的价值有一半在这里
    const recording = this.chat.recording()
    const bytes = packProject({
      name: this.projectName,
      projectId: `01GUI${Date.now().toString(36).toUpperCase()}`,
      store: this.session.store,
      log: this.session.log,
      settings: { volume: this.session.store.volume },
      chat: recording.transcript,
      captures: recording.captures,
    })
    await writeFile(target, bytes)
    this.projectPath = target
    // 保存成功 = 基准推进：WAL 里这一段已经进了工程文件，不必再留着
    this.commitAutosave()
    return target
  }

  /** 当前状态快照。 */
  state(): StudioState {
    const store = this.session.store
    const stats = measure(store)
    const snapshot: StudioState = {
      name: this.projectName,
      minecraftVersion: store.registry.minecraftVersion,
      revision: store.revision,
      totalOps: this.session.log.length,
      blocks: stats.blocks,
      volume: opTuple(store.volume),
      paletteSize: store.palette.size,
      ops: this.session.log
        .all()
        .slice(-50)
        .map((op) => ({ rev: op.rev, tool: op.tool, changed: op.result.changed, ts: op.ts })),
      histogram: stats.histogram.slice(0, 8),
    }
    if (this.projectPath !== undefined) snapshot.projectPath = this.projectPath
    if (stats.bounds !== undefined) snapshot.bounds = opTuple(stats.bounds)
    const notice = this.takeNotice()
    if (notice !== undefined) snapshot.notice = notice
    return snapshot
  }

  /**
   * 在**世界被改动之后**重建回放会话。
   *
   * `ReplaySession` 的游标记录"已重放到第几版"。如果世界被外部写入（工具调用、示例生成），
   * 游标就与真实版本脱节了——此时向后 seek 会以为自己已经回退过，于是**不重建**，
   * 结果历史版本里混着未来的方块。写完重建是唯一安全的做法。
   */
  private resetReplay(): void {
    this.replay = new ReplaySession(this.session.store, this.session.log)
  }

  /** 生成一座示例小屋，让首次启动的界面不是空的。 */
  demo(): StudioState {
    const store = this.session.store
    const P = (name: string): number => store.palette.indexOf(name)
    const rect = [
      { x: 4, z: 4 },
      { x: 13, z: 4 },
      { x: 13, z: 13 },
      { x: 4, z: 13 },
    ]
    const record = (tool: string, args: unknown, run: () => ReturnType<typeof store.write>): void => {
      this.session.log.record(run(), { tool, args, correlationId: 'demo', source: 'user' })
    }

    record('extrude', { baseY: 0, height: 1, block: 'minecraft:oak_planks' }, () =>
      store.write((v) => forEachExtrude(rect, { baseY: 0, height: 1 }, v), P('minecraft:oak_planks'), {
        confirm: true,
      }),
    )
    record('extrude', { baseY: 1, height: 4, hollow: true }, () =>
      store.write(
        (v) => forEachExtrude(rect, { baseY: 1, height: 4, hollow: true, capTop: false, capBottom: false }, v),
        P('minecraft:stone_bricks'),
        { confirm: true },
      ),
    )
    record('erase', { from: [8, 1, 4], to: [8, 2, 4] }, () =>
      store.write((v) => forEachBox({ x: 8, y: 1, z: 4 }, { x: 8, y: 2, z: 4 }, 'solid', v), 0, {
        mode: 'destroy',
        confirm: true,
      }),
    )
    for (const [x, z] of [
      [4, 8],
      [13, 8],
    ] as const) {
      record('place_block', { pos: [x, 2, z], block: 'minecraft:glass' }, () =>
        store.write((v) => v(x, 2, z), P('minecraft:glass'), { confirm: true }),
      )
    }
    for (const z of [4, 13]) {
      record('fill_plane', { p3: [9, 9, 9] }, () =>
        store.write(
          (v) => forEachPlane({ x: 4, y: 5, z }, { x: 13, y: 5, z }, { x: 9, y: 9, z: 9 }, {}, v),
          P('minecraft:spruce_planks'),
          { confirm: true },
        ),
      )
    }
    record('fill_box', { from: [11, 5, 11], to: [11, 11, 11] }, () =>
      store.write(
        (v) => forEachBox({ x: 11, y: 5, z: 11 }, { x: 11, y: 11, z: 11 }, 'hollow', v),
        P('minecraft:bricks'),
        { confirm: true },
      ),
    )

    this.resetReplay()
    this.projectName = '示例小屋'
    return this.state()
  }

  /**
   * 跳转到历史版本。
   *
   * 用 `ReplaySession` 在事件日志上移动——向前是增量的，向后退才重建。
   */
  seek(revision: number): StudioState {
    this.replay.seek(revision)
    return this.state()
  }

  seekLatest(): StudioState {
    this.replay.seekLatest()
    return this.state()
  }

  /** 渲染一张截图（PNG 字节）。 */
  shoot(request: ShootRequest): { png: Uint8Array; view: string; revision: number } {
    const store = this.session.store
    const highlightLast = request.highlightLast !== false
    let highlight: Bounds | undefined
    if (highlightLast) {
      const last = this.session.log.at(this.session.log.length - 1)
      highlight = last?.patch.bounds()
    }

    const stats = measure(store)
    const bounds = stats.bounds
    const image = this.session.ctx.shoot({
      view: request.view,
      width: request.width,
      height: request.height,
      ...(highlight !== undefined ? { highlight } : {}),
      caption: [
        `REV ${store.revision}  BLOCKS ${stats.blocks}`,
        ...(bounds !== undefined
          ? [`BOUNDS ${bounds.min.x},${bounds.min.y},${bounds.min.z}..${bounds.max.x},${bounds.max.y},${bounds.max.z}`]
          : []),
      ],
    })
    return { png: image.png, view: image.camera, revision: image.revision }
  }

  /** 切片文本。 */
  slice(request: SliceRequest): string {
    const range: Record<string, [number, number]> = {}
    for (const axis of ['x', 'y', 'z'] as const) {
      const value = request[axis]
      if (value !== undefined) range[axis] = value
    }
    try {
      return renderSlice(this.session.store, {
        axis: request.axis,
        index: request.index,
        ...(Object.keys(range).length > 0 ? { range } : {}),
      }).text
    } catch (error) {
      return error instanceof Error ? `无法渲染切片：${error.message}` : String(error)
    }
  }

  // ── 导出 / 导入（M7） ──────────────────────────────────────────────────────
  //
  // 这一层只负责**算出字节**；文件对话框与写盘在 Electron 主进程里。
  // 分开的好处是这一层不依赖 Electron，可以直接被 vitest 测。

  /**
   * 导出成交换格式。返回**一组**文件——`.obj` 会附带 `.mtl`。
   *
   * 导出的是**当前 revision 的世界**，所以先在时间线上拖到某一版再导，
   * 就能把那个历史版本单独拿出来。
   */
  exportModel(
    format: ExportFormat,
    baseName: string,
  ): { files: Array<{ name: string; bytes: Uint8Array }>; summary: string } {
    const store = this.session.store
    const bounds = store.contentBounds()
    if (bounds === undefined) throw new Error('世界是空的，没有可导出的内容')
    const size: [number, number, number] = [
      bounds.max.x - bounds.min.x + 1,
      bounds.max.y - bounds.min.y + 1,
      bounds.max.z - bounds.min.z + 1,
    ]
    const stem = baseName.replace(/\.(schem|schematic|litematic|obj)$/i, '')

    if (format === 'schem') {
      const result = exportSchematic(store, {
        dataVersion: DATA_VERSION_1_21_4,
        metadata: { Name: this.projectName, Author: 'ArchItect' },
      })
      return {
        files: [{ name: `${stem}.schem`, bytes: result.bytes }],
        summary: `Sponge v3 · ${result.size.join('×')} · ${result.blocks} 方块`,
      }
    }

    if (format === 'litematic') {
      const bytes = exportLitematic(store, { name: this.projectName, author: 'ArchItect' })
      return {
        files: [{ name: `${stem}.litematic`, bytes }],
        summary: `Litematica v6 · ${size.join('×')}`,
      }
    }

    // `.obj`：用碰撞盒几何，颜色取自当前配色方案（plain 时是确定性兜底色）
    const resolve = this.session.colorResolver
    const result = exportObj(store, {
      mtlName: `${stem}.mtl`,
      colorOf: (state) => {
        const rgb = resolve(state)
        return rgb === undefined ? undefined : { r: rgb.r, g: rgb.g, b: rgb.b }
      },
    })
    const files: Array<{ name: string; bytes: Uint8Array }> = [
      { name: `${stem}.obj`, bytes: new TextEncoder().encode(result.obj) },
    ]
    if (result.mtl !== undefined) {
      files.push({ name: `${stem}.mtl`, bytes: new TextEncoder().encode(result.mtl) })
    }
    return {
      files,
      summary: `Wavefront · ${size.join('×')} · ${result.blocks} 方块 / ${result.faces} 面 / ${result.materials.length} 种材质`,
    }
  }

  /**
   * 读一个外部 schematic，**换成当前工程**继续编辑。
   *
   * 语义是"接管"而不是"贴进来"：导入一份外部文件通常是"我要在它基础上改",
   * 而不是"我要把它塞进现有建筑里"。所以工区按内容重建、历史清空。
   */
  async importModel(path: string): Promise<{
    state: StudioState
    summary: string
    unknown: Array<{ name: string; count: number; suggestions: string[] }>
    renamed: Array<{ from: string; to: string; count: number }>
    skipped: number
  }> {
    const { readFile } = await import('node:fs/promises')
    const bytes = new Uint8Array(await readFile(path))
    const isLitematic = path.toLowerCase().endsWith('.litematic')
    const data: SchematicData = isLitematic
      ? litematicToSchematicData(await readLitematic(bytes))
      : await readSpongeSchematic(bytes)

    // 工区刚好装下内容，另留 8 格便于继续扩建
    const [sx, sy, sz] = data.size
    const session = new AgentSession({
      volume: {
        min: { x: 0, y: 0, z: 0 },
        max: { x: Math.max(sx + 7, 15), y: Math.max(sy + 7, 15), z: Math.max(sz + 7, 15) },
      },
      plain: this.plain,
    })
    const result = importSchematicInto(session.store, data, { at: { x: 0, y: 0, z: 0 } })

    this.session = session
    this.replay = new ReplaySession(session.store, session.log)
    this.projectPath = undefined
    this.projectName = path.split('/').pop()?.replace(/\.(schem|schematic|litematic)$/i, '') ?? '导入的工程'
    this.chat.clear()

    return {
      state: this.state(),
      summary:
        `源 ${data.size.join('×')}${data.dataVersion !== undefined ? ` · DataVersion ${data.dataVersion}` : ''} · ` +
        `写入 ${result.placed} 格`,
      unknown: result.unknown,
      renamed: result.renamed,
      skipped: result.skipped,
    }
  }

  /** 直方图文本（给 UI 的材质面板用）。 */
  measureText(): string {
    const stats = measure(this.session.store)
    if (stats.bounds === undefined) return '世界是空的'
    const size = stats.size!
    return `尺寸 ${size.x}×${size.y}×${size.z}   方块 ${stats.blocks}`
  }
}
