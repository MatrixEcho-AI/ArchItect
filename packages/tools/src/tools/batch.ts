import { mergeSparse } from '@architect/core'

import { arr, blockRef, bool, obj, str, vec3 } from '../schema.js'
import { defineTool, failure } from '../types.js'
import type { ToolContext, ToolResult } from '../types.js'
import {
  isToolResult,
  sparseSummary,
  planErase,
  resolveBlock,
  planExtrude,
  planFillBox,
  planFillLine,
  planFillPlane,
  planPlaceBlock,
  toPos,
} from './edit.js'
import type { CellEmitter, EditPlan } from './edit.js'
import { planPasteTool } from './transform.js'

/**
 * 批处理：把多个操作合并成**一次写入**。
 *
 * 收益不是"少写几行代码"，而是把 N 次往返压成 1 次：一个 revision、一次 dry-run 确认、
 * 一张截图（plan §8.1）。多轮会话里 agent 的时间与 token 大头都在往返上。
 *
 * ## 语义（这是契约，不是实现细节）
 *
 * - **顺序生效**：后面的 op 看得到前面 op 的结果，同一个格子以最后一个 op 为准。
 * - **整体原子**：任何一个 op 的计划失败（比如方块名拼错），整批中止、**一格都不写**。
 *   错误信息会指明是第几个 op 出的问题。
 * - **每个 op 的模式按"进入这一批之前的世界 + 本批已定的结果"判定**。
 *   单次调用 `fill_box{mode:keep}` 时它看的是世界的真实状态；放进批处理里它看的是
 *   "上一批 ops 已经确定要写的值"。这正是直觉上该有的行为。
 * - **只收纯几何操作**：`fill_box` / `fill_line` / `fill_plane` / `extrude` /
 *   `place_block` / `erase` / `paste_region`。`symmetrize` 与 `replace_blocks`
 *   需要读整片世界，塞进批处理会让"看哪一版世界"变得说不清，所以它们必须单独调用。
 */

/** 空气的全局 state id。`writeBlocks` 里也是这个约定。 */
const AIR_STATE_ID = 0

const BATCHABLE = new Set([
  'fill_box',
  'fill_line',
  'fill_plane',
  'extrude',
  'place_block',
  'erase',
  'paste_region',
])

/** 一批最多几个 op。再多就该拆成两批了——一次确认几百个操作没人看得过来。 */
export const MAX_BATCH_OPS = 64

export function planBatchOp(
  ctx: ToolContext,
  tool: string,
  args: Record<string, unknown>,
): EditPlan | ToolResult {
  switch (tool) {
    case 'fill_box':
      return planFillBox(
        ctx.store,
        toPos(args['from'], 'from'),
        toPos(args['to'], 'to'),
        String(args['block']),
        args['mode'] as Parameters<typeof planFillBox>[4],
      )
    case 'fill_line':
      return planFillLine(ctx.store, args as Parameters<typeof planFillLine>[1])
    case 'fill_plane':
      return planFillPlane(ctx.store, args as Parameters<typeof planFillPlane>[1])
    case 'extrude':
      return planExtrude(ctx.store, args as Parameters<typeof planExtrude>[1])
    case 'place_block':
      return planPlaceBlock(ctx.store, args['pos'] as number[], String(args['block']))
    case 'erase':
      return planErase(args['from'] as number[], args['to'] as number[])
    case 'paste_region': {
      const clip = ctx.clipboard.current
      if (clip === undefined) {
        return failure(
          'NOT_FOUND',
          'The clipboard is empty — nothing has been copied yet.',
          'Call copy_region{from,to} before batching a paste_region.',
        )
      }
      return planPasteTool(
        ctx,
        clip,
        toPos(args['at'], 'at'),
        args['rotate'] as Parameters<typeof planPasteTool>[3],
        args['mirror'] as Parameters<typeof planPasteTool>[4],
        args['mode'] as Parameters<typeof planPasteTool>[5],
      )
    }
    default:
      return failure(
        'INVALID_ARGS',
        `"${tool}" cannot be batched.`,
        `run_batch accepts only: ${[...BATCHABLE].join(', ')}. Call store-reading tools (symmetrize, replace_blocks, fix_states) separately.`,
      )
  }
}

