import type { ViewportShell } from './viewport-shell.js'

/**
 * 诊断开关的**合成动作**。
 *
 * 它们存在的理由只有一个：让"只有真跑一次才会走到"的路径也能被自动抓图验到。
 * 所以每一条都走**真实的事件路径**（真的派发指针/键盘事件、真的点按钮），
 * 而不是调内部函数——调内部函数证明不了"用户点得动"。
 *
 * 与旧 `main.ts` 的差别只有一处，但很关键：**字段值现在是 React state**。
 * 旧实现里 `applyCameraFields()` 在事件处理里同步读 `input.value`，所以
 * "设值 → 派发 change → 点应用"一口气做完就行；现在 `dispatchEvent` 只是把更新
 * 排进 React 的队列，立刻点"应用"读到的还是上一次的值。所以每一步之后都要
 * 让 React 跑完一轮（见 `settle()`）。
 */

/** 等 React 提交两帧。字段值是受控的，不等就会读到旧值。 */
function settle(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
}

/**
 * 合成一次拖动（`--drag-test`）。
 *
 * 不合成事件的话，`--capture` 抓到的永远是静止的第一帧。
 */
export function simulateDrag(): void {
  const overlay = document.getElementById('overlay')
  if (overlay === null) return
  const rect = overlay.getBoundingClientRect()
  const cx = rect.left + rect.width / 2
  const cy = rect.top + rect.height / 2
  const send = (type: string, x: number, y: number): void => {
    overlay.dispatchEvent(
      new PointerEvent(type, {
        pointerId: 1,
        button: 0,
        buttons: type === 'pointerup' ? 0 : 1,
        clientX: x,
        clientY: y,
        bubbles: true,
      }),
    )
  }
  send('pointerdown', cx, cy)
  for (let i = 1; i <= 5; i++) send('pointermove', cx + i * 14, cy + i * 4)
}

/**
 * 合成一次"人手放一格"（`--paint-test`）。
 *
 * 验的是整条链路：拖动阈值 → 拾取 IPC → 写世界 → 记 op → 重画。
 * 直接调内部函数会跳过阈值那一段，而"手一抖就改掉一格"正是最需要被验到的行为。
 */
export async function simulatePaint(): Promise<void> {
  // 编辑模式是那个隐藏复选框的状态。**用 `.click()` 而不是"改 .checked + 派发 change"**：
  // 受控 checkbox 的 checked 由 React 状态决定，对 DOM 直接赋值再派发 change 不会触发
  // onChange（实测如此，见 `simulateCameraPanel` 里同一条注释）。`.click()` 是用户
  // 真实走的那条路，也是受控 checkbox 唯一可靠的程序化驱动方式。
  const box = document.getElementById('edit-mode') as HTMLInputElement | null
  if (box !== null) {
    box.click()
    await settle()
  }
  const overlay = document.getElementById('overlay')
  if (overlay === null) return
  const rect = overlay.getBoundingClientRect()
  const at = { x: rect.left + rect.width / 2, y: rect.top + rect.height * 0.62 }
  for (const type of ['pointerdown', 'pointerup'] as const) {
    overlay.dispatchEvent(
      new PointerEvent(type, {
        pointerId: 1,
        button: 0,
        buttons: type === 'pointerdown' ? 1 : 0,
        clientX: at.x,
        clientY: at.y,
        bubbles: true,
      }),
    )
  }
  // `pointerup` 里是 fire-and-forget 的，等它把 IPC 走完再让 `--capture` 抓图
  await new Promise((resolve) => setTimeout(resolve, 600))
}

/**
 * 合成一次"在机位面板里填坐标 + 共享给模型"（`--camera-test`）。
 *
 * 验的是**人机共用机位**这条链路（D-52）：主进程 `--shot` 拍出来的那张模型视角图，
 * 应该就是这个坐标拍出来的。
 */
