import {
  forEachBox,
  forEachExtrude,
  forEachLine,
  forEachPlane,
  StateError,
  symmetrize,
} from '@architect/core'
import type { WorldStore, WriteMode, WriteResult } from '@architect/core'

import { arr, blockRef, bool, int, num, obj, vec2, vec3 } from '../schema.js'
import { defineTool, failure } from '../types.js'
import type { ToolContext, ToolResult } from '../types.js'

/**
 * 一次编辑操作的**几何意图**：它会覆盖哪些格子、要写成什么。
 *
 * 把"算哪些格子"和"落盘"分开，是为了让 `run_batch` 能把多个操作**合并成一次写入**——
 * 一个 revision、一次 dry-run 确认、一张截图（plan §8.1）。
 * 两条路径共用同一份几何，所以批处理里的 `fill_box` 与单独调用的 `fill_box`
 * 覆盖的格子必然一致。
 */
/** `emit` 的第三个参数按格覆盖默认方块下标；单材质操作不传它。 */
export type CellEmitter = (x: number, y: number, z: number, blockIndex?: number) => void

export interface EditPlan {
  /** 逐格吐出坐标。**只收集，不落盘**——落盘由调用方统一做。 */
  cells: (emit: CellEmitter) => void
  /** 默认方块在调色板里的下标。`mode === 'destroy'` 时无意义。 */
  blockIndex: number
  mode: WriteMode
}

/**
 * 把计划落盘。单工具与批处理都走这一条。
 *
 * 走 `writeBlocks` 而不是 `write`，是因为**粘贴**这类操作每一格的方块都不同，
 * 而 `write` 只接受一个方块下标。单材质操作把 `blockIndex` 当默认值用，行为完全一样。
 */
export function commitPlan(
  ctx: ToolContext,
  tool: string,
  args: unknown,
  plan: EditPlan,
  confirm: boolean,
): ToolResult {
  const result = ctx.store.writeBlocks((emit) => plan.cells((x, y, z, blockIndex) => emit(x, y, z, blockIndex ?? plan.blockIndex)), {
    mode: plan.mode,
    confirm,
  })
  return writeResultToTool(ctx, tool, args, result)
}

/** 把校验过的 `[x,y,z]` 转成 `Pos`。 */
export function toPos(value: unknown, field: string): { x: number; y: number; z: number } {
  if (!Array.isArray(value) || value.length !== 3) {
    throw new Error(`${field} must be [x,y,z]`)
  }
  const [x, y, z] = value as number[]
  return { x: Math.round(x!), y: Math.round(y!), z: Math.round(z!) }
}

/**
 * 把 `WriteResult` 翻成给 LLM 的工具结果。
 *
 * **`NEEDS_CONFIRM` 是这里的重点**：dry-run 预览带着"要覆盖什么"的分类统计还回去，
 * LLM 必须先解释清楚才能带 `confirm: true` 重发（plan §9.4 机制 3）。
 */
