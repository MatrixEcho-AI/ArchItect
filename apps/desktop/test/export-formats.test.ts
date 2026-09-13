import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import { StudioService } from '../src/main/services/studio.js'
import { EXPORT_FORMATS, exportFormatEntry, exportFormatOf } from '../src/shared/export-formats.js'

/**
 * 导出格式那条链路的**防回归测试**。
 *
 * ## 这条测试是为哪次事故写的
 *
 * 界面上「导出」曾经是一个直通按钮，格式在 `app.tsx` 里写死成 `'schem'`，
 * 而它的注释写着"扩展名决定格式；`.schem` / `.litematic` / `.obj` 三种"。
 * 也就是说三种格式**曾经都出得来**，某次改动之后只剩 `.schem`——
 * 而没有任何东西报警：
 *
 * - 类型检查过（`'schem'` 是合法的 `ExportFormat`）；
 * - 全量测试绿；
 * - 打包冒烟也绿，因为它**直接调 `service.exportModel(format, …)`**，
 *   证明的是"引擎能出 litematic"，不是"用户点得到 litematic"。
 *
 * 所以这里补的是**那条断掉的链路**：表 → 界面菜单 → 调用点 → 真的出字节。
 * 单测其中任何一段都不够——链路断在哪一段，用户就在哪一段失去一个格式。
 *
 * ## 为什么这个文件不渲染 React 组件
 *
 * **渲染那件事交给 `toolbar-export.test.ts`**（它跑在 jsdom 里，真挂载 `Toolbar`
 * 并真派发点击）。这里管的是另外两段：**表本身**、以及**表到字节**那一段。
 *
 * 三段的分工是刻意的：
 *
 * | 文件 | 管什么 | 拦得住什么 |
 * |---|---|---|
 * | 本文件 | 表 + 服务层 + `app.tsx` 的接线 | 格式被删、服务层少实现一种、接线写死 |
 * | `toolbar-export.test.ts` | 真挂载、真点击 | 组件坏了、菜单少一项、点击串位 |
 *
 * 缺任何一段，"界面上某个格式消失"都能重新发生。
 */
const here = dirname(fileURLToPath(import.meta.url))
const rendererRoot = join(here, '..', 'src/renderer')

const read = (relative: string): string => readFileSync(join(rendererRoot, relative), 'utf8')

/**
 * 去掉注释，只留代码。
 *
 * **断言必须针对代码，不能针对注释**，否则会得到一个荒唐的结果：注释里越把
 * 这次事故记清楚（"这行曾经写死成 `exportModel('schem')`"），测试越红。
 * 第一版就是这么红的——而它逼着人做选择：要么删掉那段解释，要么改测试。
 * 两个都不该选。
 *
 * 这是个刻意很小的状态机（行注释 / 块注释 / 三种字符串），不引 TypeScript
 * 编译器：这里只需要"注释与字符串里的字面量不算数"，不需要真语法树。
 * `gui-script.test.ts` 也在做同一类文本手术，理由相同。
 */
function codeOnly(source: string): string {
  let out = ''
  let i = 0
  while (i < source.length) {
    const char = source[i]!
    const next = source[i + 1]
    if (char === '/' && next === '/') {
      while (i < source.length && source[i] !== '\n') i++
      continue
    }
    if (char === '/' && next === '*') {
      i += 2
      while (i < source.length && !(source[i] === '*' && source[i + 1] === '/')) i++
      i += 2
      continue
    }
    if (char === '"' || char === "'" || char === '`') {
      out += char
      i++
      while (i < source.length) {
        if (source[i] === '\\') {
          out += source[i]! + (source[i + 1] ?? '')
          i += 2
          continue
        }
        out += source[i]!
        if (source[i] === char) {
          i++
          break
        }
        i++
      }
      continue
    }
    out += char
    i++
  }
  return out
}

describe('导出格式：唯一真相表', () => {
  it('**恰好是三种**：schem / litematic / obj', () => {
    // 这条断言刻意写死。加第四种格式时它会红——那是**有意的**：
    // README 的导出表、`architect --help` 的 `--format` 说明、以及这里
    // 三处都该同时更新，而不是让新格式只在某一个入口悄悄出现。
    expect(EXPORT_FORMATS.map((entry) => entry.format)).toEqual(['schem', 'litematic', 'obj'])
  })

  it('格式名与磁盘后缀不重复（否则菜单里两项会指向同一个文件）', () => {
    const formats = EXPORT_FORMATS.map((entry) => entry.format)
    const extensions = EXPORT_FORMATS.map((entry) => entry.extension)
    expect(new Set(formats).size, `格式名有重复：${formats.join(', ')}`).toBe(formats.length)
    expect(new Set(extensions).size, `后缀有重复：${extensions.join(', ')}`).toBe(extensions.length)
  })

  it('每一项都带得有对话框 filter 的文案键（菜单与对话框共用这一份）', () => {
    for (const entry of EXPORT_FORMATS) {
      expect(entry.label, `${entry.format} 没给 label`).toMatch(/^dialog\./)
    }
  })

  it('`exportFormatEntry` 取得到每一行，取不到就抛（不给调用方留非空断言）', () => {
    for (const entry of EXPORT_FORMATS) {
      expect(exportFormatEntry(entry.format)).toBe(entry)
    }
  })
})

