import type { Bounds } from '@architect/core'

export interface Vec3 {
  x: number
  y: number
  z: number
}

export interface CameraSpec {
  /** 注视点（世界坐标）。 */
  target: Vec3
  /** 水平角（度）。0 = 从 +Z 朝 -Z 看（正北方向看过去）。 */
  azimuth: number
  /** 仰角（度）。90 = 正俯视，0 = 水平。 */
  elevation: number
  /**
   * 绕视线轴的滚转（度）。默认 0。
   *
   * 只有"地平线必须是平的"这一条预设之外才需要它：`azimuth` + `elevation` 已经
   * 覆盖了所有**不倾斜**的朝向，滚转是第三个自由度。建筑评审里基本不用，
   * 但"相机朝向完全由我指定"这件事少了它就不完整。
   */
  roll?: number
  /** 每格多少像素。 */
  scale: number
  width: number
  height: number
}

/** 相机的正交基。`forward` 是**从相机指向场景**的方向。 */
export interface CameraBasis {
  right: Vec3
  up: Vec3
  forward: Vec3
}

export const DEG = Math.PI / 180

/**
 * 由角度导出正交基。
 *
 * 相机位于 `target + dist * dir`，其中 `dir = (sin(az)cos(el), sin(el), cos(az)cos(el))`。
 * 于是 `az = 0, el = 0` 时相机在 +Z 看向 -Z，`el = 90` 时在正上方俯视。
 */
export function cameraBasis(spec: CameraSpec): CameraBasis {
  const az = spec.azimuth * DEG
  const el = spec.elevation * DEG
  const cosA = Math.cos(az)
  const sinA = Math.sin(az)
  const cosE = Math.cos(el)
  const sinE = Math.sin(el)

  const forward: Vec3 = { x: -sinA * cosE, y: -sinE, z: -cosA * cosE }
  const right = { x: cosA, y: 0, z: -sinA }
  const up = { x: -sinA * sinE, y: cosE, z: -cosA * sinE }
  const roll = spec.roll ?? 0
  if (roll === 0) return { right, up, forward }
  // 绕视线轴转 right/up（forward 不变）。这是"相机侧倾"，不是"场景旋转"——
  // 两者在正交投影下等价，但写成转基向量才能和 projectPoint 对上。
  const r = roll * DEG
  const cosR = Math.cos(r)
  const sinR = Math.sin(r)
  return {
    forward,
    right: {
      x: right.x * cosR + up.x * sinR,
      y: right.y * cosR + up.y * sinR,
      z: right.z * cosR + up.z * sinR,
    },
    up: {
      x: up.x * cosR - right.x * sinR,
      y: up.y * cosR - right.y * sinR,
      z: up.z * cosR - right.z * sinR,
    },
  }
}

/**
 * **由相机位置与注视点求朝向**（`eye` + `lookAt`）。
 *
 * 正交投影下相机的**距离不影响成像**——只有方向与注视点算数。所以这个函数把
 * "把相机放在 (a,b,c) 看向 (d,e,f)" 翻译成 `azimuth` / `elevation` / `target`，
 * 距离被有意丢掉。文档与工具描述里必须写清这一点，否则用户会以为"放远了会变小"。
 *
 * `up === forward` 时（垂直俯视）叉乘退化为零向量，此时按"正上方看下去"的
 * 约定取 up = (0,0,-1)，与 `elevation: 90` 的行为一致。
 */
export function orientationFromEye(
  eye: Vec3,
  lookAt: Vec3,
  roll = 0,
): { azimuth: number; elevation: number; roll: number } {
  const dx = lookAt.x - eye.x
  const dy = lookAt.y - eye.y
  const dz = lookAt.z - eye.z
  const horizontal = Math.hypot(dx, dz)
  if (horizontal < 1e-9 && Math.abs(dy) < 1e-9) {
    throw new RangeError('相机位置与注视点重合，朝向无法确定')
  }
  // cameraBasis 里 forward = (-sinA·cosE, -sinE, -cosA·cosE)，反解：
  const length = Math.hypot(dx, dy, dz)
  const fx = dx / length
  const fy = dy / length
  const fz = dz / length
  const elevation = Math.asin(Math.min(1, Math.max(-1, -fy))) / DEG
  const azimuth = Math.atan2(-fx, -fz) / DEG
  return { azimuth, elevation, roll }
}

/** 由角度与注视点求"相机在哪"。只用于回报与显示——正交投影下它不参与成像。 */
export function eyeFromOrientation(camera: CameraSpec, distance: number): Vec3 {
  const az = camera.azimuth * DEG
  const el = camera.elevation * DEG
  return {
    x: camera.target.x + distance * Math.sin(az) * Math.cos(el),
    y: camera.target.y + distance * Math.sin(el),
    z: camera.target.z + distance * Math.cos(az) * Math.cos(el),
  }
}
export interface ProjectedPoint {
  /** 屏幕坐标（像素，原点在左上角）。 */
  x: number
  y: number
  /** 越大离相机越远。 */
  depth: number
}

