import type { BlockRegistry } from './registry.js'
import { propertiesToStateId, propertyValueAt, stateIdToProperties } from './state.js'
import type { BlockProperty, Properties, PropertyValue } from './types.js'

/**
 * 方块状态的**朝向重映射**。
 *
 * 复制/旋转/镜像一整个区域时，坐标跟着动是显然的；**容易被漏掉的是方块自己的朝向**：
 * 一座朝东的楼梯原样搬到旋转后的位置，就变成了一座嵌在墙里的错块。这是所有体素工具
 * 最经典的 bug，所以这里单独一个模块、单独一套全量测试。
 *
 * ## 做法：一个整数矩阵，其余全部推导出来
 *
 * 每一种变换都是坐标轴的一个**带符号置换**（3×3 整数矩阵，每行每列恰好一个 ±1）。
 * 方向类属性值（`north`/`east`/`up`/…）只需要把方向向量过一遍矩阵再读回来——
 * 于是"坐标怎么转"和"朝向怎么转"**用的是同一个事实**，不可能对不上。
 *
 * 另外两条从矩阵本身读出来的信息：
 *
 * - `det < 0` 表示这次变换**翻转了手性**。左手/右手这类相对量（`hinge=left`、
 *   楼梯 `shape=outer_left`、双箱 `type=left`）必须跟着互换——镜像一次，
 *   左转就变成了右转。
 * - `rotation`(0..15) 是"从南开始、每格 22.5°、俯视顺时针"的枚举。
 *   它在变换下是仿射的：`r → det·r + t (mod 16)`，其中 `t` 由"南"映射到哪一档给出。
 *
 * ## 顺序
 *
 * `mirror` **先**做，`rotate` **后**做。两个都给时结果不等价于反过来，所以这个顺序
 * 是契约的一部分，写在文档里而不是留给读者猜。
 */

/** 绕 Y 轴的旋转角度（俯视、+X 东 +Z 南，顺时针为正）。 */
export type RotateDegrees = 0 | 90 | 180 | 270

/** 镜像平面的法线方向。`x` = 沿 X 翻转，`y` = 上下翻转。 */
export type MirrorAxis = 'x' | 'y' | 'z'

export interface Transform {
  rotate?: RotateDegrees
  /** 先镜像。 */
  mirror?: MirrorAxis
}

export const IDENTITY_TRANSFORM: Transform = {}

// ── 3×3 带符号置换矩阵 ─────────────────────────────────────────────────────────
// 按行主序存：`[m00,m01,m02, m10,m11,m12, m20,m21,m22]`，作用在列向量 (x,y,z) 上。

type Mat3 = readonly [number, number, number, number, number, number, number, number, number]

const IDENTITY: Mat3 = [1, 0, 0, 0, 1, 0, 0, 0, 1]

/** 绕 Y 轴 90° 顺时针：(x,y,z) → (-z, y, x)。 */
const ROT_Y_90: Mat3 = [0, 0, -1, 0, 1, 0, 1, 0, 0]

const MIRROR: Record<MirrorAxis, Mat3> = {
  x: [-1, 0, 0, 0, 1, 0, 0, 0, 1],
  y: [1, 0, 0, 0, -1, 0, 0, 0, 1],
  z: [1, 0, 0, 0, 1, 0, 0, 0, -1],
}

/** `second ∘ first`（先 first 后 second）。 */
function multiply(second: Mat3, first: Mat3): Mat3 {
  const out = new Array<number>(9).fill(0)
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 3; c++) {
      let sum = 0
      for (let k = 0; k < 3; k++) sum += second[r * 3 + k]! * first[k * 3 + c]!
      out[r * 3 + c] = sum
    }
  }
  return out as unknown as Mat3
}

const applyMatrix = (m: Mat3, v: readonly [number, number, number]): [number, number, number] => [
  m[0]! * v[0] + m[1]! * v[1] + m[2]! * v[2],
  m[3]! * v[0] + m[4]! * v[1] + m[5]! * v[2],
  m[6]! * v[0] + m[7]! * v[1] + m[8]! * v[2],
]

