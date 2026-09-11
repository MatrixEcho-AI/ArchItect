import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { measure } from '@architect/core'
import type { ShotInput } from '@architect/agent'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { StudioService } from '../src/main/services/studio.js'
import type { StudioEvent } from '../src/main/services/chat.js'

// 用确定性兜底配色，跳过 352MB 资源包的加载
const makeStudio = (): StudioService => new StudioService({ plain: true })

let workspace: string
beforeAll(async () => {
  workspace = await mkdtemp(join(tmpdir(), 'architect-studio-'))
})
afterAll(async () => {
  await rm(workspace, { recursive: true, force: true })
})

describe('StudioService：状态', () => {
  it('新建是空世界', () => {
    const state = makeStudio().newProject()
    expect(state.blocks).toBe(0)
    expect(state.revision).toBe(0)
    expect(state.totalOps).toBe(0)
    expect(state.bounds).toBeUndefined()
    expect(state.histogram).toEqual([])
  })

  it('示例小屋生成出合规的结构', () => {
    const studio = makeStudio()
    const state = studio.demo()

    expect(state.totalOps).toBeGreaterThan(4)
    expect(state.revision).toBe(state.totalOps)
    expect(state.blocks).toBeGreaterThan(200)
    expect(state.bounds).toBeDefined()
    expect(state.histogram.length).toBeGreaterThan(1)

    // 门洞净高 2
    const store = studio.agentSession.store
    expect(store.isAir({ x: 8, y: 1, z: 4 })).toBe(true)
    expect(store.isAir({ x: 8, y: 2, z: 4 })).toBe(true)
    expect(store.isAir({ x: 8, y: 3, z: 4 })).toBe(false)
    // 屋顶比墙高
    const stats = measure(store)
    expect(stats.bounds!.max.y).toBeGreaterThan(8)
  })

  it('每个 op 都记录了工具名与改动格数', () => {
    const state = makeStudio().demo()
    for (const op of state.ops) {
      expect(op.tool.length).toBeGreaterThan(0)
      expect(op.changed).toBeGreaterThan(0)
      expect(op.rev).toBeGreaterThan(0)
      // 谁改的：界面要能一眼分开"模型改的"与"我改的"
      expect(['llm', 'user']).toContain(op.source)
    }
  })

  it('**opDetail 给出参数与改动量**（工具调用检查器点开某一步）', () => {
    const studio = makeStudio()
    studio.demo()
    const last = studio.state().totalOps

    // 示例小屋是**宿主**造的（不是模型），所以它的 source 是 user；
    // 这里借着它验形状，下面再验"模型那一侧"能区分出来
    const demoOp = studio.opDetail(1)!
    expect(demoOp.tool.length).toBeGreaterThan(0)
    expect(demoOp.source).toBe('user')
    expect(demoOp.result.changed).toBeGreaterThan(0)
    expect(demoOp.args).toBeDefined()

    // 人手放一格：同一条日志、同一个 `rev` 序列，只有 `source` 不同
    const state = studio.editBlock({ pos: [2, 2, 2], block: 'minecraft:stone', mode: 'place' })
    expect(state.totalOps).toBe(last + 1)
    const mine = studio.opDetail(state.totalOps)!
    expect(mine.source).toBe('user')
    expect(mine.args).toMatchObject({ pos: [2, 2, 2], block: 'minecraft:stone' })
    expect(mine.result.changed).toBe(1)

    // 模型那一侧：`applyEdit` 默认是宿主（user），工具循环里走的是同一个方法、
    // 只是带了另一个 actor——所以"谁改的"这件事只有一个字段的差别（D-61）
    const store = studio.agentSession.store
    studio.agentSession.applyEdit(
      'place_block',
      { pos: [3, 3, 3] },
      () => store.write((emit) => emit(3, 3, 3), store.palette.indexOf('minecraft:stone'), { confirm: true }),
      { source: 'llm', actor: 'assistant' },
    )
    const fromModel = studio.opDetail(studio.state().totalOps)!
    expect(fromModel.source).toBe('llm')
    expect(fromModel.actor).toBe('assistant')

    // 不存在的版本问不出东西，也不该抛
    expect(studio.opDetail(9999)).toBeUndefined()
  })
})

