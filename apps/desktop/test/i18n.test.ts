import { readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { initI18n, setLocale, t } from '@architect/i18n'
import { describe, expect, it } from 'vitest'

import { StudioService } from '../src/main/services/studio.js'

initI18n({ locale: 'zh-CN' })

const here = dirname(fileURLToPath(import.meta.url))
const desktopRoot = join(here, '..')

/** 去掉注释，只留代码。注释里全是中文，而它们**本来就该**是中文。 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/.*$/gm, '$1')
}

const CJK = /[\u4e00-\u9fff]/

/** 字符串字面量（单引号 / 双引号 / 反引号）里的内容。 */
const LITERAL = /'([^'\\]*(?:\\.[^'\\]*)*)'|"([^"\\]*(?:\\.[^"\\]*)*)"|`([^`\\]*(?:\\.[^`\\]*)*)`/g

function stringLiterals(source: string): string[] {
  const found: string[] = []
  for (const match of source.matchAll(LITERAL)) found.push(match[1] ?? match[2] ?? match[3] ?? '')
  return found
}

/**
 * **判据：这个中文字符串是不是流向"开发者出口"的。**
 *
 * 允许的出口只有这几个：终端诊断行（`--smoke` / `--gui-smoke` 的 `lines.push`）、
 * `console.*`、`process.std*.write`、以及**内部** `throw new Error(...)`
 * ——它们被 catch 之后用来决定"要不要回落到软件光栅器"，不会显示给用户。
 *
 * 其余一律要 `t(...)`。用"出口"而不是"白名单字符串"来判：白名单会随着改动一条条变长，
 * 而人一旦习惯了往里加东西，这个测试就再也拦不住任何东西。
 */
const DEV_SINKS = [
  'lines.push(',
  'console.warn(',
  'console.error(',
  'console.log(',
  'process.stdout.write(',
  'process.stderr.write(',
  'throw new Error(',
  // 渲染进程把"这一枪为什么画不了"回报给主进程（`{error}` / `{detail}`），
  // 主进程拿它决定回落到软件光栅器，并把原话写进终端的诊断行——到不了用户眼前
  'error: ',
  'detail: ',
  // 诊断开关（`--camera-test` 之类）把自查结论贴进提示条，好让抓图能读到。
  // **它只在诊断跑里出现**，正常启动永远不会写这一行；同一批诊断行的中文本来
  // 就写在主进程里（`[gui-smoke]` 那些 `lines.push`），性质一样。
  // 判据是"这个出口只有开发者会看到"，不是"这句中文看起来重不重要"。
  'banner.textContent =',
]

/**
 * **语言名不进 i18n 表**（endonym：每种语言用它自己的写法）。
 *
 * 语言选择器里那一项在哪个 locale 下都该写"中文"而不是 "Chinese"——用户找自己的
 * 语言时，认的是自己语言的字形，翻过去反而找不到。所以这一类是**判据的例外**，
 * 而不是"漏翻"；写成例外并说明理由，比往资源表里塞一个中英两边都一样的键更诚实。
 *
 * 只放语言名，不放别的：这个集合一旦开始装"看起来也说得过去"的短语，
 * 这条测试就再也拦不住任何东西了。
 */
const ENDONYMS = new Set(['中文', 'English'])

/** 往前看几行找出口：模板字符串是跨行的，`${}` 里的中文可能离出口好几行。 */
const SINK_LOOKBACK = 8

/** 含汉字、且不是流向开发者出口的字符串字面量。 */
function offendingLiterals(source: string): string[] {
  const code = stripComments(source)
  const lines = code.split('\n')
  const offenders: string[] = []
  for (const match of code.matchAll(LITERAL)) {
    const literal = match[1] ?? match[2] ?? match[3] ?? ''
    if (!CJK.test(literal)) continue
    if (ENDONYMS.has(literal.trim())) continue
    const line = code.slice(0, match.index).split('\n').length - 1
    const context = lines.slice(Math.max(0, line - SINK_LOOKBACK), line + 1).join('\n')
    if (DEV_SINKS.some((sink) => context.includes(sink))) continue
    offenders.push(literal)
  }
  return offenders
}

describe('桌面端：用户可见的文案必须走 i18n', () => {
  it('**主进程里没有硬编码的用户可见中文**', () => {
    const files = [
      'src/main/index.ts',
      'src/main/services/studio.ts',
      'src/main/services/chat.ts',
      'src/main/services/settings.ts',
    ]
    const offenders: string[] = []
    for (const file of files) {
      const source = readFileSync(join(desktopRoot, file), 'utf8')
      for (const literal of offendingLiterals(source)) offenders.push(`${file}: ${literal.slice(0, 90)}`)
    }
    expect(offenders).toEqual([])
  })

  it('**渲染进程里没有硬编码的用户可见中文**（文案一律走 `t()`）', () => {
    // 旧版这条查的是 `data-i18n` 标记：结构在手写 HTML 里，文案靠标记在运行时填。
    // 换成 React 之后结构化成了 JSX，文案直接是 `t('...')`——**判据反而更强了**，
    // 因为 `t()` 的键是编译期校验的点分路径，写错键编译不过，而 `data-i18n` 写错
    // 只会在界面上留下一个裸键。所以这里只保留"有没有硬编码中文"这一半，
    // 扫描范围从单个 `main.ts` 扩到整个 renderer（含 components/）。
    const files: string[] = []
    const walk = (dir: string): void => {
      for (const entry of readdirSync(join(desktopRoot, dir))) {
        const rel = `${dir}/${entry}`
        if (statSync(join(desktopRoot, rel)).isDirectory()) walk(rel)
        else if (entry.endsWith('.ts') || entry.endsWith('.tsx')) files.push(rel)
      }
    }
    walk('src/renderer')

    const offenders: string[] = []
    for (const file of files) {
      const source = readFileSync(join(desktopRoot, file), 'utf8')
      for (const literal of offendingLiterals(source)) offenders.push(`${file}: ${literal.slice(0, 90)}`)
    }
    expect(offenders).toEqual([])
  })

  it('关键提示在英文下是英文、在中文下是中文', () => {
    const texts: Array<[Parameters<typeof t>[0], Record<string, string | number>]> = [
      ['recovery.found', { ops: 3, project: 'hut.mcai' }],
      ['recovery.missingBase', { ops: 3, project: ' (x)' }],
      ['recovery.cannotApply', {}],
      ['recovery.appliedNotice', { ops: 3, project: 'hut.mcai' }],
      ['desktop.edit.outsidePlace', {}],
      ['desktop.chatBlocking.noProvider', {}],
      ['desktop.contextTrimmed', { turns: 2, images: '', reason: 'windowed' }],
      ['desktop.export.objSummary', { size: '1×2×3', blocks: 4, faces: 5, materials: 6 }],
      ['desktop.import.summary', { size: '1×2×3', version: '', cells: 7 }],
      ['chat.behindTipDetail', { rev: 1, total: 3, lost: 2 }],
    ]

    setLocale('en-US')
    const english = texts.map(([key, vars]) => t(key, vars))
    for (const [index, text] of english.entries()) {
      expect(CJK.test(text), `en-US 的 ${texts[index]![0]} 里还有汉字：${text}`).toBe(false)
      expect(text.length).toBeGreaterThan(0)
    }

    setLocale('zh-CN')
    const chinese = texts.map(([key, vars]) => t(key, vars))
    for (const [index, text] of chinese.entries()) {
      expect(CJK.test(text), `zh-CN 的 ${texts[index]![0]} 应当是中文：${text}`).toBe(true)
    }
    // 两种语言真的不一样（不是同一句话抄了两遍）
    expect(english).not.toEqual(chinese)
    setLocale('zh-CN')
  })

  it('**文案里不再有那句做不到的承诺**（"打开那个工程即可在此基础上继续"）', () => {
    const source = stripComments(readFileSync(join(desktopRoot, 'src/main/services/studio.ts'), 'utf8'))
    // 提示与动作必须成对：说到就要能做到
    expect(source).not.toContain('打开那个工程即可')
    expect(source).toContain('applyRecovery')
    expect(source).toContain('discardRecovery')
    // 扫描器自身的基本功：去掉注释之后不该再看见注释里的中文
    expect(stringLiterals("const a = '中文' // 这是注释")).toEqual(['中文'])
  })
})

describe('桌面端文案与状态接线', () => {
  it('没接 autosave（无头/测试）时没有待办，调恢复也不炸', async () => {
    initI18n({ locale: 'zh-CN' })
    const studio = new StudioService({ plain: true })
    expect(studio.recover()).toBeUndefined()
    expect(studio.state().recovery).toBeUndefined()
    expect((await studio.applyRecovery()).recovery).toBeUndefined()
    expect(studio.discardRecovery().recovery).toBeUndefined()
  })
})
