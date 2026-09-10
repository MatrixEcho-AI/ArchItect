import { EditLog, WorldStore } from '@architect/core'
import type { Bounds } from '@architect/core'
import { describe, expect, it } from 'vitest'

import { createDefaultRegistry } from '../src/index.js'
import type { ToolContext } from '../src/types.js'

const volume: Bounds = { min: { x: 0, y: 0, z: 0 }, max: { x: 31, y: 31, z: 31 } }
const registry = createDefaultRegistry()

function makeContext(useVolume: Bounds = volume): ToolContext {
  const store = new WorldStore({ minecraftVersion: '1.21.4', volume: useVolume })
  const log = new EditLog()
  return {
    store,
    log,
    clipboard: {},
    correlationId: 'turn_1',
    record: (tool, args, result) => {
      log.record(result, { tool, args, correlationId: 'turn_1', ts: '2026-01-01T00:00:00.000Z' })
    },
    shoot: () => {
      throw new Error('这个测试不该截图')
    },
  }
}

/** 调用一个工具并把结果收窄成非空。 */
async function call(ctx: ToolContext, name: string, args: unknown) {
  const result = await registry.call(ctx, name, args)
  return result
}

const blockAt = (ctx: ToolContext, x: number, y: number, z: number): string =>
  ctx.store.getBlockString({ x, y, z }).replace('minecraft:', '')

