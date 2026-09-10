import type { Bounds } from '../types.js'
import type { WorldStore } from '../world/store.js'

export type SliceAxis = 'x' | 'y' | 'z'

export interface SliceRange {
  x?: readonly [number, number]
  y?: readonly [number, number]
  z?: readonly [number, number]
}

export interface SliceOptions {
  axis: SliceAxis
  index: number
  /** 只渲染这个范围内的部分（闭区间）。 */
  range?: SliceRange
  /** 单张切片的单元格上限。超过就报错，让调用方缩小范围而不是拿到一堆乱码。 */
  maxCells?: number
  /** 覆盖自动分配的字形（方块规范串 → 单个字符）。 */
  glyphs?: Record<string, string>
}

export interface SliceLegendEntry {
  glyph: string
  block: string
  count: number
}

export interface SliceResult {
  /** 可直接喂给 LLM 的文本。 */
  text: string
  legend: SliceLegendEntry[]
  columns: number
  rows: number
  columnAxis: SliceAxis
  rowAxis: SliceAxis
  /** 该切片的包围盒（在切片平面内）。 */
  extent: Bounds
}

/** 空气固定用 `.`，其余按出现次数从多到少分配。 */
const AIR_GLYPH = '.'
const GLYPHS = '#%*=-~:;<>@$&ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'

export const DEFAULT_MAX_SLICE_CELLS = 4096

/**
 * 把一层切片渲染成 **ASCII 平面图**。
 *
 * 这是 LLM 做精确编辑的主力工具，也是本 harness 最重要的一条成本优化：
 * 一个 16×16 层的输出约 300 token，而一张图约 350 token **且模型看到的只有 ~800×800**
 * （见 plan §9.5）。文本还能让 LLM 数格子不错位。
 *
 * 坐标轴约定：
 * - `axis: 'y'`（俯视平面图）→ 列是 x，行是 z，行号自上而下递增
 * - `axis: 'x'` / `axis: 'z'`（立面图）→ 列是另一个水平轴，行是 y，**行号自下而上**（按建筑习惯）
 */
export function renderSlice(store: WorldStore, options: SliceOptions): SliceResult {
  const { axis, index } = options
  const maxCells = options.maxCells ?? DEFAULT_MAX_SLICE_CELLS

  const { columnAxis, rowAxis } = planeAxes(axis)
  const columnRange = axisRange(store, options.range, columnAxis)
  const rowRange = axisRange(store, options.range, rowAxis)
  const columns = columnRange[1] - columnRange[0] + 1
  const rows = rowRange[1] - rowRange[0] + 1

  if (columns <= 0 || rows <= 0) {
    throw new RangeError(`Slice range is empty: ${columnAxis}[${columnRange}] × ${rowAxis}[${rowRange}]`)
  }
  if (columns * rows > maxCells) {
    throw new RangeError(
      `Slice has ${columns}×${rows} = ${columns * rows} cells, exceeding the limit ${maxCells}. ` +
        `Shrink the range or use a smaller volume.`,
    )
  }

  // 立面图按建筑习惯自上而下读（y 递减），平面图按地图习惯（z 递增）。
  // **行坐标必须先算出来，取样与标号共用它**——否则会出现"标号 y=9 实际显示 y=0"的错位。
  const rowAscending = axis === 'y'
  const rowCoords: number[] = []
  for (let r = 0; r < rows; r++) {
    rowCoords.push(rowAscending ? rowRange[0] + r : rowRange[1] - r)
  }

  // 第一遍：统计每个方块出现次数，用于分配字形
  const counts = new Map<string, number>()
  const cells: string[] = new Array(columns * rows)
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < columns; c++) {
      const block = store.getBlockString(
        positionOf(axis, index, columnAxis, columnRange[0] + c, rowAxis, rowCoords[r]!),
      )
      cells[r * columns + c] = block
      counts.set(block, (counts.get(block) ?? 0) + 1)
    }
  }

  const airBlock = 'minecraft:air'
  const glyphOf = new Map<string, string>()
  glyphOf.set(airBlock, AIR_GLYPH)
  if (options.glyphs !== undefined) {
    for (const [block, glyph] of Object.entries(options.glyphs)) glyphOf.set(block, glyph)
  }
  const rest = [...counts.keys()]
    .filter((b) => b !== airBlock)
    .sort((a, b) => (counts.get(b) ?? 0) - (counts.get(a) ?? 0) || a.localeCompare(b))
  let next = 0
  for (const block of rest) {
    if (glyphOf.has(block)) continue
    glyphOf.set(block, GLYPHS[next] ?? '?')
    next++
  }

  const legend: SliceLegendEntry[] = [...counts.entries()]
    .map(([block, count]) => ({ glyph: glyphOf.get(block)!, block, count }))
    .sort((a, b) => b.count - a.count || a.block.localeCompare(b.block))

  const text = compose({
    axis,
    index,
    columnAxis,
    rowAxis,
    columnRange,
    rowRange,
    columns,
    rows,
    cells,
    rowCoords,
    glyphOf,
    legend,
  })

  return {
    text,
    legend,
    columns,
    rows,
    columnAxis,
    rowAxis,
    extent: boundsOf(axis, index, columnAxis, columnRange, rowAxis, rowRange),
  }
}

