import { WorldStore } from '@architect/core'
import type { Bounds, PlacedEntity } from '@architect/core'
import { describe, expect, it } from 'vitest'

import { exportSchematic, importSchematicInto } from '../src/bridge.js'
import { numberFromJson } from '../src/json-nbt.js'
import {
  exportLitematic,
  exportLitematicDetailed,
  litematicToSchematicData,
  readLitematic,
} from '../src/litematic.js'
import { compound, compoundList, int, list, longArray, string, writeNbt } from '../src/nbt.js'
import { DATA_VERSION_1_21_4, readSpongeSchematic } from '../src/schematic.js'

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

/** 走完整条导入路径：读文件 → 中间表示 → 写进世界。 */
async function importLitematic(store: WorldStore, bytes: Uint8Array, at = { x: 0, y: 0, z: 0 }) {
  return importSchematicInto(store, litematicToSchematicData(await readLitematic(bytes)), { at })
}

describe('.litematic 的实体与方块实体', () => {
  it('导出 → 导入 → 再导出：**字节完全相同**', async () => {
    const source = scene()
    const first = exportLitematic(source)
    const detailed = exportLitematicDetailed(source)
    expect(detailed.problems).toEqual([])
    expect(detailed.entities).toBe(2)
    expect(detailed.blockEntities).toBe(1)

    const target = makeStore()
    await importLitematic(target, first)
    expect(target.entities.size).toBe(2)
    expect(target.blockEntities.size).toBe(1)
    expect(exportLitematic(target)).toEqual(first)
  })

  it('字段对上：类型、位置、朝向、附加数据', async () => {
    const target = makeStore()
    await importLitematic(target, exportLitematic(scene()))
    const list2 = target.entities.list()

    expect(list2.map((entity) => entity.type)).toEqual(['minecraft:oak_boat', 'minecraft:oak_boat'])
    expect(list2[0]).toMatchObject({ x: 3.5, y: 1, z: 4.5, yaw: 8 })
    expect(list2[0]!.data).toBeUndefined() // 180° 落在 22.5° 格点上，不该再留一份 Rotation
    expect(list2[1]).toMatchObject({ yaw: 4, pitch: 15, data: { CustomName: '{"text":"船"}' } })
    expect(target.blockEntities.at({ x: 1, y: 0, z: 1 })).toEqual({
      x: 1,
      y: 0,
      z: 1,
      kind: 'minecraft:barrel',
      data: { CustomName: '{"text":"仓"}' },
    })
  })

  it('**v1 的包装形状**（`EntityData` / `TileNBT`）也认', async () => {
    // 这是 `.litematic` 独有的一处历史差异：v1 把原版 NBT 包在 `EntityData`/`TileNBT` 里，
    // 位置写在外层；v2+ 才把位置直接写进实体自己的 NBT
    const bytes = writeNbt({
      Version: int(5),
      MinecraftDataVersion: int(DATA_VERSION_1_21_4),
      Metadata: compound({ Name: string('v1'), Author: string('x') }),
      Regions: compound({
        'Region 1': compound({
          Position: compound({ x: int(0), y: int(0), z: int(0) }),
          Size: compound({ x: int(2), y: int(2), z: int(2) }),
          BlockStatePalette: compoundList([{ Name: string('minecraft:air'), Properties: compound({}) }]),
          BlockStates: longArray([0n]),
          Entities: compoundList([
            {
              Pos: list('double', [1.5, 0, 1.5]),
              // 嵌套 compound 必须包一层 `compound()`：裸对象会被当成标签去序列化
              EntityData: compound({
                id: string('minecraft:oak_boat'),
                Rotation: list('float', [90, 0]),
              }),
            },
          ]),
          TileEntities: compoundList([
            {
              x: int(0),
              y: int(0),
              z: int(0),
              TileNBT: compound({ id: string('minecraft:sign'), Text1: string('hi') }),
            },
          ]),
        }),
      }),
    })

    const data = await readLitematic(bytes)
    const region = data.regions[0]!
    expect(region.entities).toHaveLength(1)
    expect(region.entities![0]).toMatchObject({ id: 'minecraft:oak_boat', pos: [1.5, 0, 1.5] })
    expect(region.blockEntities).toHaveLength(1)
    expect(region.blockEntities![0]).toMatchObject({ id: 'minecraft:sign', pos: [0, 0, 0] })
    expect(region.blockEntities![0]!.data).toEqual({ Text1: 'hi' })

    // 位置是元数据，不该同时留在附加数据里（否则模型会看到两份位置）
    expect(region.entities![0]!.data).toEqual({ Rotation: [{ __nbt: 'float', value: 90 }, { __nbt: 'float', value: 0 }] })

    const target = makeStore()
    await importLitematic(target, bytes)
    expect(target.entities.list()[0]!.yaw).toBe(4) // 90° = 4 × 22.5°
    expect(target.blockEntities.at({ x: 0, y: 0, z: 0 })!.kind).toBe('minecraft:sign')
  })

  it('**同一个世界导出成两种格式，读回来必须一致**', async () => {
    const source = scene()
    const fromSchem = await readSpongeSchematic(exportSchematic(source).bytes)
    const fromLitematic = litematicToSchematicData(await readLitematic(exportLitematic(source)))

    // 两种格式的键名、位置容器、附加数据的写法国全不同（`Id` vs `id`、
    // `Pos` 数组 vs `x`/`y`/`z`、`Data` vs 内联），但读回来必须是同一份中间表示——
    // 不一致就说明有一边的约定写错了，而那种错只在游戏里才看得出来
    expect(fromLitematic.entities).toEqual(fromSchem.entities)
    expect(fromLitematic.blockEntities).toEqual(fromSchem.blockEntities)
    expect(fromLitematic.size).toEqual(fromSchem.size)
  })

  it('非格点角度在 `.litematic` 里同样保留原值', async () => {
    const store = makeStore()
    store.setBlock({ x: 0, y: 0, z: 0 }, 'minecraft:stone')
    store.entities.set({ ...boat('e_1_1'), data: { Rotation: [189.3, 45] } })

    const target = makeStore()
    await importLitematic(target, exportLitematic(store))
    const entity = target.entities.list()[0]!
    expect(entity.yaw).toBe(8)
    expect(entity.pitch).toBe(45)

    const again = litematicToSchematicData(await readLitematic(exportLitematic(target)))
    const rotation = again.entities![0]!.data['Rotation'] as unknown[]
    expect(numberFromJson(rotation[0])).toBeCloseTo(189.3, 9)
  })

  it('附加数据转不成 NBT 时**报出来**，结构照旧导出', () => {
    const store = makeStore()
    store.setBlock({ x: 0, y: 0, z: 0 }, 'minecraft:stone')
    store.entities.set({ ...boat('e_1_1'), data: { broken: [1, 'a'] } })

    const result = exportLitematicDetailed(store)
    expect(result.entities).toBe(1)
    expect(result.problems).toHaveLength(1)
    expect(result.problems[0]).toMatch(/同质的/)
  })

  it('悬在建筑之外的实体也会被导出', async () => {
    const store = makeStore()
    store.setBlock({ x: 0, y: 0, z: 0 }, 'minecraft:stone')
    store.entities.set(boat('e_1_1', 20.5, 10, 20.5))

    const detailed = exportLitematicDetailed(store)
    expect(detailed.entities).toBe(1)
    expect(detailed.size).toEqual([21, 11, 21])

    const target = makeStore()
    await importLitematic(target, detailed.bytes)
    expect(target.entities.list()[0]).toMatchObject({ x: 20.5, y: 10, z: 20.5 })
  })
})
