import { formatMeasure, measure, normalizeEntityName, renderSlice } from '@architect/core'
import type { Bounds, SliceAxis, WorldStore } from '@architect/core'

import { arr, blockRef, int, obj, str, vec3 } from '../schema.js'
import { defineTool, failure } from '../types.js'
import { toPos } from './edit.js'

export const sliceTool = defineTool<{
  axis: 'x' | 'y' | 'z'
  index: number
  x?: number[]
  y?: number[]
  z?: number[]
  maxCells?: number
}>({
  name: 'slice',
  description:
    'Render one slice as an **ASCII plan view** (with coordinate rulers and a legend) — **this is your main tool for precise editing**.\n' +
    'Use it to confirm "is this cell the block I think it is"; do not guess coordinates from a screenshot (one cell is only a few pixels there).\n' +
    'axis=y is a top-down plan (columns are x, rows are z); axis=x / axis=z are elevations (rows are y, top to bottom).\n' +
    'Limiting the range with the x/y/z arguments can compress the output to a few dozen lines. If the range is too large it errors and tells you how far to shrink it.',
  parameters: obj(
    {
      axis: { type: 'string', description: 'Which axis the slice is perpendicular to.', enum: ['x', 'y', 'z'] },
      index: int('Coordinate of the slice.'),
      x: arr('Render only this closed interval of x [start,end].', int('coordinate'), { minItems: 2, maxItems: 2 }),
      y: arr('Render only this closed interval of y [start,end].', int('coordinate'), { minItems: 2, maxItems: 2 }),
      z: arr('Render only this closed interval of z [start,end].', int('coordinate'), { minItems: 2, maxItems: 2 }),
      maxCells: int('Cell limit, default 4096.', { minimum: 16 }),
    },
    ['axis', 'index'],
  ),
  execute: (ctx, args) => {
    const range: Record<string, [number, number]> = {}
    for (const axis of ['x', 'y', 'z'] as const) {
      const value = args[axis]
      if (value !== undefined) range[axis] = [value[0]!, value[1]!]
    }
    try {
      const result = renderSlice(ctx.store, {
        axis: args.axis as SliceAxis,
        index: args.index,
        ...(Object.keys(range).length > 0 ? { range } : {}),
        ...(args.maxCells !== undefined ? { maxCells: args.maxCells } : {}),
      })
      return {
        ok: true,
        summary: result.text,
        data: {
          axis: args.axis,
          index: args.index,
          columns: result.columns,
          rows: result.rows,
          legend: result.legend,
        },
      }
    } catch (error) {
      if (error instanceof RangeError) {
        return failure('INVALID_ARGS', error.message, 'Shrink the range with the x/y/z arguments, or use a different index.')
      }
      throw error
    }
  },
})

export const measureTool = defineTool<Record<string, never>>({
  name: 'measure',
  description:
    'World size and material histogram: bounding box, width/height/depth, total non-air blocks, and the count and share of each block type.\n' +
    '**Use it to confirm scale before you start** ("how long is this wall really"), and before claiming completion to check the size against the requirement.',
  parameters: obj({}),
  execute: (ctx) => {
    const result = measure(ctx.store)
    return { ok: true, summary: formatMeasure(result), data: { ...result } }
  },
})

export const getBlockTool = defineTool<{ pos: number[] }>({
  name: 'get_block',
  description: 'Read the block at a single cell (returns the full state string, e.g. minecraft:oak_stairs[facing=east,...]).',
  parameters: obj({ pos: vec3('block coordinate [x,y,z]') }, ['pos']),
  execute: (ctx, args) => {
    const pos = toPos(args.pos, 'pos')
    const block = ctx.store.getBlockString(pos)
    return {
      ok: true,
      summary: `[${pos.x},${pos.y},${pos.z}] = ${block}`,
      data: { pos, block, stateId: ctx.store.getBlockStateId(pos) },
    }
  },
})

