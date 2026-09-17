import { t } from './index.js'
import type { MessageKey } from './index.js'

/**
 * 结构化提示的**显示层翻译**。
 *
 * `packages/*` 冒上来的不是一句话，而是**稳定的 code 与参数**：中间层（CLI / 桌面端）
 * 拿 code 翻译成当前语言，`.mcai` 存档与测试只断言 code——同一份档案不随
 * 界面语言漂移。这与 `errors.ts` 的 `localizeToolError` 是同一套取舍的两个成员：
 * 那边处理工具错误码（`error.*`），这边处理上下文裁剪原因与互操作问题。
 *
 * 为什么类型定义在 i18n 而不是在 agent / interop：**不能为了一个类型把依赖

 * 反过来**（i18n 应该谁都能用），所以这里声明的是「最小结构」，生产方各自定义
 * 结构兼容的接口（与 `LocalizableToolError` 刻意不 import `ToolError` 同理）。
 */

/** `packages/agent/src/context.ts` 里 `ContextReason` 的最小结构。 */
export interface LocalizableContextReason {
  code: string
  /** 上下文窗口的 token 数（只有 SMALL_CONTEXT_WINDOW 带着它）。 */
  window?: number
}

const CONTEXT_REASON_KEYS: Record<string, MessageKey> = {
  KEPT_BY_PROMPT_CACHE: 'agent.contextReason.keptByPromptCache',
  CAPABILITY_UNKNOWN: 'agent.contextReason.capabilityUnknown',
  NO_PROMPT_CACHE: 'agent.contextReason.noPromptCache',
  SMALL_CONTEXT_WINDOW: 'agent.contextReason.smallWindow',
}

/** 裁剪原因 → 当前语言的一句话。不认识的 code 原样返回。 */
export function localizeContextReason(reason: LocalizableContextReason): string {
  const key = CONTEXT_REASON_KEYS[reason.code]
  if (key === undefined) return reason.code
  const rendered = t(key, reason.window === undefined ? {} : { window: reason.window })
  // 参数没给全（占位符还在）就退回 code：显示 {{window}} 比显示裸 code 更糟
  if (rendered.includes('{{')) return reason.code
  return rendered
}

/** 互操作导出与存档截图自查里的一条问题（`collectSparse` / `validateCaptures` 的产出）。 */
export interface LocalizableProblem {
  code: string
  params?: Record<string, string | number>
}

const PROBLEM_KEYS: Record<string, MessageKey> = {
  ENTITY_EXTRA_NOT_NBT: 'problem.entityExtra',
  BLOCK_ENTITY_EXTRA_NOT_NBT: 'problem.blockEntityExtra',
  CAPTURE_SHA_MISMATCH: 'problem.captureShaMismatch',
  CAPTURE_DUPLICATE_ID: 'problem.captureDuplicateId',
  CAPTURE_MISSING_FILE: 'problem.captureMissingFile',
  CAPTURE_SIZE_MISMATCH: 'problem.captureSizeMismatch',
  CAPTURE_ORPHAN_FILE: 'problem.captureOrphanFile',
  CAPTURE_BAD_ENTRY_NAME: 'problem.captureBadEntryName',
}

/** 一条问题 → 当前语言的一句话。认不出的 code 退回可读的 JSON 形状。 */
export function localizeProblem(problem: LocalizableProblem): string {
  const key = PROBLEM_KEYS[problem.code]
  if (key === undefined) return JSON.stringify(problem)
  const rendered = t(key, problem.params ?? {})
  if (rendered.includes('{{')) return JSON.stringify(problem)
  return rendered
}
