/**
 * **纹理来源**：一套方块纹理从哪儿来。
 *
 * 这是"不内置素材"那条决策（§10.3）的落地点。以前纹理唯一来源是
 * `minecraft-assets` 这个 npm 包——它把每个版本的整套资源包都装进了包里
 * （实测 65 275 个文件、asar 592 MB），而这是**美术资源**：既不该我们分发，
 * 也不该让用户为了几 MB 纹理下载几百 MB。
 *
 * 来源有四种，都能塞进同一个接口：
 *
 * 1. **内置资源包**（`assets.ts`）：默认。装完就有真实纹理，不需要先装 Minecraft；
 * 2. 用户指定的资源包目录 / zip / 客户端 jar（换成自己的材质包）；
 * 3. 用户的 `.minecraft` 里那个版本的客户端 jar（自动探测）；
 * 4. **烘好的平均色**（`bake.ts` 的产出）——形状、UV、明暗全都在，只是每格一块纯色。
 *    它是最兜底的一级：既没内置资源、也没有用户的包时，画面仍然**不会**退化成
 *    "满屏洋红棋盘格"。
 *
 * 三条路都实现同一个 `TexturePack` 接口，所以 mesher / 图集 / 颜色解析
 * 完全不需要知道自己在读哪种来源。
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { unzipSync } from 'fflate'

import { loadBakedBlockMap } from './baked.js'
import { Canvas, encodePng } from './canvas.js'

/** 资源包里方块纹理所在的相对目录（1.13 之后是 `block/`，之前是 `blocks/`）。 */
const BLOCK_DIRS = ['block', 'blocks'] as const
/** 物品纹理目录，颜色解析时偶而会用到（`pink_petals` 这类）。 */
const ITEM_DIRS = ['item', 'items'] as const
/**
 * 实体纹理目录。与方块不同，它**带子目录**（`entity/boat/oak`、`entity/cow/cow`），
 * 所以读侧要能走嵌套路径，目录来源也要递归。
 */
const ENTITY_DIR = 'entity'
/** 图集只用方块纹理。 */
const TILE_SIZE = 16

export interface TexturePack {
  /** 稳定标识，含来源与参数——用来当图集/mesher 的缓存键。 */
  readonly id: string
  /** 来源种类，界面据此选文案（本字段不是译文）。 */
  readonly kind: 'assets' | 'minecraft' | 'pack' | 'baked' | 'none'
  /** 给人看的具体位置（路径、版本号）。界面把它填进 i18n 模板。 */
  readonly detail: string
  /**
   * 按资源包相对路径读一张纹理的 PNG 字节，例如 `block/stone`。
   * 不带扩展名；找不到返回 `undefined`（调用方据此画缺失纹理）。
   */
  read(path: string): Uint8Array | undefined
  /** 全部方块纹理的**裸名**（`block/` 下的文件名去扩展名），升序。 */
  blockTiles(): readonly string[]
}

/**
 * 内存里的资源包：路径（不带扩展名）→ 字节。
 *
 * 字节是**懒读**的：目录来源下，1.21.4 有 1000 多张 PNG，全读一遍要几百毫秒，
 * 而一次渲染通常只用到其中几十张。`load` 返回 `undefined` 表示这张读不出来。
 */
class MapTexturePack implements TexturePack {
  constructor(
    readonly id: string,
    readonly kind: TexturePack['kind'],
    readonly detail: string,
    private readonly entries: ReadonlyMap<string, () => Uint8Array | undefined>,
    private readonly tiles: readonly string[],
    private readonly cache = new Map<string, Uint8Array>(),
  ) {}

  read(path: string): Uint8Array | undefined {
    const normalized = path.replace(/^minecraft:/, '')
    const candidates = [normalized]
    const bare = normalized.includes('/') ? normalized.slice(normalized.indexOf('/') + 1) : normalized
    for (const dir of BLOCK_DIRS) candidates.push(`${dir}/${bare}`)
    for (const dir of ITEM_DIRS) candidates.push(`${dir}/${bare}`)

    for (const candidate of candidates) {
      const cached = this.cache.get(candidate)
      if (cached !== undefined) return cached
      const load = this.entries.get(candidate)
      if (load === undefined) continue
      const bytes = load()
      if (bytes === undefined) continue
      this.cache.set(candidate, bytes)
      return bytes
    }
    return undefined
  }

  blockTiles(): readonly string[] {
    return this.tiles
  }
}

/** 什么都不给：调用方只能用颜色。图集会是空的，mesher 会退化成纯色。 */
export function emptyTexturePack(): TexturePack {
  return new MapTexturePack('none', 'none', '', new Map(), [])
}

