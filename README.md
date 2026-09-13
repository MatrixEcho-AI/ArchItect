# ArchItect

一款用多模态 LLM 设计 Minecraft 建筑的桌面程序，附带同功能的命令行工具。

## 主要功能

- 可以用一句话描述需求，由模型设计并建造
- 模型通过 29 个 LLM 工具建造与检视世界
- 可以在对话面板回看每一步工具调用与对应的截图
- 可以拖动时间线回到任意一步，或撤销 / 重做
- 可以打开和保存 `.mcai` 工程，与他人分享设计过程
- 可以导入 `.schem` 与 `.litematic` 继续编辑
- 可以导出 `.schem`、`.litematic`、`.obj`
- 可以配置 DeepSeek、OpenAI、Ollama 或任意 OpenAI 兼容端点
- 界面支持简体中文与英文

## 安装与启动

需要 Node ≥ 22 与 pnpm。

```bash
pnpm install
pnpm desktop
```

不需要 API key 也能跑通一遍完整流程：

```bash
pnpm demo:v0
```

## 配置模型

点击顶栏最右的齿轮，在「模型配置」里填写接口地址、API Key 与模型名，然后点「测试连接」。
连接成功后界面会显示这个模型是否支持图像输入、单图大约多少 token。

API Key 只存在本机加密存储里，不写进 `.mcai`。命令行下用 `pnpm providers` 探测端点。

## 基本使用

- **设计一座建筑：** 在右下角的输入框里描述需求，按 ⌘/Ctrl + Enter 发送。对话栏上方的「模板」里有几个可以直接改用的例子。
- **回看某一步：** 拖动时间线，或点「编辑记录」里的一条。停在历史版本上时发送框会锁住，先点「回到最新」再继续。
- **移动视角：** 视口是自由相机——`WASD` 走、空格上升、Shift 下降、拖动转头、滚轮变焦、双击回到自动取景。顶栏的「机位」下拉里有等轴测与各立面的预设。
- **打开与保存：** 顶栏的「打开…」与「保存…」读写 `.mcai` 工程。
- **导出：** 顶栏的「导出…」是个三选一的下拉——`.schem`（WorldEdit）、`.litematic`（Litematica）、`.obj`（三维软件）。
- **导入：** 顶栏的「导入…」读入 `.schem` 或 `.litematic`，之后可以继续编辑或导出。

## 导出

| 格式 | 用途 |
|------|------|
| `.mcai` | 工程文件：含编辑记录、对话与截图 |
| `.schem` | WorldEdit：`//schem load` 然后 `//paste` |
| `.litematic` | Litematica |
| `.obj` + `.mtl` | 三维软件 |

导出的是文件，不写入游戏存档或服务器。

## 实体与方块实体

模型可以直接往世界里放**实体**（船、矿车、盔甲架、生物……），也能给**方块实体**
写内容（箱子里的东西、告示牌的朝向、旗帜的图案）。它们和方块是**两层并列的数据**，
不是"方块的一种属性"：

- 实体位置是浮点的、允许重叠，所以它不占格子、不进调色板；
- 方块实体键在格子上并且**寄生**于方块——把箱子换成石头，里面的东西随之消失
  （与原版一致）。撤销会把它连同内容一起恢复。

这两层一起进入 `.mcai`、撤销重做、`.schem` 与 `.litematic`。**`.obj` 不导出实体**：
那条路只认方块碰撞盒，按 AABB 盒导出一堆 `o` 组会和真实形状对不上，所以宁可不导，
而不是给一个看着像、用起来错的模型。

### 已知的渲染差异

实体没有自己的几何表，用的是上游 `prismarine-viewer` 的骨骼模型，因此有几处与游戏内不同：

| 差异 | 说明 |
|------|------|
| **alpha 裁剪** | 原版用 `alphaTest` 把透明像素整个丢掉；我们的光栅器只有"不透明 / 混合"两条路，实体贴图按不透明画。画布预填了背景色，所以透明像素**看上去**是背景，但它们**写了深度**，会挡住后面的东西 |
| **动画贴图整张用** | 竖向的帧条没有取第一帧（方块图集取了左上角的 16×16，实体这条没做同样的事），所以带多帧的贴图会被拉伸着采样 |
| **只有变体贴图的生物** | 猫、马、羊驼、村民、兔子、鹦鹉、狐狸、豹猫、潜影贝、热带鱼在上游表里只列了花纹变体。我们各画其中一个原版常见变体：**形状是真的，花纹是"某一种"** |
| **认不出模型的实体** | 退化成按 `minecraft-data` 宽高做的 AABB 兜底盒（展示框、画、1.21 新增的部分生物）。比"猜一个形状"诚实，也比"什么都不画"有用 |
| **告示牌文字与旗帜图案** | **未画**。数据存得住、导得出，只是截图里看不到那几个像素——设计价值主要在进游戏之后 |

## 命令行

```bash
pnpm architect info hut.mcai                     # 清单与调色板
pnpm architect slice hut.mcai --axis y --index 1 # 一层的 ASCII 平面图
pnpm architect shoot hut.mcai --out hut.png --view iso_ne
pnpm architect export hut.mcai --out hut.schem
pnpm architect import hut.schem --out hut.mcai
pnpm architect build "造一座 9x9 的林间小屋，云杉木板墙、圆石地基、斜坡屋顶，正门朝南开" --out hut.mcai
```

`pnpm architect --help` 列出全部命令与选项。

## 文档

| 文档 | 内容 |
|------|------|
| [`docs/development.md`](docs/development.md) | 参与开发：工程结构、常用命令、调试开关、打包 |
| [`docs/mcai-format.md`](docs/mcai-format.md) | `.mcai` 格式规范（字节级） |
| [`docs/tool-reference.md`](docs/tool-reference.md) | 29 个工具的完整参考——从 JSON Schema 生成，不会过期 |
| [`docs/prompt-library.md`](docs/prompt-library.md) | 建筑风格需求模板：住宅 / 公共建筑 / 结构装饰 / 修问题 |
| [`examples/README.md`](examples/README.md) | 示例工程怎么看、怎么重新生成 |
| [`plan.md`](plan.md) | 设计文档：世界模型、格式、渲染、工具语义、Agent 循环、决策记录 |

## 许可

Copyright (C) 2026 ArchItect contributors

本项目以 **GPL v3**发布，它是自由软件：你可以自由使用、修改和再分发，但分发衍生作品时必须以同一许可开放源代码，并且不提供任何担保。

第三方组件保留各自的许可，与 GPL v3 兼容。
