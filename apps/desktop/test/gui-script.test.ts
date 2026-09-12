import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

/**
 * **拼给渲染进程的那段脚本必须是合法 JS。**
 *
 * `assertGuiPanels` 里那一段是**字符串**，不是代码：它被 `executeJavaScript` 送到
 * 渲染进程当普通 JS 跑。所以 TypeScript 一个字都帮不上忙——`(): number =>` 这种
 * 类型标注在 `.ts` 里完全合法，进了字符串就变成语法错误。
 *
 * 而且它的失败方式极难查：`executeJavaScript` 只回一句
 * "Script failed to execute, this normally means an error was thrown"，
 * 没有行号、没有栈，主进程那边表现为"渲染进程没有回报"+ 整条冒烟超时。
 * 真机踩过一次，为了那一行找了好几轮。
 *
 * 所以这里把那段字符串抠出来做一次语法检查。抠法刻意"笨"但可靠：
 * 从源码文本里切出模板字面量，把 `${...}` 一律换成 `0`（合法的 JS 表达式），
 * 剩下的交给 `new Function` —— 只要能构造出来，送过去就能跑。
 *
 * ⚠️ 这条只查**语法**，不查行为：行为由 gui-smoke 自己在真窗口里查。
 */
const here = dirname(fileURLToPath(import.meta.url))
const source = readFileSync(join(here, '..', 'src/main/index.ts'), 'utf8')

/** 从 `const script = \`…\`` 里切出那段模板字面量的正文。 */
function injectedScript(): string {
  const anchor = source.indexOf('async function assertGuiPanels')
  expect(anchor, '找不到 assertGuiPanels（它被改名了吗？）').toBeGreaterThan(-1)
  const start = source.indexOf('const script = `', anchor)
  expect(start, '找不到 `const script = ` 那一行').toBeGreaterThan(-1)
  const body = source.slice(start + 'const script = `'.length)
  const end = body.indexOf('`\n')
  expect(end, '模板字面量没有收尾').toBeGreaterThan(-1)
  return body.slice(0, end)
}

describe('拼给渲染进程的脚本', () => {
  const script = injectedScript()

  it('确实抠出了一段像样的脚本（别让这条断言变成空转）', () => {
    expect(script.length).toBeGreaterThan(1000)
    expect(script).toContain('querySelector')
    expect(script).toContain('return results')
  })

  it('**是合法 JS**：类型标注之类的东西不许漏进这段字符串', () => {
    // `${...}` 是主进程侧的插值，取值由运行时决定；换成 `0` 只为了过语法关
    const body = script.replace(/\$\{[^}]*\}/g, '0')
    expect(
      () => new Function(`return (async () => { ${body} })`),
      '这段脚本送进渲染进程会解析失败（症状是"渲染进程没有回报"）',
    ).not.toThrow()
  })

  it('注释里没有反引号（那会把模板字面量提前截断）', () => {
    // 模板字面量里出现裸反引号会在**编译期**就坏掉，但这条留着当文档：
    // 写注释时用引号，别用反引号。
    expect(script).not.toContain('`')
  })
})
