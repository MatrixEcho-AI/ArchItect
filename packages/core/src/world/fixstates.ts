import { boundsContain, normalizeBounds } from '../geometry/box.js'
import { propertiesToStateId, stateIdToProperties } from '../state.js'
import type { BlockProperty, Bounds, Pos, Properties, PropertyValue } from '../types.js'
import type { WriteOptions, WriteResult, WorldStore } from './store.js'

/**
 * `fix_states` 的纯实现：**按邻居关系修正"连接类"方块的 state**。
 *
 * 它只修三类属性，其余一律不碰（尤其是 `waterlogged`）：
 *
 * - `connect`          —— 栅栏 / 墙 / 玻璃板 / 铁栏杆的 `north/south/east/west` 连接值。
 * - `wall_up`          —— 墙的 `up`（中心柱）。1.21.4 里只有墙家族带这个属性，玻璃板没有。
 * - `stairs`           —— 楼梯的 `shape`（`straight` / `inner_*` / `outer_*`）。
 * - `embedded_partial` —— **只报告不修改**：被六个实心方块完全包住、因而不可见的半砖/楼梯。
 *   这是原任务书里 `slab_double` 的替代规则，原因见下方长注释。
 *
 * 三个不变式：
 *
 * 1. **幂等**：每个目标值只依赖邻居的"方块种类 / 朝向 / 半格 / 是否为整格实心"，
 *    而本 pass 从不改这些东西（只改连接值、`up`、`shape`），所以第一次扫描后
 *    再扫一次得到完全相同的目标值 → `changed === 0`。
 * 2. **一次提交**：先在心里算完整个计划，最后只调一次 `store.writeBlocks`，
 *    因此只增加一个 revision，`undo` 一步即可撤销。
 * 3. **确定性**：计划按 `y → z → x` 排序后提交，与 chunk 列的遍历顺序无关；
 *    同样的世界必然产生同样的 changeSet。
 *
 * 每个目标 state 都用「当前完整属性集 + 少量覆盖」重新编码（`propertiesToStateId`），
 * 缺省属性从 `defaultState` 继承这条规则由 codec 负责，本文件不自己拼 stateId。
 */

/** 水平方向。与 Minecraft 的 `Direction` 同名，`north` = -Z、`south` = +Z。 */
type Dir = 'north' | 'south' | 'east' | 'west'

const DIRECTIONS: readonly Dir[] = ['north', 'south', 'east', 'west']

const STEP: Record<Dir, { x: number; z: number }> = {
  north: { x: 0, z: -1 },
  south: { x: 0, z: 1 },
  east: { x: 1, z: 0 },
  west: { x: -1, z: 0 },
}

const OPPOSITE: Record<Dir, Dir> = { north: 'south', south: 'north', east: 'west', west: 'east' }

/** `Direction.getCounterClockWise()`：北→西→南→东。 */
const COUNTER_CLOCKWISE: Record<Dir, Dir> = { north: 'west', west: 'south', south: 'east', east: 'north' }

/** `Direction.getAxis()`：南北在 Z 轴上，东西在 X 轴上。 */
const AXIS: Record<Dir, 'x' | 'z'> = { north: 'z', south: 'z', east: 'x', west: 'x' }

/** 楼梯的 `shape` 取值。 */
type StairShape = 'straight' | 'inner_left' | 'inner_right' | 'outer_left' | 'outer_right'

/** 连接家族：同家族才互相连接（栅栏不会连到墙上）。 */
type FamilyKind = 'fence' | 'wall' | 'pane'

export interface FixStatesOptions extends WriteOptions {
  /** 只修正这个闭区间**内**的格子；邻居仍照常从世界里读（区域外的不动）。 */
  region?: Bounds
}

export interface FixStatesReport {
  /** 真正提交的格数（等于 `WriteResult.changed`；dry-run 未提交时为 0）。 */
  changed: number
  /** 检查过的非空气格数（区域 ∩ 工区）。 */
  scanned: number
  /**
   * 每条规则命中的格数。**同格可被多条规则命中**（例如一面墙同时改连接和 `up`），
   * 所以 `byRule` 各值之和 >= `changed`。`embedded_partial` 是只报告不修改的规则，
   * 它的计数是"发现数"而不是"写入数"。
   */
  byRule: Record<string, number>
  /** `embedded_partial` 命中的位置样本（最多 `EMBEDDED_SAMPLE_LIMIT` 个），供工具回显。 */
  embeddedSample: Pos[]
}

