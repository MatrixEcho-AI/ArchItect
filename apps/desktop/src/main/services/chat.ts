import { createHash } from 'node:crypto'

import {
  activeProvider,
  createProvider,
  costTableFor,
  currencyOf,
  discoverProvider,
  normalizeProviderCosts,
  resolveApiKey,
  UsageMeter,
  validateProviderConfig,
  addPreset,
  defaultSettings,
} from '@architect/agent'
import type {
  AgentEvent,
  CostTable,
  DiscoveryResult,
  LlmMessage,
  LlmImage,
  LlmProvider,
  PresetKey,
  ProviderConfig,
  ProviderSettings,
  SettingsIssue,
  UsageTotals,
} from '@architect/agent'
import { getLocale, t } from '@architect/i18n'
import { TranscriptRecorder } from '@architect/mcai'
import type { CaptureBundle, ChatTranscript, TranscriptRecording } from '@architect/mcai'
import type { ToolResult } from '@architect/tools'

import type { SecretStore } from './settings.js'

/**
 * 对话与模型的会话状态。
 *
 * 世界仍然归 `StudioService` 管；这里只负责"把一次对话跑起来，并把过程变成界面能画的东西"。
 * 渲染进程拿到的永远是**纯数据**（文字 + 截图 id），不是 PNG 字节——
 * 截图按 id 懒取，事件流就能保持很小。
 */

export interface ChatMessageView {
  id: number
  role: 'user' | 'assistant' | 'tool'
  text: string
  /** `role === 'tool'` 时才有。 */
  toolName?: string
  toolOk?: boolean
  /** 工具参数的紧凑 JSON。 */
  args?: string
  /** 结果里有截图时给一个 key，界面按需向主进程要 PNG。 */
  imageId?: string
  imageRevision?: number
  /** 这张图当时用的机位。 */
  imageView?: string
  /**
   * **用户随这条消息给的图**（"插入图片"与"采集视口"两个入口）。
   *
   * 与 `imageId` 分开而不是复用一个字段：`imageId` 是**工具截图**的语义
   * （模型自己看回来的，会随 revision 过期），这里是**人给的输入**。
   * 界面上前者画在工具卡片里、后者画在用户消息下方；模型那边前者会被
   * `retainHistory` 当过期截图剪掉，后者不会。
   */
  userImageIds?: string[]
  /** 完成闸门的提醒（§9.4）。 */
  gate?: boolean
  /**
   * 工具调用的**完整返回**（给界面折叠展开用）。
   *
   * 与上面的 `text` 是**两份**，别合并：
   *  - `text` 是给界面**默认显示**的一行摘要（只取首行、最多 400 字，见 `summarize`）；
   *  - `toolResult` 是原始那一段（完整 summary + 结构化 `data` 的 JSON），只在用户
   *    点开时才看。
   *
   * 分开的理由是"默认视图要短"和"排查时要全"是**两个相反的诉求**，一个字段满足不了。
   */
  toolResult?: string
  /** 这一轮**失败**了（请求报错、空回复……）。界面据此把它画红，而不是混在正常回复里。 */
  failed?: boolean
  /**
   * 这一条**正在流式生成**（还没收到收口的 `assistant`）。界面据此在末尾画一个光标，
   * 而不是等整段生成完才让字出现。
   */
  streaming?: boolean
  /**
   * 流式期间模型吐出的**思维链正文**。
   *
   * 为什么是正文而不是"已经想了几个字"：界面上要的是 Codex 那种做法——**一行**里滚动
   * 显示最新的思考内容，点一下才展开全文。只给字数的话那一行无从显示，用户只能干等。
   *
   * 但它**永远不该默认铺满对话**：思维链是模型的草稿，逐字铺开会把真正的回答淹掉。
   * 所以这里的职责只是"如实带出去"，收不收、怎么收由界面决定（默认收着）。
   */
  thinking?: string
  ts: string
}

export interface ChatView {
  running: boolean
  messages: ChatMessageView[]
  usage: UsageTotals
  costAmount?: number
  /** 金额的币种代码（价格表带的那个）。 */
  costCurrency?: string
  stopReason?: string
  error?: string
  /** 被预算刹住的原因（如果有）。与 `error` 分开：这不是故障。 */
  /** provider 配置是否齐备。不齐时界面直接引导去设置，而不是等报错。 */
  ready: boolean
  /** 配置缺什么（中文，直接显示）。 */
  blocking: string[]
}

export interface ProviderView extends ProviderConfig {
  /** 密钥是否已经存在（环境变量有值，或密钥库里存过）。**不返回密钥本身**。 */
  hasKey: boolean
  /** 密钥引用指向的环境变量名（如果有），用于提示用户 export 哪个。 */
  envName?: string
}

export interface SettingsView {
  activeId: string
  providers: ProviderView[]
  locale: 'zh-CN' | 'en-US'
  ui: { view?: string; requireVerification?: boolean }
  secrets: { location: string; encrypted: boolean }
  issues: SettingsIssue[]
}

export interface TestConnectionInput {
  preset: PresetKey
  baseURL: string
  model?: string
  apiKeyRef?: string
  /** 界面上刚输入的明文密钥。**只在这一次请求里用，不落盘**。 */
  apiKeyPlain?: string
  /** 只列模型，不跑能力探针。 */
  listOnly?: boolean
}

/** 主进程 → 渲染进程的推送。整份 ChatView 一起发：消息条数是几十量级，diff 不值得。 */
export type StudioEvent =
  | { type: 'chat'; view: ChatView }
  | { type: 'settings'; view: SettingsView }
  | { type: 'state'; state: unknown }
  /**
   * **一轮跑动中的轻量进度**：工具刚写完，世界版本前进了。
   *
   * 为什么不直接推一份 `state`：`StudioService.state()` 要 `measure()` 一遍全部方块
   * （为了统计数与直方图），那是 O(方块数)。一次 `run_batch` 能写几千格、一轮里
   * 又能有十几次工具调用——每次都全量数一遍，只为了让界面上的 rev 数字动一格。
   *
   * 所以这条只带**增量**：rev、op 数、以及新出现的那几条 op（左栏那份记录要能立刻
   * 长出来）。统计数、包围盒、直方图仍然在一轮结束时由 `state` 给全量。
   */
  | { type: 'revision'; revision: number; totalOps: number; behindTip: boolean; ops: RevisionOp[] }

