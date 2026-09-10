import { initI18n, onLocaleChange, setLocale, t } from '@architect/i18n'
import type { MessageKey } from '@architect/i18n'

/**
 * 渲染进程：**一个哑视图**。
 *
 * 它不持有世界、不跑体素逻辑、不打包任何 workspace 包进浏览器——
 * 所有的渲染和编辑都在主进程完成，这里只要 PNG、文本和事件。
 * 代价是交互有 IPC 往返，但换来了极简的构建（不需要前端打包器）。
 *
 * 唯一的例外是 `@architect/i18n`：它没有 Node 依赖，被打进这份 bundle 里，
 * 这样文案切换是即时的，不需要为了翻一句话去往返一趟主进程。
 */

// ── 主进程传过来的数据类型（与 studio.ts / chat.ts 对齐） ──────────────────────

interface StudioState {
  projectPath?: string
  name: string
  minecraftVersion: string
  revision: number
  totalOps: number
  blocks: number
  bounds?: { min: [number, number, number]; max: [number, number, number] }
  volume: { min: [number, number, number]; max: [number, number, number] }
  paletteSize: number
  ops: Array<{ rev: number; tool: string; changed: number; ts: string }>
  histogram: Array<{ block: string; count: number; percent: number }>
  /** 一次性提示（崩溃恢复之类）。主进程读过就没了，所以界面要自己留住。 */
  notice?: string
}

interface ChatMessageView {
  id: number
  role: 'user' | 'assistant' | 'tool'
  text: string
  toolName?: string
  toolOk?: boolean
  args?: string
  imageId?: string
  imageRevision?: number
  imageView?: string
  gate?: boolean
}

interface ChatView {
  running: boolean
  messages: ChatMessageView[]
  usage: { in: number; out: number; cachedIn: number; turns: number; toolCalls: number; screenshots: number }
  costUsd?: number
  stopReason?: string
  error?: string
  /** 被预算刹住的原因（如果有）。**不是故障**，界面要说清楚。 */
  budgetStop?: string
  ready: boolean
  blocking: string[]
}

interface ProviderView {
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

interface SettingsView {
  activeId: string
  providers: ProviderView[]
  budget?: { maxUsd?: number; maxTokensOut?: number; maxTurns?: number }
  locale: 'zh-CN' | 'en-US'
  ui: { view?: string; requireVerification?: boolean }
  secrets: { location: string; encrypted: boolean }
  issues: Array<{ field: string; message: string }>
}

type ProbeStep =
  | { type: 'models'; count: number; models: string[] }
  | { type: 'model'; model: string; matched?: string; guessed?: boolean }
  | { type: 'text'; ok: boolean; tokensIn?: number; error?: string }
  | { type: 'tools'; mode: string }
  | { type: 'vision'; vision: boolean; imageTokenCost?: number; error?: string }
  | { type: 'capabilities'; capabilities: ProviderView['capabilities'] }
  | { type: 'error'; error: string }

interface DiscoveryResult {
  ok: boolean
  config: ProviderView
  models: string[]
  steps: ProbeStep[]
  error?: string
}

type StudioEvent =
  | { type: 'chat'; view: ChatView }
  | { type: 'settings'; view: SettingsView }
  | { type: 'state'; state: StudioState }

interface ArchitectBridge {
  state(): Promise<StudioState>
  measureText(): Promise<string>
  newProject(): Promise<StudioState>
  open(): Promise<StudioState | undefined>
  save(path?: string): Promise<string | undefined>
  seek(revision: number): Promise<StudioState>
  seekLatest(): Promise<StudioState>
  shoot(request: { view: string; width: number; height: number; highlightLast?: boolean }): Promise<{
    png: Uint8Array
    view: string
    revision: number
  }>
  slice(request: { axis: 'x' | 'y' | 'z'; index: number }): Promise<string>
  demo(): Promise<StudioState>
  exportModel(format: string, suggestedName?: string): Promise<{ paths: string[]; summary: string } | undefined>
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