/** `embedded_partial` 回显的位置样本上限。 */
export const EMBEDDED_SAMPLE_LIMIT = 12

/** 规则键是协议标识，**不翻译、不改名**。 */
export const FIX_STATES_RULES = ['connect', 'wall_up', 'stairs', 'embedded_partial'] as const

interface SideSpec {
  property: BlockProperty
  /** 「连上」时写入的值。 */
  connected: PropertyValue
  /** 「不连」时写入的值。 */
  disconnected: PropertyValue
}

interface ConnectableSpec {
  kind: FamilyKind
  sides: Partial<Record<Dir, SideSpec>>
  /** 墙的 `up`；栅栏 / 玻璃板在 1.21.4 没有这个属性。 */
  up: BlockProperty | undefined
}

interface StairSpec {
  facing: BlockProperty
  half: BlockProperty
  shape: BlockProperty
  shapeValues: ReadonlySet<string>
}

interface FixIndex {
  connectable: Map<string, ConnectableSpec>
  stairs: Map<string, StairSpec>
  slabs: Set<string>
}

/** 从方块名判断连接家族。`_fence_gate` 不以 `_fence` 结尾，天然被排除。 */
function familyKindOf(name: string): FamilyKind | undefined {
  if (name.endsWith('_fence')) return 'fence'
  if (name.endsWith('_wall')) return 'wall'
  if (name.endsWith('_pane') || name === 'iron_bars') return 'pane'
  return undefined
}

/**
 * 从属性**自己的声明**推出"连上 / 不连"两个值，绝不硬编码 `true`。
 *
 * - `bool`：索引 0 是 `true`（见 state.ts 的坑），不连是 `false`。
 * - 枚举：声明里的**第一个值**是不连、**最后一个值**是完全连上。
 *   墙是 `none|low|tall` → `none` / `tall`。
 */
function sideSpec(property: BlockProperty): SideSpec | undefined {
  if (property.type === 'bool') return { property, connected: true, disconnected: false }
  const values = property.values
  if (values === undefined || values.length < 2) return undefined
  const disconnected = values[0]
  const connected = values[values.length - 1]
  if (disconnected === undefined || connected === undefined) return undefined
  return { property, disconnected, connected }
}

/** 一次性把注册表里所有连接族 / 楼梯 / 半砖方块找出来；之后每格都是 O(1) 查表。 */
function buildIndex(registry: WorldStore['registry']): FixIndex {
  const connectable = new Map<string, ConnectableSpec>()
  const stairs = new Map<string, StairSpec>()
  const slabs = new Set<string>()

  for (const name of registry.blockNames) {
    const block = registry.blockByName(name)
    if (block === undefined) continue

    const kind = familyKindOf(name)
    if (kind !== undefined) {
      const sides: Partial<Record<Dir, SideSpec>> = {}
      for (const dir of DIRECTIONS) {
        const property = block.states.find((s) => s.name === dir)
        if (property === undefined) continue
        const spec = sideSpec(property)
        if (spec !== undefined) sides[dir] = spec
      }
      // 四个方向必须齐全，否则不是我们认识的那种"连接方块"，宁可不动它。
      if (DIRECTIONS.every((dir) => sides[dir] !== undefined)) {
        connectable.set(name, { kind, sides, up: block.states.find((s) => s.name === 'up' && s.type === 'bool') })
      }
    }

    const shape = block.states.find((s) => s.name === 'shape' && s.values?.includes('inner_left') === true)
    if (shape !== undefined) {
      const facing = block.states.find((s) => s.name === 'facing')
      const half = block.states.find((s) => s.name === 'half')
      if (facing !== undefined && half !== undefined) {
        stairs.set(name, { facing, half, shape, shapeValues: new Set(shape.values ?? []) })
      }
    }

    const type = block.states.find(
      (s) => s.name === 'type' && s.values?.includes('top') === true && s.values?.includes('bottom') === true,
    )
    if (type !== undefined) slabs.add(name)
  }

  return { connectable, stairs, slabs }
}

