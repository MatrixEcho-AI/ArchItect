import type { Bounds, Pos, WorldStore } from '@architect/core'

/**
 * Wavefront `.obj` 导出。
 *
 * 用途是"把建筑丢进 Blender / 任何三维软件里看一眼"，所以取舍偏向**几何正确**而不是文件小：
 *
 * - 用 `registry.shapesOf(stateId)` 而不是"所有方块都是立方体"。楼梯是两块、栅栏是细柱、
 *   门是薄板——只画整块的 OBJ 会让楼梯变成实心台阶，看起来完全不是那回事。
 * - **面剔除只对实心立方体之间做**。非整块的形状（楼梯、台阶、栅栏）一律不剔——
 *   它们之间到底挡不挡得住要真正做 CSG 才能判定，猜错的代价是"模型上多了几个洞"，
 *   比多画几个面糟糕得多。
 * - 顶点去重：相邻方块的公共角点只写一次，文件能小一大截。
 *
 * 坐标系与 Minecraft 一致：**+X 东、+Y 上、+Z 南**，一个方块 = 一个单位，
 * 顶点落在方块最小角。导入软件后如果觉得是镜像的，那是 +Z 方向的定义差异，
 * 不是这里算错了。
 */

export interface ObjColor {
  r: number
  g: number
  b: number
}

export interface ObjExportOptions {
  region?: Bounds
  /** 按方块状态给颜色。给了才生成 `.mtl`，否则只有几何。 */
  colorOf?: (state: string, stateId: number) => ObjColor | undefined
  /** 是否在实心立方体之间剔除面（默认 true）。 */
  cullFaces?: boolean
  /** 顶点坐标小数位（默认 4）。 */
  precision?: number
  /** 以 `region.min` 为原点（默认 true）——导出的模型落在原点附近，进软件不用再挪。 */
  originAtZero?: boolean
  /**
   * `.mtl` 的文件名，写进 `mtllib` 那一行。
   *
   * **必须和实际写出的文件名一致**，否则模型能打开但全是灰的。
   * 默认 `model.mtl`；调用方写文件时应该把同一个名字传进来。
   */
  mtlName?: string
}

export interface ObjExportResult {
  obj: string
  mtl?: string
  /** 导出的方块数。 */
  blocks: number
  /** 写出的四边形面数。 */
  faces: number
  /** 去重后的顶点数。 */
  vertices: number
  materials: string[]
}

interface Quad {
  /** 4 个顶点在顶点表里的下标。 */
  indices: [number, number, number, number]
  material: string
}

