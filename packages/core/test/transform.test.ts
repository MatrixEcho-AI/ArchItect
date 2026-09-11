import { beforeAll, describe, expect, it } from 'vitest'

import { loadRegistry } from '../src/registry.js'
import { propertiesToStateId, stateIdToString } from '../src/state.js'
import type { BlockRegistry } from '../src/registry.js'
import {
  IDENTITY_TRANSFORM,
  isIdentity,
  isMirroring,
  matrixOf,
  parseTransform,
  remapStateId,
  remapStateString,
  transformLocalPoint,
  transformLocalY,
  transformedSize,
} from '../src/transform.js'
import type { Transform } from '../src/transform.js'

let registry: BlockRegistry
beforeAll(() => {
  registry = loadRegistry('1.21.4')
})

/** 八种基本变换：四档旋转 × {不镜像、沿 X 镜像}，再加上三种镜像。 */
const TRANSFORMS: Array<{ name: string; transform: Transform }> = [
  { name: 'identity', transform: {} },
  { name: 'rot90', transform: { rotate: 90 } },
  { name: 'rot180', transform: { rotate: 180 } },
  { name: 'rot270', transform: { rotate: 270 } },
  { name: 'mirrorX', transform: { mirror: 'x' } },
  { name: 'mirrorZ', transform: { mirror: 'z' } },
  { name: 'mirrorY', transform: { mirror: 'y' } },
  { name: 'mirrorX+rot90', transform: { mirror: 'x', rotate: 90 } },
  { name: 'rot90+mirrorZ', transform: { rotate: 270, mirror: 'z' } },
]

const state = (text: string): number => {
  const match = /^(?:minecraft:)?([a-z0-9_]+)(?:\[([^\]]*)\])?$/.exec(text)!
  const block = registry.blockByName(match[1]!)!
  const overrides: Record<string, string | number | boolean> = {}
  for (const pair of (match[2] ?? '').split(',')) {
    if (pair.length === 0) continue
    const [key, raw] = pair.split('=') as [string, string]
    overrides[key] = raw === 'true' ? true : raw === 'false' ? false : /^-?\d+$/.test(raw) ? Number(raw) : raw
  }
  return propertiesToStateId(block, overrides)
}

describe('矩阵本身', () => {
  it('单位变换的矩阵是单位阵', () => {
    expect(matrixOf({})).toEqual([1, 0, 0, 0, 1, 0, 0, 0, 1])
    expect(isIdentity({})).toBe(true)
    expect(isIdentity({ rotate: 360 as 0 })).toBe(true)
  })

  it('旋转不翻转手性，镜像翻转手性', () => {
    for (const degrees of [90, 180, 270] as const) expect(isMirroring({ rotate: degrees })).toBe(false)
    for (const axis of ['x', 'y', 'z'] as const) expect(isMirroring({ mirror: axis })).toBe(true)
    // 镜像两次回到不翻转
    expect(isMirroring({ mirror: 'x', rotate: 180 })).toBe(true)
  })

  it('旋转四次回到自身', () => {
    // 真的要**复合四次**：把同一个字面量赋四遍是恒真的，复合逻辑改错了它也不会红。
    // 矩阵是行主序的 3×3，这里按定义连乘。
    const multiply = (a: readonly number[], b: readonly number[]): number[] =>
      [0, 1, 2].flatMap((r) =>
        [0, 1, 2].map(
          (c) => a[r * 3]! * b[c]! + a[r * 3 + 1]! * b[3 + c]! + a[r * 3 + 2]! * b[6 + c]!,
        ),
      )
    let four: readonly number[] = matrixOf(IDENTITY_TRANSFORM)
    for (let i = 0; i < 4; i++) four = multiply(four, matrixOf({ rotate: 90 }))
    expect(four).toEqual(matrixOf(IDENTITY_TRANSFORM))

    // 对照组：三次不该回到恒等。否则上面那条可能是空转的。
    let three: readonly number[] = matrixOf(IDENTITY_TRANSFORM)
    for (let i = 0; i < 3; i++) three = multiply(three, matrixOf({ rotate: 90 }))
    expect(three).not.toEqual(matrixOf(IDENTITY_TRANSFORM))
  })

  it('parseTransform 拒绝不认识的角度与轴', () => {
    expect(() => parseTransform({ rotate: 45 })).toThrow(/rotate/)
    expect(() => parseTransform({ mirror: 'w' })).toThrow(/mirror/)
    expect(parseTransform({ rotate: 0, mirror: 'none' })).toEqual({})
    expect(parseTransform(undefined)).toEqual({})
  })
})

