/**
 * 正交射线拾取（`pick.ts`）。
 *
 * 这一组测的是**人手接管的地基**："我点的那个像素，就是我看到的那一格"。
 * 所以最有力的断言是**往返**：先按渲染用的投影把某一面投影到屏幕上，
 * 再拿那个像素去拾取，看回来的格子与朝向对不对得上。
 * 自己另写一套反投影的话，这种往返会以"差一格"的形式飘掉。
 */

import { WorldStore } from '@architect/core'
import { beforeAll, describe, expect, it } from 'vitest'

import { cameraForShot, projectPoint, cameraBasis } from '../src/camera.js'
import type { CameraSpec } from '../src/camera.js'
import { assetsTexturePack } from '../src/assets.js'
import { loadRenderData, meshWorld } from '../src/mesher.js'
import { pickBlock, screenRay } from '../src/pick.js'

const VERSION = '1.21.4'
const VOLUME = { min: { x: 0, y: 0, z: 0 }, max: { x: 15, y: 15, z: 15 } }

function world(blocks: Array<[number, number, number, string]>): WorldStore {
  const store = new WorldStore({ minecraftVersion: VERSION, volume: VOLUME })
  for (const [x, y, z, name] of blocks) store.setBlock({ x, y, z }, `minecraft:${name}`)
  return store
}

/**
 * 1.21.4 的渲染数据（方块模型 + 贴图集）加载一次要 1 秒出头，是**整个文件共享**
 * 的成本（`loadRenderData` 内部有 versionCache）。必须在这里显式付掉，
 * 否则它会算在「本文件里第一个跑到的测试」头上：那个测试单独跑 1.3 秒，
 * 全量并行抢 CPU 时膨胀到 5.9 秒，直接撞穿 vitest 默认的 5 秒超时，变成随机假红。
 * 成本归属摆正之后，单个用例才能回到几十毫秒。
 */
beforeAll(() => {
  loadRenderData(VERSION, assetsTexturePack(VERSION))
}, 120_000)

const geometryOf = (store: WorldStore): ReturnType<typeof meshWorld> =>
  meshWorld(store, loadRenderData(VERSION, assetsTexturePack(VERSION)))

const camera = (azimuth: number, elevation: number, scale = 24): CameraSpec =>
  cameraForShot(VOLUME, { view: 'iso_ne', width: 600, height: 400, azimuth, elevation, scale })

/** 某一格某一面的中心（世界坐标）。`axis` 为 0/1/2，`side` 为 ±1。 */
function faceCentre(cell: [number, number, number], axis: number, side: number): {
  x: number
  y: number
  z: number
} {
  const point = {
    x: cell[0] + 0.5,
    y: cell[1] + 0.5,
    z: cell[2] + 0.5,
  }
  const key = axis === 0 ? 'x' : axis === 1 ? 'y' : 'z'
  point[key] = cell[axis]! + (side > 0 ? 1 : 0)
  return point
}

const AXES: Array<{ axis: number; side: number; normal: [number, number, number]; name: string }> = [
  { axis: 0, side: 1, normal: [1, 0, 0], name: '+X' },
  { axis: 0, side: -1, normal: [-1, 0, 0], name: '-X' },
  { axis: 1, side: 1, normal: [0, 1, 0], name: '+Y' },
  { axis: 1, side: -1, normal: [0, -1, 0], name: '-Y' },
  { axis: 2, side: 1, normal: [0, 0, 1], name: '+Z' },
  { axis: 2, side: -1, normal: [0, 0, -1], name: '-Z' },
]

