// @vitest-environment jsdom
import { createElement } from 'react'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it } from 'vitest'

import { t } from '@architect/i18n'

import { SettingsModal } from '../src/renderer/components/settings-modal.js'
import type { SettingsView } from '../src/renderer/types.js'

/**
 * **设置对话框的左侧菜单**：通用在前、模型第二，默认落在模型页。
 *
 * 这是又一个"源码看着对、运行时才见分晓"的地方：菜单的顺序、点击后换不换内容、
 * 默认落在哪一页，都是 DOM 行为。文本断言（"存在 SECTIONS"）拦不住把两项写反，
 * 也拦不住默认页写错——而默认页写错的代价是 gui-smoke 与"挡住发送"横幅进来的用户
 * 直接落在语言页上。
 *
 * 与 `toolbar-export.test.ts` 同一个理由跑在 jsdom 里：真挂载、真点击。
 */
if (window.matchMedia === undefined) {
  window.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia
}
if (globalThis.ResizeObserver === undefined) {
  globalThis.ResizeObserver = class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  } as unknown as typeof ResizeObserver
}
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

/** 一份最小但成形的设置：一个配好的 provider。 */
const settings: SettingsView = {
  activeId: 'deepseek',
  providers: [
    {
      id: 'deepseek',
      preset: 'deepseek',
      kind: 'openai-compatible',
      baseURL: 'https://api.deepseek.com',
      apiKeyRef: 'env:DEEPSEEK_API_KEY',
      model: 'deepseek-flash',
      capabilities: {
        vision: true,
        toolCalling: 'native',
        promptCache: 'auto',
        source: 'probe',
        probedAt: '2026-01-01T00:00:00.000Z',
      },
      hasKey: true,
    },
  ],
  locale: 'zh-CN',
  ui: {},
  secrets: { location: 'memory', encrypted: false },
  issues: [],
}

let mounted: { host: HTMLElement; root: ReturnType<typeof createRoot> } | undefined

async function settle(ms = 120): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms))
  })
}

afterEach(async () => {
  if (mounted === undefined) return
  const { host, root } = mounted
  mounted = undefined
  await act(async () => {
    root.unmount()
  })
  host.remove()
})

/** 挂载并等对话框打开。Modal 渲染在 portal（document.body），查询要走 document。 */
async function mountModal(): Promise<void> {
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  mounted = { host, root }
  await act(async () => {
    root.render(
      createElement(SettingsModal, {
        open: true,
        settings,
        activeId: '',
        onActiveId: () => {},
        onClose: () => {},
        onSaved: () => {},
        onStatus: () => {},
      }),
    )
  })
  await settle()
}

/** 点菜单里的一项。 */
async function clickMenuItem(id: string): Promise<void> {
  const item = document.querySelector(`#${id}`)
  expect(item, `菜单里没有 #${id}`).not.toBeNull()
  await act(async () => {
    item!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
  await settle()
}

describe('设置对话框的左侧菜单', () => {
  it('**菜单恰好两项：通用在前，模型第二**', async () => {
    await mountModal()
    const items = [...document.querySelectorAll('.settings-menu-item')]
    expect(items.map((item) => item.textContent)).toEqual([
      t('settings.menu.general'),
      t('settings.menu.model'),
    ])
  })

  it('**默认落在模型页**（provider 列表在、语言选择器不在）', async () => {
    await mountModal()
    expect(document.querySelectorAll('.provider-card').length, '模型页没有 provider 条目').toBeGreaterThan(0)
    expect(document.querySelector('#cfg-locale'), '模型页不该出现语言选择器').toBeNull()
    expect(document.querySelector('#settings-menu-model')!.className).toContain('is-active')
  })

  it('点「通用」：语言选择器出现，provider 列表消失；点「模型」又回来', async () => {
    await mountModal()

    await clickMenuItem('settings-menu-general')
    expect(document.querySelector('#cfg-locale'), '通用页没有语言选择器').not.toBeNull()
    expect(document.querySelectorAll('.provider-card').length, '通用页不该有 provider 条目').toBe(0)
    expect(document.querySelector('#settings-menu-general')!.className).toContain('is-active')

    await clickMenuItem('settings-menu-model')
    expect(document.querySelectorAll('.provider-card').length, '切回模型页后 provider 条目不见了').toBeGreaterThan(0)
    expect(document.querySelector('#cfg-locale'), '切回模型页后语言选择器还在').toBeNull()
  })
})
