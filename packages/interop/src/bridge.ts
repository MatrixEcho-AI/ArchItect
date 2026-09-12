import { DEFAULT_HARD_LIMIT } from '@architect/core'
import type { Bounds, PlacedEntity, Pos, WorldStore } from '@architect/core'

import { compoundFromJson, numberFromJson, NbtConversionError } from './json-nbt.js'
import { migrateState } from './migrate.js'
import { DATA_VERSION_1_21_4, readSpongeSchematic, writeSpongeSchematic } from './schematic.js'
import type { SchematicBlock, SchematicBlockEntity, SchematicData, SchematicEntity } from './schematic.js'

/**
 * 世界 ↔ 交换格式的桥。
 *
 * 这一层唯一的职责是把"工区里的稀疏体素"与"文件格式里的密集体素"对上，
 * 并且**如实报告发生了什么**：哪些方块没认出来、哪些被改名迁移过、有多少格被裁剪。
 * 导入导出最糟的失败模式是"看起来成功"，所以返回值宁可啰嗦。
 */

export interface ExportOptions {
  /** 只导出这个范围；省略用内容包围盒。 */
  region?: Bounds
  /** 输出文件的尺寸；省略时按 region 算。 */
  size?: [number, number, number]
  /** 目标 Minecraft 版本的 DataVersion。 */
  dataVersion?: number
  metadata?: Record<string, string>
}

export interface ExportResult {
  bytes: Uint8Array
  size: [number, number, number]
  /** 实际写进文件的非空气格数。 */
  blocks: number
  /** 写进文件的实体数。 */
  entities: number
  /** 写进文件的方块实体数。 */
  blockEntities: number
  /**
   * 附加数据转不成 NBT 而**只导出了结构**的条目（类型串 + 原因）。
   *
   * 这一栏存在是因为"猜"在这里是错的：JSON 分不出 byte/short/int/float/double，
   * 猜出来的文件在游戏里是错的、而在这里看不出来。转不了就说出来，别假装成功。
   */
  problems: string[]
  /** 导出的世界坐标范围。 */
  region: Bounds
  dataVersion: number
}

/** `yaw` 的步长：0..15 一步 22.5°（plan D-82）。规范里旋转是附加数据里的 `Rotation`。 */
const YAW_STEP = 22.5

const cellInside = (x: number, y: number, z: number, region: Bounds): boolean => {
  const cx = Math.floor(x)
  const cy = Math.floor(y)
  const cz = Math.floor(z)
  return (
    cx >= region.min.x && cx <= region.max.x &&
    cy >= region.min.y && cy <= region.max.y &&
    cz >= region.min.z && cz <= region.max.z
  )
}

/**
 * 默认导出范围：**方块与两层稀疏数据的并集**。
 *
 * 只用 `contentBounds()` 会安静地漏掉悬在建筑之上的实体（船浮在水面上、盔甲架站在
 * 屋顶的栏杆外），因为那个包围盒只算方块。交换格式里没有"世界坐标"，
 * 范围之外的东西就是不在文件里——所以范围必须自己长到装得下。
 */
function exportBoundsOf(store: WorldStore): Bounds | undefined {
  let box = store.contentBounds()
  const grow = (x: number, y: number, z: number): void => {
    const cell = { x: Math.floor(x), y: Math.floor(y), z: Math.floor(z) }
    if (box === undefined) {
      box = { min: { ...cell }, max: { ...cell } }
      return
    }
    box = {
      min: {
        x: Math.min(box.min.x, cell.x),
        y: Math.min(box.min.y, cell.y),
        z: Math.min(box.min.z, cell.z),
      },
      max: {
        x: Math.max(box.max.x, cell.x),
        y: Math.max(box.max.y, cell.y),
        z: Math.max(box.max.z, cell.z),
      },
    }
  }
  for (const entity of store.entities.list()) grow(entity.x, entity.y, entity.z)
  for (const entity of store.blockEntities.list()) grow(entity.x, entity.y, entity.z)
  return box
}

/**
 * 实体的附加数据。
 *
 * 模型的 `yaw`/`pitch` 是一等字段，而规范里旋转只是附加数据里的 `Rotation`。
 * **`data.Rotation` 优先**：从外部文件读进来的那个才是原值（可能写的是 189.3°，
 * 而我们的 `yaw` 是 22.5° 的步长，量化回去就毁了）；我们自己的实体没有它，
 * 才由 `yaw` 生成。两个方向因此都是无损的。
 */
