import { EditLog, measure, ReplaySession, WorldStore } from '@architect/core'
import type { Bounds, OpSource, Palette, WriteResult } from '@architect/core'
import {
  cameraForShot,
  bakedColorTexturePack,
  createFallbackColorResolver,
  createPackColorResolver,
  encodePng,
  renderIsometric,
  shotCameraLabel,
} from '@architect/render'
import type { TexturePack } from '@architect/render'
import type { CameraSpec, ColorResolver, OverlayOptions } from '@architect/render'
import { createDefaultRegistry } from '@architect/tools'
import type { ScreenshotRequest, ToolContext, ToolImage, ToolRegistry } from '@architect/tools'

import { buildStateMessage, buildSystemPrompt } from './prompts.js'
import type { PromptContext } from './prompts.js'

/** 一次编辑的执行者。`source` 进 `.mcai`，用来区分"谁改的"。 */
export interface Actor {
  source: OpSource
  actor: string
}

/** 工具调用写下的 op：模型改的。 */
const LLM_ACTOR: Actor = { source: 'llm', actor: 'assistant' }

/**
 * **由人**改的 op（界面上的手改）。
 *
 * 和模型改的走同一条日志、同一套重放——于是时间线、撤销、`.mcai` 往返、
 * 导出全都自动成立，不需要给"人手编辑"另开一条数据通路。
 */
export const USER_ACTOR: Actor = { source: 'user', actor: 'user' }

/**
 * 交给外部渲染后端的一张图。
 *
 * 里面**没有世界**。几何由后端自己按 `revision` 取（桌面端从网格缓存里拿，
 * 渲染进程再拉一次），所以同一份请求既能喂给软件光栅器，也能过一趟 IPC 给 GPU。
 * 相机是**已经解算好的 `CameraSpec`**——取景只算一次，两条路的构图因此同源，
 * 不会出现"GPU 那张和模型以为的机位不一样"。
 */
export interface ShotInput {
  camera: CameraSpec
  /** 机位标签（`iso_ne` / `az45/el30` …），会回显给模型。 */
  view: string
  revision: number
  width: number
  height: number
  /** 叠加层，与软件路径**同一份选项**。 */
  overlays: OverlayOptions
  /** 是否走纹理路径。`plain: true` 的会话为 `false`。 */
  textured: boolean
}

/**
 * 外部渲染后端。
 *
 * 返回 `undefined` 表示"这一枪我画不了"（没有 GPU、窗口还没起来、revision 对不上……），
 * 会话会退回软件光栅器。**不能因为拿不到 GPU 就没有截图**——截图是模型的眼睛，
 * 宁可给一张差一点的，也不能让 `screenshot` 直接失败。
 */
export type ShotRenderer = (input: ShotInput) => ToolImage | undefined | Promise<ToolImage | undefined>

export interface SessionOptions {
  minecraftVersion?: string
  volume: Bounds
  /** LLM 自己写的设计笔记，作为稳定前缀的一部分。 */
  designNotes?: string
  /** 允许 LLM 使用的方块白名单（进 system prompt 的约束）。 */
  paletteAllowlist?: readonly string[]
  /** 不读资源包，用确定性兜底配色（CI 用）。 */
  plain?: boolean
  /**
   * 纹理来源（用户的 `.minecraft` / 资源包 / 平均色兜底）。
   *
   * 省略时**只有颜色没有纹理**：颜色走烘好的平均色（确定性、不依赖任何资源包），
   * 需要纹理的 `textured` 截图会明确报错而不是画成一片洋红。CLI 与桌面端
   * 各自把解析好的包传进来（桌面端是设置里的那一项）。
   */
  textures?: TexturePack
  /**
   * 注入时钟。
   *
   * 生产代码不需要它——op 的时间戳本该是真实时间。但**生成可复现的夹具**需要：
   * 示例工程、回归基线这类东西如果每次生成都带一个新时间戳，
   * `git diff` 就永远有噪音，"这次改动到底改了什么"也就看不出来了。
   */
  now?: () => string
  registry?: ToolRegistry
  /**
   * 预先载入的调色板。
   *
   * **打开已有工程时必须传**：快照里存的是**该工程调色板的索引**，
   * 用一张只有 air 的新调色板去解释它，索引 1 就指向不存在的方块了。
   */
  palette?: Palette
  /**
   * 优先使用的渲染后端。**省略/返回 `undefined`/抛错时都退回软件光栅器。**
   *
   * 桌面端拿它把模型的眼睛接到渲染进程里的 three.js 上：模型看到的和用户拖出来的
   * 是同一套渲染器，而不是"用户看 GPU 版、模型看软件版"。
   */
  render?: ShotRenderer
}