function isDir(value: PropertyValue | undefined): value is Dir {
  return typeof value === 'string' && (DIRECTIONS as readonly string[]).includes(value)
}

const addStep = (pos: Pos, dir: Dir): Pos => {
  const step = STEP[dir]
  return { x: pos.x + step.x, y: pos.y, z: pos.z + step.z }
}

/** 取该格的楼梯信息（`facing` + `half`）；不是楼梯则 `undefined`。 */
function stairAt(store: WorldStore, index: FixIndex, pos: Pos): { facing: Dir; half: PropertyValue } | undefined {
  const stateId = store.getBlockStateId(pos)
  const block = store.registry.blockByStateId(stateId)
  if (block === undefined) return undefined
  const spec = index.stairs.get(block.name)
  if (spec === undefined) return undefined
  const properties = stateIdToProperties(block, stateId)
  const facing = properties[spec.facing.name]
  const half = properties[spec.half.name]
  if (!isDir(facing) || half === undefined) return undefined
  return { facing, half }
}

/**
 * 香草的 `isDifferentStairs`：`pos` 那格不是楼梯，或者朝向 / 半格与自身不同，就算"不同"。
 * 只比较 `facing` 与 `half`——本 pass 不改这两个属性，所以判定结果是稳定的。
 */
function isDifferentStairs(
  store: WorldStore,
  index: FixIndex,
  pos: Pos,
  selfFacing: Dir,
  selfHalf: PropertyValue,
): boolean {
  const other = stairAt(store, index, pos)
  return other === undefined || other.facing !== selfFacing || other.half !== selfHalf
}

/**
 * 楼梯 `shape` 的香草判定规则，逐句对应 `StairBlock.getStairsShape`：
 *
 * 设自身朝向为 F、半格为 H（`half`；两格楼梯只有半格相同才会拼角）：
 *
 * 1. **凸角**：看正前方 `P+F` 的楼梯 N。若 N 的朝向 G 与 F **垂直**（轴不同），
 *    且 `P-G`（N 朝向的反方向那一格）不是"与自身同朝向同半格"的楼梯，
 *    则 G == F 的逆时针邻向时是 `outer_left`，否则 `outer_right`。
 * 2. **凹角**：否则看正后方 `P-F` 的楼梯 B。若 B 的朝向 G 与 F 垂直，
 *    且 `P+G` 不是"与自身同朝向同半格"的楼梯，则 G == F 的逆时针邻向时
 *    是 `inner_left`，否则 `inner_right`。
 * 3. 都不满足 → `straight`。
 *
 * 「逆时针邻向」按 `Direction.getCounterClockWise()`：北→西→南→东。
 *
 * 这套规则已用注册表的**碰撞盒数据**交叉验证：例如
 * `oak_stairs[facing=north,half=bottom,shape=outer_left]` 的上半格是西北象限，
 * 它恰好与本规则判定为 `outer_left` 的那组邻居（正前方朝西的楼梯）拼成连续踏面；
 * `inner_left` 的"西侧长条 + 东北象限"两个盒子也正好接上正后方朝西的楼梯。
 */
function vanillaStairShape(
  store: WorldStore,
  index: FixIndex,
  pos: Pos,
  facing: Dir,
  half: PropertyValue,
): StairShape {
  const front = stairAt(store, index, addStep(pos, facing))
  if (front !== undefined && front.half === half) {
    const turn = front.facing
    if (AXIS[turn] !== AXIS[facing] && isDifferentStairs(store, index, addStep(pos, OPPOSITE[turn]), facing, half)) {
      return turn === COUNTER_CLOCKWISE[facing] ? 'outer_left' : 'outer_right'
    }
  }

  const back = stairAt(store, index, addStep(pos, OPPOSITE[facing]))
  if (back !== undefined && back.half === half) {
    const turn = back.facing
    if (AXIS[turn] !== AXIS[facing] && isDifferentStairs(store, index, addStep(pos, turn), facing, half)) {
      return turn === COUNTER_CLOCKWISE[facing] ? 'inner_left' : 'inner_right'
    }
  }

  return 'straight'
}

