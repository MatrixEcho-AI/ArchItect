import { createHash } from 'node:crypto'

import { normalizeBounds } from '../geometry/box.js'
import { AIR_STATE_ID, Palette } from '../palette.js'
import { loadRegistry } from '../registry.js'
import type { BlockRegistry } from '../registry.js'
import { stateIdToString } from '../state.js'
import type { Bounds, Pos } from '../types.js'
import { ChangeSet } from './changeset.js'
import { createChunkColumn, toColumnLocal, VANILLA_MIN_Y, VANILLA_WORLD_HEIGHT } from './column.js'
import type { ChunkColumn } from './column.js'

export type WriteMode =
  /** 无条件覆盖。 */
  | 'replace'
  /** 只在空气处写入（不破坏已有内容）。 */
  | 'keep'
  /** 只覆盖非空气（给已有结构"上色"）。 */
  | 'overlay'
  /** 删除：命中的方块变成空气，忽略写入方块。 */
  | 'destroy'

/** 位置生产者：零分配地流式产出坐标，避免把上百万个 `Pos` 先物化成数组。 */
export type PositionProducer = (visit: (x: number, y: number, z: number) => void) => void

/** 方块生产者：每格自带调色板索引，供搬运类操作（镜像 / 复制）使用。 */
export type BlockProducer = (
  emit: (x: number, y: number, z: number, blockIndex: number) => void,
) => void

export interface WriteOptions {
  mode?: WriteMode
  /** 影响格数超过 `confirmThreshold` 时必须显式确认。 */
  confirm?: boolean
  confirmThreshold?: number
  /** 单次操作影响格数的硬上限，超过直接拒绝（防止 OOM）。 */
  hardLimit?: number
}

export interface WritePreview {
  willChange: number
  willOverwriteNonAir: number
  clipped: number
  /** 被覆盖方块的名字 → 数量（按数量降序）。 */
  overwriteBreakdown: Record<string, number>
  sample: Pos[]
  /** 扫描是否因触到硬上限而提前中止（此时计数是下界）。 */
  truncated: boolean
}

export type WriteResult =
  | {
      ok: true
      revision: number
      changed: number
      overwrittenNonAir: number
      clipped: number
      bounds: Bounds | undefined
      /** 精确的方块变更。工具层据此生成 `EditOp` 记进事件日志。 */
      changeSet: ChangeSet
    }
  | { ok: false; reason: 'NEEDS_CONFIRM' | 'TOO_LARGE'; preview: WritePreview }

export const DEFAULT_CONFIRM_THRESHOLD = 50_000
export const DEFAULT_HARD_LIMIT = 4_000_000
const SAMPLE_LIMIT = 20

export interface WorldStoreOptions {
  minecraftVersion: string
  /** 工区（可写边界）。**没有人为的尺寸上限**——这是项目级设置。 */
  volume: Bounds
  palette?: Palette
  minY?: number
  worldHeight?: number
}

const columnKey = (x: number, z: number): string => `${x >> 4},${z >> 4}`

/**
 * 世界状态。**唯一允许写方块的地方**——工区约束、变更记录、撤销、dry-run 预算都在这一层。
 *
 * 底层是 `prismarine-chunk` 的 `ChunkColumn`（每格 uint16 全局 stateId），
 * 因此与渲染 mesher、`.schem` 导出、chunk 协议零转换。
 * chunk 列**惰性分配**：没写过的列不占内存（约 27 KB/列）。
 */
export class WorldStore {
  readonly registry: BlockRegistry
  readonly palette: Palette
  readonly volume: Bounds
  readonly minY: number
  readonly maxY: number

  private readonly columns = new Map<string, ChunkColumn>()
  private undoStack: ChangeSet[] = []
  private redoStack: ChangeSet[] = []
  private currentRevision = 0

  constructor(options: WorldStoreOptions) {
    this.registry = loadRegistry(options.minecraftVersion)
    this.palette = options.palette ?? new Palette(this.registry)
    this.minY = options.minY ?? VANILLA_MIN_Y
    const worldHeight = options.worldHeight ?? VANILLA_WORLD_HEIGHT
    this.maxY = this.minY + worldHeight - 1

    const normalized = normalizeBounds(options.volume.min, options.volume.max)
    this.volume = {
      min: { x: normalized.min.x, y: Math.max(normalized.min.y, this.minY), z: normalized.min.z },
      max: { x: normalized.max.x, y: Math.min(normalized.max.y, this.maxY), z: normalized.max.z },
    }
    if (this.volume.min.y > this.volume.max.y) {
      throw new RangeError(
        `Volume Y range ${normalized.min.y}..${normalized.max.y} does not intersect world height ${this.minY}..${this.maxY}`,
      )
    }
  }

