# ArchItect

用多模态 LLM 设计 Minecraft 建筑的 harness。

用一句话描述需求（例如"设计一座海边灯塔，塔身收分，顶部有玻璃灯室"），它自行规划、
调用几何工具、截图自检，最后产出一个可回放、可导出、可分享的 `.mcai` 工程文件。

```
你的需求
  → LLM 规划（英文 prompt，工具调用更稳）
  → 调用批量几何工具（extrude / fill_line / run_batch / copy_region…）
  → 渲染截图回灌给它自己看（judge appearance）
  → slice 的 ASCII 平面图读回确认（judge coordinates）
  → verify 结构化自检（声称完成前必须读回）
  → .mcai 工程文件（方块 + 编辑记录 + 对话记录 + 截图）
  → 导出 .schem / .litematic / .obj 拿去游戏或三维软件里用
```

## 主要功能

- 可以用一句话描述需求，由模型规划尺寸、调用几何工具，并截图自检后继续修改
- 可以把 `.mcai` 发给别人：方块数据、编辑记录、完整对话记录与截图都在这个文件里
- 可以回放编辑记录里的每一步；撤销 / 重做在时间线上移动并重放，不新增记录
- 可以手工补改：人改的和模型改的是同一条 op 日志（只差 `source` 字段）
- 可以导出 `.schem`（WorldEdit）、`.litematic`（Litematica）、`.obj`（三维软件）
- 可以接本地 Ollama，用同一套 Provider 配置

## 安装与启动

需要 Node ≥ 22 与 pnpm。

```bash
pnpm install

# 1. 不需要 API key 的完整闭环演示：脚本化造一座灯塔，产出一份 .mcai
pnpm demo:v0
pnpm desktop                       # 打开界面

# 2. 接一个模型
pnpm providers                     # 探测端点：有哪些模型、吃不吃图、单图多少 token
export ARCHITECT_API_KEY=sk-...    # 没配好时上一条命令会提示要设置哪个环境变量

# 3. 让它设计一座
pnpm architect build "造一座 9x9 的林间小屋，云杉木板墙、圆石地基、斜坡屋顶，正门朝南开" \
  --out hut.mcai

# 4. 看结果
pnpm architect slice hut.mcai --axis y --index 1     # ASCII 平面图
pnpm architect shoot hut.mcai --out hut.png --view iso_ne
pnpm architect export hut.mcai --out hut.schem       # 拿去游戏里 //schem load
```

还没接模型时界面也可以打开、查看和导出，对话栏会提示先到「设置」里填接口地址与 API Key。

### 界面

| 位置 | 内容 |
|------|-----------|
| **顶栏** | 新建 / 打开 / 保存 · 撤销 / 重做 · 视图开关 · 设置（最右那个齿轮） |
| **左栏** | 工程信息（名称、版本、方块数、文件名）· 材质清单（每种方块用了多少格、占比）· 编辑记录（每一步一行） |
| **中间** | 视口。拖动转头、滚轮变焦、双击回到自动取景 |
| **右栏** | 与模型的对话：每一次工具调用、每一张截图都在这里，顶部是 token 与花费读数，底部是输入框（⌘/Ctrl + Enter 发送） |
| **右下角** | 当前版本号（例如 `rev 7 / 7`） |

左栏的调色板、机位面板，以及顶栏的成本 / 状态读数当前从界面上隐藏了，实现见 `plan.md` §10.1。

## 工作方式

模型看到的截图与视口共用同一份几何与相机：桌面端由渲染进程的 three.js 画，CLI、CI 与
无 GPU 环境走软件光栅器，后者逐字节可复现，golden 测试比对的是它。两条路共用相机与
叠加层，所以换后端不会换构图。

工具集是 24 个 LLM 工具，以批量几何为主。

| 环节 | 做法 |
|------|------|
| 看图 | 截图上叠坐标标尺与坐标轴，改动范围高亮 |
| 精确编辑 | 走 `slice` 的 ASCII 平面图。截图下采样到约 800×800，一格只有几个像素，只用来看观感 |
| 建模 | `extrude` 画一层平面图长成建筑、`fill_line` 做任意方向的梁与收分、`run_batch` 把多个操作压成一个 revision |
| 朝向 | `copy_region` / `paste_region` / `symmetrize` 用同一个矩阵同时算坐标与朝向；在 1.21.4 全部 27 866 个 state × 9 种变换上验证过是双射 |
| 上下文 | 按 provider 分两套：有前缀缓存的一轮都不裁，没有的只保留最近 6 轮、最多 3 张截图；截图按内容寻址去重 |
| 完成闸门 | 改过东西之后，必须有一次通过的结构化读回才允许结束 |
| 机位 | 机位面板可填精确角度或相机坐标 / 注视点；勾选「模型用这个机位」后，模型的截图从该位置拍，截图标签带上注视点（`az45/el30→(8,5,8)`） |
| 视口 | 第一人称透视相机：`WASD` 移动（抬头按 W 即上升）、空格上升 / Shift 下降、拖动转头、滚轮改视场角、双击回到自动取景 |
| 手工编辑 | 左栏调色板选方块，视口里点击放置、Alt+点击挖掉、Cmd/Ctrl+点击吸取 |
| 撤销 / 重做 | 时间线游标前后移动并重放，不写新的 op。停在历史版本上时发送框会锁住并说明原因 |

## 导出

| 格式 | 用途 |
|------|-----------|
| `.mcai` | 工程文件本身：可回放、可分享，含对话与截图存档 |
| `.schem` | WorldEdit：`//schem load` 然后 `//paste` |
| `.litematic` | Litematica |
| `.obj` + `.mtl` | 三维软件 |

纹理默认使用内置资源包，开箱即用，不需要先装 Minecraft。要换自己的：CLI 加
`--textures <目录|zip|客户端 jar>`，或者设 `ARCHITECT_MINECRAFT_DIR` 指向 `.minecraft`，
程序会去读对应版本的客户端 jar。

## 文档

| 文档 | 内容 |
|------|------|
| [`docs/development.md`](docs/development.md) | 参与开发：工程结构、常用命令、调试开关、打包 |
| [`plan.md`](plan.md) | 设计文档：世界模型、格式、渲染、工具语义、Agent 循环、里程碑、决策记录 |
| [`docs/mcai-format.md`](docs/mcai-format.md) | `.mcai` 格式规范（字节级） |
| [`docs/tool-reference.md`](docs/tool-reference.md) | 24 个工具的完整参考——从 JSON Schema 生成，不会过期 |
| [`docs/prompt-library.md`](docs/prompt-library.md) | 建筑风格需求模板：住宅 / 公共建筑 / 结构装饰 / 修问题 |
| [`examples/README.md`](examples/README.md) | 示例工程怎么看、怎么重新生成 |

## 非目标

连接真实服务器施工、红石逻辑、命令方块、实体布置、生存玩法、多人协作、移动端、
程序化地形生成。只提供导出功能，文件由你自己拿去游戏里粘贴。

## 安全

API key 不进 git，也不进 `.mcai`。`.mcai` 是会被分享的文件，配置里只存
`env:NAME` / `safe:<id>` 这样的指针；系统钥匙串不可用时拒绝落盘，而不是退回明文。
