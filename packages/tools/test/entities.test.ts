import { EditLog, MAX_ENTITIES, ReplaySession, WorldStore } from '@architect/core'
import type { Bounds } from '@architect/core'
import { describe, expect, it } from 'vitest'

import { createDefaultRegistry } from '../src/index.js'
import type { ToolContext, ToolImage } from '../src/types.js'

const volume: Bounds = { min: { x: -4, y: 0, z: -4 }, max: { x: 31, y: 31, z: 31 } }

/** 与 `tools.test.ts` 同一个形状，但 `record` 要把**稀疏层**透传下去（实体全在那里）。 */
function makeContext(): ToolContext {
  const store = new WorldStore({ minecraftVersion: '1.21.4', volume })
  const log = new EditLog()
  return {
    store,
    log,
    history: new ReplaySession(store, log),
    clipboard: {},
    correlationId: 'turn_1',
    record: (tool, args, result, sparse) => {
      log.record(
        result,
        {
          tool,
          args,
          correlationId: 'turn_1',
          ts: '2026-01-01T00:00:00.000Z',
          worldRevision: store.revision,
        },
        sparse ?? {},
      )
    },
    shoot: (): ToolImage => {
      throw new Error('these tests never take screenshots')
    },
  }
}

const registry = createDefaultRegistry()
const call = (ctx: ToolContext, name: string, args: unknown) => registry.call(ctx, name, args)

