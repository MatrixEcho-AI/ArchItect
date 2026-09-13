import { useCallback, useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { App as AntdApp, ConfigProvider } from 'antd'
import enUS from 'antd/locale/en_US'
import zhCN from 'antd/locale/zh_CN'
import { getLocale, initI18n, normalizeLocale } from '@architect/i18n'

import { App } from './app.js'
import { ARCHITECT_THEME } from './theme.js'
import type { Locale } from '@architect/i18n'

import 'antd/dist/reset.css'
import './styles.css'

/**
 * 渲染进程的入口。
 *
 * 三件事，都只在这里做一次：
 *
 * 1. **挂 React 树**到 `#root`。标记只剩一个空 div——旧版那 228 行手写 HTML 里
 *    每个面板、每个输入框都是一份需要人肉保持同步的第二真相，现在结构只有一处。
 * 2. **i18n 与 antd 的 locale 绑在一起**。这两条线必须同时切：只切一条的症状很具体
 *    ——界面是中文、但 antd 的弹窗按钮是英文（antd 有自己的文案表）。语言状态提到
 *    这一层，`App` 通过 `onLocaleChange` 上报，两边一起跟着走。
 * 3. **深色主题**（`theme.ts`）。`AntdApp` 提供 `message` / `modal` 的上下文，
 *    组件里就能用 `App.useApp()` 拿到它们（不必再自己造一套提示）。
 */
function Root(): React.JSX.Element {
  // 首帧的语言先看系统：渲染进程的 i18next 是**自己一份**，主进程初始化过不代表它初始化过。
  // 写死任何一种语言都会在设置读回来之前闪一下错的；`navigator.language` 在 Electron 里
  // 就是 app locale，与主进程的 `app.getLocale()` 同源。
  const [locale, setLocale] = useState<Locale>(normalizeLocale(navigator.language) ?? getLocale())
  const onLocaleChange = useCallback((next: Locale) => setLocale(next), [])
  // 脏活在这里、不在渲染里：渲染函数可能有副作用是 React 最忌讳的一类 bug
  useEffect(() => {
    initI18n({ locale })
  }, [locale])
  return (
    <ConfigProvider theme={ARCHITECT_THEME} locale={locale === 'en-US' ? enUS : zhCN}>
      <AntdApp>
        <App onLocaleChange={onLocaleChange} />
      </AntdApp>
    </ConfigProvider>
  )
}

const container = document.getElementById('root')
if (container === null) throw new Error('缺少 #root：index.html 被改坏了')
createRoot(container).render(<Root />)
