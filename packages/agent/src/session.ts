import { EditLog, measure, WorldStore } from '@architect/core'
import type { Bounds, Palette } from '@architect/core'
import { createAssetColorResolver, createFallbackColorResolver, encodePng, fitCamera, presetAngles, renderIsometric } from '@architect/render'
import type { ColorResolver, ViewPreset } from '@architect/render'
import { createDefaultRegistry } from '@architect/tools'
import type { ScreenshotRequest, ToolContext, ToolImage, ToolRegistry } from '@architect/tools'

import { buildStateMessage, buildSystemPrompt } from './prompts.js'
import type { PromptContext } from './prompts.js'

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
  readonly registry: ToolRegistry
  readonly ctx: ToolContext
  private readonly resolve: ColorResolver
  private shotCount = 0

  constructor(private readonly options: SessionOptions) {
    const version = options.minecraftVersion ?? '1.21.4'
    this.store = new WorldStore({
      minecraftVersion: version,
      volume: options.volume,
      ...(options.palette !== undefined ? { palette: options.palette } : {}),
    })
    this.log = new EditLog()
    this.registry = options.registry ?? createDefaultRegistry()
    this.resolve = options.plain === true ? createFallbackColorResolver() : createAssetColorResolver(version)

    this.ctx = {
      store: this.store,
      log: this.log,
      clipboard: {},
      correlationId: 'init',
      record: (tool, args, result) => {
        this.log.record(result, {
          tool,
          args,
          correlationId: this.ctx.correlationId,
          source: 'llm',
          ...(options.now !== undefined ? { ts: options.now() } : {}),
        })
      },
      shoot: (request) => this.shoot(request),
    }
  }

  /** 开始新的一轮：同一次 LLM 响应里的多个 op 会共享这个 id，便于整轮回滚。 */
  beginTurn(correlationId: string): void {
    this.ctx.correlationId = correlationId
  }

  /** 按当前状态构造 system prompt。**前缀要稳定**，所以只放慢变的东西。 */
  buildSystem(): string {
    const promptContext: PromptContext = {
      volume: `(${this.store.volume.min.x},${this.store.volume.min.y},${this.store.volume.min.z}) .. (${this.store.volume.max.x},${this.store.volume.max.y},${this.store.volume.max.z})`,
    }
    if (this.options.paletteAllowlist !== undefined) {
      promptContext.palette = this.options.paletteAllowlist
    }
    if (this.options.designNotes !== undefined) promptContext.designNotes = this.options.designNotes
    return buildSystemPrompt(promptContext)
  }

  /** 每次提问前追加的 volatile 状态（放在历史里，不污染 system 前缀）。 */
  buildStateLine(): string {
    const stats = measure(this.store)
    const bounds = stats.bounds
    return buildStateMessage({
      revision: this.store.revision,
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
   * 当前会话用的配色方案。
   *
   * 暴露出来是为了让**别的导出路径**（`.obj` 的材质色）和截图用的是同一套颜色——
   * 各建一个 resolver 的话，同一种方块在截图里和 OBJ 里可能长得不一样。
   */
  get colorResolver(): ColorResolver {
    return this.resolve
  }

  private shoot(request: ScreenshotRequest): ToolImage {
    const bounds = this.store.contentBounds() ?? this.store.volume
    const camera = fitCamera(bounds, presetAngles(request.view as ViewPreset), request.width, request.height)
    const result = renderIsometric(this.store, {
      camera,
      resolve: this.resolve,
      overlays: {
        ruler: true,
        axisGizmo: true,
        volumeBox: this.store.volume,
        ...(request.highlight !== undefined ? { highlight: request.highlight } : {}),
        ...(request.caption !== undefined ? { caption: request.caption } : {}),
      },
    })
    this.shotCount++
    return {
      png: encodePng(result.canvas),
      width: request.width,
      height: request.height,
      camera: request.view,
      revision: this.store.revision,
    }
  }
}