export const getRegionTool = defineTool<{ from: number[]; to: number[]; axis?: 'x' | 'y' | 'z'; maxCells?: number }>({
  name: 'get_region',
  description:
    'Render a region layer by layer as ASCII (equivalent to calling slice per layer and concatenating). Use it only for small regions — ' +
    'with many layers the output gets long; usually calling slice for a single layer is better.',
  parameters: obj(
    {
      from: vec3('start [x,y,z]'),
      to: vec3('end [x,y,z]'),
      axis: { type: 'string', description: 'Which axis to slice along, default y.', enum: ['x', 'y', 'z'] },
      maxCells: int('Cell limit per layer, default 1024.', { minimum: 16 }),
    },
    ['from', 'to'],
  ),
  execute: (ctx, args) => {
    const from = toPos(args.from, 'from')
    const to = toPos(args.to, 'to')
    const axis: SliceAxis = args.axis ?? 'y'
    const lo = Math.min(from[axis], to[axis])
    const hi = Math.max(from[axis], to[axis])
    if (hi - lo + 1 > 8) {
      return failure(
        'INVALID_ARGS',
        `This region has ${hi - lo + 1} layers along ${axis}, the output would be too long`,
        'Shrink the region, or use slice to inspect one layer at a time.',
      )
    }
    const parts: string[] = []
    for (let index = lo; index <= hi; index++) {
      const result = renderSlice(ctx.store, {
        axis,
        index,
        range: {
          x: [Math.min(from.x, to.x), Math.max(from.x, to.x)],
          y: [Math.min(from.y, to.y), Math.max(from.y, to.y)],
          z: [Math.min(from.z, to.z), Math.max(from.z, to.z)],
        },
        maxCells: args.maxCells ?? 1024,
      })
      parts.push(result.text)
    }
    return {
      ok: true,
      summary: parts.join('\n\n'),
      data: { layers: hi - lo + 1, axis },
    }
  },
})

export const searchBlocksTool = defineTool<{ query: string; limit?: number }>({
  name: 'search_blocks',
  description:
    'Search available blocks by name substring (e.g. "stairs", "planks", "oak"). Use it when unsure how a block name is spelled.',
  parameters: obj(
    { query: str('Search substring, case-insensitive.'), limit: int('Maximum number to return, default 20.', { minimum: 1 }) },
    ['query'],
  ),
  execute: (ctx, args) => {
    const query = args.query.toLowerCase()
    const matches = ctx.store.registry.blockNames.filter((name) => name.includes(query))
    const limit = args.limit ?? 20
    const shown = matches.slice(0, limit)
    if (matches.length === 0) {
      return failure('NOT_FOUND', `No block name contains "${args.query}"`, 'Try a shorter substring.')
    }
    return {
      ok: true,
      summary:
        `matched ${matches.length} types${matches.length > shown.length ? ` (showing first ${shown.length})` : ''}: ` +
        shown.map((n) => `minecraft:${n}`).join(', '),
      data: { total: matches.length, matches: shown.map((n) => `minecraft:${n}`) },
    }
  },
})

/** `verify` 的单条 claim。 */
interface Claim {
  check:
    | 'block_at'
    | 'air_at'
    | 'count'
    | 'supported'
    | 'symmetric'
    | 'entity_at'
    | 'entity_count'
    | 'block_entity_at'
  pos?: number[]
  expect?: string
  block?: string
  /** 实体类型（`entity_at` 期望的、`entity_count` 统计的）。**不是方块名**。 */
  type?: string
  from?: number[]
  to?: number[]
  min?: number
  max?: number
  axis?: 'x' | 'y' | 'z'
  coordinate?: number
}

