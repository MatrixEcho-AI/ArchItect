/**
 * **第一人称自由相机**：位置是真的，朝向是自己的，投影是透视的。
 *
 * ## 为什么不能只有角度
 *
 * 原来那台相机只有 `azimuth` / `elevation` + 一个"注视点"，拖动改角度、注视点不动，
 * 于是画面**永远绕着那个点转**：建筑在屏幕正中自转。用户的原话是"不要相对目标点旋转，
 * 要相对相机旋转"——一台真正的相机要有**位置**：`WASD` 平移它，拖动只转它的头。
 *
 * ```text
 *   位置 eye ──forward──▶ 看到的世界
 * ```
 *
 * - **原地转头**：只改角度，`eye` 不动 → 世界从眼前扫过（而不是建筑原地自转）；
 * - **WASD**：`eye` 沿自己的轴平移 → 画面整体跟着平推；
 * - **空格 / Shift**：沿**世界 +Y** 升降（电梯，不跟视线俯仰走，见 `lift()`）；
 * - **滚轮**：改视场角（`fov`）= 变焦，人不动。
 *
 * ## 为什么这一层不碰渲染
 *
 * 这一层只做**数学**：`main.ts` 把键盘/鼠标事件翻译成这里的调用。于是
 * "转头不挪位置""W 沿视线走（含俯仰）""A/D 是水平横移"这些性质能在 Node 里直接断言，
 * 不用起 Electron。投影本身在 `@architect/render`（`CameraSpec.perspective`）。
 */

import { basisFromAngles, clampFreeElevation } from '@architect/render/browser'

export type Vec3 = [number, number, number]

export interface FreeCamera {
  /**
   * 相机位置（世界坐标）。`undefined` = **还没落地**：由自动取景决定（站在能把内容
   * 框进画面的地方）。第一次转头或平移时 `place()` 把它定下来，之后就只受 WASD 影响。
   */
  eye?: Vec3
  /** 水平角（度）。0 = 从 +Z 看向 -Z。 */
  azimuth: number
  /** 仰角（度）。负值 = 抬头。 */
  elevation: number
  /** 绕视线轴的滚转（度）。 */
  roll: number
  /** 垂直视场角（度）。滚轮改它 = 变焦。 */
  fov: number
}

/** 视场角的可取范围。再小就成了望远镜，再大边缘会拉得没法看。 */
export const FOV_RANGE = { min: 25, max: 110 } as const

