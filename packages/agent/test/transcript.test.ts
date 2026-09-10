import { describe, expect, it } from 'vitest'

import type { TranscriptEvent } from '@architect/mcai'

import { runAgent } from '../src/loop.js'
import type { AgentEvent } from '../src/loop.js'
import { ScriptedProvider } from '../src/providers/scripted.js'
import { AgentSession } from '../src/session.js'

/**
 * **编译期契约测试**：`TranscriptRecorder` 在 `packages/mcai` 里声明了一份结构化的
 * 事件视图，而不是 import `AgentEvent`——`.mcai` 是格式权威，不该反过来依赖 harness 实现。
 *
 * 代价是两边可能漂移。这一条断言把这个代价降到零：**字段对不上直接编译失败**，
 * 不会等到运行时录出一份缺字段的对话记录。
 */
const _assignable = (event: AgentEvent): TranscriptEvent => event
void _assignable

describe('事件视图与 AgentEvent 不会漂移', () => {
  it('**运行时再验一次**：真实事件流的每一种事件都能被录制器接受', async () => {
    const session = new AgentSession({
      volume: { min: { x: 0, y: 0, z: 0 }, max: { x: 15, y: 15, z: 15 } },
      plain: true,
    })
    const provider = new ScriptedProvider([
      { toolCalls: [{ name: 'fill_box', args: { from: [0, 0, 0], to: [3, 0, 3], block: 'minecraft:stone' } }] },
      { toolCalls: [{ name: 'screenshot', args: { view: 'iso_ne', width: 128, height: 96 } }] },
      { toolCalls: [{ name: 'verify', args: { claims: [{ check: 'block_at', pos: [0, 0, 0], expect: 'minecraft:stone' }] } }] },
      { text: '做好了。' },
    ])

    const seen = new Set<string>()
    const state = await runAgent(
      {
        provider,
        registry: session.registry,
        ctx: session.ctx,
        system: session.buildSystem(),
        stateLine: session.buildStateLine(),
        onEvent: (event) => seen.add(event.type),
      },
      '铺地板然后拍张照',
    )

    expect(state.stopReason).toBe('completed')
    // 覆盖面：这些事件类型都必须能在 `TranscriptEvent` 里找到对应成员
    for (const type of ['turn', 'assistant', 'tool_call', 'tool_result', 'images', 'stop']) {
      expect(seen.has(type), `事件流里没有 ${type}`).toBe(true)
    }
  })
})
