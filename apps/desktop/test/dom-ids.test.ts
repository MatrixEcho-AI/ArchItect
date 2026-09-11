import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

/**
 * 渲染进程取元素用的是 `el()`，**找不到就 throw**（`main.ts` 顶部）。而标记与代码是两份
 * 文件，于是"把 index.html 里的某一块删掉 / 注释掉 / 隐藏"这种最普通的改动会**在运行时**
 * 炸——类型检查与单元测试都不碰 DOM，拦不住它。
 *
 * 这条测试把两份文件对起来：代码里严格取的 id，必须真的存在。
 *
 * 几个刻意的取舍：
 *
 * - **只查一个方向**（代码 → HTML）。反过来"HTML 里有但没人取"是合法的：id 可以只为 CSS
 *   或标签服务，把它当错误会让正常的标记改动无端变红。
 * - **动态创建的元素**走白名单。它们由 JS 在运行时插进 DOM（`innerHTML`），HTML 里本来就没有；
 *   白名单只能写在这里，而且要写清是哪一行创建的。
 */
const DYNAMIC_IDS = new Set([
  // renderChat()：随 #blocking 的 innerHTML 一起创建
  'blocking-settings',
  // renderOpDetail()：随 #op-detail 的 innerHTML 一起创建
  'op-detail-close',
])

const here = dirname(fileURLToPath(import.meta.url))
const desktopRoot = join(here, '..')

/** 代码里严格取的 id：`el('x')` / `el<T>('x')` / `getElementById('x')` / `querySelector('#x')`。 */
function referencedIds(source: string): string[] {
  const ids = new Set<string>()
  for (const pattern of [
    /\bel(?:<[^>]*>)?\(\s*'([^']+)'\s*\)/g,
    /getElementById\(\s*'([^']+)'\s*\)/g,
    /querySelector(?:<[^>]*>)?\(\s*'#([^']+)'\s*\)/g,
  ]) {
    for (const match of source.matchAll(pattern)) ids.add(match[1]!)
  }
  return [...ids].sort()
}

function declaredIds(html: string): Set<string> {
  return new Set([...html.matchAll(/id="([^"]+)"/g)].map((match) => match[1]!))
}

describe('渲染进程取的元素必须真的在 index.html 里', () => {
  const source = readFileSync(join(desktopRoot, 'src/renderer/main.ts'), 'utf8')
  const html = readFileSync(join(desktopRoot, 'src/renderer/index.html'), 'utf8')
  const declared = declaredIds(html)

  it('没有"代码里取了、标记里却没有"的 id（那种会直接抛异常）', () => {
    const missing = referencedIds(source).filter((id) => !declared.has(id) && !DYNAMIC_IDS.has(id))
    expect(missing, `这些 id 被 el() 严格取，但 index.html 里没有：${missing.join(', ')}`).toEqual([])
  })

  it('白名单里的动态 id 确实是被 JS 创建出来的（不是为了绕开这条测试）', () => {
    for (const id of DYNAMIC_IDS) {
      expect(source, `${id} 既不在 HTML 里，也没在 main.ts 里被创建`).toContain(`id="${id}"`)
    }
  })

  it('**被隐藏的块仍然有完整的接线**：隐藏只能靠 hidden，不能靠删标记', () => {
    // 这几块按要求"从界面上隐藏"（不是删掉）：元素还在、代码还在，
    // 去掉一个 class 就能改回可见。碰它们的 markup 时这条会先响。
    for (const id of ['cost', 'status', 'btn-settings', 'cam-mode', 'cam-share', 'camera-panel', 'palette-panel']) {
      expect(declared.has(id), `#${id} 不在 index.html 里了`).toBe(true)
    }
    // 每个被隐藏的元素自己那一行必须带 hidden（从它所在的 `<` 取到 `>`，属性顺序无关）
    for (const id of ['cost', 'status', 'btn-settings', 'camera-panel', 'palette-panel']) {
      const start = html.lastIndexOf('<', html.indexOf(`id="${id}"`))
      const tag = start < 0 ? '' : html.slice(start, html.indexOf('>', start) + 1)
      expect(tag, `#${id} 的标签上没有 hidden：${tag}`).toContain('hidden')
    }
  })
})
