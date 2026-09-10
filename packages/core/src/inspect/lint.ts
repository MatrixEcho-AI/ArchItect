import { boundsIntersect, normalizeBounds } from '../geometry/box.js'
import { AIR_STATE_ID } from '../palette.js'
import { stateIdToProperties } from '../state.js'
import type { Bounds, Pos } from '../types.js'
import type { Axis } from '../world/symmetrize.js'
import type { WorldStore } from '../world/store.js'

/**
 * 建筑 linter（plan §8.2 的 `analyze_structure`）。
 *
 * 这是一个**纯函数模块**：输入是 `(store, options)`，输出是一份确定性的体检报告，
 * 不碰工具层、不碰 LLM、不产生任何 revision。
 *
 * 性能约定（几百 k 非空气方块也要跑得动）：
 * - **只对世界做一遍 `forEachNonAir` 扫描**，顺路建出「每列的非空气 y 列表」「方块直方图」
 *   「悬空候选」，后续所有检查都复用这些数据，不再重建大表。
 * - 门洞 / 净高 / 对称性 / 漏水都从「每列 y 列表」推，不逐格扫描整个包围盒
 *   （唯一的例外是漏水分析：它真的需要一次有界的空气洪泛，见 `analyzeLeak`）。
 * - `forEachNonAir` 对每个 `(x,z)` 是按 y 升序访问的，所以每列的 y 列表天然有序；
 *   代码里仍保留一次 O(n) 的有序性校验 + 兜底排序，避免上游遍历顺序变化时静默算错。
 * - 所有 `samples` 都用一个「只保留最小的 N 个坐标」的收集器，结果与遍历顺序无关，
 *   因此同一世界必然得到同一份报告（含 samples 顺序）。
 */

/** 悬挑的默认容差：y-1 层最近支撑超过这么多格才算无支撑悬挑。 */
export const LINT_DEFAULT_MAX_OVERHANG = 4
/** 门洞净高的默认下限（格）。 */
export const LINT_DEFAULT_MIN_DOOR_CLEARANCE = 2
/** 楼层净高的默认下限（格）。 */
export const LINT_DEFAULT_MIN_HEADROOM = 2
/** 调色板「嘈杂」的默认阈值（不同方块类型数）。 */
export const LINT_NOISY_PALETTE_TYPES = 24
/** 使用格数少于这个值的方块被认为是「一次性 / 遗留试块」。 */
export const LINT_RARE_BLOCK_CELLS = 3
/** 每条 finding 最多回带多少个样本坐标（LLM 结果的成本上限）。 */
export const LINT_MAX_SAMPLES = 8
/** 悬挑搜索在 `maxOverhang` 之外再多探这么多圈，用于给出「最坏离支撑多远」。 */
const OVERHANG_SEARCH_EXTRA = 4
/** 漏水洪泛的包围盒格数上限，超过就跳过（避免为一个空包围盒分配几百 MB）。 */
const LEAK_MAX_CELLS = 4_000_000

export type LintSeverity = 'error' | 'warn' | 'info'

/** 七项检查的稳定 id（LLM 与测试都按它对齐）。 */
export type LintFindingId =
  | 'floating'
  | 'cantilever'
  | 'doorway'
  | 'headroom'
  | 'leaky'
  | 'palette'
  | 'symmetry'

export interface LintOptions {
  /** 分析范围；默认取内容包围盒，内容为空时取工区。 */
  region?: Bounds
  /** 悬挑容差（格），默认 4。 */
  maxOverhang?: number
  /** 门洞净高下限（格），默认 2。 */
  minDoorClearance?: number
  /** 楼层净高下限（格），默认 2。 */
  minHeadroom?: number
  /** 对称性检测的轴；不传时对三条中心面各测一次并取分最高者。 */
  symmetryAxis?: Axis
  /** 对称面坐标（可以落在格心之间，如 2.5）；不传时取分析范围中心。 */
  symmetryCoordinate?: number
}

export interface LintFinding {
  id: LintFindingId
  severity: LintSeverity
  count: number
  /** 面向 LLM 的一句话说明（英文）。 */
  summary: string
  /** 最多 `LINT_MAX_SAMPLES` 个代表坐标（确定性排序）。 */
  samples: Pos[]
}

export interface LintReport {
  region: Bounds
  /** 分析范围内的非空气方块数。 */
  blocks: number
  findings: LintFinding[]
  /** 0..100，无 error 且无 warn 时为 100。公式见 `computeScore`。 */
  score: number
}

