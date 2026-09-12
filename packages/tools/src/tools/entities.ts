import {
  blockEntityKindOf,
  BLOCK_ENTITY_BLOCKS,
  loadEntityRegistry,
  MAX_BLOCK_ENTITIES,
  MAX_ENTITIES,
  nbtValueProblem,
  normalizeEntityName,
} from '@architect/core'
import type { Bounds, EntityChange, EntityRegistry, PlacedEntity } from '@architect/core'

import { arr, bool, int, num, obj, str, vec3 } from '../schema.js'
import { defineTool, failure } from '../types.js'
import type { ToolResult } from '../types.js'
import { toPos } from './edit.js'

/**
 * 实体层与方块实体层的工具。
 *
 * 这两层与方块层最大的差别是**没有格网**：实体是浮点位置、一格可以叠任意多个，
 * 方块实体是"方格子上挂着的注解"（一格一个，而且随方块消失）。所以这一组工具
 * 与 `fill_box` / `erase` 那一族的形状不同——它们按 **id 或区域**操作，而不是按格子。
 */

/**
 * 命名朝向 → `yaw` 的格点（0..15，每步 22.5°）。
 *
 * Minecraft 的 yaw：**0° 朝南（+Z）**，顺时针增大——90° 朝西、180° 朝北、270° 朝东。
 * 这个映射写错的表现是"船全都横着"，而模型分不出是映射错了还是自己选错了朝向。
 */
const FACING_YAW: Record<string, number> = { south: 0, west: 4, north: 8, east: 12 }

/** 格内偏移的默认值：16 分之 8 = 格心，y 贴地。 */
const DEFAULT_OFFSET: [number, number, number] = [8, 0, 8]

/** 世界坐标（浮点）→ 它所在的格。摘要里给人看的是格，不是小数。 */
const floorOf = (value: number): number => Math.floor(value)

const ENTITY_TYPE = str(
  'Entity type, e.g. "minecraft:oak_boat" — **not** a block name. ' +
    'Unknown types come back with suggestions; entities are counted separately from blocks.',
)
const CELL = vec3('The cell (integer block coordinates).')

const REGION = obj(
  {
    from: vec3('First corner of a closed box, inclusive.'),
    to: vec3('Opposite corner of the same box, inclusive.'),
  },
  ['from', 'to'],
  { description: 'A closed box in world coordinates.' },
)

/** 实体类型校验：只认这个版本真的有的类型，认不出时给候选（D-83）。 */
function resolveType(
  registry: EntityRegistry,
  raw: unknown,
  where: string,
): { type: string } | { error: ToolResult } {
  const name = typeof raw === 'string' ? raw.trim() : ''
  if (name.length === 0) {
    return { error: failure('INVALID_ARGS', `${where}.type is required.`) }
  }
  if (registry.has(name)) return { type: normalizeEntityName(name) }
  const suggestions = registry.suggest(name)
  const hint =
    suggestions.length > 0
      ? `Did you mean: ${suggestions.join(', ')}?`
      : `No entity type in ${registry.minecraftVersion} looks like that. Types are the vanilla ids, e.g. minecraft:oak_boat, minecraft:armor_stand.`
  return {
    error: failure('UNKNOWN_ENTITY', `Unknown entity type "${name}".`, hint, {
      name,
      suggestions: suggestions.join(', '),
    }),
  }
}

const regionOf = (value: { from?: number[]; to?: number[] } | undefined): Bounds | undefined => {
  if (value?.from === undefined || value.to === undefined) return undefined
  const from = toPos(value.from, 'region.from')
  const to = toPos(value.to, 'region.to')
  return {
    min: { x: Math.min(from.x, to.x), y: Math.min(from.y, to.y), z: Math.min(from.z, to.z) },
    max: { x: Math.max(from.x, to.x), y: Math.max(from.y, to.y), z: Math.max(from.z, to.z) },
  }
}

/** `place_entity` 的一条输入（JSON Schema 的形状与它对齐）。 */
interface EntityInput {
  type?: string
  at?: number[]
  offset?: number[]
  facing?: string
  yaw?: number
  pitch?: number
  data?: Record<string, unknown>
}