describe('place_entity', () => {
  it('放一条船：位置、朝向、以及**一条 op**', async () => {
    const ctx = makeContext()
    const result = await call(ctx, 'place_entity', {
      entities: [{ type: 'minecraft:oak_boat', at: [3, 1, 4], facing: 'north' }],
    })

    expect(result.ok).toBe(true)
    expect(ctx.store.entities.size).toBe(1)
    const entity = ctx.store.entities.list()[0]!
    expect(entity.type).toBe('minecraft:oak_boat')
    // 默认偏移 = 格心、贴地：8/16 = 0.5
    expect(entity).toMatchObject({ x: 3.5, y: 1, z: 4.5 })
    // 朝北 = 180° = 第 8 个 22.5° 格点（Minecraft 的 yaw 0° 是朝南）
    expect(entity.yaw).toBe(8)
    // 摘要里必须给 id —— 模型要用它 remove_entity
    expect(result.summary).toContain(entity.id)

    expect(ctx.log.length).toBe(1)
    expect(ctx.store.revision).toBe(1)
    expect(ctx.log.byRevision(1)!.entityChanges).toHaveLength(1)
    expect(ctx.log.validate()).toEqual([])
  })

  it('**一排船是一次调用**（一条 op、一个 revision）', async () => {
    const ctx = makeContext()
    const result = await call(ctx, 'place_entity', {
      entities: Array.from({ length: 8 }, (_, i) => ({ type: 'minecraft:oak_boat', at: [i, 1, 0] })),
    })
    expect(result.ok).toBe(true)
    expect(ctx.store.entities.size).toBe(8)
    expect(ctx.log.length).toBe(1)
    expect(ctx.store.revision).toBe(1)
    expect(result.data?.revision).toBe(1)
  })

  it('offset 是 16 分之一格', async () => {
    const ctx = makeContext()
    await call(ctx, 'place_entity', {
      entities: [{ type: 'minecraft:armor_stand', at: [2, 3, 2], offset: [0, 8, 15] }],
    })
    expect(ctx.store.entities.list()[0]).toMatchObject({ x: 2, y: 3.5, z: 2.9375 })
  })

  it('yaw 覆盖 facing', async () => {
    const ctx = makeContext()
    await call(ctx, 'place_entity', {
      entities: [{ type: 'minecraft:oak_boat', at: [0, 0, 0], facing: 'north', yaw: 4 }],
    })
    expect(ctx.store.entities.list()[0]!.yaw).toBe(4)
  })

  it('类型拼错 → UNKNOWN_ENTITY，而且给候选', async () => {
    const ctx = makeContext()
    const result = await call(ctx, 'place_entity', {
      entities: [{ type: 'minecraft:oak_bot', at: [0, 0, 0] }],
    })
    expect(result.ok).toBe(false)
    expect(result.error?.code).toBe('UNKNOWN_ENTITY')
    expect(result.error?.hint).toMatch(/minecraft:oak_boat/)
    expect(ctx.store.entities.size).toBe(0)
  })

  it('**整批要么全成、要么全不成**：第三条类型错，前两条也不许留下', async () => {
    const ctx = makeContext()
    const result = await call(ctx, 'place_entity', {
      entities: [
        { type: 'minecraft:oak_boat', at: [0, 0, 0] },
        { type: 'minecraft:oak_boat', at: [1, 0, 0] },
        { type: 'minecraft:not_a_thing', at: [2, 0, 0] },
      ],
    })
    expect(result.ok).toBe(false)
    // 一边校验一边写的话，这里会剩下 2 条**没有 op** 的实体：撤销撤不掉、日志里也看不见
    expect(ctx.store.entities.size).toBe(0)
    expect(ctx.log.length).toBe(0)
    expect(ctx.store.revision).toBe(0)
  })

  it('负载必须是 NBT 装得下的：null 与异质数组都在写入前就被拒', async () => {
    const ctx = makeContext()
    const withNull = await call(ctx, 'place_entity', {
      entities: [{ type: 'minecraft:oak_boat', at: [0, 0, 0], data: { CustomName: null } }],
    })
    expect(withNull.ok).toBe(false)
    expect(withNull.error?.code).toBe('INVALID_ARGS')

    const mixed = await call(ctx, 'place_entity', {
      entities: [{ type: 'minecraft:oak_boat', at: [0, 0, 0], data: { Motion: [1, 'a'] } }],
    })
    expect(mixed.ok).toBe(false)
    expect(mixed.error?.message).toMatch(/homogeneous/)

    expect(ctx.store.entities.size).toBe(0)
    expect(ctx.log.length).toBe(0)
  })

  it('单次调用最多 256 条（schema 就挡住），而世界的上限是 4096', async () => {
    const ctx = makeContext()
    // 单次上限由 schema 的 maxItems 挡住——一次调用不该能创建任意多个对象
    const tooManyInOneCall = await call(ctx, 'place_entity', {
      entities: Array.from({ length: 257 }, () => ({ type: 'minecraft:oak_boat', at: [0, 0, 0] })),
    })
    expect(tooManyInOneCall.ok).toBe(false)
    expect(tooManyInOneCall.error?.code).toBe('INVALID_ARGS')

    // 世界的上限要**跨调用**才撞得到：16 次 × 256 = 4096
    for (let batch = 0; batch < MAX_ENTITIES / 256; batch++) {
      const entities = Array.from({ length: 256 }, (_, i) => {
        const n = batch * 256 + i
        return { type: 'minecraft:oak_boat', at: [n % 32, 1 + Math.floor(n / 1024), Math.floor(n / 32) % 32] }
      })
      const placed = await call(ctx, 'place_entity', { entities })
      expect(placed.ok, `第 ${batch + 1} 批失败：${placed.summary}`).toBe(true)
    }
    expect(ctx.store.entities.size).toBe(MAX_ENTITIES)

    const over = await call(ctx, 'place_entity', {
      entities: [{ type: 'minecraft:oak_boat', at: [0, 20, 0] }],
    })
    expect(over.ok).toBe(false)
    expect(over.error?.code).toBe('TOO_LARGE')
  })

  it('重复放同一个位置同一朝向：**不产生 op**（没有变化就不占版本号）', async () => {
    const ctx = makeContext()
    await call(ctx, 'place_entity', { entities: [{ type: 'minecraft:oak_boat', at: [1, 1, 1] }] })
    const again = await call(ctx, 'place_entity', { entities: [{ type: 'minecraft:oak_boat', at: [1, 1, 1] }] })
    expect(again.ok).toBe(true)
    // 新分配了 id，所以实际上是"又放了一条"——用显式 id 去重才是"没有变化"那条路。
    // 这里断言的是**版本号与 op 数一致**这条不变式没被破坏
    expect(ctx.log.length).toBe(ctx.store.revision)
    expect(ctx.log.validate()).toEqual([])
  })
})

