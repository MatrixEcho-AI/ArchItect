import { EditLog, forEachBox, WorldStore } from '@architect/core'
import type { Bounds } from '@architect/core'
import { describe, expect, it } from 'vitest'

import {
  buildCaptureBundle,
  collectCaptures,
  makeCaptureRef,
  transcriptFromJsonl,
  transcriptToJsonl,
  validateCaptures,
} from '../src/chat.js'
import type { ChatMessageRecord } from '../src/chat.js'
import { openProject, packProject, unpackProject } from '../src/project.js'
import { TranscriptRecorder } from '../src/transcript.js'
import type { TranscriptEvent } from '../src/transcript.js'

const volume: Bounds = { min: { x: 0, y: 0, z: 0 }, max: { x: 15, y: 15, z: 15 } }

function makeStore(): WorldStore {
  const store = new WorldStore({ minecraftVersion: '1.21.4', volume })
  store.write((v) => forEachBox({ x: 0, y: 0, z: 0 }, { x: 3, y: 0, z: 3 }, 'solid', v), store.palette.indexOf('minecraft:stone'), {
    confirm: true,
  })
  return store
}

/** 一张最小的"PNG"，只要能区分内容即可——这一层不关心 PNG 本身。 */
const fakePng = (seed: number): Uint8Array => new Uint8Array([0x89, 0x50, 0x4e, 0x47, seed, seed + 1])

const sha256Of = async (bytes: Uint8Array): Promise<string> => {
  const { createHash } = await import('node:crypto')
  return createHash('sha256').update(bytes).digest('hex')
}

describe('消息的 JSONL 编解码', () => {
  const message = (id: number, role: ChatMessageRecord['role'], text: string): ChatMessageRecord => ({
    id,
    role,
    text,
    ts: '2026-01-01T00:00:00.000Z',
  })

  it('往返一致，一行一条', () => {
    const messages = [message(1, 'user', '造一座灯塔'), message(2, 'assistant', '好的'), message(3, 'tool', 'ok')]
    const text = transcriptToJsonl(messages)
    expect(text.split('\n').filter((line) => line.length > 0)).toHaveLength(3)
    expect(transcriptFromJsonl(text).messages).toEqual(messages)
  })

  it('空档案导出成空串', () => {
    expect(transcriptToJsonl([])).toBe('')
    expect(transcriptFromJsonl('').messages).toEqual([])
  })

  it('**坏行只丢那一行**，不整份档案打不开', () => {
    const good = JSON.stringify(message(1, 'user', '你好'))
    const { messages, brokenLines } = transcriptFromJsonl(`${good}\n{ 这不是 json\n{"role":"assistant","id":2,"text":"好","ts":"x"}\n`)
    expect(brokenLines).toBe(1)
    expect(messages).toHaveLength(2)
    expect(messages[0]?.text).toBe('你好')
    expect(messages[1]?.text).toBe('好')
  })

  it('缺 role 的行也当成坏行', () => {
    expect(transcriptFromJsonl('{"id":1,"text":"x"}\n').brokenLines).toBe(1)
  })
})

describe('截图索引与文件必须一一对应', () => {
  it('内容寻址：同一张图只存一份，重复引用不产生第二份', async () => {
    const png = fakePng(1)
    const ref = makeCaptureRef(png, { revision: 3, camera: 'iso_ne', width: 64, height: 48 }, await sha256Of(png))
    expect(ref.id).toBe((await sha256Of(png)).slice(0, 16))
    expect(ref.file).toBe(`captures/${ref.id}.png`)

    const bundle = buildCaptureBundle([
      { ref, png },
      { ref, png },
    ])
    expect(bundle.refs).toHaveLength(1)
    expect(bundle.files.size).toBe(1)
    expect(validateCaptures(bundle)).toEqual([])
  })

  it('索引指向不存在的文件、或有文件不在索引里，都要报出来', async () => {
    const png = fakePng(2)
    const ref = makeCaptureRef(png, { revision: 1, camera: 'iso_nw', width: 8, height: 8 }, await sha256Of(png))
    expect(validateCaptures({ refs: [ref], files: new Map() })).toEqual([
      `capture ${ref.id} is in the index but has no file`,
    ])
    expect(validateCaptures({ refs: [], files: new Map([[ref.id, png]]) })).toEqual([
      `capture ${ref.id} has a file but is not in the index`,
    ])
    // 大小不一致：换一段**长度不同**的字节（内容不同但长度相同是测不出来的）
    const differentLength = new Uint8Array(png.length + 3).fill(7)
    expect(validateCaptures({ refs: [ref], files: new Map([[ref.id, differentLength]]) })[0]).toContain('bytes but the index says')
  })
})