/** 每列扫描结果。`ys` 升序，**包含分析范围之外的方块**（它们同样能提供支撑）。 */
interface ColumnScan {
  x: number
  z: number
  ys: number[]
}

export function lintStructure(store: WorldStore, options: LintOptions = {}): LintReport {
  const maxOverhang = normalizeInt(options.maxOverhang, LINT_DEFAULT_MAX_OVERHANG, 0)
  const minDoorClearance = normalizeInt(options.minDoorClearance, LINT_DEFAULT_MIN_DOOR_CLEARANCE, 1)
  const minHeadroom = normalizeInt(options.minHeadroom, LINT_DEFAULT_MIN_HEADROOM, 1)

  // 指定了 region 就用它做扫描过滤；没指定时先按工区扫，扫完再用**扫描中顺路算出的**
  // 内容包围盒收口。这样"默认分析全部内容"也不需要额外调一次 contentBounds()（那是一次全量扫描）。
  const filterRegion = options.region !== undefined ? clampRegion(store, options.region) : store.volume

  // ── 唯一的全量扫描 ────────────────────────────────────────────────
  // 顺路产出：每列 y 列表（悬空 / 悬挑 / 净高 / 门洞 / 漏水共用）、内容包围盒、
  // 方块直方图、门上半扇被堵的计数。热路径里不分配 Pos 对象（复用 `probe`）。
  const columns = new Map<number, ColumnScan>()
  const paletteCounts = new Map<string, number>()
  const firstPos = new Map<string, Pos>()
  const floatingSamples = new SampleSet(LINT_MAX_SAMPLES, compareYThenXZ)
  const doorwaySamples = new SampleSet(LINT_MAX_SAMPLES, compareYThenXZ)
  const cantileverCandidates: number[] = []
  const floatingCandidates: number[] = []
  const probe: Pos = { x: 0, y: 0, z: 0 }

  let blocks = 0
  let blockedDoorCount = 0
  let hasContent = false
  let contentMinX = 0
  let contentMinY = 0
  let contentMinZ = 0
  let contentMaxX = 0
  let contentMaxY = 0
  let contentMaxZ = 0

  store.forEachNonAir((x, y, z, stateId) => {
    const key = columnKey(x, z)
    let column = columns.get(key)
    if (column === undefined) {
      column = { x, z, ys: [] }
      columns.set(key, column)
    }
    const previous = column.ys.length > 0 ? column.ys[column.ys.length - 1]! : Number.NaN
    const isColumnMin = column.ys.length === 0
    column.ys.push(y)

    if (!insideRegion(filterRegion, x, y, z)) return

    blocks++
    if (!hasContent) {
      contentMinX = contentMaxX = x
      contentMinY = contentMaxY = y
      contentMinZ = contentMaxZ = z
      hasContent = true
    } else {
      if (x < contentMinX) contentMinX = x
      if (x > contentMaxX) contentMaxX = x
      if (y < contentMinY) contentMinY = y
      if (y > contentMaxY) contentMaxY = y
      if (z < contentMinZ) contentMinZ = z
      if (z > contentMaxZ) contentMaxZ = z
    }

    const block = store.registry.blockByStateId(stateId)
    const name = block === undefined ? `state:${stateId}` : block.name
    paletteCounts.set(name, (paletteCounts.get(name) ?? 0) + 1)
    if (!firstPos.has(name)) firstPos.set(name, { x, y, z })

    const shaped = store.registry.shapesOf(stateId).length > 0

    // 悬空：候选只可能是每列的最低格——上方那些只要本格有支撑就必然也有支撑。
    // y 升序访问 → 列表为空即该列最低格。是否豁免（坐在工区底板上）要等最终
    // region 定下来才知道，所以先收进候选，留到后面判。
    if (isColumnMin && shaped) floatingCandidates.push(x, y, z)

    // 悬挑：正下方有支撑（距离 0）就不可能超标，先剪掉绝大多数方块。
    if (shaped && previous !== y - 1) cantileverCandidates.push(x, y, z)

    // 门：**下半扇正上方不是它自己的上半扇** → 这个门是残的，走不过去。
    //
    // 注意方向：判据是"上面缺了"，不是"上面有东西"。门的上半扇之上当然是墙——
    // 那是所有正常门的做法。反过来判会把每一扇装在墙里的门都报成问题。
    if (block !== undefined && name.endsWith('_door')) {
      const properties = stateIdToProperties(block, stateId)
      if (properties['half'] === 'lower') {
        probe.x = x
        probe.y = y + 1
        probe.z = z
        const aboveId = store.getBlockStateId(probe)
        const aboveBlock = store.registry.blockByStateId(aboveId)
        const hasMatchingUpper =
          aboveBlock !== undefined &&
          aboveBlock.name === name &&
          stateIdToProperties(aboveBlock, aboveId)['half'] === 'upper'
        if (!hasMatchingUpper) {
          blockedDoorCount++
          doorwaySamples.push({ x, y, z })
        }
      }
    }
  })

  // 最终分析范围：显式 region 优先；否则用扫描中算出的内容包围盒（空世界回落到工区）。
  const contentBounds: Bounds | undefined = hasContent
    ? {
        min: { x: contentMinX, y: contentMinY, z: contentMinZ },
        max: { x: contentMaxX, y: contentMaxY, z: contentMaxZ },
      }
    : undefined
  const region: Bounds = options.region !== undefined ? filterRegion : (contentBounds ?? store.volume)

  // ── 悬空（error） ───────────────────────────────────────────────
  //
  // 判据：**从这一格往下一直找到工区底板，整列都没有非空气**才算悬空。
  //
  // 两处容易做错的地方：
  // ① 不能把"分析范围的最低一层"当成地面。默认范围是内容包围盒，而一块悬空平台
  //    自己的底面就是那个包围盒的最低层——那样判的话，最该被抓到的悬空平台永远不报。
  //    地面是**工区底板**（`volume.min.y`），不是分析范围的底。
  // ② 不能只比较 `region.min.y`。给了一个局部范围（比如只分析 y=5..10）时，
  //    下面 y<5 的地方完全可能有楼板撑着，必须真的往下扫一遍。
  const volumeFloor = store.volume.min.y
  const inRegion = (x: number, y: number, z: number): boolean =>
    x >= region.min.x && x <= region.max.x &&
    y >= region.min.y && y <= region.max.y &&
    z >= region.min.z && z <= region.max.z

  let floatingCount = 0
  for (let i = 0; i + 2 < floatingCandidates.length; i += 3) {
    const x = floatingCandidates[i]!
    const y = floatingCandidates[i + 1]!
    const z = floatingCandidates[i + 2]!
    if (!inRegion(x, y, z)) continue
    // 坐在工区底板上的那一层就是"地面"，它当然不算悬空
    if (y <= volumeFloor) continue
    let supported = false
    for (let below = y - 1; below >= volumeFloor; below--) {
      if (!store.isAir({ x, y: below, z })) {
        supported = true
        break
      }
    }
    if (supported) continue
    // **吊挂**也是支撑：灯笼吊在链子上、告示牌挂在墙上时，下面本来就是空的。
    // 只看下方会把所有悬挂物误判成悬空——而悬空是 error，会直接把完成闸门卡死。
    probe.x = x
    probe.y = y + 1
    probe.z = z
    if (y + 1 <= store.volume.max.y && store.getBlockStateId(probe) !== AIR_STATE_ID) continue
    floatingCount++
    floatingSamples.push({ x, y, z })
  }

  for (const column of columns.values()) {
    if (!isSortedAscending(column.ys)) column.ys.sort((a, b) => a - b)
  }

  // ── 悬挑（warn） ────────────────────────────────────────────────
  const overhangCap = maxOverhang + OVERHANG_SEARCH_EXTRA
  let cantileverCount = 0
  let worstOverhang = 0
  let cantileverSamples = new SampleSet(LINT_MAX_SAMPLES, compareYThenXZ)

  for (let i = 0; i + 2 < cantileverCandidates.length; i += 3) {
    const x = cantileverCandidates[i]!
    const y = cantileverCandidates[i + 1]!
    const z = cantileverCandidates[i + 2]!
    if (y <= region.min.y) continue // 地面一层豁免
    const distance = nearestSupportDistance(columns, x, y - 1, z, overhangCap)
    if (distance <= maxOverhang) continue
    cantileverCount++
    const pos: Pos = { x, y, z }
    if (distance > worstOverhang) {
      // 只保留「最坏的一批」——重新开一个收集器，样本数不会累积。
      worstOverhang = distance
      cantileverSamples = new SampleSet(LINT_MAX_SAMPLES, compareYThenXZ)
      cantileverSamples.push(pos)
    } else if (distance === worstOverhang) {
      cantileverSamples.push(pos)
    }
  }

  // ── 门洞 / 净高（复用每列 y 列表，不逐格扫包围盒） ─────────────
  const headroomSamples = new SampleSet(LINT_MAX_SAMPLES, compareYThenXZ)
  const shapedAt = (x: number, y: number, z: number): boolean => {
    probe.x = x
    probe.y = y
    probe.z = z
    const stateId = store.getBlockStateId(probe)
    return stateId !== AIR_STATE_ID && store.registry.shapesOf(stateId).length > 0
  }

  let headroomCount = 0
  let doorwayCount = blockedDoorCount

  for (const column of columns.values()) {
    if (column.x < region.min.x || column.x > region.max.x) continue
    if (column.z < region.min.z || column.z > region.max.z) continue
    const ys = column.ys
    for (let i = 0; i + 1 < ys.length; i++) {
      const floorY = ys[i]!
      const ceilingY = ys[i + 1]!
      const gap = ceilingY - floorY - 1
      if (gap <= 0) continue
      const airY = floorY + 1
      if (floorY < region.min.y || ceilingY > region.max.y || airY > region.max.y) continue
      if (!shapedAt(column.x, floorY, column.z)) continue

      // 净高：可站立的格子上方到天花板的净空不足。
      if (gap < minHeadroom) {
        headroomCount++
        headroomSamples.push({ x: column.x, y: floorY, z: column.z })
      }

      // 门洞：一段夹在上下两块实体之间的空气竖井，且底部两侧至少有一对**对面**是实体，
      // 才算是「墙上的洞」，而不是开阔地里两块石头之间的缝。
      if (gap < minDoorClearance) {
        const oppositeX = shapedAt(column.x - 1, airY, column.z) && shapedAt(column.x + 1, airY, column.z)
        const oppositeZ = shapedAt(column.x, airY, column.z - 1) && shapedAt(column.x, airY, column.z + 1)
        if (oppositeX || oppositeZ) {
          doorwayCount++
          doorwaySamples.push({ x: column.x, y: airY, z: column.z })
        }
      }
    }
  }

  // ── 漏水（warn） ────────────────────────────────────────────────
  const leak = analyzeLeak(store, contentBounds, columns)

  // ── 调色板（info） ─────────────────────────────────────────────
  let paletteFinding: LintFinding | undefined
  if (blocks > 0) {
    const distinct = paletteCounts.size
    const rare: Array<{ name: string; count: number }> = []
    for (const [name, count] of paletteCounts) {
      if (count < LINT_RARE_BLOCK_CELLS) rare.push({ name, count })
    }
    rare.sort((a, b) => a.count - b.count || a.name.localeCompare(b.name))

    const rareSamples = new SampleSet(
      LINT_MAX_SAMPLES,
      (a, b) => a.x - b.x || a.y - b.y || a.z - b.z,
    )
    for (const entry of rare) {
      const pos = firstPos.get(entry.name)
      if (pos !== undefined) rareSamples.push(pos)
    }

    const noisy = distinct > LINT_NOISY_PALETTE_TYPES
    const listed = rare
      .slice(0, LINT_MAX_SAMPLES)
      .map((entry) => `minecraft:${entry.name} (${entry.count})`)
      .join(', ')
    const paletteSummary = [
      `${distinct} distinct block type(s) used`,
      noisy
        ? `this exceeds the noise threshold of ${LINT_NOISY_PALETTE_TYPES} — the palette may look incoherent`
        : `no palette noise (> ${LINT_NOISY_PALETTE_TYPES} types)`,
      rare.length === 0
        ? `no block type is used in fewer than ${LINT_RARE_BLOCK_CELLS} cells`
        : `${rare.length} block type(s) appear in fewer than ${LINT_RARE_BLOCK_CELLS} cells (likely one-off leftovers): ${listed}`,
    ].join('; ')
    paletteFinding = {
      id: 'palette',
      severity: 'info',
      count: distinct,
      summary: `${paletteSummary}.`,
      samples: rareSamples.list(),
    }
  }

  // ── 对称性（info） ─────────────────────────────────────────────
  const symmetryFinding = blocks > 0 ? buildSymmetryFinding(store, region, columns, options) : undefined

  const findings: LintFinding[] = []
  if (floatingCount > 0) {
    findings.push({
      id: 'floating',
      severity: 'error',
      count: floatingCount,
      summary:
        `${floatingCount} column(s) have a block with nothing supporting it all the way down to the ` +
        `build-volume floor (y=${volumeFloor}); the whole column was tested, so a ceiling resting on a wall ` +
        `is not floating. ` +
        `Blocks whose collision shape list is empty (torches, flowers, signs, redstone dust) are ignored — ` +
        `they are legitimately airborne.`,
      samples: floatingSamples.list(),
    })
  }
  if (cantileverCount > 0) {
    findings.push({
      id: 'cantilever',
      severity: 'warn',
      count: cantileverCount,
      summary:
        `${cantileverCount} block(s) have no support within ${maxOverhang} block(s) horizontally at y-1 ` +
        `(Chebyshev distance, searched up to ${overhangCap}); worst distance observed: ${worstOverhang}${worstOverhang > overhangCap ? '+' : ''}. ` +
        `Blocks with no collision shape are ignored.`,
      samples: cantileverSamples.list(),
    })
  }
  if (doorwayCount > 0) {
    findings.push({
      id: 'doorway',
      // **warn 而不是 error**：这道检查只能看出"开口不足 minDoorClearance 高"，
      // 分不清那是"本该走人的门洞"还是"故意开的小窗"。作为 error 会把完成闸门
      // 卡在一个主观判断上——提醒足够，拦截不对。
      severity: 'warn',
      count: doorwayCount,
      summary:
        `${doorwayCount} doorway/opening problem(s): an air shaft in a wall is less than ${minDoorClearance} block(s) high, ` +
        `or a *_door upper half has a non-air block directly above it (not walkable through).`,
      samples: doorwaySamples.list(),
    })
  }
  if (headroomCount > 0) {
    findings.push({
      id: 'headroom',
      severity: 'warn',
      count: headroomCount,
      summary:
        `${headroomCount} walkable cell(s) have less than ${minHeadroom} block(s) of head clearance ` +
        `to the next non-air block above (the cell itself is non-air with air directly above).`,
      samples: headroomSamples.list(),
    })
  }
  if (leak.skipped) {
    findings.push({
      id: 'leaky',
      severity: 'info',
      count: 0,
      summary:
        `Leak analysis skipped: the content bounding box has ${leak.boxVolume} cells, ` +
        `above the ${LEAK_MAX_CELLS} cell budget for the air flood fill.`,
      samples: [],
    })
  } else if (leak.count > 0) {
    findings.push({
      id: 'leaky',
      severity: 'warn',
      count: leak.count,
      summary:
        `${leak.count} interior air cell(s) connect to the outside across the content bounding box border ` +
        `(the shell is not sealed; intended doors and windows are counted unless the shell encloses them).`,
      samples: leak.samples,
    })
  }
  if (paletteFinding !== undefined) findings.push(paletteFinding)
  if (symmetryFinding !== undefined) findings.push(symmetryFinding)

  findings.sort(compareFindings)

  return { region, blocks, findings, score: computeScore(findings) }
}