/** `revision` 事件里那一条 op（与 `StudioState.ops` 同形）。 */
export interface RevisionOp {
  rev: number
  tool: string
  changed: number
  ts: string
  source: string
}

/**
 * **本轮要发给模型的东西**：一句话，外加用户随这句话给的图。
 *
 * 打包成一个对象而不是"给 `ChatRunner` 再加两个位置参数"：位置参数每加一个，
 * 所有 runner 实现（真实的那个 + 测试里七八个）都要跟着改一遍，而且第 7 个
 * `Uint8Array` 参数在调用点上完全看不出是什么。这里加字段是向后兼容的。
 */
export interface SendGoal {
  text: string
  /** 用户附的图（没有就是空数组）。 */
  images: LlmImage[]
}

export type ChatRunner = (
  goal: SendGoal,
  provider: LlmProvider,
  onEvent: (event: AgentEvent) => void,
  shouldStop: () => boolean,
  /**
   * **上一轮之后的消息**。桌面端一次 send 就是一次 `runAgent`，
   * 不把它接上的话，模型对这次会话毫无记忆（见 `AgentOptions.history`）。
   */
  history: readonly LlmMessage[],
  /** 上一轮结束时还没读回的改动数（完成闸门的跨轮状态）。 */
  pendingMutations: number,
) => Promise<{
  stopReason: string
  error?: string
  usage: { in: number; out: number; cachedIn?: number }
  /** 跑完之后的完整消息数组，下一轮原样接上。省略表示这个 provider 不留历史。 */
  messages?: LlmMessage[]
  pendingMutations?: number
}>

/**
 * 流式增量**合并推送**的间隔。
 *
 * 每来一个 token 就推一份完整的 ChatView，会让 IPC 与整列重绘都跑到几十次/秒；
 * 人眼要的只是"字在往外冒"，一帧一次就够。非增量事件（工具、报错、结束）不走这条，
 * 那些必须立刻可见。
 */
const STREAM_EMIT_MS = 40

export interface ChatOptions {
  settings?: ProviderSettings
  secrets?: SecretStore
  /** 截图缓存上限。够了就丢掉最旧的——它只是界面上的一张缩略图，能重新渲染出来。 */
  maxCaptures?: number
  /** 用户附图的上限。与截图分开算，理由见 `attachments` 字段。 */
  maxAttachments?: number
  /** 测试注入用：替换 provider 构造。 */
  providerFactory?: (config: ProviderConfig, apiKey: string | undefined) => LlmProvider
}

export class ChatController {
  private settings: ProviderSettings
  private readonly secrets: SecretStore
  private readonly maxCaptures: number
  private readonly maxAttachments: number
  private readonly providerFactory: ChatOptions['providerFactory'] | undefined

  private messages: ChatMessageView[] = []
  private captures = new Map<string, { png: Uint8Array; revision: number; view: string }>()
  /**
   * **用户附图**（插入的图片 / 采集的视口那一枪）。
   *
   * 与 `captures` 分开两张表，因为生命周期不同：截图是"模型自己看回来的"，会被
   * `retainHistory` 当过期截图剪掉；附图是"人给的输入"，剪掉它等于把用户的话删了。
   * 存的是**字节**（与 `LlmImage` 同形），所以 `send` 里不用再找一次图。
   */
  private attachments = new Map<string, LlmImage>()
  private running = false
  private stopRequested = false
  private stopReason: string | undefined
  private error: string | undefined
  private nextId = 1
  private meter = new UsageMeter()
  private issues: SettingsIssue[] = []
  /**
   * **发给模型的历史**（跨轮延续）。
   *
   * 与界面上那份 `messages` 刻意分开：那份是给人看的——工具结果只留第一行（400 字符）、
   * 参数截断到 300 字符——拿它回灌给模型等于把工具结果砍成残废。
   * 这份是上一轮 `runAgent` 真正发给模型的消息，只追加、不修改。
   *
   * 打开旧工程时**接不回**来：`.mcai` 的对话档案按设计只存"给人看的过程"，
   * 不含原始消息（system prompt / 工具 schema / 图片 base64，见 `mcai/transcript.ts`），
   * 而 DeepSeek 又要求历史里每一轮的 `reasoning_content` 原样回传。
   */
  private modelHistory: LlmMessage[] = []
  /** 上一轮结束时还没读回的改动数（完成闸门的跨轮状态）。 */
  private pendingMutations = 0
  /**
   * 正在生成的那一条（已经进了 `messages`，还没被收口）。
   *
   * 它就是界面上"逐字输出"的那一条：`assistant_delta` 往里接碎片，收口的
   * `assistant` 事件把整段盖上（最终响应是权威版本，碎片只是先看到的那部分）。
   */
  private live: ChatMessageView | undefined
  /** `live` 属于第几轮。轮次对不上说明上一轮没收口，先把它关掉。 */
  private liveTurn: number | undefined
  /** 挂起的合并推送（见 `STREAM_EMIT_MS`）。 */
  private streamTimer: ReturnType<typeof setTimeout> | undefined
  /**
   * 对话录制器。
   *
   * 与界面那份 `messages` **刻意分开**：界面只留最近 60 张截图（内存有限），
   * 而工程文件要存下整场会话的全部截图与消息。录制器不做淘汰，界面做。
   */
  private recorder: TranscriptRecorder
  /** 最近一次预算刹车的原因。界面据此把"停下来"解释清楚。 */
  /** 由 StudioService 注入：真正跑 agent 循环的那个函数。 */
  private runner: ChatRunner
  private emit: (event: StudioEvent) => void = () => {}
  private afterRun: () => void = () => {}
  private afterTool: () => void = () => {}

  constructor(
    options: ChatOptions,
    runner: ChatRunner,
  ) {
    this.settings = options.settings ?? defaultSettings()
    this.secrets = options.secrets ?? { location: t('desktop.secretLocation.unconfigured'), encrypted: false, get: () => undefined, set: () => false, has: () => false, remove: () => {} }
    this.maxCaptures = options.maxCaptures ?? 60
    this.maxAttachments = options.maxAttachments ?? 24
    this.providerFactory = options.providerFactory
    this.runner = runner
    this.recorder = new TranscriptRecorder({ title: t('desktop.untitledSession') })
  }

  onEvent(listener: (event: StudioEvent) => void): void {
    this.emit = listener
  }