/**
 * 一次设计会话：世界 + 事件日志 + 工具上下文 + 截图实现。
 *
 * 把"渲染截图"注入成 `ToolContext.shoot`，是为了让 tools 包不必知道
 * 用的是软件光栅器还是 three.js——两者共用同一份相机与颜色代码。
 */
export class AgentSession {
  readonly store: WorldStore
  readonly log: EditLog
  /**
   * **op 流上的游标**（时间线、`undo`/`redo` 都用它）。
   *
   * 会话自己持有它，桌面端的时间线直接用同一个——**不能各建一个**：
   * 两个游标意味着"世界写着 rev 7、另一个游标还停在 3"这类双真相。
   */
  readonly history: ReplaySession
  readonly registry: ToolRegistry
  readonly ctx: ToolContext
  private readonly resolve: ColorResolver
  /** 这一场会话用哪套纹理（截图与颜色解析共用同一份）。 */
  private readonly textures: TexturePack
  /**
   * 设计笔记（`update_notes` 的落地处）。
   *
   * 是**可变**的会话状态，不是构造参数：模型在一轮里写下计划，从**下一轮**起
   * 它出现在系统提示的稳定前缀里。中途不重建系统提示是有意的——那会把前缀缓存打掉。
   */
  private designNotes: string | undefined
  private shotCount = 0
  private fallbacks: string[] = []

  constructor(private readonly options: SessionOptions) {
    const version = options.minecraftVersion ?? '1.21.4'
    this.store = new WorldStore({
      minecraftVersion: version,
      volume: options.volume,
      ...(options.palette !== undefined ? { palette: options.palette } : {}),
    })
    this.log = new EditLog()
    // **会话自己持有游标**：世界 + 日志 + 游标是一件事，拆开放到别处就会出现
    // 两个游标各改各的（那个 bug 真出现过）。桌面端的时间线直接用它，不再另建一个。
    this.history = new ReplaySession(this.store, this.log)
    this.registry = options.registry ?? createDefaultRegistry()
    // 纹理来源决定颜色怎么来：有资源包就用资源包的真实纹理算平均色，
    // 没有就用烘好的平均色（三级台阶见 colors.ts）
    // 默认给**烘好的平均色**：确定性（不依赖这台机器装没装 Minecraft），
    // 而且 `textured` 截图照样能用——每个方块一块纯色，形状/UV/明暗全对。
    // 调用方（CLI / 桌面端）会传自己解析好的来源覆盖它（D-61 的那条"同一个入口"）。
    this.textures = options.textures ?? bakedColorTexturePack(version)
    this.designNotes = options.designNotes
    this.resolve =
      options.plain === true ? createFallbackColorResolver() : createPackColorResolver(version, this.textures)

    this.ctx = {
      store: this.store,
      log: this.log,
      history: this.history,
      clipboard: {},
      // 设计笔记：会话级状态，`update_notes` 写、系统提示读（§9.2 的阶段摘要）
      notes: {
        get: () => this.designNotes,
        set: (next) => {
          this.designNotes = next
        },
      },
      correlationId: 'init',
      record: (tool, args, result) => {
        this.record(tool, args, result, LLM_ACTOR)
      },
      shoot: (request) => this.shoot(request),
    }
  }

