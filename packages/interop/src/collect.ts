import type { Bounds, WorldStore } from '@architect/core'

import { compoundFromJson, numberFromJson, NbtConversionError } from './json-nbt.js'
import type { SchematicBlockEntity, SchematicEntity } from './schematic.js'

/**
 * 世界 ↔ 交换格式之间**与格式无关的那一半**：把两层稀疏数据从世界里取出来、
 * 以及把文件里的附加数据翻译回模型的字段。
 *
 * 单独一个模块是因为 `.schem` 与 `.litematic` 在这里**完全一样**——位置的口径、
 * `yaw`/`pitch` 的换算、附加数据转不成 NBT 时要报出来。两份实现迟早会漂开，
 * 而漂开的表现是"同一个世界导出成两种格式，实体位置差一点"。
 */

/** `yaw` 的步长：0..15 一步 22.5°（plan D-82）。两种格式里旋转都只是附加数据。 */
export const YAW_STEP = 22.5

/** 一个位置所在的格是否落在闭区间里。**按格比，不按浮点比**——见 `insideFilter`。 */
export function cellInside(x: number, y: number, z: number, region: Bounds): boolean {
  const cx = Math.floor(x)
  const cy = Math.floor(y)
  const cz = Math.floor(z)
  return (
    cx >= region.min.x && cx <= region.max.x &&
    cy >= region.min.y && cy <= region.max.y &&
    cz >= region.min.z && cz <= region.max.z
  )
}

/**
 * 文件坐标是否在 `region` 过滤范围内（`region` 用的也是文件坐标）。
 *
 * **按格比，不按浮点比**：方块那一侧的判据是"格子 `z` 在 `[min.z, max.z]` 内"，
 * 而实体的 `z` 是浮点（4.5 表示第 4 格里的某个位置）。直接用浮点比的话，
 * `z = 4.5` 会被判成"超过 max.z = 4"而丢掉——而它的格子明明就在范围里。
 * 同一个区域选择对三层必须给出同样的答案。
 */
export function insideFilter(pos: readonly number[], filter: Bounds | undefined): boolean {
  if (filter === undefined) return true
  return cellInside(pos[0]!, pos[1]!, pos[2]!, filter)
}

/**
 * 统一成带命名空间的规范串。
 *
 * 我们模型里实体/方块实体类型只有一种写法（`minecraft:oak_boat`），而文件里两种都
 * 见得到。不统一的话，工具白名单、渲染模型表、导出写回会各自遇到"同一个东西的
 * 两个身份"。
 */
export const withNamespace = (id: string): string => (id.includes(':') ? id : `minecraft:${id}`)

/**
 * 实体的附加数据。
 *
 * 模型的 `yaw`/`pitch` 是一等字段，而两种交换格式里旋转都只是附加数据里的
 * `Rotation`。**`data.Rotation` 优先**：从外部文件读进来的那个才是原值
 * （可能写的是 189.3°，而我们的 `yaw` 是 22.5° 的步长，量化回去就毁了）；
 * 我们自己的实体没有它，才由 `yaw` 生成。两个方向因此都是无损的。
 */
export function entityExtra(entity: { yaw: number; pitch?: number; data?: Record<string, unknown> }): Record<string, unknown> {
  const data: Record<string, unknown> = { ...(entity.data ?? {}) }
  if (data['Rotation'] === undefined) {
    data['Rotation'] = [entity.yaw * YAW_STEP, entity.pitch ?? 0]
  }
  return data
}

/**
 * 从附加数据里的 `Rotation` 反推 `yaw`/`pitch`，并决定要不要把 `Rotation` 留在 `data` 里。
 *
 * 规则是"**只在量化真的会丢信息时才留原值**"：
 * - 文件的 yaw 正好落在 22.5° 的格点上（我们自己的导出永远是），就把它交给
 *   `yaw`/`pitch` 两个字段、从 `data` 里删掉——于是"导出 → 导入"逐字段相等；
 * - 落在格点之外（外部文件里的 189.3°），**原值留在 `data.Rotation` 里**，
 *   `yaw` 只是"最近的格点"这个给人看的近似。导出时 `data.Rotation` 优先，
 *   所以重新导出仍然写 189.3°——外部文件 → 我们 → 外部文件是无损的。
 */
export function rotationOf(data: Record<string, unknown>): { yaw: number; pitch?: number; keep: boolean } {
  const rotation = data['Rotation']
  const degrees = Array.isArray(rotation) ? numberFromJson(rotation[0]) : undefined
  const rawPitch = Array.isArray(rotation) ? numberFromJson(rotation[1]) : undefined
  if (degrees === undefined) return { yaw: 0, keep: false }
  const yaw = ((Math.round(degrees / YAW_STEP) % 16) + 16) % 16
  return {
    yaw,
    // 0 不写成字段：模型的 `pitch` 是可选的，"没有"与"0"在导出时等价
    ...(rawPitch !== undefined && rawPitch !== 0 ? { pitch: rawPitch } : {}),
    keep: degrees !== yaw * YAW_STEP,
  }
}