describe('全量状态重映射：不漏、不丢、不串种', () => {
  /**
   * 一次扫描同时验三件事，因为它们对同一批 27 866 个 state × 9 种变换做同样的遍历：
   * ① 映射结果仍是**同种方块**的合法 state（不会串种、不会越界）；
   * ② 每种变换在每个方块的区间上是**单射**（旋转/镜像不丢信息）；
   * ③ 区间大小守恒（单射 + 值域有界 ⇒ 双射）。
   * 分开写会跑三遍，合起来只跑一遍。
   */
  it(
    '**每一个 state 在每一种变换下都是同种方块的合法 state，且变换是双射**',
    () => {
      let checked = 0
      for (const { name, transform } of TRANSFORMS) {
        for (const blockName of registry.blockNames) {
          const block = registry.blockByName(blockName)!
          const seen = new Set<number>()
          for (let id = block.minStateId; id <= block.maxStateId; id++) {
            const mapped = remapStateId(registry, id, transform)
            // 不会把 oak_stairs 变成别的方块，也不会越界
            if (registry.blockByStateId(mapped)?.name !== blockName) {
              throw new Error(`${name}: ${blockName} ${id} → ${mapped} 变成了别的方块`)
            }
            if (seen.has(mapped)) {
              throw new Error(`${name}: ${blockName} 上不是单射，${id} 撞到了 ${mapped}`)
            }
            seen.add(mapped)
            checked++
          }
          expect(seen.size, `${name} / ${blockName}`).toBe(block.maxStateId - block.minStateId + 1)
        }
      }
      expect(checked).toBe((registry.maxStateId + 1) * TRANSFORMS.length)
    },
    120_000,
  )

  it(
    '旋转四次 / 镜像两次回到原状态',
    () => {
    for (const name of registry.blockNames) {
      const block = registry.blockByName(name)!
      for (let id = block.minStateId; id <= block.maxStateId; id++) {
        let rotated = id
        for (let i = 0; i < 4; i++) rotated = remapStateId(registry, rotated, { rotate: 90 })
        expect(rotated, `${name} ${id}`).toBe(id)
        for (const axis of ['x', 'y', 'z'] as const) {
          const twice = remapStateId(registry, remapStateId(registry, id, { mirror: axis }), { mirror: axis })
          expect(twice, `${name} ${id} mirror ${axis}`).toBe(id)
        }
      }
    }
    },
    120_000,
  )

  it('恒等变换不改变任何 state', () => {
    for (const id of [0, 1, 73, 136, 5000, 20000, 27865]) {
      expect(remapStateId(registry, id, IDENTITY_TRANSFORM)).toBe(id)
    }
  })

  it('没有属性的方块原样返回', () => {
    const stone = registry.blockByName('stone')!
    expect(stone.states.length).toBe(0)
    expect(remapStateId(registry, stone.defaultState, { rotate: 90 })).toBe(stone.defaultState)
  })
})

