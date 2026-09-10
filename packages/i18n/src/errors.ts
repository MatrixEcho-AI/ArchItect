import { t } from './index.js'
import type { MessageKey, MessageVars } from './index.js'

/**
 * 工具错误的**最小结构**。
 *
 * 刻意不 import `@architect/tools` 的 `ToolError`：i18n 包应该谁都能用，
 * 不该为了一个类型把工具层拖进来（也避免包依赖成环）。
 */
export interface LocalizableToolError {
  code: string
  /** 面向 LLM 的英文说明。 */
  message: string
  hint?: string
}

/** 资源表里真的存在的工具错误码。 */
const KNOWN_CODES = new Set([
  'UNKNOWN_TOOL',
  'INVALID_ARGS',
  'UNKNOWN_BLOCK',
  'OUT_OF_VOLUME',
  'NEEDS_CONFIRM',
  'TOO_LARGE',
  'NOT_FOUND',
  'INTERNAL',
])

/**
 * 把工具错误本地化成**给用户看**的一句话。
 *
 * §10.4-1：给 LLM 的那份保持英文稳定（`formatToolResult` 负责），
 * 给用户看的这份走 i18n。同一份错误、两份渲染，互不影响。
 *
 * 参数不全时**回退到英文原文**——显示 `未知方块 {{name}}` 比显示英文原文更糟。
 */
export function localizeToolError(error: LocalizableToolError, params: MessageVars = {}): string {
  if (!KNOWN_CODES.has(error.code)) {
    return error.hint !== undefined ? `${error.message} — ${error.hint}` : error.message
  }
  const rendered = t(`error.${error.code}` as MessageKey, params)
  // 还有没被替换的占位符 = 参数没给全，回退
  if (rendered.includes('{{')) {
    return error.hint !== undefined ? `${error.message} — ${error.hint}` : error.message
  }
  return rendered
}

/** 从工具结果里常见的位置把参数抠出来，省得每个调用点手写一遍。 */
export function toolErrorParams(
  error: LocalizableToolError,
  data?: Record<string, unknown>,
): MessageVars {
  const params: MessageVars = {}
  for (const [key, value] of Object.entries(data ?? {})) {
    if (typeof value === 'string' || typeof value === 'number') params[key] = value
  }
  if (params['suggestions'] === undefined) {
    // 建议列表可能以 `.` / `?` / `。` 收尾——那是句子的一部分，不是列表的一部分
    const match =
      /Did you mean:?\s*(.+?)\s*[.?!。？]*$/.exec(error.message) ??
      /是否想用[:：]?\s*(.+?)\s*$/.exec(error.message)
    if (match?.[1] !== undefined) params['suggestions'] = match[1]
  }
  if (params['name'] === undefined) {
    // 真实格式：`Unknown block "minecraft:oak_logg".`（带引号）或旧的中文形式。
    // 引号可选，并且要削掉紧跟其后的句读——`minecraft:oak_logg.` 里的点是句子的一部分，不是名字的一部分。
    const match = /(?:Unknown block|未知方块)\s*["“]?([^"”\s]+)["”]?/.exec(error.message)
    if (match?.[1] !== undefined) params['name'] = match[1].replace(/[.,;:!?]+$/, '')
  }
  if (params['detail'] === undefined) params['detail'] = error.message
  return params
}