const determinant = (m: Mat3): number =>
  m[0]! * (m[4]! * m[8]! - m[5]! * m[7]!) -
  m[1]! * (m[3]! * m[8]! - m[5]! * m[6]!) +
  m[2]! * (m[3]! * m[7]! - m[4]! * m[6]!)

/** 变换对应的矩阵。**先镜像后旋转**。 */
export function matrixOf(transform: Transform): Mat3 {
  let m = IDENTITY
  if (transform.mirror !== undefined) m = multiply(MIRROR[transform.mirror], m)
  const steps = Math.round((transform.rotate ?? 0) / 90)
  for (let i = 0; i < ((steps % 4) + 4) % 4; i++) m = multiply(ROT_Y_90, m)
  return m
}

/** 这次变换是否翻转了手性（镜像奇数次）。 */
export function isMirroring(transform: Transform): boolean {
  return determinant(matrixOf(transform)) < 0
}

/**
 * **水平面内**的手性是否翻转。
 *
 * 这里不能用 3×3 的行列式。`hinge`（门轴在左还是在右）、`type=left/right`（双箱）、
 * `shape=inner_left/outer_left`（楼梯）、以及告示牌那 16 档 `rotation`，全都是
 * **水平面内**的量：它们关心的是 (x,z) 平面被翻转了没有。
 *
 * 竖直翻转 `mirror:'y'` 在 (x,z) 上的诱导映射是**恒等**（这些量一个都不该变），
 * 而它的 3×3 行列式是 -1。用 3×3 判就会把门轴左右互换、把告示牌 yaw 取反——
 * 竖直翻转只该换 `half=lower/upper` 那一类上下量，那个另外由 `isVerticalFlipped` 管。
 *
 * 取 (x,z) 子块的行列式 `m00·m22 − m02·m20`。x/z 镜像与全部旋转在这个判据下
 * 与 3×3 一致，只有含 `mirror:'y'` 的那几组不同。
 */
function flipsHorizontalHandedness(m: Mat3): boolean {
  return m[0]! * m[8]! - m[2]! * m[6]! < 0
}

export function isIdentity(transform: Transform): boolean {
  return matrixOf(transform).every((value, index) => value === IDENTITY[index])
}

/** 校验并规范化外部传进来的变换描述。**不认识就报错，不静默忽略**。 */
export function parseTransform(input: { rotate?: unknown; mirror?: unknown } | undefined): Transform {
  const out: Transform = {}
  if (input === undefined) return out
  if (input.rotate !== undefined) {
    const degrees = Number(input.rotate)
    if (degrees !== 0 && degrees !== 90 && degrees !== 180 && degrees !== 270) {
      throw new Error(`rotate accepts 0 / 90 / 180 / 270, got ${String(input.rotate)}`)
    }
    if (degrees !== 0) out.rotate = degrees
  }
  if (input.mirror !== undefined && input.mirror !== null && input.mirror !== 'none') {
    if (input.mirror !== 'x' && input.mirror !== 'y' && input.mirror !== 'z') {
      throw new Error(`mirror accepts x / y / z, got ${String(input.mirror)}`)
    }
    out.mirror = input.mirror
  }
  return out
}

// ── 方向词表 ──────────────────────────────────────────────────────────────────

const DIRECTIONS: ReadonlyArray<{ token: string; vec: readonly [number, number, number] }> = [
  { token: 'north', vec: [0, 0, -1] },
  { token: 'east', vec: [1, 0, 0] },
  { token: 'south', vec: [0, 0, 1] },
  { token: 'west', vec: [-1, 0, 0] },
  { token: 'up', vec: [0, 1, 0] },
  { token: 'down', vec: [0, -1, 0] },
]

const TOKEN_BY_VEC = new Map<string, string>(DIRECTIONS.map((d) => [d.vec.join(','), d.token]))
/** 水平方向词（不含 `up`/`down`）——用来判断一个组合值是不是"顺序无关的方向集合"。 */
const HORIZONTAL_TOKENS = new Set(['north', 'east', 'south', 'west'])
const VEC_BY_TOKEN = new Map<string, readonly [number, number, number]>(
  DIRECTIONS.map((d) => [d.token, d.vec]),
)

