import { afterAll, beforeEach, describe, expect, it } from 'vitest'

import { enUS, initI18n, t, zhCN } from '@architect/i18n'
import type { MessageKey } from '@architect/i18n'

import {
  AgentSession,
  classifyHttpError,
  configFromPreset,
  discoverProvider,
  evaluateTask,
  exchangesFromJsonl,
  GOLDEN_TASKS,
  parseSettings,
  PROVIDER_PRESETS,
  redactSecret,
  ReplayProvider,
  resolveApiKey,
  ScriptedProvider,
  scriptFromCalls,
  validateProviderConfig,
} from '../src/index.js'

/** 深比较键路径（与 packages/i18n 的测试同口径）。 */
function keyPaths(value: unknown, prefix = ''): string[] {
  if (typeof value === 'string') return [prefix]
  if (typeof value !== 'object' || value === null) return []
  return Object.entries(value).flatMap(([key, child]) =>
    keyPaths(child, prefix.length === 0 ? key : `${prefix}.${key}`),
  )
}

/** 从文案表里按点分路径取值。 */
function pick(table: unknown, path: string): string {
  return path.split('.').reduce<unknown>((node, key) => (node as Record<string, unknown>)[key], table) as string
}

const CJK = /[\u4e00-\u9fff]/

async function caught(promise: Promise<unknown>): Promise<Error> {
  return promise.then(
    () => {
      throw new Error('预期这里应该抛错，但没有')
    },
    (error: unknown) => (error instanceof Error ? error : new Error(String(error))),
  )
}