/**
 * 把一个 zip（客户端 jar 或资源包 zip）解成资源包。
 *
 * `kind` 只影响界面怎么称呼它（"你的 Minecraft" vs "你指定的资源包"），
 * 读取逻辑完全一样——客户端 jar 本来就是一个大资源包。
 */
export function zipTexturePack(path: string, kind: 'minecraft' | 'pack' = 'pack'): TexturePack {
  const archive = unzipSync(readFileSync(path), {
    // 只解压纹理：客户端 jar 里 90% 是 class 与其它资源，全解开要几百毫秒、上百 MB。
    filter: (file) => file.name.includes('/textures/') && file.name.endsWith('.png'),
  })

  const entries = new Map<string, () => Uint8Array>()
  for (const [name, bytes] of Object.entries(archive)) {
    const relative = packRelativePath(name)
    if (relative !== undefined) entries.set(relative, () => bytes)
  }

  return new MapTexturePack(`zip:${path}`, kind, path, entries, blockTilesOf(entries.keys()))
}

/** 把一个解包后的目录（资源包根目录，或直接是 `textures/block`）解成资源包。 */
export function directoryTexturePack(root: string): TexturePack {
  const dirs = textureRoots(root)
  const entries = new Map<string, () => Uint8Array>()
  for (const [dir, kind] of dirs) {
    // 实体纹理**带子目录**（`entity/boat/oak`），其余是平铺的
    for (const file of walkPng(dir, kind === ENTITY_DIR)) {
      const name = file.slice(0, -'.png'.length)
      const relative = `${kind}/${name}`
      if (!entries.has(relative)) {
        entries.set(relative, () => readFileSync(join(dir, file)))
      }
    }
  }

  return new MapTexturePack(`dir:${root}`, 'pack', root, entries, blockTilesOf(entries.keys()))
}/** `assets/minecraft/textures/block/stone.png` → `block/stone`；不是纹理就 `undefined`。 */
function packRelativePath(name: string): string | undefined {
  // 先试实体：它允许嵌套（`textures/entity/boat/oak.png` → `entity/boat/oak`）
  const entity = /(?:^|\/)textures\/entity\/(.+)\.png$/.exec(name)
  if (entity !== null) return `${ENTITY_DIR}/${entity[1]!}`

  const match = /(?:^|\/)textures\/([^/]+)\/([^/]+)\.png$/.exec(name)
  if (match === null) return undefined
  const folder = match[1]!
  const file = match[2]!
  if ((BLOCK_DIRS as readonly string[]).includes(folder)) return `block/${file}`
  if ((ITEM_DIRS as readonly string[]).includes(folder)) return `item/${file}`
  return undefined
}

/** 目录来源里，找到所有装着纹理的目录，并标注它们属于哪一类。 */
function textureRoots(root: string): Array<[string, 'block' | 'item' | 'entity']> {
  const found: Array<[string, 'block' | 'item' | 'entity']> = []
  for (const [dirs, kind] of [
    [BLOCK_DIRS, 'block'],
    [ITEM_DIRS, 'item'],
  ] as const) {
    for (const dir of dirs) {
      const candidate = join(root, 'assets', 'minecraft', 'textures', dir)
      if (isDirectory(candidate)) found.push([candidate, kind])
    }
    // 也接受"直接把 textures/block 递给我"的用法（调试时最省事）
    for (const dir of dirs) {
      const direct = join(root, dir)
      if (isDirectory(direct) && !found.some(([existing]) => existing === direct)) {
        found.push([direct, kind])
      }
    }
  }
  // 实体纹理目录（递归遍历交给收集器，这里只报目录）
  const entityDir = join(root, 'assets', 'minecraft', 'textures', ENTITY_DIR)
  if (isDirectory(entityDir)) found.push([entityDir, ENTITY_DIR])
  // 最后兜底：目录本身就是一堆 PNG
  if (found.length === 0 && isDirectory(root) && hasPng(root)) found.push([root, 'block'])
  return found
}

/** 目录下的 PNG 文件名（`recursive` 时给出相对子路径，如 `boat/oak.png`），升序。 */
function walkPng(dir: string, recursive = false): string[] {
  const out: string[] = []
  const visit = (current: string, prefix: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (recursive) visit(join(current, entry.name), `${prefix}${entry.name}/`)
        continue
      }
      if (entry.name.endsWith('.png')) out.push(`${prefix}${entry.name}`)
    }
  }
  try {
    visit(dir, '')
  } catch {
    return []
  }
  return out.sort()
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

