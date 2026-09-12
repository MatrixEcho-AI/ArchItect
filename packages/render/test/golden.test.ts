import { mkdirSync, readFileSync, existsSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { WorldStore } from '@architect/core'
import type { Bounds } from '@architect/core'
import { describe, expect, it } from 'vitest'

import { cameraForShot } from '../src/camera.js'
import { encodePng } from '../src/canvas.js'
import { bakedColorTexturePack } from '../src/texturepack.js'
import { createFallbackColorResolver } from '../src/colors.js'
import { renderIsometric } from '../src/isometric.js'
import { measure } from '@architect/core'

/**
 * **软件光栅器的 golden 基线**（plan §14 的渲染测试行、M3 的验收项）。
 *
 * 为什么值得签这一份：软件光栅器是**逐字节可复现**的（plan §7.1.1），
 * 而它同时是 CLI、CI、无 GPU 环境的唯一渲染路径，也是"给模型看的那张图"在
 * 回落时的样子。以前这里只有"不是空白 + 尺寸对"这种弱断言——它能通过
 * 一幅**砖缝全糊、AO 全丢、z-buffer 失效**的图。签名之后，任何一次渲染改动
 * 都会在这里留下一条可见的 diff。
 *
 * 两条纪律：
 *
 * 1. **只用确定性输入**：`plain`（哈希配色）或**烘好的平均色**资源包。
 *    绝不引入 `minecraft-assets`——那玩意儿的版本一变，基线就要重签，
 *    而"为什么这次签变了"会变成一件说不清的事。
 * 2. **改渲染就要重新签**，这是这套测试的代价，也是它的作用。命令：
 *    `ARCHITECT_UPDATE_GOLDEN=1 pnpm test packages/render/test/golden.test.ts`
 *    重新签之前先看一眼新图对不对——签名的价值全在"人真的看过"。
 */
const here = dirname(fileURLToPath(import.meta.url))
const goldenDir = join(here, 'golden')
const updating = process.env['ARCHITECT_UPDATE_GOLDEN'] === '1'

const VOLUME: Bounds = { min: { x: 0, y: 0, z: 0 }, max: { x: 31, y: 31, z: 31 } }

/**
 * 一个**固定的小场景**：够杂，才能一次锁住几何、剔除、AO、z-buffer 与叠加层。
 *
 * 含：整块的墙与地、台阶（非整块模型 + 朝向重映射）、栅栏（连横杆）、玻璃（半透明通道）、
 * 一扇门（两格高）、悬挑（AO 与阴影梯度）、以及一块高处的装饰（测深度排序）。
 */
function fixture(): WorldStore {
  const store = new WorldStore({ minecraftVersion: '1.21.4', volume: VOLUME })
  const at = (name: string): number => store.palette.indexOf(name)
  // 地板 + 三面墙
  store.write((emit) => {
    for (let x = 2; x <= 13; x++) for (let z = 2; z <= 13; z++) emit(x, 0, z)
  }, at('minecraft:stone_bricks'), { confirm: true })
  store.write((emit) => {
    for (let x = 2; x <= 13; x++) for (let y = 1; y <= 4; y++) emit(x, y, 2)
  }, at('minecraft:spruce_planks'), { confirm: true })
  store.write((emit) => {
    for (let z = 2; z <= 13; z++) for (let y = 1; y <= 4; y++) emit(2, y, z)
  }, at('minecraft:spruce_planks'), { confirm: true })
  // 台阶（朝向南）+ 栅栏 + 玻璃窗
  for (let i = 0; i < 3; i++) {
    store.write((emit) => emit(5 + i, 1, 10), at(`minecraft:oak_stairs[facing=south]`), { confirm: true })
  }
  for (let z = 4; z <= 8; z++) {
    store.write((emit) => emit(13, 1, z), at('minecraft:oak_fence[north=true,south=true]'), { confirm: true })
  }
  store.write((emit) => emit(6, 3, 2), at('minecraft:glass'), { confirm: true })
  store.write((emit) => emit(7, 3, 2), at('minecraft:glass'), { confirm: true })
  // 门（两格高）与门洞
  store.write((emit) => {
    emit(9, 1, 2)
    emit(9, 2, 2)
  }, 0, { mode: 'destroy', confirm: true })
  store.write((emit) => emit(9, 1, 2), at('minecraft:spruce_door[facing=south,half=lower]'), { confirm: true })
  store.write((emit) => emit(9, 2, 2), at('minecraft:spruce_door[facing=south,half=upper]'), { confirm: true })
  // 悬挑 + 高处装饰
  store.write((emit) => {
    for (let x = 4; x <= 8; x++) emit(x, 5, 2)
  }, at('minecraft:dark_oak_planks'), { confirm: true })
  store.write((emit) => emit(11, 6, 11), at('minecraft:red_concrete'), { confirm: true })
  return store
}

interface Case {
  name: string
  width: number
  height: number
  /** `plain`：哈希配色（最纯的确定性）；`baked`：烘好的平均色 + 真实模型几何。 */
  coloring: 'plain' | 'baked'
  view: 'iso_ne' | 'front' | 'top'
  overlays: boolean
  highlightLast: boolean
  /** 在场景里摆四条朝向不同的船（实体层 golden）。 */
  entities?: boolean
}

const CASES: Case[] = [
  // 主基线：纯色 + 叠加层，覆盖等轴测投影、画家排序、标尺/坐标轴/工区线框
  { name: 'iso-plain-overlays', width: 320, height: 240, coloring: 'plain', view: 'iso_ne', overlays: true, highlightLast: true },
  // 同一个场景换正视图：投影与可见面集合完全不同（能抓到"只有等轴测才对"的回归）
  { name: 'front-plain', width: 240, height: 240, coloring: 'plain', view: 'front', overlays: false, highlightLast: false },
  // 俯视：测上下面的判据与"恰好侧对相机"的背面容差
  { name: 'top-plain', width: 240, height: 240, coloring: 'plain', view: 'top', overlays: false, highlightLast: false },
  // 纹理路径：真实方块模型（台阶/栅栏/玻璃/门）+ 逐像素采样 + AO + z-buffer。
  // 用烘好的平均色当"纹理"，所以完全不依赖 minecraft-assets，CI 上逐字节一致
  { name: 'iso-baked-uv', width: 320, height: 240, coloring: 'baked', view: 'iso_ne', overlays: false, highlightLast: false },
  // 实体层：四条船、四个朝向，摆在空地上。这一张同时锁住三件事——船的形状、
  // `yaw` 的符号（写反了四条船会整体反向）、以及"实体图集与方块图集不是同一张"
  // 这件事（材质位查错表的话，船的透明判据会变成随机，图里看得出来）。
  // 贴图来自 `bakedColorTexturePack` 画的那张棋盘，所以**完全不依赖 minecraft-assets**
  { name: 'iso-baked-entities', width: 320, height: 240, coloring: 'baked', view: 'iso_ne', overlays: false, highlightLast: false, entities: true },
]

function renderCase(testCase: Case): Uint8Array {
  const store = fixture()
  if (testCase.entities === true) {
    // 四个朝向各一条，摆在地板上（y=1）。间距 3 格，免得互相遮住看不清朝向
    for (const [i, yaw] of [0, 4, 8, 12].entries()) {
      store.entities.set({
        id: `e_golden_${i}`,
        type: 'minecraft:oak_boat',
        x: 5.5 + (i % 2) * 3,
        y: 1,
        z: 5.5 + Math.floor(i / 2) * 3,
        yaw,
      })
    }
  }
  const bounds = measure(store).bounds ?? VOLUME
  const camera = cameraForShot(bounds, {
    view: testCase.view,
    width: testCase.width,
    height: testCase.height,
  })
  const result = renderIsometric(store, {
    camera,
    resolve: createFallbackColorResolver(),
    ...(testCase.coloring === 'baked'
      ? { textured: true, textures: bakedColorTexturePack('1.21.4') }
      : {}),
    overlays: testCase.overlays
      ? {
          // 叠加层里**能确定的部分全开**：标尺、坐标轴、工区线框、高亮、说明行。
          // 它们是"给模型看的那张图"的一部分，退化在这儿比退化在方块上更隐蔽
          ruler: true,
          axisGizmo: true,
          volumeBox: VOLUME,
          caption: [`golden ${testCase.name}`],
          ...(testCase.highlightLast ? { highlight: store.volume } : {}),
        }
      : false,
  })
  return encodePng(result.canvas)
}

describe('软件光栅器的 golden 基线（逐字节，plan §14）', () => {
  it('**同一个场景渲染两次逐字节相同**（基线成立的前提）', () => {
    const first = renderCase(CASES[0]!)
    const second = renderCase(CASES[0]!)
    expect(second).toEqual(first)
  })

  for (const testCase of CASES) {
    it(`golden: ${testCase.name}`, () => {
      const png = renderCase(testCase)
      const path = join(goldenDir, `${testCase.name}.png`)
      if (updating) {
        mkdirSync(goldenDir, { recursive: true })
        writeFileSync(path, png)
        return
      }
      if (!existsSync(path)) {
        throw new Error(
          `缺少 golden 基线 ${testCase.name}.png——先跑 ARCHITECT_UPDATE_GOLDEN=1 pnpm test packages/render/test/golden.test.ts 生成并**看一眼新图**`,
        )
      }
      const baseline = new Uint8Array(readFileSync(path))
      if (!baseline.every((byte, index) => png[index] === byte) || baseline.length !== png.length) {
        // 只说"不一样"没用：把大小差与第一个不同处在哪儿一起报出来，人才知道从哪看起
        let firstDiff = -1
        for (let i = 0; i < Math.min(baseline.length, png.length); i++) {
          if (baseline[i] !== png[i]) {
            firstDiff = i
            break
          }
        }
        throw new Error(
          `${testCase.name}: 渲染结果与基线不同（基线 ${baseline.length} 字节 / 现在 ${png.length} 字节，` +
            `第一处差异在第 ${firstDiff} 字节）。如果这是有意的渲染改动，重新签基线：` +
            `ARCHITECT_UPDATE_GOLDEN=1 pnpm test packages/render/test/golden.test.ts`,
        )
      }
      expect(baseline.length).toBe(png.length)
    })
  }
})
