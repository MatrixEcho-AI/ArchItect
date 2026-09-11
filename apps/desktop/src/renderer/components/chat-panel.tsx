import { useCallback, useEffect, useRef, useState } from 'react'
import { Alert, Button, Flex, Input, Tooltip } from 'antd'
import { DownOutlined, RightOutlined } from '@ant-design/icons'
import { t } from '@architect/i18n'

import { usageText } from '../cost.js'
import { Markdown } from './markdown.js'
import type { ChatMessageView, ChatView, StudioState } from '../types.js'

/**
 * 对话面板：标题行（含读数）+ 消息列表 + 输入框 + 三条横幅。
 *
 * 几件必须原样保留的事（都有测试或真机事故在后面撑着）：
 *
 * 1. **贴底才自动滚**。流式生成时字一直在往下长，用户要是往上翻看早先的内容，
 *    每次重绘都把他拽回底部就等于不让人看。
 * 2. **失败的那一轮画红**。以前它什么都不显示，用户以为消息发丢了，只能反复重发。
 * 3. **挡住发送时必须给一条能直接解决问题的路**（`#blocking-settings`）。
 *    只说"到设置里去填"等于把新用户丢在一个需要自己找路的地方。
 * 4. 截图**点一下放大到 200%**：方块只有几个像素，看不清具体放了什么。
 *
 * 这一版新加的几件事，都与"别让对话被噪音淹掉"有关：
 *  - **思维链收成一行**（Codex 式）：一行里滚动显示最新的思考内容，点开才看全文；
 *  - **工具调用的结果折叠**：默认只留"谁被调了"，点开才看返回了什么；
 *  - 每条卡片按角色着色 + 入场动画（见 `styles.css` 的 `.msg.*`）。
 */

export interface ChatPanelProps {
  chat: ChatView | undefined
  state: StudioState | undefined
  /** 一次性提示（导出成功、导入结果、软件视口降级…）。`undefined` = 不显示。 */
  notice: string | undefined
  onNoticeClose: () => void
  onSend: (text: string) => void
  onStop: () => void
  onRecoveryApply: () => void
  onRecoveryDiscard: () => void
  onOpenSettings: () => void
}