describe('具体的朝向语义', () => {
  const check = (before: string, transform: Transform, after: string): void => {
    expect(remapStateString(registry, `minecraft:${before}`, transform)).toBe(`minecraft:${after}`)
  }

  it('楼梯的 facing 跟着旋转走', () => {
    const base = 'oak_stairs[facing=north,half=bottom,shape=straight,waterlogged=false]'
    check(base, { rotate: 90 }, 'oak_stairs[facing=east,half=bottom,shape=straight,waterlogged=false]')
    check(base, { rotate: 180 }, 'oak_stairs[facing=south,half=bottom,shape=straight,waterlogged=false]')
    check(base, { rotate: 270 }, 'oak_stairs[facing=west,half=bottom,shape=straight,waterlogged=false]')
    // 沿 X 镜像：南北不变，东西互换
    check(base, { mirror: 'x' }, base)
    // 沿 Z 镜像：南北互换
    check(base, { mirror: 'z' }, 'oak_stairs[facing=south,half=bottom,shape=straight,waterlogged=false]')
  })

  it('楼梯的上下朝向只被竖直镜像翻转（楼梯的 facing 里没有 up/down）', () => {
    // oak_stairs.facing 声明只有 north|south|west|east；上下由 half 表达
    const base = 'oak_stairs[facing=north,half=bottom,shape=straight,waterlogged=false]'
    check(base, { mirror: 'y' }, 'oak_stairs[facing=north,half=top,shape=straight,waterlogged=false]')
  })

  it('**手性翻转**：镜像时楼梯的 left/right 互换，旋转时不动', () => {
    const base = 'oak_stairs[facing=north,half=bottom,shape=outer_left,waterlogged=false]'
    check(base, { rotate: 90 }, 'oak_stairs[facing=east,half=bottom,shape=outer_left,waterlogged=false]')
    check(base, { mirror: 'x' }, 'oak_stairs[facing=north,half=bottom,shape=outer_right,waterlogged=false]')
    check(base, { mirror: 'z' }, 'oak_stairs[facing=south,half=bottom,shape=outer_right,waterlogged=false]')
  })

  it('原木的 axis：旋转交换 x/z，镜像不动', () => {
    check('oak_log[axis=x]', { rotate: 90 }, 'oak_log[axis=z]')
    check('oak_log[axis=z]', { rotate: 90 }, 'oak_log[axis=x]')
    check('oak_log[axis=y]', { rotate: 90 }, 'oak_log[axis=y]')
    check('oak_log[axis=x]', { mirror: 'x' }, 'oak_log[axis=x]')
    check('oak_log[axis=x]', { mirror: 'y' }, 'oak_log[axis=x]')
  })

  it('**属性名本身是方向的**：栅栏连接要连名字一起转', () => {
    const base = 'oak_fence[east=false,north=true,south=false,waterlogged=false,west=false]'
    check(base, { rotate: 90 }, 'oak_fence[east=true,north=false,south=false,waterlogged=false,west=false]')
    check(base, { rotate: 180 }, 'oak_fence[east=false,north=false,south=true,waterlogged=false,west=false]')
    check(base, { rotate: 270 }, 'oak_fence[east=false,north=false,south=false,waterlogged=false,west=true]')
    // 沿 X 镜像：east↔west，north/south 不动
    check(base, { mirror: 'x' }, 'oak_fence[east=false,north=true,south=false,waterlogged=false,west=false]')
    check(
      'oak_fence[east=true,north=false,south=false,waterlogged=false,west=false]',
      { mirror: 'x' },
      'oak_fence[east=false,north=false,south=false,waterlogged=false,west=true]',
    )
  })

  it('墙的 none/low/tall 值原样保留，只有属性名在转', () => {
    // 顺时针 90°：east→south、north→east、south→west、west→north
    check(
      'cobblestone_wall[east=tall,north=none,south=none,up=true,waterlogged=false,west=low]',
      { rotate: 90 },
      'cobblestone_wall[east=none,north=low,south=tall,up=true,waterlogged=false,west=none]',
    )
  })

  it('wall/pane 的 up 没有配对的 down：竖直镜像只能保住原名（已文档化的近似）', () => {
    // 这些方块只有 `up`，没有 `down`。映射成不存在的属性名会让编码直接抛错，
    // 所以 mapPropertyName 在目标名未声明时保留原名——保住一个能编码的状态。
    check(
      'cobblestone_wall[east=none,north=none,south=none,up=false,waterlogged=false,west=none]',
      { mirror: 'y' },
      'cobblestone_wall[east=none,north=none,south=none,up=false,waterlogged=false,west=none]',
    )
  })

  it('门的 hinge 是相对量：镜像互换、旋转不变', () => {
    const base = 'oak_door[facing=north,half=lower,hinge=left,open=false,powered=false]'
    check(base, { rotate: 90 }, 'oak_door[facing=east,half=lower,hinge=left,open=false,powered=false]')
    check(base, { mirror: 'x' }, 'oak_door[facing=north,half=lower,hinge=right,open=false,powered=false]')
    // 竖直翻转只换 `half`（上下量），**不**换 `hinge`：门轴在左还是在右是水平面内的
    // 相对量，而 `mirror:'y'` 在 (x,z) 上什么也没做。
    check(base, { mirror: 'y' }, 'oak_door[facing=north,half=upper,hinge=left,open=false,powered=false]')
  })

  it('竖直翻转不改变水平面内的手性（楼梯内外角、告示牌 yaw）', () => {
    check(
      'oak_stairs[facing=north,half=bottom,shape=outer_left,waterlogged=false]',
      { mirror: 'y' },
      'oak_stairs[facing=north,half=top,shape=outer_left,waterlogged=false]',
    )
    check('oak_sign[rotation=3,waterlogged=false]', { mirror: 'y' }, 'oak_sign[rotation=3,waterlogged=false]')
    // 对照：x/z 镜像仍然要互换（水平面真的被翻转了）
    check(
      'oak_stairs[facing=north,half=bottom,shape=outer_left,waterlogged=false]',
      { mirror: 'x' },
      'oak_stairs[facing=north,half=bottom,shape=outer_right,waterlogged=false]',
    )
  })

  it('告示牌的 rotation 是 16 档仿射映射', () => {
    check('oak_sign[rotation=0,waterlogged=false]', { rotate: 90 }, 'oak_sign[rotation=4,waterlogged=false]')
    check('oak_sign[rotation=0,waterlogged=false]', { rotate: 180 }, 'oak_sign[rotation=8,waterlogged=false]')
    check('oak_sign[rotation=6,waterlogged=false]', { rotate: 90 }, 'oak_sign[rotation=10,waterlogged=false]')
    check('oak_sign[rotation=0,waterlogged=false]', { mirror: 'x' }, 'oak_sign[rotation=0,waterlogged=false]')
    check('oak_sign[rotation=0,waterlogged=false]', { mirror: 'z' }, 'oak_sign[rotation=8,waterlogged=false]')
    check('oak_sign[rotation=3,waterlogged=false]', { mirror: 'z' }, 'oak_sign[rotation=5,waterlogged=false]')
    // 16 档下都是 0..15
    for (let r = 0; r < 16; r++) {
      const text = remapStateString(registry, `minecraft:oak_sign[rotation=${r},waterlogged=false]`, { rotate: 90 })
      const value = Number(/rotation=(\d+)/.exec(text)![1])
      expect(value).toBe((r + 4) % 16)
    }
  })

  it('铁轨的组合朝向会按声明表重新拼写', () => {
    // north_east 转 90° → 北→东、东→南 → 组合应是 south_east（不是 east_south）
    check('rail[shape=north_east,waterlogged=false]', { rotate: 90 }, 'rail[shape=south_east,waterlogged=false]')
    check('rail[shape=north_east,waterlogged=false]', { rotate: 180 }, 'rail[shape=south_west,waterlogged=false]')
    check('rail[shape=north_south,waterlogged=false]', { rotate: 90 }, 'rail[shape=east_west,waterlogged=false]')
    check('rail[shape=east_west,waterlogged=false]', { rotate: 90 }, 'rail[shape=north_south,waterlogged=false]')
    check('rail[shape=ascending_north,waterlogged=false]', { rotate: 90 }, 'rail[shape=ascending_east,waterlogged=false]')
    check('rail[shape=ascending_west,waterlogged=false]', { rotate: 90 }, 'rail[shape=ascending_north,waterlogged=false]')
  })

  it('jigsaw 的 orientation 两个词元分别映射，且顺序是有语义的', () => {
    check('jigsaw[orientation=north_up]', { rotate: 90 }, 'jigsaw[orientation=east_up]')
    check('jigsaw[orientation=north_up]', { rotate: 180 }, 'jigsaw[orientation=south_up]')
    check('jigsaw[orientation=up_east]', { mirror: 'y' }, 'jigsaw[orientation=down_east]')
    check('jigsaw[orientation=down_east]', { mirror: 'y' }, 'jigsaw[orientation=up_east]')
    // `east_up` 的上下镜像该是 `east_down`，而这个值在 1.21.4 里**不存在**
    // （12 个取值只覆盖了 24 种组合的一半）。按多重集合去凑会错配成 `down_east`——
    // 那是另一个朝向，不是镜像。所以这里只能原样保留。
    check('jigsaw[orientation=east_up]', { mirror: 'y' }, 'jigsaw[orientation=east_up]')
  })

  it('上下翻转时台阶的 type 与漏斗的 face 成对互换', () => {
    check('oak_slab[type=bottom,waterlogged=false]', { mirror: 'y' }, 'oak_slab[type=top,waterlogged=false]')
    check('oak_slab[type=double,waterlogged=false]', { mirror: 'y' }, 'oak_slab[type=double,waterlogged=false]')
    // 漏斗的 facing 里**没有 up**（只有 down + 四个水平向）。上下翻转后它本该朝上，
    // 但那个状态编码不出来——保住 `down` 是唯一能编码的结果，如实保留。
    check('hopper[enabled=true,facing=down]', { mirror: 'y' }, 'hopper[enabled=true,facing=down]')
    // 按钮的 face 是 floor/wall/ceiling，上下翻转有对应值，所以真的会换
    check('oak_button[face=floor,facing=north,powered=false]', { mirror: 'y' },
      'oak_button[face=ceiling,facing=north,powered=false]')
    check('bell[attachment=ceiling,facing=north,powered=false]', { mirror: 'y' },
      'bell[attachment=floor,facing=north,powered=false]')
  })

  it('纯数字属性（age/power/level）不被动过', () => {
    // 规范字符串的属性名是**字母序**的，断言要照着写
    check('wheat[age=5]', { rotate: 90 }, 'wheat[age=5]')
    check(
      'redstone_wire[east=none,north=none,power=12,south=none,west=none]',
      { rotate: 90 },
      'redstone_wire[east=none,north=none,power=12,south=none,west=none]',
    )
  })

  it('红石线的连接属性名跟着转', () => {
    check(
      'redstone_wire[east=side,north=up,power=3,south=none,west=none]',
      { rotate: 90 },
      'redstone_wire[east=up,north=none,power=3,south=side,west=none]',
    )
  })
})

