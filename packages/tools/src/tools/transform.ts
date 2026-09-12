import { clipPasteSize, copyRegion, planPaste, planPasteSparse, pasteSparseWriter } from '@architect/core'
import type { ClipRegion, MirrorAxis, RotateDegrees } from '@architect/core'

import { bool, obj, str, vec3 } from '../schema.js'
import { defineTool, failure } from '../types.js'
import type { ToolContext, ToolResult } from '../types.js'
import { commitPlan, isToolResult, toPos } from './edit.js'
import type { EditPlan } from './edit.js'

/**
 * 区域复制粘贴。
 *
 * 这一对工具是"对称 / 重复体量"的主力：造好一段，复制，转个角度贴到别处。
 * **朝向会跟着一起变**——这是它与"再画一遍"的本质区别，也是体素工具最容易做错的地方。
 */

const ROTATE = {
  type: 'number' as const,
  description: 'Rotation about +Y in degrees: 0 (default) / 90 / 180 / 270. 90 is clockwise seen from above.',
  enum: [0, 90, 180, 270] as const,
}

const MIRROR = {
  type: 'string' as const,
  description:
    'Mirror the clipboard before rotating. x flips along X (east<->west), z along Z (north<->south), y flips vertically (up<->down).',
  enum: ['x', 'y', 'z'] as const,
}

export const copyRegionTool = defineTool<{
  from: number[]
  to: number[]
  only?: string[]
}>({
  name: 'copy_region',
  description:
    'Copy a box into the session clipboard. **Read-only** — it neither changes the world nor the revision.\n' +
    'Only non-air cells are stored and facing is preserved exactly; paste_region remaps facing when you rotate or mirror.\n' +
    '**Entities and block-entity contents come along too**: boats standing in the box, and what is inside chests, signs and banners. ' +
    'Passing `only` filters by block name, and since entities have no block name that also leaves them behind — omit `only` when you want the whole scene.\n' +
    'Copy once, paste many times: this is how you build repeated wings, towers and arches.',
  parameters: obj(
    {
      from: vec3('One corner of the box [x,y,z].'),
      to: vec3('The opposite corner [x,y,z]. Inclusive.'),
      only: {
        type: 'array' as const,
        description: 'Copy only these block names (e.g. ["minecraft:oak_planks"]). Omit to copy everything non-air.',
        items: str('block name'),
      },
    },
    ['from', 'to'],
  ),
  mutating: false,
  destructive: false,
  execute: (ctx, args) => {
    const from = toPos(args.from, 'from')
    const to = toPos(args.to, 'to')
    let clip: ClipRegion
    try {
      clip = copyRegion(ctx.store, from, to, args.only !== undefined ? { only: args.only } : {})
    } catch (error) {
      if (error instanceof RangeError) {
        return failure('TOO_LARGE', error.message, 'Shrink from/to, or pass only to filter by block name.')
      }
      throw error
    }
    ctx.clipboard.current = clip
    const [sx, sy, sz] = clip.size
    return {
      ok: true,
      summary:
        `Copied ${clip.cells.length} non-air cell(s) from ` +
        `(${from.x},${from.y},${from.z})..(${to.x},${to.y},${to.z}) — size ${sx}x${sy}x${sz}. ` +
        `Call paste_region with {at, rotate, mirror}; at is the **minimum corner** of the pasted copy.`,
      data: { cells: clip.cells.length, size: [sx, sy, sz], origin: [from.x, from.y, from.z] },
    }
  },
})

