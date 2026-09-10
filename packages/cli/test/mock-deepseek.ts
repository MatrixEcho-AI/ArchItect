import { createServer } from 'node:http'
import type { IncomingMessage, Server, ServerResponse } from 'node:http'

/**
 * 一个**协议级**的假模型端点。
 *
 * ## 它测的是别的测试测不到的那一段
 *
 * `ScriptedProvider` 绕过了整个 HTTP 层：请求体的字段名、`Authorization` 头、
 * 图像 content part 的形状、`reasoning_content` 的回传要求、流式关闭（`stream:false`）、
 * 以及"服务端报 400 时适配层怎么反应"——这些它一个都不经过。
 *
 * 这个服务器按 DeepSeek/OpenAI 兼容端的真实行为回话，并且**故意难为适配层**：
 *
 * 1. **只接受 `max_completion_tokens`**，见到 `max_tokens` 就返回 400，
 *    错误正文里提到 `max_completion_tokens`——这正是适配层 `'auto'` 模式要试出来的情形。
 * 2. **每次响应都带 `reasoning_content`**，并且**检查**后续请求里 assistant 消息
 *    有没有把它回传。DeepSeek 的推理模型少了这个字段会直接报错，而 OpenAI 收到
 *    这个未知字段也会报错——两边都硬性要求，才能证明 `'auto'` 的判据是对的。
 * 3. 图像 content part 要真的数出来，并按图片数量抬高 `prompt_tokens`，
 *    这样图像 token 的记账口径也能被验到。
 *
 * 它**不是**"假装能用的桩"：所有断言都建立在服务器真正收到的字节上
 * （见 `requests` 日志），而不是建立在"我们以为发出去的是什么"。
 */

export interface RecordedRequest {
  url: string
  /** 有没有带 Authorization 头。 */
  authorized: boolean
  /** 请求体里 `max_tokens` / `max_completion_tokens` 哪个字段出现了。 */
  maxTokensField?: string
  /** 那个字段的值。用来验"设了上限真的生效"，而不只是"字段存在"。 */
  maxTokensValue?: number
  /** 请求里带了几个 image_url part。 */
  imageParts: number
  /** 请求里 assistant 消息带 `reasoning_content` 的条数。 */
  reasoningEchoes: number
  /** 请求里带 toolCalls 的 assistant 消息条数（= 已经走到第几轮）。 */
  assistantTurns: number
  /** 发过来的工具名列表（本轮的）。 */
  toolsOffered: number
  stream?: unknown
}

export interface MockModelOptions {
  /** 要求的密钥。省略则只要是 Bearer 就放行。 */
  apiKey?: string
  /** 模型 id。 */
  model?: string
  /** 聊天里要走的工具序列；走完就输出收尾文本。 */
  plan?: Array<{ tools: Array<{ name: string; args: unknown }> }>
  finalText?: string
  /** 每张图折算多少 prompt token（用来验证图像记账）。 */
  imageTokens?: number
}

export interface MockModel {
  url: string
  requests: RecordedRequest[]
  /** 服务器上所有断言失败的原因（不该有）。 */
  violations: string[]
  close(): Promise<void>
  /** 走完整个规划后置真。 */
  readonly finished: boolean
}