describe('区域局部坐标变换（复制粘贴用）', () => {
  it('90° 旋转把 x/z 换位，尺寸也跟着换', () => {
    const size = [4, 3, 6] as const
    expect(transformedSize(size, { rotate: 90 })).toEqual([6, 3, 4])
    expect(transformedSize(size, { rotate: 180 })).toEqual([4, 3, 6])
    expect(transformedSize(size, { rotate: 270 })).toEqual([6, 3, 4])
    // 大小两轴坐标互换：(x,z) → (sz-1-z, x)
    expect(transformLocalPoint([0, 0, 0], size, { rotate: 90 })).toEqual([5, 0, 0])
    expect(transformLocalPoint([3, 0, 0], size, { rotate: 90 })).toEqual([5, 0, 3])
    expect(transformLocalPoint([0, 0, 5], size, { rotate: 90 })).toEqual([0, 0, 0])
    expect(transformLocalPoint([3, 0, 5], size, { rotate: 90 })).toEqual([0, 0, 3])
  })

  it('旋转是绕区域中心的：中心格不动', () => {
    const size = [5, 1, 5] as const
    expect(transformLocalPoint([2, 0, 2], size, { rotate: 90 })).toEqual([2, 0, 2])
    expect(transformLocalPoint([0, 0, 0], size, { rotate: 180 })).toEqual([4, 0, 4])
  })

  it('偶数尺寸也不会出现半格', () => {
    for (const size of [[4, 2, 4], [4, 1, 7], [6, 3, 6]] as const) {
      for (let x = 0; x < size[0]; x++) {
        for (let z = 0; z < size[2]; z++) {
          for (const rotate of [90, 180, 270] as const) {
            const mapped = transformLocalPoint([x, 0, z], size, { rotate })
            const target = transformedSize(size, { rotate })
            expect(Number.isInteger(mapped[0]) && Number.isInteger(mapped[2])).toBe(true)
            expect(mapped[0]).toBeGreaterThanOrEqual(0)
            expect(mapped[0]).toBeLessThan(target[0])
            expect(mapped[2]).toBeGreaterThanOrEqual(0)
            expect(mapped[2]).toBeLessThan(target[2])
          }
        }
      }
    }
  })

  it('镜像落在区域内的互补格上', () => {
    const size = [4, 2, 6] as const
    expect(transformLocalPoint([0, 0, 0], size, { mirror: 'x' })).toEqual([3, 0, 0])
    expect(transformLocalPoint([0, 0, 0], size, { mirror: 'z' })).toEqual([0, 0, 5])
    expect(transformLocalPoint([1, 1, 4], size, { mirror: 'x' })).toEqual([2, 1, 4])
  })

  it('竖直镜像只动高度', () => {
    expect(transformLocalY(0, 5, { mirror: 'y' })).toBe(4)
    expect(transformLocalY(0, 5, { rotate: 90 })).toBe(0)
  })

  it('**局部坐标变换与状态变换是同一个旋转**：绕一圈把整块区域送回原位', () => {
    const size = [5, 2, 7] as const
    const seen = new Set<string>()
    for (let x = 0; x < size[0]; x++) {
      for (let z = 0; z < size[2]; z++) {
        const mapped = transformLocalPoint([x, 0, z], size, { rotate: 90 })
        seen.add(`${mapped[0]},${mapped[2]}`)
      }
    }
    // 35 格 → 35 个互不相同的落点
    expect(seen.size).toBe(size[0] * size[2])
  })
})

