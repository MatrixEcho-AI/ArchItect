import type { ClipRegion, EditLog, WorldStore, WriteResult } from '@architect/core'

import type { JsonSchema } from './schema.js'

/** 截图：工具返回给 LLM 的图像。 */
export interface ToolImage {
  png: Uint8Array
  width: number
  height: number
  /** 机位标识，如 `iso_ne`。 */
  camera: string
  /**
   * 截图时的世界版本。
   *
   * **必须回显并核对**：LLM 拿几轮前的旧图下结论是多轮视觉 agent 最隐蔽的 bug
   * （plan §9.4 机制 4）。
   */
  revision: number
}

export type ToolErrorCode =
  | 'UNKNOWN_TOOL'
  | 'INVALID_ARGS'
  | 'UNKNOWN_BLOCK'
  | 'OUT_OF_VOLUME'
  | 'NEEDS_CONFIRM'
  | 'TOO_LARGE'
  | 'NOT_FOUND'
  | 'INTERNAL'

export interface ToolError {
  code: ToolErrorCode
  /** 面向 LLM 的说明。 */
  message: string
  /** 自纠建议。 */
  hint?: string
}

export interface ToolResult {
  ok: boolean
  /** 紧凑文本结果——**这是 LLM 真正读的那份**。 */
  summary: string
  /** 结构化数据（供 UI / 测试 / 日志用）。 */
  data?: Record<string, unknown>
  image?: ToolImage
  error?: ToolError
  /** 累积的成本（由上层填）。 */
  cost?: { tokensIn: number; tokensOut: number; ms: number }
}

/**
 * 会话级相机。字段与 `ScreenshotRequest` 的相机部分同形，只是**没有**尺寸与高亮。
 *
 * 全部可选：`set_camera` 允许只改其中一项（比如只把注视点挪到塔顶）。
 */
export interface SessionCamera {
  view?: string
  azimuth?: number
  elevation?: number
  /** 相机位置（世界坐标）。与 `lookAt` 成对使用。 */
  eye?: [number, number, number]
  /** 注视点（世界坐标）。 */
  lookAt?: [number, number, number]
  /** 绕视线轴的滚转（度）。 */
  roll?: number
  /** 每格像素。 */
  scale?: number
}

export interface ScreenshotRequest {
  /** 预设机位名（`iso_ne` / `front` / `top` …）。给了 `azimuth`/`elevation` 时它只作为回退与标签。 */
  view: string
  width: number
  height: number
  /**
   * **自由机位**：水平角（度，0 = 从 +Z 朝 -Z 看）。
   *
   * 预设机位只有 9 个，而"这个屋檐从侧面看是不是挑得太远"这类判断经常需要
   * 一个预设给不出的角度。给了方位角就以它为准。
   */
  azimuth?: number
  /** **自由机位**：仰角（度，1 = 几乎平视，89 = 几乎俯视）。会被夹在 1..89。 */
  elevation?: number
  /** 每格像素。省略表示自动取景（按当前角度把内容铺满画面）。 */
  scale?: number
  /** 注视点（世界坐标）。省略表示内容包围盒中心——**只在要特写某个局部时才用**。 */
  target?: [number, number, number]
  /** 高亮某个区域（通常是上一次编辑的影响范围）。 */
  highlight?: { min: { x: number; y: number; z: number }; max: { x: number; y: number; z: number } }
  caption?: string[]
}

export interface ToolContext {
  store: WorldStore
  log: EditLog
  /**
   * 会话级的区域剪贴板。
   *
   * `copy_region` 写它、`paste_region` 读它——两次调用之间隔着若干轮对话，
   * 所以它必须活在整个会话上，而不是单次工具调用里。
   */
  clipboard: { current?: ClipRegion }
  /**
   * **会话级相机**，由 `set_camera` 设置。
   *
   * 和 `clipboard` 一样必须活在整个会话上：`set_camera` 与之后那些 `screenshot`
   * 之间隔着若干轮对话。`screenshot` 显式给了角度时以显式参数为准，
   * 没给才落到这里——否则"先定机位再反复截图"这件事没法表达。
   */
  camera?: SessionCamera
  /** 本轮的关联 id：同一次 LLM 响应里的多个 op 共享它，便于整轮回滚。 */
  correlationId: string
  /** 记录一条 EditOp。mutating 工具写入成功后必须调用。 */
  record: (tool: string, args: unknown, result: WriteResult) => void
  /** 截图实现。由调用方注入，避免 tools 包绑死某个渲染后端。 */
  shoot: (request: ScreenshotRequest) => ToolImage
}

export interface ToolDefinition {
  name: string
  /** 给 LLM 看的说明。**写不清楚 LLM 就用不对**（plan 附录 A）。 */
  description: string
  parameters: JsonSchema
  /** 是否修改世界。 */
  mutating: boolean
  /** 是否破坏性（大面积覆盖/删除）。 */
  destructive: boolean
  execute: (ctx: ToolContext, args: Record<string, unknown>) => ToolResult | Promise<ToolResult>
}

/** 定义一个工具。`Args` 只影响 executor 的类型，工具描述本身就是契约。 */
export function defineTool<Args extends Record<string, unknown>>(definition: {
  name: string
  description: string
  parameters: JsonSchema
  mutating?: boolean
  destructive?: boolean
  execute: (ctx: ToolContext, args: Args) => ToolResult | Promise<ToolResult>
}): ToolDefinition {
  return {
    name: definition.name,
    description: definition.description,
    parameters: definition.parameters,
    mutating: definition.mutating ?? false,
    destructive: definition.destructive ?? false,
    execute: (ctx, args) => definition.execute(ctx, args as Args),
  }
}

export function failure(
  code: ToolErrorCode,
  message: string,
  hint?: string,
  data?: Record<string, unknown>,
): ToolResult {
  const error: ToolError = { code, message }
  if (hint !== undefined) error.hint = hint
  const result: ToolResult = { ok: false, summary: hint !== undefined ? `${message} — ${hint}` : message, error }
  // `data` 里放**结构化**的参数（count / limit / name / suggestions），
  // UI 拿它去本地化（plan §10.4-1），LLM 仍然只读上面那句英文。
  if (data !== undefined) result.data = data
  return result
}
