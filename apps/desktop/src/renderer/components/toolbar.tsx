import { Button, Flex, Tooltip } from 'antd'
import {
  ExportOutlined,
  FolderOpenOutlined,
  ImportOutlined,
  PlusOutlined,
  RedoOutlined,
  SaveOutlined,
  SettingOutlined,
  UndoOutlined,
} from '@ant-design/icons'
import { t } from '@architect/i18n'

import type { StudioState } from '../types.js'
import type { MessageKey } from '@architect/i18n'

/**
 * 顶栏。**八个图标按钮，没有文字**：
 * 新建 │ 打开 │ 保存 ‖ 撤销 │ 重做 ‖ 导出 │ 导入 ……设置。
 *
 * 这是个**纯展示组件**：所有动作由 `App` 通过 props 传进来。这样做的理由是
 * "按一下会发生什么"集中在一处，而不是散在八个按钮的 `onClick` 里。
 *
 * 四件事按用户要求改了，改法都写在这儿：
 *
 * 1. **文字改成图标**。按钮上不再有字，所以**每个都必须有 Tooltip**——图标认不出来
 *    的时候，悬停是唯一的解释来源。`aria-label` 也一起给上（不只为了无障碍，
 *    自动化抓元素时它比图标好认）。
 * 2. **「机位」下拉与「生成示例」已移除**（代码注释在下面）。理由分别是：
 *    机位那条路现在由视口直接操作（WASD / 拖动 / 双击回自动取景），下拉框是重复入口；
 *    示例工程在界面上就没有入口了（`--demo` 那条诊断路径还在）。
 * 3. 底色换成极淡的浅蓝，在 `theme.ts` 的 `Layout.headerBg` 里。
 * 4. **「设置」从隐藏改回可见，并用齿轮图标放到右上角**（`#btn-settings`）。
 *    "配置模型 API"此前只能从对话里那条"还没配模型"的横幅进，等于没配过的人
 *    才有入口、配过的人反而找不到。
 *
 * 三个**隐藏但保留**的元素照旧，它们不是残留（`dom-ids` 测试都盯着）：
 * `#cost`（成本读数，写入点仍在）、`#status`（渲染进程里唯一读得到的相机快照，
 * gui-smoke 的 wasd-move / space-shift-vertical / 拖动方向三条断言读的就是它）、
 * 以及左栏的机位面板与调色板。
 */
export interface ToolbarProps {
  state: StudioState | undefined
  /** 成本 / 缓存命中读数。**元素隐藏**，但内容照旧在写。 */
  costText: string
  /** 一行状态文字。**元素隐藏**，但它是 gui-smoke 读相机快照的唯一入口。 */
  statusText: string
  onNew: () => void
  onOpen: () => void
  onSave: () => void
  onExport: () => void
  onImport: () => void
  onUndo: () => void
  onRedo: () => void
  onOpenSettings: () => void
}