  /** 一轮结束后回调（StudioService 用它刷新世界状态快照）。 */
  onAfterRun(listener: () => void): void {
    this.afterRun = listener
  }

  /**
   * **每一次工具返回之后**的回调，无论那一次有没有改动世界。
   *
   * 宿主拿它做"改了就立刻进 rev"：不等整轮结束，工具每写完一次就把新版本推给界面。
   * 判据（有没有真的改动）留给宿主——它才拿得到 `EditLog`，而这里只看得到工具名与
   * `ok`，拿工具名去猜"这个工具是不是写操作"迟早会错（`run_batch` / `fill_line` /
   * 以后新加的工具都会漏）。
   */
  onToolResult(listener: () => void): void {
    this.afterTool = listener
  }

  // ── 设置 ────────────────────────────────────────────────────────────────────

  get settingsValue(): ProviderSettings {
    return this.settings
  }

  setSettings(settings: ProviderSettings): void {
    this.settings = settings
  }

  setIssues(issues: SettingsIssue[]): void {
    this.issues = issues
  }

  settingsView(): SettingsView {
    return {
      activeId: this.settings.activeId,
      providers: this.settings.providers.map((config) => this.providerView(config)),
      locale: this.settings.locale ?? getLocale(),
      ui: this.settings.ui ?? {},
      secrets: { location: this.secrets.location, encrypted: this.secrets.encrypted },
      issues: this.issues,
    }
  }

  private providerView(config: ProviderConfig): ProviderView {
    const envName = config.apiKeyRef.startsWith('env:') ? config.apiKeyRef.slice(4) : undefined
    const view: ProviderView = { ...config, hasKey: this.hasKey(config) }
    if (envName !== undefined) view.envName = envName
    return view
  }

  private hasKey(config: ProviderConfig): boolean {
    if (config.apiKeyRef.length === 0) return true
    if (config.apiKeyRef.startsWith('safe:')) return this.secrets.has(config.apiKeyRef.slice(5))
    if (config.apiKeyRef.startsWith('env:')) {
      const value = process.env[config.apiKeyRef.slice(4)]
      return value !== undefined && value.trim().length > 0
    }
    return false
  }

  /**
   * 保存一个 provider 配置。
   *
   * **明文密钥走 `safe:` 引用进密钥库，绝不进设置文件**（D-13）。
   * 没有加密能力时返回一条 issue，并明确告诉用户改用环境变量——而不是悄悄写明文。
   */
  saveProvider(config: ProviderConfig, apiKeyPlain?: string): SettingsView {
    /**
     * **归一价格表的内存形状**（`cost` 与 `costs` 只留该留的那个）。
     *
     * 界面送来的是**文件形状**的配置，而内存里我们按 `costs` 给"按模型分表"，
     * 好让界面与查表都只看一个字段。不归一的话，"刚保存的那一份"会用文件形状
     * 留在内存里——界面读不到价格，用户以为丢了，再点一次保存就真的写没了。
     * 解析与保存共用 `applyCostShape`，形状必然一致（见那里的注释）。
     */
    const target: ProviderConfig = normalizeProviderCosts({ ...config })
    if (apiKeyPlain !== undefined && apiKeyPlain.trim().length > 0) {
      const id = config.id
      if (this.secrets.set(id, apiKeyPlain.trim())) {
        target.apiKeyRef = `safe:${id}`
      } else {
        this.issues = [
          ...this.issues.filter((i) => i.field !== 'apiKeyRef'),
          {
            field: 'apiKeyRef',
            message: t('desktop.chatBlocking.keychainUnavailable'),
          },
        ]
      }
    }
    const providers = this.settings.providers.filter((p) => p.id !== target.id)
    providers.push(target)
    /**
     * **保存一份配置不该把你正在用的模型换掉。**
     *
     * 以前这里无条件 `activeId: target.id`，在"只能编辑当前那一个"的旧对话框里看不出来；
     * 改成列表之后就成了事故：改一下另一个 provider 的密钥、点保存，对话就悄悄发到
     * 那个模型上了——而"用哪个模型说话"由输入框里那个选择器决定（用户的要求）。
     * 只在原来那个 id 已经不在了（第一次配、或被删过）时才落到刚保存的这个。
     */
    const keepActive =
      this.settings.activeId.length > 0 && providers.some((p) => p.id === this.settings.activeId)
    this.settings = {
      ...this.settings,
      providers,
      activeId: keepActive ? this.settings.activeId : target.id,
    }
    // 模型/能力变了，之前那轮对话的失败原因就不适用了
    this.error = undefined
    const view = this.settingsView()
    this.emitSettings(view)
    return view
  }

  removeProvider(id: string): SettingsView {
    const providers = this.settings.providers.filter((p) => p.id !== id)
    if (this.secrets.has(id)) this.secrets.remove(id)
    this.settings = {
      ...this.settings,
      providers,
      activeId: providers.some((p) => p.id === this.settings.activeId)
        ? this.settings.activeId
        : (providers[0]?.id ?? ''),
    }
    const view = this.settingsView()
    this.emitSettings(view)
    return view
  }

  /** 按预设加一个新实例并设为当前。 */
  addProvider(key: PresetKey): SettingsView {
    const config = addPreset(this.settings, key)
    this.settings = { ...this.settings, activeId: config.id }
    const view = this.settingsView()
    this.emitSettings(view)
    return view
  }

  setActive(id: string): SettingsView {
    this.settings = { ...this.settings, activeId: id }
    const view = this.settingsView()
    this.emitSettings(view)
    return view
  }

  setLocale(locale: 'zh-CN' | 'en-US'): SettingsView {
    this.settings = { ...this.settings, locale }
    const view = this.settingsView()
    this.emitSettings(view)
    return view
  }

  setUi(patch: { view?: string; requireVerification?: boolean }): SettingsView {
    this.settings = { ...this.settings, ui: { ...this.settings.ui, ...patch } }
    const view = this.settingsView()
    this.emitSettings(view)
    return view
  }

  // ── 连接测试（D-12） ────────────────────────────────────────────────────────

