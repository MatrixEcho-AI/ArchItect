import { useEffect, useRef } from 'react'
import { t } from '@architect/i18n'

import type { ViewportShell } from '../viewport-shell.js'

/**
 * 三维视口的**挂载点**。
 *
 * 它是 React 与命令式外壳之间唯一的那道缝：
 *   - React 提供两层画布（`#canvas` 是 WebGL / three.js，`#overlay` 是 2D 叠加层与软件帧）
 *   - 所有指针、滚轮、键盘事件**原样转给外壳**，React 一个字节的状态都不碰
 *
 * 为什么不做成受控组件：拖动每移动一像素就 `setState` 会让整棵树重渲染，
 * 而画布本身一个字节都没变。**高频的那一半必须留在 React 之外。**
 *
 * 两层画布靠 CSS 绝对定位严格重叠（见 `styles.css` 的 `.viewport-stage canvas`），
 * 共用同一份相机投影，所以标尺/文字的线与方块永远对得上。
 */
export interface ViewportProps {
  shell: ViewportShell | undefined
  /** 空世界时盖上那行字。**视口本身照样画一遍**——见外壳 `requestFrame` 的注释。 */
  empty: boolean
  /** 编辑模式：几乎没动的按下 = 改一格。 */
  editMode: boolean
  /** 一次"点击"（拖动距离在阈值内）。`button === 2` 或 Alt = 挖掉。 */
  onPick: (event: {
    clientX: number
    clientY: number
    altKey: boolean
    metaKey: boolean
    ctrlKey: boolean
    button: number
  }) => void
  /** 自由视角下拖动过 → 下拉框不再说"等轴测 东北"。 */
  onFreeView: () => void
  /** 相机动了 → 让 React 重算机位字段与状态行。 */
  onCameraChanged: () => void
}

/** 拖动超过这个距离就不算点击——否则每次转视角都会顺手改掉一格。 */
const CLICK_SLOP = 4

