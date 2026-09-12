import { Button, Card, Descriptions, Flex, Input, Select } from 'antd'
import { t } from '@architect/i18n'

import { shortBlock } from '../cost.js'
import type { OpDetailView, StudioState } from '../types.js'

/**
 * 左栏的五个分区：工程 / 机位 / 调色板 / 材质 / 编辑记录。
 *
 * **后三个里有两个是按要求从界面上隐藏的**（机位面板、调色板）。隐藏只靠 `hidden`，
 * 不删标记——元素与接线都还在，去掉一个 class 就能改回可见。理由写在旧标记的注释里，
 * 现在仍然成立：整块注释掉会让几十处引用变成 null 检查。
 *
 * 机位面板里含**「模型用这个机位」**（人机共用机位，D-52）与**编辑模式**开关
 * （调色板那块，它控制视口点击会不会改世界）。两者的入口都在这里。
 */

export interface CameraFields {
  azimuth: string
  elevation: string
  roll: string
  fov: string
  eye: [string, string, string]
  lookAt: [string, string, string]
}

export interface LeftPanelProps {
  state: StudioState | undefined
  /** 机位字段：**单向镜**。相机变就刷新它，但用户正在打字时不刷新（由 App 判断）。 */
  camera: CameraFields
  camMode: 'angle' | 'eye'
  camShared: boolean
  onCamMode: (mode: 'angle' | 'eye') => void
  onCamField: (patch: Partial<CameraFields>) => void
  /** 字段填完（失焦）→ 应用回相机。旧实现是在 `change` 上应用的，语义相同。 */
  onCamCommit: () => void
  onCamApply: () => void
  onCamReset: () => void
  onCamShared: (shared: boolean) => void
  /** 调色板 */
  editMode: boolean
  onEditMode: (on: boolean) => void
  blockQuery: string
  onBlockQuery: (query: string) => void
  blockMatches: string[]
  currentBlock: string
  onSelectBlock: (block: string) => void
  /** 编辑记录 */
  opDetail: OpDetailView | undefined
  onOpenOp: (rev: number) => void
  onCloseOp: () => void
}