  /**
   * 记一条 op。
   *
   * 截断与编号校验都在 `EditLog.record` 里（`worldRevision`）——那是唯一能同时
   * 看到"写入后的版本"和"日志长度"的地方。曾经把它写在这一层，结果是任何
   * 自己拼 `ToolContext` 的宿主都绕过了它，留下一份有两条同号 op 的日志。
   */
  private record(tool: string, args: unknown, result: WriteResult, who: Actor): void {
    this.log.record(result, {
      tool,
      args,
      correlationId: this.ctx.correlationId,
      source: who.source,
      actor: who.actor,
      worldRevision: this.store.revision,
      ...(this.options.now !== undefined ? { ts: this.options.now() } : {}),
    })
  }

  /** 开始新的一轮：同一次 LLM 响应里的多个 op 会共享这个 id，便于整轮回滚。 */
  beginTurn(correlationId: string): void {
    this.ctx.correlationId = correlationId
  }

  /**
   * **宿主自己写一笔**（示例生成、导入、界面上的手改）。
   *
   * 和工具写入走**同一条记录路径**：截断、编号校验、`source` 全都一致。
   * 宿主绕过它直接调 `log.record` 的话，就少了一道不变式检查，
   * 而且很容易忘了传 `worldRevision`——那样日志与世界会安静地脱节。
   *
   * `who` 默认是"人"，因为会走这条路的都是人在改（模型走的是工具）。
   */
  applyEdit(tool: string, args: unknown, run: () => WriteResult, who: Actor = USER_ACTOR): WriteResult {
    const result = run()
    this.record(tool, args, result, who)
    return result
  }

  /** 按当前状态构造 system prompt。**前缀要稳定**，所以只放慢变的东西。 */
  /** 当前的设计笔记（保存工程时要写进 `.mcai`，重开之后模型不该失忆）。 */
  get currentDesignNotes(): string | undefined {
    return this.designNotes
  }

  buildSystem(): string {
    const promptContext: PromptContext = {
      volume: `(${this.store.volume.min.x},${this.store.volume.min.y},${this.store.volume.min.z}) .. (${this.store.volume.max.x},${this.store.volume.max.y},${this.store.volume.max.z})`,
    }
    if (this.options.paletteAllowlist !== undefined) {
      promptContext.palette = this.options.paletteAllowlist
    }
    // 用**当前**的笔记（`update_notes` 可能在上一轮改过它），不是构造时那份快照
    if (this.designNotes !== undefined) promptContext.designNotes = this.designNotes
    return buildSystemPrompt(promptContext)
  }

  /** 每次提问前追加的 volatile 状态（放在历史里，不污染 system 前缀）。 */
  buildStateLine(): string {
    const stats = measure(this.store)
    const bounds = stats.bounds
    return buildStateMessage({
      revision: this.store.revision,
      totalRevisions: this.log.length,
      blocks: stats.blocks,
      ...(bounds !== undefined
        ? { bounds: `${bounds.min.x},${bounds.min.y},${bounds.min.z}..${bounds.max.x},${bounds.max.y},${bounds.max.z}` }
        : {}),
    })
  }

  get screenshots(): number {
    return this.shotCount
  }

  /**
   * 最近一次"想走 GPU 但没走成"的原因，没有就是 `undefined`。
   *
   * 存在这里而不是抛出去：截图回落是可恢复的（图还是出来了，只是没那么好看），
   * 但**用户需要知道**——否则"为什么聊天里的图忽然变糊了"没法解释。
   * 界面拿它显示一行状态。
   */
  get renderFallback(): string | undefined {
    return this.fallbacks.at(-1)
  }

