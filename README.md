# ArchItect

一款用多模态 LLM 设计 Minecraft 建筑的桌面程序，附带同功能的命令行工具。

## 主要功能

- 可以用一句话描述需求，由模型设计并建造
- 模型通过 24 个 LLM 工具建造与检视世界
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
- **导入：** 顶栏的「导入…」读入 `.schem` 或 `.litematic`，之后可以继续编辑或导出。

## 导出

| 格式 | 用途 |
|------|------|
| `.mcai` | 工程文件：含编辑记录、对话与截图 |
| `.schem` | WorldEdit：`//schem load` 然后 `//paste` |
| `.litematic` | Litematica |
| `.obj` + `.mtl` | 三维软件 |

导出的是文件，不写入游戏存档或服务器。

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
| [`docs/tool-reference.md`](docs/tool-reference.md) | 24 个工具的完整参考——从 JSON Schema 生成，不会过期 |
| [`docs/prompt-library.md`](docs/prompt-library.md) | 建筑风格需求模板：住宅 / 公共建筑 / 结构装饰 / 修问题 |
| [`examples/README.md`](examples/README.md) | 示例工程怎么看、怎么重新生成 |
| [`plan.md`](plan.md) | 设计文档：世界模型、格式、渲染、工具语义、Agent 循环、决策记录 |
