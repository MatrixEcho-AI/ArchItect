import { describeIssues, validateArgs } from './schema.js'
import { failure } from './types.js'
import type { ToolContext, ToolDefinition, ToolResult } from './types.js'

/**
 * 工具注册表。
 *
 * 负责三件事：把工具导出成 LLM 认识的格式、校验参数、以及**把执行期的异常
 * 转成结构化的、可自纠的错误**——工具抛出去没人接，Agent 循环就会整个挂掉。
 */
export class ToolRegistry {
  private readonly tools = new Map<string, ToolDefinition>()

  register(tool: ToolDefinition): this {
    if (this.tools.has(tool.name)) throw new Error(`Tool "${tool.name}" is already registered`)
    this.tools.set(tool.name, tool)
    return this
  }

  get(name: string): ToolDefinition | undefined {
    return this.tools.get(name)
  }

  list(): ToolDefinition[] {
    return [...this.tools.values()]
  }

  get size(): number {
    return this.tools.size
  }

  /** 导出成 LLM 的 tools 参数（OpenAI `tools` / Anthropic `tools` 的形状）。 */
  toToolSchemas(): Array<{ name: string; description: string; parameters: unknown }> {
    return this.list().map((tool) => ({
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    }))
  }

  /** 校验并执行一次工具调用。**永远不抛异常**，失败以 `ok: false` 返回。 */
  async call(ctx: ToolContext, name: string, rawArgs: unknown): Promise<ToolResult> {
    const tool = this.tools.get(name)
    if (tool === undefined) {
      return failure(
        'UNKNOWN_TOOL',
        `No tool named "${name}"`,
        `Available tools: ${[...this.tools.keys()].join(', ')}`,
      )
    }

    const validated = validateArgs(tool.parameters, rawArgs ?? {})
    if (!validated.ok) {
      return failure('INVALID_ARGS', `Invalid arguments: ${describeIssues(validated.issues)}`)
    }

    try {
      return await tool.execute(ctx, validated.value)
    } catch (error) {
      // 工具内部异常不能让 Agent 循环崩掉——转成可自纠的错误还给它
      const message = error instanceof Error ? error.message : String(error)
      return failure('INTERNAL', `Tool ${name} failed: ${message}`)
    }
  }
}
