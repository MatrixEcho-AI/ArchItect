import { WorldStore, stateIdToString } from '@architect/core'
import type { Bounds } from '@architect/core'
import { describe, expect, it } from 'vitest'

import { exportSchematic, importSchematicBytes } from '../src/bridge.js'
import {
  asByteArray,
  asCompound,
  asInt,
  byteArray,
  child,
  compound,
  int,
  intArray as nbtIntArray,
  readNbt,
  short,
  string,
  writeNbt,
} from '../src/nbt.js'
import { DATA_VERSION_1_21_4, decodeVarints, encodeVarints, readSpongeSchematic, writeSpongeSchematic } from '../src/schematic.js'
import type { SchematicBlock } from '../src/schematic.js'

const volume: Bounds = { min: { x: 0, y: 0, z: 0 }, max: { x: 31, y: 31, z: 31 } }
const makeStore = (): WorldStore => new WorldStore({ minecraftVersion: '1.21.4', volume })

const block = (x: number, y: number, z: number, state: string): SchematicBlock => ({ x, y, z, state })

describe('VarInt 编解码（v3 的 Data 用）', () => {
  it('**逐字节对照手算值**——这是 v3 与 v2 唯一真正的差别', () => {
    expect(encodeVarints([0])).toEqual([0x00])
    expect(encodeVarints([1])).toEqual([0x01])
    expect(encodeVarints([127])).toEqual([0x7f])
    // 128 = 0b1000_0000 → 低 7 位 0 + 继续位，再一个 1
    expect(encodeVarints([128])).toEqual([0x80, 0x01])
    // 300 = 0b1_0010_1100 → 低 7 位 010_1100=0x2c|0x80，高位 0b10
    expect(encodeVarints([300])).toEqual([0xac, 0x02])
    // 16384 = 0x4000 → 三个字节
    expect(encodeVarints([16384])).toEqual([0x80, 0x80, 0x01])
  })

  it('往返一致，且能解出超过 5 字节才会报错', () => {
    const values = [0, 1, 127, 128, 255, 256, 300, 16383, 16384, 65535, 1_000_000]
    expect(decodeVarints(encodeVarints(values))).toEqual(values)
    expect(() => decodeVarints([0x80, 0x80, 0x80, 0x80, 0x80, 0x01])).toThrow(/VarInt/)
  })

  it('不接受负数', () => {
    expect(() => encodeVarints([-1])).toThrow(/负数/)
  })
})

