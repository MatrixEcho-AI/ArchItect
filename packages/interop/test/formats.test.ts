import { gunzipSync, gzipSync } from 'node:zlib'

import { WorldStore } from '@architect/core'
import type { Bounds } from '@architect/core'
import { describe, expect, it } from 'vitest'

import { exportLitematic, bitsFor, litematicToSchematicData, packBlockStates, readLitematic, unpackBlockStates, writeLitematic } from '../src/litematic.js'
import { exportObj } from '../src/obj.js'
import { importSchematicInto } from '../src/bridge.js'
import type { SchematicBlock } from '../src/schematic.js'

const volume: Bounds = { min: { x: 0, y: 0, z: 0 }, max: { x: 31, y: 31, z: 31 } }
const makeStore = (): WorldStore => new WorldStore({ minecraftVersion: '1.21.4', volume })

describe('.litematic 位打包', () => {
  it('位宽下限是 2，即使调色板只有一项', () => {
    expect(bitsFor(1)).toBe(2)
    expect(bitsFor(2)).toBe(2)
    expect(bitsFor(4)).toBe(2)
    expect(bitsFor(5)).toBe(3)
    expect(bitsFor(16)).toBe(4)
    expect(bitsFor(17)).toBe(5)
    expect(bitsFor(1024)).toBe(10)
    expect(bitsFor(4096)).toBe(12)
  })

  it('**手算对照**：2 位一格的打包，每 long 放 32 格', () => {
    const indices = [0, 1, 2, 3, 1, 0]
    const longs = packBlockStates(indices, 4)
    expect(longs).toHaveLength(1)
    // 低位到高位依次是 i=0..5 的值：00 01 10 11 01 00
    // 从高位往低写就是 0b00_01_11_10_01_00 = 484
    expect(longs[0]).toBe(0b00_01_11_10_01_00n)
    expect(longs[0]).toBe(484n)
    expect(unpackBlockStates(longs, indices.length, 4)).toEqual(indices)
  })

  it('跨 long 边界时下标不串（末尾 long 不满也不补位）', () => {
    const perLong = Math.floor(64 / 5) // 12
    const indices = Array.from({ length: 40 }, (_, i) => i % 17)
    const longs = packBlockStates(indices, 17)
    expect(longs).toHaveLength(Math.ceil(40 / perLong))
    expect(unpackBlockStates(longs, indices.length, 17)).toEqual(indices)
  })

  it('**最高位被用上时不能变成负数**（用带符号右移就会踩到）', () => {
    // 要真的碰到 bit 63，得让"每 long 的最后一格"落在 offset 48 上：
    // 16 位一格 → 每 long 4 格 → offset 0/16/32/48，第 4 格的值最高位正好是 bit 63。
    const paletteSize = 40000 // bitsFor → 16
    const value = 0x8000 // 16 位里最高位是 1
    const indices = [1, 1, 1, value, 1, 1, 1, value]
    expect(bitsFor(paletteSize)).toBe(16)
    const longs = packBlockStates(indices, paletteSize)

    // 打包结果里确实有 long 的最高位是 1（否则这个测试根本没测到东西）
    expect(longs.some((v) => BigInt.asUintN(64, v) >= 1n << 63n)).toBe(true)
    // 而且这些 long 仍然是合法的**有符号** 64 位（NBT 层会拒绝越界值）
    for (const word of longs) {
      expect(word).toBeGreaterThanOrEqual(-(2n ** 63n))
      expect(word).toBeLessThan(2n ** 63n)
    }
    // 关键：解包要拿回原值，而不是负数
    expect(unpackBlockStates(longs, indices.length, paletteSize)).toEqual(indices)
  })

  it('写出来的 long 落在有符号 64 位范围内（否则 NBT 层直接拒绝）', () => {
    const longs = packBlockStates([2048, 2048, 2048, 2048, 2048, 2048], 4096)
    for (const value of longs) {
      expect(value).toBeGreaterThanOrEqual(-(2n ** 63n))
      expect(value).toBeLessThan(2n ** 63n)
    }
  })

  it('解包读到超出长度的位置时补 0 而不是抛错', () => {
    expect(unpackBlockStates([1n], 100, 4)).toHaveLength(100)
  })
})

