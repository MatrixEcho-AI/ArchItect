import { describe, expect, it } from 'vitest'

import { forEachBox } from '../src/geometry/box.js'
import { forEachLine } from '../src/geometry/line.js'
import { forEachExtrude } from '../src/geometry/polygon.js'
import { EditLog, EditLogError } from '../src/history/log.js'
import { replayTo, ReplaySession, verifyReplay } from '../src/history/replay.js'
import { ChangeSet } from '../src/world/changeset.js'
import { WorldStore } from '../src/world/store.js'
import { symmetrize } from '../src/world/symmetrize.js'
import type { Bounds, Pos } from '../src/types.js'

const volume: Bounds = { min: { x: -4, y: 0, z: -4 }, max: { x: 24, y: 24, z: 24 } }
const makeStore = (): WorldStore => new WorldStore({ minecraftVersion: '1.21.4', volume })

const box = (from: Pos, to: Pos, mode: 'solid' | 'hollow' | 'outline' = 'solid') =>
  (visit: (x: number, y: number, z: number) => void) => forEachBox(from, to, mode, visit)

const rect = (x0: number, z0: number, x1: number, z1: number) => [
  { x: x0, z: z0 },
  { x: x1, z: z0 },
  { x: x1, z: z1 },
  { x: x0, z: z1 },
]

/**
 * 造一段有代表性的编辑序列（含覆盖、删除、镜像、对角填充），边写世界边记日志。
 * 每个 op 用固定时间戳，保证序列化可复现。
 */
function buildScenario(): { store: WorldStore; log: EditLog } {
  const store = makeStore()
  const log = new EditLog()
  let clock = 0
  const next = (): string => new Date(Date.UTC(2026, 0, 1, 0, 0, clock++)).toISOString()

  const record = (
    producer: Parameters<WorldStore['write']>[0],
    block: string,
    tool: string,
    args: unknown,
    options: Parameters<WorldStore['write']>[2] = {},
  ): void => {
    const result = store.write(producer, store.palette.indexOf(block), { confirm: true, ...options })
    log.record(result, { tool, args, ts: next(), correlationId: 'turn_1' })
  }

  record(box({ x: 0, y: 0, z: 0 }, { x: 11, y: 0, z: 11 }), 'minecraft:oak_planks', 'fill_box', {
    from: [0, 0, 0],
    to: [11, 0, 11],
  })
  record(
    (v) => forEachExtrude(rect(0, 0, 11, 11), { baseY: 1, height: 4, hollow: true, capTop: false, capBottom: false }, v),
    'minecraft:stone_bricks',
    'extrude',
    { points: rect(0, 0, 11, 11), baseY: 1, height: 4, hollow: true },
  )
  // 开门洞（destroy → 写空气，from 非空 to 空）
  record(box({ x: 5, y: 1, z: 0 }, { x: 5, y: 2, z: 0 }), 'minecraft:air', 'erase', {}, { mode: 'destroy' })
  // 覆盖已有方块（overwrite）
  record(box({ x: 0, y: 1, z: 4 }, { x: 0, y: 1, z: 5 }), 'minecraft:glass', 'fill_box', {}, { mode: 'replace' })
  // 对角批量填充
  record(
    (v) => forEachLine({ x: 3, y: 5, z: 3 }, { x: 8, y: 10, z: 8 }, { radius: 1, taper: [2, 0] }, v),
    'minecraft:dark_prismarine',
    'fill_line',
    { from: [3, 5, 3], to: [8, 10, 8], radius: 1 },
  )
  // 镜像
  {
    const result = symmetrize(store, {
      axis: 'z',
      coordinate: 12,
      source: 'negative',
      confirm: true,
    })
    log.record(result, { tool: 'symmetrize', args: { axis: 'z', coordinate: 12 }, ts: next() })
  }
  // 一个 no-op（写相同方块）不该产生 op
  record(box({ x: 0, y: 0, z: 0 }, { x: 11, y: 0, z: 11 }), 'minecraft:oak_planks', 'fill_box', {})

  return { store, log }
}

