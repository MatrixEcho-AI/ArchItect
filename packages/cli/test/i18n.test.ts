import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { drainMissingKeys, enUS, getLocale, initI18n, t, zhCN } from '@architect/i18n'
import type { MessageKey } from '@architect/i18n'

/** 深比较键路径（与 packages/i18n 的测试同口径）。 */
function keyPaths(value: unknown, prefix = ''): string[] {
  if (typeof value === 'string') return [prefix]
  if (typeof value !== 'object' || value === null) return []
  return Object.entries(value).flatMap(([key, child]) =>
    keyPaths(child, prefix.length === 0 ? key : `${prefix}.${key}`),
  )
}

const CJK = /[\u4e00-\u9fff]/

/** 从文案表里按点分路径取值。 */
function pick(table: unknown, path: string): string {
  return path.split('.').reduce<unknown>((node, key) => (node as Record<string, unknown>)[key], table) as string
}

/** CJK 占两个终端列宽，对齐要按显示宽度算。 */
function width(text: string): number {
  let total = 0
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0
    total += code >= 0x1100 && code <= 0xffe6 ? 2 : 1
  }
  return total
}

const CLI_ENTRY = fileURLToPath(new URL('../src/index.ts', import.meta.url))
const REPO_ROOT = fileURLToPath(new URL('../../..', import.meta.url))

/**
 * 起一个真实的 CLI 子进程跑 `--help`。
 *
 * 只有端到端跑一遍才能证明「环境变量 → 语言 → stdout」这条链路是通的；
 * 单测 `t()` 只能证明资源表里有键。
 */
function runHelp(locale: string): string {
  return execFileSync('npx', ['--no-install', 'tsx', CLI_ENTRY, '--help'], {
    cwd: REPO_ROOT,
    env: { ...process.env, ARCHITECT_LANG: locale, LANG: undefined, LC_ALL: undefined, LC_MESSAGES: undefined },
    encoding: 'utf8',
  })
}

describe('CLI i18n（D-01）', () => {
  beforeEach(() => {
    initI18n({ locale: 'zh-CN' })
    drainMissingKeys()
  })

  afterEach(() => {
    delete process.env['ARCHITECT_LANG']
    delete process.env['LC_ALL']
    delete process.env['LC_MESSAGES']
  })

  it('ARCHITECT_LANG 真的在两个语言之间切换 cli.* 文案', () => {
    process.env['ARCHITECT_LANG'] = 'zh-CN'
    initI18n()
    expect(getLocale()).toBe('zh-CN')
    const zh: Record<string, string> = {
      heading: t('cli.usage.heading'),
      missingProject: t('cli.error.missingProject'),
      infoBlocks: t('cli.info.blocks'),
      verdict: t('cli.providers.verdictAvailable'),
    }
    expect(zh['heading']).toBe('用法：')
    expect(zh['missingProject']).toBe('缺少工程文件路径')
    expect(CJK.test(zh['infoBlocks']!)).toBe(true)
    expect(CJK.test(zh['verdict']!)).toBe(true)

    process.env['ARCHITECT_LANG'] = 'en-US'
    initI18n()
    expect(getLocale()).toBe('en-US')
    const en: Record<string, string> = {
      heading: t('cli.usage.heading'),
      missingProject: t('cli.error.missingProject'),
      infoBlocks: t('cli.info.blocks'),
      verdict: t('cli.providers.verdictAvailable'),
    }
    expect(en['heading']).toBe('Usage:')
    expect(en['missingProject']).toBe('Missing project file path')
    // 逐个键证明「英文 != 中文」，而不是只证明键存在
    for (const key of Object.keys(zh)) {
      expect(en[key], `${key} 在英文里没有变化`).not.toBe(zh[key])
      expect(CJK.test(en[key]!), `${key} 的英文里还混着中文`).toBe(false)
    }
  })

  it('cli.* 没有任何键的英文与中文逐字相同（漏翻会被抓出来）', () => {
    const identical = keyPaths(zhCN).filter(
      (path) => path.startsWith('cli.') && pick(zhCN, path) === pick(enUS, path),
    )
    // 不需要豁免名单：旗标、路径、方块 id、工具名都留在代码里，不进文案表
    expect(identical).toEqual([])
  })

  it('cli.* 的键在中文表里都能取到（不会漏进裸键）', () => {
    initI18n({ locale: 'zh-CN' })
    for (const path of keyPaths(zhCN)) {
      if (!path.startsWith('cli.')) continue
      expect(t(path as MessageKey), `${path} 取不到`).not.toBe(path)
    }
    expect(drainMissingKeys()).toEqual([])
  })

  // 起两个子进程比较慢，给足超时（默认 5s 在 CI 上可能不够）
  it(
    '--help 端到端跟随 ARCHITECT_LANG',
    () => {
      const zh = runHelp('zh-CN')
      const en = runHelp('en-US')

      // 关键旗标名在两种语言里都原样出现（旗标不翻译）
      const flags = [
        '--json',
        '--limit',
        '--view',
        '--views',
        '--width',
        '--height',
        '--plain',
        '--no-overlays',
        '--highlight-last',
        '--provider',
        '--model',
        '--base-url',
        '--api-key-env',
        '--no-probe',
        '--size',
        '--max-turns',
        '--tasks',
        '--out-dir',
        '--record',
        '--replay',
        '-h, --help',
      ]
      for (const flag of flags) {
        expect(zh, `中文帮助缺 ${flag}`).toContain(flag)
        expect(en, `英文帮助缺 ${flag}`).toContain(flag)
      }

      expect(CJK.test(zh)).toBe(true)
      expect(CJK.test(en), `英文帮助里混进了中文：\n${en}`).toBe(false)

      // 每种语言各自按显示宽度对齐：短选项的解释从第 34 显示列开始
      const column = 34
      const jsonZh = zh.split('\n').find((line) => line.startsWith('  --json'))!
      expect(width(jsonZh.slice(0, jsonZh.indexOf('以')))).toBe(column)
      const jsonEn = en.split('\n').find((line) => line.startsWith('  --json'))!
      expect(width(jsonEn.slice(0, jsonEn.indexOf('Emit')))).toBe(column)

      // 过长的选项写法独占一行，说明另起一行缩进 34
      for (const text of [zh, en]) {
        const lines = text.split('\n')
        const index = lines.findIndex((line) => line.startsWith('  --provider <deepseek'))
        expect(index).toBeGreaterThanOrEqual(0)
        expect(lines[index + 1]!.startsWith(' '.repeat(column))).toBe(true)
      }
    },
    60_000,
  )
})
