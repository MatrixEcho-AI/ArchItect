import { describe, expect, it } from 'vitest'

import { canonicalJson } from '../src/entity/canonical.js'
import { BlockEntityStore, MAX_BLOCK_ENTITIES } from '../src/entity/blockentities.js'
import { EntityStore, MAX_ENTITIES } from '../src/entity/store.js'
import { invertChanges } from '../src/entity/types.js'
import type { EntityChange, PlacedBlockEntity, PlacedEntity } from '../src/entity/types.js'
import { decodeEditOp, EditLog, encodeEditOp } from '../src/history/log.js'
import type { EditOpRecord } from '../src/history/editop.js'
import { ReplaySession, verifyReplay } from '../src/history/replay.js'
import { ChangeSet } from '../src/world/changeset.js'
import { WorldStore } from '../src/world/store.js'
import type { Bounds, Pos } from '../src/types.js'

const volume: Bounds = { min: { x: -8, y: 0, z: -8 }, max: { x: 24, y: 24, z: 24 } }
const makeStore = (): WorldStore => new WorldStore({ minecraftVersion: '1.21.4', volume })

/**
 * 那一格的方块名。
 *
 * `getBlockString` 给的是带属性的规范串（`minecraft:chest[facing=north,…]`），
 * 而 `minecraft-data` 的 `blockByStateId().name` 是**不带命名空间**的短名——
 * 两边都不是裸 id，断起来要看清用的是哪一个。
 */
const blockName = (store: WorldStore, pos: Pos): string | undefined =>
  store.registry.blockByStateId(store.getBlockStateId(pos))?.name

const boat = (id: string, x = 3.5, y = 1, z = 4.5): PlacedEntity => ({
  id,
  type: 'minecraft:oak_boat',
  x,
  y,
  z,
  yaw: 8,
})

const chest = (x: number, y: number, z: number): PlacedBlockEntity => ({
  x,
  y,
  z,
  kind: 'chest',
  data: { items: [{ slot: 0, id: 'minecraft:diamond', count: 3 }] },
})

/** 把当前世界当成 rev 0 的基准——打开工程时 `restoreColumns(…, 0)` 就是这么做的。 */
const asBase = (store: WorldStore): void => store.setRevision(0)