/** 方向词 → 变换后的方向词。不是方向词就原样返回。 */
function mapDirectionToken(token: string, m: Mat3): string {
  const vec = VEC_BY_TOKEN.get(token)
  if (vec === undefined) return token
  return TOKEN_BY_VEC.get(applyMatrix(m, vec).join(',')) ?? token
}

/**
 * 相对量：`left` / `right`（门轴、双箱、楼梯的 `inner_left` / `outer_left`）。
 *
 * 镜像翻转手性，所以左右互换；旋转保持手性，所以不动。这条规则对**所有**带 left/right
 * 的属性通用（`hinge`、`type`、`shape`），不需要按属性名各写一遍。
 */
function mapHandedToken(token: string, mirrored: boolean): string {
  if (!mirrored) return token
  if (token === 'left') return 'right'
  if (token === 'right') return 'left'
  return token
}

/**
 * 上下翻转时才需要成对互换的**非方向**属性值。
 *
 * 它们不写成方向词（`bottom` 不是 `down`），所以矩阵管不到，只能显式列表。
 * 只在 `mirror: 'y'`（或任何让 **Y 轴反向**的变换）下生效。
 */
const VERTICAL_VALUE_PAIRS: Record<string, Record<string, string>> = {
  // 门是 lower/upper，楼梯与台阶是 bottom/top —— 同一个属性名两套词表
  half: { bottom: 'top', top: 'bottom', lower: 'upper', upper: 'lower' },
  // 台阶 bottom/top/double；箱子 left/right/single（left/right 走手性规则）
  type: { bottom: 'top', top: 'bottom' },
  // 漏斗、砂轮一类用 floor/wall/ceiling 描述附着面
  face: { floor: 'ceiling', ceiling: 'floor' },
  attachment: { floor: 'ceiling', ceiling: 'floor' },
}

/** `hanging=true` 表示"吊在上面"——上下翻转后它就不吊了。 */
const VERTICAL_BOOLEAN_FLIPS = new Set(['hanging'])

const isVerticalFlipped = (m: Mat3): boolean => applyMatrix(m, [0, 1, 0])[1] < 0

// ── 属性名与属性值的重映射 ────────────────────────────────────────────────────

/**
 * 属性**名**本身是方向的情况：`north` / `east` / `south` / `west` / `up` / `down`。
 *
 * 69 个方块（栅栏、墙、玻璃板、铁栏杆…）把连接状态直接写成了方向名的布尔/枚举属性。
 * 旋转时**属性名要跟着转**：原本 `north=true` 的那一格，转完应该写 `east=true`。
 * 只转值是错的——那是这个模块最容易写错的一处。
 */
function mapPropertyName(name: string, m: Mat3, declared: ReadonlySet<string>): string {
  if (!VEC_BY_TOKEN.has(name)) return name
  const mapped = mapDirectionToken(name, m)
  // **映射后必须仍然存在**：`up` 在墙/玻璃板上是单独一个属性（没有配对的 `down`），
  // 竖直镜像会把它映射成 `down`——那会产生一个编码不出来的状态。
  // 宁可保留原名（一个能编码的近似），也不要抛 StateError 把整次复制炸掉。
  return declared.has(mapped) ? mapped : name
}

const INT_LIKE = /^-?\d+$/

/** `rotation` 的取值数量（16 档，每档 22.5°，0 = 南，俯视顺时针递增）。 */
const ROTATION_STEPS = 16

/** 方向向量 → `rotation` 档位。只处理四个正方向，它们是唯一的基准。 */
function rotationIndexOf(vec: readonly [number, number, number]): number {
  const token = TOKEN_BY_VEC.get(vec.join(','))
  switch (token) {
    case 'south':
      return 0
    case 'west':
      return 4
    case 'north':
      return 8
    case 'east':
      return 12
    default:
      return 0
  }
}

function mapAxisValue(text: string, m: Mat3): string {
  // 轴是一个**无向**方向：x 轴换成 z 轴，但它仍是一条轴，不区分正负
  const probe: readonly [number, number, number] = text === 'x' ? [1, 0, 0] : text === 'y' ? [0, 1, 0] : [0, 0, 1]
  const mapped = applyMatrix(m, probe)
  if (mapped[0] !== 0) return 'x'
  if (mapped[1] !== 0) return 'y'
  return 'z'
}

