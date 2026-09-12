import type { Bounds } from '../types.js'
import type { WorldStore } from '../world/store.js'

export type SliceAxis = 'x' | 'y' | 'z'

export interface SliceRange {
  x?: readonly [number, number]
  y?: readonly [number, number]
  z?: readonly [number, number]
}

/**
 * 一个落在切片平面上的实体。坐标是**浮点**，画图时取它所在的格。
 *
 * 为什么实体值得单独一层字形：D3 说精确编辑靠文本、审美才靠图。实体是浮点位置、
 * 一格能叠任意多个，模型在截图上根本数不出来——而这张 ASCII 图是它唯一能
 * "看见第 4 格上到底有没有船"的地方。
 */
export interface SliceEntityMark {
  x: number
  y: number
  z: number
  type: string
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
  /** 世界里的实体；落在这一层的会被盖在方块的格子上，并进图例。 */
  entities?: readonly SliceEntityMark[]
}

export interface SliceLegendEntry {
  glyph: string
  /** 方块规范串；`entity` 为真时这里是**实体类型**。 */
  block: string
  count: number
  /** 这一项是实体而不是方块。图例里要能一眼分开。 */
  entity?: boolean
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

/**
 * 实体的字形池。
 *
 * **必须从方块池里挖出来**：两套池子有重叠时，一个 `o` 会同时出现在
 * "o = minecraft:oak_planks" 与 "o = minecraft:oak_boat" 两行上，而图例正是
 * 模型读坐标的依据。只在真的有实体落在这一层时才挖——否则同一个世界的
 * `slice` 输出会在加了实体支持之后**整体改字形**，那是没有必要的回归。
 */
const ENTITY_GLYPHS = 'oO0@&$%+=~'

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
  // 实体**先**占字形：它们要从方块池里把字符挖走，所以得先知道自己用了哪些
  const marks = new Array<string | undefined>(columns * rows)
  const entityCounts = new Map<string, number>()
  for (const entity of options.entities ?? []) {
    const cell: Record<SliceAxis, number> = {
      x: Math.floor(entity.x),
      y: Math.floor(entity.y),
      z: Math.floor(entity.z),
    }
    if (cell[axis] !== index) continue // 不在这一层上
    const c = cell[columnAxis] - columnRange[0]
    const r = rowCoords.indexOf(cell[rowAxis])
    if (c < 0 || c >= columns || r < 0 || r >= rows) continue
    const glyph = entityGlyphFor(marks, entityCounts, entity.type)
    marks[r * columns + c] = glyph
  }

  const blockPool = entityCounts.size > 0 ? [...GLYPHS].filter((ch) => !ENTITY_GLYPHS.includes(ch)) : GLYPHS
  const rest = [...counts.keys()]
    .filter((b) => b !== airBlock)
    .sort((a, b) => (counts.get(b) ?? 0) - (counts.get(a) ?? 0) || a.localeCompare(b))
  let next = 0
  for (const block of rest) {
    if (glyphOf.has(block)) continue
    glyphOf.set(block, blockPool[next] ?? '?')
    next++
  }

  const legend: SliceLegendEntry[] = [...counts.entries()]
    .map(([block, count]) => ({ glyph: glyphOf.get(block)!, block, count }))
    .sort((a, b) => b.count - a.count || a.block.localeCompare(b.block))
  // 实体排在方块之后：方块那一段按出现次数排（主材在前），实体是少数派
  for (const [type, count] of [...entityCounts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))) {
    legend.push({ glyph: entityGlyphFor(marks, entityCounts, type), block: type, count, entity: true })
  }

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
    marks,
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

/** 给一种实体类型分配字形（同一层里每种类型一个），并累加它的出现次数。 */
function entityGlyphFor(
  _marks: Array<string | undefined>,
  counts: Map<string, number>,
  type: string,
): string {
  const existing = counts.get(type)
  counts.set(type, (existing ?? 0) + 1)
  // 插入顺序就是分配顺序（第一次见到某个类型时它才进这张表）
  const index = [...counts.keys()].indexOf(type)
  return ENTITY_GLYPHS[index] ?? '?'
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
  /**
   * 默认范围：**Y 仍是整个世界高度（那是真实上限），X/Z 跟着内容走**。
   *
   * 原来 X/Z 无条件回落到 `store.volume`，而世界已经没有可写边界了——建在老工区
   * 之外的东西会被这个默认范围整片截掉（调用方不传 range 时就发生）。
   * 内容包围盒回答的是"实际有什么"，而不是"当初声明允许在哪儿"。
   *
   * **没有任何内容时仍然回落到项目参考区域**：那时"跟内容走"没有意义（内容在
   * 原点那一格），而调用方（`slice` 工具、测试）期望的是"把这片地方画成空的"
   * ——包括"这片地方太大、拒绝渲染"那条提示。空世界给一张 1×1 的图反而是另一种错。
   */
  const fallback: [number, number] =
    axis === 'y'
      ? [store.minY, store.maxY]
      : ((): [number, number] => {
          const content = store.contentBounds()
          if (content === undefined) return [store.volume.min[axis], store.volume.max[axis]]
          return [content.min[axis], content.max[axis]]
        })()
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
  /** 实体盖在格子上的字形；`undefined` = 这一格没有实体。 */
  marks: Array<string | undefined>
  /** 每一行对应的坐标（第 0 行在最上面）。 */
  rowCoords: number[]
  glyphOf: Map<string, string>
  legend: SliceLegendEntry[]
}

function compose(input: ComposeInput): string {
  const { axis, index, columnAxis, rowAxis, columnRange, rowRange, columns, rows, cells, marks, glyphOf } = input

  const rowLabelWidth = Math.max(String(rowRange[0]).length, String(rowRange[1]).length)
  const gutter = ` ${rowAxis} `.padEnd(rowLabelWidth + 2)
  const lines: string[] = []

  lines.push(
    `slice(axis=${axis}, index=${index})  ${columnAxis}[${columnRange[0]}..${columnRange[1]}]  ` +
      `${rowAxis}[${rowRange[0]}..${rowRange[1]}]  (${columns}x${rows})`,
  )
  lines.push(
    `legend: ${input.legend
      .map((e) => `${e.glyph} = ${e.block}${e.entity === true ? ' [entity]' : ''} (${e.count})`)
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
      const i = r * columns + c
      // 实体盖在方块之上：同一格里两者都有时，先让人看见那个"多出来的东西"
      row += marks[i] ?? glyphOf.get(cells[i]!) ?? '?'
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