describe('ChangeSet 序列化的对齐陷阱', () => {
  it('base64 往返精确，且不依赖 Buffer 的 4 字节对齐', () => {
    const set = new ChangeSet()
    for (let i = 0; i < 5000; i++) set.push(i - 2000, i % 300, -i, i % 9, (i * 7) % 13)
    const raw = set.toBuffer()

    // 造一个 byteOffset 未对齐的 Buffer：前面垫 1 字节再切片
    const padded = Buffer.concat([Buffer.alloc(1), raw])
    const unaligned = padded.subarray(1)
    expect(unaligned.byteOffset % 4).not.toBe(0) // 确认真的错位了
    const fromUnaligned = ChangeSet.fromBuffer(unaligned)
    expect(fromUnaligned.length).toBe(set.length)
    expect(fromUnaligned.at(4999)).toEqual(set.at(4999))

    // base64 往返（真实落盘路径）
    const roundTrip = ChangeSet.fromBuffer(Buffer.from(raw.toString('base64'), 'base64'))
    expect(roundTrip.length).toBe(set.length)
    for (let i = 0; i < set.length; i += 997) expect(roundTrip.at(i)).toEqual(set.at(i))
  })

  it('缓冲区过短会抛错而不是静默读到垃圾', () => {
    expect(() => ChangeSet.fromBuffer(Buffer.alloc(4))).toThrow(/too short/)
    const truncated = new ChangeSet()
    truncated.push(0, 0, 0, 0, 1)
    const buf = truncated.toBuffer().subarray(0, 12)
    expect(() => ChangeSet.fromBuffer(buf)).toThrow(/too short/)
  })
})

describe('EditLog', () => {
  it('记录 op，rev 从 1 连续递增', () => {
    const { log } = buildScenario()
    expect(log.length).toBe(6)
    expect(log.revision).toBe(6)
    expect(log.byRevision(1)!.id).toBe('op_000001')
    expect(log.byRevision(6)!.tool).toBe('symmetrize')
    // validate 应当干净
    expect(log.validate()).toEqual([])
  })

  it('no-op 不产生 op', () => {
    const store = makeStore()
    const log = new EditLog()
    const r1 = store.write(box({ x: 0, y: 0, z: 0 }, { x: 1, y: 1, z: 1 }), store.palette.indexOf('minecraft:stone'), {
      confirm: true,
    })
    expect(log.record(r1, { tool: 'fill_box', args: {} })).toBeDefined()

    const r2 = store.write(box({ x: 0, y: 0, z: 0 }, { x: 1, y: 1, z: 1 }), store.palette.indexOf('minecraft:stone'), {
      confirm: true,
    })
    expect(log.record(r2, { tool: 'fill_box', args: {} })).toBeUndefined()
    expect(log.length).toBe(1)
  })

  it('upTo 与 byCorrelation', () => {
    const { log } = buildScenario()
    expect(log.upTo(3)).toHaveLength(3)
    expect(log.upTo(0)).toHaveLength(0)
    expect(log.upTo(999)).toHaveLength(6)
    expect(log.byCorrelation('turn_1').length).toBe(5) // symmetrize 没带 correlationId
  })

  it('append 校验 rev 连续性', () => {
    const { log } = buildScenario()
    const bad = { ...log.byRevision(1)!, rev: 99 }
    expect(() => log.append(bad)).toThrow(EditLogError)
  })

  it('JSONL 往返：patch 逐格一致', () => {
    const { log } = buildScenario()
    const text = log.toJSONL()
    expect(text.split('\n').filter((l) => l.length > 0)).toHaveLength(6)

    const { log: restored, droppedTail } = EditLog.fromJSONL(text)
    expect(droppedTail).toBe(0)
    expect(restored.length).toBe(log.length)
    expect(restored.validate()).toEqual([])

    for (let i = 0; i < log.length; i++) {
      const a = log.at(i)!
      const b = restored.at(i)!
      expect(b.id).toBe(a.id)
      expect(b.tool).toBe(a.tool)
      expect(b.args).toEqual(a.args)
      expect(b.result).toEqual(a.result)
      expect(b.correlationId).toBe(a.correlationId)
      expect(b.patch.length).toBe(a.patch.length)
      for (let k = 0; k < a.patch.length; k++) expect(b.patch.at(k)).toEqual(a.patch.at(k))
    }
  })

  it('写到一半的最后一行被容忍并丢弃（崩溃恢复）', () => {
    const { log } = buildScenario()
    const lines = log.toJSONL().split('\n')
    const broken = lines.slice(0, 3).join('\n') + '\n{"id":"op_000004","rev":4,"ts":"2026'
    const { log: restored, droppedTail } = EditLog.fromJSONL(broken)
    expect(restored.length).toBe(3)
    expect(droppedTail).toBe(1)
  })

  it('中间行损坏要报错，而不是静默丢数据', () => {
    const { log } = buildScenario()
    const lines = log.toJSONL().split('\n').filter((l) => l.length > 0)
    lines[2] = '{ 坏掉的 JSON'
    expect(() => EditLog.fromJSONL(lines.join('\n') + '\n')).toThrow(/corrupted/)
  })

  it('validate 能抓出 patch 长度与 result.changed 不符', () => {
    const { log } = buildScenario()
    const op = log.byRevision(1)!
    op.result = { ...op.result, changed: op.result.changed + 1 }
    expect(log.validate()[0]).toMatch(/patch has .* cells, but result.changed=/)
  })

  it('空日志序列化为空串', () => {
    expect(new EditLog().toJSONL()).toBe('')
  })
})

