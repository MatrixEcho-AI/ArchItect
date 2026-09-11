import { describe, expect, it } from 'vitest'

import {
  createFreeCamera,
  forwardOf,
  FOV_RANGE,
  lookAtFrom,
  moveStep,
  pan,
  place,
  rightOf,
  turn,
  zoom,
} from '../src/renderer/freecamera.js'

/**
 * 自由相机的**数学**。
 *
 * 断言的是三件用户能感觉到的性质：
 * 1. WASD 相对**相机自己**走（抬头按 W 会上升，横移不会改高度）；
 * 2. 转头是**原地**的（位置一动不动）——这正是"像 Minecraft 那样转头"与
 *    "建筑像个托盘一样自转"的全部差别；
 * 3. 仰角能抬头（负值）但不会翻过极点，视场角有上下限。
 */

const cameraAt = (azimuth: number, elevation: number) => {
  const camera = createFreeCamera({ azimuth, elevation, fov: 70 })
  place(camera, [0, 0, 10])
  return camera
}

describe('自由相机', () => {
  it('落地之前没有位置；place 之后就是那个点', () => {
    const camera = createFreeCamera({ azimuth: 45, elevation: 35, fov: 70 })
    expect(camera.eye).toBeUndefined()
    // 还没落地（自动取景）时移动键是空操作，不会把相机推到奇怪的地方
    pan(camera, 5, 5)
    expect(camera.eye).toBeUndefined()
    place(camera, [1, 2, 3])
    expect(camera.eye).toEqual([1, 2, 3])
  })

  it('az=0/el=0 时看向 -Z，右方是 +X（和渲染层的约定一致）', () => {
    const camera = cameraAt(0, 0)
    const forward = forwardOf(camera)
    expect(forward[0]).toBeCloseTo(0, 9)
    expect(forward[1]).toBeCloseTo(0, 9)
    expect(forward[2]).toBeCloseTo(-1, 9)
    const right = rightOf(camera)
    expect(right[0]).toBeCloseTo(1, 9)
    expect(right[1]).toBeCloseTo(0, 9)
    expect(right[2]).toBeCloseTo(0, 9)
  })

  it('**W 沿视线走（含俯仰）**：抬头按 W 是上升，不是贴地往前', () => {
    const camera = cameraAt(0, -30)
    const [fx, fy, fz] = forwardOf(camera)
    expect(fy).toBeGreaterThan(0) // 抬头 → 视线朝上
    const before = [...camera.eye!]
    moveStep(camera, new Set(['w']), 1, 2)
    const after = camera.eye!
    // 位移与视线同向，长度 = 速度 × 时间
    for (const [index, component] of [fx, fy, fz].entries()) {
      expect(after[index]! - before[index]!).toBeCloseTo(component * 2, 6)
    }
    expect(after[1]).toBeGreaterThan(before[1]!)
  })

  it('**A/D 是水平横移**：不管仰角多大，都不会把人带飞', () => {
    const camera = cameraAt(0, 60)
    expect(rightOf(camera)[1]).toBe(0)
    const before = [...camera.eye!]
    moveStep(camera, new Set(['d']), 1, 3)
    expect(camera.eye![1]).toBeCloseTo(before[1]!, 9)
    expect(camera.eye![0]).toBeCloseTo(before[0]! + 3, 6)
  })

  it('按住相反的方向互相抵消（W+S 不动、A+D 不动）', () => {
    const camera = cameraAt(20, 20)
    const before = [...camera.eye!]
    moveStep(camera, new Set(['w', 's']), 1, 5)
    moveStep(camera, new Set(['a', 'd']), 1, 5)
    expect(camera.eye).toEqual(before)
  })

  it('**原地转头**：位置一动不动，视线转到新的方向上', () => {
    const camera = cameraAt(0, 0)
    const before = [...camera.eye!]
    turn(camera, 90, 0, 1) // 往右拖 90 px，灵敏度 1°/px
    expect(camera.azimuth).toBeCloseTo(-90, 9)
    expect(camera.eye).toEqual(before) // **位置不变**
    // 转了 90°：原本看向 -Z，现在看向 +X
    const forward = forwardOf(camera)
    expect(forward[0]).toBeCloseTo(1, 6)
    expect(forward[2]).toBeCloseTo(0, 6)
  })

  it('方位角只保留一轮：一直往一个方向拖不会攒到 500°', () => {
    const camera = cameraAt(0, 0)
    turn(camera, 400, 0, 1) // 往右拖 400 px
    expect(camera.azimuth).toBeGreaterThanOrEqual(-180)
    expect(camera.azimuth).toBeLessThanOrEqual(180)
    expect(camera.azimuth).toBeCloseTo(-40, 9) // -400° 折回 -40°
  })

  it('仰角能抬头到 -89，但翻不过去', () => {
    const camera = cameraAt(0, 0)
    turn(camera, 0, 10_000, 1)
    expect(camera.elevation).toBe(89)
    turn(camera, 0, -10_000, 1)
    expect(camera.elevation).toBe(-89)
  })

  it('滚轮改视场角：上滚放大（fov 变小），且夹在范围内', () => {
    const camera = cameraAt(0, 0)
    const before = camera.fov
    zoom(camera, -100)
    expect(camera.fov).toBeLessThan(before)
    zoom(camera, 100)
    expect(camera.fov).toBeCloseTo(before, 6)
    zoom(camera, -100_000)
    expect(camera.fov).toBe(FOV_RANGE.min)
    zoom(camera, 100_000)
    expect(camera.fov).toBe(FOV_RANGE.max)
  })

  it('lookAtFrom 落在视线上、距离正确（推给模型的机位用它）', () => {
    const camera = cameraAt(35, 20)
    const [fx, fy, fz] = forwardOf(camera)
    const at = lookAtFrom(camera, 12)
    const eye = camera.eye!
    expect(at[0] - eye[0]).toBeCloseTo(fx * 12, 6)
    expect(at[1] - eye[1]).toBeCloseTo(fy * 12, 6)
    expect(at[2] - eye[2]).toBeCloseTo(fz * 12, 6)
  })
})