export function LeftPanel(props: LeftPanelProps): React.JSX.Element {
  const { state } = props
  const used = state?.histogram ?? []

  return (
    <div className="panel-scroll">
      <Section title={t('panel.project')}>
        <Descriptions
          id="project-info"
          column={1}
          size="small"
          colon={false}
          // antd 5.29 起 `labelStyle` / `contentStyle` 已废弃，改用 `styles`
          styles={{
            label: { color: 'var(--ant-color-text-secondary)', fontSize: 12 },
            content: { fontSize: 12, justifyContent: 'flex-end' },
          }}
          items={projectRows(state)}
        />
      </Section>

      {/* 机位面板：**按要求隐藏**。含「模型用这个机位」（人机共用机位）的入口。 */}
      <Section title={t('viewport.camera')} id="camera-panel" hidden>
        <Flex vertical gap={6} className="camera">
          <Select
            id="cam-mode"
            size="small"
            value={props.camMode}
            onChange={props.onCamMode}
            options={[
              { value: 'angle', label: t('viewport.cam.modeAngle') },
              { value: 'eye', label: t('viewport.cam.modeEye') },
            ]}
          />

          {/* 按角度：方位角 + 仰角 */}
          <div id="cam-angle" className={props.camMode === 'eye' ? 'hidden' : undefined}>
            <div className="cam-grid">
              <NumField
                id="cam-az"
                label={t('viewport.cam.azimuth')}
                value={props.camera.azimuth}
                onChange={(value) => props.onCamField({ azimuth: value })}
              onCommit={props.onCamCommit} />
              <NumField
                id="cam-el"
                label={t('viewport.cam.elevation')}
                value={props.camera.elevation}
                onChange={(value) => props.onCamField({ elevation: value })}
              onCommit={props.onCamCommit} />
            </div>
          </div>

          {/* 按坐标：相机位置 + 注视点 */}
          <div id="cam-eye" className={props.camMode === 'eye' ? undefined : 'hidden'}>
            <span className="cam-label">{t('viewport.cam.eye')}</span>
            <div className="cam-grid three">
              <NumField id="cam-ex" label="X" value={props.camera.eye[0]} onChange={(v) => props.onCamField({ eye: [v, props.camera.eye[1], props.camera.eye[2]] })} onCommit={props.onCamCommit} />
              <NumField id="cam-ey" label="Y" value={props.camera.eye[1]} onChange={(v) => props.onCamField({ eye: [props.camera.eye[0], v, props.camera.eye[2]] })} onCommit={props.onCamCommit} />
              <NumField id="cam-ez" label="Z" value={props.camera.eye[2]} onChange={(v) => props.onCamField({ eye: [props.camera.eye[0], props.camera.eye[1], v] })} onCommit={props.onCamCommit} />
            </div>
            <span className="cam-label">{t('viewport.cam.lookAt')}</span>
            <div className="cam-grid three">
              <NumField id="cam-lx" label="X" value={props.camera.lookAt[0]} onChange={(v) => props.onCamField({ lookAt: [v, props.camera.lookAt[1], props.camera.lookAt[2]] })} onCommit={props.onCamCommit} />
              <NumField id="cam-ly" label="Y" value={props.camera.lookAt[1]} onChange={(v) => props.onCamField({ lookAt: [props.camera.lookAt[0], v, props.camera.lookAt[2]] })} onCommit={props.onCamCommit} />
              <NumField id="cam-lz" label="Z" value={props.camera.lookAt[2]} onChange={(v) => props.onCamField({ lookAt: [props.camera.lookAt[0], props.camera.lookAt[1], v] })} onCommit={props.onCamCommit} />
            </div>
          </div>

          <div className="cam-grid">
            <NumField
              id="cam-roll"
              label={t('viewport.cam.roll')}
              value={props.camera.roll}
              onChange={(value) => props.onCamField({ roll: value })}
            onCommit={props.onCamCommit} />
            <NumField
              id="cam-scale"
              label={t('viewport.cam.scale')}
              value={props.camera.fov}
              onChange={(value) => props.onCamField({ fov: value })}
            onCommit={props.onCamCommit} />
          </div>

          <label className="cam-share">
            <input
              id="cam-share"
              type="checkbox"
              checked={props.camShared}
              onChange={(event) => props.onCamShared(event.target.checked)}
            />
            <span>{t('viewport.cam.share')}</span>
          </label>

          <Flex gap={6}>
            <Button size="small" id="cam-apply" style={{ flex: 1 }} onClick={props.onCamApply}>
              {t('viewport.cam.apply')}
            </Button>
            <Button size="small" id="cam-reset" style={{ flex: 1 }} onClick={props.onCamReset}>
              {t('viewport.cam.reset')}
            </Button>
          </Flex>

          <p className="cam-hint">{t('viewport.cam.hint')}</p>
        </Flex>
      </Section>

      {/* 调色板 / 人手接管：**按要求隐藏**。「编辑模式」这个开关也在这块里——
          隐掉之后视口点击不会改世界（那是这个开关控制的）。元素与接线都还在。 */}
      <Section title={t('panel.palette')} id="palette-panel" hidden>
        <label className="cam-share">
          <input
            id="edit-mode"
            type="checkbox"
            checked={props.editMode}
            onChange={(event) => props.onEditMode(event.target.checked)}
          />
          <span>{t('palette.editMode')}</span>
        </label>
        <p className="cam-hint">{t('palette.hint')}</p>
        <Input
          id="block-search"
          size="small"
          allowClear
          spellCheck={false}
          placeholder={t('palette.search')}
          value={props.blockQuery}
          onChange={(event) => props.onBlockQuery(event.target.value)}
        />
        <ul id="palette-matches" className="palette-list">
          {props.blockMatches.map((name) => (
            <li
              key={name}
              title={name}
              data-block={name}
              className={name === props.currentBlock ? 'active' : undefined}
              onClick={() => props.onSelectBlock(name)}
            >
              {shortBlock(name)}
            </li>
          ))}
        </ul>
        <div className="palette-current">
          <span>{t('palette.current')}</span>
          <b id="palette-current">{props.currentBlock.length > 0 ? shortBlock(props.currentBlock) : '—'}</b>
        </div>
        <ul id="palette-used" className="palette-chips">
          {used.map((entry) => (
            <li
              key={entry.block}
              title={entry.block}
              data-block={entry.block}
              className={entry.block === props.currentBlock ? 'active' : undefined}
              onClick={() => props.onSelectBlock(entry.block)}
            >
              {shortBlock(entry.block)} ·{entry.count}
            </li>
          ))}
        </ul>
      </Section>

      <Section title={t('panel.materials')}>
        {/* 用原生 `ul`/`li` 而不是 antd 的 `List`：`List` 不会把 `id` 落到 DOM 上，
            而 `#histogram` 是 dom-ids 测试盯着的 id 之一。 */}
        <ul id="histogram" className="histogram">
          {used.map((entry) => (
            <li key={entry.block}>
              <span>{entry.block.replace('minecraft:', '')}</span>
              <span>
                {entry.count} · {entry.percent}%
              </span>
            </li>
          ))}
        </ul>
      </Section>

      <Section title={t('panel.ops')}>
        {/* 点一条记录展开它的参数与改动量：排查"模型哪一步改坏了"的入口 */}
        {props.opDetail !== undefined && (
          <OpDetail detail={props.opDetail} onClose={props.onCloseOp} />
        )}
        <ol id="ops" className="ops ops-scroll">
          {(state?.ops ?? [])
            .slice()
            .reverse()
            .map((op) => (
              <li
                key={op.rev}
                className={`op${op.rev === state?.revision ? ' current' : ''}${op.source === 'user' ? ' user' : ''}`}
                data-rev={op.rev}
                title={t('panel.opDetail.hint')}
                onClick={() => props.onOpenOp(op.rev)}
              >
                <span className="rev">{op.rev}</span>
                <b>{op.tool}</b>
                <span>{op.changed}</span>
              </li>
            ))}
        </ol>
      </Section>
    </div>
  )
}

