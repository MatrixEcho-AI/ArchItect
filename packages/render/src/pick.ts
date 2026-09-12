/**
 * **正交射线拾取**：屏幕上的一个像素 → 世界里的哪一格、命中哪个面。
 *
 * 人手接管要靠它（"点哪儿改哪儿"）。做成 CPU 侧而不是 three.js 的 `Raycaster`，
 * 有三个理由：
 *
 * 1. **软件视口也要能用**（没有 WebGL 时的兜底视口根本没有 three 场景）。
 * 2. **和渲染共用同一份投影**：射线方向与像素→世界的那一步都从
 *    `cameraBasis` / `projectPoint` 的口径反推，所以"点到的格子"和"看到的格子"
 *    是同一个——自己另写一套反投影，迟早会与画面差一格。
 * 3. **可测**：纯函数，给几何 + 相机 + 像素就能断言，不需要 DOM 也不需要 GPU。
 *
 * 正交投影下**所有射线平行**（方向都是 `basis.forward`），只有起点随像素走。
 * 这让拾取比透视投影简单得多：起点 = 目标点 + right·sx + up·sy − forward·很远，
 * 其中 `sx`/`sy` 正是 `projectPoint` 里那两个量。
 */

import { cameraBasis, focalLength } from './camera.js'
import type { CameraBasis, CameraSpec, Vec3 } from './camera.js'
import type { WorldGeometry } from './mesher.js'

export interface PickHit {
  /** 命中面**属于**的那一格——挖掉它。 */
  block: Vec3
  /** 贴在命中面外侧的那一格——放这里。 */
  place: Vec3
  /** 命中面的朝向（主轴单位向量）。 */
  normal: Vec3
  /** 命中的深度（沿视线方向，越大越远）。给"点击顺序"之类的判断用。 */
  depth: number
  /** 命中点的世界坐标（调试与画高亮用）。 */
  point: Vec3
}

/**
 * 一次射线与三角形汤的命中，**不含任何方块语义**。
 *
 * 抽出来是因为"命中了哪个三角形"是通用的，而"命中之后怎么解释"不是：
 * 方块那侧要把它吸附到整数格与主轴法线，实体那侧要回到**是哪一个实体**。
 * 两套语义共用同一段射线与同一个 Möller–Trumbore——各写一遍迟早会在
 * "贴着边点"这类情况上给出不同的答案。
 */
export interface TriangleHit {
  /** 命中的三角形在 `indices` 里的起始下标。 */
  triangle: number
  depth: number
  point: Vec3
}

/**
 * 屏幕像素 → 最近的三角形。没有命中返回 `undefined`（点到天空）。
 *
 * **不剔除背面**：方块与实体的几何都有双面（mesher 的绕向会跟着 AO 翻转），
 * 剔掉背面会让"从里面看"点不到东西。
 */
export function pickTriangle(
  geometry: WorldGeometry,
  camera: CameraSpec,
  x: number,
  y: number,
): TriangleHit | undefined {
  const ray = screenRay(camera, x, y)
  const { positions, indices } = geometry
  const { origin, direction } = ray

  let bestDepth = Number.POSITIVE_INFINITY
  let bestTriangle = -1
  for (let t = 0; t < indices.length; t += 3) {
    const depth = rayTriangle(
      origin,
      direction,
      positions,
      indices[t]!,
      indices[t + 1]!,
      indices[t + 2]!,
    )
    if (depth === undefined || depth < 0.0 || depth >= bestDepth) continue
    bestDepth = depth
    bestTriangle = t
  }
  if (bestTriangle < 0) return undefined

  return {
    triangle: bestTriangle,
    depth: bestDepth,
    point: {
      x: origin.x + direction.x * bestDepth,
      y: origin.y + direction.y * bestDepth,
      z: origin.z + direction.z * bestDepth,
    },
  }
}

/**
 * 实体拾取：命中的三角形属于哪一个实体。
 *
 * `owners` 是**逐三角形**的所有者下标（`EntityRenderResult.owners`）——几何本身
 * 是一份三角形汤，没有身份信息，而"点到了哪条船"必须能回答。
 * 落在没有所有者的三角形上（越界或负值）就当成没命中。
 */
