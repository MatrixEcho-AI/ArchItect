import { describe, expect, it } from 'vitest'

import {
  byte,
  byteArray,
  compound,
  compoundList,
  double,
  float,
  int,
  intArray,
  list,
  long,
  longArray,
  readNbt,
  short,
  string,
  writeNbt,
} from '../src/nbt.js'
import type { NbtTree } from '../src/nbt.js'
import { compoundFromJson, compoundToJson, jsonToNbt, NbtConversionError } from '../src/json-nbt.js'

/**
 * 真的走一遍 NBT 编解码，而不是只在内存里换形状。
 *
 * `prismarine-nbt` 的**入参和出参形状不对称**（标量列表的元素是裸值、复合列表的元素是
 * 裸字段表、long 写进去是 BigInt 读出来是 `[hi,lo]`），所以"我以为的树形"和
 * "解析器给的树形"经常不是一回事。只测内存转换会把这类错误全部放过。
 */
async function throughNbt(tree: NbtTree): Promise<Record<string, unknown>> {
  return compoundToJson((await readNbt(writeNbt(tree))).value)
}

/** 转换成 JSON、再转回 NBT、再解析一次——两步之后必须还是同一份 JSON。 */
async function assertStable(tree: NbtTree, expected: Record<string, unknown>): Promise<void> {
  const json = await throughNbt(tree)
  expect(json).toEqual(expected)
  const again = await throughNbt(compoundFromJson(json))
  expect(again).toEqual(json)
}

describe('JSON ↔ NBT：能裸写的裸写，不能裸写的带标注', () => {
  it('int 与 string 裸写', async () => {
    await assertStable({ a: int(5), b: string('屋'), c: int(-7) }, { a: 5, b: '屋', c: -7 })
  })

  it('**整数取值的 double 必须带标注**：裸写成 5 回程会变成 int', async () => {
    await assertStable({ d: double(5), e: double(5.5) }, { d: { __nbt: 'double', value: 5 }, e: 5.5 })
  })

  it('byte / short / float 带标注（JSON 分不出它们和 int）', async () => {
    await assertStable(
      { b: byte(-3), s: short(300), f: float(0.5) },
      { b: { __nbt: 'byte', value: -3 }, s: { __nbt: 'short', value: 300 }, f: { __nbt: 'float', value: 0.5 } },
    )
  })

  it('long 写成十进制字符串：BigInt 过不了 JSON.stringify，写成 number 会静默改值', async () => {
    const big = 9223372036854775807n
    await assertStable({ l: long(big) }, { l: { __nbt: 'long', value: big.toString() } })
  })

  it('三种定长数组带标注', async () => {
    await assertStable(
      { ba: byteArray([1, 2, 200]), ia: intArray([-1, 2]), la: longArray([1n, 2n]) },
      {
        ba: { __nbt: 'byteArray', value: [1, 2, -56] }, // NBT 的 byte 是有符号的
        ia: { __nbt: 'intArray', value: [-1, 2] },
        la: { __nbt: 'longArray', value: ['1', '2'] },
      },
    )
  })

  it('标量列表与复合列表都要能往返（两者的元素形状不一样）', async () => {
    await assertStable(
      {
        // 标量列表的元素是**裸值**（见 `list` 的说明）
        names: list('string', ['a', 'b']),
        counts: list('int', [1, 2]),
        entries: compoundList([{ Name: string('x'), Count: int(3) }]),
      },
      { names: ['a', 'b'], counts: [1, 2], entries: [{ Name: 'x', Count: 3 }] },
    )
  })

  it('空列表往返成空数组，不会变成别的', async () => {
    await assertStable({ empty: list('end', []) }, { empty: [] })
  })

  it('嵌套 compound 与嵌套列表', async () => {
    await assertStable(
      { outer: compound({ inner: compound({ deep: int(1) }) }) },
      { outer: { inner: { deep: 1 } } },
    )
  })

  it('NBT 里的空槽（undefined）在 JSON 里不存在', () => {
    // 只能在**读**这一侧出现：`writeUncompressed` 不接受带 undefined 槽的 compound
    // （protodef 会抛 `Cannot read properties of undefined (reading 'type')`），
    // 所以这里直接喂解析形状给转换器，不走编解码
    expect(compoundToJson({ a: int(1), b: undefined })).toEqual({ a: 1 })
    expect(compoundFromJson({ a: 1, b: undefined })).toEqual({ a: int(1) })
  })
})

describe('JSON → NBT 的推断规则', () => {
  it('整数 → int，非整数 → double，布尔 → byte，字符串 → string', () => {
    expect(jsonToNbt(5)).toEqual(int(5))
    expect(jsonToNbt(5.5)).toEqual(double(5.5))
    expect(jsonToNbt(true)).toEqual(byte(1))
    expect(jsonToNbt(false)).toEqual(byte(0))
    expect(jsonToNbt('x')).toEqual(string('x'))
  })

  it('**数字数组整体定类型**：`[189.3, 45]` 是 double 列表，不是"double 与 int 混在一起"', () => {
    // 旋转角最常这么写，而逐个推断会抛错——那会让最普通的输入直接失败
    expect(jsonToNbt([189.3, 45])).toEqual(list('double', [189.3, 45]))
    expect(jsonToNbt([180, 0])).toEqual(list('int', [180, 0]))
    expect(jsonToNbt([1, 2.5, 3])).toEqual(list('double', [1, 2.5, 3]))
  })

  it('**异质数组抛错，不强行合并**（NBT 的列表必须同质）', () => {
    expect(() => jsonToNbt([1, 'a'])).toThrow(NbtConversionError)
    expect(() => jsonToNbt([1, { a: 1 }])).toThrow(/必须是同质的/)
  })

  it('null 抛错（NBT 没有对应的类型，编一个不如说出来）', () => {
    expect(() => jsonToNbt(null)).toThrow(/没有对应类型/)
  })

  it('非有限数字抛错', () => {
    expect(() => jsonToNbt(Number.NaN)).toThrow(/有限数字/)
    expect(() => jsonToNbt(Number.POSITIVE_INFINITY)).toThrow(/有限数字/)
  })

  it('带标注的对象按标注还原，不是当成普通 compound', () => {
    expect(jsonToNbt({ __nbt: 'short', value: 5 })).toEqual(short(5))
    expect(jsonToNbt({ __nbt: 'longArray', value: ['3'] })).toEqual(longArray([3n]))
    expect(() => jsonToNbt({ __nbt: '不存在的类型', value: 1 })).toThrow(/不认识标注的类型/)
  })
})
