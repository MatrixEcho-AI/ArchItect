/**
 * 对话记录与截图存档（plan §5.1 的 `chat/` 与 `captures/`）。
 *
 * **这是 `.mcai` 与"一个存档文件"的分界线**：只存方块，用户拿到的是一张图；
 * 存了对话，用户能看见"为什么长成这样"——哪一轮提了什么要求、模型调了哪些工具、
 * 每次改完拍了哪张图。所以这两部分不是附属品，是工程文件的一半。
 *
 * 存的是**面向人的记录**，不是发给模型的原始消息（§9.2 的那份带完整 prompt 前缀）。
 * 两者刻意分开：
 *
 * - 原始消息里有大量为缓存前缀服务的内容（system prompt、工具 schema 的重复），
 *   存进工程文件只会让文件变大一倍而毫无信息量。
 * - 工程文件可能被分享，而原始消息里可能夹着用户没说出口的东西。
 *
 * 截图**内容寻址**：`id` 是内容哈希，同一张图只存一份，改坏了也能对得上。
 */

export interface CaptureRef {
  /** 内容哈希前 16 位，同时是文件名。 */
  id: string
  revision: number
  /** 机位预设名，如 `iso_ne`。 */
  camera: string
  width: number
  height: number
  bytes: number
  /** 完整 sha256，便于校验。 */
  sha256: string
  /** zip 内路径，如 `captures/a1b2c3.png`。 */
  file: string
  /** 引用它的消息 id（同一张图可能被多条消息引用，这里记第一个）。 */
  messageId?: number
}

export interface ChatToolCallRecord {
  id: string
  name: string
  args: unknown
  /**
   * 模型给的参数**原文不是合法 JSON** 时的那段**原文**（截断到 200 字符）。
   *
   * 必须进档案：`args` 这时候只是个空占位（`{}`），只存它的话，事后翻档案
   * 只会看到"模型调了一个没有参数的工具"，而真实情况是它吐了一段坏 JSON。
   * 这一条与 `tool_result` 里那条 ERROR 合起来，才够离线复现。
   */
  unparsableArgs?: string
}

export interface ChatMessageRecord {
  id: number
  role: 'user' | 'assistant' | 'tool'
  text: string
  ts: string
  /** assistant 请求的工具调用。 */
  toolCalls?: ChatToolCallRecord[]
  /** tool 消息对应的调用。 */
  toolCallId?: string
  toolName?: string
  /** tool 消息：成功与否。 */
  ok?: boolean
  /** 引用 `captures/` 里的截图。 */
  imageIds?: string[]
  /** assistant 消息：这一轮的用量与模型。 */
  usage?: { in: number; out: number; cachedIn?: number }
  model?: string
  /** 预算刹车时的累计花费（美元）。 */
  usd?: number
  /** 完成闸门、重试、预算刹车、截断一类的系统提示（不是模型说的话，界面要区别显示）。 */
  note?: 'gate' | 'retry' | 'budget' | 'truncated' | 'context'
}

/**
 * 这一场会话的用量计数。
 *
 * 为什么要存：打开工程时界面要把"几轮、几次工具、几张截图"原样显示出来。
 * 不存的话只能靠数消息反推——而 assistant 消息数 **不等于** 轮数
 * （一轮里可能既有正文又有多次工具调用），反推出来的数字一定是错的
 * （实测：13 轮的会话被显示成 "1 turns"）。
 */
export interface ChatSessionTotals {
  in: number
  out: number
  cachedIn?: number
  turns: number
  toolCalls: number
  screenshots: number
}

export interface ChatSessionRecord {
  id: string
  title: string
  createdAt: string
  /** 会话结束时用的模型。 */
  model?: string
  /** 模型的配置实例名。**只存名字，不存任何密钥引用**（D-13）。 */
  providerId?: string
  /** 用量计数（老工程没有这一项，界面会退回"按消息数估"并如实标注）。 */
  totals?: ChatSessionTotals
}