  private recordFallback(reason: string): void {
    this.fallbacks.push(reason)
    // 只留最近几条：这是给人看的提示，不是日志
    if (this.fallbacks.length > 8) this.fallbacks.shift()
  }

  /**
   * 当前会话用的配色方案。
   *
   * 暴露出来是为了让**别的导出路径**（`.obj` 的材质色）和截图用的是同一套颜色——
   * 各建一个 resolver 的话，同一种方块在截图里和 OBJ 里可能长得不一样。
   */
  get colorResolver(): ColorResolver {
    return this.resolve
  }

  /**
   * 拍一张图。
   *
   * **先问外部后端，拿不到才自己画**。顺序是有意的：桌面端有 GPU，
   * 那条路好看得多；CLI 与 CI 没有 GPU，软件光栅器保证确定性。
   * 两边共用同一份 `CameraSpec` 与同一份叠加层选项，所以构图与标尺完全对齐，
   * 差的只是"谁来执行这次绘制"。
   *
   * `plain: true` 的会话**不问外部后端**：纯色路径只有软件光栅器实现
   * （GPU 那条路要图集），问了也是白问，还会把"按设计走纯色"记成一次回落。
   */
  private async shoot(request: ScreenshotRequest): Promise<ToolImage> {
    const contentBounds = this.store.contentBounds()
    const bounds = contentBounds ?? this.store.volume
    // 会话相机（`set_camera` 设的）在这里兜底：显式参数优先，没给才落到它。
    // 工具层已经合过一次，但桌面端与脚本也走 `ctx.shoot`，所以这里再兜一次。
    // **合并结果同时用来算标签**：只按原始请求算的话，"机位来自会话相机"的那几张
    // 会全部记成 `iso_ne`，事后在档案里根本认不出它们其实是同一个自定义机位。
    const merged = { ...this.ctx.camera, ...request, view: request.view }
    const camera = cameraForShot(bounds, merged)
    const overlays: OverlayOptions = {
      ruler: true,
      axisGizmo: true,
      volumeBox: this.store.volume,
      ...(request.highlight !== undefined ? { highlight: request.highlight } : {}),
      ...(request.caption !== undefined ? { caption: request.caption } : {}),
    }
    const label = shotCameraLabel(merged)
    const revision = this.store.revision
    // 默认走**纹理渲染**（真实方块模型 + 逐面纹理 + 原版光照）。
    // 这是模型的眼睛：纯色平均色会让 `stone_bricks` 和 `stone` 看起来一模一样
    // （平均色只差 4/255），模型就没法在截图上核对"我叫它砌的是石砖"。
    // `plain: true` 时才退回纯色，供 golden 测试与 CI 用。
    const textured = this.options.plain !== true

    const external = textured ? this.options.render : undefined
    if (external !== undefined) {
      try {
        const image = await external({
          camera,
          view: label,
          revision,
          width: request.width,
          height: request.height,
          overlays,
          textured,
        })
        // `await` 期间主进程还可能处理别的事件（用户拖时间线、自动保存……），
        // 所以外部分支回来之后**必须再核一次 revision**：拿一张和它自己的
        // revision 对不上的图去下结论，正是 plan §9.4 要防的那个隐蔽 bug。
        if (image !== undefined && this.store.revision === revision) {
          this.shotCount++
          return image
        }
        this.recordFallback(
          image === undefined ? '外部渲染后端拒绝了这一枪' : '渲染期间世界被改动，这一枪作废',
        )
      } catch (error) {
        // 外部分支坏掉不该把整轮对话带走
        this.recordFallback(error instanceof Error ? error.message : String(error))
      }
    }

    const result = renderIsometric(this.store, {
      camera,
      resolve: this.resolve,
      textures: this.textures,
      ...(textured ? { textured: true } : {}),
      overlays,
    })
    this.shotCount++
    return {
      png: encodePng(result.canvas),
      width: request.width,
      height: request.height,
      camera: label,
      revision: this.store.revision,
    }
  }
}