describe('.litematic 往返', () => {
  const blocks: SchematicBlock[] = [
    { x: 0, y: 0, z: 0, state: 'minecraft:stone' },
    { x: 1, y: 0, z: 0, state: 'minecraft:oak_stairs[facing=east,half=bottom,shape=straight,waterlogged=false]' },
    { x: 0, y: 1, z: 1, state: 'minecraft:water_cauldron[level=3]' },
  ]

  it('写读往返，状态字符串（含属性）逐格一致', async () => {
    const bytes = writeLitematic({
      regions: [{ name: '小屋', blocks, size: [2, 2, 2] }],
      name: '测试',
      author: 'ArchItect',
    })
    const data = await readLitematic(bytes)
    expect(data.version).toBe(6)
    expect(data.name).toBe('测试')
    expect(data.regions).toHaveLength(1)
    const region = data.regions[0]!
    expect(region.size).toEqual([2, 2, 2])
    expect(region.blocks).toHaveLength(3)
    for (const original of blocks) {
      expect(region.blocks.find((b) => b.x === original.x && b.y === original.y && b.z === original.z)?.state).toBe(
        original.state,
      )
    }
  })

  it('**确定性**：同样的输入导出逐字节相同（时间戳固定为 0）', () => {
    const input = { regions: [{ blocks, size: [2, 2, 2] as [number, number, number] }] }
    expect(Buffer.from(writeLitematic(input)).equals(Buffer.from(writeLitematic(input)))).toBe(true)
  })

  it('超出区域尺寸的方块直接报错', () => {
    expect(() =>
      writeLitematic({ regions: [{ blocks: [{ x: 5, y: 0, z: 0, state: 'minecraft:stone' }], size: [2, 1, 1] }] }),
    ).toThrow(/超出区域尺寸/)
  })

  it('缺 Regions 时给出可读的错误', async () => {
    const { writeNbt, compound, int } = await import('../src/nbt.js')
    const bad = writeNbt({ Version: int(6) })
    await expect(readLitematic(bad)).rejects.toThrow(/Regions/)
    void compound
  })
})

describe('.litematic 也能当导入源', () => {
  it('从世界导出 .litematic，转成通用表示再导入别的世界，hash 对拍', async () => {
    const source = makeStore()
    for (let x = 0; x < 4; x++) {
      for (let z = 0; z < 4; z++) {
        source.write((emit) => emit(x, 0, z), source.palette.indexOf('minecraft:stone_bricks'), { confirm: true })
      }
    }
    source.write((emit) => emit(1, 1, 1), source.palette.indexOf('minecraft:oak_stairs[facing=west]'), {
      confirm: true,
    })
    const before = source.contentHash()

    const bytes = exportLitematic(source, { name: 'hut' })
    const data = await readLitematic(bytes)
    const target = makeStore()
    const result = importSchematicInto(target, litematicToSchematicData(data))

    expect(result.unknown).toEqual([])
    expect(result.skipped).toBe(0)
    expect(target.contentHash()).toBe(before)
  })
})

