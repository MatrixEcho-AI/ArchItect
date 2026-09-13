import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { SoftwareViewport } from '../src/renderer/viewport.js'
import type { SoftwareFrame, SoftwareFrameRequest, ViewportCamera } from '../src/renderer/viewport.js'

/**
 * 软件视口（没有 WebGL 时的兜底）。
 *
 * 它全部的价值在两条**时序**性质上，而不是"能画出图"：
 *
 * 1. **请求要合并**。拖动时 pointermove 比光栅化快得多，排队的结果是画面越拖越落后。
 * 2. **相同的帧不要重画**。每次状态事件（对话多一条消息、自动保存）都会触发一次
 *    重绘请求，而同一个版本 + 同一个机位的图是逐像素一样的。
 *
 * 这两条在 Node 里能直接测——`SoftwareViewport` 刻意不碰 DOM，
 * 它只往 `FrameSink` 里塞帧、只通过注入的 `requestFrame` 要帧。
 */

const VIEW: ViewportCamera = { azimuth: 45, elevation: 30, roll: 0, scale: 0 }

/** 一个记账用的假主进程：记下每一次请求，返回一张能认出是哪一帧的图。 */
function fakeHost(): {
  requests: SoftwareFrameRequest[]
  draws: Array<{ pixels: Uint8Array; revision: number }>
  viewport: SoftwareViewport
  /** 让下一次请求挂住，用来观察"飞行途中又来了新相机" */
  hold: () => () => void
} {
  const requests: SoftwareFrameRequest[] = []
  const draws: Array<{ pixels: Uint8Array; revision: number }> = []
  let revision = 1
  let gate: Promise<void> | undefined
  let release: (() => void) | undefined

  const viewport = new SoftwareViewport(
    {
      resize: () => {},
      blit: (frame) => draws.push({ pixels: frame.pixels, revision: frame.revision }),
    },
    async (request) => {
      requests.push(request)
      const waiting = gate
      gate = undefined
      if (waiting !== undefined) await waiting
      const frame: SoftwareFrame = {
        pixels: new Uint8Array([revision, request.azimuth & 0xff, request.draft ? 1 : 0, 0]),
        width: request.width,
        height: request.height,
        revision,
        ms: 1,
      }
      revision++
      return frame
    },
  )

  return {
    requests,
    draws,
    viewport,
    hold: () => {
      gate = new Promise<void>((resolve) => {
        release = resolve
      })
      return () => release?.()
    },
  }
}

/** 等所有已排队的微任务跑完（`pump` 是 async 的）。 */
const settle = async (): Promise<void> => {
  for (let i = 0; i < 8; i++) await Promise.resolve()
}

describe('SoftwareViewport：请求合并', () => {
  it('尺寸变化后重画一次，并把尺寸带给主进程', async () => {
    const host = fakeHost()
    host.viewport.resize(200, 150, 2)
    host.viewport.render(VIEW)
    await settle()
    expect(host.requests).toHaveLength(1)
    // **忽略设备像素比**：软件光栅化的成本与像素数成正比
    expect(host.requests[0]).toMatchObject({ width: 200, height: 150, draft: false })
    expect(host.draws).toHaveLength(1)
  })

  it('同一个版本、同一个机位、同一个尺寸 → **连问都不问**', async () => {
    const host = fakeHost()
    host.viewport.setRevision(7)
    host.viewport.resize(200, 150, 1)
    host.viewport.render(VIEW)
    await settle()
    expect(host.requests).toHaveLength(1)

    // 状态事件又催了一次（对话多了一条消息、自动保存……）
    host.viewport.render(VIEW)
    await settle()
    expect(host.requests).toHaveLength(1)
    expect(host.viewport.frames).toBe(1)
  })

  it('版本变了就会重画', async () => {
    const host = fakeHost()
    host.viewport.setRevision(7)
    host.viewport.render(VIEW)
    await settle()
    host.viewport.setRevision(8)
    host.viewport.render(VIEW)
    await settle()
    expect(host.requests).toHaveLength(2)
  })

  it('草稿帧与全分辨率帧是**两帧**，不能互相顶掉', async () => {
    const host = fakeHost()
    host.viewport.setRevision(7)
    host.viewport.render(VIEW, { draft: true })
    await settle()
    host.viewport.render(VIEW)
    await settle()
    expect(host.requests.map((r) => r.draft)).toEqual([true, false])
    expect(host.viewport.frames).toBe(2)
  })

  it('**草稿帧降分辨率**：拖动时省下的像素就是能不能跟手', async () => {
    const host = fakeHost()
    host.viewport.setRevision(7)
    host.viewport.resize(800, 600, 1)
    host.viewport.render(VIEW, { draft: true })
    await settle()
    expect(host.requests[0]).toMatchObject({ width: 400, height: 300, draft: true })

    host.viewport.render(VIEW)
    await settle()
    expect(host.requests[1]).toMatchObject({ width: 800, height: 600, draft: false })
  })

  it('sink 拿到的是**视口尺寸**，不是草稿帧的尺寸（否则拖动中画布会来回换缓冲）', async () => {
    const sizes: Array<[number, number]> = []
    const viewport = new SoftwareViewport(
      { resize: (width, height) => sizes.push([width, height]), blit: () => {} },
      async (request) => ({
        pixels: new Uint8Array(request.width * request.height * 4),
        width: request.width,
        height: request.height,
        revision: 1,
        ms: 0,
      }),
    )
    viewport.setRevision(1)
    viewport.resize(800, 600, 1)
    viewport.render(VIEW, { draft: true })
    await settle()
    viewport.render(VIEW)
    await settle()
    expect(sizes).toEqual([[800, 600]])
  })

  it('尺寸变了必须重画（否则画面停在旧比例上）', async () => {
    const host = fakeHost()
    host.viewport.setRevision(7)
    host.viewport.resize(200, 150, 1)
    host.viewport.render(VIEW)
    await settle()
    host.viewport.resize(400, 300, 1)
    host.viewport.render(VIEW)
    await settle()
    expect(host.requests.map((r) => `${r.width}x${r.height}`)).toEqual(['200x150', '400x300'])
  })
})