export function exportObj(store: WorldStore, options: ObjExportOptions = {}): ObjExportResult {
  const region = options.region ?? store.contentBounds()
  if (region === undefined) throw new Error('世界是空的，没有可导出的内容')
  const precision = options.precision ?? 4
  const cull = options.cullFaces !== false
  const origin = options.originAtZero !== false ? region.min : { x: 0, y: 0, z: 0 }

  const vertices: number[] = []
  const vertexIndex = new Map<string, number>()
  const quads: Quad[] = []
  const materials = new Map<string, ObjColor | undefined>()
  let blocks = 0

  const round = (value: number): number => Number(value.toFixed(precision))
  const vertexOf = (x: number, y: number, z: number): number => {
    const key = `${round(x)},${round(y)},${round(z)}`
    const existing = vertexIndex.get(key)
    if (existing !== undefined) return existing
    const index = vertices.length / 3 + 1 // OBJ 顶点下标从 1 开始
    vertices.push(round(x), round(y), round(z))
    vertexIndex.set(key, index)
    return index
  }

  const at = (pos: Pos): number => store.getBlockStateId(pos)
  const solidAt = (pos: Pos): boolean => {
    const stateId = at(pos)
    if (stateId === 0) return false
    return store.registry.isFullCube(stateId)
  }

  for (let y = region.min.y; y <= region.max.y; y++) {
    for (let z = region.min.z; z <= region.max.z; z++) {
      for (let x = region.min.x; x <= region.max.x; x++) {
        const stateId = at({ x, y, z })
        if (stateId === 0) continue
        const shapes = store.registry.shapesOf(stateId)
        if (shapes.length === 0) continue
        blocks++

        const state = store.getBlockString({ x, y, z })
        const material = state.replace('minecraft:', '').replace(/[[\],=]/g, '_')
        if (!materials.has(material)) materials.set(material, options.colorOf?.(state, stateId))

        const fullCube = store.registry.isFullCube(stateId) && shapes.length === 1
        const base = { x: x - origin.x, y: y - origin.y, z: z - origin.z }

        for (const box of shapes) {
          const [bx0, by0, bz0, bx1, by1, bz1] = box
          const x0 = base.x + bx0
          const y0 = base.y + by0
          const z0 = base.z + bz0
          const x1 = base.x + bx1
          const y1 = base.y + by1
          const z1 = base.z + bz1

          // 六个面：只有"**整块**并排**整块**"才剔。见文件头说明。
          const skip = (dx: number, dy: number, dz: number): boolean =>
            cull && fullCube && solidAt({ x: x + dx, y: y + dy, z: z + dz })

          const push = (corners: readonly (readonly [number, number, number])[]): void => {
            const [a, b, c, d] = corners as [
              [number, number, number],
              [number, number, number],
              [number, number, number],
              [number, number, number],
            ]
            quads.push({
              indices: [vertexOf(...a), vertexOf(...b), vertexOf(...c), vertexOf(...d)],
              material,
            })
          }

          if (!skip(1, 0, 0)) {
            push([
              [x1, y0, z1],
              [x1, y0, z0],
              [x1, y1, z0],
              [x1, y1, z1],
            ])
          }
          if (!skip(-1, 0, 0)) {
            push([
              [x0, y0, z0],
              [x0, y0, z1],
              [x0, y1, z1],
              [x0, y1, z0],
            ])
          }
          if (!skip(0, 1, 0)) {
            push([
              [x0, y1, z1],
              [x1, y1, z1],
              [x1, y1, z0],
              [x0, y1, z0],
            ])
          }
          if (!skip(0, -1, 0)) {
            push([
              [x0, y0, z0],
              [x1, y0, z0],
              [x1, y0, z1],
              [x0, y0, z1],
            ])
          }
          if (!skip(0, 0, 1)) {
            push([
              [x0, y0, z1],
              [x1, y0, z1],
              [x1, y1, z1],
              [x0, y1, z1],
            ])
          }
          if (!skip(0, 0, -1)) {
            push([
              [x1, y0, z0],
              [x0, y0, z0],
              [x0, y1, z0],
              [x1, y1, z0],
            ])
          }
        }
      }
    }
  }

  const lines: string[] = [
    '# ArchItect OBJ export',
    `# ${region.max.x - region.min.x + 1}x${region.max.y - region.min.y + 1}x${region.max.z - region.min.z + 1} region, ${blocks} blocks`,
    '# +X east, +Y up, +Z south; one block = one unit',
  ]
  const hasMaterials = options.colorOf !== undefined && [...materials.values()].some((c) => c !== undefined)
  const mtlName = options.mtlName ?? 'model.mtl'
  if (hasMaterials) lines.push(`mtllib ${mtlName}`)

  for (let i = 0; i < vertices.length; i += 3) {
    lines.push(`v ${vertices[i]} ${vertices[i + 1]} ${vertices[i + 2]}`)
  }

  let currentMaterial: string | undefined
  for (const quad of quads) {
    if (hasMaterials && quad.material !== currentMaterial) {
      lines.push(`usemtl ${quad.material}`)
      currentMaterial = quad.material
    }
    lines.push(`f ${quad.indices.join(' ')}`)
  }

  const result: ObjExportResult = {
    obj: `${lines.join('\n')}\n`,
    blocks,
    faces: quads.length,
    vertices: vertices.length / 3,
    materials: [...materials.keys()],
  }
  if (hasMaterials) result.mtl = buildMtl(materials)
  return result
}

function buildMtl(materials: Map<string, ObjColor | undefined>): string {
  const lines = ['# ArchItect MTL export']
  for (const [name, color] of materials) {
    if (color === undefined) continue
    lines.push(`newmtl ${name}`, `Kd ${fmt(color.r)} ${fmt(color.g)} ${fmt(color.b)}`, 'Ka 0 0 0', 'Ks 0 0 0', 'd 1', 'illum 1')
  }
  return `${lines.join('\n')}\n`
}

/** 颜色是 0..255，MTL 要 0..1。 */
const fmt = (channel: number): string => (Math.max(0, Math.min(255, channel)) / 255).toFixed(4)
