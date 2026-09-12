/**
 * 读取**烘好的渲染元数据**（见 `bake.ts`）。
 *
 * 这些文件随仓库提交（`data/<版本>/*.json`），因为它是由一个 devDependency
 * 生成、且必须在没有 `node_modules` 的产物里也能读到的**运行时数据**。
 * `pnpm bake:check` 会在它过期时失败，所以"提交生成物"在这里是安全的。
 *
 * 路径要同时覆盖三种跑法：vitest/tsx（相对本文件）、打包后的 Electron
 * （electron-builder 的 `extraResources` 放到 `resources/data`）、以及
 * 老实的 `cwd` 兜底。任何一个都不该是唯一路径——打包后路径错了
 * 会表现成"纹理全没了"，而那是本项目最贵的一类 bug（见 §10.3）。
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * 烘焙文件的格式版本。加字段时 +1，加载器据此拒绝读不懂的文件。
 *
 * 这个常量放在**读侧**而不是 `bake.ts`（写侧）：`bake.ts` 会 `import 'minecraft-assets'`，
 * 而 `baked.ts` 是主进程运行时要打进去的模块。让读侧依赖写侧，会把 352 MB 的
 * 资源包顺着一条 import 边拖进 bundle（实测产物 65 MB 的 `main.cjs`）。
 */
export const BAKED_FORMAT = 1

/** 结构数据：方块状态表 + 模型表。 */
export interface BakedRenderData {
  format: number
  version: string
  blocksStates: Record<string, unknown>
  blocksModels: Record<string, unknown>
}

/** 反查表：方块名 → 纹理路径；以及每种纹理的平均色。 */
export interface BakedBlockMap {
  format: number
  version: string
  /** 图集要哪些 tile（资源包 `blocks/` 目录的文件清单，升序）。 */
  tiles: readonly string[]
  /** 方块名 → 纹理路径（`block/oak_planks`）。 */
  textures: Record<string, string>
  /** 每种纹理路径的平均色 `[r, g, b, a]`（a 是 0..255）。 */
  colors: Record<string, readonly number[]>
}

/**
 * 实体模型表（从 `prismarine-viewer` 烘出来的 94 个模型）。
 *
 * 只有**几何与贴图名**，没有贴图字节——贴图和方块一样走 `TexturePack`，
 * 我们不分发素材。
 */
export interface BakedEntityModels {
  format: number
  version: string
  /** 模型键（`boat` / `minecraft`…）→ `{ identifier, textures, geometry }`。 */
  models: Record<string, unknown>
}

/**
 * 本模块所在目录；**两种模块格式都要能算出来**。
 *
 * ⚠️ 不能直接写 `fileURLToPath(import.meta.url)`：桌面端主进程是 esbuild 打成 **CJS**
 * 的（`dist/main.cjs`），esbuild 会把 `import.meta` 抹成 `{}`——于是
 * `import.meta.url` 是 `undefined`，`fileURLToPath(undefined)` 在**模块加载期**就抛
 * `ERR_INVALID_ARG_TYPE`，整个主进程起不来（打包版表现为一个"启动即报错"的对话框，
 * 而 `--smoke` 连一行日志都打不出来）。这个坑真踩过一次。
 *
 * 所以：ESM（tsx / vitest）走 `import.meta.url`，CJS（esbuild 产物）走 `__dirname`，
 * 两个都拿不到就返回 `undefined`（候选列表里少一项，而不是整个进程崩掉）。
 */
function moduleDir(): string | undefined {
  const url = (import.meta as { url?: string }).url
  if (typeof url === 'string' && url.length > 0) return dirname(fileURLToPath(url))
  if (typeof __dirname === 'string' && __dirname.length > 0) return __dirname
  return undefined
}

/**
 * 数据根目录的候选列表，**按优先级**。
 *
 * 第一个存在的胜出。把它导出是为了让测试能断言"打包后的路径也在候选里"，
 * 以及出问题时能打印出到底找过哪儿。
 */
