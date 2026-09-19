import { describe, expect, it } from 'vitest'

import { basisFromAngles, projectPoint } from '@architect/render/browser'
import type { CameraSpec } from '@architect/render/browser'

import {
  createFreeCamera,
  dolly,
  DRAG_SENSITIVITY,
  dragUnitFor,
  forwardOf,
  groundForwardOf,
  FOV_RANGE,
  lookAtFrom,
  look,
  moveStep,
  orbit,
  pan,
  place,
  rightOf,
  track,
  turn,
  zoom,
} from '../src/renderer/freecamera.js'
import type { Vec3 } from '../src/renderer/freecamera.js'

/**
 * 自由相机的**数学**。
 *
 * 断言的是四件用户能感觉到的性质：
 * 1. WASD 像 Minecraft 一样相对相机的**水平朝向**走，俯仰不会改变高度；
 * 2. 转头是**原地**的（位置一动不动）——这正是"像 Minecraft 那样转头"与
 *    "建筑像个托盘一样自转"的全部差别；
 * 3. **拖动的方向感**：画面跟着手走（这条对着投影结果断言，见下面的用例）；
 * 4. 仰角能抬头（负值）但不会翻过极点，视场角有上下限。
 */

const cameraAt = (azimuth: number, elevation: number) => {
  const camera = createFreeCamera({ azimuth, elevation, fov: 70 })
  place(camera, [0, 0, 10])
  return camera
}

