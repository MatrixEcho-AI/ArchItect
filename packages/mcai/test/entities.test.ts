import { EditLog, WorldStore } from '@architect/core'
import type { Bounds, PlacedBlockEntity, PlacedEntity } from '@architect/core'
import { strToU8, unzipSync, zipSync } from 'fflate'
import { describe, expect, it } from 'vitest'

import { ENTRY_ORDER, FIXED_MTIME, McaiFormatError, PATHS } from '../src/manifest.js'
import { openProject, packProject, unpackProject } from '../src/project.js'
import { decodeBlockEntities, decodeEntities, encodeBlockEntities, encodeEntities } from '../src/sparse.js'

const volume: Bounds = { min: { x: -4, y: 0, z: -4 }, max: { x: 24, y: 24, z: 24 } }
const newStore = (): WorldStore => new WorldStore({ minecraftVersion: '1.21.4', volume })

const boat = (id: string, x = 3.5, y = 1, z = 4.5): PlacedEntity => ({
  id,
  type: 'minecraft:oak_boat',
  x,
  y,
  z,
  yaw: 8,
})

const barrel = (x: number, y: number, z: number): PlacedBlockEntity => ({
  x,
  y,
  z,
  kind: 'barrel',
  data: { items: [{ slot: 0, id: 'minecraft:coal', count: 8 }] },
})

const pack = (store: WorldStore, log: EditLog, extra?: ReadonlyMap<string, Uint8Array>): Uint8Array =>
  packProject({
    name: '测试工程',
    projectId: '01ENT000000000000000000',
    store,
    log,
    settings: { volume },
    now: '2026-01-01T00:00:00.000Z',
    ...(extra !== undefined ? { extra } : {}),
  })

/** 造一个三层都有内容的世界：基准里一个方块实体，两条 op 各放一条船。 */
function scene(): { store: WorldStore; log: EditLog } {
  const store = newStore()
  const log = new EditLog()
  const ts = '2026-01-01T00:00:00.000Z'

  // rev 0 的基准：一个桶 + 它里面的东西（等价于从 .schem 导入进来的内容）
  store.setBlock({ x: 2, y: 1, z: 2 }, 'minecraft:barrel')
  store.blockEntities.set(barrel(2, 1, 2))
  store.setRevision(0)

  const first = store.entities.set(boat('e_1_1'))!
  log.record(
    undefined,
    { tool: 'place_entity', args: {}, ts, worldRevision: store.commitEntities([first]) },
    { entities: [first] },
  )
  const second = store.entities.set(boat('e_2_1', 9.5, 1, 9.5))!
  log.record(
    undefined,
    { tool: 'place_entity', args: {}, ts, worldRevision: store.commitEntities([second]) },
    { entities: [second] },
  )
  return { store, log }
}

describe('sparse：两层基快照的编解码', () => {
  it('往返逐字段相等；空集合编码成空串', () => {
    const entities: PlacedEntity[] = [
      boat('e_1_1'),
      { ...boat('e_1_2', 9.5, 2, 9.5), pitch: 15, data: { passengers: [{ type: 'minecraft:pig' }] } },
    ]
    expect(decodeEntities(encodeEntities(entities))).toEqual(entities)
    const blockEntities = [barrel(1, 2, 3), { x: 4, y: 5, z: 6, kind: 'sign', data: {} }]
    expect(decodeBlockEntities(encodeBlockEntities(blockEntities))).toEqual(blockEntities)
    expect(encodeEntities([])).toBe('')
    expect(encodeBlockEntities([])).toBe('')
    expect(decodeEntities('')).toEqual([])
  })

  it('坏行给出带行号的报错，而不是静默丢掉那一行', () => {
    expect(() => decodeEntities('{"id":"a"}\n')).toThrow(McaiFormatError)
    const good = JSON.stringify(boat('e_1_1'))
    expect(() => decodeEntities(`${good}\nnot json\n`)).toThrow(/第 2 行/)
    expect(() => decodeBlockEntities(`${JSON.stringify(barrel(1, 1, 1))}\n[]\n`)).toThrow(/不是一个对象/)
  })

  it('类型串形状不合法会被拒绝', () => {
    expect(() => decodeEntities(JSON.stringify({ ...boat('e_1_1'), type: 'Oak Boat!' }))).toThrow(/不是合法形状/)
    expect(() => decodeBlockEntities(JSON.stringify({ ...barrel(1, 1, 1), kind: 'a b' }))).toThrow(/不是合法形状/)
  })

  it('方块实体的坐标必须是整数格', () => {
    expect(() => decodeBlockEntities(JSON.stringify({ ...barrel(1, 1, 1), x: 1.5 }))).toThrow(/必须是整数/)
  })

  it('坐标与朝向必须是有限数字', () => {
    expect(() => decodeEntities(JSON.stringify({ ...boat('e_1_1'), y: 'x' }))).toThrow(/必须是有限数字/)
    expect(() => decodeEntities(JSON.stringify({ ...boat('e_1_1'), z: null }))).toThrow(/必须是有限数字/)
  })

  it('超过各层自己的上限时拒绝（和内存里的上限是同一个数字）', () => {
    const many = Array.from({ length: 4097 }, (_, i) => JSON.stringify(boat(`e_1_${i}`))).join('\n') + '\n'
    expect(() => decodeEntities(many)).toThrow(/超过上限 4096/)
  })
})