/**
 * `score` 公式（0..100）：
 *
 *   error 扣分 = Σ min(30, 2 × count)
 *   warn  扣分 = Σ min(15, 1 × count)
 *   score = clamp(round(100 - error扣分 - warn扣分), 0, 100)
 *
 * **info 不扣分**：调色板与对称性只是报告，所以「没有 error 也没有 warn」时必然是 100。
 * 每条 finding 的扣分有上限，避免一个上千格的问题直接把分数压到 0 而掩盖其它信息。
 */
function computeScore(findings: readonly LintFinding[]): number {
  let penalty = 0
  for (const finding of findings) {
    if (finding.count <= 0) continue
    if (finding.severity === 'error') penalty += Math.min(30, 2 * finding.count)
    else if (finding.severity === 'warn') penalty += Math.min(15, finding.count)
  }
  return Math.max(0, Math.min(100, Math.round(100 - penalty)))
}

/** 把报告渲染成给 LLM 读的紧凑文本（纯函数，样本已经在报告里限过量）。 */
export function formatLintReport(report: LintReport): string {
  const { region, blocks, findings, score } = report
  const errors = sumBySeverity(findings, 'error')
  const warnings = sumBySeverity(findings, 'warn')
  const info = findings.filter((finding) => finding.severity === 'info').length
  const head =
    `analyze_structure: region (${region.min.x},${region.min.y},${region.min.z})..` +
    `(${region.max.x},${region.max.y},${region.max.z}), blocks ${blocks}, ` +
    `score ${score}/100 (errors ${errors}, warnings ${warnings}, info findings ${info})`

  const lines = [head]
  if (findings.length === 0) {
    lines.push('No problems found: the structure is structurally clean.')
    return lines.join('\n')
  }
  for (const finding of findings) {
    lines.push(`${finding.severity.toUpperCase()} ${finding.id} x${finding.count}: ${finding.summary}`)
    if (finding.samples.length > 0) {
      lines.push(`  samples: ${finding.samples.map((p) => `[${p.x},${p.y},${p.z}]`).join(' ')}`)
    }
  }
  return lines.join('\n')
}

