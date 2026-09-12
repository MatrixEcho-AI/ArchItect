import { t } from '@architect/i18n'

import type { LlmProvider, LlmRequest, LlmResponse, LlmToolCall, LlmUsage } from '../types.js'

export interface ScriptedStep {
  text?: string
  /**
   * `unparsableArgs` 用来演"模型吐了一段不是合法 JSON 的参数"（见 `LlmToolCall.unparsableArgs`）。
   * 有它时循环会把这次调用变成一条失败的工具结果，而不是结束 run——真机上
   * 遇到的就是这条路径，而它必须在没有 API key 的情况下可测。
   */
  toolCalls?: Array<{ name: string; args: unknown; unparsableArgs?: string }>
  reasoningContent?: string
}

export type ScriptedDecider = (request: LlmRequest, turn: number) => ScriptedStep

/**
 * 确定性的剧本 provider。
 *
 * 存在的理由是**让 Agent 循环在没有 API key 的情况下完全可测**：
 * 给定一串"第 N 轮该返回什么"，循环的每一步（工具调用、图像回灌、终止条件、
 * 预算耗尽）都能被断言，而不需要联网、不需要花钱、不会因为模型随机性而 flaky。
 *
 * 也可以用来做离线演示：把一段真实的工具调用序列录下来，之后随时重放。
 */
export class ScriptedProvider implements LlmProvider {
  readonly id = 'scripted'
  readonly model: string
  readonly supportsImages: boolean

  private turn = 0

  constructor(
    private readonly script: ScriptedDecider | readonly ScriptedStep[],
    options: { model?: string; supportsImages?: boolean } = {},
  ) {
    this.model = options.model ?? 'scripted-v1'
    this.supportsImages = options.supportsImages !== false
  }

  /** 已经走了几轮，便于测试断言。 */
  get turns(): number {
    return this.turn
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async chat(request: LlmRequest): Promise<LlmResponse> {
    const step =
      typeof this.script === 'function'
        ? this.script(request, this.turn)
        : (this.script[this.turn] ?? { text: t('agent.scripted.exhausted') })
    this.turn++

    const toolCalls: LlmToolCall[] = (step.toolCalls ?? []).map((call, index) => ({
      id: `call_${this.turn}_${index}`,
      name: call.name,
      args: call.args,
      ...(call.unparsableArgs !== undefined ? { unparsableArgs: call.unparsableArgs } : {}),
    }))

    const response: LlmResponse = {
      text: step.text ?? '',
      toolCalls,
      usage: estimateUsage(request, step),
      finishReason: toolCalls.length > 0 ? 'tool_calls' : 'stop',
    }
    if (step.reasoningContent !== undefined) response.reasoningContent = step.reasoningContent
    return response
  }
}

/** 粗略估算 token（约 4 字符 1 token），让成本统计在离线测试里也有数。 */
function estimateUsage(request: LlmRequest, step: ScriptedStep): LlmUsage {
  let chars = request.system.length
  for (const message of request.messages) {
    chars += message.content.length
    if (message.images !== undefined) chars += message.images.length * 1400 // 单图约 350 token
  }
  const outChars = (step.text?.length ?? 0) + JSON.stringify(step.toolCalls ?? []).length
  return { in: Math.ceil(chars / 4), out: Math.ceil(outChars / 4) }
}

/** 由一串 `[工具名, 参数]` 生成"全程只调工具，最后收尾"的剧本。 */
export function scriptFromCalls(
  calls: ReadonlyArray<readonly [string, unknown]>,
  finalText = t('agent.scripted.done'),
): ScriptedStep[] {
  return [
    ...calls.map(([name, args]) => ({ toolCalls: [{ name, args }] })),
    { text: finalText },
  ]
}
