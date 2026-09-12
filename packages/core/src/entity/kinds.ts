/**
 * 方块 → 它挂着的**方块实体类型**。
 *
 * ## 为什么这张表必须自己维护
 *
 * `minecraft-data` 1.21.4 **不提供**这个信息：`blocksByName[*].entity` 全空
 * （实测 0 命中）。所以只能自己写。
 *
 * ## 为什么表外的方块一律**拒绝**，而不是猜一个 id
 *
 * 方块实体的类型**不等于方块名**：`oak_sign` 方块的方块实体是 `minecraft:sign`、
 * `white_banner` 是 `minecraft:banner`、`player_head` 是 `minecraft:skull`。
 * 猜一个 id 的两种后果都很难查：写得不对时游戏把整个方块实体丢掉（"方块在、
 * 附加数据没了"），而导出到 `.schem` 的文件看起来完全正常。拒绝至少是说得清的。
 *
 * ## 覆盖范围
 *
 * 这是**我们建模的那个子集**，不是全部。规则能生成的（木种前缀、颜色前缀）就生成，
 * 其余逐个列。要加新方块就往这里加一条——加错了会在导入导出往返测试里露出来。
 */

/** 有独立木种的方块（`oak_sign` / `crimson_hanging_sign` …）。 */
const WOODS = [
  'oak',
  'spruce',
  'birch',
  'jungle',
  'acacia',
  'dark_oak',
  'mangrove',
  'cherry',
  'bamboo',
  'crimson',
  'warped',
  'pale_oak',
] as const

/** 16 种染料色（旗帜、潜影盒）。 */
const COLORS = [
  'white',
  'orange',
  'magenta',
  'light_blue',
  'yellow',
  'lime',
  'pink',
  'gray',
  'light_gray',
  'cyan',
  'purple',
  'blue',
  'brown',
  'green',
  'red',
  'black',
] as const

const KINDS: Record<string, string> = {
  // 容器
  chest: 'minecraft:chest',
  // 陷阱箱的方块实体 id 就是 `minecraft:chest`，不是 `minecraft:trapped_chest`
  trapped_chest: 'minecraft:chest',
  barrel: 'minecraft:barrel',
  ender_chest: 'minecraft:ender_chest',
  shulker_box: 'minecraft:shulker_box',
  furnace: 'minecraft:furnace',
  blast_furnace: 'minecraft:blast_furnace',
  smoker: 'minecraft:smoker',
  dispenser: 'minecraft:dispenser',
  dropper: 'minecraft:dropper',
  hopper: 'minecraft:hopper',
  brewing_stand: 'minecraft:brewing_stand',
  crafter: 'minecraft:crafter',

  // 装饰与特殊
  decorated_pot: 'minecraft:decorated_pot',
  lectern: 'minecraft:lectern',
  jukebox: 'minecraft:jukebox',
  campfire: 'minecraft:campfire',
  soul_campfire: 'minecraft:campfire',
  beehive: 'minecraft:beehive',
  bee_nest: 'minecraft:beehive',
  chiseled_bookshelf: 'minecraft:chiseled_bookshelf',
  enchanting_table: 'minecraft:enchanting_table',
  beacon: 'minecraft:beacon',
  conduit: 'minecraft:conduit',
  end_portal: 'minecraft:end_portal',
  end_gateway: 'minecraft:end_gateway',
  spawner: 'minecraft:mob_spawner',
  trial_spawner: 'minecraft:trial_spawner',
  vault: 'minecraft:vault',
  bell: 'minecraft:bell',
  flower_pot: 'minecraft:flower_pot',
  suspicious_sand: 'minecraft:brushable_block',
  suspicious_gravel: 'minecraft:brushable_block',
  sculk_sensor: 'minecraft:sculk_sensor',
  calibrated_sculk_sensor: 'minecraft:calibrated_sculk_sensor',
  sculk_catalyst: 'minecraft:sculk_catalyst',
  sculk_shrieker: 'minecraft:sculk_shrieker',
  comparator: 'minecraft:comparator',
  daylight_detector: 'minecraft:daylight_detector',
  piston: 'minecraft:piston',
  sticky_piston: 'minecraft:piston',
  moving_piston: 'minecraft:piston',
  structure_block: 'minecraft:structure_block',
  jigsaw: 'minecraft:jigsaw',
  // 三种命令方块的方块实体 id 都是 `minecraft:command_block`
  command_block: 'minecraft:command_block',
  chain_command_block: 'minecraft:command_block',
  repeating_command_block: 'minecraft:command_block',

  // 头颅：方块名有 9 种，方块实体 id 只有 `minecraft:skull`
  skeleton_skull: 'minecraft:skull',
  skeleton_wall_skull: 'minecraft:skull',
  wither_skeleton_skull: 'minecraft:skull',
  wither_skeleton_wall_skull: 'minecraft:skull',
  zombie_head: 'minecraft:skull',
  zombie_wall_head: 'minecraft:skull',
  player_head: 'minecraft:skull',
  player_wall_head: 'minecraft:skull',
  creeper_head: 'minecraft:skull',
  creeper_wall_head: 'minecraft:skull',
  dragon_head: 'minecraft:skull',
  dragon_wall_head: 'minecraft:skull',
  piglin_head: 'minecraft:skull',
  piglin_wall_head: 'minecraft:skull',
}

for (const wood of WOODS) {
  KINDS[`${wood}_sign`] = 'minecraft:sign'
  KINDS[`${wood}_wall_sign`] = 'minecraft:sign'
  KINDS[`${wood}_hanging_sign`] = 'minecraft:hanging_sign'
  KINDS[`${wood}_wall_hanging_sign`] = 'minecraft:hanging_sign'
  KINDS[`${wood}_bed`] = 'minecraft:bed'
}
for (const color of COLORS) {
  KINDS[`${color}_banner`] = 'minecraft:banner'
  KINDS[`${color}_wall_banner`] = 'minecraft:banner'
  KINDS[`${color}_shulker_box`] = 'minecraft:shulker_box'
}

/** 那份表里全部的方块名（规范串），诊断与测试用。 */
export const BLOCK_ENTITY_BLOCKS: readonly string[] = Object.keys(KINDS)
  .sort()
  .map((name) => `minecraft:${name}`)

/**
 * 这个方块挂着哪种方块实体；不带方块实体（或还没进这张表）时返回 `undefined`。
 *
 * 入参是调色板里的**规范状态串**（`minecraft:oak_sign[facing=north,…]`），
 * 所以要先剥掉属性与命名空间——palette 存的是带属性的串，而这张表的键是裸名字。
 */
export function blockEntityKindOf(block: string): string | undefined {
  const bare = /^(?:minecraft:)?([a-z0-9_]+)/.exec(block.trim())?.[1]
  if (bare === undefined) return undefined
  return KINDS[bare]
}