function sumBySeverity(findings: readonly LintFinding[], severity: LintSeverity): number {
  let total = 0
  for (const finding of findings) {
    if (finding.severity === severity) total += finding.count
  }
  return total
}

// ── 对称性 ──────────────────────────────────────────────────────────

interface SymmetryResult {
  axis: Axis
  coordinate: number
  matched: number
  total: number
  score: number
  samples: Pos[]
}

function buildSymmetryFinding(
  store: WorldStore,
  region: Bounds,
  columns: ReadonlyMap<number, ColumnScan>,
  options: LintOptions,
): LintFinding {
  // 「dominant plane」：显式给了轴/坐标就只测那一面；什么都没给就测三条中心面取最高分。
  const axes: Axis[] =
    options.symmetryAxis !== undefined
      ? [options.symmetryAxis]
      : options.symmetryCoordinate !== undefined
        ? ['x']
        : ['x', 'y', 'z']

  let best: SymmetryResult | undefined
  for (const axis of axes) {
    const coordinate = options.symmetryCoordinate ?? centreOf(region, axis)
    const result = symmetryOnPlane(store, region, columns, axis, coordinate)
    if (best === undefined || result.score > best.score) best = result
  }
  const chosen = best!
  const percent = Math.round(chosen.score * 1000) / 10
  return {
    id: 'symmetry',
    severity: 'info',
    count: chosen.total - chosen.matched,
    summary:
      `plane ${chosen.axis}=${formatCoordinate(chosen.coordinate)}: ${chosen.matched}/${chosen.total} non-air cells ` +
      `match their mirror image (score ${percent}%).`,
    samples: chosen.samples,
  }
}