export const pasteRegionTool = defineTool<{
  at: number[]
  rotate?: RotateDegrees
  mirror?: MirrorAxis
  mode?: 'replace' | 'keep' | 'overlay'
  confirm?: boolean
}>({
  name: 'paste_region',
  description:
    'Paste the clipboard so its **minimum corner** lands on `at`.\n' +
    '**Facing is remapped**: rotate 90 turns an east-facing stair into a south-facing one, a mirror swaps door hinges, sign rotation moves to the mirrored value.\n' +
    '**Entities move with it** (their yaw is remapped the same way) and chest/sign contents are copied into the pasted blocks — ' +
    'a chest only receives the contents if its block actually landed there, so `mode: keep` onto an occupied cell leaves that cell alone.\n' +
    'rotate is applied **after** mirror. rotate 90/270 swaps the footprint: a 4x6 copy pasted with rotate=90 occupies 6x4.',
  parameters: obj(
    {
      at: vec3('Where the minimum corner of the pasted copy goes [x,y,z].'),
      rotate: ROTATE,
      mirror: MIRROR,
      mode: {
        type: 'string' as const,
        description:
          'replace (default, overwrite) / keep (only into air, to graft onto existing structure) / overlay (only onto non-air, to recolor).',
        enum: ['replace', 'keep', 'overlay'] as const,
      },
      confirm: bool('Explicitly confirm an operation above the confirmation threshold. Review the dry-run preview first.'),
    },
    ['at'],
  ),
  mutating: true,
  destructive: false,
  execute: (ctx, args) => {
    const clip = ctx.clipboard.current
    if (clip === undefined) {
      return failure(
        'NOT_FOUND',
        'The clipboard is empty — nothing has been copied yet.',
        'Call copy_region{from,to} first, then paste_region.',
      )
    }
    const at = toPos(args.at, 'at')
    const plan = planPasteTool(ctx, clip, at, args.rotate, args.mirror, args.mode)
    if (isToolResult(plan)) return plan
    const size = clipPasteSize(clip, {
      ...(args.rotate !== undefined ? { rotate: args.rotate } : {}),
      ...(args.mirror !== undefined ? { mirror: args.mirror } : {}),
    })
    const result = commitPlan(ctx, 'paste_region', args, plan, args.confirm === true)
    if (result.ok && result.data !== undefined) {
      result.summary += ` Footprint ${size[0]}x${size[1]}x${size[2]} at (${at.x},${at.y},${at.z}).`
      result.data['pasteSize'] = size
    }
    return result
  },
})

/**
 * `paste_region` 的几何意图。
 *
 * 与 `core/planPaste` 只差一层：这里把"局部坐标 + stateId"翻成调色板下标，
 * 用 `emit` 的按格覆盖参数交给写入层。`run_batch` 复用同一个函数。
 *
 * **另外两层也在这里定下来**（`sparse`）：`planPasteSparse` + `pasteSparseWriter`
 * 是 core 里同一对函数，`pasteRegion` 用的就是它们。共用是刻意的——
 * "批处理里粘贴的船落在哪"与"单独粘贴的船落在哪"必须是同一个答案。
 * 那个回调在**方块写入之后**执行，所以它能看出哪一格真的被写成了源方块。
 */
export function planPasteTool(
  ctx: ToolContext,
  clip: ClipRegion,
  at: { x: number; y: number; z: number },
  rotate: RotateDegrees | undefined,
  mirror: MirrorAxis | undefined,
  mode: 'replace' | 'keep' | 'overlay' = 'replace',
): EditPlan | ToolResult {
  const transform = {
    ...(rotate !== undefined ? { rotate } : {}),
    ...(mirror !== undefined ? { mirror } : {}),
  }
  const cells = planPaste(ctx.store.registry, clip, at, transform)
  // **只有实体、没有方块也是合法的一贴**：一块空地上停着一条船，剪贴板里
  // 一个非空气格都没有。按"没有格子"拒掉的话，这条船永远复制不走。
  if (cells.length === 0 && clip.entities.length === 0) {
    return failure('NOT_FOUND', 'The clipboard holds no cells.', 'Call copy_region on a non-empty box first.')
  }
  const indices = cells.map((cell) => ctx.store.blockIndexForStateId(cell.stateId))
  const sparse = pasteSparseWriter(
    ctx.store,
    planPasteSparse(ctx.store, clip, at, transform),
    // 版本在写入前算得出来：这一笔至多推进一格
    ctx.store.revision + 1,
  )
  return {
    cells: (emit) => {
      for (const [index, cell] of cells.entries()) emit(cell.x, cell.y, cell.z, indices[index]!)
    },
    blockIndex: 0,
    mode,
    sparse: () => sparse(),
  }
}