describe('.mcai 的两层稀疏数据', () => {
  it('打包再打开：三层内容与哈希都一致', () => {
    const { store, log } = scene()
    const bytes = pack(store, log)

    const { store: reopened, project } = openProject(bytes)
    expect(reopened.stats().blocks).toBe(store.stats().blocks)
    expect(reopened.entities.size).toBe(2)
    expect(reopened.blockEntities.size).toBe(1)
    expect(reopened.blockEntities.at({ x: 2, y: 1, z: 2 })).toEqual(barrel(2, 1, 2))
    expect(reopened.contentHash()).toBe(store.contentHash())
    expect(project.manifest.worldHash).toBe(store.contentHash())
    expect(project.entities).toHaveLength(2)
    expect(project.blockEntities).toEqual([barrel(2, 1, 2)])
  })

  it('两个条目真的写进了 zip，而且都在 ENTRY_ORDER 里（打包才是确定性的）', () => {
    const { store, log } = scene()
    const entries = unzipSync(pack(store, log))
    expect(Object.keys(entries)).toContain(PATHS.entities)
    expect(Object.keys(entries)).toContain(PATHS.blockEntities)
    expect(ENTRY_ORDER).toContain(PATHS.entities)
    expect(ENTRY_ORDER).toContain(PATHS.blockEntities)
  })

  it('空集合不写条目：没用到这两层的工程字节与以前一致，老读方也照常打开', () => {
    const store = newStore()
    const log = new EditLog()
    store.setBlock({ x: 0, y: 0, z: 0 }, 'minecraft:stone')
    store.setRevision(0)

    const bytes = pack(store, log)
    const entries = Object.keys(unzipSync(bytes))
    expect(entries).not.toContain(PATHS.entities)
    expect(entries).not.toContain(PATHS.blockEntities)

    // "缺了就是空"：老工程（以及所有没用到这两层的工程）必须能打开
    const { store: reopened } = openProject(bytes)
    expect(reopened.entities.size).toBe(0)
    expect(reopened.blockEntities.size).toBe(0)
    expect(reopened.contentHash()).toBe(store.contentHash())
  })

  it('baseRevision 之后的实体变更靠重放回到世界（不是只有快照那一条路）', () => {
    // packProject 每次都写全量快照（baseRevision === revision），所以这条路径
    // 平时跑不到。这里手工拼一份 baseRevision < revision 的工程——将来快照改成
    // 增量、或者别的工具产出这种文件时，走的就是它。
    const { store, log } = scene()

    // 先打包 rev 1 的状态：快照里只有一条船
    const partial = newStore()
    const partialLog = new EditLog()
    partial.setBlock({ x: 2, y: 1, z: 2 }, 'minecraft:barrel')
    partial.blockEntities.set(barrel(2, 1, 2))
    partial.setRevision(0)
    const only = partial.entities.set(boat('e_1_1'))!
    partialLog.record(
      undefined,
      { tool: 'place_entity', args: {}, ts: '2026-01-01T00:00:00.000Z', worldRevision: partial.commitEntities([only]) },
      { entities: [only] },
    )
    const entries: Record<string, Uint8Array> = {}
    for (const [path, data] of Object.entries(unzipSync(pack(partial, partialLog)))) entries[path] = data

    // 再把日志换成完整的两条 op，并把 manifest 推到 rev 2、baseRevision 留在 1
    const project = unpackProject(pack(partial, partialLog))
    entries[PATHS.edits] = strToU8(log.toJSONL())
    entries[PATHS.manifest] = strToU8(
      JSON.stringify({ ...project.manifest, revision: 2, baseRevision: 1, counters: { ops: 2, captures: 0, llmCalls: 0 } }, null, 2) + '\n',
    )

    const { store: reopened } = openProject(zipSync(entries, { mtime: FIXED_MTIME }))
    expect(reopened.revision).toBe(2)
    // 第二条船只存在于 op 2 的 entityChanges 里——只贴方块那一层的话它就是没了
    expect(reopened.entities.size).toBe(2)
    expect(reopened.entities.get('e_2_1')?.x).toBe(9.5)
    expect(reopened.contentHash()).toBe(store.contentHash())
  })
})