/** 六个面都被整格实心方块盖住 → 这一格里的半砖 / 楼梯完全看不见。 */
const NEIGHBOUR_OFFSETS: readonly Pos[] = [
  { x: 0, y: 1, z: 0 },
  { x: 0, y: -1, z: 0 },
  { x: 0, y: 0, z: -1 },
  { x: 0, y: 0, z: 1 },
  { x: 1, y: 0, z: 0 },
  { x: -1, y: 0, z: 0 },
]

function isEmbedded(store: WorldStore, pos: Pos): boolean {
  for (const offset of NEIGHBOUR_OFFSETS) {
    const stateId = store.getBlockStateId({ x: pos.x + offset.x, y: pos.y + offset.y, z: pos.z + offset.z })
    if (!store.registry.isFullCube(stateId)) return false
  }
  return true
}

/**
 * 邻居是否应该与 `kind` 家族相连。
 *
 * **安全子集**：同家族（栅栏↔栅栏、墙↔墙、玻璃板/铁栏杆↔玻璃板/铁栏杆）或整格实心立方体。
 * 刻意不做、且已在报告里声明的部分：
 * - 墙连到"不同高度"的墙时香草会选 `low`，这里统一取家族最大值 `tall`；
 * - 栅栏 / 墙 ↔ 栅栏门（`*_fence_gate`，它没有方向属性）；
 * - 红石线 / 绊线 / 藤蔓 / 荧光地衣等的 `north/south/east/west`——它们的取值不是
 *   `bool` 而是 `up|side|none` 这类语义完全不同的枚举，不属于本 pass 的家族。
 */
function connects(store: WorldStore, kind: FamilyKind, neighbourStateId: number): boolean {
  if (store.registry.isFullCube(neighbourStateId)) return true
  const block = store.registry.blockByStateId(neighbourStateId)
  return block !== undefined && familyKindOf(block.name) === kind
}

/**
 * 修正所有"连接类"方块的状态。
 *
 * 返回值 = 普通 `WriteResult` 字段 + `fix` 报告。无论 `writeBlocks` 是否落盘，
 * `fix` 都在（dry-run 时 `changed` 为 0，但 `scanned` / `byRule` 反映扫描结果）。
 */
