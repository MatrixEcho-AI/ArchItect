import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { LlmError, ScriptedProvider, scriptFromCalls } from '@architect/agent'
import type {
  AgentEvent,
  LlmProvider,
  LlmRequest,
  ProviderConfig,
  ProviderSettings,
  ScriptedStep,
} from '@architect/agent'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { ChatController } from '../src/main/services/chat.js'
import type { ChatView } from '../src/main/services/chat.js'
import type { Cipher, SecretStore } from '../src/main/services/settings.js'
import {
  createMemorySecretStore,
  createSecretStore,
  loadSettings,
  saveSettings,
} from '../src/main/services/settings.js'
import { StudioService } from '../src/main/services/studio.js'

let workspace: string
beforeAll(async () => {
  workspace = await mkdtemp(join(tmpdir(), 'architect-chat-'))
})
afterAll(async () => {
  await rm(workspace, { recursive: true, force: true })
})

/** 可预测的"加密"：翻转每个字节。真实实现走系统钥匙串，这里只要证明流程对。 */
const flipCipher: Cipher = {
  available: () => true,
  encrypt: (plaintext) => Buffer.from(Uint8Array.from(Buffer.from(plaintext, 'utf8'), (b) => b ^ 0xff)),
  decrypt: (ciphertext) => Buffer.from(Uint8Array.from(ciphertext, (b) => b ^ 0xff)).toString('utf8'),
}

const noCipher: Cipher = {
  available: () => false,
  encrypt: () => {
    throw new Error('不该被调用')
  },
  decrypt: () => {
    throw new Error('不该被调用')
  },
}

const deepseekWithKey = (): ProviderSettings => ({
  version: 1,
  activeId: 'DeepSeek',
  providers: [
    {
      id: 'DeepSeek',
      preset: 'deepseek',
      kind: 'openai-compatible',
      baseURL: 'https://api.deepseek.com',
      apiKeyRef: 'safe:DeepSeek',
      model: 'deepseek-v4.1-flash',
      capabilities: { vision: true, toolCalling: 'native', promptCache: 'auto', source: 'probe' },
      cost: { inPerMTok: 0.14, outPerMTok: 0.28, cacheReadPerMTok: 0.0028 },
    },
  ],
  locale: 'zh-CN',
  ui: { view: 'iso_ne', requireVerification: true },
})

/** 建一个带剧本 provider 的 ChatController，并把事件收集起来。 */
function makeChat(options: {
  settings?: ProviderSettings
  secrets?: SecretStore
  script: readonly ScriptedStep[]
  onWorldWrite?: (service: StudioService) => void
}): {
  service: StudioService
  chat: ChatController
  events: AgentEvent[]
  studioEvents: string[]
  settle: () => Promise<void>
} {
  const secrets = options.secrets ?? createMemorySecretStore()
  secrets.set('DeepSeek', 'sk-test-key')
  const service = new StudioService({ plain: true, chat: { settings: options.settings ?? deepseekWithKey(), secrets } })
  const events: AgentEvent[] = []
  const studioEvents: string[] = []

  // 用带剧本的 provider 替掉真实网络调用；同时把事件抄一份给测试断言
  const provider = new ScriptedProvider(options.script, { model: 'scripted-v1' })

  // providerFactory 是构造参数，所以这里自建一个 controller 而不是用 StudioService 里那个；
  // runner 直接复用 StudioService 的 session，保证"世界"是同一个
  const controller = new ChatController(
    { settings: options.settings ?? deepseekWithKey(), secrets, providerFactory: () => provider },
    async (goal, _provider, onEvent, shouldStop) => {
      const { runAgent } = await import('@architect/agent')
      const state = await runAgent(
        {
          provider,
          registry: service.agentSession.registry,
          ctx: service.agentSession.ctx,
          system: service.agentSession.buildSystem(),
          stateLine: service.agentSession.buildStateLine(),
          onEvent: (event) => {
            events.push(event)
            onEvent(event)
          },
          shouldStop,
        },
        goal,
      )
      options.onWorldWrite?.(service)
      return {
        stopReason: state.stopReason,
        ...(state.error !== undefined ? { error: state.error } : {}),
        usage: state.usage,
      }
    },
  )
  controller.onEvent((event) => studioEvents.push(event.type))
  return {
    service,
    chat: controller,
    events,
    studioEvents,
    // 循环是异步跑起来的；等 running 落回 false
    settle: async () => {
      for (let i = 0; i < 200 && controller.chatView().running; i++) {
        await new Promise((resolve) => setTimeout(resolve, 10))
      }
    },
  }
}