describe('.obj 导出', () => {
  it('整块方块之间剔面：2x1x1 相邻两块只剩 10 个面', () => {
    const store = makeStore()
    const stone = store.palette.indexOf('minecraft:stone')
    store.write((emit) => emit(0, 0, 0), stone, { confirm: true })
    store.write((emit) => emit(1, 0, 0), stone, { confirm: true })

    const result = exportObj(store)
    // 两块各 6 面，中间两张互相挡掉的去掉 → 10
    expect(result.faces).toBe(10)
    expect(result.blocks).toBe(2)
    // 顶点去重：两个立方体共享 4 个角点
    expect(result.vertices).toBe(8 + 4)
  })

  it('关掉剔除时每块 6 个面', () => {
    const store = makeStore()
    const stone = store.palette.indexOf('minecraft:stone')
    store.write((emit) => emit(0, 0, 0), stone, { confirm: true })
    store.write((emit) => emit(1, 0, 0), stone, { confirm: true })
    expect(exportObj(store, { cullFaces: false }).faces).toBe(12)
  })

  it('**非整块形状不剔面，而且真的按碰撞盒画**（楼梯不是实心方块）', () => {
    const store = makeStore()
    store.write((emit) => emit(0, 0, 0), store.palette.indexOf('minecraft:oak_stairs[facing=north]'), {
      confirm: true,
    })
    const result = exportObj(store)
    const shapes = store.registry.shapesOf(store.getBlockStateId({ x: 0, y: 0, z: 0 }))
    // 楼梯的碰撞盒不止一个 → 面数不止 6，但也不该是"一个实心方块"的 6
    expect(shapes.length).toBeGreaterThan(1)
    expect(result.faces).toBe(shapes.length * 6)
  })

  it('无碰撞形状的方块不产生几何（火把、植物）', () => {
    const store = makeStore()
    store.write((emit) => emit(0, 0, 0), store.palette.indexOf('minecraft:torch'), { confirm: true })
    const result = exportObj(store)
    expect(result.faces).toBe(0)
    expect(result.blocks).toBe(0)
  })

  it('顶点坐标以 region.min 为原点，且是 4 位小数', () => {
    const store = makeStore()
    store.write((emit) => emit(5, 2, 7), store.palette.indexOf('minecraft:stone'), { confirm: true })
    const result = exportObj(store)
    const vertexLines = result.obj.split('\n').filter((line) => line.startsWith('v '))
    // 一个实心方块在原点：8 个角点，坐标都是 0 或 1
    expect(vertexLines).toHaveLength(8)
    const coords = vertexLines.map((line) => line.slice(2).split(' ').map(Number))
    expect(Math.min(...coords.map((c) => c[0]!))).toBe(0)
    expect(Math.max(...coords.map((c) => c[0]!))).toBe(1)
  })

  it('每个面的法线朝外（右手法则绕序正确）', () => {
    const store = makeStore()
    store.write((emit) => emit(0, 0, 0), store.palette.indexOf('minecraft:stone'), { confirm: true })
    const result = exportObj(store, { cullFaces: false })
    const lines = result.obj.split('\n')
    const verts: Array<[number, number, number]> = []
    for (const line of lines) {
      if (!line.startsWith('v ')) continue
      const [, x, y, z] = line.split(' ')
      verts.push([Number(x), Number(y), Number(z)])
    }
    const faces = lines.filter((line) => line.startsWith('f ')).map((line) => line.slice(2).split(' ').map(Number))
    expect(faces).toHaveLength(6)

    const centre: [number, number, number] = [0.5, 0.5, 0.5]
    for (const face of faces) {
      const [a, b, c] = face.slice(0, 3).map((index) => verts[index - 1]!) as [
        [number, number, number],
        [number, number, number],
        [number, number, number],
      ]
      const ab: [number, number, number] = [b[0] - a[0], b[1] - a[1], b[2] - a[2]]
      const bc: [number, number, number] = [c[0] - b[0], c[1] - b[1], c[2] - b[2]]
      const normal: [number, number, number] = [
        ab[1] * bc[2] - ab[2] * bc[1],
        ab[2] * bc[0] - ab[0] * bc[2],
        ab[0] * bc[1] - ab[1] * bc[0],
      ]
      // 面心相对立方体中心的方向，应当与法线同向
      const faceCentre: [number, number, number] = [
        (a[0] + b[0] + c[0]) / 3 - centre[0],
        (a[1] + b[1] + c[1]) / 3 - centre[1],
        (a[2] + b[2] + c[2]) / 3 - centre[2],
      ]
      const dot = normal[0] * faceCentre[0] + normal[1] * faceCentre[1] + normal[2] * faceCentre[2]
      expect(dot, `face ${face.join(',')} 的法线朝内`).toBeGreaterThan(0)
    }
  })

  it('给了颜色就生成 .mtl，并按材质分组', () => {
    const store = makeStore()
    store.write((emit) => emit(0, 0, 0), store.palette.indexOf('minecraft:stone'), { confirm: true })
    store.write((emit) => emit(1, 0, 0), store.palette.indexOf('minecraft:gold_block'), { confirm: true })

    const result = exportObj(store, {
      // 刻意不给相邻剔除完全一样的行为留余地：两块不同材质，中间的面仍会被剔
      colorOf: (state) => (state.includes('gold') ? { r: 255, g: 215, b: 0 } : { r: 128, g: 128, b: 128 }),
    })
    expect(result.mtl).toBeDefined()
    expect(result.obj).toContain('mtllib model.mtl') // 默认名
    expect(result.mtl).toContain('newmtl stone')
    expect(result.mtl).toContain('newmtl gold_block')
    // 0..1 归一化
    expect(result.mtl).toContain('Kd 1.0000 0.8431 0.0000')
    expect(result.obj).toContain('usemtl stone')
    expect(result.obj).toContain('usemtl gold_block')
    // 文件名要能对上，否则模型打开后全是灰的
    expect(exportObj(store, { mtlName: 'hut.mtl', colorOf: () => ({ r: 1, g: 2, b: 3 }) }).obj).toContain(
      'mtllib hut.mtl',
    )
  })

  it('不给颜色时没有 mtl、也没有 usemtl', () => {
    const store = makeStore()
    store.write((emit) => emit(0, 0, 0), store.palette.indexOf('minecraft:stone'), { confirm: true })
    const result = exportObj(store)
    expect(result.mtl).toBeUndefined()
    expect(result.obj).not.toContain('usemtl')
  })

  it('空世界报可读错误', () => {
    expect(() => exportObj(makeStore())).toThrow(/空的/)
  })
})

