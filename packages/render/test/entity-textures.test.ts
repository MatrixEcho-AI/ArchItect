import { createRequire } from 'node:module'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'

import { loadEntityRegistry } from '@architect/core'
import { describe, expect, it } from 'vitest'

import { loadBakedEntityModels } from '../src/baked.js'
import { entityModelFor, textureForModel } from '../src/entity-models.js'

/**
 * **每个有模型的实体，最终要读的那张贴图都必须真的在资源包里。**
 *
 * 这条测试是写"打包"那条时撞出来的：模型表来自 `prismarine-viewer`，**贴图路径停在
 * 1.16 时代**（见 `entity-models.ts` 文件头）。表里 207 条贴图引用有 30 条指向
 * 1.21.4 里不存在的文件，而**失败方式是安静的**——`buildEntityAtlas` 把读不到的路径
 * 收进 `missing` 就继续跑，那个实体被画成"形状对、糊了一层兜底灰"。
 * 一只灰色的鱿鱼比一个灰盒子更难看出是坏的。
 *
 * ## 判据为什么是"有模型的实体"
 *
 * 认不出模型的实体退化成 `minecraft-data` 宽高给出的 AABB 兜底盒，那是**有意的**
 * 设计（plan §18.6、`entity-models.ts` 的规则 3），不是缺陷——所以这里不管它们。
 * 但"模型表里明明有这个模型"就不该再缺贴图：形状已经画对了，缺的只是颜色。
 *
 * 于是不变式是：**`entityModelFor` 解析出模型 ⇒ `textureForModel` 必须给出一个存在的文件**。
 * 新增实体、改上游包、改修正表都可能破坏它，三种情况都会在这里响。
 *
 * 这条测试会读 `minecraft-assets`（`@architect/render` 的运行时依赖）。
 * D-72 那条"golden 不许碰 minecraft-assets"管的是**逐字节基线**——基线的价值在于
 * 与上游解耦；这条不是基线，它恰恰要**盯住**上游，所以耦合是它的目的。
 */

const require = createRequire(import.meta.url)
const VERSION = '1.21.4'

/** `minecraft-assets` 里那个版本的资源目录（用 resolve，不加载那个 352 MB 的包）。 */
function assetsRoot(version: string): string {
  return join(dirname(require.resolve('minecraft-assets')), 'minecraft-assets', 'data', version)
}

/**
 * 贴图路径 → 磁盘上的文件。
 *
 * 与 `assetsTexturePack.read()` 的分支一一对应；这里多出来的用处是**报错时能说出
 * 路径**。前缀与目录名不总是同名（`block/` 落在 `blocks/`）。
 */
function textureFile(assets: string, path: string): string | undefined {
  if (path.startsWith('block/')) return join(assets, 'blocks', `${path.slice('block/'.length)}.png`)
  if (path.startsWith('entity/')) return join(assets, 'entity', `${path.slice('entity/'.length)}.png`)
  if (path.startsWith('item/')) return join(assets, 'items', `${path.slice('item/'.length)}.png`)
  return undefined
}

describe('实体贴图：有模型的实体都得有一张真贴图', () => {
  const models = loadBakedEntityModels(VERSION).models
  const registry = loadEntityRegistry(VERSION)
  const assets = assetsRoot(VERSION)

  it(`minecraft-assets 里有 ${VERSION} 的资源目录`, () => {
    expect(existsSync(assets), `找不到资源目录：${assets}`).toBe(true)
  })

  it('**模型里的贴图路径解析不出文件时，测试失败并列出是哪几个实体**', () => {
    const broken: string[] = []
    let withModel = 0

    for (const type of registry.names) {
      const ref = entityModelFor(type, models)
      if (ref === undefined) continue // 兜底盒是设计，不是缺陷
      withModel++
      const texture = textureForModel(ref.model, models[ref.model], ref.texture)
      if (texture === undefined) {
        broken.push(`${type} → 模型 ${ref.model}：模型表里连 default 都没有，修正表也漏了它`)
        continue
      }
      const file = textureFile(assets, texture)
      if (file === undefined || !existsSync(file)) {
        broken.push(`${type} → 模型 ${ref.model}：贴图 ${texture} 在资源包里不存在`)
      }
    }

    // 兜底：别让这条测试在"一个模型都解析不出来"时**空转通过**
    expect(withModel, '一个实体都没解析出模型，模型表多半没读到').toBeGreaterThan(50)
    expect(broken, `这些实体会被画成"形状对、贴图糊成兜底灰"：\n${broken.join('\n')}`).toEqual([])
  })
})