describe('设置文件持久化', () => {
  it('文件不存在时给默认设置并标 fresh', () => {
    const loaded = loadSettings(join(workspace, 'nope', 'settings.json'))
    expect(loaded.fresh).toBe(true)
    expect(loaded.settings.providers[0]?.preset).toBe('deepseek')
  })

  it('往返保持 provider 与预算', () => {
    const file = join(workspace, 'round', 'settings.json')
    const settings = deepseekWithKey()
    settings.budget = { maxUsd: 3, maxTurns: 25 }
    saveSettings(file, settings)
    const loaded = loadSettings(file)
    expect(loaded.fresh).toBe(false)
    expect(loaded.settings.activeId).toBe('DeepSeek')
    expect(loaded.settings.budget).toEqual({ maxUsd: 3, maxTurns: 25 })
  })

  it('**json 语法坏掉时退回默认值，但不覆盖用户的文件**', async () => {
    const file = join(workspace, 'broken', 'settings.json')
    await writeFile(file, '{ 这不是 json', 'utf8').catch(async () => {
      const { mkdir } = await import('node:fs/promises')
      await mkdir(join(workspace, 'broken'), { recursive: true })
      await writeFile(file, '{ 这不是 json', 'utf8')
    })
    const loaded = loadSettings(file)
    expect(loaded.settings.providers.length).toBeGreaterThan(0)
    expect(loaded.issues.length).toBe(1)
    // 原文件还在，用户能手工抢救
    expect(await readFile(file, 'utf8')).toBe('{ 这不是 json')
  })
})

describe('密钥存储（D-13）', () => {
  it('有加密能力时能往返，且**磁盘上不是明文**', async () => {
    const file = join(workspace, 'secrets.json')
    const store = createSecretStore(file, flipCipher)
    expect(store.set('DeepSeek', 'sk-super-secret')).toBe(true)
    expect(store.get('DeepSeek')).toBe('sk-super-secret')
    expect(store.has('DeepSeek')).toBe(true)
    const onDisk = await readFile(file, 'utf8')
    expect(onDisk).not.toContain('sk-super-secret')
    store.remove('DeepSeek')
    expect(store.get('DeepSeek')).toBeUndefined()
  })

  it('**没有加密能力时拒绝落盘**，而不是退回明文', async () => {
    const file = join(workspace, 'plaintext.json')
    const store = createSecretStore(file, noCipher)
    expect(store.encrypted).toBe(false)
    expect(store.set('DeepSeek', 'sk-super-secret')).toBe(false)
    expect(store.get('DeepSeek')).toBeUndefined()
    await expect(readFile(file, 'utf8')).rejects.toThrow()
  })

  it('解不开的密文当作没有（换机器/换钥匙串是正常情况）', async () => {
    const file = join(workspace, 'stale.json')
    const writer = createSecretStore(file, flipCipher)
    writer.set('DeepSeek', 'sk-x')
    const other: Cipher = {
      available: () => true,
      encrypt: () => Buffer.from('zz'),
      decrypt: () => {
        throw new Error('bad key')
      },
    }
    expect(createSecretStore(file, other).get('DeepSeek')).toBeUndefined()
  })
})

describe('ChatController：配置门禁', () => {
  it('没配置好时 chatView 给出**具体**缺什么，而不是等报错', () => {
    const secrets = createMemorySecretStore()
    const settings = deepseekWithKey()
    settings.providers[0]!.model = ''
    const controller = new ChatController({ settings, secrets }, async () => ({
      stopReason: 'completed',
      usage: { in: 0, out: 0 },
    }))
    const view = controller.chatView()
    expect(view.ready).toBe(false)
    expect(view.blocking.join(' ')).toContain('模型')
  })

  it('缺密钥时明确说清是哪个环境变量', () => {
    const settings = deepseekWithKey()
    settings.providers[0]!.apiKeyRef = 'env:ARCHITECT_API_KEY_NOPE'
    const controller = new ChatController({ settings, secrets: createMemorySecretStore() }, async () => ({
      stopReason: 'completed',
      usage: { in: 0, out: 0 },
    }))
    const view = controller.chatView()
    expect(view.ready).toBe(false)
    expect(view.blocking.join(' ')).toContain('ARCHITECT_API_KEY_NOPE')
  })

  it('配置齐备时 ready=true 且没有 blocking', () => {
    const { chat } = makeChat({ script: [] })
    expect(chat.chatView().ready).toBe(true)
    expect(chat.chatView().blocking).toEqual([])
  })

  it('send 在没配置好时直接抛错，不静默什么都不做', () => {
    const settings = deepseekWithKey()
    settings.providers[0]!.baseURL = ''
    const controller = new ChatController({ settings, secrets: createMemorySecretStore() }, async () => ({
      stopReason: 'completed',
      usage: { in: 0, out: 0 },
    }))
    expect(() => controller.send('设计一座灯塔')).toThrow()
  })
})