describe('.schem 写出：布局必须逐项对上规范', () => {
  it('v3 的关键字段齐全且类型正确', async () => {
    const bytes = writeSpongeSchematic({
      size: [3, 2, 2],
      blocks: [block(2, 1, 1, 'minecraft:diamond_block')],
      dataVersion: DATA_VERSION_1_21_4,
      metadata: { Name: '测试', Author: 'ArchItect' },
    })

    const root = await readNbt(bytes)
    const schematic = asCompound(child(root, 'Schematic'))!
    expect(schematic).toBeDefined()
    expect(asInt(schematic['Version'])).toBe(3)
    expect(asInt(schematic['DataVersion'])).toBe(DATA_VERSION_1_21_4)
    expect(asInt(schematic['Width'])).toBe(3)
    expect(asInt(schematic['Height'])).toBe(2)
    expect(asInt(schematic['Length'])).toBe(2)
    expect(asIntArrayOf(schematic['Offset'])).toEqual([0, 0, 0])
    // 压缩过：gzip 魔数
    expect(Array.from(bytes.slice(0, 2))).toEqual([0x1f, 0x8b])
  })

  it('**索引顺序是 x + z*Width + y*Width*Length**（y 在最外层）', async () => {
    // W=3 H=2 L=2；把 (2,1,1) 放上钻石块
    // 手算：2 + 1*3 + 1*3*2 = 11
    const bytes = writeSpongeSchematic({
      size: [3, 2, 2],
      blocks: [block(2, 1, 1, 'minecraft:diamond_block')],
      dataVersion: DATA_VERSION_1_21_4,
    })
    const data = await readRawData(bytes)
    // 整个数组长度 = W*H*L（每格一个 VarInt，没有额外填充）
    expect(data.length).toBe(12)
    expect(data[11]).toBe(1) // 1 = 调色板里第一个非空气项
    // 前一个位置（x=1,y=1,z=1）必须是空气。如果 y 被放错层，这里会跟着错。
    expect(data[10]).toBe(0)
    // 除了第 11 位，其余 11 格全空
    expect(data.filter((v) => v !== 0)).toEqual([1])
  })

  it('同一批方块放在不同 y 层时会落在相隔 W*L 的位置上', async () => {
    const bytes = writeSpongeSchematic({
      size: [2, 3, 2],
      blocks: [block(0, 0, 0, 'minecraft:stone'), block(0, 2, 0, 'minecraft:stone')],
      dataVersion: DATA_VERSION_1_21_4,
    })
    const data = await readRawData(bytes)
    // y=0 → 0；y=2 → 0 + 0*2 + 2*2*2 = 8
    expect(data[0]).toBe(1)
    expect(data[8]).toBe(1)
    expect(data.length).toBe(12)
  })

  it('调色板第 0 项固定是空气，非空气按出现顺序编号', async () => {
    const bytes = writeSpongeSchematic({
      size: [2, 1, 1],
      blocks: [block(0, 0, 0, 'minecraft:stone'), block(1, 0, 0, 'minecraft:oak_planks')],
      dataVersion: DATA_VERSION_1_21_4,
    })
    const root = await readNbt(bytes)
    const palette = asCompound(asCompound(child(root, 'Schematic'))!['Blocks'])!['Palette']!
    const entries = Object.entries(asCompound(palette)!).map(([name, tag]) => [name, asInt(tag)] as const)
    const byIndex = entries.sort((a, b) => a[1] - b[1])
    expect(byIndex[0]).toEqual(['minecraft:air', 0])
    expect(byIndex[1]).toEqual(['minecraft:stone', 1])
    expect(byIndex[2]).toEqual(['minecraft:oak_planks', 2])
  })

  it('空气格不入表；超出声明尺寸的方块直接报错', () => {
    const bytes = writeSpongeSchematic({
      size: [1, 1, 1],
      blocks: [block(0, 0, 0, 'minecraft:air')],
      dataVersion: DATA_VERSION_1_21_4,
    })
    expect(bytes.length).toBeGreaterThan(0)
    expect(() =>
      writeSpongeSchematic({
        size: [1, 1, 1],
        blocks: [block(5, 0, 0, 'minecraft:stone')],
        dataVersion: DATA_VERSION_1_21_4,
      }),
    ).toThrow(/超出声明尺寸/)
    expect(() => writeSpongeSchematic({ size: [0, 1, 1], blocks: [], dataVersion: 1 })).toThrow(/尺寸必须为正/)
  })
})

