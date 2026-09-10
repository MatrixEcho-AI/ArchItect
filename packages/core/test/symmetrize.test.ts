import { describe, expect, it } from 'vitest'

import { forEachBox } from '../src/geometry/box.js'
import { forEachExtrude } from '../src/geometry/polygon.js'
import { posKey } from '../src/types.js'
import { WorldStore } from '../src/world/store.js'
import { symmetrize } from '../src/world/symmetrize.js'
import type { Bounds, Pos } from '../src/types.js'

const defaultVolume: Bounds = { min: { x: 0, y: 0, z: 0 }, max: { x: 20, y: 10, z: 20 } }
const makeStore = (volume: Bounds = defaultVolume): WorldStore =>
  new WorldStore({ minecraftVersion: '1.21.4', volume })
const box = (from: Pos, to: Pos, mode: 'solid' | 'hollow' | 'outline' = 'solid') =>
  (visit: (x: number, y: number, z: number) => void) => forEachBox(from, to, mode, visit)

const dump = (store: WorldStore): Map<string, string> => {
  const out = new Map<string, string>()
  store.forEachNonAir((x, y, z) => out.set(posKey({ x, y, z }), store.getBlockString({ x, y, z })))
  return out
}

describe('symmetrize：沿平面镜像', () => {
  it('镜像公式：平面过 coordinate 格的中心，x=7 → x=9（coordinate=8）', () => {
    const store = makeStore()
    store.setBlock({ x: 7, y: 3, z: 5 }, 'minecraft:stone')
    const result = symmetrize(store, { axis: 'x', coordinate: 8, source: 'negative', confirm: true })
    expect(result.ok).toBe(true)
    expect(store.getBlockString({ x: 7, y: 3, z: 5 })).toBe('minecraft:stone') // 源保留
    expect(store.getBlockString({ x: 9, y: 3, z: 5 })).toBe('minecraft:stone') // 镜像
  })

  it('对称建筑：造一半，镜像出另一半', () => {
    const store = makeStore()
    // 左半边：x 0..7 的一堵墙
    store.write(
      (v) => forEachExtrude(
        [
          { x: 0, z: 0 },
          { x: 7, z: 0 },
          { x: 7, z: 7 },
          { x: 0, z: 7 },
        ],
        { baseY: 0, height: 4, hollow: true },
        v,
      ),
      store.palette.indexOf('minecraft:stone_bricks'),
      { confirm: true },
    )
    const beforeMirror = dump(store)

    symmetrize(store, { axis: 'x', coordinate: 8, source: 'negative', confirm: true })

    // 镜像后：x=8 是平面本身（源里没有），x=9..16 应当是 x=7..0 的镜像
    for (let dx = 0; dx <= 7; dx++) {
      for (let y = 0; y < 4; y++) {
        for (let z = 0; z <= 7; z++) {
          const source = store.getBlockString({ x: 7 - dx, y, z })
          const mirrored = store.getBlockString({ x: 9 + dx, y, z })
          expect(mirrored, `dx=${dx} y=${y} z=${z}`).toBe(source)
        }
      }
    }
    expect(beforeMirror.size).toBeGreaterThan(0)
  })

  it('clear:true（默认）清掉目标侧原有的杂物', () => {
    const store = makeStore()
    store.setBlock({ x: 2, y: 3, z: 3 }, 'minecraft:stone')
    store.setBlock({ x: 14, y: 3, z: 3 }, 'minecraft:dirt') // 目标侧的杂物
    symmetrize(store, { axis: 'x', coordinate: 8, source: 'negative', confirm: true })
    // 杂物被清掉，换成镜像过来的 stone
    expect(store.getBlockString({ x: 14, y: 3, z: 3 })).toBe('minecraft:stone')
  })

  it('clear:false 只补空缺，不覆盖目标侧已有内容', () => {
    const store = makeStore()
    store.setBlock({ x: 2, y: 3, z: 3 }, 'minecraft:stone')
    store.setBlock({ x: 14, y: 3, z: 3 }, 'minecraft:dirt')
    symmetrize(store, {
      axis: 'x',
      coordinate: 8,
      source: 'negative',
      clear: false,
      confirm: true,
    })
    expect(store.getBlockString({ x: 14, y: 3, z: 3 })).toBe('minecraft:dirt') // 保留
  })

  it('source:positive 反向镜像', () => {
    const store = makeStore()
    store.setBlock({ x: 12, y: 3, z: 3 }, 'minecraft:stone')
    symmetrize(store, { axis: 'x', coordinate: 8, source: 'positive', confirm: true })
    expect(store.getBlockString({ x: 4, y: 3, z: 3 })).toBe('minecraft:stone')
  })

  it('平面上的方块映射到自己（不产生变化）', () => {
    const store = makeStore()
    store.setBlock({ x: 8, y: 3, z: 3 }, 'minecraft:stone')
    const before = store.revision
    symmetrize(store, { axis: 'x', coordinate: 8, source: 'negative', confirm: true })
    expect(store.revision).toBe(before) // 无变化 → 不递增
    expect(store.getBlockString({ x: 8, y: 3, z: 3 })).toBe('minecraft:stone')
  })

  it('保留方块状态（楼梯朝向等原样复制）', () => {
    const store = makeStore()
    store.setBlock({ x: 6, y: 2, z: 6 }, 'oak_stairs[facing=north,half=top]')
    symmetrize(store, { axis: 'x', coordinate: 8, source: 'negative', confirm: true })
    expect(store.getBlockString({ x: 10, y: 2, z: 6 })).toBe(
      store.getBlockString({ x: 6, y: 2, z: 6 }),
    )
    expect(store.getBlockString({ x: 10, y: 2, z: 6 })).toContain('half=top')
  })

  it('镜像到工区外的部分被裁剪', () => {
    const store = makeStore({ min: { x: 0, y: 0, z: 0 }, max: { x: 10, y: 10, z: 10 } })
    store.setBlock({ x: 0, y: 3, z: 3 }, 'minecraft:stone') // 镜像到 x=16，越界
    const result = symmetrize(store, { axis: 'x', coordinate: 8, source: 'negative', confirm: true })
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.clipped).toBeGreaterThan(0)
    expect(store.isAir({ x: 0, y: 3, z: 3 })).toBe(false) // 源仍保留，只是镜像落到了工区外
  })

  it('y 轴镜像（左右对称 → 上下翻转）', () => {
    const store = makeStore()
    store.setBlock({ x: 3, y: 2, z: 3 }, 'minecraft:stone')
    symmetrize(store, { axis: 'y', coordinate: 5, source: 'negative', confirm: true })
    expect(store.getBlockString({ x: 3, y: 8, z: 3 })).toBe('minecraft:stone')
  })

  it('z 轴镜像', () => {
    const store = makeStore()
    store.setBlock({ x: 3, y: 2, z: 1 }, 'minecraft:stone')
    symmetrize(store, { axis: 'z', coordinate: 10, source: 'negative', confirm: true })
    expect(store.getBlockString({ x: 3, y: 2, z: 19 })).toBe('minecraft:stone')
  })

  it('可以撤销', () => {
    const store = makeStore()
    store.write(box({ x: 0, y: 0, z: 0 }, { x: 6, y: 3, z: 6 }), store.palette.indexOf('minecraft:stone'), {
      confirm: true,
    })
    const before = dump(store)
    symmetrize(store, { axis: 'x', coordinate: 8, source: 'negative', confirm: true })
    expect(dump(store).size).toBeGreaterThan(before.size)
    store.revertLastWrite()
    expect(dump(store)).toEqual(before)
  })

  it('对称性自检：镜像后左右两半逐格相等', () => {
    const store = makeStore()
    // 造一个不对称的左半区
    store.write(box({ x: 0, y: 0, z: 0 }, { x: 5, y: 3, z: 5 }), store.palette.indexOf('minecraft:stone'), {
      confirm: true,
    })
    store.setBlock({ x: 3, y: 4, z: 3 }, 'minecraft:oak_log')
    symmetrize(store, { axis: 'x', coordinate: 8, source: 'negative', confirm: true })

    let checked = 0
    for (let dx = 0; dx <= 7; dx++) {
      for (let y = 0; y <= 5; y++) {
        for (let z = 0; z <= 8; z++) {
          expect(store.getBlockString({ x: 7 - dx, y, z })).toBe(
            store.getBlockString({ x: 9 + dx, y, z }),
          )
          checked++
        }
      }
    }
    expect(checked).toBe(8 * 6 * 9)
  })
})