  /**
   * 探测一个端点，**并把结果写回配置**。
   *
   * 界面上刚输入的明文密钥只在这一次探测里用，不落盘——用户还没点保存。
   *
   * ## 为什么要在这里写回（真机事故）
   *
   * `createProvider` 的 `supportsImages` 读的是 `config.capabilities.vision`，而它
   * **只有探针能填**（预设里是 `false`，config.ts 里那条"不读静态表"）。可这条通道
   * 原来只 `return result`：探针在**本地那份 config** 上量出了 `vision: true`，
   * 那份 config 随即被丢掉，落盘的仍是预设的 `vision: false`。
   *
   * 后果不是"少了个数字"，而是**图被静默丢掉**：`OpenAiCompatibleProvider.serialize`
   * 见 `supportsImages === false` 就把图换成一行
   * "(The current model does not support images; N screenshot(s) omitted)"。
   * 用户看到的是"截图渲染成功、rev 也对，但拿到的只有文字元数据"——一路都是绿的，
   * 只有画面没有。CLI 那条路没这个毛病，因为它在 `resolveProvider` 里显式
   * `Object.assign(config, discovery.config)`；桌面这条路漏了同一件事。
   *
   * 写回的**前提是这次探测真的是在测已存的那个 provider**（端点与密钥引用都对得上）。
   * 否则用户只是在拿一个草稿端点试连接，把它的能力记到另一个 provider 上就是撒谎。
   */
  async testConnection(input: TestConnectionInput): Promise<DiscoveryResult> {
    const base = this.settings.providers.find((p) => p.id === this.settings.activeId)
    const config: ProviderConfig = {
      ...(base ?? { id: input.preset, preset: input.preset, kind: 'openai-compatible', apiKeyRef: '' } as ProviderConfig),
      preset: input.preset,
      baseURL: input.baseURL,
      apiKeyRef: input.apiKeyRef ?? base?.apiKeyRef ?? '',
      model: input.model ?? '',
      capabilities: base?.capabilities ?? { vision: false, toolCalling: 'native', promptCache: 'none', source: 'preset' },
    }
    let apiKey = input.apiKeyPlain?.trim()
    if (apiKey === undefined || apiKey.length === 0) {
      apiKey = await resolveApiKey(config.apiKeyRef, (ref) => this.resolveRef(ref))
    }

    const result = await discoverProvider(config, {
      ...(apiKey !== undefined ? { apiKey } : {}),
      ...(input.model !== undefined && input.model.length > 0 ? { model: input.model } : {}),
      ...(input.listOnly === true ? { listOnly: true } : {}),
    })

    // 只在"测的就是已存的那个 provider"时写回；草稿端点不污染已存的记录
    //
    // ⚠️ 能力要从 `result.config` 取，**不是**上面那份 `config`：`discoverProvider`
    // 开头就 `structuredClone(base)`，量出来的结论只落在它返回的副本上，
    // 传进去的那份对象始终没被碰过。这一条踩过一次——写成 `config.capabilities`
    // 时比较双方都是旧的，条件永远为假，于是"写回"整段静默不执行。
    const probed = result.config
    const sameTarget =
      base !== undefined && base.baseURL === probed.baseURL && base.apiKeyRef === probed.apiKeyRef
    if (sameTarget && !sameCapabilities(base.capabilities, probed.capabilities)) {
      this.settings = {
        ...this.settings,
        providers: this.settings.providers.map((p) =>
          p.id === base.id ? { ...p, model: probed.model, capabilities: probed.capabilities } : p,
        ),
      }
      this.emitSettings(this.settingsView())
    }
    return result
  }

  private resolveRef(ref: string): string | undefined {
    if (ref.startsWith('safe:')) return this.secrets.get(ref.slice(5))
    if (ref.startsWith('env:')) return process.env[ref.slice(4)]
    return undefined
  }

  /**
   * 能力**还没测过**的当前 provider——就是那种 `source: 'preset'`、`vision` 还是预设
   * 默认 `false` 的配置。启动时拿它决定"要不要补一次探针"。
   *
   * 为什么要有这个：`vision` 是**唯一**决定图发不发给模型的开关，而它在探针之前一律
   * 是 `false`。没有这一步时，一条"从没测过"的配置会一直静默吞图；用户唯一的补救
   * 是碰巧点开设置再点一次"测试连接"。所以宁可启动时自己补测一次。
   *
   * `source` 是 `'user'` / `'probe'` 的一律不碰——那是用户手填或已经测过的结论。
   */
  unmeasuredProvider(): ProviderConfig | undefined {
    const config = activeProvider(this.settings)
    if (config === undefined) return undefined
    return config.capabilities.source === 'preset' ? config : undefined
  }

  // ── 对话 ────────────────────────────────────────────────────────────────────

  chatView(): ChatView {
    return {
      running: this.running,
      messages: this.messages.map((m) => ({ ...m })),
      usage: this.meter.value,
      ...(this.costNow() !== undefined ? this.costNow()! : {}),
      ...(this.stopReason !== undefined ? { stopReason: this.stopReason } : {}),
      ...(this.error !== undefined ? { error: this.error } : {}),
      ready: this.blocking().length === 0,
      blocking: this.blocking(),
    }
  }

  /**
   * 此刻该用哪张价格表：**按当前模型查**（自定义端点一个 provider 挂多个模型，
   * 价格可能差几倍）。查表规则见 `costTableFor`。
   */
  private activeCost(): CostTable | undefined {
    return costTableFor(activeProvider(this.settings))
  }

  /**
   * 表盘要用的金额与币种。**两者必须一起报**：只报数字的话界面只能用 `$`，
   * 而人民币的价格表会显示成美元——账单对不上的那种错。
   */
  private costNow(): { costAmount: number; costCurrency: string } | undefined {
    const table = this.activeCost()
    const amount = this.meter.costOf(table)
    if (amount === undefined) return undefined
    return { costAmount: amount, costCurrency: currencyOf(table) }
  }

  private blocking(): string[] {
    const config = activeProvider(this.settings)
    if (config === undefined) return [t('desktop.chatBlocking.noProvider')]
    const problems = validateProviderConfig(config).filter(
      (problem) => problem.field === 'baseURL' || problem.field === 'apiKeyRef',
    )
    const out = problems.map((p) => p.message)
    if (config.model.trim().length === 0) {
      out.push(t('desktop.chatBlocking.needModel'))
    } else if (!this.hasKey(config)) {
      out.push(
        config.apiKeyRef.startsWith('env:')
          ? t('desktop.chatBlocking.envKeyMissing', { name: config.apiKeyRef.slice(4) })
          : t('desktop.chatBlocking.keyMissing'),
      )
    }
    return out
  }

