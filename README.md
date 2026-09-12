# ArchItect

### [中文](#%E4%B8%AD%E6%96%87) | [English](#english)

---

<div lang="zh-CN">

## 中文

用多模态 LLM 设计 Minecraft 建筑的桌面程序，附带同功能的命令行工具。

### 主要功能

- 可以用一句话描述需求，由模型设计并建造
- 模型通过 24 个 LLM 工具建造与检视世界
- 可以在对话面板回看每一步工具调用与对应的截图
- 可以拖动时间线回到任意一步，或撤销 / 重做
- 可以打开和保存 `.mcai` 工程，与他人分享设计过程
- 可以导入 `.schem` 与 `.litematic` 继续编辑
- 可以导出 `.schem`、`.litematic`、`.obj`
- 可以配置 DeepSeek、OpenAI、Ollama 或任意 OpenAI 兼容端点
- 界面支持简体中文与英文

### 安装与启动

需要 Node ≥ 22 与 pnpm。

```bash
pnpm install
pnpm desktop
```

不需要 API key 也能跑通一遍完整流程：

```bash
pnpm demo:v0
```

### 配置模型

点击顶栏最右的齿轮，在「模型」里填写接口地址、API Key 与模型名，然后点「测试连接」。
连接成功后界面会显示这个模型是否支持图像输入、单图大约多少 token。

API Key 只存在本机加密存储里，不写进 `.mcai`。命令行下用 `pnpm providers` 探测端点。

### 基本使用

- **设计一座建筑：** 在右下角的输入框里描述需求，按 ⌘/Ctrl + Enter 发送。对话栏上方的「模板」里有几个可以直接改用的例子。
- **回看某一步：** 拖动时间线，或点「编辑记录」里的一条。停在历史版本上时发送框会锁住，先点「回到最新」再继续。
- **移动视角：** 视口是自由相机——`WASD` 走、空格上升、Shift 下降、拖动转头、滚轮变焦、双击回到自动取景。顶栏的「机位」下拉里有等轴测与各立面的预设。
- **打开与保存：** 顶栏的「打开…」与「保存…」读写 `.mcai` 工程。
- **导入：** 顶栏的「导入…」读入 `.schem` 或 `.litematic`，之后可以继续编辑或导出。

### 导出

| 格式 | 用途 |
|------|------|
| `.mcai` | 工程文件：含编辑记录、对话与截图 |
| `.schem` | WorldEdit：`//schem load` 然后 `//paste` |
| `.litematic` | Litematica |
| `.obj` + `.mtl` | 三维软件 |

导出的是文件，不写入游戏存档或服务器。

### 命令行

```bash
pnpm architect info hut.mcai                     # 清单与调色板
pnpm architect slice hut.mcai --axis y --index 1 # 一层的 ASCII 平面图
pnpm architect shoot hut.mcai --out hut.png --view iso_ne
pnpm architect export hut.mcai --out hut.schem
pnpm architect import hut.schem --out hut.mcai
pnpm architect build "造一座 9x9 的林间小屋，云杉木板墙、圆石地基、斜坡屋顶，正门朝南开" --out hut.mcai
```

`pnpm architect --help` 列出全部命令与选项。

### 文档

| 文档 | 内容 |
|------|------|
| [`docs/development.md`](docs/development.md) | 参与开发：工程结构、常用命令、调试开关、打包 |
| [`docs/mcai-format.md`](docs/mcai-format.md) | `.mcai` 格式规范（字节级） |
| [`docs/tool-reference.zh-CN.md`](docs/tool-reference.zh-CN.md) | 24 个工具的完整参考——从 JSON Schema 生成，不会过期 |
| [`docs/prompt-library.md`](docs/prompt-library.md) | 建筑风格需求模板：住宅 / 公共建筑 / 结构装饰 / 修问题 |
| [`examples/README.md`](examples/README.md) | 示例工程怎么看、怎么重新生成 |
| [`plan.md`](plan.md) | 设计文档：世界模型、格式、渲染、工具语义、Agent 循环、决策记录 |

</div>

---

<div lang="en">

## English

A desktop application for designing Minecraft buildings with a multimodal LLM, with a
command-line tool that does the same.

### Main features

- Describe a building in one sentence and the model designs and builds it
- The model works the world through 24 LLM tools
- Follow every tool call and its screenshot in the chat panel
- Drag the timeline back to any step, or undo and redo
- Open and save `.mcai` projects and share the design process with others
- Import `.schem` and `.litematic` files and keep editing them
- Export `.schem`, `.litematic` and `.obj`
- Configure DeepSeek, OpenAI, Ollama, or any OpenAI-compatible endpoint
- Interface available in Simplified Chinese and English

### Install and run

Requires Node ≥ 22 and pnpm.

```bash
pnpm install
pnpm desktop
```

A complete run needs no API key:

```bash
pnpm demo:v0
```

### Configure a model

Select the gear at the right of the toolbar, fill in the endpoint, API key and model name
under “Model”, then select “Test connection”. The dialog then reports whether the model
accepts images and roughly how many tokens one image costs.

The API key is kept in this machine's encrypted store and never written into a `.mcai`.
On the command line, `pnpm providers` probes the endpoint.

### Basic use

- **Design a building:** describe it in the box at the bottom right and press ⌘/Ctrl + Enter. The “Templates” list above the conversation holds a few requests to start from.
- **Revisit a step:** drag the timeline, or select a row in “Edit log”. While the project is on a historical revision the send box is locked; return to the latest revision first.
- **Move the camera:** the viewport is a free camera — `WASD` to walk, Space to rise, Shift to descend, drag to turn, the wheel to zoom, double-click to fit. The toolbar's “Camera” list holds the isometric and elevation presets.
- **Open and save:** “Open…” and “Save…” in the toolbar read and write `.mcai` projects.
- **Import:** “Import…” reads a `.schem` or `.litematic`, which can then be edited or exported.

### Export

| Format | Use |
|--------|-----|
| `.mcai` | The project file: edit log, conversation and screenshots |
| `.schem` | WorldEdit: `//schem load` then `//paste` |
| `.litematic` | Litematica |
| `.obj` + `.mtl` | 3D software |

These are files; nothing is written to a game save or a server.

### Command line

```bash
pnpm architect info hut.mcai                     # manifest and palette
pnpm architect slice hut.mcai --axis y --index 1 # one layer as an ASCII plan
pnpm architect shoot hut.mcai --out hut.png --view iso_ne
pnpm architect export hut.mcai --out hut.schem
pnpm architect import hut.schem --out hut.mcai
pnpm architect build "A 9x9 forest hut: spruce plank walls, cobblestone foundation, pitched roof, door facing south" --out hut.mcai
```

`pnpm architect --help` lists every command and option.

### Documentation

| Document | Contents |
|----------|----------|
| [`docs/development.md`](docs/development.md) | Working on the project: layout, commands, debug switches, packaging |
| [`docs/mcai-format.md`](docs/mcai-format.md) | The `.mcai` format, byte by byte |
| [`docs/tool-reference.md`](docs/tool-reference.md) | The complete reference for all 24 tools, generated from the JSON schemas |
| [`docs/prompt-library.md`](docs/prompt-library.md) | Request templates by building type |
| [`examples/README.md`](examples/README.md) | The example project, and how to regenerate it |
| [`plan.md`](plan.md) | Design document: world model, formats, rendering, tool semantics, agent loop, decisions |

</div>
