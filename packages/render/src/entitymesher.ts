import type { AtlasIndexEntry } from './atlas-format.js'
import type { WorldGeometry } from './mesher.js'

/**
 * **实体模型 → 三角形。**
 *
 * 模型数据是 Blockbench 那一套：`{texturewidth, textureheight, bones[]}`，
 * 每个骨骼有 `pivot` / `rotation` / `parent`，每个 cube 有 `origin` / `size` / `uv`
 * / `inflate` / 可选的自身 `rotation`。单位是**像素**（1/16 格），原点在实体脚下。
 *
 * 数学移植自 `prismarine-viewer` 的 `viewer/lib/entity/Entity.js`（`addCube`），
 * 但有三处**故意不同**，每一处都是"照抄会在我们的渲染器里出错"：
 *
 * 1. **法线要跟着转。** 上游把面的轴对齐法线直接塞进属性里（它靠 three.js 的
 *    几何变换补上），而我们的光栅器**按法线做背面剔除与明暗**——不转的话，
 *    转过的实体会把该看见的面剔掉。
 * 2. **骨骼层级要复合。** 上游在绑定姿态下渲染，蒙皮的 `boneWorld · inverse(boneWorld)`
 *    恒等于单位阵，于是**祖先骨骼的旋转根本没有生效**（顶点只被自己那一根骨骼转过）。
 *    原版是按层级渲染的，所以这里沿 `parent` 链复合变换。
 * 3. **模型要落到地面上。** 上游不做任何偏移，于是船（模型 y 从 10 px 起）会浮在
 *    离地 0.625 格的地方。这里把模型**整体下移，让最低点落在 0**——与
 *    `place_entity` 的默认偏移"格心、贴地"是同一个约定。
 */

interface RawCube {
  origin: [number, number, number]
  size: [number, number, number]
  uv: [number, number]
  inflate?: number
  rotation?: [number, number, number]
}

interface RawBone {
  name: string
  parent?: string
  pivot?: [number, number, number]
  rotation?: [number, number, number]
  bind_pose_rotation?: [number, number, number]
  mirror?: boolean
  cubes?: RawCube[]
}

export interface RawGeometry {
  texturewidth?: number
  textureheight?: number
  bones?: RawBone[]
}

export interface RawEntityModel {
  identifier?: string
  textures?: Record<string, string>
  geometry?: Record<string, RawGeometry>
}

/**
 * 六个面的 UV 走向与绕序。**数据照抄上游**，包括 `north` 那个 `u1 = [2,0,2]`
 * （原版"顶面跨两格宽"的贴图约定）。
 */
const FACES: Array<{
  dir: [number, number, number]
  u0: [number, number, number]
  v0: [number, number, number]
  u1: [number, number, number]
  v1: [number, number, number]
  corners: Array<[number, number, number, number, number]>
}> = [
  { dir: [0, 1, 0], u0: [0, 0, 1], v0: [0, 0, 0], u1: [1, 0, 1], v1: [0, 0, 1], corners: [[0, 1, 1, 0, 0], [1, 1, 1, 1, 0], [0, 1, 0, 0, 1], [1, 1, 0, 1, 1]] },
  { dir: [0, -1, 0], u0: [1, 0, 1], v0: [0, 0, 0], u1: [2, 0, 1], v1: [0, 0, 1], corners: [[1, 0, 1, 0, 0], [0, 0, 1, 1, 0], [1, 0, 0, 0, 1], [0, 0, 0, 1, 1]] },
  { dir: [1, 0, 0], u0: [0, 0, 0], v0: [0, 0, 1], u1: [0, 0, 1], v1: [0, 1, 1], corners: [[1, 1, 1, 0, 0], [1, 0, 1, 0, 1], [1, 1, 0, 1, 0], [1, 0, 0, 1, 1]] },
  { dir: [-1, 0, 0], u0: [1, 0, 1], v0: [0, 0, 1], u1: [1, 0, 2], v1: [0, 1, 1], corners: [[0, 1, 0, 0, 0], [0, 0, 0, 0, 1], [0, 1, 1, 1, 0], [0, 0, 1, 1, 1]] },
  { dir: [0, 0, -1], u0: [1, 0, 0], v0: [0, 0, 0], u1: [0, 0, 0], v1: [0, 1, 0], corners: [[0, 1, 1, 0, 0], [0, 0, 1, 0, 1], [1, 1, 1, 1, 0], [1, 0, 1, 1, 1]] },
  { dir: [0, 0, 1], u0: [0, 0, 1], v0: [0, 0, 0], u1: [1, 0, 1], v1: [0, 1, 1], corners: [[0, 1, 0, 0, 0], [0, 0, 0, 0, 1], [1, 1, 0, 1, 0], [1, 0, 0, 1, 1]] },
]

