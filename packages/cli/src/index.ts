import { readFile } from 'node:fs/promises'
import { parseArgs } from 'node:util'

import { writeFile } from 'node:fs/promises'

import { formatMeasure, measure, ReplaySession, renderSlice } from '@architect/core'
import type { Bounds, SliceAxis, SliceRange, WorldStore } from '@architect/core'
import {
  createPackColorResolver,
  texturePackAt,
  createFallbackColorResolver,
  encodePng,
  fitCamera,
  presetAngles,
  renderIsometric,
} from '@architect/render'
import { assetsTexturePack } from '@architect/render/assets'
import type { TexturePack } from '@architect/render'
import type { OverlayOptions } from '@architect/render'
import { sanitizeForFont } from '@architect/render'
import type { ViewPreset } from '@architect/render'
import { readFile as readTextFile } from 'node:fs/promises'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'

import {
  activeProvider,
  AgentSession,
  costOf,
  createProvider,
  discoverProvider,
  envKeyRef,
  evaluateTask,
  exchangesFromJsonl,
  exchangesToJsonl,
  findTask,
  GOLDEN_TASKS,
  presetFromEnv,
  PROVIDER_PRESETS,
  RecordingProvider,
  ReplayProvider,
  resolveApiKey,
  runAgent,
  settingsFromEnv,
  UsageMeter,
  validateProviderConfig,
} from '@architect/agent'
import type {
  AgentEvent,
  CostTable,
  GoldenTask,
  LlmProvider,
  PresetKey,
  ProviderConfig,
  RecordedExchange,
  TaskEvaluation,
} from '@architect/agent'
import {
  DATA_VERSION_1_21_4,
  exportLitematic,
  exportObj,
  exportSchematic,
  importSchematicInto,
  readSpongeSchematic,
  readLitematic,
  litematicToSchematicData,
} from '@architect/interop'
import { initI18n, t } from '@architect/i18n'
import { openProject, packProject, TranscriptRecorder } from '@architect/mcai'
import type { McaiProject } from '@architect/mcai'

/**
 * 组装 `--help` 帮助文本。
 *
 * 不能整块塞进 i18n：这份文本要按**显示宽度**对齐（CJK 是双宽），而中英的
 * 列宽不同。所以骨架（命令与选项的写法）留在代码里，只有解释文案走 `t()`，
 * 再按 `displayWidth` 补齐每一行；中英各自内部对齐即可。
 */
function usageText(): string {
  const meta = {
    command: t('cli.usage.meta.command'),
    project: t('cli.usage.meta.project'),
    option: t('cli.usage.meta.option'),
    preset: t('cli.usage.meta.preset'),
    goal: t('cli.usage.meta.goal'),
  }
  // 解释文案从第 34 个显示列开始；过长的选项写法独占一行
  const column = 34
  const entry = (flags: string, desc: string): string => {
    const left = `  ${flags}`
    const width = displayWidth(left)
    return width >= column
      ? `${left}\n${' '.repeat(column)}${desc}`
      : `${left}${' '.repeat(column - width)}${desc}`
  }
  const lines = [
    t('cli.usage.title'),
    '',
    t('cli.usage.heading'),
    `  architect <${meta.command}> <${meta.project}.mcai> [${meta.option}]`,
    '',
    t('cli.usage.commandsHeading'),
    entry('info <file>', t('cli.usage.cmd.info')),
    entry('ops  <file> [--limit N]', t('cli.usage.cmd.ops')),
    entry('measure <file>', t('cli.usage.cmd.measure')),
    entry(
      'slice <file> --axis <x|y|z> --index <n> [--x a..b] [--y a..b] [--z a..b]',
      t('cli.usage.cmd.slice'),
    ),
    entry('replay <file> [--to <rev>] [--slice <axis:index>]', t('cli.usage.cmd.replay')),
    entry(`shoot <file> --out <out.png> [--view <${meta.preset}> | --views a,b,c]`, t('cli.usage.cmd.shoot')),
    entry(`build "<${meta.goal}>" --out <file.mcai>`, t('cli.usage.cmd.build')),
    entry(
      'bench [--tasks a,b] [--out-dir <dir>] [--record <file> | --replay <file>]',
      t('cli.usage.cmd.bench'),
    ),
    entry(`providers [--provider <${meta.preset}>]`, t('cli.usage.cmd.providers')),
    entry(
      `export <${meta.project}.mcai> --out <out> [--format schem|litematic|obj] [--to <rev>]`,
      t('cli.usage.cmd.export'),
    ),
    entry(
      `import <file.schem|.litematic> --out <${meta.project}.mcai> [--size W,H,D]`,
      t('cli.usage.cmd.import'),
    ),
    '',
    t('cli.usage.optionsHeading'),
    entry('--json', t('cli.usage.opt.json')),
    entry('--limit N', t('cli.usage.opt.limit')),
    entry(`--view <${meta.preset}>`, t('cli.usage.opt.view')),
    entry('--views a,b,c', t('cli.usage.opt.views')),
    entry('--width / --height <px>', t('cli.usage.opt.size')),
    entry('--plain', t('cli.usage.opt.plain')),
    entry('--no-overlays', t('cli.usage.opt.noOverlays')),
    entry('--highlight-last', t('cli.usage.opt.highlightLast')),
    '',
    t('cli.usage.providerHeading'),
    entry('--provider <deepseek|openai|ollama|custom|scripted>', t('cli.usage.provider.preset')),
    entry('--model <id>', t('cli.usage.provider.model')),
    entry('--base-url <url>', t('cli.usage.provider.baseUrl')),
    entry('--api-key-env <VAR>', t('cli.usage.provider.apiKeyEnv')),
    entry('--no-probe', t('cli.usage.provider.noProbe')),
    entry('--model <id>', t('cli.usage.provider.modelShort')),
    entry('--base-url <url>', t('cli.usage.provider.baseUrlShort')),
    entry('--size <x,y,z>', t('cli.usage.provider.size')),
    entry('--max-turns <n>', t('cli.usage.provider.maxTurns')),
    entry('--max-usd <n>', t('cli.usage.provider.maxUsd')),
    entry('--max-output-tokens <n>', t('cli.usage.provider.maxOutputTokens')),
    `  ${t('cli.usage.provider.apiKeyNote')}`,
    '',
    t('cli.usage.benchHeading'),
    entry('--textures <path>', t('cli.usage.opt.textures')),
    entry('--tasks <a,b,c>', t('cli.usage.bench.tasks')),
    entry('--out-dir <dir>', t('cli.usage.bench.outDir')),
    entry('--record <file.jsonl>', t('cli.usage.bench.record')),
    entry('--replay <file.jsonl>', t('cli.usage.bench.replay')),
    entry('-h, --help', t('cli.usage.bench.help')),
  ]
  return `${lines.join('\n')}\n`
}