export const placeEntityTool = defineTool<{ entities: EntityInput[] }>({
  name: 'place_entity',
  description:
    'Place one or more **entities** (boats, minecarts, armour stands, item frames…) into the world.\n' +
    'This is the only tool that creates entities. It does not touch blocks, so an entity can sit in the same cell as whatever you already built.\n' +
    'Positions are **integer cells**; `offset` moves within the cell in 1/16ths and defaults to the cell centre sitting on the floor.\n' +
    '**One call = one revision = one undo step**, so place a whole row of eight boats in a single call instead of eight calls.\n' +
    'The result lists the ids it assigned — keep them if you want to move or remove those entities later.\n' +
    'Entities are **not** shown in `measure`; use `list_entities` to see them and `verify` with an entity_at claim to read them back.',
  parameters: obj(
    {
      entities: arr(
        'The entities to place. A row of eight boats is eight entries **in one call**.',
        obj(
          {
            type: ENTITY_TYPE,
            at: vec3('The cell to place it in.'),
            offset: arr(
              'Offset within the cell in 1/16ths, each 0..15. Default [8,0,8] = centred, on the floor. ' +
                'Raise y to hang something (an item frame is usually at y=8).',
              int('sixteenths', { minimum: 0, maximum: 15 }),
              { minItems: 3, maxItems: 3 },
            ),
            facing: {
              type: 'string',
              description: 'Cardinal facing; ignored when yaw is given. north = -Z, south = +Z, east = +X, west = -X.',
              enum: ['north', 'south', 'east', 'west'],
            },
            yaw: int(
              'Facing as a 0..15 step of 22.5°: 0 = south (+Z), 4 = west, 8 = north, 12 = east. Overrides facing.',
              { minimum: 0, maximum: 15 },
            ),
            pitch: num('Pitch in degrees.', { minimum: -90, maximum: 90 }),
            data: obj(
              {},
              [],
              {
                additionalProperties: true,
                description:
                  'Extra payload for this entity type (armour stand pose, item frame contents, custom name…). ' +
                  'Stored verbatim and written out to .schem / .litematic, so it must be NBT-representable: ' +
                  'no null, no mixed-type arrays.',
              },
            ),
          },
          ['type', 'at'],
        ),
        { minItems: 1, maxItems: 256 },
      ),
    },
    ['entities'],
  ),
  mutating: true,
  execute: (ctx, args) => {
    const registry = loadEntityRegistry(ctx.store.registry.minecraftVersion)
    const inputs = args.entities ?? []
    if (inputs.length === 0) return failure('INVALID_ARGS', 'entities must not be empty.')

    const room = MAX_ENTITIES - ctx.store.entities.size
    if (inputs.length > room) {
      return failure(
        'TOO_LARGE',
        `Placing ${inputs.length} entities would exceed the limit of ${MAX_ENTITIES} (currently ${ctx.store.entities.size}, room for ${room}).`,
        'Remove some entities first with remove_entity.',
        { limit: MAX_ENTITIES, current: ctx.store.entities.size },
      )
    }

    /**
     * **先把整批校验完，再动世界。** 一边校验一边 `set` 的话，第 3 条类型拼错时
     * 前 2 条已经落进去了，而那一笔没有 op——撤销撤不掉，日志里也看不见。
     * 与 `run_batch` 的"任一失败整批中止"同一个态度。
     */
    const revision = ctx.store.revision + 1
    const pending: PlacedEntity[] = []
    for (let i = 0; i < inputs.length; i++) {
      const input = inputs[i]!
      const where = `entities[${i}]`
      const resolved = resolveType(registry, input.type, where)
      if ('error' in resolved) return resolved.error

      const at = toPos(input.at, `${where}.at`)
      const offset = input.offset ?? DEFAULT_OFFSET
      const yaw =
        input.yaw ?? (input.facing !== undefined ? FACING_YAW[input.facing]! : 0)

      let data: Record<string, unknown> | undefined
      if (input.data !== undefined && Object.keys(input.data).length > 0) {
        const problem = nbtValueProblem(input.data, `${where}.data`)
        if (problem !== undefined) {
          return failure('INVALID_ARGS', `Cannot store that payload: ${problem}`, 'Simplify data, or drop it and use a simpler entity.', {
            detail: problem,
          })
        }
        data = input.data
      }

      pending.push({
        id: ctx.store.entities.allocateId(revision),
        type: resolved.type,
        x: at.x + offset[0]! / 16,
        y: at.y + offset[1]! / 16,
        z: at.z + offset[2]! / 16,
        yaw,
        ...(input.pitch !== undefined ? { pitch: input.pitch } : {}),
        ...(data !== undefined ? { data } : {}),
      })
    }

    const changes: EntityChange[] = []
    for (const entity of pending) {
      const change = ctx.store.entities.set(entity)
      if (change !== undefined) changes.push(change)
    }
    if (changes.length === 0) {
      return { ok: true, summary: 'No change: those entities are already placed exactly like that.', data: { revision: ctx.store.revision, placed: 0, entities: [] } }
    }

    const at = ctx.store.commitSparse({ entities: changes })
    ctx.record('place_entity', args, undefined, { entities: changes })

    const lines = pending.map((entity) => `${entity.id} ${entity.type} @ [${floorOf(entity.x)},${floorOf(entity.y)},${floorOf(entity.z)}] yaw ${entity.yaw}`)
    return {
      ok: true,
      summary:
        `Placed ${pending.length} ${pending.length === 1 ? 'entity' : 'entities'} (revision ${at}):\n` +
        lines.join('\n'),
      data: {
        revision: at,
        placed: pending.length,
        entities: pending.map((entity) => ({ id: entity.id, type: entity.type, x: entity.x, y: entity.y, z: entity.z, yaw: entity.yaw })),
      },
    }
  },
})