/**
 * 展开一条编辑记录的细节。
 *
 * 参数是**原样的 JSON**（不翻译、不美化过头）：用户在排查"模型这一步到底传了什么"，
 * 把 `args` 改写成人话反而会遮住真相（少了哪个字段、坐标写成了哪个数）。
 */
function OpDetail({
  detail,
  onClose,
}: {
  detail: OpDetailView
  onClose: () => void
}): React.JSX.Element {
  const rows: Array<[string, string]> = [
    [
      t('panel.opDetail.source'),
      detail.source === 'user'
        ? t('panel.opDetail.sourceUser')
        : t('panel.opDetail.sourceLlm'),
    ],
    [t('panel.opDetail.args'), JSON.stringify(detail.args ?? {}).slice(0, 400)],
    [
      t('panel.opDetail.result'),
      t('panel.opDetail.resultLine', {
        changed: detail.result.changed,
        overwritten: detail.result.overwrittenNonAir,
        clipped: detail.result.clipped,
      }),
    ],
  ]
  return (
    <div id="op-detail" className="op-detail">
      <b>{t('panel.opDetail.title', { rev: detail.rev, tool: detail.tool })}</b>
      <Button size="small" id="op-detail-close" onClick={onClose} style={{ float: 'right' }}>
        ✕
      </Button>
      <dl>
        {rows.map(([key, value]) => (
          <div key={key} style={{ display: 'contents' }}>
            <dt>{key}</dt>
            <dd>{value}</dd>
          </div>
        ))}
      </dl>
    </div>
  )
}

/**
 * 工程信息。
 *
 * **只留"这是什么工程、走到第几步、有多少方块"。** 调色板条目数、Minecraft 版本、
 * 包围盒、模型机位、纹理来源五行按要求**移除**了：它们是诊断信息，不是设计时要看的
 * 东西，常驻在左栏只是噪音。数据仍在 `StudioState` 上（`paletteSize` /
 * `minecraftVersion` / `bounds` / `camera` / `texture`），要恢复就是往这个数组里加回一行。
 */
function projectRows(state: StudioState | undefined): Array<{ key: string; label: string; children: string }> {
  if (state === undefined) return []
  const rows: Array<{ key: string; label: string; children: string }> = [
    { key: 'name', label: t('panel.info.name'), children: state.name },
    { key: 'revision', label: t('panel.info.revision'), children: `${state.revision} / ${state.totalOps}` },
    { key: 'blocks', label: t('panel.info.blocks'), children: String(state.blocks) },
  ]
  if (state.projectPath !== undefined) {
    rows.push({
      key: 'file',
      label: t('panel.info.file'),
      children: state.projectPath.split(/[/\\]/).pop() ?? '',
    })
  }
  return rows
}

function NumField({
  id,
  label,
  value,
  onChange,
  onCommit,
}: {
  id: string
  label: string
  value: string
  onChange: (value: string) => void
  onCommit?: () => void
}): React.JSX.Element {
  return (
    <label className="cam-field">
      <span>{label}</span>
      <Input
        id={id}
        size="small"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        // **填完才算数**：回车提交，或点下面的「应用」。
        //
        // 刻意**不用 `onBlur`**：自动化里给这些字段补 `blur` 事件会把应用之外的
        // 东西一起带出来（实测派发 blur 之后游标自己退到了 rev 7、界面弹出一条
        // "正在看历史版本"）。回头查这个不值得——`change`/回车/按钮三条路已经够
        // 覆盖用户真实操作，而"每次输入都应用"会把半填好的状态写回输入框
        // （见 app.tsx 里 `onCamField` 的注释）。
        onPressEnter={onCommit}
      />
    </label>
  )
}

/** 一个分区。`hidden` 只加 class，不删内容（见文件头注释）。 */
function Section({
  title,
  id,
  hidden,
  children,
}: {
  title: string
  id?: string
  hidden?: boolean
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <Card
      id={id}
      className={hidden === true ? 'hidden' : undefined}
      size="small"
      variant="borderless"
      title={title.toUpperCase()}
      styles={{ header: { borderBottom: '1px solid var(--ant-color-border-secondary)' } }}
    >
      {children}
    </Card>
  )
}
