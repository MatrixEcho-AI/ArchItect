import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import { createDefaultRegistry, DOC_LOCALES, DOC_PATHS } from '../src/index.js'
import { diffToolReference, renderToolReference } from '../src/docs.js'

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const references = DOC_LOCALES.map((locale) => ({ locale, path: join(root, DOC_PATHS[locale]) }))

/**
 * **工具文档不可能悄悄过期。**
 *
 * 手写的工具文档一定会漂移：改了 schema 忘了改文档，读到的人看到的是错的契约。
 * 这一条测试把两份 `docs/tool-reference*.md` 与生成结果逐字节对比——不一致就失败，
 * 并直接告诉你缺了哪个工具、多了哪个工具。
 *
 * 重新生成：`pnpm docs:gen`
 */
describe('工具参考文档与 schema 一致', () => {
  const registry = createDefaultRegistry()

  it('**磁盘上的每一份文档都与生成结果逐字节一致**', () => {
    for (const reference of references) {
      const onDisk = readFileSync(reference.path, 'utf8')
      const problems = diffToolReference(registry, onDisk, reference.locale)
      expect(
        problems,
        `${DOC_PATHS[reference.locale]} 已过期，跑 \`pnpm docs:gen\` 重新生成。\n  ${problems.join('\n  ')}`,
      ).toEqual([])
    }
  })

  it('**每个工具都在文档里出现**（新增工具忘了生成文档会在这里挂）', () => {
    const text = renderToolReference(registry)
    for (const tool of registry.list()) {
      expect(text, `文档里没有 ${tool.name}`).toContain(`## \`${tool.name}\``)
    }
  })

  it('每个工具都带上了自己的完整描述与参数表', () => {
    const text = renderToolReference(registry)
    for (const tool of registry.list()) {
      const section = text.split(`## \`${tool.name}\``)[1]
      expect(section, `${tool.name} 没有描述`).toBeDefined()
      // 描述是逐字嵌入的（它是给 LLM 的 prompt，不能有第二种版本）
      expect(section!.split('```')[1]).toContain(tool.description.split('\n')[0]!.slice(0, 40))
      const parameters = Object.keys(tool.parameters.properties ?? {})
      if (parameters.length === 0) continue
      for (const name of parameters) {
        expect(section, `${tool.name} 的参数 ${name} 不在文档里`).toContain(`\`${name}\``)
      }
    }
  })

  it('文档里没有已经删掉的工具', () => {
    const text = renderToolReference(registry)
    const documented = [...text.matchAll(/^## `([a-z_]+)`$/gm)].map((match) => match[1]!)
    const actual = new Set(registry.list().map((tool) => tool.name))
    for (const name of documented) {
      expect(actual.has(name), `文档里的 ${name} 已经不存在了`).toBe(true)
    }
  })

  it('生成的文档是确定性的（同样的注册表两次生成完全一样）', () => {
    expect(renderToolReference(registry)).toBe(renderToolReference(registry))
  })

  it('生成的文档不带时间戳一类会每跑一次就变的东西', () => {
    const text = renderToolReference(registry)
    expect(text).not.toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:/)
    expect(text).not.toContain(new Date().getFullYear().toString())
  })
})
