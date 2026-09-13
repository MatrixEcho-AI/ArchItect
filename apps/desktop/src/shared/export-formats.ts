import type { MessageKey } from '@architect/i18n'

/**
 * 导出格式的**唯一真相**：主进程、预加载与渲染进程都从这一张表取。
 *
 * ## 为什么要有这个文件
 *
 * 在这之前，"能导出哪几种格式"散在三个地方：主进程按扩展名猜（`formatOf`）、
 * 保存对话框各自挑一个 filter（`filterOf`）、而**界面把格式写死成 `'schem'`**。
 * 前两处有代码形状撑着，第三处没有闸门。
 *
 * 后果是一次安静的回归：界面上的导出按钮从此只出得来 `.schem`，
 * `.litematic` 与 `.obj` 除非手打扩展名否则拿不到。而**没有任何东西报警**——
 * 类型检查过、全量测试绿、打包冒烟也绿（它直接调服务层，三种格式确实都能导）。
 * 只有用户会发现少了两项。这正是 `plan.md` 附录 D 里那句"linter 的三条判据必须
 * 写死，否则会稳定误报"的反面：**唯一真相只能有一份，否则就会稳定漂移**。
 *
 * 现在菜单、对话框 filter、扩展名与字节四处都从这张表推出来：
 * 加一种格式只改这里一行（`studio.exportModel` 的类型会立刻要求你实现它），
 * 而"界面少给了一种"会撞上 `test/export-formats.test.ts`。
 *
 * ## 为什么 `format` 与 `extension` 是两个字段而不是一个
 *
 * 它们现在逐项相同，看着冗余，但语义不同：`format` 是 `exportModel` 的入参
 * （内部标识），`extension` 是落在磁盘上的后缀。`schem` 这一项就是反例的预兆——
 * Sponge 的历史扩展名还有 `.schematic`，将来若要把 `format` 改名而保住旧后缀，
 * 拆开就不必动所有调用点。
 */
export const EXPORT_FORMATS = [
  { format: 'schem', extension: 'schem', label: 'dialog.schemFilter' },
  { format: 'litematic', extension: 'litematic', label: 'dialog.litematicFilter' },
  { format: 'obj', extension: 'obj', label: 'dialog.objFilter' },
] as const satisfies ReadonlyArray<{ format: string; extension: string; label: MessageKey }>

/** 表里的一行。 */
export type ExportFormatEntry = (typeof EXPORT_FORMATS)[number]

/**
 * 导出格式的**联合类型**。
 *
 * 它由表反推，所以"表里加一项、类型里没加"或反过来的漂移都不可能发生。
 * `StudioService.exportModel` 收这个类型：少实现一种格式就编译不过。
 */
export type ExportFormat = ExportFormatEntry['format']

/**
 * 按格式取那一行。
 *
 * 入参是 `ExportFormat`，所以"找不到"在类型上不可能发生；抛错只是为了让调用方
 * 不必写非空断言——把不可能的分支显式化，比在调用点撒 `!` 诚实。
 */
export function exportFormatEntry(format: ExportFormat): ExportFormatEntry {
  const entry = EXPORT_FORMATS.find((item) => item.format === format)
  if (entry === undefined) throw new Error(`unknown export format: ${format}`)
  return entry
}

/**
 * 按扩展名（或 `--format` 的值）判断要导成什么。认不出来的一律按 `.schem`。
 *
 * "认不出来退到默认值"是刻意保留的旧行为：用户在保存对话框里手打一个
 * `hut.xyz`，与其报错不如按默认格式写出去——他改扩展名通常是想换个格式，
 * 而不是想让这次导出失败。
 */
export function exportFormatOf(value: string): ExportFormat {
  const lower = value.toLowerCase()
  const hit = EXPORT_FORMATS.find(
    (entry) => lower === entry.format || lower.endsWith(`.${entry.extension}`),
  )
  return hit?.format ?? 'schem'
}

/**
 * 从"另存为"给的路径里剥掉扩展名，留下文件名主干。
 *
 * 比格式表多一个 `.schematic`：那是 Sponge 格式的另一个叫法，只在**导入**侧出现，
 * 用户手打这个后缀时我们仍然该认出它属于 `.schem` 这一族。
 */
export const EXPORT_EXTENSION_STRIP = /\.(schem|schematic|litematic|obj)$/i
