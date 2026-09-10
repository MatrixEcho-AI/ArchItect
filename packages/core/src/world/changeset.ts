import type { Bounds, Pos } from '../types.js'

const INITIAL_CAPACITY = 1024

/**
 * 一次编辑产生的方块变更集。
 *
 * 用**并行类型化数组**而不是对象数组：一次 `fill_box` 可能改上百万格，
 * 对象数组（每格一个 `{x,y,z,from,to}`）会产生百万级小对象和巨大的 GC 压力。
 *
 * 这个结构同时也是 `.mcai` 里 `EditOp.patch` 的序列化格式——直接 `Buffer.from(view.buffer)` 落盘。
 */
export class ChangeSet {
  private xs: Int32Array
  private ys: Int32Array
  private zs: Int32Array
  private fromIds: Uint16Array
  private toIds: Uint16Array
  private count = 0

  private minX = 0
  private minY = 0
  private minZ = 0
  private maxX = 0
  private maxY = 0
  private maxZ = 0
  private hasBounds = false

  constructor(initialCapacity: number = INITIAL_CAPACITY) {
    const capacity = Math.max(1, initialCapacity)
    this.xs = new Int32Array(capacity)
    this.ys = new Int32Array(capacity)
    this.zs = new Int32Array(capacity)
    this.fromIds = new Uint16Array(capacity)
    this.toIds = new Uint16Array(capacity)
  }

  get length(): number {
    return this.count
  }

  get capacity(): number {
    return this.xs.length
  }

  push(x: number, y: number, z: number, from: number, to: number): void {
    if (this.count === this.xs.length) this.grow()
    const i = this.count++
    this.xs[i] = x
    this.ys[i] = y
    this.zs[i] = z
    this.fromIds[i] = from
    this.toIds[i] = to

    if (!this.hasBounds) {
      this.minX = this.maxX = x
      this.minY = this.maxY = y
      this.minZ = this.maxZ = z
      this.hasBounds = true
      return
    }
    if (x < this.minX) this.minX = x
    if (x > this.maxX) this.maxX = x
    if (y < this.minY) this.minY = y
    if (y > this.maxY) this.maxY = y
    if (z < this.minZ) this.minZ = z
    if (z > this.maxZ) this.maxZ = z
  }

  /** 逐条遍历变更（不分配对象）。 */
  forEach(visit: (x: number, y: number, z: number, from: number, to: number) => void): void {
    for (let i = 0; i < this.count; i++) {
      visit(this.xs[i]!, this.ys[i]!, this.zs[i]!, this.fromIds[i]!, this.toIds[i]!)
    }
  }

  at(index: number): { pos: Pos; from: number; to: number } {
    if (index < 0 || index >= this.count) throw new RangeError(`ChangeSet index ${index} out of range (length=${this.count})`)
    return {
      pos: { x: this.xs[index]!, y: this.ys[index]!, z: this.zs[index]! },
      from: this.fromIds[index]!,
      to: this.toIds[index]!,
    }
  }

  /** 受影响区域；空变更集返回 `undefined`。 */
  bounds(): Bounds | undefined {
    if (!this.hasBounds) return undefined
    return {
      min: { x: this.minX, y: this.minY, z: this.minZ },
      max: { x: this.maxX, y: this.maxY, z: this.maxZ },
    }
  }

  /** from/to 互换，用于撤销。 */
  inverted(): ChangeSet {
    const result = new ChangeSet(this.count)
    for (let i = 0; i < this.count; i++) {
      result.push(this.xs[i]!, this.ys[i]!, this.zs[i]!, this.toIds[i]!, this.fromIds[i]!)
    }
    return result
  }

  /** 零拷贝视图：`[x:i32][y:i32][z:i32][from:u16][to:u16]`，小端。 */
  toBuffer(): Buffer {
    const header = Buffer.allocUnsafe(8)
    header.writeUInt32LE(this.count, 0)
    header.writeUInt32LE(0, 4) // 保留位（后续版本可用于 flags）
    return Buffer.concat(
      [
        header,
        Buffer.from(this.xs.buffer, this.xs.byteOffset, this.count * 4),
        Buffer.from(this.ys.buffer, this.ys.byteOffset, this.count * 4),
        Buffer.from(this.zs.buffer, this.zs.byteOffset, this.count * 4),
        Buffer.from(this.fromIds.buffer, this.fromIds.byteOffset, this.count * 2),
        Buffer.from(this.toIds.buffer, this.toIds.byteOffset, this.count * 2),
      ],
      header.length + this.count * 16,
    )
  }

  static fromBuffer(buffer: Buffer): ChangeSet {
    // 用 DataView 而不是 Int32Array 视图：Buffer 可能来自内存池，byteOffset 不保证 4 字节对齐，
    // 而 `new Int32Array(buf.buffer, unalignedOffset)` 会直接抛错。
    const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength)
    if (view.byteLength < 8) throw new RangeError('ChangeSet buffer is too short, missing the 8-byte header')
    const count = view.getUint32(0, true)
    const expected = 8 + count * 16
    if (view.byteLength < expected) {
      throw new RangeError(`ChangeSet buffer length ${view.byteLength} is too short, need ${expected}`)
    }
    // 列式布局：x[] y[] z[] from[] to[]（与 toBuffer 一致，便于压缩）
    const xBase = 8
    const yBase = xBase + count * 4
    const zBase = yBase + count * 4
    const fromBase = zBase + count * 4
    const toBase = fromBase + count * 2

    const result = new ChangeSet(Math.max(1, count))
    for (let i = 0; i < count; i++) {
      result.push(
        view.getInt32(xBase + i * 4, true),
        view.getInt32(yBase + i * 4, true),
        view.getInt32(zBase + i * 4, true),
        view.getUint16(fromBase + i * 2, true),
        view.getUint16(toBase + i * 2, true),
      )
    }
    return result
  }

  private grow(): void {
    const next = this.xs.length * 2
    const xs = new Int32Array(next)
    const ys = new Int32Array(next)
    const zs = new Int32Array(next)
    const fromIds = new Uint16Array(next)
    const toIds = new Uint16Array(next)
    xs.set(this.xs)
    ys.set(this.ys)
    zs.set(this.zs)
    fromIds.set(this.fromIds)
    toIds.set(this.toIds)
    this.xs = xs
    this.ys = ys
    this.zs = zs
    this.fromIds = fromIds
    this.toIds = toIds
  }
}