describe('StudioService：截图', () => {
  it('返回可用的 PNG', async () => {
    const studio = makeStudio()
    studio.demo()
    const shot = await studio.shoot({ view: 'iso_ne', width: 240, height: 180 })
    expect(shot.png.length).toBeGreaterThan(500)
    expect(shot.view).toBe('iso_ne')
    expect(shot.revision).toBe(studio.state().revision)
    // PNG 魔数
    expect([...shot.png.slice(0, 4)]).toEqual([0x89, 0x50, 0x4e, 0x47])
  })

  it('不同机位产生不同图', async () => {
    const studio = makeStudio()
    studio.demo()
    const a = await studio.shoot({ view: 'iso_ne', width: 240, height: 180 })
    const b = await studio.shoot({ view: 'top', width: 240, height: 180 })
    expect([...a.png]).not.toEqual([...b.png])
  })

  it('空世界也能渲染（会画出工区线框与标尺）', async () => {
    const studio = makeStudio()
    await expect(studio.shoot({ view: 'iso_ne', width: 160, height: 120 })).resolves.toBeDefined()
  })
})

describe('StudioService：GPU 截图通道', () => {
  /** 一个假的"渲染进程"：把请求记下来，按需要成功或失败。 */
  const stub = (
    behavior: 'ok' | 'refuse' | 'throw',
  ): { bridge: { capture: (input: ShotInput) => Promise<Uint8Array | undefined> }; seen: ShotInput[] } => {
    const seen: ShotInput[] = []
    return {
      seen,
      bridge: {
        capture: async (input) => {
          seen.push(input)
          if (behavior === 'refuse') return undefined
          if (behavior === 'throw') throw new Error('渲染进程没了')
          return new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3])
        },
      },
    }
  }

  it('接上通道之后，截图交给它，且相机已经解算好', async () => {
    const { bridge, seen } = stub('ok')
    const studio = new StudioService({ shots: bridge })
    studio.demo()
    const shot = await studio.shoot({ view: 'iso_ne', width: 240, height: 180 })
    expect(shot.png.length).toBe(7)
    expect(seen).toHaveLength(1)
    // 解算好的相机带着尺寸与缩放，渲染进程不重新取景
    expect(seen[0]!.camera.width).toBe(240)
    expect(seen[0]!.camera.height).toBe(180)
    expect(seen[0]!.camera.scale).toBeGreaterThan(0)
    expect(seen[0]!.revision).toBe(studio.state().revision)
  })

  it('**纯色会话不碰 GPU**：那条路要图集，问了也是白问', async () => {
    const { bridge, seen } = stub('ok')
    const studio = new StudioService({ plain: true, shots: bridge })
    studio.demo()
    const shot = await studio.shoot({ view: 'iso_ne', width: 120, height: 90 })
    expect(seen).toEqual([])
    // 没有回落——这是按设计走软件路径，不是"GPU 用不了"
    expect(studio.renderFallback).toBeUndefined()
    expect([...shot.png.slice(0, 4)]).toEqual([0x89, 0x50, 0x4e, 0x47])
  })

  it('通道拒绝时退回软件光栅器，并记下原因', async () => {
    const { bridge } = stub('refuse')
    const studio = new StudioService({ shots: bridge })
    studio.demo()
    const shot = await studio.shoot({ view: 'iso_ne', width: 240, height: 180 })
    expect([...shot.png.slice(0, 4)]).toEqual([0x89, 0x50, 0x4e, 0x47])
    expect(shot.png.length).toBeGreaterThan(500)
    expect(studio.renderFallback).toBe('外部渲染后端拒绝了这一枪')
  })

  it('通道抛错也不会把截图整体带走', async () => {
    const { bridge } = stub('throw')
    const studio = new StudioService({ shots: bridge })
    studio.demo()
    const shot = await studio.shoot({ view: 'iso_ne', width: 200, height: 150 })
    expect(shot.png.length).toBeGreaterThan(500)
    expect(studio.renderFallback).toBe('渲染进程没了')
  })
})

