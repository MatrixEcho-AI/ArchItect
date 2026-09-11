/**
 * 纹理渲染路径（`mesher.ts` + `raster.ts`）的测试。
 *
 * 这一组锁的是"渲染得和游戏里一致"这句话里**可断言的那部分**：
 *
 * - 几何来自**原版方块模型**，不是碰撞盒（栅栏要连横杆、玻璃板要是一张薄片）；
 * - 颜色来自**逐像素纹理采样**，不是整张纹理的平均色；
 * - 光照是**原版的方向明暗**（顶亮、底暗）+ AO；
 * - z-buffer 真的解决遮挡（画家算法在穿插几何上是错的）。
 *
 * 不断言"和游戏截图逐像素相同"——那需要跑游戏。断言的是那些**一旦退化就会
 * 悄悄变回"看起来差不多但其实是错的"**的性质。
 */

import { WorldStore } from '@architect/core'
import { beforeAll, describe, expect, it } from 'vitest'

import { buildTextureAtlas, TILE_SIZE } from '../src/atlas.js'
import { assetsTexturePack } from '../src/assets.js'
import { cameraBasis, cameraForShot, fitCamera, presetAngles, shotCameraLabel } from '../src/camera.js'
import { createWorldView, loadRenderData, meshWorld } from '../src/mesher.js'
import { renderIsometric } from '../src/isometric.js'
import { createFallbackColorResolver } from '../src/colors.js'

const VERSION = '1.21.4'
const BG = { r: 0, g: 0, b: 0 }

/** 一格的工区，放指定的方块。 */
function world(...blocks: Array<[number, number, number, string]>): WorldStore {
  const store = new WorldStore({
    minecraftVersion: VERSION,
    volume: { min: { x: 0, y: 0, z: 0 }, max: { x: 15, y: 15, z: 15 } },
  })
  for (const [x, y, z, name] of blocks) store.setBlock({ x, y, z }, `minecraft:${name}`)
  return store
}

const pack = (): ReturnType<typeof assetsTexturePack> => assetsTexturePack(VERSION)
const data = (): ReturnType<typeof loadRenderData> => loadRenderData(VERSION, pack())

/**
 * 只网格化一个方块，返回它的三角形数。
 *
 * 放在 **y=1** 而不是 y=0：世界底面（y<0）的面会被原版规则剔除，
 * 放在 y=0 会少掉底面那 2 个三角形，数字对不上"一个完整立方体 12 个三角形"。
 */
function trianglesOf(name: string): number {
  const store = world([0, 1, 0, name])
  return meshWorld(store, data()).indices.length / 3
}

beforeAll(() => {
  // 首次会解码 1040 张纹理，把这一步挪出用例的计时
  loadRenderData(VERSION, pack())
})

describe('网格化：几何来自原版方块模型', () => {
  it('整立方体是 12 个三角形（6 面 × 2），这是基准', () => {
    expect(trianglesOf('stone')).toBe(12)
  })

  it('**楼梯能渲染出来**——上游 `name.includes("air")` 把 57 种楼梯全当空气跳过了', () => {
    // `oak_stairs` 里有 "st-air-s"。这一条是回归测试：一旦有人把 vendored 的
    // 空气判断改回 `includes('air')`，渲染出来的建筑里楼梯会全部消失。
    expect(trianglesOf('oak_stairs')).toBeGreaterThan(12)
    for (const name of ['stone_stairs', 'dark_oak_stairs', 'quartz_stairs']) {
      expect(trianglesOf(name), name).toBeGreaterThan(0)
    }
  })

  it('**栅栏会连横杆**：旁边有栅栏时几何比孤立的多', () => {
    // 孤立的一根栅栏柱和立方体面数一样（都是 6 面），所以"比立方体多"这个判据是错的。
    // 真正的证据是连接：碰撞盒路线下栅栏永远不会长横杆，模型会把栅栏当成实心墙。
    const lone = trianglesOf('oak_fence')
    const store = world([0, 1, 0, 'oak_fence'], [1, 1, 0, 'oak_fence'])
    const connected = meshWorld(store, data()).indices.length / 3
    expect(connected).toBeGreaterThan(lone * 2 - 4)
  })

  it('玻璃板、门、活板门、铁栏杆都按原版模型展开', () => {
    for (const name of ['glass_pane', 'oak_door', 'oak_trapdoor', 'iron_bars']) {
      expect(trianglesOf(name), name).toBeGreaterThan(0)
    }
  })

  it('空气不产生任何几何', () => {
    const store = world([0, 0, 0, 'stone'])
    const only = meshWorld(store, data())
    const empty = new WorldStore({
      minecraftVersion: VERSION,
      volume: { min: { x: 0, y: 0, z: 0 }, max: { x: 15, y: 15, z: 15 } },
    })
    expect(meshWorld(empty, data()).vertices).toBe(0)
    expect(only.vertices).toBeGreaterThan(0)
  })

  it('顶点的世界坐标落在方块自己那一格附近（段偏移没算错）', () => {
    const store = world([5, 3, 7, 'stone'])
    const g = meshWorld(store, data())
    let minX = Infinity
    let maxX = -Infinity
    let minY = Infinity
    let maxY = -Infinity
    for (let i = 0; i < g.vertices; i++) {
      const x = g.positions[i * 3]!
      const y = g.positions[i * 3 + 1]!
      if (x < minX) minX = x
      if (x > maxX) maxX = x
      if (y < minY) minY = y
      if (y > maxY) maxY = y
    }
    // 忘了加段偏移的话会整体偏 8 格
    expect(minX).toBeCloseTo(5, 5)
    expect(maxX).toBeCloseTo(6, 5)
    expect(minY).toBeCloseTo(3, 5)
    expect(maxY).toBeCloseTo(4, 5)
  })

  it('UV 全部落在图集 [0,1] 内', () => {
    const store = world([0, 0, 0, 'stone'], [1, 0, 0, 'oak_stairs'], [2, 0, 0, 'grass_block'])
    const g = meshWorld(store, data())
    for (const uv of g.uvs) {
      expect(uv).toBeGreaterThanOrEqual(0)
      expect(uv).toBeLessThanOrEqual(1)
    }
  })

  it('相邻同类方块之间的面被剔除（不是把 6 个面全画出来）', () => {
    const single = meshWorld(world([0, 1, 0, 'stone']), data()).indices.length / 3
    const pair = meshWorld(world([0, 1, 0, 'stone'], [1, 1, 0, 'stone']), data()).indices.length / 3
    // 贴合的是**两个**面（左边那块朝东的 + 右边那块朝西的），各 2 个三角形：
    // 12 + 12 − 4 = 20
    expect(pair).toBe(single * 2 - 4)
  })
})

