import { describe, expect, it } from 'vitest'

import { loadRegistry } from '../src/registry.js'
import {
  parseState,
  propertiesToStateId,
  StateError,
  stateIdToProperties,
  stateIdToString,
} from '../src/state.js'

const registry = loadRegistry('1.21.4')

describe('注册表', () => {
  it('1.21.4 有 1095 个方块类型 / 27866 个 state', () => {
    expect(registry.blockCount).toBe(1095)
    expect(registry.maxStateId).toBe(27865)
  })

  it('stateId 0 是 air，且状态空间连续无空洞', () => {
    expect(registry.blockByStateId(0)?.name).toBe('air')
    for (let s = 0; s <= registry.maxStateId; s++) {
      expect(registry.blockByStateId(s), `stateId ${s}`).toBeDefined()
    }
  })
})

describe('state 编解码公式', () => {
  it('解码 defaultState 得到 vanilla 语义（含 bool 反转）', () => {
    const cases: Array<[string, number, Record<string, unknown>]> = [
      ['oak_stairs', 2940, { facing: 'north', half: 'bottom', shape: 'straight', waterlogged: false }],
      ['oak_log', 137, { axis: 'y' }],
      ['oak_slab', 12044, { type: 'bottom', waterlogged: false }],
      ['water', 86, { level: 0 }],
      ['oak_leaves', 279, { distance: 7, persistent: false, waterlogged: false }],
      ['redstone_wire', 4193, { power: 0, north: 'none', east: 'none', south: 'none', west: 'none' }],
    ]
    for (const [name, stateId, expected] of cases) {
      const block = registry.blockByName(name)!
      expect(block.defaultState, name).toBe(stateId)
      expect(stateIdToProperties(block, stateId), name).toEqual(expected)
    }
  })

  it('oak_stairs 的 defaultState 具体是 half=bottom（不是 values[0]=top）', () => {
    const block = registry.blockByName('oak_stairs')!
    expect(block.states.find((s) => s.name === 'half')!.values).toEqual(['top', 'bottom'])
    expect(stateIdToProperties(block, block.defaultState).half).toBe('bottom')
  })

  it('全量往返：27484 个 state 的 encode(decode(sid)) === sid，零失配', () => {
    let checked = 0
    const mismatches: string[] = []
    for (const name of registry.blockNames) {
      const block = registry.blockByName(name)!
      if (block.states.length === 0) continue
      for (let stateId = block.minStateId; stateId <= block.maxStateId; stateId++) {
        checked++
        const back = propertiesToStateId(block, stateIdToProperties(block, stateId))
        if (back !== stateId) mismatches.push(`${name}: ${stateId} -> ${back}`)
      }
    }
    expect(checked).toBe(27484)
    expect(mismatches.slice(0, 10)).toEqual([])
  })
})

describe('缺省属性继承（坑 2）', () => {
  it('省略 half 时从 defaultState 继承 bottom，而不是用 values[0] 的 top', () => {
    const block = registry.blockByName('oak_stairs')!
    // values[0] 补缺省会得到 2990（half=top）
    expect(propertiesToStateId(block, { facing: 'east' })).toBe(3000)
    const props = stateIdToProperties(block, 3000)
    expect(props.half).toBe('bottom')
    expect(props.facing).toBe('east')
  })

  it('minStateId 不等于 defaultState 的方块占多数', () => {
    const withStates = registry.blockNames
      .map((n) => registry.blockByName(n)!)
      .filter((b) => b.states.length > 0)
    const differing = withStates.filter((b) => b.defaultState !== b.minStateId)
    expect(withStates.length).toBe(713)
    expect(differing.length).toBe(566)
  })

  it('未知属性会报错并列出合法属性', () => {
    const block = registry.blockByName('oak_stairs')!
    expect(() => propertiesToStateId(block, { nope: 'x' })).toThrow(StateError)
    expect(() => propertiesToStateId(block, { nope: 'x' })).toThrow(/it has: facing/)
  })
})

