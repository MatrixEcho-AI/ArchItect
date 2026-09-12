import { useEffect, useState } from 'react'
import { Button, Flex, Input, InputNumber, Modal, Select, Typography } from 'antd'
import { t } from '@architect/i18n'

import type { ProviderView, SettingsView } from '../types.js'
import type { Locale } from '@architect/i18n'
import type { MessageKey } from '@architect/i18n'

/**
 * 设置对话框。**密钥只写不读**（D-13 / §13.3）：
 *
 * 输入框永远是空的，`placeholder` 只说明"已经有 key 了"或"从哪个环境变量读"。
 * 没有任何一条 IPC 通道能把明文读回来——所以这里连"回显已保存的 key"这条路都不存在，
 * 不是"没做"。
 *
 * **这里没有"测试连接"，也没有探针日志**（用户定的）：接口地址、模型名、能不能吃图
 * 那一堆是**维护这个程序的人**要看的，不是设置模型的人要看的。要看那本日志有 CLI：
 * `architect providers`（见 `cli.providers.*` 与 `packages/cli`）。
 *
 * 但探针**本身**不能一起删掉：它是唯一会写回「模型名」和「vision」的地方
 * （`ChatController.testConnection` 那段写回），而 `vision` 是决定图发不发给模型的
 * 唯一开关。没有按钮还调不到它的话，新用户填完地址保存后会永远卡在
 * "还没选定模型"，而且附图会被静默丢掉。所以「应用」时自己补一次，见下面
 * `runProbe` 的调用点——**那条调用是这个对话框里唯一不可省的一步**。
 */

const PRESETS = ['deepseek', 'openai', 'ollama', 'custom'] as const

export interface SettingsModalProps {
  open: boolean
  settings: SettingsView | undefined
  /** 当前正在编辑的 provider id。`undefined` = 跟着 `activeId` 走。 */
  activeId: string | undefined
  onActiveId: (id: string) => void
  onClose: () => void
  /** 让 `App` 统一处理"写回 + 刷新 + 状态行"这三件事。 */
  onSaved: (next: SettingsView) => void
  /**
   * 让 `App` 写一行状态。**带参数**，因为"挑了哪个模型"这条必须说出模型名——
   * 只说"发现 1 个可用模型"等于没说。
   */
  onStatus: (key: MessageKey, params?: Record<string, string>) => void
}

