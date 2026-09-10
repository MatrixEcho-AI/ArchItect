import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import { createDefaultRegistry } from '@architect/tools'

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const readme = readFileSync(join(root, 'README.md'), 'utf8')
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
  scripts: Record<string, string>
}

/**
 * **README 不能说过期的话。**
 *
 * README 是唯一一份"新用户会照着敲"的文档，它写错一条命令，用户就卡在那里。
 * 这里机械核对能核对的部分：提到的 `pnpm <script>` 必须真的存在，
 * 提到的文档路径必须真的在，说的工具数量必须与注册表一致。
 */
describe('README 与仓库实际状态一致', () => {
  it('**提到的每一个 pnpm 脚本都真的存在**', () => {
    const scripts = new Set(Object.keys(pkg.scripts))
    const workspaceScripts = new Set(
      Object.keys(
        (JSON.parse(readFileSync(join(root, 'apps/desktop/package.json'), 'utf8')) as { scripts: Record<string, string> })
          .scripts,
      ),
    )

    // 根脚本：`pnpm <script>`（排除 `--filter` 这类选项）
    const rootMentioned = [...readme.matchAll(/pnpm (?!-)([a-z0-9:_-]+)/g)].map((match) => match[1]!)
    expect(rootMentioned.length).toBeGreaterThan(5)
    for (const script of rootMentioned) {
      if (script === 'install') continue // 内置命令
      expect(scripts.has(script), `README 提到的 pnpm ${script} 不存在`).toBe(true)
    }

    // 工作区内脚本：`--filter @architect/<pkg> <script>`
    for (const match of readme.matchAll(/--filter (@architect\/[a-z]+) ([a-z0-9:_-]+)/g)) {
      const [, pkgName, script] = match as unknown as [string, string, string]
      expect(pkgName).toBe('@architect/desktop') // 目前只提了桌面端
      expect(workspaceScripts.has(script), `README 提到的 ${pkgName} 的 ${script} 脚本不存在`).toBe(true)
    }
  })

  it('**提到的每一个文档路径都真的存在**', () => {
    const { existsSync } = require('node:fs') as typeof import('node:fs')
    const links = [...readme.matchAll(/\]\(([^)]+\.md)\)/g)].map((match) => match[1]!)
    expect(links.length).toBeGreaterThan(3)
    for (const link of links) {
      expect(existsSync(join(root, link)), `README 指向的 ${link} 不存在`).toBe(true)
    }
  })

  it('**说的工具数量与注册表一致**（加了工具忘了改 README 会在这里挂）', () => {
    const count = createDefaultRegistry().list().length
    expect(readme).toContain(`${count} 个 LLM 工具`)
    expect(readme).toContain(`${count} 个工具的完整参考`)
  })

  it('README 不出现任何密钥的样式', () => {
    // `sk-...` 只允许作为占位出现一次（那个示例是给用户看的）
    const matches = [...readme.matchAll(/sk-[A-Za-z0-9]{8,}/g)]
    expect(matches).toEqual([])
  })
})
