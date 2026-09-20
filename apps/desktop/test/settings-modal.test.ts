// @vitest-environment jsdom
import { createElement } from 'react'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it } from 'vitest'

import { t } from '@architect/i18n'

import { SettingsModal } from '../src/renderer/components/settings-modal.js'
import type { SettingsView } from '../src/renderer/types.js'

/**
 * **设置对话框的左侧菜单**：通用在前、模型第二，默认落在通用页。
 *
 * 这是又一个"源码看着对、运行时才见分晓"的地方：菜单的顺序、点击后换不换内容、
 * 默认落在哪一页，都是 DOM 行为。文本断言（"存在 SECTIONS"）拦不住把两项写反，
 * 也拦不住默认页写错。
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
      models: [{ id: 'deepseek-flash' }, { id: 'deepseek-reasoner' }],
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
async function mountModal(activeId = ''): Promise<void> {
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  mounted = { host, root }
  await act(async () => {
    root.render(
      createElement(SettingsModal, {
        open: true,
        settings,
        activeId,
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

/**
 * 在一个 antd Select 里按文案选一项。
 *
 * Select 的下拉是 portal + 动画，所以要：点选择器 → 等一拍 → 在下拉里找那一项 →
 * 点它 → 等一拍（收起的退场动画）。任何一步漏了等，下一步拿到的就是空下拉。
 */
async function chooseSelectOption(selectId: string, optionText: string): Promise<void> {
  const selector = document.querySelector(`#${selectId}`)
  expect(selector, `找不到 #${selectId}`).not.toBeNull()
  // `#cfg-*` 是 antd Select 内部的**搜索输入框**，不是触发器；
  // 展开下拉要 mousedown 在 `.ant-select-selector` 上（点外层 `.ant-select` 没反应）。
  const wrap = selector!.closest('.ant-select')!
  const trigger = wrap.querySelector('.ant-select-selector') ?? wrap
  await act(async () => {
    trigger.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }))
  })
  await settle()
  const option = [...document.querySelectorAll<HTMLElement>('.ant-select-item-option')].find(
    (el) => (el.textContent ?? '').includes(optionText),
  )
  expect(option, `下拉里没有「${optionText}」这一项`).not.toBeUndefined()
  await act(async () => {
    option!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
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

  it('**默认落在通用页**（外观与语言在、provider 列表不在）', async () => {
    await mountModal()
    expect(document.querySelector('#cfg-theme'), '通用页没有外观选择器').not.toBeNull()
    expect(document.querySelector('#cfg-locale'), '通用页没有语言选择器').not.toBeNull()
    expect(document.querySelectorAll('.provider-card').length, '通用页不该有 provider 条目').toBe(0)
    expect(document.querySelector('#settings-menu-general')!.className).toContain('is-active')
  })

  it('点「模型」：provider 列表出现，外观/语言消失；点「通用」又回来', async () => {
    await mountModal()

    await clickMenuItem('settings-menu-model')
    expect(document.querySelectorAll('.provider-card').length, '模型页没有 provider 条目').toBeGreaterThan(0)
    expect(document.querySelector('#cfg-locale'), '模型页不该出现语言选择器').toBeNull()
    expect(document.querySelector('#settings-menu-model')!.className).toContain('is-active')

    await clickMenuItem('settings-menu-general')
    expect(document.querySelector('#cfg-locale'), '切回通用页后语言选择器不见了').not.toBeNull()
    expect(document.querySelectorAll('.provider-card').length, '切回通用页后 provider 条目还在').toBe(0)
  })
})

describe('一个 provider 的多个模型', () => {
  it('编辑 provider 时显示可用模型列表与当前模型选择器', async () => {
    await mountModal('deepseek')
    await clickMenuItem('settings-menu-model')

    expect(document.querySelector('#cfg-models')).not.toBeNull()
    expect(document.querySelector('#cfg-model')).not.toBeNull()
    expect(document.body.textContent).toContain('deepseek-flash')
    expect(document.body.textContent).toContain('deepseek-reasoner')
  })
})

describe('通用页的外观设置', () => {
  it('**浅色 / 深色 / 自动三项**，选中即调 `setUi` 落盘（不需要保存按钮）', async () => {
    const patches: Array<Record<string, unknown>> = []
    // setUi 是唯一会被调到的桥方法：设置项改动立刻落盘，界面跟着 settings 走
    ;(window as { architect?: unknown }).architect = { setUi: (patch: Record<string, unknown>) => {
      patches.push(patch)
      return Promise.resolve(settings)
    } }
    await mountModal()

    await chooseSelectOption('cfg-theme', t('settings.theme.dark'))
    expect(patches).toEqual([{ theme: 'dark' }])

    await chooseSelectOption('cfg-theme', t('settings.theme.auto'))
    expect(patches).toEqual([{ theme: 'dark' }, { theme: 'auto' }])
  })
})