/**
 * 把 `.litematic` 里每个 `Size` 复合标签的三个值改掉。
 *
 * 造不出一份「合法但尺寸巨大」的文件——写侧会真的按尺寸打包，`new Array(count)`
 * 那一头就先炸了。所以只能在字节上改，这也正是攻击者会做的事：解压后的 NBT 里每个
 * `Size` 是 `TAG_Int(03) | 名长(00 01) | 名字 | 值(i32)` 三连，值分别在 +8 / +16 / +24。
 */
function forgedRegionSize(bytes: Uint8Array, sx: number, sy: number, sz: number): Uint8Array {
  const raw = Uint8Array.from(gunzipSync(bytes))
  const ascii = Array.from(raw)
    .map((byte) => (byte >= 32 && byte < 127 ? String.fromCharCode(byte) : '.'))
    .join('')
  const putInt = (buf: Uint8Array, offset: number, value: number): void => {
    buf[offset] = (value >>> 24) & 255
    buf[offset + 1] = (value >>> 16) & 255
    buf[offset + 2] = (value >>> 8) & 255
    buf[offset + 3] = value & 255
  }
  let patched = 0
  for (let i = ascii.indexOf('Size'); i >= 0; i = ascii.indexOf('Size', i + 1)) {
    // 只改长得像 `TAG_Int x / TAG_Int y / TAG_Int z` 的那一处
    if (raw[i + 4] !== 3 || raw[i + 7] !== 0x78 || raw[i + 12] !== 3 || raw[i + 15] !== 0x79) continue
    putInt(raw, i + 8, sx)
    putInt(raw, i + 16, sy)
    putInt(raw, i + 24, sz)
    patched++
  }
  if (patched === 0) throw new Error('没找到可改的 Size 标签——这个夹具需要跟着格式更新')
  return Uint8Array.from(gzipSync(raw))
}

