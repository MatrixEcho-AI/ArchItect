import type { Bounds } from '@architect/core'

export interface Vec3 {
  x: number
  y: number
  z: number
}

export interface CameraSpec {
  /** 注视点（世界坐标）。正交投影的画面中心；透视投影下只用来定朝向（投影用 `perspective.eye`）。 */
  target: Vec3
  /** 水平角（度）。0 = 从 +Z 朝 -Z 看（正北方向看过去）。 */
  azimuth: number
  /**
   * 仰角（度）。90 = 正俯视，0 = 水平，**负值 = 抬头**。
   *
   * 模型那条路（`cameraForShot`）会把它夹到 1..89（它是"把建筑拍进画面"）；
   * 交互相机允许抬头，夹的范围是 `±FREE_ELEVATION_LIMIT`。
   */
  elevation: number
  /**
   * 绕视线轴的滚转（度）。默认 0。
   *
   * 只有"地平线必须是平的"这一条预设之外才需要它：`azimuth` + `elevation` 已经
   * 覆盖了所有**不倾斜**的朝向，滚转是第三个自由度。建筑评审里基本不用，
   * 但"相机朝向完全由我指定"这件事少了它就不完整。
   */
  roll?: number
  /** 每格多少像素。正交投影里是成像的唯一尺度；透视投影里退化成"注视点处的等效值"。 */
  scale: number
  width: number
  height: number
  /**
   * 给了它 = **透视投影**（第一人称：相机站在 `eye`，`fov` 是垂直视场角）；不给 = 正交投影。
   *
   * 两种投影**共用**角度语义、叠加层与拾取，所以同一份机位换个投影就是另一种画法。
   * 默认是正交：模型截图与 CLI 要的是"能比较的等轴测视图"（近大远小会让两张图
   * 因为站位不同而没法比），而**人看的视口**要的是"站在世界里看"。
   */
  perspective?: PerspectiveView
}

/** 透视投影的相机位置与视场角。 */
export interface PerspectiveView {
  /** 相机位置（世界坐标）。**透视投影下它是真的位置**，不像正交那样只是为了定方向。 */
  eye: Vec3
  /** 垂直视场角（度）。 */
  fov: number
}

/**
 * 近裁剪面。
 *
 * 透视投影里"在相机后面"的点会投影到画面另一侧（除以负数），不裁掉就会画出
 * 满屏乱飞的三角形。正交投影不需要它（没有除法）。
 */
export const PERSPECTIVE_NEAR = 0.1

/** 默认视场角（度）。70 是 Minecraft 的默认值，也是"看建筑"比较自然的视角。 */
export const DEFAULT_FOV = 70

/** 相机的正交基。`forward` 是**从相机指向场景**的方向。 */
export interface CameraBasis {
  right: Vec3
  up: Vec3
  forward: Vec3
}

export const DEG = Math.PI / 180

/**
 * 交互相机（"自由视角"）能接受的仰角。
 *
 * 模型那条路（`cameraForShot`）夹在 **1..89**：它是"把建筑拍进画面"，抬头没有意义。
 * 但**用户自己看的这台相机**要能抬头（负仰角）——像游戏里那样，"往上看屋檐"做不到的话，
 * 相机就只是个转盘。上界仍是 89：正好 90° 时 up 会退化成一条线。
 */
export const FREE_ELEVATION_LIMIT = 89

/** 把交互相机的仰角夹进 `±FREE_ELEVATION_LIMIT`。渲染、拾取、机位面板共用它。 */
export function clampFreeElevation(value: number): number {
  return Math.min(FREE_ELEVATION_LIMIT, Math.max(-FREE_ELEVATION_LIMIT, value))
}

/**
 * 由角度导出正交基。
 *
 * 相机位于 `target + dist * dir`，其中 `dir = (sin(az)cos(el), sin(el), cos(az)cos(el))`。
 * 于是 `az = 0, el = 0` 时相机在 +Z 看向 -Z，`el = 90` 时在正上方俯视。
 *
 * 交互相机（WASD 平移、原地转头）只有角度、没有一份完整的 `CameraSpec`，
 * 所以真正的计算放在 `basisFromAngles` 里，这里是它 + 一个 spec 的包装。
 */
export function cameraBasis(spec: CameraSpec): CameraBasis {
  return basisFromAngles(spec.azimuth, spec.elevation, spec.roll ?? 0)
}

/** 只由角度（与可选滚转）导出正交基。 */
export function basisFromAngles(azimuth: number, elevation: number, roll = 0): CameraBasis {
  const az = azimuth * DEG
  const el = elevation * DEG
  const cosA = Math.cos(az)
  const sinA = Math.sin(az)
  const cosE = Math.cos(el)
  const sinE = Math.sin(el)

  const forward: Vec3 = { x: -sinA * cosE, y: -sinE, z: -cosA * cosE }
  const right = { x: cosA, y: 0, z: -sinA }
  const up = { x: -sinA * sinE, y: cosE, z: -cosA * sinE }
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
    throw new RangeError('The camera position and the look-at point coincide, so the direction is undefined')
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
  /** 屏幕坐标（像素，原点在左上角）。在相机后面时是 `NaN`（透视投影）。 */
  x: number
  y: number
  /** 越大离相机越远。透视投影下**小于等于 0 = 在相机后面**，调用方要丢掉。 */
  depth: number
}