describe('.schem 读入：v3 与 v2 都要认', () => {
  it('读回自己写的 v3', async () => {
    const bytes = writeSpongeSchematic({
      size: [3, 2, 2],
      blocks: [
        block(0, 0, 0, 'minecraft:stone'),
        block(2, 1, 1, 'minecraft:oak_stairs[facing=north,half=bottom,shape=straight,waterlogged=false]'),
      ],
      dataVersion: DATA_VERSION_1_21_4,
    })
    const data = await readSpongeSchematic(bytes)
    expect(data.size).toEqual([3, 2, 2])
    expect(data.formatVersion).toBe(3)
    expect(data.dataVersion).toBe(DATA_VERSION_1_21_4)
    expect(data.blocks).toHaveLength(2)
    expect(data.blocks.find((b) => b.state.startsWith('minecraft:oak_stairs'))).toMatchObject({ x: 2, y: 1, z: 1 })
  })

  it('**认未压缩的输入**（有些工具导出的就是裸 NBT）', async () => {
    const compressed = writeSpongeSchematic({
      size: [1, 1, 1],
      blocks: [block(0, 0, 0, 'minecraft:stone')],
      dataVersion: DATA_VERSION_1_21_4,
    })
    const { gunzipSync } = await import('node:zlib')
    const raw = new Uint8Array(gunzipSync(Buffer.from(compressed)))
    const data = await readSpongeSchematic(raw)
    expect(data.blocks).toHaveLength(1)
    expect(data.blocks[0]?.state).toBe('minecraft:stone')
  })

  it('**能读 v2**（Version=2 + 定宽 2 字节大端的 Data）——网上大多数 .schem 还是 v2', async () => {
    // 手搓一个 v2 文件：W=2 H=1 L=2，索引 x + z*W + y*W*L = x + 2z
    // (0,0,0)=stone(idx1), (1,0,1)=gold(idx2)。扁平数组：[1,0, 0,2]
    const flat = [1, 0, 0, 2]
    const dataBytes = flat.flatMap((value) => [(value >> 8) & 0xff, value & 0xff])
    const v2 = await gzip(
      buildSchematicNbt({
        version: 2,
        size: [2, 1, 2],
        palette: { 'minecraft:air': 0, 'minecraft:stone': 1, 'minecraft:gold_block': 2 },
        data: dataBytes,
        dataVersion: 2865,
      }),
    )

    const data = await readSpongeSchematic(v2)
    expect(data.formatVersion).toBe(2)
    expect(data.dataVersion).toBe(2865)
    expect(data.blocks).toHaveLength(2)
    expect(data.blocks.find((b) => b.state === 'minecraft:stone')).toMatchObject({ x: 0, y: 0, z: 0 })
    expect(data.blocks.find((b) => b.state === 'minecraft:gold_block')).toMatchObject({ x: 1, y: 0, z: 1 })
  })

  it('v1 的老布局给出明确指引，而不是报一个看不懂的错', async () => {
    const v1 = await gzip(
      writeNbtRaw({
        Palette: compound({ 'minecraft:air': int(0), 'minecraft:stone': int(1) }),
        BlockData: byteArray([0, 1, 0, 0]),
      }),
    )
    await expect(readSpongeSchematic(v1)).rejects.toThrow(/v1 格式/)
  })

  it('尺寸非法 / 缺 Blocks 时报可读的错误', async () => {
    const noBlocks = await gzip(writeNbtRaw({ Schematic: compound({ Version: int(3), Width: short(1), Height: short(1), Length: short(1) }) }))
    await expect(readSpongeSchematic(noBlocks)).rejects.toThrow(/Blocks/)

    const badSize = await gzip(
      writeNbtRaw({ Schematic: compound({ Version: int(3), Width: short(0), Height: short(1), Length: short(1) }) }),
    )
    await expect(readSpongeSchematic(badSize)).rejects.toThrow(/尺寸非法/)

    await expect(readSpongeSchematic(new Uint8Array([1, 2, 3, 4]))).rejects.toThrow()
  })
})

