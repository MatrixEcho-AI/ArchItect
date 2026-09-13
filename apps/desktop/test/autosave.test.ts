import { mkdtempSync, existsSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { WorldStore } from '@architect/core'
import type { PlacedBlockEntity } from '@architect/core'
import { DATA_VERSION_1_21_4, exportSchematic } from '@architect/interop'
import { openProject } from '@architect/mcai'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { AutosaveService } from '../src/main/services/autosave.js'
import { StudioService } from '../src/main/services/studio.js'

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'architect-autosave-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

const make = (overrides: Partial<ConstructorParameters<typeof AutosaveService>[0]> = {}): AutosaveService =>
  new AutosaveService({
    dir,
    projectId: 'test-project',
    name: '测试工程',
    now: () => '2026-01-01T00:00:00.000Z',
    ...overrides,
  })

/** 造一个有若干步编辑的工作台。 */
function makeStudio(steps = 3): StudioService {
  const studio = new StudioService({ plain: true })
  const store = studio.agentSession.store
  const P = (name: string): number => store.palette.indexOf(name)
  for (let i = 0; i < steps; i++) {
    const result = store.write((emit) => emit(i, 0, 0), P('minecraft:stone'), { confirm: true })
    studio.agentSession.log.record(result, {
      tool: 'place_block',
      args: { pos: [i, 0, 0] },
      source: 'llm',
      actor: 'assistant',
    })
  }
  return studio
}

describe('换工程之后的 WAL 基准', () => {
  it('**导入之后 WAL 换到新基准**，新世界的第一笔编辑要进 WAL', async () => {
    // 导入 = 换了一个工程，基准是 rev 0。少一次 retarget，WAL 里还留着上一个工程的
    // 基准（这里停在 7），而新世界的第一笔编辑是 rev 1——`op.rev > baseRevision`
    // 不成立，改动**永远不进 WAL**，崩溃时静默丢失。
    const studio = makeStudio(7)
    studio.attachAutosave(make())
    // **先存一次**：只有 `onSaved` / `retarget` 会推 WAL 的基准，`autosaveNow()` 不会。
    // 存过之后基准才是 7，下面这条测试才真的在验「导入有没有把它换掉」。
    await studio.save(join(dir, 'before.mcai'))
    expect(studio.autosaveNow(), '刚存完不该有待记的 op').toBe(0)

    const source = new WorldStore({
      minecraftVersion: '1.21.4',
      volume: { min: { x: 0, y: 0, z: 0 }, max: { x: 15, y: 15, z: 15 } },
    })
    source.write(
      (emit) => {
        for (let x = 0; x < 3; x++) emit(x, 0, 0)
      },
      source.palette.indexOf('minecraft:stone'),
      { confirm: true },
    )
    const schemPath = join(dir, 'in.schem')
    writeFileSync(
      schemPath,
      exportSchematic(source, {
        dataVersion: DATA_VERSION_1_21_4,
        metadata: { Name: 't', Author: 'a' },
      }).bytes,
    )

    const imported = await studio.importModel(schemPath)
    expect(imported.state.revision, '导入应当把游标拉回 0').toBe(0)

    // 导入之后改一格：它必须进 WAL
    const store = studio.agentSession.store
    const result = store.write((emit) => emit(0, 0, 0), store.palette.indexOf('minecraft:gold_block'), {
      confirm: true,
    })
    studio.agentSession.log.record(result, {
      tool: 'place_block',
      args: { pos: [0, 0, 0] },
      source: 'llm',
      actor: 'assistant',
    })
    expect(studio.autosaveNow(), '导入之后的编辑没进 WAL（基准还停在上一个工程）').toBe(1)
  })
})

describe('保存之后的 WAL 基准', () => {
  it('**撤销之后再保存，基准取的是世界游标而不是日志长度**', async () => {
    // 基准被写成 `log.length` 的话：撤销之后游标（5→2）比日志长度小，而 WAL 只记
    // `rev > baseRevision` 的 op——保存之后重放出来的那几笔全都不进 WAL，崩溃时
    // **静默丢失**，界面连「有几步没保存」都不弹。
    const studio = makeStudio(5)
    const wal = make()
    studio.attachAutosave(wal)

    studio.seek(2)
    expect(studio.state().revision).toBe(2)
    expect(studio.state().totalOps, '游标没有退到日志长度之前，这条测试就不成立').toBe(5)

    const path = join(dir, 'base.mcai')
    await studio.save(path)
    expect(existsSync(path)).toBe(true)

    // 保存之后再做一笔编辑：它必须进 WAL
    const store = studio.agentSession.store
    const result = store.write((emit) => emit(0, 1, 0), store.palette.indexOf('minecraft:stone'), {
      confirm: true,
    })
    studio.agentSession.log.record(result, {
      tool: 'place_block',
      args: { pos: [0, 1, 0] },
      source: 'llm',
      actor: 'assistant',
    })

    // 保存那一刻游标是 2、日志长度是 5：文件里只有 rev ≤ 2 的内容，所以 3、4、5 这
    // 三笔仍然只活在日志里，**必须进 WAL**；再加上刚写的那笔，一共 4 笔。
    // 基准若被写成 `log.length`(5)，就只会记到刚写的那 1 笔，3..5 静默丢失——
    // 崩溃之后用户看到的是「没有待恢复的草稿」，而实际上有三笔没保存。
    expect(studio.autosaveNow(), '撤销之后重放出来的那几笔没进 WAL').toBe(4)
  })
})

describe('AutosaveService：只记新 op，不做全量快照', () => {
  it('**第一次 journal 记下当前全部 op，第二次没有新 op 就一次盘都不写**', () => {
    const studio = makeStudio(3)
    const autosave = make()
    expect(autosave.journal(studio.agentSession.log)).toBe(3)
    expect(autosave.journal(studio.agentSession.log)).toBe(0)
    expect(autosave.journaledCount).toBe(3)

    // WAL 文件很小：一个 op 几十字节，而不是几十万格
    const pending = autosave.pending()!
    expect(pending.ops).toHaveLength(3)
    expect(pending.header.baseRevision).toBe(0)
  })

  it('增量：再改一步只追加那一步', () => {
    const studio = makeStudio(2)
    const autosave = make()
    autosave.journal(studio.agentSession.log)

    const store = studio.agentSession.store
    const result = store.write((emit) => emit(9, 0, 0), store.palette.indexOf('minecraft:stone'), { confirm: true })
    studio.agentSession.log.record(result, { tool: 'place_block', args: {}, source: 'llm', actor: 'assistant' })

    expect(autosave.journal(studio.agentSession.log)).toBe(1)
    expect(autosave.pending()!.ops.map((op) => op.rev)).toEqual([1, 2, 3])
  })

  it('保存之后基准推进，WAL 只剩"保存之后"的那一段', () => {
    const studio = makeStudio(3)
    const autosave = make()
    autosave.journal(studio.agentSession.log)
    autosave.onSaved(3, '/tmp/x.mcai', 3)
    expect(autosave.pending()).toBeUndefined()

    const store = studio.agentSession.store
    const result = store.write((emit) => emit(9, 0, 0), store.palette.indexOf('minecraft:stone'), { confirm: true })
    studio.agentSession.log.record(result, { tool: 'place_block', args: {}, source: 'llm', actor: 'assistant' })
    autosave.journal(studio.agentSession.log)

    const pending = autosave.pending()!
    // 基准是 3，所以只有 rev 4 需要重放
    expect(pending.ops.map((op) => op.rev)).toEqual([4])
    expect(pending.header.baseRevision).toBe(3)
    expect(pending.header.projectPath).toBe('/tmp/x.mcai')
  })

  it('没有改动时 pending() 是 undefined（不该弹"要不要恢复"）', () => {
    const autosave = make()
    expect(autosave.pending()).toBeUndefined()
  })

  it('基准工程被删掉时如实标出 baseExists=false，而不是硬凑', () => {
    const studio = makeStudio(2)
    const autosave = make()
    autosave.journal(studio.agentSession.log)
    autosave.onSaved(0, '/tmp/definitely-not-here.mcai', 2)
    const result = studio.agentSession.store.write(
      (emit) => emit(9, 0, 0),
      studio.agentSession.store.palette.indexOf('minecraft:stone'),
      { confirm: true },
    )
    studio.agentSession.log.record(result, { tool: 'place_block', args: {}, source: 'llm', actor: 'assistant' })
    autosave.journal(studio.agentSession.log)

    const pending = autosave.pending()!
    expect(pending.baseExists).toBe(false)
    expect(existsSync('/tmp/definitely-not-here.mcai')).toBe(false)
  })
})

describe('崩溃恢复：走完整条链路（真的是"保存 + 重放 op"）', () => {
  it('**保存 → 再改 → 崩溃 → 恢复出来的世界与崩溃前逐格一致**', async () => {
    const studio = makeStudio(3)
    const autosave = make()
    autosave.journal(studio.agentSession.log)

    // 第一次保存（此时世界是 3 格）
    const savePath = join(dir, 'project.mcai')
    studio.attachAutosave(autosave)
    await studio.save(savePath)

    // 继续改两格（agent 会调 autosaveNow）
    const store = studio.agentSession.store
    for (const x of [10, 11]) {
      const result = store.write((emit) => emit(x, 0, 0), store.palette.indexOf('minecraft:stone'), { confirm: true })
      studio.agentSession.log.record(result, { tool: 'place_block', args: { pos: [x, 0, 0] }, source: 'llm', actor: 'assistant' })
    }
    expect(studio.autosaveNow()).toBe(2)

    const beforeCrash = store.contentHash()
    expect(store.stats().blocks).toBe(5)

    // —— 模拟崩溃：进程没了，只剩磁盘上的 project.mcai 和 WAL ——
    const reopened = new AutosaveService({
      dir,
      projectId: 'test-project',
      name: '测试工程',
      now: () => '2026-01-01T00:00:00.000Z',
    })
    const pending = reopened.pending()!
    expect(pending.ops).toHaveLength(2)
    expect(pending.baseExists).toBe(true)

    // 恢复 = 打开基准工程，再把 WAL 里多出来的 op 重放上去
    const { project, store: restored } = openProject(new Uint8Array(require('node:fs').readFileSync(savePath)))
    for (const op of pending.ops) restored.applyPatch(op.patch)
    restored.setRevision(project.manifest.revision + pending.ops.length)

    expect(restored.contentHash()).toBe(beforeCrash)
    expect(restored.stats().blocks).toBe(5)
    expect(restored.revision).toBe(5)
  })
})

describe('保存 → 打开：世界的三层都要回来', () => {
  it('实体与方块实体随工程往返（打开时要装在 restoreColumns 之后）', async () => {
    const path = join(dir, 'three-layers.mcai')
    const before = makeStudio(2)
    const store = before.agentSession.store
    const log = before.agentSession.log

    // 一笔方块实体的主动写入（方块 + 工具自己写的附加数据）
    const barrelWrite = store.write((emit) => emit(5, 0, 0), store.palette.indexOf('minecraft:barrel'), {
      confirm: true,
    })
    const contents = store.blockEntities.set({
      x: 5,
      y: 0,
      z: 0,
      kind: 'barrel',
      data: { items: [{ slot: 0, id: 'minecraft:coal', count: 2 }] },
    })!
    log.record(
      barrelWrite,
      { tool: 'edit_block_entity', args: {}, worldRevision: store.revision },
      { blockEntities: [contents] },
    )

    // 一笔"只放实体"的写入
    const boatId = store.entities.allocateId(store.revision + 1)
    const boat = store.entities.set({
      id: boatId,
      type: 'minecraft:oak_boat',
      x: 8.5,
      y: 1,
      z: 8.5,
      yaw: 4,
    })!
    log.record(
      undefined,
      { tool: 'place_entity', args: {}, worldRevision: store.commitEntities([boat]) },
      { entities: [boat] },
    )

    const expected = store.contentHash()
    expect(store.entities.size).toBe(1)
    expect(store.blockEntities.size).toBe(1)
    await before.save(path)

    const after = new StudioService({ plain: true })
    await after.open(path)
    expect(after.agentSession.store.entities.get(boatId)?.type).toBe('minecraft:oak_boat')
    expect(after.agentSession.store.blockEntities.at({ x: 5, y: 0, z: 0 })).toEqual({
      x: 5,
      y: 0,
      z: 0,
      kind: 'barrel',
      data: { items: [{ slot: 0, id: 'minecraft:coal', count: 2 }] },
    })
    // 哈希对拍才是重点：少掉这两层的话方块计数完全看不出来
    expect(after.agentSession.store.contentHash()).toBe(expected)
  })
})

describe('StudioService 的接线', () => {
  it('autosaveNow 在一轮结束与定时器上都会被调，且是增量的', () => {
    const studio = makeStudio(2)
    const autosave = make()
    studio.attachAutosave(autosave)
    expect(studio.autosaveNow()).toBe(2)
    expect(studio.autosaveNow()).toBe(0)
  })

  it('没接 autosave 时（测试、无头）不写盘也不报错', () => {
    const studio = makeStudio(2)
    expect(studio.autosaveNow()).toBe(0)
    expect(studio.recover()).toBeUndefined()
  })

  it('**基准不在原处时给出可读的说明，而不是硬凑一份恢复**', async () => {
    const studio = makeStudio(2)
    const autosave = make()
    studio.attachAutosave(autosave)
    autosave.journal(studio.agentSession.log)
    autosave.onSaved(0, '/tmp/gone-forever.mcai', 2)
    const store = studio.agentSession.store
    const result = store.write((emit) => emit(9, 0, 0), store.palette.indexOf('minecraft:stone'), { confirm: true })
    studio.agentSession.log.record(result, { tool: 'place_block', args: {}, source: 'llm', actor: 'assistant' })
    studio.autosaveNow()

    const outcome = studio.recover()!
    // 基准不在原处：只登记待办、**拒绝恢复**，并且如实说清为什么
    // （基准是 rev 0——测试里那个"文件"根本不存在——所以草稿是全部 3 步）
    expect(outcome.ops).toBe(3)
    expect(outcome.baseExists).toBe(false)
    // 提示里带着那个**路径**（数据，不跟语言变）。句子本身由文案表负责，
    // 这里不去匹配它的措辞。
    const notice = studio.state().notice ?? ''
    expect(notice).toContain('/tmp/gone-forever.mcai')
    // 硬着头皮"恢复"只会得到一个不是崩溃前的世界，所以这里必须什么都不做
    const before = studio.agentSession.store.contentHash()
    const state = await studio.applyRecovery()
    expect(state.recovery).toBeDefined()
    expect(studio.agentSession.store.contentHash()).toBe(before)
  })

  it('保存之后 WAL 里不再留着已保存的那一段（不会重复恢复）', async () => {
    const studio = makeStudio(3)
    const autosave = make()
    studio.attachAutosave(autosave)
    studio.autosaveNow()
    await studio.save(join(dir, 'p.mcai'))
    expect(autosave.pending()).toBeUndefined()
  })
})

describe('崩溃恢复：主进程真的把草稿接回世界', () => {
  /** 一个改一格并把这一步记进日志的小工具（人手的写法与模型一样）。 */
  function place(studio: StudioService, x: number): void {
    const store = studio.agentSession.store
    studio.agentSession.applyEdit('place_block', { pos: [x, 0, 0] }, () =>
      store.write((emit) => emit(x, 0, 0), store.palette.indexOf('minecraft:stone'), { confirm: true }),
    )
  }

  it('**保存 → 再改 → 崩溃 → 恢复出来的世界与崩溃前逐格一致**', async () => {
    const savePath = join(dir, 'crash.mcai')

    // —— 崩溃之前那个进程 ——
    const before = makeStudio(3)
    const wal = make()
    before.attachAutosave(wal)
    await before.save(savePath)
    place(before, 20)
    place(before, 21)
    expect(before.autosaveNow()).toBe(2)
    const expectedHash = before.agentSession.store.contentHash()
    expect(before.agentSession.store.stats().blocks).toBe(5)

    // —— 崩溃之后：换一个全新的工作台，只读磁盘上剩下的东西 ——
    const after = new StudioService({ plain: true })
    const reopened = make()
    after.attachAutosave(reopened)

    const pending = after.recover()!
    expect(pending).toMatchObject({ ops: 2, baseExists: true, basePath: savePath })
    // 只说"能恢复"不算数：此刻世界还是空的，草稿一步都没进去
    expect(after.agentSession.store.stats().blocks).toBe(0)

    const state = await after.applyRecovery()
    expect(state.recovery).toBeUndefined()
    expect(state.projectPath).toBe(savePath)
    expect(after.agentSession.store.contentHash()).toBe(expectedHash)
    expect(after.agentSession.store.stats().blocks).toBe(5)
    // 游标用最后一条 op 自己的编号，不用算术推
    expect(after.agentSession.store.revision).toBe(5)
    // 草稿已经进世界了：同一卷 WAL 不该被恢复第二次
    expect(reopened.pending()).toBeUndefined()
  })

  it('**WAL 里的实体与方块实体也要被恢复**（只贴方块那一层会安静地丢东西）', async () => {
    const savePath = join(dir, 'entities.mcai')

    // —— 崩溃之前那个进程 ——
    const before = makeStudio(2)
    const wal = make()
    before.attachAutosave(wal)
    await before.save(savePath)

    const store = before.agentSession.store
    const log = before.agentSession.log

    // 一笔"放一条船"：只有实体层，一个方块都不动
    const boatId = store.entities.allocateId(store.revision + 1)
    const boat = store.entities.set({
      id: boatId,
      type: 'minecraft:oak_boat',
      x: 8.5,
      y: 1,
      z: 8.5,
      yaw: 4,
    })!
    log.record(
      undefined,
      {
        tool: 'place_entity',
        args: {},
        source: 'llm',
        actor: 'assistant',
        worldRevision: store.commitEntities([boat]),
      },
      { entities: [boat] },
    )

    // 一笔"给桶里塞东西"：方块（走 WriteResult）+ 工具主动写的方块实体
    const barrel = store.write((emit) => emit(12, 0, 0), store.palette.indexOf('minecraft:barrel'), {
      confirm: true,
    })
    const contents: PlacedBlockEntity = {
      x: 12,
      y: 0,
      z: 0,
      kind: 'barrel',
      data: { items: [{ slot: 0, id: 'minecraft:coal', count: 8 }] },
    }
    const contentsChange = store.blockEntities.set(contents)!
    log.record(
      barrel,
      {
        tool: 'edit_block_entity',
        args: {},
        source: 'llm',
        actor: 'assistant',
        worldRevision: store.revision,
      },
      { blockEntities: [contentsChange] },
    )

    expect(before.autosaveNow()).toBe(2)
    const expectedHash = store.contentHash()
    expect(store.entities.size).toBe(1)
    expect(store.blockEntities.size).toBe(1)

    // —— 崩溃之后 ——
    const after = new StudioService({ plain: true })
    const reopened = make()
    after.attachAutosave(reopened)
    const pending = after.recover()!
    expect(pending).toMatchObject({ ops: 2, baseExists: true, basePath: savePath })
    // 草稿一步都还没进去
    expect(after.agentSession.store.entities.size).toBe(0)
    expect(after.agentSession.store.blockEntities.size).toBe(0)

    await after.applyRecovery()
    expect(after.agentSession.store.entities.get(boatId)?.type).toBe('minecraft:oak_boat')
    expect(after.agentSession.store.blockEntities.at({ x: 12, y: 0, z: 0 })).toEqual(contents)
    // 哈希对拍才是重点：少掉这两层的话，方块计数完全看不出来
    expect(after.agentSession.store.contentHash()).toBe(expectedHash)
    expect(after.agentSession.store.revision).toBe(4)
  })

  it('丢掉草稿：世界不变、WAL 清空、待办消失', () => {
    const studio = makeStudio(2)
    const autosave = make()
    studio.attachAutosave(autosave)
    autosave.onSaved(0, join(dir, 'somewhere.mcai'), 2)
    const store = studio.agentSession.store
    const result = store.write((emit) => emit(9, 0, 0), store.palette.indexOf('minecraft:stone'), { confirm: true })
    studio.agentSession.log.record(result, { tool: 'place_block', args: {}, source: 'llm', actor: 'assistant' })
    studio.autosaveNow()
    const before = store.contentHash()

    expect(studio.recover()).toBeDefined()
    const state = studio.discardRecovery()
    expect(state.recovery).toBeUndefined()
    expect(studio.recover()).toBeUndefined()
    expect(autosave.pending()).toBeUndefined()
    expect(store.contentHash()).toBe(before)
  })

  it('**重启的进程接管盘上那卷草稿，不会把同几步再记一遍**', () => {
    const studio = makeStudio(2)
    const first = make()
    first.journal(studio.agentSession.log)
    expect(first.pending()!.ops.map((op) => op.rev)).toEqual([1, 2])

    // 换一个进程（新的服务实例）接着写：它必须认出这卷 WAL 里已经有 rev 1..2
    const second = make()
    const result = studio.agentSession.store.write(
      (emit) => emit(9, 0, 0),
      studio.agentSession.store.palette.indexOf('minecraft:stone'),
      { confirm: true },
    )
    studio.agentSession.log.record(result, { tool: 'place_block', args: {}, source: 'llm', actor: 'assistant' })
    expect(second.journal(studio.agentSession.log)).toBe(1)
    expect(second.pending()!.ops.map((op) => op.rev)).toEqual([1, 2, 3])
  })

  it('**撤销到保存点之后继续改：草稿整卷重写，旧的几条不会留在里面**', () => {
    const studio = makeStudio(3)
    const autosave = make()
    studio.attachAutosave(autosave)
    autosave.journal(studio.agentSession.log) // rev 1..3（还没保存过，全部是草稿）
    const store = studio.agentSession.store

    // 退回 rev 2 再改一格：日志被截断，rev 3 换成另一条内容
    store.setRevision(2)
    const result = store.write((emit) => emit(9, 0, 0), store.palette.indexOf('minecraft:diamond_block'), {
      confirm: true,
    })
    studio.agentSession.log.record(result, {
      tool: 'place_block',
      args: {},
      source: 'user',
      actor: 'user',
      worldRevision: store.revision,
    })
    expect(studio.agentSession.log.length).toBe(3)

    // 整卷重写：3 条一起重写一遍（WAL 只能追加，改不了历史），
    // 而 rev 3 是**新的**那条，不是被截断掉的那条
    expect(autosave.journal(studio.agentSession.log)).toBe(3)
    const pending = autosave.pending()!
    expect(pending.ops.map((op) => op.rev)).toEqual([1, 2, 3])
    const last = pending.ops[2]!
    const logged = studio.agentSession.log.byRevision(3)!
    expect(last.patch.toBuffer().equals(logged.patch.toBuffer())).toBe(true)
  })

  it('**退回保存点之前再改：草稿里不放它**（那是要保存才能固定住的事）', () => {
    const studio = makeStudio(3)
    const autosave = make()
    studio.attachAutosave(autosave)
    const savePath = join(dir, 'saved.mcai')
    autosave.journal(studio.agentSession.log)
    autosave.onSaved(3, savePath, 3) // 基准 = rev 3
    expect(autosave.pending()).toBeUndefined()

    const store = studio.agentSession.store
    store.setRevision(1)
    const result = store.write((emit) => emit(9, 0, 0), store.palette.indexOf('minecraft:stone'), { confirm: true })
    studio.agentSession.log.record(result, {
      tool: 'place_block',
      args: {},
      source: 'user',
      actor: 'user',
      worldRevision: store.revision,
    })
    expect(studio.agentSession.log.length).toBe(2)

    // 这条 op 的编号（2）落在基准（3）里面，WAL 里表达不了——
    // 硬记下来只会在恢复时与工程文件里的 op 撞号。如实什么都不记。
    expect(autosave.journal(studio.agentSession.log)).toBe(0)
    expect(autosave.pending()).toBeUndefined()
  })
})
