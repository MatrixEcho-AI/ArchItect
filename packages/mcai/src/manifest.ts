/**
 * `.mcai` 的格式定义：路径、版本、manifest 结构与校验。
 *
 * 容器是普通的 **zip**（deflate，不加密），条目顺序与时间戳固定，
 * 因此相同内容必然产生相同的字节——便于做内容寻址与回归测试。
 */

/** 格式版本，独立于应用版本。主版本变化表示不兼容。 */
export const FORMAT_VERSION = '0.1'

/** zip 内的固定路径。 */
export const PATHS = {
  manifest: 'manifest.json',
  project: 'project.json',
  palette: 'world/palette.json',
  base: 'world/base.mcvox',
  edits: 'history/edits.jsonl',
  checkpoints: 'history/checkpoints.json',
  sessions: 'chat/sessions.json',
  messages: 'chat/messages.jsonl',
  capturesIndex: 'captures/index.json',
  stats: 'meta/stats.json',
  log: 'meta/log.txt',
} as const

/** zip 条目的固定写入顺序（确定性打包要求）。 */
export const ENTRY_ORDER: readonly string[] = [
  PATHS.manifest,
  PATHS.project,
  PATHS.palette,
  PATHS.base,
  PATHS.edits,
  PATHS.checkpoints,
  PATHS.sessions,
  PATHS.messages,
  PATHS.capturesIndex,
  PATHS.stats,
  PATHS.log,
]

/** 确定性打包用的固定时间戳（1980-01-01，zip 纪元起点）。 */
export const FIXED_MTIME = new Date(Date.UTC(1980, 0, 1, 0, 0, 0))

export interface ManifestCounters {
  ops: number
  captures: number
  llmCalls: number
}

export interface Manifest {
  formatVersion: string
  appVersion: string
  projectId: string
  name: string
  minecraftVersion: string
  createdAt: string
  modifiedAt: string
  /** 当前版本号 = op 总数。 */
  revision: number
  /** `world/base.mcvox` 对应的版本号。 */
  baseRevision: number
  /** 世界内容哈希（`WorldStore.contentHash()`）。 */
  worldHash: string
  /** 世界 Y 范围。 */
  minY: number
  worldHeight: number
  counters: ManifestCounters
  /**
   * 模型自己写的**设计笔记**（`update_notes` 工具，§9.2 的阶段摘要）。
   *
   * 存在 manifest 而不是某个会话里：它是"这栋建筑的当前计划"，跨会话有效——
   * 关掉再打开，模型不该失忆。省略时表示没有笔记。
   */
  designNotes?: string
}

export interface ProjectSettings {
  /** 工区（可写边界）。没有人为尺寸上限，这是项目级设置。 */
  volume: { min: { x: number; y: number; z: number }; max: { x: number; y: number; z: number } }
  /** 允许 LLM 使用的方块集；空表示不限制。 */
  paletteAllowlist?: string[]
  /** 只为引用，**绝不存密钥**（plan §13.3 红线 2）。 */
  providerId?: string
}

export class McaiFormatError extends Error {
  override readonly name = 'McaiFormatError'
}

export function createManifest(init: {
  projectId: string
  name: string
  minecraftVersion: string
  minY: number
  worldHeight: number
  appVersion?: string
  now?: string
}): Manifest {
  const now = init.now ?? new Date().toISOString()
  return {
    formatVersion: FORMAT_VERSION,
    appVersion: init.appVersion ?? '0.1.0',
    projectId: init.projectId,
    name: init.name,
    minecraftVersion: init.minecraftVersion,
    createdAt: now,
    modifiedAt: now,
    revision: 0,
    baseRevision: 0,
    worldHash: '',
    minY: init.minY,
    worldHeight: init.worldHeight,
    counters: { ops: 0, captures: 0, llmCalls: 0 },
  }
}

/** 校验 manifest 的必填字段与格式版本兼容性。 */
export function validateManifest(value: unknown): Manifest {
  if (typeof value !== 'object' || value === null) {
    throw new McaiFormatError('manifest.json is not an object')
  }
  const m = value as Partial<Manifest>
  const required: Array<keyof Manifest> = [
    'formatVersion',
    'appVersion',
    'projectId',
    'name',
    'minecraftVersion',
    'createdAt',
    'modifiedAt',
    'revision',
    'baseRevision',
    'minY',
    'worldHeight',
  ]
  const missing = required.filter((k) => m[k] === undefined)
  if (missing.length > 0) {
    throw new McaiFormatError(`manifest.json is missing required fields: ${missing.join(', ')}`)
  }
  if (typeof m.formatVersion !== 'string') {
    throw new McaiFormatError('manifest.formatVersion must be a string')
  }
  const [major] = m.formatVersion.split('.')
  if (major !== FORMAT_VERSION.split('.')[0]) {
    throw new McaiFormatError(
      `Project format ${m.formatVersion} has a different major version from the supported ${FORMAT_VERSION}`,
    )
  }
  if (typeof m.revision !== 'number' || typeof m.baseRevision !== 'number') {
    throw new McaiFormatError('manifest.revision / baseRevision must be numbers')
  }
  if (m.baseRevision > m.revision) {
    throw new McaiFormatError(
      `manifest.baseRevision (${m.baseRevision}) cannot exceed revision (${m.revision})`,
    )
  }
  return m as Manifest
}
