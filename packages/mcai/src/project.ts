import { EditLog, loadRegistry, Palette, WorldStore } from '@architect/core'
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate'

import {
  buildCaptureBundle,
  captureEntryPaths,
  collectCaptures,
  emptyTranscript,
  parseCapturesIndex,
  parseSessions,
  transcriptFromJsonl,
  transcriptToJsonl,
} from './chat.js'
import type { CaptureBundle, ChatTranscript } from './chat.js'
import {
  createManifest,
  ENTRY_ORDER,
  FIXED_MTIME,
  McaiFormatError,
  PATHS,
  validateManifest,
} from './manifest.js'
import type { Manifest, ProjectSettings } from './manifest.js'
import { decodeSnapshot, encodeSnapshot } from './snapshot.js'
import type { Snapshot } from './snapshot.js'

/** 一个已解包的 `.mcai` 工程。 */
export interface McaiProject {
  manifest: Manifest
  settings: ProjectSettings
  /** 磁盘层调色板（规范状态字符串）。 */
  palette: Palette
  /** `world/base.mcvox`，对应 `manifest.baseRevision`。 */
  snapshot: Snapshot
  /** `history/edits.jsonl`。其中 `rev <= baseRevision` 的部分已包含在 snapshot 里。 */
  log: EditLog
  /** `chat/sessions.json` + `chat/messages.jsonl`。**对话记录是工程文件的一半**，不是附属品。 */
  chat: ChatTranscript
  /** `captures/`：对话里引用过的截图，内容寻址去重。 */
  captures: CaptureBundle
  /** 打开工程时发现的截图问题（索引与文件对不上之类）。不阻断打开，但要如实报告。 */
  captureProblems: string[]
  /** 原始 zip 条目，便于无损转发未识别的部分。 */
  extra: Map<string, Uint8Array>
}

export interface PackInput {
  name: string
  projectId: string
  /** 当前世界状态（会先 `dumpColumns()`）。 */
  store: WorldStore
  log: EditLog
  settings: ProjectSettings
  /** 对话记录。省略则写成空档案（老调用点不必改）。 */
  chat?: ChatTranscript
  /** 截图存档。省略则写成空索引。 */
  captures?: CaptureBundle
  appVersion?: string
  now?: string
}

/**
 * 把世界与事件日志打包成 `.mcai` 字节。
 *
 * 打包是**确定性**的：条目按 `ENTRY_ORDER` 写入、时间戳固定为 zip 纪元，
 * 所以相同内容必然得到相同字节。
 */
export function packProject(input: PackInput): Uint8Array {
  const { store, log } = input
  const snapshot = encodeSnapshot({
    minY: store.minY,
    worldHeight: store.worldHeight,
    paletteSize: store.palette.size,
    columns: store.dumpColumns(),
  })

  const manifest = createManifest({
    projectId: input.projectId,
    name: input.name,
    minecraftVersion: store.registry.minecraftVersion,
    minY: store.minY,
    worldHeight: store.worldHeight,
    appVersion: input.appVersion,
    now: input.now,
  })
  const chat = input.chat ?? emptyTranscript()
  const captures = input.captures ?? buildCaptureBundle([])
  // 打包前自查一次：索引与文件对不上是能看见的问题，值得在写盘前就把话说清楚
  validateCapturesQuietly(captures)

  manifest.revision = log.length
  manifest.baseRevision = log.length // 每次保存都写全量快照
  manifest.worldHash = store.contentHash()
  manifest.counters = {
    ops: log.length,
    captures: captures.refs.length,
    // 有 usage 的 assistant 消息 = 一次真实的模型调用
    llmCalls: chat.messages.filter((message) => message.usage !== undefined).length,
  }

  const files: Record<string, Uint8Array> = {
    [PATHS.manifest]: strToU8(JSON.stringify(manifest, null, 2) + '\n'),
    [PATHS.project]: strToU8(JSON.stringify(input.settings, null, 2) + '\n'),
    [PATHS.palette]: strToU8(
      JSON.stringify({ minecraftVersion: store.registry.minecraftVersion, entries: store.palette.strings() }, null, 2) +
        '\n',
    ),
    [PATHS.base]: snapshot,
    [PATHS.edits]: strToU8(log.toJSONL()),
    [PATHS.checkpoints]: strToU8('[]\n'),
    [PATHS.sessions]: strToU8(`${JSON.stringify(chat.sessions, null, 2)}\n`),
    [PATHS.messages]: strToU8(transcriptToJsonl(chat.messages)),
    [PATHS.capturesIndex]: strToU8(`${JSON.stringify(captures.refs, null, 2)}\n`),
    [PATHS.stats]: strToU8(
      JSON.stringify(
        {
          blocks: store.stats().blocks,
          columns: store.allocatedColumns,
          messages: chat.messages.length,
          captures: captures.refs.length,
        },
        null,
        2,
      ) + '\n',
    ),
    [PATHS.log]: strToU8(`打包于 ${manifest.modifiedAt}，版本 ${manifest.revision}\n`),
  }
  // 截图条目名是动态的，单独加进来
  for (const id of [...captures.files.keys()].sort()) {
    files[capturePathOf(id)] = captures.files.get(id)!
  }

  // 按固定顺序重排，保证确定性：先按 ENTRY_ORDER，动态条目（截图）按名字排序接在后面。
  // 截图不参与 ENTRY_ORDER 是因为它的数量与名字取决于内容，写不进一张静态表。
  const ordered: Record<string, [Uint8Array, { mtime: Date; level: 6 }]> = {}
  for (const path of ENTRY_ORDER) {
    const data = files[path]
    if (data === undefined) continue
    ordered[path] = [data, { mtime: FIXED_MTIME, level: 6 }]
  }
  for (const path of captureEntryPaths(captures)) {
    const data = files[path]
    if (data === undefined) continue
    ordered[path] = [data, { mtime: FIXED_MTIME, level: 6 }]
  }

  return zipSync(ordered, { mtime: FIXED_MTIME })
}