describe('未识别的条目：只收不写等于删', () => {
  it('④ 不认识两层新条目的读方打开再保存，条目还在、世界不降级', () => {
    const { store, log } = scene()
    const bytes = pack(store, log)

    // —— 模拟一个不认识这两个条目的读方 ——
    // 它只认旧的条目表，于是这两个条目落进它的 `extra`；它的世界里没有这两层
    const oldKnown = ENTRY_ORDER.filter((path) => path !== PATHS.entities && path !== PATHS.blockEntities)
    const oldExtra = new Map<string, Uint8Array>(
      Object.entries(unzipSync(bytes)).filter(
        ([path]) => !oldKnown.includes(path) && !path.startsWith('captures/'),
      ),
    )
    expect([...oldExtra.keys()].sort()).toEqual([PATHS.entities, PATHS.blockEntities].sort())

    const { store: oldStore, project: oldProject } = openProject(bytes)
    oldStore.entities.clear() // 这一层它根本不知道
    oldStore.blockEntities.clear()
    const resaved = pack(oldStore, oldProject.log, oldExtra)

    // —— 新读方打开"旧读方保存过"的文件：两层都还在 ——
    const { store: reopened } = openProject(resaved)
    expect(reopened.entities.size).toBe(2)
    expect(reopened.blockEntities.size).toBe(1)
    expect(reopened.stats().blocks).toBe(store.stats().blocks)
    expect(reopened.contentHash()).toBe(store.contentHash())
  })

  it('未知条目按名字排序写回，且不会盖掉已知条目', () => {
    const store = newStore()
    const log = new EditLog()
    store.setBlock({ x: 0, y: 0, z: 0 }, 'minecraft:stone')
    store.setRevision(0)

    const extra = new Map<string, Uint8Array>([
      ['future/z.bin', strToU8('zzz')],
      ['future/a.bin', strToU8('aaa')],
      // 恶意/手滑：塞一个已知路径进来，不该覆盖我们写的内容
      [PATHS.project, strToU8('{"volume":{"min":{"x":9,"y":9,"z":9},"max":{"x":9,"y":9,"z":9}}}')],
      // 截图有自己的通路，不当未知条目转发
      ['captures/deadbeef.png', strToU8('not a png')],
    ])
    const bytes = pack(store, log, extra)
    const entries = unzipSync(bytes)

    expect(new TextDecoder().decode(entries['future/a.bin']!)).toBe('aaa')
    expect(new TextDecoder().decode(entries['future/z.bin']!)).toBe('zzz')
    expect(entries['captures/deadbeef.png']).toBeUndefined()
    // 已知条目以我们写的为准
    const settings = JSON.parse(new TextDecoder().decode(entries[PATHS.project]!)) as { volume: { min: unknown } }
    expect(settings.volume.min).not.toEqual({ x: 9, y: 9, z: 9 })

    // 解开后它们仍然在 extra 里，可以被继续转发
    expect([...unpackProject(bytes).extra.keys()].sort()).toEqual(['future/a.bin', 'future/z.bin'])
  })

  it('zip 条目的顺序是确定的：同一个世界打两次字节完全相同', () => {
    const { store, log } = scene()
    const extra = new Map<string, Uint8Array>([['future/x.bin', strToU8('x')]])
    expect(pack(store, log, extra)).toEqual(pack(store, log, extra))
  })
})