export function Viewport({
  shell,
  empty,
  editMode,
  onPick,
  onFreeView,
  onCameraChanged,
}: ViewportProps): React.JSX.Element {
  const stageRef = useRef<HTMLDivElement>(null)
  // 事件处理器要读最新的 editMode / 回调，但不该因为它们的身份变化就重装监听
  const latest = useRef({ editMode, onPick, onFreeView, onCameraChanged })
  latest.current = { editMode, onPick, onFreeView, onCameraChanged }

  // 容器尺寸。用 ResizeObserver 而不是 window.resize：侧栏折叠、对话框打开也会
  // 改变视口大小，而 window 尺寸没变。
  useEffect(() => {
    if (shell === undefined) return
    /**
     * 两层画布**按 id 取**，不走 React ref。
     *
     * 这不是风格问题：先前这里用 `overlayRef.current`，而那个 ref **从没绑到画布上**
     * （JSX 里漏了 `ref={overlayRef}`），于是 effect 每次都因为 `null` 提前返回——
     * 画布永远是 300×150 的默认尺寸，而界面照常渲染（CSS 把 300×150 拉伸到整屏），
     * 所以肉眼几乎看不出问题，只有模型收到的那张截图是小图。
     *
     * 按 id 取就没有"忘了绑 ref"这一种失败模式：元素在不在 DOM 里，一眼可查。
     */
    const overlay = document.getElementById('overlay') as HTMLCanvasElement | null
    if (overlay === null) return

    const measure = (): void => {
      const rect = overlay.getBoundingClientRect()
      shell.resize(rect.width, rect.height, window.devicePixelRatio || 1)
    }

    /**
     * **挂载时必须同步测一次，不能只等 `ResizeObserver`。**
     *
     * `ResizeObserver` 的首次回调是**异步**的（下一帧才来），而渲染进程的 `ready`
     * 在这之前就可能发出去——主进程从收到 `ready` 那一刻起就会来要截图，
     * 于是 `--shot` 拍到的是一张 **300×150**（HTML canvas 的默认尺寸）的图。
     *
     * 这个坑是接 React 时新引入的：旧实现的视口是启动时一次性建好的，建完立刻测；
     * 现在外壳建在 effect 里，测尺寸落在另一个 effect 里，两者之间多了一个异步空档。
     * 症状很隐蔽——抓窗口看是对的（那是 `capturePage`，与画布尺寸无关），
     * 只有 `--shot` 那条路会拍出小图。
     */
    measure()

    /**
     * 真机症状与判断依据：`overlay.getBoundingClientRect()` 返回 0 时说明这一帧布局
     * 还没算完（React 刚提交、字体还没回流）。那种情况下**宁可晚一帧量**，
     * 也不要拿 0 去改画布尺寸——`resize` 会把尺寸夹到 1，画布会先塌成 1×1。
     */
    const observer = new ResizeObserver(() => {
      const rect = overlay.getBoundingClientRect()
      if (rect.width < 1 || rect.height < 1) {
        requestAnimationFrame(measure)
        return
      }
      measure()
    })
    observer.observe(overlay)
    return () => observer.disconnect()
  }, [shell])

  // 指针 / 滚轮 / 双击
  useEffect(() => {
    if (shell === undefined) return
    const overlay = document.getElementById('overlay') as HTMLCanvasElement | null
    if (overlay === null) return

    let dragging = false
    let dragAt = { x: 0, y: 0 }
    /** 累计拖动距离。**用它区分"点击"和"转视角"**：手一抖就改掉一格是最烦人的事。 */
    let moved = 0
    /** 这次按下的是哪个键——松手时要按同一个键决定是放置还是挖掉。 */
    let button = 0

    const onPointerDown = (event: PointerEvent): void => {
      // 右键也接：体素编辑器的惯例是右键挖掉。下面的 contextmenu 要一起挡掉
      if (event.button !== 0 && event.button !== 2) return
      dragging = true
      button = event.button
      moved = 0
      dragAt = { x: event.clientX, y: event.clientY }
      // **必须包起来**：`setPointerCapture` 对"没有活动指针"的指针 id 会抛
      // `NotFoundError`，而合成的 `PointerEvent`（`--drag-test` / `--paint-test` /
      // 自动化脚本）恰恰没有活动指针。不包的话这个异常会从事件处理器里冒出去——
      // 抓指针只是"手滑出窗口也继续收到 pointermove"的优化，失败了顶多丢这一条优化，
      // 不该让整个交互挂掉。
      try {
        overlay.setPointerCapture(event.pointerId)
      } catch {
        // 没有活动指针：继续，用窗口级的 pointerup 兜底
      }
      document.body.classList.add('dragging')
      // 拖过就说明用户要的是自由视角，下拉框不该再说"等轴测 东北"
      latest.current.onFreeView()
    }

    const onPointerMove = (event: PointerEvent): void => {
      if (!dragging) return
      const dx = event.clientX - dragAt.x
      const dy = event.clientY - dragAt.y
      dragAt = { x: event.clientX, y: event.clientY }
      moved += Math.abs(dx) + Math.abs(dy)
      shell.drag(dx, dy, event.altKey, overlay.clientHeight)
    }

    const endDrag = (event: PointerEvent): void => {
      if (!dragging) return
      dragging = false
      document.body.classList.remove('dragging')
      if (overlay.hasPointerCapture(event.pointerId)) overlay.releasePointerCapture(event.pointerId)
      // 松手补一张全分辨率的：拖动中出的都是草稿帧
      shell.requestFrame()
      // 编辑模式下"几乎没动"的一次按下 = 一次点击 → 改一格
      if (
        latest.current.editMode &&
        event.type === 'pointerup' &&
        event.button === button &&
        moved <= CLICK_SLOP
      ) {
        latest.current.onPick({
          clientX: event.clientX,
          clientY: event.clientY,
          altKey: event.altKey,
          metaKey: event.metaKey,
          ctrlKey: event.ctrlKey,
          button: event.button,
        })
      }
    }

    const onWheel = (event: WheelEvent): void => {
      event.preventDefault()
      shell.wheel(event.deltaY)
    }

    const onDoubleClick = (): void => shell.dblclick()
    const onContextMenu = (event: MouseEvent): void => event.preventDefault()

    overlay.addEventListener('pointerdown', onPointerDown)
    overlay.addEventListener('pointermove', onPointerMove)
    overlay.addEventListener('pointerup', endDrag)
    overlay.addEventListener('pointercancel', endDrag)
    overlay.addEventListener('wheel', onWheel, { passive: false })
    overlay.addEventListener('dblclick', onDoubleClick)
    overlay.addEventListener('contextmenu', onContextMenu)
    return () => {
      overlay.removeEventListener('pointerdown', onPointerDown)
      overlay.removeEventListener('pointermove', onPointerMove)
      overlay.removeEventListener('pointerup', endDrag)
      overlay.removeEventListener('pointercancel', endDrag)
      overlay.removeEventListener('wheel', onWheel)
      overlay.removeEventListener('dblclick', onDoubleClick)
      overlay.removeEventListener('contextmenu', onContextMenu)
      document.body.classList.remove('dragging')
    }
  }, [shell])

  // 编辑模式：光标换成十字（不然用户不知道"现在点一下会改东西"）
  useEffect(() => {
    document.body.classList.toggle('editing', editMode)
    return () => document.body.classList.remove('editing')
  }, [editMode])

  // WASD / 空格 / Shift：**像游戏里那样走**。空格归相机、按钮上的空格归按钮。
  useEffect(() => {
    if (shell === undefined) return
    const held = new Set<string>()
    let frame: number | undefined
    /**
     * 这一步的**起点墙钟时间**，以及已经推进过的总秒数。
     *
     * 为什么不用"上一帧的时间戳"来算 `dt`：那样每帧的位移是**从帧间隔**推出来的，
     * 而帧间隔会被节流（窗口被遮挡、GPU 进程忙、后台标签页）放大到几百毫秒，
     * 于是 `Math.min(0.1, dt)` 把它截成 0.1 之内的一个小数——按住键半天，相机几乎没动。
     * 症状是"WASD 时灵时不灵"，而且只在自动化的短窗口里暴露（人按一会儿就动了）。
     *
     * 换成从**起点**积分的总时长，位移就不再依赖"这一帧停了多久"：只要有一帧真的跑了，
     * 它就会把从按下到现在应有的位移一次性补上。
     */
    let stepStart = 0

    /** 移动键的键名（`event.key.toLowerCase()`）：空格是 `' '`，Shift 是 `'shift'`。 */
    const MOVE_KEYS = new Set(['w', 'a', 's', 'd', ' ', 'shift'])

    /**
     * **焦点在输入类控件上时不抢键**：字母键会被它们吃掉（下拉框也吃）。
     */
    const typing = (target: EventTarget | null): boolean =>
      target instanceof HTMLElement &&
      (target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        target instanceof HTMLSelectElement ||
        target.isContentEditable)

    const step = (now: number): void => {
      if (held.size === 0) {
        frame = undefined
        // 补一张全分辨率的（循环里出的都是草稿帧，软件视口那半分辨率得换掉）
        shell.walkEnded()
        return
      }
      // 单帧位移仍然封顶 0.1s（掉一大帧时不要瞬移），但计时从**按下那一刻**算起，
      // 所以被节流掉的那些帧不会让位移凭空消失（见 `stepStart` 的注释）
      const dt = Math.min(0.1, Math.max(0, (now - stepStart) / 1000))
      shell.walk(held, dt)
      // 状态行（以及机位字段）要跟着走：`walk` 只排帧，不通知"相机变了"。
      // 少这一句的话，走动过程中隐藏的状态行不更新，而它正是 wasd-move 断言读的东西。
      latest.current.onCameraChanged()
      latest.current.onFreeView()
      frame = requestAnimationFrame(step)
    }

    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.metaKey || event.ctrlKey || event.altKey) return
      if (typing(event.target)) return
      const key = event.key.toLowerCase()
      if (!MOVE_KEYS.has(key)) return
      // **空格在按钮上归按钮**：焦点停在按钮上时按空格是"点它"，抢过来当"上升"就变成
      // "再发一次消息 / 再导出一次"。只让空格这一条：按钮不吃字母键，没理由因为焦点
      // 在按钮上就把 WASD 一起停掉。
      if (key === ' ' && event.target instanceof HTMLButtonElement) return
      // 空格默认还会滚动页面。既然要拿它当"上升"，默认行为就得吃掉
      if (key === ' ') event.preventDefault()
      // 系统自动重复会把同一个键反复送进来：已经在走就什么都不用做
      if (held.has(key)) return
      held.add(key)
      if (frame === undefined) {
        // 起点用**按下这一刻**，而不是第一次 rAF 回调的时刻——首帧本身可能被拖后
        stepStart = performance.now()
        // 先立即走一步：不能等 rAF 才动，否则"按一下立刻松手"或者首帧被节流时，
        // 这一步会整个丢掉（wasd-move 断言读的正是"按 8 帧之后位置变没变"）
        shell.walk(held, 0)
        latest.current.onCameraChanged()
        frame = requestAnimationFrame(step)
      }
    }

    const release = (event: KeyboardEvent): void => {
      held.delete(event.key.toLowerCase())
    }
    // 窗口失去焦点时按键的 keyup 收不到（切出去松的手），不清掉就会一直往前走
    const clear = (): void => {
      held.clear()
    }

    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('keyup', release)
    window.addEventListener('blur', clear)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('keyup', release)
      window.removeEventListener('blur', clear)
      if (frame !== undefined) cancelAnimationFrame(frame)
    }
  }, [shell])

  return (
    <div className="viewport-stage" ref={stageRef}>
      {/* three.js 画方块 */}
      <canvas id="canvas" title={t('viewport.hint')} />
      {/* 叠加层单独一层 2D 画布：标尺/坐标轴/文字画在这上面，两层尺寸完全一致 */}
      <canvas id="overlay" />
      {empty && <div id="empty" className="viewport-empty">{t('viewport.empty')}</div>}
    </div>
  )
}