  /**
   * **游标**：世界现在对应事件日志上的第几个版本（0 = 空白，N = 应用了前 N 条 op）。
   *
   * 它**不是**单调递增的计数器——`ReplaySession.seek()` 与 `revertLastWrite()`
   * 都会让它变小。所以任何"用 revision 当唯一键"的缓存，都要能接受同一个键
   * 对应同一份内容（这正是它可用的原因：revision 一一对应一个世界状态）。
   */
  get revision(): number {
    return this.currentRevision
  }

  /** 已分配的 chunk 列数——内存占用的直接指标（约 27 KB/列）。 */
  get allocatedColumns(): number {
    return this.columns.size
  }

  /** 读取全局 stateId；世界高度之外或未分配的列一律是空气。 */
  getBlockStateId(pos: Pos): number {
    if (pos.y < this.minY || pos.y > this.maxY) return AIR_STATE_ID
    const column = this.columns.get(columnKey(pos.x, pos.z))
    if (column === undefined) return AIR_STATE_ID
    // ChunkColumn 吃的是区块本地坐标（见 column.ts 的警告）
    return column.getBlockStateId({ x: toColumnLocal(pos.x), y: pos.y, z: toColumnLocal(pos.z) })
  }

  /** 读取方块的规范状态字符串。 */
  getBlockString(pos: Pos): string {
    const stateId = this.getBlockStateId(pos)
    const block = this.registry.blockByStateId(stateId)
    return block === undefined ? 'minecraft:air' : stateIdToString(block, stateId)
  }

  isAir(pos: Pos): boolean {
    return this.getBlockStateId(pos) === AIR_STATE_ID
  }

  /** 某格在**本项目调色板**中的索引。 */
  paletteIndexOf(pos: Pos): number {
    return this.blockIndexForStateId(this.getBlockStateId(pos))
  }

  /** 全局 stateId → 本项目调色板索引。未知方块按需加入调色板（不会丢信息）。 */
  blockIndexForStateId(stateId: number): number {
    const block = this.registry.blockByStateId(stateId)
    if (block === undefined) return 0
    return this.palette.indexOfCanonical(stateIdToString(block, stateId))
  }

  /** 单格写入。内部走 `write()`，所以同样有工区约束与撤销支持。 */
  setBlock(pos: Pos, block: string, mode: WriteMode = 'replace'): WriteResult {
    return this.write((visit) => visit(pos.x, pos.y, pos.z), this.palette.indexOf(block), {
      mode,
      confirm: true,
    })
  }

  /**
   * 批量写入**同一种**方块。
   *
   * **先扫描定型、再决定是否提交**：超过 `confirmThreshold` 时返回 dry-run 预览而不落盘，
   * 这样 LLM 必须先说明"要覆盖什么、为什么可以覆盖"才能继续（见 plan §9.4 机制 3）。
   */
  write(produce: PositionProducer, blockIndex: number, options: WriteOptions = {}): WriteResult {
    return this.writeBlocks((emit) => produce((x, y, z) => emit(x, y, z, blockIndex)), options)
  }