interface Invocation {
  command: string
  file?: string
  axis?: SliceAxis
  index?: number
  to?: number
  limit: number
  json: boolean
  sliceSpec?: string
  ranges: SliceRange
  out?: string
  views?: ViewPreset[]
  width: number
  height: number
  plain: boolean
  overlays: boolean
  highlightLast: boolean
  textures?: string
  provider?: string
  model?: string
  baseUrl?: string
  size?: string
  maxTurns?: number
  maxUsd?: number
  /** 单轮输出上限。**默认不设**——不设才是不限制（服务端思考模式默认 64K）。 */
  maxOutputTokens?: number
  apiKeyEnv?: string
  probe: boolean
  quiet: boolean
  tasks?: string
  outDir?: string
  record?: string
  replay?: string
  format?: string
}

/**
 * CLI 的渲染版本。与 `AgentSession` 的默认值保持一致——CLI 只跑 1.21.4 这一个版本
 * （`.mcai` 的 `minecraftVersion` 字段是给将来多版本用的）。
 */
const RENDER_VERSION = '1.21.4'

async function main(argv: string[]): Promise<number> {
  // D-01：CLI 复用同一套 i18n；语言从环境变量推断，`LANG=en-US` 即出英文
  initI18n()
  let parsed: ReturnType<typeof parseArgs>
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        axis: { type: 'string' },
        index: { type: 'string' },
        to: { type: 'string' },
        limit: { type: 'string' },
        slice: { type: 'string' },
        out: { type: 'string' },
        view: { type: 'string' },
        views: { type: 'string' },
        width: { type: 'string' },
        height: { type: 'string' },
        plain: { type: 'boolean', default: false },
        'no-overlays': { type: 'boolean', default: false },
        'highlight-last': { type: 'boolean', default: false },
        provider: { type: 'string' },
        model: { type: 'string' },
        'base-url': { type: 'string' },
        size: { type: 'string' },
        'max-turns': { type: 'string' },
        'max-usd': { type: 'string' },
        'max-output-tokens': { type: 'string' },
        'api-key-env': { type: 'string' },
        'no-probe': { type: 'boolean', default: false },
        quiet: { type: 'boolean', default: false },
        tasks: { type: 'string' },
        'out-dir': { type: 'string' },
        textures: { type: 'string' },
        record: { type: 'string' },
        replay: { type: 'string' },
        format: { type: 'string' },
        x: { type: 'string' },
        y: { type: 'string' },
        z: { type: 'string' },
        json: { type: 'boolean', default: false },
        help: { type: 'boolean', short: 'h', default: false },
      },
    })
  } catch (error) {
    process.stderr.write(`${(error as Error).message}\n\n${usageText()}`)
    return 2
  }

  // parseArgs 对混合类型的 options 会推成联合类型，这里收窄成实际形状
  const values = parsed.values as {
    axis?: string
    index?: string
    to?: string
    limit?: string
    slice?: string
    x?: string
    y?: string
    z?: string
    out?: string
    view?: string
    views?: string
    width?: string
    height?: string
    plain?: boolean
    textures?: string
    'no-overlays'?: boolean
    'highlight-last'?: boolean
    provider?: string
    model?: string
    'base-url'?: string
    size?: string
    'max-turns'?: string
    'max-usd'?: string
    'max-output-tokens'?: string
    'api-key-env'?: string
    'no-probe'?: boolean
    quiet?: boolean
    tasks?: string
    'out-dir'?: string
    record?: string
    replay?: string
    format?: string
    json?: boolean
    help?: boolean
  }
  const positionals = parsed.positionals
  if (values.help === true) {
    process.stdout.write(usageText())
    return 0
  }
  if (positionals.length === 0) {
    process.stderr.write(usageText())
    return 2
  }

  const inv: Invocation = {
    command: positionals[0]!,
    limit: values.limit !== undefined ? Number(values.limit) : 50,
    json: values.json === true,
    ranges: {},
    width: values.width !== undefined ? Number(values.width) : 1024,
    height: values.height !== undefined ? Number(values.height) : 768,
    plain: values.plain === true,
    overlays: values['no-overlays'] !== true,
    highlightLast: values['highlight-last'] === true,
    probe: values['no-probe'] !== true,
    quiet: values.quiet === true,
  }
  if (values.provider !== undefined) inv.provider = values.provider
  if (values.model !== undefined) inv.model = values.model
  if (values['base-url'] !== undefined) inv.baseUrl = values['base-url']
  if (values.size !== undefined) inv.size = values.size
  if (values['max-turns'] !== undefined) inv.maxTurns = Number(values['max-turns'])
  if (values['max-usd'] !== undefined) inv.maxUsd = Number(values['max-usd'])
  if (values['max-output-tokens'] !== undefined) inv.maxOutputTokens = Number(values['max-output-tokens'])
  if (values['api-key-env'] !== undefined) inv.apiKeyEnv = values['api-key-env']
  if (values.tasks !== undefined) inv.tasks = values.tasks
  if (values['out-dir'] !== undefined) inv.outDir = values['out-dir']
  if (values.textures !== undefined) inv.textures = values.textures
  if (values.record !== undefined) inv.record = values.record
  if (values.replay !== undefined) inv.replay = values.replay
  if (values.format !== undefined) inv.format = values.format
  if (values.out !== undefined) inv.out = values.out
  if (values.views !== undefined) inv.views = values.views.split(',').map((v) => v.trim()) as ViewPreset[]
  else if (values.view !== undefined) inv.views = [values.view as ViewPreset]
  if (positionals[1] !== undefined) inv.file = positionals[1]
  if (values.axis !== undefined) inv.axis = values.axis as SliceAxis
  if (values.index !== undefined) inv.index = Number(values.index)
  if (values.to !== undefined) inv.to = Number(values.to)
  if (values.slice !== undefined) inv.sliceSpec = values.slice
  for (const axis of ['x', 'y', 'z'] as const) {
    const raw = values[axis]
    if (raw !== undefined) inv.ranges[axis] = parseRange(raw, `--${axis}`)
  }

  if (inv.command === 'bench') return cmdBench(inv)
  if (inv.command === 'providers') return cmdProviders(inv)
  if (inv.command === 'export') {
    if (inv.file === undefined) {
      process.stderr.write(`${t('cli.error.exportNeedsFile')}\n`)
      return 2
    }
    return cmdExport(inv)
  }
  if (inv.command === 'import') {
    if (inv.file === undefined) {
      process.stderr.write(`${t('cli.error.importNeedsFile')}\n`)
      return 2
    }
    return cmdImport(inv)
  }

  // build 不需要输入文件：第二个位置参数是需求文本
  if (inv.command === 'build') {
    const goal = positionals.slice(1).join(' ').trim()
    if (goal.length === 0) {
      process.stderr.write(`${t('cli.error.buildNeedsGoal')}\n`)
      return 2
    }
    return cmdBuild(goal, inv)
  }

  if (inv.file === undefined) {
    process.stderr.write(`${t('cli.error.missingProject')}\n`)
    return 2
  }

  const loaded = await loadProject(inv.file)
  switch (inv.command) {
    case 'info':
      return cmdInfo(loaded, inv)
    case 'ops':
      return cmdOps(loaded, inv)
    case 'measure':
      return cmdMeasure(loaded.store, inv)
    case 'slice':
      return cmdSlice(loaded.store, inv)
    case 'replay':
      return cmdReplay(loaded, inv)
    case 'shoot':
      return cmdShoot(loaded, inv)
    default:
      process.stderr.write(`${t('cli.unknownCommand', { name: inv.command })}\n\n${usageText()}`)
      return 2
  }
}

