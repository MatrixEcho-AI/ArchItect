import { fixStates, normalizeBounds } from '@architect/core'
import type { Bounds } from '@architect/core'

import { bool, obj, vec3 } from '../schema.js'
import { defineTool, failure } from '../types.js'
import { toPos, writeResultToTool } from './edit.js'

/** 把 byRule 计数排成一行英文，保持规则键原样（协议标识，不翻译）。 */
function formatByRule(byRule: Record<string, number>): string {
  return Object.entries(byRule)
    .map(([rule, count]) => `${rule}=${count}`)
    .join(', ')
}

/**
 * `fix_states` 工具：对区域跑一遍 state 自动修正 pass。
 *
 * 纯逻辑在 `@architect/core` 的 `fixStates` 里；这里只做参数解析、结果翻成英文摘要，
 * 并把 `fix` 报告塞进 `data`（键名是协议标识）。
 */
export const fixStatesTool = defineTool<{
  from?: number[]
  to?: number[]
  confirm?: boolean
}>({
  name: 'fix_states',
  description:
    'Repair block states that are locally inconsistent with their neighbours: fence / wall / glass-pane / iron-bars connection booleans (north, south, east, west), the wall post (up), and stair shape (straight / inner_* / outer_*). waterlogged is never touched.\n' +
    'Run it after symmetrize, paste_region, rotate or any bulk fill that placed connection blocks with their default side values.\n' +
    'Only cells that are actually inconsistent are rewritten, and the whole pass commits as exactly ONE revision, so a single undo removes it entirely. It is idempotent: running it a second time changes nothing.\n' +
    'from and to optionally restrict the repair to a box (both must be given together); omit both to repair the whole volume. The result reports how many cells each rule fixed. Half-slabs or stairs that are completely enclosed by solid blocks are reported but NOT modified.',
  parameters: obj(
    {
      from: vec3('Optional first corner [x,y,z] of the box to repair. Give it together with to, or omit both.'),
      to: vec3('Optional opposite corner [x,y,z] of the box to repair. Give it together with from, or omit both.'),
      confirm: bool(
        'Explicitly confirm a repair that exceeds the confirm threshold. Decide after reading the dry-run preview.',
      ),
    },
    [],
  ),
  mutating: true,
  destructive: false,
  execute: (ctx, args) => {
    let region: Bounds | undefined
    if (args.from !== undefined || args.to !== undefined) {
      if (args.from === undefined || args.to === undefined) {
        return failure(
          'INVALID_ARGS',
          'from and to must be provided together (or both omitted to repair the whole volume).',
        )
      }
      region = normalizeBounds(toPos(args.from, 'from'), toPos(args.to, 'to'))
    }

    const result = fixStates(ctx.store, {
      ...(region !== undefined ? { region } : {}),
      confirm: args.confirm === true,
    })
    const toolResult = writeResultToTool(ctx, 'fix_states', args, result)
    if (!result.ok) return toolResult

    const fix = result.fix
    toolResult.data = { ...toolResult.data, fix }
    toolResult.summary += ` Repaired by rule: ${formatByRule(fix.byRule)}.`

    const embedded = fix.byRule.embedded_partial ?? 0
    if (embedded > 0) {
      const sample = fix.embeddedSample.map((p) => `[${p.x},${p.y},${p.z}]`).join(' ')
      toolResult.summary +=
        ` ${embedded} hidden slab/stair cell(s) are completely enclosed by solid blocks and were reported but NOT modified` +
        `${sample.length > 0 ? `: ${sample}` : ''}.`
    }
    return toolResult
  },
})
