import { unzlibSync, zlibSync } from 'fflate'

/** `world/base.mcvox` 的内存形态。 */
export interface Snapshot {
  minY: number
  worldHeight: number
  paletteSize: number
  columns: Array<{ chunkX: number; chunkZ: number; indices: Uint16Array }>
}

const MAGIC = [0x4d, 0x43, 0x41, 0x56, 0x4f, 0x58, 0x00, 0x00] // "MCAVOX\0\0"
/**
 * 快照正文解压后的上限。
 *
 * 真实工程远小于此——单次写入的硬上限是 400 万格，密排的快照正文也就十几 MB。
 * 这个值挡的是「用表头声明换内存」：全零数据的压缩比约 1000×。
 */
const MAX_SNAPSHOT_BYTES = 256 * 1024 * 1024

const SNAPSHOT_VERSION = 1
const HEADER_BYTES = 32

export class SnapshotError extends Error {
  override readonly name = 'SnapshotError'
}

/**
 * 序列化基准快照。
 *
 * ```
 * header (32 bytes)
 *   magic[8] | version:u32 | minY:i32 | worldHeight:u32 | paletteSize:u32 | columnCount:u32 | reserved:u32
 * body = zlib( for each column: chunkX:i32 | chunkZ:i32 | indices:u16[worldHeight*256] )
 * ```
 *
 * 方块存的是**项目调色板索引**而不是全局 stateId，所以快照跨 Minecraft 版本可迁移
 * （见 plan §4.5：全局 stateId 在 1.16 与 1.21 之间完全不stable）。
 */
export function encodeSnapshot(snapshot: Snapshot): Uint8Array {
  const { minY, worldHeight, paletteSize, columns } = snapshot
  if (worldHeight <= 0) throw new SnapshotError(`worldHeight must be positive, got ${worldHeight}`)
  if (paletteSize > 0x10000) {
    throw new SnapshotError(`The palette has ${paletteSize} entries, over the uint16 limit`)
  }

  const perColumn = 8 + worldHeight * 256 * 2
  const body = new Uint8Array(columns.length * perColumn)
  const bodyView = new DataView(body.buffer)
  let offset = 0
  for (const column of columns) {
    const expected = worldHeight * 256
    if (column.indices.length !== expected) {
      throw new SnapshotError(
        `Column (${column.chunkX},${column.chunkZ}) has ${column.indices.length} indices, expected ${expected}`,
      )
    }
    bodyView.setInt32(offset, column.chunkX, true)
    bodyView.setInt32(offset + 4, column.chunkZ, true)
    offset += 8
    for (let i = 0; i < expected; i++) {
      bodyView.setUint16(offset + i * 2, column.indices[i]!, true)
    }
    offset += expected * 2
  }

  const compressed = zlibSync(body, { level: 6 })
  const out = new Uint8Array(HEADER_BYTES + compressed.length)
  const view = new DataView(out.buffer)
  out.set(MAGIC, 0)
  view.setUint32(8, SNAPSHOT_VERSION, true)
  view.setInt32(12, minY, true)
  view.setUint32(16, worldHeight, true)
  view.setUint32(20, paletteSize, true)
  view.setUint32(24, columns.length, true)
  view.setUint32(28, 0, true)
  out.set(compressed, HEADER_BYTES)
  return out
}

export function decodeSnapshot(bytes: Uint8Array): Snapshot {
  if (bytes.length < HEADER_BYTES) {
    throw new SnapshotError(`base.mcvox is only ${bytes.length} bytes, too short for a header`)
  }
  for (let i = 0; i < MAGIC.length; i++) {
    if (bytes[i] !== MAGIC[i]) throw new SnapshotError('base.mcvox has the wrong magic number, so this program did not write it')
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const version = view.getUint32(8, true)
  if (version !== SNAPSHOT_VERSION) {
    throw new SnapshotError(`Snapshot version ${version} is not supported (this program writes ${SNAPSHOT_VERSION})`)
  }
  const minY = view.getInt32(12, true)
  const worldHeight = view.getUint32(16, true)
  const paletteSize = view.getUint32(20, true)
  const columnCount = view.getUint32(24, true)
  if (worldHeight === 0) throw new SnapshotError('The snapshot worldHeight is 0')
  if (paletteSize === 0) throw new SnapshotError('The snapshot paletteSize is 0; a palette holds at least air')

  const perColumn = 8 + worldHeight * 256 * 2
  // **按表头算出来的期望长度预分配输出缓冲**，而不是让它自己解到输入耗尽。
  //
  // 全零数据的压缩比约 1000×：几十 KB 的快照就能解出几百 MB，而那是 V8 致命
  // OOM、不是可捕获的异常。期望长度这里本来就要算、下一行本来也要比对，所以
  // 这个上限对合法文件永远成立。
  //
  // 用 `out` 而不是什么长度参数：fflate 没有那个参数（`packages/mcai` 走 fflate 是
  // 为了能在渲染进程里跑，不能换成 node:zlib）。给了 `out` 之后最多只写这么多字节，
  // 真出现更长的数据会被截掉，紧接着的长度比对就会报错。
  const expected = columnCount * perColumn
  if (expected > MAX_SNAPSHOT_BYTES) {
    throw new SnapshotError(`The snapshot declares ${expected} bytes of body, over the ${MAX_SNAPSHOT_BYTES}-byte limit`)
  }
  const body = unzlibSync(bytes.subarray(HEADER_BYTES), { out: new Uint8Array(expected) })
  if (body.length !== columnCount * perColumn) {
    throw new SnapshotError(
      `The snapshot body is ${body.length} bytes; ${columnCount} columns x ${perColumn} bytes is ${columnCount * perColumn}`,
    )
  }

  const bodyView = new DataView(body.buffer, body.byteOffset, body.byteLength)
  const columns: Snapshot['columns'] = []
  let offset = 0
  for (let c = 0; c < columnCount; c++) {
    const chunkX = bodyView.getInt32(offset, true)
    const chunkZ = bodyView.getInt32(offset + 4, true)
    offset += 8
    const indices = new Uint16Array(worldHeight * 256)
    for (let i = 0; i < indices.length; i++) {
      indices[i] = bodyView.getUint16(offset + i * 2, true)
    }
    offset += indices.length * 2
    columns.push({ chunkX, chunkZ, indices })
  }

  return { minY, worldHeight, paletteSize, columns }
}
