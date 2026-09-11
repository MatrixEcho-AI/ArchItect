import type { ThemeConfig } from 'antd'

/**
 * antd 主题：**白色主题 + antd 默认主色**。
 *
 * ## 为什么主色那几项是"不写"而不是"写一个值"
 *
 * 第一版这里写了 `colorPrimary: '#2b8a99'`（青绿），来由是旧界面那套自研 CSS 的
 * `--accent: #5cc8d6`——当时的想法是"换 UI 时观感保持连续"。**那是错的**：
 * 要的是 antd 的界面，而 antd 的识别色就是它默认那支蓝（`#1677ff`）。
 * 把主色换掉之后，同一个按钮组件看起来是"某个别的设计系统"，而不是 antd——
 * 而这正是这次改版要拿到的东西。所以 `colorPrimary` / `colorWarning` /
 * `colorError` / `colorSuccess` **一律不写**，由 antd 自己派生（它还负责
 * hover / active / disabled 那一整族色，手写必然漏）。
 *
 * 只有下面这几项是真的**本地化选择**，与"用哪套色"无关，所以留着：
 * 中文字体栈、13px 正文（antd 默认 14px 在密集的左栏里放不下）。
 *
 * ## 层次关系（不能反）
 *
 * `colorBgLayout` 是后台的底（`#f5f6f8`），`colorBgContainer` 是卡片/输入框的底
 * （`#ffffff`）——反了会出现"卡片比背景还暗"的脏观感。
 *
 * 视口的清屏色**不进主题**：那是 WebGL 的画布色，见 `viewport-shell.ts` 的
 * `VIEWPORT_CLEAR`。两者接近是有意的，但改一个不该动另一个。
 */
/**
 * 顶栏与侧栏的底色：**极淡的浅蓝**。
 *
 * 用户的要求是"一定要淡，比你理解的浅蓝色还要淡一点"。取值 `#eef6fd` —— 它不是蓝灰色，
 * 是**带一点蓝的白**：白底上叠了约 7% 的蓝，饱和度低到只在与纯白并排时才看得出来。
 *
 * 一个要守住的约束：它必须比 `colorBgContainer`（卡片、输入框，纯白）**更深一点点**。
 * 反过来的话卡片会"陷进"背景里，看起来像没渲染完。
 *
 * 侧栏与顶栏共用同一个值：两者只差一条分隔线，用两个相近但不等的浅色会显脏。
 */
const CHROME_BG = '#eef6fd'

export const ARCHITECT_THEME: ThemeConfig = {
  /**
   * **必须显式开启**（antd 的默认值是 `false`）。
   *
   * 开了它，antd 才会把整套 token 挂成 CSS 变量（`--ant-color-*`），而
   * `styles.css` 里那些 `var(--ant-color-*-bg)` 正是读它。
   *
   * 这个坑值得写下来，因为它**没有任何报错**：变量不存在时 CSS 不会失败，
   * 只是回落到继承值——"卡片按角色着色"于是变成"所有卡片一个色"，从截图上
   * 看只像配色难看，完全不像配置错了。是我加的一条 gui-smoke 断言
   * （`card-colors`，读真卡片的计算背景色）把它抓出来的，不是人眼看出来的。
   */
  cssVar: true,
  token: {
    colorBgBase: '#ffffff',
    colorBgLayout: CHROME_BG,
    colorBgContainer: '#ffffff',
    colorBgElevated: '#ffffff',
    borderRadius: 4,
    fontSize: 13,
    fontFamily:
      "-apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang SC', 'Microsoft YaHei', sans-serif",
  },
  components: {
    Layout: {
      headerBg: CHROME_BG,
      bodyBg: CHROME_BG,
      siderBg: CHROME_BG,
      headerHeight: 38,
      headerPadding: '0 10px',
    },
    // 左栏那几块是"分区"而不是卡片：不要阴影、不要圆角，只要一条分割线
    Card: {
      headerBg: 'transparent',
      headerFontSize: 11,
      paddingLG: 10,
    },
    // 编辑记录/直方图是密集列表，行高压到最小
    List: {
      itemPadding: '1px 0',
      fontSize: 12,
    },
    Button: {
      paddingInline: 10,
      paddingInlineSM: 6,
    },
  },
}