describe('M7 验收：导出再导入，contentHash 必须相等', () => {
  /** 造一座有点意思的小屋：多种方块、含带属性的状态、非正方体。 */
  function buildHut(store: WorldStore): void {
    const put = (x: number, y: number, z: number, state: string): void => {
      store.write((emit) => emit(x, y, z), store.palette.indexOf(state), { confirm: true })
    }
    for (let x = 0; x < 7; x++) {
      for (let z = 0; z < 5; z++) put(x, 0, z, 'minecraft:oak_planks')
    }
    for (let y = 1; y <= 3; y++) {
      for (let x = 0; x < 7; x++) {
        put(x, y, 0, 'minecraft:stone_bricks')
        put(x, y, 4, 'minecraft:stone_bricks')
      }
      for (let z = 1; z < 4; z++) {
        put(0, y, z, 'minecraft:stone_bricks')
        put(6, y, z, 'minecraft:stone_bricks')
      }
    }
    for (let x = 0; x < 7; x++) {
      for (let z = 0; z < 5; z++) put(x, 4, z, 'minecraft:spruce_planks')
    }
    // 一扇门（带 facing/half/hinge 属性）、一扇窗、一座朝东的楼梯
    put(3, 1, 0, 'minecraft:oak_door[facing=south,half=lower,hinge=left,open=false,powered=false]')
    put(3, 2, 0, 'minecraft:oak_door[facing=south,half=upper,hinge=left,open=false,powered=false]')
    put(3, 2, 4, 'minecraft:glass')
    put(5, 3, 3, 'minecraft:oak_stairs[facing=east,half=bottom,shape=straight,waterlogged=false]')
    put(2, 0, 0, 'minecraft:water_cauldron[level=3]')
  }

  it('**往返后 worldHash 相等**（逐格正确还原）', async () => {
    const source = makeStore()
    buildHut(source)
    const before = source.contentHash()
    expect(source.stats().blocks).toBeGreaterThan(100)

    const exported = exportSchematic(source, { metadata: { Name: 'hut' } })
    expect(exported.blocks).toBe(source.stats().blocks)

    // 收进一个全新的世界再导入：不能靠原来那张调色板，否则测不出真问题
    const target = makeStore()
    const result = await importSchematicBytes(target, exported.bytes, {
      at: exported.region.min,
    })

    expect(result.unknown).toEqual([])
    expect(result.skipped).toBe(0)
    expect(result.total).toBe(exported.blocks)
    expect(result.placed).toBe(exported.blocks)
    expect(result.migrated).toBe(false)
    expect(target.contentHash()).toBe(before)
    expect(target.stats().blocks).toBe(source.stats().blocks)
  })

  it('**带属性的状态逐格还原**，不只是方块名对上', async () => {
    const source = makeStore()
    buildHut(source)
    const exported = exportSchematic(source)
    const target = makeStore()
    await importSchematicBytes(target, exported.bytes, { at: exported.region.min })

    for (const pos of [
      { x: 3, y: 1, z: 0 },
      { x: 3, y: 2, z: 0 },
      { x: 5, y: 3, z: 3 },
      { x: 2, y: 0, z: 0 },
    ]) {
      expect(target.getBlockString(pos), JSON.stringify(pos)).toBe(source.getBlockString(pos))
    }
    expect(target.getBlockString({ x: 5, y: 3, z: 3 })).toContain('facing=east')
    expect(target.getBlockString({ x: 2, y: 0, z: 0 })).toContain('level=3')
  })

  it('**整次导入只占一个 revision**（不是每种方块一版）', async () => {
    const source = makeStore()
    buildHut(source)
    const exported = exportSchematic(source)

    const target = makeStore()
    const start = target.revision
    const result = await importSchematicBytes(target, exported.bytes, { at: exported.region.min })
    expect(target.revision).toBe(start + 1)
    expect(result.revision).toBe(start + 1)
    // 撤回一次就该全部回退
    target.undo()
    expect(target.stats().blocks).toBe(0)
  })

  it('世界坐标偏移不影响还原：换个落点，内容形状一致', async () => {
    const source = makeStore()
    buildHut(source)
    const exported = exportSchematic(source)

    const target = makeStore()
    await importSchematicBytes(target, exported.bytes, { at: { x: 10, y: 5, z: 20 } })
    // 每个非空气格的相对位置一致
    const shifted = new Set<string>()
    target.forEachNonAir((x, y, z) => shifted.add(`${x - 10},${y - 5},${z - 20}`))
    const original = new Set<string>()
    source.forEachNonAir((x, y, z) =>
      original.add(`${x - exported.region.min.x},${y - exported.region.min.y},${z - exported.region.min.z}`),
    )
    expect([...shifted].sort()).toEqual([...original].sort())
  })

  it('导出空世界给出可读的错误，而不是写一个空文件', () => {
    expect(() => exportSchematic(makeStore())).toThrow(/空的/)
  })

  it('只导出指定范围', () => {
    const store = makeStore()
    buildHut(store)
    const partial = exportSchematic(store, {
      region: { min: { x: 0, y: 0, z: 0 }, max: { x: 6, y: 0, z: 4 } },
    })
    expect(partial.size).toEqual([7, 1, 5])
    expect(partial.blocks).toBe(35)
  })
})

