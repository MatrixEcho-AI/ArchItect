import { gunzipSync, gzipSync } from 'node:zlib'

import { WorldStore } from '@architect/core'
import type { Bounds } from '@architect/core'
import { describe, expect, it } from 'vitest'

import { exportLitematic, bitsFor, litematicToSchematicData, packBlockStates, readLitematic, unpackBlockStates, writeLitematic } from '../src/litematic.js'
import { asCompound, asCompoundList, asString, asUnsignedLongArray, child, readNbt } from '../src/nbt.js'
import { exportObj } from '../src/obj.js'
import { importSchematicInto } from '../src/bridge.js'
import type { SchematicBlock } from '../src/schematic.js'

const volume: Bounds = { min: { x: 0, y: 0, z: 0 }, max: { x: 31, y: 31, z: 31 } }
const makeStore = (): WorldStore => new WorldStore({ minecraftVersion: '1.21.4', volume })

/**
 * **逐位参考实现**——照着定义写，不是照着实现写。
 *
 * 定义：Litematica 的 `BlockStates` 是**一条连续位流**，第 i 格的第 b 位就是
 * 全局第 `i*bits + b` 位，按小端填进 long 数组，长度 `ceil(count*bits/64)`。
 *
 * 它刻意写得又笨又慢（一个 bit 一个 bit 地摆），职责只有一个：
 * **独立于 `packBlockStates` 的实现细节，把"什么是正确的位流"钉死**。
 *
 * 这一对（参考 vs 实现）才是拦住本次格式错误的东西：
 *
 * - **自测往返**（pack 完再 unpack）两套布局都自洽，永远绿；
 * - **参考实现对拍**只在布局真的对时才绿。
 *
 * 曾经的实现是"每格完整落在一个 long 内"（也就是 Minecraft 原版 `BitArray` 的布局），
 * 它与真格式在 `bits ∈ {2,4,8,16,32}` 时逐位相同——恰好覆盖了仓库里所有样例的规模，
 * 所以六条位打包测试全绿，而任何真实建筑（调色板 > 16 项）导出的文件在
 * Litematica 里都是一片错方块。
 */
function referencePack(indices: readonly number[], paletteSize: number): bigint[] {
  const bits = bitsFor(paletteSize)
  const words = new Array<bigint>(Math.ceil((indices.length * bits) / 64)).fill(0n)
  for (let i = 0; i < indices.length; i++) {
    for (let b = 0; b < bits; b++) {
      if (((indices[i]! >> b) & 1) === 0) continue
      const position = i * bits + b
      const word = Math.floor(position / 64)
      words[word] = BigInt.asUintN(64, words[word]! | (1n << BigInt(position % 64)))
    }
  }
  return words.map((word) => BigInt.asIntN(64, word))
}