describe('EntityStore：实体层的存取与差分', () => {
  it('set 产出新增差分；同样的内容再 set 一次不再产出', () => {
    const store = new EntityStore()
    const change = store.set(boat('e_1_1'))
    expect(change?.key).toBe('e_1_1')
    expect(change?.before).toBeUndefined()
    expect(change?.after).toEqual(boat('e_1_1'))
    expect(store.size).toBe(1)
    // "没有变化就不产出差分"是 contentHash 稳定与"空操作不占版本号"的共同前提
    expect(store.set(boat('e_1_1'))).toBeUndefined()
  })

  it('改了位置之后旧格上不再看得见它（位置索引必须跟着摘）', () => {
    const store = new EntityStore()
    store.set(boat('e_1_1', 3.5, 1, 4.5))
    expect(store.at({ x: 3, y: 1, z: 4 })).toHaveLength(1)
    store.set(boat('e_1_1', 9.5, 1, 4.5))
    expect(store.at({ x: 3, y: 1, z: 4 })).toHaveLength(0)
    expect(store.at({ x: 9, y: 1, z: 4 })).toHaveLength(1)
    expect(store.at({ x: 9, y: 1, z: 4 })[0]!.x).toBe(9.5)
  })

  it('一格可以叠多个实体，而且 at() 与 inBounds() 用同一个口径', () => {
    const store = new EntityStore()
    store.set(boat('e_1_1', 3.5, 1, 4.5))
    store.set(boat('e_1_2', 3.25, 1.5, 4.75))
    expect(store.at({ x: 3, y: 1, z: 4 })).toHaveLength(2)
    const cell: Bounds = { min: { x: 3, y: 1, z: 4 }, max: { x: 3, y: 1, z: 4 } }
    expect(store.inBounds(cell)).toHaveLength(2)
    // 一格之外就选不中了——区域选择与按格查询必须给出同样的答案
    expect(store.inBounds({ min: { x: 0, y: 0, z: 0 }, max: { x: 2, y: 2, z: 2 } })).toHaveLength(0)
  })

  it('remove 产出删除差分；删一个不存在的 id 什么都不产出', () => {
    const store = new EntityStore()
    store.set(boat('e_1_1'))
    const removed = store.remove('e_1_1')
    expect(removed?.key).toBe('e_1_1')
    expect(removed?.before?.id).toBe('e_1_1')
    expect(removed?.after).toBeUndefined()
    expect(store.size).toBe(0)
    expect(store.remove('e_1_1')).toBeUndefined()
  })

  it('removeInBounds 一次删掉一片', () => {
    const store = new EntityStore()
    store.set(boat('e_1_1', 1.5, 1, 1.5))
    store.set(boat('e_1_2', 2.5, 1, 2.5))
    store.set(boat('e_1_3', 9.5, 1, 9.5))
    const removed = store.removeInBounds({ min: { x: 0, y: 0, z: 0 }, max: { x: 4, y: 4, z: 4 } })
    expect(removed).toHaveLength(2)
    expect(store.list().map((e) => e.id)).toEqual(['e_1_3'])
  })

  it('applyChanges 与 set/remove 等价，而且可以重复应用（幂等）', () => {
    const viaSetter = new EntityStore()
    viaSetter.set(boat('e_1_1'))
    viaSetter.set(boat('e_1_2', 8.5, 2, 9.5))
    viaSetter.remove('e_1_1')

    const viaChanges = new EntityStore()
    const changes: EntityChange[] = [
      { key: 'e_1_1', after: boat('e_1_1') },
      { key: 'e_1_2', after: boat('e_1_2', 8.5, 2, 9.5) },
      { key: 'e_1_1', before: boat('e_1_1') },
    ]
    viaChanges.applyChanges(changes)
    viaChanges.applyChanges(changes) // 重放路径会这么做，不该改变任何东西
    expect(viaChanges.toJSON()).toEqual(viaSetter.toJSON())
  })

  it('差分里 key 与 after.id 不一致时拒绝应用', () => {
    const store = new EntityStore()
    expect(() => store.applyChanges([{ key: 'e_1_9', after: boat('e_1_1') }])).toThrow(/does not match/)
  })

  it('invertChanges 就是交换 before/after，撤销不需要任何额外记账', () => {
    const forward: EntityChange[] = [
      { key: 'e_1_1', after: boat('e_1_1') },
      { key: 'e_1_2', before: boat('e_1_2'), after: boat('e_1_2', 9.5, 1, 9.5) },
      { key: 'e_1_3', before: boat('e_1_3') },
    ]
    const store = new EntityStore()
    store.set(boat('e_1_2'))
    store.set(boat('e_1_3'))
    const before = store.toJSON()
    store.applyChanges(forward)
    expect(store.toJSON()).not.toEqual(before)
    store.applyChanges(invertChanges(forward))
    expect(store.toJSON()).toEqual(before)
  })

  it('id 由写入方分配，而且会跳过已经被占用的号', () => {
    const store = new EntityStore()
    expect(store.allocateId(3)).toBe('e_3_1')
    expect(store.allocateId(3)).toBe('e_3_2')
    store.set(boat('e_3_3'))
    expect(store.allocateId(3)).toBe('e_3_4')
    // revision 一变就从 1 重新开始（截断分叉之后不该复用旧号）
    expect(store.allocateId(4)).toBe('e_4_1')
  })

  it('超过上限时拒绝，而不是把内存吃光', () => {
    const store = new EntityStore()
    const many: PlacedEntity[] = []
    for (let i = 0; i < MAX_ENTITIES; i++) many.push(boat(`e_1_${i}`))
    store.fromJSON(many)
    expect(store.size).toBe(MAX_ENTITIES)
    expect(() => store.set(boat('e_1_overflow'))).toThrow(/over the/)
    expect(() => store.fromJSON([...many, boat('e_1_overflow')])).toThrow(/over the/)
  })

  it('toJSON/fromJSON 往返之后哈希不变', () => {
    const store = new EntityStore()
    store.set(boat('e_1_1'))
    store.set({ ...boat('e_1_2', 8.5, 2, 9.5), data: { passengers: [{ type: 'minecraft:pig' }] } })
    const reopened = new EntityStore()
    reopened.fromJSON(store.toJSON())
    expect(reopened.toJSON()).toEqual(store.toJSON())
  })
})