/**
 * 默认导出范围：**方块与两层稀疏数据的并集**。
 *
 * 只用 `contentBounds()` 会安静地漏掉悬在建筑之上的实体（船浮在水面上、盔甲架站在
 * 屋顶的栏杆外），因为那个包围盒只算方块。交换格式里没有"世界坐标"，
 * 范围之外的东西就是不在文件里——所以范围必须自己长到装得下。
 */
export function exportBoundsOf(store: WorldStore): Bounds | undefined {
  let box = store.contentBounds()
  const grow = (x: number, y: number, z: number): void => {
    const cell = { x: Math.floor(x), y: Math.floor(y), z: Math.floor(z) }
    if (box === undefined) {
      box = { min: { ...cell }, max: { ...cell } }
      return
    }
    box = {
      min: {
        x: Math.min(box.min.x, cell.x),
        y: Math.min(box.min.y, cell.y),
        z: Math.min(box.min.z, cell.z),
      },
      max: {
        x: Math.max(box.max.x, cell.x),
        y: Math.max(box.max.y, cell.y),
        z: Math.max(box.max.z, cell.z),
      },
    }
  }
  for (const entity of store.entities.list()) grow(entity.x, entity.y, entity.z)
  for (const entity of store.blockEntities.list()) grow(entity.x, entity.y, entity.z)
  return box
}

/**
 * 一条互操作问题。**本体是稳定的 code + 参数，不是一句话**：
 * 显示层（CLI / 桌面端）才用 `localizeProblem` 拼句子——与上下文裁剪的
 * `ContextReason` 同一个取舍。`interop` 不依赖 i18n，所以这里只声明结构。
 */
export interface InteropProblem {
  code: 'ENTITY_EXTRA_NOT_NBT' | 'BLOCK_ENTITY_EXTRA_NOT_NBT'
  params: { detail: string } & ({ id: string; type: string } | { kind: string; x: number; y: number; z: number })
}

export interface SparseExport {
  entities: SchematicEntity[]
  blockEntities: SchematicBlockEntity[]
  /**
   * 附加数据转不成 NBT 而**只导出了结构**的条目（code + 那一条的身份与原因参数）。
   *
   * 这一栏存在是因为"猜"在这里是错的：JSON 分不出 byte/short/int/float/double，
   * 猜出来的文件在游戏里是错的、而在这里看不出来。转不了就说出来，别假装成功。
   */
  problems: InteropProblem[]
}

/**
 * 把 `region` 范围内的两层稀疏数据取出来，位置换算成**相对 `region.min`** 的
 * 文件坐标（与方块同一个口径）。
 */
export function collectSparse(store: WorldStore, region: Bounds): SparseExport {
  const problems: InteropProblem[] = []
  const entities: SchematicEntity[] = []
  for (const entity of store.entities.list()) {
    if (!cellInside(entity.x, entity.y, entity.z, region)) continue
    const pos: [number, number, number] = [
      entity.x - region.min.x,
      entity.y - region.min.y,
      entity.z - region.min.z,
    ]
    const payload = entityExtra(entity)
    if (!canConvert(payload)) {
      // 结构照走：类型与位置还是能进游戏的，只有附加数据没有。**但上面已经报出来了**
      problems.push({
        code: 'ENTITY_EXTRA_NOT_NBT',
        params: { id: entity.id, type: entity.type, detail: conversionProblemOf(payload) },
      })
      entities.push({ id: entity.type, pos, data: {} })
      continue
    }
    entities.push({ id: entity.type, pos, data: payload })
  }

  const blockEntities: SchematicBlockEntity[] = []
  for (const entity of store.blockEntities.list()) {
    if (!cellInside(entity.x, entity.y, entity.z, region)) continue
    const pos: [number, number, number] = [
      entity.x - region.min.x,
      entity.y - region.min.y,
      entity.z - region.min.z,
    ]
    if (!canConvert(entity.data)) {
      problems.push({
        code: 'BLOCK_ENTITY_EXTRA_NOT_NBT',
        params: { kind: entity.kind, x: entity.x, y: entity.y, z: entity.z, detail: conversionProblemOf(entity.data) },
      })
      blockEntities.push({ id: entity.kind, pos, data: {} })
      continue
    }
    blockEntities.push({ id: entity.kind, pos, data: entity.data })
  }

  return { entities, blockEntities, problems }
}

/**
 * 提前试转一次，好把"转不了"**定位到具体那一条**。
 *
 * 不这么做的话，失败会在写到 NBT 那一刻抛出，于是只能整份重写一遍、把所有条目的
 * 附加数据都摘掉——一条坏数据连累另外几十条，而报告里也说不清是谁。
 */
export function canConvert(data: Record<string, unknown>): boolean {
  try {
    compoundFromJson(data)
    return true
  } catch (error) {
    if (error instanceof NbtConversionError) return false
    throw error
  }
}

export function conversionProblemOf(data: Record<string, unknown>): string {
  try {
    compoundFromJson(data)
    return ''
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
}
