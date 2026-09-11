/**
 * `architect import` 写出来的 `.mcai` 必须是一份**自洽的基准**。
 *
 * 这条只能在这一层验：走的是真实子进程与真实文件，导入内部那次 `writeBlocks`
 * 与「把游标拉回 0」的收尾是不是接得上，单测 `packProject` 看不出来。
 */
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { WorldStore } from '@architect/core'
import { DATA_VERSION_1_21_4, exportSchematic } from '@architect/interop'
import { unpackProject } from '@architect/mcai'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { TSX_CLI } from './run-cli.js'

const CLI_ENTRY = fileURLToPath(new URL('../src/index.ts', import.meta.url))

let dir: string
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'architect-import-'))
})
afterAll(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('CLI 导入写出的 .mcai', () => {
  it('**导入的内容是基准状态**：manifest 的 revision 是 0，编辑记录是空的', () => {
    // 导入走 `store.writeBlocks`，它无条件把游标加一，而导入**不记 op**。少一次
    // 收尾（把游标拉回 0），写出的文件就是「游标 1 / 日志空」：桌面端打开后撤销会
    // 读到不存在的 op 抛 TypeError，之后每一笔编辑都因为「游标与日志脱节」报错，
    // 而方块其实已经写进世界了。
    const volume = { min: { x: 0, y: 0, z: 0 }, max: { x: 15, y: 15, z: 15 } }
    const store = new WorldStore({ minecraftVersion: '1.21.4', volume })
    store.write(
      (emit) => {
        for (let x = 0; x < 4; x++) for (let z = 0; z < 4; z++) emit(x, 0, z)
      },
      store.palette.indexOf('minecraft:stone'),
      { confirm: true },
    )
    const schematic = exportSchematic(store, {
      dataVersion: DATA_VERSION_1_21_4,
      metadata: { Name: 't', Author: 'a' },
    })
    const schemPath = join(dir, 'hut.schem')
    writeFileSync(schemPath, schematic.bytes)
    const outPath = join(dir, 'back.mcai')

    execFileSync(process.execPath, [TSX_CLI, CLI_ENTRY, 'import', schemPath, '--out', outPath], {
      encoding: 'utf8',
    })

    const project = unpackProject(new Uint8Array(readFileSync(outPath)))
    expect(project.manifest.revision, '游标不是基准状态（rev 应当与日志长度一致）').toBe(0)
    expect(project.log.all(), '导入不该产生编辑记录').toHaveLength(0)
    // 工程名取的是文件名，不是整条路径——`.mcai` 是拿来分享的，路径里带着用户名不合适
    expect(project.manifest.name).toBe('hut')
  }, 60_000)
})