  settings(): Promise<SettingsView>
  saveProvider(config: unknown, apiKeyPlain?: string): Promise<SettingsView>
  removeProvider(id: string): Promise<SettingsView>
  addProvider(preset: string): Promise<SettingsView>
  setActive(id: string): Promise<SettingsView>
  setBudget(budget: unknown): Promise<SettingsView>
  setLocale(locale: string): Promise<SettingsView>
  setUi(patch: unknown): Promise<SettingsView>
  testConnection(input: unknown): Promise<DiscoveryResult>

  chat(): Promise<ChatView>
  send(text: string): Promise<ChatView>
  stop(): Promise<ChatView>
  clearChat(): Promise<ChatView>
  chatImage(id: string): Promise<Uint8Array | undefined>

  subscribe(listener: (event: StudioEvent) => void): () => void
  ready(report: { ok: boolean; detail: string }): Promise<void>
}

declare global {
  interface Window {
    architect: ArchitectBridge
  }
}

const RENDER_WIDTH = 900
const RENDER_HEIGHT = 640

const el = <T extends HTMLElement>(id: string): T => {
  const found = document.getElementById(id)
  if (found === null) throw new Error(`缺少元素 #${id}`)
  return found as T
}

const canvas = el<HTMLCanvasElement>('canvas')
const ctx = canvas.getContext('2d')
const statusEl = el('status')
const empty = el('empty')
const scrub = el<HTMLInputElement>('scrub')
const revLabel = el('rev-label')
const viewSelect = el<HTMLSelectElement>('view')
const messagesEl = el<HTMLOListElement>('messages')
const blockingEl = el('blocking')
const noticeEl = el('notice')
const chatInput = el<HTMLTextAreaElement>('chat-input')
const sendButton = el<HTMLButtonElement>('btn-send')
const stopButton = el<HTMLButtonElement>('btn-stop')
const usageEl = el('chat-usage')
const costEl = el('cost')
const settingsDialog = el<HTMLDialogElement>('settings-dialog')

let current: StudioState | undefined
let chat: ChatView | undefined
let settings: SettingsView | undefined
let view = 'iso_ne'
/** 请求序号：防止慢的旧渲染覆盖新结果。 */
let shootToken = 0
/** 截图 blob 缓存：同一张图不重复走 IPC，也不重复建 objectURL。 */
const imageUrls = new Map<string, string>()
/** 正在设置里编辑的 provider（可能与当前生效的那个不同）。 */
let editing: ProviderView | undefined

// ── i18n ──────────────────────────────────────────────────────────────────────

/** 把 `data-i18n` / `data-i18n-placeholder` 的静态文案刷一遍。 */
function applyStaticText(): void {
  for (const node of document.querySelectorAll<HTMLElement>('[data-i18n]')) {
    const key = node.dataset['i18n']
    if (key !== undefined) node.textContent = t(key as MessageKey)
  }
  for (const node of document.querySelectorAll<HTMLElement>('[data-i18n-placeholder]')) {
    const key = node.dataset['i18nPlaceholder']
    if (key !== undefined) node.setAttribute('placeholder', t(key as MessageKey))
  }
}

const presetLabel = (preset: string): string => t(`settings.presets.${preset}` as MessageKey)

// ── 状态与错误 ────────────────────────────────────────────────────────────────

function setStatus(text: string): void {
  statusEl.textContent = text
}

async function guard<T>(label: string, fn: () => Promise<T>): Promise<T | undefined> {
  try {
    setStatus(t('app.busy', { label }))
    const result = await fn()
    setStatus(t('app.ready'))
    return result
  } catch (error) {
    setStatus(t('app.failed', { label, message: error instanceof Error ? error.message : String(error) }))
    return undefined
  }
}

// ── 视口 ──────────────────────────────────────────────────────────────────────

async function shoot(): Promise<void> {
  if (ctx === null || current === undefined) return
  if (current.blocks === 0) {
    empty.classList.add('show')
    ctx.clearRect(0, 0, canvas.width, canvas.height)
    return
  }
  const token = ++shootToken
  const image = await guard(t('viewport.camera'), () =>
    window.architect.shoot({ view, width: RENDER_WIDTH, height: RENDER_HEIGHT }),
  )
  // 慢的旧请求回来时丢弃
  if (image === undefined || token !== shootToken) return
  empty.classList.remove('show')

  const blob = new Blob([image.png as unknown as BlobPart], { type: 'image/png' })
  const url = URL.createObjectURL(blob)
  await new Promise<void>((resolve) => {
    const img = new Image()
    img.onload = () => {
      canvas.width = img.width
      canvas.height = img.height
      ctx.drawImage(img, 0, 0)
      URL.revokeObjectURL(url)
      resolve()
    }
    img.onerror = () => {
      URL.revokeObjectURL(url)
      setStatus(t('viewport.shotDecodeFailed'))
      resolve()
    }
    img.src = url
  })
}

// ── 左侧面板 ──────────────────────────────────────────────────────────────────

function renderPanel(next: StudioState): void {
  current = next
  // 提示是一次性的（主进程读过就清），所以在这里留住，别让它被下一次状态刷新冲掉
  if (next.notice !== undefined) showNotice(next.notice)

  const rows: Array<[string, string]> = [
    [t('panel.info.name'), next.name],
    [t('panel.info.revision'), `${next.revision} / ${next.totalOps}`],
    [t('panel.info.blocks'), String(next.blocks)],
    [t('panel.info.palette'), String(next.paletteSize)],
    [t('panel.info.minecraft'), next.minecraftVersion],
  ]
  if (next.bounds !== undefined) {
    const [a, b] = [next.bounds.min, next.bounds.max]
    rows.push([t('panel.info.bounds'), `${a.join(',')} … ${b.join(',')}`])
  }
  if (next.projectPath !== undefined) {
    rows.push([t('panel.info.file'), next.projectPath.split('/').pop() ?? ''])
  }
  el('project-info').innerHTML = rows
    .map(([key, value]) => `<dt>${escapeHtml(key)}</dt><dd>${escapeHtml(value)}</dd>`)
    .join('')

  el('histogram').innerHTML = next.histogram
    .map(
      (entry) =>
        `<li><span>${escapeHtml(entry.block.replace('minecraft:', ''))}</span>` +
        `<span>${entry.count} · ${entry.percent}%</span></li>`,
    )
    .join('')

  el('ops').innerHTML = next.ops
    .slice()
    .reverse()
    .map(
      (op) =>
        `<li><span class="rev">${op.rev}</span><b>${escapeHtml(op.tool)}</b>` +
        `<span>${op.changed}</span></li>`,
    )
    .join('')

  scrub.max = String(next.totalOps)
  scrub.value = String(next.revision)
  revLabel.textContent = t('timeline.revision', { rev: next.revision, total: next.totalOps })
  const atHead = next.revision === next.totalOps
  el<HTMLButtonElement>('btn-latest').disabled = atHead
  scrub.disabled = next.totalOps === 0
}

/** 可关闭的横幅。**不自动消失**——它说的是"有一份未保存的草稿"，值得用户看第二眼。 */
function showNotice(text: string): void {
  noticeEl.classList.remove('hidden')
  noticeEl.replaceChildren()
  const body = document.createElement('b')
  body.textContent = text
  const close = document.createElement('button')
  close.type = 'button'
  close.className = 'mini'
  close.textContent = '✕'
  close.addEventListener('click', () => noticeEl.classList.add('hidden'))
  noticeEl.append(body, close)
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c,
  )
}

