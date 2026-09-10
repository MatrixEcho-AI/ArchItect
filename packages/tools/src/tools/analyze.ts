import { formatLintReport, lintStructure } from '@architect/core'
import type { Bounds } from '@architect/core'

import { int, num, obj, vec3 } from '../schema.js'
import { defineTool, failure } from '../types.js'
import { toPos } from './edit.js'

type AnalyzeArgs = {
  from?: number[]
  to?: number[]
  maxOverhang?: number
  minDoorClearance?: number
  minHeadroom?: number
  symmetryAxis?: 'x' | 'y' | 'z'
  symmetryCoordinate?: number
}

/**
 * `analyze_structure`：建筑 linter 的工具外壳。
 *
 * **只读**：不写方块、不递增 revision、不记 EditOp——它只是把 `lintStructure` 的纯函数结果
 * 翻成「紧凑英文文本 + 结构化 data」。文本里的样本坐标已经在 linter 里限过（每条 ≤ 8 个），
 * 所以结果不会随建筑规模膨胀。
 */
export const analyzeStructureTool = defineTool<AnalyzeArgs>({
  name: 'analyze_structure',
  description:
    'Building linter (read-only, does not change the world). Runs seven structural checks over the whole ' +
    'build or an optional region, and returns a score plus one entry per problem:\n' +
    '1. floating (error): a block with nothing supporting it anywhere below in its own column; ' +
    'blocks with no collision shape (torches, flowers, signs) are ignored because they are legitimately airborne.\n' +
    '2. cantilever (warn): a block whose nearest support one level below is more than maxOverhang blocks away horizontally.\n' +
    '3. doorway (warn): an opening at floor level in a wall that is less than minDoorClearance blocks high ' +
    '(it may be an intended window, so this is a warning, not an error), or a *_door lower half with no matching ' +
    'upper half above it (an incomplete door). A normal door with wall above it is correct and NOT reported.\n' +
    '4. headroom (warn): a walkable cell with less than minHeadroom blocks of clearance to the ceiling above.\n' +
    '5. leaky (warn): interior air that connects to the outside across the content bounding box ' +
    '(intended doors and windows count as connections).\n' +
    '6. palette (info): how many distinct block types are used, and which types appear in fewer than 3 cells.\n' +
    '7. symmetry (info): how well the build mirrors across a plane (score 0..1).\n' +
    'Severity matters: only `floating` is an error, and errors are what block completion — ' +
    'warnings and info are advice. A passing analyze_structure (no errors) satisfies the completion gate. ' +
    'score is 0..100 and is 100 when there are no errors and no warnings. ' +
    'Sample coordinates are capped at 8 per finding, so the output stays cheap. ' +
    'Run it at the end of a build stage, and always before claiming the build is complete.',
  parameters: obj(
    {
      from: vec3('First corner [x,y,z] of the region to analyze. Omit to analyze all content.'),
      to: vec3('Second corner [x,y,z] of the region to analyze. Must be given together with from.'),
      maxOverhang: int('How many blocks of horizontal offset still count as supported, default 4.', { minimum: 0 }),
      minDoorClearance: int('Minimum walkable opening height in blocks, default 2.', { minimum: 1 }),
      minHeadroom: int('Minimum head clearance for a walkable cell in blocks, default 2.', { minimum: 1 }),
      symmetryAxis: {
        type: 'string',
        description:
          'Axis of the mirror plane to test, default x. When omitted, the centre planes on x, y and z are all ' +
          'tested and the best-scoring one is reported as the dominant plane.',
        enum: ['x', 'y', 'z'],
      },
      symmetryCoordinate: num(
        'Coordinate of the mirror plane (may sit between cells, e.g. 2.5). Default: centre of the analyzed region.',
      ),
    },
    [],
  ),
  mutating: false,
  destructive: false,
  execute: (ctx, args) => {
    const hasFrom = args.from !== undefined
    const hasTo = args.to !== undefined
    if (hasFrom !== hasTo) {
      return failure(
        'INVALID_ARGS',
        'from and to must be provided together',
        'Pass both corners of the region as [x,y,z], or neither to analyze all content.',
      )
    }

    let region: Bounds | undefined
    if (hasFrom && hasTo) {
      const a = toPos(args.from, 'from')
      const b = toPos(args.to, 'to')
      region = {
        min: { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), z: Math.min(a.z, b.z) },
        max: { x: Math.max(a.x, b.x), y: Math.max(a.y, b.y), z: Math.max(a.z, b.z) },
      }
    }

    const report = lintStructure(ctx.store, {
      ...(region !== undefined ? { region } : {}),
      ...(args.maxOverhang !== undefined ? { maxOverhang: args.maxOverhang } : {}),
      ...(args.minDoorClearance !== undefined ? { minDoorClearance: args.minDoorClearance } : {}),
      ...(args.minHeadroom !== undefined ? { minHeadroom: args.minHeadroom } : {}),
      ...(args.symmetryAxis !== undefined ? { symmetryAxis: args.symmetryAxis } : {}),
      ...(args.symmetryCoordinate !== undefined ? { symmetryCoordinate: args.symmetryCoordinate } : {}),
    })

    let errors = 0
    let warnings = 0
    for (const finding of report.findings) {
      if (finding.severity === 'error') errors += finding.count
      else if (finding.severity === 'warn') warnings += finding.count
    }

    return {
      ok: true,
      summary: formatLintReport(report),
      data: {
        region: [
          [report.region.min.x, report.region.min.y, report.region.min.z],
          [report.region.max.x, report.region.max.y, report.region.max.z],
        ],
        blocks: report.blocks,
        score: report.score,
        errors,
        warnings,
        // 结构化读回：没有 error 级问题就把它算作"已读回"，可以清掉完成闸门
        readback: errors === 0,
        findings: report.findings.map((finding) => ({
          id: finding.id,
          severity: finding.severity,
          count: finding.count,
          summary: finding.summary,
          samples: finding.samples.map((p) => [p.x, p.y, p.z]),
        })),
      },
    }
  },
})
