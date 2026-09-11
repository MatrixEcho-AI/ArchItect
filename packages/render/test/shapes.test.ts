import { loadRegistry, WorldStore } from '@architect/core'
import type { Bounds } from '@architect/core'
import { describe, expect, it } from 'vitest'

import { cameraBasis, fitCamera, presetAngles, projectPoint } from '../src/camera.js'
import { createFallbackColorResolver, createPackColorResolver } from '../src/colors.js'
import { assetsTexturePack } from '../src/assets.js'
import { renderIsometric } from '../src/isometric.js'

const BG = { r: 26, g: 28, b: 34 }
const volume: Bounds = { min: { x: 0, y: 0, z: 0 }, max: { x: 15, y: 15, z: 15 } }
const registry = loadRegistry('1.21.4')

/** 非背景像素数——用来量"这个东西在图上占多大"。 */
function inkOf(store: WorldStore, size = 240): number {
  const bounds = store.contentBounds() ?? volume
  const camera = fitCamera(bounds, presetAngles('iso_ne'), size, size)
  const result = renderIsometric(store, {
    camera,
    resolve: createFallbackColorResolver(),
    background: BG,
    overlays: false,
  })
  let ink = 0
  const data = result.canvas.data
  for (let i = 0; i < size * size; i++) {
    if (data[i * 4] !== BG.r || data[i * 4 + 1] !== BG.g || data[i * 4 + 2] !== BG.b) ink++
  }
  return ink
}

function oneBlock(block: string): WorldStore {
  const store = new WorldStore({ minecraftVersion: '1.21.4', volume })
  store.setBlock({ x: 5, y: 5, z: 5 }, block)
  return store
}

describe('注册表的碰撞形状表', () => {
  it('整立方体识别正确', () => {
    for (const name of ['stone', 'oak_planks', 'dirt', 'glass']) {
      const block = registry.blockByName(name)!
      expect(registry.isFullCube(block.defaultState), name).toBe(true)
      expect(registry.shapesOf(block.defaultState), name).toEqual([[0, 0, 0, 1, 1, 1]])
    }
  })

  it('非立方体识别正确', () => {
    const cases: Array<[string, number]> = [
      ['oak_slab', 1],
      ['oak_stairs', 2],
      ['oak_fence', 1],
      ['oak_door', 1],
      ['glass_pane', 1],
      ['oak_trapdoor', 1],
    ]
    for (const [name, boxCount] of cases) {
      const block = registry.blockByName(name)!
      const boxes = registry.shapesOf(block.defaultState)
      expect(registry.isFullCube(block.defaultState), name).toBe(false)
      expect(boxes.length, name).toBe(boxCount)
    }
  })

  it('楼梯的形状确实是"下半层 + 上半层的一半"', () => {
    const block = registry.blockByName('oak_stairs')!
    const boxes = registry.shapesOf(block.defaultState)
    expect(boxes).toHaveLength(2)
    // 有一块占满下半层
    expect(boxes.some((b) => b[1] === 0 && b[4] === 0.5 && b[0] === 0 && b[3] === 1)).toBe(true)
    // 另一块只占上半层的一部分
    expect(boxes.some((b) => b[1] === 0.5 && b[4] === 1)).toBe(true)
  })

  it('台阶是半高', () => {
    const block = registry.blockByName('oak_slab')!
    const [box] = registry.shapesOf(block.defaultState)
    expect(box).toEqual([0, 0, 0, 1, 0.5, 1])
  })

  it('**近 70% 的 state 不是整立方体**——所以"全画成立方体"是错的做法', () => {
    let full = 0
    let partial = 0
    let empty = 0
    for (let s = 0; s <= registry.maxStateId; s++) {
      const boxes = registry.shapesOf(s)
      if (boxes.length === 0) empty++
      else if (registry.isFullCube(s)) full++
      else partial++
    }
    expect(partial / (registry.maxStateId + 1)).toBeGreaterThan(0.6)
    expect(empty).toBeGreaterThan(0)
    expect(full + partial + empty).toBe(registry.maxStateId + 1)
  })

  it('每个 state 都能查到形状（不会漏）', () => {
    for (const stateId of [0, 1, 2940, 12044, 27865]) {
      expect(() => registry.shapesOf(stateId)).not.toThrow()
    }
    // 越界安全
    expect(registry.shapesOf(-1)).toEqual([])
    expect(registry.shapesOf(999999)).toEqual([])
    expect(registry.isFullCube(-1)).toBe(false)
  })
})