const DEEPSEEK_PLAN = [
  { tools: [{ name: 'measure', args: {} }] },
  {
    tools: [
      {
        name: 'run_batch',
        args: {
          ops: [
            { tool: 'fill_box', args: { from: [0, 0, 0], to: [7, 0, 7], block: 'minecraft:oak_planks' } },
            {
              tool: 'extrude',
              args: {
                points: [[0, 0], [7, 0], [7, 7], [0, 7]],
                baseY: 1,
                height: 3,
                block: 'minecraft:spruce_planks',
                hollow: true,
                capTop: false,
                capBottom: false,
              },
            },
          ],
        },
      },
    ],
  },
  {
    tools: [
      { name: 'erase', args: { from: [3, 1, 0], to: [3, 2, 0], confirm: true } },
      { name: 'place_block', args: { pos: [3, 1, 0], block: 'minecraft:spruce_door[facing=south,half=lower]' } },
      { name: 'place_block', args: { pos: [3, 2, 0], block: 'minecraft:spruce_door[facing=south,half=upper]' } },
    ],
  },
  {
    tools: [
      {
        name: 'verify',
        args: {
          claims: [
            { check: 'block_at', pos: [3, 1, 0], expect: 'minecraft:spruce_door' },
            { check: 'count', block: 'minecraft:oak_planks', min: 50 },
          ],
        },
      },
    ],
  },
  { tools: [{ name: 'screenshot', args: { view: 'iso_ne', width: 320, height: 240 } }] },
]

