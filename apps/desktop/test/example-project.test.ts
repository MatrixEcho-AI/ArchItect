// @vitest-environment node
/**
 * **打开示例工程之后画面上要有东西。**
 *
 * 这条是回归测试：`restoreColumns`（`.mcai` 快照的整列写入）原先绕开了"哪些段有方块"
 * 的记录，于是网格化以为世界是空的。症状特别有欺骗性——左栏写着 330 个方块、
 * 时间线 rev 也对，**只有视口一片空白**（HUD 读 `measure()` 全量扫描，网格化读段记录）。
 *
 * 这里刻意用**真工程的字节**而不是自造一个 store：`.mcai` 的装载路径
 * （解压 → 调色板 → 整列写 → 重放补丁）是段记录最容易被漏掉的那条，而它只有走
 * 真文件才覆盖得到。
 */

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { openProject } from '@architect/mcai'
import { loadRenderData, meshWorld } from '@architect/render'
import { assetsTexturePack } from '@architect/render/assets'
import { describe, expect, it } from 'vitest'

const here = dirname(fileURLToPath(import.meta.url))
const example = join(here, '..', '..', '..', 'examples', 'forest-hut.mcai')

describe('示例工程：装载之后是可渲染的', () => {
  it('**有方块、有段、有顶点**', () => {
    const bytes = readFileSync(example)
    const { store } = openProject(new Uint8Array(bytes))

    // 1. 方块确实在（这条一直是对的，所以它一条都拦不住那个 bug）
    expect(store.stats().blocks).toBeGreaterThan(0)

    // 2. **段记录必须有**——网格化就是靠它决定画哪儿。
    //    这一条才是那个空白视口的判据。
    let sections = 0
    store.forEachPopulatedSection(() => sections++)
    expect(sections).toBeGreaterThan(0)

    // 3. 于是网格化真的产出几何
    const data = loadRenderData(
      store.registry.minecraftVersion,
      assetsTexturePack(store.registry.minecraftVersion),
    )
    const geometry = meshWorld(store, data)
    expect(geometry.vertices).toBeGreaterThan(0)
    expect(geometry.indices.length).toBeGreaterThan(0)
  })
})
