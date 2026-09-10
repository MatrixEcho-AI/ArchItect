import { measure } from '@architect/core'

import { bool, int, num, obj, vec3 } from '../schema.js'
import { defineTool, failure } from '../types.js'
import type { SessionCamera, ToolResult } from '../types.js'

const VIEWS = ['iso_ne', 'iso_nw', 'iso_se', 'iso_sw', 'front', 'back', 'left', 'right', 'top'] as const

export const screenshotTool = defineTool<{
  view?: string
  width?: number
  height?: number
  /** 自由机位：水平角（度）。给了就以它为准，`view` 只作为标签。 */
  azimuth?: number
  /** 自由机位：仰角（度），会被夹到 1..89。 */
  elevation?: number
  /** 每格像素。省略 = 自动取景。 */
  scale?: number
  /** 注视点，配合大 `scale` 做局部特写。 */
  target?: number[]
  /** 相机位置（世界坐标）。与 `lookAt` 成对使用；正交投影下距离不影响成像。 */
  eye?: number[]
  /** 注视点（世界坐标）。给了 `eye` + `lookAt` 就是"从这里看向那里"。 */
  lookAt?: number[]
  /** 绕视线轴的滚转（度）。默认 0（地平线水平）。 */
  roll?: number
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
      description:
        'Named camera preset. iso_* are the four isometric corners, the rest are orthographic elevations/top. ' +
        'Default iso_ne. Ignored when azimuth/elevation are given (it then only labels the shot).',
      enum: VIEWS,
      default: 'iso_ne',
    },
    azimuth: num(
      'Free camera: horizontal angle in degrees (0 = looking from +Z toward -Z, increasing counter-clockwise seen from above). ' +
        'Use it when the 9 presets do not give you the direction you need to judge (e.g. an overhang seen from the side). ' +
        'The model is built around the content, so you do not need to compute coordinates.',
      { minimum: -360, maximum: 720 },
    ),
    elevation: num(
      'Free camera: elevation angle in degrees. 1 = almost level with the horizon, 89 = almost straight down. ' +
        'Clamped to 1..89 (at exactly 90 the view collapses).',
      { minimum: -180, maximum: 180 },
    ),
    scale: num(
      'Pixels per block. Omit to auto-frame the content. Set it larger for a close-up of a detail ' +
        '(pair it with target), smaller to see the whole site.',
      { minimum: 0.2, maximum: 80 },
    ),
    target: vec3(
      'Look-at point in world coordinates [x, y, z]. Omit to look at the centre of the content. ' +
        'Use it with a large scale to inspect one detail closely.',
    ),
    eye: vec3(
      'Camera position in world coordinates. Give it together with lookAt to aim the camera at a specific point ' +
        'instead of using an orbit angle. NOTE: the projection is orthographic, so the DISTANCE between eye and ' +
        'lookAt does not change the image size — only the direction matters. Use scale to zoom.',
    ),
    lookAt: vec3('Point the camera looks at; also becomes the centre of the image.'),
    roll: num('Roll around the view axis in degrees. 0 keeps the horizon level (the usual choice). Default 0.', {
      minimum: -180,
      maximum: 180,
    }),
    width: int('Image width, default 1024.', { minimum: 64, maximum: 4096 }),
    height: int('Image height, default 768.', { minimum: 64, maximum: 4096 }),
    highlightLast: bool('Highlight the affected range of the last edit, to confirm "what I just changed". Default true.'),
    plain: bool('Use the deterministic fallback palette (does not read a resource pack). Usually unnecessary.'),
  }),
  execute: async (ctx, args) => {
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

    // 显式参数 > 会话相机（`set_camera` 设的）> 默认机位
    const session = ctx.camera
    const camera = {
      view: args.view ?? session?.view ?? 'iso_ne',
      azimuth: args.azimuth ?? session?.azimuth,
      elevation: args.elevation ?? session?.elevation,
      eye: session?.eye,
      lookAt: session?.lookAt,
      roll: args.roll ?? session?.roll,
      scale: args.scale ?? session?.scale,
      target: args.target as [number, number, number] | undefined,
    }
    // 显式给了角度就等于"从会话相机切回角度模式"，否则 eye/lookAt 会把角度盖掉
    const useSessionEye = args.azimuth === undefined && args.elevation === undefined && args.eye === undefined
    const image = await ctx.shoot({
      view: camera.view,
      width: args.width ?? 1024,
      height: args.height ?? 768,
      ...(camera.azimuth !== undefined ? { azimuth: camera.azimuth } : {}),
      ...(camera.elevation !== undefined ? { elevation: camera.elevation } : {}),
      ...(useSessionEye && camera.eye !== undefined ? { eye: camera.eye } : {}),
      ...(useSessionEye && camera.lookAt !== undefined ? { lookAt: camera.lookAt } : {}),
      ...(args.eye !== undefined ? { eye: args.eye } : {}),
      ...(args.lookAt !== undefined ? { lookAt: args.lookAt } : {}),
      ...(camera.roll !== undefined ? { roll: camera.roll } : {}),
      ...(camera.scale !== undefined ? { scale: camera.scale } : {}),
      ...(camera.target !== undefined ? { target: camera.target } : {}),
      ...(highlight !== undefined ? { highlight } : {}),
      caption: [
        ...caption,
        ...(() => {
          if (args.eye !== undefined && args.lookAt !== undefined) {
            return [`CAM eye ${args.eye.join(',')} → ${args.lookAt.join(',')}`]
          }
          const az = args.azimuth ?? session?.azimuth
          const el = args.elevation ?? session?.elevation
          if (az === undefined && el === undefined) return []
          const scale = args.scale ?? session?.scale
          return [`CAM az${az ?? '?'} el${el ?? '?'}${scale !== undefined ? ` z${scale}` : ''}`]
        })(),
      ],
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

/**
 * **撤销 / 重做 = 版本游标前后移动 + 重放**（plan §6）。
 *
 * 不是"打一个反向补丁"：op 记录的是**结果**，所以往回走只能重放。
 * 好处是撤销本身不进日志，时间线、`.mcai` 往返、`verifyReplay` 三者始终自洽。
 *
 * ⚠️ 一句必须写进描述里的话：**撤销之后再编辑等于从历史分叉**，
 * 被丢掉的支线真的没了。不写的话模型会以为撤销是可逆的，然后随手在历史版本上
 * 继续盖房子，把用户后面的工作挤掉。
 */
export const undoRedoTools = [
  defineTool<Record<string, never>>({
    name: 'undo',
    description:
      'Move the version cursor back one step and replay, undoing the last edit. Use it when you just made a change you regret.\n' +
      'IMPORTANT: editing after an undo DISCARDS everything after the cursor (there is no branching yet). ' +
      'If you only want to look at an earlier state, use screenshot/slice instead of undo.',
    parameters: obj({}),
    mutating: true,
    execute: (ctx): ToolResult => {
      if (!ctx.history.canUndo) return failure('NOT_FOUND', 'There is nothing to undo')
      const before = ctx.store.revision
      const revision = ctx.history.undo()
      return {
        ok: true,
        summary:
          `rolled back to revision ${revision} (was ${before}); the world is now the state before that edit. ` +
          `${ctx.history.atTip ? 'You are at the latest revision.' : `${ctx.history.length - revision} later revision(s) are still available via redo, but a new edit would discard them.`}`,
        data: { revision, dropped: before - revision, atTip: ctx.history.atTip },
      }
    },
  }),
  defineTool<Record<string, never>>({
    name: 'redo',
    description:
      'Move the version cursor forward one step and replay, reapplying an edit you undid. Only meaningful right after undo.',
    parameters: obj({}),
    mutating: true,
    execute: (ctx): ToolResult => {
      if (!ctx.history.canRedo) return failure('NOT_FOUND', 'There is nothing to redo')
      const revision = ctx.history.redo()
      return {
        ok: true,
        summary: `moved forward to revision ${revision} (of ${ctx.history.length})`,
        data: { revision, atTip: ctx.history.atTip },
      }
    },
  }),
]

/**
 * **把相机放在指定的坐标与朝向上，并在之后的所有截图里保持。**
 *
 * 和 `screenshot` 上那几个角度参数的分工：
 *
 * - `screenshot { azimuth, elevation }`：一次性的轨道角度，**拍完就忘记**。
 *   适合"换个方向看看"。
 * - `set_camera { eye, lookAt }`：**定住**一个机位，之后每次 `screenshot` 都用它，
 *   直到显式改角度或 `reset: true`。适合"我一直在盯同一个立面，别每次重报角度"。
 *
 * 正交投影下**相机与注视点的距离不影响成像**：`eye` 只提供方向，`lookAt` 成为
 * 画面中心。要放大就调 `scale`，把相机放远没有用——这一条写在描述里，
 * 否则模型（和人）都会自然地以为"放远了会变小"。
 */
export const setCameraTool = defineTool<{
  eye?: number[]
  lookAt?: number[]
  azimuth?: number
  elevation?: number
  roll?: number
  scale?: number
  reset?: boolean
}>({
  name: 'set_camera',
  description:
    'Position the camera explicitly and KEEP it for every later screenshot.\n' +
    'Give eye + lookAt to aim the camera at a point, or azimuth + elevation for an orbit angle.\n' +
    'The projection is ORTHOGRAPHIC: the distance between eye and lookAt does NOT change the image size, ' +
    'only the direction does — use scale to zoom.\n' +
    'This does not render anything. It only sets the camera; call screenshot afterwards to look.\n' +
    'reset:true clears it and goes back to the default preset.',
  parameters: obj({
    eye: vec3(
      'Camera position in world coordinates [x, y, z]. Needs lookAt to define a direction. ' +
        'Distance to lookAt is ignored by the orthographic projection.',
    ),
    lookAt: vec3('Point the camera looks at. Also becomes the centre of the image.'),
    azimuth: num('Orbit alternative to eye/lookAt: horizontal angle in degrees.', { minimum: -360, maximum: 720 }),
    elevation: num('Orbit alternative to eye/lookAt: elevation angle in degrees, clamped to 1..89.', {
      minimum: -180,
      maximum: 180,
    }),
    roll: num('Roll around the view axis in degrees. 0 keeps the horizon level.', {
      minimum: -180,
      maximum: 180,
    }),
    scale: num('Pixels per block. Omit to auto-frame the content.', { minimum: 0.2, maximum: 80 }),
    reset: bool('Clear the stored camera and go back to the default preset.'),
  }),
  execute: (ctx, args) => {
    if (args.reset === true) {
      delete ctx.camera
      return {
        ok: true,
        summary: 'Camera reset to the default preset.',
        data: { camera: null },
      }
    }

    const next: SessionCamera = { ...ctx.camera }
    if (args.eye !== undefined && args.lookAt !== undefined) {
      const eye = triple(args.eye)
      const lookAt = triple(args.lookAt)
      if (eye === undefined || lookAt === undefined) {
        return failure('INVALID_ARGS', 'eye and lookAt must both be [x, y, z] numbers', 'Pass two 3-element arrays.')
      }
      if (eye[0] === lookAt[0] && eye[1] === lookAt[1] && eye[2] === lookAt[2]) {
        return failure(
          'INVALID_ARGS',
          'eye and lookAt are the same point, so the direction is undefined',
          'Move the camera away from the point it should look at.',
        )
      }
      next.eye = eye
      next.lookAt = lookAt
      // 位置/朝向是"新的事实"，把之前的轨道角度清掉，免得两者打架
      delete next.azimuth
      delete next.elevation
    } else {
      if (args.eye !== undefined || args.lookAt !== undefined) {
        return failure(
          'INVALID_ARGS',
          'eye and lookAt must be given together',
          'A direction needs two points; pass both, or use azimuth/elevation instead.',
        )
      }
      if (args.azimuth !== undefined) next.azimuth = args.azimuth
      if (args.elevation !== undefined) next.elevation = Math.min(89, Math.max(1, args.elevation))
      if (args.azimuth !== undefined || args.elevation !== undefined) {
        delete next.eye
        delete next.lookAt
      }
    }
    if (args.roll !== undefined) next.roll = args.roll
    if (args.scale !== undefined) next.scale = args.scale

    const anything =
      next.eye !== undefined ||
      next.azimuth !== undefined ||
      next.elevation !== undefined ||
      next.roll !== undefined ||
      next.scale !== undefined
    if (!anything) {
      return failure(
        'INVALID_ARGS',
        'set_camera needs at least one of: eye + lookAt, azimuth, elevation, roll, scale',
        'Or pass reset:true to clear the camera.',
      )
    }

    ctx.camera = next
    const parts: string[] = []
    if (next.eye !== undefined && next.lookAt !== undefined) {
      parts.push(`eye ${next.eye.join(',')} → ${next.lookAt.join(',')}`)
    }
    if (next.azimuth !== undefined) parts.push(`azimuth ${next.azimuth}`)
    if (next.elevation !== undefined) parts.push(`elevation ${next.elevation}`)
    if (next.roll !== undefined) parts.push(`roll ${next.roll}`)
    if (next.scale !== undefined) parts.push(`scale ${next.scale}`)
    return {
      ok: true,
      summary:
        `Camera set: ${parts.join(', ')}. ` +
        'Every later screenshot uses it until you change the angle or reset. ' +
        'Call screenshot to look.',
      data: { camera: { ...next } },
    }
  },
})

/** `[x,y,z]` 且都是有限数才收；否则返回 undefined。 */
function triple(value: readonly number[]): [number, number, number] | undefined {
  if (value.length < 3) return undefined
  const out: [number, number, number] = [value[0]!, value[1]!, value[2]!]
  return out.every((v) => Number.isFinite(v)) ? out : undefined
}
