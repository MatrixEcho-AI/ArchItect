import { createHash } from 'node:crypto'

import {
  activeProvider,
  createProvider,
  discoverProvider,
  resolveApiKey,
  UsageMeter,
  validateProviderConfig,
  addPreset,
  defaultSettings,
} from '@architect/agent'
import type {
  AgentEvent,
  Budget,
  CostTable,
  DiscoveryResult,
  LlmProvider,
  PresetKey,
  ProviderConfig,
  ProviderSettings,
  SettingsIssue,
  UsageTotals,
} from '@architect/agent'
import { TranscriptRecorder } from '@architect/mcai'
import type { TranscriptRecording } from '@architect/mcai'
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
  /** 完成闸门的提醒（§9.4）。 */
  gate?: boolean
  ts: string
}

export interface ChatView {
  running: boolean
  messages: ChatMessageView[]
  usage: UsageTotals
  costUsd?: number
  stopReason?: string
  error?: string
  /** 被预算刹住的原因（如果有）。与 `error` 分开：这不是故障。 */
  budgetStop?: string
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
  budget?: Budget
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

export type ChatRunner = (
  goal: string,
  provider: LlmProvider,
  onEvent: (event: AgentEvent) => void,
  shouldStop: () => boolean,
) => Promise<{ stopReason: string; error?: string; usage: { in: number; out: number; cachedIn?: number } }>

export interface ChatOptions {
  settings?: ProviderSettings
  secrets?: SecretStore
  /** 截图缓存上限。够了就丢掉最旧的——它只是界面上的一张缩略图，能重新渲染出来。 */
  maxCaptures?: number
  /** 测试注入用：替换 provider 构造。 */
  providerFactory?: (config: ProviderConfig, apiKey: string | undefined) => LlmProvider
}

export class ChatController {
  private settings: ProviderSettings
  private readonly secrets: SecretStore
  private readonly maxCaptures: number
  private readonly providerFactory: ChatOptions['providerFactory'] | undefined

  private messages: ChatMessageView[] = []
  private captures = new Map<string, { png: Uint8Array; revision: number; view: string }>()
  private running = false
  private stopRequested = false
  private stopReason: string | undefined
  private error: string | undefined
  private nextId = 1
  private meter = new UsageMeter()
  private issues: SettingsIssue[] = []
  /**
   * 对话录制器。
   *
   * 与界面那份 `messages` **刻意分开**：界面只留最近 60 张截图（内存有限），
   * 而工程文件要存下整场会话的全部截图与消息。录制器不做淘汰，界面做。
   */
  private recorder: TranscriptRecorder
  /** 最近一次预算刹车的原因。界面据此把"停下来"解释清楚。 */
  private budgetStop: string | undefined
  /** 由 StudioService 注入：真正跑 agent 循环的那个函数。 */
  private runner: ChatRunner
  private emit: (event: StudioEvent) => void = () => {}
  private afterRun: () => void = () => {}

  constructor(
    options: ChatOptions,
    runner: ChatRunner,
  ) {
    this.settings = options.settings ?? defaultSettings()
    this.secrets = options.secrets ?? { location: '(未配置)', encrypted: false, get: () => undefined, set: () => false, has: () => false, remove: () => {} }
    this.maxCaptures = options.maxCaptures ?? 60
    this.providerFactory = options.providerFactory
    this.runner = runner
    this.recorder = new TranscriptRecorder({ title: '未命名会话' })
  }

  onEvent(listener: (event: StudioEvent) => void): void {
    this.emit = listener
  }

  /** 一轮结束后回调（StudioService 用它刷新世界状态快照）。 */
  onAfterRun(listener: () => void): void {
    this.afterRun = listener
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
      ...(this.settings.budget !== undefined ? { budget: this.settings.budget } : {}),
      locale: this.settings.locale ?? 'zh-CN',
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
    const target: ProviderConfig = { ...config }
    if (apiKeyPlain !== undefined && apiKeyPlain.trim().length > 0) {
      const id = config.id
      if (this.secrets.set(id, apiKeyPlain.trim())) {
        target.apiKeyRef = `safe:${id}`
      } else {
        this.issues = [
          ...this.issues.filter((i) => i.field !== 'apiKeyRef'),
          {
            field: 'apiKeyRef',
            message: '这台机器上系统钥匙串不可用，密钥没有保存。请改用环境变量：export ARCHITECT_API_KEY=...',
          },
        ]
      }
    }
    const providers = this.settings.providers.filter((p) => p.id !== target.id)
    providers.push(target)
    this.settings = { ...this.settings, providers, activeId: target.id }
    // 模型/能力变了，之前那轮对话的失败原因就不适用了
    this.error = undefined
    const view = this.settingsView()
    this.emit({ type: 'settings', view })
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
    this.emit({ type: 'settings', view })
    return view
  }

  /** 按预设加一个新实例并设为当前。 */
  addProvider(key: PresetKey): SettingsView {
    const config = addPreset(this.settings, key)
    this.settings = { ...this.settings, activeId: config.id }
    const view = this.settingsView()
    this.emit({ type: 'settings', view })
    return view
  }

  setActive(id: string): SettingsView {
    this.settings = { ...this.settings, activeId: id }
    const view = this.settingsView()
    this.emit({ type: 'settings', view })
    return view
  }

  setBudget(budget: Budget | undefined): SettingsView {
    const next: ProviderSettings = { ...this.settings }
    if (budget === undefined) delete next.budget
    else next.budget = budget
    this.settings = next
    const view = this.settingsView()
    this.emit({ type: 'settings', view })
    return view
  }

  setLocale(locale: 'zh-CN' | 'en-US'): SettingsView {
    this.settings = { ...this.settings, locale }
    const view = this.settingsView()
    this.emit({ type: 'settings', view })
    return view
  }