function symmetryOnPlane(
  store: WorldStore,
  region: Bounds,
  columns: ReadonlyMap<number, ColumnScan>,
  axis: Axis,
  coordinate: number,
): SymmetryResult {
  const probe: Pos = { x: 0, y: 0, z: 0 }
  const samples = new SampleSet(LINT_MAX_SAMPLES, compareYThenXZ)
  const twice = 2 * coordinate
  let matched = 0
  let total = 0

  for (const column of columns.values()) {
    if (column.x < region.min.x || column.x > region.max.x) continue
    if (column.z < region.min.z || column.z > region.max.z) continue
    for (const y of column.ys) {
      if (y < region.min.y || y > region.max.y) continue
      total++
      probe.x = column.x
      probe.y = y
      probe.z = column.z
      const own = store.getBlockStateId(probe)

      let mx = column.x
      let my = y
      let mz = column.z
      if (axis === 'x') mx = Math.round(twice - column.x)
      else if (axis === 'y') my = Math.round(twice - y)
      else mz = Math.round(twice - column.z)

      probe.x = mx
      probe.y = my
      probe.z = mz
      const other = store.getBlockStateId(probe)
      if (own === other) matched++
      else samples.push({ x: column.x, y, z: column.z })
    }
  }

  return {
    axis,
    coordinate,
    matched,
    total,
    score: total === 0 ? 1 : matched / total,
    samples: samples.list(),
  }
}

