import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import { FORMAT_VERSION, PATHS } from '../src/manifest.js'

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const spec = readFileSync(join(root, 'docs', 'mcai-format.md'), 'utf8')

/**
 * **格式规范不能与代码脱节。**
 *
 * 完全生成一份格式规范不现实（大部分内容是"为什么这样定"），但**可以从代码里
 * 机械核对的那部分必须核对**：路径常量、格式版本、字段名。这一条测试就是干这个的——
 * 改了 `PATHS` 或加了 manifest 字段却忘了改规范，会在这里失败。
 */
describe('格式规范与代码一致', () => {
  it('**每个路径常量都在规范里出现**', () => {
    for (const [key, path] of Object.entries(PATHS)) {
      expect(spec, `规范里没有 ${key}（${path}）`).toContain(path)
    }
  })

  it('规范里写的格式版本与代码一致', () => {
    expect(spec).toContain(`**格式版本 \`${FORMAT_VERSION}\`**`)
  })

  it('manifest 的每个顶层字段名都在规范里', () => {
    const source = readFileSync(join(root, 'packages/mcai/src/manifest.ts'), 'utf8')
    const block = /export interface Manifest \{([\s\S]*?)\n\}/.exec(source)?.[1]
    expect(block, '找不到 Manifest 接口定义').toBeDefined()
    const fields = [...block!.matchAll(/^\s{2}([a-zA-Z]+)[?]?:/gm)].map((match) => match[1]!)
    expect(fields.length).toBeGreaterThan(8)
    for (const field of fields) {
      expect(spec, `规范里没有 manifest.${field}`).toContain(field)
    }
  })

  it('规范说清了三条读方容忍度（附件缺失、未知条目保留、索引不一致只报告）', () => {
    expect(spec).toContain('未知条目原样保留')
    expect(spec).toContain('附件缺失不算损坏')
    expect(spec).toContain('只报告，不阻断')
  })

  it('规范里不出现任何密钥字段名（红线：`.mcai` 绝不存密钥）', () => {
    expect(spec).toContain('绝不存密钥')
    expect(spec).not.toMatch(/"?apiKey"?\s*[:=]\s*"/)
  })

  it('规范提到的快照魔数与代码一致', () => {
    const snapshot = readFileSync(join(root, 'packages/mcai/src/snapshot.ts'), 'utf8')
    const magic = /MAGIC = \[([^\]]+)\]/.exec(snapshot)?.[1]
    if (magic === undefined) throw new Error('没能从 packages/mcai/src/snapshot.ts 里解析出 MAGIC')
    const text = magic
      .split(',')
      .map((part) => String.fromCharCode(Number(part.trim())))
      .join('')
      .replace(/\0/g, '\\0')
    // 规范里写的是可读形式（\0 用反斜杠零表示）。比对的是**从代码里解出来的**那一串，
    // 不是写死的字面量——写死的话，改快照魔数这条测试照样绿，等于没守。
    expect(spec, 'docs/mcai-format.md 里的快照魔数与 snapshot.ts 不一致').toContain(text)
  })
})
