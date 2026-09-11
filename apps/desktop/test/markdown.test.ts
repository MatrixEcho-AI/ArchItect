// @vitest-environment jsdom
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { initI18n } from '@architect/i18n'
import { describe, expect, it } from 'vitest'

import { Markdown, renderMarkdown } from '../src/renderer/components/markdown.js'

initI18n({ locale: 'zh-CN' })

/**
 * markdown 渲染的安全边界。
 *
 * **这个文件必须跑在 jsdom 里**（见首行那个 docblock）。原因是 `dompurify` 在
 * 没有 `window` 的环境下导出的对象上没有 `sanitize`，于是：
 *   - 这些断言会直接抛错（好）；
 *   - 但如果组件当时写成了"没有 sanitize 就跳过清洗"，它们会**全绿**——
 *     因为拿到的正是未清洗的字符串。那是这类测试最坏的失败模式：绿着，但没保护。
 *
 * 内容是**模型产出的**，而 `.mcai` 是要分享给别人的文件（对话跟着工程走），
 * 所以这里按"内容不可信"来测。
 */
describe('markdown：正常渲染', () => {
  it('粗体、行内代码、标题、列表、表格、代码块都出得来', () => {
    const html = renderMarkdown(
      ['# 标题', '', '**粗体** 与 `代码`', '', '- 一', '- 二', '', '| a | b |', '|---|---|', '| 1 | 2 |', '', '```json', '{"a":1}', '```'].join('\n'),
    )
    expect(html).toContain('<strong>粗体</strong>')
    expect(html).toContain('<code>代码</code>')
    expect(html).toContain('<h1>')
    expect(html).toContain('<li>一</li>')
    expect(html).toContain('<table>')
    expect(html).toContain('<th>a</th>')
    expect(html).toContain('language-json')
  })

  it('空文本给空串（不渲染一个空壳卡片）', () => {
    expect(renderMarkdown('')).toBe('')
    expect(renderMarkdown('   \n  ')).toBe('')
  })

  it('单个换行就换行（模型按"行"思考，breaks 必须开）', () => {
    expect(renderMarkdown('第一行\n第二行')).toContain('<br>')
  })
})

/**
 * 这一组是**这个文件存在的理由**。
 *
 * 每一条都是真会用到的载荷，不是教科书例子：`<script>`、`onerror`、
 * `javascript:` URL、`data:` URL、`<iframe>`。全项目的 XSS 讨论都收在
 * `markdown.tsx` 那一个文件里，所以这里要把它的三道防线都试一遍。
 */
describe('markdown：清洗掉危险内容', () => {
  it('`<script>` 不会进结果', () => {
    const html = renderMarkdown('<script>alert(1)</script>')
    expect(html).not.toContain('<script')
    expect(html).not.toContain('alert(1)')
  })

  it('`onerror` 这类事件属性不会留下', () => {
    const html = renderMarkdown('<img src=x onerror=alert(1)>')
    expect(html).not.toContain('onerror')
    expect(html).not.toContain('alert(1)')
  })

  it('`<iframe>` 不会留下（default-src none 之外再加一层）', () => {
    const html = renderMarkdown('<iframe src="https://evil.test"></iframe>')
    expect(html).not.toContain('<iframe')
  })

  it('`javascript:` 链接不会留下一个可点的 href', () => {
    const html = renderMarkdown('[点我](javascript:alert(1))')
    expect(html).not.toContain('javascript:')
  })

  it('`data:` 链接同样处理', () => {
    const html = renderMarkdown('[点我](data:text/html,<script>alert(1)</script>)')
    expect(html).not.toContain('data:text/html')
  })

  it('`style` 属性被去掉（否则能用 CSS 把界面叠掉/钓鱼）', () => {
    const html = renderMarkdown('<p style="position:fixed;inset:0">覆盖</p>')
    expect(html).not.toContain('style=')
  })

  it('**图片一律不渲染**：截图走内容寻址那条路，远端图片地址不该被加载', () => {
    const html = renderMarkdown('![x](https://evil.test/track.png)')
    expect(html).not.toContain('<img')
    expect(html).not.toContain('evil.test')
  })

  it('正常的 https 链接保留（模型给的文档地址要能点）', () => {
    const html = renderMarkdown('[文档](https://example.com/docs)')
    expect(html).toContain('href="https://example.com/docs"')
  })

  it('清洗之后 markdown 本身仍然正常', () => {
    const html = renderMarkdown('**重要**：见 [文档](https://example.com)')
    expect(html).toContain('<strong>重要</strong>')
    expect(html).toContain('href="https://example.com"')
  })
})

describe('markdown：组件', () => {
  it('渲染进一个 .md 容器（样式挂在这个类上）', () => {
    const html = renderToStaticMarkup(createElement(Markdown, { text: '**粗**' }))
    expect(html).toContain('class="md"')
    expect(html).toContain('<strong>粗</strong>')
  })
})
