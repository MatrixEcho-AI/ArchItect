import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { EditLog, WorldStore } from '@architect/core'
import type { EditOp } from '@architect/core'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { hasRecoverable, pendingOps, WriteAheadLog } from '../src/wal.js'

let dir: string
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'architect-wal-'))
})
afterAll(() => {
  rmSync(dir, { recursive: true, force: true })
})

/**
 * 用**真实的** `EditLog` 造 op。
 *
 * 手搓一个假的 EditOp 是测不出问题的：`toJSONL` 把 patch 编成 base64，
 * `fromJSONL` 再解回来——WAL 存的正是这个字符串形式，所以夹具必须走同一条路。
 */
function makeOps(count: number, prefix = ''): EditOp[] {
  const store = new WorldStore({
    minecraftVersion: '1.21.4',
    volume: { min: { x: 0, y: 0, z: 0 }, max: { x: 31, y: 31, z: 31 } },
  })
  const log = new EditLog()
  for (let i = 0; i < count; i++) {
    const result = store.write((emit) => emit(i, 0, 0), store.palette.indexOf('minecraft:stone'), { confirm: true })
    log.record(result, {
      tool: `${prefix}fill_box`,
      args: { from: [i, 0, 0], to: [i, 0, 0] },
      source: 'llm',
      actor: 'assistant',
      ts: '2026-01-01T00:00:00.000Z',
    })
  }
  return [...log.all()]
}

describe('WAL：崩溃后能把多出来的 op 找回来', () => {
  it('**追加 → 读回，op 一条不少、顺序不变**', () => {
    const file = join(dir, 'a.wal')
    const wal = new WriteAheadLog({ file, header: { baseRevision: 0, projectId: 'p', name: 'n', startedAt: 'T' } })
    const ops = makeOps(2)
    wal.append(ops[0]!)
    wal.append(ops[1]!)

    const contents = wal.read()!
    expect(contents.header.baseRevision).toBe(0)
    expect(contents.ops.map((entry) => entry.rev)).toEqual([1, 2])
    // patch 也要原样回来——WAL 存的必须是能重建世界的完整 op，不是摘要
    expect(contents.ops[1]?.patch.length).toBe(ops[1]!.patch.length)
    expect(contents.droppedOps).toBe(0)
  })

  it('**第一次写盘失败之后，下一次仍然会补写表头**（整卷不能因此作废）', () => {
    const file = join(dir, 'first-write-fails.wal')
    // 把 WAL 的路径做成**目录**：appendFileSync 必然失败，模拟磁盘满 / Windows 上
    // 文件被索引器或杀软占着。
    mkdirSync(file, { recursive: true })
    const wal = new WriteAheadLog({ file, header: { baseRevision: 0, projectId: 'p', name: 'n', startedAt: 'T' } })
    const ops = makeOps(2)

    expect(() => wal.append(ops[0]!)).toThrow()

    // 让开之后第二次写入应当成功——而且**必须连表头一起写**。
    // 少了它，`read()` 会把第一行 op 当成表头、因 `version !== 1` 判掉整卷，
    // 连已经成功落盘的 op 一起丢。
    rmSync(file, { recursive: true, force: true })
    wal.append(ops[1]!)

    const contents = wal.read()
    expect(contents, '表头没补上，整卷 WAL 被判成不可解释').toBeDefined()
    expect(contents!.header.baseRevision).toBe(0)
    expect(contents!.ops).toHaveLength(1)
  })

  it('批量追加只写一次，读回来一样', () => {
    const file = join(dir, 'b.wal')
    const wal = new WriteAheadLog({ file, header: { baseRevision: 0, projectId: 'p', name: 'n', startedAt: 'T' } })
    wal.appendAll(makeOps(3))
    expect(wal.length).toBe(3)
    expect(wal.read()!.ops).toHaveLength(3)
  })

  it('**最后一行被写坏时只丢那一行**，前面的照常恢复', () => {
    const file = join(dir, 'crash.wal')
    const wal = new WriteAheadLog({ file, header: { baseRevision: 0, projectId: 'p', name: 'n', startedAt: 'T' } })
    const ops = makeOps(2)
    wal.append(ops[0]!)
    wal.append(ops[1]!)
    // 模拟断电：追加了半行
    writeFileSync(file, `${readFileSync(file, 'utf8')}{"rev":3,"tool":"fill_b`, 'utf8')

    const contents = wal.read()!
    expect(contents.ops).toHaveLength(2)
    expect(contents.droppedOps).toBe(1)
    expect(hasRecoverable(contents)).toBe(true)
  })

  it('**表头坏掉时整卷作废**（不知道接在谁后面就没法解释）', () => {
    const file = join(dir, 'badheader.wal')
    writeFileSync(file, '这不是 json\n{"rev":1}\n', 'utf8')
    expect(new WriteAheadLog({ file, header: { baseRevision: 0, projectId: 'p', name: 'n', startedAt: 'T' } }).read()).toBeUndefined()
  })

  it('文件不存在 → 没有可恢复的东西', () => {
    const wal = new WriteAheadLog({ file: join(dir, 'nope.wal'), header: { baseRevision: 0, projectId: 'p', name: 'n', startedAt: 'T' } })
    expect(wal.read()).toBeUndefined()
    expect(hasRecoverable(undefined)).toBe(false)
  })
})