async function loadProject(path: string): Promise<{ project: McaiProject; store: WorldStore }> {
  const bytes = await readFile(path)
  return openProject(new Uint8Array(bytes))
}

function out(text: string): void {
  process.stdout.write(text.endsWith('\n') ? text : `${text}\n`)
}

function cmdInfo({ project, store }: { project: McaiProject; store: WorldStore }, inv: Invocation): number {
  const m = project.manifest
  const stats = store.stats()
  if (inv.json) {
    out(
      JSON.stringify(
        {
          manifest: m,
          settings: project.settings,
          palette: project.palette.strings(),
          world: { blocks: stats.blocks, columns: stats.columns, approximateBytes: stats.approximateBytes },
        },
        null,
        2,
      ),
    )
    return 0
  }
  const v = store.volume
  const rows: Array<[string, string]> = [
    [t('cli.info.formatVersion'), m.formatVersion],
    [t('cli.info.appVersion'), m.appVersion],
    [t('cli.info.minecraft'), m.minecraftVersion],
    [t('cli.info.created'), m.createdAt],
    [t('cli.info.modified'), m.modifiedAt],
    [t('cli.info.revision'), t('cli.info.revisionValue', { revision: m.revision, base: m.baseRevision })],
    [t('cli.info.worldHash'), m.worldHash],
    [t('cli.info.volume'), `(${v.min.x},${v.min.y},${v.min.z}) .. (${v.max.x},${v.max.y},${v.max.z})`],
    [t('cli.info.worldHeight'), `${m.minY} .. ${m.minY + m.worldHeight - 1}  (${m.worldHeight})`],
    [t('cli.info.palette'), t('cli.info.paletteValue', { size: project.palette.size })],
    [t('cli.info.blocks'), String(stats.blocks)],
    [
      t('cli.info.memory'),
      t('cli.info.memoryValue', { kb: (stats.approximateBytes / 1024).toFixed(0), columns: stats.columns }),
    ],
    [
      t('cli.info.counters'),
      t('cli.info.countersValue', {
        ops: m.counters.ops,
        captures: m.counters.captures,
        calls: m.counters.llmCalls,
      }),
    ],
  ]
  const width = Math.max(...rows.map(([k]) => displayWidth(k)))
  out(`${m.name}  (${m.projectId})`)
  for (const [key, value] of rows) {
    out(`  ${key}${' '.repeat(width - displayWidth(key))}  ${value}`)
  }
  return 0
}

function cmdOps({ project }: { project: McaiProject }, inv: Invocation): number {
  const ops = project.log.all()
  if (ops.length === 0) {
    out(t('cli.ops.empty'))
    return 0
  }
  const limit = inv.limit <= 0 ? ops.length : Math.min(inv.limit, ops.length)
  out(t('cli.ops.header'))
  out('─'.repeat(88))
  for (const op of ops.slice(0, limit)) {
    out(
      [
        String(op.rev).padStart(3),
        op.id.padEnd(11),
        op.tool.padEnd(20),
        op.source.padEnd(8),
        String(op.result.changed).padStart(7),
        String(op.result.overwrittenNonAir).padStart(6),
        String(op.result.clipped).padStart(8),
        op.ts,
      ].join(' '),
    )
  }
  if (limit < ops.length) out(t('cli.ops.truncated', { rest: ops.length - limit }))
  return 0
}

function cmdMeasure(store: WorldStore, inv: Invocation): number {
  const result = measure(store)
  if (inv.json) {
    out(JSON.stringify(result, null, 2))
  } else {
    out(formatMeasure(result))
  }
  return 0
}

function cmdSlice(store: WorldStore, inv: Invocation): number {
  if (inv.axis === undefined || inv.index === undefined) {
    process.stderr.write(`${t('cli.error.sliceNeedsAxis')}\n`)
    return 2
  }
  const result = renderSlice(store, {
    axis: inv.axis,
    index: inv.index,
    range: Object.keys(inv.ranges).length > 0 ? inv.ranges : undefined,
  })
  out(result.text)
  return 0
}

function cmdReplay({ project, store }: { project: McaiProject; store: WorldStore }, inv: Invocation): number {
  const session = new ReplaySession(store, project.log)
  const target = inv.to ?? project.log.length
  const reached = session.seek(target)
  out(t('cli.replay.seeked', { rev: reached, total: project.log.length }))
  out('')
  out(formatMeasure(measure(store)))
  if (inv.sliceSpec !== undefined) {
    const spec = parseSliceSpec(inv.sliceSpec)
    out('')
    out(renderSlice(store, { axis: spec.axis, index: spec.index, range: inv.ranges }).text)
  }
  return 0
}

async function cmdShoot(
  { project, store }: { project: McaiProject; store: WorldStore },
  inv: Invocation,
): Promise<number> {
  if (inv.views === undefined || inv.views.length === 0) {
    process.stderr.write(`${t('cli.error.shootNeedsView', { preset: t('cli.usage.meta.preset') })}\n`)
    return 2
  }
  if (inv.to !== undefined) {
    const reached = new ReplaySession(store, project.log).seek(inv.to)
    out(t('cli.shoot.replayed', { rev: reached, total: project.log.length }))
  }
  const bounds = store.contentBounds()
  if (bounds === undefined) {
    process.stderr.write(`${t('cli.error.emptyWorld')}\n`)
    return 1
  }

  // CLI 是开发工具，默认直接用内置那份资源包（`minecraft-assets`，devDependency）；
  // `--plain` 则完全不碰资源，给 CI 与 golden 测试用
  const textures = cliTexturePack(inv, project.manifest.minecraftVersion)
  const resolve = inv.plain
    ? createFallbackColorResolver()
    : createPackColorResolver(project.manifest.minecraftVersion, textures)

  // --highlight-last：高亮最后一个 op 的影响范围，让 LLM 看见"我刚改了什么"
  let highlight: Bounds | undefined
  if (inv.highlightLast) {
    const last = project.log.at(project.log.length - 1)
    highlight = last?.patch.bounds()
    if (highlight === undefined) out(t('cli.shoot.noHighlight'))
  }

  const overlayOptions: OverlayOptions | false = inv.overlays
    ? {
        ruler: true,
        axisGizmo: true,
        volumeBox: store.volume,
        // 5×7 位图字体只有 ASCII：中文项目名先转义，否则会渲染成一排方块
        caption: [
          sanitizeForFont(`${project.manifest.name}  REV ${project.manifest.revision}`),
          `BOUNDS ${formatBounds(bounds)}`,
          `SIZE ${bounds.max.x - bounds.min.x + 1}x${bounds.max.y - bounds.min.y + 1}x${bounds.max.z - bounds.min.z + 1}`,
        ],
        ...(highlight !== undefined ? { highlight } : {}),
      }
    : false

  for (const view of inv.views) {
    const camera = fitCamera(bounds, presetAngles(view), inv.width, inv.height)
    // `--plain` 之外一律走纹理渲染：给模型和人看的图要和游戏里一致
    const result = renderIsometric(store, {
      camera,
      resolve,
      textures,
      ...(inv.plain ? {} : { textured: true }),
      overlays: overlayOptions,
    })
    const png = encodePng(result.canvas)
    const path = outputPath(inv.out, view, inv.views.length > 1)
    await writeFile(path, png)
    out(
      t('cli.shoot.line', {
        view: view.padEnd(8),
        blocks: String(result.blocks).padStart(6),
        faces: String(result.faces).padStart(6),
        scale: camera.scale.toFixed(1).padStart(6),
        kb: (png.length / 1024).toFixed(1),
        path,
      }),
    )
  }
  return 0
}

