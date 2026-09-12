import { useCallback, useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { App as AntdApp, ConfigProvider } from 'antd'
import enUS from 'antd/locale/en_US'
import zhCN from 'antd/locale/zh_CN'
import { getLocale, initI18n } from '@architect/i18n'

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
  // 占位值取主进程已经定好的那个，别写死：写死会在首帧把设置里的语言覆盖掉一次
  const [locale, setLocale] = useState<Locale>(getLocale())
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
if (container === null) throw new Error('No #root: index.html has been changed')
createRoot(container).render(<Root />)