describe('replay：M2 的核心不变式', () => {
  it('增量构建的结果与 replay 的结果哈希相等', () => {
    const { store, log } = buildScenario()
    const rebuild = makeStore()
    const check = verifyReplay(store, log, rebuild)
    expect(check.replayedHash).toBe(check.liveHash)
    expect(check.ok).toBe(true)
    expect(check.revision).toBe(6)
  })

  it('replay 后的世界逐格相等（不只比哈希）', () => {
    const { store, log } = buildScenario()
    const rebuild = makeStore()
    replayTo(rebuild, log)
    for (let x = -4; x <= 24; x++) {
      for (let y = 0; y <= 12; y++) {
        for (let z = -4; z <= 24; z++) {
          const a = store.getBlockString({ x, y, z })
          const b = rebuild.getBlockString({ x, y, z })
          if (a !== b) throw new Error(`(${x},${y},${z}) 增量=${a} replay=${b}`)
        }
      }
    }
    expect(true).toBe(true)
  })

  it('JSONL 往返之后再 replay 仍然相等（端到端）', () => {
    const { store, log } = buildScenario()
    const { log: restored } = EditLog.fromJSONL(log.toJSONL())
    const rebuild = makeStore()
    replayTo(rebuild, restored)
    expect(rebuild.contentHash()).toBe(store.contentHash())
  })

  it('replay 到中间版本会得到那个时刻的状态', () => {
    const { log } = buildScenario()
    const partial = makeStore()
    replayTo(partial, log, 2)
    // 前两个 op 是地板 + 墙，还没有门洞
    expect(partial.getBlockString({ x: 5, y: 1, z: 0 })).toContain('stone_bricks')
    expect(partial.revision).toBe(2)

    // 完整 replay 之后门洞才出现
    replayTo(partial, log)
    expect(partial.isAir({ x: 5, y: 1, z: 0 })).toBe(true)
    expect(partial.revision).toBe(6)
  })

  it('revision 越界会被夹住', () => {
    const { log } = buildScenario()
    const store = makeStore()
    expect(replayTo(store, log, 999)).toBe(6)
    expect(replayTo(store, log, -5)).toBe(0)
  })
})