describe('TranscriptRecorder：事件流 → 对话记录', () => {
  it('把用户、模型、工具调用与结果按顺序录下来', () => {
    const recorder = new TranscriptRecorder({ title: '造一座灯塔', model: 'deepseek-v4.1-flash', now: () => 'T' })
    recorder.add('user', '造一座灯塔')
    const events: TranscriptEvent[] = [
      { type: 'turn', turn: 1 },
      { type: 'tool_call', turn: 1, id: 'c1', name: 'measure', args: {} },
      { type: 'tool_result', turn: 1, id: 'c1', name: 'measure', result: { ok: true, summary: 'size 8x8x8' } },
      { type: 'assistant', turn: 2, text: '先量了一下尺度。' },
      { type: 'stop', reason: 'completed' },
    ]
    for (const event of events) recorder.onEvent(event)

    const { transcript } = recorder.recording
    expect(transcript.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'tool', 'assistant'])
    expect(transcript.messages[1]?.toolCalls?.[0]).toMatchObject({ id: 'c1', name: 'measure' })
    expect(transcript.messages[2]).toMatchObject({ toolCallId: 'c1', toolName: 'measure', ok: true })
    expect(transcript.sessions[0]).toMatchObject({ title: '造一座灯塔', model: 'deepseek-v4.1-flash' })
  })

  it('**截图进 captures，消息里只留内容寻址的 id**（不把 PNG 塞进 jsonl）', () => {
    const recorder = new TranscriptRecorder({ now: () => 'T' })
    const png = fakePng(7)
    recorder.onEvent({
      type: 'tool_result',
      turn: 1,
      id: 'c9',
      name: 'screenshot',
      result: {
        ok: true,
        summary: 'screenshot iso_ne',
        image: { png, width: 64, height: 48, camera: 'iso_ne', revision: 4 },
      },
    })

    const { transcript, captures } = recorder.recording
    expect(captures.files.size).toBe(1)
    expect(captures.refs[0]).toMatchObject({ camera: 'iso_ne', revision: 4, width: 64, height: 48 })
    const tool = transcript.messages.find((m) => m.role === 'tool')!
    expect(tool.imageIds).toEqual([captures.refs[0]!.id])
    // 消息文本里**不能**出现 base64 或字节
    expect(JSON.stringify(transcript)).not.toContain('base64')
    expect(JSON.stringify(transcript).length).toBeLessThan(600)
  })

  it('同一张图拍两次只存一份，第二条消息仍然引用它', () => {
    const recorder = new TranscriptRecorder({ now: () => 'T' })
    const png = fakePng(3)
    const image = { png, width: 8, height: 8, camera: 'iso_ne', revision: 1 }
    recorder.onEvent({ type: 'tool_result', turn: 1, id: 'a', name: 'screenshot', result: { ok: true, summary: 's1', image } })
    recorder.onEvent({ type: 'tool_result', turn: 2, id: 'b', name: 'screenshot', result: { ok: true, summary: 's2', image } })

    const { captures, transcript } = recorder.recording
    expect(captures.files.size).toBe(1)
    expect(captures.refs).toHaveLength(1)
    expect(transcript.messages.filter((m) => m.imageIds !== undefined)).toHaveLength(2)
  })

  it('闸门提醒与重试单独标出来，不和模型说的话混在一起', () => {
    const recorder = new TranscriptRecorder({ now: () => 'T' })
    recorder.onEvent({ type: 'nudge', reason: 'unverified mutations', pendingMutations: 2 })
    recorder.onEvent({ type: 'retry', attempt: 1, reason: '429' })
    const notes = recorder.recording.transcript.messages.map((m) => m.note)
    expect(notes).toEqual(['gate', 'retry'])
  })

  it('attachUsage 把用量挂到最后一条 assistant 消息上', () => {
    const recorder = new TranscriptRecorder({ now: () => 'T', model: 'm1' })
    recorder.onEvent({ type: 'assistant', turn: 1, text: '我想好了。' })
    recorder.attachUsage({ in: 100, out: 20, cachedIn: 80 })
    const message = recorder.recording.transcript.messages[0]!
    expect(message.usage).toEqual({ in: 100, out: 20, cachedIn: 80 })
    expect(message.model).toBe('m1')
  })
})