function mapRotationValue(text: string, m: Mat3): string {
  const start = Number(text)
  if (!Number.isFinite(start)) return text
  // "南"在变换后落在哪一档 → 仿射映射的常数项
  const offset = rotationIndexOf(applyMatrix(m, [0, 0, 1]))
  const sign = flipsHorizontalHandedness(m) ? -1 : 1
  const next = (((sign * start + offset) % ROTATION_STEPS) + ROTATION_STEPS) % ROTATION_STEPS
  return String(next)
}

/**
 * 属性值 → 变换后的属性值。
 *
 * 组合值（`outer_left`、`ascending_north`、`north_east`、`north_up`）按 `_` 拆成词元
 * 逐个映射，然后在**该属性自己声明的取值表**里找拼回来的那个。用声明表兜底而不是
 * 自己拼字符串，是因为规范的拼写顺序只有声明知道：`north`+`east` 在铁轨里写作
 * `north_east`，而旋转后是 `south_east` 而不是 `east_south`。
 */
function mapPropertyValue(
  property: BlockProperty,
  value: PropertyValue,
  m: Mat3,
  mirrored: boolean,
  vertical: boolean,
): PropertyValue {
  if (typeof value === 'boolean') {
    return vertical && VERTICAL_BOOLEAN_FLIPS.has(property.name) ? !value : value
  }
  const text = String(value)

  if (property.name === 'axis') return mapAxisValue(text, m)
  if (property.name === 'rotation') return mapRotationValue(text, m)

  if (vertical) {
    const pair = VERTICAL_VALUE_PAIRS[property.name]?.[text]
    if (pair !== undefined) return pair
  }

  // 纯数字属性（age / power / level / distance / candles…）没有朝向语义
  if (INT_LIKE.test(text) && property.type !== 'enum') return value

  const tokens = text.split('_')
  const mapped = tokens.map((token) => mapHandedToken(mapDirectionToken(token, m), mirrored))
  const joined = mapped.join('_')
  if (joined === text) return value
  if (property.values?.includes(joined) === true) return joined

  // 顺序无关的**水平方向集合**（铁轨的 `north_east`）：拼写顺序只是约定，
  // 旋转后可能得到 `east_south`，得在声明里按集合找出 `south_east`。
  //
  // 判据是"**所有**词元都是水平方向"——这一条把铁轨和 `orientation` 分开了：
  // `east_up` 里 `up` 不是水平方向，它的词元顺序**是有语义的**（先面、后指向），
  // 按集合去匹配会把它错配成 `down_east`，一个完全不同的朝向。
  const allHorizontal = tokens.every((token) => HORIZONTAL_TOKENS.has(token))
  if (allHorizontal && mapped.every((token) => HORIZONTAL_TOKENS.has(token))) {
    const sorted = [...mapped].sort().join('_')
    for (const candidate of property.values ?? []) {
      const parts = candidate.split('_')
      if (parts.every((token) => HORIZONTAL_TOKENS.has(token)) && [...parts].sort().join('_') === sorted) {
        return candidate
      }
    }
  }

  // 认不出来就原样保留。**留一个能编码的状态，比造一个不存在的状态安全。**
  // 会走到这里的真实例子：`hopper` 竖直镜像后 `facing=down` 应该朝上，
  // 但漏斗根本没有 `up` 这个取值——保住能编码的 `down` 是唯一诚实的做法。
  return value
}

// ── 对外接口 ──────────────────────────────────────────────────────────────────

/**
 * 把一个全局 stateId 变换到新朝向。
 *
 * 返回同**方块类型**（不会把 `oak_stairs` 变成别的东西）的新 stateId。
 */
export function remapStateId(registry: BlockRegistry, stateId: number, transform: Transform): number {
  const m = matrixOf(transform)
  if (isIdentity(transform)) return stateId
  const block = registry.blockByStateId(stateId)
  if (block === undefined) throw new Error(`Unknown state id ${stateId}`)
  if (block.states.length === 0) return stateId

  const mirrored = flipsHorizontalHandedness(m)
  const vertical = isVerticalFlipped(m)
  const source = stateIdToProperties(block, stateId)
  const target: Properties = {}
  const declared = new Set(block.states.map((property) => property.name))

  for (const property of block.states) {
    const value = source[property.name] ?? propertyValueAt(property, 0)
    target[mapPropertyName(property.name, m, declared)] = mapPropertyValue(
      property,
      value,
      m,
      mirrored,
      vertical,
    )
  }
  return propertiesToStateId(block, target)
}

