import { describe, expect, it } from 'vitest'

import { invertChanges } from '../src/entity/types.js'
import type { PlacedBlockEntity, PlacedEntity } from '../src/entity/types.js'
import type { Bounds } from '../src/types.js'
import { copyRegion, pasteRegion } from '../src/world/clipboard.js'
import { WorldStore } from '../src/world/store.js'
import { symmetrize } from '../src/world/symmetrize.js'

/**
 * **搬运类操作要把三层一起搬**（plan D-87）。
 *
 * `paste_region` 与 `symmetrize` 只搬方块的话，复制一座仓库得到的是一排空箱子、
 * 镜像一座码头得到的是一片没有船的水面——而这两件事**都不会报错**。
 * 这个文件盯的就是"另外两层真的跟着走了"，以及它们走的方向对不对。
 */

const defaultVolume: Bounds = { min: { x: 0, y: 0, z: 0 }, max: { x: 32, y: 12, z: 32 } }
const makeStore = (volume: Bounds = defaultVolume): WorldStore =>
  new WorldStore({ minecraftVersion: '1.21.4', volume })

const place = (store: WorldStore, entity: PlacedEntity): void => {
  const change = store.entities.set(entity)
  if (change !== undefined) store.commitSparse({ entities: [change] })
}

const putBlockEntity = (store: WorldStore, entry: PlacedBlockEntity): void => {
  const change = store.blockEntities.set(entry)
  if (change !== undefined) store.commitSparse({ blockEntities: [change] })
}

const boat = (id: string, x: number, y: number, z: number, yaw = 0): PlacedEntity => ({
  id,
  type: 'minecraft:oak_boat',
  x,
  y,
  z,
  yaw,
})

describe('copy_region：另外两层也在剪贴板里', () => {
  it('带走在区域内的实体（按格判，位置保持浮点）', () => {
    const store = makeStore()
    place(store, boat('e_1_1', 2.5, 0.2, 3.5))
    place(store, boat('e_1_2', 20.5, 0.2, 3.5)) // 区域外

    const clip = copyRegion(store, { x: 0, y: 0, z: 0 }, { x: 5, y: 5, z: 5 })
    expect(clip.entities.map((entry) => entry.entity.type)).toEqual(['minecraft:oak_boat'])
    // 局部坐标是**浮点**：船停在半格上是常态，按格存会把它挪到墙角
    expect(clip.entities[0]).toMatchObject({ x: 2.5, y: 0.2, z: 3.5 })
  })

  it('`only` 是个方块名过滤器，所以它**不**顺走实体', () => {
    const store = makeStore()
    store.setBlock({ x: 2, y: 0, z: 3 }, 'minecraft:stone')
    store.setBlock({ x: 2, y: 0, z: 4 }, 'minecraft:oak_planks')
    place(store, boat('e_1_1', 2.5, 0.2, 3.5))

    const filtered = copyRegion(store, { x: 0, y: 0, z: 0 }, { x: 5, y: 5, z: 5 }, { only: ['minecraft:stone'] })
    expect(filtered.cells).toHaveLength(1)
    expect(filtered.entities).toEqual([])

    const all = copyRegion(store, { x: 0, y: 0, z: 0 }, { x: 5, y: 5, z: 5 })
    expect(all.entities).toHaveLength(1)
  })

  it('方块实体的内容跟着方块走，且只跟**被复制了的**那几格', () => {
    const store = makeStore()
    store.setBlock({ x: 2, y: 0, z: 3 }, 'minecraft:chest')
    putBlockEntity(store, { x: 2, y: 0, z: 3, kind: 'chest', data: { Items: [{ id: 'minecraft:stone', count: 3 }] } })
    store.setBlock({ x: 2, y: 0, z: 4 }, 'minecraft:chest')
    putBlockEntity(store, { x: 2, y: 0, z: 4, kind: 'chest', data: { Items: [{ id: 'minecraft:dirt', count: 1 }] } })

    const clip = copyRegion(
      store,
      { x: 0, y: 0, z: 0 },
      { x: 5, y: 5, z: 5 },
      { only: ['minecraft:chest'] },
    )
    expect(clip.cells).toHaveLength(2)

    // 把 z=3 那一格从方块层滤掉（`only` 只按名字，所以这里手工验证判据是"格"）
    const narrowed = copyRegion(store, { x: 2, y: 0, z: 4 }, { x: 2, y: 0, z: 4 })
    expect(narrowed.blockEntities.map((entry) => entry.data)).toEqual([
      { Items: [{ id: 'minecraft:dirt', count: 1 }] },
    ])
  })
})