// ── 对话 ──────────────────────────────────────────────────────────────────────

function renderChat(next: ChatView): void {
  chat = next
  sendButton.disabled = next.running
  stopButton.classList.toggle('hidden', !next.running)
  chatInput.disabled = next.running

  if (next.blocking.length > 0) {
    blockingEl.classList.remove('hidden')
    blockingEl.innerHTML = `<b>${escapeHtml(t('chat.noProvider'))}</b><ul>${next.blocking
      .map((item) => `<li>${escapeHtml(item)}</li>`)
      .join('')}</ul>`
  } else {
    blockingEl.classList.add('hidden')
    blockingEl.innerHTML = ''
  }

  // 整列重建：消息是几十条量级，diff 不值得（也更不容易出错）
  messagesEl.replaceChildren(...next.messages.map(renderMessage))

  const parts = [
    t('cost.tokens', { in: next.usage.in, out: next.usage.out }),
    `${next.usage.turns} turns · ${next.usage.toolCalls} tools · ${next.usage.screenshots} shots`,
  ]
  usageEl.textContent = parts.join('   ')
  costEl.textContent =
    next.costUsd !== undefined
      ? t('cost.usd', { amount: next.costUsd.toFixed(4) })
      : next.usage.in > 0
        ? t('cost.noPrice')
        : ''
  if (next.running) setStatus(t('chat.thinking'))
  else if (next.budgetStop !== undefined) setStatus(next.budgetStop)
  else if (next.stopReason !== undefined) setStatus(t('chat.turnDone', { reason: next.stopReason }))

  // 滚到底部（正在生成时尤其重要）
  messagesEl.scrollTop = messagesEl.scrollHeight
}