/** 3×3 行主序矩阵（`m[row * 3 + col]`）。 */
type Mat3 = [number, number, number, number, number, number, number, number, number]

const IDENTITY: Mat3 = [1, 0, 0, 0, 1, 0, 0, 0, 1]

/**
 * three.js `Euler` 的 `'XYZ'` 序（`Matrix4.makeRotationFromEuler` 的公式），
 * **角度取负**——上游对骨骼与 cube 的旋转都取负，那是 Blockbench 与 three.js
 * 手性不同造成的。这里必须与上游一致，否则模型会整体翻掉。
 */
function eulerXYZ(x: number, y: number, z: number): Mat3 {
  const a = Math.cos(x)
  const b = Math.sin(x)
  const c = Math.cos(y)
  const d = Math.sin(y)
  const e = Math.cos(z)
  const f = Math.sin(z)
  const ae = a * e
  const af = a * f
  const be = b * e
  const bf = b * f
  return [
    c * e, -c * f, d,
    af + be * d, ae - bf * d, -b * c,
    bf - ae * d, be + af * d, a * c,
  ]
}

const radians = (degrees: number): number => (-degrees * Math.PI) / 180

/**
 * 标准右手系下绕 +Y / +X 旋转 `degrees`。
 *
 * 与上面的 `eulerXYZ` 分开是刻意的：`eulerXYZ` 复刻的是 three.js / Blockbench 那套
 * **取负角度**的约定（骨骼与 cube 的旋转必须照抄上游），而实体自身的 yaw/pitch
 * 是我们自己的世界语义，掺进那套约定里只会让符号问题变成猜谜。
 */
function rotateY(degrees: number): Mat3 {
  const t = (degrees * Math.PI) / 180
  const c = Math.cos(t)
  const s = Math.sin(t)
  return [c, 0, s, 0, 1, 0, -s, 0, c]
}

function rotateX(degrees: number): Mat3 {
  const t = (degrees * Math.PI) / 180
  const c = Math.cos(t)
  const s = Math.sin(t)
  return [1, 0, 0, 0, c, -s, 0, s, c]
}

function multiply(a: Mat3, b: Mat3): Mat3 {
  const out = new Array<number>(9)
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 3; c++) {
      out[r * 3 + c] =
        a[r * 3]! * b[c]! + a[r * 3 + 1]! * b[3 + c]! + a[r * 3 + 2]! * b[6 + c]!
    }
  }
  return out as Mat3
}

function apply(m: Mat3, v: [number, number, number]): [number, number, number] {
  return [
    m[0] * v[0] + m[1] * v[1] + m[2] * v[2],
    m[3] * v[0] + m[4] * v[1] + m[5] * v[2],
    m[6] * v[0] + m[7] * v[1] + m[8] * v[2],
  ]
}

/** 绕某个轴心旋转：`T(pivot) · R · T(-pivot)`，用 3×3 + 平移表示。 */
interface Placement {
  m: Mat3
  t: [number, number, number]
}

const applyPlacement = (p: Placement, v: [number, number, number]): [number, number, number] => {
  const r = apply(p.m, v)
  return [r[0] + p.t[0], r[1] + p.t[1], r[2] + p.t[2]]
}

function compose(outer: Placement, inner: Placement): Placement {
  const r = apply(outer.m, inner.t)
  return {
    m: multiply(outer.m, inner.m),
    t: [r[0] + outer.t[0], r[1] + outer.t[1], r[2] + outer.t[2]],
  }
}

