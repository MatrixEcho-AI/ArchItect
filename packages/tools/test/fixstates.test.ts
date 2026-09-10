import { EditLog, ReplaySession, WorldStore } from '@architect/core'
import type { Bounds } from '@architect/core'
import { describe, expect, it } from 'vitest'

import { fixStatesTool } from '../src/tools/fixstates.js'
import type { ToolContext } from '../src/types.js'

/**
 * `fix_states` 工具层的验收测试。
 *
 * 重点不是重测 pass 的几何（那在 core 里），而是：
 * 参数校验、结果翻成英文摘要、`data.fix` 真的带出去、以及**工具调用也只花一个 revision**。
 */

const volume: Bounds = { min: { x: 0, y: 0, z: 0 }, max: { x: 31, y: 31, z: 31 } }

interface FixData {
  changed: number
  scanned: number
  byRule: Record<string, number>
  embeddedSample: Array<{ x: number; y: number; z: number }>
}

function makeContext(): ToolContext {
  const store = new WorldStore({ minecraftVersion: '1.21.4', volume })
  const log = new EditLog()
  return {
    store,
    log,
    history: new ReplaySession(store, log),
    clipboard: {},
    correlationId: 'turn_1',
    record: (tool, args, result) => {
      log.record(result, {
        tool,
        args,
        correlationId: 'turn_1',
        ts: '2026-01-01T00:00:00.000Z',
        worldRevision: store.revision,
      })
    },
    shoot: () => {
      throw new Error('fix_states never takes a screenshot')
    },
  }
}

const fixData = (data: Record<string, unknown> | undefined): FixData => data?.fix as FixData

const CJK = /[\u3400-\u9fff]/

describe('fix_states 工具', () => {
  it('元信息：mutating=true、destructive=false，给 LLM 的字符串全是英文', () => {
    expect(fixStatesTool.name).toBe('fix_states')
    expect(fixStatesTool.mutating).toBe(true)
    expect(fixStatesTool.destructive).toBe(false)
    expect(CJK.test(fixStatesTool.description)).toBe(false)
    expect(CJK.test(JSON.stringify(fixStatesTool.parameters))).toBe(false)
    expect(fixStatesTool.description).toContain('waterlogged')
    expect(fixStatesTool.description).toContain('idempotent')
  })

  it('修好一条栅栏线，把规则计数带进 data 与摘要', async () => {
    const ctx = makeContext()
    for (let x = 0; x < 4; x++) ctx.store.setBlock({ x, y: 0, z: 0 }, 'minecraft:oak_fence')
    // `setBlock` 是**绕过日志**的直接写入，所以要把版本号拉回日志长度：
    // 这条栅栏线是**基准状态**（rev 0），工具接下来那一笔才是 rev 1。
    // 不拉的话"世界的版本"和"日志长度"一开始就是两回事，后面全对不上。
    ctx.store.setRevision(ctx.log.length)

    const result = await fixStatesTool.execute(ctx, {})

    expect(result.ok).toBe(true)
    expect(CJK.test(result.summary)).toBe(false)
    expect(result.summary).toContain('Repaired by rule: connect=')
    const fix = fixData(result.data)
    expect(fix.changed).toBe(4)
    expect(fix.byRule.connect).toBe(4)
    expect(fix.scanned).toBe(4)
    expect(ctx.store.getBlockString({ x: 1, y: 0, z: 0 })).toContain('east=true')
  })

  it('整趟修正只花一个 revision，并记下恰好一个 EditOp', async () => {
    const ctx = makeContext()
    for (let x = 0; x < 4; x++) ctx.store.setBlock({ x, y: 0, z: 0 }, 'minecraft:oak_fence')
    // `setBlock` 是**绕过日志**的直接写入，所以要把版本号拉回日志长度：
    // 这条栅栏线是**基准状态**（rev 0），工具接下来那一笔才是 rev 1。
    // 不拉的话"世界的版本"和"日志长度"一开始就是两回事，后面全对不上。
    ctx.store.setRevision(ctx.log.length)
    const revision = ctx.store.revision
    const ops = ctx.log.length

    const result = await fixStatesTool.execute(ctx, {})

    expect(result.ok).toBe(true)
    expect(ctx.store.revision).toBe(revision + 1)
    expect(ctx.log.length).toBe(ops + 1)
    expect(ctx.log.byRevision(ctx.log.revision)?.tool).toBe('fix_states')
  })

  it('幂等：第二次调用 changed=0，摘要里出现 no changes made', async () => {
    const ctx = makeContext()
    for (let x = 0; x < 4; x++) ctx.store.setBlock({ x, y: 0, z: 0 }, 'minecraft:oak_fence')
    // `setBlock` 是**绕过日志**的直接写入，所以要把版本号拉回日志长度：
    // 这条栅栏线是**基准状态**（rev 0），工具接下来那一笔才是 rev 1。
    // 不拉的话"世界的版本"和"日志长度"一开始就是两回事，后面全对不上。
    ctx.store.setRevision(ctx.log.length)

    const first = await fixStatesTool.execute(ctx, {})
    expect(fixData(first.data).changed).toBeGreaterThan(0)

    const second = await fixStatesTool.execute(ctx, {})

    expect(second.ok).toBe(true)
    expect(fixData(second.data).changed).toBe(0)
    expect(second.summary).toContain('no changes made')
  })

  it('from/to 限定区域：区域外不动', async () => {
    const ctx = makeContext()
    for (let x = 0; x < 4; x++) ctx.store.setBlock({ x, y: 0, z: 0 }, 'minecraft:oak_fence')
    // `setBlock` 是**绕过日志**的直接写入，所以要把版本号拉回日志长度：
    // 这条栅栏线是**基准状态**（rev 0），工具接下来那一笔才是 rev 1。
    // 不拉的话"世界的版本"和"日志长度"一开始就是两回事，后面全对不上。
    ctx.store.setRevision(ctx.log.length)

    const result = await fixStatesTool.execute(ctx, { from: [0, 0, 0], to: [1, 0, 0] })

    expect(result.ok).toBe(true)
    expect(fixData(result.data).changed).toBe(2)
    expect(ctx.store.getBlockString({ x: 2, y: 0, z: 0 })).toContain('east=false')
  })

  it('只给 from 不给 to 时返回可自纠的 INVALID_ARGS', async () => {
    const ctx = makeContext()

    const result = await fixStatesTool.execute(ctx, { from: [0, 0, 0] })

    expect(result.ok).toBe(false)
    expect(result.error?.code).toBe('INVALID_ARGS')
    expect(result.summary).toContain('from and to')
    expect(ctx.store.revision).toBe(0)
  })

  it('被包住的半砖会写进 data.embeddedSample，摘要说明只报告不修改', async () => {
    const ctx = makeContext()
    for (let x = 0; x <= 2; x++) {
      for (let y = 0; y <= 2; y++) {
        for (let z = 0; z <= 2; z++) ctx.store.setBlock({ x, y, z }, 'minecraft:stone')
      }
    }
    ctx.store.setBlock({ x: 1, y: 1, z: 1 }, 'minecraft:oak_slab[type=bottom]')

    const result = await fixStatesTool.execute(ctx, {})

    expect(result.ok).toBe(true)
    const fix = fixData(result.data)
    expect(fix.byRule.embedded_partial).toBe(1)
    expect(fix.embeddedSample).toEqual([{ x: 1, y: 1, z: 1 }])
    expect(result.summary).toContain('reported but NOT modified')
    expect(ctx.store.getBlockString({ x: 1, y: 1, z: 1 })).toContain('oak_slab')
  })
})
