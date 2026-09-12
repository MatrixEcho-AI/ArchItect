/**
 * 世界网格化：把 `WorldStore` 喂给 vendored 的 prismarine mesher。
 *
 * 这一层只做两件事，但两件都必须做对：
 *
 * 1. **适配 `getBlock`**。vendored mesher 要的不是"一个方块 id"，而是一个
 *    `prismarine-block` 对象——它读 `name` / `isCube` / `transparent` / `material` /
 *    `getProperties()` / `biome.name` / `position`。少任何一个字段都不会报错，
 *    而是**渲染出错误的东西**（`isCube` 缺失 → 邻居剔除全部失效 → 墙里露出一堆内表面）。
 *    这份适配是照着 `prismarine-viewer/viewer/lib/world.js` 的 `getBlock` 写的。
 * 2. **按 16³ 切段**并回填世界坐标。mesher 的顶点是"以段中心为原点"的，
 *    必须加上 `段原点 + 8` 才是世界坐标；忘了平移会得到 8 张重叠的图。
 *
 * 一次性开销（图集、方块状态预解析、着色表）按版本缓存——`prepareBlocksStates`
 * 会**原地改写** `minecraft-assets` 返回的对象，重复调用会把已经解析好的模型
 * 再解析一遍，所以这里用 `Map` 保证每个版本只做一次。
 */

import type { WorldStore } from '@architect/core'
import mcDataModule from 'minecraft-data'
import BlockModule from 'prismarine-block'
import { Vec3 } from 'vec3'

import { buildTextureAtlas } from './atlas.js'
import type { TextureAtlas } from './atlas.js'
import { loadBakedRenderData } from './baked.js'
import type { TexturePack } from './texturepack.js'
import { configureTints, getSectionGeometry } from './vendor/prismarine/models.js'
import { prepareBlocksStates } from './vendor/prismarine/modelsBuilder.js'
import type { MesherBlock, MesherWorld } from './vendor/prismarine/models.js'

/** 段边长。mesher 的循环与 AO 采样都按这个粒度写死。 */
const SECTION = 16

/**
 * 我们世界的"生物群系"：平原。
 *
 * `.mcai` 里**没有生物群系数据**——工区是一个人为划定的盒子，不是自然地形。
 * 而草、树叶、水在游戏里的颜色**是生物群系染色的**（`tintindex` 的面按群系取色），
 * 所以必须挑一个。选平原是因为它对这三类方块都是"最常见的那个颜色"。
 *
 * ⚠️ **不能按 id 硬编码**。1.21.4 里 `biomes[1]` 是 `bamboo_jungle` 而不是平原
 * （`prismarine-viewer` 的 `biomeCache[1]` 兜底在 1.16 时代是对的，到 1.21 就错了——
 * 症状是水变成黑绿色）。所以按**名字**查 id。
 */
const BIOME_NAME = 'plains'

interface VersionData {
  atlas: TextureAtlas
  blocksStates: Record<string, unknown>
}

const versionCache = new Map<string, VersionData>()

/**
 * 加载（并缓存）一个版本渲染所需的全部静态数据。
 *
 * 两半分别来自不同的地方：
 *
 * - **结构**（方块状态表、模型表）：仓库里烘好的 `data/<版本>/render.json`（`bake.ts` 的产出）。
 *   它们是纯结构数据，占 2.3 MB，没有素材授权问题。
 * - **纹理**：`pack` 给的（用户的 `.minecraft` / 资源包，或者烘好的平均色）。
 *   我们**不分发** Mojang 的纹理——见 `texturepack.ts` 的说明。
 *
 * 缓存键里必须带来源：换了资源包还命中旧图集的话，"换资源包没反应"会变成一个
 * 只在第二次运行时出现的 bug。
 */
