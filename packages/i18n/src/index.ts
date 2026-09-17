import i18next from 'i18next'

import { enUS } from './locales/en-US.js'
import { zhCN } from './locales/zh-CN.js'
import type { MessageKey } from './locales/zh-CN.js'

export { zhCN, enUS }
export type { MessageKey, Messages, Resources } from './locales/zh-CN.js'
export { localizeToolError, toolErrorParams } from './errors.js'
export type { LocalizableToolError } from './errors.js'
export { localizeContextReason, localizeProblem } from './codes.js'
export type { LocalizableContextReason, LocalizableProblem } from './codes.js'

export const SUPPORTED_LOCALES = ['zh-CN', 'en-US'] as const
export type Locale = (typeof SUPPORTED_LOCALES)[number]

/**
 * 默认英文。开源项目的读者不一定是中文用户，所以环境没有明说中文时一律用英文；
 * 中文只在环境说了（`LANG=zh_CN.UTF-8` 之类）或用户在设置里选了才用。
 */
export const DEFAULT_LOCALE: Locale = 'en-US'

export interface I18nOptions {
  locale?: Locale
  /** 缺键时的回调（测试用来断言"没有键漏翻"）。 */
  onMissingKey?: (key: string, locale: string) => void
}

let ready = false
const missing: Array<{ key: string; locale: string }> = []
let onMissing: I18nOptions['onMissingKey']

/**
 * 把一个语言标记收成受支持的语言（`zh-Hans-CN` → `zh-CN`）。认不出来返回 `undefined`。
 *
 * 导出是给渲染进程用的：它的 i18next 是**自己一份**，主进程初始化过不代表它初始化过，
 * 而 `navigator.language` 在 Electron 里就是 app locale（与 `app.getLocale()` 同源）。
 */
export function normalizeLocale(input: string | undefined): Locale | undefined {
  if (input === undefined || input.length === 0) return undefined
  const lower = input.toLowerCase()
  if (lower.startsWith('zh')) return 'zh-CN'
  if (lower.startsWith('en')) return 'en-US'
  return undefined
}

/**
 * 从环境推断语言：`ARCHITECT_LANG` 优先，其次标准的 `LC_ALL` / `LC_MESSAGES` / `LANG`，
 * 最后是系统语言。**纯函数**——两个来源都由调用方传进来，测试才确定得下来。
 *
 * CLI 与 Electron 主进程共用这一条，所以 `LANG=en-US architect build` 直接出英文日志（plan §10.4-2）。
 *
 * **系统语言这一层是为 Windows 加的。** `LANG` 那一族在 Windows 上一个都不设，
 * 没有这一层的话，中文 Windows 上永远是缺省的英文。Linux / macOS 上 `LANG` 是用户
 * 的明确选择，所以排在它前面。
 */
export function detectLocale(env: Record<string, string | undefined>, system?: string): Locale {
  return (
    normalizeLocale(env['ARCHITECT_LANG']) ??
    normalizeLocale(env['LC_ALL']) ??
    normalizeLocale(env['LC_MESSAGES']) ??
    normalizeLocale(env['LANG']) ??
    normalizeLocale(system) ??
    DEFAULT_LOCALE
  )
}

/**
 * `Intl` 报出来的系统语言，形如 `zh-CN` / `en-US`。浏览器与 Node 都有，不需要任何原生模块。
 *
 * 拿不到就返回 `undefined`（ICU 被裁掉的 Node 构建会这样），让调用方兜到 `DEFAULT_LOCALE`。
 */
export function systemLocale(): string | undefined {
  try {
    return Intl.DateTimeFormat().resolvedOptions().locale
  } catch {
    return undefined
  }
}

/**
 * 实际用的那一条：把 `process.env` 与系统语言接起来。
 *
 * `override` 给桌面端用——Electron 的 `app.getLocale()` 反映的是系统**显示语言**，
 * 比 ICU 的默认区域更贴近用户的选择。
 *
 * `process` 走 `globalThis` 取而不是直接引用：**这个包也会被 esbuild 打进渲染进程**，
 * 那里没有 `process`，直接写 `process.env` 会在浏览器里抛 `process is not defined`。
 */
export function resolveLocale(override?: string): Locale {
  return detectLocale(nodeEnv(), override ?? systemLocale())
}

/** Node 下的环境变量；浏览器里返回空对象。 */
function nodeEnv(): Record<string, string | undefined> {
  const proc = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process
  return proc?.env ?? {}
}

/**
 * 初始化 i18n。**幂等**：重复调用只是切换语言。
 *
 * 用 `initImmediate: false` 让初始化同步完成——否则首屏可能闪一下未翻译的键。
 */
export function initI18n(options: I18nOptions = {}): void {
  onMissing = options.onMissingKey
  const locale = options.locale ?? resolveLocale()
  if (ready) {
    void i18next.changeLanguage(locale)
    return
  }
  void i18next.init({
    lng: locale,
    fallbackLng: DEFAULT_LOCALE,
    supportedLngs: [...SUPPORTED_LOCALES],
    resources: {
      'zh-CN': { translation: zhCN },
      'en-US': { translation: enUS },
    },
    // 文案里含 `{{name}}` 之类，值是纯文本不是 HTML——转义只会把 `&` 变成 `&amp;`
    interpolation: { escapeValue: false },
    // 让 `minecraft:oak_stairs` 这类值不被当命名空间；键里也没有冒号
    nsSeparator: false,
    keySeparator: '.',
    returnNull: false,
    initImmediate: false,
    // 关掉启动时那行推广横幅——它是控制台噪音，不是我们的信息
    showSupportNotice: false,
    missingKeyHandler: (lngs, _ns, key) => {
      const locale = lngs[0] ?? DEFAULT_LOCALE
      missing.push({ key, locale })
      onMissing?.(key, locale)
    },
  })
  ready = true
}

/** 当前语言。 */
export function getLocale(): Locale {
  const current = i18next.resolvedLanguage ?? i18next.language
  return normalizeLocale(current) ?? DEFAULT_LOCALE
}

/** 切换语言。UI 订阅后即时生效，不需要重启（plan §10.4-4）。 */
export function setLocale(locale: Locale): void {
  if (!ready) {
    initI18n({ locale })
    return
  }
  void i18next.changeLanguage(locale)
}

export function onLocaleChange(listener: (locale: Locale) => void): () => void {
  const handler = (): void => listener(getLocale())
  i18next.on('languageChanged', handler)
  return () => i18next.off('languageChanged', handler)
}

export type MessageVars = Record<string, string | number>

/**
 * 取一条文案。
 *
 * 键是**编译期校验**的点分路径：写成 `t('chat.plcaeholder')` 直接编译不过，
 * 不会等到运行时在界面上看到一个裸键。
 */
export function t(key: MessageKey, vars?: MessageVars): string {
  if (!ready) initI18n()
  const text = i18next.t(key, vars) as unknown
  return typeof text === 'string' ? text : String(key)
}

/** 测试用：取出并清空"缺键"记录。 */
export function drainMissingKeys(): Array<{ key: string; locale: string }> {
  return missing.splice(0, missing.length)
}

/** 参数化文案（不进资源表的动态内容，如方块名）。 */
export function format(template: string, vars: MessageVars): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_match, name: string) => String(vars[name] ?? ''))
}