export function writeResultToTool(
  ctx: ToolContext,
  tool: string,
  args: unknown,
  result: WriteResult,
): ToolResult {
  if (!result.ok) {
    if (result.reason === 'NEEDS_CONFIRM') {
      const preview = result.preview
      const breakdown = Object.entries(preview.overwriteBreakdown)
        .map(([name, count]) => `${name}×${count}`)
        .join(', ')
      const sample = preview.sample.map((p) => `[${p.x},${p.y},${p.z}]`).join(' ')
      return {
        ok: false,
        summary:
          `This operation would change ${preview.willChange} cells, overwriting ${preview.willOverwriteNonAir} non-air cells, ` +
          `over the confirm threshold. Blocks overwritten: ${breakdown || '(none)'}. Sample positions: ${sample}`,
        data: { preview, needsConfirm: true },
        error: {
          code: 'NEEDS_CONFIRM',
          message: 'Operation size exceeds the threshold and needs explicit confirmation',
          hint: 'First explain what is being overwritten and why that is acceptable, then call the same tool again with confirm: true.',
        },
      }
    }
    return failure(
      'TOO_LARGE',
      `Operation exceeds the hard limit (aborted after scanning ${result.preview.willChange} cells)`,
      'Split it into several smaller operations.',
    )
  }

  ctx.record(tool, args, result)
  const bounds = result.bounds
  const where =
    bounds === undefined
      ? '(no change)'
      : `(${bounds.min.x},${bounds.min.y},${bounds.min.z})..(${bounds.max.x},${bounds.max.y},${bounds.max.z})`
  const notes: string[] = []
  if (result.overwrittenNonAir > 0) notes.push(`overwrote ${result.overwrittenNonAir} non-air cells`)
  if (result.clipped > 0) notes.push(`clipped ${result.clipped} cells (outside the world height)`)
  if (result.changed === 0) notes.push('no changes made')

  return {
    ok: true,
    summary:
      `changed ${result.changed} cells, bounds ${where}. revision ${result.revision}.` +
      (notes.length > 0 ? ` (${notes.join('; ')})` : ''),
    data: {
      revision: result.revision,
      changed: result.changed,
      overwrittenNonAir: result.overwrittenNonAir,
      clipped: result.clipped,
      bounds,
    },
  }
}

const CONFIRM = bool('Explicitly confirm an operation that exceeds the threshold. Decide after reading the dry-run preview.')
const MODE = {
  type: 'string' as const,
  description: 'Write mode. replace = unconditional overwrite; keep = only write where there is air; overlay = only overwrite non-air (recolor an existing structure).',
  enum: ['replace', 'keep', 'overlay'] as const,
}

/** 解析方块引用并加入调色板；失败时给出可自纠的错误。 */
export function resolveBlock(store: WorldStore, ref: string): number | ToolResult {
  try {
    return store.palette.indexOf(ref)
  } catch (error) {
    if (!(error instanceof StateError)) throw error
    // 拼错方块名是多轮会话里最常见的一次性失败。只回一句 "unknown" 没有用——
    // 给出候选名字，模型下一轮就能自己改对（plan §8.4：错误必须可自纠）。
    const suggestions = suggestBlocks(store, ref)
    const hint =
      suggestions.length > 0
        ? `Did you mean: ${suggestions.join(', ')}? ` +
          `Properties go in square brackets, e.g. minecraft:oak_stairs[facing=north].`
        : 'Call search_blocks with a short substring to list valid names, and check property spelling.'
    return failure('UNKNOWN_BLOCK', `Unknown block "${ref}".`, hint, {
      name: ref,
      suggestions: suggestions.join(', '),
    })
  }
}

/**
 * 从写错的方块名猜几个候选。
 *
 * 两条**便宜且可解释**的启发式，不引入编辑距离依赖：
 * ① 去掉属性与 `minecraft:` 前缀后做包含匹配；② 按 `_` 切词，词元全中的排前面。
 */
function suggestBlocks(store: WorldStore, ref: string): string[] {
  const bare = ref
    .replace(/^minecraft:/, '')
    .replace(/\[.*$/, '')
    .toLowerCase()
  if (bare.length === 0) return []

  const tokens = bare.split('_').filter((token) => token.length > 1)
  const scored: Array<{ name: string; score: number }> = []
  for (const name of store.registry.blockNames) {
    if (name === bare) continue
    let score = 0
    if (name.includes(bare)) score = 100
    else if (bare.includes(name)) score = 90
    else if (tokens.length > 0) {
      const parts = name.split('_')
      const hits = tokens.filter((token) => parts.some((part) => part.includes(token))).length
      // 必须**全部词元**命中：「oak_lamp」不该召回一堆无关的 oak_*
      if (hits === tokens.length) score = 50 + hits
    }
    if (score > 0) scored.push({ name, score })
  }
  scored.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name))
  return scored.slice(0, 5).map((entry) => `minecraft:${entry.name}`)
}

