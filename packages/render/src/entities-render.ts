import { loadEntityRegistry } from '@architect/core'
import type { WorldStore } from '@architect/core'

import type { TextureAtlas } from './atlas-format.js'
import { loadBakedEntityModels } from './baked.js'
import { buildEntityAtlas, ENTITY_FALLBACK_TEXTURE } from './entity-atlas.js'
import { defaultTextureOf, entityModelFor } from './entity-models.js'
import { meshEntity, meshFallbackBox } from './entitymesher.js'
import type { EntityMeshOptions, RawEntityModel } from './entitymesher.js'
import { concatGeometry } from './mesher.js'
import type { WorldGeometry } from './mesher.js'
import type { TexturePack } from './texturepack.js'

/**
 * **世界里的实体 → 几何 + 一张实体图集。**
 *
 * 与方块那条路分开的理由：方块的图集只与版本和资源包有关（可以按
 * `版本|资源包` 缓存），而**实体图集取决于这个世界里有哪些实体**——只有船的场景
 * 只需要两张船的贴图，没必要为全部 94 个模型建一张 16 MB 的图集。
 * 所以这一步跟着世界走，不跟着版本走。
 */

export interface EntityRenderResult {
  /** 实体三角形。材质位是 1（方块是 0），见 `concatGeometry`。 */
  geometry: WorldGeometry
  atlas: TextureAtlas
  /** 读不到或解不开的贴图路径，如实报出来。 */
  missing: string[]
  /** 用兜底盒画的实体类型（模型表里没有它们）。 */
  fallbackTypes: string[]
  /**
   * **逐三角形**的所有者：这个三角形属于 `store.entities.list()` 里的第几个实体。
   *
   * 几何是一份三角形汤，没有身份信息，而"点到的是哪条船"必须能回答——拾取
   * （`pickEntity`）与左栏选中都靠它。下标的基准就是 `list()` 的顺序（按 id 排序）。
   */
  owners: Int32Array
}

/**
 * 世界里的实体一律走这里；**世界里没有实体时返回 `undefined`**，调用方据此
 * 完全跳过这一段（既省一次图集构建，也让既有渲染路径的对象形状不变）。
 */
export function meshWorldEntities(
  store: WorldStore,
  pack: TexturePack,
): EntityRenderResult | undefined {
  const entities = store.entities.list()
  if (entities.length === 0) return undefined

  const version = store.registry.minecraftVersion
  const models = loadBakedEntityModels(version).models
  const registry = loadEntityRegistry(version)

  /** 每个实体要用哪张贴图；`undefined` 的那条走兜底盒。 */
  const plan = entities.map((entity) => {
    const ref = entityModelFor(entity.type, models)
    if (ref === undefined) return { entity, model: undefined, texture: ENTITY_FALLBACK_TEXTURE }
    const model = models[ref.model] as RawEntityModel | undefined
    const texture = ref.texture ?? defaultTextureOf(model)
    if (model === undefined || texture === undefined) {
      return { entity, model: undefined, texture: ENTITY_FALLBACK_TEXTURE }
    }
    return { entity, model, texture }
  })

  const { atlas, missing } = buildEntityAtlas(
    pack,
    plan.map((entry) => entry.texture),
  )

  const fallbackTypes = new Set<string>()
  const meshed = plan.map((entry) => {
    const options: EntityMeshOptions = {
      x: entry.entity.x,
      y: entry.entity.y,
      z: entry.entity.z,
      yaw: entry.entity.yaw,
      ...(entry.entity.pitch !== undefined ? { pitch: entry.entity.pitch } : {}),
      atlas: atlas.textures[entry.texture] ?? atlas.textures[ENTITY_FALLBACK_TEXTURE]!,
    }
    if (entry.model !== undefined) return meshEntity(entry.model, options)
    fallbackTypes.add(entry.entity.type)
    // 兜底盒的尺寸来自 `minecraft-data`（它有每种实体的宽高）——"大概多大"
    // 比"什么都不画"有用得多，而比"猜一个形状"诚实
    return meshFallbackBox(registry.sizeOf(entry.entity.type) ?? { width: 0.6, height: 1.8 }, options)
  })

  const owners = new Int32Array(meshed.reduce((sum, geometry) => sum + geometry.indices.length / 3, 0))
  let triangleBase = 0
  for (let i = 0; i < meshed.length; i++) {
    const triangles = meshed[i]!.indices.length / 3
    owners.fill(i, triangleBase, triangleBase + triangles)
    triangleBase += triangles
  }

  return {
    geometry: concatGeometry(meshed.map((geometry) => ({ geometry, material: 1 }))),
    atlas,
    missing,
    fallbackTypes: [...fallbackTypes].sort(),
    owners,
  }
}
