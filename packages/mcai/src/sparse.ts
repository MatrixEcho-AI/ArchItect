import { MAX_BLOCK_ENTITIES, MAX_ENTITIES } from '@architect/core'
import type { PlacedBlockEntity, PlacedEntity } from '@architect/core'

import { McaiFormatError } from './manifest.js'

/**
 * 两层稀疏数据的**基快照**编解码（`world/entities.jsonl` / `world/block-entities.jsonl`）。
 *
 * 为什么是 JSONL 而不是像 `base.mcvox` 那样的紧凑二进制：方块层是百万级稠密格，
 * 每格 16 字节，压不动；这两层是几十到几千个对象，每个还带着开放的 `data`。
 * 为它们设计二进制格式只会换来一堆解析代码和一个更难的调试过程（plan D-79）。
 *
 * 空集合写成**空字符串**，而调用方据此**不写这个条目**——与"打开时缺了就当空"
 * 对称，也让没用到这两层的工程字节完全不变。
 *
 * 路径参数只用于报错信息：出错时读者要知道是哪一份文件坏了。
 */

/** 实体/方块类型的允许形状。与 `migrate.ts` 里方块名的模式同一个口径。 */
const TYPE_PATTERN = /^(?:[a-z0-9_]+:)?[a-z0-9_/]+$/

export function encodeEntities(entities: readonly PlacedEntity[]): string {
  if (entities.length === 0) return ''
  return entities.map((entity) => JSON.stringify(entity)).join('\n') + '\n'
}

export function encodeBlockEntities(entities: readonly PlacedBlockEntity[]): string {
  if (entities.length === 0) return ''
  return entities.map((entity) => JSON.stringify(entity)).join('\n') + '\n'
}

export function decodeEntities(text: string): PlacedEntity[] {
  return decodeLines(text, 'world/entities.jsonl', MAX_ENTITIES, parseEntity)
}

export function decodeBlockEntities(text: string): PlacedBlockEntity[] {
  return decodeLines(text, 'world/block-entities.jsonl', MAX_BLOCK_ENTITIES, parseBlockEntity)
}

/**
 * 逐行解析并校验。
 *
 * 上限用**两层各自的内存上限**（4096 / 65536）而不是随便一个数字：那些数字是
 * "这个程序愿意同时持有多对象"的答案，读盘时当然也该是同一个答案。`unzipSync`
 * 那条 256 MB 的防线只管字节数，管不了"1 MB 的 JSON 里有 500 万个实体"。
 */
function decodeLines<T>(
  text: string,
  path: string,
  limit: number,
  parse: (value: unknown, path: string, line: number) => T,
): T[] {
  const out: T[] = []
  const lines = text.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!.trim()
    if (line.length === 0) continue
    let value: unknown
    try {
      value = JSON.parse(line)
    } catch {
      throw new McaiFormatError(`${path} 第 ${i + 1} 行不是合法 JSON`)
    }
    out.push(parse(value, path, i + 1))
    if (out.length > limit) {
      throw new McaiFormatError(`${path} 的条目超过上限 ${limit}，拒绝读取`)
    }
  }
  return out
}

function parseEntity(value: unknown, path: string, line: number): PlacedEntity {
  const where = `${path} 第 ${line} 行`
  const record = asRecord(value, where)
  const id = requireString(record.id, `${where} 的 id`)
  const type = requireString(record.type, `${where} 的 type`)
  if (!TYPE_PATTERN.test(type)) {
    throw new McaiFormatError(`${where} 的实体类型 ${JSON.stringify(type)} 不是合法形状`)
  }
  return {
    id,
    type,
    x: requireNumber(record.x, `${where} 的 x`),
    y: requireNumber(record.y, `${where} 的 y`),
    z: requireNumber(record.z, `${where} 的 z`),
    yaw: requireNumber(record.yaw, `${where} 的 yaw`),
    ...(record.pitch !== undefined ? { pitch: requireNumber(record.pitch, `${where} 的 pitch`) } : {}),
    ...(record.data !== undefined ? { data: asRecord(record.data, `${where} 的 data`) } : {}),
  }
}

function parseBlockEntity(value: unknown, path: string, line: number): PlacedBlockEntity {
  const where = `${path} 第 ${line} 行`
  const record = asRecord(value, where)
  const kind = requireString(record.kind, `${where} 的 kind`)
  if (!TYPE_PATTERN.test(kind)) {
    throw new McaiFormatError(`${where} 的方块实体种类 ${JSON.stringify(kind)} 不是合法形状`)
  }
  return {
    x: requireInteger(record.x, `${where} 的 x`),
    y: requireInteger(record.y, `${where} 的 y`),
    z: requireInteger(record.z, `${where} 的 z`),
    kind,
    data: record.data === undefined ? {} : asRecord(record.data, `${where} 的 data`),
  }
}

function asRecord(value: unknown, where: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new McaiFormatError(`${where} 不是一个对象`)
  }
  return value as Record<string, unknown>
}

function requireString(value: unknown, where: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new McaiFormatError(`${where} 必须是非空字符串`)
  }
  return value
}

function requireNumber(value: unknown, where: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new McaiFormatError(`${where} 必须是有限数字`)
  }
  return value
}

function requireInteger(value: unknown, where: string): number {
  const num = requireNumber(value, where)
  if (!Number.isInteger(num)) throw new McaiFormatError(`${where} 必须是整数`)
  return num
}
