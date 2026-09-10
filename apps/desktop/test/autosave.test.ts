import { mkdtempSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

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
    const notice = studio.state().notice ?? ''
    expect(notice).toContain('已经不在原处')
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