/**
 * `architect providers` —— 设置页「测试连接」的命令行版本（D-12）。
 *
 * 存在的理由：M4 联调要能**先确认端点和能力**，再往里灌几十轮对话。
 * 一个 401 或者"这个模型不吃图"如果在黄金任务跑到一半才发现，浪费的是钱和时间。
 *
 * 这里**不写任何文件**——发现结果只打印。密钥仍然只在环境变量里。
 */
async function cmdProviders(inv: Invocation): Promise<number> {
  const kind = inv.provider ?? process.env['ARCHITECT_PROVIDER']
  if (kind !== undefined && kind !== 'scripted' && !(kind in PROVIDER_PRESETS)) {
    process.stderr.write(
      `${t('cli.error.unknownProvider', { kind, options: Object.keys(PROVIDER_PRESETS).join(' | ') })}\n`,
    )
    return 2
  }
  const preset: PresetKey = (kind as PresetKey | undefined) ?? presetFromEnv(process.env)
  const settings = settingsFromEnv(process.env, preset)
  const config = activeProvider(settings)!
  if (inv.baseUrl !== undefined) config.baseURL = inv.baseUrl
  if (inv.apiKeyEnv !== undefined) config.apiKeyRef = envKeyRef(inv.apiKeyEnv)
  if (inv.model !== undefined) config.model = inv.model
  // 只有显式给了才设：不发这个字段 = 不限制，服务端思考模式默认 64K
  if (inv.maxOutputTokens !== undefined) config.maxOutputTokens = inv.maxOutputTokens

  const secret = await resolveApiKey(config.apiKeyRef).catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    return undefined
  })
  if (secret === undefined) return 2

  out(t('cli.providers.preset', { preset, url: config.baseURL }))
  out(t('cli.providers.keyRef', { ref: config.apiKeyRef }))
  out('')

  const steps: string[] = []
  const discovery = await discoverProvider(config, {
    apiKey: secret,
    ...(inv.model !== undefined ? { model: inv.model } : {}),
    listOnly: !inv.probe,
    onStep: (step) => {
      switch (step.type) {
        case 'models':
          steps.push(t('cli.providers.models', { n: step.count }))
          for (const model of step.models) steps.push(`    ${model}`)
          break
        case 'model':
          steps.push(
            t('cli.providers.modelChosen', { model: step.model }) +
              (step.matched !== undefined
                ? t('cli.providers.modelMatched', { preference: step.matched })
                : step.guessed
                  ? t('cli.providers.modelGuessed')
                  : ''),
          )
          break
        case 'text':
          steps.push(
            step.ok
              ? t('cli.providers.textOk', { tokens: step.tokensIn ?? 0 })
              : t('cli.providers.textFail', { error: step.error ?? '' }),
          )
          break
        case 'tools':
          steps.push(t('cli.providers.tools', { mode: step.mode }))
          break
        case 'vision':
          steps.push(
            step.vision
              ? step.imageTokenCost !== undefined
                ? t('cli.providers.visionOkCost', { tokens: step.imageTokenCost })
                : t('cli.providers.visionOkNoCost')
              : t('cli.providers.visionFail', { error: truncate(step.error ?? '', 80) }),
          )
          break
        case 'error':
          steps.push(t('cli.providers.warning', { error: truncate(step.error, 120) }))
          break
        default:
          break
      }
    },
  })

  for (const line of steps) out(line)
  out('')
  if (!discovery.ok) {
    out(t('cli.providers.verdictUnavailable', { reason: discovery.error ?? t('cli.providers.unknownReason') }))
    return 1
  }
  const capabilities = discovery.config.capabilities
  const label = {
    model: t('cli.providers.label.model'),
    vision: t('cli.providers.label.vision'),
    tools: t('cli.providers.label.tools'),
    cache: t('cli.providers.label.cache'),
    context: t('cli.providers.label.context'),
    source: t('cli.providers.label.source'),
  }
  // 标签列按最长标签的显示宽度对齐（中英各算各的，CJK 是双宽）
  const labelWidth = Math.max(...Object.values(label).map((text) => displayWidth(text)))
  const summary = (name: string, value: string): string =>
    `  ${name}${' '.repeat(labelWidth - displayWidth(name))}  ${value}`
  const visionValue =
    (capabilities.vision ? t('cli.providers.value.yes') : t('cli.providers.value.no')) +
    (capabilities.imageTokenCost !== undefined
      ? t('cli.providers.value.imageCost', { tokens: capabilities.imageTokenCost })
      : '')
  const cacheValue =
    capabilities.promptCache +
    (capabilities.promptCache === 'auto'
      ? t('cli.providers.value.cacheAuto')
      : capabilities.promptCache === 'none'
        ? t('cli.providers.value.cacheNone')
        : '')
  out(t('cli.providers.verdictAvailable'))
  out(summary(label.model, discovery.config.model))
  out(summary(label.vision, visionValue))
  out(summary(label.tools, capabilities.toolCalling))
  out(summary(label.cache, cacheValue))
  if (capabilities.contextWindow !== undefined) out(summary(label.context, String(capabilities.contextWindow)))
  out(
    summary(
      label.source,
      capabilities.source === 'probe' ? t('cli.providers.value.sourceProbe') : capabilities.source,
    ),
  )
  if (!capabilities.vision) {
    out('')
    out(t('cli.providers.hintVision'))
  }
  return 0
}

