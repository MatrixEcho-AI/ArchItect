import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { DEBUG_FLAGS, autosaveDirFor, debugFlagNames, isDiagnosticRun } from '../src/main/services/diagnostics.js'

describe('诊断开关的定义', () => {
  it('每个开关都能被单独认出来，且顺序稳定', () => {
    for (const [flag, name] of DEBUG_FLAGS) {
      expect(debugFlagNames(['electron', '.', flag])).toEqual([name])
    }
    // 叠加时按定义顺序输出（hash 是给渲染进程读的，顺序变了会破坏缓存比较）
    const all = DEBUG_FLAGS.map(([flag]) => flag)
    expect(debugFlagNames(['x', ...all])).toEqual(DEBUG_FLAGS.map(([, name]) => name))
  })

  it('没有开关时是空列表（不带 hash 起窗口）', () => {
    expect(debugFlagNames(['electron', '.'])).toEqual([])
  })
})

describe('诊断跑不许碰用户自己的草稿', () => {
  // 用 join(tmpdir(), …) 而不是写死 '/tmp/user-data'：被测的 autosaveDirFor 内部走
  // path.join，Windows 上分隔符会变成反斜杠，跟写死的正斜杠字面量对不上。
  const USER_DATA = join(tmpdir(), 'user-data')

  it('正常启动用 autosave/', () => {
    expect(isDiagnosticRun(['electron', '.'], new Set())).toBe(false)
    expect(autosaveDirFor(USER_DATA, ['electron', '.'], new Set())).toBe(join(USER_DATA, 'autosave'))
  })

  it('**带任何调试开关都算诊断跑**（它们都会合成编辑动作）', () => {
    for (const [, name] of DEBUG_FLAGS) {
      const argv = ['electron', '.']
      expect(isDiagnosticRun(argv, new Set([name]))).toBe(true)
      expect(autosaveDirFor(USER_DATA, argv, new Set([name]))).toBe(
        join(USER_DATA, 'autosave-diagnostics'),
      )
    }
  })

  it('--demo / --capture / --shot / --gui-smoke 也算（它们真的会改世界）', () => {
    for (const flag of ['--demo', '--capture', '--shot', '--gui-smoke']) {
      expect(isDiagnosticRun(['electron', '.', flag], new Set())).toBe(true)
    }
  })

  it('纯粹只读的开关不算（--smoke 用临时目录，压根不接自动保存）', () => {
    expect(isDiagnosticRun(['electron', '.', '--smoke'], new Set())).toBe(false)
    expect(isDiagnosticRun(['electron', '.', '/path/to/x.mcai'], new Set())).toBe(false)
  })
})