function entityExtra(entity: PlacedEntity): Record<string, unknown> {
  const data: Record<string, unknown> = { ...(entity.data ?? {}) }
  if (data['Rotation'] === undefined) {
    data['Rotation'] = [entity.yaw * YAW_STEP, entity.pitch ?? 0]
  }
  return data
}

/**
 * 导出 `.schem`。
 *
 * 坐标以 `region.min` 为原点——交换格式里没有"世界坐标"的概念，所有位置都是相对的。
 * 导入时按同样的约定平移回来，于是**往返之后 `contentHash()` 必然相等**，
 * 这就是 M7 的验收口径。
 */
export function exportSchematic(store: WorldStore, options: ExportOptions = {}): ExportResult {
  const region = options.region ?? exportBoundsOf(store)
  if (region === undefined) throw new Error('世界是空的，没有可导出的内容')
  const size: [number, number, number] =
    options.size ??
    [region.max.x - region.min.x + 1, region.max.y - region.min.y + 1, region.max.z - region.min.z + 1]

  const blocks: SchematicBlock[] = []
  for (let y = region.min.y; y <= region.max.y; y++) {
    for (let z = region.min.z; z <= region.max.z; z++) {
      for (let x = region.min.x; x <= region.max.x; x++) {
        const state = store.getBlockString({ x, y, z })
        if (state === 'minecraft:air') continue
        blocks.push({ x: x - region.min.x, y: y - region.min.y, z: z - region.min.z, state })
      }
    }
  }

  const problems: string[] = []
  const entities: SchematicEntity[] = []
  for (const entity of store.entities.list()) {
    if (!cellInside(entity.x, entity.y, entity.z, region)) continue
    const place = (data: Record<string, unknown>): SchematicEntity => ({
      id: entity.type,
      pos: [entity.x - region.min.x, entity.y - region.min.y, entity.z - region.min.z],
      data,
    })
    const payload = entityExtra(entity)
    if (!canConvert(payload)) {
      // 结构照走：类型与位置还是能进游戏的，只有附加数据没有。**但上面已经报出来了**
      problems.push(`实体 ${entity.id}（${entity.type}）：${conversionProblemOf(payload)}`)
      entities.push(place({}))
      continue
    }
    entities.push(place(payload))
  }

  const blockEntities: SchematicBlockEntity[] = []
  for (const entity of store.blockEntities.list()) {
    if (!cellInside(entity.x, entity.y, entity.z, region)) continue
    const place = (data: Record<string, unknown>): SchematicBlockEntity => ({
      id: entity.kind,
      pos: [entity.x - region.min.x, entity.y - region.min.y, entity.z - region.min.z],
      data,
    })
    if (!canConvert(entity.data)) {
      problems.push(`方块实体 ${entity.kind}（${entity.x},${entity.y},${entity.z}）：${conversionProblemOf(entity.data)}`)
      blockEntities.push(place({}))
      continue
    }
    blockEntities.push(place(entity.data))
  }

  const dataVersion = options.dataVersion ?? DATA_VERSION_1_21_4
  const bytes = writeSpongeSchematic({
    size,
    blocks,
    entities,
    blockEntities,
    dataVersion,
    ...(options.metadata !== undefined ? { metadata: options.metadata } : {}),
  })

  return {
    bytes,
    size,
    blocks: blocks.length,
    entities: entities.length,
    blockEntities: blockEntities.length,
    problems,
    region,
    dataVersion,
  }
}

/**
 * 提前试转一次，好把"转不了"**定位到具体那一条**。
 *
 * 不这么做的话，失败会在 `writeSpongeSchematic` 里抛出，于是只能整份重写一遍、
 * 把所有条目的附加数据都摘掉——一条坏数据连累另外几十条，而报告里也说不清是谁。
 */
function canConvert(data: Record<string, unknown>): boolean {
  try {
    compoundFromJson(data)
    return true
  } catch (error) {
    return error instanceof NbtConversionError ? false : rethrow(error)
  }
}