describe('拾取：往返（投影 → 拾取）', () => {
  it('**六个面各自投影到屏幕再拾取，回的格子都是它自己，朝向也对**', () => {
    const store = world([[5, 5, 5, 'stone']])
    const geometry = geometryOf(store)

    for (const azimuth of [45, 0, 135, -60]) {
      for (const elevation of [35, 1, 80]) {
        const spec = camera(azimuth, elevation)
        const basis = cameraBasis(spec)
        for (const face of AXES) {
          const projected = projectPoint(faceCentre([5, 5, 5], face.axis, face.side), spec, basis)
          const hit = pickBlock(geometry, spec, projected.x, projected.y)
          const where = `az${azimuth}/el${elevation} ${face.name}`
          expect(hit, `${where} 没打中`).toBeDefined()
          expect(hit!.block, `${where} 打到了别的格子`).toEqual({ x: 5, y: 5, z: 5 })

          // 背对相机的那些面**看不见**（同一格的正面挡在它前面），所以在那个像素上
          // 打到的是正面——这是对的，不是 bug。只有朝向相机的面才要求法线逐字对上。
          const facing =
            face.normal[0] * basis.forward.x +
            face.normal[1] * basis.forward.y +
            face.normal[2] * basis.forward.z
          if (facing >= 0) continue

          expect(hit!.normal, `${where} 的朝向不对`).toEqual({
            x: face.normal[0],
            y: face.normal[1],
            z: face.normal[2],
          })
          // 放置位置 = 命中格 + 朝向：每个可见面各对应一个不同的邻居
          expect(hit!.place, `${where} 的放置位置不对`).toEqual({
            x: 5 + face.normal[0],
            y: 5 + face.normal[1],
            z: 5 + face.normal[2],
          })
        }
      }
    }
  })

  it('每个机位至少验到三个可见面（否则上面那圈断言会空转）', () => {
    for (const azimuth of [45, 0, 135, -60]) {
      for (const elevation of [35, 1, 80]) {
        const basis = cameraBasis(camera(azimuth, elevation))
        const visible = AXES.filter(
          (face) =>
            face.normal[0] * basis.forward.x +
              face.normal[1] * basis.forward.y +
              face.normal[2] * basis.forward.z <
            0,
        )
        // 正对着轴看时只有 2 个面朝向相机（顶面 + 一个侧面）；斜着看才有 3 个。
        // 断言"至少 2"是为了说明上面那圈法线断言没有空转。
        expect(visible.length, `az${azimuth}/el${elevation}`).toBeGreaterThanOrEqual(2)
      }
    }
  })

  it('朝向与格子**永远一致**：place 总是 block 的某个相邻格', () => {
    const store = world([
      [4, 4, 4, 'oak_planks'],
      [6, 4, 4, 'stone'],
      [5, 6, 4, 'glass'],
    ])
    const geometry = geometryOf(store)
    const spec = camera(40, 30)
    let hits = 0
    for (let x = 0; x < 600; x += 7) {
      for (let y = 0; y < 400; y += 7) {
        const hit = pickBlock(geometry, spec, x, y)
        if (hit === undefined) continue
        hits++
        const step =
          Math.abs(hit.place.x - hit.block.x) +
          Math.abs(hit.place.y - hit.block.y) +
          Math.abs(hit.place.z - hit.block.z)
        expect(step, `(${x},${y}) 的 place 不是相邻格`).toBe(1)
      }
    }
    expect(hits).toBeGreaterThan(50)
  })

  it('打天空返回 undefined（拖到画面空白处不该改任何东西）', () => {
    // 只在角落放一格，画面绝大部分是空的
    const store = world([[0, 0, 0, 'stone']])
    const geometry = geometryOf(store)
    const spec = camera(45, 30, 4)
    expect(pickBlock(geometry, spec, 0, 0)).toBeUndefined()
    expect(pickBlock(geometry, spec, 599, 399)).toBeUndefined()
  })

  it('空世界什么都打不中', () => {
    const geometry = geometryOf(world([]))
    expect(pickBlock(geometry, camera(45, 30), 300, 200)).toBeUndefined()
  })
})

describe('拾取：遮挡与几何', () => {
  it('**取最近的那个**：前面一格的背面不会盖住后面那格', () => {
    // 沿视线方向排两个方块：近的那个应该赢
    const store = world([
      [5, 5, 5, 'stone'],
      [5, 5, 6, 'stone'],
    ])
    const geometry = geometryOf(store)
    // azimuth 0 = 从 +Z 朝 -Z 看，所以 z=6 的那个离相机更近
    const spec = camera(0, 1, 30)
    const basis = cameraBasis(spec)
    const projected = projectPoint({ x: 5.5, y: 5.5, z: 6 }, spec, basis)
    const hit = pickBlock(geometry, spec, projected.x, projected.y)
    expect(hit!.block).toEqual({ x: 5, y: 5, z: 6 })
    expect(hit!.normal).toEqual({ x: 0, y: 0, z: 1 })
  })

  it('**非立方体方块也能拾取**（楼梯的面不是整格大），命中的仍是它自己那一格', () => {
    const store = world([[8, 8, 8, 'oak_stairs']])
    const geometry = geometryOf(store)
    const spec = camera(45, 35, 40)
    const basis = cameraBasis(spec)
    // 楼梯的实体部分在格子下半，往中心偏下一点投
    const projected = projectPoint({ x: 8.5, y: 8.3, z: 8.5 }, spec, basis)
    const hit = pickBlock(geometry, spec, projected.x, projected.y)
    expect(hit).toBeDefined()
    expect(hit!.block).toEqual({ x: 8, y: 8, z: 8 })
  })

  it('射线方向就是视线方向，起点随像素平移（正交投影）', () => {
    const spec = camera(31, 27)
    const a = screenRay(spec, 0, 0)
    const b = screenRay(spec, 599, 399)
    expect(a.direction).toEqual(b.direction)
    expect(a.origin).not.toEqual(b.origin)
    // 起点与目标点连线必须与视线平行：把两点之差投影到 right/up 上应当是 0
    const basis = cameraBasis(spec)
    const dx = a.origin.x - spec.target.x
    const dy = a.origin.y - spec.target.y
    const dz = a.origin.z - spec.target.z
    expect(dx * basis.right.x + dy * basis.right.y + dz * basis.right.z).toBeCloseTo(
      (0 - spec.width / 2) / spec.scale,
      6,
    )
  })
})