  /**
   * 批量写入**每格可以不同**的方块。
   *
   * `symmetrize` / `copy_region` 这类搬运操作需要它——它们把读到的方块原样复制到新位置，
   * 而不是刷成单一材质。
   */
  writeBlocks(produce: BlockProducer, options: WriteOptions = {}): WriteResult {
    const mode = options.mode ?? 'replace'
    const confirmThreshold = options.confirmThreshold ?? DEFAULT_CONFIRM_THRESHOLD
    const hardLimit = options.hardLimit ?? DEFAULT_HARD_LIMIT
    // ⚠️ `table` **不能**在 produce 之前定格。生产者完全可能在吐格子的过程中把新方块
    // 加进调色板（`blockIndexForStateId` 就是这么干的），定格下来的旧表就没有那一项，
    // 于是抛 `Palette index N does not exist` —— 一个纯属实现细节的错误，
    // 而且只在"要写的方块此前没见过"时出现（`fixStates` 生成新 state 时必踩）。
    // 调色板自己会维护缓存，所以只在真的越界时重建一次。
    let table = this.palette.toGlobalStateIds()

    const changes = new ChangeSet(1024)
    const breakdown = new Map<string, number>()
    const sample: Pos[] = []
    let clipped = 0
    let overwrittenNonAir = 0
    let truncated = false

    produce((x, y, z, blockIndex) => {
      if (truncated) return
      if (blockIndex >= table.length) table = this.palette.toGlobalStateIds()
      const targetStateId = table[blockIndex]
      if (targetStateId === undefined) {
        throw new RangeError(`Palette index ${blockIndex} does not exist (size=${this.palette.size})`)
      }
      const writeStateId = mode === 'destroy' ? AIR_STATE_ID : targetStateId

      if (!this.insideVolume(x, y, z)) {
        clipped++
        return
      }
      const from = this.getBlockStateId({ x, y, z })
      if (!accepts(mode, from, writeStateId)) return
      if (from === writeStateId) return

      if (from !== AIR_STATE_ID) {
        overwrittenNonAir++
        const name = this.registry.blockByStateId(from)?.name ?? `stateId:${from}`
        breakdown.set(name, (breakdown.get(name) ?? 0) + 1)
      }
      if (sample.length < SAMPLE_LIMIT) sample.push({ x, y, z })
      changes.push(x, y, z, from, writeStateId)

      if (changes.length > hardLimit) truncated = true
    })

    const preview: WritePreview = {
      willChange: changes.length,
      willOverwriteNonAir: overwrittenNonAir,
      clipped,
      overwriteBreakdown: Object.fromEntries([...breakdown.entries()].sort((a, b) => b[1] - a[1])),
      sample,
      truncated,
    }

    if (truncated) return { ok: false, reason: 'TOO_LARGE', preview }
    if (changes.length > confirmThreshold && options.confirm !== true) {
      return { ok: false, reason: 'NEEDS_CONFIRM', preview }
    }

    // 空操作不提交、不递增 revision。
    // revision 是截图缓存与 stale 判断的键，无谓地 +1 会让所有缓存失效。
    if (changes.length > 0) {
      this.applyChangeSet(changes)
      this.undoStack.push(changes)
      this.redoStack = []
      this.currentRevision++
    }

    return {
      ok: true,
      revision: this.currentRevision,
      changed: changes.length,
      overwrittenNonAir,
      clipped,
      bounds: changes.bounds(),
      changeSet: changes,
    }
  }

  /**
   * 在内存里回退**最近一次写入**。返回被回滚的格数（0 表示没有可回退的）。
   *
   * ⚠️ **这不是事件溯源意义上的"撤销"**。事件日志上的撤销是**游标移动**
   * （`ReplaySession.undo()`）：不产生新 op，只把世界重放到前一个版本。
   * 两者不能混用，也不能互相替代：
   *
   * - 这个方法只认**本对象**的写入栈。`ReplaySession.seek()`（时间旅行、打开工程）
   *   会 `clear()` 掉世界与那个栈，于是它此后一律返回 0。
   * - 早期把它当成"撤销"用，结果是版本号被它 +1 而日志没变——`revision` 与
   *   `log.length` 就此脱节，重放、时间线、`.mcai` 往返全都对不上。
   *
   * 名字故意写得难听：它是给"写完立刻反悔"这类**局部**场景（脚本、测试、
   * 一次性试算）用的，不该出现在设计流程里。
   */
  revertLastWrite(): number {
    const changeSet = this.undoStack.pop()
    if (changeSet === undefined) return 0
    this.applyChangeSet(changeSet.inverted())
    this.redoStack.push(changeSet)
    // 版本号要跟着**退**：它是"世界现在对应哪个版本"的游标，不是单调计数器
    if (this.currentRevision > 0) this.currentRevision--
    return changeSet.length
  }

  /** 重新应用被 `revertLastWrite()` 回退掉的那一次写入。返回重放的格数。 */
  reapplyReverted(): number {
    const changeSet = this.redoStack.pop()
    if (changeSet === undefined) return 0
    this.applyChangeSet(changeSet)
    this.undoStack.push(changeSet)
    this.currentRevision++
    return changeSet.length
  }

  /** 有没有可以 `revertLastWrite()` 的写入。 */
  get canRevertLastWrite(): boolean {
    return this.undoStack.length > 0
  }

  /** 有没有可以 `reapplyReverted()` 的写入。 */
  get canReapplyReverted(): boolean {
    return this.redoStack.length > 0
  }

  /**
   * 直接写入一个变更集，**不记录历史、不递增 revision**。
   *
   * 这是给 replay 和"打开项目"用的旁路：重放时我们按 op 流逐条落盘，
   * 历史与版本号由 `EditLog` 负责，不需要世界再记一份。
   */
  applyPatch(changes: ChangeSet): void {
    this.applyChangeSet(changes)
  }

  /** 把版本号设成给定值（replay 结束后对齐用）。 */
  setRevision(value: number): void {
    this.currentRevision = value
  }