describe('ReplaySession 时间线', () => {
  it('往前是增量的，往后会重建', () => {
    const { log } = buildScenario()
    const session = new ReplaySession(makeStore(), log)

    expect(session.seek(2)).toBe(2)
    const at2 = session.store.contentHash()
    expect(session.seek(5)).toBe(5)
    expect(session.seek(2)).toBe(2)
    expect(session.store.contentHash()).toBe(at2) // 回到同一版本必须是同一状态
  })

  it('store 已在最新版本时向后 seek 真正回退（回归）', () => {
    // 模拟"刚从 .mcai 打开"：store 已经重放到最新。
    // 若 session 的游标从 0 开始，seek(2) 会被误判成"往前走"，
    // 在完整世界上再叠一遍前两个 op —— 数据不会回退。
    const { store, log } = buildScenario()
    const fullHash = store.contentHash()
    const fullBlocks = store.stats().blocks

    const session = new ReplaySession(store, log)
    expect(session.revision).toBe(log.length) // 游标必须从 store 的实际版本开始

    session.seek(2)
    expect(session.revision).toBe(2)
    expect(store.revision).toBe(2)
    expect(store.contentHash()).not.toBe(fullHash)
    expect(store.stats().blocks).toBeLessThan(fullBlocks)

    session.seekLatest()
    expect(store.contentHash()).toBe(fullHash)
    expect(store.stats().blocks).toBe(fullBlocks)
  })

  it('seekLatest 到最新版本后与原始世界一致', () => {
    const { store, log } = buildScenario()
    const target = makeStore()
    const session = new ReplaySession(target, log)
    session.seekLatest()
    expect(target.revision).toBe(log.length)
    expect(target.contentHash()).toBe(store.contentHash())
  })
})

describe('contentHash', () => {
  it('同内容同哈希（与编辑顺序无关）', () => {
    const a = makeStore()
    const b = makeStore()
    const stone = a.palette.indexOf('minecraft:stone')
    a.write(box({ x: 0, y: 0, z: 0 }, { x: 3, y: 0, z: 0 }), stone, { confirm: true })
    a.write(box({ x: 0, y: 0, z: 1 }, { x: 3, y: 0, z: 1 }), stone, { confirm: true })
    b.write(box({ x: 0, y: 0, z: 1 }, { x: 3, y: 0, z: 1 }), b.palette.indexOf('minecraft:stone'), { confirm: true })
    b.write(box({ x: 0, y: 0, z: 0 }, { x: 3, y: 0, z: 0 }), b.palette.indexOf('minecraft:stone'), { confirm: true })
    expect(a.contentHash()).toBe(b.contentHash())
  })

  it('内容不同则哈希不同', () => {
    const a = makeStore()
    const b = makeStore()
    a.setBlock({ x: 1, y: 1, z: 1 }, 'minecraft:stone')
    b.setBlock({ x: 1, y: 1, z: 1 }, 'minecraft:dirt')
    expect(a.contentHash()).not.toBe(b.contentHash())
    b.setBlock({ x: 1, y: 1, z: 1 }, 'minecraft:stone')
    expect(a.contentHash()).toBe(b.contentHash())
  })

  it('空世界有稳定的哈希', () => {
    expect(makeStore().contentHash()).toBe(makeStore().contentHash())
  })

  it('撤销回到之前的状态会得到之前的哈希', () => {
    const store = makeStore()
    const before = store.contentHash()
    store.setBlock({ x: 2, y: 2, z: 2 }, 'minecraft:stone')
    expect(store.contentHash()).not.toBe(before)
    store.revertLastWrite()
    expect(store.contentHash()).toBe(before)
  })
})

/**
 * 时间线游标（`ReplaySession`）。
 *
 * 这一组钉死的是**"撤销 = 游标移动"**这条语义。早期 `WorldStore` 自带一个
 * 内存撤销栈，撤销时会打一个反向补丁并让版本号 **+1**——于是世界写着 rev 4、
 * 日志只有 3 条，重放、时间线、`.mcai` 往返同时坏掉，而且坏得很安静。
 */
