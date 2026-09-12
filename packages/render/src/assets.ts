/**
 * **内置资源包**：直接把 `minecraft-assets` 那个 npm 包当成纹理来源。
 *
 * 这是默认来源：用户装完就能看到真实纹理，不需要先装一份 Minecraft、也不需要
 * 去设置里指路径。代价是包里要多背一份资源（见 plan §10.3 的实测数字）——
 * 这是个**有意的取舍**：纹理开箱即用 > 安装包小。
 *
 * 想换自己的材质包（或者在没有装这个依赖的环境里跑）走 `texturepack.ts` 里
 * 那几种来源：`.minecraft` 的客户端 jar、资源包目录、烘好的平均色。
 *
 * 单独一个模块入口（而不是塞进 `index.ts`）的理由是打包：`index.ts` 是主进程
 * 会整个打进去的入口，而 `minecraft-assets` 是一个 352 MB 的包——它是 desktop 的
 * **运行时依赖**，esbuild 必须把它标成 external（`require` 而不是打进来），
 * 所以只能在明确知道自己在干什么的地方引它。
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

import assetsModule from 'minecraft-assets'

import type { TexturePack } from './texturepack.js'

interface Assets {
  directory?: string
}

/**
 * `minecraft-assets` 里那个版本的方块纹理目录，当成一个资源包。
 *
 * 目录布局是 `data/<版本>/blocks/*.png`（不是资源包的
 * `assets/minecraft/textures/block/`），所以这里自己拼一个 `TexturePack`，
 * 而不是复用 `directoryTexturePack`。
 */
export function assetsTexturePack(minecraftVersion: string): TexturePack {
  const load = assetsModule as unknown as (version: string) => Assets | null
  const assets = load(minecraftVersion)
  const directory = assets?.directory
  if (typeof directory !== 'string') {
    throw new Error(`minecraft-assets 没有版本 "${minecraftVersion}" 的资源包目录`)
  }
  const blockDir = join(directory, 'blocks')
  const entityDir = join(directory, 'entity')
  const itemDir = join(directory, 'items')
  // 与 `buildTextureAtlas` 一样要排序：文件系统给的顺序不同会让 UV 索引漂移
  const tiles = readdirSync(blockDir)
    .filter((file) => file.endsWith('.png'))
    .map((file) => file.slice(0, -'.png'.length))
    .sort()

  return {
    id: `assets:${minecraftVersion}:${directory}`,
    kind: 'assets',
    detail: directory,
    blockTiles: () => tiles,
    read(path: string): Uint8Array | undefined {
      // 三个前缀沿用**资源包**的写法（`block/` / `item/`），因为那是 `TexturePack`
      // 对外统一的命名空间；落到这个来源上时目录名可能不一样（`block/` → `blocks/`、
      // `item/` → `items/`），映射只发生在这里。路径都可以带子目录：
      // `block/oak_planks`、`entity/boat/oak`、`item/splash_potion`。
      //
      // `item/` 这一支不是给"画个物品"用的——是**烟花火箭与药水**那两个实体：
      // 1.21.4 里它们没有自己的实体贴图，原版画的就是物品图标
      // （见 `entity-models.ts` 的 `MODEL_TEXTURE`）。不收这一支的话它们会被
      // 画成"形状对、贴图糊成兜底灰"，而不是报错。
      const file = path.startsWith('block/')
        ? join(blockDir, `${path.slice('block/'.length)}.png`)
        : path.startsWith('entity/')
          ? join(entityDir, `${path.slice('entity/'.length)}.png`)
          : path.startsWith('item/')
            ? join(itemDir, `${path.slice('item/'.length)}.png`)
            : undefined
      if (file === undefined) return undefined
      // 懒读：一次渲染通常只用几十张纹理，1000 多张全读一遍要几百毫秒
      try {
        return existsSync(file) ? readFileSync(file) : undefined
      } catch {
        return undefined
      }
    },
  }
}