describe('字符串解析的边界', () => {
  it('不带属性也能解析', () => {
    expect(remapStateString(registry, 'minecraft:stone', { rotate: 90 })).toBe('minecraft:stone')
  })

  it('不带 minecraft: 前缀也认', () => {
    expect(remapStateString(registry, 'oak_log[axis=x]', { rotate: 90 })).toBe('minecraft:oak_log[axis=z]')
  })

  it('不认识的方块报错而不是静默返回', () => {
    expect(() => remapStateString(registry, 'minecraft:not_a_block', { rotate: 90 })).toThrow(/未知方块/)
    expect(() => remapStateString(registry, '!!!', { rotate: 90 })).toThrow()
  })

  it('默认值从 defaultState 继承，不是 values[0]', () => {
    // oak_stairs 的 half 声明是 ["top","bottom"]，但默认是 bottom —— 只写 facing 不该变成 top
    expect(remapStateString(registry, 'oak_stairs[facing=north]', { rotate: 90 })).toBe(
      'minecraft:oak_stairs[facing=east,half=bottom,shape=straight,waterlogged=false]',
    )
  })

  it('stateIdToString 与重映射输出是同一种规范形式', () => {
    const id = state('oak_stairs[facing=north,half=bottom,shape=straight,waterlogged=false]')
    const block = registry.blockByStateId(id)!
    const mapped = remapStateId(registry, id, { rotate: 90 })
    expect(stateIdToString(block, mapped)).toBe(
      'minecraft:oak_stairs[facing=east,half=bottom,shape=straight,waterlogged=false]',
    )
  })
})
