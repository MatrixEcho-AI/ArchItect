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

  it('**基准不在原处时给出可读的说明，而不是硬凑一份恢复**', () => {
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
    expect(outcome.restored).toBe(0)
    expect(outcome.message).toContain('基准工程已经不在原处')
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
