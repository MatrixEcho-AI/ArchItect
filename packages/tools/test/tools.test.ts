import { EditLog, measure, WorldStore } from '@architect/core'
import type { Bounds } from '@architect/core'
import { cameraForShot, createFallbackColorResolver, encodePng, renderIsometric, shotCameraLabel } from '@architect/render'
import { describe, expect, it } from 'vitest'

import { createDefaultRegistry } from '../src/index.js'
import { ToolRegistry } from '../src/registry.js'
import { describeIssues, obj, validateArgs, vec3 } from '../src/schema.js'
import type { ScreenshotRequest, ToolContext, ToolImage } from '../src/types.js'

const volume: Bounds = { min: { x: 0, y: 0, z: 0 }, max: { x: 31, y: 31, z: 31 } }

/**
 * 测试用的最小截图实现：真渲染，但用确定性兜底配色。
 *
 * **相机必须走 `cameraForShot` 这个共享函数**，不能在这里自己拼一遍——
 * 自己拼的话"自由机位到底有没有生效"就变成了在验测试替身，而不是验产品代码。
 */
function stubShoot(store: WorldStore, request: ScreenshotRequest): ToolImage {
  const bounds = store.contentBounds() ?? volume
  const camera = cameraForShot(bounds, request)
  const result = renderIsometric(store, {
    camera,
    resolve: createFallbackColorResolver(),
    overlays: false,
  })
  return {
    png: encodePng(result.canvas),
    width: request.width,
    height: request.height,
    camera: shotCameraLabel(request),
    revision: store.revision,
  }
}

function makeContext(useVolume: Bounds = volume): ToolContext {
  const store = new WorldStore({ minecraftVersion: '1.21.4', volume: useVolume })
  const log = new EditLog()
  return {
    store,
    log,
    clipboard: {},
    correlationId: 'turn_1',
    record: (tool, args, result) => {
      log.record(result, { tool, args, correlationId: 'turn_1', ts: '2026-01-01T00:00:00.000Z' })
    },
    shoot: (request) => stubShoot(store, request),
  }
}

const registry = createDefaultRegistry()

describe('JSON Schema 校验', () => {
  const schema = obj({ from: vec3('起点'), block: { type: 'string' }, confirm: { type: 'boolean' } }, [
    'from',
    'block',
  ])

  it('接受合法输入并套用默认值', () => {
    const result = validateArgs(obj({ mode: { type: 'string', default: 'replace' } }), {})
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.value.mode).toBe('replace')
  })

  it('拒绝缺少必填字段', () => {
    const result = validateArgs(schema, { block: 'stone' })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(describeIssues(result.issues)).toContain('from: Missing required argument')
  })

  it('**列出合法字段名**，让 LLM 能自纠（回归）', () => {
    const result = validateArgs(schema, { from: [0, 0, 0], block: 'stone', blck: 'dirt' })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      const text = describeIssues(result.issues)
      expect(text).toContain('blck')
      expect(text).toContain('from')
      expect(text).toContain('block')
    }
  })

  it('校验数组长度与元素类型', () => {
    const bad = validateArgs(schema, { from: [0, 0], block: 'stone' })
    expect(bad.ok).toBe(false)
    if (!bad.ok) expect(describeIssues(bad.issues)).toContain('At least 3 items')

    const wrongType = validateArgs(schema, { from: [0, 'a', 0], block: 'stone' })
    expect(wrongType.ok).toBe(false)
    if (!wrongType.ok) expect(describeIssues(wrongType.issues)).toContain('from[1]')
  })

  it('校验 enum 并列出可选值', () => {
    const result = validateArgs(obj({ mode: { type: 'string', enum: ['a', 'b'] } }), { mode: 'c' })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(describeIssues(result.issues)).toContain('a | b')
  })

  it('校验数值上下界', () => {
    const result = validateArgs(obj({ n: { type: 'integer', minimum: 1, maximum: 5 } }), { n: 9 })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(describeIssues(result.issues)).toContain('Must not be greater than 5')
  })

  it('数字字符串会被转换（LLM 常把数字写成字符串）', () => {
    const result = validateArgs(obj({ n: { type: 'integer' } }), { n: '42' })
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.value.n).toBe(42)
  })

  it('根类型不是对象时拒绝', () => {
    const result = validateArgs(obj({}), 'nope')
    expect(result.ok).toBe(false)
  })
})