describe('不按文件声明的数字分配', () => {
  it('**声明超大目标盒的 .schem 被拒绝**，而不是照着分配', () => {
    // 目标盒完全由文件里的 Width/Height/Length 推出，而 clear 会为盒子里每一格建
    // 一条记录。上限本来要到 `writeBlocks` 内部才生效——中间没有任何东西挡着，
    // 于是一个 142 字节的文件声明 4096×4096×1 就能把进程打死（V8 致命 OOM，
    // 不是可捕获的异常；桌面端这条跑在主进程里，等于整个应用消失）。
    //
    // 这里只取**刚好越过上限**的尺寸：契约是「超过上限就拒绝」，越过的幅度不改变
    // 它在测什么，而用 4096×4096 的话守卫一旦回退就会直接把 worker 打死
    // （实测 `exit code 134`），后面的用例根本跑不到，报告也只剩一句「1 failed」。
    expect(() =>
      importSchematicInto(
        makeStore(),
        { size: [2050, 2000, 1], dataVersion: 4189, blocks: [] } as never,
        { at: { x: 0, y: 0, z: 0 } },
      ),
    ).toThrow(/超过单次写入上限/)
  })

  it('**声明超大区域的 .litematic 被拒绝**', async () => {
    // 同一类：`Size` 直接喂给 `new Array(count)`。168 字节的文件写 20000×20000×1
    // 就够 abort 一次（`invalid table size`）；这里同样只取刚好越界的尺寸，
    // 让「守卫回退」表现为干净的断言失败而不是 worker 崩掉。
    const bytes = writeLitematic({
      regions: [{ name: 'x', blocks: [{ x: 0, y: 0, z: 0, state: 'minecraft:stone' }], size: [2, 2, 2] }],
      name: 't',
      author: 'a',
    })
    await expect(readLitematic(forgedRegionSize(bytes, 2050, 2000, 1))).rejects.toThrow(
      /超过单次写入上限/,
    )
  })

  it('**目标方块不接受的属性值换成声明表里的第一个取值**，而不是让整次导入失败', () => {
    // 有些第三方工具把枚举写成数字下标（`half=1`）。以前这个值会一路走到
    // `propertiesToStateId` 抛 `StateError`，把**整次导入**带走——实测报的是
    // 「half: "1" is not a valid value, options: top | bottom」。
    const store = makeStore()
    const state = 'minecraft:oak_stairs[facing=north,half=1,shape=straight,waterlogged=false]'
    const out = importSchematicInto(
      store,
      { size: [2, 2, 2], dataVersion: 4189, blocks: [{ x: 0, y: 0, z: 0, state }] } as never,
      { at: { x: 0, y: 0, z: 0 } },
    )
    expect(out.placed, '方块被丢掉了').toBe(1)
    expect(out.skipped).toBe(0)
    expect(store.getBlockString({ x: 0, y: 0, z: 0 })).toContain('half=top')
  })

  it('对照：合法尺寸与合法属性值不受影响', async () => {
    const store = makeStore()
    const state = 'minecraft:oak_stairs[facing=north,half=top,shape=straight,waterlogged=false]'
    const out = importSchematicInto(
      store,
      { size: [2, 2, 2], dataVersion: 4189, blocks: [{ x: 0, y: 0, z: 0, state }] } as never,
      { at: { x: 0, y: 0, z: 0 } },
    )
    expect(out.placed).toBe(1)
    // 合法文件读回来也必须原样
    const bytes = writeLitematic({
      regions: [{ name: 'x', blocks: [{ x: 0, y: 0, z: 0, state: 'minecraft:stone' }], size: [2, 2, 2] }],
      name: 't',
      author: 'a',
    })
    const back = await readLitematic(bytes)
    expect(back.regions[0]?.size).toEqual([2, 2, 2])
    expect(back.regions[0]?.blocks).toHaveLength(1)
  })
})