describe('StudioService：人机共用机位', () => {
  it('机位写进会话相机，并回显在状态里', () => {
    const studio = makeStudio()
    expect(studio.state().camera).toBeUndefined()
    const state = studio.setCamera({ azimuth: 31, elevation: 27, lookAt: [16, 6, 0] })
    expect(state.camera).toEqual({ azimuth: 31, elevation: 27, lookAt: [16, 6, 0] })
    // 后续每一次 state 都带着它——界面刷新不该把它洗掉
    expect(studio.state().camera).toEqual({ azimuth: 31, elevation: 27, lookAt: [16, 6, 0] })
  })

  it('传 null 复原（界面上的「复原」按钮走这条）', () => {
    const studio = makeStudio()
    studio.setCamera({ azimuth: 31, elevation: 27 })
    const state = studio.setCamera(null)
    expect(state.camera).toBeUndefined()
  })

  it('**设了机位之后，模型的截图真的换了机位**（不只是记了个字段）', async () => {
    const studio = makeStudio()
    studio.demo()
    const before = await studio.shoot({ view: 'iso_ne', width: 240, height: 180 })
    expect(before.view).toBe('iso_ne')

    studio.setCamera({ azimuth: 31, elevation: 27, lookAt: [16, 6, 0] })
    const after = await studio.shoot({ view: 'iso_ne', width: 240, height: 180 })
    // 标签、像素、机位三者都要变——只看标签的话，"记了字段但没真用"也能过
    expect(after.view).toBe('az31/el27→(16,6,0)')
    expect([...after.png]).not.toEqual([...before.png])
  })
})

describe('StudioService：时间旅行', () => {
  it('向后 seek 真正回退世界', () => {
    const studio = makeStudio()
    const full = studio.demo()
    const fullBlocks = full.blocks

    const mid = studio.seek(Math.max(1, full.totalOps - 3))
    expect(mid.revision).toBe(Math.max(1, full.totalOps - 3))
    expect(mid.blocks).toBeLessThan(fullBlocks)

    const back = studio.seekLatest()
    expect(back.revision).toBe(full.totalOps)
    expect(back.blocks).toBe(fullBlocks)
  })

  it('**写入之后 backward seek 仍然正确**（回归：游标不能与真实版本脱节）', () => {
    // 这是 StudioService 里最容易错的地方：demo() 写了 8 次世界，
    // 如果回放会话的游标还停在 0，seek(5) 会以为自己已经回退过，于是不重建，
    // 结果 rev 5 里混着 rev 8 的方块。
    const studio = makeStudio()
    const full = studio.demo()
    const rev5 = studio.seek(5)
    expect(rev5.revision).toBe(5)
    expect(rev5.blocks).toBeLessThan(full.blocks)

    // 再回到最新，方块数必须精确复原
    expect(studio.seekLatest().blocks).toBe(full.blocks)
  })

  it('seek 到 0 得到空世界', () => {
    const studio = makeStudio()
    studio.demo()
    const zero = studio.seek(0)
    expect(zero.blocks).toBe(0)
  })
})