/** 参考实现的解包方向：从全局位流里一位一位地取回第 i 格。 */
function referenceUnpack(longs: readonly bigint[], count: number, paletteSize: number): number[] {
  const bits = bitsFor(paletteSize)
  const out: number[] = []
  for (let i = 0; i < count; i++) {
    let value = 0
    for (let b = 0; b < bits; b++) {
      const position = i * bits + b
      const word = longs[Math.floor(position / 64)]
      if (word === undefined) continue
      if ((BigInt.asUintN(64, word) >> BigInt(position % 64)) & 1n) value |= 1 << b
    }
    out.push(value)
  }
  return out
}

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

  it('**与独立逐位参考实现逐位相同**（跨全部位宽；这条才是拦住"自洽但错"的那条）', () => {
    // 旧实现只在 bits 整除 64 时与真格式相同，即 bits ∈ {2,4,8,16,32}。
    // 这里把每一种位宽都过一遍，重点是 3 / 5 / 6 / 7 / 9 / 10 / 12。
    for (const paletteSize of [1, 2, 4, 5, 8, 16, 17, 32, 33, 64, 65, 128, 129, 256, 1024, 4096, 40000]) {
      const bits = bitsFor(paletteSize)
      for (const count of [1, 2, 13, 25, 40, 64, 65, 100, 999]) {
        // 取值铺满 0..paletteSize-1，顺带覆盖"同一个值连着出现"与"跳着出现"
        const indices = Array.from({ length: count }, (_, i) => (i * 7 + 3) % paletteSize)
        const packed = packBlockStates(indices, paletteSize)
        expect(packed, `bits=${bits} count=${count}`).toEqual(referencePack(indices, paletteSize))
        expect(unpackBlockStates(packed, count, paletteSize)).toEqual(indices)
        expect(referenceUnpack(packed, count, paletteSize)).toEqual(indices)
      }
    }
  })

  it('**数组长度是 ceil(count*bits/64)**：末尾不补齐到整 long', () => {
    // bits=5、count=25：连续位流要 ceil(125/64)=2 条；
    // 而"每格不跨 long"的写法要 ceil(25/12)=3 条——长度本身就是判据。
    expect(bitsFor(17)).toBe(5)
    expect(packBlockStates(new Array<number>(25).fill(1), 17)).toHaveLength(2)

    // bits=6、count=21：紧凑 2 条，"每格不跨 long"要 3 条
    expect(bitsFor(33)).toBe(6)
    expect(packBlockStates(new Array<number>(21).fill(1), 33)).toHaveLength(2)

    // 反过来：bits 整除 64 时两种布局长度相同——这就是当年没被发现的原因。
    // paletteSize=16 → bits=4，每 long 正好 16 格。
    expect(bitsFor(16)).toBe(4)
    expect(packBlockStates(new Array<number>(40).fill(1), 16)).toHaveLength(Math.ceil((40 * 4) / 64))
  })

  it('**跨 long 边界的那一格要真的拼接**（bits=5，第 13 格横跨两条 long）', () => {
    // bits=5 时第 12 格占全局第 60..64 位：低 4 位在 long[0]，
    // 最高位落到 long[1] 的第 0 位。13*5 = 65 位 → 恰好 2 条 long。
    const indices = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0b11111]
    const longs = packBlockStates(indices, 17)
    expect(longs).toHaveLength(2)
    // long[0] 的低 60 位全 0，高 4 位是那一格的低 4 位（全是 1）
    expect(BigInt.asUintN(64, longs[0]!)).toBe(0b1111n << 60n)
    // long[1] 只剩那一格的最高位（1）
    expect(BigInt.asUintN(64, longs[1]!)).toBe(1n)
    expect(referenceUnpack(longs, indices.length, 17)).toEqual(indices)
  })

  it('跨 long 边界时下标不串（40 格、bits=5）', () => {
    const indices = Array.from({ length: 40 }, (_, i) => i % 17)
    const longs = packBlockStates(indices, 17)
    expect(longs).toHaveLength(Math.ceil((40 * 5) / 64))
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
    expect(referenceUnpack(longs, indices.length, paletteSize)).toEqual(indices)
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

  it('**写进文件的 BlockStates 就是一条连续位流**（用独立参考实现解盘上的字节）', async () => {
    // 上面那条往返用的是**我们自己的** unpack，两套布局都能自洽地读回来。
    // 这条不一样：它把文件里真实的 long 数组取出来，用参考实现解，
    // 再拿调色板翻回方块名——文件布局错了就在这里现形。
    //
    // 40 种方块 → 调色板 41 项 → bits=6（不整除 64，旧实现在这个规模上必然错位）
    const many: SchematicBlock[] = Array.from({ length: 40 }, (_, i) => ({
      x: i % 8,
      y: Math.floor(i / 8),
      z: 0,
      state: `minecraft:block_${i}`,
    }))
    const size: [number, number, number] = [8, 5, 1]
    const bytes = writeLitematic({ regions: [{ name: 'R', blocks: many, size }] })

    const root = await readNbt(bytes)
    const region = asCompound(child(child(root, 'Regions'), 'R'))!
    const palette = asCompoundList(region['BlockStatePalette'])
    const longs = asUnsignedLongArray(region['BlockStates'])!
    expect(bitsFor(palette.length), '这条测试得落在 bits 不整除 64 的规模上').toBe(6)

    const count = size[0] * size[1] * size[2]
    const decoded = referenceUnpack(longs, count, palette.length)
    for (const block of many) {
      // 与 Litematica 相同的索引口径：x + z*W + y*W*L
      const at = block.x + block.z * size[0] + block.y * size[0] * size[2]
      const slot = decoded[at]!
      expect(asString(palette[slot]?.['Name']), `(${block.x},${block.y},${block.z}) 上的方块错了`).toBe(
        block.state,
      )
    }
  })

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

  it('**目标方块不接受的属性值换成它的默认状态**，而不是让整次导入失败', () => {
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
    // **默认状态里的值**，不是声明表的第一项：楼梯的 `half` 声明表里 `top` 在前，而
    // 默认状态是 `bottom`——取前者会把楼梯整个翻个面。
    expect(store.getBlockString({ x: 0, y: 0, z: 0 })).toContain('half=bottom')
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