/** 计划函数返回 `EditPlan` 表示成功、返回 `ToolResult` 表示失败。 */
export function isToolResult<T>(value: T | ToolResult): value is ToolResult {
  return typeof value === 'object' && value !== null && 'ok' in value
}

export const fillBoxTool = defineTool<{
  from: number[]
  to: number[]
  block: string
  mode?: 'replace' | 'keep' | 'overlay' | 'hollow' | 'outline' | 'destroy'
  confirm?: boolean
}>({
  name: 'fill_box',
  description:
    'Fill an axis-aligned box. This is the most-used bulk tool: one call can change thousands of cells — do not place blocks one by one with place_block.\n' +
    'mode: replace (default, unconditional overwrite) / keep (only write where there is air, without destroying existing content) / overlay (only overwrite non-air, recolor a structure)' +
    '/ hollow (keep only the shell, hollow out the inside) / outline (keep only the 12 edges) / destroy (delete, ignores the block argument).\n' +
    'from and to are two corners of a closed interval, in any order. The world has no writable boundary, so any X/Z is accepted; only world height (Y) is clipped, and clipping is reported faithfully.',
  parameters: obj(
    {
      from: vec3('start coordinate [x,y,z]'),
      to: vec3('end coordinate [x,y,z]'),
      block: blockRef('block, e.g. "minecraft:stone" or "oak_stairs[facing=east]". Ignored when mode=destroy.'),
      mode: {
        type: 'string',
        description: 'Write mode and shape, see the tool description.',
        enum: ['replace', 'keep', 'overlay', 'hollow', 'outline', 'destroy'],
        default: 'replace',
      },
      confirm: CONFIRM,
    },
    ['from', 'to', 'block'],
  ),
  mutating: true,
  destructive: true,
  execute: (ctx, args) => {
    const from = toPos(args.from, 'from')
    const to = toPos(args.to, 'to')
    const plan = planFillBox(ctx.store, from, to, args.block, args.mode)
    if (isToolResult(plan)) return plan
    return commitPlan(ctx, 'fill_box', args, plan, args.confirm === true)
  },
})

/** `fill_box` 的几何：H 形状模式（hollow/outline）落到写入模式 `replace` 上。 */
export function planFillBox(
  store: WorldStore,
  from: { x: number; y: number; z: number },
  to: { x: number; y: number; z: number },
  block: string,
  mode?: 'replace' | 'keep' | 'overlay' | 'hollow' | 'outline' | 'destroy',
): EditPlan | ToolResult {
  const requested = mode ?? 'replace'
  const shape = requested === 'hollow' ? 'hollow' : requested === 'outline' ? 'outline' : 'solid'
  const writeMode: WriteMode = requested === 'hollow' || requested === 'outline' ? 'replace' : requested

  let blockIndex = 0
  if (writeMode !== 'destroy') {
    const resolved = resolveBlock(store, block)
    if (isToolResult(resolved)) return resolved
    blockIndex = resolved
  }
  return { cells: (emit) => forEachBox(from, to, shape, emit), blockIndex, mode: writeMode }
}

