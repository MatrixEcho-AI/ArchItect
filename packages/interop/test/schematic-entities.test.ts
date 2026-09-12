import { WorldStore } from '@architect/core'
import type { Bounds, PlacedEntity } from '@architect/core'
import { describe, expect, it } from 'vitest'

import { exportSchematic, importSchematicInto } from '../src/bridge.js'
import { numberFromJson } from '../src/json-nbt.js'
import {
  byteArray,
  compound,
  compoundList,
  int,
  intArray,
  list,
  readNbt,
  short,
  string,
  writeNbt,
} from '../src/nbt.js'
import { DATA_VERSION_1_21_4, readSpongeSchematic, writeSpongeSchematic } from '../src/schematic.js'

const volume: Bounds = { min: { x: -4, y: 0, z: -4 }, max: { x: 24, y: 24, z: 24 } }
const makeStore = (): WorldStore => new WorldStore({ minecraftVersion: '1.21.4', volume })

const boat = (id: string, x = 3.5, y = 1, z = 4.5, yaw = 8): PlacedEntity => ({
  id,
  type: 'minecraft:oak_boat',
  x,
  y,
  z,
  yaw,
})

/** 一个三层都有内容的世界：两个方块、一个方块实体、两条朝向不同的船。 */
function scene(): WorldStore {
  const store = makeStore()
  store.setBlock({ x: 0, y: 0, z: 0 }, 'minecraft:stone')
  store.setBlock({ x: 1, y: 0, z: 1 }, 'minecraft:barrel')
  store.blockEntities.set({
    x: 1,
    y: 0,
    z: 1,
    kind: 'minecraft:barrel',
    data: { CustomName: '{"text":"仓"}' },
  })
  store.entities.set(boat('e_1_1'))
  store.entities.set({ ...boat('e_1_2', 9.5, 1, 9.5, 4), pitch: 15, data: { CustomName: '{"text":"船"}' } })
  return store
}

const importInto = async (store: WorldStore, bytes: Uint8Array, at = { x: 0, y: 0, z: 0 }) =>
  importSchematicInto(store, await readSpongeSchematic(bytes), { at })