function planeAxes(axis: SliceAxis): { columnAxis: SliceAxis; rowAxis: SliceAxis } {
  if (axis === 'y') return { columnAxis: 'x', rowAxis: 'z' }
  if (axis === 'x') return { columnAxis: 'z', rowAxis: 'y' }
  return { columnAxis: 'x', rowAxis: 'y' }
}

function axisRange(
  store: WorldStore,
  range: SliceRange | undefined,
  axis: SliceAxis,
): [number, number] {
  const requested = range?.[axis]
  const fallback: [number, number] =
    axis === 'y' ? [store.minY, store.maxY] : [store.volume.min[axis], store.volume.max[axis]]
  if (requested === undefined) return fallback
  return [Math.min(requested[0], requested[1]), Math.max(requested[0], requested[1])]
}

function positionOf(
  sliceAxis: SliceAxis,
  sliceIndex: number,
  columnAxis: SliceAxis,
  column: number,
  rowAxis: SliceAxis,
  row: number,
): { x: number; y: number; z: number } {
  const pos = { x: 0, y: 0, z: 0 }
  pos[sliceAxis] = sliceIndex
  pos[columnAxis] = column
  pos[rowAxis] = row
  return pos
}

function boundsOf(
  sliceAxis: SliceAxis,
  sliceIndex: number,
  columnAxis: SliceAxis,
  columnRange: readonly [number, number],
  rowAxis: SliceAxis,
  rowRange: readonly [number, number],
): Bounds {
  const min = { x: 0, y: 0, z: 0 }
  const max = { x: 0, y: 0, z: 0 }
  min[sliceAxis] = max[sliceAxis] = sliceIndex
  min[columnAxis] = columnRange[0]
  max[columnAxis] = columnRange[1]
  min[rowAxis] = rowRange[0]
  max[rowAxis] = rowRange[1]
  return { min, max }
}

interface ComposeInput {
  axis: SliceAxis
  index: number
  columnAxis: SliceAxis
  rowAxis: SliceAxis
  columnRange: readonly [number, number]
  rowRange: readonly [number, number]
  columns: number
  rows: number
  cells: string[]
  /** 每一行对应的坐标（第 0 行在最上面）。 */
  rowCoords: number[]
  glyphOf: Map<string, string>
  legend: SliceLegendEntry[]
}

function compose(input: ComposeInput): string {
  const { axis, index, columnAxis, rowAxis, columnRange, rowRange, columns, rows, cells, glyphOf } = input

  const rowLabelWidth = Math.max(String(rowRange[0]).length, String(rowRange[1]).length)
  const gutter = ` ${rowAxis} `.padEnd(rowLabelWidth + 2)
  const lines: string[] = []

  lines.push(
    `slice(axis=${axis}, index=${index})  ${columnAxis}[${columnRange[0]}..${columnRange[1]}]  ` +
      `${rowAxis}[${rowRange[0]}..${rowRange[1]}]  (${columns}x${rows})`,
  )
  lines.push(
    `legend: ${input.legend
      .map((e) => `${e.glyph} = ${e.block} (${e.count})`)
      .join('   ')}`,
  )

  // 列标尺：十位 + 个位两行，方便数格子
  const tensRow = buildRuler(columnRange, columns, (value) =>
    value % 10 === 0 ? String(Math.floor(value / 10) % 10) : ' ',
  )
  const onesRow = buildRuler(columnRange, columns, (value) => String(Math.abs(value) % 10))
  const indent = ' '.repeat(gutter.length)
  lines.push(`${indent}  ${columnAxis}→`)
  lines.push(`${indent}  ${tensRow}`)
  lines.push(`${indent}  ${onesRow}`)

  for (let r = 0; r < rows; r++) {
    let row = ''
    for (let c = 0; c < columns; c++) {
      row += glyphOf.get(cells[r * columns + c]!) ?? '?'
    }
    const label = String(input.rowCoords[r]!).padStart(rowLabelWidth)
    lines.push(`${gutter}${label}|${row}|`)
  }

  return lines.join('\n')
}

function buildRuler(
  range: readonly [number, number],
  length: number,
  render: (value: number) => string,
): string {
  let out = ''
  for (let i = 0; i < length; i++) out += render(range[0] + i)
  return out
}
