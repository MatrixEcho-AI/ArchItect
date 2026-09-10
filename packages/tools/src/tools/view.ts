import { measure } from '@architect/core'

import { bool, int, obj } from '../schema.js'
import { defineTool, failure } from '../types.js'
import type { ToolResult } from '../types.js'

const VIEWS = ['iso_ne', 'iso_nw', 'iso_se', 'iso_sw', 'front', 'back', 'left', 'right', 'top'] as const

export const screenshotTool = defineTool<{
  view?: string
  width?: number
  height?: number
  highlightLast?: boolean
  plain?: boolean
}>({
  name: 'screenshot',
  description:
    'Render a screenshot for you to look at. **Use it only to judge appearance** (proportions, massing, style, symmetry), not to read coordinates —\n' +
    'the image the model sees is downscaled to about 800×800, one block cell is only a few pixels wide, and counting cells will always be wrong.\n' +
    'Use slice when you need precise positioning.\n' +
    'One shot per modification is enough; repeating the same camera hits the cache and costs nothing extra.\n' +
    'The result carries a revision — **check it against the current version; if they differ the image is stale and your judgement is void**.',
  parameters: obj({
    view: {
      type: 'string',
      description: 'Camera. iso_* are the four isometric corners, the rest are orthographic elevations/top. Default iso_ne.',
      enum: VIEWS,
      default: 'iso_ne',
    },
    width: int('Image width, default 1024.', { minimum: 64, maximum: 4096 }),
    height: int('Image height, default 768.', { minimum: 64, maximum: 4096 }),
    highlightLast: bool('Highlight the affected range of the last edit, to confirm "what I just changed". Default true.'),
    plain: bool('Use the deterministic fallback palette (does not read a resource pack). Usually unnecessary.'),
  }),
  execute: (ctx, args) => {
    const bounds = ctx.store.contentBounds()
    if (bounds === undefined) {
      return failure('NOT_FOUND', 'The world is empty, there is nothing to render', 'Build something first, then take a screenshot.')
    }

    const highlightLast = args.highlightLast !== false
    let highlight: { min: { x: number; y: number; z: number }; max: { x: number; y: number; z: number } } | undefined
    if (highlightLast) {
      const last = ctx.log.at(ctx.log.length - 1)
      highlight = last?.patch.bounds()
    }

    const size = measure(ctx.store)
    const caption = [
      `REV ${ctx.store.revision}  BLOCKS ${size.blocks}`,
      `BOUNDS ${bounds.min.x},${bounds.min.y},${bounds.min.z}..${bounds.max.x},${bounds.max.y},${bounds.max.z}`,
    ]

    const image = ctx.shoot({
      view: args.view ?? 'iso_ne',
      width: args.width ?? 1024,
      height: args.height ?? 768,
      ...(highlight !== undefined ? { highlight } : {}),
      caption,
    })

    const parts = [
      `screenshot ${image.camera} ${image.width}x${image.height}, revision ${image.revision}`,
      `content bounds (${bounds.min.x},${bounds.min.y},${bounds.min.z})..(${bounds.max.x},${bounds.max.y},${bounds.max.z})`,
    ]
    if (highlight !== undefined) {
      parts.push(
        `the orange box is the range of the last edit (${highlight.min.x},${highlight.min.y},${highlight.min.z})..(${highlight.max.x},${highlight.max.y},${highlight.max.z})`,
      )
    }
    parts.push('(the coordinate numbers on the image are ground rulers for estimating position; use slice for exact coordinates)')

    return {
      ok: true,
      summary: parts.join('\n'),
      data: { view: image.camera, width: image.width, height: image.height, revision: image.revision },
      image,
    }
  },
})

export const undoRedoTools = [
  defineTool<Record<string, never>>({
    name: 'undo',
    description: 'Undo the last edit, rolling the world back to the state before that operation. Returns the number of reverted cells.',
    parameters: obj({}),
    mutating: true,
    execute: (ctx): ToolResult => {
      const reverted = ctx.store.undo()
      if (reverted === 0) {
        return failure('NOT_FOUND', 'There is nothing to undo')
      }
      return {
        ok: true,
        summary: `reverted ${reverted} cells, revision ${ctx.store.revision}`,
        data: { reverted, revision: ctx.store.revision },
      }
    },
  }),
  defineTool<Record<string, never>>({
    name: 'redo',
    description: 'Redo the edit that was undone. Returns the number of cells reapplied.',
    parameters: obj({}),
    mutating: true,
    execute: (ctx): ToolResult => {
      const replayed = ctx.store.redo()
      if (replayed === 0) return failure('NOT_FOUND', 'There is nothing to redo')
      return {
        ok: true,
        summary: `redid ${replayed} cells, revision ${ctx.store.revision}`,
        data: { replayed, revision: ctx.store.revision },
      }
    },
  }),
]