export function projectPoint(
  point: Vec3,
  spec: CameraSpec,
  basis: CameraBasis,
): ProjectedPoint {
  const dx = point.x - spec.target.x
  const dy = point.y - spec.target.y
  const dz = point.z - spec.target.z
  const sx = dx * basis.right.x + dy * basis.right.y + dz * basis.right.z
  const sy = dx * basis.up.x + dy * basis.up.y + dz * basis.up.z
  const depth = dx * basis.forward.x + dy * basis.forward.y + dz * basis.forward.z
  return {
    x: spec.width / 2 + sx * spec.scale,
    y: spec.height / 2 - sy * spec.scale,
    depth,
  }
}

/**
 * 一次截图请求里与相机有关的那部分。
 *
 * 刻意**不**引用 `@architect/tools` 的 `ScreenshotRequest`：相机怎么算属于渲染层，
 * 工具层只负责把参数递过来。这样 `AgentSession`、测试替身、桌面视口共用同一份规则，
 * 不会各自实现一遍然后悄悄漂移。
 */
export interface ShotCameraRequest {
  /** 预设机位名。给了 `azimuth`/`elevation`/`eye` 时只作为回退。 */
  view: string
  width: number
  height: number
  /** 自由机位：水平角（度）。 */
  azimuth?: number
  /** 自由机位：仰角（度），会被夹到 1..89。 */
  elevation?: number
  /**
   * **相机位置**（世界坐标）。给 `eye` + `lookAt` 就是"把相机放在这里看向那里"。
   *
   * ⚠️ 正交投影下**距离不影响成像**，只有方向算数——`eye` 与 `lookAt` 之间
   * 只取方向，`lookAt` 成为画面中心。想让建筑变小要改 `scale`，不是把相机放远。
   */
  eye?: readonly number[]
  /** 注视点（世界坐标）。既做朝向的目标，也做画面中心。 */
  lookAt?: readonly number[]
  /** 绕视线轴的滚转（度）。默认 0。 */
  roll?: number
  /** 每格像素。省略 = 自动取景。 */
  scale?: number
  /** 画面中心。省略 = 内容包围盒中心。`lookAt` 优先于它。 */
  target?: readonly number[]
}

/**
 * 预设机位或**自由机位** → 一个具体的相机。
 *
 * 两条规则值得单独说：
 *
 * 1. **给了角度就以角度为准**，`view` 退化成标签。9 个预设覆盖不了
 *    "这个屋檐从侧面挑得太远了吗"这类判断，模型必须能自己挑方向。
 * 2. **仰角夹在 1..89**。正好 90° 时相机的 up 向量与视线共线（退化），
 *    画面会缩成一条线——那不是"视角不对"，是"什么都没画出来"。
 */
export function cameraForShot(bounds: Bounds, request: ShotCameraRequest): CameraSpec {
  const eye = vec(request.eye)
  const lookAt = vec(request.lookAt)
  // 注视点：`lookAt`（自由相机给的）优先于 `target`（画面中心），都没有就用内容中心
  const target = lookAt ?? vec(request.target)

  let angles = presetAngles(request.view as ViewPreset)
  let roll = request.roll ?? 0
  if (eye !== undefined && lookAt !== undefined) {
    // "把相机放在 eye 看向 lookAt" —— 由这两个点反解朝向，距离被丢掉
    const oriented = orientationFromEye(eye, lookAt, roll)
    angles = { azimuth: oriented.azimuth, elevation: oriented.elevation }
    roll = oriented.roll
  } else if (request.azimuth !== undefined || request.elevation !== undefined) {
    angles = {
      azimuth: request.azimuth ?? angles.azimuth,
      elevation: Math.min(89, Math.max(1, request.elevation ?? angles.elevation)),
    }
  }
  // 注意：`eye` 单独给（没有 lookAt）时无意义——方向要两个点才能定。忽略它。
  const fitted = fitCamera(bounds, angles, request.width, request.height)
  return {
    ...fitted,
    roll,
    ...(target !== undefined ? { target } : {}),
    ...(request.scale !== undefined ? { scale: request.scale } : {}),
  }
}

/** `[x,y,z]` → `Vec3`。长度不足 3 或含非有限值时返回 undefined（当成"没给"）。 */
function vec(value: readonly number[] | undefined): Vec3 | undefined {
  if (value === undefined || value.length < 3) return undefined
  const [x, y, z] = [value[0]!, value[1]!, value[2]!]
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return undefined
  return { x, y, z }
}