  setUi(patch: { view?: string; requireVerification?: boolean }): SettingsView {
    this.settings = { ...this.settings, ui: { ...this.settings.ui, ...patch } }
    const view = this.settingsView()
    this.emit({ type: 'settings', view })
    return view
  }

  // ── 连接测试（D-12） ────────────────────────────────────────────────────────

  /**
   * 探测一个端点，**并把结果写回配置**。
   *
   * 界面上刚输入的明文密钥只在这一次探测里用，不落盘——用户还没点保存。
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
    return result
  }

  private resolveRef(ref: string): string | undefined {
    if (ref.startsWith('safe:')) return this.secrets.get(ref.slice(5))
    if (ref.startsWith('env:')) return process.env[ref.slice(4)]
    return undefined
  }

  // ── 对话 ────────────────────────────────────────────────────────────────────

  chatView(): ChatView {
    return {
      running: this.running,
      messages: this.messages.map((m) => ({ ...m })),
      usage: this.meter.value,
      ...(this.meter.costUsd(this.activeCost()) !== undefined
        ? { costUsd: this.meter.costUsd(this.activeCost()) }
        : {}),
      ...(this.stopReason !== undefined ? { stopReason: this.stopReason } : {}),
      ...(this.error !== undefined ? { error: this.error } : {}),
      ...(this.budgetStop !== undefined ? { budgetStop: this.budgetStop } : {}),
      ready: this.blocking().length === 0,
      blocking: this.blocking(),
    }
  }

  private activeCost(): CostTable | undefined {
    return activeProvider(this.settings)?.cost
  }

  private blocking(): string[] {
    const config = activeProvider(this.settings)
    if (config === undefined) return ['还没有配置模型']
    const problems = validateProviderConfig(config).filter(
      (problem) => problem.field === 'baseURL' || problem.field === 'apiKeyRef',
    )
    const out = problems.map((p) => p.message)
    if (config.model.trim().length === 0) {
      out.push('还没选定模型——到「设置」里点一次「测试连接」让程序从 GET /models 里挑一个')
    } else if (!this.hasKey(config)) {
      out.push(
        config.apiKeyRef.startsWith('env:')
          ? `环境变量 ${config.apiKeyRef.slice(4)} 没有设置`
          : '密钥还没有保存到本机密钥库',
      )
    }
    return out
  }

  clear(): ChatView {
    this.messages = []
    this.stopReason = undefined
    this.error = undefined
    this.meter.reset()
    // 录制器也要跟着重置——否则清空对话后保存，工程文件里还留着上一次的内容
    this.recorder = new TranscriptRecorder({ title: this.recorderTitle() })
    return this.view()
  }

  /** 会话标题：用第一句用户输入，太长就截断。 */
  private recorderTitle(): string {
    const first = this.messages.find((message) => message.role === 'user')
    if (first === undefined) return '未命名会话'
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
  send(text: string): ChatView {
    if (this.running) throw new Error('上一轮还在进行中')
    const goal = text.trim()
    if (goal.length === 0) throw new Error('需求是空的')

    const blocking = this.blocking()
    if (blocking.length > 0) throw new Error(blocking.join('；'))

    this.messages.push(this.newMessage('user', goal))
    this.recorder.add('user', goal)
    this.running = true
    this.stopRequested = false
    this.stopReason = undefined
    this.error = undefined
    this.budgetStop = undefined
    this.emitView()
    void this.run(goal)
    return this.view()
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

  private newMessage(role: ChatMessageView['role'], text: string): ChatMessageView {
    return { id: this.nextId++, role, text, ts: new Date().toISOString() }
  }

  private async run(goal: string): Promise<void> {
    try {
      const config = activeProvider(this.settings)!
      const apiKey = await resolveApiKey(config.apiKeyRef, (ref) => this.resolveRef(ref))
      const provider = this.providerFactory?.(config, apiKey) ?? createProvider(config, { ...(apiKey !== undefined ? { apiKey } : {}) })
      const outcome = await this.runner(goal, provider, (event) => this.handle(event), () => this.stopRequested)
      this.stopReason = outcome.stopReason
      if (outcome.error !== undefined) this.error = outcome.error
      this.meter.add(outcome.usage)
      this.recorder.attachUsage(outcome.usage, provider.model)
    } catch (error) {
      this.error = error instanceof Error ? error.message : String(error)
      this.stopReason = 'error'
      // 让用户看见失败原因，而不是一个静默停住的界面
      this.messages.push(this.newMessage('assistant', this.error))
    } finally {
      this.running = false
      this.emitView()
      this.afterRun()
    }
  }

  private handle(event: AgentEvent): void {
    // 先录制，再更新界面：录制是"档案"，界面是"视图"，档案不该因为界面某条分支
    // 提前 return 就丢掉内容
    this.recorder.onEvent(event)
    switch (event.type) {
      case 'turn':
        this.meter.turn()
        break
      case 'assistant':
        if (event.text.trim().length > 0) this.messages.push(this.newMessage('assistant', event.text))
        break
      case 'tool_call': {
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
      case 'budget': {
        // 预算刹车：**不是错误**，界面要把它和"模型跑错了"区分开
        const message = this.newMessage('assistant', `[BUDGET] ${event.detail}`)
        message.gate = true
        this.messages.push(message)
        this.budgetStop = event.detail
        break
      }
      case 'retry': {
        const message = this.newMessage('assistant', `[retry ${event.attempt}] ${event.reason}`)
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
    this.emitView()
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

function compactJson(value: unknown): string {
  try {
    const text = JSON.stringify(value ?? {})
    return text.length > 300 ? `${text.slice(0, 300)}…` : text
  } catch {
    return '(无法序列化的参数)'
  }
}