function renderMessage(message: ChatMessageView): HTMLLIElement {
  const li = document.createElement('li')
  li.className = message.gate === true ? `${message.role} gate` : message.role
  li.dataset['messageId'] = String(message.id)

  const who = document.createElement('span')
  who.className = 'who'
  who.textContent =
    message.gate === true
      ? t('chat.nudge')
      : message.role === 'tool'
        ? `${t('chat.toolCall')} · ${message.toolName ?? ''}`
        : message.role === 'user'
          ? 'you'
          : t('app.name')
  li.append(who)

  if (message.args !== undefined && message.args !== '{}') {
    const tag = document.createElement('span')
    tag.className = 'tag'
    tag.textContent = message.args
    li.append(tag)
  }

  if (message.role === 'tool' && message.toolOk === false) li.classList.add('bad')

  const body = document.createElement('div')
  body.textContent = message.text
  li.append(body)

  if (message.imageId !== undefined) {
    const img = document.createElement('img')
    img.className = 'shot'
    img.alt = `rev ${message.imageRevision ?? '?'} ${message.imageView ?? ''}`
    img.addEventListener('click', () => img.classList.toggle('zoom'))
    void loadImage(message.imageId, img)
    li.append(img)
  }
  return li
}

async function loadImage(id: string, img: HTMLImageElement): Promise<void> {
  const cached = imageUrls.get(id)
  if (cached !== undefined) {
    img.src = cached
    return
  }
  try {
    const bytes = await window.architect.chatImage(id)
    if (bytes === undefined) return
    const url = URL.createObjectURL(new Blob([bytes as unknown as BlobPart], { type: 'image/png' }))
    imageUrls.set(id, url)
    img.src = url
  } catch {
    // 截图被缓存淘汰是正常的，静默跳过
  }
}

// ── 设置 ──────────────────────────────────────────────────────────────────────

function renderSettings(next: SettingsView): void {
  settings = next
  const select = el<HTMLSelectElement>('provider-select')
  select.replaceChildren(
    ...next.providers.map((provider) => {
      const option = document.createElement('option')
      option.value = provider.id
      option.textContent = `${provider.id}  ·  ${presetLabel(provider.preset)}`
      return option
    }),
  )
  const target = editing !== undefined && next.providers.some((p) => p.id === editing!.id)
    ? editing.id
    : next.activeId
  select.value = target
  loadFields(next.providers.find((p) => p.id === target))

  el<HTMLSelectElement>('cfg-locale').value = next.locale
  ;(el<HTMLInputElement>('cfg-usd')).value = next.budget?.maxUsd !== undefined ? String(next.budget.maxUsd) : ''
  ;(el<HTMLInputElement>('cfg-turns')).value =
    next.budget?.maxTurns !== undefined ? String(next.budget.maxTurns) : ''
}

/** 预设按钮：一键加一个实例（D-14 四项）。 */
function renderPresetButtons(): void {
  const row = el('preset-row')
  row.replaceChildren(
    ...['deepseek', 'openai', 'ollama', 'custom'].map((preset) => {
      const button = document.createElement('button')
      button.type = 'button'
      button.textContent = presetLabel(preset)
      button.addEventListener('click', () => {
        void guard(t('settings.addProvider'), async () => {
          const view = await window.architect.addProvider(preset)
          editing = view.providers.find((p) => p.id === view.activeId)
          renderSettings(view)
          setProbeLog(t('settings.llm.testing'))
        })
      })
      return button
    }),
  )
}