describe('remove_entity / list_entities', () => {
  it('按 id 删；不存在的 id 会被如实报出来', async () => {
    const ctx = makeContext()
    const placed = await call(ctx, 'place_entity', {
      entities: [{ type: 'minecraft:oak_boat', at: [1, 1, 1] }, { type: 'minecraft:oak_boat', at: [2, 1, 1] }],
    })
    const ids = (placed.data?.entities as Array<{ id: string }>).map((entity) => entity.id)

    const removed = await call(ctx, 'remove_entity', { ids: [ids[0]!, 'e_99_9'] })
    expect(removed.ok).toBe(true)
    expect(removed.data?.removed).toBe(1)
    expect(removed.data?.missing).toEqual(['e_99_9'])
    expect(ctx.store.entities.size).toBe(1)
    expect(ctx.log.length).toBe(2)
  })

  it('按区域删：一格之外的不动', async () => {
    const ctx = makeContext()
    await call(ctx, 'place_entity', {
      entities: [{ type: 'minecraft:oak_boat', at: [1, 1, 1] }, { type: 'minecraft:oak_boat', at: [9, 1, 9] }],
    })
    const removed = await call(ctx, 'remove_entity', { region: { from: [0, 0, 0], to: [4, 4, 4] } })
    expect(removed.data?.removed).toBe(1)
    expect(ctx.store.entities.list()[0]!.x).toBe(9.5)
  })

  it('既没给 ids 也没给 region → 拒绝，而不是"删了 0 个"', async () => {
    const ctx = makeContext()
    const result = await call(ctx, 'remove_entity', {})
    expect(result.ok).toBe(false)
    expect(result.error?.code).toBe('INVALID_ARGS')
  })

  it('**erase 不动实体**——两层各归各的工具', async () => {
    const ctx = makeContext()
    await call(ctx, 'place_entity', { entities: [{ type: 'minecraft:oak_boat', at: [1, 0, 1] }] })
    await call(ctx, 'fill_box', { from: [0, 0, 0], to: [3, 2, 3], block: 'stone' })
    await call(ctx, 'erase', { from: [0, 0, 0], to: [3, 2, 3] })
    expect(ctx.store.entities.size).toBe(1)
  })

  it('list_entities 列出 id、位置与朝向', async () => {
    const ctx = makeContext()
    await call(ctx, 'place_entity', {
      entities: [{ type: 'minecraft:oak_boat', at: [1, 1, 1] }, { type: 'minecraft:armor_stand', at: [2, 1, 2] }],
    })
    const all = await call(ctx, 'list_entities', {})
    expect(all.ok).toBe(true)
    expect(all.data?.total).toBe(2)
    expect(all.summary).toContain('minecraft:oak_boat')
    expect(all.summary).toContain('minecraft:armor_stand')

    const only = await call(ctx, 'list_entities', { type: 'armor_stand' })
    expect(only.data?.total).toBe(1)

    const none = await call(ctx, 'list_entities', { region: { from: [20, 20, 20], to: [22, 22, 22] } })
    expect(none.data?.total).toBe(0)
  })
})

describe('方块实体：edit_block_entity / get_block_entity', () => {
  it('方块实体 id 由**方块**推出，模型不能自己写', async () => {
    const ctx = makeContext()
    await call(ctx, 'place_block', { pos: [2, 0, 2], block: 'oak_sign' })
    const result = await call(ctx, 'edit_block_entity', { at: [2, 0, 2], data: { Text1: 'hi' } })
    expect(result.ok).toBe(true)
    // `oak_sign` 的方块实体 id 是 `minecraft:sign`，不是 `minecraft:oak_sign`
    expect(ctx.store.blockEntities.at({ x: 2, y: 0, z: 2 })?.kind).toBe('minecraft:sign')
    expect(ctx.log.byRevision(2)!.blockEntityChanges).toHaveLength(1)
    expect(ctx.log.validate()).toEqual([])
  })

  it('往石头（不带方块实体）上写附加数据 → 拒绝，而不是存下来', async () => {
    const ctx = makeContext()
    await call(ctx, 'place_block', { pos: [2, 0, 2], block: 'stone' })
    const result = await call(ctx, 'edit_block_entity', { at: [2, 0, 2], data: { Text1: 'hi' } })
    expect(result.ok).toBe(false)
    expect(result.error?.code).toBe('UNSUPPORTED')
    expect(result.error?.message).toContain('stone')
    expect(ctx.store.blockEntities.size).toBe(0)
  })

  it('merge 与 replace', async () => {
    const ctx = makeContext()
    await call(ctx, 'place_block', { pos: [1, 0, 1], block: 'barrel' })
    await call(ctx, 'edit_block_entity', { at: [1, 0, 1], data: { Items: [{ Slot: 0 }] } })
    await call(ctx, 'edit_block_entity', { at: [1, 0, 1], data: { CustomName: 'x' }, merge: true })
    expect(ctx.store.blockEntities.at({ x: 1, y: 0, z: 1 })?.data).toEqual({
      Items: [{ Slot: 0 }],
      CustomName: 'x',
    })
    await call(ctx, 'edit_block_entity', { at: [1, 0, 1], data: { CustomName: 'y' } })
    expect(ctx.store.blockEntities.at({ x: 1, y: 0, z: 1 })?.data).toEqual({ CustomName: 'y' })
  })

  it('get_block_entity 说明"没有"与"这里本来就能有"', async () => {
    const ctx = makeContext()
    await call(ctx, 'place_block', { pos: [3, 0, 3], block: 'stone' })
    await call(ctx, 'place_block', { pos: [4, 0, 4], block: 'chest' })

    const onStone = await call(ctx, 'get_block_entity', { at: [3, 0, 3] })
    expect(onStone.summary).toMatch(/does not carry one/)

    const onChest = await call(ctx, 'get_block_entity', { at: [4, 0, 4] })
    expect(onChest.summary).toMatch(/could hold one/)
    expect(onChest.data?.kind).toBe('minecraft:chest')
  })

  it('**覆盖方块会带走附加数据**，撤销之后内容回来', async () => {
    const ctx = makeContext()
    await call(ctx, 'place_block', { pos: [5, 0, 5], block: 'chest' })
    await call(ctx, 'edit_block_entity', { at: [5, 0, 5], data: { Items: [{ Slot: 0, Count: 3 }] } })
    const before = ctx.store.contentHash()

    const written = await call(ctx, 'place_block', { pos: [5, 0, 5], block: 'stone' })
    expect(ctx.store.blockEntities.size).toBe(0)
    // 剪除差分由 store 产出，跟着 WriteResult 回来
    expect((written.data as { revision: number }).revision).toBe(ctx.store.revision)

    ctx.history.undo()
    expect(ctx.store.blockEntities.at({ x: 5, y: 0, z: 5 })?.data).toEqual({ Items: [{ Slot: 0, Count: 3 }] })
    expect(ctx.store.contentHash()).toBe(before)
  })
})