export function loadRenderData(minecraftVersion: string, pack: TexturePack): VersionData {
  const cacheKey = `${minecraftVersion}|${pack.id}`
  const cached = versionCache.get(cacheKey)
  if (cached !== undefined) return cached

  // 着色表按**渲染版本**注入，而不是上游写死的 1.16.2
  configureTints(minecraftVersion)

  const baked = loadBakedRenderData(minecraftVersion)
  const atlas = buildTextureAtlas(minecraftVersion, pack)
  // `prepareBlocksStates` 要的是 `{json: {size, textures}}` 形状（prismarine atlas.json 的格式），
  // 而且会做两件有副作用的事：**原地改写**状态表，并把纹理名解析成**这张图集里的矩形**。
  //
  // 所以两件事都必须做对：
  // 1. 先**深拷贝**一份再交给它——否则第二次用不同的资源包加载时，`v.model` 已经是个
  //    解析好的对象了，再解析一遍会直接抛 `name.startsWith is not a function`；
  // 2. 每个 (版本, 资源包) 组合都要重新 prepare——图集换了，UV 矩形就换了。
  const blocksStates = prepareBlocksStates(
    {
      blocksStates: structuredClone(baked.blocksStates),
      blocksModels: structuredClone(baked.blocksModels),
    } as never,
    { json: { size: 1 / (atlas.size / 16), textures: atlas.textures } } as never,
  )

  const data: VersionData = { atlas, blocksStates }
  versionCache.set(cacheKey, data)
  return data
}

/**
 * 工具函数：形状是不是**完整立方体**。
 *
 * 与 `prismarine-viewer/viewer/lib/world.js` 的 `isCube` 逐字一致——
 * 判据是"只有一个盒，且这个盒正好是 [0,0,0,1,1,1]"。用"包围盒体积等于 1"
 * 之类的近似会漏掉台阶（它的两个盒合起来也是满体积，但中间那级是看得见的，
 * 不能用来剔除邻居的面）。
 */
function isCube(shapes: ReadonlyArray<readonly number[]> | undefined): boolean {
  if (shapes === undefined || shapes.length !== 1) return false
  const shape = shapes[0]!
  return (
    shape[0] === 0 &&
    shape[1] === 0 &&
    shape[2] === 0 &&
    shape[3] === 1 &&
    shape[4] === 1 &&
    shape[5] === 1
  )
}

/**
 * 把一个 `WorldStore` 包成 mesher 要的世界视图。
 *
 * 两个容易踩的点：
 *
 * - **`position` 必须设**。mesher 会读 `neighbor.position.y < 0` 来剔除世界底面，
 *   `prismarine-block` 默认 `position = null`，不设就是 `Cannot read properties of null`。
 * - **方块实例按 stateId 复用**（`prismarine-viewer` 同款做法）。一个 32³ 的工区
 *   有 3 万格，而 AO 每格要查十几次邻居；每查一次就 new 一个 Block 会让渲染慢一个量级。
 *   代价是**同一个实例的 `position` 会被反复改写**——只要在 mesher 内部同步用完即可，
 *   不要把返回的对象存起来。
 */
export function createWorldView(store: WorldStore): MesherWorld {
  const version = store.registry.minecraftVersion
  const BlockCtor = blockLoader(version)
  const biome = biomeOf(version)
  const cache = new Map<number, MesherBlock>()

  const view: MesherWorld = {
    getBlock: (pos) => {
      const stateId = store.getBlockStateId({ x: pos.x, y: pos.y, z: pos.z })
      let block = cache.get(stateId)
      if (block === undefined) {
        const created = BlockCtor.fromStateId(stateId, biome.id) as unknown as MesherBlock & {
          shapes?: ReadonlyArray<readonly number[]>
        }
        created.isCube = isCube(created.shapes)
        block = created
        cache.set(stateId, block)
      }
      // `prismarine-block` 的 biome 是 `new Biome(biomeId)`——**没有数据时 `.name` 是
      // undefined**，而 mesher 用 `block.biome.name` 去查着色表，拿 undefined 查会
      // 静默落到"默认色"（1.21.4 里那个默认值是 0 = 纯黑）。所以每次覆盖成真对象。
      block.biome = biome
      block.position = new Vec3(pos.x, pos.y, pos.z)
      return block
    },
  }
  return view
}

interface BiomeInfo {
  id: number
  name: string
}

const biomeCache = new Map<string, BiomeInfo>()