describe('工具注册表', () => {
  it('默认工具集包含 plan 附录 B 的 6 个必需工具', () => {
    const names = registry.list().map((t) => t.name)
    for (const required of ['screenshot', 'slice', 'fill_box', 'fill_line', 'measure', 'verify']) {
      expect(names, `缺少 ${required}`).toContain(required)
    }
  })

  it('导出的 schema 形状可直接喂给 LLM', () => {
    const schemas = registry.toToolSchemas()
    expect(schemas.length).toBe(registry.size)
    for (const schema of schemas) {
      expect(schema.name).toMatch(/^[a-z_]+$/)
      expect(schema.description.length).toBeGreaterThan(12)
      expect((schema.parameters as { type: string }).type).toBe('object')
    }
  })

  it('未知工具返回可用工具清单（可自纠）', async () => {
    const ctx = makeContext()
    const result = await registry.call(ctx, 'nonexistent', {})
    expect(result.ok).toBe(false)
    expect(result.error?.code).toBe('UNKNOWN_TOOL')
    expect(result.error?.hint).toContain('fill_box')
  })

  it('参数不合法时不执行', async () => {
    const ctx = makeContext()
    const result = await registry.call(ctx, 'fill_box', { from: [0, 0, 0] })
    expect(result.ok).toBe(false)
    expect(result.error?.code).toBe('INVALID_ARGS')
    expect(ctx.store.revision).toBe(0)
  })

  it('**工具内部异常不逃逸**，转成结构化错误（否则 Agent 循环会整个挂掉）', async () => {
    const broken = new ToolRegistry().register({
      name: 'boom',
      description: 'always throws',
      parameters: obj({}),
      mutating: false,
      destructive: false,
      execute: () => {
        throw new Error('内部炸了')
      },
    })
    const result = await broken.call(makeContext(), 'boom', {})
    expect(result.ok).toBe(false)
    expect(result.error?.code).toBe('INTERNAL')
    expect(result.summary).toContain('内部炸了')
  })

  it('重复注册同名工具会报错', () => {
    const r = new ToolRegistry().register({
      name: 'x',
      description: 'd',
      parameters: obj({}),
      mutating: false,
      destructive: false,
      execute: () => ({ ok: true, summary: '' }),
    })
    expect(() =>
      r.register({
        name: 'x',
        description: 'd',
        parameters: obj({}),
        mutating: false,
        destructive: false,
        execute: () => ({ ok: true, summary: '' }),
      }),
    ).toThrow(/already registered/)
  })
})

