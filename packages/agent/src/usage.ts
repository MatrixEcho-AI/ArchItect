/**
 * 成本与预算记账（plan §10.1 的成本表盘、§13 的可观测性）。
 *
 * 只做一件事：把累计的 token 换算成美元，并在超限时给出**具体的**越界原因。
 * 刻意不做"自动降级"——超预算时静默换便宜模型会让产出的质量无法解释。
 */

import type { LlmUsage } from './types.js'
import type { CostTable } from './providers/config.js'

export interface UsageTotals {
  in: number
  out: number
  /** 其中命中前缀缓存的部分（**已包含在 `in` 里**，不是额外的一份）。 */
  cachedIn: number
  turns: number
  toolCalls: number
  screenshots: number
}

export const emptyUsage = (): UsageTotals => ({
  in: 0,
  out: 0,
  cachedIn: 0,
  turns: 0,
  toolCalls: 0,
  screenshots: 0,
})

/**
 * 从一份 provider 配置里取出**当前模型**该用的价格表。
 *
 * 顺序是刻意的：先按模型 id 精确匹配 `costs`，再退到 provider 级 `cost`。
 * 反过来的话，配了 per-model 价格也没用——兜底那张永远先命中。
 *
 * 只看 model id，不看 baseURL：一个端点上报的 id 已经是唯一的了，而"按端点分表"
 * 会在用户换地址之后留下一堆对不上的旧键。
 */
export function costTableFor(
  provider: { model?: string; costs?: Record<string, CostTable>; cost?: CostTable } | undefined,
  at?: Date,
): CostTable | undefined {
  if (provider === undefined) return undefined
  const model = provider.model?.trim()
  const perModel = model !== undefined && model.length > 0 ? provider.costs?.[model] : undefined
  return activeCostTable(perModel ?? provider.cost, at)
}

/**
 * 取**此刻生效**的那张价格表。
 *
 * DeepSeek 的价格随北京时间分时段（高峰正好是低谷的 2 倍），所以"这次花了多少"
 * 与"什么时候跑的"有关。时段判断按**供应商的本地时区**做，不按用户所在时区——
 * 计费发生在供应商那边。没配 `peakHours` 就当不分时段。
 */
export function activeCostTable(cost: CostTable | undefined, at: Date = new Date()): CostTable | undefined {
  if (cost === undefined) return undefined
  const peak = cost.peak
  const hours = cost.peakHours
  if (peak === undefined || hours === undefined) return cost
  if (!isPeakHour(hours, at)) return cost
  /**
   * 换到高峰价时**要带上币种**：`peak` 是 `Omit<CostTable, 'peak'>`，但配置里
   * 通常只在外层写一次 `currency`（"那一行三个数字只配一次货币"）。不显式带上，
   * 高峰时段的价格就会丢币种、显示成默认的 USD——账单是人民币，数字却标美元。
   */
  return { ...peak, ...(cost.currency !== undefined ? { currency: cost.currency } : {}), peakHours: hours }
}

/** 金额显示用的币种代码。表里没写就按 USD。 */
export function currencyOf(cost: CostTable | undefined): string {
  return cost?.currency ?? 'USD'
}

/** 这个时刻算不算高峰时段。`Intl` 负责时区换算，不手写 UTC 偏移——夏令时会错。 */
export function isPeakHour(hours: NonNullable<CostTable['peakHours']>, at: Date): boolean {
  let parts: Intl.DateTimeFormatPart[]
  try {
    parts = new Intl.DateTimeFormat('en-US', {
      timeZone: hours.timeZone,
      weekday: 'short',
      hour: 'numeric',
      hour12: false,
    }).formatToParts(at)
  } catch {
    // 时区名不被这个运行时认识（老 Node / 裁剪过的 ICU）：**不猜**，按低谷算并让
    // 上层照常显示。猜成高峰会让表盘虚高一倍，那比少算是更糟的错。
    return false
  }
  const weekdayName = parts.find((part) => part.type === 'weekday')?.value ?? ''
  const hour = Number(parts.find((part) => part.type === 'hour')?.value ?? '0')
  const weekday = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(weekdayName)
  if (weekday < 0 || !hours.weekdays.includes(weekday)) return false
  // `hour12: false` 在午夜会给出 24，归一到 0
  const normalized = hour === 24 ? 0 : hour
  return hours.ranges.some(([from, to]) => normalized >= from && normalized < to)
}

/**
 * 按价格表算钱。
 *
 * **`cachedIn` 是 `in` 的子集**（DeepSeek 的 `prompt_tokens` 含缓存命中部分），
 * 所以计费是 `(in - cachedIn) × 全价 + cachedIn × 缓存价`。
 * 把它当成额外一份会**高估**成本——高估会让用户白白提前刹车。
 *
 * `at` 用来选高峰/低谷价；省略表示"现在"。
 * 没有价格表时返回 `undefined`：宁可显示"未知"，也不要显示一个编出来的数字。
 */
export function costOf(
  totals: Pick<UsageTotals, 'in' | 'out' | 'cachedIn'>,
  cost?: CostTable,
  at: Date = new Date(),
): number | undefined {
  const table = activeCostTable(cost, at)
  if (table === undefined) return undefined
  const cached = Math.min(totals.cachedIn, totals.in)
  const full = totals.in - cached
  const perM = 1_000_000
  const cacheRead = table.cacheReadPerMTok ?? table.inPerMTok
  return (
    (full * table.inPerMTok) / perM + (totals.out * table.outPerMTok) / perM + (cached * cacheRead) / perM
  )
}

/** 累计器。UI 的表盘与 CLI 的收尾统计都读它。 */
export class UsageMeter {
  private totals: UsageTotals = emptyUsage()

  add(usage: LlmUsage): void {
    this.totals.in += usage.in
    this.totals.out += usage.out
    this.totals.cachedIn += usage.cachedIn ?? 0
  }

  turn(): void {
    this.totals.turns++
  }

  toolCall(): void {
    this.totals.toolCalls++
  }

  screenshot(): void {
    this.totals.screenshots++
  }

  get value(): UsageTotals {
    return { ...this.totals }
  }

  costOf(cost?: CostTable, at?: Date): number | undefined {
    return costOf(this.totals, cost, at)
  }

  reset(): void {
    this.totals = emptyUsage()
  }
}

/** 缓存命中的占比。0 表示前缀一次都没复用上——那通常意味着 prompt 前缀不稳定。 */
export function cacheHitRatio(totals: Pick<UsageTotals, 'in' | 'cachedIn'>): number {
  if (totals.in === 0) return 0
  return Math.min(1, totals.cachedIn / totals.in)
}
