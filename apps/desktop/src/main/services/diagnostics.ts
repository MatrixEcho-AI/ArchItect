import { join } from 'node:path'

/**
 * **诊断跑与正常跑必须用不同的草稿目录。**
 *
 * `--demo` / `--capture` / `--shot` / `--gui-smoke` / `--drag-test` 这些开关会**真的编辑世界**
 * 并且真的往写前日志里记 op。如果它们和正常使用共用一个 autosave 目录，后果是：
 *
 * - 用户下次正常启动会看到一条"上次会话有 N 步没保存进工程"的提示；
 * - 那份草稿是调试跑出来的，基准往往还是某个早被删掉的临时文件（`/tmp/xxx.mcai`），
 *   于是提示变成"基准工程已经不在原处，恢复不了"——一个**看起来像报错、实际没人做错事**
 *   的横幅。这个坑真出现过：一卷 112 步、基准指向 `/tmp/lighthouse.mcai` 的草稿
 *   就是这么攒出来的（当时它还是我排查"应用为什么打不开"的干扰项）。
 *
 * 判据单独放在这里而不是写在 `index.ts` 里：`index.ts` 要 `import electron`，
 * 拿不了单元测试，而这条判据恰恰是会被改坏、又只能靠"用户下次启动时觉得奇怪"来发现的那类逻辑。
 */

/**
 * **诊断开关的唯一定义**（命令行 flag → 传给渲染进程的 hash 名）。
 *
 * 一处定义、两处使用：渲染进程（读 hash 决定合成什么事件）与主进程（决定草稿往哪写）。
 * 分成两份的话，新加一个开关时很容易只加一边——症状是"开关看着生效了，但脏数据
 * 悄悄写进了用户的草稿"。
 */
export const DEBUG_FLAGS: ReadonlyArray<readonly [flag: string, name: string]> = [
  ['--open-settings', 'settings'],
  ['--drag-test', 'drag-test'],
  ['--camera-test', 'camera-test'],
  ['--no-webgl', 'no-webgl'],
  ['--undo-test', 'undo-test'],
  ['--paint-test', 'paint-test'],
  // 合成一次"新建"：**先载入示例工程再按新建**，用来抓"新建之后该清空的东西清没清"
  ['--new-test', 'new-test'],
  // 往对话里塞一条 markdown 样本：用来肉眼验"模型回复渲染成什么样"（窄栏里的溢出、
  // 表格、代码块）。它**只进这一个会话，不写进 `.mcai`**——见 `seedMarkdownSample`。
  ['--md-test', 'md-test'],
]

/** 这一趟带了哪些诊断开关（顺序与定义一致，便于做 hash 时稳定）。 */
export function debugFlagNames(argv: readonly string[]): string[] {
  return DEBUG_FLAGS.filter(([flag]) => argv.includes(flag)).map(([, name]) => name)
}

/** 这些开关一定会改世界并写草稿，所以属于诊断跑。 */
const DIAGNOSTIC_FLAGS = ['--demo', '--capture', '--shot', '--gui-smoke'] as const

/**
 * 这一趟是不是诊断跑。
 *
 * 注意 `--smoke` 不在这里：它压根不接自动保存（用的是临时目录），不碰用户的草稿。
 * 而任何**调试开关**（`--drag-test` / `--undo-test` / `--paint-test` / `--camera-test` /
 * `--no-webgl` / `settings`…）都算——它们都会合成编辑动作。
 */
export function isDiagnosticRun(argv: readonly string[], debugFlags: ReadonlySet<string>): boolean {
  if (debugFlags.size > 0) return true
  return DIAGNOSTIC_FLAGS.some((flag) => argv.includes(flag))
}

/** 这一趟的草稿目录。诊断跑落在 `autosave-diagnostics/`，与用户自己的草稿井水不犯河水。 */
export function autosaveDirFor(
  userData: string,
  argv: readonly string[],
  debugFlags: ReadonlySet<string>,
): string {
  return join(userData, isDiagnosticRun(argv, debugFlags) ? 'autosave-diagnostics' : 'autosave')
}