/**
 * 截图的机位标签，写进对话档案。
 *
 * 自由机位拼成 `az45/el35`——只写 `view` 的话档案里所有自由机位都叫 `iso_ne`，
 * 事后回看分不清那张图是从哪个角度拍的。
 *
 * 注视点单独给了而且不是内容中心时，也拼进去（`az45/el35→(8,5,8)`）：
 * **同一组角度、不同注视点是两张不同的图**（"盯着檐口看"和"看整栋楼"），
 * 只写角度的标签会让档案里这两张图长得一模一样。
 */
export function shotCameraLabel(request: ShotCameraRequest): string {
  if (request.eye !== undefined && request.lookAt !== undefined) {
    const eye = request.eye.map((v) => Math.round(v)).join(',')
    const at = request.lookAt.map((v) => Math.round(v)).join(',')
    return `eye(${eye})→(${at})`
  }
  if (request.azimuth === undefined && request.elevation === undefined) return request.view
  const roll = request.roll !== undefined && request.roll !== 0 ? `/rl${Math.round(request.roll)}` : ''
  const lookAt = request.lookAt ?? request.target
  const at = lookAt !== undefined ? `→(${lookAt.map((v) => Math.round(v)).join(',')})` : ''
  return `az${Math.round(request.azimuth ?? 0)}/el${Math.round(Math.min(89, Math.max(1, request.elevation ?? 0)))}${roll}${at}`
}

export type ViewPreset =
  | 'iso_ne'
  | 'iso_nw'
  | 'iso_se'
  | 'iso_sw'
  | 'front'
  | 'back'
  | 'left'
  | 'right'
  | 'top'
  | 'bottom'

/** plan §7.2 的标准机位表。 */
export const VIEW_PRESETS: Record<ViewPreset, { azimuth: number; elevation: number }> = {
  iso_ne: { azimuth: 45, elevation: 30 },
  iso_nw: { azimuth: -45, elevation: 30 },
  iso_se: { azimuth: 135, elevation: 30 },
  iso_sw: { azimuth: -135, elevation: 30 },
  front: { azimuth: 0, elevation: 0 },
  back: { azimuth: 180, elevation: 0 },
  left: { azimuth: 90, elevation: 0 },
  right: { azimuth: -90, elevation: 0 },
  top: { azimuth: 0, elevation: 90 },
  bottom: { azimuth: 0, elevation: -90 },
}

export function presetAngles(preset: ViewPreset): { azimuth: number; elevation: number } {
  const angles = VIEW_PRESETS[preset]
  if (angles === undefined) throw new RangeError(`未知机位预设 "${preset}"`)
  return angles
}

/**
 * 自动取景：把包围盒塞进画面。
 *
 * 先以 `scale = 1` 投影 8 个角点量出屏幕跨度，再据此求缩放。
 * 用角点而不是包围盒投影是因为**斜视角下包围盒的投影不是包围盒**。
 */
export function fitCamera(
  bounds: Bounds,
  angles: { azimuth: number; elevation: number },
  width: number,
  height: number,
  margin = 0.08,
): CameraSpec {
  const target: Vec3 = {
    x: (bounds.min.x + bounds.max.x + 1) / 2,
    y: (bounds.min.y + bounds.max.y + 1) / 2,
    z: (bounds.min.z + bounds.max.z + 1) / 2,
  }
  const probe: CameraSpec = { target, ...angles, scale: 1, width, height }
  const basis = cameraBasis(probe)

  let minX = Number.POSITIVE_INFINITY
  let maxX = Number.NEGATIVE_INFINITY
  let minY = Number.POSITIVE_INFINITY
  let maxY = Number.NEGATIVE_INFINITY
  for (let i = 0; i < 8; i++) {
    const corner: Vec3 = {
      x: (i & 1) === 0 ? bounds.min.x : bounds.max.x + 1,
      y: (i & 2) === 0 ? bounds.min.y : bounds.max.y + 1,
      z: (i & 4) === 0 ? bounds.min.z : bounds.max.z + 1,
    }
    const p = projectPoint(corner, probe, basis)
    if (p.x < minX) minX = p.x
    if (p.x > maxX) maxX = p.x
    if (p.y < minY) minY = p.y
    if (p.y > maxY) maxY = p.y
  }

  const spanX = Math.max(1e-6, maxX - minX)
  const spanY = Math.max(1e-6, maxY - minY)
  // 留出 margin 的边距，并夹在合理区间（margin 过大会退化成看不清的缩略图）
  const usable = Math.min(1, Math.max(0.1, 1 - margin * 2))
  const scale = Math.min((width * usable) / spanX, (height * usable) / spanY)

  return { target, ...angles, scale, width, height }
}
