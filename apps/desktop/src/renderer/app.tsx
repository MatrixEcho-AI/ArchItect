import { useCallback, useEffect, useRef, useState } from 'react'
import { Flex, Layout } from 'antd'
import { setLocale as setI18nLocale, t } from '@architect/i18n'

import { ChatPanel } from './components/chat-panel.js'
import { LeftPanel } from './components/left-panel.js'
import { SettingsModal } from './components/settings-modal.js'
import { Toolbar } from './components/toolbar.js'
import { Viewport } from './components/viewport.js'
import { ViewportShell } from './viewport-shell.js'
import { costText, shortBlock } from './cost.js'
import {
  simulateCameraPanel,
  simulateDrag,
  simulateNewProject,
  simulatePaint,
} from './simulate.js'
import { debugFlags, useStudio } from './use-studio.js'
import type { CameraFields } from './components/left-panel.js'
import type { SettingsView, StudioState } from './types.js'
import type { Locale, MessageKey } from '@architect/i18n'

/**
 * 界面骨架与**全部动作**。
 *
 * 这个文件是旧 `main.ts` 里"接线"那 200 行的替代品。旧版是"取元素 → addEventListener"，
 * 新版是"把动作当值传给组件"——区别不在写法好不好看，而在**一件事只有一个地方会发生**：
 * 想知道"点导出会怎样"只需要读这里。
 *
 * 分工是死的，三条边界都要守住：
 *
 * | 东西 | 住在哪 | 为什么 |
 * |---|---|---|
 * | 世界 / 对话 / 设置三份视图 | `useStudio`（React state） | 只由主进程推送驱动 |
 * | 视口与相机 | `ViewportShell`（React 之外） | WebGL 上下文只能建一次；拖动不能触发重渲染 |
 * | "点了会发生什么" | 这个文件 | 动作当值传给组件，不散在 `onClick` 里 |
 */

const DEFAULT_FIELDS: CameraFields = {
  azimuth: '45',
  elevation: '35',
  roll: '0',
  fov: '70',
  eye: ['0', '0', '0'],
  lookAt: ['0', '0', '0'],
}

export interface AppProps {
  /**
   * 语言变了往上报告。
   *
   * antd 有它**自己**的一套文案（确认/取消、空状态、分页…），只有 `ConfigProvider`
   * 能换掉它。所以语言状态必须住在 `ConfigProvider` 的上一层（`main.tsx` 的 `Root`），
   * 这里只负责上报——`@architect/i18n` 那一半由 `t()` 自己读了。
   */
  onLocaleChange: (locale: Locale) => void
}