describe('导入外部文件：认不出来要如实报告，不静默填空气', () => {
  it('**未知方块被跳过并给出候选**，其余照常导入', async () => {
    const bytes = writeSpongeSchematic({
      size: [3, 1, 1],
      blocks: [
        block(0, 0, 0, 'minecraft:stone'),
        block(1, 0, 0, 'minecraft:oak_plankss'),
        block(2, 0, 0, 'minecraft:gold_block'),
      ],
      dataVersion: DATA_VERSION_1_21_4,
    })
    const target = makeStore()
    const result = await importSchematicBytes(target, bytes)

    expect(result.total).toBe(3)
    expect(result.skipped).toBe(1)
    expect(result.placed).toBe(2)
    expect(result.unknown).toHaveLength(1)
    expect(result.unknown[0]?.name).toBe('oak_plankss')
    expect(result.unknown[0]?.suggestions).toContain('minecraft:oak_planks')
    // 认出来的两个真的写进去了
    expect(target.getBlockString({ x: 0, y: 0, z: 0 })).toContain('stone')
    expect(target.getBlockString({ x: 2, y: 0, z: 0 })).toContain('gold_block')
    // 认不出来的那格保持空气
    expect(target.getBlockString({ x: 1, y: 0, z: 0 })).toBe('minecraft:air')
  })

  it('**改名表生效**：grass_path → dirt_path', async () => {
    const bytes = writeSpongeSchematic({
      size: [2, 1, 1],
      blocks: [block(0, 0, 0, 'minecraft:grass_path'), block(1, 0, 0, 'minecraft:sign[rotation=0]')],
      dataVersion: 2724,
    })
    const target = makeStore()
    const result = await importSchematicBytes(target, bytes)

    expect(result.skipped).toBe(0)
    expect(result.migrated).toBe(true)
    expect(result.renamed.map((r) => `${r.from}→${r.to}`).sort()).toEqual([
      'grass_path→dirt_path',
      'sign→oak_sign',
    ])
    expect(target.getBlockString({ x: 0, y: 0, z: 0 })).toContain('dirt_path')
    expect(target.getBlockString({ x: 1, y: 0, z: 0 })).toContain('oak_sign')
    // 1.14 的 sign 没有 rotation 之外的属性，rotation=0 应该保住
    expect(target.getBlockString({ x: 1, y: 0, z: 0 })).toContain('rotation=0')
  })

  it('**改名的同时丢掉新方块没有的属性**，而不是整个导入失败', async () => {
    const bytes = writeSpongeSchematic({
      size: [1, 1, 1],
      blocks: [block(0, 0, 0, 'minecraft:wooden_door[facing=north,half=lower,powered=true]')],
      dataVersion: 2200,
    })
    const target = makeStore()
    const result = await importSchematicBytes(target, bytes)
    expect(result.skipped).toBe(0)
    const state = target.getBlockString({ x: 0, y: 0, z: 0 })
    expect(state).toContain('oak_door')
    expect(state).toContain('facing=north')
    expect(state).not.toContain('wooden_door')
  })

  it('migrate=false 时只做精确匹配', async () => {
    const bytes = writeSpongeSchematic({
      size: [1, 1, 1],
      blocks: [block(0, 0, 0, 'minecraft:grass_path')],
      dataVersion: 2724,
    })
    const target = makeStore()
    const result = await importSchematicBytes(target, bytes, { migrate: false })
    expect(result.skipped).toBe(1)
    expect(result.renamed).toEqual([])
  })
})

// ── 测试辅助 ──────────────────────────────────────────────────────────────────

/** 从写出的 `.schem` 里把 v3 的 Data 解出来，用来核对索引顺序。 */
async function readRawData(bytes: Uint8Array): Promise<number[]> {
  const root = await readNbt(bytes)
  const blocks = asCompound(asCompound(child(root, 'Schematic'))!['Blocks'])!
  const data = asByteArray(blocks['Data'])!
  return decodeVarints(data)
}

function asIntArrayOf(tag: unknown): number[] | undefined {
  const value = tag as { type?: string; value?: number[] } | undefined
  return value?.type === 'intArray' ? value.value : undefined
}

async function gzip(bytes: Uint8Array): Promise<Uint8Array> {
  const { gzipSync } = await import('node:zlib')
  return new Uint8Array(gzipSync(Buffer.from(bytes)))
}

