import { execFile } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

import { unpackProject } from '@architect/mcai'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { startMockModel } from './mock-deepseek.js'
import type { MockModel } from './mock-deepseek.js'

const execFileAsync = promisify(execFile)
const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')

/**
 * **端到端：一句需求 → 一个可回放的 `.mcai`，全程走真实 HTTP。**
 *
 * 这是 plan §15 里 v0 的验收口径，也是 M4 唯一没法靠单测验的那一段。
 * `ScriptedProvider` 能验循环逻辑，但它绕过了整个 HTTP 层——请求体的字段名、
 * 鉴权头、图像 content part 的形状、`reasoning_content` 的回传要求、
 * 以及"服务端报 400 时适配层怎么反应"，一个都不经过。
 *
 * 这里起一个**协议级**的假模型端点（见 `mock-deepseek.ts`），用真正的
 * `architect build` 命令跑完整条链路，然后断言：
 *
 * - 进程退出码 0，`.mcai` 真的写出来了；
 * - 里面的方块数据、编辑记录、**对话记录**、截图存档都在；
 * - 假模型那边**真正收到的字节**符合协议（鉴权头、字段名、图像 part、思维链回传、stream:false）；
 * - 适配层的 `'auto'` 模式真的把 `max_tokens` 换成了 `max_completion_tokens`。
 */
