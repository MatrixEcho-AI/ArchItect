import { t } from '@architect/i18n'
import { measure } from '@architect/core'
import type { Bounds, WorldStore } from '@architect/core'

/**
 * 黄金基准任务（plan §14）。
 *
 * 每个任务带**程序化验收**，所以评分不依赖人眼：
 * "这算不算一座房子"被拆成可判定的命题（有没有门洞、有没有悬空、尺寸对不对）。
 * 这样改 prompt、改工具描述之后，效果变化是可量化的。
 */
export type TaskCheck =
  | { kind: 'minBlocks'; min: number; label?: string }
  | { kind: 'blockCount'; block: string; min?: number; max?: number; label?: string }
  | { kind: 'extent'; axis: 'x' | 'y' | 'z'; min?: number; max?: number; label?: string }
  | { kind: 'noFloating'; label?: string }
  /** 墙体上存在一个净高 >= clearance 的洞口（门）。 */
  | { kind: 'perimeterOpening'; clearance: number; label?: string }
  | { kind: 'symmetric'; axis: 'x' | 'y' | 'z'; label?: string }
  /** 顶层不是一整块实心（雉堞、镂空顶）。 */
  | { kind: 'topLayerNotSolid'; label?: string }
  /** 上部比下部窄（收分塔身）。 */
  | { kind: 'taper'; label?: string }
  /** 有架空的桥面（下方存在空腔）。 */
  | { kind: 'hasVoidBelow'; label?: string }

export interface GoldenTask {
  id: string
  name: string
  /** 给 LLM 的原始需求（中文）。 */
  goal: string
  volume: Bounds
  checks: TaskCheck[]
}

export const GOLDEN_TASKS: readonly GoldenTask[] = [
  {
    id: 'hut',
    get name(): string {
      return t('agent.bench.task.hut')
    },
    goal: '设计一座 10x10 的小屋：木地板，石砖墙，南面开一扇门，东西两面各开一扇窗，加一个坡屋顶和一个烟囱。',
    volume: { min: { x: 0, y: 0, z: 0 }, max: { x: 31, y: 31, z: 31 } },
    // name / checks 用 getter：标签要跟随当前语言，而不是 import 时刻的语言
    get checks(): TaskCheck[] {
      return [
        { kind: 'minBlocks', min: 300 },
        { kind: 'extent', axis: 'x', min: 8, max: 16, label: t('agent.bench.check.hutExtentX') },
        { kind: 'extent', axis: 'z', min: 8, max: 16, label: t('agent.bench.check.hutExtentZ') },
        { kind: 'extent', axis: 'y', min: 5, max: 20, label: t('agent.bench.check.hutRoofHeight') },
        { kind: 'blockCount', block: 'glass', min: 2, label: t('agent.bench.check.hutWindows') },
        { kind: 'perimeterOpening', clearance: 2, label: t('agent.bench.check.hutDoor') },
        { kind: 'noFloating' },
      ]
    },
  },
  {
    id: 'tower',
    get name(): string {
      return t('agent.bench.task.tower')
    },
    goal: '设计一座圆形石塔：半径 6，高 24，顶部有一圈雉堞。',
    volume: { min: { x: 0, y: 0, z: 0 }, max: { x: 31, y: 31, z: 31 } },
    get checks(): TaskCheck[] {
      return [
        { kind: 'minBlocks', min: 800 },
        { kind: 'extent', axis: 'x', min: 10, max: 16, label: t('agent.bench.check.towerDiameterX') },
        { kind: 'extent', axis: 'z', min: 10, max: 16, label: t('agent.bench.check.towerDiameterZ') },
        { kind: 'extent', axis: 'y', min: 20, label: t('agent.bench.check.towerHeight') },
        { kind: 'topLayerNotSolid', label: t('agent.bench.check.towerBattlements') },
        { kind: 'noFloating' },
      ]
    },
  },
  {
    id: 'courtyard',
    get name(): string {
      return t('agent.bench.task.courtyard')
    },
    goal: '设计一个 15x15 的对称庭院：四面回廊，中央有一座喷泉。',
    volume: { min: { x: 0, y: 0, z: 0 }, max: { x: 31, y: 31, z: 31 } },
    get checks(): TaskCheck[] {
      return [
        { kind: 'minBlocks', min: 400 },
        { kind: 'extent', axis: 'x', min: 13, max: 20 },
        { kind: 'extent', axis: 'z', min: 13, max: 20 },
        { kind: 'symmetric', axis: 'x', label: t('agent.bench.check.courtyardSymX') },
        { kind: 'symmetric', axis: 'z', label: t('agent.bench.check.courtyardSymZ') },
        { kind: 'noFloating' },
      ]
    },
  },
  {
    id: 'bridge',
    get name(): string {
      return t('agent.bench.task.bridge')
    },
    goal: '设计一座跨 30 格的中世纪石桥：有桥墩和拱，桥面可以通行。',
    volume: { min: { x: 0, y: 0, z: 0 }, max: { x: 40, y: 24, z: 24 } },
    get checks(): TaskCheck[] {
      return [
        { kind: 'minBlocks', min: 300 },
        { kind: 'extent', axis: 'x', min: 26, label: t('agent.bench.check.bridgeSpan') },
        { kind: 'hasVoidBelow', label: t('agent.bench.check.bridgeArch') },
        { kind: 'noFloating' },
      ]
    },
  },
  {
    id: 'lighthouse',
    get name(): string {
      return t('agent.bench.task.lighthouse')
    },
    goal: '设计一座海边灯塔：塔身向上收分，顶部有玻璃灯室。',
    volume: { min: { x: 0, y: 0, z: 0 }, max: { x: 31, y: 40, z: 31 } },
    get checks(): TaskCheck[] {
      return [
        { kind: 'minBlocks', min: 500 },
        { kind: 'extent', axis: 'y', min: 15, label: t('agent.bench.check.lighthouseHeight') },
        { kind: 'taper', label: t('agent.bench.check.lighthouseTaper') },
        { kind: 'blockCount', block: 'glass', min: 10, label: t('agent.bench.check.lighthouseGlass') },
        { kind: 'noFloating' },
      ]
    },
  },
]

