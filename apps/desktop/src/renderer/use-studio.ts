import { useCallback, useEffect, useRef, useState } from 'react'
import { t } from '@architect/i18n'

import type { ChatView, SettingsView, StudioState } from './types.js'
import type { MessageKey } from '@architect/i18n'

/**
 * 渲染进程的**权威状态**：主进程推什么，这里就存什么。
 *
 * 关键约定（与旧实现逐字一致）：
 *
 * 1. **状态只有一个来源**：`window.architect.state()/chat()/settings()` 的首次拉取，
 *    加上 `subscribe()` 推来的增量。界面自己**不猜**世界长什么样——渲染进程不持有世界。
 * 2. **`notice` 是一次性的**：主进程读过就清，所以这里一收到就留住，不能被下一次状态
 *    刷新冲掉（旧实现里也是一样的处理，注释都还在）。
 * 3. **只添加、不丢弃**：哪个视图到了就更新哪个。订阅事件里只有 `state` 会顺带触发画一帧。
 */

/** `location.hash` 里的诊断开关（`--demo --gui-smoke` 这类 flag 由主进程拼进来）。 */
export function debugFlags(): Set<string> {
  return new Set(
    location.hash
      .replace(/^#/, '')
      .split(',')
      .filter((flag) => flag.length > 0),
  )
}

export interface StudioStore {
  state: StudioState | undefined
  chat: ChatView | undefined
  settings: SettingsView | undefined
  /** 一次性提示的正文（导出成功、导入结果…）。`undefined` = 没有。 */
  notice: string | undefined
  /** 一行状态文字。**隐藏的状态行与机位读数都读它**（gui-smoke 的 WASD 断言依赖它）。 */
  status: string
  /** 已绑定到 `settings` 那一份里的 provider（设置面板正在编辑的那一个）。 */
  setState: (next: StudioState) => void
  setChat: (next: ChatView) => void
  setSettings: (next: SettingsView) => void
  setNotice: (text: string | undefined) => void
  setStatusKey: (key: MessageKey, vars?: Record<string, string | number>) => void
  /** 用一句已经成型的话覆盖状态行（导出路径这类带动态内容的地方）。 */
  setStatusText: (text: string) => void
  /** boot 阶段的就绪回报。只该调一次。 */
  reportReady: (report: { ok: boolean; detail: string }) => void
}

/**
 * 把主进程的三个视图接进 React。
 *
 * `onStateEvent` 是"世界变了"的钩子：订阅到 `state` 事件时，**除了更新左栏还要重画一帧**。
 * 画帧是命令式的（在 `ViewportShell` 里），所以这里只负责通知。
 */
export function useStudio(onStateEvent: (next: StudioState) => void): StudioStore {
  const [state, setStateValue] = useState<StudioState>()
  const [chat, setChatValue] = useState<ChatView>()
  const [settings, setSettingsValue] = useState<SettingsView>()
  const [notice, setNotice] = useState<string>()
  const [status, setStatus] = useState('')

  // 回调放进 ref：订阅只建一次，而 `onStateEvent` 每次渲染都是新的闭包。
  // 不这么做就得把 subscribe 挂在依赖上，于是每渲染一次就重订阅一次。
  const stateEvent = useRef(onStateEvent)
  stateEvent.current = onStateEvent

  const setState = useCallback((next: StudioState) => setStateValue(next), [])
  const setChat = useCallback((next: ChatView) => setChatValue(next), [])
  const setSettings = useCallback((next: SettingsView) => setSettingsValue(next), [])

  const setStatusKey = useCallback(
    (key: MessageKey, vars?: Record<string, string | number>) => setStatus(t(key, vars)),
    [],
  )
  const setStatusText = useCallback((text: string) => setStatus(text), [])

  const reportReady = useCallback((report: { ok: boolean; detail: string }) => {
    void window.architect.ready(report)
  }, [])

  // ── 首次拉取 + 订阅 + i18n 初始化 ─────────────────────────────────────────
  useEffect(() => {
    let alive = true
    const unsubscribe = window.architect.subscribe((event) => {
      if (!alive) return
      if (event.type === 'chat') setChatValue(event.view)
      else if (event.type === 'settings') setSettingsValue(event.view)
      else if (event.type === 'state') {
        setStateValue(event.state)
        stateEvent.current(event.state)
      }
    })
    return () => {
      alive = false
      unsubscribe()
    }
  }, [])

  return {
    state,
    chat,
    settings,
    notice,
    status,
    setState,
    setChat,
    setSettings,
    setNotice,
    setStatusKey,
    setStatusText,
    reportReady,
  }
}

