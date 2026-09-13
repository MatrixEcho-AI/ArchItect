import { describe, expect, it } from 'vitest'
import { theme as antdTheme } from 'antd'

import { ARCHITECT_THEME, ARCHITECT_THEME_DARK, resolveThemeMode, themeFor } from '../src/renderer/theme.js'

/**
 * 主题的纯逻辑：三选一怎么解析成两种模式、两套主题各自的硬约束。
 *
 * 这里**不测**"界面上真的变暗了"——那要真窗口（Electron 起不来的机器上验不了）。
 * 测的是把"变暗"翻译成配置的三件事：算法选对、CSS 变量开着、浅色专属的白底没带进深色。
 */
describe('主题设置 → 实际模式', () => {
  it('light / dark 直通，auto 跟随系统偏好', () => {
    expect(resolveThemeMode('light', true)).toBe('light')
    expect(resolveThemeMode('light', false)).toBe('light')
    expect(resolveThemeMode('dark', false)).toBe('dark')
    expect(resolveThemeMode('dark', true)).toBe('dark')
    expect(resolveThemeMode('auto', true)).toBe('dark')
    expect(resolveThemeMode('auto', false)).toBe('light')
  })

  it('**没设置过就是浅色**（沿用白主题，不替老用户换肤）', () => {
    expect(resolveThemeMode(undefined, true)).toBe('light')
    expect(resolveThemeMode(undefined, false)).toBe('light')
  })

  it('themeFor 把模式映射到对应主题（拿反了就是界面反色）', () => {
    expect(themeFor('light')).toBe(ARCHITECT_THEME)
    expect(themeFor('dark')).toBe(ARCHITECT_THEME_DARK)
  })
})

describe('两套主题的硬约束', () => {
  it('深色用 darkAlgorithm，浅色用默认算法', () => {
    expect(ARCHITECT_THEME_DARK.algorithm).toBe(antdTheme.darkAlgorithm)
    expect(ARCHITECT_THEME.algorithm).toBeUndefined()
  })

  it('**两套都开 cssVar**：styles.css 里的 var(--ant-*) 全靠它，关了深色切不动', () => {
    expect(ARCHITECT_THEME.cssVar).toBe(true)
    expect(ARCHITECT_THEME_DARK.cssVar).toBe(true)
  })

  it('深色**不带**浅色的白底 token（带过来深色里卡片还是白的）', () => {
    expect(ARCHITECT_THEME.token?.colorBgContainer).toBe('#ffffff')
    expect(ARCHITECT_THEME_DARK.token?.colorBgContainer).toBeUndefined()
    expect(ARCHITECT_THEME_DARK.token?.colorBgBase).toBeUndefined()
    expect(ARCHITECT_THEME_DARK.token?.colorBgElevated).toBeUndefined()
  })

  it('两套的 Layout 结构尺寸一致，只有底色不同（顶栏高 38 是对齐过的）', () => {
    expect(ARCHITECT_THEME.components?.Layout?.headerHeight).toBe(38)
    expect(ARCHITECT_THEME_DARK.components?.Layout?.headerHeight).toBe(38)
    expect(ARCHITECT_THEME.components?.Layout?.headerBg).not.toBe(
      ARCHITECT_THEME_DARK.components?.Layout?.headerBg,
    )
  })

  it('**antd 真的能派生出两族 token**（token 名写错时它静默忽略，只有派生值能抓出来）', () => {
    // 这一步替代"读计算样式"：jsdom 没有 CSS 引擎，`getComputedStyle` 拿不到级联结果，
    // 但 `getDesignToken` 是 antd 自己跑同样的派生逻辑——它对了，界面就对。
    const light = antdTheme.getDesignToken(ARCHITECT_THEME)
    const dark = antdTheme.getDesignToken(ARCHITECT_THEME_DARK)
    // 容器底：白 vs 深
    expect(light.colorBgContainer).toBe('#ffffff')
    expect(dark.colorBgContainer).not.toBe('#ffffff')
    // 布局底：我们那两个 chrome 色各自生效
    expect(light.colorBgLayout).toBe('#eef6fd')
    expect(dark.colorBgLayout).toBe('#16222e')
    // 文字：深底浅字、浅底深字
    expect(light.colorText.startsWith('rgba(0,0,0')).toBe(true)
    expect(dark.colorText.startsWith('rgba(255,255,255')).toBe(true)
  })
})