  /** 清空世界与历史。 */
  clear(): void {
    this.columns.clear()
    this.undoStack = []
    this.redoStack = []
    this.currentRevision = 0
  }

  /**
   * 世界内容的确定性哈希（sha256）。
   *
   * 遍历顺序固定为「chunk 列键排序 → y → z → x」，所以同样的世界必然得到同样的哈希。
   * 这是 M2 的核心不变式的判据：**增量构建的结果必须与 replay 的结果哈希相等**。
   *
   * 注意是全量扫描，只在保存 / 测试 / 校验时调用。
   */
  contentHash(): string {
    const hash = createHash('sha256')
    const record = Buffer.allocUnsafe(16) // x:i32 | y:i32 | z:i32 | stateId:u16 | pad:u16
    for (const key of [...this.columns.keys()].sort()) {
      const column = this.columns.get(key)!
      const [cx, cz] = key.split(',').map(Number) as [number, number]
      const baseX = cx * 16
      const baseZ = cz * 16

      // 空列（分配过但内容全空，例如撤销之后）不参与哈希——
      // 哈希必须反映**内容**，不是内存分配状态。
      if (this.columnIsEmpty(column)) continue

      hash.update(`#${cx},${cz}\n`)
      for (let y = this.minY; y <= this.maxY; y++) {
        for (let z = 0; z < 16; z++) {
          for (let x = 0; x < 16; x++) {
            const stateId = column.getBlockStateId({ x, y, z })
            if (stateId === AIR_STATE_ID) continue
            record.writeInt32LE(baseX + x, 0)
            record.writeInt32LE(y, 4)
            record.writeInt32LE(baseZ + z, 8)
            record.writeUInt16LE(stateId, 12)
            record.writeUInt16LE(0, 14)
            hash.update(record)
          }
        }
      }
    }
    return hash.digest('hex')
  }

  /**
   * 丢弃内容全空的 chunk 列，回收内存。
   *
   * 撤销与 `destroy` 会留下"分配过但全空"的列（每列约 27 KB）。保存前调一次即可。
   */
  compact(): number {
    let dropped = 0
    for (const [key, column] of [...this.columns]) {
      if (this.columnIsEmpty(column)) {
        this.columns.delete(key)
        dropped++
      }
    }
    return dropped
  }

  private columnIsEmpty(column: ChunkColumn): boolean {
    for (let y = this.minY; y <= this.maxY; y++) {
      for (let z = 0; z < 16; z++) {
        for (let x = 0; x < 16; x++) {
          if (column.getBlockStateId({ x, y, z }) !== AIR_STATE_ID) return false
        }
      }
    }
    return true
  }

  /** 世界的 Y 跨度。 */
  get worldHeight(): number {
    return this.maxY - this.minY + 1
  }

  /**
   * 导出全量快照，每列一个 `Uint16Array`（**项目调色板索引**，不是全局 stateId）。
   *
   * 索引布局是 `y 外层 → z → x 内层`，与 `contentHash` 的遍历顺序一致。
   * 只导出非空列。这是 `.mcai` 里 `world/base.mcvox` 的内存形态。
   */
  dumpColumns(): Array<{ chunkX: number; chunkZ: number; indices: Uint16Array }> {
    const out: Array<{ chunkX: number; chunkZ: number; indices: Uint16Array }> = []
    for (const key of [...this.columns.keys()].sort()) {
      const column = this.columns.get(key)!
      if (this.columnIsEmpty(column)) continue
      const [chunkX, chunkZ] = key.split(',').map(Number) as [number, number]
      const indices = new Uint16Array(this.worldHeight * 256)
      let i = 0
      for (let y = this.minY; y <= this.maxY; y++) {
        for (let z = 0; z < 16; z++) {
          for (let x = 0; x < 16; x++) {
            indices[i++] = this.blockIndexForStateId(column.getBlockStateId({ x, y, z }))
          }
        }
      }
      out.push({ chunkX, chunkZ, indices })
    }
    return out
  }