export function pickEntity(
  geometry: WorldGeometry,
  camera: CameraSpec,
  x: number,
  y: number,
  owners: Int32Array,
): { index: number; depth: number; point: Vec3 } | undefined {
  const hit = pickTriangle(geometry, camera, x, y)
  if (hit === undefined) return undefined
  const index = owners[hit.triangle / 3]
  if (index === undefined || index < 0) return undefined
  return { index, depth: hit.depth, point: hit.point }
}

/**
 * 射线起点离目标点的距离。
 *
 * 正交投影下它不影响成像，只决定"从哪里开始找交点"。取足够大，
 * 保证起点在整座建筑之外；又不要大到浮点精度开始飘。
 */
const RAY_START_DISTANCE = 4096

/**
 * 把命中点挪进格子内部的距离，以及往三角形重心靠的比例。
 *
 * 为什么两件事都要做：命中点恰好落在**面**上（某个坐标是整数），
 * 直接取整会取到外面那一格；而命中点落在三角形**边**上时，
 * 另外两个坐标也可能是整数，取整的结果就取决于浮点噪声了。
 * 先沿反法线推 0.25 格（进去），再往重心挪 10%（离边远一点），
 * 剩下的就不可能是"边界情况"。
 */
const INSIDE_NUDGE = 0.25
const CENTROID_PULL = 0.1

/** 屏幕像素 → 一条正交射线的起点与方向。 */
export function screenRay(
  camera: CameraSpec,
  x: number,
  y: number,
): { origin: Vec3; direction: Vec3 } {
  const basis = cameraBasis(camera)
  if (camera.perspective !== undefined) {
    // 透视：射线从**相机位置**出发，穿过那个像素对应的方向
    const focal = focalLength(camera, camera.perspective.fov)
    const sx = (x - camera.width / 2) / focal
    const sy = (camera.height / 2 - y) / focal
    const direction: Vec3 = {
      x: basis.forward.x + basis.right.x * sx + basis.up.x * sy,
      y: basis.forward.y + basis.right.y * sx + basis.up.y * sy,
      z: basis.forward.z + basis.right.z * sx + basis.up.z * sy,
    }
    const length = Math.hypot(direction.x, direction.y, direction.z) || 1
    return {
      origin: camera.perspective.eye,
      direction: { x: direction.x / length, y: direction.y / length, z: direction.z / length },
    }
  }
  // 正交：所有射线平行（方向都是 forward），只有起点随像素走。
  // `projectPoint` 的逆：屏幕中心对应目标点，一格 = `scale` 像素
  const sx = (x - camera.width / 2) / camera.scale
  const sy = (camera.height / 2 - y) / camera.scale
  const origin: Vec3 = {
    x: camera.target.x + basis.right.x * sx + basis.up.x * sy - basis.forward.x * RAY_START_DISTANCE,
    y: camera.target.y + basis.right.y * sx + basis.up.y * sy - basis.forward.y * RAY_START_DISTANCE,
    z: camera.target.z + basis.right.z * sx + basis.up.z * sy - basis.forward.z * RAY_START_DISTANCE,
  }
  return { origin, direction: basis.forward }
}

/**
 * 找屏幕像素下面最近的那个三角形。
 *
 * **不做背面剔除**：mesher 的三角形绕向会跟着 AO 翻转（见 vendored `models.js`），
 * 而且我们在 GPU 那条路上是双面渲染的——按绕向剔除会和画面不一致。
 * 取最近的正交点即可，这与渲染出来的结果等价。
 */
export function pickBlock(
  geometry: WorldGeometry,
  camera: CameraSpec,
  x: number,
  y: number,
): PickHit | undefined {
  const hit = pickTriangle(geometry, camera, x, y)
  if (hit === undefined) return undefined
  const { positions, indices } = geometry
  const bestDepth = hit.depth
  const point = hit.point
  const bestTriangle = hit.triangle

  const i0 = indices[bestTriangle]!
  const i1 = indices[bestTriangle + 1]!
  const i2 = indices[bestTriangle + 2]!
  const centroid: Vec3 = {
    x: (positions[i0 * 3]! + positions[i1 * 3]! + positions[i2 * 3]!) / 3,
    y: (positions[i0 * 3 + 1]! + positions[i1 * 3 + 1]! + positions[i2 * 3 + 1]!) / 3,
    z: (positions[i0 * 3 + 2]! + positions[i1 * 3 + 2]! + positions[i2 * 3 + 2]!) / 3,
  }
  const normal = normalOf(positions, i0, i1, i2)
  const inside: Vec3 = {
    x: lerp(point.x, centroid.x) - normal.x * INSIDE_NUDGE,
    y: lerp(point.y, centroid.y) - normal.y * INSIDE_NUDGE,
    z: lerp(point.z, centroid.z) - normal.z * INSIDE_NUDGE,
  }
  const block: Vec3 = { x: Math.floor(inside.x), y: Math.floor(inside.y), z: Math.floor(inside.z) }
  return {
    block,
    place: { x: block.x + normal.x, y: block.y + normal.y, z: block.z + normal.z },
    normal,
    depth: bestDepth,
    point,
  }
}