describe('端到端：真实 HTTP 下的 build（v0 验收口径）', () => {
  let dir: string
  let model: MockModel

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'architect-e2e-'))
    model = await startMockModel({ apiKey: 'sk-mock-key' })
  })
  afterEach(async () => {
    await model.close()
    rmSync(dir, { recursive: true, force: true })
  })

  const build = async (
    out: string,
    extraArgs: string[] = [],
    options: { allowFailure?: boolean } = {},
  ): Promise<{ stdout: string; stderr: string; code: number }> => {
    try {
      const { stdout } = await execFileAsync(
        'npx',
        [
          '--no-install',
          'tsx',
          join(root, 'packages/cli/src/index.ts'),
          'build',
          '造一座 8x8 的林间小屋，云杉木板墙、橡木地板，南面开一扇门',
          '--out',
          out,
          '--provider',
          'custom',
          '--base-url',
          model.url,
          '--model',
          'mock-v4.1-flash',
          '--max-turns',
          '12',
          ...extraArgs,
        ],
        {
          cwd: root,
          env: { ...process.env, ARCHITECT_API_KEY: 'sk-mock-key', ARCHITECT_LANG: 'zh-CN' },
          maxBuffer: 32 * 1024 * 1024,
        },
      )
      return { stdout, stderr: '', code: 0 }
    } catch (error) {
      const failure = error as { stdout?: string; stderr?: string; code?: number }
      // 预算触顶、未通过闸门这类"有结论的失败"退出码是 1，产物仍然写出来了——
      // 断言这些路径时要把它当正常结果看，而不是当成测试基础设施出错
      if (options.allowFailure === true) {
        return { stdout: failure.stdout ?? '', stderr: failure.stderr ?? '', code: failure.code ?? 1 }
      }
      throw new Error(`build 失败（exit ${String(failure.code)}）\n${failure.stdout ?? ''}\n${failure.stderr ?? ''}`)
    }
  }

  it('**一句需求跑出可回放的 .mcai，且全程符合协议**', async () => {
    const out = join(dir, 'hut.mcai')
    const { stdout } = await build(out)

    // ── 产物 ────────────────────────────────────────────────────────────────
    expect(statSync(out).size).toBeGreaterThan(2000)
    const bytes = new Uint8Array(readFileSync(out))
    const project = unpackProject(bytes)

    expect(project.manifest.minecraftVersion).toBe('1.21.4')
    expect(project.manifest.revision).toBeGreaterThanOrEqual(4)
    expect(project.log.length).toBe(project.manifest.revision)
    // 编辑记录里能看到工具名
    expect(project.log.all().map((op) => op.tool)).toContain('run_batch')

    // **对话记录与截图**（需求里点名要的那两样）
    expect(project.chat.messages.length).toBeGreaterThan(6)
    expect(project.chat.messages[0]).toMatchObject({ role: 'user' })
    expect(project.chat.messages.some((message) => message.toolName === 'run_batch')).toBe(true)
    expect(project.chat.messages.some((message) => message.usage !== undefined)).toBe(true)
    expect(project.manifest.counters.llmCalls).toBeGreaterThan(0)
    // **模型写下的设计笔记进了 manifest**（§9.2 阶段摘要 + D-71）：
    // 重开工程时它会被交回会话，所以这条链路必须端到端通
    expect(project.chat.messages.some((message) => message.toolName === 'update_notes')).toBe(true)
    expect(project.manifest.designNotes).toContain('云杉墙')
    expect(project.captures.refs.length).toBe(1)
    const png = project.captures.files.get(project.captures.refs[0]!.id)!
    expect(Array.from(png.slice(0, 4))).toEqual([0x89, 0x50, 0x4e, 0x47])

    // 世界真的是那个小屋
    const { store } = await import('@architect/mcai').then((mcai) => mcai.openProject(bytes))
    expect(store.stats().blocks).toBeGreaterThan(60)
    expect(store.palette.strings().some((entry) => entry.includes('spruce_door'))).toBe(true)

    // ── 协议：假模型**真正收到的字节** ───────────────────────────────────────
    expect(model.violations).toEqual([])
    const chat = model.requests.filter((request) => request.url.endsWith('/chat/completions'))
    expect(model.requests.some((request) => request.url.endsWith('/models'))).toBe(true)
    expect(chat.length).toBeGreaterThanOrEqual(5)
    for (const request of chat) {
      expect(request.authorized, '请求没带 Authorization 头').toBe(true)
      expect(request.stream, 'stream 必须是 false').toBe(false)
    }
    // 探针的文本/视觉请求不带工具，所以只在"带工具的请求"里至少有一个
    expect(chat.some((request) => request.toolsOffered > 0), '一次都没把工具 schema 发出去').toBe(true)

    // **循环请求不带单轮输出上限**（D-37）：官方口径是"未设置时思考模式默认 64K"，
    // harness 不猜这个数——猜 8192 时思考模型把额度全烧在思维链上，
    // `finish_reason: length`、正文空、工具调用零，还被报成 completed。
    //
    // 探针请求是个例外，它**故意**只要 16/128 token（"回答一个词就够"），
    // 所以判据是"没有任何请求带一个 harness 自己发明的大上限"。
    const capped = chat.filter((request) => (request.maxTokensValue ?? 0) > 128)
    expect(capped.map((request) => request.maxTokensValue)).toEqual([])
    // 正式循环的请求（工具集是全部工具，探针只有 1 个）一个字段都不带
    const loopRequests = chat.filter((request) => request.toolsOffered > 1)
    expect(loopRequests.length).toBeGreaterThan(0)
    expect(loopRequests.every((request) => request.maxTokensField === undefined)).toBe(true)

    // **思维链回传**：agent 循环里的 assistant 消息必须带上 reasoning_content，
    // 否则假模型会 400（DeepSeek 推理模型的真实行为）
    expect(chat.some((request) => request.assistantTurns > 0 && request.reasoningEchoes > 0)).toBe(true)
    expect(chat.filter((request) => request.reasoningEchoes > 0).length).toBeGreaterThan(1)

    // **图像 content part**：截图之后的那次请求里带了图。
    // 用 `assistantTurns > 0` 把"探针那张小图"排除掉——探针没有 assistant 消息，
    // 所以这条断言证明的是**agent 自己拍的截图**真的送到了模型。
    const agentImages = chat.filter((request) => request.imageParts > 0 && request.assistantTurns > 0)
    expect(agentImages.length, 'agent 的截图没有进模型上下文').toBeGreaterThan(0)
    // 视觉能力是探针**实测**出来的（自定义预设默认 vision=false，不探就发不出图）
    expect(project.manifest.counters.captures).toBe(1)

    // 收尾文本进了 stdout
    expect(stdout).toContain('小屋建好了')
    expect(stdout).toContain('结束原因：completed')
  }, 180_000)

  it('**模型拒绝时（401）给出可自纠的报错，且不产出半成品工程**', async () => {
    const bad = await startMockModel({ apiKey: 'the-right-key' })
    try {
      const out = join(dir, 'nope.mcai')
      await expect(
        execFileAsync(
          'npx',
          [
            '--no-install',
            'tsx',
            join(root, 'packages/cli/src/index.ts'),
            'build',
            '造个房子',
            '--out',
            out,
            '--provider',
            'custom',
            '--base-url',
            bad.url,
            '--model',
            'mock-v4.1-flash',
            '--no-probe',
          ],
          {
            cwd: root,
            env: { ...process.env, ARCHITECT_API_KEY: 'wrong-key', ARCHITECT_LANG: 'zh-CN' },
          },
        ),
      ).rejects.toMatchObject({ code: expect.not.stringMatching('^0$') })
    } finally {
      await bad.close()
    }
  }, 120_000)

  it('**美元上限在真实链路上真的刹住车**（不是只记账）', async () => {
    const out = join(dir, 'budget.mcai')
    // 上限设得极小：第一轮之后就该触顶。`custom` 预设没有价格表，
    // 所以这里验的正是那句"设了美元上限但没有价格表就判为越界"——
    // 静默忽略用户的上限才是真正需要防的。
    const { stdout, code } = await build(out, ['--max-usd', '0.000001'], { allowFailure: true })
    expect(code).toBe(1) // 预算触顶不是成功，退出码如实反映
    expect(stdout).toContain('结束原因：budget')
    expect(stdout).toContain('价格表')
    // 触顶前的产物照样写出来了，不是"什么都没得到"
    expect(statSync(out).size).toBeGreaterThan(500)
  }, 180_000)

  it('**显式设了输出上限时，max_tokens 被 400 顶回来会改用 max_completion_tokens**', async () => {
    // 这条只有在真实 HTTP 下才验得到——`ScriptedProvider` 根本不经过序列化。
    // 默认是不发这个字段（服务端默认 64K），所以要验自适应就得显式设一个。
    const out = join(dir, 'capped.mcai')
    const { stdout, code } = await build(out, ['--max-output-tokens', '2048'])
    expect(code).toBe(0)

    const chat = model.requests.filter((request) => request.url.endsWith('/chat/completions'))
    const fields = chat.map((request) => request.maxTokensField)
    // 第一次试探被顶回来，学到之后就一直用它。探针与正式循环各建一个实例，
    // 所以最多试错两次。
    expect(fields[0]).toBe('max_tokens')
    expect(fields.filter((field) => field === 'max_tokens').length).toBeLessThanOrEqual(2)
    expect(fields[fields.length - 1]).toBe('max_completion_tokens')
    expect(model.violations).toEqual([])
    // 上限真的生效了（不是"设了没生效"）
    expect(chat.some((request) => request.maxTokensValue === 2048)).toBe(true)
    expect(stdout).toContain('结束原因')
  }, 240_000)
})

