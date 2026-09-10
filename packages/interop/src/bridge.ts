import type { Bounds, Pos, WorldStore } from '@architect/core'

import { migrateState } from './migrate.js'
import { DATA_VERSION_1_21_4, readSpongeSchematic, writeSpongeSchematic } from './schematic.js'
import type { SchematicBlock, SchematicData } from './schematic.js'

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
  /** 导出的世界坐标范围。 */
  region: Bounds
  dataVersion: number
}

/**
 * 导出 `.schem`。
 *
 * 坐标以 `region.min` 为原点——交换格式里没有"世界坐标"的概念，所有位置都是相对的。
 * 导入时按同样的约定平移回来，于是**往返之后 `contentHash()` 必然相等**，
 * 这就是 M7 的验收口径。
 */
export function exportSchematic(store: WorldStore, options: ExportOptions = {}): ExportResult {
  const region = options.region ?? store.contentBounds()
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

  const dataVersion = options.dataVersion ?? DATA_VERSION_1_21_4
  const bytes = writeSpongeSchematic({
    size,
    blocks,
    dataVersion,
    ...(options.metadata !== undefined ? { metadata: options.metadata } : {}),
  })
  return { bytes, size, blocks: blocks.length, region, dataVersion }
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
  /** 这一次导入的世界 revision。**整次导入只涨一版。** */
  revision: number
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
      if (outcome.kind === 'renamed') {
        state = outcome.state
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

  const output: ImportResult = {
    placed: total - skipped,
    total,
    skipped,
    unknown: [...unknown.values()].sort((a, b) => b.count - a.count || a.name.localeCompare(b.name)),
    renamed: [...renamed.values()].sort((a, b) => b.count - a.count || a.from.localeCompare(b.from)),
    migrated: renamed.size > 0 || (data.dataVersion !== undefined && data.dataVersion !== DATA_VERSION_1_21_4),
    size: data.size,
    revision: written.revision,
  }
  if (data.dataVersion !== undefined) output.sourceDataVersion = data.dataVersion
  return output
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
