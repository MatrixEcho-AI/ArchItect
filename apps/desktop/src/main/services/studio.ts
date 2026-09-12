import { readFile, writeFile } from 'node:fs/promises'

import { activeProvider, AgentSession, runAgent } from '@architect/agent'
import { t } from '@architect/i18n'
import type { DiscoveryResult, LlmImage, SessionOptions, ShotInput, ShotRenderer } from '@architect/agent'
import { forEachBox, forEachExtrude, forEachPlane, measure, renderSlice } from '@architect/core'
import type { Bounds, SliceAxis, WorldStore } from '@architect/core'
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
import {
  bakedColorTexturePack,
  Canvas,
  cameraBasis,
  clampFreeElevation,
  drawOverlayGrid,
  drawOverlays,
  fitCamera,
  loadRenderData,
  meshWorld,
  pickBlock,
  rasterize,
} from '@architect/render'
import type { CameraSpec, TexturePack, WorldGeometry } from '@architect/render'
import type { SessionCamera } from '@architect/tools'

import type { AutosaveService, PendingRecovery } from './autosave.js'
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
  ops: Array<{ rev: number; tool: string; changed: number; ts: string; source: string }>
  histogram: Array<{ block: string; count: number; percent: number }>
  /** 游标前面还有内容（可以撤销）。 */
  canUndo: boolean
  /** 游标后面还有内容（可以重做）。 */
  canRedo: boolean
  /**
   * 游标停在最新版本**之前**（用户拖了时间线，或撤销过）。
   *
   * 界面据此禁用发送框并说明原因：模型的新改动会从历史**分叉**，
   * 把后面的几步截断丢掉——那是用户的工作，不能默默丢。
   */
  behindTip: boolean
  /** 一次性的提示（崩溃恢复提醒之类）。读过就没了。 */
  notice?: string
  /**
   * **会话语义上的机位**（`set_camera` 或界面上的机位面板设的）。
   *
   * 它不是"用户现在看着什么"——那是渲染进程里的相机，主进程看不到也不该看。
   * 它表达的是"接下来让模型从哪看"。界面拿它回填机位面板，好让用户知道
   * 自己设的机位还在。
   */
  camera?: SessionCamera
  /**
   * 有一份**没保存进工程的草稿**等着处理（崩溃恢复）。
   *
   * 它只是"有这么回事 + 能不能恢复"，真正的动作是 `applyRecovery()` /
   * `discardRecovery()`。界面据此显示两个按钮，而不是只给一句话干看着。
   */
  recovery?: RecoverySummary
  /**
   * 当前用的**纹理来源**（"我看到的纹理是谁的"）。
   *
   * `kind` 是协议字段（minecraft / pack / baked / none），界面自己翻译；
   * `detail` 是路径或版本号。没有资源包时是 `baked`——形状与明暗照旧，
   * 只是每格一块纯色。用户在英文界面下看到的也必须能解释这件事。
   */
  texture: { kind: string; detail: string; fellBackFrom?: string }
}

/** 一条编辑记录的细节（`opDetail` 的返回值，直接序列化给界面）。 */
export interface OpDetail {
  rev: number
  id: string
  tool: string
  args: unknown
  ts: string
  source: string
  actor: string
  result: { changed: number; overwrittenNonAir: number; clipped: number }
}

/** 崩溃恢复的待办：界面上那两个按钮描述的就是它。 */
export interface RecoverySummary {
  /** 草稿里有几条 op。 */
  ops: number
  /** 基准工程（上次保存的那个文件）。 */
  basePath?: string
  /** 基准工程还在不在原处。不在就恢复不了，只能丢掉。 */
  baseExists: boolean
}

/** 能导出成什么。GUI 的"导出…"按扩展名推断，也可以让用户显式选。 */
export type ExportFormat = 'schem' | 'litematic' | 'obj'

/** 交互视口的背景色，与 `renderIsometric` 的默认值一致（拖动时不能闪烁变色）。 */
const VIEWPORT_BACKGROUND = { r: 26, g: 28, b: 34 }

/**
 * 默认渲染版本。与 `AgentSession` 的默认值一致——harness 目前只渲染 1.21.4
 * （工程文件里的 `minecraftVersion` 是给将来多版本用的；`DATA_VERSION_1_21_4` 是
 * 存档格式里的数字版本号，两者不是一回事）。
 */
const RENDER_VERSION = '1.21.4'

/** 提示里显示工程名而不是一整条路径：路径太长，面板上会被截掉一半。 */
function baseNameOf(path: string | undefined): string {
  if (path === undefined) return t('recovery.unknownProject')
  const parts = path.split(/[/\\]/)
  return parts[parts.length - 1] ?? path
}

export interface ShootRequest {
  view: string
  width: number
  height: number
  /** 高亮某个区域；省略时高亮最后一次编辑。 */
  highlightLast?: boolean
}

/**
 * 交互视口的一帧请求。
 *
 * 与 `ShootRequest` 的差别是相机**由用户给**（拖动出来的角度），而不是预设机位；
 * 并且没有高亮/说明文字——拖动时那些每帧都在变，视觉上只会晃。
 */
export interface ViewportRequest {
  /** 水平角（度）。 */
  azimuth: number
  /** 仰角（度），会被夹在 ±89 之间（90 度时 up 向量退化；负值 = 抬头）。 */
  elevation: number
  /** 绕视线轴的滚转（度）。机位面板能设，所以这条兜底路径也得支持。 */
  roll?: number
  /** 每格像素。省略表示"自动取景"。正交投影用；透视投影下由 `perspective` 决定。 */
  scale?: number
  /** 注视点。省略 = 内容包围盒中心（与 GPU 那条路同一套语义）。 */
  target?: [number, number, number]
  /**
   * 给了它 = **透视投影**（第一人称）：相机站在 `eye`，`fov` 是垂直视场角。
   *
   * 桌面视口走这条（D-76）；不给就是正交等轴测——模型截图、CLI、golden 走那条。
   * 两条路用的是同一个 `projectPoint` / 同一个光栅器，所以"用户看到的"与
   * "模型看到的"只差一个投影方式，不差一套渲染器。
   */
  perspective?: { eye: [number, number, number]; fov: number }
  width: number
  height: number
  /** 拖动中：用低分辨率快速出图，松手后再出一张全分辨率的。 */
  draft?: boolean
}