describe('ChatController：跑一轮', () => {
  it('把用户消息、工具调用、助手回复都变成界面能画的消息', async () => {
    const { chat, events, settle } = makeChat({
      script: [
        { toolCalls: [{ name: 'fill_box', args: { from: [0, 0, 0], to: [3, 0, 3], block: 'minecraft:stone' } }] },
        {
          toolCalls: [
            {
              name: 'verify',
              args: { claims: [{ check: 'block_at', pos: [0, 0, 0], expect: 'minecraft:stone' }] },
            },
          ],
        },
        { text: '做好了：4x4 的石地板。' },
      ],
    })

    chat.send('铺一层 4x4 石地板')
    await settle()

    const messages = chat.chatView().messages
    expect(messages[0]).toMatchObject({ role: 'user', text: '铺一层 4x4 石地板' })
    const toolNames = messages.filter((m) => m.role === 'tool').map((m) => m.toolName)
    expect(toolNames).toEqual(['fill_box', 'verify'])
    expect(messages.at(-1)).toMatchObject({ role: 'assistant' })
    expect(messages.at(-1)?.text).toContain('4x4')
    expect(chat.chatView().running).toBe(false)
    expect(events.some((e) => e.type === 'stop')).toBe(true)
  })

  it('工具失败的条目带 toolOk=false，界面据此标红', async () => {
    const { chat, settle } = makeChat({
      script: [
        { toolCalls: [{ name: 'place_block', args: { pos: [0, 0, 0], block: 'minecraft:not_a_block' } }] },
        { text: '换个名字。' },
      ],
    })
    chat.send('放一个不存在的方块')
    await settle()
    const failed = chat.chatView().messages.find((m) => m.role === 'tool')
    expect(failed?.toolOk).toBe(false)
    expect(failed?.text.length).toBeGreaterThan(0)
  })

  it('截图按内容寻址存下来，界面只拿到一个 id', async () => {
    const { chat, settle } = makeChat({
      script: [
        { toolCalls: [{ name: 'fill_box', args: { from: [0, 0, 0], to: [3, 0, 3], block: 'minecraft:stone' } }] },
        { toolCalls: [{ name: 'screenshot', args: { view: 'iso_ne', width: 160, height: 120 } }] },
        {
          toolCalls: [
            {
              name: 'verify',
              args: { claims: [{ check: 'block_at', pos: [0, 0, 0], expect: 'minecraft:stone' }] },
            },
          ],
        },
        { text: '看过了。' },
      ],
    })
    chat.send('拍一张看看')
    await settle()

    const withImage = chat.chatView().messages.find((m) => m.imageId !== undefined)
    expect(withImage).toBeDefined()
    expect(withImage?.imageView).toBe('iso_ne')
    const png = chat.capture(withImage!.imageId!)
    expect(png).toBeDefined()
    // 真的是一张 PNG（magic number），不是别的什么
    expect(Array.from(png!.slice(0, 4))).toEqual([0x89, 0x50, 0x4e, 0x47])
    // 第二次拍同一机位同一版本 → 内容寻址，只存一份
    expect(chat.captureCount).toBe(1)
  })

  it('用量与成本在跑完后累计起来', async () => {
    const { chat, settle } = makeChat({
      script: [{ text: '先说说思路。' }],
    })
    chat.send('随便聊聊')
    await settle()
    const usage = chat.chatView().usage
    expect(usage.turns).toBe(1)
    expect(usage.in).toBeGreaterThan(0)
    // 预设里带了 DeepSeek 的单价，所以应该有金额
    expect(chat.chatView().costUsd).toBeGreaterThan(0)
  })

  it('stop() 之后循环停下来并如实报告原因', async () => {
    let running = true
    const secrets = createMemorySecretStore()
    secrets.set('DeepSeek', 'sk-x')
    const controller = new ChatController(
      { settings: deepseekWithKey(), secrets, providerFactory: () => new ScriptedProvider([{ text: 'x' }]) },
      async (_goal, _provider, _onEvent, shouldStop) => {
        // 模拟一个长循环：一直转到 shouldStop 变真
        for (let i = 0; i < 500; i++) {
          if (shouldStop()) {
            running = false
            return { stopReason: 'stopped', usage: { in: 1, out: 1 } }
          }
          await new Promise((resolve) => setTimeout(resolve, 1))
        }
        running = false
        return { stopReason: 'max_turns', usage: { in: 1, out: 1 } }
      },
    )
    controller.send('开始')
    await new Promise((resolve) => setTimeout(resolve, 20))
    controller.stop()
    for (let i = 0; i < 200 && controller.chatView().running; i++) {
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    expect(running).toBe(false)
    expect(controller.chatView().stopReason).toBe('stopped')
  })

  it('clear() 把消息与用量都清掉', async () => {
    const { chat, settle } = makeChat({ script: [{ text: '你好。' }] })
    chat.send('你好')
    await settle()
    expect(chat.chatView().messages.length).toBeGreaterThan(0)
    const cleared = chat.clear()
    expect(cleared.messages).toEqual([])
    expect(cleared.usage.in).toBe(0)
    expect(cleared.usage.turns).toBe(0)
    // 有价格表时零用量就是 $0，不是"未知"
    expect(cleared.costUsd).toBe(0)
  })
})

describe('ChatController：设置的增删改', () => {
  it('saveProvider 带明文密钥 → 存进密钥库，引用变 safe:<id>', () => {
    const secrets = createMemorySecretStore()
    const controller = new ChatController({ settings: deepseekWithKey(), secrets }, async () => ({
      stopReason: 'completed',
      usage: { in: 0, out: 0 },
    }))
    const config: ProviderConfig = {
      ...deepseekWithKey().providers[0]!,
      apiKeyRef: '',
    }
    const view = controller.saveProvider(config, 'sk-brand-new')
    const saved = view.providers.find((p) => p.id === 'DeepSeek')
    expect(saved?.apiKeyRef).toBe('safe:DeepSeek')
    expect(saved?.hasKey).toBe(true)
    expect(secrets.get('DeepSeek')).toBe('sk-brand-new')
    // 视图里**永远不出现**密钥本身
    expect(JSON.stringify(view)).not.toContain('sk-brand-new')
  })

  it('没有加密能力时如实报错并提示改用环境变量，不悄悄存明文', () => {
    const secrets = createSecretStore(join(workspace, 'cannot.json'), noCipher)
    const controller = new ChatController({ settings: deepseekWithKey(), secrets }, async () => ({
      stopReason: 'completed',
      usage: { in: 0, out: 0 },
    }))
    const view = controller.saveProvider({ ...deepseekWithKey().providers[0]!, apiKeyRef: '' }, 'sk-nope')
    expect(view.issues.some((i) => i.message.includes('钥匙串不可用'))).toBe(true)
    expect(view.providers.find((p) => p.id === 'DeepSeek')?.apiKeyRef).toBe('')
  })

  it('hasKey 对环境变量引用看进程环境，对 safe: 看密钥库', () => {
    const secrets = createMemorySecretStore()
    const settings = deepseekWithKey()
    settings.providers.push({
      id: '本地',
      preset: 'ollama',
      kind: 'openai-compatible',
      baseURL: 'http://localhost:11434/v1',
      apiKeyRef: '',
      model: 'qwen2.5-vl',
      capabilities: { vision: false, toolCalling: 'native', promptCache: 'none', source: 'preset' },
    })
    secrets.set('DeepSeek', 'sk-x')
    const controller = new ChatController({ settings, secrets }, async () => ({
      stopReason: 'completed',
      usage: { in: 0, out: 0 },
    }))
    const view = controller.settingsView()
    expect(view.providers.find((p) => p.id === 'DeepSeek')?.hasKey).toBe(true)
    // 本地 provider 不需要密钥 → 视为已就绪
    expect(view.providers.find((p) => p.id === '本地')?.hasKey).toBe(true)
  })

  it('addProvider 按四项预设之一加实例，并把它设为当前', () => {
    const controller = new ChatController({ settings: deepseekWithKey(), secrets: createMemorySecretStore() }, async () => ({
      stopReason: 'completed',
      usage: { in: 0, out: 0 },
    }))
    const view = controller.addProvider('ollama')
    expect(view.providers).toHaveLength(2)
    expect(view.providers.find((p) => p.id === view.activeId)?.preset).toBe('ollama')
  })

  it('removeProvider 连带清掉密钥库里的条目', () => {
    const secrets = createMemorySecretStore()
    secrets.set('DeepSeek', 'sk-x')
    const controller = new ChatController({ settings: deepseekWithKey(), secrets }, async () => ({
      stopReason: 'completed',
      usage: { in: 0, out: 0 },
    }))
    const view = controller.removeProvider('DeepSeek')
    expect(view.providers).toHaveLength(0)
    expect(secrets.has('DeepSeek')).toBe(false)
  })

  it('每一条设置变更都会推事件给界面', () => {
    const controller = new ChatController({ settings: deepseekWithKey(), secrets: createMemorySecretStore() }, async () => ({
      stopReason: 'completed',
      usage: { in: 0, out: 0 },
    }))
    const seen: string[] = []
    controller.onEvent((event) => seen.push(event.type))
    controller.setLocale('en-US')
    controller.setBudget({ maxUsd: 1 })
    controller.setUi({ view: 'front' })
    expect(seen).toEqual(['settings', 'settings', 'settings'])
    expect(controller.settingsValue.locale).toBe('en-US')
  })
})

describe('StudioService：对话与世界是同一个会话', () => {
  it('LLM 通过工具改动的方块真的落在 StudioService 的世界里', async () => {
    const service = new StudioService({
      plain: true,
      chat: { settings: deepseekWithKey(), secrets: createMemorySecretStore() },
    })
    const events: string[] = []
    service.onEvent((event) => events.push(event.type))

    const provider = new ScriptedProvider(
      scriptFromCalls([
        ['fill_box', { from: [0, 0, 0], to: [3, 0, 3], block: 'minecraft:stone' }],
        ['verify', { claims: [{ check: 'block_at', pos: [3, 0, 3], expect: 'minecraft:stone' }] }],
      ]),
    )
    // 用反射替换 providerFactory 不方便，这里直接用 runner 之外的路：
    // ChatController 的 factory 在构造时给定，测试里换成可注入的
    const chat = service.chat
    const state = await (async () => {
      const { runAgent } = await import('@architect/agent')
      return runAgent(
        {
          provider,
          registry: service.agentSession.registry,
          ctx: service.agentSession.ctx,
          system: service.agentSession.buildSystem(),
          stateLine: service.agentSession.buildStateLine(),
        },
        '铺一层 4x4 石地板',
      )
    })()

    expect(state.stopReason).toBe('completed')
    expect(service.state().blocks).toBe(16)
    expect(service.state().totalOps).toBe(1)
    expect(service.state().ops[0]?.tool).toBe('fill_box')
    void chat
  })

  it('状态行进了历史（§9.2：volatile 状态不当 system 前缀）', async () => {
    const service = new StudioService({ plain: true })
    const provider = new ScriptedProvider([{ text: '好。' }])
    const { runAgent } = await import('@architect/agent')
    const state = await runAgent(
      {
        provider,
        registry: service.agentSession.registry,
        ctx: service.agentSession.ctx,
        system: service.agentSession.buildSystem(),
        stateLine: service.agentSession.buildStateLine(),
      },
      '设计一座灯塔',
    )
    const userMessages = state.messages.filter((m) => m.role === 'user')
    expect(userMessages[0]?.content).toContain('[STATE]')
    expect(userMessages[0]?.content).toContain('revision=0')
    expect(userMessages[1]?.content).toBe('设计一座灯塔')
    // system 里不许出现 revision（那会把前缀缓存打掉）
    expect(service.agentSession.buildSystem()).not.toContain('revision=')
  })
})

describe('对话记录会跟着工程一起保存（需求原话："含对话记录"）', () => {
  it('**GUI 保存的 .mcai 里有消息与截图**，而不只是方块', async () => {
    const { chat, settle } = makeChat({
      script: [
        { toolCalls: [{ name: 'fill_box', args: { from: [0, 0, 0], to: [3, 0, 3], block: 'minecraft:stone' } }] },
        { toolCalls: [{ name: 'screenshot', args: { view: 'iso_ne', width: 160, height: 120 } }] },
        {
          toolCalls: [
            { name: 'verify', args: { claims: [{ check: 'block_at', pos: [0, 0, 0], expect: 'minecraft:stone' }] } },
          ],
        },
        { text: '铺好了。' },
      ],
    })

    chat.send('铺一层石地板然后拍张照')
    await settle()

    // 录制器里应当有完整的过程
    const recording = chat.recording()
    expect(recording.transcript.messages.length).toBeGreaterThan(4)
    expect(recording.transcript.messages[0]).toMatchObject({ role: 'user', text: '铺一层石地板然后拍张照' })
    expect(recording.transcript.messages.some((m) => m.toolName === 'fill_box')).toBe(true)
    expect(recording.captures.refs.length).toBe(1)
    expect(recording.transcript.messages.find((m) => m.usage !== undefined)).toBeDefined()

    // 界面那 60 张的淘汰上限**不该**影响工程文件：录制器是完整的另一份
    expect(chat.captureCount).toBeLessThanOrEqual(recording.captures.refs.length)
  })

  it('清空对话后保存，工程文件里不该还留着上一次的内容', async () => {
    const { chat, settle } = makeChat({ script: [{ text: '你好。' }] })
    chat.send('第一句')
    await settle()
    expect(chat.recording().transcript.messages.length).toBeGreaterThan(0)
    chat.clear()
    expect(chat.recording().transcript.messages).toEqual([])
    expect(chat.recording().captures.refs).toEqual([])
  })
})

describe('桌面端的花费上限必须真的刹车（不能只记账）', () => {
  it('设置了 maxUsd 时循环会停下来，并把原因带回界面', async () => {
    const secrets = createMemorySecretStore()
    secrets.set('DeepSeek', 'sk-x')
    const settings = deepseekWithKey()
    settings.budget = { maxUsd: 0.00001 }

    const { AgentSession, runAgent, ScriptedProvider } = await import('@architect/agent')

    // 直接验"设置里的预算会被送进循环"这条线：StudioService 的 runner 读的是
    // chat.settingsValue.budget，所以只要 UI 存的预算能被读出来就够了。
    const studio = new StudioService({ plain: true, chat: { settings, secrets } })
    expect(studio.settingsView().budget).toEqual({ maxUsd: 0.00001 })

    // 再用同样的预算跑一次真实的循环，确认它真的会停
    const session = new AgentSession({ volume: { min: { x: 0, y: 0, z: 0 }, max: { x: 15, y: 15, z: 15 } }, plain: true })
    const provider = new ScriptedProvider(
      Array.from({ length: 20 }, (_, i) => ({
        toolCalls: [{ name: 'place_block', args: { pos: [i % 16, 0, 0], block: 'minecraft:stone' } }],
      })),
    )
    const state = await runAgent(
      {
        provider,
        registry: session.registry,
        ctx: session.ctx,
        system: session.buildSystem(),
        budget: settings.budget,
        costTable: settings.providers[0]!.cost,
      },
      '一直造下去',
    )
    expect(state.stopReason).toBe('budget')
    expect(state.error).toContain('花费上限')
  })
})

describe('打开工程：把存下来的对话接回界面', () => {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
  const examplePath = join(root, 'examples', 'forest-hut.mcai')

  it('**打开示例工程：消息、截图一起回来**（对话记录是 .mcai 的一半，存了就要看得到）', async () => {
    const studio = new StudioService({ plain: true })
    await studio.open(examplePath)
    const view = studio.chatView()

    expect(view.messages.length).toBeGreaterThan(0)
    // 带截图的那条：id 能反查到字节（`captures/` 真的接回来了）
    const withImage = view.messages.find((message) => message.imageId !== undefined)
    expect(withImage).toBeDefined()
    expect(studio.chatImage(withImage!.imageId!)?.length).toBeGreaterThan(0)
    // 工具参数也回来了（挂在 assistant 的 toolCalls 上，要按 toolCallId 找回来）
    expect(view.messages.some((message) => message.args !== undefined)).toBe(true)
    // 用量形状：数字都在（示例是脚本化跑出来的，绝对值不可能是负的）
    expect(view.usage.in).toBeGreaterThanOrEqual(0)
    expect(view.usage.turns).toBeGreaterThanOrEqual(0)
  })

  it('**打开之后接着录，档案不会被抹掉**（否则"打开→再问一轮→保存"会丢掉历史）', async () => {
    const studio = new StudioService({ plain: true })
    await studio.open(examplePath)
    const view = studio.chatView()
    // 录制器被 seed 成了同一份档案：保存时两段都写进去
    const recording = studio.chat.recording()
    expect(recording.transcript.messages).toHaveLength(view.messages.length)
    expect(recording.captures.refs.length).toBeGreaterThan(0)
  })
})

describe('接续提问：把上一轮真的发给模型', () => {
  /** 等 StudioService 里那一轮跑完（`running` 落回 false）。 */
  const settleService = async (service: StudioService): Promise<void> => {
    for (let i = 0; i < 400 && service.chatView().running; i++) {
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
  }

  function withSettings(secrets: SecretStore, providerFactory: () => LlmProvider): StudioService {
    return new StudioService({
      plain: true,
      chat: { settings: deepseekWithKey(), secrets, providerFactory },
    })
  }

  it('**第二轮请求里带着第一轮的对话**（而不是只有一句新需求）', async () => {
    const secrets = createMemorySecretStore()
    secrets.set('DeepSeek', 'sk-test-key')
    const requests: LlmRequest[] = []
    const inner = new ScriptedProvider([
      { toolCalls: [{ name: 'fill_box', args: { from: [0, 0, 0], to: [3, 0, 3], block: 'minecraft:stone' } }] },
      {
        toolCalls: [
          {
            name: 'verify',
            args: { claims: [{ check: 'block_at', pos: [0, 0, 0], expect: 'minecraft:stone' }] },
          },
        ],
      },
      { text: '铺好了。' },
      { text: '开好了。' },
    ])
    const chat = inner.chat.bind(inner)
    const spy: LlmProvider = {
      id: inner.id,
      model: inner.model,
      supportsImages: inner.supportsImages,
      chat: (request) => {
        requests.push(request)
        return chat(request)
      },
    }

    const service = withSettings(secrets, () => spy)
    service.send('铺一层 4x4 石地板')
    await settleService(service)
    service.send('再开一扇窗')
    await settleService(service)

    expect(requests.length).toBeGreaterThanOrEqual(2)
    // 第二个 send 的那一次请求（第一个 send 自己就发了三次）
    const second = requests.at(-1)!.messages
    // 第一句需求、它调过的工具、以及工具读回的结果，全都在
    expect(second.map((message) => message.content)).toContain('铺一层 4x4 石地板')
    expect(second.some((message) => message.role === 'assistant' && (message.toolCalls?.length ?? 0) > 0)).toBe(true)
    expect(second.some((message) => message.role === 'tool')).toBe(true)
    // 这一句新需求在最后
    expect(second.at(-1)!.content).toBe('再开一扇窗')
  })

  it('清空对话之后不再带旧历史（否则模型还记得你删掉的那些话）', async () => {
    const secrets = createMemorySecretStore()
    secrets.set('DeepSeek', 'sk-test-key')
    const requests: LlmRequest[] = []
    const inner = new ScriptedProvider([{ text: '好的。' }, { text: '又是新的。' }])
    const chat = inner.chat.bind(inner)
    const spy: LlmProvider = {
      id: inner.id,
      model: inner.model,
      supportsImages: inner.supportsImages,
      chat: (request) => {
        requests.push(request)
        return chat(request)
      },
    }
    const service = withSettings(secrets, () => spy)
    service.send('第一句')
    await settleService(service)
    service.clearChat()
    service.send('第二句')
    await settleService(service)

    const second = requests[1]!.messages
    expect(second.map((message) => message.content)).not.toContain('第一句')
    expect(second.at(-1)!.content).toBe('第二句')
  })

  it('**provider 报错时对话里必须出现一条可见的失败消息**（不能静默）', async () => {
    const secrets = createMemorySecretStore()
    secrets.set('DeepSeek', 'sk-test-key')
    const failing: LlmProvider = {
      id: 'failing',
      model: 'failing',
      supportsImages: false,
      chat: async () => {
        throw new LlmError('HTTP 402: Insufficient Balance', 'BAD_REQUEST', false)
      },
    }
    const service = withSettings(secrets, () => failing)
    service.send('十字架上加上耶稣，因为耶稣被钉在十字架上')
    await settleService(service)

    const view = service.chatView()
    expect(view.running).toBe(false)
    // 以前这里只有 `view.error`，而界面从来没有渲染过它 —— 用户看到的就是"没反应"
    const failed = view.messages.filter((message) => message.failed === true)
    expect(failed).toHaveLength(1)
    expect(failed[0]!.text).toContain('402')
    expect(view.error).toContain('402')
  })
})

/**
 * **流式：字是边收边画的，「思考中…」也在对话列表里。**
 *
 * 时序由测试掌握（runner 就是一段可手动推事件的闭包）：真跑一遍 `runAgent`
 * 的话这些中间态一眨眼就过去了，断言不到。"思考中…"曾经只写在顶栏那行状态上，
 * 而那行是**隐藏**的——所以这里断言的是它真的落进了消息数组。
 */
describe('流式输出', () => {
  interface Stage {
    chat: ChatController
    emit: (event: AgentEvent) => void
    /** 已经推给界面的视图（合并推送意味着它比事件数少）。 */
    views: ChatView[]
    finish: () => Promise<void>
  }

  /** 建一个由测试手动驱动的会话，并发出第一句需求。 */
  async function stage(): Promise<Stage> {
    const secrets = createMemorySecretStore()
    secrets.set('DeepSeek', 'sk-test-key')
    let push: ((event: AgentEvent) => void) | undefined
    let done: (() => void) | undefined
    const finished = new Promise<void>((resolve) => {
      done = resolve
    })
    const chat = new ChatController(
      { settings: deepseekWithKey(), secrets },
      async (_goal, _provider, onEvent) => {
        push = onEvent
        await finished
        return { stopReason: 'completed', usage: { in: 1, out: 1 } }
      },
    )
    const views: ChatView[] = []
    chat.onEvent((event) => {
      if (event.type === 'chat') views.push(event.view)
    })
    chat.send('做个房子')
    // runner 要等密钥解析完才被调到；等它把 onEvent 交出来
    for (let i = 0; i < 200 && push === undefined; i++) await new Promise((resolve) => setTimeout(resolve, 5))
    if (push === undefined) throw new Error('runner 没被调起来')
    return {
      chat,
      emit: (event) => push?.(event),
      views,
      finish: async () => {
        done?.()
        for (let i = 0; i < 200 && chat.chatView().running; i++) {
          await new Promise((resolve) => setTimeout(resolve, 5))
        }
      },
    }
  }

  it('**「思考中…」当场进对话列表，正文逐字长出来，最后以完整响应收口**', async () => {
    const { chat, emit, views, finish } = await stage()

    // 一轮开始：正文一个字都没有，但列表里已经有一条"正在生成"的了
    emit({ type: 'turn', turn: 1 })
    expect(chat.chatView().messages.at(-1)).toMatchObject({ role: 'assistant', text: '', streaming: true })

    emit({ type: 'assistant_delta', turn: 1, text: '先', reasoning: '' })
    emit({ type: 'assistant_delta', turn: 1, text: '铺', reasoning: '' })
    // 思维链带的是**正文**（不是"想了几个字"）：界面要在一行里滚动显示最新内容，
    // 也得能点开看全文。多个碎片是**拼接**，不是取最后一个。
    emit({ type: 'assistant_delta', turn: 1, text: '', reasoning: '想一' })
    emit({ type: 'assistant_delta', turn: 1, text: '', reasoning: '想二' })
    const growing = chat.chatView().messages.at(-1)!
    expect(growing.text).toBe('先铺')
    expect(growing.streaming).toBe(true)
    expect(growing.thinking).toBe('想一想二')
    // 还是一条消息，不是每个碎片一条
    expect(chat.chatView().messages.filter((message) => message.role === 'assistant')).toHaveLength(1)

    // 收口：**以完整响应为准**（碎片可能少一块，最终响应不会）
    emit({ type: 'assistant', turn: 1, text: '先铺地板。' })
    const settled = chat.chatView().messages.at(-1)!
    expect(settled.text).toBe('先铺地板。')
    expect(settled.streaming).toBe(false)
    // **思维链收口后仍然留着**：生成完之后"它当时在想什么"是排查"模型为什么这么改"
    // 最直接的线索。界面上默认收成一行，点开才展开。
    expect(settled.thinking).toBe('想一想二')

    await finish()
    expect(views.at(-1)!.running).toBe(false)
    expect(views.at(-1)!.messages.at(-1)!.text).toBe('先铺地板。')
  })

  it('增量**合并**推送：同步连发不会一个碎片推一次，但最终一定会到', async () => {
    const { emit, views } = await stage()
    emit({ type: 'turn', turn: 1 })
    const before = views.length
    for (const piece of ['一', '二', '三', '四', '五']) {
      emit({ type: 'assistant_delta', turn: 1, text: piece, reasoning: '' })
    }
    // 合并窗口内一次都不推（几十次/秒的 IPC 与整列重绘就是这么省下来的）
    expect(views.length).toBe(before)
    await new Promise((resolve) => setTimeout(resolve, 90))
    expect(views.length).toBeGreaterThan(before)
    expect(views.at(-1)!.messages.at(-1)!.text).toBe('一二三四五')
  })

  it('**重试不留重复的半句话**：上一次尝试的碎片作废，只留重试后的完整正文', async () => {
    const { chat, emit, finish } = await stage()
    emit({ type: 'turn', turn: 1 })
    emit({ type: 'assistant_delta', turn: 1, text: '半句话', reasoning: '' })
    emit({ type: 'retry', attempt: 1, reason: '连接被掐断' })
    emit({ type: 'turn', turn: 1 })
    emit({ type: 'assistant_delta', turn: 1, text: '好', reasoning: '' })
    emit({ type: 'assistant_delta', turn: 1, text: '的。', reasoning: '' })
    emit({ type: 'assistant', turn: 1, text: '好的。' })
    await finish()

    const assistant = chat.chatView().messages.filter((message) => message.role === 'assistant')
    // 一条 [retry] 提示 + 一条正文，半句话那条已经被丢掉
    expect(assistant.map((message) => message.text)).toEqual(['[retry 1] 连接被掐断', '好的。'])
    expect(assistant.some((message) => message.streaming === true)).toBe(false)
  })

  it('**只调工具的那一轮不留空气泡**（正文一个字都没有）', async () => {
    const { chat, emit, finish } = await stage()
    emit({ type: 'turn', turn: 1 })
    emit({ type: 'assistant_delta', turn: 1, text: '', reasoning: '它在想' })
    emit({ type: 'tool_call', turn: 1, id: 'c1', name: 'fill_box', args: { block: 'minecraft:stone' } })
    await finish()

    const messages = chat.chatView().messages
    expect(messages.at(-1)).toMatchObject({ role: 'tool', toolName: 'fill_box' })
    expect(messages.some((message) => message.role === 'assistant')).toBe(false)
  })
})