describe('StudioService：撤销 / 重做', () => {
  it('撤销是**游标退一格**：方块回去、日志长度不变', () => {
    const studio = makeStudio()
    const full = studio.demo()
    const ops = full.totalOps

    const undone = studio.undo()
    expect(undone.revision).toBe(ops - 1)
    expect(undone.blocks).toBeLessThan(full.blocks)
    // 关键：撤销不进日志。进的话时间线上会冒出一步"撤销"，而模型看不到它
    expect(undone.totalOps).toBe(ops)
    expect(undone.canUndo).toBe(true)
    expect(undone.canRedo).toBe(true)
    expect(undone.behindTip).toBe(true)

    const redone = studio.redo()
    expect(redone.revision).toBe(ops)
    expect(redone.blocks).toBe(full.blocks)
    expect(redone.behindTip).toBe(false)
    expect(redone.canRedo).toBe(false)
  })

  it('撤销到底再撤销是空操作（不会把版本号拧成负的）', () => {
    const studio = makeStudio()
    const full = studio.demo()
    for (let i = 0; i < full.totalOps + 3; i++) studio.undo()
    const state = studio.state()
    expect(state.revision).toBe(0)
    expect(state.blocks).toBe(0)
    expect(state.canUndo).toBe(false)
  })

  it('**撤销之后保存再打开，撤销的结果不丢**（回归：日志与世界脱节）', async () => {
    const studio = makeStudio()
    const full = studio.demo()
    studio.undo()
    studio.undo()
    const expected = studio.state()
    const path = join(workspace, 'undone.mcai')
    await studio.save(path)

    const reopened = makeStudio()
    const opened = await reopened.open(path)
    expect(opened.revision).toBe(expected.revision)
    expect(opened.blocks).toBe(expected.blocks)
    expect(opened.totalOps).toBe(full.totalOps)
    // 重开的工程里游标仍然停在同一个位置，重做还能把后面拿回来
    expect(reopened.redo().blocks).toBeGreaterThan(opened.blocks)
  })

  it('停历史版本上时**拒绝发消息**，并给出可照做的提示', () => {
    const studio = makeStudio()
    const full = studio.demo()
    const events: StudioEvent[] = []
    studio.onEvent((event) => events.push(event))
    studio.seek(full.totalOps - 2)

    const view = studio.send('再高一点')
    // 没进对话——否则模型会在这里从历史分叉，把后面两步覆盖掉
    expect(view.messages).toEqual([])
    // 提示是**一次性**的，所以走事件读（界面就是这么拿的），而不是事后再问一次 state
    const notice = events
      .map((event) => (event.type === 'state' ? (event.state as { notice?: string }).notice : undefined))
      .find((value) => value !== undefined)
    expect(notice).toContain('历史版本')
    expect(notice).toContain('2 步')
  })

  it('回到最新之后那道闸放开（接下来卡在"还没选模型"上是另一回事）', () => {
    const studio = makeStudio()
    studio.demo()
    studio.seek(1)
    studio.seekLatest()
    expect(studio.state().behindTip).toBe(false)
    // 过了历史那道闸才会走到 ChatController 的配置检查，报的是模型没选而不是历史版本
    expect(() => studio.send('再高一点')).toThrow(/还没选定模型/)
  })
})

describe('StudioService：软件视口（没有 WebGL 时的兜底）', () => {
  it('出一帧原始 RGBA，长度与尺寸对得上', () => {
    const studio = makeStudio()
    studio.demo()
    const frame = studio.viewport({ azimuth: 45, elevation: 30, width: 120, height: 90 })
    expect(frame.pixels.length).toBe(120 * 90 * 4)
    expect(frame.width).toBe(120)
    expect(frame.height).toBe(90)
    expect(frame.revision).toBe(studio.state().revision)
    expect(frame.scale).toBeGreaterThan(0)
  })

  it('第二帧命中网格缓存（拖动靠它才跟得上）', () => {
    const studio = makeStudio()
    studio.demo()
    const first = studio.viewport({ azimuth: 45, elevation: 30, width: 120, height: 90 })
    expect(first.meshed).toBe(true)
    const second = studio.viewport({ azimuth: 60, elevation: 30, width: 120, height: 90 })
    expect(second.meshed).toBe(false)
  })

  it('**注视点与滚转也要生效**：机位面板设的机位在兜底路径上不能丢', () => {
    const studio = makeStudio()
    studio.demo()
    const centred = studio.viewport({ azimuth: 45, elevation: 30, width: 120, height: 90 })
    const offset = studio.viewport({
      azimuth: 45,
      elevation: 30,
      target: [16, 6, 0],
      width: 120,
      height: 90,
    })
    // 取景中心确实挪了，画面也真的变了（只改字段不改画面的话这里会相等）
    expect(offset.target).toEqual([16, 6, 0])
    expect(offset.target).not.toEqual(centred.target)
    expect([...offset.pixels]).not.toEqual([...centred.pixels])

    const rolled = studio.viewport({ azimuth: 45, elevation: 30, roll: 30, width: 120, height: 90 })
    expect([...rolled.pixels]).not.toEqual([...centred.pixels])
  })

  it('draft 帧跳过叠加层（拖动时文字每帧都在抖）', () => {
    const studio = makeStudio()
    studio.demo()
    const full = studio.viewport({ azimuth: 45, elevation: 30, width: 160, height: 120 })
    const draft = studio.viewport({ azimuth: 45, elevation: 30, width: 160, height: 120, draft: true })
    expect([...draft.pixels]).not.toEqual([...full.pixels])
  })
})

