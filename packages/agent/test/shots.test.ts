import { describe, expect, it } from 'vitest'

import { AgentSession } from '../src/session.js'
import type { ShotInput, ShotRenderer } from '../src/session.js'

/**
 * 截图的后端选择。
 *
 * 这里要钉死的是**回落语义**：桌面端有 GPU 就把这一枪交给它，拿不到就必须
 * 悄悄退回软件光栅器——截图是模型的眼睛，`screenshot` 失败一次，
 * 那一轮对话就变成了盲改。
 */

const VOLUME = { min: { x: 0, y: 0, z: 0 }, max: { x: 15, y: 15, z: 15 } }

/** 有纹理的会话（会读资源包，但整个文件只付一次）。 */
const makeSession = (render?: ShotRenderer): AgentSession =>
  new AgentSession({
    volume: VOLUME,
    ...(render !== undefined ? { render } : {}),
  })

const pngMagic = (png: Uint8Array): number[] => [...png.slice(0, 4)]

const stone = (session: AgentSession): number => session.store.palette.indexOf('minecraft:stone')

describe('截图：外部渲染后端', () => {
  it('递过去的相机是**已经解算好的**，渲染进程不需要重新取景', async () => {
    const seen: ShotInput[] = []
    const session = makeSession((input) => {
      seen.push(input)
      return { png: new Uint8Array([1, 2, 3]), width: input.width, height: input.height, camera: input.view, revision: input.revision }
    })
    session.store.write((emit) => emit(1, 1, 1), stone(session), { confirm: true })

    const image = await session.ctx.shoot({ view: 'iso_ne', width: 640, height: 480 })

    expect(seen).toHaveLength(1)
    const input = seen[0]!
    expect(input.camera.width).toBe(640)
    expect(input.camera.height).toBe(480)
    expect(input.camera.scale).toBeGreaterThan(0)
    expect(input.camera.target).toBeDefined()
    expect(input.textured).toBe(true)
    expect(input.revision).toBe(session.store.revision)
    // 叠加层与软件路径同一份：标尺、坐标轴、工区线框都在
    expect(input.overlays.ruler).toBe(true)
    expect(input.overlays.axisGizmo).toBe(true)
    expect(input.overlays.volumeBox).toEqual(VOLUME)
    expect(image.png.length).toBe(3)
  })

  it('后端说"画不了"时退回软件光栅器，并把原因记下来', async () => {
    const session = makeSession(() => undefined)
    session.store.write((emit) => emit(1, 1, 1), stone(session), { confirm: true })

    const image = await session.ctx.shoot({ view: 'iso_ne', width: 160, height: 120 })

    expect(pngMagic(image.png)).toEqual([0x89, 0x50, 0x4e, 0x47])
    expect(image.revision).toBe(session.store.revision)
    expect(session.renderFallback).toBe('外部渲染后端拒绝了这一枪')
  })

  it('后端抛错也只是回落，不会把整轮对话带走', async () => {
    const session = makeSession(() => {
      throw new Error('渲染进程没了')
    })
    session.store.write((emit) => emit(1, 1, 1), stone(session), { confirm: true })

    const image = await session.ctx.shoot({ view: 'iso_ne', width: 160, height: 120 })

    expect(pngMagic(image.png)).toEqual([0x89, 0x50, 0x4e, 0x47])
    expect(session.renderFallback).toBe('渲染进程没了')
  })

  it('**渲染期间世界被改动 → 那张图作废**，不能拿旧图当新图', async () => {
    const session = makeSession((input) => {
      // 模拟"IPC 飞行途中用户又改了一格"：await 期间世界推进了一个 revision
      session.store.write((emit) => emit(2, 2, 2), stone(session), {
        confirm: true,
      })
      return {
        png: new Uint8Array([9, 9, 9]),
        width: input.width,
        height: input.height,
        camera: input.view,
        revision: input.revision,
      }
    })
    session.store.write((emit) => emit(1, 1, 1), stone(session), { confirm: true })

    const image = await session.ctx.shoot({ view: 'iso_ne', width: 160, height: 120 })

    // 拿到的必须是软件光栅器**按新状态**画的那张，而不是那个 3 字节的假图
    expect(pngMagic(image.png)).toEqual([0x89, 0x50, 0x4e, 0x47])
    expect(image.revision).toBe(session.store.revision)
    expect(session.renderFallback).toBe('渲染期间世界被改动，这一枪作废')
  })

  it('纯色会话**根本不问**外部后端，也不算回落', async () => {
    let called = 0
    const session = new AgentSession({
      volume: VOLUME,
      plain: true,
      render: () => {
        called++
        return undefined
      },
    })
    session.store.write((emit) => emit(1, 1, 1), stone(session), { confirm: true })

    const image = await session.ctx.shoot({ view: 'iso_ne', width: 160, height: 120 })

    expect(called).toBe(0)
    expect(session.renderFallback).toBeUndefined()
    expect(pngMagic(image.png)).toEqual([0x89, 0x50, 0x4e, 0x47])
  })

  it('没有外部后端时行为不变（CLI / CI）', async () => {
    const session = new AgentSession({ volume: VOLUME, plain: true })
    session.store.write((emit) => emit(1, 1, 1), stone(session), { confirm: true })

    const image = await session.ctx.shoot({ view: 'iso_ne', width: 160, height: 120 })

    expect(pngMagic(image.png)).toEqual([0x89, 0x50, 0x4e, 0x47])
    expect(image.camera).toBe('iso_ne')
    expect(session.screenshots).toBe(1)
    expect(session.renderFallback).toBeUndefined()
  })
})