describe('编辑工具', () => {
  it('fill_box 写入并记录 EditOp', async () => {
    const ctx = makeContext()
    const result = await registry.call(ctx, 'fill_box', {
      from: [0, 0, 0],
      to: [3, 0, 3],
      block: 'minecraft:stone',
    })
    expect(result.ok).toBe(true)
    expect(result.data?.changed).toBe(16)
    expect(ctx.log.length).toBe(1)
    expect(ctx.log.at(0)!.tool).toBe('fill_box')
    expect(ctx.log.at(0)!.correlationId).toBe('turn_1')
  })

  it('fill_box 的 hollow / outline 模式', async () => {
    const ctx = makeContext()
    const hollow = await registry.call(ctx, 'fill_box', {
      from: [0, 0, 0],
      to: [3, 3, 3],
      block: 'stone',
      mode: 'hollow',
    })
    expect(hollow.data?.changed).toBe(4 * 4 * 4 - 2 * 2 * 2)

    // 用新上下文：hollow 已经把外壳写上了，outline ⊂ 外壳，同上下文里会算出 0 变化
    const outlineCtx = makeContext()
    const outline = await registry.call(outlineCtx, 'fill_box', {
      from: [0, 0, 0],
      to: [3, 3, 3],
      block: 'stone',
      mode: 'outline',
    })
    expect(outline.data?.changed).toBe(12 * 2 + 8)
  })

  it('fill_line 的 radius 给出 2R+1 格粗（用户明确要的对角批量填充）', async () => {
    const ctx = makeContext()
    const result = await registry.call(ctx, 'fill_line', {
      from: [8, 0, 8],
      to: [8, 20, 8],
      block: 'stone',
      radius: 2,
    })
    expect(result.ok).toBe(true)
    let width = 0
    for (let x = 0; x <= 20; x++) if (!ctx.store.isAir({ x, y: 10, z: 8 })) width++
    expect(width).toBe(5) // 2R+1
  })

  it('fill_line 的 taper 做锥形收分', async () => {
    const ctx = makeContext()
    await registry.call(ctx, 'fill_line', {
      from: [8, 0, 8],
      to: [8, 20, 8],
      block: 'stone',
      taper: [3, 0],
    })
    const extent = (y: number): number => {
      let lo = 99
      let hi = -1
      for (let x = 0; x <= 20; x++) {
        if (!ctx.store.isAir({ x, y, z: 8 })) {
          lo = Math.min(lo, x)
          hi = Math.max(hi, x)
        }
      }
      return hi - lo + 1
    }
    expect(extent(0)).toBeGreaterThan(extent(20))
  })

  it('extrude 从平面图长出建筑', async () => {
    const ctx = makeContext()
    const result = await registry.call(ctx, 'extrude', {
      points: [
        [0, 0],
        [5, 0],
        [5, 5],
        [0, 5],
      ],
      baseY: 0,
      height: 3,
      block: 'stone',
    })
    expect(result.ok).toBe(true)
    expect(result.data?.changed).toBe(6 * 6 * 3)
  })

  it('place_block 只改一格', async () => {
    const ctx = makeContext()
    const result = await registry.call(ctx, 'place_block', { pos: [1, 2, 3], block: 'oak_stairs[facing=east]' })
    expect(result.ok).toBe(true)
    expect(result.data?.changed).toBe(1)
    expect(ctx.store.getBlockString({ x: 1, y: 2, z: 3 })).toContain('facing=east')
  })

  it('未知方块给出可自纠的错误', async () => {
    const ctx = makeContext()
    const result = await registry.call(ctx, 'place_block', { pos: [0, 0, 0], block: 'minecraft:not_a_block' })
    expect(result.ok).toBe(false)
    expect(result.error?.code).toBe('UNKNOWN_BLOCK')
  })

  it('symmetrize 只造一半再镜像', async () => {
    const ctx = makeContext()
    await registry.call(ctx, 'fill_box', { from: [0, 0, 0], to: [6, 2, 6], block: 'stone' })
    const result = await registry.call(ctx, 'symmetrize', {
      axis: 'x',
      coordinate: 8,
      source: 'negative',
    })
    expect(result.ok).toBe(true)
    expect(ctx.store.isAir({ x: 14, y: 1, z: 3 })).toBe(false)
    expect(ctx.store.getBlockString({ x: 14, y: 1, z: 3 })).toBe(
      ctx.store.getBlockString({ x: 2, y: 1, z: 3 }),
    )
  })
})

describe('dry-run 预算（plan §9.4 机制 3）', () => {
  it('超阈值时返回 NEEDS_CONFIRM 且不落盘', async () => {
    // 用大工区：阈值 50000 是**服务端护栏**，不由 LLM 传参控制
    const ctx = makeContext({ min: { x: 0, y: 0, z: 0 }, max: { x: 63, y: 63, z: 63 } })
    // 先放一点东西，让 preview 的"覆盖非空气"有意义
    await registry.call(ctx, 'fill_box', { from: [0, 0, 0], to: [9, 9, 9], block: 'stone' })
    const before = ctx.store.revision

    const result = await registry.call(ctx, 'fill_box', {
      from: [0, 0, 0],
      to: [63, 63, 63],
      block: 'dirt',
    })
    expect(result.ok).toBe(false)
    expect(result.error?.code).toBe('NEEDS_CONFIRM')
    expect(result.data?.needsConfirm).toBe(true)
    expect(result.summary).toContain('overwriting')
    expect(result.summary).toContain('Sample positions')
    expect(ctx.store.revision).toBe(before)
  })

  it('带 confirm: true 后正常提交', async () => {
    const ctx = makeContext()
    const result = await registry.call(ctx, 'fill_box', {
      from: [0, 0, 0],
      to: [31, 31, 31],
      block: 'dirt',
      confirm: true,
    })
    expect(result.ok).toBe(true)
    expect(result.data?.changed).toBe(32 * 32 * 32)
  })
})