async function cmdBuild(goal: string, inv: Invocation): Promise<number> {
  if (inv.out === undefined) {
    process.stderr.write(`${t('cli.error.buildNeedsOut')}\n`)
    return 2
  }

  const [sx, sy, sz] = (inv.size ?? '32,32,32').split(',').map(Number) as [number, number, number]
  if (![sx, sy, sz].every((n) => Number.isFinite(n) && n > 0)) {
    process.stderr.write(`${t('cli.error.invalidSize', { size: inv.size ?? '' })}\n`)
    return 2
  }

  const resolved = await resolveProvider(inv)
  if (typeof resolved === 'string') {
    process.stderr.write(resolved)
    return 2
  }
  const { provider, config, cost } = resolved

  const session = new AgentSession({
    volume: { min: { x: 0, y: 0, z: 0 }, max: { x: sx - 1, y: sy - 1, z: sz - 1 } },
    plain: inv.plain,
    // 截图要纹理：CLI 默认用内置那份资源包，`--textures` 可以换成用户自己的
    textures: inv.plain ? undefined : cliTexturePack(inv, RENDER_VERSION),
  })

  if (!inv.quiet) {
    out(t('cli.build.goal', { goal }))
    out(t('cli.build.model', { id: provider.id, model: provider.model, volume: `${sx}x${sy}x${sz}` }))
    out(
      t('cli.build.capabilities', {
        vision: config.capabilities.vision ? t('cli.common.yes') : t('cli.common.no'),
        tools: config.capabilities.toolCalling,
        cache: config.capabilities.promptCache,
      }),
    )
    for (const note of resolved.notes) out(`  · ${note}`)
    out('')
  }

  const meter = new UsageMeter()
  // 对话记录是 `.mcai` 的一半（需求原话："含编辑记录、方块数据、对话记录"）。
  // 录的是给人看的过程，不是发给模型的原始消息——后者带着 system prompt 与工具 schema，
  // 放进工程文件只会白占体积。
  const recorder = new TranscriptRecorder({
    title: goal.slice(0, 60),
    model: provider.model,
    providerId: config.id,
  })
  recorder.add('user', goal)
  const started = Date.now()
  const state = await runAgent(
    {
      provider,
      registry: session.registry,
      ctx: session.ctx,
      system: session.buildSystem(),
      // volatile 状态走历史里的第一条 user 消息（§9.2），不进 system 前缀
      stateLine: session.buildStateLine(),
      // 上下文策略由 provider 能力决定：有前缀缓存就不裁剪（剪了反而更贵），
      // 没有缓存或窗口很小就切到滑动窗口（§9.2）
      capabilities: config.capabilities,
      ...(inv.maxTurns !== undefined ? { maxTurns: inv.maxTurns } : {}),
      // 用户在命令行给了美元上限就必须把预算**传进去**。
      // 不要在这里判"有没有价格表"——没有价格表时 `checkBudget` 会判为越界并说明原因；
      // 在这里悄悄丢掉，用户就会以为自己的上限生效了，那是最坏的失败模式。
      ...(inv.maxUsd !== undefined
        ? { budget: { maxUsd: inv.maxUsd }, ...(cost !== undefined ? { costTable: cost } : {}) }
        : {}),
      onEvent: (event) => {
        // 记账、录制与打印合在同一条事件流上——事件只发一次，漏接就会让表盘骗人
        recorder.onEvent(event)
        if (event.type === 'images') meter.screenshot()
        else if (event.type === 'tool_call') meter.toolCall()
        else if (event.type === 'turn') meter.turn()
        if (inv.quiet) return
        switch (event.type) {
          case 'turn':
            // 每一轮都打一行：第一轮可能要跑两分钟（思考模型在规划），
            // 中间什么都不打印的话，用户会以为程序挂了
            out(t('cli.build.turn', { turn: event.turn }))
            break
          case 'context':
            out(t('cli.build.context', { turns: event.droppedTurns, images: event.droppedImages, reason: event.reason }))
            break
          case 'assistant':
            out(t('cli.build.assistant', { text: truncate(event.text, 200) }))
            break
          case 'tool_call':
            out(`  → ${event.name} ${truncate(JSON.stringify(event.args ?? {}), 140)}`)
            break
          case 'tool_result':
            out(`  ← ${event.result.ok ? '' : '✗ '}${truncate(event.result.summary.split('\n')[0] ?? '', 140)}`)
            break
          case 'images':
            out(t('cli.build.images', { n: event.count, kb: (event.bytes / 1024).toFixed(0) }))
            break
          case 'retry':
            out(t('cli.build.retry', { attempt: event.attempt, reason: truncate(event.reason, 100) }))
            break
          case 'budget':
            out(t('cli.build.budget', { detail: event.detail }))
            break
          case 'truncated':
            out(t('cli.build.truncated', { out: event.out }))
            break
          default:
            break
        }
      },
    },
    goal,
  )

  // 用量在循环结束时才拿得到，回填到最后一条 assistant 消息上
  recorder.attachUsage(state.usage, provider.model)
  const recording = recorder.recording

  const bytes = packProject({
    name: goal.slice(0, 40),
    projectId: `01${Date.now().toString(36).toUpperCase()}`,
    store: session.store,
    log: session.log,
    settings: { volume: session.store.volume, ...(inv.provider !== undefined ? { providerId: inv.provider } : {}) },
    chat: recording.transcript,
    captures: recording.captures,
  })
  await writeFile(inv.out, bytes)

  const stats = measure(session.store)
  out('')
  out(
    t('cli.build.stopReason', { reason: state.stopReason }) +
      (state.error !== undefined ? t('cli.build.stopReasonError', { error: state.error }) : ''),
  )
  out(t('cli.build.turns', { turns: state.turn, toolCalls: state.toolCalls, screenshots: session.screenshots }))
  out(
    t('cost.tokens', { in: state.usage.in, out: state.usage.out }) +
      (state.usage.cachedIn > 0 ? t('cli.build.cached', { cached: state.usage.cachedIn }) : ''),
  )
  out(t('cli.build.elapsed', { seconds: ((Date.now() - started) / 1000).toFixed(1) }))
  out(usageLine(state.usage, cost))
  out(t('cli.build.stats', { blocks: stats.blocks, ops: session.log.length, revision: session.store.revision }))
  out(
    t('cli.build.transcript', {
      messages: recording.transcript.messages.length,
      captures: recording.captures.refs.length,
    }),
  )
  out(t('cli.build.written', { path: inv.out, kb: (bytes.length / 1024).toFixed(1) }))
  if (state.finalText.length > 0) {
    out('')
    out(state.finalText)
  }
  return state.stopReason === 'completed' ? 0 : 1
}

/**
 * `architect export` —— 把工程导出成游戏/三维软件能读的格式（M7）。
 *
 * 导出的是**回放到指定版本的快照**，所以 `--to` 可以导出任意历史版本——
 * "把第 40 版那个屋顶方案单独导出来看看"这种需求不用重新跑一遍 agent。
 */
