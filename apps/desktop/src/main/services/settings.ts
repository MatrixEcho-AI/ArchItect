import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import { defaultSettings, parseSettings, serializeSettings } from '@architect/agent'
import { t } from '@architect/i18n'
import type { ProviderSettings, SettingsIssue } from '@architect/agent'

/**
 * 设置文件的持久化。
 *
 * 一个刻意的取舍：**同步 IO**。设置文件只有几 KB，而且它是在启动路径上被读的
 * （窗口要在知道语言和当前 provider 之后才能渲染），同步读省掉一整套"先渲染空壳再补数据"
 * 的状态机。写用"写临时文件再 rename"，这样断电也不会留下半个 json。
 */

export interface SettingsLoad {
  settings: ProviderSettings
  issues: SettingsIssue[]
  /** 文件不存在时为 true——首次启动是正常情况，不是错误。 */
  fresh: boolean
}

export function loadSettings(file: string): SettingsLoad {
  let raw: string
  try {
    raw = readFileSync(file, 'utf8')
  } catch {
    return { settings: defaultSettings(), issues: [], fresh: true }
  }
  try {
    const parsed = parseSettings(JSON.parse(raw) as unknown)
    return { settings: parsed.settings, issues: parsed.issues, fresh: false }
  } catch {
    // json 语法就坏了：退回默认值，但**不覆盖用户的文件**——他可能还想手工抢救
    return {
      settings: defaultSettings(),
      issues: [{ field: '', message: t('desktop.settingsBadJson', { file }) }],
      fresh: false,
    }
  }
}

export function saveSettings(file: string, settings: ProviderSettings): void {
  mkdirSync(dirname(file), { recursive: true })
  const temp = `${file}.tmp`
  writeFileSync(temp, serializeSettings(settings), 'utf8')
  renameSync(temp, file)
}

// ── 密钥存储 ───────────────────────────────────────────────────────────────────

/**
 * 加解密原语。**由调用方注入**——桌面端传 Electron 的 `safeStorage`，
 * 测试传一个可预测的实现。这个接口存在的唯一目的就是让"密钥怎么存"
 * 可以被测试，而且让"没有加密能力时拒绝存储"成为一条**写死的**策略而不是注释。
 */
export interface Cipher {
  available(): boolean
  encrypt(plaintext: string): Buffer
  decrypt(ciphertext: Buffer): string
}

export interface SecretStore {
  /** 按 `safe:<id>` 里的 id 取明文。不存在返回 undefined。 */
  get(id: string): string | undefined
  /** 存入。**返回 false 表示没有加密能力，什么都没写。** */
  set(id: string, value: string): boolean
  has(id: string): boolean
  remove(id: string): void
  /** 存储位置（给 UI 显示，让用户知道东西在哪）。 */
  readonly location: string
  readonly encrypted: boolean
}

interface SecretsFile {
  version: 1
  entries: Record<string, string>
}

/**
 * 文件式密钥存储。
 *
 * **没有加密能力时坚决不落盘**（D-13）。宁可让用户每次用环境变量，
 * 也不能把密钥明文写到磁盘上——那正是"绝不落明文"要防的事。
 */
export function createSecretStore(file: string, cipher: Cipher): SecretStore {
  const read = (): SecretsFile => {
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8')) as SecretsFile
      if (parsed !== null && typeof parsed === 'object' && typeof parsed.entries === 'object') return parsed
    } catch {
      // 读不到就当空的
    }
    return { version: 1, entries: {} }
  }

  const write = (data: SecretsFile): void => {
    mkdirSync(dirname(file), { recursive: true })
    const temp = `${file}.tmp`
    writeFileSync(temp, JSON.stringify(data), { encoding: 'utf8', mode: 0o600 })
    renameSync(temp, file)
  }

  return {
    location: file,
    get encrypted(): boolean {
      return cipher.available()
    },
    get(id) {
      const stored = read().entries[id]
      if (stored === undefined) return undefined
      try {
        return cipher.decrypt(Buffer.from(stored, 'base64'))
      } catch {
        // 换了机器 / 钥匙串变了 → 密文解不开。当作没有，让用户重填。
        return undefined
      }
    },
    set(id, value) {
      if (!cipher.available()) return false
      const data = read()
      data.entries[id] = cipher.encrypt(value).toString('base64')
      write(data)
      return true
    },
    has(id) {
      return read().entries[id] !== undefined
    },
    remove(id) {
      const data = read()
      delete data.entries[id]
      write(data)
    },
  }
}

/** 测试与"没有钥匙串的环境"用。**只活在内存里**，进程退出即消失。 */
export function createMemorySecretStore(): SecretStore {
  const entries = new Map<string, string>()
  return {
    location: t('desktop.secretLocation.memory'),
    encrypted: true,
    get: (id) => entries.get(id),
    set: (id, value) => {
      entries.set(id, value)
      return true
    },
    has: (id) => entries.has(id),
    remove: (id) => {
      entries.delete(id)
    },
  }
}

export const settingsFile = (userDataDir: string): string => join(userDataDir, 'settings.json')
export const secretsFile = (userDataDir: string): string => join(userDataDir, 'secrets.json')
