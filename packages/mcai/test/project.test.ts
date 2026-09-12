import {
  EditLog,
  forEachBox,
  forEachExtrude,
  forEachLine,
  WorldStore,
} from '@architect/core'
import type { Bounds, Pos } from '@architect/core'
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate'
import { describe, expect, it } from 'vitest'

import { McaiFormatError, PATHS, validateManifest } from '../src/manifest.js'
import { openProject, packProject, unpackProject } from '../src/project.js'
import { decodeSnapshot, encodeSnapshot, SnapshotError } from '../src/snapshot.js'

const volume: Bounds = { min: { x: -4, y: 0, z: -4 }, max: { x: 24, y: 24, z: 24 } }

const box = (from: Pos, to: Pos, mode: 'solid' | 'hollow' | 'outline' = 'solid') =>
  (visit: (x: number, y: number, z: number) => void) => forEachBox(from, to, mode, visit)

const rect = (x0: number, z0: number, x1: number, z1: number) => [
  { x: x0, z: z0 },
  { x: x1, z: z0 },
  { x: x1, z: z1 },
  { x: x0, z: z1 },
]

function scenario(): { store: WorldStore; log: EditLog } {
  const store = new WorldStore({ minecraftVersion: '1.21.4', volume })
  const log = new EditLog()
  let tick = 0
  const ts = (): string => new Date(Date.UTC(2026, 0, 1, 0, 0, tick++)).toISOString()

  const doWrite = (
    producer: Parameters<WorldStore['write']>[0],
    block: string,
    tool: string,
    args: unknown,
    opts: Parameters<WorldStore['write']>[2] = {},
  ): void => {
    const r = store.write(producer, store.palette.indexOf(block), { confirm: true, ...opts })
    log.record(r, { tool, args, ts: ts(), correlationId: 'turn_1' })
  }

  doWrite(box({ x: 0, y: 0, z: 0 }, { x: 11, y: 0, z: 11 }), 'minecraft:oak_planks', 'fill_box', {
    from: [0, 0, 0],
    to: [11, 0, 11],
  })
  doWrite(
    (v) =>
      forEachExtrude(rect(0, 0, 11, 11), { baseY: 1, height: 4, hollow: true, capTop: false, capBottom: false }, v),
    'minecraft:stone_bricks',
    'extrude',
    { points: rect(0, 0, 11, 11), baseY: 1, height: 4, hollow: true },
  )
  doWrite(box({ x: 5, y: 1, z: 0 }, { x: 5, y: 2, z: 0 }), 'minecraft:air', 'erase', {}, { mode: 'destroy' })
  doWrite(box({ x: 0, y: 1, z: 4 }, { x: 0, y: 1, z: 5 }), 'minecraft:glass', 'fill_box', {})
  doWrite(
    (v) => forEachLine({ x: 3, y: 5, z: 3 }, { x: 8, y: 10, z: 8 }, { radius: 1, taper: [2, 0] }, v),
    'minecraft:dark_prismarine',
    'fill_line',
    { from: [3, 5, 3], to: [8, 10, 8], radius: 1 },
  )
  return { store, log }
}

const pack = (store: WorldStore, log: EditLog): Uint8Array =>
  packProject({
    name: '测试小屋',
    projectId: '01TEST000000000000000000',
    store,
    log,
    settings: { volume, providerId: 'deepseek' },
    now: '2026-01-01T00:00:00.000Z',
  })

describe('快照编解码', () => {
  it('往返精确', () => {
    const { store } = scenario()
    const snapshot = {
      minY: store.minY,
      worldHeight: store.worldHeight,
      paletteSize: store.palette.size,
      columns: store.dumpColumns(),
    }
    const restored = decodeSnapshot(encodeSnapshot(snapshot))
    expect(restored.minY).toBe(snapshot.minY)
    expect(restored.worldHeight).toBe(snapshot.worldHeight)
    expect(restored.paletteSize).toBe(snapshot.paletteSize)
    expect(restored.columns).toHaveLength(snapshot.columns.length)
    for (let i = 0; i < snapshot.columns.length; i++) {
      expect(restored.columns[i]!.chunkX).toBe(snapshot.columns[i]!.chunkX)
      expect(restored.columns[i]!.chunkZ).toBe(snapshot.columns[i]!.chunkZ)
      expect(restored.columns[i]!.indices).toEqual(snapshot.columns[i]!.indices)
    }
  })

  it('空世界也能往返', () => {
    const store = new WorldStore({ minecraftVersion: '1.21.4', volume })
    const restored = decodeSnapshot(
      encodeSnapshot({
        minY: store.minY,
        worldHeight: store.worldHeight,
        paletteSize: store.palette.size,
        columns: store.dumpColumns(),
      }),
    )
    expect(restored.columns).toHaveLength(0)
  })

  it('魔数不对要报错', () => {
    expect(() => decodeSnapshot(new Uint8Array(64))).toThrow(SnapshotError)
    expect(() => decodeSnapshot(new Uint8Array(64))).toThrow(/magic number/)
  })

  it('太短的输入要报错', () => {
    expect(() => decodeSnapshot(new Uint8Array(8))).toThrow(/too short for a header/)
  })

  it('列长度不符要报错', () => {
    expect(() =>
      encodeSnapshot({
        minY: 0,
        worldHeight: 2,
        paletteSize: 2,
        columns: [{ chunkX: 0, chunkZ: 0, indices: new Uint16Array(10) }],
      }),
    ).toThrow(/expected/)
  })
})