describe('canonicalJson：哈希要确定性', () => {
  it('对象键序不影响结果，undefined 值的键被丢掉', () => {
    expect(canonicalJson({ b: 1, a: 2 })).toBe(canonicalJson({ a: 2, b: 1 }))
    expect(canonicalJson({ a: 2, b: undefined })).toBe(canonicalJson({ a: 2 }))
    expect(canonicalJson({ a: [3, 1] })).not.toBe(canonicalJson({ a: [1, 3] })) // 数组是有序的
  })

  it('实体的 data 只有键序不同时，世界哈希相同；值一变就不同', () => {
    const a = makeStore()
    const b = makeStore()
    a.entities.set({ ...boat('e_1_1'), data: { item: 'minecraft:oak_planks', count: 3 } })
    b.entities.set({ ...boat('e_1_1'), data: { count: 3, item: 'minecraft:oak_planks' } })
    expect(a.contentHash()).toBe(b.contentHash())
    b.entities.set({ ...boat('e_1_1'), data: { count: 4, item: 'minecraft:oak_planks' } })
    expect(a.contentHash()).not.toBe(b.contentHash())
  })
})

describe('BlockEntityStore：方块实体层', () => {
  it('一格最多一个；同样的内容再 set 一次不产出差分', () => {
    const store = new BlockEntityStore()
    const sign: PlacedBlockEntity = { x: 2, y: 3, z: 4, kind: 'sign', data: { text: 'ArchItect' } }
    const change = store.set(sign)
    expect(change?.key).toBe('2,3,4')
    expect(change?.before).toBeUndefined()
    expect(store.size).toBe(1)
    expect(store.set(sign)).toBeUndefined()
    expect(store.at({ x: 2, y: 3, z: 4 })?.kind).toBe('sign')
  })

  it('removeAt 直接吃坐标，不必先造一个 Pos 对象（剪除在热路径上）', () => {
    const store = new BlockEntityStore()
    store.set(chest(1, 2, 3))
    const change = store.removeAt(1, 2, 3)
    expect(change?.before?.kind).toBe('chest')
    expect(store.has({ x: 1, y: 2, z: 3 })).toBe(false)
    expect(store.removeAt(1, 2, 3)).toBeUndefined()
  })

  it('list 是数值序（y → z → x），哈希的确定性靠它', () => {
    const store = new BlockEntityStore()
    store.set(chest(9, 0, 0))
    store.set(chest(1, 2, 0))
    store.set(chest(10, 0, 0))
    store.set(chest(2, 2, 0))
    expect(store.list().map((e) => `${e.y}:${e.x}`)).toEqual(['0:9', '0:10', '2:1', '2:2'])
  })

  it('应用差分时 key 与坐标不一致会被拒绝', () => {
    const store = new BlockEntityStore()
    expect(() => store.applyChanges([{ key: '0,0,0', after: chest(1, 1, 1) }])).toThrow(/does not match/)
  })

  it('超过上限时拒绝', () => {
    const store = new BlockEntityStore()
    const many: PlacedBlockEntity[] = []
    for (let i = 0; i < MAX_BLOCK_ENTITIES + 1; i++) many.push(chest(i, 0, 0))
    expect(() => store.fromJSON(many)).toThrow(/over the/)
  })
})

