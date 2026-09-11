import { copyFile, mkdir, readFile, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { build, context } from 'esbuild'

/** 脚本所在目录。所有路径都从它算起，**与 cwd 无关**。 */
const here = dirname(fileURLToPath(import.meta.url))

/**
 * 必须是 `external` 的包：**本包 package.json 里声明过的运行时依赖**。
 *
 * 不 external 的话 `minecraft-data`（上百 MB）和 `minecraft-assets`（352 MB）
 * 会被整个塞进 bundle —— 实测产物 486 MB，esbuild 直接报"字符串太长"。
 * 这两个包在主进程里 require 是完全没问题的，没必要打包。
 *
 * 判据必须是"**本包的**直接依赖"而不是"看起来像第三方"：pnpm 的隔离 node_modules
 * 下，`@architect/interop` 的传递依赖（如 `prismarine-nbt`）不在 desktop 的
 * 解析路径上，标成 external 会在启动时抛 `Cannot find module`。
 * 所以：直接依赖 → external；其余（workspace 自己人 + 传递依赖）→ 一律打进来。
 */
const pkg = JSON.parse(await readFile(join(here, 'package.json'), 'utf8'))
const EXTERNAL = new Set(Object.keys(pkg.dependencies ?? {}))

/**
 * 例外：必须**打进来**而不是 external 的包。
 *
 * `i18next` 是 `@architect/i18n` 的依赖、也是渲染进程要用的——
 * external 会在页面里留下一个 `require('i18next')`，直接 ReferenceError。
 * `prismarine-nbt`（及它拖来的 `protodef` 等）同理：它们是 interop 的传递依赖，
 * pnpm 下 desktop require 不到，而且打进来能让主进程 bundle 自洽、
 * 打包时不必再往 app 里塞 node_modules。
 */
// `three` 必须打进来：渲染进程那份 bundle 跑在浏览器里，external 会留下
// 一个 `require('three')`，页面里直接 ReferenceError。主进程不用它，但
// 一份 esbuild 配置管三个 target，打进来最省事（three 只进 renderer 的产物）。
const BUNDLED = ['i18next', 'prismarine-nbt', 'three', 'fflate']

/** Node 侧（主进程 / 预加载）的解析规则。 */
const nodeExternal = {
  name: 'node-external',
  setup(build) {
    build.onResolve({ filter: /^[^./]/ }, (args) => {
      // 相对/绝对路径交给 esbuild 正常处理
      if (args.path.startsWith('@architect/')) return null
      const bare = args.path.startsWith('@')
        ? args.path.split('/').slice(0, 2).join('/')
        : args.path.split('/')[0]
      if (BUNDLED.includes(bare)) return null
      if (EXTERNAL.has(bare)) return { path: args.path, external: true }
      // 没声明过的（传递依赖）也打进来：external 在 pnpm 下必然 require 不到
      return null
    })
  },
}

/**
 * 浏览器侧（渲染进程）：只 external `electron` 与 `node:` 内建，其余**一律打进来**。
 *
 * 这条判据与 Node 侧**必须不同**，而且不能复用上面那张"直接依赖表"：
 * `react` / `react-dom` / `antd` 现在是本包的直接依赖，按 Node 侧那条判据会被标成
 * `external`，于是产物里留下一个 `require('react')`——页面里直接 ReferenceError。
 *
 * 判据的实质是**运行环境**而不是包的类型：主进程有 node_modules 可 require，
 * 浏览器没有，所以浏览器侧的答案永远是"全都打进来"。早先一份插件管三个 target、
 * 靠一张 `BUNDLED` 白名单把 `three` 挑出来；接 antd 时这个做法立刻就不够用了
 * （白名单会越写越长，而"漏一个"的症状是页面白屏）。
 */
const browserBundleOnly = {
  name: 'browser-bundle-only',
  setup(build) {
    build.onResolve({ filter: /^[^./]/ }, (args) => {
      if (args.path === 'electron' || args.path.startsWith('node:')) {
        return { path: args.path, external: true }
      }
      return null
    })
  },
}

const shared = {
  bundle: true,
  sourcemap: true,
  logLevel: 'warning',
  // 一律用绝对路径：这样 `node apps/desktop/esbuild.mjs` 从仓库根跑也不会把
  // 入口找成 `./src/...` 然后 ENOENT（cwd 与脚本目录是两回事）
  absWorkingDir: here,
}

/** React 的自动 JSX 运行时（省掉每份文件顶上的 `import React`）。 */
const jsx = { jsx: 'automatic' }

const target = (entry, outfile, extra = {}) => ({
  entryPoints: [join(here, entry)],
  outfile: join(here, outfile),
  ...extra,
})

const targets = [
  {
    ...target('src/main/index.ts', 'dist/main.cjs'),
    platform: 'node',
    format: 'cjs',
    external: ['electron'],
    plugins: [nodeExternal],
  },
  {
    ...target('src/preload/index.ts', 'dist/preload.cjs'),
    platform: 'node',
    format: 'cjs',
    external: ['electron'],
    plugins: [nodeExternal],
  },
  {
    ...target('src/renderer/main.tsx', 'dist/renderer/main.js'),
    platform: 'browser',
    format: 'iife',
    ...jsx,
    plugins: [browserBundleOnly],
  },
]

await rm(join(here, 'dist'), { recursive: true, force: true })
await mkdir(join(here, 'dist/renderer'), { recursive: true })
await copyFile(join(here, 'src/renderer/index.html'), join(here, 'dist/renderer/index.html'))
// style.css 不再单独拷贝：它由 `src/renderer/main.tsx` import，esbuild 打进 main.js
// （外加 antd 的 reset.css）。两份 CSS 一份产物，就不会出现"改了 CSS 忘了拷"。

const watch = process.argv.includes('--watch')
if (watch) {
  const contexts = await Promise.all(targets.map((t) => context({ ...shared, ...t })))
  await Promise.all(contexts.map((c) => c.watch()))
  console.log('esbuild 监听中…')
} else {
  await Promise.all(targets.map((t) => build({ ...shared, ...t })))
  console.log('构建完成')
}