// ── 漏水 ────────────────────────────────────────────────────────────

interface LeakResult {
  /** 连通到包围盒外面的**内部空气**格数。 */
  count: number
  samples: Pos[]
  skipped: boolean
  boxVolume: number
}

/**
 * 内部是否与外界连通。
 *
 * 做法：
 * 1. 从内容包围盒的 6 个面出发，只在空气里做一次 6 连通洪泛 → 标记「外界可达的空气」。
 * 2. 「内部空气」定义为**上下都有非空气**的空气格（也就是被地板/天花板夹住、看起来像室内的那些）。
 * 3. 内部空气中被标记为外界可达的，就是漏点；它们的数量就是 `count`。
 *
 * 这样有屋顶的开放凉亭会被判为漏（它本来也没和外面隔开），而真正封死的屋子不会。
 * 包围盒过大时（空旷巨盒）直接跳过，避免为空气洪泛分配巨量内存——报告里会如实说明。
 */
function analyzeLeak(
  store: WorldStore,
  content: Bounds | undefined,
  columns: ReadonlyMap<number, ColumnScan>,
): LeakResult {
  if (content === undefined) return { count: 0, samples: [], skipped: false, boxVolume: 0 }
  const clipped = normalizeBounds(content.min, content.max)

  const sizeX = clipped.max.x - clipped.min.x + 1
  const sizeY = clipped.max.y - clipped.min.y + 1
  const sizeZ = clipped.max.z - clipped.min.z + 1
  const boxVolume = sizeX * sizeY * sizeZ
  if (boxVolume > LEAK_MAX_CELLS) return { count: 0, samples: [], skipped: true, boxVolume }

  const probe: Pos = { x: 0, y: 0, z: 0 }
  const reached = new Uint8Array(boxVolume)
  const queue: number[] = []
  const indexOf = (x: number, y: number, z: number): number =>
    ((y - clipped.min.y) * sizeZ + (z - clipped.min.z)) * sizeX + (x - clipped.min.x)
  const isAirAt = (x: number, y: number, z: number): boolean => {
    probe.x = x
    probe.y = y
    probe.z = z
    return store.getBlockStateId(probe) === AIR_STATE_ID
  }
  const seed = (x: number, y: number, z: number): void => {
    if (!isAirAt(x, y, z)) return
    const index = indexOf(x, y, z)
    if (reached[index] === 1) return
    reached[index] = 1
    queue.push(index)
  }
  const expand = (x: number, y: number, z: number): void => {
    if (!isAirAt(x, y, z)) return
    const index = indexOf(x, y, z)
    if (reached[index] === 1) return
    reached[index] = 1
    queue.push(index)
  }

  // 种子上只在 6 个面上（面很小），不必先扫整个包围盒。
  for (let x = clipped.min.x; x <= clipped.max.x; x++) {
    for (let y = clipped.min.y; y <= clipped.max.y; y++) {
      seed(x, y, clipped.min.z)
      seed(x, y, clipped.max.z)
    }
  }
  for (let x = clipped.min.x; x <= clipped.max.x; x++) {
    for (let z = clipped.min.z; z <= clipped.max.z; z++) {
      seed(x, clipped.min.y, z)
      seed(x, clipped.max.y, z)
    }
  }
  for (let y = clipped.min.y; y <= clipped.max.y; y++) {
    for (let z = clipped.min.z; z <= clipped.max.z; z++) {
      seed(clipped.min.x, y, z)
      seed(clipped.max.x, y, z)
    }
  }

  let head = 0
  while (head < queue.length) {
    const index = queue[head++]!
    const x = clipped.min.x + (index % sizeX)
    const rest = Math.floor(index / sizeX)
    const z = clipped.min.z + (rest % sizeZ)
    const y = clipped.min.y + Math.floor(rest / sizeZ)
    if (x > clipped.min.x) expand(x - 1, y, z)
    if (x < clipped.max.x) expand(x + 1, y, z)
    if (y > clipped.min.y) expand(x, y - 1, z)
    if (y < clipped.max.y) expand(x, y + 1, z)
    if (z > clipped.min.z) expand(x, y, z - 1)
    if (z < clipped.max.z) expand(x, y, z + 1)
  }

  // 内部空气 = 同列上下都有非空气的空气格。这里直接复用每列 y 列表。
  const samples = new SampleSet(LINT_MAX_SAMPLES, compareYThenXZ)
  let count = 0
  for (const column of columns.values()) {
    if (column.x < clipped.min.x || column.x > clipped.max.x) continue
    if (column.z < clipped.min.z || column.z > clipped.max.z) continue
    let lower: number | undefined
    for (const y of column.ys) {
      if (y < clipped.min.y) continue
      if (y > clipped.max.y) break
      if (lower !== undefined && y - lower > 1) {
        for (let airY = lower + 1; airY < y; airY++) {
          const index = indexOf(column.x, airY, column.z)
          if (reached[index] !== 1) continue
          count++
          samples.push({ x: column.x, y: airY, z: column.z })
        }
      }
      lower = y
    }
  }

  return { count, samples: samples.list(), skipped: false, boxVolume }
}

