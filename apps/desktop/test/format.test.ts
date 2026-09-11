import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { initI18n } from '@architect/i18n'
import { describe, expect, it } from 'vitest'

import { Collapsible, ThinkingBlock } from '../src/renderer/components/chat-panel.js'
import { compactNumber, usageText } from '../src/renderer/cost.js'
import { cacheShare } from '../src/renderer/format.js'

// 组件里的文案走 `t()`，而它要求先初始化（否则拿到的是裸键）
initI18n({ locale: 'zh-CN' })

describe('成本表盘：缓存命中比例', () => {
  it('算得出比例（四舍五入到整数）', () => {
    // 真实跑过的一轮灯塔：输入 1.97M，98% 命中前缀缓存
    expect(cacheShare({ in: 1_970_000, out: 30_000, cachedIn: 1_931_000 })).toEqual({
      count: 1_931_000,
      percent: 98,
    })
    expect(cacheShare({ in: 100, out: 1, cachedIn: 1 })).toEqual({ count: 1, percent: 1 })
    expect(cacheShare({ in: 3, out: 1, cachedIn: 2 })).toEqual({ count: 2, percent: 67 })
  })

  it('**没有缓存这个概念时不显示**（而不是显示 0%）', () => {
    expect(cacheShare({ in: 1000, out: 10 })).toBeUndefined()
    expect(cacheShare({ in: 1000, out: 10, cachedIn: 0 })).toBeUndefined()
  })

  it('还没有用量时不显示', () => {
    expect(cacheShare({ in: 0, out: 0, cachedIn: 0 })).toBeUndefined()
  })

  it('**不可能的数值宁可不说**（provider 字段含义对不上时）', () => {
    expect(cacheShare({ in: 100, out: 10, cachedIn: 120 })).toBeUndefined()
  })
})

/**
 * 顶栏那一行读数要**短**，所以数字得压。这类函数最容易错在**边界进位**上：
 * `999_950` 该写成 `1M` 还是 `1000k`？后者没人会读。
 */
describe('数字压缩（12k / 1.2M）', () => {
  it('一千以下原样，不加单位', () => {
    expect(compactNumber(0)).toBe('0')
    expect(compactNumber(7)).toBe('7')
    expect(compactNumber(842)).toBe('842')
    expect(compactNumber(999)).toBe('999')
  })

  it('千 / 百万 / 十亿 各一档，且整数不带 `.0`', () => {
    expect(compactNumber(1000)).toBe('1k')
    expect(compactNumber(1200)).toBe('1.2k')
    expect(compactNumber(12_000)).toBe('12k')
    expect(compactNumber(1_970_000)).toBe('2M')
    expect(compactNumber(2_500_000_000)).toBe('2.5B')
  })

  it('**四舍五入顶到下一档时要换单位**，不能写出 `1000k`', () => {
    expect(compactNumber(999_950)).toBe('1M')
    expect(compactNumber(999_999_999)).toBe('1B')
  })

  it('负数与非法值也不炸', () => {
    expect(compactNumber(-1200)).toBe('-1.2k')
    expect(compactNumber(Number.NaN)).toBe('—')
    expect(compactNumber(Number.POSITIVE_INFINITY)).toBe('—')
  })
})

describe('标题行读数：短，且缓存只给百分比', () => {
  const usage = {
    in: 1_970_000,
    out: 30_000,
    cachedIn: 1_931_000,
    turns: 31,
    toolCalls: 30,
    screenshots: 6,
  }

  it('token 压成 k/M，轮数与截图也压', () => {
    const text = usageText({ usage })
    expect(text).toContain('2M')
    expect(text).toContain('30k')
    expect(text).toContain('31')
    expect(text).toContain('6')
  })

  it('**缓存只显示百分比**，不带那个绝对数', () => {
    const text = usageText({ usage })
    expect(text).toContain('98%')
    // 绝对数不该出现在这一行里——顶栏那个宽度放不下，也没有决策价值
    expect(text).not.toContain('1.9M')
    expect(text).not.toContain('1931')
  })

  it('新会话（还没有任何输入）不显示一串 0', () => {
    expect(
      usageText({ usage: { in: 0, out: 0, cachedIn: 0, turns: 0, toolCalls: 0, screenshots: 0 } }),
    ).toBe('')
    expect(usageText(undefined)).toBe('')
  })

  it('provider 不报缓存时不显示这一项（而不是 0%）', () => {
    expect(usageText({ usage: { ...usage, cachedIn: 0 } })).not.toContain('缓存')
  })
})

/**
 * 思维链与工具返回**默认都收着**。
 *
 * 这是用户明确要的行为（Codex 式）：思维链只占一行、工具返回折叠。
 * 用 `renderToStaticMarkup` 验的正好是**初始状态**——它渲染不出 `useState` 之后的样子，
 * 所以"默认收着"这件事在这条路上能证明（展开了反而证明不了）。
 */
describe('对话里的折叠：默认收着', () => {
  it('思维链只渲染一行预览，全文不在 DOM 里', () => {
    const full = '第一步先量地块，第二步决定收分，第三步接屋顶。'
    const html = renderToStaticMarkup(
      createElement(ThinkingBlock, { text: full, streaming: true }),
    )
    expect(html).toContain('thinking-line')
    expect(html).toContain('第一步先量地块')
    expect(html).not.toContain('thinking-full')
  })

  it('思考结束后那行改成「已思考 N 字」，仍然可以点开', () => {
    const html = renderToStaticMarkup(
      createElement(ThinkingBlock, { text: '想完了', streaming: false }),
    )
    expect(html).toContain('thinking-toggle')
    expect(html).toContain('已思考')
    expect(html).not.toContain('thinking-full')
  })

  it('工具返回折叠：默认只有标题，正文不在 DOM 里', () => {
    const html = renderToStaticMarkup(
      createElement(Collapsible, { text: 'line one\nline two', label: '结果' }),
    )
    expect(html).toContain('collapsible-toggle')
    expect(html).toContain('结果')
    expect(html).not.toContain('collapsible-body')
    expect(html).not.toContain('line two')
  })

  it('预览取的是**最新**那一截，不是开头', () => {
    const full = `${'旧'.repeat(300)}最新的想法`
    const html = renderToStaticMarkup(
      createElement(ThinkingBlock, { text: full, streaming: true }),
    )
    expect(html).toContain('最新的想法')
  })
})
