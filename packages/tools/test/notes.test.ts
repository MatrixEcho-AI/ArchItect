import { WorldStore } from '@architect/core'
import { describe, expect, it } from 'vitest'

import { createDefaultRegistry } from '../src/index.js'
import { MAX_DESIGN_NOTES_CHARS, updateNotesTool } from '../src/tools/notes.js'
import type { ToolContext } from '../src/types.js'

/** 工具执行签名允许返回 Promise（桌面端的截图那条路就是异步的），这里统一 await。 */
async function run(
  ctx: ToolContext,
  args: { notes: string },
): Promise<{ ok: boolean; summary: string; error?: { code: string }; data?: Record<string, unknown> }> {
  return (await updateNotesTool.execute(ctx, args)) as never
}

function ctxWithNotes(): { ctx: ToolContext; notes: () => string | undefined } {
  let stored: string | undefined
  const store = new WorldStore({
    minecraftVersion: '1.21.4',
    volume: { min: { x: 0, y: 0, z: 0 }, max: { x: 15, y: 15, z: 15 } },
  })
  const ctx = {
    store,
    log: { length: 0 } as never,
    clipboard: {},
    correlationId: 'test',
    history: {} as never,
    record: () => {},
    shoot: () => {
      throw new Error('unused')
    },
    notes: {
      get: () => stored,
      set: (next: string | undefined) => {
        stored = next
      },
    },
  } as unknown as ToolContext
  return { ctx, notes: () => stored }
}

describe('update_notes：把设计计划写下来，好让它活过上下文裁剪', () => {
  it('写进去、回显出来（模型能看到自己记下的就是这些）', async () => {
    const { ctx, notes } = ctxWithNotes()
    const result = await run(ctx, { notes: '八角基座 17 格；门朝南非，净高 3 格' })
    expect(result.ok).toBe(true)
    expect(notes()).toBe('八角基座 17 格；门朝南非，净高 3 格')
    expect(result.summary).toContain('八角基座')
    expect(result.summary).toContain(`${MAX_DESIGN_NOTES_CHARS}`)
  })

  it('**是替换不是追加**（笔记进的是每个请求的前缀，追加会越滚越贵）', async () => {
    const { ctx, notes } = ctxWithNotes()
    await run(ctx, { notes: '第一版计划' })
    await run(ctx, { notes: '第二版计划' })
    expect(notes()).toBe('第二版计划')
  })

  it('空字符串 = 清掉', async () => {
    const { ctx, notes } = ctxWithNotes()
    await run(ctx, { notes: '有内容' })
    const cleared = await run(ctx, { notes: '   ' })
    expect(cleared.ok).toBe(true)
    expect(notes()).toBeUndefined()
    expect(cleared.summary).toContain('cleared')
  })

  it('**超长直接拒绝并报出当前长度**（让模型自己删，而不是悄悄截断）', async () => {
    const { ctx, notes } = ctxWithNotes()
    const tooLong = 'x'.repeat(MAX_DESIGN_NOTES_CHARS + 1)
    const result = await run(ctx, { notes: tooLong })
    expect(result.ok).toBe(false)
    expect(result.error?.code).toBe('INVALID_ARGS')
    expect(result.data).toMatchObject({ length: MAX_DESIGN_NOTES_CHARS + 1, limit: MAX_DESIGN_NOTES_CHARS })
    expect(notes()).toBeUndefined()
  })

  it('宿主没接这个能力时如实报错，不假装记下了', async () => {
    const { ctx } = ctxWithNotes()
    const bare = { ...ctx, notes: undefined } as unknown as ToolContext
    const result = await run(bare, { notes: '计划' })
    expect(result.ok).toBe(false)
    expect(result.error?.code).toBe('UNSUPPORTED')
  })

  it('在默认工具集里，而且不是 mutating（它不改世界、也不该动完成闸门）', async () => {
    const registry = createDefaultRegistry()
    const tool = registry.get('update_notes')
    expect(tool).toBeDefined()
    expect(tool?.mutating).toBe(false)
    expect(tool?.destructive).toBe(false)
  })
})