describe('只恢复基准之后的 op', () => {
  it('**基准已经包含的 op 不再重放**（否则 revision 会翻倍）', () => {
    const file = join(dir, 'base.wal')
    const wal = new WriteAheadLog({ file, header: { baseRevision: 5, projectId: 'p', name: 'n', startedAt: 'T' } })
    // 崩溃前刚保存过（rev 5 已经进快照），之后又改了两次
    // rev 4..7（1..3 是更早的事，不在这一卷里）
    const ops = makeOps(7).slice(3)
    expect(ops.map((entry) => entry.rev)).toEqual([4, 5, 6, 7])
    for (const entry of ops) wal.append(entry)

    const contents = wal.read()!
    expect(contents.ops.map((entry) => entry.rev)).toEqual([4, 5, 6, 7])
    // 基准是 5，所以只有 6 与 7 需要重放
    expect(pendingOps(contents).map((entry) => entry.rev)).toEqual([6, 7])
  })

  it('没有新 op 时不该提示恢复', () => {
    const file = join(dir, 'clean.wal')
    const wal = new WriteAheadLog({ file, header: { baseRevision: 3, projectId: 'p', name: 'n', startedAt: 'T' } })
    wal.append(makeOps(1)[0]!)
    const contents = wal.read()!
    expect(hasRecoverable(contents)).toBe(false)
  })
})

describe('保存之后 reset', () => {
  it('**清空内容并推进基准**，但保留表头（下次崩溃仍知道基准在哪）', () => {
    const file = join(dir, 'reset.wal')
    const wal = new WriteAheadLog({ file, header: { baseRevision: 0, projectId: 'p', name: 'n', startedAt: 'T' } })
    for (const entry of makeOps(2)) wal.append(entry)

    wal.reset(2, '/tmp/x.mcai')
    expect(wal.length).toBe(0)
    expect(wal.read()).toBeUndefined() // 文件已删，没东西可恢复

    // 之后又改了一次：新表头必须记住 baseRevision = 2
    wal.append(makeOps(3)[2]!)
    const contents = wal.read()!
    expect(contents.header.baseRevision).toBe(2)
    expect(contents.header.projectPath).toBe('/tmp/x.mcai')
    expect(pendingOps(contents).map((entry) => entry.rev)).toEqual([3])
  })

  it('discard 彻底删掉文件', () => {
    const file = join(dir, 'discard.wal')
    const wal = new WriteAheadLog({ file, header: { baseRevision: 0, projectId: 'p', name: 'n', startedAt: 'T' } })
    wal.append(makeOps(1)[0]!)
    wal.discard()
    expect(wal.read()).toBeUndefined()
  })
})
