import { applyOp, EditLog, loadRegistry, Palette, WorldStore } from '@architect/core'
import type { PlacedBlockEntity, PlacedEntity } from '@architect/core'
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
  validateCaptures,
} from './chat.js'
import type { CaptureBundle, CaptureProblem, ChatTranscript } from './chat.js'
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
import { decodeBlockEntities, decodeEntities, encodeBlockEntities, encodeEntities } from './sparse.js'

/** 一个已解包的 `.mcai` 工程。 */
export interface McaiProject {
  manifest: Manifest
  settings: ProjectSettings
  /** 磁盘层调色板（规范状态字符串）。 */
  palette: Palette
  /** `world/base.mcvox`，对应 `manifest.baseRevision`。 */
  snapshot: Snapshot
  /**
   * `world/entities.jsonl`：实体层的**基快照**，对应 `manifest.baseRevision`。
   *
   * 老工程没有这个条目——那时候世界上根本没有这一层，所以缺了就是空数组，
   * 与"对话与截图缺了不算损坏"同一个态度（D-26）。
   */
  entities: PlacedEntity[]
  /** `world/block-entities.jsonl`：方块实体层的基快照。同上，缺了就是空。 */
  blockEntities: PlacedBlockEntity[]
  /** `history/edits.jsonl`。其中 `rev <= baseRevision` 的部分已包含在 snapshot 里。 */
  log: EditLog
  /** `chat/sessions.json` + `chat/messages.jsonl`。**对话记录是工程文件的一半**，不是附属品。 */
  chat: ChatTranscript
  /** `captures/`：对话里引用过的截图，内容寻址去重。 */
  captures: CaptureBundle
  /** 打开工程时发现的截图问题（索引与文件对不上之类）。不阻断打开，但要如实报告。 */
  captureProblems: CaptureProblem[]
  /**
   * 原始 zip 条目，便于无损转发未识别的部分。
   *
   * **要让这条承诺成立，打包时必须把它写回去**（`PackInput.extra`）——只收不写的话，
   * "新版本加了条目 → 旧版本打开 → 保存"会把那些条目悄悄丢掉。
   */
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
  /** 模型写的设计笔记（省略表示没有）。 */
  designNotes?: string
  /**
   * **打开时收下的、本版本不认识的条目，原样写回去**（`McaiProject.extra`）。
   *
   * 不传就等于"这次保存会把不认识的条目丢掉"——对一份新工程的第一次保存来说
   * 那没问题（本来就没有），但"打开 → 改 → 保存"必须把它带上，否则格式一加东西，
   * 用户手里的旧版本就会把新版本写的数据吃掉，而且是安静地吃。
   */
  extra?: ReadonlyMap<string, Uint8Array>
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
  // 设计笔记进 manifest：它是"这栋建筑的当前计划"，重开工程时要接着用
  if (input.designNotes !== undefined && input.designNotes.length > 0) {
    manifest.designNotes = input.designNotes
  }
  const chat = input.chat ?? emptyTranscript()
  const captures = input.captures ?? buildCaptureBundle([])
  // 打包前自查一次：索引与文件对不上是能看见的问题，值得在写盘前就把话说清楚
  validateCapturesQuietly(captures)