async function cmdExport(inv: Invocation): Promise<number> {
  if (inv.out === undefined) {
    process.stderr.write(`${t('cli.error.exportNeedsOut')}\n`)
    return 2
  }
  const format = (inv.format ?? inferFormat(inv.out)).toLowerCase()
  const loaded = await loadProject(inv.file!)
  const { project, store } = loaded

  if (inv.to !== undefined) {
    if (inv.to < 0 || inv.to > project.manifest.revision) {
      process.stderr.write(`${t('cli.error.toOutOfRange', { max: project.manifest.revision })}\n`)
      return 2
    }
    const replay = new ReplaySession(store, project.log)
    replay.seek(inv.to)
  }

  const bounds = store.contentBounds()
  if (bounds === undefined) {
    process.stderr.write(`${t('cli.error.emptyWorldExport')}\n`)
    return 2
  }
  const size = {
    x: bounds.max.x - bounds.min.x + 1,
    y: bounds.max.y - bounds.min.y + 1,
    z: bounds.max.z - bounds.min.z + 1,
  }
  const metadata = { Name: project.manifest.name, Author: 'ArchItect' }

  if (format === 'schem' || format === 'schematic') {
    const result = exportSchematic(store, { dataVersion: DATA_VERSION_1_21_4, metadata })
    await writeFile(inv.out, result.bytes)
    out(t('cli.export.schem'))
    out(
      t('cli.export.schemLine', {
        size: result.size.join('x'),
        blocks: result.blocks,
        dataVersion: result.dataVersion,
      }),
    )
    out(t('cli.export.outLine', { path: inv.out, kb: (result.bytes.length / 1024).toFixed(1) }))
    out(t('cli.export.worldEdit', { name: basename(inv.out) }))
    return 0
  }

  if (format === 'litematic') {
    const bytes = exportLitematic(store, { name: project.manifest.name, author: 'ArchItect' })
    await writeFile(inv.out, bytes)
    out(t('cli.export.litematic'))
    out(
      t('cli.export.litematicLine', {
        size: `${size.x}x${size.y}x${size.z}`,
        path: inv.out,
        kb: (bytes.length / 1024).toFixed(1),
      }),
    )
    out(t('cli.export.litematicNote'))
    return 0
  }

  if (format === 'obj') {
    const resolve = inv.plain
      ? createFallbackColorResolver()
      : createPackColorResolver(project.manifest.minecraftVersion, cliTexturePack(inv, project.manifest.minecraftVersion))
    // `mtllib` 里的名字必须与实际文件名一致，否则 OBJ 能打开但全是灰的
    const mtlPath = inv.out.replace(/\.obj$/i, '.mtl')
    const result = exportObj(store, {
      mtlName: basename(mtlPath),
      colorOf: (state) => {
        const rgb = resolve(state)
        return rgb === undefined ? undefined : { r: rgb.r, g: rgb.g, b: rgb.b }
      },
    })
    await writeFile(inv.out, result.obj)
    if (result.mtl !== undefined) {
      await writeFile(mtlPath, result.mtl)
      out(t('cli.export.mtlWritten', { name: basename(mtlPath), materials: result.materials.length }))
    }
    out(t('cli.export.obj'))
    out(
      t('cli.export.objLine', {
        size: `${size.x}x${size.y}x${size.z}`,
        blocks: result.blocks,
        faces: result.faces,
        vertices: result.vertices,
      }),
    )
    out(t('cli.export.outLine', { path: inv.out, kb: (result.obj.length / 1024).toFixed(1) }))
    out(t('cli.export.objAxes'))
    return 0
  }

  process.stderr.write(`${t('cli.error.unknownFormat', { format })}\n`)
  return 2
}

const basename = (path: string): string => path.split('/').pop() ?? path

function inferFormat(path: string): string {
  const lower = path.toLowerCase()
  if (lower.endsWith('.litematic')) return 'litematic'
  if (lower.endsWith('.obj')) return 'obj'
  return 'schem'
}

/**
 * `architect import` —— 把外部 schematic 变成可继续编辑的 `.mcai`（M7）。
 *
 * 认不出来的方块**会列出来并给候选**，而不是静默填空气：一份"看起来导进去了、
 * 其实少了半面墙"的工程比一个明确的报错难查得多。
 */
async function cmdImport(inv: Invocation): Promise<number> {
  const bytes = new Uint8Array(await readFile(inv.file!))
  const isLitematic = inv.file!.toLowerCase().endsWith('.litematic')

  let data
  if (isLitematic) {
    data = litematicToSchematicData(await readLitematic(bytes))
  } else {
    data = await readSpongeSchematic(bytes)
  }

  // 工区：默认刚好装下导入的内容，也可以 --size 指定更大的（方便继续扩建）
  let volume: Bounds
  if (inv.size !== undefined) {
    const [sx, sy, sz] = inv.size.split(',').map(Number) as [number, number, number]
    if (![sx, sy, sz].every((n) => Number.isFinite(n) && n > 0)) {
      process.stderr.write(`${t('cli.error.invalidSizeImport', { size: inv.size })}\n`)
      return 2
    }
    volume = { min: { x: 0, y: 0, z: 0 }, max: { x: sx - 1, y: sy - 1, z: sz - 1 } }
  } else {
    volume = {
      min: { x: 0, y: 0, z: 0 },
      max: { x: Math.max(0, data.size[0] - 1), y: Math.max(0, data.size[1] - 1), z: Math.max(0, data.size[2] - 1) },
    }
  }

  const session = new AgentSession({ volume, plain: inv.plain })
  const result = importSchematicInto(session.store, data, { at: { x: 0, y: 0, z: 0 } })

  out(t('cli.import.header', { name: basename(inv.file!) }))
  out(
    t('cli.import.source', { size: data.size.join('x') }) +
      (data.dataVersion !== undefined ? `   DataVersion ${data.dataVersion}` : ''),
  )
  out(t('cli.import.volume', { volume: `${volume.max.x + 1}x${volume.max.y + 1}x${volume.max.z + 1}` }))
  out(t('cli.import.placed', { placed: result.placed, revision: result.revision }))

  if (result.renamed.length > 0) {
    out(`\n${t('cli.import.renamedHeader', { n: result.renamed.length })}`)
    for (const entry of result.renamed.slice(0, 12)) out(`  ${entry.from} → ${entry.to}   ×${entry.count}`)
    if (result.renamed.length > 12) out(t('cli.import.more', { n: result.renamed.length - 12 }))
  }

  if (result.unknown.length > 0) {
    out(`\n${t('cli.import.unknownHeader', { n: result.unknown.length, cells: result.skipped })}`)
    for (const entry of result.unknown.slice(0, 12)) {
      out(
        `  ${entry.name}  ×${entry.count}` +
          (entry.suggestions.length > 0
            ? t('cli.import.suggestion', { suggestions: entry.suggestions.join(', ') })
            : ''),
      )
    }
    if (result.unknown.length > 12) out(t('cli.import.more', { n: result.unknown.length - 12 }))
    out(t('cli.import.unknownNote'))
  }

  if (inv.out !== undefined) {
    const projectBytes = packProject({
      name: basename(inv.file!).replace(/\.(schem|litematic|schematic)$/i, ''),
      projectId: `01IMP${Date.now().toString(36).toUpperCase()}`,
      store: session.store,
      log: session.log,
      settings: { volume: session.store.volume },
    })
    await writeFile(inv.out, projectBytes)
    out(`\n${t('cli.import.written', { path: inv.out, kb: (projectBytes.length / 1024).toFixed(1) })}`)
  }
  return 0
}

interface BenchRow {
  task: GoldenTask
  evaluation: TaskEvaluation
  turns: number
  toolCalls: number
  screenshots: number
  tokensIn: number
  tokensOut: number
  cachedIn: number
  ms: number
  stopReason: string
  error?: string
}