describe('SoftwareViewport：飞行途中的相机', () => {
  it('一个请求在飞时来的新相机**只保留最后一个**', async () => {
    const host = fakeHost()
    host.viewport.setRevision(1)
    const release = host.hold()
    host.viewport.render(VIEW)

    // 拖动：连来三帧，全都在第一帧还没回来的时候
    host.viewport.render({ ...VIEW, azimuth: 50 })
    host.viewport.render({ ...VIEW, azimuth: 60 })
    host.viewport.render({ ...VIEW, azimuth: 70 })
    expect(host.requests).toHaveLength(1)

    release()
    await settle()
    // 中间那两个角度被跳过了——它们已经过期，画出来只会让画面更落后
    expect(host.requests.map((r) => r.azimuth)).toEqual([45, 70])
    expect(host.viewport.frames).toBe(2)
  })

  it('主进程画不出来时不记指纹，下一次同机位请求会再试', async () => {
    const requests: SoftwareFrameRequest[] = []
    let fail = true
    const viewport = new SoftwareViewport(
      { resize: () => {}, blit: () => {} },
      async (request) => {
        requests.push(request)
        if (fail) throw new Error('世界刚被换掉')
        return { pixels: new Uint8Array(4), width: request.width, height: request.height, revision: 1, ms: 0 }
      },
    )
    viewport.setRevision(1)
    viewport.render(VIEW)
    await settle()
    expect(requests).toHaveLength(1)

    fail = false
    viewport.render(VIEW)
    await settle()
    // 失败的那一帧没画出来，所以指纹没记——重试必须真的再问一次
    expect(requests).toHaveLength(2)
    expect(viewport.frames).toBe(1)
  })
})

describe('SoftwareViewport：参数传递', () => {
  it('注视点与缩放原样带给主进程（机位面板设的机位在兜底路径上也不能丢）', async () => {
    const host = fakeHost()
    host.viewport.setRevision(3)
    host.viewport.render({ azimuth: 31, elevation: 27, roll: 12, scale: 8, target: [16, 6, 0] })
    await settle()
    expect(host.requests[0]).toMatchObject({
      azimuth: 31,
      elevation: 27,
      roll: 12,
      scale: 8,
      target: [16, 6, 0],
    })
  })

  it('自动取景（scale <= 0）时**不带** scale，让主进程按内容重新取景', async () => {
    const host = fakeHost()
    host.viewport.setRevision(3)
    host.viewport.render({ ...VIEW, scale: 0 })
    await settle()
    expect(host.requests[0]!.scale).toBeUndefined()
  })

  it('dispose 之后不再画（窗口正在关闭时）', async () => {
    const host = fakeHost()
    host.viewport.setRevision(1)
    host.viewport.dispose()
    host.viewport.render(VIEW)
    await settle()
    expect(host.requests).toHaveLength(0)
  })
})

/**
 * **GPU 离屏截图必须把本次请求的尺寸合进相机 spec**（采集视口空图事故的闸门）。
 *
 * 那次事故的形状：`capture()` 把 `request.camera` 原样喂给 `applyCamera`，而
 * 「采集当前视口」给的相机是 `viewportCamera()`——**不带 width/height**。
 * 透视分支的 `aspect = spec.width / spec.height` 于是是 NaN，整个投影矩阵全是
 * NaN，GPU 一个三角形都不画：出来一张只有叠加层的空图，没有任何报错。
 * 模型的 `screenshot` 工具不受影响（`cameraForShot` 给的是完整 spec），
 * 所以这条 bug 只有用户点「拍照」才踩得到——自动化里没有一条点过它。
 *
 * 为什么这是源码断言而不是行为测试：GPU 路径要真 WebGL 上下文，Node 里
 * 构造不出 `SceneViewport`。行为那一半在 gui-smoke 里（真窗口点「拍照」，
 * 断言暂存区真的出图）。这里管的是"那个汇合点不能被改回去"。
 */
describe('GPU 离屏截图的相机汇合点', () => {
  const source = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), '..', 'src/renderer/viewport.ts'),
    'utf8',
  )
  // 只看 capture 方法体
  const start = source.indexOf('capture(request: CaptureRequest)')
  expect(start, '找不到 capture(request: CaptureRequest)——它被改名了吗？').toBeGreaterThan(-1)
  const body = source.slice(start, source.indexOf('return out.toDataURL', start))

  it('applyCamera 拿到的是**合了尺寸的 spec**，不是 request.camera 本体', () => {
    expect(body, 'capture() 又把 request.camera 原样喂给 applyCamera 了').not.toContain(
      'applyCamera(request.camera)',
    )
    expect(body, '找不到"把 width/height 合进相机"的那一步').toMatch(
      /\.\.\.request\.camera,\s*width,\s*height/,
    )
  })
})
