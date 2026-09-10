import type { ToolRegistry } from './registry.js'
import type { JsonSchema } from './schema.js'
import type { ToolDefinition } from './types.js'

/**
 * **从工具定义生成参考文档**（plan §11 的 `docs/tool-reference.md`）。
 *
 * 手写的工具文档一定会漂移：改了 schema 忘了改文档，读者看到的就是错的契约。
 * 这里换成单向生成——schema 是唯一真相，文档是它的一个视图。
 * `packages/tools/test/docs.test.ts` 会在文档过期时**直接失败**，所以漂移不可能悄悄发生。
 *
 * 生成不出来的部分（坐标口径、`fill_line` 的半径语义这类只有散文能说清的东西）
 * 留在 `plan.md` 的附录里，文档开头指过去，而不是在这里再抄一遍。
 */

const HEADER = `<!-- 由 packages/tools/src/docs.ts 生成，请勿手工编辑。 -->
<!-- 重新生成：pnpm docs:gen -->

# 工具参考

> **本文件是生成的。** 唯一真相是工具自己的 JSON Schema（\`packages/tools/src/tools/*.ts\`），
> 改 schema 之后跑 \`pnpm docs:gen\` 重新生成；文档过期时 \`pnpm test\` 会失败。
>
> 参数表能说清"有哪些参数"，说不清"这个语义为什么这样设计"。后者在 \`plan.md\` 里：
> **附录 A**（\`fill_line\` 的半径/锥度语义）、**附录 C**（几何算子的坐标口径）、
> **附录 D**（变换与批处理语义）、**附录 E**（导出格式的坑）。
>
> 工具描述本身是写给 LLM 的 prompt，所以是**英文**；这份文档是写给人看的，所以是**中文**。
`

/** 按"什么时候该用"分组。分组的依据是 mutating / destructive 两个标志，不是手写的清单。 */
interface Group {
  title: string
  blurb: string
  match: (tool: ToolDefinition) => boolean
}

const GROUPS: readonly Group[] = [
  {
    title: '批量编辑',
    blurb: '一次调用改很多格——**这类工具是主力**，逐格摆放是最后手段。',
    match: (tool) => tool.mutating && !tool.destructive && tool.name !== 'undo' && tool.name !== 'redo',
  },
  {
    title: '破坏性编辑',
    blurb: '会删掉已有内容，触发确认阈值时需要先解释清楚再带 `confirm: true` 重发。',
    match: (tool) => tool.mutating && tool.destructive,
  },
  {
    title: '检视（只读，不产生 revision）',
    blurb: '读回与定位。**精确改格子必须靠 `slice` 的 ASCII 图，不能靠数截图里的像素。**',
    match: (tool) => !tool.mutating,
  },
]

export function renderToolReference(registry: ToolRegistry): string {
  const tools = registry.list()
  const lines: string[] = [HEADER]

  lines.push('## 一览\n')
  lines.push('| 工具 | 改世界 | 破坏性 | 一句话 |')
  lines.push('|------|:------:|:------:|--------|')
  for (const tool of tools) {
    lines.push(
      `| [\`${tool.name}\`](#${anchor(tool.name)}) | ${tool.mutating ? '✅' : '—'} | ${
        tool.destructive ? '⚠️' : '—'
      } | ${firstSentence(tool.description)} |`,
    )
  }
  lines.push('')

  const grouped = new Set<string>()
  for (const group of GROUPS) {
    const members = tools.filter((tool) => group.match(tool) && !grouped.has(tool.name))
    if (members.length === 0) continue
    lines.push(`## ${group.title}\n`)
    lines.push(`${group.blurb}\n`)
    for (const tool of members) {
      grouped.add(tool.name)
      lines.push(...renderTool(tool))
    }
  }

  // 兜底：上面的分组条件如果漏掉了某个工具，也要出现在文档里而不是消失
  const ungrouped = tools.filter((tool) => !grouped.has(tool.name))
  if (ungrouped.length > 0) {
    lines.push('## 其他\n')
    for (const tool of ungrouped) lines.push(...renderTool(tool))
  }

  return `${lines.join('\n').trimEnd()}\n`
}