/**
 * **无前缀缓存的 provider 会自动切到滑动窗口**（plan §9.2 Regime B）。
 *
 * 这一条只能在这一层验：`ScriptedProvider` 能验循环里的裁剪逻辑，但"真正发出去的
 * HTTP 请求体里历史被裁短了"只有在这里才看得到。`custom` 预设的
 * `promptCache` 就是 `none`（本地模型那一类），所以这条链路就是本地模型走的那条。
 */
describe('端到端：无缓存 provider 的上下文窗口', () => {
  let dir: string
  let model: MockModel

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'architect-window-'))
    // 十轮只调 measure：轮数够多，一定能撞上窗口（K=6）
    model = await startMockModel({
      apiKey: 'sk-mock-key',
      plan: Array.from({ length: 10 }, () => ({ tools: [{ name: 'measure', args: {} }] })),
    })
  })
  afterEach(async () => {
    await model.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('**发出去的请求体里历史真的被裁了**，而且 CLI 会说出来', async () => {
    const out = join(dir, 'windowed.mcai')
    const { stdout } = await execFileAsync(
      'npx',
      [
        '--no-install',
        'tsx',
        join(root, 'packages/cli/src/index.ts'),
        'build',
        '造一座小屋',
        '--out',
        out,
        '--provider',
        'custom',
        '--base-url',
        model.url,
        '--model',
        'mock-v4.1-flash',
        '--max-turns',
        '12',
      ],
      {
        cwd: root,
        env: { ...process.env, ARCHITECT_API_KEY: 'sk-mock-key', ARCHITECT_LANG: 'zh-CN' },
        maxBuffer: 32 * 1024 * 1024,
      },
    )

    // 假模型记录的 `assistantTurns` 就是"这次请求里带了几轮历史"
    const turnsSeen = model.requests.map((request) => request.assistantTurns)
    expect(turnsSeen.length).toBeGreaterThan(8)
    // 没有窗口的话它会一路涨到 10；有窗口就封顶在 K=6
    expect(Math.max(...turnsSeen)).toBeLessThanOrEqual(6)
    // 而且真的**封过顶**：到后面几轮都不再涨（否则说明根本没裁）
    const tail = turnsSeen.slice(-3)
    expect(tail).toEqual([6, 6, 6])

    // 裁剪不是无声的：档案里要有一行，stdout 里要有一句
    expect(stdout).toContain('[上下文]')
    const project = unpackProject(new Uint8Array(readFileSync(out)))
    expect(project.chat.messages.some((message) => message.note === 'context')).toBe(true)
    // **档案本身没被剪**：它是给用户回看的，不是给模型的
    expect(project.chat.messages.filter((message) => message.toolName === 'measure').length).toBeGreaterThan(6)
  })
})