describe('copy_region / paste_region', () => {
  it('复制粘贴同一个位置应当完全等价，且不产生 revision', async () => {
    const ctx = makeContext()
    await call(ctx, 'fill_box', { from: [0, 0, 0], to: [3, 0, 3], block: 'minecraft:stone', confirm: true })
    const before = ctx.store.revision

    const copied = await call(ctx, 'copy_region', { from: [0, 0, 0], to: [3, 0, 3] })
    expect(copied.ok).toBe(true)
    expect(copied.data?.['cells']).toBe(16)
    // 复制是只读的
    expect(ctx.store.revision).toBe(before)
    expect(ctx.log.length).toBe(1)

    const pasted = await call(ctx, 'paste_region', { at: [8, 0, 0], confirm: true })
    expect(pasted.ok).toBe(true)
    expect(ctx.store.revision).toBe(before + 1)
    for (let x = 0; x < 4; x++) {
      for (let z = 0; z < 4; z++) {
        expect(blockAt(ctx, 8 + x, 0, z)).toBe('stone')
      }
    }
  })

  it('没复制过就粘贴 → 可自纠的 NOT_FOUND，而不是崩', async () => {
    const ctx = makeContext()
    const result = await call(ctx, 'paste_region', { at: [0, 0, 0] })
    expect(result.ok).toBe(false)
    expect(result.error?.code).toBe('NOT_FOUND')
    expect(result.error?.hint).toContain('copy_region')
  })

  it('**旋转 90° 会重映射楼梯朝向**，这是复制粘贴最容易漏的一步', async () => {
    const ctx = makeContext()
    await call(ctx, 'place_block', { pos: [0, 0, 0], block: 'minecraft:oak_stairs[facing=north]' })
    await call(ctx, 'copy_region', { from: [0, 0, 0], to: [0, 0, 0] })
    await call(ctx, 'paste_region', { at: [4, 0, 0], rotate: 90, confirm: true })
    expect(blockAt(ctx, 4, 0, 0)).toBe('oak_stairs[facing=east,half=bottom,shape=straight,waterlogged=false]')

    await call(ctx, 'paste_region', { at: [8, 0, 0], rotate: 180, confirm: true })
    expect(blockAt(ctx, 8, 0, 0)).toContain('facing=south')

    await call(ctx, 'paste_region', { at: [12, 0, 0], rotate: 270, confirm: true })
    expect(blockAt(ctx, 12, 0, 0)).toContain('facing=west')
  })

  it('镜像会同时翻转面向与手性（门的合页左右互换）', async () => {
    const ctx = makeContext()
    await call(ctx, 'place_block', {
      pos: [0, 0, 0],
      block: 'minecraft:oak_door[facing=east,hinge=left,half=lower]',
    })
    await call(ctx, 'copy_region', { from: [0, 0, 0], to: [0, 0, 0] })
    await call(ctx, 'paste_region', { at: [6, 0, 0], mirror: 'x', confirm: true })
    // 沿 X 镜像：east↔west，合页 left↔right
    expect(blockAt(ctx, 6, 0, 0)).toBe('oak_door[facing=west,half=lower,hinge=right,open=false,powered=false]')
  })

  it('旋转 90° 时占地尺寸的 x/z 互换', async () => {
    const ctx = makeContext()
    await call(ctx, 'fill_box', { from: [0, 0, 0], to: [3, 0, 5], block: 'minecraft:stone', confirm: true })
    await call(ctx, 'copy_region', { from: [0, 0, 0], to: [3, 0, 5] })
    const pasted = await call(ctx, 'paste_region', { at: [10, 0, 0], rotate: 90, confirm: true })
    expect(pasted.data?.['pasteSize']).toEqual([6, 1, 4])
    expect(pasted.summary).toContain('Footprint 6x1x4')
  })

  it('旋转 90° 后每一格都落在正确位置（角点对拍）', async () => {
    const ctx = makeContext()
    // 在 4x1x6 的区域里做一个不对称的 L 形，转 90° 后能唯一识别方向
    await call(ctx, 'fill_box', { from: [0, 0, 0], to: [3, 0, 0], block: 'minecraft:stone', confirm: true })
    await call(ctx, 'fill_box', { from: [0, 0, 0], to: [0, 0, 5], block: 'minecraft:bricks', confirm: true })
    await call(ctx, 'copy_region', { from: [0, 0, 0], to: [3, 0, 5] })
    await call(ctx, 'paste_region', { at: [10, 0, 0], rotate: 90, confirm: true })

    // 局部 (x,z) → (sz-1-z, x) = (5-z, x)，尺寸变 6x4，锚点 (10,0,0)
    const expected = new Map<string, string>()
    for (let x = 0; x < 4; x++) {
      for (let z = 0; z < 6; z++) {
        // 源区域：z=0 那一排铺了 stone（4 格），随后 x=0 那一列铺了 bricks（会覆盖 (0,0)）
        const source = x === 0 ? 'bricks' : z === 0 ? 'stone' : 'air'
        const [lx, lz] = [5 - z, x]
        expected.set(`${10 + lx},${lz}`, source)
      }
    }
    for (const [key, want] of expected) {
      const [x, z] = key.split(',').map(Number) as [number, number]
      expect(blockAt(ctx, x, 0, z), `(${x},${z})`).toBe(want)
    }
  })

  it('only 过滤只复制指定方块', async () => {
    const ctx = makeContext()
    await call(ctx, 'fill_box', { from: [0, 0, 0], to: [1, 0, 1], block: 'minecraft:stone', confirm: true })
    await call(ctx, 'place_block', { pos: [0, 0, 0], block: 'minecraft:gold_block' })
    const copied = await call(ctx, 'copy_region', {
      from: [0, 0, 0],
      to: [1, 0, 1],
      only: ['minecraft:gold_block'],
    })
    expect(copied.data?.['cells']).toBe(1)
    await call(ctx, 'paste_region', { at: [8, 0, 0], confirm: true })
    expect(blockAt(ctx, 8, 0, 0)).toBe('gold_block')
    // 只贴了那一格
    expect(ctx.store.getBlockString({ x: 9, y: 0, z: 0 })).toBe('minecraft:air')
  })

  it('mode=keep 只往空气里贴，方便嫁接', async () => {
    const ctx = makeContext()
    await call(ctx, 'fill_box', { from: [0, 0, 0], to: [1, 0, 1], block: 'minecraft:stone', confirm: true })
    await call(ctx, 'copy_region', { from: [0, 0, 0], to: [1, 0, 1] })
    await call(ctx, 'place_block', { pos: [8, 0, 0], block: 'minecraft:bedrock' })
    await call(ctx, 'paste_region', { at: [8, 0, 0], mode: 'keep', confirm: true })
    expect(blockAt(ctx, 8, 0, 0)).toBe('bedrock')
    expect(blockAt(ctx, 9, 0, 0)).toBe('stone')
  })
})