export function ChatPanel(props: ChatPanelProps): React.JSX.Element {
  const { chat, state } = props
  const [draft, setDraft] = useState('')
  const messagesRef = useRef<HTMLOListElement>(null)

  // 两道闸叠加：运行中不能发，停在历史版本上也不能发。
  // （`behindTip` 说的是"让模型此时动手，它的第一笔会截断后面的步骤" —— 那是用户的工作）
  const locked = chat?.running === true || state?.behindTip === true

  /** 模型没配好 → 挡住发送。这个状态也要在 DOM 上看得见（见下面 `#blocking` 的注释）。 */
  const blocked = chat !== undefined && chat.blocking.length > 0

  useStickToBottom(messagesRef, chat)

  const submit = (): void => {
    const text = draft.trim()
    if (text.length === 0 || locked) return
    setDraft('')
    props.onSend(text)
  }

  return (
    <div className="chat-column">
      <div className="chat-head">
        <h2 style={{ margin: 0, fontSize: 12, letterSpacing: 0.4 }}>{t('chat.title')}</h2>
        {/* 用量读数**挪到标题右边**：原来它长在输入框下面、占满一整行，而这一行是常驻的。
            数字已经压过（`12k` / `1.2M`），缓存只给百分比——见 `cost.ts` 的 `usageText`。

            它不短：跑久了一行放不下（实测用户那串只比可用宽度多 9px），末尾会被省略号
            收掉，所以带一个原生 `title`——悬停能看到省略的那部分。反过来，标题那头是用
            `flex: none` 钉住的（见 `styles.css` 的 `.chat-head h2`）：要挤就挤这行。 */}
        <span id="chat-usage" className="chat-usage" title={usageText(chat)}>
          {usageText(chat)}
        </span>
      </div>

      {/* 一次性提示（导出成功、导入结果、软件视口降级…）。**不自动消失**——
          它说的多半是"有一件事你需要知道"，值得用户看第二眼。可手动关掉。 */}
      <div id="notice" className={props.notice === undefined ? 'hidden' : undefined}>
        {props.notice !== undefined && (
          <Alert
            type="info"
            banner
            style={{ borderRadius: 0 }}
            message={
              <Flex gap={8} align="flex-start">
                <span style={{ flex: 1, whiteSpace: 'pre-wrap' }}>{props.notice}</span>
                <Button size="small" id="notice-close" onClick={props.onNoticeClose}>
                  ✕
                </Button>
              </Flex>
            }
          />
        )}
      </div>

      {/* 崩溃恢复：草稿等着处理，两个按钮各对应主进程一个真实动作 */}
      <RecoveryBanner state={state} onApply={props.onRecoveryApply} onDiscard={props.onRecoveryDiscard} />

      {/* 停在历史版本上时挡住发送：模型的第一笔改动会从历史分叉，把后面几步截断丢掉 */}
      {state?.behindTip === true && (
        <Alert
          id="behind-tip"
          type="warning"
          showIcon
          banner
          message={t('chat.behindTip')}
          style={{ borderRadius: 0 }}
        />
      )}

      {/* 「模型没配好」：不是一句提示，是**一个能直接解决的入口**。
          和恢复条同理：**没被挡住时也渲染，只是带 `hidden`**——gui-smoke 的
          `blocking-actionable` 断言要判的是"被挡住时那个按钮在不在"。 */}
      <div id="blocking" className={blocked ? undefined : 'hidden'}>
        <Alert
          type="warning"
          showIcon
          banner
          style={{ borderRadius: 0 }}
          message={
            <Flex vertical gap={4} align="flex-start">
              <b>{t('chat.noProvider')}</b>
              <ul style={{ margin: 0, paddingLeft: 18 }}>
                {(chat?.blocking ?? []).map((item) => (
                  <li key={item}>{item}</li>
                ))}
              </ul>
              <Button size="small" id="blocking-settings" onClick={props.onOpenSettings}>
                {t('chat.openSettings')}
              </Button>
            </Flex>
          }
        />
      </div>

      <ol id="messages" className="messages" ref={messagesRef}>
        {(chat?.messages ?? []).map((message) => (
          <Message key={message.id} message={message} />
        ))}
      </ol>

      <form
        className="chat-form"
        onSubmit={(event) => {
          event.preventDefault()
          submit()
        }}
      >
        <Input.TextArea
          id="chat-input"
          rows={3}
          disabled={locked}
          value={draft}
          placeholder={t('chat.placeholder')}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
              event.preventDefault()
              submit()
            }
          }}
        />
        <div className="chat-actions">
          <Button type="primary" size="small" id="btn-send" htmlType="submit" disabled={locked}>
            {t('chat.send')}
          </Button>
          <Button
            size="small"
            id="btn-stop"
            className={chat?.running === true ? undefined : 'hidden'}
            onClick={props.onStop}
          >
            {t('chat.stop')}
          </Button>
        </div>
      </form>
    </div>
  )
}

/**
 * **贴底才自动滚**。
 *
 * 为什么不能只在"消息条数变了"时滚：一条消息**自己长高**的情况一样常见——
 * 流式正文逐字变长、思考内容换行、**截图加载完**都是。实测最明显的是截图：
 * `screenshot` 工具回来后 `<img>` 要等 IPC 取字节 + 解码，列表在这期间被撑高，
 * 而条数没变，于是"贴底"失效，用户得自己往下拖。
 *
 * 所以判据挂在**列表高度**上：`ResizeObserver` 不管是谁把列表撑高的，只要变了就核对一次。
 * `ResizeObserver` 与"条数/正文"两个依赖一起去重（同一个变化可能两条路都触发）。
 */
