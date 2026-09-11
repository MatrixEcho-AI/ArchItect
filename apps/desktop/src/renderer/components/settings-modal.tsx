import { useEffect, useState } from 'react'
import { Button, Flex, Input, InputNumber, Modal, Select, Typography } from 'antd'
import { t } from '@architect/i18n'

import type { DiscoveryResult, ProviderView, SettingsView } from '../types.js'
import type { Locale } from '@architect/i18n'
import type { MessageKey } from '@architect/i18n'

/**
 * 设置对话框。**密钥只写不读**（D-13 / §13.3）：
 *
 * 输入框永远是空的，`placeholder` 只说明"已经有 key 了"或"从哪个环境变量读"。
 * 没有任何一条 IPC 通道能把明文读回来——所以这里连"回显已保存的 key"这条路都不存在，
 * 不是"没做"。
 *
 * 另一个保留：**探针（测试连接）的结果是人能读的一段文本**，不是几个对勾。
 * 它要回答的是"到底哪一步不对"（列不出模型？不吃图？工具调用不支持？），
 * 而"失败"两个字回答不了这个问题。
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
  onStatus: (key: MessageKey) => void
}

export function SettingsModal(props: SettingsModalProps): React.JSX.Element {
  const { settings } = props
  const [baseURL, setBaseURL] = useState('')
  const [model, setModel] = useState('')
  const [keyPlain, setKeyPlain] = useState('')
  const [usd, setUsd] = useState<number | null>(null)
  const [turns, setTurns] = useState<number | null>(null)
  const [locale, setLocale] = useState<Locale>('zh-CN')
  const [probe, setProbe] = useState('')

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

  const runProbe = async (listOnly: boolean): Promise<void> => {
    if (editing === undefined) return
    const { config, plain } = collectConfig()
    setProbe(t('settings.llm.testing'))
    try {
      const result: DiscoveryResult = await window.architect.testConnection({
        preset: editing.preset,
        baseURL: config['baseURL'],
        model: config['model'],
        apiKeyRef: config['apiKeyRef'],
        ...(plain !== undefined ? { apiKeyPlain: plain } : {}),
        listOnly,
      })
      setProbe(describeProbe(result))
      // 探针挑出来的模型写回输入框——用户不用手抄
      if (result.config.model.length > 0) setModel(result.config.model)
      /**
       * **把量出来的能力同步回界面**。
       *
       * 主进程在 `testConnection` 里已经把 `result.config.capabilities` 写回设置并落盘，
       * 但这里的 `editing` 还是探测前那一份快照；而「应用」按钮走的 `collectConfig()`
       * 恰恰读的是 `editing.capabilities`。不同步的话，点一下应用就把刚探到的
       * `vision: true` 又用旧的 `false` 盖回去——图会再次被静默丢掉。
       */
      props.onSaved(await window.architect.settings())
    } catch (error) {
      setProbe(error instanceof Error ? error.message : String(error))
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
                const budget: Record<string, number> = {}
                if (usd !== null && Number.isFinite(usd) && usd > 0) budget['maxUsd'] = usd
                if (turns !== null && Number.isFinite(turns) && turns > 0) budget['maxTurns'] = turns
                const next = await window.architect.setBudget(
                  Object.keys(budget).length > 0 ? budget : undefined,
                )
                props.onSaved(next)
                setKeyPlain('')
                props.onStatus('settings.llm.saved')
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
                    setProbe(t('settings.llm.testing'))
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

        <div style={{ borderTop: '1px solid var(--ant-color-border-secondary)', paddingTop: 8 }}>
          <Flex gap={6}>
            <Button size="small" id="btn-test" onClick={() => void runProbe(false)}>
              {t('settings.llm.test')}
            </Button>
            <Button size="small" id="btn-test-list" onClick={() => void runProbe(true)}>
              {t('settings.llm.listOnly')}
            </Button>
          </Flex>
          <pre id="probe-log" className="probe-log">
            {probe}
          </pre>
          <Typography.Text type="secondary" style={{ fontSize: 11.5 }}>
            {t('settings.llm.capabilitySource')}
          </Typography.Text>
        </div>
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

/**
 * 把探针的每一步摊成人能读的一段话。
 *
 * 刻意**不做成对勾列表**：用户要回答的是"到底哪一步不对"，而每个失败都带着原始错误。
 */
function describeProbe(result: DiscoveryResult): string {
  const lines: string[] = []
  for (const step of result.steps) {
    switch (step.type) {
      case 'models':
        lines.push(t('settings.llm.discovered', { count: step.count }))
        for (const model of step.models) lines.push(`    ${model}`)
        break
      case 'model':
        lines.push(
          `${t('settings.llm.model')}: ${step.model}` +
            (step.matched !== undefined ? `  (${step.matched})` : step.guessed === true ? '  (?)' : ''),
        )
        break
      case 'text':
        lines.push(step.ok ? `text ok (${step.tokensIn} in)` : `text failed: ${step.error}`)
        break
      case 'tools':
        lines.push(`tool calling: ${step.mode}`)
        break
      case 'vision':
        lines.push(
          step.vision
            ? `${t('settings.llm.vision')}: ${t('settings.llm.yesVision')}` +
                (step.imageTokenCost !== undefined
                  ? `  ${t('settings.llm.imageTokenCost')} ≈ ${step.imageTokenCost}`
                  : '')
            : `${t('settings.llm.vision')}: ${t('settings.llm.noVision')} — ${step.error ?? ''}`,
        )
        break
      case 'error':
        lines.push(`! ${step.error}`)
        break
      case 'capabilities':
        lines.push('')
        lines.push(
          `source: ${step.capabilities.source}   promptCache: ${step.capabilities.promptCache}`,
        )
        if (step.capabilities.contextWindow !== undefined) {
          lines.push(`${t('settings.llm.contextWindow')}: ${step.capabilities.contextWindow}`)
        }
        break
      default:
        break
    }
  }
  lines.push('')
  lines.push(result.ok ? 'OK' : `FAILED: ${result.error ?? ''}`)
  return lines.join('\n')
}