function hasPng(dir: string): boolean {
  try {
    return readdirSync(dir).some((file) => file.endsWith('.png'))
  } catch {
    return false
  }
}

function blockTilesOf(keys: Iterable<string>): readonly string[] {
  const tiles: string[] = []
  for (const key of keys) {
    if (key.startsWith('block/')) tiles.push(key.slice('block/'.length))
  }
  return tiles.sort()
}

/**
 * **烘好的平均色**当成纹理用：每个纹理路径生成一张 16×16 的纯色 PNG。
 *
 * 这是"机器上根本没有 Minecraft"时的观感兜底。为什么不做成"没有纹理就画纯色"
 * 的另一条渲染路径：那会让 mesher、three.js 视口、软件光栅器各自长出一套
 * "没有图集时怎么办"的分支，而它们本来只需要一份图集。**让来源永远是资源包**
 * 这条约束，把复杂度关进了这一个类里。
 */
export function bakedColorTexturePack(version: string): TexturePack {
  const map = loadBakedBlockMap(version)
  // tile → 颜色：把"方块 → 纹理路径"翻过来，同一张纹理被多个方块引用时（`oak_fence`
  // → `block/oak_planks`）先到先得；键是排过序的，所以跨机器一致。
  const colors = new Map<string, readonly number[]>()
  for (const block of Object.keys(map.textures).sort()) {
    const path = map.textures[block]!
    const color = map.colors[block]
    if (color === undefined) continue
    const name = path.slice(path.indexOf('/') + 1)
    if (!colors.has(name)) colors.set(name, color)
  }

  /**
   * tile 清单**直接来自烘焙文件**（= 资源包 blocks 目录的文件清单），不是从方块反推的。
   * 差这一点会漏掉模型引用但不属于任何方块的纹理，然后在 mesher 里炸成一句
   * `"undefined" is not valid JSON`——那是症状，不是原因。
   */
  const tiles = [...map.tiles].sort()
  const pngCache = new Map<string, Uint8Array>()

  return {
    id: `baked:${version}`,
    kind: 'baked',
    detail: version,
    blockTiles: () => tiles,
    read(path: string): Uint8Array | undefined {
      if (!path.startsWith('block/')) return undefined
      const name = path.slice('block/'.length)
      const cached = pngCache.get(name)
      if (cached !== undefined) return cached
      // 找不到对应方块就给中性灰（见 colors.ts 的 UNKNOWN_APPEARANCE 注释：
      // 灰色诚实地表达"我们不知道它的真实样貌"）
      const color = colors.get(name) ?? [150, 150, 150, 255]
      const canvas = new Canvas(TILE_SIZE, TILE_SIZE, {
        r: color[0] ?? 0,
        g: color[1] ?? 0,
        b: color[2] ?? 0,
      })
      // 平均色自带 alpha（0..255，玻璃 ≈ 64），带过去玻璃才还是玻璃。
      const alpha = Math.max(0, Math.min(255, Math.round(color[3] ?? 255)))
      if (alpha < 255) {
        for (let i = 0; i < TILE_SIZE * TILE_SIZE; i++) canvas.data[i * 4 + 3] = alpha
      }
      const png = encodePng(canvas)
      pngCache.set(name, png)
      return png
    },
  }
}

/** 一个用户可能把 Minecraft 装在哪儿。返回**存在**的那些，按优先级。 */
export function minecraftDirCandidates(env: NodeJS.ProcessEnv = process.env): string[] {
  const candidates: string[] = []
  const override = env['ARCHITECT_MINECRAFT_DIR']
  if (typeof override === 'string' && override.length > 0) candidates.push(override)

  const home = env['HOME'] ?? homedir()
  if (process.platform === 'darwin') {
    candidates.push(join(home, 'Library', 'Application Support', 'minecraft'))
  } else if (process.platform === 'win32') {
    const appData = env['APPDATA']
    if (typeof appData === 'string' && appData.length > 0) candidates.push(join(appData, '.minecraft'))
    candidates.push(join(home, 'AppData', 'Roaming', '.minecraft'))
  } else {
    candidates.push(join(home, '.minecraft'))
    const xdg = env['XDG_DATA_HOME']
    if (typeof xdg === 'string' && xdg.length > 0) candidates.push(join(xdg, 'minecraft'))
    candidates.push(join(home, '.var', 'app', 'com.mojang.Minecraft', '.minecraft'))
  }
  return candidates.filter((path) => isDirectory(path))
}