describe('StudioService：切片', () => {
  it('返回 ASCII 平面图', () => {
    const studio = makeStudio()
    studio.demo()
    const text = studio.slice({ axis: 'y', index: 1, x: [0, 15], z: [0, 15] })
    expect(text).toContain('slice(axis=y, index=1)')
    expect(text).toContain('legend:')
  })

  it('范围过大时返回可读的错误而不是抛异常', () => {
    const studio = new StudioService({
      plain: true,
      volume: { min: { x: 0, y: 0, z: 0 }, max: { x: 127, y: 63, z: 127 } },
    })
    const text = studio.slice({ axis: 'y', index: 0 })
    expect(text).toContain('无法渲染切片')
    expect(text).toContain('exceeding the limit')
  })
})

describe('StudioService：保存与打开', () => {
  it('往返之后世界与历史都保住', async () => {
    const studio = makeStudio()
    const before = studio.demo()
    const path = join(workspace, 'roundtrip.mcai')
    await studio.save(path)
    expect((await stat(path)).size).toBeGreaterThan(500)

    const reopened = await makeStudio().open(path)
    expect(reopened.totalOps).toBe(before.totalOps)
    expect(reopened.blocks).toBe(before.blocks)
    expect(reopened.bounds).toEqual(before.bounds)
    expect(reopened.revision).toBe(before.revision)
  })

  it('**打开时用工程的调色板**（回归：索引 1 曾经指向不存在的方块）', async () => {
    // 快照里的方块索引是相对**该工程调色板**编的。用一张只有 air 的新表去解释，
    // 索引 1 就找不到方块，直接 RangeError。
    const original = makeStudio()
    original.demo()
    const path = join(workspace, 'palette.mcai')
    await original.save(path)

    const reopened = makeStudio()
    await expect(reopened.open(path)).resolves.toBeDefined()
    expect(reopened.state().paletteSize).toBeGreaterThan(1)

    // 打开后还能继续编辑（调色板接得上）
    const store = reopened.agentSession.store
    expect(store.getBlockString({ x: 4, y: 0, z: 4 })).toBe('minecraft:oak_planks')
  })

  it('打开后时间旅行仍然可用', async () => {
    const original = makeStudio()
    const before = original.demo()
    const path = join(workspace, 'timeline.mcai')
    await original.save(path)

    const studio = makeStudio()
    const opened = await studio.open(path)
    expect(opened.blocks).toBe(before.blocks)

    const back = studio.seek(Math.max(1, before.totalOps - 3))
    expect(back.blocks).toBeLessThan(before.blocks)
    expect(studio.seekLatest().blocks).toBe(before.blocks)
  })

  it('第二次保存不需要再给路径', async () => {
    const studio = makeStudio()
    studio.demo()
    const path = join(workspace, 'resave.mcai')
    await studio.save(path)
    expect(await studio.save()).toBe(path)
  })
})

describe('StudioService：measureText', () => {
  it('空世界给明确说明', () => {
    expect(makeStudio().measureText()).toContain('空')
  })

  it('有内容时报尺寸与方块数', () => {
    const studio = makeStudio()
    studio.demo()
    const text = studio.measureText()
    expect(text).toContain('尺寸')
    expect(text).toContain('方块')
  })
})

