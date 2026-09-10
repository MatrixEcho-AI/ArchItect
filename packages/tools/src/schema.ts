/**
 * 工具参数的 JSON Schema。
 *
 * **这里是唯一真相**：喂给 LLM 的 schema 和本地校验用的是同一份定义，
 * 不存在"schema 说能传、校验器说不行"这类分歧。
 *
 * 只实现我们实际用到的子集——够用即可，不追求完整的 JSON Schema 规范。
 */
export interface JsonSchema {
  type?: 'object' | 'array' | 'string' | 'number' | 'integer' | 'boolean'
  description?: string
  enum?: readonly (string | number)[]
  items?: JsonSchema
  properties?: Record<string, JsonSchema>
  required?: readonly string[]
  /** 默认 `false`：未知字段会被拒绝，并列出合法字段名（对 LLM 自纠很关键）。 */
  additionalProperties?: boolean
  minimum?: number
  maximum?: number
  minItems?: number
  maxItems?: number
  default?: unknown
}

export interface ValidationIssue {
  /** 出问题的字段路径，如 `from` 或 `ops[2].block`。 */
  path: string
  message: string
}

export type ValidationResult =
  | { ok: true; value: Record<string, unknown> }
  | { ok: false; issues: ValidationIssue[] }

/** 把校验问题拼成一句给 LLM 看的、可自纠的话。 */
export function describeIssues(issues: readonly ValidationIssue[]): string {
  return issues.map((i) => (i.path.length > 0 ? `${i.path}: ${i.message}` : i.message)).join('; ')
}

export function validateArgs(schema: JsonSchema, input: unknown): ValidationResult {
  const issues: ValidationIssue[] = []
  if (schema.type !== 'object') {
    throw new Error(`Tool parameter schema root type must be object, got ${String(schema.type)}`)
  }
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return { ok: false, issues: [{ path: '', message: `Arguments must be an object, got ${typeName(input)}` }] }
  }

  const source = input as Record<string, unknown>
  const properties = schema.properties ?? {}
  const allowed = Object.keys(properties)
  const out: Record<string, unknown> = {}

  for (const key of Object.keys(source)) {
    if (allowed.includes(key)) continue
    // `additionalProperties: true` 是**显式**的逃生口：`run_batch` 的 `ops[].args`
    // 里头装的是别的工具的参数字典，形状由那个工具自己校验，这里不该拦。
    // 默认仍然是 `false`（拒绝未知字段并列出合法键名，plan §8.4 的自纠路径）。
    if (schema.additionalProperties === true) {
      out[key] = source[key]
      continue
    }
    issues.push({
      path: key,
      message: `Unknown argument. This tool accepts: ${allowed.length > 0 ? allowed.join(', ') : '(no arguments)'}`,
    })
  }

  for (const [key, property] of Object.entries(properties)) {
    const present = Object.prototype.hasOwnProperty.call(source, key)
    if (!present) {
      if (property.default !== undefined) out[key] = property.default
      else if ((schema.required ?? []).includes(key)) {
        issues.push({ path: key, message: 'Missing required argument' })
      }
      continue
    }
    const validated = validateValue(property, source[key], key, issues)
    if (validated !== undefined) out[key] = validated.value
  }

  return issues.length > 0 ? { ok: false, issues } : { ok: true, value: out }
}

