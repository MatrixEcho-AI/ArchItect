import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import { openProject, unpackProject } from '../src/project.js'

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const examplePath = join(root, 'examples', 'forest-hut.mcai')

/**
 * 仓库里的示例工程是一份**活的端到端夹具**。
 *
 * 单元测试是拆开验的：格式一处、渲染一处、agent 一处。示例工程把它们串起来——
 * 它是真的用 `packProject` 写出来、真的能被 `openProject` 打开的一份文件。
 * 格式演进时它会先坏，而不是等用户打开示例才发现。
 */
describe('examples/forest-hut.mcai 是一份真能用的工程', () => {
  const bytes = new Uint8Array(readFileSync(examplePath))

  it('能打开，方块数据完好', () => {
    const { store } = openProject(bytes)
    expect(store.stats().blocks).toBeGreaterThan(250)
    expect(store.registry.minecraftVersion).toBe('1.21.4')
    // 屋顶、门、窗都在
    const strings = store.palette.strings()
    expect(strings.some((s) => s.includes('spruce_planks'))).toBe(true)
    expect(strings.some((s) => s.includes('spruce_door'))).toBe(true)
    expect(strings.some((s) => s.includes('dark_oak_planks'))).toBe(true)
  })

  it('**带对话记录与截图**（这正是示例要演示的东西）', () => {
    const project = unpackProject(bytes)
    expect(project.chat.sessions).toHaveLength(1)
    expect(project.chat.sessions[0]?.id).toBe('example-hut')
    expect(project.chat.messages.length).toBeGreaterThan(10)
    expect(project.chat.messages[0]).toMatchObject({ role: 'user' })
    expect(project.chat.messages.some((m) => m.toolCalls !== undefined)).toBe(true)
    expect(project.chat.messages.some((m) => m.usage !== undefined)).toBe(true)

    expect(project.captures.refs).toHaveLength(1)
    expect(project.captures.files.size).toBe(1)
    const png = project.captures.files.get(project.captures.refs[0]!.id)!
    // 真的是 PNG
    expect(Array.from(png.slice(0, 4))).toEqual([0x89, 0x50, 0x4e, 0x47])
    expect(project.captureProblems).toEqual([])
  })

  it('manifest 的计数与内容对得上', () => {
    const project = unpackProject(bytes)
    expect(project.manifest.counters.captures).toBe(project.captures.refs.length)
    expect(project.manifest.counters.ops).toBe(project.manifest.revision)
    expect(project.manifest.worldHash).toBeTruthy()
  })

  it('**里面不含任何密钥**（`.mcai` 是要分享的文件）', () => {
    const project = unpackProject(bytes)
    const everything = [project.manifest, project.settings, project.chat].map((part) => JSON.stringify(part)).join('\n')
    expect(everything).not.toMatch(/sk-[A-Za-z0-9]{8,}/)
    expect(everything).not.toMatch(/api[_-]?key/i)
  })

  it('**示例生成是确定性的**：时间戳全部被钉死，重新生成不会产生 diff 噪音', () => {
    const project = unpackProject(bytes)
    const fixed = '2026-01-01T00:00:00.000Z'
    // op 的时间戳：不注入固定时钟的话，每一步都会带一个当次运行的时间
    for (const op of project.log.all()) {
      expect(op.ts, `op ${op.id} 的时间戳不是固定值`).toBe(fixed)
    }
    // manifest 与消息的时间戳同理
    expect(project.manifest.createdAt).toBe(fixed)
    expect(project.manifest.modifiedAt).toBe(fixed)
    for (const message of project.chat.messages) {
      expect(message.ts).toBe(fixed)
    }
    expect(project.chat.sessions[0]?.createdAt).toBe(fixed)
  })

  it('世界哈希与 manifest 对得上（打开时校验过的那个值）', () => {
    const { store } = openProject(bytes)
    const project = unpackProject(bytes)
    expect(store.contentHash()).toBe(project.manifest.worldHash)
  })
})
