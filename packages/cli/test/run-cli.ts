/**
 * 用 tsx 跑 CLI 入口的小工具（e2e 与 i18n 测试共用）。
 *
 * 原来这里走的是 `npx --no-install tsx …`，在 Windows 上必挂：
 * `npx` 实际是批处理文件 `npx.cmd`，而 Node 从 CVE-2024-27980 的修补
 * （18.20.2 / 20.12.2 起）就不允许不加 `shell: true` 直接执行 .cmd/.bat，
 * `execFile('npx', …)` 会直接抛 ENOENT（实测报错就是 `spawnSync npx ENOENT`）。
 *
 * 改成拿当前这个 node 去跑 tsx 自己的 JS 入口：三个平台行为一致，
 * 也顺便不再依赖 npx 能不能在仓库根解析到 tsx——根目录并没有装它，
 * tsx 是 packages/cli 的 devDependency（根 node_modules/.bin 里没有 tsx）。
 */
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'

const require = createRequire(import.meta.url)

const tsxPackagePath = require.resolve('tsx/package.json')
const tsxPackage = JSON.parse(readFileSync(tsxPackagePath, 'utf8')) as {
  bin: string | Record<string, string>
}

/** tsx 的 CLI 入口：用 `node <TSX_CLI> script.ts …` 的方式跑。 */
export const TSX_CLI = join(
  dirname(tsxPackagePath),
  typeof tsxPackage.bin === 'string' ? tsxPackage.bin : tsxPackage.bin['tsx']!,
)