/**
 * 交互视口要的**几何 + 图集**，一次性发给渲染进程。
 *
 * three.js 与软件光栅器吃的是**同一份** mesher 输出（带 UV 的三角形），所以
 * 两边画出来的东西在几何上完全一致——差别只在抗锯齿、mipmap 与帧率。
 *
 * 顶点位置已经是世界坐标，渲染进程不需要再做任何变换。
 */
export interface ScenePayload {
  revision: number
  positions: Float32Array
  normals: Float32Array
  /** 逐顶点 AO × 生物群系着色。**方向明暗没烘进去**，由渲染进程按法线乘。 */
  colors: Float32Array
  uvs: Float32Array
  indices: Uint32Array
  atlas: { size: number; data: Uint8Array }
  bounds?: { min: [number, number, number]; max: [number, number, number] }
  volume: { min: [number, number, number]; max: [number, number, number] }
}

/** 拾取请求：视口里的一个像素 + 当时那个相机。 */
export interface PickRequest extends ViewportRequest {
  /** 视口内的像素坐标（左上角原点，CSS 像素）。 */
  x: number
  y: number
}

export interface PickResult {
  /** 命中的那一格（挖掉它）。 */
  block: [number, number, number]
  /** 贴着命中面外侧的那一格（放这里）。 */
  place: [number, number, number]
  normal: [number, number, number]
  /** 命中的那一格现在是什么（吸管 / 状态栏）。 */
  blockId: string
  /** 放置目标在不在工区里。不在时界面直接拦下，不用等主进程报错。 */
  placeInVolume: boolean
}

export interface EditBlockRequest {
  pos: [number, number, number]
  /** `place` 时要放什么；`break` 时忽略。 */
  block?: string
  mode: 'place' | 'break'
}

export interface ViewportFrame {
  /** 原始 RGBA，长度 = width*height*4。 */
  pixels: Uint8Array
  width: number
  height: number
  revision: number
  /** 本次实际用的缩放与取景中心，回给界面显示。 */
  scale: number
  target: [number, number, number]
  /** 网格化是否命中了缓存（没命中说明这一帧把网格重建了一遍）。 */
  meshed: boolean
  ms: number
}

export interface SliceRequest {
  axis: SliceAxis
  index: number
  x?: [number, number]
  y?: [number, number]
  z?: [number, number]
}

/**
 * 渲染进程侧的 GPU 截图通道（主进程 → 渲染进程 → 主进程）。
 *
 * 返回 PNG 字节；返回 `undefined` 表示"这一枪画不了"（窗口没了、渲染进程还没就绪、
 * 它的场景版本对不上）。**调用方必须能接受 `undefined`**：截图是模型的眼睛，
 * 拿不到 GPU 就退回软件光栅器，绝不让 `screenshot` 直接失败。
 */
export interface ShotBridge {
  capture(input: ShotInput): Promise<Uint8Array | undefined>
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
  /** GPU 截图通道。省略时（测试、无窗口）全部走软件光栅器。 */
  shots?: ShotBridge
  /**
   * 纹理从哪儿来：**宿主解析好之后传进来**（桌面端给的是内置资源包，
   * 见 `apps/desktop/src/main/index.ts`；测试与无头场景给的是烘焙平均色）。
   *
   * 之所以由宿主解析、而不是这里自己去 import `minecraft-assets`：
   * 那个包必须被 esbuild 标成 external，只有宿主知道该怎么引它。
   * `plain` 时忽略它——那一路完全不用纹理（golden 测试要的是确定性）。
   */
  textures?: TexturePack
  /**
   * 按工程版本解析资源包的函数（打开别的版本工程时用）。
   * 省略时 `textures` 就一直用同一个包。
   */
  texturePackFor?: (version: string) => TexturePack
}

export class StudioService {
  private session: AgentSession
  /** 交互视口的网格缓存，见 `viewport()`。revision 一变就失效。 */
  private meshCache?: { revision: number; geometry: WorldGeometry }
  private projectPath?: string
  /**
   * 上一次推给界面的 op 条数（`revision` 事件用）。
   *
   * `undefined` = 这一轮还没推过：那时**不比较**，直接把当下当基准。见 `onToolResult`。
   */
  private pushedOps?: number
  private projectName = t('desktop.untitledProject')
  readonly chat: ChatController
  private emit: (event: StudioEvent) => void = () => {}
  private readonly plain: boolean
  /** 项目默认的渲染版本（打开工程时会用工程自己的版本覆盖）。 */
  private readonly minecraftVersion: string
  /** 宿主给的资源包（`plain` 时不看它）。 */
  private readonly textures: TexturePack | undefined
  /** 按版本解析资源包的函数（宿主注入）。 */
  private readonly texturePackFor: ((version: string) => TexturePack) | undefined
  /** 每个版本解析一次（解压客户端 jar 要几百毫秒，不能每帧一次）。 */
  private readonly texturesByVersion = new Map<string, TexturePack>()
  private autosave?: AutosaveService
  /** 渲染进程侧的 GPU 截图通道。由 `attachShotBridge` 在窗口就绪后接上。 */
  private shots?: ShotBridge
  /** 启动时从 WAL 恢复出来的提示（没有恢复过就是 undefined）。 */
  private notice: string | undefined
  /** 等着用户处理的那份草稿。"恢复"或"丢掉"之后就没有了。 */
  private draft: PendingRecovery | undefined

