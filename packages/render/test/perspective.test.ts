/**
 * **透视投影那条路**（人看的视口）。
 *
 * 正交那一路有签名图钉着（逐字节确定）；透视这一路最该验的是三件事：
 *
 * 1. 真的**近大远小**（同一个方块，站远了画出来就小）；
 * 2. **贴着方块站**不会画出满屏乱飞的三角形——那是"没裁近平面"的典型症状
 *    （顶点落到相机后面，除以 z 把整个三角形翻到画面另一侧）；
 * 3. 拾取与渲染**同一个相机**：画面正中的那个像素，拾回来的就是正前方那一格。
 */

import { WorldStore } from '@architect/core'
import { describe, expect, it } from 'vitest'

import { assetsTexturePack } from '../src/assets.js'
import { cameraBasis, orientationFromEye } from '../src/camera.js'
import type { CameraSpec } from '../src/camera.js'
import { Canvas } from '../src/canvas.js'
import { loadRenderData, meshWorld } from '../src/mesher.js'
import { pickBlock } from '../src/pick.js'
import { rasterize } from '../src/raster.js'

const VERSION = '1.21.4'
const VOLUME = { min: { x: 0, y: 0, z: 0 }, max: { x: 15, y: 15, z: 15 } }

const data = loadRenderData(VERSION, assetsTexturePack(VERSION))

function world(blocks: Array<[number, number, number, string]>): WorldStore {
  const store = new WorldStore({ minecraftVersion: VERSION, volume: VOLUME })
  for (const [x, y, z, name] of blocks) store.setBlock({ x, y, z }, `minecraft:${name}`)
  return store
}

/** 一台"站在 eye、看向 -Z"的透视相机（az=0/el=0 时 forward = (0,0,-1)）。 */
function cameraAt(eye: [number, number, number], width = 320, height = 240): CameraSpec {
  return {
    target: { x: eye[0], y: eye[1], z: eye[2] - 1 },
    azimuth: 0,
    elevation: 0,
    scale: 1,
    width,
    height,
    perspective: { eye: { x: eye[0], y: eye[1], z: eye[2] }, fov: 70 },
  }
}

/** 一台"站在 eye、盯着 at 看"的透视相机。 */
function lookFrom(
  eye: [number, number, number],
  at: [number, number, number],
  width = 320,
  height = 240,
): CameraSpec {
  const angles = orientationFromEye(
    { x: eye[0], y: eye[1], z: eye[2] },
    { x: at[0], y: at[1], z: at[2] },
  )
  return {
    target: { x: at[0], y: at[1], z: at[2] },
    azimuth: angles.azimuth,
    elevation: angles.elevation,
    scale: 1,
    width,
    height,
    perspective: { eye: { x: eye[0], y: eye[1], z: eye[2] }, fov: 70 },
  }
}

function paint(store: WorldStore, camera: CameraSpec): { painted: number; total: number } {
  const canvas = new Canvas(camera.width, camera.height, { r: 0, g: 0, b: 0 })
  rasterize(meshWorld(store, data), { camera, atlas: data.atlas, canvas })
  let painted = 0
  for (let i = 0; i < canvas.data.length; i += 4) {
    if (canvas.data[i] !== 0 || canvas.data[i + 1] !== 0 || canvas.data[i + 2] !== 0) painted++
  }
  return { painted, total: camera.width * camera.height }
}

describe('透视光栅化', () => {
  it('**近大远小**：同一个方块，站得远画出来就小', () => {
    const store = world([[5, 5, 5, 'stone']])
    const near = paint(store, cameraAt([5.5, 5.5, 12.5]))
    const far = paint(store, cameraAt([5.5, 5.5, 24.5]))
    expect(near.painted).toBeGreaterThan(0)
    expect(far.painted).toBeGreaterThan(0)
    // 距离翻倍 → 面积约 1/4（透视投影的平方反比）
    expect(far.painted / near.painted).toBeLessThan(0.45)
  })

  it('**贴着方块站（面落在近裁剪面之内）不会画出满屏垃圾**', () => {
    const store = world([[5, 5, 5, 'stone']])
    // 站在 +X 面外 0.05 格、贴着它的一个角：(6,5,5) 那个顶点离眼睛只有 0.05 格，
    // 比近裁剪面还近——那条三角形**跨过近裁剪面**。不裁的话它会被除以 0.05 放大到屏外
    const close = paint(store, lookFrom([6.05, 5.0, 5.0], [5.5, 5.5, 5.5]))
    expect(close.painted).toBeGreaterThan(0)
    // 不裁的话那个近端顶点会被放大成满屏色块：这里必须**远小于**整屏
    expect(close.painted).toBeLessThan(close.total * 0.5)
    // 近大远小：退开之后同一块画出来更小
    const farther = paint(store, lookFrom([9, 7, 7], [5.5, 5.5, 5.5]))
    expect(farther.painted).toBeLessThan(close.painted)
  })

  it('**拾取和渲染同一个相机**：画面正中那一格就是正前方那一格', () => {
    const store = world([[5, 5, 5, 'stone']])
    const camera = cameraAt([5.5, 5.5, 12.5])
    const hit = pickBlock(meshWorld(store, data), camera, camera.width / 2, camera.height / 2)
    expect(hit).toBeDefined()
    expect(hit!.block).toEqual({ x: 5, y: 5, z: 5 })
    // 正前方看到的是 +Z 那一面
    expect(hit!.normal).toEqual({ x: 0, y: 0, z: 1 })
    // 射线确实是从相机出发的
    expect(cameraBasis(camera).forward.z).toBeCloseTo(-1, 9)
  })

  it('相机后面的东西不会被拾取到', () => {
    const store = world([[5, 5, 5, 'stone']])
    // 站在方块的 +Z 侧却朝 +Z 看：目标在身后
    const camera: CameraSpec = { ...cameraAt([5.5, 5.5, 12.5]), azimuth: 180 }
    const hit = pickBlock(meshWorld(store, data), camera, camera.width / 2, camera.height / 2)
    expect(hit).toBeUndefined()
  })
})