describe('WorldStore：方块实体的剪除必须由 store 产出', () => {
  it('覆盖一个箱子会带出剪除差分，而且内容完整地留在 before 里', () => {
    const store = makeStore()
    store.setBlock({ x: 2, y: 1, z: 2 }, 'minecraft:chest')
    const contents = chest(2, 1, 2)
    store.blockEntities.set(contents)

    const write = store.writeBlocks((emit) => emit(2, 1, 2, store.palette.indexOf('minecraft:stone')), {
      confirm: true,
    })
    expect(write.ok).toBe(true)
    if (!write.ok) return
    expect(write.blockEntityChanges).toHaveLength(1)
    expect(write.blockEntityChanges[0]!.before).toEqual(contents)
    expect(write.blockEntityChanges[0]!.after).toBeUndefined()
    expect(store.blockEntities.size).toBe(0)
  })

  it('被拒绝的写入（NEEDS_CONFIRM）不许有副作用：箱子与内容都不动', () => {
    const store = makeStore()
    store.setBlock({ x: 2, y: 1, z: 2 }, 'minecraft:chest')
    store.blockEntities.set(chest(2, 1, 2))

    const write = store.writeBlocks((emit) => emit(2, 1, 2, store.palette.indexOf('minecraft:stone')), {
      confirmThreshold: 0,
    })
    expect(write.ok).toBe(false)
    expect(store.blockEntities.size).toBe(1)
    expect(blockName(store, { x: 2, y: 1, z: 2 })).toBe('chest')
  })

  it('把同一个方块重写一遍不算改动，所以不会清空箱子内容', () => {
    const store = makeStore()
    store.setBlock({ x: 2, y: 1, z: 2 }, 'minecraft:chest')
    store.blockEntities.set(chest(2, 1, 2))
    const write = store.writeBlocks((emit) => emit(2, 1, 2, store.palette.indexOf('minecraft:chest')), {
      confirm: true,
    })
    expect(write.ok).toBe(true)
    if (!write.ok) return
    expect(write.changed).toBe(0)
    expect(write.blockEntityChanges).toHaveLength(0)
    expect(store.blockEntities.size).toBe(1)
  })

  it('世界上没有方块实体时走零成本快路径（多格写入不产出任何剪除差分）', () => {
    const store = makeStore()
    const stone = store.palette.indexOf('minecraft:stone')
    const write = store.writeBlocks((emit) => {
      for (let x = 0; x < 8; x++) emit(x, 0, 0, stone)
    }, { confirm: true })
    expect(write.ok).toBe(true)
    if (!write.ok) return
    expect(write.changed).toBe(8)
    expect(write.blockEntityChanges).toEqual([])
  })
})