export function createFreeCamera(options: {
  azimuth: number
  elevation: number
  fov: number
}): FreeCamera {
  return {
    azimuth: options.azimuth,
    elevation: clampFreeElevation(options.elevation),
    roll: 0,
    fov: options.fov,
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

/** 从相机位置沿视线前 `distance` 的那个点——推给模型当 `lookAt` 用的就是它。 */
export function lookAtFrom(camera: FreeCamera, distance: number): Vec3 {
  const eye = camera.eye
  if (eye === undefined) return [0, 0, 0]
  const f = forwardOf(camera)
  return [eye[0] + f[0] * distance, eye[1] + f[1] * distance, eye[2] + f[2] * distance]
}

/** 把相机**落到一个具体位置上**（自动取景算出来的那个点，或者用户在面板里填的）。 */
export function place(camera: FreeCamera, eye: Vec3): void {
  camera.eye = [eye[0], eye[1], eye[2]]
}

/**
 * **拖动灵敏度**：整体手感系数，`1` = "拖满一整条视口高度正好转一圈"。
 *
 * 小于 1 就是"比一屏一圈更慢"。用户反馈原来的拖动稍微太灵敏（一次小幅度拖动
 * 就把画面甩过头），所以这里取 0.75：拖满一屏约转 270°。
 *
 * 它和"按视口高度归一"是两件事，都得有：归一保证**换窗口大小手感不变**，
 * 这个系数管**整体快慢**。少掉任何一个都会在某个尺寸下变得不可用。
 */
export const DRAG_SENSITIVITY = 0.75

/**
 * 一次拖动里每像素转多少度。
 *
 * `360 / 视口高度` 是归一化——固定 °/px 在窄窗口里会转得飞快，因为同样的手部
 * 位移占了更大比例的视野。`320` 是下限：再矮的视口也不要转得更慢（那种窗口里
 * 本来就没多少画面，转不动更难受）。再乘手感系数，见 `DRAG_SENSITIVITY`。
 */
export function dragUnitFor(viewportHeight: number): number {
  return (360 / Math.max(320, viewportHeight)) * DRAG_SENSITIVITY
}

/**
 * **原地转头**：`dx` / `dy` 是鼠标位移（像素），`unit` 是"每像素多少度"
 * （`main.ts` 用 `dragUnitFor()` 算它）。
 *
 * 方向是**画面跟着手走**（抓着世界拖）：往右拖 → 眼前的东西整体往右移 →
 * 相机**左**转；往下拖 → 东西整体往下移 → 相机**抬**头。为此 `azimuth` 要加、`elevation` 要减。
 *
 * 这一点踩过坑：换成透视 + 真实位置之前，相机是绕着画面中心转的，
 * 同样"往右拖 = 方位角减小"却让建筑**跟着手往右走**（近角在屏幕上右移）。
 * 于是枢轴一换，手势的方向感整个反了——用户的原话是"拖动视角反了"。
 * 现在两件事绑在一起：**`azimuth`/`elevation` 的符号按屏幕上的实际位移定**，
 * 谁改投影都不用再回来猜方向（`test/freecamera.test.ts` 里对着投影结果断言）。
 *
 * `eye` 一动不动——这正是"相对相机转"与"绕着目标转"的全部差别。
 * 仰角夹在 `±FREE_ELEVATION_LIMIT`：正好 90° 时 up 与视线共线，画面会退化。
 */
export function turn(camera: FreeCamera, dx: number, dy: number, unit: number): void {
  // 方位角**只保留一轮**（-180..180）：一直往一个方向拖不该攒到 500°，
  // 那既让面板上的数字没法读，也让"和预设机位比角度"这种事失去意义
  const azimuth = camera.azimuth + dx * unit
  camera.azimuth = ((((azimuth + 180) % 360) + 360) % 360) - 180
  camera.elevation = clampFreeElevation(camera.elevation - dy * unit * 0.8)
}

/** 滚轮：改视场角。指数变化，手感才均匀（和原来的缩放一致）。 */
export function zoom(camera: FreeCamera, deltaY: number): void {
  const fov = camera.fov * Math.exp(deltaY * 0.0015)
  camera.fov = Math.min(FOV_RANGE.max, Math.max(FOV_RANGE.min, fov))
}

/**
 * 沿相机自己的轴平移。
 *
 * - `forward` 走**完整的三维视线**（抬头按 W 就上升）——这是游戏的飞行动作，
 *   也让"想看屋顶"不需要另一组按键；
 * - `strafe` 走 `right`（水平的），所以横移永远不会把你带偏高度。
 */
export function pan(camera: FreeCamera, forward: number, strafe: number): void {
  const eye = camera.eye
  if (eye === undefined) return
  const f = forwardOf(camera)
  const r = rightOf(camera)
  camera.eye = [
    eye[0] + f[0] * forward + r[0] * strafe,
    eye[1] + f[1] * forward + r[1] * strafe,
    eye[2] + f[2] * forward + r[2] * strafe,
  ]
}

/**
 * 沿**世界 +Y** 升降（空格上升 / Shift 下降）。
 *
 * 为什么单独一个函数、而不是并进 `pan` 的 `forward`：
 *
 * - `W` 走的是**视线**，抬着头按 W 是斜着往上飞；空格要的是"垂直上电梯"。
 *   两者在抬头时不是一回事，混在一起就没法既保留飞行动作又有一个确定的升高量。
 * - 用**世界 Y**，不用相机的 `up`：`roll` 转过之后 up 是歪的，那时候按空格会斜着走。
 *
 * 相机还没落地时是空操作（和 `pan` 一致），调用方会在同一帧里 `place()` 它。
 */
export function lift(camera: FreeCamera, amount: number): void {
  const eye = camera.eye
  if (eye === undefined) return
  camera.eye = [eye[0], eye[1] + amount, eye[2]]
}

/**
 * 一帧里按住了哪些移动键，走多远。
 *
 * `speed` 是**每秒多少格**。方向取自相机自己：W/S 前后（含俯仰），A/D 左右横移
 * （水平），**空格上升 / Shift 下降**（沿世界 Y，见 `lift()`）。
 * 同时按住相反的方向会互相抵消——不必特判，算式本来就那样。
 * 相机还没落地时先不动（`pan` / `lift` 都是空操作），调用方会在同一帧里 `place()` 它。
 *
 * 键名是 `event.key.toLowerCase()` 那一套：空格是 `' '`，Shift 是 `'shift'`。
 */
export function moveStep(
  camera: FreeCamera,
  keys: ReadonlySet<string>,
  dt: number,
  speed: number,
): { forward: number; strafe: number; vertical: number } {
  const axis = (positive: string, negative: string): number =>
    (keys.has(positive) ? 1 : 0) - (keys.has(negative) ? 1 : 0)
  const forward = axis('w', 's') * speed * dt
  // A/D 是"往左/往右"，而 `right` 指向相机的右方，所以 A 取负
  const strafe = axis('d', 'a') * speed * dt
  const vertical = axis(' ', 'shift') * speed * dt
  pan(camera, forward, strafe)
  lift(camera, vertical)
  return { forward, strafe, vertical }
}