export function SettingsModal(props: SettingsModalProps): React.JSX.Element {
  const { settings } = props
  const [baseURL, setBaseURL] = useState('')
  const [model, setModel] = useState('')
  const [keyPlain, setKeyPlain] = useState('')
  const [usd, setUsd] = useState<number | null>(null)
  const [turns, setTurns] = useState<number | null>(null)
  const [locale, setLocale] = useState<Locale>('zh-CN')

  const target =
    props.activeId !== undefined && settings?.providers.some((p) => p.id === props.activeId) === true
      ? props.activeId
      : settings?.activeId
  const editing: ProviderView | undefined = settings?.providers.find((p) => p.id === target)

  // 换了 provider / 打开对话框 → 把字段刷成那一个的值。**key 一律清空**。
  useEffect(() => {
    if (!props.open || settings === undefined) return
    setBaseURL(editing?.baseURL ?? '')
    setModel(editing?.model ?? '')
    setKeyPlain('')
    setUsd(settings.budget?.maxUsd ?? null)
    setTurns(settings.budget?.maxTurns ?? null)
    setLocale(settings.locale)
  }, [props.open, target, settings, editing])

  const presetLabel = (preset: string): string => t(`settings.presets.${preset}` as MessageKey)

  const collectConfig = (): { config: Record<string, unknown>; plain?: string } => {
    const config: Record<string, unknown> = {
      id: editing?.id ?? 'custom',
      preset: editing?.preset ?? 'custom',
      kind: editing?.kind ?? 'openai-compatible',
      baseURL: baseURL.trim(),
      apiKeyRef: editing?.apiKeyRef ?? '',
      model: model.trim(),
      capabilities: editing?.capabilities ?? {
        vision: false,
        toolCalling: 'native',
        promptCache: 'none',
        source: 'preset',
      },
    }
    if (editing?.cost !== undefined) config['cost'] = editing.cost
    return keyPlain.trim().length > 0 ? { config, plain: keyPlain } : { config }
  }

  /**
   * 探测当前正在编辑的这个 provider，把结果落回设置。
   *
   * 两件事一起做，缺一不可：
   *
   * 1. **写回模型名**。`testConnection` 会在模型名为空时从 `GET /models` 挑一个
   *    （`discoverProvider` 的 `model` 步骤），这条是把挑出来的那个填回输入框，
   *    用户不用手抄。
   * 2. **写回能力**。主进程在 `testConnection` 里已经把 `result.config.capabilities`
   *    写进设置并落盘，但这里的 `editing` 还是探测前那份快照，而「应用」走的
   *    `collectConfig()` 恰恰读 `editing.capabilities`。所以探测完必须重新拉一次
   *    `settings()` 把快照换掉——否则点「应用」会用旧的 `vision: false` 盖掉刚探到的
   *    `vision: true`，图就又静默丢了。这条踩过一次。
   *
   * 返回挑出来的模型名（空串表示没挑到，例如端点不可达）。
   */
  const probeCurrent = async (): Promise<string> => {
    if (editing === undefined) return ''
    const { config, plain } = collectConfig()
    try {
      const result = await window.architect.testConnection({
        preset: editing.preset,
        baseURL: config['baseURL'],
        model: config['model'],
        apiKeyRef: config['apiKeyRef'],
        ...(plain !== undefined ? { apiKeyPlain: plain } : {}),
      })
      if (result.config.model.length > 0) setModel(result.config.model)
      props.onSaved(await window.architect.settings())
      return result.config.model
    } catch {
      /**
       * 探测失败**不拦着保存**：地址写错了也要能先把配置存下来，而失败的原因会在
       * 对话面板那条"挡住发送"的横幅里显示（`ChatController.blocking()` 读的是同一份
       * 配置）。这里只负责不让异常冒到 React 外面。
       *
       * 失败时模型名多半还是空的，调用方据此给一条能看懂的状态——那是这里唯一
       * 需要说话的地方，因为对话框里已经没有探针日志了。
       */
      return ''
    }
  }

  return (
    <Modal
      open={props.open}
      title={t('settings.title')}
      onCancel={props.onClose}
      width={720}
      destroyOnHidden
      footer={
        <Flex justify="flex-end" gap={8}>
          <Button id="btn-settings-cancel" onClick={props.onClose}>
            {t('settings.cancel')}
          </Button>
          <Button
            type="primary"
            id="btn-settings-save"
            onClick={() => {
              void (async () => {
                const { config, plain } = collectConfig()
                await window.architect.saveProvider(config, plain)
                /**
                 * **先探测，再把预算写下去**——顺序反了的话，`setBudget` 末尾那次
                 * `onSaved` 会拿着探测前的快照刷新界面，`vision` 又被盖回旧值。
                 */
                const chosen = await probeCurrent()
                const budget: Record<string, number> = {}
                if (usd !== null && Number.isFinite(usd) && usd > 0) budget['maxUsd'] = usd
                if (turns !== null && Number.isFinite(turns) && turns > 0) budget['maxTurns'] = turns
                const next = await window.architect.setBudget(
                  Object.keys(budget).length > 0 ? budget : undefined,
                )
                props.onSaved(next)
                setKeyPlain('')
                // 挑到模型就说挑到了哪一个；没挑到就是没接上，说清楚，别让用户以为配好了
                props.onStatus(
                  chosen.length > 0 ? 'settings.llm.chosen' : 'settings.llm.notChosen',
                  { model: chosen },
                )
                props.onClose()
              })()
            }}
          >
            {t('settings.apply')}
          </Button>
        </Flex>
      }
    >
      <Flex vertical gap={8}>
        <Row label={t('settings.activeProvider')}>
          <Select
            id="provider-select"
            style={{ flex: 1 }}
            value={target}
            onChange={(id: string) => {
              props.onActiveId(id)
              void window.architect.setActive(id).then(props.onSaved)
            }}
            options={(settings?.providers ?? []).map((provider) => ({
              value: provider.id,
              label: `${provider.id}  ·  ${presetLabel(provider.preset)}`,
            }))}
          />
          <Button
            size="small"
            danger
            id="btn-remove-provider"
            disabled={editing === undefined}
            onClick={() => {
              if (editing === undefined) return
              void window.architect.removeProvider(editing.id).then((next) => {
                props.onActiveId('')
                props.onSaved(next)
              })
            }}
          >
            {t('settings.removeProvider')}
          </Button>
        </Row>

        <Row label={t('settings.addProvider')}>
          <span id="preset-row" style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            {PRESETS.map((preset) => (
              <Button
                key={preset}
                size="small"
                onClick={() => {
                  void window.architect.addProvider(preset).then((view) => {
                    props.onActiveId(view.activeId)
                    props.onSaved(view)
                  })
                }}
              >
                {presetLabel(preset)}
              </Button>
            ))}
          </span>
        </Row>

        <Row label={t('settings.llm.baseURL')}>
          <Input
            id="cfg-baseurl"
            spellCheck={false}
            value={baseURL}
            onChange={(event) => setBaseURL(event.target.value)}
          />
        </Row>

        <Row label={t('settings.llm.apiKey')}>
          <Input.Password
            id="cfg-key"
            autoComplete="off"
            spellCheck={false}
            value={keyPlain}
            placeholder={
              editing?.hasKey === true
                ? t('settings.llm.keyPresent')
                : editing?.envName !== undefined
                  ? `env:${editing.envName}`
                  : ''
            }
            onChange={(event) => setKeyPlain(event.target.value)}
          />
        </Row>

        <Row label={t('settings.llm.model')}>
          <Input
            id="cfg-model"
            spellCheck={false}
            value={model}
            onChange={(event) => setModel(event.target.value)}
          />
        </Row>

        <Typography.Text type="secondary" style={{ fontSize: 11.5 }}>
          {t('settings.llm.keyNote')}
        </Typography.Text>

        <Row label={t('settings.budget')}>
          <InputNumber
            id="cfg-usd"
            min={0}
            step={0.5}
            placeholder="USD"
            style={{ width: 100 }}
            value={usd}
            onChange={setUsd}
          />
          <InputNumber
            id="cfg-turns"
            min={1}
            step={1}
            placeholder="turns"
            style={{ width: 100 }}
            value={turns}
            onChange={setTurns}
          />
          <label htmlFor="cfg-locale" style={{ color: 'var(--ant-color-text-secondary)' }}>
            {t('settings.language')}
          </label>
          <Select
            id="cfg-locale"
            style={{ width: 130 }}
            value={locale}
            onChange={(next: Locale) => {
              setLocale(next)
              void window.architect.setLocale(next).then(props.onSaved)
            }}
            options={[
              { value: 'zh-CN', label: '中文' },
              { value: 'en-US', label: 'English' },
            ]}
          />
        </Row>
      </Flex>
    </Modal>
  )
}

function Row({
  label,
  children,
}: {
  label: string
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <Flex align="center" gap={8}>
      <span
        style={{
          width: 92,
          flex: 'none',
          color: 'var(--ant-color-text-secondary)',
          fontSize: 12,
        }}
      >
        {label}
      </span>
      {children}
    </Flex>
  )
}