describe('.mcai 真的存下了对话记录与截图（用户要求的"含对话记录"）', () => {
  it('**打包 → 解包，消息与截图逐条回来**', async () => {
    const store = makeStore()
    const log = new EditLog()
    const recorder = new TranscriptRecorder({ title: '造一座小屋', sessionId: 's1', now: () => 'T' })
    recorder.add('user', '造一座 4x4 的小屋')
    const png = fakePng(42)
    recorder.onEvent({ type: 'assistant', turn: 1, text: '先铺地板。' })
    recorder.onEvent({ type: 'tool_call', turn: 1, id: 'c1', name: 'fill_box', args: { from: [0, 0, 0], to: [3, 0, 3] } })
    recorder.onEvent({
      type: 'tool_result',
      turn: 1,
      id: 'c1',
      name: 'fill_box',
      result: { ok: true, summary: 'changed 16 cells' },
    })
    recorder.onEvent({
      type: 'tool_result',
      turn: 1,
      id: 'c2',
      name: 'screenshot',
      result: { ok: true, summary: 'shot', image: { png, width: 64, height: 48, camera: 'iso_ne', revision: 1 } },
    })
    recorder.attachUsage({ in: 1234, out: 56, cachedIn: 1000 })

    const bytes = packProject({
      name: '小屋',
      projectId: 'T1',
      store,
      log,
      settings: { volume },
      chat: recorder.recording.transcript,
      captures: recorder.recording.captures,
    })

    const project = unpackProject(bytes)
    expect(project.chat.messages).toHaveLength(recorder.messageCount)
    expect(project.chat.sessions[0]).toMatchObject({ id: 's1', title: '造一座小屋' })
    expect(project.chat.messages[0]).toMatchObject({ role: 'user', text: '造一座 4x4 的小屋' })
    expect(project.chat.messages.find((m) => m.usage !== undefined)?.usage).toMatchObject({ in: 1234, out: 56 })

    // 截图：索引与文件都在，字节完全一致
    expect(project.captures.refs).toHaveLength(1)
    expect(project.captures.files.size).toBe(1)
    expect(project.captures.files.get(project.captures.refs[0]!.id)).toEqual(png)
    expect(project.captureProblems).toEqual([])

    // counters 不再是写死的 0
    expect(project.manifest.counters).toMatchObject({ ops: 0, captures: 1, llmCalls: 1 })
  })

  it('**对话记录不影响方块数据的往返**（两者互相独立）', async () => {
    const store = makeStore()
    const before = store.contentHash()
    const log = new EditLog()
    const recorder = new TranscriptRecorder({ now: () => 'T' })
    recorder.add('user', 'x')
    const bytes = packProject({
      name: 'n',
      projectId: 'T2',
      store,
      log,
      settings: { volume },
      chat: recorder.recording.transcript,
      captures: recorder.recording.captures,
    })
    const { store: reopened } = openProject(bytes)
    expect(reopened.contentHash()).toBe(before)
  })

  it('**确定性**：同样的内容（含截图）打包两次字节相同', () => {
    const build = (): Uint8Array => {
      const recorder = new TranscriptRecorder({ sessionId: 'fixed', now: () => 'T' })
      recorder.add('user', 'x')
      recorder.onEvent({
        type: 'tool_result',
        turn: 1,
        id: 'c1',
        name: 'screenshot',
        result: { ok: true, summary: 's', image: { png: fakePng(5), width: 8, height: 8, camera: 'iso_sw', revision: 1 } },
      })
      return packProject({
        name: 'n',
        projectId: 'T3',
        store: makeStore(),
        log: new EditLog(),
        settings: { volume },
        now: '2026-01-01T00:00:00.000Z',
        chat: recorder.recording.transcript,
        captures: recorder.recording.captures,
      })
    }
    expect(Buffer.from(build()).equals(Buffer.from(build()))).toBe(true)
  })

  it('省略 chat / captures 时写成空档案，老调用点不必改', () => {
    const bytes = packProject({ name: 'n', projectId: 'T4', store: makeStore(), log: new EditLog(), settings: { volume } })
    const project = unpackProject(bytes)
    expect(project.chat).toEqual({ sessions: [], messages: [] })
    expect(project.captures.refs).toEqual([])
    expect(project.manifest.counters.captures).toBe(0)
  })

  it('**没有对话的老工程照样能打开**（对话不是完整性的必要条件）', () => {
    const store = makeStore()
    const bytes = packProject({ name: 'n', projectId: 'T5', store, log: new EditLog(), settings: { volume } })
    // 手工把 chat/* 与 captures/* 剔掉，模拟一个更早的、或者被裁剪过的工程
    const { unzipSync, zipSync: zip, strToU8 } = require('fflate') as typeof import('fflate')
    const entries = unzipSync(bytes)
    const trimmed: Record<string, Uint8Array> = {}
    for (const [path, data] of Object.entries(entries)) {
      if (path.startsWith('chat/') || path.startsWith('captures/')) continue
      trimmed[path] = data
    }
    trimmed['meta/log.txt'] = strToU8('trimmed\n')
    const project = unpackProject(zip(trimmed as never))
    expect(project.chat.messages).toEqual([])
    expect(project.captures.refs).toEqual([])
    expect(project.snapshot.columns.length).toBeGreaterThan(0)
  })

  it('截图索引被改坏时报出来，但仍然能打开工程', () => {
    const store = makeStore()
    const bytes = packProject({
      name: 'n',
      projectId: 'T6',
      store,
      log: new EditLog(),
      settings: { volume },
      captures: buildCaptureBundle([
        {
          ref: makeCaptureRef(fakePng(1), { revision: 1, camera: 'iso_ne', width: 8, height: 8 }, 'a'.repeat(64)),
          png: fakePng(1),
        },
      ]),
    })
    const { unzipSync } = require('fflate') as typeof import('fflate')
    const entries = unzipSync(bytes)
    // 只留下索引，删掉 PNG —— 索引与文件对不上
    const broken: Record<string, Uint8Array> = {}
    for (const [path, data] of Object.entries(entries)) {
      if (path.startsWith('captures/') && path.endsWith('.png')) continue
      broken[path] = data
    }
    const project = unpackProject((require('fflate') as typeof import('fflate')).zipSync(broken as never))
    expect(project.captureProblems.length).toBeGreaterThan(0)
    expect(project.captureProblems[0]).toContain('has no file')
    // 但方块数据仍然读出来了
    expect(project.snapshot.columns.length).toBeGreaterThan(0)
  })
})

