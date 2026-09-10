import i18next from 'i18next'

import { enUS } from './locales/en-US.js'
import { zhCN } from './locales/zh-CN.js'
import type { MessageKey } from './locales/zh-CN.js'

export { zhCN, enUS }
export type { MessageKey, Messages, Resources } from './locales/zh-CN.js'
export { localizeToolError, toolErrorParams } from './errors.js'
export type { LocalizableToolError } from './errors.js'

export const SUPPORTED_LOCALES = ['zh-CN', 'en-US'] as const
export type Locale = (typeof SUPPORTED_LOCALES)[number]

/** 中文优先（D-01）：默认与兜底都是 `zh-CN`。 */
export const DEFAULT_LOCALE: Locale = 'zh-CN'

export interface I18nOptions {
  locale?: Locale
  /** 缺键时的回调（测试用来断言"没有键漏翻"）。 */
  onMissingKey?: (key: string, locale: string) => void
}

let ready = false
const missing: Array<{ key: string; locale: string }> = []
let onMissing: I18nOptions['onMissingKey']

function normalize(input: string | undefined): Locale | undefined {
  if (input === undefined || input.length === 0) return undefined
  const lower = input.toLowerCase()
  if (lower.startsWith('zh')) return 'zh-CN'
  if (lower.startsWith('en')) return 'en-US'
  return undefined
}

/**
 * 从环境推断语言：`ARCHITECT_LANG` 优先，其次标准的 `LC_ALL` / `LC_MESSAGES` / `LANG`。
 *
 * CLI 与 Electron 主进程共用这一条，所以 `LANG=en-US architect build` 直接出英文日志（plan §10.4-2）。
 *
 * `process` 走 `globalThis` 取而不是直接引用：**这个包也会被 esbuild 打进渲染进程**，
 * 那里没有 `process`，直接写 `process.env` 会在浏览器里抛 `process is not defined`。
 */
export function detectLocale(env?: Record<string, string | undefined>): Locale {
  const source = env ?? nodeEnv()
  return (
    normalize(source['ARCHITECT_LANG']) ??
    normalize(source['LC_ALL']) ??
    normalize(source['LC_MESSAGES']) ??
    normalize(source['LANG']) ??
    DEFAULT_LOCALE
  )
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
  const locale = options.locale ?? detectLocale()
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
  return normalize(current) ?? DEFAULT_LOCALE
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