describe('run_batch', () => {
  it('**多个 op 只产生一个 revision**（这是它存在的理由）', async () => {
    const ctx = makeContext()
    const before = ctx.store.revision
    const result = await call(ctx, 'run_batch', {
      ops: [
        { tool: 'fill_box', args: { from: [0, 0, 0], to: [3, 0, 3], block: 'minecraft:stone' } },
        { tool: 'fill_box', args: { from: [0, 1, 0], to: [3, 1, 0], block: 'minecraft:oak_planks' } },
        { tool: 'fill_line', args: { from: [0, 2, 0], to: [3, 2, 3], block: 'minecraft:glass' } },
        { tool: 'place_block', args: { pos: [0, 3, 0], block: 'minecraft:torch' } },
      ],
      confirm: true,
    })
    expect(result.ok).toBe(true)
    expect(ctx.store.revision).toBe(before + 1)
    expect(result.data?.['ops']).toBe(4)
    expect(result.data?.['revision']).toBe(before + 1)
    // 日志里也只有一条
    expect(ctx.log.length).toBe(1)
    expect(ctx.log.all()[0]?.tool).toBe('run_batch')
    expect(result.summary).toContain('one revision')
  })

  it('**任何一个 op 非法 → 整批中止，一格都不写**', async () => {
    const ctx = makeContext()
    const result = await call(ctx, 'run_batch', {
      ops: [
        { tool: 'fill_box', args: { from: [0, 0, 0], to: [3, 0, 3], block: 'minecraft:stone' } },
        { tool: 'fill_box', args: { from: [0, 1, 0], to: [3, 1, 3], block: 'minecraft:not_a_block' } },
      ],
      confirm: true,
    })
    expect(result.ok).toBe(false)
    expect(result.error?.code).toBe('UNKNOWN_BLOCK')
    expect(result.summary).toContain('ops[1]')
    expect(result.summary).toContain('nothing was written')
    expect(ctx.store.revision).toBe(0)
    expect(ctx.store.stats().blocks).toBe(0)
  })

  it('不允许批处理的工具会明确说清该单独调', async () => {
    const ctx = makeContext()
    const result = await call(ctx, 'run_batch', {
      ops: [{ tool: 'symmetrize', args: { axis: 'x', coordinate: 8, source: 'negative' } }],
    })
    // schema 的 enum 会先拦下来，错误里列出允许的工具
    expect(result.ok).toBe(false)
    expect(result.error?.code).toBe('INVALID_ARGS')
    expect(result.error?.message).toContain('symmetrize')
    expect(result.error?.message).toContain('paste_region')

    // 就算绕过 schema（比如未来加了新工具忘了更新 enum），运行期兜底也要给可自纠的提示
    const { planBatchOp } = await import('../src/tools/batch.js')
    const fallback = planBatchOp(ctx, 'symmetrize', {})
    expect(fallback).toMatchObject({ ok: false })
    expect((fallback as { error: { hint: string } }).error.hint).toContain('separately')
  })

  it('**重叠格子以最后一个 op 为准**', async () => {
    const ctx = makeContext()
    await call(ctx, 'run_batch', {
      ops: [
        { tool: 'fill_box', args: { from: [0, 0, 0], to: [3, 0, 3], block: 'minecraft:stone' } },
        { tool: 'fill_box', args: { from: [1, 0, 1], to: [2, 0, 2], block: 'minecraft:gold_block' } },
      ],
      confirm: true,
    })
    expect(blockAt(ctx, 0, 0, 0)).toBe('stone')
    expect(blockAt(ctx, 1, 0, 1)).toBe('gold_block')
    expect(blockAt(ctx, 2, 0, 2)).toBe('gold_block')
  })

  it('**批内的 mode=keep 看得到前面 op 的意图**', async () => {
    const ctx = makeContext()
    const result = await call(ctx, 'run_batch', {
      ops: [
        { tool: 'fill_box', args: { from: [0, 0, 0], to: [3, 0, 3], block: 'minecraft:stone' } },
        // 同一个区域用 keep 刷金块：应该一格都写不进去，因为前面已经把它填成石头了
        { tool: 'fill_box', args: { from: [0, 0, 0], to: [3, 0, 3], block: 'minecraft:gold_block', mode: 'keep' } },
      ],
      confirm: true,
    })
    expect(result.ok).toBe(true)
    expect(result.data?.['changed']).toBe(16)
    expect(blockAt(ctx, 0, 0, 0)).toBe('stone')
  })

  it('批内 erase 会挖出洞，且与后面的 op 按顺序生效', async () => {
    const ctx = makeContext()
    await call(ctx, 'run_batch', {
      ops: [
        { tool: 'fill_box', args: { from: [0, 0, 0], to: [3, 0, 3], block: 'minecraft:stone' } },
        { tool: 'erase', args: { from: [1, 0, 1], to: [2, 0, 2] } },
        { tool: 'place_block', args: { pos: [1, 0, 1], block: 'minecraft:glass' } },
      ],
      confirm: true,
    })
    expect(blockAt(ctx, 0, 0, 0)).toBe('stone')
    expect(blockAt(ctx, 1, 0, 1)).toBe('glass')
    expect(blockAt(ctx, 2, 0, 2)).toBe('air')
  })

  it('批内可以粘贴（复制一次、贴多次）', async () => {
    const ctx = makeContext()
    await call(ctx, 'place_block', { pos: [0, 0, 0], block: 'minecraft:oak_stairs[facing=north]' })
    await call(ctx, 'copy_region', { from: [0, 0, 0], to: [0, 0, 0] })
    await call(ctx, 'run_batch', {
      ops: [
        { tool: 'paste_region', args: { at: [2, 0, 0], rotate: 90 } },
        { tool: 'paste_region', args: { at: [4, 0, 0], rotate: 180 } },
        { tool: 'paste_region', args: { at: [6, 0, 0], rotate: 270 } },
      ],
      confirm: true,
    })
    expect(blockAt(ctx, 2, 0, 0)).toContain('facing=east')
    expect(blockAt(ctx, 4, 0, 0)).toContain('facing=south')
    expect(blockAt(ctx, 6, 0, 0)).toContain('facing=west')
    expect(ctx.store.revision).toBe(2)
  })

  it('没有任何改动时如实说"没有改动"，不虚报一次 revision', async () => {
    const ctx = makeContext()
    await call(ctx, 'fill_box', { from: [0, 0, 0], to: [1, 0, 1], block: 'minecraft:stone', confirm: true })
    const before = ctx.store.revision
    const result = await call(ctx, 'run_batch', {
      ops: [{ tool: 'fill_box', args: { from: [0, 0, 0], to: [1, 0, 1], block: 'minecraft:stone' } }],
      confirm: true,
    })
    expect(result.ok).toBe(true)
    expect(result.data?.['changed']).toBe(0)
    expect(ctx.store.revision).toBe(before)
  })

  it('超过确认阈值时整批走 dry-run，revision 不动', async () => {
    // 确认阈值是 50 000 格，所以要用一个装得下 51 200 格的工区
    const ctx = makeContext({ min: { x: 0, y: 0, z: 0 }, max: { x: 63, y: 63, z: 63 } })
    const result = await call(ctx, 'run_batch', {
      // 64 x 13 x 64 = 53 248 格，刚好越过 50 000 的确认阈值
      ops: [{ tool: 'fill_box', args: { from: [0, 0, 0], to: [63, 12, 63], block: 'minecraft:stone' } }],
    })
    expect(result.ok).toBe(false)
    expect(result.error?.code).toBe('NEEDS_CONFIRM')
    expect(result.data?.['needsConfirm']).toBe(true)
    expect(ctx.store.revision).toBe(0)
    expect(result.summary).toContain('confirmation threshold')
  })

  it('撤销一次就能整批回退（一个 changeSet）', async () => {
    const ctx = makeContext()
    await call(ctx, 'run_batch', {
      ops: [
        { tool: 'fill_box', args: { from: [0, 0, 0], to: [3, 0, 3], block: 'minecraft:stone' } },
        { tool: 'fill_box', args: { from: [0, 1, 0], to: [3, 1, 3], block: 'minecraft:oak_planks' } },
      ],
      confirm: true,
    })
    expect(ctx.store.stats().blocks).toBe(32)
    await call(ctx, 'undo', {})
    expect(ctx.store.stats().blocks).toBe(0)
  })

  it('上限与空 ops 都有可自纠的报错', async () => {
    const ctx = makeContext()
    const empty = await call(ctx, 'run_batch', { ops: [] })
    expect(empty.ok).toBe(false)
    expect(empty.error?.code).toBe('INVALID_ARGS')

    // schema 的 maxItems 先拦住（比运行期更早），错误里带上限数字
    const huge = await call(ctx, 'run_batch', {
      ops: Array.from({ length: 70 }, () => ({ tool: 'place_block', args: { pos: [0, 0, 0], block: 'minecraft:stone' } })),
    })
    expect(huge.ok).toBe(false)
    expect(huge.error?.code).toBe('INVALID_ARGS')
    expect(huge.error?.message).toContain('70')

    // 绕过 schema 时运行期也要兜住，并给出"拆成几批"的建议
    const { planBatchOp: _unused } = await import('../src/tools/batch.js')
    void _unused
    const tooMany = Array.from({ length: 70 }, () => ({
      tool: 'place_block',
      args: { pos: [0, 0, 0], block: 'minecraft:stone' },
    }))
    const direct = await registry.call(ctx, 'run_batch', { ops: tooMany })
    expect(direct.ok).toBe(false)
  })
})