describe('int 属性的 values 是载荷（坑 3）', () => {
  it('oak_leaves.distance 的 values 从 1 开始，不是 0..n-1', () => {
    const block = registry.blockByName('oak_leaves')!
    const distance = block.states.find((s) => s.name === 'distance')!
    expect(distance.type).toBe('int')
    expect(distance.values).toEqual(['1', '2', '3', '4', '5', '6', '7'])
    // 默认 state 的 distance 是 7，即 values 的最后一个，序号 6
    expect(stateIdToProperties(block, block.defaultState).distance).toBe(7)
  })

  it('distance=7 解析回默认 state（若用序号会错成 6）', () => {
    const block = registry.blockByName('oak_leaves')!
    expect(parseState(registry, 'oak_leaves[distance=7]').stateId).toBe(block.defaultState)
    expect(parseState(registry, 'oak_leaves[distance=6]').stateId).not.toBe(block.defaultState)
  })

  it('int 属性返回数字而非字符串', () => {
    const water = registry.blockByName('water')!
    expect(stateIdToProperties(water, water.defaultState).level).toBe(0)
    expect(typeof stateIdToProperties(water, water.defaultState).level).toBe('number')
  })

  it('全部 35 个非 0 基 int 属性都能正确往返', () => {
    const offsets: string[] = []
    for (const name of registry.blockNames) {
      const block = registry.blockByName(name)!
      for (const property of block.states) {
        if (property.type !== 'int') continue
        const isZeroBased = property.values?.every((v, i) => v === String(i)) ?? true
        if (isZeroBased) continue
        offsets.push(`${name}.${property.name}`)
      }
    }
    expect(offsets.length).toBe(35)
    // 偏移的 int 属性若按序号解码会偏一位，全量往返必须仍然零失配
    for (const qualified of offsets) {
      const [name, prop] = qualified.split('.') as [string, string]
      const block = registry.blockByName(name)!
      for (let stateId = block.minStateId; stateId <= block.maxStateId; stateId++) {
        const props = stateIdToProperties(block, stateId)
        expect(propertiesToStateId(block, props), `${qualified} @ ${stateId}`).toBe(stateId)
        expect(props[prop], qualified).toBeDefined()
      }
    }
  })
})

describe('规范字符串', () => {
  const stairs = registry.blockByName('oak_stairs')!

  it('属性名字母序 + 输出全部属性', () => {
    expect(stateIdToString(stairs, stairs.defaultState)).toBe(
      'minecraft:oak_stairs[facing=north,half=bottom,shape=straight,waterlogged=false]',
    )
  })

  it('解析与属性顺序无关', () => {
    const a = parseState(registry, 'minecraft:oak_stairs[facing=east,half=top,shape=straight,waterlogged=false]')
    const b = parseState(registry, 'oak_stairs[waterlogged=false,shape=straight,half=top,facing=east]')
    expect(a.stateId).toBe(b.stateId)
    expect(a.canonical).toBe(b.canonical)
    expect(a.stateId).toBe(2990)
  })

  it('省略属性与显式写默认值等价', () => {
    const short = parseState(registry, 'oak_stairs[facing=east]')
    const explicit = parseState(
      registry,
      'oak_stairs[facing=east,half=bottom,shape=straight,waterlogged=false]',
    )
    expect(short.stateId).toBe(explicit.stateId)
  })

  it('无属性方块输出裸名字', () => {
    const stone = registry.blockByName('stone')!
    expect(stateIdToString(stone, stone.defaultState)).toBe('minecraft:stone')
    expect(parseState(registry, 'stone').stateId).toBe(stone.defaultState)
  })

  it('拒绝未知方块与非法取值', () => {
    expect(() => parseState(registry, 'minecraft:not_a_block')).toThrow(/Unknown block/)
    expect(() => parseState(registry, 'oak_stairs[facing=up]')).toThrow(/not a valid value/)
    expect(() => parseState(registry, 'garbage!!')).toThrow(/Cannot parse/)
  })

  it('formatState 与 stateIdToProperties 互为逆（对若干方块抽样）', () => {
    for (const name of ['oak_door', 'oak_fence', 'glass_pane', 'oak_trapdoor']) {
      const block = registry.blockByName(name)!
      const s = stateIdToString(block, block.defaultState)
      expect(parseState(registry, s).stateId, name).toBe(block.defaultState)
    }
  })
})