/** 骨骼的局部变换：绕自己的轴心旋转。 */
function bonePlacement(bone: RawBone): Placement {
  const pivot = bone.pivot ?? [0, 0, 0]
  const rotation = bone.bind_pose_rotation ?? bone.rotation
  const m = rotation === undefined ? IDENTITY : eulerXYZ(radians(rotation[0]), radians(rotation[1]), radians(rotation[2]))
  const rotated = apply(m, pivot)
  return { m, t: [pivot[0] - rotated[0], pivot[1] - rotated[1], pivot[2] - rotated[2]] }
}

export interface EntityMeshOptions {
  /** 世界坐标（实体所在的点；模型的最底面会落在它的 y 上）。 */
  x: number
  y: number
  z: number
  /** 朝向，0..15 步、每步 22.5°。 */
  yaw: number
  pitch?: number
  /** 贴图在图集里的矩形；UV 会被映射进它里面。 */
  atlas: AtlasIndexEntry
  /** 几何变体名，默认 `default`。 */
  variant?: string
  /**
   * 把模型整体下移，让最低点落在实体位置那一层上（默认开）。
   *
   * 关掉就是上游的行为：船的模型从 y=10 px 起，于是**浮在离地 0.625 格处**。
   * 开着的理由见文件头第 3 条。
   */
  alignToFloor?: boolean
}

/** 一个空的累加器，形状与 `WorldGeometry` 一致。 */
function emptyGeometry(): {
  positions: number[]
  normals: number[]
  colors: number[]
  uvs: number[]
  indices: number[]
} {
  return { positions: [], normals: [], colors: [], uvs: [], indices: [] }
}

function finish(acc: ReturnType<typeof emptyGeometry>): WorldGeometry {
  return {
    positions: new Float32Array(acc.positions),
    normals: new Float32Array(acc.normals),
    // 实体没有 AO 也没有生物群系着色，全白——方向明暗由光栅器按法线叠加，
    // 所以实体与方块受同一套光照，不会一边亮一边暗
    colors: new Float32Array(acc.colors),
    uvs: new Float32Array(acc.uvs),
    indices: new Uint32Array(acc.indices),
    vertices: acc.positions.length / 3,
  }
}

/**
 * 把一个实体模型网格化成世界坐标下的三角形汤。
 *
 * 模型表里没有这个实体时**不要调这个函数**——用 `meshFallbackBox` 画兜底盒。
 */