describe('paste_region：三层一起落，且只推进一格版本', () => {
  it('船跟着走过去：位置按旋转搬、yaw 一起转、id 重新发', () => {
    const store = makeStore()
    store.setBlock({ x: 2, y: 0, z: 3 }, 'minecraft:stone')
    // yaw 0 = 南（+Z）。区域绕中心顺时针 90° 之后，朝南的船应当朝西（yaw 4）
    place(store, boat('e_1_1', 2.5, 0.2, 3.5, 0))

    const clip = copyRegion(store, { x: 0, y: 0, z: 0 }, { x: 5, y: 5, z: 5 })
    const before = store.revision
    const result = pasteRegion(store, clip, { x: 10, y: 0, z: 0 }, { rotate: 90, confirm: true })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    // **一格版本**：三层一起落，但仍然只有一笔 op
    expect(store.revision).toBe(before + 1)
    expect(result.revision).toBe(store.revision)

    const list = store.entities.list()
    expect(list).toHaveLength(2)
    const copy = list.find((entity) => entity.id !== 'e_1_1')!
    // 区域 6×6，局部 (2.5, 3.5) 顺时针 90° → (6-3.5, 2.5) = (2.5, 2.5)
    expect(copy).toMatchObject({ x: 12.5, y: 0.2, z: 2.5, yaw: 4 })
    expect(copy.id).not.toBe('e_1_1')
  })

  it('箱子里的东西跟着走', () => {
    const store = makeStore()
    store.setBlock({ x: 2, y: 0, z: 3 }, 'minecraft:chest')
    putBlockEntity(store, { x: 2, y: 0, z: 3, kind: 'chest', data: { Items: [{ id: 'minecraft:stone', count: 7 }] } })

    const clip = copyRegion(store, { x: 0, y: 0, z: 0 }, { x: 5, y: 5, z: 5 })
    const result = pasteRegion(store, clip, { x: 10, y: 0, z: 0 }, { confirm: true })
    expect(result.ok).toBe(true)

    expect(store.getBlockString({ x: 12, y: 0, z: 3 })).toContain('minecraft:chest')
    expect(store.blockEntities.at({ x: 12, y: 0, z: 3 })).toMatchObject({
      kind: 'chest',
      data: { Items: [{ id: 'minecraft:stone', count: 7 }] },
    })
  })

  it('`mode: keep` 跳过的格子**不会**被塞进一份箱子内容', () => {
    const store = makeStore()
    store.setBlock({ x: 2, y: 0, z: 3 }, 'minecraft:chest')
    putBlockEntity(store, { x: 2, y: 0, z: 3, kind: 'chest', data: { Items: [{ id: 'minecraft:stone', count: 7 }] } })

    const clip = copyRegion(store, { x: 0, y: 0, z: 0 }, { x: 5, y: 5, z: 5 })
    // 目标那格先放上别的东西 → keep 会跳过它
    store.setBlock({ x: 12, y: 0, z: 3 }, 'minecraft:stone')
    const result = pasteRegion(store, clip, { x: 10, y: 0, z: 0 }, { mode: 'keep', confirm: true })
    expect(result.ok).toBe(true)

    expect(store.getBlockString({ x: 12, y: 0, z: 3 })).toBe('minecraft:stone')
    expect(store.blockEntities.at({ x: 12, y: 0, z: 3 })).toBeUndefined()
  })

  it('**没有方块也能贴**：一块空地上停着一条船', () => {
    const store = makeStore()
    place(store, boat('e_1_1', 2.5, 0.2, 3.5))

    const clip = copyRegion(store, { x: 0, y: 0, z: 0 }, { x: 5, y: 5, z: 5 })
    expect(clip.cells).toEqual([])

    const before = store.revision
    const result = pasteRegion(store, clip, { x: 10, y: 0, z: 0 }, { confirm: true })
    expect(result.ok).toBe(true)
    // 一格方块都没改，版本靠稀疏层那一次推进——否则这一笔没有 op
    expect(store.revision).toBe(before + 1)
    expect(store.entities.list()).toHaveLength(2)
  })

  it('撤销：反演这一笔的差分能把两层都放回去', () => {
    const store = makeStore()
    store.setBlock({ x: 2, y: 0, z: 3 }, 'minecraft:chest')
    putBlockEntity(store, { x: 2, y: 0, z: 3, kind: 'chest', data: { Items: [{ id: 'minecraft:stone', count: 7 }] } })
    place(store, boat('e_1_1', 2.5, 0.2, 3.5))

    const clip = copyRegion(store, { x: 0, y: 0, z: 0 }, { x: 5, y: 5, z: 5 })
    const result = pasteRegion(store, clip, { x: 10, y: 0, z: 0 }, { confirm: true })
    expect(result.ok).toBe(true)
    if (!result.ok) return

    // 日志里的顺序是"剪除在前、主动在后"，反演要把整个序列倒过来
    const inverse = {
      entities: invertChanges(result.sparse.entities ?? []),
      blockEntities: invertChanges([...result.blockEntityChanges, ...(result.sparse.blockEntities ?? [])]),
    }
    store.applySparse(inverse, false)

    expect(store.entities.list().map((entity) => entity.id)).toEqual(['e_1_1'])
    expect(store.blockEntities.at({ x: 2, y: 0, z: 3 })).toMatchObject({ kind: 'chest' })
    expect(store.blockEntities.at({ x: 12, y: 0, z: 3 })).toBeUndefined()
  })
})

