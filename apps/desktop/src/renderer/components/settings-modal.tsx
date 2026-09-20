import { useEffect, useRef, useState } from 'react'
import { Button, Flex, Input, InputNumber, Modal, Select, Typography } from 'antd'
import { DownOutlined, PlusOutlined, RightOutlined } from '@ant-design/icons'
import { getLocale, normalizeLocale, t } from '@architect/i18n'

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
 * ## 版式：左边菜单 + 右边内容
 *
 * 两个栏目：**通用**（语言）与**模型**（provider 列表）。菜单顺序是用户定的
 * （通用在前），但**默认落页是模型**——gui-smoke 点开设置后要立刻看到 provider
 * 列表，而"挡住发送"的横幅那条路进来的人也是为了配模型。通用离他一次点击。
 *
 * ## 为什么是"列表 + 展开编辑"而不是一个下拉框
 *
 * 以前这里是「当前模型」下拉 + 一排字段：所有 provider 挤在同一个表单里，切一下
 * 下拉就把当前那份覆盖掉，而**没有任何地方能看到"我一共有哪几个"**。用户拿
 * DeepSeek harness 的模型配置对照过来，要的是那种：一行一个 provider、各自带
 * 状态点、各自「编辑」。
 *
 * 所以现在分两块：
 * - **列表**：每个 provider 一行，显示 id、预设、状态、当前模型；点「编辑」才展开表单。
 * - **表单**：只属于那一个 provider，底下还压着「自定义设置」（地址、模型名、
 *   按模型的价格表、用量上限）。
 *
 * "当前在用哪一个"是列表里的**状态**（绿点 + 「使用中」），不是保存时顺手改的东西——
 * 想换就点那一行的「使用」。
 *
 * ## 探针
 *
 * 这里没有"测试连接"按钮，也没有探针日志（用户定的）：那是给维护这个程序的人看的，
 * CLI 有 `architect providers`。但探针本身不能一起删——它是唯一会写回「模型名」与
 * `vision` 的地方，而 `vision` 决定图发不发给模型。所以「保存」时自己补一次，
 * 见下面 `probeCurrent`。
 */

/** 栏目。顺序即菜单顺序：通用在前，模型第二。 */
type SettingsSection = 'general' | 'model'

const SECTIONS = [
  { key: 'general', label: 'settings.menu.general' },
  { key: 'model', label: 'settings.menu.model' },
] as const satisfies ReadonlyArray<{ key: SettingsSection; label: MessageKey }>

/** 内置预设**只剩 DeepSeek**（OpenAI / Ollama 删了，要连它们就用"添加自定义提供方"）。 */
const BUILTIN_PRESETS = ['deepseek'] as const

/** 价格表的币种。**每个 provider 只配一次**，三个价格数字共用它。 */
const CURRENCIES = ['CNY', 'USD', 'EUR'] as const