/** 校验生成的文档是否与磁盘上的一致。返回不一致的原因（空数组表示一致）。 */
export function diffToolReference(registry: ToolRegistry, onDisk: string): string[] {
  const expected = renderToolReference(registry)
  if (expected === onDisk) return []
  const expectedNames = [...expected.matchAll(/^## `([a-z_]+)`$/gm)].map((match) => match[1]!)
  const diskNames = [...onDisk.matchAll(/^## `([a-z_]+)`$/gm)].map((match) => match[1]!)
  const problems: string[] = []
  const missing = expectedNames.filter((name) => !diskNames.includes(name))
  const extra = diskNames.filter((name) => !expectedNames.includes(name))
  if (missing.length > 0) problems.push(`文档缺少这些工具：${missing.join(', ')}`)
  if (extra.length > 0) problems.push(`文档里有已不存在的工具：${extra.join(', ')}`)
  if (problems.length === 0) problems.push('文档内容与生成的版本不一致（可能改了描述或参数）')
  return problems
}

function renderTool(tool: ToolDefinition): string[] {
  const lines: string[] = [`## \`${tool.name}\`\n`]
  lines.push(`\`\`\`\n${tool.description}\n\`\`\`\n`)

  const schema = tool.parameters
  const required = new Set(schema.required ?? [])
  const properties = schema.properties ?? {}
  const entries = Object.entries(properties)

  if (entries.length === 0) {
    lines.push('**无参数。**\n')
    return lines
  }

  // 先收集行、再一次性输出：中间不能插空行，否则 Markdown 会把表格截成两半
  const rows: string[] = []
  const nested: string[] = []
  for (const [name, property] of entries) {
    rows.push(
      `| \`${name}\` | ${typeOf(property)} | ${required.has(name) ? '✅' : '—'} | ${constraintOf(property)} | ${
        property.default !== undefined ? `\`${JSON.stringify(property.default)}\`` : '—'
      } | ${oneLine(property.description ?? '')} |`,
    )
    // 数组元素的对象结构单独展开——`run_batch` 的 `ops[]` 就在这一层
    const itemProperties = property.items?.properties
    if (itemProperties === undefined || Object.keys(itemProperties).length === 0) continue
    const itemRequired = new Set(property.items?.required ?? [])
    nested.push(`\`${name}[]\` 的每一项：\n`)
    nested.push('| 字段 | 类型 | 必填 | 说明 |')
    nested.push('|------|------|:----:|------|')
    for (const [key, item] of Object.entries(itemProperties)) {
      nested.push(
        `| \`${key}\` | ${typeOf(item)} | ${itemRequired.has(key) ? '✅' : '—'} | ${oneLine(item.description ?? '')} |`,
      )
    }
    nested.push('')
  }

  lines.push('| 参数 | 类型 | 必填 | 取值 / 范围 | 默认 | 说明 |')
  lines.push('|------|------|:----:|-------------|------|------|')
  lines.push(...rows)
  lines.push('')
  if (nested.length > 0) lines.push(...nested)
  if (schema.additionalProperties === true) {
    lines.push('> 这个工具接受**额外的、由内层工具自己校验**的参数（见 `additionalProperties: true`）。')
    lines.push('')
  }
  return lines
}

function typeOf(schema: JsonSchema): string {
  if (schema.enum !== undefined) return '枚举'
  switch (schema.type) {
    case 'array': {
      if (schema.items === undefined) return '数组'
      return schema.items.type === 'object' ? '对象数组' : `数组<${typeOf(schema.items)}>`
    }
    case 'integer':
      return '整数'
    case 'number':
      return '数字'
    case 'boolean':
      return '布尔'
    case 'object':
      return '对象'
    case 'string':
      return '字符串'
    default:
      return '—'
  }
}

function constraintOf(schema: JsonSchema): string {
  const parts: string[] = []
  if (schema.enum !== undefined) parts.push(schema.enum.map((value) => `\`${String(value)}\``).join(' / '))
  if (schema.type === 'integer' || schema.type === 'number') {
    if (schema.minimum !== undefined && schema.maximum !== undefined) parts.push(`${schema.minimum}..${schema.maximum}`)
    else if (schema.minimum !== undefined) parts.push(`≥ ${schema.minimum}`)
    else if (schema.maximum !== undefined) parts.push(`≤ ${schema.maximum}`)
  }
  if (schema.type === 'array') {
    if (schema.minItems !== undefined && schema.maxItems !== undefined) parts.push(`${schema.minItems}..${schema.maxItems} 项`)
    else if (schema.minItems !== undefined) parts.push(`≥ ${schema.minItems} 项`)
    else if (schema.maxItems !== undefined) parts.push(`≤ ${schema.maxItems} 项`)
  }
  return parts.length > 0 ? parts.join('；') : '—'
}

/** 表格单元格里不能有换行；描述常常是多行的。 */
const oneLine = (text: string): string => text.replace(/\s*\n\s*/g, ' ').trim()

/** 描述的第一句，用在一览表里。 */
function firstSentence(description: string): string {
  const flat = oneLine(description)
  const match = /^(.+?[.。])(?:\s|$)/.exec(flat)
  const sentence = match?.[1] ?? flat
  return sentence.length > 80 ? `${sentence.slice(0, 80)}…` : sentence
}

/** GitHub 风格的锚点。 */
function anchor(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9_-]/g, '')
}
