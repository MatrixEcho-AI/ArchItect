import type { BakedEntityModels } from './baked.js'

/**
 * 实体类型 → 模型表里的键与贴图路径。
 *
 * ## 为什么需要一张手写的表
 *
 * 烘出来的模型表来自 `prismarine-viewer`，**实体名是 1.16 时代的旧写法**：
 * 里面只有 `boat`，没有 `oak_boat`；而 `minecraft-data` 1.21.4 给的名字是
 * `oak_boat` / `spruce_boat` / …。两边的命名空间对不上，中间必须有一层映射。
 *
 * ## 规则
 *
 * 1. **同名即直通**：绝大多数生物在两边同名（`cow`、`zombie`、`armor_stand`…），
 *    直接查表即可，不写进下面那张表。
 * 2. **只有"改名"和"变体"才显式列出来**，主要就是那十种船。
 * 3. **两边都没有的（展示框、画、chest_boat 之外的 1.21 新生物）不走这里**——
 *    渲染侧退化成 `minecraft-data` 宽高给出的 AABB 兜底盒，而不是消失。
 *    那比"猜一个形状"诚实，也比"什么都不画"有用。
 */

export interface EntityModelRef {
  /** `entitymodels.json` 里的模型键。 */
  model: string
  /**
   * 贴图路径，**相对资源包的 `textures/`、不带扩展名**（`entity/boat/oak`）。
   *
   * 省略表示用模型自带的 `textures.default`。显式给路径是为了那些"模型对、
   * 但模型表的变体里没有"的情况——模型表只收了 6 种船的贴图，而资源包里
   * 1.21.4 有 10 种（mangrove / cherry / bamboo / pale_oak 都在）。
   */
  texture?: string
}

/** 模型表里带船贴图变体的木种（键名是旧的 `darkoak`，路径是 `dark_oak`）。 */
const BOAT_WOODS = [
  'oak',
  'spruce',
  'birch',
  'jungle',
  'acacia',
  'dark_oak',
  'mangrove',
  'cherry',
  'bamboo',
  'pale_oak',
] as const

const EXPLICIT: Record<string, EntityModelRef> = {}

for (const wood of BOAT_WOODS) {
  // 船模型只有一个 `boat`，木种全在贴图上。`_chest_boat` 也映射到它：
  // 模型表里没有带箱子的船，画成船（少一个箱子）比画成一个方盒子接近得多，
  // 而这件事写在 README 的已知差异里，不是猜。
  EXPLICIT[`${wood}_boat`] = { model: 'boat', texture: `entity/boat/${wood}` }
  EXPLICIT[`${wood}_chest_boat`] = { model: 'boat', texture: `entity/boat/${wood}` }
}
// 筏子走船的模型与竹贴图：形状上是同一类东西
EXPLICIT['bamboo_raft'] = { model: 'boat', texture: 'entity/boat/bamboo' }
EXPLICIT['bamboo_chest_raft'] = { model: 'boat', texture: 'entity/boat/bamboo' }
// 流浪商人的羊驼与普通羊驼共用模型
EXPLICIT['trader_llama'] = { model: 'llama' }

/** 去掉命名空间。 */
const bare = (entityType: string): string => entityType.replace(/^minecraft:/, '')

/**
 * 找一个实体该用哪个模型。**认不出时返回 `undefined`**，由调用方退化成兜底盒。
 *
 * `models` 是烘出来的那张表——传进来而不是在这里 import，是因为
 * `entity-models.ts` 要能在浏览器（three.js 视口）里用，而读烘出来的数据
 * 那条路会 `import 'node:fs'`（见 `baked.ts` 的说明）。
 */
export function entityModelFor(
  entityType: string,
  models: BakedEntityModels['models'],
): EntityModelRef | undefined {
  const name = bare(entityType)
  const explicit = EXPLICIT[name]
  if (explicit !== undefined) return explicit
  if (models[name] !== undefined) return { model: name }
  return undefined
}