function loadFields(provider: ProviderView | undefined): void {
  editing = provider
  if (provider === undefined) return
  el<HTMLInputElement>('cfg-baseurl').value = provider.baseURL
  el<HTMLInputElement>('cfg-model').value = provider.model
  const key = el<HTMLInputElement>('cfg-key')
  key.value = ''
  key.placeholder = provider.hasKey
    ? t('settings.llm.keyPresent')
    : provider.envName !== undefined
      ? `env:${provider.envName}`
      : ''
}

function collectConfig(): { config: Record<string, unknown>; plain?: string } {
  const base = editing
  const keyPlain = el<HTMLInputElement>('cfg-key').value
  const config: Record<string, unknown> = {
    id: base?.id ?? 'custom',
    preset: base?.preset ?? 'custom',
    kind: base?.kind ?? 'openai-compatible',
    baseURL: el<HTMLInputElement>('cfg-baseurl').value.trim(),
    apiKeyRef: base?.apiKeyRef ?? '',
    model: el<HTMLInputElement>('cfg-model').value.trim(),
    capabilities: base?.capabilities ?? {
      vision: false,
      toolCalling: 'native',
      promptCache: 'none',
      source: 'preset',
    },
  }
  if (base?.cost !== undefined) config['cost'] = base.cost
  return keyPlain.trim().length > 0 ? { config, plain: keyPlain } : { config }
}

function setProbeLog(text: string): void {
  el('probe-log').textContent = text
}

async function runProbe(listOnly: boolean): Promise<void> {
  if (editing === undefined) return
  const { config, plain } = collectConfig()
  setProbeLog(t('settings.llm.testing'))
  try {
    const result = await window.architect.testConnection({
      preset: editing.preset,
      baseURL: config['baseURL'],
      model: config['model'],
      apiKeyRef: config['apiKeyRef'],
      ...(plain !== undefined ? { apiKeyPlain: plain } : {}),
      listOnly,
    })
    setProbeLog(describeProbe(result))
    // 探针挑出来的模型写回输入框——用户不用手抄
    if (result.config.model.length > 0) el<HTMLInputElement>('cfg-model').value = result.config.model
  } catch (error) {
    setProbeLog(error instanceof Error ? error.message : String(error))
  }
}

function describeProbe(result: DiscoveryResult): string {
  const lines: string[] = []
  for (const step of result.steps) {
    switch (step.type) {
      case 'models':
        lines.push(t('settings.llm.discovered', { count: step.count }))
        for (const model of step.models) lines.push(`    ${model}`)
        break
      case 'model':
        lines.push(
          `${t('settings.llm.model')}: ${step.model}` +
            (step.matched !== undefined ? `  (${step.matched})` : step.guessed === true ? '  (?)' : ''),
        )
        break
      case 'text':
        lines.push(step.ok ? `text ok (${step.tokensIn} in)` : `text failed: ${step.error}`)
        break
      case 'tools':
        lines.push(`tool calling: ${step.mode}`)
        break
      case 'vision':
        lines.push(
          step.vision
            ? `${t('settings.llm.vision')}: ${t('settings.llm.yesVision')}` +
                (step.imageTokenCost !== undefined
                  ? `  ${t('settings.llm.imageTokenCost')} ≈ ${step.imageTokenCost}`
                  : '')
            : `${t('settings.llm.vision')}: ${t('settings.llm.noVision')} — ${step.error ?? ''}`,
        )
        break
      case 'error':
        lines.push(`! ${step.error}`)
        break
      case 'capabilities':
        lines.push('')
        lines.push(`source: ${step.capabilities.source}   promptCache: ${step.capabilities.promptCache}`)
        if (step.capabilities.contextWindow !== undefined) {
          lines.push(`${t('settings.llm.contextWindow')}: ${step.capabilities.contextWindow}`)
        }
        break
      default:
        break
    }
  }
  lines.push('')
  lines.push(result.ok ? 'OK' : `FAILED: ${result.error ?? ''}`)
  return lines.join('\n')
}