describe('导出格式：按扩展名 / --format 辨认', () => {
  it('带后缀的路径、裸格式名、大小写混写都认得出', () => {
    expect(exportFormatOf('hut.litematic')).toBe('litematic')
    expect(exportFormatOf('hut.obj')).toBe('obj')
    expect(exportFormatOf('hut.schem')).toBe('schem')
    expect(exportFormatOf('litematic')).toBe('litematic')
    expect(exportFormatOf('OBJ')).toBe('obj')
    expect(exportFormatOf('C:\\Users\\me\\hut.LITEMATIC')).toBe('litematic')
  })

  it('认不出来退到 `.schem`（用户在另存为里手打后缀时不该让导出失败）', () => {
    expect(exportFormatOf('hut.xyz')).toBe('schem')
    expect(exportFormatOf('hut')).toBe('schem')
    // `.schematic` 不是 `.schem` 的后缀，但它属于同一族，走的也是默认值
    expect(exportFormatOf('hut.schematic')).toBe('schem')
  })
})

describe('导出格式：表里的每一种都真的导得出字节', () => {
  /**
   * 把表接到服务层上。这一段替代了"GUI 里三种格式都能选中"的验证——
   * 菜单项既然由同一张表推出，那么"表里的每一项都导得出正确后缀的文件"
   * 就是界面上每一项都可用。
   */
  it('每种格式都产出非空字节，且后缀与表一致', () => {
    const studio = new StudioService({ plain: true })
    studio.demo()
    expect(studio.state().blocks).toBeGreaterThan(0)

    for (const entry of EXPORT_FORMATS) {
      const exported = studio.exportModel(entry.format, `hut.${entry.extension}`)
      expect(exported.files.length, `${entry.format} 一个文件都没产出`).toBeGreaterThan(0)

      const first = exported.files[0]!
      expect(first.name, `${entry.format} 写出来的后缀不对`).toBe(`hut.${entry.extension}`)
      expect(first.bytes.length, `${entry.format} 产出的是空文件`).toBeGreaterThan(0)
      expect(exported.summary.length, `${entry.format} 没给摘要（界面要显示它）`).toBeGreaterThan(0)
    }
  })

  it('`.obj` 会多带一个 `.mtl`（导出的是**一组**文件，界面按组报数）', () => {
    const studio = new StudioService({ plain: true })
    studio.demo()
    const obj = studio.exportModel('obj', 'hut.obj')
    expect(obj.files.map((file) => file.name)).toEqual(['hut.obj', 'hut.mtl'])
  })

  it('空世界时三种格式给的是**同一条**错误（判据在格式分派之前，不各炸各样）', () => {
    const studio = new StudioService({ plain: true })
    const codes = EXPORT_FORMATS.map((entry) => {
      try {
        studio.exportModel(entry.format, `hut.${entry.extension}`)
      } catch (error) {
        return (error as Error & { code?: string }).code
      }
      throw new Error(`${entry.format} 在空世界上本该抛错，但没有抛`)
    })
    // 服务层的错误带**稳定的 code**（界面按它查文案），所以这里断 code 而不是断句子
    expect(new Set(codes).size, `三种格式给了不同的错误：${codes.join(', ')}`).toBe(1)
    expect(codes[0]).toBe('desktop.world.emptyExport')
  })
})

describe('导出格式：`app.tsx` 的接线不许再写死单一格式', () => {
  // 只看代码，不看注释——否则"把事故记清楚"会变成测试变红的原因（见 `codeOnly`）
  const app = codeOnly(read('app.tsx'))

  it('**把选中的格式转发下去**，不再写死成某一种', () => {
    // 这就是那次回归的原始形状：`exportModel('schem')`。
    // 工具栏那一侧（菜单真的有三项、点击真的传对格式）由 `toolbar-export.test.ts`
    // 在 jsdom 里真挂载着验；这里管的是它**下一跳**有没有把格式丢掉。
    expect(app, '导出格式又被写死了——界面会少掉其余格式').not.toMatch(/exportModel\(\s*['"]/)
    expect(app, '找不到转发选中格式的调用点').toMatch(/exportModel\(format\)/)
  })

  it('只有一处调用 exportModel（两个入口必然漂移）', () => {
    const calls = app.match(/\.exportModel\(/g) ?? []
    expect(calls.length).toBe(1)
  })
})
