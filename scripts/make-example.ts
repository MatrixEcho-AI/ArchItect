import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { AgentSession, runAgent, ScriptedProvider } from '@architect/agent'
import { openProject, packProject, TranscriptRecorder } from '@architect/mcai'

/**
 * 生成 `examples/` 里的示例工程。
 *
 * **完全确定性**（固定时间戳、固定会话 id、脚本 provider），所以：
 * 同样的代码必然产出逐字节相同的示例文件，`git diff` 能如实反映"我们改了导出逻辑"。
 *
 * 示例工程是 M8 的交付物之一，也是一份**活的**端到端夹具：
 * `packages/mcai/test/examples.test.ts` 会打开它并核对内容，
 * 所以它不会随着格式演进悄悄烂掉。
 */
const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const FIXED_NOW = '2026-01-01T00:00:00.000Z'

async function buildHut(): Promise<void> {
  const session = new AgentSession({
    volume: { min: { x: 0, y: 0, z: 0 }, max: { x: 23, y: 23, z: 23 } },
    plain: true,
    // 注入固定时钟：不这样做，`history/edits.jsonl` 里每一步 op 的时间戳都会变，
    // 示例文件每次生成都不同，`git diff` 全是噪音
    now: () => FIXED_NOW,
  })

  const goal = '造一座 9x9 的单层林间小屋，云杉木板墙、圆石地基、斜坡屋顶，正门朝南开'
  const script = [
    {
      text: '方案：9x9 云杉小屋，圆石地基一圈，四壁高 4 格，南面开门，深色橡木做四坡顶。',
      toolCalls: [{ name: 'measure', args: {} }],
    },
    {
      toolCalls: [
        {
          name: 'run_batch',
          args: {
            ops: [
              { tool: 'fill_box', args: { from: [4, 0, 4], to: [12, 0, 12], block: 'minecraft:cobblestone' } },
              {
                tool: 'extrude',
                args: {
                  points: [[4, 4], [12, 4], [12, 12], [4, 12]],
                  baseY: 1,
                  height: 4,
                  block: 'minecraft:spruce_planks',
                  hollow: true,
                  capTop: false,
                  capBottom: false,
                },
              },
            ],
            confirm: true,
          },
        },
      ],
    },
    { toolCalls: [{ name: 'erase', args: { from: [8, 1, 4], to: [8, 2, 4], confirm: true } }] },
    {
      toolCalls: [
        { name: 'fill_box', args: { from: [8, 1, 4], to: [8, 1, 4], block: 'minecraft:spruce_door[facing=south,half=lower]' } },
        { name: 'fill_box', args: { from: [8, 2, 4], to: [8, 2, 4], block: 'minecraft:spruce_door[facing=south,half=upper]' } },
        { name: 'fill_box', args: { from: [4, 2, 8], to: [4, 3, 9], block: 'minecraft:glass_pane[east=false,north=true,south=true,waterlogged=false,west=false]' } },
        { name: 'fill_box', args: { from: [12, 2, 8], to: [12, 3, 9], block: 'minecraft:glass_pane[east=false,north=true,south=true,waterlogged=false,west=false]' } },
      ],
      confirm: true,
    },
    {
      toolCalls: [{ name: 'fill_box', args: { from: [3, 5, 3], to: [13, 5, 13], block: 'minecraft:dark_oak_planks', mode: 'hollow' } }],
    },
    {
      toolCalls: [
        {
          name: 'verify',
          args: {
            claims: [
              { check: 'block_at', pos: [8, 1, 4], expect: 'minecraft:spruce_door' },
              { check: 'block_at', pos: [8, 2, 4], expect: 'minecraft:spruce_door[half=upper]' },
              { check: 'count', block: 'minecraft:cobblestone', min: 70 },
              { check: 'count', block: 'minecraft:glass_pane', min: 2 },
            ],
          },
        },
      ],
    },
    { toolCalls: [{ name: 'screenshot', args: { view: 'iso_ne', width: 320, height: 240 } }] },
  ]

  const recorder = new TranscriptRecorder({
    sessionId: 'example-hut',
    title: goal,
    model: 'scripted-v1',
    providerId: 'scripted',
    now: () => FIXED_NOW,
  })
  recorder.add('user', goal)

  const state = await runAgent(
    {
      provider: new ScriptedProvider(script),
      registry: session.registry,
      ctx: session.ctx,
      system: session.buildSystem(),
      stateLine: session.buildStateLine(),
      onEvent: (event) => recorder.onEvent(event),
    },
    goal,
  )
  recorder.attachUsage(state.usage)

  const recording = recorder.recording
  const bytes = packProject({
    name: '林间小屋（示例）',
    projectId: '01EXAMPLEHUT',
    store: session.store,
    log: session.log,
    settings: { volume: session.store.volume },
    chat: recording.transcript,
    captures: recording.captures,
    now: FIXED_NOW,
  })

  mkdirSync(join(root, 'examples'), { recursive: true })
  const target = join(root, 'examples', 'forest-hut.mcai')
  writeFileSync(target, bytes)

  const { store } = openProject(bytes)
  console.log(`示例工程 → examples/forest-hut.mcai（${(bytes.length / 1024).toFixed(1)} KB）`)
  console.log(`  ${store.stats().blocks} 方块   op ${session.log.length}   revision ${state.stopReason}`)
  console.log(`  对话 ${recording.transcript.messages.length} 条   截图 ${recording.captures.refs.length} 张`)
}

await buildHut()
