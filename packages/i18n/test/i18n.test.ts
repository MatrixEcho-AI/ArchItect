import { describe, expect, it, beforeEach } from 'vitest'

import {
  DEFAULT_LOCALE,
  detectLocale,
  drainMissingKeys,
  enUS,
  format,
  getLocale,
  initI18n,
  localizeToolError,
  setLocale,
  t,
  toolErrorParams,
  zhCN,
} from '../src/index.js'
import type { Messages } from '../src/index.js'

/** 深比较两张语言表的键路径集合。 */
function keyPaths(value: unknown, prefix = ''): string[] {
  if (typeof value === 'string') return [prefix]
  if (typeof value !== 'object' || value === null) return []
  return Object.entries(value).flatMap(([key, child]) =>
    keyPaths(child, prefix.length === 0 ? key : `${prefix}.${key}`),
  )
}

describe('文案资源表', () => {
  it('中英两表的键路径完全一致', () => {
    expect(keyPaths(enUS).sort()).toEqual(keyPaths(zhCN).sort())
  })

  it('没有空文案', () => {
    for (const table of [zhCN, enUS] as const) {
      for (const path of keyPaths(table)) {
        const value = path.split('.').reduce<unknown>((node, key) => (node as Record<string, unknown>)[key], table)
        expect(typeof value === 'string' && value.trim().length > 0, `${path} 是空文案`).toBe(true)
      }
    }
  })

  it('占位符集合在两种语言里一致', () => {
    const placeholders = (text: string): string[] =>
      [...text.matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[1]!).sort()
    for (const path of keyPaths(zhCN)) {
      const pick = (table: Messages): string =>
        path.split('.').reduce<unknown>((node, key) => (node as Record<string, unknown>)[key], table) as string
      expect(placeholders(pick(enUS)), `${path} 的占位符不一致`).toEqual(placeholders(pick(zhCN)))
    }
  })

  it('satisfies 契约本身成立（编译期已校验，这里防回归）', () => {
    const contract: Messages = zhCN
    expect(contract.app.name).toBe('ArchItect')
  })
})

describe('t()', () => {
  beforeEach(() => {
    initI18n({ locale: 'zh-CN' })
    drainMissingKeys()
  })

  it('默认中文（D-01）', () => {
    expect(t('chat.send')).toBe('发送')
    expect(t('menu.new')).toBe('新建')
  })

  it('插值不转义', () => {
    expect(t('timeline.revision', { rev: 3, total: 8 })).toBe('rev 3 / 8')
    expect(t('error.UNKNOWN_BLOCK', { name: 'a<b', suggestions: 'x&y' })).toBe(
      '未知方块 a<b，是否想用：x&y',
    )
  })

  it('切到英文即时生效', () => {
    setLocale('en-US')
    expect(getLocale()).toBe('en-US')
    expect(t('chat.send')).toBe('Send')
    setLocale('zh-CN')
    expect(t('chat.send')).toBe('发送')
  })

  it('不认识的键不会漏进界面（回退成键本身但不崩）', () => {
    initI18n({ locale: 'zh-CN' })
    const value = t('app.name')
    expect(value).toBe('ArchItect')
  })
})

describe('detectLocale', () => {
  it('ARCHITECT_LANG 优先于 LANG', () => {
    expect(detectLocale({ ARCHITECT_LANG: 'en-US', LANG: 'zh_CN.UTF-8' })).toBe('en-US')
  })

  it('认 LANG 的各种写法', () => {
    expect(detectLocale({ LANG: 'zh_CN.UTF-8' })).toBe('zh-CN')
    expect(detectLocale({ LANG: 'en_GB.UTF-8' })).toBe('en-US')
    expect(detectLocale({ LC_ALL: 'en_US.UTF-8' })).toBe('en-US')
  })

  it('都不认识时兜到中文', () => {
    expect(detectLocale({ LANG: 'fr_FR.UTF-8' })).toBe(DEFAULT_LOCALE)
    expect(detectLocale({})).toBe(DEFAULT_LOCALE)
  })
})