  /**
   * **把工程里存的对话接回界面**（打开 `.mcai` 时用）。
   *
   * 为什么必须有：对话记录是这个格式的一半（§5），存了却看不到等于没存。
   * 之前打开工程只恢复世界，面板一片空白——用户会以为"我的对话丢了"。
   *
   * 三样东西一起恢复：消息、截图（`captures/`）、用量（成本表盘与缓存命中率）。
   * 用量从每条 assistant 消息上挂的 `usage` 重新累加，所以**成本表盘在打开旧工程后
   * 也是对的**；采到的花费按**当前**价格表重算（价格表可能改过），而不是照抄存下来的数。
   */
  load(transcript: ChatTranscript, captures: CaptureBundle): ChatView {
    // 工具参数挂在 assistant 的 `toolCalls` 上，而工具消息只带 `toolCallId`——
    // 先建一张 id → 参数的表，才能把"这一步传了什么"还原出来
    const argsById = new Map<string, unknown>()
    for (const record of transcript.messages) {
      for (const call of record.toolCalls ?? []) argsById.set(call.id, call.args)
    }
    const refById = new Map(captures.refs.map((ref) => [ref.id, ref]))

    this.messages = transcript.messages.map((record) => {
      const message: ChatMessageView = { id: record.id, role: record.role, text: record.text, ts: record.ts }
      if (record.toolName !== undefined) message.toolName = record.toolName
      if (record.ok !== undefined) message.toolOk = record.ok
      const args = record.toolCallId !== undefined ? argsById.get(record.toolCallId) : undefined
      if (args !== undefined) message.args = compactJson(args)
      const imageId = record.imageIds?.[0]
      if (imageId !== undefined) {
        message.imageId = imageId
        const ref = refById.get(imageId)
        if (ref !== undefined) {
          message.imageRevision = ref.revision
          message.imageView = ref.camera
        }
      }
      if (record.note !== undefined) message.gate = true
      return message
    })

    this.captures = new Map()
    for (const ref of captures.refs) {
      const png = captures.files.get(ref.id)
      if (png !== undefined) this.captures.set(ref.id, { png, revision: ref.revision, view: ref.camera })
    }

    // 用量：优先读档案自带的计数（`ChatSessionTotals`），没有才按消息数估。
    // **不能一律按消息数估**：assistant 消息数不等于轮数（一轮里可能既有正文
    // 又有多次工具调用），实测会把 13 轮显示成 "1 turns"。
    this.meter.reset()
    const totals = transcript.sessions[transcript.sessions.length - 1]?.totals
    if (totals !== undefined) {
      this.meter.add({ in: totals.in, out: totals.out, ...(totals.cachedIn !== undefined ? { cachedIn: totals.cachedIn } : {}) })
      for (let i = 0; i < totals.turns; i++) this.meter.turn()
      for (let i = 0; i < totals.toolCalls; i++) this.meter.toolCall()
      for (let i = 0; i < totals.screenshots; i++) this.meter.screenshot()
    } else {
      // 老档案（这一版之前存的）没有 totals：如实估一个下界，别假装精确
      for (const record of transcript.messages) {
        if (record.role === 'assistant' && record.usage !== undefined) {
          this.meter.add(record.usage)
          this.meter.turn()
        }
        if (record.role === 'tool') this.meter.toolCall()
        if (record.imageIds !== undefined) this.meter.screenshot()
      }
    }

    this.nextId = this.messages.reduce((max, message) => Math.max(max, message.id), 0) + 1
    this.stopReason = undefined
    this.error = undefined
    this.resetStream()
    // 换了工程：上一个工程的对话不能带进新工程的请求里
    this.modelHistory = []
    this.pendingMutations = 0
    // 录制器接着这份档案往下录：否则"打开旧工程 → 再问一轮 → 保存"会把档案抹掉
    this.recorder = new TranscriptRecorder({ title: this.recorderTitle() })
    this.recorder.seed(transcript, captures)
    const view = this.chatView()
    this.emit({ type: 'chat', view })
    return view
  }

  /**
   * **只给诊断用**：往对话里放一条模型回复，内容覆盖 markdown 的各种块。
   *
   * 为什么需要它：模型回复的 markdown 渲染、以及它在 330px 窄栏里会不会溢出，
   * 都属于"只有看一眼才知道对不对"的那类东西，而真的跑一轮模型要花钱、要联网、
   * 结果还不稳定（每次写的内容都不一样）。
   *
   * ⚠️ **它刻意绕过 `recorder`**，所以这条消息不会进 `.mcai`：一份带着假消息的
   * 工程文件比没有样本更糟。也因此它只在诊断开关下被调用（`main/index.ts`）。
   */
  seedDiagnosticMessage(text: string, toolName: string, args: string, result: string): void {
    const assistant = this.newMessage('assistant', text)
    this.messages.push(assistant)
    const tool = this.newMessage('tool', result.slice(0, 200))
    tool.toolName = toolName
    tool.args = args
    tool.toolOk = true
    tool.toolResult = result
    this.messages.push(tool)
    this.emit({ type: 'chat', view: this.view() })
  }

  clear(): ChatView {
    this.messages = []
    this.stopReason = undefined
    this.error = undefined
    this.meter.reset()
    this.resetStream()
    // 清空对话 = 也清掉发给模型的历史，否则下一轮它还记得你刚删掉的那些话
    this.modelHistory = []
    this.pendingMutations = 0
    // 录制器也要跟着重置——否则清空对话后保存，工程文件里还留着上一次的内容
    this.recorder = new TranscriptRecorder({ title: this.recorderTitle() })
    /**
     * **自己推一次 `chat` 事件**，与 `send` / `stop` 那些改动状态的方法一致。
     *
     * 不推也能"看着对"——但那是靠调用方恰好也推了 `state` 事件顺带刷新了界面，
     * 属于**巧合**。清空是一个状态变化，就该广播出去：这样无论是"新建"、
     * 菜单项还是快捷键触发的清空，界面都会跟着更新，不必每个调用点都记得刷新。
     */
    const view = this.view()
    this.emit({ type: 'chat', view })
    return view
  }