export const fillLineTool = defineTool<{
  from: number[]
  to: number[]
  block: string
  radius?: number
  taper?: number[]
  step?: number
  hollow?: boolean
  mode?: 'replace' | 'keep' | 'overlay'
  confirm?: boolean
}>({
  name: 'fill_line',
  description:
    '**Bulk fill along a diagonal or any direction**: place blocks along the 3D line from→to. Use it for columns, beams, braces and spires; do not fill cell by cell in a loop.\n' +
    'radius is the "upper bound on the distance from a block center to the axis", so an integer R gives a column exactly 2R+1 cells thick (R=1→3 cells, R=3→7 cells). The ends are spherical caps, not flat.\n' +
    'taper=[start,end] varies the radius linearly along the line, for tapered spires or tree-trunk taper. step>1 samples sparsely along the line (scaffolding, fence posts).\n' +
    'hollow=true keeps only a one-cell shell.',
  parameters: obj(
    {
      from: vec3('start coordinate [x,y,z]'),
      to: vec3('end coordinate [x,y,z]'),
      block: blockRef('Block reference.'),
      radius: num('Radius. 0 (default) is a one-cell-thick line. An integer R gives 2R+1 cells thick.', { minimum: 0 }),
      taper: arr('Start and end radius along the line [start,end], for a taper. Overrides radius.', num('radius'), {
        minItems: 2,
        maxItems: 2,
      }),
      step: int('Sample every step cells along the line; 1 (default) is continuous.', { minimum: 1 }),
      hollow: bool('Keep only a one-cell shell (only effective when radius > 0).'),
      mode: MODE,
      confirm: CONFIRM,
    },
    ['from', 'to', 'block'],
  ),
  mutating: true,
  destructive: false,
  execute: (ctx, args) => {
    const plan = planFillLine(ctx.store, args)
    if (isToolResult(plan)) return plan
    return commitPlan(ctx, 'fill_line', args, plan, args.confirm === true)
  },
})

export function planFillLine(
  store: WorldStore,
  args: {
    from: number[]
    to: number[]
    block: string
    radius?: number
    taper?: number[]
    step?: number
    hollow?: boolean
    mode?: 'replace' | 'keep' | 'overlay'
  },
): EditPlan | ToolResult {
  const from = toPos(args.from, 'from')
  const to = toPos(args.to, 'to')
  const resolved = resolveBlock(store, args.block)
  if (isToolResult(resolved)) return resolved

  const options: Parameters<typeof forEachLine>[2] = {
    radius: args.radius ?? 0,
    step: args.step ?? 1,
    hollow: args.hollow === true,
  }
  if (args.taper !== undefined) options.taper = [args.taper[0]!, args.taper[1]!]

  return {
    cells: (emit) => forEachLine(from, to, options, emit),
    blockIndex: resolved,
    mode: args.mode ?? 'replace',
  }
}

export const placeBlockTool = defineTool<{ pos: number[]; block: string }>({
  name: 'place_block',
  description:
    'Place a **single** block. Use it only when you really need to change one cell (e.g. patch a gap) — for bulk work use fill_box / fill_line / extrude.',
  parameters: obj({ pos: vec3('block coordinate [x,y,z]'), block: blockRef('Block reference.') }, ['pos', 'block']),
  mutating: true,
  execute: (ctx, args) => {
    const plan = planPlaceBlock(ctx.store, args.pos, args.block)
    if (isToolResult(plan)) return plan
    return commitPlan(ctx, 'place_block', args, plan, true)
  },
})

export function planPlaceBlock(
  store: WorldStore,
  pos: number[],
  block: string,
): EditPlan | ToolResult {
  const target = toPos(pos, 'pos')
  // 必须和其他工具一样先解析方块引用，否则未知方块会抛成不可自纠的 INTERNAL
  const resolved = resolveBlock(store, block)
  if (isToolResult(resolved)) return resolved
  return { cells: (emit) => emit(target.x, target.y, target.z), blockIndex: resolved, mode: 'replace' }
}