export interface ChatTranscript {
  sessions: ChatSessionRecord[]
  messages: ChatMessageRecord[]
}

export interface CaptureBundle {
  refs: CaptureRef[]
  /** id → PNG 字节。 */
  files: Map<string, Uint8Array>
}

export const emptyTranscript = (): ChatTranscript => ({ sessions: [], messages: [] })

// ── 编解码 ────────────────────────────────────────────────────────────────────

/**
 * 消息 → JSONL。
 *
 * 一行一条：追加式写入不用解析整个文件，`tail` 一眼就能看，
 * 坏了一行也只丢那一行（与 `history/edits.jsonl` 同一个理由）。
 */
export function transcriptToJsonl(messages: readonly ChatMessageRecord[]): string {
  if (messages.length === 0) return ''
  return `${messages.map((message) => JSON.stringify(message)).join('\n')}\n`
}

/**
 * JSONL → 消息。
 *
 * **坏行跳过并计数，不抛异常**：对话记录是给人看的档案，
 * 一条坏行不该让整个工程打不开。
 */
export function transcriptFromJsonl(text: string): { messages: ChatMessageRecord[]; brokenLines: number } {
  const messages: ChatMessageRecord[] = []
  let brokenLines = 0
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (trimmed.length === 0) continue
    try {
      const parsed = JSON.parse(trimmed) as ChatMessageRecord
      if (typeof parsed !== 'object' || parsed === null || typeof parsed.role !== 'string') {
        brokenLines++
        continue
      }
      messages.push(parsed)
    } catch {
      brokenLines++
    }
  }
  return { messages, brokenLines }
}

export function parseSessions(text: string): ChatSessionRecord[] {
  const trimmed = text.trim()
  if (trimmed.length === 0) return []
  try {
    const parsed = JSON.parse(trimmed) as unknown
    if (!Array.isArray(parsed)) return []
    return parsed.filter(
      (entry): entry is ChatSessionRecord =>
        typeof entry === 'object' && entry !== null && typeof (entry as ChatSessionRecord).id === 'string',
    )
  } catch {
    // 会话表坏了不影响工程可用性——消息本身才是内容
    return []
  }
}

export function parseCapturesIndex(text: string): CaptureRef[] {
  const trimmed = text.trim()
  if (trimmed.length === 0) return []
  try {
    const parsed = JSON.parse(trimmed) as unknown
    if (!Array.isArray(parsed)) return []
    return parsed.filter(
      (entry): entry is CaptureRef =>
        typeof entry === 'object' && entry !== null && typeof (entry as CaptureRef).id === 'string',
    )
  } catch {
    return []
  }
}

export const capturePath = (id: string): string => `captures/${id}.png`

/**
 * 从截图字节造一条索引项。
 *
 * **id 由内容决定**（sha256 前 16 位），所以同一张图重复拍多少次都只存一份，
 * 而且索引与文件天然一一对应——不存在"索引指向一个不存在的文件"这种状态。
 */
export function makeCaptureRef(
  png: Uint8Array,
  metadata: { revision: number; camera: string; width: number; height: number; messageId?: number },
  sha256: string,
): CaptureRef {
  const id = sha256.slice(0, 16)
  return {
    id,
    revision: metadata.revision,
    camera: metadata.camera,
    width: metadata.width,
    height: metadata.height,
    bytes: png.length,
    sha256,
    file: capturePath(id),
    ...(metadata.messageId !== undefined ? { messageId: metadata.messageId } : {}),
  }
}

/**
 * 存档截图自查的一条问题。**本体是稳定的 code + 参数，不是一句话**（与 interop 的
 * `InteropProblem` 同一个形状、同一个理由）：显示层才翻译，`.mcai` 与测试只看 code。
 */