export const removeEntityTool = defineTool<{ ids?: string[]; region?: { from: number[]; to: number[] } }>({
  name: 'remove_entity',
  description:
    'Remove entities, either by the ids that place_entity / list_entities gave you, or everywhere inside a box.\n' +
    'This never touches blocks — removing the water under a boat is `erase`, removing the boat is this.\n' +
    'Prefer a single call with several ids over several calls: one call is one revision and one undo step.',
  parameters: obj(
    {
      ids: arr('Entity ids to remove (as returned by place_entity or list_entities).', str('entity id, e.g. e_12_1')),
      region: REGION,
    },
    [],
  ),
  mutating: true,
  destructive: true,
  execute: (ctx, args) => {
    const ids = args.ids ?? []
    const bounds = regionOf(args.region)
    if (ids.length === 0 && bounds === undefined) {
      return failure('INVALID_ARGS', 'Give me either ids or a region.', 'Call list_entities first if you do not know the ids.')
    }

    const changes: EntityChange[] = []
    const missing: string[] = []
    for (const id of ids) {
      const change = ctx.store.entities.remove(id)
      if (change === undefined) missing.push(id)
      else changes.push(change)
    }
    if (bounds !== undefined) changes.push(...ctx.store.entities.removeInBounds(bounds))

    if (changes.length === 0) {
      return {
        ok: true,
        summary:
          `Removed 0 entities (revision ${ctx.store.revision}).` +
          (missing.length > 0 ? ` No entity has id ${missing.join(', ')}.` : ' Nothing matches that region.'),
        data: { revision: ctx.store.revision, removed: 0, missing },
      }
    }

    const at = ctx.store.commitSparse({ entities: changes })
    ctx.record('remove_entity', args, undefined, { entities: changes })
    return {
      ok: true,
      summary:
        `Removed ${changes.length} ${changes.length === 1 ? 'entity' : 'entities'} (revision ${at}).` +
        (missing.length > 0 ? ` ${missing.length} id(s) did not exist: ${missing.join(', ')}.` : ''),
      data: { revision: at, removed: changes.length, missing },
    }
  },
})

export const listEntitiesTool = defineTool<{ region?: { from: number[]; to: number[] }; type?: string; limit?: number }>({
  name: 'list_entities',
  description:
    'List the entities in the world (or in a box), with their ids, types, positions and facing.\n' +
    'Use it to get the ids before remove_entity, and to check what is already there before adding more.\n' +
    'This is a plain listing, **not** a verification — read back with `verify` (entity_at / entity_count) before claiming you are done.',
  parameters: obj(
    {
      region: REGION,
      type: str('Only list this entity type, e.g. "minecraft:oak_boat".'),
      limit: int('Maximum number of entities to list, default 64.', { minimum: 1, maximum: 512 }),
    },
    [],
  ),
  execute: (ctx, args) => {
    const bounds = regionOf(args.region)
    const wanted = args.type !== undefined ? normalizeEntityName(args.type) : undefined
    const limit = args.limit ?? 64

    let found = ctx.store.entities.list()
    if (bounds !== undefined) {
      found = found.filter((entity) => {
        const x = Math.floor(entity.x)
        const y = Math.floor(entity.y)
        const z = Math.floor(entity.z)
        return (
          x >= bounds.min.x && x <= bounds.max.x &&
          y >= bounds.min.y && y <= bounds.max.y &&
          z >= bounds.min.z && z <= bounds.max.z
        )
      })
    }
    if (wanted !== undefined) found = found.filter((entity) => entity.type === wanted)

    const shown = found.slice(0, limit)
    const lines = shown.map(
      (entity) =>
        `${entity.id} ${entity.type} @ [${floorOf(entity.x)},${floorOf(entity.y)},${floorOf(entity.z)}]` +
        ` (${entity.x.toFixed(2)},${entity.y.toFixed(2)},${entity.z.toFixed(2)}) yaw ${entity.yaw}` +
        (entity.data !== undefined ? ` data ${JSON.stringify(entity.data)}` : ''),
    )
    return {
      ok: true,
      summary:
        found.length === 0
          ? 'No entities match.'
          : `${found.length} ${found.length === 1 ? 'entity' : 'entities'}${found.length > shown.length ? ` (showing ${shown.length})` : ''}:\n` + lines.join('\n'),
      data: { total: found.length, shown: shown.length, entities: shown },
    }
  },
})