  /** 会话标题：用第一句用户输入，太长就截断。 */
  private recorderTitle(): string {
    const first = this.messages.find((message) => message.role === 'user')
    if (first === undefined) return t('desktop.untitledSession')
    return first.text.length > 60 ? `${first.text.slice(0, 60)}…` : first.text
  }

  /**
   * 供保存工程用：整场会话的消息与截图。
   *
   * **不是**界面上那份（那份有淘汰上限），是完整的。
   */
  recording(): TranscriptRecording {
    return this.recorder.recording
  }

  /** 开始一轮。**立刻返回**，过程通过事件推给界面。 */
  send(text: string, attachments?: readonly LlmImage[]): ChatView {
    if (this.running) throw new Error(t('desktop.chatBlocking.running'))
    const goal = text.trim()
    // 只有图、没有字也允许发：用户完全可能只想问"这张图你怎么看"。
    // 但两者都空就是空操作，直接拦住（原来是只看字）。
    const images = [...(attachments ?? [])]
    if (goal.length === 0 && images.length === 0) {
      throw new Error(t('desktop.chatBlocking.emptyGoal'))
    }

    const blocking = this.blocking()
    if (blocking.length > 0) throw new Error(blocking.join('；'))

    const message = this.newMessage('user', goal)
    const stored: LlmImage[] = []
    if (images.length > 0) {
      for (const image of images) {
        const id = this.storeAttachment(image)
        message.userImageIds = [...(message.userImageIds ?? []), id]
        // 回填**存起来的那一份**而不是入参：`LlmImage.id` 与预览用的 id 必须是同一个
        // 值，否则界面拿到的缩略图 key 和模型请求里的去重键会对不上。
        const kept = this.attachments.get(id)
        if (kept !== undefined) stored.push(kept)
      }
    }
    this.messages.push(message)
    this.recorder.add('user', goal)
    this.running = true
    this.stopRequested = false
    this.stopReason = undefined
    this.error = undefined
    this.emitView()
    void this.run({ text: goal, images: stored })
    return this.view()
  }

  /**
   * 收下一张用户附图，返回它的 id。
   *
   * id 与 `captures` 用同一个形状（内容寻址的 sha256 前 16 位），所以：
   *  - 同一条消息里贴两次同一张图只会存一份；
   *  - `storeAttachment` 产出的 id 直接就是 `LlmImage.id`，`send` 不用再转换。
   */
  storeAttachment(image: { png: Uint8Array; mimeType: string }): string {
    // id 一律**自己算**，不接受调用方指定：内容是唯一的真相，认内容才能去重，
    // 而认调用方给的键就等于把"同一张图存两份"和"不同图撞一个键"都放进来。
    //
    // `user:` 前缀不只是命名：`retainHistory` 靠它区分"用户给的输入"与"模型看回来的
    // 截图"，前者不许剪。见那个函数的注释。
    const hash = createHash('sha256').update(image.png).digest('hex').slice(0, 16)
    const id = `user:${hash}`
    if (!this.attachments.has(id)) {
      this.attachments.set(id, { png: image.png, mimeType: image.mimeType, id })
      while (this.attachments.size > this.maxAttachments) {
        const oldest = this.attachments.keys().next().value
        if (oldest === undefined) break
        this.attachments.delete(oldest)
      }
    }
    return id
  }

  /** 用户附图的字节（界面画缩略图、以及 `send` 回填 `LlmImage` 都走这里）。 */
  attachment(id: string): LlmImage | undefined {
    return this.attachments.get(id)
  }

  stop(): ChatView {
    if (this.running) this.stopRequested = true
    return this.view()
  }

  private view(): ChatView {
    return this.chatView()
  }

  private emitView(): void {
    this.emit({ type: 'chat', view: this.chatView() })
  }

  /**
   * 设置变了 → **两件事一起推**：设置本身，以及对话视图。
   *
   * 为什么对话视图也要推：标题行右上角那个花费读数是**从设置算出来的**
   * （价格表 + 币种），它挂在 `ChatView` 上（`costAmount` / `costCurrency`）。
   * 只推 settings 的话，改完币种那行读数还拿着上一次推的旧值——用户看到的是
   * "我明明把货币改成人民币了，右上角还是 USD"（这正是他报的）。
   *
   * 判据很简单：任何影响金额的设置改动（价格表、币种、当前 provider）都必须
   * 让这条读数重算，而它是对话视图的一部分。
   */
  private emitSettings(view: SettingsView): void {
    this.emit({ type: 'settings', view })
    this.emitView()
  }

  /**
   * 流式增量：**合并**成约 `STREAM_EMIT_MS` 一次推送。
   *
   * 几十个 token 一起来的场景下，逐条推会把 IPC 与整列重绘打满，而画面上不会有
   * 任何区别。合并之后一帧最多一次。
   */
  private emitStream(): void {
    if (this.streamTimer !== undefined) return
    this.streamTimer = setTimeout(() => {
      this.streamTimer = undefined
      this.emitView()
    }, STREAM_EMIT_MS)
  }

  /** 立刻推，并把挂起的合并推送吃掉（顺序不能乱：否则旧视图会盖在新视图后面）。 */
  private flushView(): void {
    if (this.streamTimer !== undefined) {
      clearTimeout(this.streamTimer)
      this.streamTimer = undefined
    }
    this.emitView()
  }

  private newMessage(role: ChatMessageView['role'], text: string): ChatMessageView {
    return { id: this.nextId++, role, text, ts: new Date().toISOString() }
  }