export interface SettingsModalProps {
  open: boolean
  settings: SettingsView | undefined
  /** 要展开编辑哪一个。`undefined` = 不展开。 */
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

/**
 * 价格表里的一行。model 是键，其余三个是每 1M token 的美元价。
 *
 * 用字符串存而不是数字：`InputNumber` 清空时给的是 `null`，而"用户正在改"的中间
 * 状态（空着、只填了输入价）必须能原样留在界面上——转成数字就会把它变成 0，
 * 于是 `{inPerMTok: 0, outPerMTok: 0}` 这种"免费"的价格表被写进文件。
 */
interface CostRow {
  model: string
  inPerMTok: string
  outPerMTok: string
  cacheReadPerMTok: string
}

export function SettingsModal(props: SettingsModalProps): React.JSX.Element {
  const { settings } = props
  const [keyPlain, setKeyPlain] = useState('')
  // 与 `main.tsx` 同一个理由：这一帧还没读到设置，先跟着系统走，别闪一下错的语言
  const [locale, setLocale] = useState<Locale>(normalizeLocale(navigator.language) ?? getLocale())
  const [showAdvanced, setShowAdvanced] = useState(false)
  /** 当前栏目。**默认通用**（用户定的）：外观与语言这种"软"设置放第一眼，模型配置在第二页。 */
  const [section, setSection] = useState<SettingsSection>('general')

  /** 表单里可编辑的那几项。其余（capabilities / compat / kind）保存时从 `editing` 原样带上。 */
  const [form, setForm] = useState<{
    id: string
    preset: string
    baseURL: string
    model: string
    models: string[]
    currency: string
    costs: CostRow[]
  }>({ id: '', preset: 'custom', baseURL: '', model: '', models: [], currency: 'USD', costs: [] })

  const editing: ProviderView | undefined = settings?.providers.find((p) => p.id === props.activeId)
  const activeId = settings?.activeId

  /**
   * 栏目只在「打开」这一跳上重置回「通用」。
   *
   * ⚠️ 不能塞进下面那个 effect：它的依赖里有 `activeId` 与 `editing`——
   * 点「编辑」换个展开项会把它整个重跑，用户就被从模型页踢回通用页
   * （gui-smoke 的 settings-provider-form 就是这么红的）。
   */
  const wasOpen = useRef(false)
  useEffect(() => {
    if (props.open && !wasOpen.current) setSection('general')
    wasOpen.current = props.open
  }, [props.open])

  // 展开的那一个变了 / 对话框打开 → 把字段刷成它的值。**key 一律清空**。
  useEffect(() => {
    if (!props.open || settings === undefined) return
    setKeyPlain('')
    setLocale(settings.locale)
    setShowAdvanced(false)
    setForm({
      id: editing?.id ?? '',
      preset: editing?.preset ?? 'custom',
      baseURL: editing?.baseURL ?? '',
      model: editing?.model ?? '',
      models: modelIdsOf(editing),
      currency: currencyOf(editing),
      costs: costRowsOf(editing),
    })
  }, [props.open, props.activeId, settings, editing])

  const presetLabel = (preset: string): string => t(`settings.presets.${preset}` as MessageKey)

  /**
   * 界面上这几项 → 一份完整的 provider 配置。
   *
   * **只放有值的键**，不要写 `costs: undefined` 这种自有属性：这份对象会经 IPC
   * 合并进主进程里那一份，而 `{...config, costs: undefined}` 是**覆盖**，不是忽略——
   * 磁盘上刚配好的价格表会在"打开对话框、什么都没改、再点一次保存"之后消失。
   * 这条在真机上量到过（界面读回来 `costs` 是空的，而文件里明明是好的）。
   *
   * 形状上只写文件里那个 `cost`（见 `parseProvider`：两种写法同名、靠形状区分），
   * 内存里的 `costs` 是解析与查表用的中间形状，不该由界面往回写。
   */
  const collectConfig = (): { config: Record<string, unknown>; plain?: string } => {
    const modelIds = uniqueModels([form.model, ...form.models])
    const savedModels = new Map((editing?.models ?? []).map((entry) => [entry.id, entry]))
    const fallbackCapabilities = {
      vision: false,
      toolCalling: 'native',
      promptCache: form.preset === 'deepseek' ? 'auto' : 'none',
      source: 'preset',
    }
    const activeCapabilities =
      savedModels.get(form.model)?.capabilities ??
      (form.model === editing?.model ? editing?.capabilities : undefined) ??
      fallbackCapabilities
    const config: Record<string, unknown> = {
      id: form.id.trim().length > 0 ? form.id.trim() : (editing?.preset ?? 'custom'),
      preset: form.preset,
      kind: editing?.kind ?? 'openai-compatible',
      baseURL: form.baseURL.trim(),
      apiKeyRef: editing?.apiKeyRef ?? '',
      model: form.model.trim(),
      models: modelIds.map((id) => ({
        id,
        ...(savedModels.get(id)?.capabilities !== undefined
          ? { capabilities: savedModels.get(id)!.capabilities }
          : id === form.model
            ? { capabilities: activeCapabilities }
            : {}),
      })),
      capabilities: activeCapabilities,
    }
    const costs = costsFromRows(form.costs, form.currency)
    if (costs !== undefined) config['cost'] = costs
    if (editing?.compat !== undefined) config['compat'] = editing.compat
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
   *    写进设置并落盘，但这里的 `editing` 还是探测前那份快照，而「保存」走的
   *    `collectConfig()` 恰恰读 `editing.capabilities`。所以探测完必须重新拉一次
   *    `settings()` 把快照换掉——否则点「保存」会用旧的 `vision: false` 盖掉刚探到的
   *    `vision: true`，图就又静默丢了。这条踩过一次。
   *
   * 返回挑出来的模型名（空串表示没挑到，例如端点不可达）。
   */
  const probeCurrent = async (): Promise<string> => {
    if (editing === undefined) return ''
    const { config, plain } = collectConfig()
    try {
      const result = await window.architect.testConnection({
        providerId: editing.id,
        preset: form.preset as ProviderView['preset'],
        baseURL: config['baseURL'],
        model: config['model'],
        apiKeyRef: config['apiKeyRef'],
        ...(plain !== undefined ? { apiKeyPlain: plain } : {}),
      })
      if (result.config.model.length > 0) {
        setForm((current) => ({
          ...current,
          model: result.config.model,
          models: uniqueModels([...current.models, ...result.models, result.config.model]),
        }))
      }
      props.onSaved(await window.architect.settings())
      return result.config.model
    } catch {
      /**
       * 探测失败**不拦着保存**：地址写错了也要能先把配置存下来，而失败的原因会在
       * 对话面板那条"挡住发送"的横幅里显示（`ChatController.blocking()` 读的是同一份
       * 配置）。这里只负责不让异常冒到 React 外面。
       */
      return ''
    }
  }

  const save = (): void => {
    void (async () => {
      const { config, plain } = collectConfig()
      await window.architect.saveProvider(config, plain)
      /**
       * **先探测，再把预算写下去**——顺序反了的话，`setBudget` 末尾那次
       * `onSaved` 会拿着探测前的快照刷新界面，`vision` 又被盖回旧值。
       */
      const chosen = await probeCurrent()
      props.onSaved(await window.architect.settings())
      setKeyPlain('')
      // 挑到模型就说挑到了哪一个；没挑到就是没接上，说清楚，别让用户以为配好了
      props.onStatus(chosen.length > 0 ? 'settings.llm.chosen' : 'settings.llm.notChosen', {
        model: chosen,
      })
      props.onActiveId('')
    })()
  }

  const addProvider = (preset: string): void => {
    void window.architect.addProvider(preset).then((view) => {
      props.onSaved(view)
      // 新加的那份**直接展开**：加它是为了填它的 key，不然还要再找一遍
      props.onActiveId(view.activeId)
    })
  }

  return (
    <Modal
      open={props.open}
      title={t('settings.title')}
      onCancel={props.onClose}
      width={720}
      destroyOnHidden
      footer={
        <Flex justify="flex-end" gap={8} align="center">
          <Button id="btn-settings-cancel" onClick={props.onClose}>
            {t('settings.cancel')}
          </Button>
        </Flex>
      }
    >
      <Flex gap={16} align="stretch" className="settings-layout">
        {/**
         * 左侧菜单。**顺序是用户定的**：通用在前、模型第二。
         * 不用 antd 的 `Menu`：它带着自己的缩进/图标/折叠语义，这里只有两项，
         * 两个按钮加一条右边框就是全部结构（样式见 styles.css 的 `.settings-menu`）。
         */}
        <div className="settings-menu">
          {SECTIONS.map((item) => (
            <button
              key={item.key}
              type="button"
              id={`settings-menu-${item.key}`}
              className={`settings-menu-item${section === item.key ? ' is-active' : ''}`}
              aria-pressed={section === item.key}
              onClick={() => setSection(item.key)}
            >
              {t(item.label)}
            </button>
          ))}
        </div>

        <div className="settings-section">
          {section === 'general' ? (
            <Flex vertical gap={12} style={{ paddingTop: 4 }}>
              {/**
               * 外观：浅色 / 深色 / 跟随系统。改动**立刻生效**——`setUi` 落盘后，
               * `App` 的 effect 把新值报给 `main.tsx` 的 Root，`ConfigProvider`
               * 换 theme，整族 CSS 变量重挂。不需要"保存"按钮。
               */}
              <Field label={t('settings.appearance')}>
                <Select
                  id="cfg-theme"
                  size="small"
                  style={{ width: 150 }}
                  value={settings?.ui.theme ?? 'light'}
                  onChange={(next: 'light' | 'dark' | 'auto') => {
                    void window.architect.setUi({ theme: next }).then(props.onSaved)
                  }}
                  options={[
                    { value: 'light', label: t('settings.theme.light') },
                    { value: 'dark', label: t('settings.theme.dark') },
                    { value: 'auto', label: t('settings.theme.auto') },
                  ]}
                />
              </Field>

              <Field label={t('settings.language')}>
                <Select
                  id="cfg-locale"
                  size="small"
                  style={{ width: 150 }}
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
              </Field>
            </Flex>
          ) : (
            <>
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                {t('settings.subtitle')}
              </Typography.Text>

      <div className="provider-list">
        {(settings?.providers ?? []).map((provider) => {
          const isActive = provider.id === activeId
          const open = provider.id === props.activeId
          // 状态点：密钥齐不齐 + 模型选没选。**两个都绿才算可用**——只报"有 key"
          // 会在模型还没选的时候显示绿灯，而那时候对话是发不出去的。
          const ready = provider.hasKey && provider.model.trim().length > 0
          return (
            <div
              key={provider.id}
              className={`provider-card${isActive ? ' is-active' : ''}${open ? ' is-open' : ''}`}
              id={`provider-${provider.id}`}
              onClick={() => {
                if (!open) props.onActiveId(provider.id)
              }}
            >
              <div className="provider-card-head">
                <span className="provider-name">{provider.id}</span>
                {provider.preset !== 'custom' && (
                  <span className="provider-tag">{presetLabel(provider.preset)}</span>
                )}
                <span className={`provider-dot${ready ? ' is-ready' : ''}`} title={t(ready ? 'settings.ready' : 'settings.notReady')} />
                {/* **没有"使用中"这个状态**（用户的要求）：在哪台模型上说话，由输入框
                    里那个选择器决定（DSH 就是这样）。这里只显示"配好了没有"。 */}
                <span style={{ flex: 1 }} />
                <Button
                  size="small"
                  id={`btn-edit-${provider.id}`}
                  onClick={(event) => {
                    event.stopPropagation()
                    props.onActiveId(open ? '' : provider.id)
                  }}
                >
                  {open ? t('settings.collapse') : t('settings.edit')}
                </Button>
                <Button
                  size="small"
                  danger
                  id={`btn-remove-${provider.id}`}
                  disabled={(settings?.providers.length ?? 0) <= 1}
                  onClick={(event) => {
                    event.stopPropagation()
                    void window.architect.removeProvider(provider.id).then((next) => {
                      props.onActiveId('')
                      props.onSaved(next)
                    })
                  }}
                >
                  {t('settings.removeProvider')}
                </Button>
              </div>

              <div className="provider-meta">
                {provider.model.trim().length > 0 ? (
                  <span>{provider.model}</span>
                ) : (
                  <span className="provider-missing">{t('settings.noModel')}</span>
                )}
                {!provider.hasKey && (
                  <span className="provider-missing"> · {t('settings.noKey')}</span>
                )}
              </div>

              {open && (
                <div className="provider-form" onClick={(event) => event.stopPropagation()}>
                  <Field label={t('settings.providerName')}>
                    <Input
                      id="cfg-id"
                      value={form.id}
                      spellCheck={false}
                      onChange={(event) => setForm((c) => ({ ...c, id: event.target.value }))}
                    />
                  </Field>

                  <Field label={t('settings.preset')}>
                    <Select
                      id="cfg-preset"
                      style={{ flex: 1 }}
                      value={form.preset}
                      onChange={(preset: string) => setForm((c) => ({ ...c, preset }))}
                      options={['deepseek', 'custom'].map((preset) => ({
                        value: preset,
                        label: presetLabel(preset),
                      }))}
                    />
                  </Field>

                  <Field label={t('settings.llm.apiKey')}>
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
                  </Field>

                  <Typography.Text type="secondary" style={{ fontSize: 11.5 }}>
                    {t('settings.llm.keyNote')}
                  </Typography.Text>

                  <Field label={t('settings.llm.models')}>
                    <Select
                      id="cfg-models"
                      mode="tags"
                      style={{ flex: 1 }}
                      value={form.models}
                      tokenSeparators={[',']}
                      placeholder={t('settings.llm.modelsPlaceholder')}
                      onChange={(values: string[]) => {
                        const models = uniqueModels(values)
                        setForm((current) => ({
                          ...current,
                          models,
                          model: models.includes(current.model) ? current.model : (models[0] ?? ''),
                        }))
                      }}
                      options={form.models.map((model) => ({ value: model, label: model }))}
                    />
                  </Field>

                  <Field label={t('settings.llm.activeModel')}>
                    <Select
                      id="cfg-model"
                      style={{ flex: 1 }}
                      value={form.model.length > 0 ? form.model : undefined}
                      placeholder={t('settings.noModel')}
                      onChange={(model: string) => setForm((current) => ({ ...current, model }))}
                      options={form.models.map((model) => ({ value: model, label: model }))}
                    />
                  </Field>

                  <Typography.Text type="secondary" style={{ fontSize: 11.5 }}>
                    {t('settings.llm.modelsNote')}
                  </Typography.Text>

                  <button
                    type="button"
                    className="provider-advanced-toggle"
                    id="btn-advanced"
                    aria-expanded={showAdvanced}
                    onClick={() => setShowAdvanced((on) => !on)}
                  >
                    {showAdvanced ? <DownOutlined /> : <RightOutlined />}
                    {t('settings.advanced')}
                  </button>

                  {showAdvanced && (
                    <div className="provider-advanced" id="provider-advanced">
                      <Field label={t('settings.llm.baseURL')}>
                        <Input
                          id="cfg-baseurl"
                          spellCheck={false}
                          value={form.baseURL}
                          onChange={(event) => setForm((c) => ({ ...c, baseURL: event.target.value }))}
                        />
                      </Field>

                      {/**
                       * **按模型定价**。一个自定义端点上常挂着好几个模型，价格差几倍，
                       * 而表盘上的钱是 `--max-usd` 的刹车依据——按 provider 只记一份
                       * 就会在切模型之后给出编的数字。
                       *
                       * 键是模型 id，与「模型名」那个输入框同一个字符串：匹配是精确的，
                       * 所以这里也提供"用当前模型名"一键填上，免得手打错了对不上。
                       */}
                      <div className="cost-table">
                        <div className="cost-head">
                          <span>{t('settings.pricing')}</span>
                          {/* **货币只配一次**（用户的要求）：三个价格数字共用它，
                              比每行都问一遍币种少三次选择。价格表存的是原币种金额，
                              表盘按它显示——不折算，因为汇率是编的。 */}
                          <span className="cost-currency">
                            <span>{t('settings.currency')}</span>
                            <Select
                              id="cfg-currency"
                              size="small"
                              style={{ width: 84 }}
                              value={form.currency}
                              onChange={(currency: string) => setForm((c) => ({ ...c, currency }))}
                              options={CURRENCIES.map((code) => ({ value: code, label: code }))}
                            />
                          </span>
                          <Button
                            size="small"
                            type="text"
                            id="btn-add-price"
                            aria-label={t('settings.addPrice')}
                            icon={<PlusOutlined />}
                            onClick={() =>
                              setForm((c) => ({
                                ...c,
                                costs: [
                                  ...c.costs,
                                  {
                                    model: c.costs.length === 0 ? c.model.trim() : '',
                                    inPerMTok: '',
                                    outPerMTok: '',
                                    cacheReadPerMTok: '',
                                  },
                                ],
                              }))
                            }
                          />
                        </div>
                        {form.costs.length === 0 && (
                          <Typography.Text type="secondary" style={{ fontSize: 11.5 }}>
                            {t('settings.pricingNone')}
                          </Typography.Text>
                        )}
                        {form.costs.map((row, at) => (
                          <div className="cost-row" key={at}>
                            <Input
                              size="small"
                              className="cost-model"
                              placeholder="model id"
                              value={row.model}
                              spellCheck={false}
                              onChange={(event) =>
                                setForm((c) => ({
                                  ...c,
                                  costs: c.costs.map((item, idx) =>
                                    idx === at ? { ...item, model: event.target.value } : item,
                                  ),
                                }))
                              }
                            />
                            <InputNumber
                              size="small"
                              className="cost-num"
                              min={0}
                              step={0.01}
                              placeholder={t('settings.priceIn')}
                              value={row.inPerMTok === '' ? null : Number(row.inPerMTok)}
                              onChange={(value) =>
                                setForm((c) => ({
                                  ...c,
                                  costs: c.costs.map((item, idx) =>
                                    idx === at ? { ...item, inPerMTok: value === null ? '' : String(value) } : item,
                                  ),
                                }))
                              }
                            />
                            <InputNumber
                              size="small"
                              className="cost-num"
                              min={0}
                              step={0.01}
                              placeholder={t('settings.priceOut')}
                              value={row.outPerMTok === '' ? null : Number(row.outPerMTok)}
                              onChange={(value) =>
                                setForm((c) => ({
                                  ...c,
                                  costs: c.costs.map((item, idx) =>
                                    idx === at ? { ...item, outPerMTok: value === null ? '' : String(value) } : item,
                                  ),
                                }))
                              }
                            />
                            <InputNumber
                              size="small"
                              className="cost-num"
                              min={0}
                              step={0.01}
                              placeholder={t('settings.priceCache')}
                              value={row.cacheReadPerMTok === '' ? null : Number(row.cacheReadPerMTok)}
                              onChange={(value) =>
                                setForm((c) => ({
                                  ...c,
                                  costs: c.costs.map((item, idx) =>
                                    idx === at
                                      ? { ...item, cacheReadPerMTok: value === null ? '' : String(value) }
                                      : item,
                                  ),
                                }))
                              }
                            />
                            <Button
                              size="small"
                              type="text"
                              danger
                              aria-label={t('settings.removePrice')}
                              onClick={() =>
                                setForm((c) => ({ ...c, costs: c.costs.filter((_, idx) => idx !== at) }))
                              }
                            >
                              ✕
                            </Button>
                          </div>
                        ))}
                        <div className="cost-legend">{t('settings.pricingHint')}</div>
                      </div>

                    </div>
                  )}

                  <Flex justify="flex-end" gap={8} style={{ marginTop: 8 }}>
                    <Button type="primary" id="btn-provider-save" onClick={save}>
                      {t('settings.apply')}
                    </Button>
                  </Flex>
                </div>
              )}
            </div>
          )
        })}
      </div>

      <Flex gap={8} style={{ marginTop: 10 }}>
        {BUILTIN_PRESETS.map((preset) => (
          <Button
            key={preset}
            id={`btn-add-${preset}`}
            className="add-provider"
            icon={<PlusOutlined />}
            onClick={() => addProvider(preset)}
          >
            {t('settings.addPreset', { name: presetLabel(preset) })}
          </Button>
        ))}
        <Button
          id="btn-add-custom"
          className="add-provider"
          icon={<PlusOutlined />}
          onClick={() => addProvider('custom')}
        >
          {t('settings.addCustom')}
        </Button>
      </Flex>
            </>
          )}
        </div>
      </Flex>
    </Modal>
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }): React.JSX.Element {
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

function uniqueModels(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter((value) => value.length > 0))]
}

function modelIdsOf(provider: ProviderView | undefined): string[] {
  if (provider === undefined) return []
  return uniqueModels([provider.model, ...(provider.models ?? []).map((entry) => entry.id)])
}

/**
 * 设置文件里的价格表 → 界面上的行。
 *
 * 两种写法都认（见 `parseSettings`）：按模型分表的对象，或者 provider 级的一张表。
 * 后者没有模型名可对应，所以**用当前模型名当键**填进来——这样用户看到的是
 * "这个模型这个价"，而不是一个不知道该填什么名字的空行。
 */
/** 这一份配置用的币种。取第一张价格表上的那个（同一个 provider 共用一种）。 */
function currencyOf(provider: ProviderView | undefined): string {
  const table =
    provider?.costs !== undefined
      ? Object.values(provider.costs)[0]
      : provider?.cost
  return table?.currency ?? 'USD'
}

function costRowsOf(provider: ProviderView | undefined): CostRow[] {
  if (provider === undefined) return []
  const toRow = (model: string, table: NonNullable<ProviderView['cost']>): CostRow => ({
    model,
    inPerMTok: String(table.inPerMTok),
    outPerMTok: String(table.outPerMTok),
    cacheReadPerMTok:
      table.cacheReadPerMTok === undefined ? '' : String(table.cacheReadPerMTok),
  })
  if (provider.costs !== undefined) {
    return Object.entries(provider.costs).map(([model, table]) => toRow(model, table))
  }
  if (provider.cost !== undefined) return [toRow(provider.model, provider.cost)]
  return []
}

/**
 * 界面上的行 → 设置文件里的价格表。
 *
 * 丢掉**填不全的行**（缺模型名、或缺输入/输出价）：半个价格表会让"这次花了多少"
 * 变成编出来的数字，而那个数字是刹车依据。全空时返回 `undefined`，让调用方
 * 干脆不写 `cost` 字段——于是表盘照旧显示 token 数，而不是 $0.00。
 */
function costsFromRows(rows: CostRow[], currency: string): Record<string, unknown> | undefined {
  const out: Record<string, unknown> = {}
  for (const row of rows) {
    const model = row.model.trim()
    const inPrice = Number(row.inPerMTok)
    const outPrice = Number(row.outPerMTok)
    if (model.length === 0 || row.inPerMTok === '' || row.outPerMTok === '') continue
    out[model] = {
      currency,
      inPerMTok: inPrice,
      outPerMTok: outPrice,
      ...(row.cacheReadPerMTok !== '' ? { cacheReadPerMTok: Number(row.cacheReadPerMTok) } : {}),
    }
  }
  return Object.keys(out).length > 0 ? out : undefined
}