function useStickToBottom(
  listRef: React.RefObject<HTMLOListElement | null>,
  chat: ChatView | undefined,
): void {
  /** 用户是不是贴在底部。**只在用户自己滚的时候改**——自动滚动不能把自己判成"用户翻上去了"。 */
  const stuck = useRef(true)
  const lastHeight = useRef(0)

  useEffect(() => {
    const list = listRef.current
    if (list === null) return

    /** 贴底时把列表推到底。 */
    const pin = (): void => {
      // 直接写 scrollTop 而不是 scrollIntoView：后者会把**外层**滚动容器也一起动，
      // 而这里只想动消息列表自己。
      list.scrollTop = list.scrollHeight
    }

    /**
     * 这一帧该不该贴底。
     *
     * 判据是"用户当前离底部有多远"，而不是"我们上次是不是贴底"：后者在
     * "内容变高 → 我们还没滚 → 距离变大"这个瞬间会把自己判成不贴底，然后就再也不跟了。
     */
    const nearBottom = (): boolean =>
      list.scrollHeight - list.scrollTop - list.clientHeight < 40

    const onScroll = (): void => {
      // 只有**用户触发**的滚动会走到这里（程序化写 scrollTop 不派发 scroll 事件）
      stuck.current = nearBottom()
    }

    const follow = (): void => {
      if (!stuck.current) return
      pin()
    }

    list.addEventListener('scroll', onScroll, { passive: true })

    const observer = new ResizeObserver(() => {
      if (list.scrollHeight === lastHeight.current) return
      lastHeight.current = list.scrollHeight
      follow()
    })
    // 观察**内容层**：列表本身的高度由 flex 决定，内容变高不一定改变列表自己的尺寸，
    // 但一定会改变它内部那层。所以这里观察第一个子元素之外的做法是观察列表的
    // `scrollHeight` 变化——`ResizeObserver` 在"内容溢出"时也会报，这正是我们要的。
    observer.observe(list)

    // 首帧与每次外部重排之后再核对一次
    follow()

    return () => {
      list.removeEventListener('scroll', onScroll)
      observer.disconnect()
    }
  }, [listRef, chat])

  /**
   * 截图加载完会撑高列表——那一下必须补一次。
   *
   * `ResizeObserver` 其实能覆盖到（列表的滚动尺寸变了），但图片是**异步解码**的，
   * 有些情况下解码完成后不再触发尺寸变化的回调。显式给一个"图都加载完了"的钩子，
   * 比依赖观察器的时序可靠。
   */
  useEffect(() => {
    const list = listRef.current
    if (list === null) return
    let cancelled = false
    const images = [...list.querySelectorAll<HTMLImageElement>('img.shot')]
    if (images.length === 0) return
    const pending = images.filter((img) => !img.complete)
    if (pending.length === 0) return
    const done = (): void => {
      if (cancelled) return
      // 等一帧让布局落定，否则 `scrollHeight` 还是旧的
      requestAnimationFrame(() => {
        if (cancelled) return
        const nearBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 40
        if (nearBottom) list.scrollTop = list.scrollHeight
      })
    }
    for (const img of pending) {
      img.addEventListener('load', done, { once: true })
      img.addEventListener('error', done, { once: true })
    }
    return () => {
      cancelled = true
      for (const img of pending) {
        img.removeEventListener('load', done)
        img.removeEventListener('error', done)
      }
    }
  }, [listRef, chat])
}

/**
 * 一条消息。
 *
 * 三种角色 + 失败/闸门各有配色，见 `styles.css` 里 `.msg.*` 那一组。
 * **颜色本身就是信息**：`user` / `assistant` / `tool` 必须一眼分得开，
 * "这一轮失败了"和"模型说了句话"更不能长得一样。
 */