describe('seed：接着一份已有档案继续录', () => {
  it('**消息与截图都接上，且新消息不会撞 id**', () => {
    const first = new TranscriptRecorder({ title: '第一段', now: () => '2026-01-01T00:00:00.000Z' })
    first.add('user', '造一座塔')
    first.onEvent({ type: 'assistant', turn: 1, text: '先量一下' })
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4])
    first.onEvent({ type: 'tool_call', turn: 1, id: 'c1', name: 'shoot', args: {} })
    first.onEvent({
      type: 'tool_result',
      turn: 1,
      id: 'c1',
      name: 'shoot',
      result: { ok: true, summary: '一张图', image: { png, width: 4, height: 4, camera: 'iso_ne', revision: 2 } },
    })
    const before = first.recording
    const beforeCount = before.transcript.messages.length
    expect(before.captures.refs.length).toBe(1)

    const second = new TranscriptRecorder({ title: '第二段', now: () => '2026-01-02T00:00:00.000Z' })
    second.seed(before.transcript, before.captures)
    const added = second.add('user', '再加一层')
    expect(added.id).toBeGreaterThan(Math.max(...before.transcript.messages.map((m) => m.id)))

    const after = second.recording
    expect(after.transcript.messages).toHaveLength(beforeCount + 1)
    expect(after.captures.refs.length).toBe(1)
    expect(after.captures.files.get(after.captures.refs[0]!.id)).toEqual(png)
    // 会话信息也接上了（不是"未命名会话"）
    expect(after.transcript.sessions[0]!.title).toBe('第一段')
  })

  it('截图文件缺失时如实跳过（不塞一张空图）', () => {
    const recorder = new TranscriptRecorder()
    recorder.seed(
      { sessions: [], messages: [] },
      {
        refs: [
          { id: 'ghost', revision: 1, camera: 'iso_ne', width: 4, height: 4, bytes: 4, sha256: 'x', file: 'captures/ghost.png' },
        ],
        files: new Map(),
      },
    )
    expect(recorder.captureCount).toBe(0)
  })
})