export const getBlockEntityTool = defineTool<{ at: number[] }>({
  name: 'get_block_entity',
  description:
    'Read the block entity data hanging on one cell — sign text, banner patterns, container contents, skull owner…\n' +
    'Returns the kind and the stored payload, or says there is none. Block entities only exist on blocks that carry them ' +
    '(a chest, a sign, a banner…); putting one on stone is rejected rather than stored.',
  parameters: obj({ at: CELL }, ['at']),
  execute: (ctx, args) => {
    const pos = toPos(args.at, 'at')
    const entity = ctx.store.blockEntities.at(pos)
    if (entity === undefined) {
      const block = ctx.store.getBlockString(pos)
      const kind = blockEntityKindOf(block)
      return {
        ok: true,
        summary:
          kind === undefined
            ? `No block entity at [${pos.x},${pos.y},${pos.z}] — the block there is ${block}, which does not carry one.`
            : `No block entity at [${pos.x},${pos.y},${pos.z}] yet; the ${block} there could hold one, so use edit_block_entity.`,
        data: { at: [pos.x, pos.y, pos.z], block, kind },
      }
    }
    return {
      ok: true,
      summary: `${entity.kind} at [${entity.x},${entity.y},${entity.z}]: ${JSON.stringify(entity.data)}`,
      data: { at: [entity.x, entity.y, entity.z], kind: entity.kind, data: entity.data },
    }
  },
})

export const editBlockEntityTool = defineTool<{
  at: number[]
  data: Record<string, unknown>
  merge?: boolean
}>({
  name: 'edit_block_entity',
    description:
      'Write the block entity data on one cell — sign text, banner patterns, container contents, skull owner…\n' +
      'The cell must already hold a block that carries a block entity (a chest, a sign, a banner…); putting one on stone is rejected ' +
      'rather than stored, because the game would drop it and the file would look fine.\n' +
      'The kind is derived from the block, so you never write it — putting sign text on a chest is not something you can express.\n' +
      'The payload is stored verbatim and later written to .schem / .litematic, so it must be NBT-representable (no null, no mixed-type arrays).',
    parameters: obj(
      {
        at: CELL,
        data: obj(
          {},
          [],
          {
            additionalProperties: true,
            description: 'The payload to store. Replaces the existing payload unless merge is true.',
          },
        ),
        merge: bool('Merge into the existing payload instead of replacing it. Default false.'),
      },
      ['at', 'data'],
    ),
  mutating: true,
  execute: (ctx, args) => {
    const pos = toPos(args.at, 'at')
    const block = ctx.store.getBlockString(pos)
    const kind = blockEntityKindOf(block)
    if (kind === undefined) {
      const supported = BLOCK_ENTITY_BLOCKS.slice(0, 12).join(', ')
      return failure(
        'UNSUPPORTED',
        `The block at [${pos.x},${pos.y},${pos.z}] is ${block}, which does not carry block entity data.`,
        `Block entity data can only go on a block that has one — for example: ${supported} … ` +
          'Place such a block there first with place_block, or use place_entity if you meant an entity.',
        { block, at: [pos.x, pos.y, pos.z] },
      )
    }

    const problem = nbtValueProblem(args.data, 'data')
    if (problem !== undefined) {
      return failure(
        'INVALID_ARGS',
        `Cannot store that payload: ${problem}`,
        'Values must survive being written to NBT: no null, no non-finite numbers, no mixed-type arrays.',
        { detail: problem },
      )
    }

    const existing = ctx.store.blockEntities.at(pos)
    if (existing === undefined && ctx.store.blockEntities.size >= MAX_BLOCK_ENTITIES) {
      return failure(
        'TOO_LARGE',
        `This world already holds ${MAX_BLOCK_ENTITIES} block entities, the limit.`,
        'Remove some with a block write over them (any block write clears what was there).',
      )
    }

    const data = args.merge === true && existing !== undefined ? { ...existing.data, ...args.data } : args.data
    const next: { x: number; y: number; z: number; kind: string; data: Record<string, unknown> } = {
      x: pos.x,
      y: pos.y,
      z: pos.z,
      kind,
      data,
    }
    const change = ctx.store.blockEntities.set(next)
    if (change === undefined) {
      return {
        ok: true,
        summary: `No change: the ${kind} at [${pos.x},${pos.y},${pos.z}] already holds exactly that payload.`,
        data: { revision: ctx.store.revision, kind, at: [pos.x, pos.y, pos.z] },
      }
    }

    const at = ctx.store.commitSparse({ blockEntities: [change] })
    ctx.record('edit_block_entity', args, undefined, { blockEntities: [change] })
    return {
      ok: true,
      summary:
        `Set the payload of the ${kind} at [${pos.x},${pos.y},${pos.z}] (revision ${at}).
` +
        `data: ${JSON.stringify(data)}`,
      data: { revision: at, kind, at: [pos.x, pos.y, pos.z], data },
    }
  },
})
