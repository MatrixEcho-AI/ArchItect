import { describe, expect, it } from 'vitest'

import { loadBakedEntityModels } from '../src/baked.js'
import { defaultTextureOf, entityModelFor } from '../src/entity-models.js'
import { meshEntity, meshFallbackBox } from '../src/entitymesher.js'
import type { RawEntityModel } from '../src/entitymesher.js'

const models = loadBakedEntityModels('1.21.4').models
const FLAT_ATLAS = { u: 0, v: 0, su: 1, sv: 1 }

const boatModel = (): RawEntityModel => models['boat'] as RawEntityModel

interface Box {
  minX: number
  maxX: number
  minY: number
  maxY: number
  minZ: number
  maxZ: number
}

function bounds(positions: Float32Array): Box {
  const box: Box = {
    minX: Number.POSITIVE_INFINITY,
    maxX: Number.NEGATIVE_INFINITY,
    minY: Number.POSITIVE_INFINITY,
    maxY: Number.NEGATIVE_INFINITY,
    minZ: Number.POSITIVE_INFINITY,
    maxZ: Number.NEGATIVE_INFINITY,
  }
  for (let i = 0; i < positions.length; i += 3) {
    box.minX = Math.min(box.minX, positions[i]!)
    box.maxX = Math.max(box.maxX, positions[i]!)
    box.minY = Math.min(box.minY, positions[i + 1]!)
    box.maxY = Math.max(box.maxY, positions[i + 1]!)
    box.minZ = Math.min(box.minZ, positions[i + 2]!)
    box.maxZ = Math.max(box.maxZ, positions[i + 2]!)
  }
  return box
}

/** 顶点集合的**旋转不变**指纹：绕 Y 转 90° 之后应当与原集合逐点对应。 */
function rotateY90(points: Array<[number, number, number]>): Array<[number, number, number]> {
  return points.map(([x, y, z]) => [-z, y, x])
}

const pointsOf = (positions: Float32Array): Array<[number, number, number]> => {
  const out: Array<[number, number, number]> = []
  for (let i = 0; i < positions.length; i += 3) {
    out.push([positions[i]!, positions[i + 1]!, positions[i + 2]!])
  }
  return out
}

describe('实体模型查表', () => {
  it('同名直通', () => {
    expect(entityModelFor('minecraft:cow', models)).toEqual({ model: 'cow' })
    expect(entityModelFor('armor_stand', models)).toEqual({ model: 'armor_stand' })
  })

  it('**改名与变体走显式表**：`oak_boat` 在模型表里叫 `boat`', () => {
    expect(entityModelFor('minecraft:oak_boat', models)).toEqual({ model: 'boat', texture: 'entity/boat/oak' })
    expect(entityModelFor('minecraft:dark_oak_boat', models)).toEqual({
      model: 'boat',
      texture: 'entity/boat/dark_oak',
    })
    // 模型表只收了 6 种船的贴图，而 1.21.4 的资源包里有 10 种
    expect(entityModelFor('minecraft:mangrove_boat', models)?.texture).toBe('entity/boat/mangrove')
    expect(entityModelFor('minecraft:trader_llama', models)).toEqual({ model: 'llama' })
  })

  it('**模型表里没有的返回 undefined**（由调用方退化成一个盒子）', () => {
    // 展示框与画都不在上游那张表里——不猜一个形状
    expect(entityModelFor('minecraft:item_frame', models)).toBeUndefined()
    expect(entityModelFor('minecraft:painting', models)).toBeUndefined()
    expect(entityModelFor('minecraft:not_a_real_entity', models)).toBeUndefined()
  })

  it('模型自带的默认贴图路径要换算成资源包相对路径', () => {
    expect(defaultTextureOf(models['cow'])).toBe('entity/cow/cow')
    // 变体优先，没有变体就回落到 default
    expect(defaultTextureOf(models['boat'], 'oak')).toBe('entity/boat/oak')
  })
})