// ── 接线 ──────────────────────────────────────────────────────────────────────

function wire(): void {
  el('btn-new').addEventListener('click', () => {
    void guard(t('menu.new'), async () => {
      renderPanel(await window.architect.newProject())
      await shoot()
    })
  })

  el('btn-open').addEventListener('click', () => {
    void guard(t('menu.open'), async () => {
      const state = await window.architect.open()
      if (state === undefined) return
      renderPanel(state)
      await shoot()
    })
  })

  el('btn-save').addEventListener('click', () => {
    void guard(t('menu.save'), async () => {
      const path = await window.architect.save()
      if (path !== undefined) {
        renderPanel(await window.architect.state())
        setStatus(`${t('menu.save')} → ${path}`)
      }
    })
  })

  el('btn-demo').addEventListener('click', () => {
    void guard(t('menu.demo'), async () => {
      renderPanel(await window.architect.demo())
      await shoot()
    })
  })

  el('btn-export').addEventListener('click', () => {
    void guard(t('menu.export'), async () => {
      // 扩展名决定格式；`.schem` / `.litematic` / `.obj` 三种
      const result = await window.architect.exportModel('schem')
      if (result === undefined) return // 用户取消
      showNotice(t('notice.exported', { count: result.paths.length, names: result.paths.join('、') }))
      setStatus(result.summary)
    })
  })

  el('btn-import').addEventListener('click', () => {
    void guard(t('menu.import'), async () => {
      const result = await window.architect.importModel()
      if (result === undefined) return // 用户取消
      renderPanel(result.state)
      // 认不出来的方块要如实说，别让用户以为全导进来了
      const parts = [t('notice.imported', { summary: result.summary })]
      if (result.renamed.length > 0) parts.push(t('notice.importRenamed', { count: result.renamed.length }))
      if (result.unknown.length > 0) {
        parts.push(
          t('notice.importSkipped', { count: result.unknown.length, cells: result.skipped }) +
            `\n${result.unknown
              .slice(0, 5)
              .map((entry) => `${entry.name} ×${entry.count}`)
              .join('、')}`,
        )
      }
      showNotice(parts.join('\n'))
      await shoot()
    })
  })

  viewSelect.addEventListener('change', () => {
    view = viewSelect.value
    void window.architect.setUi({ view })
    void shoot()
  })

  el('btn-latest').addEventListener('click', () => {
    void guard(t('timeline.latest'), async () => {
      renderPanel(await window.architect.seekLatest())
      await shoot()
    })
  })

  // 时间线拖动：input 事件很密集，用 requestAnimationFrame 合流
  let pending: number | undefined
  scrub.addEventListener('input', () => {
    const revision = Number(scrub.value)
    revLabel.textContent = t('timeline.revision', { rev: revision, total: current?.totalOps ?? 0 })
    if (pending !== undefined) cancelAnimationFrame(pending)
    pending = requestAnimationFrame(() => {
      pending = undefined
      void guard(t('timeline.drag'), async () => {
        renderPanel(await window.architect.seek(revision))
        await shoot()
      })
    })
  })

  window.addEventListener('keydown', (event) => {
    if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement) return
    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
      const delta = event.key === 'ArrowLeft' ? -1 : 1
      const next = Math.max(0, Math.min(current?.totalOps ?? 0, (current?.revision ?? 0) + delta))
      if (next === current?.revision) return
      scrub.value = String(next)
      void guard(t('timeline.drag'), async () => {
        renderPanel(await window.architect.seek(next))
        await shoot()
      })
    }
  })

  // ── 对话 ────────────────────────────────────────────────────────────────────
  el<HTMLFormElement>('chat-form').addEventListener('submit', (event) => {
    event.preventDefault()
    void submitChat()
  })
  chatInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
      event.preventDefault()
      void submitChat()
    }
  })
  stopButton.addEventListener('click', () => {
    void guard(t('chat.stop'), async () => renderChat(await window.architect.stop()))
  })
  el('btn-chat-clear').addEventListener('click', () => {
    void guard(t('chat.clear'), async () => {
      for (const url of imageUrls.values()) URL.revokeObjectURL(url)
      imageUrls.clear()
      renderChat(await window.architect.clearChat())
    })
  })

  // ── 设置 ────────────────────────────────────────────────────────────────────
  el('btn-settings').addEventListener('click', () => {
    if (settings !== undefined) renderSettings(settings)
    settingsDialog.showModal()
  })
  el('btn-settings-cancel').addEventListener('click', () => settingsDialog.close())
  el('btn-settings-save').addEventListener('click', () => {
    void guard(t('settings.apply'), async () => {
      const { config, plain } = collectConfig()
      await window.architect.saveProvider(config, plain)
      const usd = Number(el<HTMLInputElement>('cfg-usd').value)
      const turns = Number(el<HTMLInputElement>('cfg-turns').value)
      const budget: Record<string, number> = {}
      if (Number.isFinite(usd) && usd > 0) budget['maxUsd'] = usd
      if (Number.isFinite(turns) && turns > 0) budget['maxTurns'] = turns
      const withBudget = await window.architect.setBudget(Object.keys(budget).length > 0 ? budget : undefined)
      renderSettings(withBudget)
      el<HTMLInputElement>('cfg-key').value = ''
      settingsDialog.close()
      setStatus(t('settings.llm.saved'))
    })
  })
  el('provider-select').addEventListener('change', () => {
    const id = el<HTMLSelectElement>('provider-select').value
    void guard(t('settings.preset'), async () => {
      const view = await window.architect.setActive(id)
      renderSettings(view)
    })
  })
  el('btn-remove-provider').addEventListener('click', () => {
    if (editing === undefined) return
    void guard(t('settings.removeProvider'), async () => {
      const view = await window.architect.removeProvider(editing!.id)
      editing = undefined
      renderSettings(view)
    })
  })
  el('cfg-locale').addEventListener('change', () => {
    const locale = el<HTMLSelectElement>('cfg-locale').value
    void guard(t('settings.language'), async () => {
      renderSettings(await window.architect.setLocale(locale))
    })
  })
  el('btn-test').addEventListener('click', () => void runProbe(false))
  el('btn-test-list').addEventListener('click', () => void runProbe(true))

  window.architect.subscribe((event) => {
    if (event.type === 'chat') renderChat(event.view)
    else if (event.type === 'settings') renderSettings(event.view)
    else if (event.type === 'state') {
      renderPanel(event.state)
      void shoot()
    }
  })
}

