/**
 * 确定性 JSON 序列化（对象键递归排序）。
 *
 * 为什么需要它：稀疏层的 `data` 是开放对象，而 `contentHash()` 要拿它算哈希。
 * 直接用 `JSON.stringify` 的话，`{a:1,b:2}` 与 `{b:2,a:1}` 会算出两个哈希——
 * 于是"同一个世界"取决于谁先写了哪个键。`verifyReplay` 会因此偶发失败，
 * 而失败的样子是"重放之后世界不一样了"，指向一个根本不存在的问题。
 *
 * 顺带把 `undefined` 值的键丢掉：`{a:1, b:undefined}` 与 `{a:1}` 是同一个值，
 * 序列化上也该是同一个字符串（`JSON.stringify` 本来就丢，这里显式做，
 * 免得依赖它的实现细节）。
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortValue(value))
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue)
  if (value !== null && typeof value === 'object') {
    const source = value as Record<string, unknown>
    const out: Record<string, unknown> = {}
    for (const key of Object.keys(source).sort()) {
      const item = source[key]
      if (item === undefined) continue
      out[key] = sortValue(item)
    }
    return out
  }
  return value
}