describe('.mcai 打包 / 解包往返', () => {
  it('打到 zip 再解开，世界哈希一致', () => {
    const { store, log } = scenario()
    const bytes = pack(store, log)

    const { store: reopened, project } = openProject(bytes)
    expect(reopened.contentHash()).toBe(store.contentHash())
    expect(reopened.revision).toBe(log.length)
    expect(project.manifest.name).toBe('测试小屋')
    expect(project.manifest.minecraftVersion).toBe('1.21.4')
    expect(project.manifest.worldHash).toBe(store.contentHash())
  })

  it('逐格核对（不只比哈希）', () => {
    const { store, log } = scenario()
    const { store: reopened } = openProject(pack(store, log))
    for (let x = -4; x <= 24; x++) {
      for (let y = 0; y <= 12; y++) {
        for (let z = -4; z <= 24; z++) {
          const a = store.getBlockString({ x, y, z })
          const b = reopened.getBlockString({ x, y, z })
          if (a !== b) throw new Error(`(${x},${y},${z}) 原始=${a} 重开=${b}`)
        }
      }
    }
    expect(true).toBe(true)
  })

  it('事件日志原样保留', () => {
    const { store, log } = scenario()
    const { project } = openProject(pack(store, log))
    expect(project.log.length).toBe(log.length)
    expect(project.log.validate()).toEqual([])
    for (let i = 0; i < log.length; i++) {
      expect(project.log.at(i)!.tool).toBe(log.at(i)!.tool)
      expect(project.log.at(i)!.args).toEqual(log.at(i)!.args)
      expect(project.log.at(i)!.patch.length).toBe(log.at(i)!.patch.length)
    }
  })

  it('调色板原样保留（顺序也一致）', () => {
    const { store, log } = scenario()
    const { project } = openProject(pack(store, log))
    expect(project.palette.strings()).toEqual(store.palette.strings())
  })

  it('settings 原样保留，且**不含任何密钥字段**', () => {
    const { store, log } = scenario()
    const bytes = pack(store, log)
    const { project } = openProject(bytes)
    expect(project.settings.volume).toEqual(volume)
    expect(project.settings.providerId).toBe('deepseek')

    // 红线 2：.mcai 是可分享文件，绝不能出现 API key
    const text = new TextDecoder().decode(bytes)
    expect(text).not.toMatch(/sk-[A-Za-z0-9]{16,}/)
    expect(text).not.toMatch(/api[_-]?key["':\s]/i)
  })

  it('确定性打包：相同内容产生相同字节', () => {
    const a = scenario()
    const b = scenario()
    const bytesA = pack(a.store, a.log)
    const bytesB = pack(b.store, b.log)
    expect(bytesB).toEqual(bytesA)
  })

  it('zip 里包含约定的条目', () => {
    const { store, log } = scenario()
    const { project } = openProject(pack(store, log))
    expect(project.manifest.revision).toBe(5)
    expect(project.manifest.baseRevision).toBe(5)
    expect(project.extra.size).toBe(0) // 没有未识别的条目
  })

  it('空工程也能往返', () => {
    const store = new WorldStore({ minecraftVersion: '1.21.4', volume })
    const log = new EditLog()
    const { store: reopened } = openProject(pack(store, log))
    expect(reopened.stats().blocks).toBe(0)
    expect(reopened.revision).toBe(0)
    expect(reopened.contentHash()).toBe(store.contentHash())
  })

  it('多列工程（跨 chunk）也能往返', () => {
    const store = new WorldStore({
      minecraftVersion: '1.21.4',
      volume: { min: { x: 0, y: 0, z: 0 }, max: { x: 40, y: 8, z: 40 } },
    })
    const log = new EditLog()
    store.write(
      box({ x: 0, y: 0, z: 0 }, { x: 40, y: 0, z: 40 }, 'outline'),
      store.palette.indexOf('minecraft:stone'),
      { confirm: true },
    )
    log.record(
      store.write(box({ x: 0, y: 1, z: 0 }, { x: 40, y: 1, z: 1 }), store.palette.indexOf('minecraft:dirt'), {
        confirm: true,
      }),
      { tool: 'fill_box', args: {} },
    )
    const { store: reopened } = openProject(pack(store, log))
    expect(reopened.contentHash()).toBe(store.contentHash())
    expect(reopened.allocatedColumns).toBeGreaterThan(1)
  })
})

describe('.mcai 的损坏检测', () => {
  it('缺少 manifest 会明确报错', () => {
    const other = new Uint8Array([1, 2, 3])
    expect(() => unpackProject(other)).toThrow()
  })

  it('manifest 字段缺失会报错', () => {
    expect(() => validateManifest({ formatVersion: '0.1' })).toThrow(McaiFormatError)
    expect(() => validateManifest({ formatVersion: '0.1' })).toThrow(/missing required fields/)
  })

  it('格式主版本不兼容会报错', () => {
    const { store, log } = scenario()
    const bytes = pack(store, log)
    const project = unpackProject(bytes)
    expect(() =>
      validateManifest({ ...project.manifest, formatVersion: '9.0' }),
    ).toThrow(/different major version/)
  })

  it('baseRevision 大于 revision 会报错', () => {
    const { store, log } = scenario()
    const project = unpackProject(pack(store, log))
    expect(() => validateManifest({ ...project.manifest, baseRevision: 99 })).toThrow(
      /cannot exceed/,
    )
  })

  it('调色板条目数与快照声明不符会报错', () => {
    const { store, log } = scenario()
    const entries = unzipSync(pack(store, log))
    entries[PATHS.palette] = strToU8(
      JSON.stringify({ minecraftVersion: '1.21.4', entries: ['minecraft:air'] }),
    )
    expect(() => unpackProject(zipSync(entries))).toThrow(/palette has 1 entries but the snapshot declares/)
  })

  it('快照的世界高度与 manifest 不符会报错', () => {
    const { store, log } = scenario()
    const entries = unzipSync(pack(store, log))
    const manifest = JSON.parse(strFromU8(entries[PATHS.manifest]!)) as Record<string, unknown>
    manifest.worldHeight = (manifest.worldHeight as number) + 16
    entries[PATHS.manifest] = strToU8(JSON.stringify(manifest))
    expect(() => unpackProject(zipSync(entries))).toThrow(/world height does not match/)
  })

  it('快照正文被截断会报错（不是静默读出垃圾）', () => {
    const { store, log } = scenario()
    const entries = unzipSync(pack(store, log))
    const base = entries[PATHS.base]!
    entries[PATHS.base] = base.subarray(0, base.length - 32)
    expect(() => unpackProject(zipSync(entries))).toThrow()
  })

  it('PATHS 常量是稳定的（格式契约）', () => {
    expect(PATHS.manifest).toBe('manifest.json')
    expect(PATHS.base).toBe('world/base.mcvox')
    expect(PATHS.edits).toBe('history/edits.jsonl')
    expect(PATHS.messages).toBe('chat/messages.jsonl')
  })
})

describe('设计笔记跟着工程走（重开之后模型不该失忆）', () => {
  it('**保存 → 打开：笔记原样回来；没有笔记时不留空字段**', () => {
    const store = new WorldStore({ minecraftVersion: '1.21.4', volume })
    const log = new EditLog()
    const notes = '八角基座 17 格；塔身收分到 5 格；门朝南非，净高 3 格不能堵'

    // 注入时钟：manifest 里有 modifiedAt，不注入就每次都不一样（确定性测试的前提）
    const now = '2026-01-01T00:00:00.000Z'
    const withNotes = packProject({
      name: '灯塔',
      projectId: 'P1',
      store,
      log,
      settings: { volume },
      designNotes: notes,
      now,
    })
    const opened = openProject(withNotes).project
    expect(opened.manifest.designNotes).toBe(notes)
    // 打包是确定性的：同一份输入两次结果逐字节相同（笔记不该引入任何抖动）
    expect(
      packProject({ name: '灯塔', projectId: 'P1', store, log, settings: { volume }, designNotes: notes, now }),
    ).toEqual(withNotes)

    const without = packProject({ name: '灯塔', projectId: 'P1', store, log, settings: { volume }, now })
    const plain = openProject(without).project
    expect(plain.manifest.designNotes).toBeUndefined()
    // 空字符串也当"没有"，不写进 manifest（省得每份工程都挂一个空字段）
    const empty = packProject({
      name: '灯塔',
      projectId: 'P1',
      store,
      log,
      settings: { volume },
      designNotes: '',
      now,
    })
    expect(openProject(empty).project.manifest.designNotes).toBeUndefined()
  })
})

describe('格式版本策略：可选字段可以随便加，破坏性改动必须升版本', () => {
  it('**未来的读取方字段不认识也能打开**（新增可选字段不升版本的前提）', () => {
    const { store, log } = scenario()
    const entries = unzipSync(pack(store, log))
    const manifest = JSON.parse(strFromU8(entries[PATHS.manifest]!)) as Record<string, unknown>
    // 模拟"更高版本的 app 写出来的文件"：额外字段 + 已知字段的新取值
    manifest.futureSection = { anything: [1, 2, 3] }
    manifest.designNotes = '来自未来的笔记'
    entries[PATHS.manifest] = strToU8(JSON.stringify(manifest))

    const project = unpackProject(zipSync(entries))
    expect(project.manifest.revision).toBeGreaterThanOrEqual(0)
    // 未知字段**留着**：将来要原样转发（`extra` 那套也是同一个理由）
    // 读它要过一道 `unknown`：`Manifest` 没有索引签名，直接转 `Record` 不合法
    expect((project.manifest as unknown as Record<string, unknown>)['futureSection']).toEqual({
      anything: [1, 2, 3],
    })
  })

  it('**老文件缺可选字段也能打开**（向后兼容）', () => {
    const { store, log } = scenario()
    const entries = unzipSync(pack(store, log))
    const manifest = JSON.parse(strFromU8(entries[PATHS.manifest]!)) as Record<string, unknown>
    delete manifest.designNotes
    entries[PATHS.manifest] = strToU8(JSON.stringify(manifest))
    const project = unpackProject(zipSync(entries))
    expect(project.manifest.designNotes).toBeUndefined()
  })

  it('**主版本不同就直接拒**（而不是猜着读）', () => {
    const { store, log } = scenario()
    const entries = unzipSync(pack(store, log))
    const manifest = JSON.parse(strFromU8(entries[PATHS.manifest]!)) as Record<string, unknown>
    manifest.formatVersion = '9.0'
    entries[PATHS.manifest] = strToU8(JSON.stringify(manifest))
    expect(() => unpackProject(zipSync(entries))).toThrow(/different major version/)
  })

  it('缺必填字段时报出**具体缺了哪个**（迁移器不做，但错误要能指导人）', () => {
    const { store, log } = scenario()
    const entries = unzipSync(pack(store, log))
    const manifest = JSON.parse(strFromU8(entries[PATHS.manifest]!)) as Record<string, unknown>
    delete manifest.minecraftVersion
    entries[PATHS.manifest] = strToU8(JSON.stringify(manifest))
    expect(() => unpackProject(zipSync(entries))).toThrow(/minecraftVersion/)
  })
})

describe('不按文件声明的尺寸解压', () => {
  it('**条目声明解压后超大时拒绝**，而不是照着分配', () => {
    // `.mcai` 里的条目是压缩的，全零数据的压缩比约 1000×：实测 **1 MB** 的工程文件
    // 能让 `unpackProject` 吃掉 1 GB 内存，5 MB 就是 5 GB——V8 致命 OOM，不是可捕获
    // 的异常，而这条跑在桌面端**主进程**里（应用直接消失、未保存的编辑一起没）。
    //
    // 这里把中央目录里**声明**的解压尺寸改大：fflate 按它预分配，而 filter 在解压前
    // 就能看到它。
    const bytes = Uint8Array.from(zipSync({ 'chat/messages.jsonl': strToU8('[]') }))
    const signature = [0x50, 0x4b, 0x01, 0x02]
    let at = -1
    outer: for (let i = 0; i + 4 <= bytes.length; i++) {
      for (let k = 0; k < 4; k++) if (bytes[i + k] !== signature[k]) continue outer
      at = i
      break
    }
    expect(at, '没找到中央目录项——这个夹具需要跟着 zip 布局更新').toBeGreaterThanOrEqual(0)
    // 中央目录项里「解压后大小」在签名后第 24 字节
    new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).setUint32(at + 24, 0x7fffffff, true)
    expect(() => unpackProject(bytes)).toThrow(/byte limit/)
  })

  it('**快照声明了超大的正文长度时拒绝**，而不是照着分配', () => {
    // 快照正文是 zlib，头里的 `columnCount` 决定期望长度，而期望长度决定分配。
    // 头部布局：magic[8] | version | minY | worldHeight | paletteSize | **columnCount** | reserved
    const bytes = encodeSnapshot({ minY: 0, worldHeight: 384, paletteSize: 2, columns: [] })
    new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).setUint32(24, 3_000_000, true)
    expect(() => decodeSnapshot(bytes)).toThrow(/byte limit/)
  })

  it('对照：正常尺寸的快照编解码不受影响', () => {
    const snapshot = {
      minY: 0,
      worldHeight: 16,
      paletteSize: 2,
      columns: [{ chunkX: 0, chunkZ: 0, indices: new Uint16Array(16 * 256) }],
    }
    const back = decodeSnapshot(encodeSnapshot(snapshot))
    expect(back.worldHeight).toBe(16)
    expect(back.columns).toHaveLength(1)
  })
})