const lerp = (from: number, to: number): number => from + (to - from) * CENTROID_PULL

/**
 * 三角形的朝向，**吸附到主轴**。
 *
 * 面片的法线本来就是轴对齐的（方块面），吸附一次可以免掉浮点噪声带来的
 * "法线是 (0, 0.9999998, 0)"这种值——那会让 `block + normal` 得到非整数。
 */
function normalOf(positions: Float32Array, i0: number, i1: number, i2: number): Vec3 {
  const ax = positions[i0 * 3]!
  const ay = positions[i0 * 3 + 1]!
  const az = positions[i0 * 3 + 2]!
  const e1x = positions[i1 * 3]! - ax
  const e1y = positions[i1 * 3 + 1]! - ay
  const e1z = positions[i1 * 3 + 2]! - az
  const e2x = positions[i2 * 3]! - ax
  const e2y = positions[i2 * 3 + 1]! - ay
  const e2z = positions[i2 * 3 + 2]! - az
  const nx = e1y * e2z - e1z * e2y
  const ny = e1z * e2x - e1x * e2z
  const nz = e1x * e2y - e1y * e2x
  const ax2 = Math.abs(nx)
  const ay2 = Math.abs(ny)
  const az2 = Math.abs(nz)
  if (ay2 >= ax2 && ay2 >= az2) return { x: 0, y: ny >= 0 ? 1 : -1, z: 0 }
  if (ax2 >= az2) return { x: nx >= 0 ? 1 : -1, y: 0, z: 0 }
  return { x: 0, y: 0, z: nz >= 0 ? 1 : -1 }
}

/**
 * Möller–Trumbore。返回沿 `direction` 的距离；不相交返回 `undefined`。
 *
 * **不剔除背面**（行列式取绝对值），理由见 `pickBlock`。
 */
function rayTriangle(
  origin: Vec3,
  direction: Vec3,
  positions: Float32Array,
  i0: number,
  i1: number,
  i2: number,
): number | undefined {
  const ax = positions[i0 * 3]!
  const ay = positions[i0 * 3 + 1]!
  const az = positions[i0 * 3 + 2]!
  const e1x = positions[i1 * 3]! - ax
  const e1y = positions[i1 * 3 + 1]! - ay
  const e1z = positions[i1 * 3 + 2]! - az
  const e2x = positions[i2 * 3]! - ax
  const e2y = positions[i2 * 3 + 1]! - ay
  const e2z = positions[i2 * 3 + 2]! - az

  const px = direction.y * e2z - direction.z * e2y
  const py = direction.z * e2x - direction.x * e2z
  const pz = direction.x * e2y - direction.y * e2x
  const det = e1x * px + e1y * py + e1z * pz
  if (Math.abs(det) < 1e-12) return undefined
  const inv = 1 / det

  const tx = origin.x - ax
  const ty = origin.y - ay
  const tz = origin.z - az
  const u = (tx * px + ty * py + tz * pz) * inv
  if (u < -1e-6 || u > 1 + 1e-6) return undefined

  const qx = ty * e1z - tz * e1y
  const qy = tz * e1x - tx * e1z
  const qz = tx * e1y - ty * e1x
  const v = (direction.x * qx + direction.y * qy + direction.z * qz) * inv
  if (v < -1e-6 || u + v > 1 + 1e-6) return undefined

  return (e2x * qx + e2y * qy + e2z * qz) * inv
}

/** 让 `CameraBasis` 类型在外部可见（拾取与渲染共用它）。 */
export type { CameraBasis }