describe('检视工具', () => {
  it('measure 报告尺寸与直方图', async () => {
    const ctx = makeContext()
    await registry.call(ctx, 'fill_box', { from: [0, 0, 0], to: [3, 4, 5], block: 'stone' })
    const result = await registry.call(ctx, 'measure', {})
    expect(result.summary).toContain('size: 4×5×6')
    expect(result.summary).toContain('minecraft:stone')
  })

  it('slice 输出 ASCII 平面图', async () => {
    const ctx = makeContext()
    await registry.call(ctx, 'fill_box', { from: [0, 0, 0], to: [3, 0, 3], block: 'stone' })
    const result = await registry.call(ctx, 'slice', { axis: 'y', index: 0, x: [0, 5], z: [0, 5] })
    expect(result.ok).toBe(true)
    expect(result.summary).toContain('slice(axis=y, index=0)')
    expect(result.summary).toContain('legend:')
    expect(result.summary).toContain('####')
  })

  it('slice 超上限时提示缩小范围', async () => {
    const ctx = makeContext({ min: { x: 0, y: 0, z: 0 }, max: { x: 127, y: 63, z: 127 } })
    const result = await registry.call(ctx, 'slice', { axis: 'y', index: 0 })
    expect(result.ok).toBe(false)
    expect(result.error?.message).toContain('exceeding the limit')
  })

  it('search_blocks 按子串找方块', async () => {
    const ctx = makeContext()
    const result = await registry.call(ctx, 'search_blocks', { query: 'oak_stairs' })
    expect(result.ok).toBe(true)
    expect(result.summary).toContain('minecraft:oak_stairs')
  })

  it('get_block 返回完整状态串', async () => {
    const ctx = makeContext()
    await registry.call(ctx, 'place_block', { pos: [0, 0, 0], block: 'oak_stairs[facing=east]' })
    const result = await registry.call(ctx, 'get_block', { pos: [0, 0, 0] })
    expect(result.summary).toContain('facing=east')
    expect(result.summary).toContain('half=bottom')
  })
})

describe('verify：结构化自检（plan §9.4 机制 1）', () => {
  it('block_at 判定 pass/fail 并给出实际值', async () => {
    const ctx = makeContext()
    await registry.call(ctx, 'fill_box', { from: [0, 0, 0], to: [3, 0, 3], block: 'stone' })
    const result = await registry.call(ctx, 'verify', {
      claims: [
        { check: 'block_at', pos: [0, 0, 0], expect: 'minecraft:stone' },
        { check: 'block_at', pos: [5, 0, 5], expect: 'minecraft:stone' },
      ],
    })
    expect(result.ok).toBe(false)
    expect(result.summary).toContain('1/2 passed')
    expect(result.summary).toContain('PASS')
    expect(result.summary).toContain('FAIL')
    expect(result.summary).toContain('actual is minecraft:air')
  })

  it('block_at 默认只比对方块名，忽略属性', async () => {
    const ctx = makeContext()
    await registry.call(ctx, 'place_block', { pos: [0, 0, 0], block: 'oak_stairs[facing=east]' })
    const loose = await registry.call(ctx, 'verify', {
      claims: [{ check: 'block_at', pos: [0, 0, 0], expect: 'oak_stairs' }],
    })
    expect(loose.ok).toBe(true)

    const strict = await registry.call(ctx, 'verify', {
      claims: [{ check: 'block_at', pos: [0, 0, 0], expect: 'oak_stairs[facing=west]' }],
    })
    expect(strict.ok).toBe(false)
  })

  it('air_at', async () => {
    const ctx = makeContext()
    const result = await registry.call(ctx, 'verify', { claims: [{ check: 'air_at', pos: [0, 0, 0] }] })
    expect(result.ok).toBe(true)
  })

  it('count 的数量区间', async () => {
    const ctx = makeContext()
    await registry.call(ctx, 'fill_box', { from: [0, 0, 0], to: [3, 0, 3], block: 'stone' })
    const pass = await registry.call(ctx, 'verify', {
      claims: [{ check: 'count', block: 'stone', min: 10, max: 20 }],
    })
    expect(pass.ok).toBe(true)

    const fail = await registry.call(ctx, 'verify', {
      claims: [{ check: 'count', block: 'stone', min: 100 }],
    })
    expect(fail.ok).toBe(false)
    expect(fail.summary).toContain('actual 16')
  })

  it('supported 能抓出悬空方块', async () => {
    const ctx = makeContext()
    await registry.call(ctx, 'place_block', { pos: [5, 10, 5], block: 'stone' })
    const result = await registry.call(ctx, 'verify', {
      claims: [{ check: 'supported', from: [0, 0, 0], to: [10, 15, 10] }],
    })
    expect(result.ok).toBe(false)
    expect(result.summary).toContain('floating block')
    expect(result.summary).toContain('[5,10,5]')
  })

  it('symmetric 检出不对称', async () => {
    const ctx = makeContext()
    await registry.call(ctx, 'place_block', { pos: [3, 1, 3], block: 'stone' })
    const fail = await registry.call(ctx, 'verify', {
      claims: [{ check: 'symmetric', axis: 'x', coordinate: 8, from: [0, 0, 0], to: [16, 4, 16] }],
    })
    expect(fail.ok).toBe(false)

    await registry.call(ctx, 'symmetrize', { axis: 'x', coordinate: 8, source: 'negative' })
    const pass = await registry.call(ctx, 'verify', {
      claims: [{ check: 'symmetric', axis: 'x', coordinate: 8, from: [0, 0, 0], to: [16, 4, 16] }],
    })
    expect(pass.ok).toBe(true)
  })
})