/**
 * 模型自带的默认贴图路径。
 *
 * 模型表里的值是 `textures/entity/cow/cow` 这种写法（相对资源包根），
 * 而 `TexturePack.read` 收的是相对 `textures/` 的路径（`entity/cow/cow`）。
 *
 * 这里做两层翻译，都把上游的写法换成 `TexturePack` 那个**资源包命名空间**的写法：
 * ① 去掉 `textures/` 前缀；② 物品贴图上游写作复数的 `items/`（那是
 * minecraft-assets 的目录名），而资源包里是单数的 `item/`。
 * 目录名与命名空间不一致这件事只在 `assetsTexturePack` 那一层还原
 * （`block/` → `blocks/` 同理），所以这里给出的一律是命名空间的写法。
 */
export function defaultTextureOf(model: unknown, variant?: string): string | undefined {
  const textures = (model as { textures?: Record<string, string> } | undefined)?.textures
  if (textures === undefined) return undefined
  const value = (variant !== undefined ? textures[variant] : undefined) ?? textures['default']
  if (typeof value !== 'string' || value.length === 0) return undefined
  return value.replace(/^textures\//, '').replace(/^items\//, 'item/')
}

/**
 * 模型表里**默认贴图缺失或路径过时**的模型 → 1.21.4 里真正该画的那张。
 *
 * ## 为什么必须有一张手写的修正表
 *
 * 上游表是 `prismarine-viewer` 的，**实体贴图路径停在 1.16 时代**（见文件头的说明）。
 * 1.21.4 把好几类挪进了子目录，于是表里的值指向一个不存在的文件。两条后果都是
 * **安静的**：`buildEntityAtlas` 把读不到的路径收进 `missing` 就继续跑，那个实体
 * 于是被画成"形状对、糊了一层兜底灰"——比兜底盒更难看出是坏的。
 *
 * 三类修正，每一类都在这里写明理由：
 *
 * 1. **路径挪窝**：`entity/squid` → `entity/squid/squid`（1.17 起生物各自一个目录）、
 *    `entity/arrow` → `entity/projectiles/arrow`、`entity/steve` →
 *    `entity/player/wide/steve`。
 * 2. **改画物品贴图**：烟花火箭与药水在 1.21.4 没有自己的实体贴图，
 *    原版画的就是物品图标（`item/firework_rocket`、`item/splash_potion`）。
 * 3. **变体模型没有 `default`**：猫、马、羊驼、村民、兔子、鹦鹉、狐狸、豹猫、
 *    潜影贝、热带鱼这些在表里**只列了变体贴图**（`white`/`black`/`brown`…），
 *    取 `textures.default` 得到 `undefined`，于是整只生物退化成 AABB 盒子。
 *    这里给每个挑一个原版最常见的变体：**形状是真的，只有花纹是"某一种"**——
 *    比一个灰盒子接近得多，而且这件事写在 README 的已知差异里。
 */
const MODEL_TEXTURE: Readonly<Record<string, string>> = {
  // ── 1. 路径挪窝 ──
  squid: 'entity/squid/squid',
  arrow: 'entity/projectiles/arrow',
  player: 'entity/player/wide/steve',
  // ── 2. 原版画的是物品贴图 ──
  firework_rocket: 'item/firework_rocket',
  potion: 'item/splash_potion',
  // ── 3. 只有变体贴图，没有 default ──
  cat: 'entity/cat/white',
  ocelot: 'entity/cat/ocelot',
  horse: 'entity/horse/horse_brown',
  donkey: 'entity/horse/donkey',
  mule: 'entity/horse/mule',
  skeleton_horse: 'entity/horse/horse_skeleton',
  zombie_horse: 'entity/horse/horse_zombie',
  llama: 'entity/llama/creamy',
  villager: 'entity/villager/type/plains',
  zombie_villager: 'entity/zombie_villager/zombie_villager',
  rabbit: 'entity/rabbit/brown',
  parrot: 'entity/parrot/parrot_red_blue',
  fox: 'entity/fox/fox',
  shulker: 'entity/shulker/shulker_purple',
  tropical_fish: 'entity/fish/tropical_a',
}

/**
 * 一个实体**最终要读的那张贴图**。
 *
 * 优先级：显式指定（船的木种那样，模型对但贴图得挑）> 修正表 > 模型自带的 `default`。
 * 修正表排在 `default` 之前是刻意的：那张 `default` 正是"过时或缺失"的定义。
 */
export function textureForModel(
  modelKey: string,
  model: unknown,
  explicit?: string,
): string | undefined {
  if (explicit !== undefined) return explicit
  return MODEL_TEXTURE[modelKey] ?? defaultTextureOf(model)
}