export const verifyTool = defineTool<{ claims: Claim[] }>({
  name: 'verify',
  description:
    '**Structured self-check**: submit a set of "expectations"; the engine judges each one pass/fail and reports the actual value.\n' +
    'After any modification call it to read back the result before claiming completion — **it is forbidden to say "done" without reading back**.\n' +
    'Before calling it you must write down your expectations in claims; if you cannot, you have not thought through what you are doing.\n' +
    'Available checks: block_at (a cell is a given block — write properties in brackets to also constrain them, e.g. `minecraft:oak_stairs[facing=west]`; properties you omit are not constrained) / air_at (a cell is air) / count (the count of a block is within a range)' +
    '/ supported (no floating blocks in a region — floating means the whole column below is empty down to the reference region floor AND nothing sits directly above; a ceiling on a wall or a hanging lantern is fine) / symmetric (symmetric across a plane)' +
    ' / entity_at (an entity of a given type is in a cell — **use this after place_entity**) / entity_count (how many entities of a type are in a region; give min and/or max)' +
    ' / block_entity_at (a cell carries block entity data, optionally of a given kind).',
  parameters: obj(
    {
      claims: arr(
        'List of expectations. Each item looks like {check:"block_at", pos:[x,y,z], expect:"minecraft:air"}.',
        obj(
          {
            check: {
              type: 'string',
              description: 'Check type.',
              enum: [
                'block_at',
                'air_at',
                'count',
                'supported',
                'symmetric',
                'entity_at',
                'entity_count',
                'block_entity_at',
              ],
            },
            pos: vec3('Coordinate used by block_at / air_at.'),
            expect: blockRef(
              'Expected block for block_at. With no brackets only the block name is compared. ' +
                'With brackets, **every property you write must match** and properties you omit are ignored — ' +
                'so `minecraft:oak_stairs[facing=west]` checks the facing without pinning half/shape.',
            ),
            block: str('Block name used by count.'),
            type: str(
              'Entity type used by entity_at (what entity_at expects) and entity_count (what it counts), ' +
                'e.g. "minecraft:oak_boat". **Not** a block name — entities are a separate layer from blocks.',
            ),
            from: vec3('Region start for count / supported / symmetric.'),
            to: vec3('Region end for count / supported / symmetric.'),
            min: int('Lower bound for count.'),
            max: int('Upper bound for count.'),
            axis: { type: 'string', description: 'Symmetry axis for symmetric.', enum: ['x', 'y', 'z'] },
            coordinate: int('Mirror coordinate for symmetric.'),
          },
          ['check'],
        ),
        { minItems: 1 },
      ),
    },
    ['claims'],
  ),
  execute: (ctx, args) => {
    const results = args.claims.map((claim, index) => checkClaim(ctx.store, claim, index))
    const failed = results.filter((r) => !r.pass)
    const lines = results.map(
      (r) => `${r.pass ? 'PASS' : 'FAIL'}  ${r.label}${r.detail !== undefined ? `  → ${r.detail}` : ''}`,
    )
    return {
      ok: failed.length === 0,
      summary: `${results.length - failed.length}/${results.length} passed\n${lines.join('\n')}`,
      data: {
        results,
        failed: failed.length,
        // 结构化读回：全部 claim 通过才算是真的读回了（plan §9.4 机制 1）
        readback: failed.length === 0,
      },
      ...(failed.length > 0
        ? {
            error: {
              code: 'NOT_FOUND' as const,
              message: `${failed.length} claims failed`,
              hint: 'Fix based on the actual values in the FAIL lines, then call verify again.',
            },
          }
        : {}),
    }
  },
})

interface ClaimResult {
  label: string
  pass: boolean
  detail?: string
}