describe('截图工具', () => {
  it('返回 PNG、机位与 revision', async () => {
    const ctx = makeContext()
    await registry.call(ctx, 'fill_box', { from: [0, 0, 0], to: [3, 3, 3], block: 'stone' })
    const result = await registry.call(ctx, 'screenshot', { view: 'iso_ne', width: 160, height: 120 })
    expect(result.ok).toBe(true)
    expect(result.image?.png.length).toBeGreaterThan(100)
    expect(result.image?.width).toBe(160)
    expect(result.image?.revision).toBe(ctx.store.revision)
    expect(result.summary).toContain('revision')
  })

  it('高亮上一次编辑的范围', async () => {
    const ctx = makeContext()
    await registry.call(ctx, 'fill_box', { from: [2, 2, 2], to: [4, 4, 4], block: 'stone' })
    const result = await registry.call(ctx, 'screenshot', { width: 120, height: 90 })
    expect(result.summary).toContain('orange box')
    expect(result.summary).toContain('(2,2,2)')
  })

  it('空世界给出明确错误', async () => {
    const ctx = makeContext()
    const result = await registry.call(ctx, 'screenshot', {})
    expect(result.ok).toBe(false)
    expect(result.error?.code).toBe('NOT_FOUND')
    expect(result.error?.hint).toContain('Build something first')
  })

  it('**模型能给任意角度**：同一个世界，不同 azimuth 画出来的图不一样', async () => {
    // 9 个预设覆盖不了"这个屋檐从侧面挑得太远了吗"这类判断。
    // 这一条锁的是自由机位真的接上了，而不是退回了默认预设。
    const ctx = makeContext()
    await registry.call(ctx, 'fill_box', { from: [0, 0, 0], to: [5, 5, 5], block: 'stone' })
    await registry.call(ctx, 'fill_box', { from: [0, 6, 0], to: [5, 6, 1], block: 'red_concrete' })

    const a = await registry.call(ctx, 'screenshot', { azimuth: 20, elevation: 25, width: 160, height: 120 })
    const b = await registry.call(ctx, 'screenshot', { azimuth: 200, elevation: 25, width: 160, height: 120 })
    expect(a.ok && b.ok).toBe(true)
    expect(a.image!.png).not.toEqual(b.image!.png)
    // 机位标签要如实写出角度，否则档案里所有自由机位都长得一样
    expect(a.image!.camera).toContain('az20')
    expect(a.summary).toContain('az20')
    expect(b.image!.camera).toContain('az200')
  })

  it('仰角被夹到 1..89（正好 90° 时画面会退化成一条线）', async () => {
    const ctx = makeContext()
    await registry.call(ctx, 'fill_box', { from: [0, 0, 0], to: [3, 3, 3], block: 'stone' })
    const result = await registry.call(ctx, 'screenshot', { azimuth: 0, elevation: 90, width: 120, height: 90 })
    expect(result.ok).toBe(true)
    expect(result.image!.camera).toBe('az0/el89')
  })

  it('`scale` + `target` 能做局部特写（图与自动取景不同）', async () => {
    const ctx = makeContext()
    await registry.call(ctx, 'fill_box', { from: [0, 0, 0], to: [7, 0, 7], block: 'stone' })
    await registry.call(ctx, 'place_block', { pos: [4, 1, 4], block: 'gold_block' })
    const wide = await registry.call(ctx, 'screenshot', { view: 'iso_ne', width: 160, height: 120 })
    const close = await registry.call(ctx, 'screenshot', {
      azimuth: 45,
      elevation: 30,
      target: [4, 1, 4],
      scale: 14,
      width: 160,
      height: 120,
    })
    expect(close.ok).toBe(true)
    expect(close.image!.png).not.toEqual(wide.image!.png)
  })

  it('`set_camera` 定住机位，之后每次 screenshot 都用它', async () => {
    const ctx = makeContext()
    await registry.call(ctx, 'fill_box', { from: [0, 0, 0], to: [5, 5, 5], block: 'stone' })

    const set = await registry.call(ctx, 'set_camera', { eye: [8, 8, 100], lookAt: [3, 3, 3] })
    expect(set.ok).toBe(true)
    expect(set.summary).toContain('eye 8,8,100')
    // 不含尺寸与高亮的相机被存进上下文，后续截图自己会去读
    expect(ctx.camera?.eye).toEqual([8, 8, 100])

    const after = await registry.call(ctx, 'screenshot', { width: 160, height: 120 })
    expect(after.ok).toBe(true)
    expect(after.image!.camera).toBe('eye(8,8,100)→(3,3,3)')

    // 显式给角度 = 从会话相机切回角度模式，单次覆盖
    const override = await registry.call(ctx, 'screenshot', { azimuth: 0, elevation: 5, width: 160, height: 120 })
    expect(override.image!.camera).toBe('az0/el5')
    // 覆盖不该把会话相机改掉
    expect(ctx.camera?.eye).toEqual([8, 8, 100])
  })

  it('`set_camera` 只改注视点/缩放时不清掉朝向', async () => {
    const ctx = makeContext()
    await registry.call(ctx, 'fill_box', { from: [0, 0, 0], to: [3, 3, 3], block: 'stone' })
    await registry.call(ctx, 'set_camera', { azimuth: 30, elevation: 20 })
    const again = await registry.call(ctx, 'set_camera', { scale: 12 })
    expect(again.ok).toBe(true)
    expect(ctx.camera).toMatchObject({ azimuth: 30, elevation: 20, scale: 12 })
  })

  it('`set_camera` 的错要能自纠：缺一个点、两点重合、什么都没给', async () => {
    const ctx = makeContext()
    const onlyEye = await registry.call(ctx, 'set_camera', { eye: [1, 2, 3] })
    expect(onlyEye.ok).toBe(false)
    expect(onlyEye.error?.message).toContain('together')

    const same = await registry.call(ctx, 'set_camera', { eye: [1, 2, 3], lookAt: [1, 2, 3] })
    expect(same.ok).toBe(false)
    expect(same.error?.message).toContain('same point')

    const nothing = await registry.call(ctx, 'set_camera', {})
    expect(nothing.ok).toBe(false)
    expect(nothing.error?.message).toContain('at least one')

    // 失败不该污染上下文
    expect(ctx.camera).toBeUndefined()
  })

  it('`set_camera { reset: true }` 清掉机位，回到默认预设', async () => {
    const ctx = makeContext()
    await registry.call(ctx, 'fill_box', { from: [0, 0, 0], to: [3, 3, 3], block: 'stone' })
    await registry.call(ctx, 'set_camera', { azimuth: 90, elevation: 10 })
    const reset = await registry.call(ctx, 'set_camera', { reset: true })
    expect(reset.ok).toBe(true)
    expect(ctx.camera).toBeUndefined()
    const shot = await registry.call(ctx, 'screenshot', { width: 120, height: 90 })
    expect(shot.image!.camera).toBe('iso_ne')
  })

  it('`set_camera` 设定后，`screenshot` 的 `eye`/`lookAt` 也能一次性覆盖', async () => {
    const ctx = makeContext()
    await registry.call(ctx, 'fill_box', { from: [0, 0, 0], to: [3, 3, 3], block: 'stone' })
    await registry.call(ctx, 'set_camera', { azimuth: 30, elevation: 20 })
    const shot = await registry.call(ctx, 'screenshot', {
      eye: [0, 0, 50],
      lookAt: [1, 1, 1],
      width: 160,
      height: 120,
    })
    expect(shot.ok).toBe(true)
    expect(shot.image!.camera).toBe('eye(0,0,50)→(1,1,1)')
    // 一次性覆盖不该改掉会话相机
    expect(ctx.camera?.azimuth).toBe(30)
  })

  it('预设机位仍然照旧（`view` 不带角度时标签就是预设名）', async () => {
    const ctx = makeContext()
    await registry.call(ctx, 'fill_box', { from: [0, 0, 0], to: [3, 3, 3], block: 'stone' })
    const result = await registry.call(ctx, 'screenshot', { view: 'top', width: 120, height: 90 })
    expect(result.image!.camera).toBe('top')
  })
})