export function Toolbar(props: ToolbarProps): React.JSX.Element {
  const { state, costText, statusText } = props
  const busy = state === undefined
  return (
    <Flex align="center" gap={4} style={{ height: '100%' }}>
      <span style={{ fontWeight: 700, letterSpacing: 0.5, marginRight: 8 }}>{t('app.name')}</span>

      <IconButton id="btn-new" label="menu.new" disabled={busy} onClick={props.onNew} icon={<PlusOutlined />} />
      <IconButton id="btn-open" label="menu.open" disabled={busy} onClick={props.onOpen} icon={<FolderOpenOutlined />} />
      <IconButton id="btn-save" label="menu.save" disabled={busy} onClick={props.onSave} icon={<SaveOutlined />} />

      <Divider />

      <IconButton
        id="btn-undo"
        label="menu.undo"
        tip="menu.undoTitle"
        disabled={state?.canUndo !== true}
        onClick={props.onUndo}
        icon={<UndoOutlined />}
      />
      <IconButton
        id="btn-redo"
        label="menu.redo"
        tip="menu.redoTitle"
        disabled={state?.canRedo !== true}
        onClick={props.onRedo}
        icon={<RedoOutlined />}
      />

      <Divider />

      <IconButton id="btn-export" label="menu.export" disabled={busy} onClick={props.onExport} icon={<ExportOutlined />} />
      <IconButton id="btn-import" label="menu.import" disabled={busy} onClick={props.onImport} icon={<ImportOutlined />} />

      {/* ── 已按要求移除，但代码与接线都留着（恢复只需取消注释）────────────────────

          **机位下拉**：视口本身就能改机位（WASD / 拖动 / 滚轮 / 双击回自动取景），
          下拉框是第二个入口。注意 `#view` 恢复时还要一并恢复 `App` 里的 `view` 状态
          与 `setSessionView` 调用。

      <label htmlFor="view" style={{ color: 'var(--ant-color-text-secondary)' }}>
        {t('viewport.camera')}
      </label>
      <Select
        id="view"
        size="small"
        value={view}
        style={{ width: 150 }}
        onChange={props.onViewChange}
        options={VIEW_OPTIONS.map((option) => ({ value: option.value, label: t(option.key) }))}
      />

      <Divider />

          **生成示例**：界面上**已经没有这个入口了**（欢迎提示里那句指引也一并删了，
          因为它指向的就是这个按钮）。`StudioService.demo()` 与 `studio:demo` 通道
          都还在，`--demo` 诊断开关也用着它——所以恢复时只需要把这个按钮加回来，
          再把 `viewport.empty` 的文案改回去。

      <IconButton id="btn-demo" label="menu.demo" disabled={busy} onClick={props.onDemo} icon={<AppstoreAddOutlined />} />

      ────────────────────────────────────────────────────────────────────────── */}

      <span style={{ flex: 1 }} />

      {/* 成本 / 缓存命中读数：**隐藏**。写入点仍在（`costText`）；
          给人看的那一行读数已经挪到「对话」标题右边（见 `chat-panel.tsx`）。 */}
      <span
        id="cost"
        className="hidden"
        style={{ color: 'var(--ant-color-warning)', whiteSpace: 'nowrap' }}
      >
        {costText}
      </span>

      {/* 设置入口：**回到可见**，而且搬到右上角。
          它与左边那组"文件/编辑"按钮不同类——那是改工程的，这是配应用自身的，
          所以中间用 `flex: 1` 撑开、单独靠右（放在两个隐藏块之后，才是真的贴右边缘）。
          按钮是**齿轮图标**（`SettingOutlined`），按规定不再带文字，
          Tooltip + `aria-label` 用 `menu.settings` 兜底。
          `#btn-settings` 这个 id 留着：`#blocking-settings`（对话里没配模型时的横幅）
          打开的是同一个对话框。 */}
      <IconButton
        id="btn-settings"
        label="menu.settings"
        onClick={props.onOpenSettings}
        icon={<SettingOutlined />}
      />

      {/* 状态行：**隐藏**。同时它是渲染进程里唯一能读到的相机快照——
          gui-smoke 的 WASD / 空格 / 拖动方向断言都读它，所以不能删。 */}
      <span
        id="status"
        className="hidden"
        style={{ minWidth: 160, textAlign: 'right', whiteSpace: 'nowrap' }}
      >
        {statusText}
      </span>
    </Flex>
  )
}

/**
 * 一个图标按钮。
 *
 * `label` 同时用作 Tooltip 文案与 `aria-label`；`tip` 给"有更详细说明"的那两个
 * （撤销 / 重做带了快捷键）用，不给就用 `label`。
 */
function IconButton({
  id,
  label,
  tip,
  disabled,
  onClick,
  icon,
}: {
  id: string
  label: MessageKey
  tip?: MessageKey
  disabled?: boolean
  onClick: () => void
  icon: React.ReactNode
}): React.JSX.Element {
  const text = t(label)
  return (
    <Tooltip title={t(tip ?? label)}>
      <Button
        size="small"
        id={id}
        disabled={disabled}
        onClick={onClick}
        icon={icon}
        aria-label={text}
      />
    </Tooltip>
  )
}

function Divider(): React.JSX.Element {
  return (
    <span
      style={{
        width: 1,
        height: 18,
        background: 'var(--ant-color-border)',
        margin: '0 6px',
        flex: 'none',
      }}
    />
  )
}