  constructor(options: StudioOptions = {}) {
    this.plain = options.plain ?? false
    this.shots = options.shots
    this.minecraftVersion = options.minecraftVersion ?? RENDER_VERSION
    this.textures = options.textures
    this.texturePackFor = options.texturePackFor
    const volume = options.volume ?? { min: { x: 0, y: 0, z: 0 }, max: { x: 31, y: 31, z: 31 } }
    this.session = this.openSession({
      volume,
      ...(options.minecraftVersion !== undefined ? { minecraftVersion: options.minecraftVersion } : {}),
      plain: options.plain ?? false,
    })

    this.chat = new ChatController(
      options.chat ?? { secrets: createMemorySecretStore() },
      // 每轮都重新读 this.session：newProject/open 会把它换成新的
      async (goal, provider, onEvent, shouldStop, history, pendingMutations) => {        // 用户设的花费上限要**真的刹车**，不能只记账。价格表来自当前 provider。
        const settings = this.chat.settingsValue
        const active = activeProvider(settings)
        const cost = active?.cost
        const state = await runAgent(
          {
            provider,
            registry: this.session.registry,
            ctx: this.session.ctx,
            system: this.session.buildSystem(),
            stateLine: this.session.buildStateLine(),
            // 上一轮的对话与闸门状态一起接上：模型记得刚才发生了什么，
            // 也不会因为"换了一轮"就把没读回的改动当成已完成
            history,
            pendingMutations,
            onEvent,
            shouldStop,
            // 用户随这句话附的图（插入的图片 / 采集的视口那一枪）。挂在本次需求那条
            // user 消息上，所以模型这一轮就能直接看到，不用先调 screenshot。
            ...(goal.images.length > 0 ? { images: goal.images } : {}),
            ...(settings.budget !== undefined ? { budget: settings.budget } : {}),
            ...(cost !== undefined ? { costTable: cost } : {}),
            // 上下文策略由 provider 能力决定（§9.2）：本地模型没有前缀缓存，
            // 不切窗口的话每个请求都要把整段历史全价重算一遍
            ...(active !== undefined ? { capabilities: active.capabilities } : {}),
          },
          goal.text,
        )
        return {
          stopReason: state.stopReason,
          ...(state.error !== undefined ? { error: state.error } : {}),
          usage: state.usage,
          // 下一轮原样接在这后面（append-only：前缀不稳，缓存就全废）
          messages: state.messages,
          pendingMutations: state.pendingMutations,
        }
      },
    )
    // 世界被改动之后必须重建回放游标，否则向后 seek 会以为自己已经回退过
    this.chat.onAfterRun(() => {
      // 一轮结束时把这一步的 op 落进 WAL：agent 停下来时状态一定是齐的
      this.autosaveNow()
      // 全量 state 已经把这些 op 带过去了，基准一起跟上——
      // 不跟的话下一轮第一次工具调用会推一条内容没变的 `revision`，界面白闪一下
      this.pushedOps = this.session.log.length
      this.emit({ type: 'state', state: this.state() })
    })
    /**
     * **工具每写完一次，就把新版本推给界面**（不再等整轮结束）。
     *
     * 用户的原话："模型在调用工具之后请即刻在 rev 里添加上，而不是等到模型完成整个
     * 过程一次性全部加进来。" 一轮里模型可能连着调十几次工具，全都挤在最后那一下
     * 出现，中间那段时间界面看着就像什么都没发生——而世界其实一直在变。
     *
     * 判据是 `EditLog` 的长度**有没有真的变**，不是"这个工具看起来像写操作"：
     * `verify` 之类的读操作也会走这条回调，而拿工具名去猜迟早会错（`run_batch` /
     * `fill_line` / 将来新加的工具都会漏）。写过没写过，日志最清楚。
     *
     * 这里**只发轻量的 `revision`**，不发完整 `state`——后者要 `measure()` 一遍全部
     * 方块，而一次 `run_batch` 就能写几千格。统计数、直方图、包围盒由一轮结束时的
     * `state` 给全量。见 `StudioEvent` 里 `revision` 那一段。
     */
    this.chat.onToolResult(() => {
      const total = this.session.log.length
      if (this.pushedOps !== undefined && total === this.pushedOps) return
      this.pushedOps = total
      this.emit({ type: 'revision', ...this.revisionProgress() })
    })
  }

  /** `revision` 事件的内容：版本号、op 数、以及最近那几条 op（左栏记录要立刻长出来）。 */
  private revisionProgress(): {
    revision: number
    totalOps: number
    behindTip: boolean
    ops: Array<{ rev: number; tool: string; changed: number; ts: string; source: string }>
  } {
    return {
      revision: this.session.store.revision,
      totalOps: this.session.log.length,
      behindTip: !this.session.history.atTip,
      ops: this.session.log
        .all()
        .slice(-50)
        .map((op) => ({
          rev: op.rev,
          tool: op.tool,
          changed: op.result.changed,
          ts: op.ts,
          source: op.source,
        })),
    }
  }

  /** 接上自动保存。省略时（测试里）不做任何写盘。 */
  attachAutosave(service: AutosaveService): void {
    this.autosave = service
  }

  /**
   * 建一个会话。**所有会话都必须走这里**——否则换了工程之后，新会话就悄悄
   * 丢掉 GPU 截图通道，退回软件光栅器，而这种退化在界面上只表现为"图忽然变糊了"。
   */
  private openSession(options: Omit<SessionOptions, 'render' | 'textures'>): AgentSession {
    const version = options.minecraftVersion ?? this.minecraftVersion
    return new AgentSession({ ...options, textures: this.texturePack(version), render: this.gpuShot() })
  }

  /**
   * 解析（并缓存）某个版本的纹理来源。
   *
   * `plain` 会话固定用**烘好的平均色**：确定性、不依赖这台机器上有没有装 Minecraft，
   * 这正是 CI 与 golden 测试要的。其余情况按设置来（默认自动找 `.minecraft`）。
   */
  private texturePack(version: string): TexturePack {
    const cached = this.texturesByVersion.get(version)
    if (cached !== undefined) return cached
    // `plain`（测试/CI）固定用烘好的平均色：确定性，不依赖这台机器上有什么资源
    const pack = this.plain
      ? bakedColorTexturePack(version)
      : (this.texturePackFor?.(version) ?? this.textures ?? bakedColorTexturePack(version))
    this.texturesByVersion.set(version, pack)
    return pack
  }