describe('StudioService：人手接管（点哪儿改哪儿）', () => {
  /** 视口的相机参数：拾取与绘图必须用同一套。 */
  const VIEW = { azimuth: 45, elevation: 30, width: 320, height: 240 }

  it('画面中心打中小屋：格子、朝向、放置位置三者自洽', () => {
    const studio = makeStudio()
    studio.demo()
    const hit = studio.pick({ ...VIEW, x: VIEW.width / 2, y: VIEW.height / 2 })
    expect(hit).toBeDefined()
    const bounds = studio.state().bounds!
    for (const axis of [0, 1, 2] as const) {
      expect(hit!.block[axis]).toBeGreaterThanOrEqual(bounds.min[axis])
      expect(hit!.block[axis]).toBeLessThanOrEqual(bounds.max[axis])
    }
    // 放置位置永远是命中格的相邻格（差一格，且只差一格）
    const step = [0, 1, 2].reduce((sum, i) => sum + Math.abs(hit!.place[i]! - hit!.block[i]!), 0)
    expect(step).toBe(1)
    // 命中的那一格不可能是空气——空气没有面
    expect(hit!.blockId).not.toBe('minecraft:air')
  })

  it('点到天空返回 undefined（不该改任何东西）', () => {
    const studio = makeStudio()
    studio.demo()
    // 缩到很小，画面绝大部分是空的
    const hit = studio.pick({ ...VIEW, scale: 4, x: 2, y: 2 })
    expect(hit).toBeUndefined()
  })

  it('**人手放的一格和模型放的一格完全同权**：进日志、记 source:user、能被撤销', () => {
    const studio = makeStudio()
    const before = studio.demo()
    const target: [number, number, number] = [20, 5, 20]

    const after = studio.editBlock({ pos: target, block: 'minecraft:gold_block', mode: 'place' })
    expect(after.blocks).toBe(before.blocks + 1)
    expect(after.revision).toBe(before.revision + 1)
    expect(after.totalOps).toBe(before.totalOps + 1)
    expect(studio.agentSession.store.getBlockString({ x: 20, y: 5, z: 20 })).toContain('gold_block')

    // 最后一条 op 是人的（`source` 进 `.mcai`，事后分得清谁改的）
    const op = studio.agentSession.log.at(studio.agentSession.log.length - 1)!
    expect(op.tool).toBe('place_block')
    expect(op.source).toBe('user')
    expect(op.actor).toBe('user')

    // 同权的最硬证据：撤销把**人的**那一笔也退掉了
    expect(studio.undo().blocks).toBe(before.blocks)
    expect(studio.redo().blocks).toBe(before.blocks + 1)
  })

  it('人手改的一笔**存进 .mcai 再打开还在**（不能只活在内存里）', async () => {
    const studio = makeStudio()
    studio.demo()
    studio.editBlock({ pos: [20, 5, 20], block: 'minecraft:gold_block', mode: 'place' })
    const expected = studio.state()
    const path = join(workspace, 'hand-edited.mcai')
    await studio.save(path)

    const reopened = makeStudio()
    const opened = await reopened.open(path)
    expect(opened.blocks).toBe(expected.blocks)
    expect(opened.revision).toBe(expected.revision)
    expect(reopened.state().histogram.some((entry) => entry.block.includes('gold_block'))).toBe(true)
  })

  it('挖掉一格也进日志', () => {
    const studio = makeStudio()
    const before = studio.demo()
    const pos: [number, number, number] = [4, 1, 4] // 墙脚
    expect(studio.agentSession.store.isAir({ x: 4, y: 1, z: 4 })).toBe(false)
    const after = studio.editBlock({ pos, mode: 'break' })
    expect(after.blocks).toBe(before.blocks - 1)
    expect(studio.agentSession.store.isAir({ x: 4, y: 1, z: 4 })).toBe(true)
    expect(studio.agentSession.log.at(studio.agentSession.log.length - 1)!.tool).toBe('break_block')
  })

  it('工区外**拒绝**而不是悄悄裁掉（悄悄裁掉的话用户只会觉得"点了没反应"）', () => {
    const studio = makeStudio()
    studio.demo()
    expect(() => studio.editBlock({ pos: [-1, 5, 5], block: 'minecraft:stone', mode: 'place' })).toThrow(/工区/)
    expect(() => studio.editBlock({ pos: [-1, 5, 5], mode: 'break' })).toThrow(/工区/)
  })

  it('挖空气、放认不出的方块名都被拒绝（后者会污染调色板）', () => {
    const studio = makeStudio()
    studio.demo()
    const empty: [number, number, number] = [2, 2, 2]
    expect(studio.agentSession.store.isAir({ x: 2, y: 2, z: 2 })).toBe(true)
    expect(() => studio.editBlock({ pos: empty, mode: 'break' })).toThrow(/本来就是空/)
    expect(() => studio.editBlock({ pos: [2, 2, 2], block: 'minecraft:not_a_block', mode: 'place' })).toThrow(
      /认不出/,
    )
    // 认不出的名字**不能**被悄悄追加进调色板：`palette.indexOf` 是"没有就建一个"
    expect(studio.agentSession.store.palette.strings().some((item) => item.includes('not_a_block'))).toBe(false)
  })

  it('还没选方块时拒绝放置', () => {
    const studio = makeStudio()
    studio.demo()
    expect(() => studio.editBlock({ pos: [2, 2, 2], mode: 'place' })).toThrow(/还没选方块/)
  })

  it('调色板搜得到，且**短名字排在前面**（搜 stone 时 stone 该在 stone_brick_stairs 前）', () => {
    const studio = makeStudio()
    const matches = studio.blocks('stone')
    expect(matches.length).toBeGreaterThan(5)
    expect(matches.length).toBeLessThanOrEqual(60)
    expect(matches[0]).toBe('stone')
    expect(matches).toContain('stone_bricks')
    expect(studio.blocks('')).toEqual([])
  })
})