describe('档案自带的用量计数（打开工程时界面不能靠猜）', () => {
  it('**轮数 / 工具次数 / 截图数都原样存下来**', () => {
    const recorder = new TranscriptRecorder({ title: '灯塔', now: () => '2026-01-01T00:00:00.000Z' })
    // 两轮：第一轮一次工具调用 + 一张截图，第二轮一次工具调用
    recorder.onEvent({ type: 'turn', turn: 1 })
    recorder.onEvent({ type: 'assistant', turn: 1, text: '先看看' })
    recorder.onEvent({ type: 'tool_call', turn: 1, id: 'c1', name: 'shoot', args: {} })
    recorder.onEvent({ type: 'images', turn: 1, count: 1, bytes: 100 })
    recorder.onEvent({
      type: 'tool_result',
      turn: 1,
      id: 'c1',
      name: 'shoot',
      result: { ok: true, summary: '一张图' },
    })
    recorder.onEvent({ type: 'turn', turn: 2 })
    recorder.onEvent({ type: 'tool_call', turn: 2, id: 'c2', name: 'measure', args: {} })
    recorder.attachUsage({ in: 1000, out: 20, cachedIn: 900 }, 'deepseek-flash')

    const totals = recorder.recording.transcript.sessions[0]!.totals!
    expect(totals).toEqual({ in: 1000, out: 20, cachedIn: 900, turns: 2, toolCalls: 2, screenshots: 1 })

    // seed 之后计数接着走（否则"打开旧工程 → 再跑一轮"会把轮数抹成 1）
    const second = new TranscriptRecorder()
    second.seed(recorder.recording.transcript, recorder.recording.captures)
    second.onEvent({ type: 'turn', turn: 3 })
    expect(second.recording.transcript.sessions[0]!.totals!.turns).toBe(3)
    expect(second.recording.transcript.sessions[0]!.totals!.in).toBe(1000)
  })

  it('没有用量时计数仍然在（in/out 为 0）', () => {
    const recorder = new TranscriptRecorder()
    recorder.onEvent({ type: 'turn', turn: 1 })
    const totals = recorder.recording.transcript.sessions[0]!.totals!
    expect(totals).toMatchObject({ in: 0, out: 0, turns: 1, toolCalls: 0, screenshots: 0 })
  })

  it('**截图 id 只收内容寻址的样子**，条目名里的路径不会被传下去', () => {
    // id 是从**不可信的 zip 条目名**里切出来的，而重新打包时会按它拼
    // `captures/<id>.png`。放行 `../../x` 就等于把穿越条目名原样交给下一个解压这份
    // 工程的人（打开 → 另存 → 分享，恶意条目就这么传下去）。
    const { bundle, problems } = collectCaptures(
      {
        'captures/../../../../../../tmp/evil.png': new Uint8Array([1]),
        'captures/abcdef0123456789.png': new Uint8Array([2]),
        'chat/messages.jsonl': new Uint8Array([3]),
      },
      [],
    )
    expect([...bundle.files.keys()], '穿越条目名被收下了').toEqual(['abcdef0123456789'])
    expect(problems.join(' ')).toContain('dropped')
  })
})