describe('P1 验收：三条不变式', () => {
  it('① 只放一条船、一个方块都不动，日志也必须真的多一条 op', () => {
    const store = makeStore()
    const log = new EditLog()

    const id = store.entities.allocateId(store.revision + 1)
    const change = store.entities.set(boat(id))!
    const revision = store.commitEntities([change])

    // 这一笔没有方块写入，所以 WriteResult 传 undefined（不是造一个空结果占位）
    const op = log.record(
      undefined,
      {
        tool: 'place_entity',
        args: { entities: [{ type: 'minecraft:oak_boat', at: [3, 1, 4] }] },
        worldRevision: revision,
      },
      { entities: [change] },
    )

    expect(op).toBeDefined()
    expect(log.length).toBe(1)
    expect(revision).toBe(1)
    expect(op!.patch.length).toBe(0) // 空 patch，但字段必须在（D-78）
    expect(op!.result.changed).toBe(0)
    expect(op!.entityChanges).toHaveLength(1)
    expect(op!.result.entitiesChanged).toBe(1)
    expect(log.validate()).toEqual([])
  })

  it('① 补：三层都空时才不记 op，空写入不占版本号', () => {
    const store = makeStore()
    const log = new EditLog()
    expect(log.record(undefined, { tool: 'place_entity', args: {} })).toBeUndefined()
    const noop = store.writeBlocks(() => {}, {})
    expect(log.record(noop, { tool: 'noop', args: {} })).toBeUndefined()
    expect(log.length).toBe(0)
    expect(store.revision).toBe(0)
  })

  it('① 补：实体写入会推进版本号，否则 record 的游标校验会当场抛错', () => {
    const store = makeStore()
    const log = new EditLog()
    const change = store.entities.set(boat('e_1_1'))!
    // 忘了 commitEntities → 版本号没动，日志却要 +1
    expect(() =>
      log.record(undefined, { tool: 'place_entity', args: {}, worldRevision: store.revision }, { entities: [change] }),
    ).toThrow(/游标与日志脱节/)
  })

  it('② 覆盖一个装满东西的箱子，撤销之后内容还在', () => {
    const store = makeStore()
    const log = new EditLog()

    // rev 0 的基准：一个箱子 + 它里面的东西（等价于从 .schem 导入进来的内容）
    store.setBlock({ x: 2, y: 1, z: 2 }, 'minecraft:chest')
    const contents = chest(2, 1, 2)
    store.blockEntities.set(contents)
    asBase(store)

    // rev 1：往箱子上糊石头。**差分是 store 产出的**——工具层根本不知道
    // 那个格子上原本挂着一个装满东西的箱子
    const write = store.writeBlocks((emit) => emit(2, 1, 2, store.palette.indexOf('minecraft:stone')), {
      confirm: true,
    })
    expect(write.ok).toBe(true)
    if (!write.ok) return
    expect(write.blockEntityChanges).toHaveLength(1)
    expect(store.blockEntities.size).toBe(0)

    const op = log.record(write, { tool: 'place_block', args: {}, worldRevision: store.revision })!
    expect(op.blockEntityChanges).toHaveLength(1)

    // 撤销 = 游标退回 rev 0
    const session = new ReplaySession(store, log)
    session.undo()
    expect(session.revision).toBe(0)
    expect(blockName(store, { x: 2, y: 1, z: 2 })).toBe('chest')
    expect(store.blockEntities.at({ x: 2, y: 1, z: 2 })).toEqual(contents)

    // 重做 = 游标前进一格，东西又没了
    session.redo()
    expect(session.revision).toBe(1)
    expect(store.blockEntities.size).toBe(0)
  })

  it('③ 方块一模一样、只有实体不同时，verifyReplay 必须失败', () => {
    const store = makeStore()
    const log = new EditLog()
    store.setBlock({ x: 0, y: 0, z: 0 }, 'minecraft:stone')
    asBase(store)
    // 世界里有条船，但日志里没有记这一笔——正是"实体不进 op"那个 bug 的样子
    store.entities.set(boat('e_1_1'))

    const verdict = verifyReplay(store, log, makeStore())
    expect(verdict.ok).toBe(false)
    expect(verdict.liveHash).not.toBe(verdict.replayedHash)
  })

  it('③ 补：实体进了 op 之后重放一致；方块实体也一样', () => {
    const store = makeStore()
    const log = new EditLog()

    // rev 0 基准：一个箱子
    store.setBlock({ x: 2, y: 1, z: 2 }, 'minecraft:chest')
    store.blockEntities.set(chest(2, 1, 2))
    asBase(store)

    // op 1：放一条船
    const change = store.entities.set({ ...boat('e_1_1'), data: { variant: 'oak' } })!
    log.record(
      undefined,
      { tool: 'place_entity', args: {}, worldRevision: store.commitEntities([change]) },
      { entities: [change] },
    )

    // op 2：把箱子糊掉
    const write = store.writeBlocks((emit) => emit(2, 1, 2, store.palette.indexOf('minecraft:stone')), {
      confirm: true,
    })
    log.record(write, { tool: 'place_block', args: {}, worldRevision: store.revision })

    const verdict = verifyReplay(store, log, makeStore())
    expect(verdict.ok).toBe(true)
    expect(verdict.revision).toBe(2)
    expect(log.validate()).toEqual([])
  })

  it('三层一起在时间线上来回走，每个版本的哈希都对得上', () => {
    const store = makeStore()
    const log = new EditLog()
    store.setBlock({ x: 2, y: 1, z: 2 }, 'minecraft:chest')
    store.blockEntities.set(chest(2, 1, 2))
    asBase(store)

    const first = store.entities.set(boat('e_1_1'))!
    log.record(
      undefined,
      { tool: 'place_entity', args: {}, worldRevision: store.commitEntities([first]) },
      { entities: [first] },
    )
    const second = store.entities.set(boat('e_2_1', 6.5, 1, 6.5))!
    log.record(
      undefined,
      { tool: 'place_entity', args: {}, worldRevision: store.commitEntities([second]) },
      { entities: [second] },
    )
    const write = store.writeBlocks((emit) => emit(2, 1, 2, store.palette.indexOf('minecraft:stone')), {
      confirm: true,
    })
    log.record(write, { tool: 'place_block', args: {}, worldRevision: store.revision })

    // 记下每个版本的哈希，再从头走一遍，必须逐个对上
    const session = new ReplaySession(store, log)
    const hashes: string[] = []
    for (let rev = 0; rev <= log.length; rev++) {
      session.seek(rev)
      hashes.push(store.contentHash())
    }
    expect(new Set(hashes).size).toBe(hashes.length) // 三个版本互不相同

    for (let rev = log.length; rev >= 0; rev--) {
      session.seek(rev)
      expect(store.contentHash(), `rev ${rev} 对不上`).toBe(hashes[rev])
    }
    // 回到 rev 0 就回到了基准：箱子在、内容在、两条船都不在
    session.seek(0)
    expect(store.blockEntities.at({ x: 2, y: 1, z: 2 })).toEqual(chest(2, 1, 2))
    expect(store.entities.size).toBe(0)
  })
})