// ── 小工具 ──────────────────────────────────────────────────────────

/**
 * 「只保留最小的 N 个坐标」的收集器。
 *
 * 这是**确定性**的关键：无论世界以什么顺序被遍历，留下的都是同一批样本。
 */
class SampleSet {
  private readonly items: Pos[] = []

  constructor(
    private readonly limit: number,
    private readonly compare: (a: Pos, b: Pos) => number,
  ) {}

  push(pos: Pos): void {
    const items = this.items
    if (items.length < this.limit) {
      items.push(pos)
      items.sort(this.compare)
      return
    }
    const worst = items[items.length - 1]
    if (worst !== undefined && this.compare(pos, worst) < 0) {
      items[items.length - 1] = pos
      items.sort(this.compare)
    }
  }

  list(): Pos[] {
    return this.items.map((p) => ({ x: p.x, y: p.y, z: p.z }))
  }
}

const compareYThenXZ = (a: Pos, b: Pos): number => a.y - b.y || a.x - b.x || a.z - b.z

const SEVERITY_RANK: Record<LintSeverity, number> = { error: 0, warn: 1, info: 2 }
const FINDING_RANK: Record<LintFindingId, number> = {
  floating: 0,
  cantilever: 1,
  doorway: 2,
  headroom: 3,
  leaky: 4,
  palette: 5,
  symmetry: 6,
}