export function bakedDataRoots(): string[] {
  const roots: string[] = []
  const override = globalThis.process?.env?.['ARCHITECT_DATA_DIR']
  if (typeof override === 'string' && override.length > 0) roots.push(override)
  const here = moduleDir()
  if (here !== undefined) {
    // 源码旁边（vitest / tsx / pnpm architect）：packages/render/src → packages/render/data
    roots.push(join(here, '..', 'data'))
    // 桌面端的 esbuild 产物：apps/desktop/dist → 仓库根的 packages/render/data
    // （这条让开发时的 dev 运行不依赖 cwd）
    roots.push(join(here, '..', '..', '..', 'packages', 'render', 'data'))
  }
  // 打包后：electron-builder 把 packages/render/data 拷到 resources/data
  const resources = (globalThis.process as { resourcesPath?: string } | undefined)?.resourcesPath
  if (typeof resources === 'string' && resources.length > 0) roots.push(join(resources, 'data'))
  // 从仓库根跑起来的兜底
  roots.push(join(globalThis.process?.cwd?.() ?? '.', 'packages', 'render', 'data'))
  return roots
}

export function bakedDataRoot(): string {
  const roots = bakedDataRoots()
  for (const root of roots) {
    if (existsSync(root)) return root
  }
  throw new Error(
    `找不到烘好的渲染数据目录。找过这些位置：\n  ${roots.join('\n  ')}\n` +
      '开发时跑 `pnpm bake:gen` 生成；打包时确认 electron-builder 的 extraResources 里有 packages/render/data。',
  )
}

/** 仓库里烘了哪些版本（数据目录下的子目录名，升序）。 */
export function bakedVersions(): string[] {
  const root = bakedDataRoot()
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .filter((entry) => existsSync(join(root, entry.name, 'render.json')))
    .map((entry) => entry.name)
    .sort()
}

function readJson<T extends { format: number }>(version: string, file: string): T {
  const path = join(bakedDataRoot(), version, file)
  if (!existsSync(path)) {
    throw new Error(`没有版本 "${version}" 的 ${file}（找的是 ${path}）——跑 pnpm bake:gen`)
  }
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as T
  if (parsed.format !== BAKED_FORMAT) {
    throw new Error(
      `${path} 的格式版本是 ${parsed.format}，本代码只认 ${BAKED_FORMAT}——跑 pnpm bake:gen 重新生成`,
    )
  }
  return parsed
}

/**
 * 缓存。
 *
 * `prepareBlocksStates` 会**原地改写**结构数据（把模型解析进状态里），
 * 所以同一份数据必须只加载一次、只交给 mesher 一份。缓存同时保证了
 * "同一版本拿到同一个对象"这个廉价判据。
 */
const RENDER_CACHE = new Map<string, BakedRenderData>()
const BLOCKMAP_CACHE = new Map<string, BakedBlockMap>()
const ENTITY_CACHE = new Map<string, BakedEntityModels>()

export function loadBakedRenderData(version: string): BakedRenderData {
  const cached = RENDER_CACHE.get(version)
  if (cached !== undefined) return cached
  const data = readJson<BakedRenderData>(version, 'render.json')
  RENDER_CACHE.set(version, data)
  return data
}

export function loadBakedBlockMap(version: string): BakedBlockMap {
  const cached = BLOCKMAP_CACHE.get(version)
  if (cached !== undefined) return cached
  const map = readJson<BakedBlockMap>(version, 'blockmap.json')
  BLOCKMAP_CACHE.set(version, map)
  return map
}

export function loadBakedEntityModels(version: string): BakedEntityModels {
  const cached = ENTITY_CACHE.get(version)
  if (cached !== undefined) return cached
  const models = readJson<BakedEntityModels>(version, 'entitymodels.json')
  ENTITY_CACHE.set(version, models)
  return models
}

/** 测试用：清掉缓存，好让"第一次加载"的路径每次都能被走到。 */
export function clearBakedCache(): void {
  RENDER_CACHE.clear()
  BLOCKMAP_CACHE.clear()
  ENTITY_CACHE.clear()
}
