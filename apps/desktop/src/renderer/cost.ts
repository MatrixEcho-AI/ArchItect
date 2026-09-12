import { t } from '@architect/i18n'

import { cacheShare } from './format.js'
import type { ChatUsageView } from './types.js'

/**
 * 界面上的**纯计算**（不碰 DOM、不碰 React，所以能单测）。
 *
 * `format.ts` 已经放了一个（缓存命中率）；这里是它的同伴：读数怎么拼、数字怎么压。
 * 拎出来的理由一样——这是"数量看着有、但比例或单位错了没人会注意"的那一类。
 */

/**
 * 把大数字压成 `12k` / `1.2M` 这种短形式。
 *
 * 顶栏那一行只有几百像素，而 token 数动辄几十万——照原样写会把标题挤走，
 * 而这一行是**常驻**的读数。所以宁可损失一点精度。
 *
 * 三条刻意的规则：
 *  - **小于 1000 不动**：`0`、`7`、`842` 本来就短，加单位只是噪音；
 *  - **只保留一位小数，且 `.0` 去掉**：`12.0k` 读起来像有两位有效数字，其实没有；
 *  - **进位到下一个单位**：`999_950` 会先四舍五入成 `1000.0k`，那不如直接写 `1M`
 *    —— 这是这类函数最经典的 off-by-one，也是它值得单测的原因。
 */
export function compactNumber(value: number): string {
  if (!Number.isFinite(value)) return '—'
  const sign = value < 0 ? '-' : ''
  const abs = Math.abs(value)
  if (abs < 1000) return `${sign}${Math.round(abs)}`

  /** 从大到小排的档位。索引 +1 就是更大的一档。 */
  const units = ['k', 'M', 'B'] as const

  for (let i = units.length - 1; i >= 0; i--) {
    const scale = 1000 ** (i + 1)
    if (abs < scale) continue
    const suffix = units[i]!
    // 先按这一档算，再看它有没有被四舍五入**顶到下一档**（`999_950` → `1000.0k`）。
    // 少了这一步就会写出 `1000k` 这种没人会读的东西。
    let scaled = round1(abs / scale)
    let finalSuffix: string = suffix
    if (scaled >= 1000) {
      const next = units[i + 1]
      if (next === undefined) {
        // 已经是最大档（B）：如实写原数，别假装成 1000B
        return `${sign}${Math.round(abs)}`
      }
      scaled = round1(abs / (scale * 1000))
      finalSuffix = next
    }
    return `${sign}${format1(scaled)}${finalSuffix}`
  }
  return `${sign}${Math.round(abs)}`
}

/** 保留一位小数。**返回数字**——它要参与"有没有顶到下一档"的比较。 */
function round1(value: number): number {
  return Math.round(value * 10) / 10
}

/** 一位小数的显示形式；整数不带 `.0`（`12.0k` 读起来像有两位有效数字，其实没有）。 */
function format1(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1)
}

/**
 * 对话标题右侧那一行读数：**短**。
 *
 * 形如 `565.3k 入 / 18.1k 出 · 缓存 89% · $0.0123`。原来那行是
 * `1,234,567 入 / 89,012 出   31 turns · 30 tools · 6 shots   $0.0524 · 缓存命中 98%`，
 * 它待在输入框下面、占满一整行——用户要的是"扫一眼知道花了多少"，不是一份账单。
 *
 * 两条保留的判据（原来的注释里写着，现在仍然成立）：
 *  - **缓存那一项只在 provider 报了的时候才显示**（`cacheShare` 返回 undefined 就不显示），
 *    而不是显示 0%——98% 命中是这个 harness 成本结构里最重要的一个数字（§9.2 Regime A）；
 *  - 缓存**只给百分比**，不给绝对数：绝对数在顶栏这个宽度里没有决策价值。
 *
 * 只剩四项：入 / 出 / 缓存 / 花费。见下面关于轮次与截图那一段为什么被删掉。
 */
export function usageText(
  chat: { usage: ChatUsageView; costAmount?: number; costCurrency?: string } | undefined,
): string {
  if (chat === undefined) return ''
  const parts: string[] = []
  // 还没有任何输入（新会话）时别显示一串 0
  if (chat.usage.in > 0 || chat.usage.out > 0) {
    parts.push(
      t('cost.compactTokens', {
        in: compactNumber(chat.usage.in),
        out: compactNumber(chat.usage.out),
      }),
    )
  }
  /**
   * **轮数与截图数不显示。**
   *
   * 这两项原来跟着 token 一起拼在这一行里，而它们是这里最长、也最没有决策价值的
   * 两个数：用户要回答的是"花了多少 / 缓存命中有没有生效"，"跑了几轮、截了几张图"
   * 既不影响任何决定，也不是他能控制的东西。删掉之后这一行短了一大截。
   *
   * 数据本身没删：`usage.turns` / `usage.screenshots` 仍在 `UsageTotals` 里记账，
   * 预算闸门（`agent.usage.maxTurns`）与隐藏的 `#cost` 诊断元素照旧用得到。
   */
  const cache = cacheShare(chat.usage)
  if (cache !== undefined) parts.push(t('cost.compactCache', { percent: cache.percent }))
  if (chat.costAmount !== undefined) {
    parts.push(t('cost.amount', { amount: chat.costAmount.toFixed(4), currency: chat.costCurrency ?? 'USD' }))
  }
  return parts.join(' · ')
}

/**
 * 成本 / 缓存命中读数（隐藏的 `#cost` 元素）。
 *
 * 与 `usageText` 分开是有原因的：它们的**用途不同**。这条是给诊断与自动化读的一句话
 * （元素本身带 `hidden`），而 `usageText` 是给人扫一眼的短标签。合起来写会得出
 * "要么太长、要么信息不全"的折中。
 */
export function costText(
  costAmount: number | undefined,
  currency: string | undefined,
  usage: ChatUsageView | undefined,
): string {
  if (usage === undefined) return ''
  const cache = cacheShare(usage)
  const amount =
    costAmount !== undefined
      ? t('cost.amount', { amount: costAmount.toFixed(4), currency: currency ?? 'USD' })
      : ''
  if (cache === undefined || amount.length === 0) return amount
  return `${amount} · ${t('cost.cachedShare', { percent: cache.percent })}`
}

/** 方块名的短形式：`minecraft:` 前缀与状态属性在人眼里是噪音。 */
export function shortBlock(name: string): string {
  return name.replace(/^minecraft:/, '').replace(/\[.*\]$/, '')
}