interface Pending {
  blockIndex: number
  stateId: number
}

export const runBatchTool = defineTool<{
  ops: Array<{ tool: string; args: Record<string, unknown> }>
  confirm?: boolean
}>({
  name: 'run_batch',
  description:
    '**Pack several edits into one atomic commit** — one revision, one confirmation, one screenshot. This is the main lever on round trips: prefer one run_batch of 5 edits over 5 separate calls.\n' +
    'Ops run **in order** and later ops win on overlapping cells. If any op is invalid the whole batch is aborted and **nothing is written**.\n' +
    'Allowed op tools: fill_box, fill_line, fill_plane, extrude, place_block, erase, paste_region. ' +
    'symmetrize / replace_blocks / fix_states / copy_region read wide swathes of the world and must be called on their own.\n' +
    '`mode: keep` / `overlay` inside a batch are evaluated against the world before the batch plus what earlier ops in the same batch decided.',
  parameters: obj(
    {
      ops: arr(
        'Operations in execution order. Each item is {tool, args} where tool is one of the allowed names and args is that tool\'s own argument object.',
        obj(
          {
            tool: {
              type: 'string',
              description: 'Which tool to run.',
              enum: ['fill_box', 'fill_line', 'fill_plane', 'extrude', 'place_block', 'erase', 'paste_region'],
            },
            args: {
              type: 'object',
              description: 'That tool\'s arguments, exactly as if you had called it directly (omit confirm).',
              additionalProperties: true,
            },
          },
          ['tool', 'args'],
        ),
        { minItems: 1, maxItems: MAX_BATCH_OPS },
      ),
      confirm: bool(
        'Explicitly confirm an operation above the confirmation threshold. The dry-run preview covers **all** ops combined, so you only need to confirm once.',
      ),
    },
    ['ops'],
  ),
  mutating: true,
  destructive: true,
  execute: (ctx, args): ToolResult => {
    const ops = args.ops
    if (ops.length === 0) {
      return failure('INVALID_ARGS', 'ops is empty.', 'Pass at least one operation.')
    }
    if (ops.length > MAX_BATCH_OPS) {
      return failure(
        'TOO_LARGE',
        `${ops.length} operations exceeds the batch limit of ${MAX_BATCH_OPS}.`,
        'Split into several run_batch calls.',
      )
    }

    // ── 1. 先把所有 op 的计划都算出来。任何一个失败就整批中止，一格都不写。──
    const plans: EditPlan[] = []
    for (const [index, op] of ops.entries()) {
      const plan = planBatchOp(ctx, op.tool, op.args ?? {})
      if (isToolResult(plan)) {
        return {
          ...plan,
          summary: `Batch aborted at ops[${index}] (${op.tool}), nothing was written. ${plan.summary}`,
          data: { ...(plan.data ?? {}), abortedAt: index, abortedTool: op.tool },
        }
      }
      plans.push(plan)
    }

    // ── 2. 按顺序解算每一格的最终意图 ──────────────────────────────────────────
    const table = ctx.store.palette.toGlobalStateIds()
    const pending = new Map<string, Pending>()

    const currentStateId = (x: number, y: number, z: number): number =>
      pending.get(`${x},${y},${z}`)?.stateId ?? ctx.store.getBlockStateId({ x, y, z })

    for (const plan of plans) {
      const emit: CellEmitter = (x, y, z, override) => {
        const blockIndex = override ?? plan.blockIndex
        const targetStateId = plan.mode === 'destroy' ? AIR_STATE_ID : table[blockIndex]
        if (targetStateId === undefined) return
        const from = currentStateId(x, y, z)
        if (plan.mode === 'keep' && from !== AIR_STATE_ID) return
        if (plan.mode === 'overlay' && from === AIR_STATE_ID) return
        if (from === targetStateId) return
        pending.set(`${x},${y},${z}`, { blockIndex, stateId: targetStateId })
      }
      plan.cells(emit)
    }

    if (pending.size === 0 && !plans.some((plan) => plan.sparse !== undefined)) {
      return {
        ok: true,
        summary: `run_batch: ${plans.length} operation(s) produced no changes (everything was already as requested, or every cell was filtered out by keep/overlay).`,
        data: { ops: plans.length, changed: 0, revision: ctx.store.revision },
      }
    }

    // ── 3. 一次提交。dry-run 预览与确认阈值由 writeBlocks 在**合并后**判定。──
    //
    // 稀疏层（实体与方块实体）也在这**一次**提交里：`writeLayered` 先落方块
    // （顺路剪掉被写格子上的旧方块实体），再跑各 op 的稀疏层意图，**只推进一格版本**。
    // 意图按 op 顺序拼起来，所以后面 op 写同一个格子时覆盖前面的——与方块一致。
    const cells = [...pending.entries()].map(([key, value]) => {
      const [x, y, z] = key.split(',').map(Number) as [number, number, number]
      return { x, y, z, blockIndex: value.blockIndex }
    })
    const writers = plans.map((plan) => plan.sparse).filter((sparse) => sparse !== undefined)
    const result = ctx.store.writeLayered(
      (emit) => {
        for (const cell of cells) emit(cell.x, cell.y, cell.z, cell.blockIndex)
      },
      (write) => mergeSparse(writers.map((sparse) => sparse(write))),
      { mode: 'replace', confirm: args.confirm === true },
    )

    if (!result.ok) {
      // dry-run 预览：revision 没动，LLM 看过之后带 confirm:true 重发
      const preview = result.preview
      const breakdown = Object.entries(preview.overwriteBreakdown)
        .map(([name, count]) => `${name}×${count}`)
        .join(', ')
      return {
        ok: false,
        summary:
          `run_batch would change ${preview.willChange} cell(s) across ${plans.length} operation(s), ` +
          `overwriting ${preview.willOverwriteNonAir} non-air cell(s) — above the confirmation threshold. ` +
          `Overwritten blocks: ${breakdown || '(none)'}.`,
        data: { preview, needsConfirm: true, ops: plans.length },
        error: {
          code: 'NEEDS_CONFIRM',
          message: 'Batch size exceeds the confirmation threshold',
          hint: 'Explain what would be overwritten and why that is acceptable, then re-call run_batch with confirm: true.',
        },
      }
    }

    // `sparse` 必须回传给 `record`：那一笔 op 要同时记下三层，否则撤销/重放会丢掉
    // 批处理里粘贴带过来的船与箱子内容。
    ctx.record('run_batch', args, result, result.sparse)
    const bounds = result.bounds
    const where =
      bounds === undefined
        ? '(no change)'
        : `(${bounds.min.x},${bounds.min.y},${bounds.min.z})..(${bounds.max.x},${bounds.max.y},${bounds.max.z})`
    const sources = Object.fromEntries(
      [...new Set(plans.map((_, index) => ops[index]!.tool))].map((tool) => [
        tool,
        ops.filter((op) => op.tool === tool).length,
      ]),
    )
    return {
      ok: true,
      summary:
        `run_batch applied ${plans.length} operation(s) as **one revision** (${result.revision}): ` +
        `${result.changed} cell(s) changed, bounds ${where}.` +
        sparseSummary(result.sparse) +
        (result.overwrittenNonAir > 0 ? ` Overwrote ${result.overwrittenNonAir} non-air cell(s).` : '') +
        (result.clipped > 0 ? ` Clipped ${result.clipped} cell(s) outside the world height.` : '') +
        `\nOps: ${JSON.stringify(sources)}. Now read the result back with verify().`,
      data: {
        revision: result.revision,
        changed: result.changed,
        ops: plans.length,
        byTool: sources,
        overwrittenNonAir: result.overwrittenNonAir,
        clipped: result.clipped,
        bounds,
      },
    }
  },
})

