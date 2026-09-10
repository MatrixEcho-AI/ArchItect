import { unzlibSync, zlibSync } from 'fflate'

/** `world/base.mcvox` 的内存形态。 */
export interface Snapshot {
  minY: number
  worldHeight: number
  paletteSize: number
  columns: Array<{ chunkX: number; chunkZ: number; indices: Uint16Array }>
}

const MAGIC = [0x4d, 0x43, 0x41, 0x56, 0x4f, 0x58, 0x00, 0x00] // "MCAVOX\0\0"
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
  if (worldHeight <= 0) throw new SnapshotError(`worldHeight 必须为正，收到 ${worldHeight}`)
  if (paletteSize > 0x10000) {
    throw new SnapshotError(`调色板有 ${paletteSize} 项，超出 uint16 上限`)
  }

  const perColumn = 8 + worldHeight * 256 * 2
  const body = new Uint8Array(columns.length * perColumn)
  const bodyView = new DataView(body.buffer)
  let offset = 0
  for (const column of columns) {
    const expected = worldHeight * 256
    if (column.indices.length !== expected) {
      throw new SnapshotError(
        `列 (${column.chunkX},${column.chunkZ}) 有 ${column.indices.length} 个索引，期望 ${expected}`,
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
    throw new SnapshotError(`base.mcvox 只有 ${bytes.length} 字节，连头部都不够`)
  }
  for (let i = 0; i < MAGIC.length; i++) {
    if (bytes[i] !== MAGIC[i]) throw new SnapshotError('base.mcvox 魔数不匹配，不是本程序写出的快照')
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const version = view.getUint32(8, true)
  if (version !== SNAPSHOT_VERSION) {
    throw new SnapshotError(`快照版本 ${version} 不受支持（本程序支持 ${SNAPSHOT_VERSION}）`)
  }
  const minY = view.getInt32(12, true)
  const worldHeight = view.getUint32(16, true)
  const paletteSize = view.getUint32(20, true)
  const columnCount = view.getUint32(24, true)
  if (worldHeight === 0) throw new SnapshotError('快照的 worldHeight 为 0')
  if (paletteSize === 0) throw new SnapshotError('快照的 paletteSize 为 0（调色板至少要含 air）')

  const perColumn = 8 + worldHeight * 256 * 2
  const body = unzlibSync(bytes.subarray(HEADER_BYTES))
  if (body.length !== columnCount * perColumn) {
    throw new SnapshotError(
      `快照正文有 ${body.length} 字节，按 ${columnCount} 列 × ${perColumn} 字节应为 ${columnCount * perColumn}`,
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