  /**
   * 从快照恢复（会**清空**当前世界与历史）。
   *
   * `indices` 里的调色板索引必须先存在于 `this.palette` 中——
   * 打开项目时要先加载 `palette.json`，再调这个方法。
   */
  restoreColumns(
    columns: Iterable<{ chunkX: number; chunkZ: number; indices: Uint16Array }>,
    revision = 0,
  ): void {
    const table = this.palette.toGlobalStateIds()
    const expected = this.worldHeight * 256
    this.clear()
    for (const { chunkX, chunkZ, indices } of columns) {
      if (indices.length !== expected) {
        throw new RangeError(
          `Column (${chunkX},${chunkZ}) has ${indices.length} indices, expected ${expected} (world height ${this.worldHeight})`,
        )
      }
      const column = createChunkColumn(this.registry.minecraftVersion, {
        minY: this.minY,
        worldHeight: this.worldHeight,
      })
      let i = 0
      for (let y = this.minY; y <= this.maxY; y++) {
        for (let z = 0; z < 16; z++) {
          for (let x = 0; x < 16; x++) {
            const paletteIndex = indices[i++]!
            const stateId = table[paletteIndex]
            if (stateId === undefined) {
              throw new RangeError(`Column (${chunkX},${chunkZ}) references a nonexistent palette index ${paletteIndex}`)
            }
            if (stateId !== AIR_STATE_ID) column.setBlockStateId({ x, y, z }, stateId)
          }
        }
      }
      this.columns.set(`${chunkX},${chunkZ}`, column)
    }
    this.setRevision(revision)
  }

  /**
   * 世界内容的包围盒（忽略空气）。
   *
   * 注意：这是 O(列 × 16 × 16 × 高度) 的全量扫描，只在需要时调用，
   * 不要放进每次编辑的热路径。
   */
  contentBounds(): Bounds | undefined {
    let minX = 0
    let minY = 0
    let minZ = 0
    let maxX = 0
    let maxY = 0
    let maxZ = 0
    let found = false

    this.forEachNonAir((x, y, z) => {
      if (!found) {
        minX = maxX = x
        minY = maxY = y
        minZ = maxZ = z
        found = true
        return
      }
      if (x < minX) minX = x
      if (x > maxX) maxX = x
      if (y < minY) minY = y
      if (y > maxY) maxY = y
      if (z < minZ) minZ = z
      if (z > maxZ) maxZ = z
    })

    return found ? { min: { x: minX, y: minY, z: minZ }, max: { x: maxX, y: maxY, z: maxZ } } : undefined
  }

  /** 非空气方块总数与内存指标。同样是全量扫描。 */
  stats(): { blocks: number; columns: number; approximateBytes: number } {
    let blocks = 0
    this.forEachNonAir(() => blocks++)
    return { blocks, columns: this.columns.size, approximateBytes: this.columns.size * 27 * 1024 }
  }

  /** 逐格遍历所有非空气方块。 */
  forEachNonAir(visit: (x: number, y: number, z: number, stateId: number) => void): void {
    for (const [key, column] of this.columns) {
      const [cx, cz] = key.split(',').map(Number) as [number, number]
      const baseX = cx * 16
      const baseZ = cz * 16
      for (let x = 0; x < 16; x++) {
        for (let z = 0; z < 16; z++) {
          // 这里 x/z 本来就是本地坐标，直接用；换算成世界坐标只用于回调
          for (let y = this.minY; y <= this.maxY; y++) {
            const stateId = column.getBlockStateId({ x, y, z })
            if (stateId !== AIR_STATE_ID) visit(baseX + x, y, baseZ + z, stateId)
          }
        }
      }
    }
  }

  /**
   * 这一格在工区里吗？
   *
   * 公开出来是给**界面**用的：人手接管时"能不能放在这儿"要在点击那一刻就答出来
   * （放在工区外会被 `write` 裁掉，而"点了没反应"是最难查的一种反馈）。
   */
  contains(pos: Pos): boolean {
    return this.insideVolume(pos.x, pos.y, pos.z)
  }

  private insideVolume(x: number, y: number, z: number): boolean {
    return (
      x >= this.volume.min.x &&
      x <= this.volume.max.x &&
      y >= this.volume.min.y &&
      y <= this.volume.max.y &&
      z >= this.volume.min.z &&
      z <= this.volume.max.z
    )
  }

  private applyChangeSet(changes: ChangeSet): void {
    changes.forEach((x, y, z, _from, to) => {
      const key = columnKey(x, z)
      let column = this.columns.get(key)
      if (column === undefined) {
        // 往未分配的列写空气 = 无操作，不要白白分配 27 KB
        if (to === AIR_STATE_ID) return
        column = createChunkColumn(this.registry.minecraftVersion, {
          minY: this.minY,
          worldHeight: this.maxY - this.minY + 1,
        })
        this.columns.set(key, column)
      }
      column.setBlockStateId({ x: toColumnLocal(x), y, z: toColumnLocal(z) }, to)
    })
  }
}

function accepts(mode: WriteMode, from: number, to: number): boolean {
  switch (mode) {
    case 'replace':
      return true
    case 'keep':
      return from === AIR_STATE_ID
    case 'overlay':
      return from !== AIR_STATE_ID
    case 'destroy':
      return from !== AIR_STATE_ID && to === AIR_STATE_ID
  }
}
