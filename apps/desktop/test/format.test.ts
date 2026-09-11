import { describe, expect, it } from 'vitest'

import { cacheShare } from '../src/renderer/format.js'

describe('成本表盘：缓存命中比例', () => {
  it('算得出比例（四舍五入到整数）', () => {
    // 真实跑过的一轮灯塔：输入 1.97M，98% 命中前缀缓存
    expect(cacheShare({ in: 1_970_000, out: 30_000, cachedIn: 1_931_000 })).toEqual({
      count: 1_931_000,
      percent: 98,
    })
    expect(cacheShare({ in: 100, out: 1, cachedIn: 1 })).toEqual({ count: 1, percent: 1 })
    expect(cacheShare({ in: 3, out: 1, cachedIn: 2 })).toEqual({ count: 2, percent: 67 })
  })

  it('**没有缓存这个概念时不显示**（而不是显示 0%）', () => {
    expect(cacheShare({ in: 1000, out: 10 })).toBeUndefined()
    expect(cacheShare({ in: 1000, out: 10, cachedIn: 0 })).toBeUndefined()
  })

  it('还没有用量时不显示', () => {
    expect(cacheShare({ in: 0, out: 0, cachedIn: 0 })).toBeUndefined()
  })

  it('**不可能的数值宁可不说**（provider 字段含义对不上时）', () => {
    expect(cacheShare({ in: 100, out: 10, cachedIn: 120 })).toBeUndefined()
  })
})