export async function startMockModel(options: MockModelOptions = {}): Promise<MockModel> {
  const plan = options.plan ?? DEEPSEEK_PLAN
  const model = options.model ?? 'mock-v4.1-flash'
  const imageTokens = options.imageTokens ?? 349
  const requests: RecordedRequest[] = []
  const violations: string[] = []
  let finished = false
  /**
   * 剧本走到第几步。**只数"真正的 agent 轮次"**，不数探针请求。
   *
   * 两个都不能拿来当计数器：
   * - 请求里的 `assistantTurns`：无前缀缓存的 provider 下循环会裁历史
   *   （plan §9.2 Regime B），那个数字到 K 就不涨了，剧本会卡在同一步上；
   * - 无脑数 chat 请求：能力探针也会发 chat，会把剧本提前消耗掉。
   *
   * 判据是**请求里带的工具集是不是真工具**：探针只带 `report_ready` 一个。
   */
  let agentTurns = 0

  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8')
      const body = raw.length > 0 ? (JSON.parse(raw) as ChatBody) : undefined
      const send = (status: number, payload: unknown): void => {
        res.writeHead(status, { 'content-type': 'application/json' })
        res.end(JSON.stringify(payload))
      }

      const authorized = typeof req.headers.authorization === 'string' && req.headers.authorization.startsWith('Bearer ')
      if (options.apiKey !== undefined && req.headers.authorization !== `Bearer ${options.apiKey}`) {
        send(401, { error: { message: 'invalid api key' } })
        return
      }

      if (req.url?.endsWith('/models')) {
        requests.push({ url: req.url, authorized, imageParts: 0, reasoningEchoes: 0, assistantTurns: 0, toolsOffered: 0 })
        send(200, { data: [{ id: model, owned_by: 'mock', context_length: 131072 }] })
        return
      }
      if (!req.url?.endsWith('/chat/completions') || body === undefined) {
        send(404, { error: { message: 'not found' } })
        return
      }

      const tools = Array.isArray(body.tools) ? (body.tools as Array<{ function?: { name?: string } }>) : []
      const isProbe = tools.length > 0 && tools.every((tool) => tool.function?.name === 'report_ready')
      const turnIndex = agentTurns
      if (!isProbe && tools.length > 0) agentTurns++
      const messages = body.messages ?? []
      const images = messages.reduce((sum, message) => {
        if (!Array.isArray(message.content)) return sum
        return sum + (message.content as Array<{ type?: string }>).filter((part) => part.type === 'image_url').length
      }, 0)
      const reasoningEchoes = messages.filter(
        (message) => message.role === 'assistant' && typeof message.reasoning_content === 'string',
      ).length
      const assistantTurns = messages.filter((message) => message.role === 'assistant').length

      requests.push({
        url: req.url,
        authorized,
        ...(body.max_tokens !== undefined
          ? { maxTokensField: 'max_tokens', maxTokensValue: body.max_tokens }
          : {}),
        ...(body.max_completion_tokens !== undefined
          ? { maxTokensField: 'max_completion_tokens', maxTokensValue: body.max_completion_tokens }
          : {}),
        imageParts: images,
        reasoningEchoes,
        assistantTurns,
        toolsOffered: (body.tools ?? []).length,
        stream: body.stream,
      })

      // ── 刻意为难①：只认 max_completion_tokens ──────────────────────────────
      //
      // **不发这个字段是合法的**，而且是现在的默认：官方口径是"未设置时非思考模式
      // 默认 8K、思考模式默认 64K"，harness 不抢这个决定权（D-37）。所以这里
      // 只在"发了 max_tokens"时刁难，另外禁止两个字段同时出现。
      if (body.max_tokens !== undefined) {
        send(400, {
          error: {
            message:
              "Unsupported parameter: 'max_tokens' is not supported with this model. Use 'max_completion_tokens' instead.",
          },
        })
        return
      }
      if (body.max_completion_tokens !== undefined && body.max_tokens !== undefined) {
        violations.push('max_tokens 与 max_completion_tokens 同时出现')
      }

      // ── 刻意为难②：回传的 assistant 消息必须带 reasoning_content ───────────
      // DeepSeek 的推理模型就是这个行为：少了直接 400
      const expectsReasoning = messages.some(
        (message) => message.role === 'assistant' && typeof message.reasoning_content !== 'string',
      )
      if (expectsReasoning) {
        send(400, { error: { message: "Missing 'reasoning_content' on assistant messages (mock requires the echo)" } })
        return
      }

      if (typeof body.stream !== 'boolean' || body.stream) {
        violations.push(`stream 应当是 false，收到 ${String(body.stream)}`)
      }
      if (body.tools !== undefined && (body.tools as unknown[]).length === 0) {
        violations.push('tools 是空数组；要么别发，要么发工具')
      }

      const promptTokens = 30 + images * imageTokens + assistantTurns * 40

      const step = plan[turnIndex]
      if (step === undefined) {
        finished = true
        // 收尾：没有工具调用 + 一段文本。**文本要放进 content**，
        // 放进 reasoning_content 的话循环拿到的 finalText 就是空的。
        send(200, completion(options.finalText ?? '小屋建好了：云杉墙、橡木地板、南面一扇门。', [], promptTokens))
        return
      }
      send(
        200,
        completion(
          turnIndex === 0 ? '先量一下尺度，再铺地板、起墙。' : '',
          step.tools.map((tool, index) => ({
            id: `call_${assistantTurns}_${index}`,
            type: 'function',
            function: { name: tool.name, arguments: JSON.stringify(tool.args) },
          })),
          promptTokens,
        ),
      )
    })
  })

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('mock server 没有拿到端口')

  return {
    url: `http://127.0.0.1:${address.port}`,
    requests,
    violations,
    get finished() {
      return finished
    },
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error != null ? reject(error) : resolve()))
      }),
  }
}

interface ChatBody {
  max_tokens?: number
  max_completion_tokens?: number
  stream?: unknown
  tools?: unknown[]
  messages?: Array<{ role?: string; content?: unknown; reasoning_content?: string }>
}

/** 每次都带 `reasoning_content`——推理模型的正常形态，也是适配层必须回传的东西。 */
function completion(
  content: string,
  toolCalls: Array<{ id: string; type: string; function: { name: string; arguments: string } }>,
  promptTokens: number,
  reasoning = '先看尺度，再按阶段建。',
): unknown {
  return {
    id: 'chatcmpl-mock',
    object: 'chat.completion',
    model: 'mock',
    choices: [
      {
        index: 0,
        message: {
          role: 'assistant',
          content: content.length > 0 ? content : null,
          reasoning_content: reasoning,
          ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
        },
        finish_reason: toolCalls.length > 0 ? 'tool_calls' : 'stop',
      },
    ],
    usage: {
      prompt_tokens: promptTokens,
      completion_tokens: content.length + toolCalls.length * 20 + 5,
      prompt_cache_hit_tokens: Math.floor(promptTokens / 2),
    },
  }
}