describe('时间线游标', () => {
  it('撤销 / 重做只是游标前后移动，日志长度不变', () => {
    const { store, log } = buildScenario()
    const tip = log.length
    const session = new ReplaySession(store, log)
    expect(session.atTip).toBe(true)
    expect(session.canUndo).toBe(true)
    expect(session.canRedo).toBe(false)

    expect(session.undo()).toBe(tip - 1)
    expect(store.revision).toBe(tip - 1)
    // **不产生新 op**：撤销进日志的话，"撤销"和"再改回去"就没法区分了
    expect(log.length).toBe(tip)
    expect(session.canRedo).toBe(true)

    expect(session.redo()).toBe(tip)
    expect(store.revision).toBe(tip)
    expect(log.length).toBe(tip)
    expect(session.atTip).toBe(true)
  })

  it('**游标就是 `store.revision`**：不存在第二个真相', () => {
    const { store, log } = buildScenario()
    const session = new ReplaySession(store, log)
    session.undo()
    session.undo()
    expect(session.revision).toBe(store.revision)
    session.seek(1)
    expect(session.revision).toBe(store.revision)
    expect(session.length).toBe(log.length)
  })

  it('撤销之后重做回来，内容与哈希都精确复原', () => {
    const { store, log } = buildScenario()
    const session = new ReplaySession(store, log)
    const before = store.contentHash()
    session.undo()
    expect(store.contentHash()).not.toBe(before)
    session.redo()
    expect(store.contentHash()).toBe(before)
  })

  it('一路撤销到 0 得到空世界，再撤销是空操作', () => {
    const { store, log } = buildScenario()
    const session = new ReplaySession(store, log)
    for (let i = 0; i < log.length + 3; i++) session.undo()
    expect(store.revision).toBe(0)
    expect(store.contentHash()).toBe(makeStore().contentHash())
    expect(session.canUndo).toBe(false)
  })

  it('任意游标位置上，世界都等于"从零重放到那里"', () => {
    const { store, log } = buildScenario()
    const session = new ReplaySession(store, log)
    const rebuild = makeStore()
    for (let rev = log.length; rev >= 0; rev--) {
      session.seek(rev)
      expect(store.revision).toBe(rev)
      // 注意用 `replayTo(.., rev)` 而不是 `verifyReplay`：后者重放到**最新**，
      // 拿它去比一个停在 rev 5 的世界当然不等
      replayTo(rebuild, log, rev)
      expect(store.contentHash(), `rev ${rev} 对不上`).toBe(rebuild.contentHash())
    }
  })
})

describe('EditLog：在历史版本上继续编辑（分叉）', () => {
  it('给了 worldRevision 就会先截断，绝不出现两条同号 op', () => {
    const { store, log } = buildScenario()
    const session = new ReplaySession(store, log)
    const tip = log.length
    session.seek(tip - 2)

    const result = store.write(box({ x: 0, y: 5, z: 0 }, { x: 1, y: 5, z: 1 }), store.palette.indexOf('minecraft:bricks'), {
      confirm: true,
    })
    log.record(result, { tool: 'fill_box', args: {}, worldRevision: store.revision })

    expect(log.length).toBe(store.revision)
    expect(store.revision).toBe(tip - 1)
    expect(new Set(log.all().map((op) => op.rev)).size).toBe(log.length)
    expect(verifyReplay(store, log, makeStore()).ok).toBe(true)
  })

  it('世界绕过日志被改过时**大声报错**，而不是安静地写出两条同号 op', () => {
    const store = makeStore()
    const log = new EditLog()
    // 夹具 / 导入会绕过日志直接写：版本号涨了，日志还是空的
    store.setBlock({ x: 1, y: 1, z: 1 }, 'minecraft:stone')
    store.setBlock({ x: 2, y: 1, z: 1 }, 'minecraft:stone')
    store.setBlock({ x: 3, y: 1, z: 1 }, 'minecraft:stone')
    const result = store.write(box({ x: 5, y: 1, z: 5 }, { x: 6, y: 1, z: 6 }), store.palette.indexOf('minecraft:bricks'), {
      confirm: true,
    })
    // 写入后世界在 rev 4，而日志里下一条只能是 rev 1——这时**必须报错**。
    // 不报的话日志与世界会安静地脱节，重放、时间线、`.mcai` 往返同时坏掉。
    expect(() => log.record(result, { tool: 'fill_box', args: {}, worldRevision: store.revision })).toThrow(
      EditLogError,
    )
  })
})