/** 按名字取生物群系——**不要按 id 硬编码**，见 `BIOME_NAME` 的说明。 */
function biomeOf(version: string): BiomeInfo {
  let found = biomeCache.get(version)
  if (found === undefined) {
    const mc = mcDataLoader(version) as unknown as {
      biomesByName: Record<string, BiomeInfo | undefined>
      biomes: Record<number, BiomeInfo | undefined>
    }
    found = mc.biomesByName[BIOME_NAME] ?? mc.biomes[1] ?? { id: 1, name: BIOME_NAME }
    biomeCache.set(version, found)
  }
  return found
}

/** 合并后的三角形汤，**已经是世界坐标**。 */
export interface WorldGeometry {
  positions: Float32Array
  normals: Float32Array
  /** 逐顶点颜色 = AO × 生物群系着色。方向明暗由光栅器叠加。 */
  colors: Float32Array
  uvs: Float32Array
  indices: Uint32Array
  /** 顶点数 = positions.length / 3。 */
  vertices: number
  /**
   * **逐三角形**的材质序号（长度 = 三角形数）。缺省全是 0 = 方块图集。
   *
   * 为什么需要它：实体贴图与方块贴图**不在同一张图集里**，尺寸也不同。
   * 光栅器的"不透明 / 半透明"判据是"取重心 UV → tile 序号 → 查表"，而两个图集
   * 的 tile 网格不一样——没有这个字段的话，实体三角形会被拿去查方块那张表，
   * 判据变成随机。
   */
  materials?: Uint8Array
}

/**
 * 把**所有含方块的段**网格化。
 *
 * 这里曾经是按 `store.volume` 三重循环扫的——那时世界有一个小的、声明的工区。
 * 现在没有可写边界了（X/Z 想建多远建多远），那条路走不通：扫一个巨大的声明范围
 * 会把时间全花在空白上，而扫原来的 32³ 又会漏掉界外新建的东西。
 *
 * 所以改成**由"哪些段真的有方块"驱动**（`WorldStore.forEachPopulatedSection`）。
 * 工作量只与非空范围成正比，与坐标长到多大无关。
 *
 * 只需遍历非空段本身，**不需要再往外扩一圈**：mesher 是按世界坐标去读邻居的
 * （`store.getBlockStateId`，跨段没问题），所以段边界的面剔除与 AO 本来就是对的，
 * 而"只有邻居段里有方块"的那些面由邻居段自己产出（它也在非空段列表里）。
 */
export function meshWorld(store: WorldStore, data: VersionData): WorldGeometry {
  const chunks: WorldGeometry[] = []
  let vertices = 0
  let indices = 0

  // 段基坐标按 16 对齐去重：`populatedSections` 里存的是"含方块的段"，
  // 同一个段只会出现一次，但对齐这一步仍然要做——键是按世界坐标 `>> 4` 算的，
  // 回调回来的是段基坐标，两者必须对齐到同一个格子才不会重复网格化（重复 = z-fighting）。
  const pending = new Map<string, { sx: number; sy: number; sz: number }>()
  store.forEachPopulatedSection((sx, sy, sz) => {
    const ax = floor16(sx)
    const ay = floor16(sy)
    const az = floor16(sz)
    pending.set(`${ax},${ay},${az}`, { sx: ax, sy: ay, sz: az })
  })

  for (const { sx, sy, sz } of pending.values()) {
    const view = createWorldView(store)
    const g = getSectionGeometry(sx, sy, sz, view, data.blocksStates)
    const count = g.positions.length / 3
    if (count === 0) continue

    // mesher 的顶点以段中心为原点，`sx + 8` 才是它对应的世界偏移
    const ox = sx + SECTION / 2
    const oy = sy + SECTION / 2
    const oz = sz + SECTION / 2
    const positions = new Float32Array(count * 3)
    for (let i = 0; i < count; i++) {
      positions[i * 3] = g.positions[i * 3]! + ox
      positions[i * 3 + 1] = g.positions[i * 3 + 1]! + oy
      positions[i * 3 + 2] = g.positions[i * 3 + 2]! + oz
    }

    chunks.push({
      positions,
      normals: g.normals,
      colors: g.colors,
      uvs: g.uvs,
      indices: Uint32Array.from(g.indices),
      vertices: count,
    })
    vertices += count
    indices += g.indices.length
  }

  return concat(chunks, vertices, indices)
}