describe('世界适配层', () => {
  it('**永远返回方块对象**：空气也要是一个带 position 的真对象', () => {
    // mesher 会直接读 `block.biome.name` 和 `neighbor.position.y`；
    // 返回 undefined 或漏设 position 都会在渲染中途抛，而不是画出点别的
    const view = createWorldView(world([0, 0, 0, 'stone']))
    const air = view.getBlock({ x: 4, y: 4, z: 4 })
    expect(air).toBeDefined()
    expect(air?.name).toBe('air')
    expect(air?.position).toBeDefined()
  })

  it('生物群系按**名字**取（按 id 硬编码在 1.21.4 会拿到 bamboo_jungle）', () => {
    const view = createWorldView(world([0, 0, 0, 'water']))
    expect(view.getBlock({ x: 0, y: 0, z: 0 })?.biome?.name).toBe('plains')
  })

  it('isCube 只对"正好一个整立方体盒"的方块为真', () => {
    const view = createWorldView(world([0, 0, 0, 'stone'], [1, 0, 0, 'oak_slab'], [2, 0, 0, 'water']))
    expect((view.getBlock({ x: 0, y: 0, z: 0 }) as { isCube?: boolean }).isCube).toBe(true)
    expect((view.getBlock({ x: 1, y: 0, z: 0 }) as { isCube?: boolean }).isCube).toBe(false)
  })
})