export async function simulateCameraPanel(shell: ViewportShell | undefined): Promise<void> {
  /**
   * 合成一次「把机位定到 (40,30,40) 看向 (16,6,0)，并共享给模型」。
   *
   * ## 为什么走外壳 API 而不是逐个字段合成 DOM 事件
   *
   * 这个开关的目的是**验"人机共用机位"这条链路**（D-52）：界面上定的机位有没有真的
   * 写进会话、模型接下来是不是从那儿看。它不该兼职测试"React 受控输入框能不能被
   * 脚本驱动"——那是另一件事，而且在此项目里已经证明很脆：
   *
   *   - 直接给 `.value` 赋值会被 React 的 value tracker 判成"没变"而丢弃（部分字段生效、
   *     部分不生效，症状极具迷惑性）；
   *   - 走原生 setter + `input` 事件能让字段更新，但机位字段是"填完才算数"（回车/应用
   *     提交），脚本补发 `blur` 又会带出别的东西（实测游标自己退到了 rev 7）。
   *
   * 切模式那一句本来就已经走外壳 API 了（antd 的 `Select` 在 DOM 上改不动），
   * 这里统一成同一种做法：**用真实的 IPC 走完共享链路，用外壳 API 摆好机位**。
   * 于是这个开关验证的东西一个字没少，而它不再依赖一层与 Electron/React 版本
   * 都有关系的合成事件兼容性。
   */
  shell?.applyFields({
    mode: 'eye',
    ...shell.cameraFields(),
    eye: ['40', '30', '40'],
    lookAt: ['16', '6', '0'],
  })
  await settle()

  const share = document.getElementById('cam-share') as HTMLInputElement | null
  if (share !== null) {
    // 受控 checkbox 只吃 `click`：改 `.checked` 再派发 `change` 不会触发 onChange。
    // 这也正是用户真实走的那条路（切换 → 点击）。
    share.click()
  }
  // 等节流那 120ms：不推过去的话会话机位还是旧的
  await new Promise((resolve) => setTimeout(resolve, 300))

  /**
   * **自查一次**：会话相机到底有没有被写上眼位。
   *
   * 为什么值得断言：`--shot` 那条路固定用 `view: 'iso_ne'` 取图，**不反映**会话机位——
   * 只看那句"机位 iso_ne"分不出"共享成功"和"根本没共享"。而用户勾了「模型用这个机位」
   * 却什么都没发生，界面上不会有任何异常，这是最该被自动抓住的一类。
   *
   * 结果写进可见的提示条（`#notice`），抓图就能读到。
   */
  const want = '40,30,40'
  const eye = (await window.architect.state()).camera?.eye
  const actual = eye === undefined ? '(none)' : eye.map((n) => Math.round(n)).join(',')
  const banner = document.getElementById('notice')
  if (banner !== null) {
    banner.classList.remove('hidden')
    // 整句写在同一个赋值里：i18n 测试按"字面量离开发者出口几行内"判定归属，
    // 拆成变量再拼会让那句中文漂到窗口外，测试就没法把它认成诊断行。
    banner.textContent =
      actual === want
        ? `[camera-test] OK 模型用这个机位已生效：${actual}`
        : `[camera-test] FAILED 期望 ${want}，实际 ${actual}`
  }
}

/**
 * 合成一次**新建**（`--new-test`）：先记下当前场景与对话，再新建，然后把前后对比
 * 写进可见的提示条。
 *
 * 存在的理由：`--capture` / `--gui-smoke` 只能看到"界面上有没有更新"，而"新建之后
 * 画布清空了没有"是**渲染器内部**的事（GPU 里的 mesh），DOM 上读不到。这个开关把它
 * 变成一个能看见、能断言的数字。
 *
 * 用法：`--demo --new-test --capture <png>`。
 */
export async function simulateNewProject(): Promise<void> {
  const before = window.__architectDebugScene?.() ?? { meshes: 0, triangles: 0 }
  const beforeChat = (await window.architect.chat()).messages.length
  const beforeBlocks = (await window.architect.state()).blocks

  await window.architect.newProject()
  /**
   * **轮询等它稳定，别睡一个固定时长。**
   *
   * 新建之后的链条有好几段是异步的：主进程推 state → React 提交 → 外壳发现版本变了
   * → 去要一份新几何（IPC）→ 重建 mesh → 画一帧。400ms 在空闲机器上够，但
   * "够不够"取决于当时忙不忙——实测就撞上过：诊断在几何回来之前读到了旧三角形数，
   * 于是报了一个**假的 FAILED**，而它真正的问题是等待策略。
   */
  await waitUntil(() => (window.__architectDebugScene?.().triangles ?? 0) === 0, 3000)

  const after = window.__architectDebugScene?.() ?? { meshes: 0, triangles: 0 }
  const afterChat = (await window.architect.chat()).messages.length
  const afterBlocks = (await window.architect.state()).blocks
  // 提醒：判据读的是**渲染进程真正画出来的东西**（`__architectDebugScene` 报的是
  // GPU 里的 mesh），不是"主进程说世界空了"。前者才是用户看到的那一份。
  const banner = document.getElementById('notice')
  if (banner !== null) {
    banner.classList.remove('hidden')
    const ok = after.triangles === 0 && afterChat === 0 && afterBlocks === 0
    banner.textContent =
      `[new-test] ${ok ? 'OK' : 'FAILED'} 画布 ${before.triangles}→${after.triangles} 三角形 · ` +
      `对话 ${beforeChat}→${afterChat} 条 · 方块 ${beforeBlocks}→${afterBlocks}`
  }
}

/**
 * 轮询等到条件成立（或超时）。
 *
 * 诊断脚本里**不要用固定 sleep**：要等的东西大多是"IPC + 渲染"这类时长不定的链条，
 * 固定的数要么白等要么不够，而"不够"会伪装成一个功能 bug（见 `simulateNewProject`）。
 */
async function waitUntil(predicate: () => boolean, timeoutMs = 2000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return true
    await new Promise((resolve) => requestAnimationFrame(resolve))
  }
  return predicate()
}

/**
 * `--md-test`：把对话滚到底。
 *
 * 那条样本比一屏长，不滚的话抓到的图只有上半段——而"长方块 id 会不会撑破卡片"
 * 这类问题恰恰在下半段。它同时**验证贴底自动滚还能用**（这是用户报过的 bug）。
 */
export async function scrollChatToBottom(): Promise<void> {
  const list = document.getElementById('messages')
  if (list === null) return
  await waitUntil(() => list.scrollHeight > list.clientHeight, 1000)
  list.scrollTop = list.scrollHeight
  await new Promise((resolve) => requestAnimationFrame(resolve))
}