async function cmdBench(inv: Invocation): Promise<number> {
  const tasks =
    inv.tasks === undefined
      ? [...GOLDEN_TASKS]
      : inv.tasks.split(',').map((id) => {
          const task = findTask(id.trim())
          if (task === undefined) throw new Error(t('cli.error.benchUnknownTask', { id }))
          return task
        })

  // --replay：从录音回放，完全不联网
  let replayPool: RecordedExchange[] | undefined
  if (inv.replay !== undefined) {
    replayPool = exchangesFromJsonl(await readTextFile(inv.replay, 'utf8'))
    out(t('cli.bench.replay', { path: inv.replay, turns: replayPool.length }))
  } else {
    const resolved = await resolveProvider(inv)
    if (typeof resolved === 'string') {
      process.stderr.write(resolved)
      return 2
    }
    out(t('cli.bench.model', { id: resolved.provider.id, model: resolved.provider.model }))
    out(
      t('cli.bench.capabilities', {
        vision: resolved.config.capabilities.vision ? t('cli.common.yes') : t('cli.common.no'),
        tools: resolved.config.capabilities.toolCalling,
      }) +
        (resolved.config.capabilities.imageTokenCost !== undefined
          ? t('cli.bench.imageCost', { tokens: resolved.config.capabilities.imageTokenCost })
          : ''),
    )
    for (const note of resolved.notes) out(`  · ${note}`)
  }

  if (inv.outDir !== undefined) await mkdir(inv.outDir, { recursive: true })
  if (!inv.quiet) out('')

  const rows: BenchRow[] = []
  const recorded: RecordedExchange[] = []
  let replayCursor = 0

  for (const task of tasks) {
    const session = new AgentSession({
      volume: task.volume,
      plain: inv.plain,
      textures: inv.plain ? undefined : cliTexturePack(inv, RENDER_VERSION),
    })
    let provider: LlmProvider

    if (replayPool !== undefined) {
      // 每个任务从录音里切出属于它的那一段（按轮数推进）
      let end = replayCursor
      let consumeUntil = replayCursor
      while (consumeUntil < replayPool.length) {
        const exchange = replayPool[consumeUntil]!
        consumeUntil++
        // 一次任务的结束标志：录音里出现一条"没有工具调用"的响应
        if (exchange.response.toolCalls.length === 0) break
      }
      end = consumeUntil
      provider = new ReplayProvider(replayPool.slice(replayCursor, end))
      replayCursor = end
    } else {
      const inner = await resolveProvider({ ...inv, quiet: true })
      if (typeof inner === 'string') {
        process.stderr.write(inner)
        return 2
      }
      provider = inv.record !== undefined
        ? new RecordingProvider(inner.provider, (exchange) => {
            recorded.push(exchange)
          })
        : inner.provider
    }

    const started = Date.now()
    const state = await runAgent(
      {
        provider,
        registry: session.registry,
        ctx: session.ctx,
        system: session.buildSystem(),
        stateLine: session.buildStateLine(),
        ...(inv.maxTurns !== undefined ? { maxTurns: inv.maxTurns } : {}),
        onEvent: inv.quiet
          ? undefined
          : (event: AgentEvent) => {
              if (event.type === 'tool_call') process.stdout.write(`    → ${event.name}\n`)
              if (event.type === 'nudge') process.stdout.write(`${t('cli.bench.nudge')}\n`)
            },
      },
      task.goal,
    )

    const evaluation = evaluateTask(task, session.store, session.log.length)
    const row: BenchRow = {
      task,
      evaluation,
      turns: state.turn,
      toolCalls: state.toolCalls,
      screenshots: session.screenshots,
      tokensIn: state.usage.in,
      tokensOut: state.usage.out,
      cachedIn: state.usage.cachedIn,
      ms: Date.now() - started,
      stopReason: state.stopReason,
    }
    if (state.error !== undefined) row.error = state.error
    rows.push(row)

    if (inv.outDir !== undefined) {
      const base = join(inv.outDir, task.id)
      await writeFile(
        `${base}.mcai`,
        packProject({
          name: task.name,
          projectId: `01BENCH${task.id.toUpperCase()}`,
          store: session.store,
          log: session.log,
          settings: { volume: session.store.volume },
        }),
      )
      if (session.store.contentBounds() !== undefined) {
        const shot = await session.ctx.shoot({ view: 'iso_ne', width: 512, height: 384 })
        await writeFile(`${base}.png`, shot.png)
      }
    }

    process.stdout.write(
      `${t('cli.bench.row', {
        name: padTo(task.name, 8),
        passed: evaluation.passed,
        total: evaluation.total,
        stopReason: row.stopReason.padEnd(11),
        turns: String(row.turns).padStart(2),
        toolCalls: String(row.toolCalls).padStart(3),
        blocks: String(row.evaluation.stats.blocks).padStart(5),
      })}\n`,
    )
    for (const result of evaluation.results) {
      if (!result.pass) {
        process.stdout.write(`      ✗ ${result.label}${result.detail !== undefined ? ` → ${result.detail}` : ''}\n`)
      }
    }
  }

  if (inv.record !== undefined && recorded.length > 0) {
    await writeFile(inv.record, exchangesToJsonl(recorded))
    out(`\n${t('cli.bench.recorded', { turns: recorded.length, path: inv.record })}`)
  }

  // 汇总表
  out('')
  out(t('cli.bench.summaryHeader'))
  out('─'.repeat(72))
  let achieved = 0
  let totalIn = 0
  let totalOut = 0
  let totalCached = 0
  for (const row of rows) {
    if (row.evaluation.achieved) achieved++
    totalIn += row.tokensIn
    totalOut += row.tokensOut
    totalCached += row.cachedIn
    out(
      [
        padTo(row.task.name, 10),
        `${row.evaluation.passed}/${row.evaluation.total}`.padEnd(8),
        String(row.turns).padStart(4),
        String(row.toolCalls).padStart(5),
        String(row.screenshots).padStart(5),
        String(row.tokensIn).padStart(9),
        String(row.tokensOut).padStart(8),
        String(row.cachedIn).padStart(7),
        `${(row.ms / 1000).toFixed(1)}s`.padStart(7),
      ].join(' '),
    )
  }
  out('─'.repeat(72))
  out(
    t('cli.bench.total', { achieved, total: rows.length, in: totalIn, out: totalOut }) +
      (totalCached > 0
        ? t('cli.common.cachedShare', {
            cached: totalCached,
            percent: ((totalCached / Math.max(1, totalIn)) * 100).toFixed(0),
          })
        : ''),
  )
  if (rows.some((r) => r.error !== undefined)) {
    out('')
    for (const row of rows.filter((r) => r.error !== undefined)) out(`  ${row.task.name}: ${row.error}`)
  }
  return achieved === rows.length ? 0 : 1
}

const SCRIPTED_PROVIDER: LlmProvider = {
  id: 'scripted',
  model: 'scripted',
  supportsImages: false,
  chat: async () => ({
    text: t('cli.providers.scriptedNote'),
    toolCalls: [],
    usage: { in: 0, out: 0 },
    finishReason: 'stop',
  }),
}

interface ResolvedProvider {
  provider: LlmProvider
  config: ProviderConfig
  cost?: CostTable
  /** 探针/发现过程里的说明，供打印。 */
  notes: string[]
}

/**
 * 把命令行参数解析成一个可用的 provider（plan §9.5）。
 *
 * **密钥只从环境变量读**（D-13）：不落文件、不进 `.mcai`、不进日志。
 * 模型与能力尽量靠运行时发现（D-12）——所以这里会真的打三个小请求，
 * 用 `--no-probe` 可以跳过。
 */