export function Message({ message }: { message: ChatMessageView }): React.JSX.Element {
  const classes = [
    'msg',
    message.role,
    message.gate === true ? 'gate' : '',
    message.toolOk === false || message.failed === true ? 'bad' : '',
    message.streaming === true ? 'streaming' : '',
  ]
    .filter((name) => name.length > 0)
    .join(' ')

  const who =
    message.failed === true
      ? t('chat.failed')
      : message.gate === true
        ? t('chat.nudge')
        : message.role === 'tool'
          ? `${t('chat.toolCall')} · ${message.toolName ?? ''}`
          : message.role === 'user'
            ? 'you'
            : t('app.name')

  const thinking = message.thinking ?? ''

  return (
    <li className={classes} data-message-id={String(message.id)}>
      <span className="who">{who}</span>

      {/**
       * 工具调用的**参数与返回一起折叠**。
       *
       * 默认只留"谁被调了"（上面那行 `who`）。理由是同一条：参数的 JSON 能有几百
       * 字符（`verify` 的期望列表就是），返回更能有几百行（`get_region` 的 ASCII
       * 平面图）——铺在对话里会把真正的叙述淹掉，而它们平时**不需要看**，排查时才需要。
       *
       * 参数与返回放在**同一个折叠块**里：它们是同一次调用的一体两面，分成两个开关
       * 会让"这一枪到底传了什么、回来什么"要来回点两次。
       */}
      {message.role === 'tool' && (
        <Collapsible
          {...(message.args !== undefined && message.args !== '{}' ? { args: message.args } : {})}
          text={message.toolResult ?? ''}
          /* 头一行摘要（`message.text`）也收进折叠区里。它在卡片上常显的话，
             `verify` 那 4 条 PASS 会占掉 6 行——工具调用在对话里的价值是
             "这一步调了什么"，不是它的返回全文。 */
          preview={message.text}
          label={t('chat.toolResult')}
        />
      )}

      {/* 思维链：**一行**滚动显示最新内容，点开才看全文（Codex 式）。
          还在生成时这一行就是"它还活着"的证据；生成完之后它仍然留着，可以回看。 */}
      {thinking.length > 0 && <ThinkingBlock text={thinking} streaming={message.streaming === true} />}

      {/*
        **模型的回复按 markdown 渲染，用户的原样显示。**
        
        非对称是有理由的：
          - 模型的输出天然是 markdown（标题、列表、表格、`verify` 的 JSON 片段），
            按纯文本铺出来在 330px 宽的栏里很难读——`**粗体**` 带着星号，表格挤成一团；
          - 用户写的是**需求**，不是文档。他自己打的 `*` 或 `1.` 不该被重新排版，
            改写用户的原话是界面能做的最讨厌的事之一。
        
        工具消息走上面的折叠区（等宽文本），这里不掺和。
      */}
      {message.role === 'assistant' && message.text.length > 0 && <Markdown text={message.text} />}
      {message.role === 'user' && message.text.length > 0 && (
        <div className="body">{message.text}</div>
      )}

      {/* 正文一个字都没来、也还没开始思考 = 刚发出请求。这一条必须存在，
          否则用户看到的是"消息发出去了，然后什么都不动"。 */}
      {message.streaming === true && message.text.length === 0 && thinking.length === 0 && (
        <div className="thinking-line plain">{t('chat.thinking')}</div>
      )}

      {message.imageId !== undefined && (
        <Shot
          id={message.imageId}
          alt={`rev ${message.imageRevision ?? '?'} ${message.imageView ?? ''}`}
        />
      )}
    </li>
  )
}

/**
 * 思维链：**一行**预览 + 点开全文。
 *
 * 预览取**最新**的那一截（`tail`），不是开头：思考是一路往下推进的，用户想知道的是
 * "它现在想到哪儿了"。CSS 负责把它压成一行并渐隐（`styles.css` 的 `.thinking-line`）。
 */
export function ThinkingBlock({ text, streaming }: { text: string; streaming: boolean }): React.JSX.Element {
  const [open, setOpen] = useState(false)
  /** 预览窗口取最后一段。太长的话 DOM 里也没必要留，但全文要完整保留给展开。 */
  const tail = text.length > 240 ? text.slice(-240) : text
  return (
    <div className={`thinking${streaming ? ' live' : ''}`}>
      <button type="button" className="thinking-toggle" onClick={() => setOpen((value) => !value)}>
        {open ? <DownOutlined /> : <RightOutlined />}
        <span className="thinking-line" title={open ? undefined : tail}>
          {streaming ? t('chat.thinkingLatest', { text: tail }) : t('chat.thinkingDone', { count: text.length })}
        </span>
      </button>
      {open && <div className="thinking-full">{text}</div>}
    </div>
  )
}

/**
 * 通用折叠块。
 *
 * 空内容时渲染成一条"（空）"——**不渲染成什么都没有**，否则"这一条到底有没有返回"
 * 就看不出来了。
 *
 * `args` 是可选的第二段（工具调用传了什么）。它和 `text` 放在同一个开关下：
 * 两者是同一次调用的一体两面，分成两个开关会让排查要来回点两次。
 */