function writeNbtRaw(tree: Record<string, unknown>): Uint8Array {
  return writeNbt(tree as Parameters<typeof writeNbt>[0], { compress: false })
}

/** 手工拼一个 Sponge 文件（用来造 v2 / v1 这类我们自己不会写的形状）。 */
function buildSchematicNbt(input: {
  version: number
  size: [number, number, number]
  palette: Record<string, number>
  data: number[]
  dataVersion: number
}): Uint8Array {
  const palette: Record<string, ReturnType<typeof int>> = {}
  for (const [name, index] of Object.entries(input.palette)) palette[name] = int(index)
  return writeNbt({
    Schematic: compound({
      Version: int(input.version),
      DataVersion: int(input.dataVersion),
      Width: short(input.size[0]),
      Height: short(input.size[1]),
      Length: short(input.size[2]),
      Offset: nbtIntArray([0, 0, 0]),
      PaletteMax: int(Object.keys(input.palette).length),
      Blocks: compound({ Palette: compound(palette), Data: byteArray(input.data) }),
      Metadata: compound({ Name: string('v2 fixture') }),
    }),
  })
}

describe('M7 加强验收：跨**大量不同方块状态**的往返', () => {
  /**
   * 前面那个小屋只覆盖了几种方块。真正会漏掉问题的是**带属性的状态**：
   * 楼梯的 facing/shape、栅栏的连接位、告示牌的 rotation、原木的 axis……
   * 所以这里从注册表里**确定性地抽一批状态**（每个方块取默认状态 + 几个变体），
   * 铺成一片"方块样本墙"，再验 contentHash。
   */
  function sampleStates(store: WorldStore, limit: number): string[] {
    const names = [...store.registry.blockNames]
    const picked: string[] = []
    // 先按名字排序保证确定性，再均匀取样（不要只取前 N 个，那样全是 air/stone/... 开头的）
    for (let i = 0; picked.length < limit && i < names.length * 40; i++) {
      const name = names[i % names.length]!
      const block = store.registry.blockByName(name)!
      // 同一个方块多取几个 state（属性值不同 → 走 state 编解码的不同分支）
      const span = block.maxStateId - block.minStateId
      const stride = Math.max(1, Math.floor(span / 4))
      const stateId = block.minStateId + ((i * stride) % (span + 1))
      const state = store.registry.blockByName(name) !== undefined ? stateIdToStringOf(store, stateId) : undefined
      if (state !== undefined && state !== 'minecraft:air' && !picked.includes(state)) picked.push(state)
    }
    return picked
  }

  function stateIdToStringOf(store: WorldStore, stateId: number): string | undefined {
    const block = store.registry.blockByStateId(stateId)
    if (block === undefined) return undefined
    return stateIdToString(block, stateId)
  }

  it('**1000+ 种状态铺满一片区域，导出再导入 contentHash 仍相等**', async () => {
    const source = new WorldStore({ minecraftVersion: '1.21.4', volume: { min: { x: 0, y: 0, z: 0 }, max: { x: 63, y: 31, z: 63 } } })
    const states = sampleStates(source, 1200)
    expect(states.length).toBeGreaterThan(900)

    let placed = 0
    for (const [index, state] of states.entries()) {
      const x = index % 32
      const z = Math.floor(index / 32) % 32
      const y = Math.floor(index / 1024)
      source.write((emit) => emit(x, y, z), source.palette.indexOf(state), { confirm: true })
      placed++
    }
    expect(source.stats().blocks).toBe(placed)
    const before = source.contentHash()

    const exported = exportSchematic(source)
    const target = new WorldStore({ minecraftVersion: '1.21.4', volume: { min: { x: 0, y: 0, z: 0 }, max: { x: 63, y: 31, z: 63 } } })
    const result = await importSchematicBytes(target, exported.bytes, { at: exported.region.min })

    expect(result.unknown).toEqual([])
    expect(result.skipped).toBe(0)
    expect(target.contentHash()).toBe(before)

    // 顺带：每个状态本身也要能原样出现（防止"整体 hash 相同但分布不同"这种巧合）
    for (const state of states.slice(0, 50)) {
      expect(target.palette.strings()).toContain(state)
    }
  }, 120_000)
})