describe('实体网格化', () => {
  it('船：顶点数是 6 面 × 4 顶点 × cube 数，索引数是顶点数的 1.5 倍', () => {
    const geometry = meshEntity(boatModel(), { x: 0, y: 0, z: 0, yaw: 0, atlas: FLAT_ATLAS })
    const boneCount = (boatModel().geometry!['default']!.bones ?? []).reduce(
      (sum, bone) => sum + (bone.cubes?.length ?? 0),
      0,
    )
    expect(boneCount).toBeGreaterThan(0)
    expect(geometry.vertices).toBe(boneCount * 6 * 4)
    expect(geometry.indices.length).toBe(geometry.vertices * 1.5)
  })

  it('**最低点落在实体位置上**（不这么对齐的话船会浮在离地 0.625 格处）', () => {
    const aligned = meshEntity(boatModel(), { x: 5, y: 3, z: 5, yaw: 0, atlas: FLAT_ATLAS })
    expect(bounds(aligned.positions).minY).toBeCloseTo(3, 6)

    const upstream = meshEntity(boatModel(), {
      x: 5,
      y: 3,
      z: 5,
      yaw: 0,
      atlas: FLAT_ATLAS,
      alignToFloor: false,
    })
    // 上游的行为：模型自带的 y 偏移原样保留
    expect(bounds(upstream.positions).minY).toBeGreaterThan(3.1)
  })

  it('大小合理：船大约是 1 格多宽、半格高', () => {
    const geometry = meshEntity(boatModel(), {
      x: 0,
      y: 0,
      z: 0,
      yaw: 0,
      atlas: FLAT_ATLAS,
      alignToFloor: false,
    })
    const box = bounds(geometry.positions)
    const width = Math.max(box.maxX - box.minX, box.maxZ - box.minZ)
    expect(width).toBeGreaterThan(0.8)
    expect(width).toBeLessThan(2.2)
    expect(box.maxY - box.minY).toBeGreaterThan(0.2)
    expect(box.maxY - box.minY).toBeLessThan(1.5)
  })

  it('**yaw 的每一步就是绕 Y 转 22.5°**：yaw=4 的顶点集合 == yaw=0 绕 Y 转 90°', () => {
    // 用同一个锚点（0,0,0）——位置平移会让逐点比较失去意义
    const base = meshEntity(boatModel(), { x: 0, y: 0, z: 0, yaw: 0, atlas: FLAT_ATLAS })
    const turned = meshEntity(boatModel(), { x: 0, y: 0, z: 0, yaw: 4, atlas: FLAT_ATLAS })

    const expected = rotateY90(pointsOf(base.positions)).sort((a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2])
    const actual = pointsOf(turned.positions).sort((a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2])

    expect(actual.length).toBe(expected.length)
    for (let i = 0; i < actual.length; i++) {
      expect(actual[i]![0]).toBeCloseTo(expected[i]![0], 5)
      expect(actual[i]![1]).toBeCloseTo(expected[i]![1], 5)
      expect(actual[i]![2]).toBeCloseTo(expected[i]![2], 5)
    }
  })

  it('**法线跟着转**：不转的话光栅器会按轴对齐法线把该看见的面剔掉', () => {
    const base = meshEntity(boatModel(), { x: 0, y: 0, z: 0, yaw: 0, atlas: FLAT_ATLAS })
    const turned = meshEntity(boatModel(), { x: 0, y: 0, z: 0, yaw: 4, atlas: FLAT_ATLAS })

    const normalsOf = (positions: Float32Array): Set<string> => {
      const out = new Set<string>()
      for (let i = 0; i < positions.length; i += 3) {
        out.add(`${positions[i]!.toFixed(3)},${positions[i + 1]!.toFixed(3)},${positions[i + 2]!.toFixed(3)}`)
      }
      return out
    }
    // yaw=0 时船一定有朝 ±X 与 ±Z 的面；转 90° 之后两组互换
    const before = normalsOf(base.normals)
    const after = normalsOf(turned.normals)
    expect(before).not.toEqual(after)
    // 每个法线都是单位向量
    for (let i = 0; i < turned.normals.length; i += 3) {
      const length = Math.hypot(turned.normals[i]!, turned.normals[i + 1]!, turned.normals[i + 2]!)
      expect(length).toBeCloseTo(1, 5)
    }
  })

  it('位置平移直接进顶点，不改变形状', () => {
    const here = meshEntity(boatModel(), { x: 0, y: 0, z: 0, yaw: 0, atlas: FLAT_ATLAS })
    const there = meshEntity(boatModel(), { x: 10, y: 4, z: -3, yaw: 0, atlas: FLAT_ATLAS })
    for (let i = 0; i < here.positions.length; i += 3) {
      expect(there.positions[i]! - here.positions[i]!).toBeCloseTo(10, 5)
      expect(there.positions[i + 1]! - here.positions[i + 1]!).toBeCloseTo(4, 5)
      expect(there.positions[i + 2]! - here.positions[i + 2]!).toBeCloseTo(-3, 5)
    }
  })

  it('UV 落在图集矩形里面（贴图空间 → 图集空间的映射）', () => {
    const atlas = { u: 0.25, v: 0.5, su: 0.125, sv: 0.25 }
    const geometry = meshEntity(boatModel(), { x: 0, y: 0, z: 0, yaw: 0, atlas })
    expect(geometry.uvs.length).toBe(geometry.vertices * 2)
    for (let i = 0; i < geometry.uvs.length; i += 2) {
      expect(geometry.uvs[i]!).toBeGreaterThanOrEqual(atlas.u - 1e-6)
      expect(geometry.uvs[i]!).toBeLessThanOrEqual(atlas.u + atlas.su + 1e-6)
      expect(geometry.uvs[i + 1]!).toBeGreaterThanOrEqual(atlas.v - 1e-6)
      expect(geometry.uvs[i + 1]!).toBeLessThanOrEqual(atlas.v + atlas.sv + 1e-6)
    }
  })

  it('兜底盒：用 minecraft-data 的宽高，落地，居中的', () => {
    const geometry = meshFallbackBox({ width: 0.5, height: 0.5 }, { x: 1, y: 2, z: 1, yaw: 0, atlas: FLAT_ATLAS })
    const box = bounds(geometry.positions)
    expect(box.minX).toBeCloseTo(0.75, 5)
    expect(box.maxX).toBeCloseTo(1.25, 5)
    expect(box.minY).toBeCloseTo(2, 5)
    expect(box.maxY).toBeCloseTo(2.5, 5)
    expect(geometry.vertices).toBe(24)
  })
})