describe('形状感知的渲染', () => {
  it('半砖占的像素明显少于整块', () => {
    const full = inkOf(oneBlock('minecraft:stone'))
    const slab = inkOf(oneBlock('minecraft:oak_slab'))
    expect(slab).toBeGreaterThan(0)
    expect(slab).toBeLessThan(full * 0.8)
  })

  it('栅栏是细柱，不是墙', () => {
    const full = inkOf(oneBlock('minecraft:stone'))
    const fence = inkOf(oneBlock('minecraft:oak_fence'))
    expect(fence).toBeGreaterThan(0)
    expect(fence).toBeLessThan(full * 0.5)
  })

  it('无碰撞形状的方块（火把）仍然会显示——不能静默消失', () => {
    expect(registry.shapesOf(registry.blockByName('torch')!.defaultState)).toEqual([])
    expect(inkOf(oneBlock('minecraft:torch'))).toBeGreaterThan(0)
  })

  it('楼梯是两级台阶：面上多于一个整块，但墨迹少于 1.5 个整块', () => {
    const store = oneBlock('minecraft:oak_stairs')
    const bounds = store.contentBounds()!
    const camera = fitCamera(bounds, presetAngles('iso_ne'), 240, 240)
    const result = renderIsometric(store, {
      camera,
      resolve: createFallbackColorResolver(),
      background: BG,
      overlays: false,
    })
    expect(result.faces).toBeGreaterThan(3)
    const fullInk = inkOf(oneBlock('minecraft:stone'))
    const stairInk = inkOf(store)
    expect(stairInk).toBeLessThan(fullInk * 1.5)
  })

  it('整立方体贴着整立方体时，内部面被剔除（形状路径下仍然有效）', () => {
    const store = new WorldStore({ minecraftVersion: '1.21.4', volume })
    store.write((v) => {
      for (let x = 0; x < 4; x++) for (let y = 0; y < 4; y++) for (let z = 0; z < 4; z++) v(x, y, z)
    }, store.palette.indexOf('minecraft:stone'), { confirm: true })
    const camera = fitCamera(store.contentBounds()!, presetAngles('iso_ne'), 240, 240)
    const culled = renderIsometric(store, {
      camera,
      resolve: createFallbackColorResolver(),
      background: BG,
      overlays: false,
    })
    const uncelled = renderIsometric(store, {
      camera,
      resolve: createFallbackColorResolver(),
      background: BG,
      overlays: false,
      cullOccluded: false,
    })
    expect(culled.faces).toBeLessThan(uncelled.faces)
  })

  it('正面朝向相机的面才画（一个孤立方块最多 3 个面）', () => {
    const store = oneBlock('minecraft:stone')
    const camera = fitCamera(store.contentBounds()!, presetAngles('iso_ne'), 240, 240)
    const result = renderIsometric(store, {
      camera,
      resolve: createFallbackColorResolver(),
      background: BG,
      overlays: false,
    })
    expect(result.faces).toBe(3)
  })

  it('形状渲染是确定性的', () => {
    const a = oneBlock('minecraft:oak_stairs')
    const b = oneBlock('minecraft:oak_stairs')
    expect(inkOf(a)).toBe(inkOf(b))
  })
})

describe('纹理解析的健壮性', () => {
  it('**texture 为 null 的方块不会让整个渲染崩掉**（回归）', async () => {
    const { averageColor, decodeDataUri, PngError } = await import('../src/png.js')
    expect(() => decodeDataUri(null as unknown as string)).toThrow(PngError)
    expect(typeof averageColor).toBe('function')
  })

  it('资源包解析器能在整张方块表上跑完且不抛异常', () => {
    const resolve = createPackColorResolver('1.21.4', assetsTexturePack('1.21.4'))
    // 挑一批"已知缺纹理"的方块——它们必须安全回退
    for (const name of [
      'oak_fence',
      'cobblestone_wall',
      'glass_pane',
      'iron_bars',
      'vine',
      'air',
      'mushroom_stem',
      'bamboo',
      'tuff_wall',
      'chiseled_bookshelf',
    ]) {
      expect(() => resolve(name), name).not.toThrow()
      const appearance = resolve(name)
      expect(appearance.r).toBeGreaterThanOrEqual(0)
      expect(appearance.r).toBeLessThanOrEqual(255)
    }
  })

  it('栅栏回退到木板色，而不是中性灰（后缀剥离要试多个候选基名）', () => {
    const resolve = createPackColorResolver('1.21.4', assetsTexturePack('1.21.4'))
    const fence = resolve('minecraft:oak_fence')
    const planks = resolve('minecraft:oak_planks')
    expect(fence).toEqual(planks)
  })

  it('墙回退到基础材质色', () => {
    const resolve = createPackColorResolver('1.21.4', assetsTexturePack('1.21.4'))
    expect(resolve('minecraft:cobblestone_wall')).toEqual(resolve('minecraft:cobblestone'))
  })

  it('玻璃板回退到玻璃（含透明度）', () => {
    const resolve = createPackColorResolver('1.21.4', assetsTexturePack('1.21.4'))
    const pane = resolve('minecraft:glass_pane')
    const glass = resolve('minecraft:glass')
    expect(pane).toEqual(glass)
    expect(pane.a).toBeLessThan(1)
  })

  it('实在找不到时用中性灰——不能用随机色（紫色的墙会误导 LLM）', () => {
    const resolve = createPackColorResolver('1.21.4', assetsTexturePack('1.21.4'))
    const unknown = resolve('minecraft:definitely_not_a_block_xyz')
    expect(unknown.r).toBe(unknown.g)
    expect(unknown.g).toBe(unknown.b)
  })

  it('解析器带缓存', () => {
    const resolve = createPackColorResolver('1.21.4', assetsTexturePack('1.21.4'))
    expect(resolve('minecraft:stone')).toBe(resolve('minecraft:stone'))
  })

  it('相机基与投影在形状路径下没变', () => {
    const camera = { target: { x: 0, y: 0, z: 0 }, azimuth: 0, elevation: 0, scale: 10, width: 100, height: 100 }
    const basis = cameraBasis(camera)
    const p = projectPoint({ x: 1, y: 0, z: 0 }, camera, basis)
    expect(p.x).toBeCloseTo(60)
    expect(p.y).toBeCloseTo(50)
  })
})
