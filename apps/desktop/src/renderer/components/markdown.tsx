import { memo, useMemo } from 'react'
import DOMPurify from 'dompurify'
import { marked } from 'marked'

/**
 * 对话里的 **markdown 渲染**。
 *
 * 模型的回复天然是 markdown：设计说明用标题与列表、坐标用表格、`verify` 的期望用
 * JSON 片段。按纯文本铺出来（`white-space: pre-wrap`）在窄栏里读起来很糟——
 * `**粗体**` 带着星号、表格挤成一团。
 *
 * ## 这里是唯一一处 `dangerouslySetInnerHTML`，所以全项目的 XSS 讨论都收在这一个文件
 *
 * 内容来源是**模型**，而且 `.mcai` 是要分享给别人的文件（对话会跟着工程走）——
 * 也就是说这份内容我们是**不能信**的。三道防线，缺一不可：
 *
 * 1. **`DOMPurify.sanitize`**：主防线。它按白名单清洗，并把 `javascript:` / `data:`
 *    这类危险的 `href` 一并处理掉。DOMPurify 比我自己写正则可靠得多——这类过滤
 *    写过的人都知道，手写的那些总会漏。
 * 2. **渲染进程的 CSP**（`index.html`）：`script-src 'self'` 没有让步，所以就算
 *    有 `<script>` 漏进来也执行不了；`default-src 'none'` 让外部资源也加载不了。
 * 3. **主进程的 `will-navigate` / `setWindowOpenHandler`**：链接在系统浏览器里开，
 *    不会把应用本身导航走。
 *
 * ## 为什么 memo
 *
 * 一条 assistant 消息在流式生成时会**逐字重渲染**（碎片每 40ms 合并推一次）。
 * markdown 解析 + 清洗都是纯计算，`memo` 让"文本没变就不重算"这件事自动成立。
 */
export const Markdown = memo(function Markdown({ text }: { text: string }): React.JSX.Element {
  const html = useMemo(() => renderMarkdown(text), [text])
  return (
    // eslint-disable-next-line react/no-danger -- 见文件头：这里的内容已经过 DOMPurify 清洗
    <div className="md" dangerouslySetInnerHTML={{ __html: html }} />
  )
})

/**
 * markdown → **已清洗的** HTML。
 *
 * 单独抽出来是为了它能被单测直接调用（组件那层要渲染环境，函数这一层不用）。
 */
export function renderMarkdown(text: string): string {
  if (text.trim().length === 0) return ''
  const raw = marked.parse(text, {
    async: false,
    gfm: true,
    // 模型经常在单个换行处就换行（它按"行"思考），不开这个的话那些换行会被吃掉
    breaks: true,
  }) as string
  /**
   * **没有 DOM 时不许往下走。**
   *
   * `dompurify` 在 Node 里（没有 `window`）导出的对象上**没有 `sanitize`**，
   * 直接调会抛 `TypeError`。两条路都不能要：
   *   - 抛错 → 整个对话面板白屏，而且报的是个跟 markdown 毫无关系的错；
   *   - 悄悄退化成"不清洗" → **更糟**，因为那就等于放行模型给的任意 HTML，
   *     而且测试会绿（它拿到的正是未清洗的字符串）。
   *
   * 所以这里显式失败并说清楚原因。正常路径上渲染进程一定有 DOM，走不到这个分支；
   * 它防的是"在 Node 里渲染这些组件"这种用法（`renderToStaticMarkup` 的单测、
   * 未来的 SSR）——那时必须显式接管清洗，不能默认它已经做了。
   */
  if (typeof DOMPurify.sanitize !== 'function') {
    throw new Error(
      'renderMarkdown 需要一个 DOM：dompurify 在没有 window 的环境里不提供 sanitize。' +
        '服务端渲染这类场景请自行先建 DOM（jsdom），不要在未清洗的情况下渲染模型输出。',
    )
  }
  return DOMPurify.sanitize(raw, {
    ALLOWED_TAGS: [
      'p', 'br', 'hr', 'strong', 'em', 'del', 'code', 'pre', 'blockquote',
      'ul', 'ol', 'li', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
      'table', 'thead', 'tbody', 'tr', 'th', 'td', 'a',
    ],
    ALLOWED_ATTR: ['href', 'title', 'class', 'colspan', 'rowspan', 'align'],
    // **不放行 `target`**：链接交给主进程的 `will-navigate` 在系统浏览器里开
    // （见 `main/index.ts`），不需要 `_blank`，也免得开两个窗口的语义绕一层。
    // 标签白名单里没有 img：图不在对话里渲染（截图走 `Shot` 那条内容寻址的路），
    // 所以模型编出来的远端图片地址不该被加载。
  })
}