function compareFindings(a: LintFinding, b: LintFinding): number {
  return SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] || FINDING_RANK[a.id] - FINDING_RANK[b.id]
}

/** 坐标编码成单个 number 作为 Map 键（避免每次查询分配字符串）。 */
const COORD_OFFSET = 1 << 20
const COORD_SPAN = 1 << 21
function columnKey(x: number, z: number): number {
  return (x + COORD_OFFSET) * COORD_SPAN + (z + COORD_OFFSET)
}

function hasY(ys: readonly number[], y: number): boolean {
  let lo = 0
  let hi = ys.length - 1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    const value = ys[mid]!
    if (value === y) return true
    if (value < y) lo = mid + 1
    else hi = mid - 1
  }
  return false
}

function nearestSupportDistance(
  columns: ReadonlyMap<number, ColumnScan>,
  x: number,
  y: number,
  z: number,
  cap: number,
): number {
  const hasBlockAt = (px: number, pz: number): boolean => {
    const column = columns.get(columnKey(px, pz))
    return column !== undefined && hasY(column.ys, y)
  }
  if (hasBlockAt(x, z)) return 0
  // 按切比雪夫距离一圈一圈往外找，命中即返回 → 常见情形只查几个格子。
  for (let d = 1; d <= cap; d++) {
    for (let dx = -d; dx <= d; dx++) {
      if (hasBlockAt(x + dx, z - d)) return d
      if (hasBlockAt(x + dx, z + d)) return d
    }
    for (let dz = -d + 1; dz <= d - 1; dz++) {
      if (hasBlockAt(x - d, z + dz)) return d
      if (hasBlockAt(x + d, z + dz)) return d
    }
  }
  return cap + 1
}

function isSortedAscending(values: readonly number[]): boolean {
  for (let i = 1; i < values.length; i++) {
    if (values[i]! < values[i - 1]!) return false
  }
  return true
}

function insideRegion(region: Bounds, x: number, y: number, z: number): boolean {
  return (
    x >= region.min.x &&
    x <= region.max.x &&
    y >= region.min.y &&
    y <= region.max.y &&
    z >= region.min.z &&
    z <= region.max.z
  )
}

function centreOf(region: Bounds, axis: Axis): number {
  if (axis === 'x') return (region.min.x + region.max.x) / 2
  if (axis === 'y') return (region.min.y + region.max.y) / 2
  return (region.min.z + region.max.z) / 2
}

function formatCoordinate(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1)
}

function normalizeInt(value: number | undefined, fallback: number, minimum: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback
  return Math.max(minimum, Math.floor(value))
}

/** 显式给定的分析范围：规范化并夹到工区内。与工区无交集时退化成一个点（blocks=0）。 */
function clampRegion(store: WorldStore, requested: Bounds): Bounds {
  const normalized = normalizeBounds(requested.min, requested.max)
  const clamped = boundsIntersect(normalized, store.volume)
  return clamped ?? { min: { ...store.volume.min }, max: { ...store.volume.min } }
}