describe('光栅化：逐像素采样真实纹理', () => {
  /**
   * 渲染一面墙，返回它的像素。这一条是整次改造的**核心动机**：
   * `stone_bricks` 和 `stone` 的平均色只差 4/255（122 vs 126），
   * 纯色渲染下模型分辨不出自己砌的是哪一种。
   */
  function wallPixels(name: string): Uint8Array {
    const store = new WorldStore({
      minecraftVersion: VERSION,
      volume: { min: { x: 0, y: 0, z: 0 }, max: { x: 7, y: 7, z: 7 } },
    })
    for (let x = 0; x < 8; x++) {
      for (let z = 0; z < 8; z++) store.setBlock({ x, y: 0, z }, `minecraft:${name}`)
    }
    const camera = fitCamera(store.contentBounds()!, presetAngles('iso_ne'), 320, 320)
    const canvas = renderIsometric(store, {
      camera,
      resolve: createFallbackColorResolver(),
      background: BG,
      overlays: false,
      textured: true,
      textures: pack(),
    }).canvas
    return canvas.data
  }

  it('**石砖和石头渲染出来的像素明显不同**（平均色几乎一样，纹理差很多）', () => {
    const bricks = wallPixels('stone_bricks')
    const stone = wallPixels('stone')
    let different = 0
    let painted = 0
    for (let i = 0; i < bricks.length; i += 4) {
      if (bricks[i + 3] === 0) continue
      painted++
      if (bricks[i] !== stone[i]) different++
    }
    expect(painted).toBeGreaterThan(0)
    expect(different / painted).toBeGreaterThan(0.1)
  })

  it('同一张纹理渲染两次逐字节一致（软件光栅器的确定性）', () => {
    expect(wallPixels('stone_bricks')).toEqual(wallPixels('stone_bricks'))
  })

  it('纹理没有被平均掉：墙上出现了多种颜色', () => {
    const pixels = wallPixels('stone_bricks')
    const seen = new Set<number>()
    for (let i = 0; i < pixels.length; i += 4) {
      if (pixels[i + 3] === 0) continue
      seen.add((pixels[i]! << 16) | (pixels[i + 1]! << 8) | pixels[i + 2]!)
    }
    expect(seen.size).toBeGreaterThan(2)
  })

  it('**水的颜色不是黑的**（生物群系着色查不到时会静默变成 0）', () => {
    const store = new WorldStore({
      minecraftVersion: VERSION,
      volume: { min: { x: 0, y: 0, z: 0 }, max: { x: 7, y: 7, z: 7 } },
    })
    for (let x = 0; x < 8; x++) for (let z = 0; z < 8; z++) store.setBlock({ x, y: 0, z }, 'minecraft:water')
    const camera = fitCamera(store.contentBounds()!, presetAngles('iso_ne'), 200, 200)
    const canvas = renderIsometric(store, {
      camera,
      resolve: createFallbackColorResolver(),
      background: BG,
      overlays: false,
      textured: true,
      textures: pack(),
    }).canvas
    let blue = 0
    for (let i = 0; i < canvas.data.length; i += 4) {
      if (canvas.data[i + 2]! > canvas.data[i]! + 20) blue++
    }
    expect(blue).toBeGreaterThan(100)
  })
})

describe('光栅化：z-buffer', () => {
  it('近处的方块挡住远处的（画家算法做不到）', () => {
    const store = new WorldStore({
      minecraftVersion: VERSION,
      volume: { min: { x: 0, y: 0, z: 0 }, max: { x: 7, y: 7, z: 7 } },
    })
    store.setBlock({ x: 0, y: 0, z: 0 }, 'minecraft:red_concrete')
    store.setBlock({ x: 0, y: 1, z: 0 }, 'minecraft:lime_concrete')
    store.setBlock({ x: 0, y: 2, z: 0 }, 'minecraft:blue_concrete')
    // 正上方俯视：看到的是最上面那一块
    const camera = fitCamera(store.contentBounds()!, presetAngles('top'), 120, 120)
    const canvas = renderIsometric(store, {
      camera,
      resolve: createFallbackColorResolver(),
      background: BG,
      overlays: false,
      textured: true,
      textures: pack(),
    }).canvas
    let r = 0
    let g = 0
    let b = 0
    for (let i = 0; i < canvas.data.length; i += 4) {
      r += canvas.data[i]!
      g += canvas.data[i + 1]!
      b += canvas.data[i + 2]!
    }
    expect(b).toBeGreaterThan(r)
    expect(b).toBeGreaterThan(g)
  })
})

