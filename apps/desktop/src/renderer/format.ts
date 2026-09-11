/**
 * 界面上的**纯计算**（不碰 DOM，所以能单测）。
 *
 * 渲染进程以前是零单测的：它整块逻辑都挂在 DOM 上。但"成本表盘显示什么"这类东西
 * 其实是纯函数，把它从 `main.ts` 里拎出来，就能用测试钉住——而它恰好是最容易被
 * 改错又最难发现的一类（数字看着有，但比例错了没人会注意到）。
 */

/** 与 `ChatView.usage` 同形（只取这里用得到的字段）。 */
export interface UsageLike {
  in: number
  out: number
  /** 命中前缀缓存的输入 token。老 provider / 老工程可能没有这个数。 */
  cachedIn?: number
}

export interface CacheShare {
  count: number
  /** 0..100，四舍五入到整数。 */
  percent: number
}

/**
 * 输入里有多少走了前缀缓存。
 *
 * 三种情况返回 `undefined`（界面据此**不显示**这一项，而不是显示 0%）：
 *
 * - provider 不报缓存（本地模型、老录音）；
 * - 还没有任何输入（新会话）；
 * - 报了个不可能的数（`cachedIn > in`，说明 provider 的字段含义与我们对不上——
 *   宁可不说，也不要在界面上显示一个 120% 的"缓存命中"）。
 */
export function cacheShare(usage: UsageLike): CacheShare | undefined {
  const cached = usage.cachedIn
  if (cached === undefined || cached <= 0) return undefined
  if (usage.in <= 0 || cached > usage.in) return undefined
  return { count: cached, percent: Math.round((cached / usage.in) * 100) }
}