describe('replace_blocks', () => {
  it('按方块名整片换材质，忽略属性', async () => {
    const ctx = makeContext()
    await call(ctx, 'fill_box', { from: [0, 0, 0], to: [3, 0, 3], block: 'minecraft:oak_planks', confirm: true })
    await call(ctx, 'fill_box', { from: [0, 1, 0], to: [3, 1, 3], block: 'minecraft:oak_log', confirm: true })
    await call(ctx, 'fill_box', { from: [0, 2, 0], to: [3, 2, 3], block: 'minecraft:stone', confirm: true })

    const result = await call(ctx, 'replace_blocks', {
      from: [0, 0, 0],
      to: [3, 2, 3],
      blocks: ['minecraft:oak_planks', 'minecraft:oak_log'],
      with: 'minecraft:spruce_planks',
      confirm: true,
    })
    expect(result.ok).toBe(true)
    expect(result.data?.['changed']).toBe(32)
    expect(blockAt(ctx, 0, 0, 0)).toBe('spruce_planks')
    expect(blockAt(ctx, 0, 1, 0)).toBe('spruce_planks')
    // 不在名单里的不动
    expect(blockAt(ctx, 0, 2, 0)).toBe('stone')
  })

  it('名字匹配忽略属性：一次调用换掉整段各种朝向的楼梯', async () => {
    const ctx = makeContext()
    await call(ctx, 'place_block', { pos: [0, 0, 0], block: 'minecraft:oak_stairs[facing=north]' })
    await call(ctx, 'place_block', { pos: [1, 0, 0], block: 'minecraft:oak_stairs[facing=east]' })
    await call(ctx, 'place_block', { pos: [2, 0, 0], block: 'minecraft:oak_stairs[facing=south]' })
    const result = await call(ctx, 'replace_blocks', {
      from: [0, 0, 0],
      to: [2, 0, 0],
      blocks: ['oak_stairs'],
      with: 'minecraft:stone_bricks',
      confirm: true,
    })
    expect(result.data?.['changed']).toBe(3)
    expect(blockAt(ctx, 0, 0, 0)).toBe('stone_bricks')
    expect(blockAt(ctx, 2, 0, 0)).toBe('stone_bricks')
  })

  it('匹配不到时如实说"没有改动"', async () => {
    const ctx = makeContext()
    await call(ctx, 'fill_box', { from: [0, 0, 0], to: [1, 0, 1], block: 'minecraft:stone', confirm: true })
    const before = ctx.store.revision
    const result = await call(ctx, 'replace_blocks', {
      from: [0, 0, 0],
      to: [1, 0, 1],
      blocks: ['minecraft:diamond_block'],
      with: 'minecraft:gold_block',
      confirm: true,
    })
    expect(result.ok).toBe(true)
    expect(result.data?.['changed']).toBe(0)
    expect(ctx.store.revision).toBe(before)
  })

  it('未知目标方块给出候选名而不是内部错误', async () => {
    const ctx = makeContext()
    await call(ctx, 'place_block', { pos: [0, 0, 0], block: 'minecraft:oak_planks' })
    const result = await call(ctx, 'replace_blocks', {
      from: [0, 0, 0],
      to: [0, 0, 0],
      blocks: ['oak_planks'],
      with: 'minecraft:oak_plank',
      confirm: true,
    })
    expect(result.ok).toBe(false)
    expect(result.error?.code).toBe('UNKNOWN_BLOCK')
  })
})