function checkClaim(store: WorldStore, claim: Claim, index: number): ClaimResult {
  const id = `claim[${index}]`
  switch (claim.check) {
    case 'block_at': {
      if (claim.pos === undefined || claim.expect === undefined) {
        return { label: id, pass: false, detail: 'block_at requires pos and expect' }
      }
      const pos = toPos(claim.pos, 'pos')
      const actual = store.getBlockString(pos)
      // **写出来的属性是"必须匹配"，没写的不约束**——这是工具描述承诺的语义，
      // 也是 LLM 会自然采用的形式：`expect: "minecraft:oak_stairs[facing=west]"`
      // 应该只检查朝西，而不该因为 half/shape 没写就判失败。
      const expected = parseExpectation(claim.expect)
      const actualName = baseName(actual)
      let pass = actualName === expected.name
      if (pass && Object.keys(expected.properties).length > 0) {
        // 注意：`actual` 是**带方块名**的规范串，要先拆掉名字再取属性，
        // 否则第一对会解析成 `minecraft:oak_stairs[facing` = `west`
        const actualProps = parseExpectation(actual).properties
        for (const [name, value] of Object.entries(expected.properties)) {
          if (String(actualProps[name]) !== value) {
            pass = false
            break
          }
        }
      }
      return {
        label: `${id} block_at [${pos.x},${pos.y},${pos.z}] == ${claim.expect}`,
        pass,
        detail: pass ? undefined : `actual is ${actual}`,
      }
    }
    case 'air_at': {
      if (claim.pos === undefined) return { label: id, pass: false, detail: 'air_at requires pos' }
      const pos = toPos(claim.pos, 'pos')
      const actual = store.getBlockString(pos)
      return {
        label: `${id} air_at [${pos.x},${pos.y},${pos.z}]`,
        pass: actual === 'minecraft:air',
        detail: actual === 'minecraft:air' ? undefined : `actual is ${actual}`,
      }
    }
    case 'count': {
      if (claim.block === undefined) return { label: id, pass: false, detail: 'count requires block' }
      const target = baseName(normalizeRef(claim.block))
      const bounds = regionOf(claim)
      let count = 0
      store.forEachNonAir((x, y, z) => {
        if (bounds !== undefined && !inside(bounds, x, y, z)) return
        if (baseName(store.getBlockString({ x, y, z })) === target) count++
      })
      const min = claim.min ?? Number.NEGATIVE_INFINITY
      const max = claim.max ?? Number.POSITIVE_INFINITY
      const pass = count >= min && count <= max
      return {
        label: `${id} count(${claim.block}) ∈ [${claim.min ?? '-∞'}, ${claim.max ?? '+∞'}]`,
        pass,
        detail: pass ? undefined : `actual ${count}`,
      }
    }
    case 'supported': {
      const bounds = regionOf(claim)
      if (bounds === undefined) return { label: id, pass: false, detail: 'supported requires from/to' }
      // 判据：从该格往下**一直找到工区底板**，整列都没有非空气才算悬空。
      //
      // 两处必须说清楚，因为它们决定了这个检查到底有没有用：
      // ① 只看正下方会把天花板、桥面、悬挑这些正常结构误判为悬空，所以要扫整列。
      // ② 地面是**工区底板**而不是 `from/to` 的底。否则"一块悬空平台"只要
      //    自己就是被检查区域的最低层，就会被当成地面而漏报——那正是最该抓到的情形。
      // ③ 坐标样本**有上限**：几万条坐标拼进字符串既费 token 又费内存，
      //    而这个检查只需要知道"有几块、最早几块在哪"。
      const floor = store.volume.min.y
      let count = 0
      const sample: string[] = []
      store.forEachNonAir((x, y, z) => {
        if (!inside(bounds, x, y, z)) return
        if (y <= floor) return
        let supported = false
        for (let below = y - 1; below >= floor; below--) {
          if (!store.isAir({ x, y: below, z })) {
            supported = true
            break
          }
        }
        if (supported) return
        // 吊挂也算支撑：灯笼、挂式告示牌本来就该是"下面空着"的
        if (!store.isAir({ x, y: y + 1, z })) return
        count++
        if (sample.length < SUPPORTED_SAMPLE_LIMIT) sample.push(`[${x},${y},${z}]`)
      })
      return {
        label: `${id} supported region (${bounds.min.x},${bounds.min.y},${bounds.min.z})..(${bounds.max.x},${bounds.max.y},${bounds.max.z})`,
        pass: count === 0,
        detail:
          count === 0
            ? undefined
            : `${count} floating block(s), e.g. ${sample.join(' ')}${count > sample.length ? ' …' : ''}`,
      }
    }
    case 'symmetric': {
      if (claim.axis === undefined || claim.coordinate === undefined) {
        return { label: id, pass: false, detail: 'symmetric requires axis and coordinate' }
      }
      const bounds = regionOf(claim)
      if (bounds === undefined) return { label: id, pass: false, detail: 'symmetric requires from/to' }
      const axis = claim.axis
      const c = claim.coordinate
      let mismatches = 0
      let firstMismatch = ''
      for (let x = bounds.min.x; x <= bounds.max.x; x++) {
        for (let y = bounds.min.y; y <= bounds.max.y; y++) {
          for (let z = bounds.min.z; z <= bounds.max.z; z++) {
            const pos = { x, y, z }
            const mirrored =
              axis === 'x' ? { x: 2 * c - x, y, z } : axis === 'y' ? { x, y: 2 * c - y, z } : { x, y, z: 2 * c - z }
            if (store.getBlockString(pos) !== store.getBlockString(mirrored)) {
              mismatches++
              if (firstMismatch === '') {
                firstMismatch = `[${x},${y},${z}] ${store.getBlockString(pos)} ≠ [${mirrored.x},${mirrored.y},${mirrored.z}] ${store.getBlockString(mirrored)}`
              }
            }
          }
        }
      }
      return {
        label: `${id} symmetric along ${axis}=${c}`,
        pass: mismatches === 0,
        detail: mismatches === 0 ? undefined : `${mismatches} mismatches, e.g. ${firstMismatch}`,
      }
    }
    /**
     * 实体层的读回。**这是 `place_entity` 之后能过完成闸门的唯一途径**：
     * 闸门只认 `mutating && result.data.readback === true`（loop.ts），
     * 而方块类的 claim 读不到实体——没有这三条，模型改完实体就只能连吃两次
     * nudge，然后以 `unverified` 收场。
     */
    case 'entity_at': {
      if (claim.pos === undefined) return { label: id, pass: false, detail: 'entity_at requires pos' }
      const pos = toPos(claim.pos, 'pos')
      const here = store.entities.at(pos)
      const wanted = claim.type !== undefined ? normalizeEntityName(claim.type) : claim.expect !== undefined ? normalizeEntityName(claim.expect) : undefined
      const matched = wanted === undefined ? here : here.filter((entity) => entity.type === wanted)
      return {
        label: `${id} entity_at [${pos.x},${pos.y},${pos.z}]${wanted !== undefined ? ` == ${wanted}` : ''}`,
        pass: matched.length > 0,
        detail:
          matched.length > 0
            ? undefined
            : here.length === 0
              ? 'no entity in that cell'
              : `that cell holds ${here.map((entity) => entity.type).join(', ')}`,
      }
    }
    case 'entity_count': {
      const wanted =
        claim.type !== undefined
          ? normalizeEntityName(claim.type)
          : claim.expect !== undefined
            ? normalizeEntityName(claim.expect)
            : undefined
      if (wanted === undefined) {
        return { label: id, pass: false, detail: 'entity_count requires type (the entity type to count)' }
      }
      const bounds = regionOf(claim)
      let count = 0
      for (const entity of store.entities.list()) {
        if (entity.type !== wanted) continue
        if (bounds !== undefined && !inside(bounds, Math.floor(entity.x), Math.floor(entity.y), Math.floor(entity.z))) {
          continue
        }
        count++
      }
      const min = claim.min ?? 0
      const max = claim.max ?? Number.POSITIVE_INFINITY
      const pass = count >= min && count <= max
      return {
        label: `${id} entity_count ${wanted} in [${min},${max === Number.POSITIVE_INFINITY ? 'inf' : max}]`,
        pass,
        detail: pass ? undefined : `actual is ${count}`,
      }
    }
    case 'block_entity_at': {
      if (claim.pos === undefined) {
        return { label: id, pass: false, detail: 'block_entity_at requires pos' }
      }
      const pos = toPos(claim.pos, 'pos')
      const entity = store.blockEntities.at(pos)
      const wanted = claim.expect !== undefined ? normalizeEntityName(claim.expect) : undefined
      const pass = entity !== undefined && (wanted === undefined || entity.kind === wanted)
      return {
        label: `${id} block_entity_at [${pos.x},${pos.y},${pos.z}]${wanted !== undefined ? ` == ${wanted}` : ''}`,
        pass,
        detail: pass
          ? undefined
          : entity === undefined
            ? 'no block entity in that cell'
            : `actual is ${entity.kind}`,
      }
    }
    default:
      return { label: id, pass: false, detail: `Unknown check type ${String(claim.check)}` }
  }
}