/** 规范字符串形式的重映射。磁盘层存字符串，所以复制粘贴走这条路径。 */
export function remapStateString(registry: BlockRegistry, stateString: string, transform: Transform): string {
  const stateId = resolveStateId(registry, stateString)
  return formatStateId(registry, remapStateId(registry, stateId, transform))
}

function resolveStateId(registry: BlockRegistry, stateString: string): number {
  const match = /^(?:minecraft:)?([a-z0-9_]+)(?:\[([^\]]*)\])?$/.exec(stateString.trim())
  if (match === null) throw new Error(`Not a valid block state: "${stateString}"`)
  const block = registry.blockByName(match[1]!)
  if (block === undefined) throw new Error(`Unknown block "${match[1]}"`)
  const overrides: Properties = {}
  for (const pair of (match[2] ?? '').split(',')) {
    if (pair.trim().length === 0) continue
    const eq = pair.indexOf('=')
    if (eq <= 0) throw new Error(`"${pair}" is not key=value`)
    const name = pair.slice(0, eq).trim()
    const raw = pair.slice(eq + 1).trim()
    overrides[name] = raw === 'true' ? true : raw === 'false' ? false : INT_LIKE.test(raw) ? Number(raw) : raw
  }
  return propertiesToStateId(block, overrides)
}

function formatStateId(registry: BlockRegistry, stateId: number): string {
  const block = registry.blockByStateId(stateId)!
  const properties = stateIdToProperties(block, stateId)
  const keys = Object.keys(properties).sort()
  if (keys.length === 0) return `minecraft:${block.name}`
  return `minecraft:${block.name}[${keys.map((k) => `${k}=${String(properties[k])}`).join(',')}]`
}

// ── 区域变换时的局部坐标映射 ──────────────────────────────────────────────────

export type Size3 = readonly [number, number, number]
export type LocalPoint = readonly [number, number, number]

/**
 * 区域经过变换后的新尺寸。
 *
 * 90°/270° 会把水平两轴换位（`x,z` 互换）。
 */
export function transformedSize(size: Size3, transform: Transform): Size3 {
  let [sx, sy, sz] = size
  const steps = Math.round((transform.rotate ?? 0) / 90) % 4
  for (let i = 0; i < steps; i++) [sx, sz] = [sz, sx]
  return [sx, sy, sz]
}

/**
 * 区域内的**局部坐标**（0 起）经过变换后落在新区域的哪一格。
 *
 * 用的是"绕区域中心旋转/镜像"的口径，并且**刻意写成整数运算**：
 * 奇数尺寸时中心落在某一格上，偶数尺寸时中心落在两格之间，两种情况下
 * `size-1-p` 都精确地给出镜像格，**不会出现半格**。
 *
 * 90° 旋转的公式 `(x,z) → (sz-1-z, x)` 与矩阵那套是同一个旋转——这是复制粘贴
 * 与状态重映射必须共用的事实，各写一套迟早会对不上。
 */
export function transformLocalPoint(point: LocalPoint, size: Size3, transform: Transform): LocalPoint {
  let [x, y, z] = point
  let [sx, , sz] = size

  if (transform.mirror === 'x') x = sx - 1 - x
  else if (transform.mirror === 'z') z = sz - 1 - z
  // mirror 'y' 不动 x/z —— 这里只算水平落点，高度的镜像由调用方按区域高度处理

  const steps = Math.round((transform.rotate ?? 0) / 90) % 4
  for (let i = 0; i < steps; i++) {
    const nx = sz - 1 - z
    const nz = x
    x = nx
    z = nz
    ;[sx, sz] = [sz, sx]
  }
  void sx
  return [x, y, z]
}

/** 水平镜像轴到竖直镜像轴的转换：区域变换里的 `y` 镜像只影响高度。 */
export function transformLocalY(y: number, height: number, transform: Transform): number {
  return transform.mirror === 'y' ? height - 1 - y : y
}