  private async run(goal: SendGoal): Promise<void> {
    try {
      const config = activeProvider(this.settings)!
      const apiKey = await resolveApiKey(config.apiKeyRef, (ref) => this.resolveRef(ref))
      const provider = this.providerFactory?.(config, apiKey) ?? createProvider(config, { ...(apiKey !== undefined ? { apiKey } : {}) })
      // **把上一轮接上**：模型看到的不是"一句话 + 一行状态"，而是这次会话到目前为止的
      // 全部往来（含它自己调过的工具与读回结果）。
      const outcome = await this.runner(
        goal,
        provider,
        (event) => this.handle(event),
        () => this.stopRequested,
        this.modelHistory,
        this.pendingMutations,
      )
      this.stopReason = outcome.stopReason
      if (outcome.error !== undefined) {
        this.error = outcome.error
        // **失败必须在对话里看得见。**
        //
        // 以前这里只写 `this.error`，而界面从来没渲染过这个字段——于是一次 provider
        // 报错看上去就是"消息发出去了、然后什么都没发生"。用户没有任何线索，
        // 只能反复重发（每一次都同样静默）。顶栏那行 `本轮结束（error）`
        // 不是给人看的失败反馈。
        this.fail(t('chat.errorLine', { message: outcome.error }))
      }
      if (outcome.messages !== undefined) this.modelHistory = retainHistory(outcome.messages)
      if (outcome.pendingMutations !== undefined) this.pendingMutations = outcome.pendingMutations
      this.meter.add(outcome.usage)
      this.recorder.attachUsage(outcome.usage, provider.model)
    } catch (error) {
      this.error = error instanceof Error ? error.message : String(error)
      this.stopReason = 'error'
      // 让用户看见失败原因，而不是一个静默停住的界面
      this.fail(this.error)
    } finally {
      this.running = false
      // 流没来得及收口就结束了（报错、被停止）：光标必须收掉，
      // 否则界面上会永远停在"正在生成"
      this.closeStream()
      this.flushView()
      this.afterRun()
    }
  }

  /** 往对话里放一条**失败**消息（红色）。用户必须看得见，不能只进顶栏那行状态。 */
  private fail(text: string): void {
    const message = this.newMessage('assistant', text)
    message.failed = true
    this.messages.push(message)
  }

  // ── 流式：把"思考中"和逐字输出都放进对话列表 ────────────────────────────────
  //
  // 顶栏那行状态（`setStatus`）是**隐藏**的，"思考中…"写在那里等于没写。所以这一轮
  // 一开始就在对话列表里落一条占位：模型想多久、吐多少字，用户都在这条上看得见。

  /** 开一条流式占位（在 `turn` 事件上）。上一轮没收口的先收掉。 */
  private openStream(turn: number): void {
    this.closeStream()
    const message = this.newMessage('assistant', '')
    message.streaming = true
    this.messages.push(message)
    this.live = message
    this.liveTurn = turn
  }

  /** 碎片到达：接到这一轮的占位上。轮次对不上就重开一条（碎片不会跨轮拼）。 */
  private appendDelta(event: Extract<AgentEvent, { type: 'assistant_delta' }>): void {
    if (this.live === undefined || this.liveTurn !== event.turn) this.openStream(event.turn)
    const live = this.live
    if (live === undefined) return
    live.text += event.text
    // 思维链**累加正文**（不是累加长度）：界面要在一行里滚动显示最新内容，也得能展开全文。
    if (event.reasoning.length > 0) live.thinking = (live.thinking ?? '') + event.reasoning
  }

  /**
   * 收口：**以完整响应为准**。
   *
   * 不用拼起来的碎片当最终结果——碎片可能因为重试或我们这边的拼接缺陷少一块，
   * 而 `assistant` 事件带的是权威的那一份。
   */
  private finishStream(text: string): void {
    const live = this.live
    if (live === undefined) {
      if (text.trim().length > 0) this.messages.push(this.newMessage('assistant', text))
      return
    }
    if (text.length > 0) live.text = text
    this.closeStream()
  }

  /**
   * 关掉当前这条流式消息。
   *
   * 空的（一个字都没吐出来，比如"这一轮只调工具"）**直接摘掉**：留着就是一个
   * 永远空着的空气泡。有内容的留下，只是把光标收掉。
   */
  private closeStream(): void {
    const live = this.live
    this.live = undefined
    this.liveTurn = undefined
    if (live === undefined) return
    live.streaming = false
    // **刻意不删 `thinking`**：生成完之后那一段仍然要能点开回看（"它当时在想什么"
    // 是排查"模型为什么这么改"最直接的线索）。界面默认把它收成一行。
    if (live.text.trim().length === 0) this.messages = this.messages.filter((message) => message !== live)
  }

  /** 丢掉当前这条（重试时用）：上次尝试的碎片要作废，重试会从头再吐一遍。 */
  private discardStream(): void {
    const live = this.live
    this.live = undefined
    this.liveTurn = undefined
    if (live !== undefined) this.messages = this.messages.filter((message) => message !== live)
  }

  /** 换工程 / 清空对话：流式状态与挂起的推送一并丢掉（那些碎片已不属于这批消息）。 */
  private resetStream(): void {
    this.discardStream()
    if (this.streamTimer !== undefined) {
      clearTimeout(this.streamTimer)
      this.streamTimer = undefined
    }
  }

  private handle(event: AgentEvent): void {
    // 先录制，再更新界面：录制是"档案"，界面是"视图"，档案不该因为界面某条分支
    // 提前 return 就丢掉内容
    this.recorder.onEvent(event)
    // 增量走合并推送（字往外冒，一帧一次够了）；其余事件必须立刻可见
    let streaming = false
    switch (event.type) {
      case 'turn':
        this.meter.turn()
        // 「思考中…」进对话列表：这一轮到出字之前，用户就盯着这条
        this.openStream(event.turn)
        break
      case 'assistant_delta':
        this.appendDelta(event)
        streaming = true
        break
      case 'assistant':
        this.finishStream(event.text)
        break
      case 'tool_call': {
        // 只看不说的那一轮（只调工具、正文空）：把占位收掉，别留空气泡
        this.closeStream()
        const message = this.newMessage('tool', event.name)
        message.toolName = event.name
        message.args = compactJson(event.args)
        this.messages.push(message)
        this.meter.toolCall()
        break
      }
      case 'tool_result': {
        // **只查一次**：查到之后立刻把 toolOk 写上，再查就找不到它了
        const message = this.lastToolMessage(event.name)
        if (message !== undefined) {
          message.toolOk = event.result.ok
          message.text = summarize(event.result)
          message.toolResult = fullResult(event.result)
          const image = event.result.image
          if (image !== undefined) {
            message.imageId = this.storeCapture(image.png, image.revision, image.camera)
            message.imageRevision = image.revision
            message.imageView = image.camera
            this.meter.screenshot()
          }
        }
        break
      }
      case 'nudge': {
        const message = this.newMessage('assistant', `[GATE] ${event.reason} (${event.pendingMutations})`)
        message.gate = true
        this.messages.push(message)
        break
      }
      case 'context': {
        // 上下文裁剪：**不是错误**，但它解释了"模型为什么忘了前面那几步"。
        // 不显示的话，用户只会觉得模型变笨了。
        const message = this.newMessage(
          'assistant',
          t('desktop.contextTrimmed', {
            turns: event.droppedTurns,
            images:
              event.droppedImages > 0 ? t('desktop.contextImages', { count: event.droppedImages }) : '',
            reason: event.reason,
          }),
        )
        message.gate = true
        this.messages.push(message)
        break
      }
      case 'retry': {
        // 上一次尝试的碎片**作废**：重试会从头再吐一遍，留着就是同一句话出现两次
        this.discardStream()
        const message = this.newMessage('assistant', `[retry ${event.attempt}] ${event.reason}`)
        message.gate = true
        this.messages.push(message)
        break
      }
      case 'truncated': {
        // 输出撞上 token 上限。**必须显示**：这一轮多半是"正文空、工具零"，
        // 不显示的话用户看到的就是"发了消息没反应"（plan §16 记过这个翻车）。
        const message = this.newMessage('assistant', t('chat.truncated', { out: String(event.out) }))
        message.gate = true
        this.messages.push(message)
        break
      }
      case 'stop':
        this.stopReason = event.reason
        break
      default:
        break
    }
    if (streaming) this.emitStream()
    else this.flushView()
    // 工具刚返回：**立刻**把可能前进的世界版本推出去（宿主自己判断有没有改动）
    if (event.type === 'tool_result') this.afterTool()
  }