describe('StudioService：导入之后能接着改（M7 验收的另一半）', () => {
  it('**导入的工程是"基准状态"，接着编辑从 rev 1 开始，而且能存回去**', async () => {
    // 先造一份 .schem：把示例小屋导出去，再导进一个新工作台
    const source = makeStudio()
    source.demo()
    const schem = join(workspace, 'import-then-edit.schem')
    const exported = source.exportModel('schem', schem)
    await writeFile(schem, exported.files[0]!.bytes)

    const target = makeStudio()
    const imported = await target.importModel(schem)
    expect(imported.state.blocks).toBeGreaterThan(0)
    // 导入的内容**不在 op 流里**：游标是 0，日志也是空的（rev 0 = 打开时看到的样子）
    expect(imported.state.revision).toBe(0)
    expect(imported.state.totalOps).toBe(0)

    // 接着改一格：它必须成为 rev 1（而不是接在"虚构的历史"后面）
    const blocksBefore = imported.state.blocks
    const after = target.editBlock({ pos: [1, 1, 1], block: 'minecraft:gold_block', mode: 'place' })
    expect(after.revision).toBe(1)
    expect(after.totalOps).toBe(1)
    expect(after.blocks).toBe(blocksBefore + 1)
    // 撤销回到导入时那一版（基准不在 op 流里，所以退回 0 就是导入的样子）
    expect(target.undo().blocks).toBe(blocksBefore)

    // 存回去：再打开时内容一致（导入 → 编辑 → 保存 → 打开 这一圈是闭环的）
    const saved = join(workspace, 'import-then-edit.mcai')
    await target.save(saved)
    const reopened = makeStudio()
    const state = await reopened.open(saved)
    expect(state.blocks).toBe(blocksBefore)
    expect(state.revision).toBe(0)
  })
})

describe('StudioService：设计笔记的保存与恢复（模型重开工程不该失忆）', () => {
  it('**模型写下笔记 → 保存 → 重开，笔记还在，而且进了系统提示**', async () => {
    const studio = makeStudio()
    studio.demo()
    // 走真实的工具路径写笔记
    const result = await studio.agentSession.registry.call(studio.agentSession.ctx, 'update_notes', {
      notes: '八角基座 17 格；塔身收分到 5 格；门朝南非',
    })
    expect(result.ok).toBe(true)
    expect(studio.agentSession.currentDesignNotes).toContain('八角基座')

    const path = join(workspace, 'notes.mcai')
    await studio.save(path)

    const reopened = makeStudio()
    await reopened.open(path)
    expect(reopened.agentSession.currentDesignNotes).toContain('八角基座')
    expect(reopened.agentSession.buildSystem()).toContain('八角基座 17 格')
  })
})
