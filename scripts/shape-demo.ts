import { writeFileSync } from 'node:fs'
import { createAssetColorResolver, encodePng, fitCamera, presetAngles, renderIsometric } from '@architect/render'
import { WorldStore } from '@architect/core'

function main(): void {
  const store = new WorldStore({
    minecraftVersion: '1.21.4',
    volume: { min: { x: 0, y: 0, z: 0 }, max: { x: 31, y: 20, z: 31 } },
  })
  const P = (name: string): number => store.palette.indexOf(name)
  const put = (x: number, y: number, z: number, block: string): void => {
    store.write((v) => v(x, y, z), P(block), { confirm: true })
  }

  // 楼梯（带朝向）
  for (let i = 0; i < 5; i++) {
    put(2 + i, i, 2, `minecraft:oak_stairs[facing=east]`)
  }
  // 台阶（上下半砖）
  put(2, 0, 5, 'minecraft:stone_bricks')
  put(3, 0, 5, 'minecraft:oak_slab[type=bottom]')
  put(3, 1, 5, 'minecraft:oak_slab[type=top]')
  // 栅栏围栏
  for (let z = 8; z <= 14; z++) put(2, 0, z, 'minecraft:oak_fence')
  // 门
  put(6, 0, 8, 'minecraft:oak_door[facing=south,half=lower]')
  put(6, 1, 8, 'minecraft:oak_door[facing=south,half=upper]')
  // 玻璃板
  for (let x = 8; x <= 12; x++) put(x, 0, 8, 'minecraft:glass_pane')
  // 活板门
  put(9, 0, 11, 'minecraft:oak_trapdoor[facing=north,half=bottom,open=true]')
  // 墙
  for (let z = 11; z <= 15; z++) put(12, 0, z, 'minecraft:cobblestone_wall')
  // 压力板 / 地毯 / 火把（无碰撞形状）
  put(4, 1, 5, 'minecraft:torch')
  put(14, 0, 11, 'minecraft:stone_pressure_plate')

  const bounds = store.contentBounds()!
  const resolve = createAssetColorResolver('1.21.4')
  const camera = fitCamera(bounds, presetAngles('iso_ne'), 720, 480)
  const result = renderIsometric(store, { camera, resolve, overlays: { ruler: false } })
  writeFileSync('/tmp/shapes.png', encodePng(result.canvas))
  console.log(`已渲染 /tmp/shapes.png  ${result.blocks} 方块 / ${result.faces} 面`)
  console.log(`（改之前所有方块都会画成整立方体，约 ${result.blocks * 3} 面且全是方块状）`)
}

main()