  // 快照写的是**世界现在的样子**，而世界现在停在 `store.revision` ——那是游标，
  // 不一定等于日志长度：撤销之后日志还留着后面几步（重做分支），世界却不在那里。
  //
  // 早期这里写的是 `log.length`，于是"撤销之后保存"会存下一份谎报：
  // 快照是撤销后的内容，manifest 却说它在最新版本上，日志里那条被撤销的 op
  // 看上去"已经应用了"。重开之后世界与日志就此对不上（重放、时间线全错）。
  const cursor = store.revision
  manifest.revision = cursor
  manifest.baseRevision = cursor // 每次保存都写全量快照
  manifest.worldHash = store.contentHash()
  manifest.counters = {
    // 日志是**全量**写进去的：游标之后那几步是重做分支，重开之后还能 ⌘⇧Z 拿回来
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
          /** 世界另外两层的规模。`meta/stats.json` 是给人看的诊断，多这两行省一次开工程。 */
          entities: store.entities.size,
          blockEntities: store.blockEntities.size,
          messages: chat.messages.length,
          captures: captures.refs.length,
        },
        null,
        2,
      ) + '\n',
    ),
    [PATHS.log]: strToU8(`打包于 ${manifest.modifiedAt}，版本 ${manifest.revision}\n`),
  }
  /**
   * 两层稀疏数据的基快照。**空集合不写条目**——与"打开时缺了就当空"对称，
   * 也让没用到这两层的工程字节和以前一模一样。
   */
  const entities = encodeEntities(store.entities.toJSON())
  const blockEntities = encodeBlockEntities(store.blockEntities.toJSON())
  if (entities.length > 0) files[PATHS.entities] = strToU8(entities)
  if (blockEntities.length > 0) files[PATHS.blockEntities] = strToU8(blockEntities)

  // 截图条目名是动态的，单独加进来
  for (const id of [...captures.files.keys()].sort()) {
    files[capturePathOf(id)] = captures.files.get(id)!
  }

  /**
   * **不认识的条目原样写回**（关闭 `McaiProject.extra` 那个承诺）。
   *
   * `unpackProject` 一直老老实实把未知条目收进 `extra`，但从来没人写回来——
   * 于是"新版本加了一个条目、旧版本打开再保存"就等于把那个条目删了。
   * 加条目这件事本来是向后兼容的（旧读方忽略未知条目照常打开），
   * 坏就坏在**保存**这一步，所以修复点也在这里。
   *
   * 已知条目以我们写的为准；`captures/` 有自己那条通路，不当未知条目转发。
   */
  const extraPaths = new Set<string>()
  for (const [path, data] of input.extra ?? []) {
    if (files[path] !== undefined) continue
    if (path.startsWith('captures/')) continue
    files[path] = data
    extraPaths.add(path)
  }

  // 按固定顺序重排，保证确定性：先按 ENTRY_ORDER，动态条目（截图）按名字排序接在后面，
  // 最后是不认识的条目（同样按名字排序）。截图不参与 ENTRY_ORDER 是因为它的数量与
  // 名字取决于内容，写不进一张静态表；未知条目同理。
  const ordered: Record<string, [Uint8Array, { mtime: Date; level: 6 }]> = {}
  const push = (path: string): void => {
    const data = files[path]
    if (data === undefined) return
    ordered[path] = [data, { mtime: FIXED_MTIME, level: 6 }]
  }
  for (const path of ENTRY_ORDER) push(path)
  for (const path of captureEntryPaths(captures)) push(path)
  for (const path of [...extraPaths].sort()) push(path)

  return zipSync(ordered, { mtime: FIXED_MTIME })
}

/**
 * 单个 zip 条目解压后允许的字节数。
 *
 * `unzipSync` 会把每个条目**整段解开**，而条目在 `.mcai` 里是压缩过的：全零数据的
 * 压缩比约 1000×。实测 1 MB 的 `.mcai` 能让这个函数吃掉 1 GB 内存，5 MB 就是 5 GB
 * ——V8 致命 OOM，不是可捕获的异常。
 *
 * 挡住的是「用声明尺寸换内存」这一类输入；这个上限远大于任何真实工程
 * （仓库里的示例工程是 1.9 KB，而快照本身又是 zlib 过的一层）。
 */
const MAX_ENTRY_BYTES = 256 * 1024 * 1024

/**
 * 全部条目**合计**允许的字节数，以及条目数上限。
 *
 * 单条目上限挡不住「很多个刚好不超限的条目」：中央目录项每个只要几十字节，一个
 * 1 MB 的文件可以声明上百个各 200 MB 的条目，而 `unzipSync` 会把它们**全部**解开
 * ——256 MB × 100 = 25 GB。这是同一类「用声明换内存」，只是摊到了多个条目上。
 */
const MAX_TOTAL_BYTES = 512 * 1024 * 1024
const MAX_ENTRIES = 4096

