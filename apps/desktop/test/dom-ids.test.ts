import { readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

/**
 * 渲染进程硬取的每个元素 id，都必须真的有人创建它。
 *
 * 这条测试的来源是一次真机事故：旧实现里 `el('x')` 在找不到元素时直接 throw，
 * 而标记与代码是**两份文件**，于是"把 index.html 里的某一块删掉 / 注释掉 / 隐藏"
 * 这种最普通的改动会**在运行时**炸——类型检查与单元测试都不碰 DOM，拦不住它。
 *
 * ## 界面换成 React 之后，这条测试要保护的东西变了
 *
 * 旧版是"代码 → index.html"：结构在手写的 228 行 HTML 里，代码按 id 去取。
 * 新版结构也是一份文件（`components/*.tsx` 里的 JSX），但**取元素的方式变成两种**：
 *
 *   - **受控引用**（绝大多数）：`ref` / props，编译期就有保障，不需要这条测试；
 *   - **按 id 硬取**（少数）：`simulate.ts` 的合成事件、`app.tsx` 里建外壳与拾取时
 *     取 `#canvas` / `#overlay`。这些是**只在运行时才炸**的那一类，也正是这条测试
 *     要盯的。
 *
 * 所以判据是"`getElementById('x')` 的 x，必须能在渲染进程源码里找到 `id="x"`"。
 * 它同时守住了另一件事：**那几个"隐藏但不删"的块**（机位面板、调色板、成本读数、
 * 状态行）必须仍然有人渲染，而且仍然带隐藏标记——它们承载着人机共用机位、
 * 人手接管、以及 gui-smoke 读相机快照那条链路。
 *
 * 两个刻意的取舍，与旧版一致：
 *
 * - **只查一个方向**（取 → 有）。反过来"有 id 但没人取"是合法的（id 可以只为
 *   自动化或 CSS 服务），把它当错误会让正常改动无端变红。
 * - **动态创建的 id 走白名单**，并且要写清是哪一行创建的。
 */
const DYNAMIC_IDS = new Set([
  // 对话横幅里"打开设置"那个按钮：随 `#blocking` 那条 Alert 的 message 一起渲染，
  // 不是独立的一块标记（旧版是 renderChat() 的 innerHTML 里拼出来的）
  'blocking-settings',
])

const here = dirname(fileURLToPath(import.meta.url))
const desktopRoot = join(here, '..')
const rendererRoot = join(desktopRoot, 'src/renderer')

/** 渲染进程的全部源码（.ts + .tsx，含 components/ 子目录）。 */
function sources(): Array<{ path: string; text: string }> {
  const out: Array<{ path: string; text: string }> = []
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry)
      if (statSync(full).isDirectory()) {
        walk(full)
        continue
      }
      if (entry.endsWith('.ts') || entry.endsWith('.tsx')) {
        out.push({ path: full, text: readFileSync(full, 'utf8') })
      }
    }
  }
  walk(rendererRoot)
  return out
}

/** 代码里**按 id 硬取**的那些 id。 */
function referencedIds(files: Array<{ path: string; text: string }>): string[] {
  const ids = new Set<string>()
  for (const { text } of files) {
    for (const pattern of [
      /getElementById\(\s*'([^']+)'\s*\)/g,
      /querySelector(?:<[^>]*>)?\(\s*'#([^']+)'\s*\)/g,
    ]) {
      for (const match of text.matchAll(pattern)) ids.add(match[1]!)
    }
  }
  return [...ids].sort()
}

/** 源码里声明出来的 id（JSX 的 `id="x"` 与对象字面量的 `id: 'x'` 都算）。 */
function declaredIds(files: Array<{ path: string; text: string }>): Set<string> {
  const ids = new Set<string>()
  for (const { text } of files) {
    for (const match of text.matchAll(/\bid[=:]\s*['"]([^'"]+)['"]/g)) ids.add(match[1]!)
  }
  return ids
}