describe('工具错误本地化', () => {
  beforeEach(() => {
    initI18n({ locale: 'zh-CN' })
  })

  it('有码有参数时出中文', () => {
    // 这就是 resolveBlock 真实产出的那句（带引号、句末有句点）
    const error = {
      code: 'UNKNOWN_BLOCK',
      message:
        'Unknown block "minecraft:oak_logg". Did you mean: minecraft:oak_log, minecraft:oak_planks?',
    }
    expect(localizeToolError(error, toolErrorParams(error))).toBe(
      '未知方块 minecraft:oak_logg，是否想用：minecraft:oak_log, minecraft:oak_planks',
    )
  })

  it('能直接吃 data 里的结构化参数', () => {
    const error = { code: 'TOO_LARGE', message: 'Selection too large' }
    expect(localizeToolError(error, { count: 9000, limit: 4096 })).toBe(
      '范围太大：9000 个方块，上限 4096',
    )
  })

  it('能从英文原文里抠出建议列表与方块名（并削掉句末句点）', () => {
    const error = {
      code: 'UNKNOWN_BLOCK',
      message:
        'Unknown block "minecraft:oak_logg". Did you mean: minecraft:oak_log, minecraft:oak_planks?',
    }
    const params = toolErrorParams(error)
    expect(params['suggestions']).toBe('minecraft:oak_log, minecraft:oak_planks')
    expect(params['name']).toBe('minecraft:oak_logg')
  })

  it('参数不全时回退英文原文，而不是显示裸占位符', () => {
    const error = { code: 'UNKNOWN_BLOCK', message: 'Unknown block foo' }
    const rendered = localizeToolError(error, {})
    expect(rendered).not.toContain('{{')
    expect(rendered).toBe('Unknown block foo')
  })
  it('不认识的错误码回退英文原文', () => {
    const error = { code: 'SOMETHING_NEW', message: 'boom', hint: 'try again' }
    expect(localizeToolError(error)).toBe('boom — try again')
  })
})

describe('format()', () => {
  it('替换已知变量，未知的留空而不是留占位符', () => {
    expect(format('{{a}}/{{b}}', { a: 1 })).toBe('1/')
  })
})

describe('文案表不能整块丢失（回归：一次误操作曾把 cli/agent 两组整段截掉）', () => {
  const topGroups = (table: unknown): string[] =>
    Object.keys(table as Record<string, unknown>).sort()

  it('**两表的顶层分组完全一致且一个都不能少**', () => {
    const zh = topGroups(zhCN)
    const en = topGroups(enUS)
    expect(en).toEqual(zh)
    // 写死一份期望而不是"两边一样就行"——两边被同样截断时，只比结构是抓不到的
    expect(zh).toEqual([
      'agent',
      'app',
      'chat',
      'cli',
      'cost',
      'desktop',
      'dialog',
      'error',
      'image',
      'menu',
      'notice',
      'palette',
      'panel',
      'recovery',
      'settings',
      'timeline',
      'verify',
      'viewport',
    ])
  })

  it('**叶子键数量有下界**（整组消失时立刻失败，而不是安静地少一半文案）', () => {
    const count = (table: unknown): number => {
      if (typeof table === 'string') return 1
      if (typeof table !== 'object' || table === null) return 0
      return Object.values(table as Record<string, unknown>).reduce<number>(
        (sum, child) => sum + count(child),
        0,
      )
    }
    // 真实值：zh 约 400+。下界只用来抓"整组没了"，不追求精确。
    expect(count(zhCN)).toBeGreaterThan(330)
    expect(count(enUS)).toBeGreaterThan(330)
    // CLI 与 agent 是两组大类，各自也该有像样的规模
    expect(count((zhCN as Record<string, unknown>)['cli'])).toBeGreaterThan(120)
    expect(count((zhCN as Record<string, unknown>)['agent'])).toBeGreaterThan(60)
  })

  it('分组规模在两表之间一致（某一组被截掉一半会在这里露出来）', () => {
    const count = (table: unknown): number => {
      if (typeof table === 'string') return 1
      if (typeof table !== 'object' || table === null) return 0
      return Object.values(table as Record<string, unknown>).reduce<number>(
        (sum, child) => sum + count(child),
        0,
      )
    }
    for (const group of topGroups(zhCN)) {
      const zhSize = count((zhCN as Record<string, unknown>)[group])
      const enSize = count((enUS as Record<string, unknown>)[group])
      expect(enSize, `分组 ${group} 的规模不一致`).toBe(zhSize)
    }
  })
})