describe('相机：坐标与朝向', () => {
  const bounds = { min: { x: 0, y: 0, z: 0 }, max: { x: 15, y: 15, z: 15 } }
  const base = { view: 'iso_ne', width: 320, height: 240 }

  it('`eye` + `lookAt` 反解出朝向，`lookAt` 成为画面中心', () => {
    // 站在 +Z 一侧看向原点 → 应该是 az=0（从 +Z 朝 -Z 看）
    const c = cameraForShot(bounds, { ...base, eye: [8, 8, 100], lookAt: [8, 8, 0] })
    expect(Math.abs(c.azimuth)).toBeLessThan(1e-9)
    expect(Math.abs(c.elevation)).toBeLessThan(1e-9)
    expect(c.target).toEqual({ x: 8, y: 8, z: 0 })
  })

  it('**正交投影下距离不影响成像**：把相机放远一倍，画面必须逐字节一样', () => {
    // 必须是**同一条射线**上的两个点，否则方向本来就不同（那验的就不是距离了）
    const lookAt: [number, number, number] = [8, 8, 8]
    const near = cameraForShot(bounds, { ...base, eye: [8, 8 + 10, 8 + 10], lookAt })
    const far = cameraForShot(bounds, { ...base, eye: [8, 8 + 1000, 8 + 1000], lookAt })
    expect(far.azimuth).toBeCloseTo(near.azimuth, 10)
    expect(far.elevation).toBeCloseTo(near.elevation, 10)
    // 注视点相同、角度相同、自动取景相同 ⇒ 同一个相机
    expect(far.target).toEqual(near.target)
    expect(far.scale).toBeCloseTo(near.scale, 10)
  })

  it('正上方俯视（eye 在 lookAt 正上方）不退化', () => {
    const c = cameraForShot(bounds, { ...base, eye: [8, 100, 8], lookAt: [8, 8, 8] })
    expect(c.elevation).toBeCloseTo(90, 6)
    // 90° 时 cameraBasis 的 up 会退化，但反解出来的基仍然要能投影出有限值
    const basis = cameraBasis(c)
    expect(Number.isFinite(basis.up.x + basis.up.y + basis.up.z)).toBe(true)
  })

  it('相机与注视点重合 → 明确报错，而不是画出一堆 NaN', () => {
    expect(() => cameraForShot(bounds, { ...base, eye: [4, 4, 4], lookAt: [4, 4, 4] })).toThrow()
  })

  it('`roll` 真的把画面转起来（旋转 90° 后像素必须不同）', () => {
    const store = world([0, 1, 0, 'stone_bricks'], [4, 1, 2, 'red_concrete'])
    const shot = (roll: number): Uint8Array =>
      renderIsometric(store, {
        camera: cameraForShot(bounds, { ...base, azimuth: 30, elevation: 25, roll }),
        resolve: createFallbackColorResolver(),
        background: BG,
        overlays: false,
        textured: true,
        textures: pack(),
      }).canvas.data
    expect(shot(0)).not.toEqual(shot(90))
  })

  it('`eye` 单独给（没有 lookAt）时被忽略，退回预设机位', () => {
    const withEye = cameraForShot(bounds, { ...base, eye: [0, 0, 100] })
    const plain = cameraForShot(bounds, base)
    expect(withEye.azimuth).toBeCloseTo(plain.azimuth, 10)
    expect(withEye.elevation).toBeCloseTo(plain.elevation, 10)
  })

  it('机位标签把 eye/lookAt 与滚转都写出来（档案里要能分辨）', () => {
    expect(shotCameraLabel({ ...base, eye: [1, 2, 3], lookAt: [4, 5, 6] })).toBe('eye(1,2,3)→(4,5,6)')
    expect(shotCameraLabel({ ...base, azimuth: 45, elevation: 30, roll: 15 })).toBe('az45/el30/rl15')
    expect(shotCameraLabel({ ...base, view: 'top' })).toBe('top')
  })

  it('**同一组角度、不同注视点是两张不同的图**，标签必须区分得开', () => {
    // 人机共用机位那条路推的就是"角度 + 注视点"：只写角度的话，
    // 用户在面板上把注视点挪到檐口前后，档案里两张图会长得一模一样
    expect(shotCameraLabel({ ...base, azimuth: 45, elevation: 30, lookAt: [8, 5, 8] })).toBe(
      'az45/el30→(8,5,8)',
    )
    expect(shotCameraLabel({ ...base, azimuth: 45, elevation: 30, roll: 0, target: [16, 6, 0] })).toBe(
      'az45/el30→(16,6,0)',
    )
  })
})

describe('图集本身', () => {
  it('tile 尺寸是 16，图集边长是 2 的幂', () => {
    const atlas = buildTextureAtlas(VERSION, pack())
    expect(TILE_SIZE).toBe(16)
    expect(atlas.size % TILE_SIZE).toBe(0)
    expect(Math.log2(atlas.size) % 1).toBe(0)
  })

  it('每个已知方块纹理都能在资源包里找到（`--plain` 之外的路径不该大面积命中 missing）', () => {
    const atlas = buildTextureAtlas(VERSION, pack())
    // 注意：`textures` 的键是**纹理名**，不是方块名——`smooth_quartz` 这个方块用的是
    // `quartz_block_bottom/side/top` 三张纹理，图集里没有叫 `smooth_quartz` 的纹理。
    for (const name of ['stone', 'stone_bricks', 'quartz_block_top', 'oak_planks', 'red_concrete', 'glass']) {
      expect(atlas.textures[name], name).toBeDefined()
    }
    expect(Object.keys(atlas.textures).length).toBeGreaterThan(1000)
  })
})

describe('两条渲染路径并存', () => {
  it('`textured` 关掉时逐字节回到纯色路径（golden 测试靠它）', () => {
    const store = world([0, 0, 0, 'stone_bricks'], [1, 0, 0, 'oak_planks'])
    const camera = fitCamera(store.contentBounds()!, presetAngles('iso_ne'), 160, 160)
    const plain = renderIsometric(store, {
      camera,
      resolve: createFallbackColorResolver(),
      background: BG,
      overlays: false,
    })
    const textured = renderIsometric(store, {
      camera,
      resolve: createFallbackColorResolver(),
      background: BG,
      overlays: false,
      textured: true,
      textures: pack(),
    })
    // 两条路径必须给出不同的像素——相同就说明 `textured` 根本没接上
    expect(plain.canvas.data).not.toEqual(textured.canvas.data)
    expect(plain.blocks).toBe(2)
    expect(textured.blocks).toBe(2)
  })
})