  /**
   * 当前用的纹理来源（界面显示"我看到的纹理是谁的"）。
   *
   * `fellBackFrom` 有值时说明用户要的来源没找到——界面要如实说出来，
   * 否则"我明明装了资源包"会变成一个没人能解释的现象。
   */
  textureInfo(): { kind: string; detail: string } {
    const version = this.session.store.registry.minecraftVersion
    const pack = this.texturePack(version)
    return { kind: pack.kind, detail: pack.detail }
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
   * 启动时检查 WAL 里有没有上一轮没保存的改动。
   *
   * **只登记，不动手**：恢复会改变世界、会打开另一个文件，那是要用户点头的事。
   * 之前这里只写一句提示，而提示里说的"打开那个工程即可在此基础上继续"
   * **代码里根本做不到**——草稿躺在磁盘上没人重放，用户以为能拿回来，其实拿不回来。
   * 现在提示与动作都在：`state().recovery` 给界面两个按钮，动作落在下面两个方法上。
   *
   * 只在上次保存过的工程**还在原处**时才谈得上恢复——基准丢了就说不清
   * "恢复出来的是什么"，那种情况宁可如实说明也不要硬凑。
   */
  recover(): RecoverySummary | undefined {
    if (this.autosave === undefined) return undefined
    const pending = this.autosave.pending()
    if (pending === undefined) return undefined
    this.draft = pending

    const basePath = pending.header.projectPath
    if (!pending.baseExists) {
      this.notice = t('recovery.missingBase', {
        ops: pending.ops.length,
        project: basePath !== undefined ? t('recovery.parenthesized', { value: basePath }) : '',
      })
    } else {
      this.notice = t('recovery.found', { ops: pending.ops.length, project: baseNameOf(basePath) })
    }
    return this.recoverySummary()
  }

  /** 界面要显示的恢复待办（没有待办就是 `undefined`）。 */
  private recoverySummary(): RecoverySummary | undefined {
    const draft = this.draft
    if (draft === undefined) return undefined
    const summary: RecoverySummary = { ops: draft.ops.length, baseExists: draft.baseExists }
    if (draft.header.projectPath !== undefined) summary.basePath = draft.header.projectPath
    return summary
  }

  /**
   * 真的把草稿恢复出来。
   *
   * 三步，顺序不能换：
   *
   * 1. **打开基准工程**——不是"当前打开的那个"，草稿属于它自己的那个文件；
   * 2. 把游标推到**日志末端**：`.mcai` 可能留着一段重做分支（保存时游标在中间），
   *    而草稿里的 op 是接在日志末端之后编号的。崩溃之后"当时游标在哪"已经无从
   *    判断，这里**以内容为准**：恢复到日志末端（见 D-69）；
   * 3. 逐条重放草稿里的 op，再把游标设到**最后一条 op 自己的 `rev`**——
   *    用编号而不是算术推导，编号是唯一的真相（D-57）。
   */
  async applyRecovery(): Promise<StudioState> {
    const draft = this.draft
    if (draft === undefined) return this.state()
    const basePath = draft.header.projectPath
    if (!draft.baseExists || basePath === undefined) {
      this.notice = t('recovery.cannotApply')
      return this.state()
    }

    await this.open(basePath)
    const store = this.session.store
    const log = this.session.log
    store.setRevision(log.length)
    for (const op of draft.ops) {
      store.applyPatch(op.patch)
      log.append(op)
    }
    const last = draft.ops[draft.ops.length - 1]
    if (last !== undefined) store.setRevision(last.rev)

    this.draft = undefined
    // 草稿已经进世界了：基准推到最新，免得同一个文件被恢复第二次
    this.autosave?.clear(log.length)
    this.notice = t('recovery.appliedNotice', { ops: draft.ops.length, project: baseNameOf(basePath) })
    return this.state()
  }

  /** 用户说"这份草稿不要了"。 */
  discardRecovery(): StudioState {
    if (this.draft === undefined) return this.state()
    const dropped = this.draft.ops.length
    this.draft = undefined
    this.autosave?.discard()
    this.notice = t('recovery.discardedNotice', { ops: dropped })
    return this.state()
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

  /**
   * 发一条对话。
   *
   * **游标不在最新时拒绝**。用户在时间线上翻到 rev 3 看着呢，这时让模型动手，
   * 它的第一笔写入就会把 rev 4..N 截断丢掉——那是用户的工作，不能默默丢。
   * 模型自己在运行中调 `undo` 造成的历史游标是另一回事：那一笔"撤销"是它自己做的，
   * 它接着改就是正常的"撤销后换个做法"。
   */
  send(text: string, attachments?: readonly LlmImage[]): ChatView {
    const history = this.session.history
    if (!history.atTip) {
      this.notice = t('chat.behindTipDetail', {
        rev: history.revision,
        total: history.length,
        lost: history.length - history.revision,
      })
      // 立刻推一次状态：提示要马上看得见，不能等下一次世界变化
      this.emit({ type: 'state', state: this.state() })
      return this.chat.chatView()
    }
    return this.chat.send(text, attachments)
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

  /**
   * 用户附图的字节（界面画缩略图用）。
   *
   * 与 `chatImage` 分开一条：`chat:image` 走的是**截图**表，历史里那些用户附图
   * 不在那一张表里（见 `ChatController.attachments` 的注释）。
   */
  chatAttachment(id: string): LlmImage | undefined {
    return this.chat.attachment(id)
  }

  /** 收下一张用户附图，返回内容寻址的 id（`send` 与"插入图片"两条路都走它）。 */
  storeChatAttachment(image: { png: Uint8Array; mimeType: string }): string {
    return this.chat.storeAttachment(image)
  }

  settingsView(): SettingsView {
    return this.chat.settingsView()
  }

  testConnection(input: TestConnectionInput): ReturnType<ChatController['testConnection']> {
    return this.chat.testConnection(input)
  }

  /**
   * 启动时给"还没测过能力"的当前 provider 补一次探针。
   *
   * 返回 `undefined` 表示不需要补测（没有 provider / 已经测过 / 用户手填过）。
   * 调用方负责落盘——和 `settings:test` 那条通道一样，设置文件只有一个写入口。
   */
  async probeUnmeasured(): Promise<DiscoveryResult | undefined> {
    const config = this.chat.unmeasuredProvider()
    if (config === undefined) return undefined
    return this.chat.testConnection({
      preset: config.preset,
      baseURL: config.baseURL,
      apiKeyRef: config.apiKeyRef,
      model: config.model,
    })
  }

  get agentSession(): AgentSession {
    return this.session
  }

  /** 新建一个空工程。 */
  newProject(volume?: Bounds): StudioState {
    this.session = this.openSession({
      volume: volume ?? this.session.store.volume,
    })
    this.projectPath = undefined
    this.projectName = t('desktop.untitledProject')
    /**
     * **新工程 = 新对话。**
     *
     * 少了这一句的症状很具体：新建之后左栏、时间线都归零了，右边却还挂着上一座建筑
     * 的 22 条消息，而且**下一轮模型还记得它们**（`clear()` 会一并清掉
     * `modelHistory`，所以这不是"只清显示"）。
     *
     * `clear()` 自己会 emit 一个 `chat` 事件，界面跟着更新——不需要在这里多推一次。
     */
    this.chat.clear()
    /**
     * **必须自己推一次 `state`。**
     *
     * `onEvent(listener)` 把 `this.emit` 与 `chat.onEvent` 接在**同一个** listener 上，
     * 所以 `chat.clear()` 的 `chat` 事件能到界面——这也正是"对话清了、左栏没清"
     * 那个现象的来源：`clear()` 推的是 `{type:'chat'}`，而**没有任何人推 `{type:'state'}`**。
     *
     * 返回值只对调用方（IPC handler）有用，推给界面是**另一件事**：
     * 按下"新建"的如果是界面自己，它当然可以拿返回值去 setState；
     * 但只要还有第二条调用路径（诊断脚本、菜单项、快捷键），就会漏。
     * 让状态变化本身广播出去，比要求每个调用点都记得刷新可靠。
     */
    this.emit({ type: 'state', state: this.state() })
    return this.state()
  }

  /** 打开一个 `.mcai`。 */
  async open(path: string): Promise<StudioState> {
    const bytes = await readFile(path)
    const { project, store } = openProject(new Uint8Array(bytes))
    // 必须把工程的调色板交给新会话——快照里的索引是相对这张表编的
    this.session = this.openSession({
      volume: store.volume,
      minecraftVersion: project.manifest.minecraftVersion,
      palette: project.palette,
      // 模型写的设计笔记跟着工程走：重开之后它不该失忆（§9.2 阶段摘要）
      ...(project.manifest.designNotes !== undefined
        ? { designNotes: project.manifest.designNotes }
        : {}),
    })
    // 把打开的世界装进 session（复用它的日志与工具上下文）
    const target = this.session.store
    target.restoreColumns(store.dumpColumns(), project.manifest.baseRevision)
    for (const op of project.log.all()) this.session.log.append(op)
    target.setRevision(project.manifest.revision)
    this.projectPath = path
    this.projectName = project.manifest.name
    // 对话记录是工程文件的一半：打开时把它接回界面（消息、截图、用量）
    this.chat.load(project.chat, project.captures)
    return this.state()
  }

  /** 保存工程；省略路径时写回原位。 */
  async save(path?: string): Promise<string> {
    const target = path ?? this.projectPath
    if (target === undefined) throw new Error(t('desktop.noSavePath'))
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
      ...(this.session.currentDesignNotes !== undefined
        ? { designNotes: this.session.currentDesignNotes }
        : {}),
    })
    await writeFile(target, bytes)
    this.projectPath = target
    // 保存成功 = 基准推进：WAL 里这一段已经进了工程文件，不必再留着
    this.commitAutosave()
    return target
  }

  /**
   * 一条编辑记录的细节（界面点开某一步看）。
   *
   * 为什么单独开一条通道而不是塞进 `state()`：`args` 可能是个很大的多边形/区域参数，
   * 而 `state()` 每次编辑都会被推一遍。这里按需取一条，代价与用户点了几次成正比。
   */
  opDetail(rev: number): OpDetail | undefined {
    const op = this.session.log.byRevision(rev)
    if (op === undefined) return undefined
    return {
      rev: op.rev,
      id: op.id,
      tool: op.tool,
      args: op.args,
      ts: op.ts,
      source: op.source,
      actor: op.actor,
      result: op.result,
    }
  }

  /** 当前状态快照。 */
  state(): StudioState {
    const store = this.session.store
    const stats = measure(store)
    const snapshot: StudioState = {
      name: this.projectName,
      minecraftVersion: store.registry.minecraftVersion,
      // 纹理来源：界面要能回答"我看到的纹理是谁的"
      texture: this.textureInfo(),
      revision: store.revision,
      totalOps: this.session.log.length,
      blocks: stats.blocks,
      volume: opTuple(store.volume),
      paletteSize: store.palette.size,
      ops: this.session.log
        .all()
        .slice(-50)
        .map((op) => ({
          rev: op.rev,
          tool: op.tool,
          changed: op.result.changed,
          ts: op.ts,
          // 谁改的：界面上"模型改的"和"我改的"要能一眼分开
          source: op.source,
        })),
      histogram: stats.histogram.slice(0, 8),
      // 撤销/重做是**游标移动**，所以这两个是"游标前后还有没有内容"，
      // 不是"世界内部的栈里还有没有东西"。界面据此灰掉按钮。
      canUndo: this.session.history.canUndo,
      canRedo: this.session.history.canRedo,
      // 游标落在最新版本**之前**：此时再让模型改，就是从历史分叉（会丢后面几步）
      behindTip: !this.session.history.atTip,
    }
    if (this.projectPath !== undefined) snapshot.projectPath = this.projectPath
    if (stats.bounds !== undefined) snapshot.bounds = opTuple(stats.bounds)
    if (this.session.ctx.camera !== undefined) snapshot.camera = this.session.ctx.camera
    const recovery = this.recoverySummary()
    if (recovery !== undefined) snapshot.recovery = recovery
    const notice = this.takeNotice()
    if (notice !== undefined) snapshot.notice = notice
    return snapshot
  }

  /**
   * 设置/清除**会话语义上的机位**（界面上的机位面板走这里）。
   *
   * 和 `set_camera` 工具写的是同一个字段，于是"用户在界面上拖到的角度"和
   * "模型接下来从哪看"可以是同一个机位——人机共用机位。
   *
   * 传 `null` 表示复原：之后的截图回到默认预设。
   */
  setCamera(camera: SessionCamera | null): StudioState {
    if (camera === null || Object.keys(camera).length === 0) delete this.session.ctx.camera
    else this.session.ctx.camera = camera
    return this.state()
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
    // 走会话的 `applyEdit` 而不是自己 `log.record`：那条路会校验
    // "游标 / 日志长度 / op 编号"三者一致，自己拼很容易少传一项
    const record = (tool: string, args: unknown, run: () => ReturnType<typeof store.write>): void => {
      this.session.applyEdit(tool, args, run)
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

    this.projectName = t('desktop.demoProjectName')
    return this.state()
  }

  /**
   * 跳转到历史版本。
   *
   * 用 `ReplaySession` 在事件日志上移动——向前是增量的，向后退才重建。
   */
  seek(revision: number): StudioState {
    this.session.history.seek(revision)
    return this.state()
  }

  seekLatest(): StudioState {
    this.session.history.seekLatest()
    return this.state()
  }

  /**
   * **撤销**：游标退一格 + 重放（plan §6）。不进日志，所以时间线、重放、
   * `.mcai` 往返全都保持一致。
   */
  undo(): StudioState {
    this.session.history.undo()
    return this.state()
  }

  /** **重做**：游标进一格。只在撤销之后有意义。 */
  redo(): StudioState {
    this.session.history.redo()
    return this.state()
  }

  /**
   * 渲染一张截图（PNG 字节）。
   *
   * **异步**：桌面端默认把这一枪交给渲染进程里的 three.js（走一趟 IPC 拿 PNG），
   * 拿不到（窗口没起来、渲染进程挂了、revision 对不上）才在这里用软件光栅器画。
   * 两条路共用同一份相机与叠加层，所以构图、标尺、高亮框完全对齐。
   */
  async shoot(request: ShootRequest): Promise<{ png: Uint8Array; view: string; revision: number }> {
    const store = this.session.store
    const highlightLast = request.highlightLast !== false
    let highlight: Bounds | undefined
    if (highlightLast) {
      const last = this.session.log.at(this.session.log.length - 1)
      highlight = last?.patch.bounds()
    }

    const stats = measure(store)
    const bounds = stats.bounds
    const image = await this.session.ctx.shoot({
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

  /**
   * **采集当前视口**，作为用户附图交给模型。
   *
   * 相机由**渲染进程**给（`request.camera`）：拖到哪个角度、WASD 走到哪儿，采到的
   * 就是那个机位。相机只活在渲染进程里，所以这一步必须由它发起——主进程单独去
   * `studio.shoot()` 只能拿到一个预设机位，那不是用户屏幕上看到的东西。
   *
   * 与 `studio.shoot` 复用同一条链（`ctx.shoot` → 渲染进程的 three.js，拿不到才
   * 回落软件光栅器），所以构图、标尺、高亮框与 `screenshot` 工具完全一致。
   */
  async grabViewport(request: {
    camera: CameraSpec
    view: string
    width: number
    height: number
  }): Promise<{ png: Uint8Array; view: string; revision: number }> {
    const store = this.session.store
    const stats = measure(store)
    const bounds = stats.bounds
    const last = this.session.log.at(this.session.log.length - 1)
    const highlight = last?.patch.bounds()
    const image = await this.session.ctx.shoot({
      // **原样透传**：渲染进程给的就是它此刻用的那份相机（可能带 perspective），
      // 所以采到的画面和用户屏幕上的那一帧同源。
      camera: request.camera,
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

  /** 主进程侧的 GPU 截图通道。取不到就返回 `undefined`，会话会退回软件光栅器。 */
  attachShotBridge(bridge: ShotBridge): void {
    this.shots = bridge
  }

  /** 上一次截图有没有回落、为什么。界面拿它显示一行状态。 */
  get renderFallback(): string | undefined {
    return this.session.renderFallback
  }

  /**
   * 把一枪交给渲染进程里的 three.js。
   *
   * 几何不在这里传：渲染进程自己按 `revision` 拉 `studio:scene`（那份数据本来就
   * 按 revision 缓存着）。所以过 IPC 的只有一个很小的 `ShotInput`，
   * 大头的顶点数据不会被复制第二遍。
   *
   * **`plain` 会话强制走软件路径**：three.js 那条路只有纹理渲染，
   * 没有"平均色快路径"，而 `plain` 的存在理由就是逐字节可复现（golden 测试）。
   * 让它落到 GPU 上会把确定性一起丢掉。
   */
  private gpuShot(): ShotRenderer {
    return async (input) => {
      const bridge = this.shots
      if (bridge === undefined || !input.textured) return undefined
      const png = await bridge.capture({
        camera: input.camera,
        view: input.view,
        revision: input.revision,
        width: input.width,
        height: input.height,
        overlays: input.overlays,
        textured: input.textured,
      })
      if (png === undefined) return undefined
      return { png, width: input.width, height: input.height, camera: input.view, revision: input.revision }
    }
  }

  /**
   * 交互视口的一帧。
   *
   * **为什么要缓存网格**：拖动时每一帧都要重画，而"把 3 万格翻译成带 UV 的三角形"
   * 比光栅化贵一个量级（实测 32³ 的灯塔：网格化 ~180 ms，光栅化 ~30 ms）。
   * 网格只跟 revision 有关、与相机无关——所以按 revision 缓存，拖动时只剩光栅化，
   * 这才可能到"跟手"的帧率。
   *
   * **为什么返回原始 RGBA 而不是 PNG**：拖动时每帧编码一次 PNG（~20 ms）再在
   * 渲染进程解码一次，纯属白花；`putImageData` 直接吃 RGBA。
   * 代价是每帧要走 ~2.5 MB 的结构化克隆，比 PNG 往返更快也更简单。
   */
  /**
   * 视口相机的**唯一**构造处。
   *
   * `viewport()` / `pick()` 共用它。这不是省几行代码的事：拾取要答的是
   * "你点的那个像素下面是哪一格"，而"哪个像素画的是哪一格"完全由这个相机决定。
   * 各建一个相机，两边就会以"差一格"的形式飘开——而且只在某些角度才飘。
   */
  private viewportCamera(request: ViewportRequest): CameraSpec {
    const bounds = this.session.store.contentBounds() ?? this.session.store.volume
    const azimuth = request.azimuth
    // 交互相机允许抬头（±89）：用户自己看的这台相机不是"把建筑拍进画面"，
    // 它是"站在世界里看"，所以和模型那条路（1..89）用不同的夹法（见 FREE_ELEVATION_LIMIT）
    const elevation = clampFreeElevation(request.elevation)
    const roll = request.roll ?? 0
    // `scale` 省略 = 自动取景：每帧都按当前角度重新取景，转起来不会跑出画面
    const fitted = fitCamera(bounds, { azimuth, elevation }, request.width, request.height)
    const scale = request.scale ?? fitted.scale
    // 自定义注视点只挪画面中心，不改缩放——和 GPU 那条路（`Viewport.render`）口径一致
    const target = request.target
    const eye = request.perspective
    return {
      ...fitted,
      azimuth,
      elevation,
      roll,
      scale,
      ...(target !== undefined ? { target: { x: target[0], y: target[1], z: target[2] } } : {}),
      // 透视：相机位置**由渲染进程给**（用户走到哪儿就是哪儿），主进程不重新取景
      ...(eye !== undefined
        ? {
            perspective: {
              eye: { x: eye.eye[0], y: eye.eye[1], z: eye.eye[2] },
              fov: eye.fov,
            },
          }
        : {}),
    }
  }

  /** 当前版本的网格，按 revision 缓存。绘图、截图、拾取都吃这一份。 */
  private geometryFor(store: WorldStore): { geometry: WorldGeometry; meshed: boolean } {
    if (this.meshCache !== undefined && this.meshCache.revision === store.revision) {
      return { geometry: this.meshCache.geometry, meshed: false }
    }
    const data = loadRenderData(store.registry.minecraftVersion, this.texturePack(store.registry.minecraftVersion))
    const geometry = meshWorld(store, data)
    this.meshCache = { revision: store.revision, geometry }
    return { geometry, meshed: true }
  }

  viewport(request: ViewportRequest): ViewportFrame {
    const started = Date.now()
    const store = this.session.store
    const bounds = store.contentBounds() ?? store.volume
    const camera = this.viewportCamera(request)
    const { azimuth, elevation } = camera
    const roll = camera.roll ?? 0

    const data = loadRenderData(store.registry.minecraftVersion, this.texturePack(store.registry.minecraftVersion))
    const { geometry, meshed } = this.geometryFor(store)

    const canvas = new Canvas(request.width, request.height, VIEWPORT_BACKGROUND)
    const basis = cameraBasis(camera)
    if (!request.draft) {
      drawOverlayGrid(canvas, camera, basis, bounds, { ruler: true, axisGizmo: true, volumeBox: store.volume })
    }
    rasterize(geometry, { camera, atlas: data.atlas, canvas })
    if (!request.draft) {
      drawOverlays(canvas, camera, basis, bounds, {
        ruler: true,
        axisGizmo: true,
        volumeBox: store.volume,
        caption: [
          `REV ${store.revision}  AZ ${azimuth.toFixed(0)}  EL ${elevation.toFixed(0)}${roll !== 0 ? `  RL ${roll.toFixed(0)}` : ''}`,
          `BOUNDS ${bounds.min.x},${bounds.min.y},${bounds.min.z}..${bounds.max.x},${bounds.max.y},${bounds.max.z}`,
        ],
      })
    }

    return {
      pixels: canvas.data,
      width: request.width,
      height: request.height,
      revision: store.revision,
      scale: camera.scale,
      target: [camera.target.x, camera.target.y, camera.target.z],
      meshed,
      ms: Date.now() - started,
    }
  }

  /**
   * 给 three.js 视口的几何快照。
   *
   * 网格按 revision 缓存（和 `viewport()` 共用同一份），所以拖动/换版本时
   * 只有版本真的变了才会重新网格化。图集也只在第一次发（4 MB）。
   */
  scene(): ScenePayload {
    const store = this.session.store
    const data = loadRenderData(store.registry.minecraftVersion, this.texturePack(store.registry.minecraftVersion))
    const { geometry } = this.geometryFor(store)
    const bounds = store.contentBounds()
    return {
      revision: store.revision,
      positions: geometry.positions,
      normals: geometry.normals,
      colors: geometry.colors,
      uvs: geometry.uvs,
      indices: geometry.indices,
      atlas: { size: data.atlas.size, data: data.atlas.data },
      ...(bounds !== undefined
        ? { bounds: { min: [bounds.min.x, bounds.min.y, bounds.min.z], max: [bounds.max.x, bounds.max.y, bounds.max.z] } }
        : {}),
      volume: {
        min: [store.volume.min.x, store.volume.min.y, store.volume.min.z],
        max: [store.volume.max.x, store.volume.max.y, store.volume.max.z],
      },
    }
  }

  /**
   * **屏幕像素 → 世界里的那一格**（人手接管：点哪儿改哪儿）。
   *
   * 相机走 `viewportCamera`、几何走 `geometryFor`，和画面上看到的那一帧是同一份——
   * 这是"点到的格子 = 看到的格子"的全部依据。
   *
   * 没有屏幕射线命中任何三角形时返回 `undefined`（点到天空）。
   */
  pick(request: PickRequest): PickResult | undefined {
    const store = this.session.store
    const camera = this.viewportCamera(request)
    const { geometry } = this.geometryFor(store)
    const hit = pickBlock(geometry, camera, request.x, request.y)
    if (hit === undefined) return undefined

    const cell = { x: hit.block.x, y: hit.block.y, z: hit.block.z }
    const inside = store.contains(cell)
    return {
      block: [hit.block.x, hit.block.y, hit.block.z],
      place: [hit.place.x, hit.place.y, hit.place.z],
      normal: [hit.normal.x, hit.normal.y, hit.normal.z],
      /** 命中的那一格现在是什么（吸管与状态栏用）。 */
      blockId: inside ? store.getBlockString(cell) : 'minecraft:air',
      /** 放置目标在工区内吗？不在的话界面直接拦下，不用等主进程报错。 */
      placeInVolume: store.contains(hit.place),
    }
  }

  /**
   * **人改一格**：放置或挖掉。
   *
   * 走 `session.applyEdit`，所以它和模型改的**完全同权**：进日志（`source: 'user'`）、
   * 能被撤销、能被时间线回放、能导出、能存进 `.mcai`。
   * 给人手编辑另开一条数据通路的话，上面每一样都要重做一遍，而且迟早会漏一样。
   */
  editBlock(request: EditBlockRequest): StudioState {
    const store = this.session.store
    const pos = { x: Math.round(request.pos[0]), y: Math.round(request.pos[1]), z: Math.round(request.pos[2]) }

    if (request.mode === 'break') {
      if (!store.contains(pos)) throw new Error(t('desktop.edit.outsideBreak'))
      if (store.isAir(pos)) throw new Error(t('desktop.edit.alreadyAir'))
      this.session.applyEdit('break_block', { pos: request.pos }, () =>
        store.write((emit) => emit(pos.x, pos.y, pos.z), 0, { mode: 'destroy', confirm: true }),
      )
    } else {
      const name = request.block
      if (name === undefined || name.length === 0) throw new Error(t('desktop.edit.noBlockSelected'))
      // `palette.indexOf` 会把认不出的名字**悄悄追加**进调色板，所以先自己验一遍。
      // 不验的话，手滑打错一个名字就会在工程里留下一项永远用不到的调色板条目
      if (store.registry.blockByName(name) === undefined) throw new Error(t('desktop.edit.unknownBlock', { name }))
      if (!store.contains(pos)) throw new Error(t('desktop.edit.outsidePlace'))
      this.session.applyEdit('place_block', { pos: request.pos, block: name }, () =>
        store.write((emit) => emit(pos.x, pos.y, pos.z), store.palette.indexOf(name), { confirm: true }),
      )
    }

    // 人手编辑也不该把没保存的改动留在内存里：和跑完一轮一样落一次 WAL
    this.autosaveNow()
    this.emit({ type: 'state', state: this.state() })
    return this.state()
  }

  /**
   * 调色板搜索：按名字在 `minecraft-data` 里找。
   *
   * 为什么不给一张"所有可放置方块"的固定表：1.21.4 有 1095 种，里面混着大量
   * 技术方块（`moving_piston`、`bubble_column`…），筛出一张正确的表本身就是个坑；
   * 而用户真正要的多半是"我刚才用过的"（那在 `state().histogram` 里）
   * 或"我搜得到的那几个"。
   */
  blocks(query: string): string[] {
    const store = this.session.store
    const needle = query.trim().toLowerCase()
    if (needle.length === 0) return []

    const matches = [...store.registry.blockNames]
      .filter((name) => name.includes(needle))
      // 排前面的是"越短越像"的那些：搜 `stone` 时 `stone` 该在 `stone_brick_stairs` 前面
      .sort((a, b) => a.length - b.length || (a < b ? -1 : 1))
      .slice(0, 60)
    return matches
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
      return error instanceof Error ? t('desktop.sliceFailed', { message: error.message }) : String(error)
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
    if (bounds === undefined) throw new Error(t('desktop.world.emptyExport'))
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
        summary: t('desktop.export.schemSummary', { size: result.size.join('×'), blocks: result.blocks }),
      }
    }

    if (format === 'litematic') {
      const bytes = exportLitematic(store, { name: this.projectName, author: 'ArchItect' })
      return {
        files: [{ name: `${stem}.litematic`, bytes }],
        summary: t('desktop.export.litematicSummary', { size: size.join('×') }),
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
      summary: t('desktop.export.objSummary', {
        size: size.join('×'),
        blocks: result.blocks,
        faces: result.faces,
        materials: result.materials.length,
      }),
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
    const session = this.openSession({
      volume: {
        min: { x: 0, y: 0, z: 0 },
        max: { x: Math.max(sx + 7, 15), y: Math.max(sy + 7, 15), z: Math.max(sz + 7, 15) },
      },
      plain: this.plain,
    })
    const result = importSchematicInto(session.store, data, { at: { x: 0, y: 0, z: 0 } })
    // 导入的内容是**基准状态**，不在 op 流里：把游标拉回 0，
    // 这样"世界的版本"与"日志长度"从第一笔编辑起就一致。
    // 与 `.mcai` 的 base 快照语义一样：rev 0 = 打开时看到的样子。
    session.store.setRevision(0)

    this.session = session
    this.projectPath = undefined
    this.projectName =
      path.split('/').pop()?.replace(/\.(schem|schematic|litematic)$/i, '') ?? t('desktop.importedProject')
    this.chat.clear()

    return {
      state: this.state(),
      summary: t('desktop.import.summary', {
        size: data.size.join('×'),
        version: data.dataVersion !== undefined ? t('desktop.import.dataVersion', { version: data.dataVersion }) : '',
        cells: result.placed,
      }),
      unknown: result.unknown,
      renamed: result.renamed,
      skipped: result.skipped,
    }
  }

  /** 直方图文本（给 UI 的材质面板用）。 */
  measureText(): string {
    const stats = measure(this.session.store)
    if (stats.bounds === undefined) return t('desktop.world.empty')
    const size = stats.size!
    return t('panel.measureLine', { size: `${size.x}×${size.y}×${size.z}`, blocks: stats.blocks })
  }
}