function conversionProblemOf(data: Record<string, unknown>): string {
  try {
    compoundFromJson(data)
    return ''
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
}

function rethrow(error: unknown): never {
  throw error
}

export interface UnknownBlock {
  name: string
  count: number
  suggestions: string[]
}

export interface RenamedBlock {
  /** 源方块名（不带 `minecraft:`）。 */
  from: string
  /** 目标方块名（不带 `minecraft:`）。报告里要的是"从哪个名字换到了哪个名字"。 */
  to: string
  count: number
}

export interface ImportResult {
  /** 写进世界的非空气格数。 */
  placed: number
  /** 源文件里的非空气格数（经过 region 过滤之后）。 */
  total: number
  /** 因为目标方块认不出来而**没写**的格数。 */
  skipped: number
  /** 认不出来的方块，按数量降序。**没有写进世界。** */
  unknown: UnknownBlock[]
  /** 被改名表迁移过的方块。 */
  renamed: RenamedBlock[]
  /** 源文件是否与目标版本不同（有改名，或 DataVersion 对不上）。 */
  migrated: boolean
  sourceDataVersion?: number
  size: [number, number, number]
  /** 写进世界的实体数。 */
  entities: number
  /** 写进世界的方块实体数。 */
  blockEntities: number
  /** 这一次导入的世界 revision。**整次导入只涨一版。** */
  revision: number
}

/**
 * 统一成带命名空间的规范串。
 *
 * 我们模型里实体/方块实体类型只有一种写法（`minecraft:oak_boat`），而文件里
 * 两种都见得到——`minecraft:oak_boat` 与 `oak_boat`。不统一的话，`place_entity`
 * 查白名单、渲染查模型表、导出写回文件会各自遇到"同一个东西的两个身份"。
 */
const withNamespace = (id: string): string => (id.includes(':') ? id : `minecraft:${id}`)

/**
 * 从附加数据里的 `Rotation` 反推 `yaw`/`pitch`，并决定要不要把 `Rotation` 留在 `data` 里。
 *
 * 规则是"**只在量化真的会丢信息时才留原值**"：
 * - 文件的 yaw 正好落在 22.5° 的格点上（我们自己的导出永远是），就把它交给
 *   `yaw`/`pitch` 两个字段、从 `data` 里删掉——于是"导出 → 导入"逐字段相等
 *   （除了 id，文件格式不携带它，见 `ExportResult`）；
 * - 落在格点之外（外部文件里的 189.3°），**原值留在 `data.Rotation` 里**，
 *   `yaw` 只是"最近的格点"这个给人看的近似。导出时 `data.Rotation` 优先，
 *   所以重新导出仍然写 189.3°——外部文件 → 我们 → 外部文件是无损的。
 */
function rotationOf(data: Record<string, unknown>): { yaw: number; pitch?: number; keep: boolean } {
  const rotation = data['Rotation']
  const degrees = Array.isArray(rotation) ? numberFromJson(rotation[0]) : undefined
  const rawPitch = Array.isArray(rotation) ? numberFromJson(rotation[1]) : undefined
  if (degrees === undefined) return { yaw: 0, keep: false }
  const yaw = (((Math.round(degrees / YAW_STEP) % 16) + 16) % 16)
  return {
    yaw,
    // 0 不写成字段：模型的 `pitch` 是可选的，"没有"与"0"在导出时等价
    ...(rawPitch !== undefined && rawPitch !== 0 ? { pitch: rawPitch } : {}),
    keep: degrees !== yaw * YAW_STEP,
  }
}

export interface ImportOptions {
  /** 落点：源文件的 `(0,0,0)` 放在这里。省略时用内容最小角（空世界则用工区最小角）。 */
  at?: Pos
  /** 只导入源文件里这个范围内的格。 */
  region?: Bounds
  /** 是否用改名表迁移（默认 true）。关掉就只做精确匹配。 */
  migrate?: boolean
  /**
   * 是否先把目标盒子清空（默认 `true`）。
   *
   * 交换格式的语义是"这个盒子长这样"，不是"把东西堆上去"——不清空的话，
   * 新内容与旧残留混在一起，看起来像导入成功但多了一堆东西。
   */
  clear?: boolean
}

/**
 * 把 `.schem` 里的方块写进世界。**整次导入只占一个 revision。**
 *
 * 与导出对称：源文件坐标 `(0,0,0)` 落在 `at`，所以"导出再导入"是恒等变换。
 */
export function importSchematicInto(
  store: WorldStore,
  data: SchematicData,
  options: ImportOptions = {},
): ImportResult {
  const at = options.at ?? store.contentBounds()?.min ?? store.volume.min
  const min = at
  const max: Pos = { x: at.x + data.size[0] - 1, y: at.y + data.size[1] - 1, z: at.z + data.size[2] - 1 }
  const filter = options.region

  // 目标盒子完全由**文件里声明的尺寸**推出，所以必须先自己卡一道。
  //
  // 下面那个三重循环会为盒子里的**每一格**建一条 `plan` 记录（`clear` 默认开），
  // 而 `writeBlocks` 的硬上限要到它自己把 `changes` 攒完、已经开始分配之后才生效——
  // 中间没有任何东西挡着。于是几百字节的文件只要声明 4096×4096×1，就能在分配阶段
  // 把进程打死（实测 V8 致命 OOM，不是可捕获的异常；桌面端这条跑在主进程里，
  // 等于整个应用消失、未保存的编辑一起没）。
  //
  // 合法导入本来就该在这个上限之内：超了 `writeBlocks` 也只会静默截断。
  const targetVolume = data.size[0] * data.size[1] * data.size[2]
  if (targetVolume > DEFAULT_HARD_LIMIT) {
    throw new Error(
      `导入目标盒 ${data.size.join('x')} = ${targetVolume} 格，超过单次写入上限 ${DEFAULT_HARD_LIMIT} 格`,
    )
  }

  const unknown = new Map<string, UnknownBlock>()
  const renamed = new Map<string, RenamedBlock>()
  /** 目标格 → 方块下标。后写的覆盖先写的，所以先铺空气再铺内容。 */
  const plan = new Map<string, number>()
  let total = 0
  let skipped = 0

  const noteUnknown = (name: string, suggestions: string[], count: number): void => {
    const entry = unknown.get(name) ?? { name, count: 0, suggestions }
    entry.count += count
    unknown.set(name, entry)
  }

  if (options.clear !== false) {
    for (let y = min.y; y <= max.y; y++) {
      for (let z = min.z; z <= max.z; z++) {
        for (let x = min.x; x <= max.x; x++) plan.set(`${x},${y},${z}`, 0)
      }
    }
  }

  for (const block of data.blocks) {
    if (filter !== undefined) {
      if (block.x < filter.min.x || block.x > filter.max.x) continue
      if (block.y < filter.min.y || block.y > filter.max.y) continue
      if (block.z < filter.min.z || block.z > filter.max.z) continue
    }
    total++
    const x = min.x + block.x
    const y = min.y + block.y
    const z = min.z + block.z

    let state = block.state
    if (options.migrate !== false) {
      const outcome = migrateState(store.registry, block.state, data.dataVersion)
      if (outcome.kind === 'unknown') {
        noteUnknown(outcome.from, outcome.suggestions, 1)
        skipped++
        continue
      }
      // `exact` 与 `renamed` 的 `state` 都是**规范化之后**的串：`migrateState`
      // 内部走 `canonicalize`，会排序属性、补齐缺失项、把目标方块不接受的取值
      // 换成声明默认值。只有 `renamed` 采用它是不够的——`exact` 时继续用**原始串**，
      // 而原始串未必是合法状态（`half=1` 就是），于是 `palette.indexOf` 抛错，
      // 那一格被记成「未知方块」丢掉，方块凭空消失。
      state = outcome.state
      if (outcome.kind === 'renamed') {
        const toName = /^(?:minecraft:)?([a-z0-9_]+)/.exec(outcome.state)?.[1] ?? outcome.state
        const entry = renamed.get(outcome.from) ?? { from: outcome.from, to: toName, count: 0 }
        entry.count++
        renamed.set(outcome.from, entry)
      }
    } else {
      const parsed = /^(?:minecraft:)?([a-z0-9_]+)/.exec(block.state)
      if (parsed === null || store.registry.blockByName(parsed[1]!) === undefined) {
        noteUnknown(parsed?.[1] ?? block.state, [], 1)
        skipped++
        continue
      }
    }

    let blockIndex: number
    try {
      // `indexOf` 会顺带把新方块加进调色板——这正是我们要的
      blockIndex = store.palette.indexOf(state)
    } catch {
      noteUnknown(block.state, [], 1)
      skipped++
      continue
    }
    plan.set(`${x},${y},${z}`, blockIndex)
  }

  const cells = [...plan.entries()].map(([key, blockIndex]) => {
    const [x, y, z] = key.split(',').map(Number) as [number, number, number]
    return { x, y, z, blockIndex }
  })

  // 一次写入：一个 revision。`writeBlocks` 自己处理工区裁剪与 dry-run。
  const written = store.writeBlocks(
    (emit) => {
      for (const cell of cells) emit(cell.x, cell.y, cell.z, cell.blockIndex)
    },
    { mode: 'replace', confirm: true },
  )
  if (!written.ok) {
    throw new Error(`导入写盘失败：${written.reason}（预览 ${written.preview.willChange} 格）`)
  }

  /**
   * 两层稀疏数据。**必须排在 `writeBlocks` 之后**：方块实体的写入要发生在剪除之后，
   * 否则刚写进去的附加数据会被同一次写入顺手剪掉——那正是"寄生"的语义，
   * 顺序反了的症状是"方块和附加数据都在文件里，导入之后附加数据没了"。
   *
   * 这里**既不推进版本号也不记 op**：导入的收尾是"rev 0 = 导入时看到的样子"
   * （命令行动作里那句 `setRevision(0)`），所以整次导入是一个基准，
   * 方块与两层稀疏数据同属它。
   */
  let entityCount = 0
  for (const entity of data.entities ?? []) {
    if (!insideFilter(entity.pos, filter)) continue
    const rotation = rotationOf(entity.data)
    const extra = { ...entity.data }
    if (!rotation.keep) delete extra['Rotation']
    const change = store.entities.set({
      id: store.entities.allocateId(store.revision + 1),
      type: withNamespace(entity.id),
      x: min.x + entity.pos[0],
      y: min.y + entity.pos[1],
      z: min.z + entity.pos[2],
      yaw: rotation.yaw,
      ...(rotation.pitch !== undefined ? { pitch: rotation.pitch } : {}),
      ...(Object.keys(extra).length > 0 ? { data: extra } : {}),
    })
    if (change !== undefined) entityCount++
  }

  let blockEntityCount = 0
  for (const entity of data.blockEntities ?? []) {
    if (!insideFilter(entity.pos, filter)) continue
    const change = store.blockEntities.set({
      x: min.x + entity.pos[0],
      y: min.y + entity.pos[1],
      z: min.z + entity.pos[2],
      kind: withNamespace(entity.id),
      data: entity.data,
    })
    if (change !== undefined) blockEntityCount++
  }

  const output: ImportResult = {
    placed: total - skipped,
    total,
    skipped,
    unknown: [...unknown.values()].sort((a, b) => b.count - a.count || a.name.localeCompare(b.name)),
    renamed: [...renamed.values()].sort((a, b) => b.count - a.count || a.from.localeCompare(b.from)),
    migrated: renamed.size > 0 || (data.dataVersion !== undefined && data.dataVersion !== DATA_VERSION_1_21_4),
    size: data.size,
    entities: entityCount,
    blockEntities: blockEntityCount,
    revision: written.revision,
  }
  if (data.dataVersion !== undefined) output.sourceDataVersion = data.dataVersion
  return output
}

/**
 * 文件坐标是否在 `region` 过滤范围内（`region` 用的也是文件坐标）。
 *
 * **按格比，不按浮点比**：方块那一侧的判据是"格子 `z` 在 `[min.z, max.z]` 内"，
 * 而实体的 `z` 是浮点（4.5 表示第 4 格里的某个位置）。直接用浮点比的话，
 * `z = 4.5` 会被判成"超过 max.z = 4"而丢掉——而它的格子明明就在范围里。
 * 同一个区域选择对三层必须给出同样的答案。
 */
function insideFilter(pos: readonly number[], filter: Bounds | undefined): boolean {
  if (filter === undefined) return true
  const x = Math.floor(pos[0]!)
  const y = Math.floor(pos[1]!)
  const z = Math.floor(pos[2]!)
  return (
    x >= filter.min.x && x <= filter.max.x &&
    y >= filter.min.y && y <= filter.max.y &&
    z >= filter.min.z && z <= filter.max.z
  )
}

/** 从字节直接导入（读文件 + 写世界一步到位）。 */
export async function importSchematicBytes(
  store: WorldStore,
  bytes: Uint8Array,
  options: ImportOptions = {},
): Promise<ImportResult> {
  const data = await readSpongeSchematic(bytes)
  return importSchematicInto(store, data, options)
}