export function App({ onLocaleChange }: AppProps): React.JSX.Element {
  /**
   * 当前机位预设名。**没有 UI 拥有它了**（顶栏那个下拉已按用户要求移除），
   * 但它还得留着：双击视口与机位面板的「复位」都要知道"回到哪个预设"，
   * 而 `setUi({view})` 也还在往设置里存。
   *
   * 用 `useRef` 而不是 `useState`：它不再影响任何渲染输出（`free` 与 `iso_ne`
   * 画出来一模一样），放进 state 只会让每次拖动多一次无谓的重渲染。
   */
  const viewRef = useRef('iso_ne')
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [editingProvider, setEditingProvider] = useState<string | undefined>(undefined)
  const [opDetailRev, setOpDetailRev] = useState<number | undefined>(undefined)
  const [opDetail, setOpDetail] = useState<Awaited<ReturnType<typeof window.architect.opDetail>>>()
  /** 外壳建好之后由 effect 推一版，让依赖它的 UI 重算。 */
  const [shellReady, setShellReady] = useState(false)
  /** 相机版本号：外壳每次"相机动了"就 +1，驱动机位字段与状态行重算。 */
  const [camTick, setCamTick] = useState(0)
  const [camMode, setCamMode] = useState<'angle' | 'eye'>('angle')
  const [camShared, setCamShared] = useState(false)
  const [cameraFields, setCameraFields] = useState<CameraFields>(DEFAULT_FIELDS)
  const [status, setStatus] = useState('')
  const [editMode, setEditMode] = useState(false)
  const [blockQuery, setBlockQuery] = useState('')
  const [blockMatches, setBlockMatches] = useState<string[]>([])
  const [currentBlock, setCurrentBlock] = useState('')

  const shellRef = useRef<ViewportShell | undefined>(undefined)
  /** 时间线滑杆。非受控，所以游标变了要**程序化**把它挪过去（见下面那个 effect）。 */
  const scrubRef = useRef<HTMLInputElement>(null)
  const studioRef = useRef<ReturnType<typeof useStudio> | undefined>(undefined)
  /** 事件处理器要读最新的方块选择，但它不该因为方块变了就重装监听。 */
  const blockRef = useRef('')
  blockRef.current = currentBlock

  const onCameraChanged = useCallback(() => setCamTick((tick) => tick + 1), [])

  const studio = useStudio((next) => {
    studioRef.current?.setState(next)
    void shellRef.current?.shoot()
  })
  studioRef.current = studio

  // ── 首次加载：设置 → 世界 → 对话 → 建外壳 ────────────────────────────────
  const booted = useRef(false)
  useEffect(() => {
    if (booted.current) return
    booted.current = true
    void (async () => {
      try {
        const initial = await window.architect.settings()
        studioRef.current?.setSettings(initial)
        if (initial.ui.view !== undefined && initial.ui.view.length > 0) viewRef.current = initial.ui.view
        studioRef.current?.setState(await window.architect.state())
        studioRef.current?.setChat(await window.architect.chat())
        studioRef.current?.setStatusText(t('app.ready'))
      } catch (error) {
        studioRef.current?.reportReady({
          ok: false,
          detail: error instanceof Error ? error.message : String(error),
        })
      }
    })()
  }, [])

  /**
   * 建外壳。**在第一份世界状态到手之后**才建。
   *
   * 时机不是随便挑的，有两个约束夹着它：
   *   - 它要 `document.getElementById('canvas')` —— 所以必须在 React 把画布提交到
   *     DOM 之后（放在 boot 的异步链里就会拿到 `null`）；
   *   - 它要能立刻画出一帧 —— 所以必须在世界状态到手之后（不然第一帧是空的，
   *     而 `--shot` 恰恰是"渲染进程就绪"那一刻来要图的）。
   *
   * 两个条件合起来正好是"首份状态 + 一次提交"，也就是这个 effect。
   */
  useEffect(() => {
    if (studio.state === undefined || shellRef.current !== undefined) return
    const canvas = document.getElementById('canvas') as HTMLCanvasElement | null
    const overlay = document.getElementById('overlay') as HTMLCanvasElement | null
    if (canvas === null || overlay === null) return
    shellRef.current = new ViewportShell({
      canvas,
      overlay,
      debugFlags: debugFlags(),
      onCameraChanged,
      onState: (next) => {
        studioRef.current?.setState(next)
        studioRef.current?.setStatusText(t('app.ready'))
      },
      onStatus: (key) => setStatus(t(key)),
    })
    setShellReady(true)
  }, [studio.state, onCameraChanged])

  const shell = shellRef.current

  // 外壳建好之后：软件视口要说实话、挂离屏截图钩子、拉预设、跑诊断、回报 ready
  const announced = useRef(false)
  useEffect(() => {
    if (!shellReady || shell === undefined || announced.current) return
    announced.current = true
    void (async () => {
      const flags = debugFlags()
      // 软件视口是**降级**，不是常态：必须说出来，否则用户只会觉得"这软件怎么这么卡"
      if (shell.software) studioRef.current?.setNotice(t('viewport.softwareMode'))

      /**
       * **离屏截图钩子必须在 `ready` 之前挂上。**
       *
       * 主进程从收到 `ready` 那一刻就可能来要图；挂晚了会白丢一枪——那一枪会退回
       * 软件光栅器，图糊一点但不会错，所以这里只是"别浪费"。
       */
      window.__architectCaptureShot = (request) => shell.capture(request)

      /**
       * **只给诊断用**的场景探针：画布上还剩多少三角形。
       *
       * 与 `__architectCaptureShot` 同样的理由挂在 `window` 上：方向是主 → 渲染，
       * 而 `ipcRenderer.invoke` 只能渲染 → 主。`SceneViewport` 的真实状态在 DOM 上
       * 看不见，"新建之后画布清空了没有"只能靠这个数字断言。
       */
      window.__architectDebugScene = () => shell.debugScene()

      // 预设角度必须在第一帧之前拿到，否则首帧用的是写死的默认角度
      await shell.loadPresets()
      await shell.shoot()

      /**
       * **让出一帧再报 `ready`。**
       *
       * 主进程收到 `ready` 就会来要截图（`--shot`），而"画布已经量过尺寸"这件事
       * 由另一个 effect 负责。不让这一帧的话，`--shot` 可能在画布还是默认
       * 300×150（HTML canvas 的默认尺寸）的时候拍到一张小图。
       */
      await new Promise((resolve) => requestAnimationFrame(resolve))
      await shell.shoot()

      if (flags.has('drag-test')) simulateDrag()
      if (flags.has('camera-test')) await simulateCameraPanel(shell)
      if (flags.has('undo-test')) {
        await afterState(await window.architect.undo())
        await afterState(await window.architect.undo())
      }
      if (flags.has('paint-test')) await simulatePaint()
      if (flags.has('new-test')) await simulateNewProject()
      if (flags.has('settings')) setSettingsOpen(true)

      const canvas = document.getElementById('canvas') as HTMLCanvasElement | null
      studioRef.current?.reportReady({
        ok: true,
        detail: shell.software
          ? '软件视口（没有 WebGL）'
          : `canvas ${canvas?.width ?? 0}x${canvas?.height ?? 0}`,
      })
    })()
    // 只在"外壳第一次可用"时跑一次；其余依赖都是 ref 或只读的
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shellReady])

  // ── i18n：应用是唯一真相，antd 的 locale 由 `main.tsx` 跟着这个 state 走 ────
  useEffect(() => {
    const next = studio.settings?.locale
    if (next === undefined) return
    setI18nLocale(next)
    onLocaleChange(next)
  }, [studio.settings?.locale, onLocaleChange])

  // ── 世界变了 → 交给外壳（换工程时它会重置相机取景） ─────────────────────────
  useEffect(() => {
    if (shell === undefined || studio.state === undefined) return
    shell.setState(studio.state)
    shell.setSessionView(viewRef.current)
  }, [shell, shellReady, studio.state])

  // ── 调色板："用过的"就是直方图，第一次拿到世界时给个默认值 ────────────────
  useEffect(() => {
    const entries = studio.state?.histogram ?? []
    if (blockRef.current.length === 0 && entries.length > 0) setCurrentBlock(entries[0]!.block)
  }, [studio.state?.histogram])

  // 搜索节流：`studio:blocks` 要遍历 1095 个方块名，不值得每敲一个键问一次
  useEffect(() => {
    if (blockQuery.length === 0) {
      setBlockMatches([])
      return
    }
    const timer = window.setTimeout(() => {
      void window.architect.blocks(blockQuery).then(setBlockMatches)
    }, 160)
    return () => window.clearTimeout(timer)
  }, [blockQuery])

  /** 机位面板里正在打字时不要覆盖他（单向镜的那一半）。 */
  const camPanelBusy = (): boolean => {
    const active = document.activeElement
    return active instanceof HTMLElement && active.closest('.camera') !== null
  }

  // ── 机位字段与状态行：相机的**单向镜** ──────────────────────────────────────
  useEffect(() => {
    if (shell === undefined || camPanelBusy()) return
    setCameraFields(shell.cameraFields())
    setCamShared(shell.shared)
    const angles = shell.angles()
    const base = shell.settled
      ? t('viewport.statusAt', {
          az: angles.azimuth.toFixed(0),
          el: angles.elevation.toFixed(0),
          pos: shell
            .eye()
            .map((value) => Math.round(value))
            .join(','),
          ms: shell.software ? 'CPU' : 'GPU',
        })
      : t('viewport.status', {
          az: angles.azimuth.toFixed(0),
          el: angles.elevation.toFixed(0),
          ms: shell.software ? 'CPU' : 'GPU',
        })
    setStatus(base + (shell.shared ? ` · ${t('viewport.cam.sharedShort')}` : ''))
  }, [shell, shellReady, camTick])

  // ── 动作 ───────────────────────────────────────────────────────────────────

  /** 统一的"跑一个可能失败的动作"：状态行报进度、报结果，失败不吞。 */
  const run = async (label: string, fn: () => Promise<void>): Promise<void> => {
    setStatus(t('app.busy', { label }))
    try {
      await fn()
    } catch (error) {
      setStatus(
        t('app.failed', {
          label,
          message: error instanceof Error ? error.message : String(error),
        }),
      )
    }
  }

  /**
   * 世界被改过之后：**只把新状态交给 React**。
   *
   * 刻意不在这里再调 `shoot()`。状态的去向只有一条：
   * React 更新 → `[shell, studio.state]` 那个 effect → `shell.setState()` →
   * 外壳自己判断版本变没变、要不要重拉几何（见它的注释）。
   *
   * 早先这里多调了一次 `shoot()`，而它**必然早退**：React 是异步提交的，这一刻
   * `shell.current` 还是上一份状态，版本号没变。结果就是两条路互相以为对方会干活，
   * 画布永远停在老内容上。
   */
  const afterState = async (next: StudioState): Promise<void> => {
    studioRef.current?.setState(next)
  }

  const seek = (revision: number): void => {
    void run(t('timeline.drag'), async () => {
      await afterState(await window.architect.seek(revision))
    })
  }

  const openOp = (rev: number): void => {
    void run(t('panel.opDetail.title', { rev, tool: '' }), async () => {
      const detail = await window.architect.opDetail(rev)
      setOpDetail(detail)
      setOpDetailRev(rev)
      await afterState(await window.architect.seek(rev))
    })
  }

  /**
   * 游标变了 → 把滑杆挪到对应位置。
   *
   * **拖动中不碰**：`scrubbing` 为真时元素的值就是用户正在拖到的位置，这时按状态
   * 去写它会和手指打架（状态要等 IPC 回来才更新，写回去等于把拇指按住）。
   */
  useEffect(() => {
    const scrub = scrubRef.current
    if (scrub === null || scrubbing.current) return
    const next = String(studio.state?.revision ?? 0)
    if (scrub.value !== next) scrub.value = next
  }, [studio.state?.revision])

  /** 时间线拖动：事件很密集，用 `requestAnimationFrame` 合流。 */
  const seekFrame = useRef<number | undefined>(undefined)
  /** 用户/脚本正在拖时间线：这期间不要用状态覆盖滑杆的值。 */
  const scrubbing = useRef(false)
  const onScrub = (revision: number): void => {
    scrubbing.current = true
    if (seekFrame.current !== undefined) cancelAnimationFrame(seekFrame.current)
    seekFrame.current = requestAnimationFrame(() => {
      seekFrame.current = undefined
      scrubbing.current = false
      seek(Number(revision))
    })
  }

  // ── 键盘：⌘Z / ⇧⌘Z 撤销重做，左右方向键走游标 ─────────────────────────────
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      const editing =
        event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'z') {
        // **输入框里不抢**——在文本框里按 ⌘Z 应该是文本撤销，不是世界撤销
        if (editing) return
        event.preventDefault()
        const redo = event.shiftKey
        void run(t(redo ? 'menu.redo' : 'menu.undo'), async () => {
          await afterState(await (redo ? window.architect.redo() : window.architect.undo()))
        })
        return
      }
      if (editing) return
      if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
      const total = studioRef.current?.state?.totalOps ?? 0
      const at = studioRef.current?.state?.revision ?? 0
      const next = Math.max(0, Math.min(total, at + (event.key === 'ArrowLeft' ? -1 : 1)))
      if (next !== at) seek(next)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
    // `run` / `afterState` / `seek` 每次渲染都是新闭包，但它们只读 ref 与 setState，
    // 所以按"挂一次"来用是安全的——重挂反而会在快速按键时丢事件
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  /**
   * 视口里点了一下 → 选格 → 改世界。三种手势与体素编辑器惯例一致：
   * 点一下 = 放置（放在**命中面的外侧**那一格）、Alt/右键 = 挖掉、⌘/Ctrl = 吸取。
   */
  const pick = (event: {
    clientX: number
    clientY: number
    altKey: boolean
    metaKey: boolean
    ctrlKey: boolean
    button: number
  }): void => {
    void run(t('palette.current'), async () => {
      const overlay = document.getElementById('overlay')
      if (overlay === null) return
      const rect = overlay.getBoundingClientRect()
      if (rect.width < 1 || rect.height < 1) return
      // 相机参数与画面用的是同一套口径：CSS 像素尺寸 + 渲染进程里的相机状态
      const hit = await window.architect.pick({
        ...(shellRef.current?.viewportCamera() ?? { azimuth: 0, elevation: 0, scale: 0 }),
        width: Math.floor(rect.width),
        height: Math.floor(rect.height),
        x: event.clientX - rect.left,
        y: event.clientY - rect.top,
      })
      if (hit === null) {
        setStatus(t('palette.miss'))
        return
      }
      if (event.metaKey || event.ctrlKey) {
        setCurrentBlock(hit.blockId)
        setStatus(t('palette.picked', { block: shortBlock(hit.blockId) }))
        return
      }
      const breaking = event.altKey || event.button === 2
      if (!breaking && !hit.placeInVolume) {
        setStatus(t('palette.outside'))
        return
      }
      const target = breaking ? hit.block : hit.place
      const next = await window.architect.edit({
        pos: target,
        ...(breaking ? {} : { block: blockRef.current }),
        mode: breaking ? 'break' : 'place',
      })
      studioRef.current?.setState(next)
      await shellRef.current?.shoot()
      setStatus(
        breaking
          ? t('palette.broke', { block: shortBlock(hit.blockId), pos: hit.block.join(',') })
          : t('palette.placed', { block: shortBlock(blockRef.current), pos: target.join(',') }),
      )
    })
  }

  return (
    <>
      <Layout style={{ height: '100vh' }}>
        <Layout.Header>
          <Toolbar
            state={studio.state}
            costText={costText(studio.chat?.costUsd, studio.chat?.usage)}
            statusText={status}
            onNew={() =>
              void run(t('menu.new'), async () => {
                await afterState(await window.architect.newProject())
              })
            }
            onOpen={() =>
              void run(t('menu.open'), async () => {
                const next = await window.architect.open()
                if (next === undefined) return // 用户取消
                await afterState(next)
              })
            }
            onSave={() =>
              void run(t('menu.save'), async () => {
                const path = await window.architect.save()
                if (path === undefined) return
                studioRef.current?.setState(await window.architect.state())
              })
            }
            /* 「生成示例」按钮已按用户要求移除。`window.architect.demo()` 仍然在
               （preload 的 `studio:demo` 通道、`StudioService.demo()` 都没动），
               欢迎提示里那一条仍然指向它——所以这个能力没有消失，只是不再占顶栏。
               要恢复：把 `onDemo` 加回 props，并在 toolbar.tsx 里取消那段注释。 */
            onExport={() =>
              void run(t('menu.export'), async () => {
                // 扩展名决定格式；`.schem` / `.litematic` / `.obj` 三种
                const result = await window.architect.exportModel('schem')
                if (result === undefined) return // 用户取消
                studioRef.current?.setNotice(
                  t('notice.exported', {
                    count: result.paths.length,
                    names: result.paths.join('、'),
                  }),
                )
                setStatus(result.summary)
              })
            }
            onImport={() =>
              void run(t('menu.import'), async () => {
                const result = await window.architect.importModel()
                if (result === undefined) return // 用户取消
                await afterState(result.state)
                // 认不出来的方块要如实说，别让用户以为全导进来了
                const parts = [t('notice.imported', { summary: result.summary })]
                if (result.renamed.length > 0) {
                  parts.push(t('notice.importRenamed', { count: result.renamed.length }))
                }
                if (result.unknown.length > 0) {
                  parts.push(
                    t('notice.importSkipped', {
                      count: result.unknown.length,
                      cells: result.skipped,
                    }) +
                      `\n${result.unknown
                        .slice(0, 5)
                        .map((entry) => `${entry.name} ×${entry.count}`)
                        .join('、')}`,
                  )
                }
                studioRef.current?.setNotice(parts.join('\n'))
              })
            }
            onUndo={() =>
              void run(t('menu.undo'), async () => {
                await afterState(await window.architect.undo())
              })
            }
            onRedo={() =>
              void run(t('menu.redo'), async () => {
                await afterState(await window.architect.redo())
              })
            }
            onOpenSettings={() => setSettingsOpen(true)}
          />
        </Layout.Header>

        <Layout>
          <Layout.Sider width={232} theme="light" style={{ overflow: 'hidden' }}>
            <LeftPanel
              state={studio.state}
              camera={cameraFields}
              camMode={camMode}
              camShared={camShared}
              onCamMode={(mode) => {
                setCamMode(mode)
                // 换模式时字段是同一台相机，所以"应用"是个空操作——不会跳视角
                shellRef.current?.applyFields({ mode, ...cameraFields })
              }}
              onCamCommit={() => {
                const current = shellRef.current
                if (current === undefined) return
                if (!current.applyFields({ mode: camMode, ...cameraFields })) return
                setCameraFields(current.cameraFields())
              }}
              onCamField={(patch) => {
                /**
                 * **只更新字段，不动相机。**
                 *
                 * 旧实现是在 `change` 事件上"应用"的，也就是说：填的过程不动相机，
                 * 填完（失焦/回车）才算数。我第一版改成了"每敲一个字符都应用一次"，
                 * 那是错的，而且错得很隐蔽——`applyFields` 内部会排一帧，帧里又会按
                 * 相机重算一遍字段，于是**用半填好的状态把输入框覆盖回去**：
                 * 实测写 cam-ex=40 之后立刻变成 9（自动取景算出来的眼位），
                 * 六个字段一个都存不下来。
                 *
                 * 所以这里只写状态；"应用"由 `onCamApply`（按钮）与下面的
                 * `onBlur` 负责，语义与旧实现一致。
                 */
                setCameraFields({ ...cameraFields, ...patch })
              }}
              onCamApply={() => {
                const current = shellRef.current
                if (current === undefined) return
                if (!current.applyFields({ mode: camMode, ...cameraFields })) return
                setCameraFields(current.cameraFields())
                setStatus(t('viewport.cam.applied'))
              }}
              onCamReset={() => {
                const preset = viewRef.current === 'free' ? 'iso_ne' : viewRef.current
                shellRef.current?.resetToPreset(preset)
                if (viewRef.current === 'free') {
                  viewRef.current = 'iso_ne'
                  shellRef.current?.setSessionView('iso_ne')
                }
                setCamShared(false)
                setStatus(t('viewport.cam.unshared'))
                void window.architect.setCamera(null).then((next) => studioRef.current?.setState(next))
              }}
              onCamShared={(shared) => {
                setCamShared(shared)
                shellRef.current?.setShared(shared)
              }}
              editMode={editMode}
              onEditMode={(on) => {
                setEditMode(on)
                setStatus(on ? t('palette.editMode') : t('app.ready'))
              }}
              blockQuery={blockQuery}
              onBlockQuery={setBlockQuery}
              blockMatches={blockMatches}
              currentBlock={currentBlock}
              onSelectBlock={setCurrentBlock}
              opDetail={opDetailRev !== undefined ? opDetail : undefined}
              onOpenOp={openOp}
              onCloseOp={() => {
                setOpDetailRev(undefined)
                setOpDetail(undefined)
              }}
            />
          </Layout.Sider>

          <Layout.Content style={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}>
            <div style={{ flex: 1, minHeight: 0 }}>
              <Viewport
                shell={shell}
                empty={studio.state?.blocks === 0}
                editMode={editMode}
                onPick={pick}
                onFreeView={() => {
                  if (viewRef.current === 'free') return
                  viewRef.current = 'free'
                  shellRef.current?.setSessionView('free')
                }}
                onCameraChanged={onCameraChanged}
              />
            </div>
            {/* 时间线：游标前后移动 = 撤销 / 重做，同一套语义（plan §6） */}
            <Flex
              align="center"
              gap={10}
              style={{
                flex: 'none',
                padding: '8px 12px',
                background: 'var(--ant-color-bg-container)',
                borderTop: '1px solid var(--ant-color-border-secondary)',
              }}
            >
              {/*
                **时间线用原生 `input[type=range]`，不用 antd 的 `Slider`。**

                `Slider` 的 `id` 落在包裹元素上而不是内部那个 `input` 上，而
                `#scrub` 是一个**真契约**：gui-smoke 的 `timeline-drag` 断言要
                `scrub.value = …` 再派发 `input` 事件（旧实现就是这个形状）。
                与其为了让断言能抓到而塞一个隐藏的原生输入框（两个控件同一语义，
                迟早不同步），不如就用原生那一个——滑杆本来就该是原生元素，
                样式在 `styles.css` 里调。

                这个滑杆是**非受控**的（`defaultValue` + 一个 effect 程序化跟随），
                不是 `value=` 受控。原因不是省事：React 会给受控 input 装 value tracker，
                于是"从 DOM 上直接赋值 + 派发 input 事件"会被它判成**没变**而丢弃，
                `onChange` 不触发。而拖时间线恰恰是**程序化驱动**的（自动化脚本、
                以及未来可能的快捷键步进），受控值在这条路上反而成了障碍。
                跟真实用户拖动无关：那是元素自身的值变化，走的正常路径。
              */}
              <input
                id="scrub"
                ref={scrubRef}
                type="range"
                className="scrub"
                style={{ flex: 1 }}
                min={0}
                max={studio.state?.totalOps ?? 0}
                defaultValue={studio.state?.revision ?? 0}
                disabled={(studio.state?.totalOps ?? 0) === 0}
                onChange={(event) => onScrub(Number(event.target.value))}
              />
              <span
                id="rev-label"
                style={{
                  color: 'var(--ant-color-primary)',
                  fontVariantNumeric: 'tabular-nums',
                  minWidth: 92,
                }}
              >
                {t('timeline.revision', {
                  rev: studio.state?.revision ?? 0,
                  total: studio.state?.totalOps ?? 0,
                })}
              </span>
            </Flex>
          </Layout.Content>

          <Layout.Sider width={330} theme="light" style={{ overflow: 'hidden' }}>
            <ChatPanel
              chat={studio.chat}
              state={studio.state}
              notice={studio.notice}
              onNoticeClose={() => studioRef.current?.setNotice(undefined)}
              onSend={(text) => {
                void run(t('chat.send'), async () => {
                  studioRef.current?.setChat(await window.architect.send(text))
                })
              }}
              onStop={() =>
                void run(t('chat.stop'), async () => {
                  studioRef.current?.setChat(await window.architect.stop())
                })
              }
              onRecoveryApply={() =>
                void run(t('recovery.apply'), async () => {
                  await afterState(await window.architect.applyRecovery())
                })
              }
              onRecoveryDiscard={() =>
                void run(t('recovery.discard'), async () => {
                  await afterState(await window.architect.discardRecovery())
                })
              }
              onOpenSettings={() => setSettingsOpen(true)}
            />
          </Layout.Sider>
        </Layout>
      </Layout>

      <SettingsModal
        open={settingsOpen}
        settings={studio.settings}
        activeId={editingProvider}
        onActiveId={setEditingProvider}
        onClose={() => setSettingsOpen(false)}
        onSaved={(next: SettingsView) => studioRef.current?.setSettings(next)}
        onStatus={(key: MessageKey) => setStatus(t(key))}
      />
    </>
  )
}