export const extrudeTool = defineTool<{
  points: number[][]
  baseY: number
  height: number
  block: string
  hollow?: boolean
  capTop?: boolean
  capBottom?: boolean
  confirm?: boolean
}>({
  name: 'extrude',
  description:
    'Extrude an XZ-plane polygon along +Y — **one of the most efficient tools**: draw one floor plan and grow it directly into a building.\n' +
    'Vertices are block coordinates, and the covered range includes the boundary (the rectangle (0,0)-(4,4) covers 5×5 cells).\n' +
    'hollow=true extrudes only the outline (walls); combined with capBottom (floor) / capTop (roof) you get a house "with floor, walls and roof".',
  parameters: obj(
    {
      points: arr(
        'Polygon vertices, closed in order, at least 3. Each item is [x,z].',
        vec2('vertex [x,z]'),
        { minItems: 3 },
      ),
      baseY: int('Y of the base plane.'),
      height: int('Extrusion height (cells).', { minimum: 1 }),
      block: blockRef('Block reference (or material pattern).'),
      hollow: bool('Extrude only the outline (walls), leaving the inside empty.'),
      capTop: bool('Whether to cap the top when hollow (roof). Default true.'),
      capBottom: bool('Whether to cap the bottom when hollow (floor). Default true.'),
      confirm: CONFIRM,
    },
    ['points', 'baseY', 'height', 'block'],
  ),
  mutating: true,
  destructive: false,
  execute: (ctx, args) => {
    const plan = planExtrude(ctx.store, args)
    if (isToolResult(plan)) return plan
    return commitPlan(ctx, 'extrude', args, plan, args.confirm === true)
  },
})

export function planExtrude(
  store: WorldStore,
  args: {
    points: number[][]
    baseY: number
    height: number
    block: string
    hollow?: boolean
    capTop?: boolean
    capBottom?: boolean
  },
): EditPlan | ToolResult {
  const polygon = args.points.map((p) => ({
    x: Math.round(p[0] ?? Number.NaN),
    z: Math.round(p[1] ?? Number.NaN),
  }))
  for (const [i, p] of polygon.entries()) {
    if (!Number.isFinite(p.x) || !Number.isFinite(p.z)) {
      return failure('INVALID_ARGS', `points[${i}] is not a valid [x,z]`)
    }
  }
  const resolved = resolveBlock(store, args.block)
  if (isToolResult(resolved)) return resolved

  const options: Parameters<typeof forEachExtrude>[1] = {
    baseY: args.baseY,
    height: args.height,
    hollow: args.hollow === true,
  }
  if (args.capTop !== undefined) options.capTop = args.capTop
  if (args.capBottom !== undefined) options.capBottom = args.capBottom

  return {
    cells: (emit) => forEachExtrude(polygon, options, emit),
    blockIndex: resolved,
    mode: 'replace',
  }
}

export const fillPlaneTool = defineTool<{
  p1: number[]
  p2: number[]
  p3: number[]
  block: string
  thickness?: number
  triangle?: boolean
  confirm?: boolean
}>({
  name: 'fill_plane',
  description:
    'Fill an **arbitrary plane** defined by three points — sloped roofs, braces, non-axis-aligned walls.\n' +
    'The plane passes through the cell centers of the three points; by default it **fills the whole plane inside the bounding box of the three points** (which is what you want for a roof); ' +
    'pass triangle: true to fill only that triangle.\n' +
    'Three collinear points raise an error.',
  parameters: obj(
    {
      p1: vec3('first point [x,y,z]'),
      p2: vec3('second point [x,y,z]'),
      p3: vec3('third point [x,y,z]'),
      block: blockRef('Block reference.'),
      thickness: num('Thickness (cells), default 1 (exactly one layer).', { minimum: 1 }),
      triangle: bool('Fill only the triangle formed by the three points instead of the whole bounding-box plane. Default false.'),
      confirm: CONFIRM,
    },
    ['p1', 'p2', 'p3', 'block'],
  ),
  mutating: true,
  destructive: false,
  execute: (ctx, args) => {
    let plan: EditPlan | ToolResult
    try {
      plan = planFillPlane(ctx.store, args)
    } catch (error) {
      if (error instanceof RangeError) {
        return failure('INVALID_ARGS', error.message, 'The three points must not be collinear.')
      }
      throw error
    }
    if (isToolResult(plan)) return plan
    return commitPlan(ctx, 'fill_plane', args, plan, args.confirm === true)
  },
})

