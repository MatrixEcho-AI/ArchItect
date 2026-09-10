import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { measure } from '@architect/core'
import type { ShotInput } from '@architect/agent'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { StudioService } from '../src/main/services/studio.js'

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
    }
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