/** 解包 `.mcai` 字节。不建世界，只把各部分读出来。 */
export function unpackProject(bytes: Uint8Array): McaiProject {
  const entries = unzipSync(bytes)

  const manifestBytes = entries[PATHS.manifest]
  if (manifestBytes === undefined) {
    throw new McaiFormatError(`${PATHS.manifest} 缺失——这不是一个有效的 .mcai 工程`)
  }
  const manifest = validateManifest(JSON.parse(strFromU8(manifestBytes)))

  const paletteBytes = entries[PATHS.palette]
  if (paletteBytes === undefined) throw new McaiFormatError(`${PATHS.palette} 缺失，无法解释方块数据`)
  const palettePayload = JSON.parse(strFromU8(paletteBytes)) as { entries: string[] }

  const baseBytes = entries[PATHS.base]
  if (baseBytes === undefined) throw new McaiFormatError(`${PATHS.base} 缺失，工程没有方块数据`)
  const snapshot = decodeSnapshot(baseBytes)

  if (snapshot.paletteSize !== palettePayload.entries.length) {
    throw new McaiFormatError(
      `调色板有 ${palettePayload.entries.length} 项，但快照声明 ${snapshot.paletteSize} 项，文件已损坏`,
    )
  }
  if (snapshot.minY !== manifest.minY || snapshot.worldHeight !== manifest.worldHeight) {
    throw new McaiFormatError('快照的世界高度与 manifest 不一致，文件已损坏')
  }

  const registry = loadRegistry(manifest.minecraftVersion)
  const palette = Palette.fromJSON(registry, palettePayload)

  const settingsBytes = entries[PATHS.project]
  const settings: ProjectSettings =
    settingsBytes === undefined
      ? { volume: { min: { x: 0, y: manifest.minY, z: 0 }, max: { x: 15, y: manifest.minY + 15, z: 15 } } }
      : (JSON.parse(strFromU8(settingsBytes)) as ProjectSettings)

  const editsBytes = entries[PATHS.edits]
  const { log } = EditLog.fromJSONL(editsBytes === undefined ? '' : strFromU8(editsBytes))

  // 对话与截图：**缺了不算损坏**。老工程、或者用脚本裁出来的最小工程都可能是空的，
  // 而方块数据仍然完全可用——不该因为"没有对话"就打不开。
  const sessionsBytes = entries[PATHS.sessions]
  const messagesBytes = entries[PATHS.messages]
  const capturesIndexBytes = entries[PATHS.capturesIndex]
  const chat: ChatTranscript = {
    sessions: sessionsBytes === undefined ? [] : parseSessions(strFromU8(sessionsBytes)),
    messages: messagesBytes === undefined ? [] : transcriptFromJsonl(strFromU8(messagesBytes)).messages,
  }
  const refs = capturesIndexBytes === undefined ? [] : parseCapturesIndex(strFromU8(capturesIndexBytes))
  const { bundle: captures, problems: captureProblems } = collectCaptures(entries, refs)

  const extra = new Map<string, Uint8Array>()
  for (const [path, data] of Object.entries(entries)) {
    if (ENTRY_ORDER.includes(path)) continue
    if (path.startsWith('captures/')) continue
    extra.set(path, data)
  }

  return { manifest, settings, palette, snapshot, log, chat, captures, captureProblems, extra }
}

const capturePathOf = (id: string): string => `captures/${id}.png`

/**
 * 打包前自查截图索引。
 *
 * 这里**只警告不抛错**：索引与文件对不上是能看见的问题，但方块数据仍然完好，
 * 为它拒绝保存整份工程是本末倒置。
 */
function validateCapturesQuietly(bundle: CaptureBundle): string[] {
  const problems: string[] = []
  for (const ref of bundle.refs) {
    const bytes = bundle.files.get(ref.id)
    if (bytes === undefined) problems.push(`截图 ${ref.id} 在索引里但没有对应文件`)
    else if (bytes.length !== ref.bytes) problems.push(`截图 ${ref.id} 大小与索引不一致`)
  }
  if (problems.length > 0) process.emitWarning(`.mcai 截图索引有问题：${problems.join('；')}`)
  return problems
}

/**
 * 打开一个 `.mcai`：建世界、装调色板、恢复快照、重放剩余 op。
 *
 * 返回的 store 处于 `manifest.revision` 状态。
 */
export function openProject(bytes: Uint8Array): { project: McaiProject; store: WorldStore } {
  const project = unpackProject(bytes)
  const store = new WorldStore({
    minecraftVersion: project.manifest.minecraftVersion,
    volume: project.settings.volume,
    palette: project.palette,
    minY: project.manifest.minY,
    worldHeight: project.manifest.worldHeight,
  })
  store.restoreColumns(project.snapshot.columns, project.manifest.baseRevision)
  // 快照已包含 rev <= baseRevision 的全部变更，只重放其后的部分。
  // （重复重放虽然幂等，但既白做功，又会掩盖 baseRevision 的语义错误。）
  for (const op of project.log.upTo(project.manifest.revision).slice(project.manifest.baseRevision)) {
    store.applyPatch(op.patch)
  }
  store.setRevision(project.manifest.revision)
  return { project, store }
}