async function submitChat(): Promise<void> {
  const text = chatInput.value
  if (text.trim().length === 0) return
  chatInput.value = ''
  try {
    renderChat(await window.architect.send(text))
  } catch (error) {
    setStatus(error instanceof Error ? error.message : String(error))
  }
}

// ── 启动 ──────────────────────────────────────────────────────────────────────

async function boot(): Promise<void> {
  try {
    const initial = await window.architect.settings()
    initI18n({ locale: initial.locale })
    applyStaticText()
    renderPresetButtons()
    onLocaleChange(() => {
      applyStaticText()
      renderPresetButtons()
      if (current !== undefined) renderPanel(current)
      if (chat !== undefined) renderChat(chat)
      if (settings !== undefined) renderSettings(settings)
    })
    setLocale(initial.locale)
    if (initial.ui.view !== undefined && initial.ui.view.length > 0) {
      view = initial.ui.view
      viewSelect.value = view
    }

    wire()
    renderSettings(initial)
    renderPanel(await window.architect.state())
    renderChat(await window.architect.chat())
    await shoot()
    // `#settings`：抓图/调试时直接把设置面板打开
    if (location.hash === '#settings') settingsDialog.showModal()
    await window.architect.ready({ ok: true, detail: `canvas ${canvas.width}x${canvas.height}` })
  } catch (error) {
    await window.architect.ready({
      ok: false,
      detail: error instanceof Error ? error.message : String(error),
    })
  }
}

void boot()