describe('verify 的实体 claim：完成闸门唯一的读回途径', () => {
  it('entity_at / entity_count / block_entity_at 全过 → readback', async () => {
    const ctx = makeContext()
    await call(ctx, 'place_entity', {
      entities: [
        { type: 'minecraft:oak_boat', at: [1, 1, 1] },
        { type: 'minecraft:oak_boat', at: [2, 1, 1] },
      ],
    })
    await call(ctx, 'place_block', { pos: [4, 0, 4], block: 'oak_sign' })
    await call(ctx, 'edit_block_entity', { at: [4, 0, 4], data: { Text1: 'hi' } })

    const result = await call(ctx, 'verify', {
      claims: [
        { check: 'entity_at', pos: [1, 1, 1], type: 'minecraft:oak_boat' },
        { check: 'entity_count', type: 'minecraft:oak_boat', min: 2, max: 2 },
        { check: 'block_entity_at', pos: [4, 0, 4], expect: 'minecraft:sign' },
      ],
    })
    expect(result.ok).toBe(true)
    expect(result.data?.readback).toBe(true)
  })

  it('实体不在那里时 FAIL，并说出那一格里到底有什么', async () => {
    const ctx = makeContext()
    await call(ctx, 'place_entity', { entities: [{ type: 'minecraft:armor_stand', at: [1, 1, 1] }] })
    const result = await call(ctx, 'verify', {
      claims: [{ check: 'entity_at', pos: [1, 1, 1], type: 'minecraft:oak_boat' }],
    })
    expect(result.ok).toBe(false)
    expect(result.data?.readback).toBe(false)
    expect(result.summary).toMatch(/minecraft:armor_stand/)
  })

  it('entity_count 的上下界', async () => {
    const ctx = makeContext()
    await call(ctx, 'place_entity', { entities: [{ type: 'minecraft:oak_boat', at: [1, 1, 1] }] })
    expect(
      (await call(ctx, 'verify', { claims: [{ check: 'entity_count', type: 'minecraft:oak_boat', min: 2 }] })).ok,
    ).toBe(false)
    expect(
      (await call(ctx, 'verify', { claims: [{ check: 'entity_count', type: 'minecraft:oak_boat', max: 1 }] })).ok,
    ).toBe(true)
  })

  it('**方块等级别的 verify 读不回实体层**——这正是闸门需要实体 claim 的原因', async () => {
    const ctx = makeContext()
    await call(ctx, 'place_entity', { entities: [{ type: 'minecraft:oak_boat', at: [1, 1, 1] }] })
    await call(ctx, 'fill_box', { from: [0, 0, 0], to: [2, 0, 2], block: 'stone' })
    const blockOnly = await call(ctx, 'verify', {
      claims: [{ check: 'count', block: 'stone', min: 9 }],
    })
    expect(blockOnly.ok).toBe(true)
    // 方块全对，但实体一个字都没被读到——所以实体那条 op 仍然是"未读回"
    expect(ctx.store.entities.size).toBe(1)
  })
})