export function projectPoint(
  point: Vec3,
  spec: CameraSpec,
  basis: CameraBasis,
): ProjectedPoint {
  if (spec.perspective !== undefined) return projectPerspective(point, spec, basis, spec.perspective)
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
 * 透视投影：先量出点相对相机的三个分量（右 / 上 / 前），再除以**深度**。
 *
 * 焦距取自垂直视场角：`focal = (height/2) / tan(fov/2)` —— 于是 `fov` 就是
 * "画面高度对应多少度"，宽高比由 `width/height` 自然带出来（横向 fov 随之变化）。
 *
 * **在相机后面（`forward <= 0`）交回 `NaN`**：那种点除以负数会翻到画面另一侧，
 * 画出来是满屏乱飞的三角形。调用方（叠加层、光栅器）按 `depth <= 0` 丢掉它们；
 * 光栅器还要把**跨过近裁剪面**的三角形裁开，否则近处的墙会整块消失。
 */
function projectPerspective(
  point: Vec3,
  spec: CameraSpec,
  basis: CameraBasis,
  view: PerspectiveView,
): ProjectedPoint {
  const dx = point.x - view.eye.x
  const dy = point.y - view.eye.y
  const dz = point.z - view.eye.z
  const sx = dx * basis.right.x + dy * basis.right.y + dz * basis.right.z
  const sy = dx * basis.up.x + dy * basis.up.y + dz * basis.up.z
  const depth = dx * basis.forward.x + dy * basis.forward.y + dz * basis.forward.z
  if (!(depth > 0)) return { x: Number.NaN, y: Number.NaN, depth }
  const focal = focalLength(spec, view.fov)
  return {
    x: spec.width / 2 + (sx / depth) * focal,
    y: spec.height / 2 - (sy / depth) * focal,
    depth,
  }
}

/** 垂直视场角 → 焦距（像素）。 */
export function focalLength(spec: { height: number }, fov: number): number {
  return spec.height / 2 / Math.tan((fov * DEG) / 2)
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
  if (angles === undefined) throw new RangeError(`Unknown camera preset "${preset}"`)
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

/**
 * 透视投影的**自动取景**：把包围盒塞进视锥，返回相机该站在哪儿。
 *
 * 正交取景只需要一个缩放系数（`fitCamera`），透视取景要考虑**距离**——
 * 同一个东西放远了就小。所以这里解的是距离：
 *
 * 每个角点在相机空间里的横向偏移是 `u + w·d`（`u` 是它相对内容中心在 `right` 上的分量，
 * `w` 在 `forward` 上的分量，`d` 是相机沿视线后退的距离），成像要求
 * `|u| / (d + w) ≤ tan(半视场角)`，于是 `d ≥ |u|/tan - w`。**取所有角点、两个轴上的最大值**
 * 就是恰好框住的那个距离——不需要迭代，也不是"按包围球估一个"。
 *
 * 宽高比参与进来：横向可用角度随 `width/height` 变化，所以竖屏时受限的是横向。
 */
export function fitPerspective(
  bounds: Bounds,
  angles: { azimuth: number; elevation: number },
  options: { fov: number; width: number; height: number; margin?: number; roll?: number },
): CameraSpec {
  const target: Vec3 = {
    x: (bounds.min.x + bounds.max.x + 1) / 2,
    y: (bounds.min.y + bounds.max.y + 1) / 2,
    z: (bounds.min.z + bounds.max.z + 1) / 2,
  }
  const fov = options.fov
  const width = Math.max(1, options.width)
  const height = Math.max(1, options.height)
  const basis = cameraBasis({ target, ...angles, scale: 1, width, height })
  // 垂直半角与横向半角：竖屏时横向更窄，取两者中**更紧**的那个约束
  const tanV = Math.tan((fov * DEG) / 2)
  const tanH = tanV * (width / height)

  let distance = 0
  for (let i = 0; i < 8; i++) {
    const dx = ((i & 1) === 0 ? bounds.min.x : bounds.max.x + 1) - target.x
    const dy = ((i & 2) === 0 ? bounds.min.y : bounds.max.y + 1) - target.y
    const dz = ((i & 4) === 0 ? bounds.min.z : bounds.max.z + 1) - target.z
    const u = dx * basis.right.x + dy * basis.right.y + dz * basis.right.z
    const v = dx * basis.up.x + dy * basis.up.y + dz * basis.up.z
    const w = dx * basis.forward.x + dy * basis.forward.y + dz * basis.forward.z
    distance = Math.max(distance, Math.abs(u) / tanH - w, Math.abs(v) / tanV - w)
  }
  // 留边距（乘出来，加常数会在小建筑上把相机推到很后面）；再兜一个下限，
  // 免得空世界里 distance 变成 0 或负数
  const margin = Math.min(0.4, Math.max(0, options.margin ?? 0.08))
  const eyeDistance = Math.max(1, distance * (1 + margin))
  const eye: Vec3 = {
    x: target.x - basis.forward.x * eyeDistance,
    y: target.y - basis.forward.y * eyeDistance,
    z: target.z - basis.forward.z * eyeDistance,
  }
  return {
    target,
    azimuth: angles.azimuth,
    elevation: angles.elevation,
    ...(options.roll !== undefined ? { roll: options.roll } : {}),
    // 注视点处的等效"每格像素"：面板与旧代码读它，成像本身只用 eye/fov
    scale: focalLength({ height }, fov) / eyeDistance,
    width,
    height,
    perspective: { eye, fov },
  }
}
