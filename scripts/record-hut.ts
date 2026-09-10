import { writeFileSync } from 'node:fs'
import {
  AgentSession, exchangesToJsonl, findTask, RecordingProvider, runAgent, ScriptedProvider,
} from '@architect/agent'

async function main(): Promise<void> {
  const task = findTask('hut')!
  const session = new AgentSession({ volume: task.volume, plain: true })

  // 一份"会通过验收"的剧本：地板 → 墙 → 门 → 窗 → 屋顶 → verify → 收尾
  const rect = [[4,4],[13,4],[13,13],[4,13]]
  const script = [
    { text: '先量尺度。', toolCalls: [{ name: 'measure', args: {} }] },
    { toolCalls: [{ name: 'extrude', args: { points: rect, baseY: 0, height: 1, block: 'minecraft:oak_planks' } }] },
    { toolCalls: [{ name: 'extrude', args: {
      points: rect, baseY: 1, height: 4, block: 'minecraft:stone_bricks',
      hollow: true, capTop: false, capBottom: false } }] },
    { toolCalls: [{ name: 'erase', args: { from: [8,1,4], to: [8,2,4] } }] },
    { toolCalls: [{ name: 'fill_box', args: { from: [4,2,8], to: [4,2,8], block: 'minecraft:glass' } }] },
    { toolCalls: [{ name: 'fill_box', args: { from: [13,2,8], to: [13,2,8], block: 'minecraft:glass' } }] },
    { toolCalls: [{ name: 'extrude', args: {
      points: rect, baseY: 5, height: 3, block: 'minecraft:spruce_planks',
      hollow: true, capBottom: false, capTop: true } }] },
    { toolCalls: [{ name: 'verify', args: { claims: [
      { check: 'air_at', pos: [8,1,4] },
      { check: 'air_at', pos: [8,2,4] },
      { check: 'count', block: 'minecraft:glass', min: 2 },
      { check: 'supported', from: [0,0,0], to: [31,31,31] } ] } }] },
    { text: '小屋完成：10x10 木地板、石砖墙、南面门洞、东西两扇窗、坡屋顶。' },
  ]

  const recorded: unknown[] = []
  const provider = new RecordingProvider(
    new ScriptedProvider(script),
    (exchange) => recorded.push(exchange),
    () => new Date('2026-01-01T00:00:00.000Z'),
  )
  const state = await runAgent(
    { provider, registry: session.registry, ctx: session.ctx, system: session.buildSystem() },
    task.goal,
  )
  console.log(`录制完成：${state.stopReason}，${recorded.length} 轮，${session.log.length} 个 op`)
  writeFileSync('scripts/fixtures/hut.jsonl', exchangesToJsonl(recorded as never))
  console.log('已写出 scripts/fixtures/hut.jsonl')
}

main().catch((e: unknown) => { console.error(e); process.exit(1) })
