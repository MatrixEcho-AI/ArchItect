import { WorldStore } from '@architect/core'
import type { Bounds } from '@architect/core'
import { describe, expect, it } from 'vitest'

import { cameraForShot } from '../src/camera.js'
import { encodePng } from '../src/canvas.js'
import { createFallbackColorResolver } from '../src/colors.js'
import { meshWorldEntities } from '../src/entities-render.js'
import { ENTITY_FALLBACK_TEXTURE } from '../src/entity-atlas.js'
import { renderIsometric } from '../src/isometric.js'
import { bakedColorTexturePack } from '../src/texturepack.js'

const VOLUME: Bounds = { min: { x: 0, y: 0, z: 0 }, max: { x: 15, y: 15, z: 15 } }
const makeStore = (): WorldStore => new WorldStore({ minecraftVersion: '1.21.4', volume: VOLUME })

function scene(withEntities: boolean): WorldStore {
  const store = makeStore()
  for (let x = 0; x < 8; x++) for (let z = 0; z < 8; z++) store.setBlock({ x, y: 0, z }, 'minecraft:stone')
  if (withEntities) {
    store.entities.set({ id: 'e_1_1', type: 'minecraft:oak_boat', x: 3.5, y: 1, z: 3.5, yaw: 0 })
    // 模型表里没有它 → 走 `minecraft-data` 宽高的兜底盒
    store.entities.set({ id: 'e_1_2', type: 'minecraft:item_frame', x: 5.5, y: 1, z: 5.5, yaw: 0 })
  }
  return store
}

const pack = bakedColorTexturePack('1.21.4')

describe('世界里的实体 → 几何 + 图集', () => {
  it('**没有实体时返回 undefined**：渲染路径的形状与以前完全一样', () => {
    // 这条不是优化，是"既有 golden 逐字节不变"的机制保证
    expect(meshWorldEntities(scene(false), pack)).toBeUndefined()
  })

  it('船用真模型，模型表里没有的用兜底盒并行如实报出来', () => {
    const result = meshWorldEntities(scene(true), pack)!
    expect(result.geometry.vertices).toBeGreaterThan(0)
    expect(result.missing).toEqual([])
    expect(result.fallbackTypes).toEqual(['minecraft:item_frame'])
    // 两张贴图各占一个 tile，外加永远在 0 号位的兜底 tile
    expect(Object.keys(result.atlas.textures).sort()).toEqual(
      [ENTITY_FALLBACK_TEXTURE, 'entity/boat/oak'].sort(),
    )
  })

  it('**材质位全是 1**（方块是 0）——查错表的话透明判据会变成随机', () => {
    const result = meshWorldEntities(scene(true), pack)!
    const materials = result.geometry.materials!
    expect(materials.length).toBe(result.geometry.indices.length / 3)
    expect([...new Set(materials)]).toEqual([1])
  })

  it('图集 tile 比贴图大时逐 tile 记下真实尺寸（否则整条船会被判成半透明）', () => {
    const result = meshWorldEntities(scene(true), pack)!
    // 确定性贴图包给的实体贴图是 64×32，tile 取到 64
    expect(result.atlas.tileSize).toBe(64)
    const boatTile = Object.keys(result.atlas.textures).sort().indexOf('entity/boat/oak')
    expect(result.atlas.tileExtents![boatTile * 2]).toBe(64)
    expect(result.atlas.tileExtents![boatTile * 2 + 1]).toBe(32)
  })

  it('读不到的贴图**如实报出来**，不静默填黑', () => {
    const store = scene(false)
    store.entities.set({ id: 'e_1_1', type: 'minecraft:cow', x: 3, y: 1, z: 3, yaw: 0 })
    // 这个包只认 `block/`，所以实体的 `entity/...` 一律读不到
    const blockOnly = {
      id: 'block-only',
      kind: 'baked' as const,
      detail: '',
      blockTiles: () => pack.blockTiles(),
      read: (path: string) => (path.startsWith('block/') ? pack.read(path) : undefined),
    }
    const result = meshWorldEntities(store, blockOnly)!
    expect(result.missing).toEqual(['entity/cow/cow'])
  })
})

describe('两条软件路径都要画实体', () => {
  it('纹理路径：有实体与没实体的图不同', () => {
    const render = (withEntities: boolean): Uint8Array => {
      const store = scene(withEntities)
      const camera = cameraForShot(store.contentBounds()!, { view: 'iso_ne', width: 200, height: 150 })
      return encodePng(
        renderIsometric(store, {
          camera,
          resolve: createFallbackColorResolver(),
          textured: true,
          textures: pack,
          overlays: false,
        }).canvas,
      )
    }
    expect(render(true)).not.toEqual(render(false))
  })

  it('**纯色快路径也画**（画成碰撞盒，与它画方块的方式一致）', () => {
    const render = (withEntities: boolean): Uint8Array => {
      const store = scene(withEntities)
      const camera = cameraForShot(store.contentBounds()!, { view: 'iso_ne', width: 200, height: 150 })
      return encodePng(
        renderIsometric(store, { camera, resolve: createFallbackColorResolver(), overlays: false }).canvas,
      )
    }
    expect(render(true)).not.toEqual(render(false))
  })
})
