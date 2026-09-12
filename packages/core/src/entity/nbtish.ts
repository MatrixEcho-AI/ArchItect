/**
 * "这个 JSON 值能不能变成 NBT"的检查。
 *
 * 为什么工具层需要它：`PlacedEntity.data` / `PlacedBlockEntity.data` 是**自由 JSON**，
 * 而它们最终要写进 `.schem` / `.litematic`，那里是 NBT。两种表示的信息量不一样，
 * 而 JSON 里有几样东西在 NBT 里**根本没有对应**——`null`、非有限数字、
 * 函数，以及**异质数组**（NBT 的列表必须同质）。
 *
 * 早一点报出来比晚一点好：等到导出时才失败，模型的世界里已经躺着一份
 * 永远导不出去的数据，而它看不到任何征兆。
 *
 * **与 `packages/interop/src/json-nbt.ts` 的关系**：那里的转换器是权威，
 * 这里是写盘前的预检。规则确实写了两遍，但刻意让**预检更保守**——它只拒绝
 * 一定不可能的值。如果哪天两条规则漂开，表现是"写入时通过、导出时被 `problems`
 * 报出来"，而不是静默产出一个错的文件。
 */

/** 值不行时返回一句人话；能变成 NBT 时返回 `undefined`。 */
export function nbtValueProblem(value: unknown, path = 'data'): string | undefined {
  if (value === null) return `${path} is null — NBT has no null type`
  switch (typeof value) {
    case 'string':
      return undefined
    case 'boolean':
      return undefined
    case 'number':
      return Number.isFinite(value) ? undefined : `${path} is ${String(value)} — NBT numbers must be finite`
    case 'object':
      break
    default:
      // function / symbol / bigint / undefined
      return `${path} is a ${typeof value}, which has no NBT representation`
  }

  if (Array.isArray(value)) {
    if (value.length === 0) return undefined
    const first = kindOf(value[0])
    for (let i = 1; i < value.length; i++) {
      const kind = kindOf(value[i])
      if (kind !== first) {
        return (
          `${path}[${i}] is a ${kind} but ${path}[0] is a ${first} — ` +
          'an NBT list must be homogeneous, so a mixed array cannot be stored'
        )
      }
    }
    for (let i = 0; i < value.length; i++) {
      const problem = nbtValueProblem(value[i], `${path}[${i}]`)
      if (problem !== undefined) return problem
    }
    return undefined
  }

  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (item === undefined) continue // NBT 允许空槽，序列化时直接不写
    const problem = nbtValueProblem(item, `${path}.${key}`)
    if (problem !== undefined) return problem
  }
  return undefined
}

export function isNbtValue(value: unknown): boolean {
  return nbtValueProblem(value) === undefined
}

/** 数组同质性比较用的粗粒度类型（数字之间不分 int/double，那由转换器决定）。 */
function kindOf(value: unknown): string {
  if (Array.isArray(value)) return 'array'
  if (value === null) return 'null'
  return typeof value
}