export function planFillPlane(
  store: WorldStore,
  args: { p1: number[]; p2: number[]; p3: number[]; block: string; thickness?: number; triangle?: boolean },
): EditPlan | ToolResult {
  const p1 = toPos(args.p1, 'p1')
  const p2 = toPos(args.p2, 'p2')
  const p3 = toPos(args.p3, 'p3')
  const resolved = resolveBlock(store, args.block)
  if (isToolResult(resolved)) return resolved

  const options: Parameters<typeof forEachPlane>[3] = {}
  if (args.thickness !== undefined) options.thickness = args.thickness
  if (args.triangle !== undefined) options.triangle = args.triangle

  // `forEachPlane` 对共线三点抛 RangeError。**必须在收集阶段就抛**——
  // 否则错误会推迟到落盘，批处理里就没法干净地整体中止了。
  const probe: Array<[number, number, number]> = []
  forEachPlane(p1, p2, p3, options, (x, y, z) => probe.push([x, y, z]))

  return {
    cells: (emit) => {
      for (const [x, y, z] of probe) emit(x, y, z)
    },
    blockIndex: resolved,
    mode: 'replace',
  }
}

export const eraserTool = defineTool<{ from: number[]; to: number[]; confirm?: boolean }>({
  name: 'erase',
  description: 'Delete blocks inside a box (equivalent to fill_box + mode=destroy, but more direct).',
  parameters: obj({ from: vec3('start [x,y,z]'), to: vec3('end [x,y,z]'), confirm: CONFIRM }, [
    'from',
    'to',
  ]),
  mutating: true,
  destructive: true,
  execute: (ctx, args) => {
    const plan = planErase(args.from, args.to)
    return commitPlan(ctx, 'erase', args, plan, args.confirm === true)
  },
})

export function planErase(fromRaw: number[], toRaw: number[]): EditPlan {
  const from = toPos(fromRaw, 'from')
  const to = toPos(toRaw, 'to')
  return { cells: (emit) => forEachBox(from, to, 'solid', emit), blockIndex: 0, mode: 'destroy' }
}

export const symmetrizeTool = defineTool<{
  axis: 'x' | 'y' | 'z'
  coordinate: number
  source: 'negative' | 'positive'
  clear?: boolean
  confirm?: boolean
}>({
  name: 'symmetrize',
  description:
    'Mirror across a plane: copy the source half **verbatim** onto the other half (preserving stair facing and material distribution). Build only half of a symmetric building, then call this.\n' +
    'The mirror plane passes through the **center** of the coordinate cell, so coordinate-1 maps to coordinate+1 and the coordinate cell maps to itself.\n' +
    'clear=false means "fill gaps only", without overwriting what already exists on the target side.\n' +
    'Block facing **is remapped**: an east-facing stair becomes west-facing, door hinges swap sides, and sign rotation lands on the mirrored value. ' +
    '(A few orientations have no mirror-image encoding in 1.21.4 — walls have no `down` counterpart, and jigsaw `orientation` only declares 12 of 24 combinations. Those cells keep their original facing rather than being guessed.)',
  parameters: obj(
    {
      axis: { type: 'string', description: 'Which axis the mirror plane is perpendicular to.', enum: ['x', 'y', 'z'] },
      coordinate: int('Coordinate of the mirror plane.'),
      source: {
        type: 'string',
        description: 'Which side is the source. negative = the side with coordinates less than coordinate.',
        enum: ['negative', 'positive'],
      },
      clear: bool('Clear the target side before mirroring. Default true; false fills gaps only.'),
      confirm: CONFIRM,
    },
    ['axis', 'coordinate', 'source'],
  ),
  mutating: true,
  destructive: true,
  execute: (ctx, args) => {
    const options = {
      axis: args.axis,
      coordinate: args.coordinate,
      source: args.source,
      clear: args.clear !== false,
      confirm: args.confirm === true,
    }
    return writeResultToTool(ctx, 'symmetrize', args, symmetrize(ctx.store, options))
  },
})