export function Collapsible({
  text,
  label,
  args,
  preview,
}: {
  text: string
  label: string
  args?: string
  /** 收起时也能看见的一行摘要（工具返回的首行）。不给就什么都不显示。 */
  preview?: string
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const body = text.trim().length > 0 ? text : '—'
  const hasPreview = preview !== undefined && preview.trim().length > 0
  return (
    <div className="collapsible">
      <button type="button" className="collapsible-toggle" onClick={() => setOpen((value) => !value)}>
        {open ? <DownOutlined /> : <RightOutlined />}
        <span>{label}</span>
        {!open && hasPreview && <span className="collapsible-preview">{preview}</span>}
      </button>
      {open && (
        <>
          {args !== undefined && (
            <>
              <div className="collapsible-label">{t('panel.opDetail.args')}</div>
              <pre className="collapsible-body">{args}</pre>
            </>
          )}
          <div className="collapsible-label">{t('panel.opDetail.result')}</div>
          <pre className="collapsible-body">{body}</pre>
        </>
      )}
    </div>
  )
}

/**
 * 对话里的截图。
 *
 * blob URL 按 `imageId` 缓存：同一张图不重复走 IPC，也不重复建 objectURL。
 * 缓存挂在模块上（不是组件里）——消息列表整列重建时组件会被卸载，挂在组件上等于每次都重拉。
 */
const imageUrls = new Map<string, string>()

function Shot({ id, alt }: { id: string; alt: string }): React.JSX.Element {
  const [url, setUrl] = useState<string | undefined>(() => imageUrls.get(id))
  const [zoom, setZoom] = useState(false)

  const load = useCallback(async () => {
    if (imageUrls.has(id)) return
    try {
      const bytes = await window.architect.chatImage(id)
      if (bytes === undefined) return
      const next = URL.createObjectURL(
        new Blob([bytes as unknown as BlobPart], { type: 'image/png' }),
      )
      imageUrls.set(id, next)
      setUrl(next)
    } catch {
      // 截图被缓存淘汰是正常的，静默跳过
    }
  }, [id])

  useEffect(() => {
    void load()
  }, [load])

  if (url === undefined) return <></>
  return (
    <Tooltip title={alt}>
      <img
        className={zoom ? 'shot zoom' : 'shot'}
        src={url}
        alt={alt}
        onClick={() => setZoom((value) => !value)}
      />
    </Tooltip>
  )
}

/**
 * 崩溃恢复的待办条。
 *
 * 为什么不是一句提示：**"上次有 3 步没保存"这件事只有配上动作才有意义**。
 * 基准工程找不到时"恢复"必须是禁用的：没有基准就没法知道该把这些 op 接到哪儿，
 * 硬接出来的世界不会是崩溃前的那个。
 *
 * ⚠️ **没有草稿时也照样渲染，只是带 `hidden`**，而不是 `return <></>`。
 * 这是旧实现刻意的语义（"隐藏只能靠 hidden，不能靠删标记"），而且 gui-smoke 的
 * `recovery-banner` 断言正是按它写的：它判的是"显示与否**跟状态一致**"。
 * 条件渲染会让那条断言失去对象——元素不在时它无从区分"没有草稿"与"这块被删了"。
 */
function RecoveryBanner({
  state,
  onApply,
  onDiscard,
}: {
  state: StudioState | undefined
  onApply: () => void
  onDiscard: () => void
}): React.JSX.Element {
  const recovery = state?.recovery
  return (
    <div
      id="recovery"
      className={recovery === undefined ? 'hidden' : undefined}
      style={{ borderBottom: '1px solid var(--ant-color-border-secondary)' }}
    >
      <Alert
        type="info"
        showIcon
        banner
        style={{ borderRadius: 0 }}
        message={
          <Flex vertical gap={4} align="flex-start">
            <b>{t('recovery.title')}</b>
            <span id="recovery-detail">
              {t('recovery.detail', {
                ops: String(recovery?.ops ?? 0),
                project: recovery?.basePath ?? '—',
              })}
            </span>
            <Flex gap={6}>
              <Button
                size="small"
                id="btn-recover"
                disabled={recovery?.baseExists !== true}
                onClick={onApply}
              >
                {t('recovery.apply')}
              </Button>
              <Button size="small" id="btn-discard-recovery" onClick={onDiscard}>
                {t('recovery.discard')}
              </Button>
            </Flex>
          </Flex>
        }
      />
    </div>
  )
}