/** 自动探测：第一个存在的 `.minecraft`。 */
export function detectMinecraftDir(env: NodeJS.ProcessEnv = process.env): string | undefined {
  return minecraftDirCandidates(env)[0]
}

/**
 * 在 `.minecraft` 里找某个版本的客户端 jar。
 *
 * 先按标准布局找 `versions/<版本>/<版本>.jar`；找不到就扫一遍 `versions/`，
 * 挑目录名**以该版本开头**的（快照版本目录名更长，如 `1.21.4-pre1`）。
 * 再找不到就返回 `undefined`——这时调用方会退回平均色，而不是猜一个 jar 出来。
 */
export function findClientJar(minecraftDir: string, version: string): string | undefined {
  const exact = join(minecraftDir, 'versions', version, `${version}.jar`)
  if (existsSync(exact)) return exact

  const versionsDir = join(minecraftDir, 'versions')
  if (!isDirectory(versionsDir)) return undefined
  const names = readdirSync(versionsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.startsWith(version))
    .map((entry) => entry.name)
    .sort()
  for (const name of names) {
    const jar = join(versionsDir, name, `${name}.jar`)
    if (existsSync(jar)) return jar
  }
  return undefined
}

/** 打开一个 `.minecraft` 目录里对应版本的资源包。找不到 jar 就 `undefined`。 */
export function minecraftTexturePack(minecraftDir: string, version: string): TexturePack | undefined {
  const jar = findClientJar(minecraftDir, version)
  if (jar === undefined) return undefined
  const pack = zipTexturePack(jar, 'minecraft')
  return pack.blockTiles().length > 0 ? pack : undefined
}

/** 用户给的一个路径：目录 → 资源包目录，文件 → zip/jar。 */
export function texturePackAt(path: string): TexturePack | undefined {
  if (isDirectory(path)) {
    const pack = directoryTexturePack(path)
    return pack.blockTiles().length > 0 ? pack : undefined
  }
  if (existsSync(path) && /\.(zip|jar)$/i.test(path)) {
    const pack = zipTexturePack(path)
    return pack.blockTiles().length > 0 ? pack : undefined
  }
  return undefined
}

export type TextureSourceSpec =
  /** 自动：探测 `.minecraft`，找不到就用平均色。 */
  | { kind: 'auto' }
  /** 指定 `.minecraft` 目录（不填则自动探测）。 */
  | { kind: 'minecraft'; dir?: string }
  /** 指定资源包目录 / zip / 客户端 jar。 */
  | { kind: 'pack'; path: string }
  /** 只用烘好的平均色。 */
  | { kind: 'baked' }

/** 界面/日志里显示"现在用的是哪种来源"时用的**种类**（不是译文）。 */
export interface ResolvedTexturePack {
  pack: TexturePack
  /** 用户要的来源没找到时，这里说明为什么退了（界面拿它翻译成一句提示）。 */
  fellBackFrom?: 'minecraft' | 'pack'
}

/**
 * 按设置解析出真正要用的资源包。
 *
 * **永远返回一个包**（最差是平均色）。渲染管线里没有"没有纹理"这个状态，
 * 否则每条路径都要多一个分支（见 `bakedColorTexturePack` 的注释）。
 */
export function resolveTexturePack(
  spec: TextureSourceSpec,
  version: string,
  env: NodeJS.ProcessEnv = process.env,
): ResolvedTexturePack {
  const baked = () => bakedColorTexturePack(version)

  switch (spec.kind) {
    case 'baked':
      return { pack: baked() }
    case 'pack': {
      const pack = texturePackAt(spec.path)
      if (pack !== undefined) return { pack }
      return { pack: baked(), fellBackFrom: 'pack' }
    }
    case 'minecraft': {
      const dir = spec.dir ?? detectMinecraftDir(env)
      if (dir !== undefined) {
        const pack = minecraftTexturePack(dir, version)
        if (pack !== undefined) return { pack }
      }
      return { pack: baked(), fellBackFrom: 'minecraft' }
    }
    case 'auto': {
      const dir = detectMinecraftDir(env)
      if (dir !== undefined) {
        const pack = minecraftTexturePack(dir, version)
        if (pack !== undefined) return { pack }
      }
      return { pack: baked() }
    }
  }
}

/** 把规格描述成一行，供设置界面回显（不含译文）。 */
export function describeTextureSpec(spec: TextureSourceSpec): string {
  switch (spec.kind) {
    case 'auto':
      return 'auto'
    case 'baked':
      return 'baked'
    case 'minecraft':
      return spec.dir ?? 'auto'
    case 'pack':
      return spec.path
  }
}