export interface CaptureProblem {
  code:
    | 'CAPTURE_SHA_MISMATCH'
    | 'CAPTURE_DUPLICATE_ID'
    | 'CAPTURE_MISSING_FILE'
    | 'CAPTURE_SIZE_MISMATCH'
    | 'CAPTURE_ORPHAN_FILE'
    | 'CAPTURE_BAD_ENTRY_NAME'
  params?: Record<string, string | number>
}

/** 校验索引与文件对得上。**报出来而不是静默忽略**——少一张图是能看见的问题。 */
export function validateCaptures(bundle: CaptureBundle): CaptureProblem[] {
  const problems: CaptureProblem[] = []
  const seen = new Set<string>()
  for (const ref of bundle.refs) {
    if (ref.id !== ref.sha256.slice(0, 16)) {
      problems.push({ code: 'CAPTURE_SHA_MISMATCH', params: { id: ref.id } })
    }
    if (seen.has(ref.id)) problems.push({ code: 'CAPTURE_DUPLICATE_ID', params: { id: ref.id } })
    seen.add(ref.id)
    const bytes = bundle.files.get(ref.id)
    if (bytes === undefined) problems.push({ code: 'CAPTURE_MISSING_FILE', params: { id: ref.id } })
    else if (bytes.length !== ref.bytes) {
      problems.push({ code: 'CAPTURE_SIZE_MISMATCH', params: { id: ref.id, bytes: bytes.length, listed: ref.bytes } })
    }
  }
  for (const id of bundle.files.keys()) {
    if (!seen.has(id)) problems.push({ code: 'CAPTURE_ORPHAN_FILE', params: { id } })
  }
  return problems
}

/** 供 `packProject` 用：把一批截图整理成可写入的形式。 */
export function buildCaptureBundle(entries: Iterable<{ ref: CaptureRef; png: Uint8Array }>): CaptureBundle {
  const refs: CaptureRef[] = []
  const files = new Map<string, Uint8Array>()
  const seen = new Set<string>()
  for (const entry of entries) {
    if (seen.has(entry.ref.id)) continue
    seen.add(entry.ref.id)
    refs.push(entry.ref)
    files.set(entry.ref.id, entry.png)
  }
  refs.sort((a, b) => a.id.localeCompare(b.id))
  return { refs, files }
}

/** 截图在 zip 里的条目名必须排序后再写，否则打包不是确定性的。 */
export function captureEntryPaths(bundle: CaptureBundle): string[] {
  return [...bundle.files.keys()].sort().map(capturePath)
}

/** 打开工程时，把 `captures/` 下的条目收回来。 */
export function collectCaptures(
  entries: Record<string, Uint8Array>,
  refs: readonly CaptureRef[],
): { bundle: CaptureBundle; problems: CaptureProblem[] } {
  const files = new Map<string, Uint8Array>()
  const problems: CaptureProblem[] = []
  for (const [path, data] of Object.entries(entries)) {
    if (!path.startsWith('captures/') || !path.endsWith('.png')) continue
    const id = path.slice('captures/'.length, -'.png'.length)
    // **只收像内容寻址 id 的条目名**。id 是从**不可信的 zip 条目名**里切出来的，
    // 而重新打包时会按它生成 `captures/<id>.png`——放行 `../../../x` 就等于把穿越
    // 条目名原样交给下一个解压这份工程的人（打开 → 另存 → 分享，恶意条目就这么
    // 传下去）。真正的 id 是 sha256 的前缀，所以只认十六进制。
    if (!/^[0-9a-f]{8,64}$/.test(id)) {
      problems.push({ code: 'CAPTURE_BAD_ENTRY_NAME', params: { path } })
      continue
    }
    files.set(id, data)
  }
  const bundle: CaptureBundle = { refs: [...refs], files }
  // 图丢了不影响方块数据可用，所以**只报告、不阻断打开**
  return { bundle, problems: [...problems, ...validateCaptures(bundle)] }
}
