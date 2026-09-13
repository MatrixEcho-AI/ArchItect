// @vitest-environment jsdom
import { createElement } from 'react'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it } from 'vitest'

import { t } from '@architect/i18n'

import { Toolbar } from '../src/renderer/components/toolbar.js'
import { EXPORT_FORMATS } from '../src/shared/export-formats.js'
import type { ExportFormat } from '../src/shared/export-formats.js'
import type { StudioState } from '../src/renderer/types.js'

/**
 * **导出下拉真的渲染得出来，而且每一项真的把对应的格式传下去。**
 *
 * 这是那条链路上最外的一环，也是唯一能覆盖"组件自己坏了"的一环：
 * 类型检查、服务层测试、源码断言都拦不住"Drowdown 与子元素的组合在真浏览器里
 * 打不开"或"菜单项点下去回调收到的是别的格式"。
 *
 * ## 为什么这个文件必须跑在 jsdom 里
 *
 * 全仓只有 `markdown.test.ts` 与本文件声明了 jsdom（`vitest.config.ts` 的默认
 * environment 是 `node`）。这里**真的挂载 `Toolbar` 并真的派发点击**，
 * 不读源码文本——因为上一次事故（界面上 `.litematic` 消失）恰恰是"源码看起来
 * 很对、运行时少一项"，文本断言在那次事故里天然是瞎的。
 *
 * jsdom 里要补两个浏览器 API（`matchMedia` / `ResizeObserver`），antd 5 启动时
 * 就会摸它们。这不是"测试环境的将就"——`markdown.test.ts` 也在做同一类打点。
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
// React 18 靠这个开关决定要不要为 `act()` 抑制警告；不设的话每次挂载都会刷屏，
// 而刷屏的代价是"真正的警告被淹掉"。
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

/** 一个 `busy` 为假的最小状态——`Toolbar` 只读 `canUndo` / `canRedo` 两个字段。 */
const state = { canUndo: false, canRedo: false } as unknown as StudioState

let mounted: { host: HTMLElement; root: ReturnType<typeof createRoot> } | undefined

/**
 * 让 rc-motion 的入场/退场动画跑完。
 *
 * antd 的下拉是异步挂载 + 有动画的：`requestAnimationFrame` 链上的状态更新如果
 * 落在 `act` 之外，React 会往 stderr 刷 "code that causes React state updates
 * should be wrapped into act(...)"。**这些警告必须收干净**——不然将来真出问题时，
 * 它埋在几十行样板警告里没人看得见（这个项目为"噪声淹掉信号"写过好几次注释）。
 * 所以每个动作用一个 `act` 包住，并在里面留出动画的时间。
 */
async function settle(ms = 120): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms))
  })
}

afterEach(async () => {
  if (mounted === undefined) return
  const { host, root } = mounted
  mounted = undefined
  // 卸载也会触发 rc-motion 的退场动画，同样要包在 act 里
  await act(async () => {
    root.unmount()
  })
  host.remove()
})

/** 挂载工具栏，返回它。 */
async function mountToolbar(onExport: (format: ExportFormat) => void): Promise<HTMLElement> {
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  mounted = { host, root }
  await act(async () => {
    root.render(
      createElement(Toolbar, {
        state,
        costText: '',
        statusText: '',
        onNew: () => {},
        onOpen: () => {},
        onSave: () => {},
        onExport,
        onImport: () => {},
        onUndo: () => {},
        onRedo: () => {},
        onOpenSettings: () => {},
      }),
    )
  })
  return host
}

/** 点一下导出按钮，等下拉真的挂到 body 上。 */
async function openExportMenu(host: HTMLElement): Promise<HTMLElement[]> {
  const trigger = host.querySelector('#btn-export')
  expect(trigger, '工具栏里没有 #btn-export').not.toBeNull()
  await act(async () => {
    trigger!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
  // rc-trigger 是异步挂载 + rc-motion 有入场动画，等它跑完再查
  await settle()
  return [...document.querySelectorAll<HTMLElement>('.ant-dropdown-menu-item')]
}

/** 点中菜单里的一项（并等退场动画跑完）。 */
async function clickItem(item: HTMLElement): Promise<void> {
  await act(async () => {
    item.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
  await settle()
}

describe('工具栏的导出下拉', () => {
  it('点一下导出，菜单里**恰好是表里那三种格式**（顺序也一致）', async () => {
    const host = await mountToolbar(() => {})
    const items = await openExportMenu(host)
    // 断的是"与 EXPORT_FORMATS 逐项对应"而不是写死的三条中文：加一种格式时
    // 这里跟着表走，而 locale 换掉也不会误报。
    expect(items.map((item) => item.textContent)).toEqual(EXPORT_FORMATS.map((entry) => t(entry.label)))
  })

  it('**点 litematic 那一项，回调收到的就是 `litematic`**（每项都对得上，没有串位）', async () => {
    const picked: ExportFormat[] = []
    const host = await mountToolbar((format) => picked.push(format))

    // 逐个点开、点中、再关掉。一次只点一项，这样"串位"（点 A 传 B）会立刻暴露。
    for (const entry of EXPORT_FORMATS) {
      const items = await openExportMenu(host)
      const index = EXPORT_FORMATS.indexOf(entry)
      await clickItem(items[index]!)
    }

    expect(picked).toEqual(EXPORT_FORMATS.map((entry) => entry.format))
  })
})
