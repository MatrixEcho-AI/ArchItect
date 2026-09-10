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
  const right: Vec3 = { x: cosA, y: 0, z: -sinA }
  const up: Vec3 = { x: -sinA * sinE, y: cosE, z: -cosA * sinE }
  return { right, up, forward }
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