describe('.schem 的实体与方块实体', () => {
  it('导出 → 导入 → 再导出：**字节完全相同**', async () => {
    const source = scene()
    const first = exportSchematic(source)
    expect(first.problems).toEqual([])
    expect(first.entities).toBe(2)
    expect(first.blockEntities).toBe(1)

    const target = makeStore()
    const result = await importInto(target, first.bytes)
    expect(result.entities).toBe(2)
    expect(result.blockEntities).toBe(1)

    // 逐字节相同比"字段对得上"强：它连顺序、类型、空与非空都一起管住了
    expect(exportSchematic(target).bytes).toEqual(first.bytes)
  })

  it('类型、位置、朝向与附加数据都对上；落在格点上的 yaw 不会被塞进 data', async () => {
    const target = makeStore()
    await importInto(target, exportSchematic(scene()).bytes)
    const list2 = target.entities.list()

    expect(list2.map((entity) => entity.type)).toEqual(['minecraft:oak_boat', 'minecraft:oak_boat'])
    expect(list2[0]).toMatchObject({ x: 3.5, y: 1, z: 4.5, yaw: 8 })
    // 180° 正好是 8 × 22.5°，`yaw` 一个字段就够了，不该再留一份 Rotation
    expect(list2[0]!.data).toBeUndefined()
    expect(list2[1]).toMatchObject({ yaw: 4, pitch: 15, data: { CustomName: '{"text":"船"}' } })

    expect(target.blockEntities.at({ x: 1, y: 0, z: 1 })).toEqual({
      x: 1,
      y: 0,
      z: 1,
      kind: 'minecraft:barrel',
      data: { CustomName: '{"text":"仓"}' },
    })
  })

  it('**外部文件的非格点角度保留原值**：189.3° 不会被量化成 180°', async () => {
    const bytes = writeSpongeSchematic({
      size: [2, 2, 2],
      blocks: [{ x: 0, y: 0, z: 0, state: 'minecraft:stone' }],
      entities: [{ id: 'minecraft:oak_boat', pos: [0.5, 0, 0.5], data: { Rotation: [189.3, 45] } }],
      dataVersion: DATA_VERSION_1_21_4,
    })

    const target = makeStore()
    await importInto(target, bytes)
    const entity = target.entities.list()[0]!
    expect(entity.yaw).toBe(8) // 最近的格点，给模型与工具看
    expect(entity.pitch).toBe(45)

    // 原值留在 data 里，重新导出仍然写 189.3——外部文件 → 我们 → 外部文件无损
    const again = await readSpongeSchematic(exportSchematic(target).bytes)
    const rotation = again.entities![0]!.data['Rotation'] as unknown[]
    expect(numberFromJson(rotation[0])).toBeCloseTo(189.3, 9)
    expect(numberFromJson(rotation[1])).toBe(45)
  })

  it('v2 形状也认：`BlockEntities` 在**根**上、附加数据**内联**', async () => {
    // v2 与 v3 的三处差异全在这份手工文件里：根上的 BlockEntities、内联的附加数据、
    // 以及 `Data` 是定宽 2 字节大端而不是 VarInt
    const bytes = writeNbt({
      Schematic: compound({
        Version: int(2),
        DataVersion: int(DATA_VERSION_1_21_4),
        Width: short(1),
        Height: short(1),
        Length: short(1),
        Offset: intArray([0, 0, 0]),
        Blocks: compound({
          Palette: compound({ 'minecraft:air': int(0) }),
          Data: byteArray([0, 0]),
        }),
        BlockEntities: compoundList([
          {
            Pos: intArray([0, 0, 0]),
            Id: string('minecraft:sign'),
            Text1: string('hi'),
            Color: string('black'),
          },
        ]),
        Entities: compoundList([
          { Pos: list('double', [0.5, 0, 0.5]), Id: string('oak_boat'), Rotation: list('float', [90, 0]) },
        ]),
      }),
    })

    const parsed = await readSpongeSchematic(bytes)
    expect(parsed.blockEntities).toHaveLength(1)
    expect(parsed.blockEntities![0]).toMatchObject({ id: 'minecraft:sign', pos: [0, 0, 0] })
    expect(parsed.blockEntities![0]!.data).toEqual({ Text1: 'hi', Color: 'black' })
    expect(parsed.entities).toHaveLength(1)
    expect(parsed.entities![0]!.id).toBe('oak_boat') // 源文件里没有命名空间

    // 导入时统一补上命名空间，否则同一个东西会有两个身份
    const target = makeStore()
    importSchematicInto(target, parsed, { at: { x: 0, y: 0, z: 0 } })
    expect(target.entities.list()[0]!.type).toBe('minecraft:oak_boat')
    expect(target.entities.list()[0]!.yaw).toBe(4) // 90° = 4 × 22.5°
    expect(target.blockEntities.at({ x: 0, y: 0, z: 0 })!.kind).toBe('minecraft:sign')
  })

  it('v3 形状：`BlockEntities` 在 **`Blocks` 里**、附加数据嵌在 `Data` 下', async () => {
    const bytes = writeSpongeSchematic({
      size: [1, 1, 1],
      blocks: [],
      blockEntities: [
        { pos: [0, 0, 0], id: 'minecraft:sign', data: { Text1: 'foo', Text2: '', Text3: 'bar', Text4: '' } },
      ],
      entities: [{ id: 'minecraft:oak_boat', pos: [0.5, 0, 0.5], data: { Rotation: [90, 0] } }],
      dataVersion: DATA_VERSION_1_21_4,
    })
    const root = await readNbt(bytes)
    const schematic = (root.value['Schematic'] as { value: Record<string, unknown> }).value as Record<
      string,
      { value: Record<string, unknown> }
    >

    // 规范原文：BlockEntities 在 Block Container 里，Entities 在根上
    expect(schematic['Entities']!.value['value']).toBeDefined()
    expect(schematic['Blocks']!.value['BlockEntities']).toBeDefined()
    expect(schematic['BlockEntities']).toBeUndefined()

    const parsed = await readSpongeSchematic(bytes)
    // v3 的附加数据在 `Data` 子 compound 下，读方要把它摊平回一份 data
    expect(parsed.blockEntities![0]!.data).toEqual({
      Text1: 'foo',
      Text2: '',
      Text3: 'bar',
      Text4: '',
    })
  })

  it('附加数据转不成 NBT 时**报出来**，而不是安静地写出去或安静地丢掉', () => {
    const store = makeStore()
    store.setBlock({ x: 0, y: 0, z: 0 }, 'minecraft:stone')
    // 异质数组：NBT 的列表装不下（JSON 说得出、NBT 说不出）
    store.entities.set({ ...boat('e_1_1'), data: { broken: [1, 'a'] } })

    const result = exportSchematic(store)
    expect(result.entities).toBe(1) // 结构照走：类型与位置还是能进游戏的
    expect(result.problems).toHaveLength(1)
    expect(result.problems[0]).toMatch(/同质的/)
  })

  it('悬在建筑之外的实体也会被导出：范围要长到装得下它们', () => {
    const store = makeStore()
    store.setBlock({ x: 0, y: 0, z: 0 }, 'minecraft:stone')
    // 方块包围盒只到 (0,0,0)，这条船在 20 格外、10 格高——
    // 只按 contentBounds() 定范围的话它会被安静地漏掉
    store.entities.set(boat('e_1_1', 20.5, 10, 20.5))

    const result = exportSchematic(store)
    expect(result.entities).toBe(1)
    expect(result.region.max).toEqual({ x: 20, y: 10, z: 20 })
    expect(result.size).toEqual([21, 11, 21])
  })

  it('region 过滤对两层稀疏数据同样生效（用的是文件坐标）', async () => {
    const source = scene()
    const all = await readSpongeSchematic(exportSchematic(source).bytes)
    const target = makeStore()
    // 只要文件坐标 x ≤ 4 的那一块：船 e_1_1 在 (3.5,1,4.5) 里，e_1_2 在 (9.5,1,9.5) 外
    importSchematicInto(target, all, {
      at: { x: 0, y: 0, z: 0 },
      region: { min: { x: 0, y: 0, z: 0 }, max: { x: 4, y: 4, z: 4 } },
    })
    expect(target.entities.list().map((entity) => entity.x)).toEqual([3.5])
  })
})