describe('EditOp 的磁盘形态：两层稀疏差分', () => {
  const baseRecord = (overrides: Partial<EditOpRecord> = {}): EditOpRecord => ({
    id: 'op_000001',
    rev: 1,
    ts: '2026-01-01T00:00:00.000Z',
    source: 'llm',
    actor: 'assistant',
    tool: 'fill_box',
    args: {},
    result: { changed: 0, overwrittenNonAir: 0, clipped: 0 },
    patch: new ChangeSet(1).toBuffer().toString('base64'),
    ...overrides,
  })

  it('encode/decode 保留两层差分', () => {
    const store = makeStore()
    const log = new EditLog()
    store.setBlock({ x: 2, y: 1, z: 2 }, 'minecraft:chest')
    store.blockEntities.set(chest(2, 1, 2))
    asBase(store)

    const entities = [store.entities.set(boat('e_1_1'))!]
    log.record(
      undefined,
      { tool: 'place_entity', args: {}, worldRevision: store.commitEntities(entities) },
      { entities },
    )
    const write = store.writeBlocks((emit) => emit(2, 1, 2, store.palette.indexOf('minecraft:stone')), {
      confirm: true,
    })
    log.record(write, { tool: 'place_block', args: {}, worldRevision: store.revision })

    const rebuild = new EditLog()
    for (const op of [log.byRevision(1)!, log.byRevision(2)!]) {
      const round = decodeEditOp(encodeEditOp(op))
      expect(round.entityChanges).toEqual(op.entityChanges)
      expect(round.blockEntityChanges).toEqual(op.blockEntityChanges)
      expect(round.patch.length).toBe(op.patch.length)
      rebuild.append(round)
    }
    expect(rebuild.validate()).toEqual([])
    expect(rebuild.toJSONL()).toBe(log.toJSONL())
  })

  it('JSONL 往返之后重放结果与原日志一致', () => {
    const store = makeStore()
    const log = new EditLog()
    const change = store.entities.set(boat('e_1_1'))!
    log.record(
      undefined,
      {
        tool: 'place_entity',
        args: {},
        ts: '2026-01-01T00:00:00.000Z',
        worldRevision: store.commitEntities([change]),
      },
      { entities: [change] },
    )

    const { log: reopened } = EditLog.fromJSONL(log.toJSONL())
    expect(reopened.length).toBe(1)
    expect(verifyReplay(store, reopened, makeStore()).ok).toBe(true)
  })

  it('老 op（没有这两个字段）读回来是 undefined，而不是空数组', () => {
    const op = decodeEditOp(baseRecord())
    expect(op.entityChanges).toBeUndefined()
    expect(op.blockEntityChanges).toBeUndefined()
    // 老 op 也必须能过 validate：计数字段缺席 = 0 = 差分条数
    const log = new EditLog()
    log.append(op)
    expect(log.validate()).toEqual([])
  })

  it('非数组的 entityChanges 会被拒绝，而不是静默当成空的', () => {
    const bad = baseRecord({ entityChanges: 'nope' as unknown as EntityChange[] })
    expect(() => decodeEditOp(bad)).toThrow(/non-array/)
  })

  it('没有 key 的差分条目会被拒绝', () => {
    const bad = baseRecord({ entityChanges: [{ before: boat('e_1_1') }] as unknown as EntityChange[] })
    expect(() => decodeEditOp(bad)).toThrow(/without a string key/)
  })

  it('条数超上限的差分会被拒绝（读方加固，挡构造出来的 .mcai）', () => {
    const many = Array.from({ length: 65537 }, (_, i) => ({ key: `e_1_${i}`, after: boat(`e_1_${i}`) }))
    expect(() => decodeEditOp(baseRecord({ entityChanges: many }))).toThrow(/over the/)
  })

  it('validate 抓得住"计数与差分对不上"', () => {
    const store = makeStore()
    const log = new EditLog()
    const change = store.entities.set(boat('e_1_1'))!
    const op = log.record(
      undefined,
      { tool: 'place_entity', args: {}, worldRevision: store.commitEntities([change]) },
      { entities: [change] },
    )!
    op.result.entitiesChanged = 7
    expect(log.validate().join('\n')).toMatch(/entity changes, but result.entitiesChanged=7/)
  })

  it('工具主动写的方块实体也能进 op——这是剪除之外的另一半来源', () => {
    const store = makeStore()
    const log = new EditLog()
    const write = store.writeBlocks((emit) => emit(4, 1, 4, store.palette.indexOf('minecraft:chest')), {
      confirm: true,
    })
    const change = store.blockEntities.set(chest(4, 1, 4))!
    const op = log.record(
      write,
      { tool: 'edit_block_entity', args: {}, worldRevision: store.revision },
      { blockEntities: [change] },
    )!

    expect(op.blockEntityChanges).toEqual([change])
    expect(op.result.blockEntitiesChanged).toBe(1)
    expect(op.result.changed).toBe(1) // 方块那一格也在这一条 op 里
    expect(log.validate()).toEqual([])
    expect(verifyReplay(store, log, makeStore()).ok).toBe(true)

    const session = new ReplaySession(store, log)
    session.undo()
    expect(store.blockEntities.size).toBe(0)
    session.redo()
    expect(store.blockEntities.at({ x: 4, y: 1, z: 4 })).toEqual(chest(4, 1, 4))
  })

  it('同一个格子上"先剪除、后写入"的顺序要对：换个容器得到的是新的那份内容', () => {
    const store = makeStore()
    const log = new EditLog()
    store.setBlock({ x: 4, y: 1, z: 4 }, 'minecraft:chest')
    const old = chest(4, 1, 4)
    store.blockEntities.set(old)
    asBase(store)

    // 把箱子换成桶：方块写入顺手剪掉旧内容，工具再写进新内容
    const write = store.writeBlocks((emit) => emit(4, 1, 4, store.palette.indexOf('minecraft:barrel')), {
      confirm: true,
    })
    const fresh: PlacedBlockEntity = { x: 4, y: 1, z: 4, kind: 'barrel', data: { items: [] } }
    const change = store.blockEntities.set(fresh)!
    const op = log.record(write, { tool: 'replace_blocks', args: {}, worldRevision: store.revision }, {
      blockEntities: [change],
    })!

    // 剪除在前、主动在后：同一个键出现两次，应用顺序决定最终是哪一个
    expect(op.blockEntityChanges).toHaveLength(2)
    expect(op.blockEntityChanges![0]!.after).toBeUndefined()
    expect(op.blockEntityChanges![1]!.after).toEqual(fresh)

    const session = new ReplaySession(store, log)
    session.undo()
    expect(store.blockEntities.at({ x: 4, y: 1, z: 4 })).toEqual(old)
    session.redo()
    expect(store.blockEntities.at({ x: 4, y: 1, z: 4 })).toEqual(fresh)
  })

  it('encode 不写空数组：没有那两层时记录里就该没有那两个字段', () => {
    const store = makeStore()
    const log = new EditLog()
    const write = store.writeBlocks((emit) => emit(0, 0, 0, store.palette.indexOf('minecraft:stone')), {
      confirm: true,
    })
    log.record(write, { tool: 'place_block', args: {} })
    const record = encodeEditOp(log.byRevision(1)!)
    expect('entityChanges' in record).toBe(false)
    expect('blockEntityChanges' in record).toBe(false)
  })
})