describe('撤销 / 重做工具', () => {
  it('undo 回滚并报格数', async () => {
    const ctx = makeContext()
    await registry.call(ctx, 'fill_box', { from: [0, 0, 0], to: [3, 0, 3], block: 'stone' })
    const before = ctx.store.contentHash()
    await registry.call(ctx, 'fill_box', { from: [5, 0, 5], to: [6, 0, 6], block: 'dirt' })
    const undone = await registry.call(ctx, 'undo', {})
    expect(undone.ok).toBe(true)
    expect(undone.data?.reverted).toBe(4)
    expect(ctx.store.contentHash()).toBe(before)
  })

  it('没有可撤销时返回明确错误', async () => {
    const ctx = makeContext()
    const result = await registry.call(ctx, 'undo', {})
    expect(result.ok).toBe(false)
    expect(result.error?.code).toBe('NOT_FOUND')
  })

  it('redo 重放', async () => {
    const ctx = makeContext()
    await registry.call(ctx, 'fill_box', { from: [0, 0, 0], to: [2, 0, 2], block: 'stone' })
    await registry.call(ctx, 'undo', {})
    const redone = await registry.call(ctx, 'redo', {})
    expect(redone.ok).toBe(true)
    expect(measure(ctx.store).blocks).toBe(9)
  })
})

