import { describe, expect, it } from 'vitest'

import {
  anchorOf,
  createFreeCamera,
  forwardOf,
  materialize,
  moveStep,
  pan,
  rightOf,
  turn,
} from '../src/renderer/freecamera.js'

/**
 * 自由相机的**数学**。
 *
 * 这里断言的不是"函数被调用了"，而是三件用户能感觉到的性质：
 * 1. WASD 相对**相机自己**走（抬头按 W 会上升，横移不会改高度）；
 * 2. 转头是**原地**的（位置不动，画面中心转到新视线上）——这正是"像游戏里一样"
 *    和"绕着目标转"的全部差别；
 * 3. 仰角能抬头（负值）但不会翻过极点。
 */

const cameraAt = (azimuth: number, elevation: number, focus = 10) => {
  const camera = createFreeCamera({ azimuth, elevation, focus })
  materialize(camera, [0, 0, 0])
  return camera
}

describe('自由相机', () => {
  it('初始状态还没落地：画面中心交给自动取景', () => {
    const camera = createFreeCamera({ azimuth: 45, elevation: 35, focus: 32 })
    expect(camera.eye).toBeUndefined()
    expect(anchorOf(camera)).toBeUndefined()
  })

  it('落地之后位置在画面中心**沿视线后退** focus 的地方（不改成像）', () => {
    const camera = createFreeCamera({ azimuth: 0, elevation: 0, focus: 10 })
    materialize(camera, [0, 0, 0])
    // az=0/el=0 = 站在 +Z 看向 -Z
    const forward = forwardOf(camera)
    expect(forward[0]).toBeCloseTo(0, 9)
    expect(forward[1]).toBeCloseTo(0, 9)
    expect(forward[2]).toBeCloseTo(-1, 9)
    expect(camera.eye).toEqual([0, 0, 10])
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

  it('**原地转头**：位置一动不动，画面中心转到新视线上', () => {
    const camera = cameraAt(0, 0)
    const before = [...camera.eye!]
    turn(camera, 90, 0, 1) // 往右拖 90 px，灵敏度 1°/px
    expect(camera.azimuth).toBeCloseTo(-90, 9)
    expect(camera.eye).toEqual(before) // **位置不变**
    const anchor = anchorOf(camera)!
    for (const index of [0, 1, 2]) {
      expect(anchor[index]!).toBeCloseTo([10, 0, 10][index]!, 9) // 从 (0,0,0) 挪到了新视线上
    }
    // 画面中心永远在视线上、离相机 focus 远
    const forward = forwardOf(camera)
    for (const index of [0, 1, 2]) {
      expect(anchor[index]! - before[index]!).toBeCloseTo(forward[index]! * 10, 6)
    }
  })

  it('转头**不会**把画面中心钉在原地（那正是"绕点旋转"的旧行为）', () => {
    const camera = cameraAt(45, 35)
    const anchorBefore = anchorOf(camera)!
    turn(camera, 120, 60, 1)
    const anchorAfter = anchorOf(camera)!
    const moved = Math.hypot(
      anchorAfter[0] - anchorBefore[0],
      anchorAfter[1] - anchorBefore[1],
      anchorAfter[2] - anchorBefore[2],
    )
    expect(moved).toBeGreaterThan(1)
  })

  it('仰角能抬头到 -89，但翻不过去', () => {
    const camera = cameraAt(0, 0)
    turn(camera, 0, 10_000, 1)
    expect(camera.elevation).toBe(89)
    turn(camera, 0, -10_000, 1)
    expect(camera.elevation).toBe(-89)
  })

  it('平移之后画面中心跟着走（由位置推导，不再是钉住的注视点）', () => {
    const camera = cameraAt(0, 0)
    camera.target = [5, 5, 5] // 机位面板明确指定的注视点
    pan(camera, 0, 2)
    expect(camera.target).toBeUndefined() // 位置说话：注视点让位
    expect(anchorOf(camera)).toEqual([2, 0, 0])
  })
})
