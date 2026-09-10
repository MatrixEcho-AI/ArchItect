import { boundsSize, boundsVolume } from '../geometry/box.js'
import type { Bounds } from '../types.js'
import type { WorldStore } from '../world/store.js'

export interface BlockCount {
  block: string
  count: number
  /** 占非空气方块的百分比。 */
  percent: number
}

export interface MeasureResult {
  /** 内容包围盒（忽略空气）。空世界为 `undefined`。 */
  bounds: Bounds | undefined
  size: { x: number; y: number; z: number } | undefined
  /** 非空气方块总数。 */
  blocks: number
  /** 已分配 chunk 列数与内存估算。 */
  memory: { columns: number; approximateBytes: number }
  /** 方块直方图，按数量降序。 */
  histogram: BlockCount[]
}

/**
 * 尺寸与材质直方图。
 *
 * `measure` 是 LLM 在动手前确认尺度的主要手段（plan §9.3 工具准则第 5 条），
 * 也是"声称完成前必须通过"的检查项之一。
 */
export function measure(store: WorldStore): MeasureResult {
  const counts = new Map<string, number>()
  let blocks = 0
  let minX = 0
  let minY = 0
  let minZ = 0
  let maxX = 0
  let maxY = 0
  let maxZ = 0
  let found = false

  store.forEachNonAir((x, y, z) => {
    blocks++
    if (!found) {
      minX = maxX = x
      minY = maxY = y
      minZ = maxZ = z
      found = true
    } else {
      if (x < minX) minX = x
      if (x > maxX) maxX = x
      if (y < minY) minY = y
      if (y > maxY) maxY = y
      if (z < minZ) minZ = z
      if (z > maxZ) maxZ = z
    }
    const block = store.getBlockString({ x, y, z })
    counts.set(block, (counts.get(block) ?? 0) + 1)
  })

  const bounds: Bounds | undefined = found
    ? { min: { x: minX, y: minY, z: minZ }, max: { x: maxX, y: maxY, z: maxZ } }
    : undefined

  const histogram: BlockCount[] = [...counts.entries()]
    .map(([block, count]) => ({
      block,
      count,
      percent: blocks === 0 ? 0 : Math.round((count / blocks) * 1000) / 10,
    }))
    .sort((a, b) => b.count - a.count || a.block.localeCompare(b.block))

  const stats = store.stats()
  return {
    bounds,
    size: bounds === undefined ? undefined : boundsSize(bounds),
    blocks,
    memory: { columns: stats.columns, approximateBytes: stats.approximateBytes },
    histogram,
  }
}

/** 工区的体积（用于"用了多少比例"的判断）。 */
export function volumeOf(store: WorldStore): number {
  return boundsVolume(store.volume)
}

/** 把 `measure` 的结果渲染成紧凑文本（给 LLM 看的那份）。 */
export function formatMeasure(result: MeasureResult): string {
  const lines: string[] = []
  if (result.bounds === undefined) {
    lines.push('The world is empty (no non-air blocks)')
    return lines.join('\n')
  }
  const { min, max } = result.bounds
  lines.push(
    `bounds: (${min.x},${min.y},${min.z}) .. (${max.x},${max.y},${max.z})  ` +
      `size: ${result.size!.x}×${result.size!.y}×${result.size!.z}`,
  )
  lines.push(`blocks: ${result.blocks}   columns: ${result.memory.columns}`)
  lines.push('histogram:')
  for (const entry of result.histogram.slice(0, 12)) {
    lines.push(`  ${String(entry.count).padStart(7)}  ${String(entry.percent).padStart(5)}%  ${entry.block}`)
  }
  if (result.histogram.length > 12) {
    lines.push(`  … ${result.histogram.length - 12} more block types`)
  }
  return lines.join('\n')
}