describe('verify：属性声明按"必须匹配"而不是"完全相等"', () => {
  /** 造一个"只差属性"的世界，用来区分这两种语义。 */
  const withStairs = (): ToolContext => {
    const ctx = makeContext()
    ctx.store.setBlock({ x: 3, y: 1, z: 3 }, 'minecraft:oak_stairs[facing=west]')
    return ctx
  }

  it('写出来的属性必须对上，没写的不约束', async () => {
    const ctx = withStairs()
    // half / shape / waterlogged 都没写，但实际存在——**不该因此判失败**
    const pass = await registry.call(ctx, 'verify', {
      claims: [{ check: 'block_at', pos: [3, 1, 3], expect: 'minecraft:oak_stairs[facing=west]' }],
    })
    expect(pass.ok).toBe(true)
    expect(pass.summary).toContain('1/1 passed')
  })

  it('属性对不上就失败，并在 detail 里给出真实的完整状态供自纠', async () => {
    const ctx = withStairs()
    const failed = await registry.call(ctx, 'verify', {
      claims: [{ check: 'block_at', pos: [3, 1, 3], expect: 'minecraft:oak_stairs[facing=east]' }],
    })
    expect(failed.ok).toBe(false)
    expect(failed.summary).toContain('0/1 passed')
    expect(failed.summary).toContain('actual is minecraft:oak_stairs[facing=west')
  })

  it('不带方括号时只比方块名，和以前一样', async () => {
    const ctx = withStairs()
    const pass = await registry.call(ctx, 'verify', {
      claims: [{ check: 'block_at', pos: [3, 1, 3], expect: 'minecraft:oak_stairs' }],
    })
    expect(pass.ok).toBe(true)
  })

  it('方块名不对时当然失败，哪怕属性写得对', async () => {
    const ctx = withStairs()
    const failed = await registry.call(ctx, 'verify', {
      claims: [{ check: 'block_at', pos: [3, 1, 3], expect: 'minecraft:oak_slab[facing=west]' }],
    })
    expect(failed.ok).toBe(false)
  })

  it('多写一个属性也要对上（不能蒙过）', async () => {
    const ctx = withStairs()
    const failed = await registry.call(ctx, 'verify', {
      claims: [
        { check: 'block_at', pos: [3, 1, 3], expect: 'minecraft:oak_stairs[facing=west,half=top]' },
      ],
    })
    expect(failed.ok).toBe(false)
    expect(failed.summary).toContain('half=bottom')
  })

  it('不带 minecraft: 前缀的写法也认', async () => {
    const ctx = withStairs()
    const pass = await registry.call(ctx, 'verify', {
      claims: [{ check: 'block_at', pos: [3, 1, 3], expect: 'oak_stairs[facing=west]' }],
    })
    expect(pass.ok).toBe(true)
  })
})