describe('symmetrize：镜像时三层一起走', () => {
  it('船映到目标半区，位置按"过格心"的平面算、yaw 跟着镜像', () => {
    const store = makeStore()
    store.setBlock({ x: 3, y: 0, z: 5 }, 'minecraft:oak_planks')
    // yaw 12 = 东；沿 X 镜像之后应当变成西（yaw 4）
    place(store, boat('e_1_1', 3.5, 0.2, 5.5, 12))

    const result = symmetrize(store, { axis: 'x', coordinate: 8, source: 'negative', confirm: true })
    expect(result.ok).toBe(true)

    const list = store.entities.list()
    expect(list).toHaveLength(2)
    const copy = list.find((entity) => entity.id !== 'e_1_1')!
    // 点 `p → 2c+1-p`：3.5 → 13.5；block 3 → 13
    expect(copy).toMatchObject({ x: 13.5, y: 0.2, z: 5.5, yaw: 4 })
    expect(store.getBlockString({ x: 13, y: 0, z: 5 })).toBe('minecraft:oak_planks')
  })

  it('方块实体的内容映过去', () => {
    const store = makeStore()
    store.setBlock({ x: 3, y: 0, z: 5 }, 'minecraft:chest')
    putBlockEntity(store, { x: 3, y: 0, z: 5, kind: 'chest', data: { Items: [{ id: 'minecraft:stone', count: 2 }] } })

    symmetrize(store, { axis: 'x', coordinate: 8, source: 'negative', confirm: true })
    expect(store.blockEntities.at({ x: 13, y: 0, z: 5 })).toMatchObject({
      kind: 'chest',
      data: { Items: [{ id: 'minecraft:stone', count: 2 }] },
    })
  })

  it('`clear: true`（默认）把目标侧原有的实体删掉——"以源半区为准"', () => {
    const store = makeStore()
    store.setBlock({ x: 3, y: 0, z: 5 }, 'minecraft:oak_planks')
    place(store, boat('e_1_1', 3.5, 0.2, 5.5))
    place(store, boat('e_1_2', 13.5, 0.2, 5.5)) // 目标侧，应当被清掉

    symmetrize(store, { axis: 'x', coordinate: 8, source: 'negative', confirm: true })
    const ids = store.entities.list().map((entity) => entity.id)
    expect(ids).not.toContain('e_1_2')
    expect(store.entities.list()).toHaveLength(2)
  })

  it('`clear: false`（只补空缺）：目标格上有方块就不补实体，也不删任何东西', () => {
    const store = makeStore()
    store.setBlock({ x: 3, y: 0, z: 5 }, 'minecraft:oak_planks')
    place(store, boat('e_1_1', 3.5, 0.2, 5.5))
    // 镜像落点 x=13 上已经有一座别的东西 → "只补空缺"不动它，也不把船叠上去
    store.setBlock({ x: 13, y: 0, z: 5 }, 'minecraft:stone')
    place(store, boat('e_1_2', 13.5, 0.2, 5.5))

    symmetrize(store, { axis: 'x', coordinate: 8, source: 'negative', clear: false, confirm: true })
    const ids = store.entities.list().map((entity) => entity.id)
    expect(ids).toEqual(['e_1_1', 'e_1_2'])
  })

  it('竖直镜像不给 yaw 取反，但把 pitch 翻过来', () => {
    const store = makeStore()
    store.setBlock({ x: 3, y: 2, z: 5 }, 'minecraft:oak_planks')
    const change = store.entities.set({
      id: 'e_1_1',
      type: 'minecraft:armor_stand',
      x: 3.5,
      y: 2.2,
      z: 5.5,
      yaw: 12,
      pitch: 30,
    })
    store.commitSparse({ entities: [change!] })

    symmetrize(store, { axis: 'y', coordinate: 5, source: 'negative', confirm: true })
    const copy = store.entities.list().find((entity) => entity.id !== 'e_1_1')!
    expect(copy).toMatchObject({ y: 8.8, yaw: 12, pitch: -30 })
  })
})

describe('稀疏层摘要（避免"复制了一座仓库、箱子是空的"读不出来）', () => {
  it('一次搬运只推进一格版本，摘要句说得出带了几层', () => {
    const store = makeStore()
    store.setBlock({ x: 2, y: 0, z: 3 }, 'minecraft:chest')
    putBlockEntity(store, { x: 2, y: 0, z: 3, kind: 'chest', data: { Items: [] } })
    place(store, boat('e_1_1', 2.5, 0.2, 3.5))

    const clip = copyRegion(store, { x: 0, y: 0, z: 0 }, { x: 5, y: 5, z: 5 })
    const before = store.revision
    const result = pasteRegion(store, clip, { x: 10, y: 0, z: 0 }, { confirm: true })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(store.revision).toBe(before + 1)
    expect(result.sparse.entities?.length).toBe(1)
    expect(result.sparse.blockEntities?.length).toBe(1)
  })
})