function validateValue(
  schema: JsonSchema,
  value: unknown,
  path: string,
  issues: ValidationIssue[],
): { value: unknown } | undefined {
  if (schema.enum !== undefined && !schema.enum.includes(value as string | number)) {
    issues.push({ path, message: `Must be one of: ${schema.enum.join(' | ')} (got ${JSON.stringify(value)})` })
    return undefined
  }

  switch (schema.type) {
    case 'integer':
    case 'number': {
      const numeric = typeof value === 'number' ? value : Number(value)
      if (!Number.isFinite(numeric)) {
        issues.push({ path, message: `Must be a number, got ${JSON.stringify(value)}` })
        return undefined
      }
      if (schema.type === 'integer' && !Number.isInteger(numeric)) {
        issues.push({ path, message: `Must be an integer, got ${numeric}` })
        return undefined
      }
      if (schema.minimum !== undefined && numeric < schema.minimum) {
        issues.push({ path, message: `Must not be less than ${schema.minimum} (got ${numeric})` })
        return undefined
      }
      if (schema.maximum !== undefined && numeric > schema.maximum) {
        issues.push({ path, message: `Must not be greater than ${schema.maximum} (got ${numeric})` })
        return undefined
      }
      return { value: numeric }
    }
    case 'boolean':
      if (typeof value !== 'boolean') {
        issues.push({ path, message: `Must be a boolean, got ${JSON.stringify(value)}` })
        return undefined
      }
      return { value }
    case 'string':
      if (typeof value !== 'string') {
        issues.push({ path, message: `Must be a string, got ${JSON.stringify(value)}` })
        return undefined
      }
      return { value }
    case 'array': {
      if (!Array.isArray(value)) {
        issues.push({ path, message: `Must be an array, got ${typeName(value)}` })
        return undefined
      }
      if (schema.minItems !== undefined && value.length < schema.minItems) {
        issues.push({ path, message: `At least ${schema.minItems} items, got ${value.length}` })
        return undefined
      }
      if (schema.maxItems !== undefined && value.length > schema.maxItems) {
        issues.push({ path, message: `At most ${schema.maxItems} items, got ${value.length}` })
        return undefined
      }
      const items = schema.items
      if (items === undefined) return { value }
      const collected: unknown[] = []
      for (let i = 0; i < value.length; i++) {
        const item = validateValue(items, value[i], `${path}[${i}]`, issues)
        if (item !== undefined) collected.push(item.value)
      }
      return { value: collected }
    }
    case 'object': {
      const nested = validateArgs(schema, value)
      if (!nested.ok) {
        for (const issue of nested.issues) {
          issues.push({ path: issue.path.length > 0 ? `${path}.${issue.path}` : path, message: issue.message })
        }
        return undefined
      }
      return { value: nested.value }
    }
    case undefined:
      return { value }
    default:
      issues.push({ path, message: `Unsupported schema type ${String(schema.type)}` })
      return undefined
  }
}

function typeName(value: unknown): string {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'array'
  return typeof value
}

// ── 构造助手：让工具定义读起来接近自然语言 ────────────────────────────

export const str = (description: string, extra: Partial<JsonSchema> = {}): JsonSchema => ({
  type: 'string',
  description,
  ...extra,
})

export const int = (description: string, extra: Partial<JsonSchema> = {}): JsonSchema => ({
  type: 'integer',
  description,
  ...extra,
})

export const num = (description: string, extra: Partial<JsonSchema> = {}): JsonSchema => ({
  type: 'number',
  description,
  ...extra,
})

export const bool = (description: string, extra: Partial<JsonSchema> = {}): JsonSchema => ({
  type: 'boolean',
  description,
  ...extra,
})

export const arr = (
  description: string,
  items: JsonSchema,
  extra: Partial<JsonSchema> = {},
): JsonSchema => ({ type: 'array', description, items, ...extra })

export const obj = (
  properties: Record<string, JsonSchema>,
  required: readonly string[] = [],
  extra: Partial<JsonSchema> = {},
): JsonSchema => ({
  type: 'object',
  properties,
  required,
  additionalProperties: false,
  ...extra,
})

/** 世界坐标 `[x, y, z]`。用数组而不是对象是为了省 token（LLM 每次调用都要带）。 */
export const vec3 = (description: string): JsonSchema =>
  arr(description, int('coordinate component'), { minItems: 3, maxItems: 3 })

export const vec2 = (description: string): JsonSchema =>
  arr(description, int('coordinate component'), { minItems: 2, maxItems: 2 })

/** 方块引用：`"minecraft:stone"` 或 `"oak_stairs[facing=east]"`。 */
export const blockRef = (description: string): JsonSchema => str(description)
