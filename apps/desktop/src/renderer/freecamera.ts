/**
 * **自由相机**：一台真的"站在世界里"的相机——位置是一个真实的点，角度是它自己的朝向。
 *
 * ## 为什么不能只有角度
 *
 * 原来那台相机只有 `azimuth` / `elevation` + 一个"注视点"，拖动改角度、注视点不动，
 * 于是画面**永远绕着那个点转**：建筑在屏幕正中自转，用户没法"站在原地转头"，
 * 也没法走过去看某个檐口。正交投影下这件事尤其明显——因为成像只取决于
 * "视线方向 + 画面正中是哪一点"，注视点不动 = 那个点被钉死在屏幕中央。
 *
 * 这里把两者都变成**推导出来的量**：
 *
 * ```text
 *   位置 eye ──forward──▶ 画面中心 anchor = eye + focus · forward
 * ```
 *
 * - **原地转头**：只改角度，`eye` 不动 → `anchor` 转到新视线上。画面会平移，
 *   这正是"像游戏里一样相对相机自己转"与"绕着目标转"的全部差别。
 * - **WASD**：`eye` 沿自己的轴平移 → 画面整体跟着平推。
 * - `focus` 是"画面中心离相机多远"：正交投影下它**不参与成像**（沿视线挪动画面不变），
 *   只决定那个点落在哪儿（拾取的射线起点、推给模型的 `lookAt` 都读它）。
 *   所以它可以是个任意常数，不需要"真实"。
 *
 * 这一层刻意**只做数学、不碰 DOM**：`main.ts` 把键盘/鼠标事件翻译成这里的调用，
 * 于是"转头时位置不动""W 沿视线走（含俯仰）""A/D 是水平横移"这些性质能在 Node 里直接断言。
 */

import { basisFromAngles, clampFreeElevation } from '@architect/render/browser'

export type Vec3 = [number, number, number]

export interface FreeCamera {
  /** 水平角（度）。0 = 从 +Z 看向 -Z。 */
  azimuth: number
  /** 仰角（度）。负值 = 抬头。 */
  elevation: number
  /** 绕视线轴的滚转（度）。 */
  roll: number
  /** 每格像素。0 或负数 = 自动取景。 */
  scale: number
  /**
   * 相机位置。`undefined` = **还没落地**：此时画面中心是"内容中心"，
   * 相机只是"浮在内容外面那个方向"，由自动取景决定（预设机位、刚打开工程都是这个状态）。
   * 第一次转头或平移时会由 `materialize()` 落到一个具体的位置上。
   */
  eye?: Vec3
  /** `eye` 落地时定下的"画面中心距离"。换机位/复位时会重新定。 */
  focus: number
  /**
   * 显式的画面中心（机位面板"按坐标"那一栏填的注视点）。
   *
   * 一般情况下画面中心由 `eye` + `forward` 算（`anchorOf`），但用户明确指定了注视点时
   * 就以它为准——那正是"相机放这儿、盯着那儿看"。转头时它会被清掉（否则画面中心
   * 又被钉住了，"原地转头"立刻退化成绕点旋转）。
   */
  target?: Vec3
}

export function createFreeCamera(options: {
  azimuth: number
  elevation: number
  focus: number
}): FreeCamera {
  return {
    azimuth: options.azimuth,
    elevation: clampFreeElevation(options.elevation),
    roll: 0,
    scale: 0,
    focus: options.focus,
  }
}

/** 视线方向（含俯仰，单位向量）。 */
export function forwardOf(camera: FreeCamera): Vec3 {
  const { forward } = basisFromAngles(camera.azimuth, clampFreeElevation(camera.elevation), 0)
  return [forward.x, forward.y, forward.z]
}

/** 相机右方（**总是水平的**：`right` 与仰角无关，所以横移不会把人带飞）。 */
export function rightOf(camera: FreeCamera): Vec3 {
  const { right } = basisFromAngles(camera.azimuth, clampFreeElevation(camera.elevation), 0)
  return [right.x, right.y, right.z]
}

/** 画面中心。`undefined` = 交给渲染层按内容自动取景（见 `FreeCamera.eye`）。 */
export function anchorOf(camera: FreeCamera): Vec3 | undefined {
  if (camera.target !== undefined) return [...camera.target]
  if (camera.eye === undefined) return undefined
  const forward = forwardOf(camera)
  return [
    camera.eye[0] + forward[0] * camera.focus,
    camera.eye[1] + forward[1] * camera.focus,
    camera.eye[2] + forward[2] * camera.focus,
  ]
}

/**
 * 把相机**落到一个具体位置上**——位置取"从画面中心沿视线后退 `focus`"。
 *
 * 正交投影下这一步不改画面（画面中心还是那个点），改的是"我站在哪儿"：
 * 落点之后转头，世界就会绕**这个位置**摆，而不是绕画面中心转。
 *
 * `anchor` 是当前的画面中心（`anchorOf` 为 `undefined` 时由调用方给内容中心）。
 */
export function materialize(camera: FreeCamera, anchor: Vec3): void {
  const forward = forwardOf(camera)
  camera.eye = [
    anchor[0] - forward[0] * camera.focus,
    anchor[1] - forward[1] * camera.focus,
    anchor[2] - forward[2] * camera.focus,
  ]
  // 位置已经落地，画面中心从此由它推导
  delete camera.target
}

/**
 * **原地转头**：`dx` / `dy` 是鼠标位移（像素），`unit` 是"每像素多少度"。
 *
 * 和拖动一样的方向感：往右拖 = 画面往右转，往下拖 = 从上往下看。
 * 仰角夹在 `±FREE_ELEVATION_LIMIT`——正好 90° 时 up 与视线共线，画面会缩成一条线。
 */
export function turn(camera: FreeCamera, dx: number, dy: number, unit: number): void {
  camera.azimuth -= dx * unit
  camera.elevation = clampFreeElevation(camera.elevation + dy * unit * 0.8)
}

/**
 * 沿相机自己的轴平移。
 *
 * - `forward` 走**完整的三维视线**（抬头按 W 就上升）——这是游戏的飞行动作，
 *   也让"想看屋顶"不需要另一组按键；
 * - `strafe` 走 `right`（水平的），所以横移永远不会把你带偏高度。
 */
export function pan(camera: FreeCamera, forward: number, strafe: number): void {
  if (camera.eye === undefined) return
  const f = forwardOf(camera)
  const r = rightOf(camera)
  camera.eye = [
    camera.eye[0] + f[0] * forward + r[0] * strafe,
    camera.eye[1] + f[1] * forward + r[1] * strafe,
    camera.eye[2] + f[2] * forward + r[2] * strafe,
  ]
  delete camera.target
}

/**
 * 一帧里按住了哪些移动键，走多远。
 *
 * `speed` 是**每秒多少格**。方向取自相机自己：W/S 前后（含俯仰），A/D 左右。
 * 同时按住相反的方向会互相抵消——不必特判，算式本来就那样。
 */
export function moveStep(
  camera: FreeCamera,
  keys: ReadonlySet<string>,
  dt: number,
  speed: number,
): { forward: number; strafe: number } {
  const axis = (positive: string, negative: string): number =>
    (keys.has(positive) ? 1 : 0) - (keys.has(negative) ? 1 : 0)
  const forward = axis('w', 's') * speed * dt
  // A/D 是"往左/往右"，而 `right` 指向相机的右方，所以 A 取负
  const strafe = axis('d', 'a') * speed * dt
  pan(camera, forward, strafe)
  return { forward, strafe }
}