function floor16(value: number): number {
  return Math.floor(value / SECTION) * SECTION
}

function concat(chunks: WorldGeometry[], vertices: number, indices: number): WorldGeometry {
  const positions = new Float32Array(vertices * 3)
  const normals = new Float32Array(vertices * 3)
  const colors = new Float32Array(vertices * 3)
  const uvs = new Float32Array(vertices * 2)
  const out = new Uint32Array(indices)
  let vertexAt = 0
  let indexAt = 0
  for (const chunk of chunks) {
    positions.set(chunk.positions, vertexAt * 3)
    normals.set(chunk.normals, vertexAt * 3)
    colors.set(chunk.colors, vertexAt * 3)
    uvs.set(chunk.uvs, vertexAt * 2)
    for (let i = 0; i < chunk.indices.length; i++) out[indexAt + i] = chunk.indices[i]! + vertexAt
    vertexAt += chunk.vertices
    indexAt += chunk.indices.length
  }
  return { positions, normals, colors, uvs, indices: out, vertices }
}

// ── 依赖注入 ─────────────────────────────────────────────────────────────────
//
// `prismarine-block` 与 `minecraft-assets` 都是 CJS，且类型声明覆盖不全。
// 这里集中窄化一次，免得业务代码里到处写 `as unknown as`。

interface BlockFactory {
  fromStateId: (stateId: number, biomeId: number) => MesherBlock
}

const mcDataLoader = mcDataModule as unknown as (version: string) => unknown

const blockFactories = new Map<string, BlockFactory>()

function blockLoader(version: string): BlockFactory {
  let factory = blockFactories.get(version)
  if (factory === undefined) {
    factory = (BlockModule as unknown as (v: string) => BlockFactory)(version)
    blockFactories.set(version, factory)
  }
  return factory
}

/**
 * 把几段几何拼成一段，并给每段标上**材质序号**。
 *
 * 方块与实体不在同一张图集里，而 `WorldGeometry` 是一份三角形汤——没有材质位的话，
 * 光栅器只能拿实体三角形的 UV 去查方块那张 tile 表，判据会变成随机。
 * 空的段会被跳过，全段材质都是 0 时**不写 `materials`**（省一次分配，
 * 也让既有路径拿到的对象形状与以前完全一样）。
 */
export function concatGeometry(
  parts: ReadonlyArray<{ geometry: WorldGeometry; material: number }>,
): WorldGeometry {
  const kept = parts.filter((part) => part.geometry.vertices > 0)
  if (kept.length === 0) {
    return {
      positions: new Float32Array(0),
      normals: new Float32Array(0),
      colors: new Float32Array(0),
      uvs: new Float32Array(0),
      indices: new Uint32Array(0),
      vertices: 0,
    }
  }
  if (kept.length === 1 && kept[0]!.material === 0) return kept[0]!.geometry

  let vertices = 0
  let indexCount = 0
  for (const part of kept) {
    vertices += part.geometry.vertices
    indexCount += part.geometry.indices.length
  }

  const positions = new Float32Array(vertices * 3)
  const normals = new Float32Array(vertices * 3)
  const colors = new Float32Array(vertices * 3)
  const uvs = new Float32Array(vertices * 2)
  const indices = new Uint32Array(indexCount)
  const materials = new Uint8Array(indexCount / 3)

  let vertexBase = 0
  let indexBase = 0
  let triangleBase = 0
  for (const part of kept) {
    const { geometry } = part
    positions.set(geometry.positions, vertexBase * 3)
    normals.set(geometry.normals, vertexBase * 3)
    colors.set(geometry.colors, vertexBase * 3)
    uvs.set(geometry.uvs, vertexBase * 2)
    for (let i = 0; i < geometry.indices.length; i++) {
      indices[indexBase + i] = geometry.indices[i]! + vertexBase
    }
    const triangles = geometry.indices.length / 3
    materials.fill(part.material, triangleBase, triangleBase + triangles)
    vertexBase += geometry.vertices
    indexBase += geometry.indices.length
    triangleBase += triangles
  }

  return { positions, normals, colors, uvs, indices, vertices, materials }
}