/** 把一个世界点投影到屏幕上（用当前的自由相机）——方向感只能这么验。 */
const screenOf = (camera: ReturnType<typeof createFreeCamera>, point: Vec3) => {
  const eye = camera.eye!
  const spec: CameraSpec = {
    azimuth: camera.azimuth,
    elevation: camera.elevation,
    roll: camera.roll,
    scale: 0,
    width: 800,
    height: 600,
    target: { x: 0, y: 0, z: 0 },
    perspective: { eye: { x: eye[0], y: eye[1], z: eye[2] }, fov: camera.fov },
  }
  const basis = basisFromAngles(camera.azimuth, camera.elevation, camera.roll)
  return projectPoint({ x: point[0], y: point[1], z: point[2] }, spec, basis)
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

  it('**W 沿水平朝向走**：抬头按 W 仍贴着水平面前进', () => {
    const camera = cameraAt(0, -30)
    const [fx, fy, fz] = groundForwardOf(camera)
    expect(fy).toBe(0)
    const before = [...camera.eye!]
    moveStep(camera, new Set(['w']), 1, 2)
    const after = camera.eye!
    // 位移与视线同向，长度 = 速度 × 时间
    for (const [index, component] of [fx, fy, fz].entries()) {
      expect(after[index]! - before[index]!).toBeCloseTo(component * 2, 6)
    }
    expect(after[1]).toBe(before[1])
  })

  it('**A/D 是水平横移**：不管仰角多大，都不会把人带飞', () => {
    const camera = cameraAt(0, 60)
    expect(rightOf(camera)[1]).toBe(0)
    const before = [...camera.eye!]
    moveStep(camera, new Set(['d']), 1, 3)
    expect(camera.eye![1]).toBeCloseTo(before[1]!, 9)
    expect(camera.eye![0]).toBeCloseTo(before[0]! + 3, 6)
  })

  /**
   * **空格上升 / Shift 下降**。
   *
   * 两条性质缺一不可：只沿世界 Y（抬头按空格也是直着上去，不是斜着飞），
   * 且水平位置一动不动。所以这里特意把相机设成大幅度抬头。
   */
  it('**空格上升 / Shift 下降**：沿世界 Y 直上直下，不跟视线俯仰走', () => {
    const camera = cameraAt(30, -60) // 抬着头，且不是正对着某个轴
    const [fx, fy, fz] = forwardOf(camera)
    // 视线确实斜着：水平分量不为零，垂直分量也不为 1
    expect(Math.hypot(fx, fz)).toBeGreaterThan(0.3)
    expect(fy).toBeGreaterThan(0.3)
    const eye = camera.eye!
    const before: Vec3 = [eye[0], eye[1], eye[2]]

    const up = moveStep(camera, new Set([' ']), 1, 2)
    expect(up.vertical).toBe(2)
    expect(camera.eye![1]).toBeCloseTo(before[1] + 2, 6)
    expect(camera.eye![0]).toBeCloseTo(before[0], 9)
    expect(camera.eye![2]).toBeCloseTo(before[2], 9)

    const down = moveStep(camera, new Set(['shift']), 1, 2)
    expect(down.vertical).toBe(-2)
    expect(camera.eye).toEqual(before)
  })

  it('空格和 Shift 同时按住互相抵消（升降是同一个轴）', () => {
    const camera = cameraAt(20, 20)
    const before = [...camera.eye!]
    moveStep(camera, new Set([' ', 'shift']), 1, 5)
    expect(camera.eye).toEqual(before)
  })

  it('升降与水平前后可以叠加（空格 + W 是斜着往前上）', () => {
    const camera = cameraAt(0, 0) // 平视：W 只往前走
    const eye = camera.eye!
    const before: Vec3 = [eye[0], eye[1], eye[2]]
    moveStep(camera, new Set(['w', ' ']), 1, 4)
    expect(camera.eye![1]).toBeCloseTo(before[1] + 4, 6) // 空格给的垂直量
    expect(camera.eye![2]).toBeCloseTo(before[2] - 4, 6) // W 给的水平量
  })

  it('相机没落地时升降也是空操作', () => {
    const camera = createFreeCamera({ azimuth: 0, elevation: 0, fov: 70 })
    moveStep(camera, new Set([' ']), 1, 5)
    expect(camera.eye).toBeUndefined()
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
    expect(camera.azimuth).toBeCloseTo(90, 9)
    expect(camera.eye).toEqual(before) // **位置不变**
    // 转了 90°：原本看向 -Z，现在看向 -X（往右拖 = 相机往左转，见下一个用例）
    const forward = forwardOf(camera)
    expect(forward[0]).toBeCloseTo(-1, 6)
    expect(forward[2]).toBeCloseTo(0, 6)
  })

  it('**右键自由观察是 Minecraft 方向**：鼠标右移向右看，下移低头', () => {
    const camera = cameraAt(0, 0)
    const before = [...camera.eye!]
    look(camera, 20, 10, 1)
    expect(camera.azimuth).toBe(-20)
    expect(camera.elevation).toBe(8)
    expect(camera.eye).toEqual(before)
  })

  it('**左键环绕**：观察中心与观察距离不变，相机位置随角度移动', () => {
    const camera = cameraAt(0, 0)
    const pivot: Vec3 = [0, 0, 0]
    const before = [...camera.eye!]
    orbit(camera, pivot, 90, 0, 1)
    expect(camera.eye).not.toEqual(before)
    expect(Math.hypot(...camera.eye!)).toBeCloseTo(10, 6)
    expect(lookAtFrom(camera, 10)).toEqual([
      expect.closeTo(0, 6),
      expect.closeTo(0, 6),
      expect.closeTo(0, 6),
    ])
  })

  it('**中键平移**：相机和观察中心同量移动，角度与距离不变', () => {
    const camera = cameraAt(0, 0)
    const beforeEye = [...camera.eye!] as Vec3
    const beforeAngles = [camera.azimuth, camera.elevation]
    const pivot = track(camera, [0, 0, 0], 40, -20, 600)
    const eyeDelta = camera.eye!.map((value, index) => value - beforeEye[index]!)
    expect(pivot).toEqual([
      expect.closeTo(eyeDelta[0]!, 9),
      expect.closeTo(eyeDelta[1]!, 9),
      expect.closeTo(eyeDelta[2]!, 9),
    ])
    expect([camera.azimuth, camera.elevation]).toEqual(beforeAngles)
    expect(Math.hypot(
      camera.eye![0] - pivot[0],
      camera.eye![1] - pivot[1],
      camera.eye![2] - pivot[2],
    )).toBeCloseTo(10, 6)
  })

  /**
   * **拖动的方向感**：手往哪边走，画面里的东西就往哪边走。
   *
   * 这条必须对着**投影结果**断言，不能只对角度符号断言。同样的"往右拖 = 方位角减小"，
   * 在"绕画面中心转"的旧相机上会让建筑跟着手往右走，换成"原地转头 + 透视"之后就成了反的
   * （用户的原话："拖动视角反了"）。角度符号只是实现细节，屏幕上往哪边挪才是手感，
   * 所以这里真的把世界点投影出来比对——换任何一台相机，方向错了这条就红。
   */
  it('**画面跟着手走**：往右拖，右边的东西往右移；往下拖，上面的东西往下移', () => {
    const sideways = cameraAt(0, 0)
    const right: Vec3 = [5, 0, 0] // 相机右方 5 格
    const beforeX = screenOf(sideways, right).x
    turn(sideways, 20, 0, 1) // 往右拖 20 px
    expect(screenOf(sideways, right).x).toBeGreaterThan(beforeX)

    const updown = cameraAt(0, 0)
    const above: Vec3 = [0, 5, 0] // 相机上方 5 格
    const beforeY = screenOf(updown, above).y
    turn(updown, 0, 20, 1) // 往下拖 20 px
    expect(screenOf(updown, above).y).toBeGreaterThan(beforeY)
  })

  it('方位角只保留一轮：一直往一个方向拖不会攒到 500°', () => {
    const camera = cameraAt(0, 0)
    turn(camera, 400, 0, 1) // 往右拖 400 px
    expect(camera.azimuth).toBeGreaterThanOrEqual(-180)
    expect(camera.azimuth).toBeLessThanOrEqual(180)
    expect(camera.azimuth).toBeCloseTo(40, 9) // 400° 折回 40°
  })

  /**
   * **拖动灵敏度**。三件事一起钉住：归一化还在（窗口越矮 °/px 越大，但不超过下限）、
   * 有下限（再矮也不继续变慢）、以及**总体上比"一屏转一圈"慢**——最后这条正是
   * "把灵敏度调低一点"的可检验定义，改回去就会红。
   */
  it('拖动灵敏度：按视口高度归一，但拖满一屏转不满一圈', () => {
    // 归一化 + 手感系数
    expect(dragUnitFor(800)).toBeCloseTo((360 / 800) * DRAG_SENSITIVITY, 9)
    expect(dragUnitFor(400)).toBeGreaterThan(dragUnitFor(800))
    // 320 px 是下限：更矮的视口不再变慢
    expect(dragUnitFor(320)).toBeCloseTo((360 / 320) * DRAG_SENSITIVITY, 9)
    expect(dragUnitFor(200)).toBe(dragUnitFor(320))
    // **比"拖满一整条视口高度 = 360°"更慢**
    expect(DRAG_SENSITIVITY).toBeLessThan(1)
    expect(dragUnitFor(800) * 800).toBeLessThan(360)
    expect(dragUnitFor(800) * 800).toBeCloseTo(360 * DRAG_SENSITIVITY, 6)
  })

  it('仰角夹在 ±89：拖到底也翻不过极点', () => {
    const camera = cameraAt(0, 0)
    turn(camera, 0, 10_000, 1) // 往下拖到底 = 抬头到极限
    expect(camera.elevation).toBe(-89)
    turn(camera, 0, -10_000, 1)
    expect(camera.elevation).toBe(89)
  })

  it('显式光学变焦会改变 FOV，且夹在范围内', () => {
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

  it('**滚轮拉近/拉远**：改变观察距离但保持 FOV 与锚点不变', () => {
    const camera = cameraAt(0, 0)
    const pivot: Vec3 = [0, 0, 0]
    const fov = camera.fov
    dolly(camera, pivot, -100)
    const near = Math.hypot(...camera.eye!)
    expect(near).toBeLessThan(10)
    expect(camera.fov).toBe(fov)
    expect(lookAtFrom(camera, near)).toEqual([
      expect.closeTo(0, 6),
      expect.closeTo(0, 6),
      expect.closeTo(0, 6),
    ])
    dolly(camera, pivot, 100)
    expect(Math.hypot(...camera.eye!)).toBeCloseTo(10, 6)
    expect(camera.fov).toBe(fov)
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