  private lastToolMessage(name: string): ChatMessageView | undefined {
    for (let i = this.messages.length - 1; i >= 0; i--) {
      const message = this.messages[i]!
      if (message.role === 'tool' && message.toolName === name && message.toolOk === undefined) return message
    }
    return undefined
  }

  private storeCapture(png: Uint8Array, revision: number, view: string): string {
    const id = createHash('sha256').update(png).digest('hex').slice(0, 16)
    // 内容寻址：同一张图天然只存一份（plan §7.3）
    if (!this.captures.has(id)) {
      this.captures.set(id, { png, revision, view })
      while (this.captures.size > this.maxCaptures) {
        const oldest = this.captures.keys().next().value
        if (oldest === undefined) break
        this.captures.delete(oldest)
      }
    }
    return id
  }

  capture(id: string): Uint8Array | undefined {
    return this.captures.get(id)?.png
  }

  get captureCount(): number {
    return this.captures.size
  }

  /** 会话累计用量（主进程收尾统计用）。 */
  get totals(): UsageTotals {
    return this.meter.value
  }
}

function summarize(result: ToolResult): string {
  const first = result.summary.split('\n')[0] ?? ''
  return first.length > 400 ? `${first.slice(0, 400)}…` : first
}

/**
 * 工具返回的**完整**内容，给界面折叠展开用。
 *
 * 两段拼起来：完整 `summary`（LLM 读的那一份，人也能读）+ 结构化 `data` 的 JSON。
 * `data` 也要给：模型"把参数传成了什么"与"世界实际长什么样"常常只有对着它才说得清
 * （`verify` 的逐条结论、`slice` 的坐标、`analyze_structure` 的问题列表都在里面）。
 *
 * 空的时候给空串，让界面自己决定显示"（空）"——这里替它编一句人话反而会把
 * "真的没有返回"和"返回了空"混成一样。
 */
function fullResult(result: ToolResult): string {
  const parts = [result.summary]
  if (result.error !== undefined) parts.push(`error: ${result.error.code} ${result.error.message}`)
  if (result.data !== undefined && Object.keys(result.data).length > 0) {
    try {
      parts.push(JSON.stringify(result.data, null, 2))
    } catch {
      // 循环引用之类：`data` 是我们自己造的，理论上不会有，但没必要为了一个折叠块抛
      parts.push('(data 无法序列化)')
    }
  }
  return parts.join('\n\n')
}

/**
 * 下一轮要接上的历史。**只做一件事：把上一轮的截图丢掉。**
 *
 * 为什么丢图：截图对下一轮**已经过期**——revision 变了，而系统提示里明确要求
 * "图与当前 revision 不一致就作废那个判断"。把过期的大图每轮重发一遍，
 * 是纯粹的钱（一张 800×800 的图要吃掉几千 token）。信息不丢：工具结果里
 * 仍然留着"截了哪张图、哪个 revision"那一行。
 *
 * **用户自己给的图不丢。** 判据是 `id` 上的 `user:` 前缀（见 `storeAttachment`）。
 * 这一条踩过：原来这里是"有图就丢"，于是用户贴的参考图只在当轮可见，
 * 下一轮模型就忘了自己看过什么——而用户贴图的意思恰恰是"以后都按这张来"。
 * 模型自己截的那些才是过期的，因为世界已经变了；人给的图不会因为改了几格就失效。
 *
 * 为什么其余字段原样带：`reasoningContent` 必须回传（DeepSeek 要求带了 tools 的
 * 请求里历史每一轮的思维链原样回传，否则 400），`toolCalls` 与 `toolCallId`
 * 的配对关系也不能动。
 */
function retainHistory(messages: readonly LlmMessage[]): LlmMessage[] {
  return messages.map((message) => {
    if (message.images === undefined || message.images.length === 0) return { ...message }
    const kept = message.images.filter((image) => (image.id ?? '').startsWith('user:'))
    const dropped = message.images.length - kept.length
    if (dropped === 0) return { ...message, images: kept }
    const { images: _dropped, ...rest } = message
    return {
      ...rest,
      ...(kept.length > 0 ? { images: kept } : {}),
      content: `${message.content}\n(${dropped} screenshot(s) omitted from retained history)`,
    }
  })
}

function compactJson(value: unknown): string {
  try {
    const text = JSON.stringify(value ?? {})
    return text.length > 300 ? `${text.slice(0, 300)}…` : text
  } catch {
    return t('desktop.unserializableArgs')
  }
}

/**
 * 两份能力描述是不是同一份。
 *
 * 用来判断探针有没有**真的改到东西**——没变就别动设置、别写盘。用 JSON 全量比较而不是
 * 只比 `vision`：`toolCalling` / `imageTokenCost` / `contextWindow` 都是探针的结论，
 * 漏比一个就会让那个字段永远停在旧值上（这次这个 bug 就是这么来的）。
 */
function sameCapabilities(
  a: ProviderConfig['capabilities'],
  b: ProviderConfig['capabilities'],
): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}