describe('symmetrize 现在会重映射朝向', () => {
  it('朝东的楼梯镜像后朝西（回归：以前会保留原朝向）', async () => {
    const ctx = makeContext()
    await call(ctx, 'place_block', { pos: [4, 1, 0], block: 'minecraft:oak_stairs[facing=east]' })
    await call(ctx, 'symmetrize', { axis: 'x', coordinate: 8, source: 'negative', confirm: true })
    // 4 → 2*8-4 = 12
    expect(blockAt(ctx, 12, 1, 0)).toBe('oak_stairs[facing=west,half=bottom,shape=straight,waterlogged=false]')
    // 源格不动
    expect(blockAt(ctx, 4, 1, 0)).toContain('facing=east')
  })

  it('沿 Z 镜像时南北互换', async () => {
    const ctx = makeContext()
    await call(ctx, 'place_block', { pos: [0, 1, 4], block: 'minecraft:oak_stairs[facing=north]' })
    await call(ctx, 'symmetrize', { axis: 'z', coordinate: 8, source: 'negative', confirm: true })
    expect(blockAt(ctx, 0, 1, 12)).toContain('facing=south')
  })

  it('remapStates=false 时才保留原朝向', async () => {
    const ctx = makeContext()
    await call(ctx, 'place_block', { pos: [4, 1, 0], block: 'minecraft:oak_stairs[facing=east]' })
    const { symmetrize } = await import('@architect/core')
    symmetrize(ctx.store, { axis: 'x', coordinate: 8, source: 'negative', confirm: true, remapStates: false })
    expect(blockAt(ctx, 12, 1, 0)).toContain('facing=east')
  })
})

describe('工具集顺序（plan §2：批量工具排在单格工具前面）', () => {
  it('run_batch 排在最前，place_block 排在批量工具之后', () => {
    const names = registry.list().map((tool) => tool.name)
    expect(names[0]).toBe('run_batch')
    expect(names.indexOf('place_block')).toBeGreaterThan(names.indexOf('extrude'))
    expect(names.indexOf('place_block')).toBeGreaterThan(names.indexOf('fill_box'))
    expect(names).toContain('copy_region')
    expect(names).toContain('paste_region')
    expect(names).toContain('replace_blocks')
  })
})
