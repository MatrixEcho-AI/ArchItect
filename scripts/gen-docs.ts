import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { createDefaultRegistry, DOC_LOCALES, DOC_PATHS, renderToolReference } from '@architect/tools'

/**
 * 生成文档。
 *
 * **只生成"能从代码推出来"的那部分**——工具参考的参数表来自 JSON Schema。
 * 只有散文能说清的语义（坐标口径、半径定义、格式的坑）留在 `plan.md` 的附录里，
 * 这里是单向引用，不抄第二份。
 *
 * `--check` 只比较不写入，供 CI / 测试用。
 */
const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const check = process.argv.includes('--check')

const registry = createDefaultRegistry()
// 一种语言一份。工具描述（正文）两种语言里都是英文——它是给 LLM 的 prompt；
// 只有外壳文案跟语言走，所以两份放两个文件，而不是把同一段正文抄两遍。
const targets: Array<{ path: string; content: string }> = DOC_LOCALES.map((locale) => ({
  path: join(root, DOC_PATHS[locale]),
  content: renderToolReference(registry, locale),
}))

let stale = 0
for (const target of targets) {
  const relative = target.path.slice(root.length + 1)
  if (check) {
    const { readFileSync, existsSync } = await import('node:fs')
    const current = existsSync(target.path) ? readFileSync(target.path, 'utf8') : ''
    if (current !== target.content) {
      console.error(`✗ ${relative} 与代码不一致——跑 pnpm docs:gen 重新生成`)
      stale++
    } else {
      console.log(`✓ ${relative}`)
    }
    continue
  }
  mkdirSync(dirname(target.path), { recursive: true })
  writeFileSync(target.path, target.content, 'utf8')
  console.log(`已生成 ${relative}（${target.content.split('\n').length} 行）`)
}

if (check && stale > 0) process.exitCode = 1