export function fixStates(
  store: WorldStore,
  options: FixStatesOptions = {},
): WriteResult & { fix: FixStatesReport } {
  const index = buildIndex(store.registry)
  const region = options.region !== undefined ? normalizeBounds(options.region.min, options.region.max) : undefined

  const byRule: Record<string, number> = { connect: 0, wall_up: 0, stairs: 0, embedded_partial: 0 }
  const embeddedSample: Pos[] = []
  const planned: Array<{ x: number; y: number; z: number; stateId: number; blockIndex: number }> = []
  let scanned = 0

  store.forEachNonAir((x, y, z, stateId) => {
    const pos: Pos = { x, y, z }
    if (region !== undefined && !boundsContain(region, pos)) return
    // 区域外的格子 writeBlocks 会 clip 掉，这里先跳过，避免"看起来改了很多其实被裁掉"。
    if (!boundsContain(store.volume, pos)) return
    scanned++

    const block = store.registry.blockByStateId(stateId)
    if (block === undefined) return

    // 用**当前完整属性集**做基底再覆盖，这样 waterlogged 之类的属性原样保留。
    const current = stateIdToProperties(block, stateId)
    const fixed: Properties = {}
    const hitRules = new Set<string>()

    const connectable = index.connectable.get(block.name)
    if (connectable !== undefined) {
      for (const dir of DIRECTIONS) {
        const side = connectable.sides[dir]
        if (side === undefined) continue
        const neighbourStateId = store.getBlockStateId(addStep(pos, dir))
        const desired = connects(store, connectable.kind, neighbourStateId) ? side.connected : side.disconnected
        if (current[side.property.name] !== desired) {
          fixed[side.property.name] = desired
          hitRules.add('connect')
        }
      }

      if (connectable.up !== undefined) {
        // 上方被整格实心方块盖住 → 不立中心柱（up=false）；否则立柱。
        // 见文件头与报告：任务书给的字面极性与本仓库碰撞盒数据相反，这里以数据为准。
        const desired = !store.registry.isFullCube(store.getBlockStateId({ x, y: y + 1, z }))
        if (current[connectable.up.name] !== desired) {
          fixed[connectable.up.name] = desired
          hitRules.add('wall_up')
        }
      }
    }

    const stair = index.stairs.get(block.name)
    if (stair !== undefined) {
      const facing = current[stair.facing.name]
      if (isDir(facing)) {
        const desired = vanillaStairShape(store, index, pos, facing, current[stair.half.name] ?? 'bottom')
        // 只在方块自己声明了这个 shape 取值时才写，保证永远写不出 codec 编不出来的 state。
        if (current[stair.shape.name] !== desired && stair.shapeValues.has(desired)) {
          fixed[stair.shape.name] = desired
          hitRules.add('stairs')
        }
      }
    }

    if (hitRules.size > 0) {
      const nextStateId = propertiesToStateId(block, { ...current, ...fixed })
      if (nextStateId !== stateId) {
        planned.push({ x, y, z, stateId: nextStateId, blockIndex: -1 })
        for (const rule of hitRules) byRule[rule] = (byRule[rule] ?? 0) + 1
      }
    }

    // `slab_double` 的替代规则：一格只能放一个方块，所以"同一格里叠两块半砖"永远不成立；
    // `type=double` 也是合法的"整格半砖"。真正有意义、且能从几何证明的只有下面这条：
    // 半砖 / 楼梯被六个整格实心方块完全包住时，碰撞盒和模型都被挡死，看不见也走不进去。
    // 它可能是有意埋的（隐形碰撞、防刷怪等），所以**只报告、不删除**。
    if (
      (index.slabs.has(block.name) || index.stairs.has(block.name)) &&
      !store.registry.isFullCube(stateId) &&
      isEmbedded(store, pos)
    ) {
      byRule.embedded_partial = (byRule.embedded_partial ?? 0) + 1
      if (embeddedSample.length < EMBEDDED_SAMPLE_LIMIT) embeddedSample.push(pos)
    }
  })

  // 固定顺序提交，保证 changeSet / 撤销栈与 chunk 遍历顺序无关。
  planned.sort((a, b) => a.y - b.y || a.z - b.z || a.x - b.x)
  // 报告里的样本也排序：`forEachNonAir` 走的是 chunk 列的插入顺序，
  // 同样的世界用不同的建造顺序搭出来，遍历顺序会不同，报告也应当一致。
  embeddedSample.sort((a, b) => a.y - b.y || a.z - b.z || a.x - b.x)

  // **必须在 writeBlocks 之前**把目标 state 加进调色板。
  // `store.writeBlocks` 在调用 producer 之前就把 `palette.toGlobalStateIds()` 拍了快照，
  // 所以 producer 里现加的调色板条目不在快照里，会抛
  // "Palette index N does not exist"。修正后的 state 几乎都是新组合（例如
  // oak_fence[east=true]），世界里原本没有，因此这里先解析一遍再提交。
  // 代价：dry-run（NEEDS_CONFIRM）时调色板也会先长几个条目；调色板不属于 revision，
  // 多几个没人引用的条目是无害的。
  for (const cell of planned) cell.blockIndex = store.blockIndexForStateId(cell.stateId)

  const writeOptions: WriteOptions = { mode: 'replace', confirm: options.confirm === true }
  if (options.confirmThreshold !== undefined) writeOptions.confirmThreshold = options.confirmThreshold
  if (options.hardLimit !== undefined) writeOptions.hardLimit = options.hardLimit

  const result = store.writeBlocks((emit) => {
    for (const cell of planned) emit(cell.x, cell.y, cell.z, cell.blockIndex)
  }, writeOptions)

  return {
    ...result,
    fix: {
      changed: result.ok ? result.changed : 0,
      scanned,
      byRule,
      embeddedSample,
    },
  }
}