/** 解包 `.mcai` 字节。不建世界，只把各部分读出来。 */
export function unpackProject(bytes: Uint8Array): McaiProject {
  let declaredBytes = 0
  let entryCount = 0
  const entries = unzipSync(bytes, {
    filter: (file) => {
      if (file.originalSize > MAX_ENTRY_BYTES) {
        throw new McaiFormatError(
          `工程里的 ${file.name} 声明解压后 ${file.originalSize} 字节，超过上限 ${MAX_ENTRY_BYTES}`,
        )
      }
      declaredBytes += file.originalSize
      entryCount++
      if (declaredBytes > MAX_TOTAL_BYTES) {
        throw new McaiFormatError(
          `工程里的条目合计声明解压后 ${declaredBytes} 字节，超过上限 ${MAX_TOTAL_BYTES}`,
        )
      }
      if (entryCount > MAX_ENTRIES) {
        throw new McaiFormatError(`工程有超过 ${MAX_ENTRIES} 个条目，拒绝解包`)
      }
      return true
    },
  })

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

  // 两层稀疏数据的基快照：**缺了就是空**。老工程根本没有这两个条目，
  // 而那时候世界上也没有这两层，所以"缺"与"空"在这里本来就是同一件事——
  // 不给它加一条"必需"，老工程才不会因为一次格式演进就打不开。
  const entitiesBytes = entries[PATHS.entities]
  const entities = entitiesBytes === undefined ? [] : decodeEntities(strFromU8(entitiesBytes))
  const blockEntitiesBytes = entries[PATHS.blockEntities]
  const blockEntities =
    blockEntitiesBytes === undefined ? [] : decodeBlockEntities(strFromU8(blockEntitiesBytes))

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

  return {
    manifest,
    settings,
    palette,
    snapshot,
    entities,
    blockEntities,
    log,
    chat,
    captures,
    captureProblems,
    extra,
  }
}

const capturePathOf = (id: string): string => `captures/${id}.png`

/**
 * 打包前自查截图索引。
 *
 * 这里**只警告不抛错**：索引与文件对不上是能看见的问题，但方块数据仍然完好，
 * 为它拒绝保存整份工程是本末倒置。
 */
function validateCapturesQuietly(bundle: CaptureBundle): CaptureProblem[] {
  const problems = validateCaptures(bundle).filter(
    (p) => p.code === 'CAPTURE_MISSING_FILE' || p.code === 'CAPTURE_SIZE_MISMATCH',
  )
  // mcai 不依赖 i18n，所以这条警告只报 code（稳定的诊断信息，不是给界面的文案）
  if (problems.length > 0) {
    process.emitWarning(`.mcai capture index problems: ${problems.map((p) => p.code).join(', ')}`)
  }
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
  /**
   * 两层稀疏数据的基快照，**必须排在 `restoreColumns` 之后**：
   * 那个方法内部会 `clear()`，而 `clear()` 是三层一起清的
   * （plan §18.2 那条"三层必须一起发生"的唯一实现点）。顺序反了就是
   * "打开工程之后实体全没了"，而且方块数据看上去完好无损。
   */
  store.entities.fromJSON(project.entities)
  store.blockEntities.fromJSON(project.blockEntities)
  // 快照已包含 rev <= baseRevision 的全部变更，只重放其后的部分。
  // （重复重放虽然幂等，但既白做功，又会掩盖 baseRevision 的语义错误。）
  //
  // 走 `applyOp` 而不是 `store.applyPatch`：一条 op 现在可以带三层负载
  // （方块 / 方块实体 / 实体，plan §18.2）。只贴方块那一层的话，打开工程会
  // 安静地少掉实体与方块实体——而少掉的东西不在任何计数里，只有当有人
  // 拿 `contentHash()` 对拍时才看得出来。
  for (const op of project.log.upTo(project.manifest.revision).slice(project.manifest.baseRevision)) {
    applyOp(store, op)
  }
  store.setRevision(project.manifest.revision)
  return { project, store }
}
