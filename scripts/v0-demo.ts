import { mkdirSync, writeFileSync } from 'node:fs'
import { AgentSession, runAgent, ScriptedProvider } from '@architect/agent'
import { measure } from '@architect/core'
import { openProject, packProject, TranscriptRecorder } from '@architect/mcai'

async function main(): Promise<void> {
  const session = new AgentSession({
    volume: { min: { x: 0, y: 0, z: 0 }, max: { x: 31, y: 40, z: 31 } },
    plain: false,
  })

  const script = [
    // 纯文本步骤会让循环判定"说完了"并结束，所以方案说明要并进第一个工具调用步骤
    {
      text: '方案：八角基座，塔身从 11 格收到 5 格，顶部玻璃灯室，南面开一扇门。先量一下当前尺度。',
      toolCalls: [{ name: 'measure', args: {} }],
    },
    { toolCalls: [{ name: 'extrude', args: {
      points: [[8,4],[16,4],[20,8],[20,16],[16,20],[8,20],[4,16],[4,8]],
      baseY: 0, height: 2, block: 'minecraft:stone_bricks' } }] },
    { toolCalls: [{ name: 'fill_line', args: {
      from: [12,2,12], to: [12,22,12], block: 'minecraft:stone_bricks', taper: [5,2], hollow: true } }] },
    { toolCalls: [{ name: 'erase', args: { from: [12,2,7], to: [12,4,8] } }] },
    // fill_line 没有 capTop/capBottom（那是 extrude 的参数）——多传会被 schema 拒绝
    { toolCalls: [{ name: 'fill_line', args: {
      from: [12,23,12], to: [12,25,12], block: 'minecraft:glass',
      radius: 3, hollow: true } }] },
    { toolCalls: [{ name: 'fill_line', args: {
      from: [12,26,12], to: [12,27,12], block: 'minecraft:dark_prismarine',
      radius: 4, hollow: true } }] },
    { toolCalls: [{ name: 'fill_box', args: {
      from: [9,27,9], to: [15,27,15], block: 'minecraft:dark_prismarine' } }] },
    { toolCalls: [{ name: 'verify', args: { claims: [
      { check: 'air_at', pos: [12,3,7] },
      // 塔身是空心的：y=3 处半径约 4.75，所以壳在离轴 4 格的位置，不是 3 格
      { check: 'block_at', pos: [12,3,16], expect: 'minecraft:stone_bricks' },
      { check: 'count', block: 'minecraft:stone_bricks', min: 400 },
      { check: 'count', block: 'minecraft:glass', min: 50 } ] } }] },
    { toolCalls: [{ name: 'screenshot', args: { view: 'iso_ne', width: 320, height: 240 } }] },
    { text: '灯塔完成：石砖基座 + 收分塔身 + 玻璃灯室 + 深色塔顶，南面门洞净高 3 格。' },
  ]

  // 对话记录与截图要一起进 `.mcai` —— 这是需求里"含对话记录"那一条
  const goal = '设计一座海边灯塔，塔身收分，顶部有玻璃灯室'
  const recorder = new TranscriptRecorder({ title: goal, model: 'scripted-v1', providerId: 'scripted' })
  recorder.add('user', goal)

  const state = await runAgent(
    { provider: new ScriptedProvider(script), registry: session.registry, ctx: session.ctx,
      system: session.buildSystem(),
      onEvent: (e) => {
        recorder.onEvent(e)
        if (e.type === 'tool_call') process.stdout.write(`  → ${e.name}\n`)
        if (e.type === 'tool_result') process.stdout.write(`  ${e.result.ok ? '✓' : '✗'} ${e.result.summary.split('\n')[0]}\n`)
      } },
    goal,
  )
  recorder.attachUsage(state.usage)

  console.log(`结束：${state.stopReason}  轮数 ${state.turn}  工具 ${state.toolCalls}  截图 ${session.screenshots}`)
  console.log(`token ${state.usage.in} 入 / ${state.usage.out} 出`)
  const stats = measure(session.store)
  console.log(`包围盒 ${JSON.stringify(stats.bounds)}  size ${stats.size!.x}x${stats.size!.y}x${stats.size!.z}`)
  console.log(`方块 ${stats.blocks}  op ${session.log.length}`)
  console.log('直方图: ' + stats.histogram.map(h=>`${h.block.replace('minecraft:','')}×${h.count}`).join('  '))

  const recording = recorder.recording
  const bytes = packProject({ name: '海边灯塔', projectId: '01LIGHTHOUSE', store: session.store,
    log: session.log, settings: { volume: session.store.volume },
    chat: recording.transcript, captures: recording.captures, now: '2026-01-01T00:00:00.000Z' })
  // 目标目录可能还不存在（换台机器、换了 tmp 清理策略）——写文件前先建好
  mkdirSync('/tmp/v0demo', { recursive: true })
  writeFileSync('/tmp/v0demo/lighthouse.mcai', bytes)
  console.log(`\n已写出 lighthouse.mcai（${(bytes.length/1024).toFixed(1)} KB）`)
  console.log(`对话 ${recording.transcript.messages.length} 条   截图存档 ${recording.captures.refs.length} 张`)

  const { store: re, project } = openProject(bytes)
  console.log(`重新打开：rev ${re.revision}  方块 ${measure(re).blocks}  哈希一致 ${re.contentHash() === session.store.contentHash()}`)
  console.log(`日志 ${project.log.all().map(o=>`${o.id}:${o.tool}`).join('  ')}`)
  console.log(`\n${state.finalText}`)
}

main().catch((e: unknown) => { console.error(e); process.exit(1) })