export function meshEntity(model: RawEntityModel, options: EntityMeshOptions): WorldGeometry {
  const geometry = model.geometry?.[options.variant ?? 'default'] ?? model.geometry?.['default']
  if (geometry === undefined) return finish(emptyGeometry())

  const texWidth = geometry.texturewidth ?? 64
  const texHeight = geometry.textureheight ?? 64
  const bones = geometry.bones ?? []

  // ── 骨骼层级：先把每个骨骼的世界变换算出来（沿 parent 链复合） ──
  const local = new Map<string, Placement>()
  const world = new Map<string, Placement>()
  const boneOf = new Map<string, RawBone>()
  for (const bone of bones) {
    boneOf.set(bone.name, bone)
    local.set(bone.name, bonePlacement(bone))
  }
  const worldOf = (name: string, guard = 0): Placement => {
    const cached = world.get(name)
    if (cached !== undefined) return cached
    const bone = boneOf.get(name)
    if (bone === undefined || guard > 32) return { m: IDENTITY, t: [0, 0, 0] }
    const own = local.get(name)!
    const parent = bone.parent
    const result = parent === undefined ? own : compose(worldOf(parent, guard + 1), own)
    world.set(name, result)
    return result
  }

  const acc = emptyGeometry()
  const scale = 1 / 16

  // 实体自身的朝向：先绕 +Y 转 yaw，再绕 +X 转 pitch（yaw 在外层）。
  //
  // Minecraft 的 yaw 是**从上往下看顺时针**增大的（0 = 南、90 = 西、180 = 北、
  // 270 = 东），而 `rotateY` 是标准的右手正向（+Z 转向 +X）。两者方向相反，
  // 所以这里取负号——写反的症状是"船全都反着朝"，而模型分不出是它选错了朝向
  // 还是渲染转错了。
  const yawMatrix = rotateY(-options.yaw * 22.5)
  const pitchMatrix = options.pitch !== undefined ? rotateX(options.pitch) : IDENTITY
  const facing = multiply(yawMatrix, pitchMatrix)

  // 先全量算一遍模型空间的顶点，才能知道最低点在哪（`alignToFloor`）
  const pending: Array<{
    position: [number, number, number]
    normal: [number, number, number]
    u: number
    v: number
  }> = []

  for (const bone of bones) {
    const boneWorld = worldOf(bone.name)
    for (const cube of bone.cubes ?? []) {
      const cubeRotation =
        cube.rotation === undefined
          ? IDENTITY
          : eulerXYZ(radians(cube.rotation[0]), radians(cube.rotation[1]), radians(cube.rotation[2]))
      const inflate = cube.inflate ?? 0

      for (const face of FACES) {
        for (const corner of face.corners) {
          const sign = [corner[0], corner[1], corner[2]] as [number, number, number]
          const base: [number, number, number] = [
            cube.origin[0] + sign[0] * cube.size[0] + (sign[0] ? inflate : -inflate),
            cube.origin[1] + sign[1] * cube.size[1] + (sign[1] ? inflate : -inflate),
            cube.origin[2] + sign[2] * cube.size[2] + (sign[2] ? inflate : -inflate),
          ]
          // cube 自身的旋转（上游是在模型空间里转的，不是绕 cube 中心——照它来）
          const rotated = apply(cubeRotation, base)
          const position = applyPlacement(boneWorld, rotated)
          const normal = apply(cubeRotation, face.dir)
          const boneNormal = apply(boneWorld.m, normal)

          const uSource = corner[3] ? face.u1 : face.u0
          const vSource = corner[4] ? face.v1 : face.v0
          pending.push({
            position,
            normal: boneNormal,
            u:
              (cube.uv[0] + uSource[0] * cube.size[0] + uSource[1] * cube.size[1] + uSource[2] * cube.size[2]) /
              texWidth,
            v:
              (cube.uv[1] + vSource[0] * cube.size[0] + vSource[1] * cube.size[1] + vSource[2] * cube.size[2]) /
              texHeight,
          })
        }
      }
    }
  }

  let dropY = 0
  if (options.alignToFloor !== false && pending.length > 0) {
    let minY = Number.POSITIVE_INFINITY
    for (const vertex of pending) if (vertex.position[1] < minY) minY = vertex.position[1]
    if (Number.isFinite(minY)) dropY = minY
  }

  const { atlas } = options
  for (const vertex of pending) {
    const local3: [number, number, number] = [
      vertex.position[0] * scale,
      (vertex.position[1] - dropY) * scale,
      vertex.position[2] * scale,
    ]
    const turned = apply(facing, local3)
    acc.positions.push(options.x + turned[0], options.y + turned[1], options.z + turned[2])
    const normal = apply(facing, vertex.normal)
    acc.normals.push(normal[0], normal[1], normal[2])
    acc.colors.push(1, 1, 1)
    // 贴图空间 → 图集空间
    acc.uvs.push(atlas.u + vertex.u * atlas.su, atlas.v + vertex.v * atlas.sv)
  }

  // 六个面各 4 个顶点，顺序与 FACES 的 corners 一致：0,1,2 + 2,1,3
  const quads = pending.length / 4
  for (let q = 0; q < quads; q++) {
    const base = q * 4
    acc.indices.push(base, base + 1, base + 2, base + 2, base + 1, base + 3)
  }

  return finish(acc)
}

/**
 * 模型表里没有这个实体时的**兜底盒**。
 *
 * `minecraft-data` 给了每种实体的碰撞盒宽高，画一个盒子的信息量比"什么都不画"
 * 高得多（模型至少知道那里有个东西、大概多大），而比"猜一个形状"诚实。
 * 展示框、画、`chest_boat` 之外的新实体都走这条路。
 */
export function meshFallbackBox(
  size: { width: number; height: number },
  options: EntityMeshOptions,
): WorldGeometry {
  const half = size.width / 2
  const model: RawEntityModel = {
    geometry: {
      default: {
        texturewidth: 1,
        textureheight: 1,
        bones: [
          {
            name: 'box',
            cubes: [
              {
                origin: [-half * 16, 0, -half * 16],
                size: [size.width * 16, size.height * 16, size.width * 16],
                // UV 全部指向贴图的左上角一点——兜底盒没有自己的贴图
                uv: [0, 0],
              },
            ],
          },
        ],
      },
    },
  }
  return meshEntity(model, options)
}