export const replaceBlocksTool = defineTool<{
  from: number[]
  to: number[]
  blocks: string[]
  with: string
  confirm?: boolean
}>({
  name: 'replace_blocks',
  description:
    '**Material swap**: inside the box, replace every cell whose block is one of `blocks` with `with`.\n' +
    'Use it to recolor a finished shape (e.g. swap all oak_planks and oak_log for spruce) instead of rebuilding it. ' +
    'Only the block **name** is matched — properties like stair facing are ignored on purpose, so a whole staircase recolors in one call.\n' +
    'Reads the world, so it cannot be nested inside run_batch.',
  parameters: obj(
    {
      from: vec3('One corner of the box [x,y,z].'),
      to: vec3('The opposite corner [x,y,z]. Inclusive.'),
      blocks: arr(
        'Block names to replace. Matching ignores properties, so "minecraft:oak_stairs" catches every facing.',
        str('block name'),
        { minItems: 1 },
      ),
      with: blockRef('The block to write in their place.'),
      confirm: bool('Explicitly confirm an operation above the confirmation threshold. Review the dry-run preview first.'),
    },
    ['from', 'to', 'blocks', 'with'],
  ),
  mutating: true,
  destructive: false,
  execute: (ctx, args) => {
    const from = toPos(args.from, 'from')
    const to = toPos(args.to, 'to')
    const wanted = new Set(args.blocks.map((name) => name.replace(/^minecraft:/, '')))
    // 目标方块也要走 resolveBlock：未知名字要给出候选，而不是抛成不可自纠的 INTERNAL
    const target = resolveBlock(ctx.store, args.with)
    if (isToolResult(target)) return target

    const min = { x: Math.min(from.x, to.x), y: Math.min(from.y, to.y), z: Math.min(from.z, to.z) }
    const max = { x: Math.max(from.x, to.x), y: Math.max(from.y, to.y), z: Math.max(from.z, to.z) }

    // 先扫一遍定下要改哪些格子，再一次性提交：这样 dry-run 预览与确认阈值
    // 判的是**真正会被改的那批格子**，而不是整个盒子的体积。
    const hits: Array<{ x: number; y: number; z: number }> = []
    const seen = new Map<string, number>()
    for (let y = min.y; y <= max.y; y++) {
      for (let z = min.z; z <= max.z; z++) {
        for (let x = min.x; x <= max.x; x++) {
          const stateId = ctx.store.getBlockStateId({ x, y, z })
          if (stateId === AIR_STATE_ID) continue
          const name = ctx.store.registry.blockByStateId(stateId)?.name
          if (name === undefined || !wanted.has(name)) continue
          hits.push({ x, y, z })
          seen.set(name, (seen.get(name) ?? 0) + 1)
        }
      }
    }

    if (hits.length === 0) {
      return {
        ok: true,
        summary:
          `replace_blocks found no cell matching ${args.blocks.join(', ')} inside ` +
          `(${min.x},${min.y},${min.z})..(${max.x},${max.y},${max.z}). Nothing changed.`,
        data: { changed: 0, revision: ctx.store.revision },
      }
    }

    const result = ctx.store.write(
      (emit) => {
        for (const hit of hits) emit(hit.x, hit.y, hit.z)
      },
      target,
      { confirm: args.confirm === true },
    )
    if (!result.ok) {
      return {
        ok: false,
        summary: `replace_blocks would change ${hits.length} cell(s), above the confirmation threshold.`,
        data: { preview: result.preview, needsConfirm: true, matched: Object.fromEntries(seen) },
        error: {
          code: 'NEEDS_CONFIRM',
          message: 'Replacement size exceeds the confirmation threshold',
          hint: 'Explain what would be overwritten and why that is acceptable, then re-call with confirm: true.',
        },
      }
    }
    ctx.record('replace_blocks', args, result)
    return {
      ok: true,
      summary:
        `replace_blocks swapped ${result.changed} cell(s) to ${args.with} ` +
        `(matched ${Object.entries(seen).map(([name, count]) => `${name}×${count}`).join(', ')}). ` +
        `revision ${result.revision}.`,
      data: {
        revision: result.revision,
        changed: result.changed,
        matched: Object.fromEntries(seen),
      },
    }
  },
})

/** 供 `registry` 注册时统一引用，避免 `index.ts` 里出现一长串导入。 */
export const batchTools = [runBatchTool, replaceBlocksTool]