export interface CheckResult {
  label: string
  pass: boolean
  detail?: string
}

export interface TaskEvaluation {
  taskId: string
  passed: number
  total: number
  results: CheckResult[]
  /** 全部通过才算达成。 */
  achieved: boolean
  stats: { blocks: number; size: string; ops: number }
}

/** 跑一遍程序化验收。 */
export function evaluateTask(task: GoldenTask, store: WorldStore, ops = 0): TaskEvaluation {
  const stats = measure(store)
  const results = task.checks.map((check) => runCheck(check, store, stats))
  const passed = results.filter((r) => r.pass).length
  return {
    taskId: task.id,
    passed,
    total: results.length,
    results,
    achieved: passed === results.length,
    stats: {
      blocks: stats.blocks,
      size: stats.size === undefined ? t('agent.bench.detail.emptySize') : `${stats.size.x}×${stats.size.y}×${stats.size.z}`,
      ops,
    },
  }
}

type Stats = ReturnType<typeof measure>

function runCheck(check: TaskCheck, store: WorldStore, stats: Stats): CheckResult {
  switch (check.kind) {
    case 'minBlocks': {
      const pass = stats.blocks >= check.min
      return {
        label: check.label ?? t('agent.bench.check.minBlocks', { min: check.min }),
        pass,
        ...(pass ? {} : { detail: t('agent.bench.detail.actual', { value: stats.blocks }) }),
      }
    }
    case 'blockCount': {
      const target = check.block.replace(/^minecraft:/, '').split('[')[0]!
      let count = 0
      store.forEachNonAir((x, y, z) => {
        const name = store.getBlockString({ x, y, z }).replace(/^minecraft:/, '').split('[')[0]!
        if (name === target) count++
      })
      const aboveMin = check.min === undefined || count >= check.min
      const belowMax = check.max === undefined || count <= check.max
      const pass = aboveMin && belowMax
      return {
        label: check.label ?? t('agent.bench.check.blockCount', { block: check.block }),
        pass,
        ...(pass
          ? {}
          : {
              detail: t('agent.bench.detail.actualOf', {
                value: count,
                min: check.min ?? '-∞',
                max: check.max ?? '+∞',
              }),
            }),
      }
    }
    case 'extent': {
      const size = stats.size
      if (size === undefined) {
        return {
          label: check.label ?? t('agent.bench.check.extentSpan', { axis: check.axis }),
          pass: false,
          detail: t('agent.bench.detail.emptyWorld'),
        }
      }
      const value = size[check.axis]
      const aboveMin = check.min === undefined || value >= check.min
      const belowMax = check.max === undefined || value <= check.max
      const pass = aboveMin && belowMax
      return {
        label: check.label ?? t('agent.bench.check.extentInRange', { axis: check.axis }),
        pass,
        ...(pass
          ? {}
          : {
              detail: t('agent.bench.detail.actualOf', {
                value,
                min: check.min ?? '-∞',
                max: check.max ?? '+∞',
              }),
            }),
      }
    }
    case 'noFloating': {
      const bounds = stats.bounds
      if (bounds === undefined) {
        return {
          label: check.label ?? t('agent.bench.check.noFloating'),
          pass: false,
          detail: t('agent.bench.detail.emptyWorld'),
        }
      }
      // 判据是"整列下方完全没有支撑"，不是"正下方是空气"——
      // 后者会把天花板、桥面、悬挑全判成悬空，而那些正是建筑该有的东西。
      const floating: string[] = []
      store.forEachNonAir((x, y, z) => {
        if (y <= bounds.min.y) return
        let supported = false
        for (let below = y - 1; below >= bounds.min.y; below--) {
          if (!store.isAir({ x, y: below, z })) {
            supported = true
            break
          }
        }
        if (!supported) floating.push(`[${x},${y},${z}]`)
      })
      return {
        label: check.label ?? t('agent.bench.check.noFloating'),
        pass: floating.length === 0,
        ...(floating.length === 0
          ? {}
          : {
              detail: t('agent.bench.detail.floating', {
                count: floating.length,
                examples: floating.slice(0, 4).join(' '),
              }),
            }),
      }
    }
    case 'perimeterOpening': {
      const bounds = stats.bounds
      if (bounds === undefined) {
        return {
          label: check.label ?? t('agent.bench.check.perimeterOpening'),
          pass: false,
          detail: t('agent.bench.detail.emptyWorld'),
        }
      }
      const y0 = bounds.min.y + 1
      const candidates: Array<[number, number]> = []
      for (let x = bounds.min.x; x <= bounds.max.x; x++) {
        candidates.push([x, bounds.min.z], [x, bounds.max.z])
      }
      for (let z = bounds.min.z; z <= bounds.max.z; z++) {
        candidates.push([bounds.min.x, z], [bounds.max.x, z])
      }
      for (const [x, z] of candidates) {
        // 门下必须有地板（不是空气）——否则那不是门洞，是边缘
        if (store.isAir({ x, y: bounds.min.y, z })) continue
        let clearance = 0
        for (let dy = 0; dy < 6; dy++) {
          if (!store.isAir({ x, y: y0 + dy, z })) break
          clearance++
        }
        if (clearance >= check.clearance) {
          return {
            label: check.label ?? t('agent.bench.check.perimeterOpening'),
            pass: true,
            detail: t('agent.bench.detail.openingFound', { x, y: y0, z, clearance }),
          }
        }
      }
      return {
        label: check.label ?? t('agent.bench.check.perimeterOpening'),
        pass: false,
        detail: t('agent.bench.detail.openingMissing', { clearance: check.clearance }),
      }
    }
    case 'symmetric': {
      const bounds = stats.bounds
      if (bounds === undefined) {
        return {
          label: check.label ?? t('agent.bench.check.symmetricPlain'),
          pass: false,
          detail: t('agent.bench.detail.emptyWorld'),
        }
      }
      const axis = check.axis
      const coordinate = Math.floor(((bounds.min[axis] + bounds.max[axis]) / 2))
      let mismatches = 0
      for (let x = bounds.min.x; x <= bounds.max.x; x++) {
        for (let y = bounds.min.y; y <= bounds.max.y; y++) {
          for (let z = bounds.min.z; z <= bounds.max.z; z++) {
            const mirrored =
              axis === 'x'
                ? { x: 2 * coordinate - x, y, z }
                : axis === 'y'
                  ? { x, y: 2 * coordinate - y, z }
                  : { x, y, z: 2 * coordinate - z }
            if (store.getBlockString({ x, y, z }) !== store.getBlockString(mirrored)) mismatches++
          }
        }
      }
      return {
        label: check.label ?? t('agent.bench.check.symmetric', { axis, coordinate }),
        pass: mismatches === 0,
        ...(mismatches === 0
          ? {}
          : { detail: t('agent.bench.detail.asymmetric', { count: mismatches, axis, coordinate }) }),
      }
    }
    case 'topLayerNotSolid': {
      const bounds = stats.bounds
      if (bounds === undefined) {
        return {
          label: check.label ?? t('agent.bench.check.topLayerNotSolid'),
          pass: false,
          detail: t('agent.bench.detail.emptyWorld'),
        }
      }
      const top = bounds.max.y
      let gaps = 0
      let filled = 0
      for (let x = bounds.min.x; x <= bounds.max.x; x++) {
        for (let z = bounds.min.z; z <= bounds.max.z; z++) {
          if (store.isAir({ x, y: top, z })) gaps++
          else filled++
        }
      }
      const ratio = filled + gaps === 0 ? 0 : gaps / (filled + gaps)
      return {
        label: check.label ?? t('agent.bench.check.topLayerNotSolid'),
        pass: ratio > 0.15,
        ...(ratio > 0.15
          ? {}
          : {
              detail: t('agent.bench.detail.topNearlySolid', { percent: (ratio * 100).toFixed(1) }),
            }),
      }
    }
    case 'taper': {
      const bounds = stats.bounds
      if (bounds === undefined) {
        return {
          label: check.label ?? t('agent.bench.check.taper'),
          pass: false,
          detail: t('agent.bench.detail.emptyWorld'),
        }
      }
      const height = bounds.max.y - bounds.min.y + 1
      if (height < 6) {
        return {
          label: check.label ?? t('agent.bench.check.taper'),
          pass: false,
          detail: t('agent.bench.detail.tooShort', { height }),
        }
      }
      const widthAt = (y: number): number => {
        let lo = Number.POSITIVE_INFINITY
        let hi = Number.NEGATIVE_INFINITY
        for (let x = bounds.min.x; x <= bounds.max.x; x++) {
          for (let z = bounds.min.z; z <= bounds.max.z; z++) {
            if (store.isAir({ x, y, z })) continue
            lo = Math.min(lo, x)
            hi = Math.max(hi, x)
          }
        }
        return hi < lo ? 0 : hi - lo + 1
      }
      const bottom = widthAt(bounds.min.y + Math.floor(height * 0.15))
      const top = widthAt(bounds.max.y - Math.floor(height * 0.15))
      return {
        label: check.label ?? t('agent.bench.check.taper'),
        pass: top < bottom,
        ...(top < bottom ? {} : { detail: t('agent.bench.detail.noTaper', { bottom, top }) }),
      }
    }
    case 'hasVoidBelow': {
      const bounds = stats.bounds
      if (bounds === undefined) {
        return {
          label: check.label ?? t('agent.bench.check.hasVoidBelow'),
          pass: false,
          detail: t('agent.bench.detail.emptyWorld'),
        }
      }
      let voids = 0
      for (let x = bounds.min.x; x <= bounds.max.x; x++) {
        for (let z = bounds.min.z; z <= bounds.max.z; z++) {
          if (!store.isAir({ x, y: bounds.min.y, z })) continue
          for (let y = bounds.min.y + 1; y <= bounds.max.y; y++) {
            if (!store.isAir({ x, y, z })) {
              voids++
              break
            }
          }
        }
      }
      return {
        label: check.label ?? t('agent.bench.check.hasVoidBelow'),
        pass: voids >= 10,
        ...(voids >= 10 ? {} : { detail: t('agent.bench.detail.fewVoids', { count: voids }) }),
      }
    }
  }
}

export function findTask(id: string): GoldenTask | undefined {
  return GOLDEN_TASKS.find((task) => task.id === id)
}