const baseName = (ref: string): string => ref.replace(/^minecraft:/, '').split('[')[0]!

/** `supported` 检查回显的坐标样本上限——它只需要"最早几块在哪"，不需要全部。 */
const SUPPORTED_SAMPLE_LIMIT = 8

/** 把 `minecraft:oak_stairs[facing=west]` 拆成方块名 + **只列出用户写了的**属性。 */
function parseExpectation(ref: string): { name: string; properties: Record<string, string> } {
  const match = /^(?:minecraft:)?([a-z0-9_]+)(?:\[(.*)\])?$/.exec(ref.trim())
  if (match === null) return { name: baseName(ref), properties: {} }
  return { name: match[1]!, properties: parseProperties(match[2] ?? '') }
}

/** `facing=west,half=bottom` → `{facing:'west', half:'bottom'}`。空串得到空对象。 */
function parseProperties(text: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const pair of text.split(',')) {
    const trimmed = pair.trim()
    if (trimmed.length === 0) continue
    const eq = trimmed.indexOf('=')
    if (eq <= 0) continue
    out[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim()
  }
  return out
}

function normalizeRef(ref: string): string {
  return ref.startsWith('minecraft:') ? ref : `minecraft:${ref}`
}

function regionOf(claim: Claim): Bounds | undefined {
  if (claim.from === undefined || claim.to === undefined) return undefined
  const a = toPos(claim.from, 'from')
  const b = toPos(claim.to, 'to')
  return {
    min: { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), z: Math.min(a.z, b.z) },
    max: { x: Math.max(a.x, b.x), y: Math.max(a.y, b.y), z: Math.max(a.z, b.z) },
  }
}

function inside(bounds: Bounds, x: number, y: number, z: number): boolean {
  return (
    x >= bounds.min.x && x <= bounds.max.x &&
    y >= bounds.min.y && y <= bounds.max.y &&
    z >= bounds.min.z && z <= bounds.max.z
  )
}

export type { Claim, ClaimResult }