describe('agent i18n（D-01 / plan §10.4-2）', () => {
  beforeEach(() => {
    initI18n({ locale: 'zh-CN' })
  })

  // 别把 en-US 泄漏给同进程里依赖中文默认值的测试
  afterAll(() => {
    initI18n({ locale: 'zh-CN' })
  })

  it('切到 en-US 后 agent.* 文案变成英文', () => {
    initI18n({ locale: 'zh-CN' })
    const zh = t('agent.openai.authFailed', { status: 401, detail: 'bad key' })
    expect(zh).toBe('鉴权失败（401）：bad key')

    initI18n({ locale: 'en-US' })
    const en = t('agent.openai.authFailed', { status: 401, detail: 'bad key' })
    expect(en).toBe('Authentication failed (401): bad key')
    expect(CJK.test(en)).toBe(false)
  })

  it('agent.* 没有任何键的英文与中文逐字相同（漏翻会被抓出来）', () => {
    const identical = keyPaths(zhCN).filter(
      (path) => path.startsWith('agent.') && pick(zhCN, path) === pick(enUS, path),
    )
    expect(identical).toEqual([])
  })

  it('agent.* 的键在中文表里都能取到（不会漏进裸键）', () => {
    initI18n({ locale: 'zh-CN' })
    for (const path of keyPaths(zhCN)) {
      if (!path.startsWith('agent.')) continue
      expect(t(path as MessageKey), `${path} 取不到`).not.toBe(path)
    }
  })

  it('resolveApiKey 的报错真的跟随语言', async () => {
    initI18n({ locale: 'zh-CN' })
    const zh = await caught(resolveApiKey('env:MISSING', () => undefined))
    expect(CJK.test(zh.message)).toBe(true)
    expect(zh.message).toContain('拿不到密钥')

    initI18n({ locale: 'en-US' })
    const en = await caught(resolveApiKey('env:MISSING', () => undefined))
    expect(CJK.test(en.message), en.message).toBe(false)
    expect(en.message).toContain('Could not resolve the key')
  })

  it('validateProviderConfig 的问题说明真的跟随语言', () => {
    initI18n({ locale: 'zh-CN' })
    const zh = validateProviderConfig(configFromPreset('deepseek', { apiKeyRef: 'sk-abcdefghijklmnop' }))
    expect(zh[0]?.message).toContain('不能直接填密钥')

    initI18n({ locale: 'en-US' })
    const en = validateProviderConfig(configFromPreset('deepseek', { apiKeyRef: 'sk-abcdefghijklmnop' }))
    expect(CJK.test(en[0]?.message ?? '')).toBe(false)
    expect(en[0]?.message).toContain('never a pasted key')
    // code/field 是协议，不能翻译
    expect(en[0]?.field).toBe('apiKeyRef')
  })

  it('parseSettings 的 issue 说明真的跟随语言', () => {
    initI18n({ locale: 'zh-CN' })
    const zh = parseSettings({
      version: 99,
      activeId: 'x',
      providers: [{ id: 'x', preset: 'deepseek', baseURL: 'https://x.test' }],
    })
    expect(zh.issues.some((i) => i.message.includes('比本程序'))).toBe(true)

    initI18n({ locale: 'en-US' })
    const en = parseSettings({
      version: 99,
      activeId: 'x',
      providers: [{ id: 'x', preset: 'deepseek', baseURL: 'https://x.test' }],
    })
    for (const issue of en.issues) {
      expect(CJK.test(issue.message), issue.message).toBe(false)
    }
    expect(en.issues.some((i) => i.message.includes('newer than this app'))).toBe(true)
  })

  it('classifyHttpError 的四类错误都跟随语言，code 不变', () => {
    initI18n({ locale: 'en-US' })
    expect(classifyHttpError(401, 'nope').message).toContain('Authentication failed')
    expect(classifyHttpError(429, 'slow').message).toContain('Rate limited')
    expect(classifyHttpError(503, 'down').message).toContain('Server error')
    expect(classifyHttpError(400, 'bad').message).toContain('Request rejected')
    expect(classifyHttpError(401, 'nope').code).toBe('AUTH')
    expect(classifyHttpError(429, 'slow').retryable).toBe(true)

    initI18n({ locale: 'zh-CN' })
    expect(CJK.test(classifyHttpError(401, 'nope').message)).toBe(true)
  })

  it('预设 note 跟随语言，而不是 import 时刻的快照', () => {
    initI18n({ locale: 'zh-CN' })
    expect(CJK.test(PROVIDER_PRESETS.custom.note ?? '')).toBe(true)

    initI18n({ locale: 'en-US' })
    const en = PROVIDER_PRESETS.custom.note ?? ''
    expect(CJK.test(en), en).toBe(false)
    expect(en.length).toBeGreaterThan(0)
  })

  it('redactSecret 的占位标签跟随语言，且仍然不泄露前缀', () => {
    initI18n({ locale: 'zh-CN' })
    expect(redactSecret(undefined)).toBe('(未设置)')
    expect(redactSecret('sk-1234567890')).toBe('***')

    initI18n({ locale: 'en-US' })
    expect(redactSecret(undefined)).toBe('(not set)')
    expect(redactSecret('sk-1234567890')).toBe('***')
  })

  it('发现流程的探测标签与超时说明跟随语言', async () => {
    // 用真实函数走一遍超时路径：fetch 永不 resolve，timeout 立刻触发
    initI18n({ locale: 'en-US' })
    const never = (() => new Promise<Response>(() => {})) as unknown as typeof fetch
    const result = await discoverProvider(configFromPreset('deepseek'), {
      apiKey: 'k',
      fetchImpl: never,
      timeoutMs: 5,
    })
    expect(result.ok).toBe(false)
    expect(CJK.test(result.error ?? ''), result.error).toBe(false)
    expect(result.error).toContain('timed out')

    initI18n({ locale: 'zh-CN' })
    const zhResult = await discoverProvider(configFromPreset('deepseek'), {
      apiKey: 'k',
      fetchImpl: never,
      timeoutMs: 5,
    })
    expect(CJK.test(zhResult.error ?? '')).toBe(true)
    expect(zhResult.error).toContain('超时')
  })

  it('黄金任务的 name / check label 跟随语言，id 不变', () => {
    const ids = ['hut', 'tower', 'courtyard', 'bridge', 'lighthouse']
    initI18n({ locale: 'zh-CN' })
    expect(GOLDEN_TASKS.map((task) => task.id)).toEqual(ids)
    expect(GOLDEN_TASKS[0]!.name).toBe('小屋')
    expect(GOLDEN_TASKS[0]!.checks[1]!.label).toBe('东西向跨度接近 10')

    initI18n({ locale: 'en-US' })
    expect(GOLDEN_TASKS.map((task) => task.id)).toEqual(ids)
    expect(GOLDEN_TASKS[0]!.name).toBe('Hut')
    const label = GOLDEN_TASKS[0]!.checks[1]!.label ?? ''
    expect(CJK.test(label), label).toBe(false)
    expect(label).toContain('East-west span')
  })

  it('验收失败时的 label / detail 跟随语言', () => {
    const session = new AgentSession({ volume: GOLDEN_TASKS[4]!.volume, plain: true })
    initI18n({ locale: 'en-US' })
    const en = evaluateTask(GOLDEN_TASKS[4]!, session.store)
    expect(en.results.every((r) => !CJK.test(r.label) && !CJK.test(r.detail ?? ''))).toBe(true)

    initI18n({ locale: 'zh-CN' })
    const zh = evaluateTask(GOLDEN_TASKS[4]!, session.store)
    expect(zh.results.some((r) => CJK.test(r.label))).toBe(true)
  })

  it('录音重放的报错与兜底文本跟随语言', async () => {
    const request = { system: '', messages: [], tools: [] }
    const line =
      '{"turn":1,"meta":{"at":"T","provider":"p","model":"m","ms":0},"request":{"system":"","messages":[],"tools":["gone_tool"]},"response":{"text":"","toolCalls":[],"usage":{"in":0,"out":0},"finishReason":"stop"}}'

    initI18n({ locale: 'en-US' })
    const missing = await caught(new ReplayProvider(exchangesFromJsonl(line)).chat(request))
    expect(CJK.test(missing.message), missing.message).toBe(false)
    expect(missing.message).toContain('no longer exist')
    expect((await new ReplayProvider([], { onExhausted: 'stop' }).chat(request)).text).toBe('(recording exhausted)')

    initI18n({ locale: 'zh-CN' })
    const missingZh = await caught(new ReplayProvider(exchangesFromJsonl(line)).chat(request))
    expect(missingZh.message).toContain('当前不存在的工具')
    expect((await new ReplayProvider([], { onExhausted: 'stop' }).chat(request)).text).toBe('（录音已放完）')
  })

  it('录音 JSONL 解析报错跟随语言', () => {
    initI18n({ locale: 'en-US' })
    expect(() => exchangesFromJsonl('nope')).toThrow(/not valid JSON/)
    initI18n({ locale: 'zh-CN' })
    expect(() => exchangesFromJsonl('nope')).toThrow(/不是合法 JSON/)
  })

  it('剧本 provider 的兜底文本与默认收尾跟随语言', async () => {
    const request = { system: '', messages: [], tools: [] }
    initI18n({ locale: 'en-US' })
    expect((await new ScriptedProvider([]).chat(request)).text).toBe('(script exhausted)')
    expect(scriptFromCalls([]).at(-1)?.text).toBe('Done.')

    initI18n({ locale: 'zh-CN' })
    expect((await new ScriptedProvider([]).chat(request)).text).toBe('（剧本用完了）')
    expect(scriptFromCalls([]).at(-1)?.text).toBe('完成。')
  })
})