async function resolveProvider(inv: Invocation): Promise<ResolvedProvider | string> {
  const kind = inv.provider ?? process.env['ARCHITECT_PROVIDER']
  if (kind === 'scripted') {
    const preset = PROVIDER_PRESETS.deepseek
    return {
      provider: SCRIPTED_PROVIDER,
      // scripted 不是供应商，只是离线测试用的假 provider；这里给一份最小合法配置
      config: {
        id: 'scripted',
        preset: 'custom',
        kind: 'openai-compatible',
        baseURL: preset.baseURL,
        apiKeyRef: '',
        model: 'scripted',
        capabilities: { vision: false, toolCalling: 'prompted', promptCache: 'none', source: 'preset' },
      },
      notes: [],
    }
  }
  if (kind !== undefined && !(kind in PROVIDER_PRESETS)) {
    return `${t('cli.error.unknownProvider', {
      kind,
      options: `${Object.keys(PROVIDER_PRESETS).join(' | ')} | scripted`,
    })}\n`
  }

  const preset: PresetKey = (kind as PresetKey | undefined) ?? presetFromEnv(process.env)
  const settings = settingsFromEnv(process.env, preset)
  const config = activeProvider(settings)!
  if (inv.baseUrl !== undefined) config.baseURL = inv.baseUrl
  if (inv.apiKeyEnv !== undefined) config.apiKeyRef = envKeyRef(inv.apiKeyEnv)
  if (inv.model !== undefined) config.model = inv.model
  // 只有显式给了才设：不发这个字段 = 不限制，服务端思考模式默认 64K
  if (inv.maxOutputTokens !== undefined) config.maxOutputTokens = inv.maxOutputTokens

  const blocking = validateProviderConfig(config).filter(
    (problem) => problem.field === 'baseURL' || problem.field === 'apiKeyRef',
  )
  if (blocking.length > 0) {
    return `${blocking.map((p) => p.message).join('\n')}\n`
  }

  let apiKey: string | undefined
  try {
    apiKey = await resolveApiKey(config.apiKeyRef)
  } catch (error) {
    return `${error instanceof Error ? error.message : String(error)}\n`
  }

  const notes: string[] = []
  if (inv.probe) {
    // 发现过程**不打印进度**：CLI 的输出要留给结果，说明放进 notes
    const discovery = await discoverProvider(config, {
      ...(apiKey !== undefined ? { apiKey } : {}),
      ...(inv.model !== undefined ? { model: inv.model } : {}),
    })
    Object.assign(config, discovery.config)
    for (const step of discovery.steps) {
      switch (step.type) {
        case 'models':
          notes.push(t('cli.providers.noteModels', { n: step.count }))
          break
        case 'model':
          notes.push(
            t('cli.providers.noteModelChosen', { model: step.model }) +
              (step.matched !== undefined
                ? t('cli.providers.modelMatched', { preference: step.matched })
                : step.guessed
                  ? t('cli.providers.noteModelGuessed')
                  : ''),
          )
          break
        case 'vision':
          notes.push(
            step.vision
              ? step.imageTokenCost !== undefined
                ? t('cli.providers.noteVisionOkCost', { tokens: step.imageTokenCost })
                : t('cli.providers.noteVisionOkNoCost')
              : t('cli.providers.noteVisionFail', { error: truncate(step.error ?? '', 60) }),
          )
          break
        case 'tools':
          notes.push(t('cli.providers.tools', { mode: step.mode }))
          break
        case 'error':
          notes.push(t('cli.providers.noteProblem', { error: truncate(step.error, 100) }))
          break
        default:
          break
      }
    }
    if (!discovery.ok && discovery.error !== undefined) {
      return `${t('cli.providers.noteProbeFailed', { error: discovery.error })}\n`
    }
  }

  return {
    provider: createProvider(config, { ...(apiKey !== undefined ? { apiKey } : {}) }),
    config,
    ...(config.cost !== undefined ? { cost: config.cost } : {}),
    notes,
  }
}

/**
 * 收尾的用量行。**有价格表才算钱**——报一个没量过的数字比不报更糟（plan §9.2 的口径）。
 */
function usageLine(usage: { in: number; out: number; cachedIn?: number }, cost?: CostTable): string {
  const cached = usage.cachedIn ?? 0
  const share =
    usage.in > 0
      ? t('cli.common.cachedShare', { cached, percent: ((cached / usage.in) * 100).toFixed(0) })
      : ''
  const usd = costOf({ in: usage.in, out: usage.out, cachedIn: cached }, cost)
  return (
    t('cost.tokens', { in: usage.in, out: usage.out }) +
    (cached > 0 ? share : '') +
    (usd !== undefined ? t('cli.build.cost', { amount: usd.toFixed(4) }) : '')
  )
}

function truncate(text: string, limit: number): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length <= limit ? flat : `${flat.slice(0, limit)}…`
}

function formatBounds(b: Bounds): string {
  return `${b.min.x},${b.min.y},${b.min.z} .. ${b.max.x},${b.max.y},${b.max.z}`
}

/**
 * CLI 用哪个纹理来源。
 *
 * - `--textures <path>`：用户指定的资源包目录 / zip / 客户端 jar；
 * - 默认：内置的 `minecraft-assets`（devDependency——CLI 本来就是开发工具，
 *   发布产物才需要"不内置素材"那条约束）。
 */
function cliTexturePack(inv: { textures?: string }, version: string): TexturePack {
  if (inv.textures !== undefined) {
    const pack = texturePackAt(inv.textures)
    if (pack === undefined) throw new Error(`--textures 指向的路径里没有方块纹理：${inv.textures}`)
    return pack
  }
  return assetsTexturePack(version)
}

function outputPath(base: string | undefined, view: ViewPreset, multiple: boolean): string {
  if (base === undefined) return `./${view}.png`
  if (!multiple) return base
  return base.replace(/\.png$/i, '') + `-${view}.png`
}

function parseRange(raw: string, flag: string): [number, number] {
  const match = /^(-?\d+)\.\.(-?\d+)$/.exec(raw.trim())
  if (match === null) throw new Error(t('cli.error.invalidRange', { flag, raw }))
  return [Number(match[1]), Number(match[2])]
}

function parseSliceSpec(raw: string): { axis: SliceAxis; index: number } {
  const match = /^(x|y|z):(-?\d+)$/.exec(raw.trim())
  if (match === null) throw new Error(t('cli.error.invalidSlice', { raw }))
  return { axis: match[1] as SliceAxis, index: Number(match[2]) }
}

/**
 * 按**显示宽度**补空格。
 *
 * `String.prototype.padEnd` 数的是 UTF-16 码元个数，而中文/日文/韩文字符在终端里
 * 占**两个列宽**。所以 `'小屋'.padEnd(8)` 只补 6 个空格，实际宽度是 10——表格会错位。
 * 凡是把可能含 CJK 的文本放进对齐的地方，都要走这个函数。
 */
function padTo(text: string, width: number): string {
  return text + ' '.repeat(Math.max(0, width - displayWidth(text)))
}

/** 中日韩字符占两个终端列宽，对齐时要按显示宽度算。 */
function displayWidth(text: string): number {
  let width = 0
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0
    width += code >= 0x1100 && code <= 0xffe6 ? 2 : 1
  }
  return width
}

main(process.argv.slice(2))
  .then((code) => {
    process.exitCode = code
  })
  .catch((error: unknown) => {
    process.stderr.write(`${t('cli.error.fatal', { message: error instanceof Error ? error.message : String(error) })}\n`)
    process.exitCode = 1
  })
