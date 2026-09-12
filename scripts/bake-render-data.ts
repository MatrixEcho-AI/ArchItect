import { mkdirSync, readFileSync, existsSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { bakeBlockMap, bakeEntityModels, bakeRenderJson, canBake } from '@architect/render/bake'

/**
 * 把渲染要用的**结构数据**从 `minecraft-assets` 里烘出来，写进
 * `packages/render/data/<版本>/`。
 *
 * 为什么要有这一步（而不是运行时直接 require 那个包）：它把"发布产物里放什么"
 * 这件事变成一次显式的、可评审的动作。烘出来的只有两块：
 *
 * - `render.json`：方块状态表 + 模型表（2.3 MB，纯结构，没有素材）；
 * - `blockmap.json`：方块名 → 纹理路径的反查表 + 每种纹理的平均色（排过版，能读 diff）；
 * - `entitymodels.json`：实体模型的骨骼几何（来自 `prismarine-viewer`，同样没有素材）。
 *
 * **纹理本身不进仓库、不进安装包**：运行期从用户自己的 `.minecraft` 里读
 * （`texturepack.ts`）。这才是 §10.3 里那条"根本解法"，顺带解决素材授权。
 *
 * `--check` 只比较不写入，供 CI / 测试用（和 `docs:gen` 一个套路）。
 */
const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const check = process.argv.includes('--check')
const versions = process.argv.slice(2).filter((arg) => !arg.startsWith('--'))
const targets = versions.length > 0 ? versions : ['1.21.4']

let stale = 0
for (const version of targets) {
  if (!canBake(version)) {
    console.error(`✗ minecraft-assets 里没有版本 "${version}"（装好 devDependency 再跑）`)
    stale++
    continue
  }
  const files: Array<[string, string]> = [
    [join(root, 'packages/render/data', version, 'render.json'), bakeRenderJson(version)],
    [join(root, 'packages/render/data', version, 'blockmap.json'), bakeBlockMap(version)],
    [join(root, 'packages/render/data', version, 'entitymodels.json'), bakeEntityModels(version)],
  ]

  for (const [path, content] of files) {
    const relative = path.slice(root.length + 1)
    if (check) {
      const current = existsSync(path) ? readFileSync(path, 'utf8') : ''
      if (current !== content) {
        console.error(`✗ ${relative} 与 minecraft-assets 不一致——跑 pnpm bake:gen 重新生成`)
        stale++
      } else {
        console.log(`✓ ${relative}`)
      }
      continue
    }
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, content, 'utf8')
    console.log(`已生成 ${relative}（${(content.length / 1024).toFixed(0)} KB）`)
  }
}

if (check && stale > 0) process.exitCode = 1