describe('渲染进程硬取的每个元素 id 都必须有人创建', () => {
  const files = sources()
  // 唯一的例外是挂载点 `#root`：它**必须**在 index.html 里而不是 JSX 里，
  // 因为 React 要往它里面挂。把它和 JSX 一起当声明来源，比单开一个白名单更诚实
  // ——白名单会让人以为"HTML 里声明 id"是可以随手加的，而这里只应有这一个。
  const indexHtml = readFileSync(join(rendererRoot, 'index.html'), 'utf8')
  const declared = declaredIds([...files, { path: 'index.html', text: indexHtml }])

  it('没有"代码里取了、但没有任何组件渲染它"的 id（那种会直接抛异常）', () => {
    const missing = referencedIds(files).filter((id) => !declared.has(id) && !DYNAMIC_IDS.has(id))
    expect(
      missing,
      `这些 id 被 getElementById 硬取，但源码里没有任何 id="…"：${missing.join(', ')}`,
    ).toEqual([])
  })

  it('白名单里的动态 id 确实是被渲染出来的（不是为了绕开这条测试）', () => {
    for (const id of DYNAMIC_IDS) {
      expect(declared.has(id), `${id} 既没被渲染，也没在别处说得通`).toBe(true)
    }
  })

  it('**被隐藏的块仍然在渲染，而且仍然带隐藏标记**：隐藏只能靠 hidden，不能靠删', () => {
    // 这几块按要求"从界面上隐藏"（不是删掉）：元素还在、接线还在，
    // 去掉一个隐藏标记就能改回可见。碰它们的标记时这条会先响。
    //
    // `#status` 尤其不能少：它是渲染进程里**唯一读得到的相机快照**，
    // gui-smoke 的 wasd-move / space-shift-vertical / 拖动方向三条断言都读它。
    //
    // `#btn-settings` **已经不在这个名单里**：按要求它回到可见，并以齿轮图标
    // 放在右上角（`toolbar.tsx` 的 `IconButton`）——它不能再带 `hidden`，
    // 但下面那条"照旧渲染"的断言仍然管着它。
    const hiddenBlocks = ['cost', 'status', 'camera-panel', 'palette-panel']
    for (const id of hiddenBlocks) {
      expect(declared.has(id), `#${id} 不再被渲染了`).toBe(true)
    }

    // 每个隐藏元素附近必须出现 hidden。取 id 前后各 260 字符作为"这个元素的属性表"
    // 的近似窗口——JSX 里一个元素的属性都挤在一起，这个窗口够用，而且不受属性顺序影响。
    for (const id of hiddenBlocks) {
      const owner = files.find((file) => file.text.includes(`id="${id}"`))
      expect(owner, `找不到渲染 #${id} 的文件`).toBeDefined()
      const at = owner!.text.indexOf(`id="${id}"`)
      const window = owner!.text.slice(Math.max(0, at - 260), at + 260)
      expect(window, `#${id} 附近没有 hidden 标记：\n${window}`).toContain('hidden')
    }
  })

  it('**设置入口可见**：`#btn-settings` 照旧渲染，且不再带隐藏标记', () => {
    // 这条是上一条的反面：设置按钮从"隐藏但保留"改成"显示在右上角"。
    // 只把 id 从 hiddenBlocks 里拿掉还不够——那样"它到底还渲不渲染"就没人盯了
    // （这条测试只查"取 → 有"，而 `#btn-settings` 现在已经没人硬取）。
    // 所以这里自己声明契约：元素在、且没有 hidden。
    expect(declared.has('btn-settings'), '#btn-settings 不再被渲染了').toBe(true)
    const owner = files.find((file) => file.text.includes('id="btn-settings"'))
    expect(owner, '找不到渲染 #btn-settings 的文件').toBeDefined()
    const at = owner!.text.indexOf('id="btn-settings"')
    const window = owner!.text.slice(Math.max(0, at - 260), at + 260)
    expect(window, `#btn-settings 仍然带隐藏标记：\n${window}`).not.toContain('hidden')
  })
})
