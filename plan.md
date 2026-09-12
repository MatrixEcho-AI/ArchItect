# ArchItect — 多模态 LLM 驱动的 Minecraft 建筑设计 Harness

> 设计文档 / 实施计划 v1.0
> 目标产物：一个 Node.js + Electron 桌面应用，让多模态 LLM 通过「截图 → 思考 → 编辑方块 → 再截图」的闭环来设计 Minecraft 建筑，
> 并把整个项目（方块数据、编辑历史、对话记录）打包为单一工程文件 `.mcai`。

---

## 目录

1. [一句话定位](#1-一句话定位)
2. [核心设计判断](#2-核心设计判断)
3. [总体架构](#3-总体架构)
4. [世界模型（Voxel Core）](#4-世界模型voxel-core)
5. [.mcai 工程格式规范](#5-mcai-工程格式规范)
6. [编辑模型：EditOp 事件溯源](#6-编辑模型editop-事件溯源)
7. [渲染与截图管线](#7-渲染与截图管线)
8. [LLM 工具集（Tool API）](#8-llm-工具集tool-api)
9. [Agent 循环与上下文工程](#9-agent-循环与上下文工程)
10. [Electron 应用设计](#10-electron-应用设计)
11. [目录结构与包划分](#11-目录结构与包划分)
12. [技术选型](#12-技术选型)
13. [安全、预算与可观测性](#13-安全预算与可观测性)
14. [测试与评估](#14-测试与评估)
15. [里程碑与验收标准](#15-里程碑与验收标准)
16. [风险与对策](#16-风险与对策)
17. [决策记录](#17-决策记录)

---

## 1. 一句话定位

**ArchItect 是建筑的「AI 绘图台」**：LLM 是设计师，harness 是它的手和眼。
手 = 一套确定性、可回放、带约束的体素编辑工具；眼 = 可指定任意机位的渲染截图。

不是「让 bot 在服务器里聊天盖房子」，而是一个**纯粹的离线设计软件**：
全部设计与迭代都在内存中的虚拟工地上完成（快、确定、可回放、零成本试错），
最后**导出一个文件**（`.schem` / `.litematic` / `.mcstructure`），用户自己拿去游戏里用。

> **不连 Minecraft 服务器**（D-04）。本产品不包含 `mineflayer`、不登录账号、不施工。
> 整个世界就是一份可回放的编辑记录 + 方块数据，`.mcai` 就是它的全部。

---

## 2. 核心设计判断

这几条决定了后面所有细节，先立在最前面：

| # | 判断 | 理由 |
|---|------|------|
| D1 | **方块编辑工具不是"放一个方块"，而是"批量几何工具"** | 让 LLM 逐格摆放 1 万个方块是不现实的（token、延迟、错误率都会爆炸）。必须提供 `fill_box` / `fill_line`(对角批量) / `fill_plane` / `extrude` / `symmetrize` 这类**一次调用产生几百到几万方块**的工具。LLM 负责"意图与几何参数"，harness 负责"像素级精确"。 |
| D2 | **世界状态与编辑历史分离：快照 + 追加式事件日志** | 撤销/重做/时间旅行/崩溃恢复/自动化测试回放，全部由这一条换来。`.mcai` 的本质是「一份基准快照 + 一条可重放的操作流」。 |
| D3 | **精确编辑靠"文本切片"，审美判断才靠"图像"** | 图像 token 贵且 LLM 空间推理弱。给 LLM 提供 `slice()` 返回的 ASCII 层视图（带坐标标尺）让它做"这一格该改成什么"的精确操作；图像只用于"看起来怎么样"的整体评审。这是成本与成功率的关键。 |
| D4 | **截图必须带坐标标尺、坐标轴、选区线框、上次编辑高亮** | 裸渲染图 LLM 无法建立像素↔坐标的映射。叠加层是把 2D 图变成可用空间信息的最廉价手段。 |
| D5 | **引擎无关的纯 TS 内核** | `core`/`mcai`/`render`/`tools`/`agent` 不依赖 Electron、不依赖 DOM。这样 CLI 无头跑批、CI 跑回放测试、渲染窗口复用同一套代码，三个场景一套实现。 |
| D6 | **Electron 的 Chromium 就是渲染器，不引入 headless-gl / puppeteer** | 交互视口和工具截图共用同一个 three.js 渲染器与同一份场景构建代码，不存在"UI 里好看、截图里不一样"的问题。也避免原生模块编译地狱。 |
| D7 | **会话期间工作在解压目录，`.mcai` 是打包产物** | 每编辑一次就重写整个 zip 不可接受。会话期用 `project.mcai.d/` 工作目录 + WAL，保存/导出时才原子性打包为 `.mcai`。 |
| D8 | **LLM 只能改"可写工区"内的方块，且只能用它被允许的调色板** | 把"越界/用错方块"从"事后检查"变成"结构上不可能"。约束放在工具层，不放在 prompt 里求 LLM 自觉。 |

---

## 3. 总体架构

```
┌──────────────────────────────────────────────────────────────────────────┐
│ Electron Main Process                                                    │
│  ┌───────────────┐  ┌────────────────┐  ┌─────────────────────────────┐  │
│  │ ProjectService│  │ CaptureService │  │ LLMService (持有 API Key)   │  │
│  │ 打开/保存.mcai│  │ 隐藏窗口截图   │  │ Provider 适配 + 限流 + 计费 │  │
│  └───────┬───────┘  └───────┬────────┘  └──────────────┬──────────────┘  │
│          │ IPC              │ IPC                      │ IPC             │
└──────────┼──────────────────┼──────────────────────────┼─────────────────┘
           │                  │                          │
┌──────────▼──────────────────▼──────────────────────────▼─────────────────┐
│ Renderer (React)                                                          │
│  ┌──────────────┐ ┌───────────┐ ┌──────────┐ ┌────────────┐ ┌──────────┐ │
│  │ 3D 视口      │ │ 对话面板  │ │ 时间线   │ │ 工具调用   │ │ 调色板   │ │
│  │ (three.js)   │ │ + 截图流  │ │ 撤销/分支│ │ 检查器     │ │ + 成本计 │ │
│  └──────┬───────┘ └───────────┘ └──────────┘ └────────────┘ └──────────┘ │
└─────────┼─────────────────────────────────────────────────────────────────┘
          │ MessagePort (世界 diff patch 双向流)
┌─────────▼─────────────────────────────────────────────────────────────────┐
│ Worker Thread: "Studio" (权威状态)                                          │
│  WorldStore ── EditEngine ── UndoStack ── HistoryLog ── ReplayEngine        │
│      ▲                                                                    │
│      │ 调用                                                                │
│  AgentRuntime ── ToolRegistry ── ContextBuilder ── DesignNotes             │
│      │                                                                    │
│      └── 需要截图/网络 → RPC 回 Main (CaptureService / LLMService)          │
└───────────────────────────────────────────────────────────────────────────┘

另外：apps/cli 直接以无头模式实例化 Studio 内核（不启动 Electron），
      用于批处理生成、回放测试、CI。
```

**为什么 Agent 循环跑在 Worker 里**：LLM 调用与批量方块运算都是长任务，放主线程会卡死 UI。
**为什么截图不走 Worker**：WebGL 上下文需要 Chromium 渲染进程，只有 Main 能管窗口。

---

## 4. 世界模型（Voxel Core）

### 4.1 坐标系与约定

- 采用 Minecraft 原生坐标系：**+X 东、+Y 上、+Z 南**，右手系。
- 所有方块坐标为**整数**，代表方块的最小角（block corner），不是中心。
- 所有 `from`/`to` 区间**闭区间**（`from` 与 `to` 的坐标顺序任意，内部自动规范化）。
- 内部统一用 `Int32Array` 存坐标，返回给 LLM 时统一格式化为 `[x, y, z]`。
- 长度单位对外一律说明为 **1 方块 = 1 米**，让 LLM 的建筑尺度直觉可用。

### 4.2 两个存储层次（实测确定的方案）

这是整个项目最关键的一个决定：**磁盘上存"版本无关"的信息，内存里用"生态原生"的结构**，两者之间用一张查表转换。

```ts
// ── 磁盘层：.mcai 内部（版本无关） ──────────────────────────────────
type StateString = string   // "minecraft:oak_stairs[facing=north,half=bottom,shape=straight,waterlogged=false]"

interface Palette {                       // world/palette.json
  minecraftVersion: string                // "1.21.4" —— 仅用于校验与迁移，不参与索引语义
  entries: StateString[]                  // index 0 恒为 "minecraft:air"
}
// world/base.mcvox: 每格 uint16 = entries 的下标（项目本地调色板索引）

// ── 内存层：prismarine-chunk（生态原生，四处零转换） ─────────────────
const column = new ChunkColumn({ minY: -64, worldHeight: 384 })   // 1.18+：24 个 section
column.setBlockStateId(new Vec3(x, y, z), globalStateId)          // 每格 uint16 = 全局 stateId
column.getBlockStateId(new Vec3(x, y, z))
```

打开项目时构建一张 `paletteIndex → globalStateId` 的 `Uint16Array`，此后内存里全部走全局 stateId，**没有逐格转换开销**。

**为什么内存层直接用 `prismarine-chunk`**（已实测）——它让四个方向零转换：

| 方向 | 收益 |
|------|------|
| 渲染 | 可复用 `prismarine-viewer` 的 mesher（见 §7.0），或自写 mesher 直接读 `ChunkColumn.sections` |
| 导出 `.schem` | `prismarine-schematic` 的 palette 本来就是 `getBlockStateId` 的数组，直接对接 |
| ~~mineflayer 施工~~ | ~~`bot.world` 就是 `prismarine-world`~~ —— **已排除**（D-04 不做服务器施工），但保留这行是为了说明为什么数据层选型依然正确 |
| 网络协议 | 读写 chunk packet 的 palette 与它是同一表示 |

实测数据（1.21.4）：`new ChunkColumn({minY:-64, worldHeight:384})` → 24 个 section，支持 y=-60 地下写入；
**空 chunk column ≈ 27 KB**，一个 `64×64×64` 工区 = 16 列 ≈ **428 KB**，内存可忽略。

> ⚠️ **必须知道的一个陷阱**：`ChunkColumn` 的 **x/z 是区块本地坐标 0..15，不是世界坐标**。
> 上游的索引是位运算 `(((y-minY) & 15) << 8) | (z << 4) | x`，**x/z 完全没有掩码**。
> 传世界坐标（x ≥ 16）会让 `(z << 4) | x` 发生**位重叠**——写 `(16,20,16)` 与读 `(16,20,17)` 落到同一个索引。
> 危险之处在于"写进去再读出来"仍然自洽，所以这个 bug **不会自己暴露**，只会静默污染邻居格。
> 因此 `WorldStore` 是 world → local 转换的唯一负责方，`toColumnLocal()` 是强制路径。

```ts
interface BuildVolume { min: Vec3; max: Vec3 }   // 闭区间，LLM 的活动边界

interface WorldStore {                           // 我们对 prismarine-chunk 的封装
  volume: BuildVolume
  palette: Palette                               // 磁盘层调色板
  paletteToGlobal: Uint16Array                   // 打开时构建的查表
  columns: Map<ChunkKey, ChunkColumn>            // 稀疏，未加载视为全 air
  revision: number
}
```

> `WorldStore` 是**唯一**允许写方块的地方。历史、工区约束、撤销、dry-run 全在这一层实现——`prismarine-chunk` 本身不提供任何这些。

- **建筑尺寸不设上限**（D-10）。没有硬编码的边长上限，工区是**项目级设置**，由用户在新建项目时定（LLM 也可以调 `define_volume`）。工区存在的唯一理由是 **LLM 需要知道自己的活动边界**，不是一种限制。
- **不设上限 ≠ 没有成本**，所以给的是**仪表而不是闸门**：

  | 足迹 | 列数 | 内存（27 KB/列，仅算被触碰的列） |
  |---|---:|---:|
  | 128×128 | 64 | ~1.7 MB |
  | 256×256 | 256 | ~7 MB |
  | 512×512 | 1 024 | ~28 MB |
  | 1024×1024 | 4 096 | ~110 MB |
  | 2048×2048 | 16 384 | ~440 MB |

  列**惰性分配**（只有被写过的 chunk 列才占内存），所以大工区不写就不花钱。
  UI 常驻显示实时内存估算与方块数，超过软阈值（默认 512 MB）时提示，但**不阻止**。
- **Y 轴范围也是项目设置**：默认 vanilla `-64..320`（384 高，24 个 section）。要造天空之城就把 `worldHeight` 调大——代价是**每列内存按 section 数线性增长**（`worldHeight` 1024 → 64 section → 每列约 72 KB）。这个换算关系必须写进 UI 提示。
- **不限制的代价落在历史和渲染上，不落在世界存储上**：真正会胀的是 `edits.jsonl`（见 §5）和一次要 mesh 的 section 数。
  对策是 §6.2 的分段 checkpoint + 渲染的视距裁剪，而不是限制用户建多大。
- **方块注册表**来自 [`minecraft-data`](https://github.com/PrismarineJS/minecraft-data)，版本在 `manifest.json` 里钉死。工具层校验所有方块名与 state key 合法，非法输入直接报错给 LLM（错误信息里附候选名，便于自纠）。

### 4.3 编辑引擎语义

每个编辑 op 先算出一个 **BlockChangeSet**（`Map<pos, oldIndex → newIndex>`），再原子提交：

1. **裁剪**：剔除工区外的坐标（计入 `clipped` 计数，不报错，但如实告诉 LLM）。
2. **调色板校验**：不合法方块 → 整个 op 失败，返回带候选建议的错误。
3. **模式过滤**：`replace`（无条件覆盖）/ `keep`（仅 air 可写）/ `overlay`（仅非 air 可写）/ `destroy`（仅删除）。
4. **预算检查**：影响方块数 > 阈值（默认 50 000）需要 `confirm: true`，否则返回 dry-run 报告让 LLM 自己决定。
5. **提交**：单次 `revision++`，发 diff patch 给渲染进程，追加 `EditOp` 到 history，返回紧凑摘要 + 可选截图。

### 4.4 方块状态自动修正（AutoState Pass）

楼梯朝向、栅栏/墙的自动连接、台阶的 `half`、门/活板门的 `facing`、藤蔓/铁丝的连接态——
如果让 LLM 手写这些 state，成功率会惨不忍睹。

因此提供两个层次的辅助：

- **上下文推导**：`place_block("minecraft:oak_stairs")` 时若不写 `facing`，引擎按"玩家视角朝向 / 最近的墙面 / 楼梯所在坡面"推断最合理的 state（可配置推断器链）。
- **后处理修正**：提交后可运行一次 `fixStates(region)`，模仿 WorldEdit 的 `//fixstates`——
  根据邻居关系修正连接类方块的 state（栅栏连接、红石线形状、方块面）。这个 pass 是**幂等**的，也可以让 LLM 显式调用工具触发。

### 4.5 方块 state 编码规则与三个坑（全部实测核实）

本节所有数字都在 `minecraft-data@3.116.0` + `prismarine-block` + `prismarine-chunk@1.41.0` 上实跑得到，不是推断。

#### 4.5.1 事实清单

| 事实 | 实测值 |
|------|--------|
| 1.21.4 方块类型数 | 1,095 |
| 1.21.4 block state 总数 | **27,866**（id 连续，`0..27865`） |
| `stateId 0` | `minecraft:air` |
| uint16 够不够 | 够。27,866 / 65,536 = **42.5%**，余量 2.35×（须加运行时断言） |
| 属性最多的方块 | `redstone_wire` 1,296 个 state；`note_block` 1,150；`fire` 512 |
| `oak_stairs` | 80 个 state（`facing`4 × `half`2 × `shape`5 × `waterlogged`2），`min=2929` `def=2940` `max=3008` |

**全局 stateId 跨版本完全不稳定：**

| 方块 | 1.16.5 | 1.18.2 | 1.20.4 | 1.21.1 | 1.21.4 |
|------|-------:|-------:|-------:|-------:|-------:|
| `oak_log` | 73 | 76 | 130 | 130 | **136** |
| `oak_stairs` | 1954 | 2010 | 2874 | 2874 | **2929** |
| `water` | 34 | 34 | 80 | 80 | **86** |
| 全版本 state 总数 | 17,112 | 20,342 | 26,644 | 26,684 | **27,866** |

→ **同一个数字 136 在 1.16.5 和 1.21.4 代表不同方块。所以 `.mcai` 绝不能持久化全局 stateId**，否则文件绑死游戏版本。这正是 §4.2 分两层的原因。

#### 4.5.2 编码公式（已全量验证）

```
全局 stateId = block.minStateId + Σ (属性序号 × 权重)
权重按 block.states 数组【逆序】做混合进制 —— 最后一个属性变化最快
```

`oak_stairs.states = [facing(4), half(2), shape(5), waterlogged(2)]` → 权重 `facing=20, half=10, shape=2, waterlogged=1`。

```ts
// stateId -> properties（与 prismarine-block 官方实现逐字一致）
let data = stateId - block.minStateId
for (let i = block.states.length - 1; i >= 0; i--) {
  const p = block.states[i]
  props[p.name] = propValue(p, data % p.num_values)
  data = Math.floor(data / p.num_values)
}
// ⚠️ 关键细节：bool 是反的
const propValue = (p, i) => (p.type === 'enum' || p.values) ? p.values[i]
                          : p.type === 'bool' ? !i : i    // 索引 0 = true，索引 1 = false

// properties -> stateId（逆运算）
let data = 0, offset = 1
for (let i = block.states.length - 1; i >= 0; i--) {
  const s = block.states[i]
  if (props[s.name] !== undefined) data += offset * parseValue(props[s.name], s)
  offset *= s.num_values
}
stateId = block.minStateId + data
```

**验证结果：27,484 个 state id 往返（`encode(decode(sid)) === sid`）零失配。**
用官方 `prismarine-block` 与手写公式双路交叉验证，结果一致。

解码 `defaultState` 的 sanity check（全部与 vanilla 语义相符）：

| 方块 | defaultState | 解码结果 |
|------|---:|------|
| `oak_stairs` | 2940 | `[facing=north,half=bottom,shape=straight,waterlogged=false]` |
| `oak_log` | 137 | `[axis=y]` |
| `oak_slab` | 12044 | `[type=bottom,waterlogged=false]` |
| `oak_door` | 4688 | `[facing=north,half=lower,hinge=left,open=false,powered=false]` |
| `water` | 86 | `[level=0]` |
| `oak_leaves` | 279 | `[distance=7,persistent=false,waterlogged=false]` |
| `redstone_wire` | 4193 | `[power=0,north=none,east=none,south=none,west=none]` |

#### 4.5.3 三个必须避开的坑（全部实测复现过）

**坑 1：`minStateId` 不是默认 state。**
713 个带属性的方块里 **566 个**的 `defaultState !== minStateId`（`oak_log`: min=136 / def=137；`grass_block`: min=8 / def=9）。
→ 任何"取该方块第一个 state"的写法都是错的，必须用 `defaultState`。

**坑 2：缺省属性不能用 `values[0]` 补。**
`oak_stairs.half.values = ["top","bottom"]`，`values[0]` 是 `top`，**但默认是 `bottom`**。
实测 `oak_stairs[facing=east]`（省略 `half`/`shape`/`waterlogged`）：

| 补缺省策略 | 结果 | 判定 |
|------|------|------|
| 用 `values[0]` 填 | `half=top`，stateId **2990** | ✗ |
| 用 `defaultState` 解码后继承 | `half=bottom`，stateId **3000** | ✓ |

→ **正确算法：先解码 `defaultState` 得到完整属性集 → 用用户给的属性覆盖 → 再编码。**

**坑 3：字符串里属性的顺序在生态里根本没有统一约定。**
- `minecraft-data` 的解码输出顺序 = `block.states` 的**逆序**（`oak_stairs` → `[waterlogged,shape,half,facing]`）
- 官方 legacy 方块表里又是另一个样：`minecraft:oak_stairs[half=bottom,shape=outer_right,facing=east]`，实测 **692/844 条非字母序**，且与 `states` 声明序也不一致
- 两者互不相同 → 排序是**人为约定**，不可推导

→ 因此三条铁律：

1. **解析必须与顺序无关**：按属性名匹配，绝不按位置。
2. **输出必须规范化**：本项目的规范序定为**属性名字母序**，且**输出全部属性、不省略默认值**，让字符串自包含、可离线 diff、可做集合去重。
3. **相等性判断一律比较 `stateId`，绝不比较字符串**。（导出 `.schem` 时按生态习惯省略默认值即可，反正解析端必须容忍。）

---

## 5. .mcai 工程格式规范

`.mcai` = **ZIP 容器**（deflate，不加密），扩展名注册到 Electron 的文件关联。

### 5.1 内部布局

```
project.mcai
├── manifest.json           # 格式版本、项目 id、MC 版本、revision、校验和
├── project.json            # 用户设置：工区、允许调色板、默认机位、LLM 配置引用
├── world/
│   ├── palette.json        # 有序方块状态表
│   ├── base.mcvox          # 基准体素快照（二进制，zstd/deflate）
│   └── chunks/             # 大体积时的分片（base.mcvox 仅存索引）
├── history/
│   ├── edits.jsonl         # 追加式 EditOp 事件日志（JSON Lines）
│   └── checkpoints.json    # 命名检查点 → {opIndex, worldHash}
├── chat/
│   ├── sessions.json       # 会话 id / 标题 / 时间戳
│   └── messages.jsonl      # 角色、内容块、tool_calls、usage、model
├── captures/
│   ├── index.json          # captureId → {camera, revision, size, sha256, file}
│   └── <captureId>.png     # 对话中引用过的截图（内容寻址去重）
├── assets/                 # 用户导入的参考图、外部 schematic
└── meta/
    ├── stats.json          # 方块直方图、尺寸、成本账本
    └── log.txt             # 人类可读活动日志
```

### 5.2 `manifest.json`

**`chat/` 与 `captures/` 是工程文件的一半，不是附属品。** 只存方块，用户拿到的是一张图；
存了对话，用户能看见"为什么长成这样"——哪一轮提了什么要求、模型调了哪些工具、
每次改完拍了哪张图。所以：

- 存的是**面向人的记录**（说了什么、调了什么、结果如何），**不是**发给模型的原始消息。
  后者带着 system prompt、工具 schema、图片 base64，既有重复又可能夹着不该随文件分享的内容
  （§9.2 那份是缓存前缀，不是档案）。
- 截图**内容寻址**：`id` = sha256 前 16 位，同一张图只存一份，索引与文件天然一一对应。
- **缺了对话不算损坏**：老工程、或被裁剪过的最小工程，方块数据仍然完全可用，
  不该因为"没有对话"就打不开。索引与文件对不上只**报告**，不阻断。
- 一次 LLM 响应里的多个工具调用**合并回同一条 assistant 消息**——事件流把它们拆成了
  多条事件，档案里再拆开就会出现一串没有内容的空行，而"这一轮模型想做什么"恰恰最该看清。

```jsonc
{
  "formatVersion": "0.1",            // 格式版本，独立于 app 版本
  "appVersion": "0.1.0",
  "projectId": "01J8Z...",           // ULID
  "name": "Medieval Lighthouse",
  "minecraftVersion": "1.21.4",
  "createdAt": "2025-01-01T00:00:00Z",
  "modifiedAt": "2025-01-01T03:00:00Z",
  "revision": 184,                   // = edits.jsonl 行数
  "baseRevision": 150,               // base.mcvox 对应的 revision
  "worldHash": "blake3:...",         // 全量体素哈希，用于一致性校验
  "counters": { "ops": 184, "captures": 37, "llmCalls": 92 }
}
```

### 5.3 `EditOp`（`history/edits.jsonl` 每行一条）

```jsonc
{
  "id": "op_000184",
  "rev": 184,
  "ts": "2025-01-01T02:59:59.120Z",
  "source": "llm",                   // llm | user | import | system
  "actor": "assistant",              // 会话内标识
  "tool": "fill_line",
  "args": { "from": [0,4,0], "to": [15,19,15], "block": "minecraft:spruce_planks", "radius": 0.5 },
  "result": { "changed": 1024, "clipped": 0, "truncated": false },
  "patch": "b64:zstd...",            // 可选：变更集二进制（有 base 快照时可省略）
  "durationMs": 12,
  "correlationId": "turn_0042"       // 关联同一次 LLM 响应里的多个 op
}
```

- `patch` 可选：有基准快照时，重放 `args` 即可重建，不必存 diff。存 patch 只是为了**快速跳转**（时间线拖动时不必从头重放）。策略：每 50 个 op 存一次全量快照，其余存 patch。
- **重放确定性**：`base.mcvox` + `edits.jsonl` 必须能逐格重建任意 revision 的世界。这是强制不变式，由测试守。

### 5.4 打包与崩溃安全

- 会话期：`<project>.mcai.d/` 解压工作目录 + `wal.jsonl` 写前日志。
- 保存：把工作目录原子性重新打包为 `.mcai`（先写 `.tmp`，`fsync`，再 `rename`）。
- 崩溃恢复：重开时发现 `.mcai.d/` 比 `.mcai` 新 → 提示恢复，WAL 重放到最后一条完整记录。
- 读-only 打开：可直接流式读 zip 内的 `manifest.json` / `palette.json` / 缩略图，用于文件浏览器预览，无需全解压。
- **确定性打包**：zip 内条目按固定顺序、固定时间戳写入 → 相同内容产生相同哈希，方便 git 之外的内容寻址与回归测试。

---

## 6. 编辑模型：EditOp 事件溯源

```
base.mcvox (rev 150)  ──replay──▶  rev 151 ──▶ 152 ──▶ ... ──▶ 184 (当前)
                                    ▲                       ▲
                              checkpoint "屋顶完成"    当前编辑位置
```

能免费得到的能力：

| 能力 | 实现 |
|------|------|
| 撤销 / 重做 | 游标在 op 序列上前后移动 + 重放 |
| 时间线拖动预览 | 从最近 checkpoint 重放到目标 rev |
| 分支试错 | "从这里换个方案试试" → fork 出新的 op 序列（分支记录在同一 jsonl 里，用 `branch` 字段） |
| 精确回滚 LLM 的一步 | UI 上定位到 `turn_0042` 的 `correlationId`，一键回滚该轮全部 op |
| 自动保存 | 追加 jsonl 即完成，无全量写 |
| 确定性测试 | 录一段 op 脚本 → 断言最终 `worldHash` |
| 成本归因 | 每个 op 挂 token 消耗，能算出"这面墙花了几分钱" |
| LLM 自省 | `get_history({last:20})` 让 LLM 知道自己刚才干了什么 |

**游标只有一个：`store.revision`。** 它不单调——撤销、时间旅行都会让它变小，
而它始终**一一对应**一个世界状态（所以拿它当缓存键是安全的）。
`ReplaySession` 曾经另存一份 `cursor`，那意味着"世界写着 rev 7、游标还停在 3"
这类双真相：撤销、时间旅行、撤销之后再编辑各自改动一份，谁都不知道对方干了什么。
现在没有第二份。

**在历史版本上继续编辑 = 从这里分叉。** 新 op 想占的编号已经被旧的占了，
所以先把日志**截断**到游标处再记。这是分叉的简化版：被丢弃的那条支线**真的没了**，
`branch` 字段那种"两条支线都留在同一个 jsonl 里"的完整形态还没做（见 §17.2）。
丢数据这件事不能默默发生，所以两道闸：**用户停在历史版本上时不许发消息**
（界面禁用输入框并写清原因），模型自己 `undo` 之后再编辑则按正常的"撤销后换个做法"
处理，且状态行会明确告诉它后面还有几步会被丢掉。

**内容不在 op 流里的，就是版本 0。** 导入的 schematic、`.mcai` 的 base 快照、
测试夹具用 `setBlock` 铺的底——它们都是"打开时看到的样子"，不属于任何一步编辑。
所以导入之后游标归零，之后的编辑从 rev 1 开始数。不归零的话"世界的版本"
与"日志长度"从第一笔起就是两回事，后面全对不上（`EditLog.record` 会直接报错，见 D-58）。

这条"rev 0 不是空世界"的语义有一个直接后果：**往后退不能靠"清空再重放"**。
`ReplaySession.seek()` 早先就是这么写的，于是"撤销到最开始"会把导入进来的内容整栋删掉
（清空之后没有任何 op 能把它放回来）。现在改成**逐条反向应用** `ChangeSet.inverted()`：
只碰被改动过的格子，既正确又更快（见 D-70）。

---

## 7. 渲染与截图管线

### 7.0 渲染层选型：复用 mineflayer 生态的 mesher，自己写渲染器（已实测）

#### 7.0.1 先纠正一个层次混淆

`mineflayer` **本身不渲染任何东西**——它是协议客户端。真实渲染链路是
`mineflayer → prismarine-world/chunk → prismarine-viewer(three.js) → canvas`。
所以"用 mineflayer 渲染"落到实处其实是"用不用 `prismarine-viewer`"。三层必须拆开：

| 层 | 选型 | 说明 |
|----|------|------|
| **数据层** | `minecraft-data` + `prismarine-chunk` + `prismarine-world` | ✅ **采纳**（§4.2 内存层直接用 `ChunkColumn`） |
| **几何层（mesher）** | vendor `prismarine-viewer` 的 `models.js` + `modelsBuilder.js` | ✅ **采纳**（见 7.0.2） |
| **渲染层** | 自研 three.js（最新版） | ✅ 自研，但要写的很少 |

#### 7.0.2 关键实测：mesher 与 three.js 完全解耦

| 文件 | 行数 | `THREE.` 引用数 |
|------|-----:|---------------:|
| `viewer/lib/models.js`（方块模型 → 几何体） | 509 | **0** |
| `viewer/lib/modelsBuilder.js`（模型变体解析） | 144 | **0** |
| `viewer/lib/worldrenderer.js`（three.js 绑定） | 184 | 9 |

`models.js` 的 `getSectionGeometry(sx, sy, sz, world, blocksStates)` 返回的是**纯 JS 数组**：

```js
{ sx, sy, sz, positions: [], normals: [], colors: [], uvs: [], indices: [] }
```

也就是说——**最难的那部分（楼梯/台阶/栅栏/门/火把等非立方体方块的模型解析、旋转、UV 展开）已经是一份不依赖任何渲染引擎的纯几何代码。**
而 `worldrenderer.js` 那 9 处 `THREE.`（`BufferGeometry` / `BufferAttribute` / `Mesh` / `MeshLambertMaterial` / `NearestFilter`）
在现代 three（r150+）里 **API 全部没变**，改写量约 50 行。

**两个包都是 MIT 许可**，vendoring 完全合法（保留版权声明即可），总量仅 **653 行**。

#### 7.0.3 非立方体方块：**vendoring mesher**（原"碰撞盒"方案已废弃，见 D-40）

> **这一节改判了。** 最初的方案是用 `minecraft-data` 的 `blockCollisionShapes` 生成几何，
> 理由是"不必 vendor 653 行 mesher、也不必做纹理图集 UV"。那个理由在**只看轮廓**时成立，
> 一旦要求"渲染得和游戏里一致"就不成立了：
>
> - **碰撞盒不是视觉形状**。栅栏的碰撞盒是一根柱子（没有横杆）、玻璃板是薄片（不连成片）、
>   楼梯只是两块盒子（没有正确的 UV 与光照）。§7.0.3 原文说"比整立方体接近得多"是对的，
>   但"接近得多"和"一样"在 LLM 反馈这件事上是两回事。
> - **平均色抹掉材料差异**。整张 16×16 纹理取平均之后，`stone_bricks` 与 `stone` 只差
>   4/255、`smooth_quartz` 与 `quartz_bricks` 差 2/255。模型给"白色**石砌**塔身"选了石砖，
>   却在截图上看不出它和普通石头有什么不同——"写后读"这道闸门在材料维度上是瞎的。
>
> 现方案：vendor `prismarine-viewer` 的 `models.js`（509 行）+ `modelsBuilder.js`（144 行），
> 自己写纹理图集与一个 z-buffer 三角形光栅器。见 D-39 / D-40 / D-41 与 §7.1。

下面是**废弃方案**的原始记录，保留下来是因为"为什么它看起来够用"值得记住：

实测 `minecraft-data` 的 `blockCollisionShapes`。

```js
stone        [[0,0,0,1,1,1]]                          // 整立方体
oak_slab     [[0,0,0,1,0.5,1]]                        // 半高
oak_stairs   [[0,0,0,1,0.5,1],[0,0.5,0,1,1,0.5]]     // 两级台阶，形状精确
oak_fence    [[0.375,0,0.375,0.625,1.5,0.625]]        // 细柱
oak_door     [[0,0,0,0.8125,1,1]]                     // 薄板
glass_pane   [[0.4375,0,0.4375,0.5625,1,0.5625]]      // 薄片
```

**实测：27 866 个 state 里有 19 441 个（69.8%）不是整立方体**，而建筑师最常用的楼梯、台阶、栅栏、门、玻璃板**恰恰全在非立方体那一类**。

所以"所有方块都画成整立方体"不是"精度略低"，而是**会给 LLM 错误反馈**——栅栏画成实心墙，模型会去"修"一个不存在的问题。

碰撞盒不是视觉形状（栅栏少了连接的横杆），但比整立方体接近得多，而代价只有：读一张表 + 几十行面生成。**不需要 vendor 653 行 mesher，也不需要纹理图集 UV。**

配套的两条实现细节：

1. **只有贴着方块边界的面才做邻居剔除**。楼梯中间那级台阶的侧面即使旁边是实心方块也必须画——它是看得见的。
2. **无碰撞形状的方块**（火把、植物、告示牌，5 374 个 state）用一个居中细柱代替。不处理它们会**完全不显示**，比显示得不精确更糟。

| 部分 | 难度 | 来源 |
|------|------|------|
| 非立方体几何 | ~~困难~~ **易** | `blockCollisionShapes`（1095 个方块 / 4989 个形状） |
| 纹理 | **中** | `minecraft-assets` 的 `textureContent`（base64 PNG，自己写 16×16 解码器） |
| 软件光栅器 | 中 | 正交投影 + 画家算法 + 凸多边形扫描线填充 |
| 相机 / 叠加层 | 易 | 自己控制——这正是不能用现成 viewer 的原因 |
| three.js 绑定 | 易 | 留给交互视口（M5） |
| chunk 增量更新 | 中 | 脏 section 队列 |

> **纹理回退是分层**的：精确匹配 → 后缀剥离（`_fence` 要试多个候选基名，`oak` 不存在但 `oak_planks` 存在）→ 显式别名 → **中性灰**。
> 最后一级必须是灰色而不是随机哈希色：随机色会让一堵墙变成紫色，LLM 会据此建立错误的心智模型。
>
> 这一层兜底现在**只服务纯色路径**（`--plain` 与 OBJ 导出）。纹理路径不使用"平均色"，
> 而是直接采样资源包里的真实纹理；两者共用同一套消息与相机，不共用颜色来源。

### 7.1 纹理渲染（D-39 / D-40 / D-41）

| 层 | 来源 | 说明 |
|----|------|------|
| 方块状态 → 模型 | `minecraft-assets` 的 `blocksStates` + `blocksModels` | 原版模型 JSON：`parent` 继承、`multipart` 条件、元素旋转、逐面 `uv` |
| 模型 → 三角形 | vendor 的 `models.js` + `modelsBuilder.js` | 509 + 144 行，MIT，`THREE.` 引用数 = 0 |
| 纹理 | 资源包 `blocks/*.png`，自己解码并打成 1024×1024 图集 | 纯 JS，不依赖原生 `canvas`。动画纹理只取第一帧 |
| 光栅化 | 自研 z-buffer 三角形光栅器 | 正交投影 ⇒ 仿射 UV 插值**精确**，不需要透视校正 |
| 光照 | 原版方向明暗（顶 1.0 / 底 0.5 / 南北 0.8 / 东西 0.6）× AO × 生物群系着色 | **不是**"某个方向的一盏灯"——原版就是这三层相乘 |

**为什么需要 D-41 那一处上游修改**：`models.js` 用 `block.name.includes('air')` 跳过空气，
而 `oak_stairs` 里含 "st**air**s"。1.21.4 里有 **57 种楼梯**会因此完全不渲染。
楼梯是建筑里最常用的方块之一，这个 bug 必须修。

**已知差异**（如实记录，不假装一致）：`.mcai` 没有生物群系数据，草/树叶/水的着色固定用平原；
水不是流体模拟高度（不按邻居算液面），而是按水源方块铺满一格。

#### 7.1.1 两条渲染路径（D-47）

| | 交互视口（桌面渲染进程） | CLI / CI / 无 GPU 环境 |
|---|---|---|
| 引擎 | three.js / WebGL（`apps/desktop/src/renderer/viewport.ts`） | 自研软件光栅器（`packages/render/src/raster.ts`） |
| 抗锯齿 | 离屏超采样 2× 后缩回；窗口本身开 MSAA | 无（拖动时降 1/2 边长再由画布放大） |
| 纹理过滤 | 近邻 + 无 mipmap（与游戏一致） | 近邻 |
| 光照 | 原版方向常量**烘进顶点色** + `MeshBasicMaterial`（没有灯） | 同一组常量，逐三角形乘 |
| 帧率 | GPU，拖动 60 fps | 一次一张，~10–30 ms |
| 确定性 | 不要求（不同 GPU 有差异） | **要求**（golden 测试逐字节比对） |

**在桌面端，模型的眼睛走的是左边那一列**（D-50）：`screenshot` 工具要图时，
主进程把一枪交给渲染进程的 three.js 去画，拿回来的是 PNG；只有在窗口还没起来、
渲染进程挂了、或者这一枪要的是纯色路径（`--plain`，给 golden 测试和 CI 用）时，
才退回软件光栅器。于是"用户拖到的画面"和"模型看到的画面"不只是同一个世界的两种画法，
而是**同一套渲染器**；CLI 没有 Electron，仍然走软件光栅器——`bench` 与 `demo:v0`
的可复现性靠的就是它。

**反过来也成立**：拿不到 WebGL 时（虚拟机、远程桌面、驱动被禁）交互视口会退到
右边那一列——由主进程的软件光栅器出帧，渲染进程只把 RGBA 贴上去（D-54）。
慢、糊、拖动降分辨率，但界面能用；而且这时**两条路自动又合到一起**，
模型看到的和用户看到的仍然是同一个渲染器画出来的。

两条路共用**同一份几何**（mesher 的输出）、**同一份相机**（`cameraBasis` / `fitCamera`）
与**同一份叠加层选项**（`OverlayOptions`），所以构图、标尺、高亮框完全对齐（D-48）。

光照刻意不用 three 的灯：原版明暗是**逐方向常量**，与"太阳在哪"无关；
用平行光去凑只会得到一个"看起来挺立体但和游戏对不上"的结果。

#### 7.0.4 生态维护状态实测（当前 ≈2026-10）

| 包 | 版本 | 最后发布 | 状态 |
|----|------|---------|------|
| `mineflayer` | 4.39.0 | **2026-09-06** | ✅ 活跃 |
| `minecraft-data` | 3.116.0 | **2026-09-05** | ✅ 活跃 |
| `minecraft-assets` | 1.19.0 | 2026-08-22 | ✅ |
| `prismarine-chunk` | 1.41.0 | 2026-07-31 | ✅ |
| `prismarine-world` | 3.7.0 | 2026-03-30 | ✅ |
| `prismarine-schematic` | 1.3.0 | 2026-03-30 | ✅ |
| **`prismarine-viewer`** | **1.33.0** | **2025-02-09** | ⚠️ **停更 ≈20 个月** |

**结论：你担心的"mineflayer 有没有完善的最新版本库"——答案是明确的「有」，而且生态非常活跃。**
唯一掉队的是 `prismarine-viewer`（停更 20 个月、钉死 `three@0.128.0`）。

所以最终方案是"取其精华"：**数据、世界、几何全部来自 mineflayer 生态（健康的那部分），只把渲染层换成自己的 three.js。**

#### 7.0.5 为什么不直接用 prismarine-viewer

1. **`three` 钉死 `0.128.0`**（2021-04）—— 想升级就得 fork，那不如直接用自己的。
2. **它是个 express + socket.io 服务**（`lib/standalone.js`：`express()` + `http.createServer()` + `socket.io`），为"远程浏览器连 bot"设计；我们在同一进程内，这层是纯开销。
3. **headless 路径依赖原生模块**：`lib/headless.js` 直接 `require('node-canvas-webgl/lib')` —— 正是 §12 要避开的。
4. **它的 `utils.electron.js` 只有 15 行**，是个纹理加载器，不是真的 Electron 集成。
5. **机位不可控**：只有第一人称/轨道，**没有**正交立面、任意轴切片、坐标标尺/高亮叠加 —— 而这些是 §2/D4 的核心决策。

> **M3 的落地建议**：直接走 `vendored mesher + 自研渲染器` 的最短路径（先打通单机位出图、验证世界数据管线），
> **不要**为了"先看到东西"临时接上 `prismarine-viewer`——否则叠加层要付双倍代价，还会把 three 0.128 拖进依赖树。

### 7.1 截图是核心 API，不是附属功能

```ts
interface CameraSpec {
  mode: "orbit" | "iso" | "ortho" | "section" | "free" | "heightmap";
  target: Vec3;                 // 注视点（默认工区中心）
  distance?: number;            // 或由 fit: bbox 自动算
  azimuth?: number;             // 水平角，度；0 = 从 +Z 朝 -Z 看
  elevation?: number;           // 俯仰角，度；90 = 正俯视
  fit?: BBox;                   // 自动取景到该包围盒
  fov?: number;
  ortho?: { scale: number };
  section?: { axis: "x"|"y"|"z"; index: number; thickness: number };
  width: number; height: number;
  overlays?: OverlayOptions;
  hide?: ("entities"|"airEdges"|"inside")[];
}

interface OverlayOptions {
  axisGizmo?: boolean;          // 左下角坐标轴指示
  grid?: { step: number; labels: boolean };   // 地面/包围盒标尺（带数字刻度）
  selectionBox?: boolean;       // 工区线框
  lastEditHighlight?: boolean;  // 上一次 op 影响的方块高亮描边
  blockCursor?: Vec3[];         // 标记若干坐标点（LLM 用来指认"这里"）
}

interface Screenshot extends CameraSpec {
  views?: CameraSpec[];         // 多视图合成
  layout?: "single" | "2x2" | "1x3" | "2x3";   // contact sheet
  labelViews?: boolean;         // 每个子图左上角标注视图名
  quality?: "draft" | "final";
}
```

### 7.2 机位预设（给 LLM 的"标准六视图"）

| 预设 | 说明 | 用途 |
|------|------|------|
| `iso_ne/se/sw/nw` | 45° 等轴测四角 | 默认评审视角，一张图看懂体量 |
| `front/back/left/right` | 正交立面 | 看门窗、比例、对称 |
| `top` | 正俯视 + 高度着色 | 看平面布局 |
| `section` | 任意轴切片 | 看内部结构、层高、楼板 |
| `closeup` | 聚焦 bbox | 看细节（雕花、栏杆） |
| `heightmap` | 平面高度伪彩 | 调试地形/坡屋顶 |
| `flythrough` | 走廊内视角序列 | 体验空间感（v1） |

**推荐给 LLM 的默认行为**：整体评审用 `layout: "2x2"` 一张 contact sheet 覆盖 `iso_ne / front / right / top`，
细节确认才用单张 `closeup`。这样一次评审 = 1 张图而不是 4 张，token 立省 75%。

### 7.3 技术实现：同步渲染 + toDataURL

在本项目里，**截图由 Electron 的隐藏窗口完成**，方案如下：

```
Main: CaptureService.capture(spec)
  → 隐藏 BrowserWindow (show:false, 离屏定位, backgroundThrottling:false)
    加载与交互视口同一份 renderer bundle，URL 带 ?mode=capture
  → webContents.executeJavaScript(`window.__architect.capture(${JSON.stringify(spec)})`)
      · 内部：构建/更新 three.js 场景 → renderer.render()  ← 同步调用，不依赖 rAF
      · 然后 canvas.toDataURL("image/png")                  ← 需要 preserveDrawingBuffer:true
  → 返回 base64 → Main 落盘 captures/<hash>.png + 登记 index.json
```

关键点：

- `WebGLRenderer.render()` **是同步的**，不需要 requestAnimationFrame，因此隐藏窗口不合成也能出像素。
- `preserveDrawingBuffer: true` 是必须的（否则 `toDataURL` 可能拿到空帧）。仅截图窗口开启，交互视口不开，避免性能损失。
- **降级链**：① `executeJavaScript` + `toDataURL` → ② `webContents.capturePage()` → ③ 纯 JS 等轴测软件光栅器。
- **内容寻址缓存**：`hash(worldRevision + cameraSpec + overlayOptions)` → 命中则秒回，不重复渲染、不重复消耗 LLM 图像 token。LLM 反复要同一个角度是常态，这个缓存性价比极高。

### 7.4 纯 JS 等轴测后端（重要）

一个不依赖 WebGL 的软件光栅器，用画家算法从后往前绘制等轴测立方体（支持方块平均色 + 简单明暗）。

存在的理由，不是炫技：

1. **CI 可跑**：WebGL 出图在不同 GPU 上有细微差异，无法做像素级 golden test；软件光栅器完全确定。
2. **无 GUI 环境可用**：CLI 批处理、Linux server 上没有显示器时仍能出图。
3. **降级兜底**：显卡驱动异常时应用不至于瞎掉。
4. **极快**：小体量的等轴测缩略图能在几毫秒内出，适合做项目缩略图与时间线预览。

代价是画面不如 PBR 漂亮——所以它只用于测试、缩略图和兜底，**给 LLM 的正式评审图走 WebGL 后端**。

### 7.5 材质与视觉

- 方块纹理来自客户端资源包，本地解包出纹理图集（`assets/blocks/*.png`）。需要在首次运行时从用户提供的 `.minecraft/versions/<v>/<v>.jar` 提取，或下载官方资源包（注意授权，见风险表）。
- 简单光照：半球光 + 定向光 + 环境光遮蔽（AO）近似，不做阴影贴图（对 LLM 理解形状无帮助，纯浪费性能）。
- 可加 `xray` 模式：只渲染结构骨架，便于 LLM 看内部。

---

## 8. LLM 工具集（Tool API）

工具描述是喂给 LLM 的 prompt 的一部分，**必须写得像给一个新来的实习生看**：说清单位、坐标系、边界行为、开销。

### 8.1 编辑类

| 工具 | 说明 | 版本 |
|------|------|------|
| `place_block` | 放单格。`{pos, block, mode}` | v0 |
| `fill_box` | 轴对齐长方体填充。`mode: replace\|keep\|overlay\|hollow\|outline\|shell` | v0 |
| **`fill_line`** | **对角/任意方向批量填充（3D Bresenham）**。`{from, to, block, radius, taper, step, hollow}`。`radius` 把线变成圆柱梁；`taper` 做锥形（塔尖、尖顶）；`step>1` 做稀疏（脚手架、围栏柱） | v0 |
| `fill_plane` | 三点确定的**任意斜面**，用于斜屋顶、斜撑、非轴对齐墙面。`{p1,p2,p3, thickness, block}` | v0 |
| `extrude` | **2D 多边形轮廓 → 沿轴挤出**。`{points, axis, height, block, hollow, capTop}`。画一层平面图然后长成建筑，是效率最高的一类工具 | v0 |
| `symmetrize` | 沿平面镜像。`{axis, coordinate, source: 'negative'\|'positive'\|'both-merge'}`。对称建筑省一半工作量 | v0 |
| `erase` | 删除（= 填 air）。亦支持 `keep`/`inside` 等模式 | v0 |
| `replace_blocks` | 材质替换。`{region, match: {blocks:[...], tag?}, with}` | v0 |
| `copy_region` / `paste_region` | 区域复制粘贴，支持 `rotate: 0\|90\|180\|270`、`mirror`。**注意：旋转必须重映射方块 state 的 `facing`**，这是易错点，实现里要有专门测试 | v1 |
| `run_batch` | 把多个 op 打包成一次原子提交 = **一个 revision + 一张截图**。降低往返次数的主要手段 | v0 |
| `fix_states` | 对区域跑 state 自动修正 pass（栅栏连接、楼梯朝向等） | v1 |
| `undo` / `redo` | 相对当前游标回退/前进 N 步 | v0 |
| `checkpoint` | 打命名快照（"屋顶完成"），便于回滚 | v1 |

`block` 参数统一支持三种形式，让 LLM 能一次性做出有层次的材质：

```jsonc
"minecraft:stone"                                        // 单一方块
{ "pattern": [["minecraft:stone", 3], ["minecraft:cobblestone", 1]] }   // 加权随机（种子固定，可复现）
{ "gradient": ["minecraft:stone_bricks", "minecraft:deepslate_bricks"], "axis": "y" }  // 沿轴渐变
```

### 8.2 检视类（读操作，不产生 revision，成本极低）

| 工具 | 说明 | 版本 |
|------|------|------|
| **`slice`** | 返回一层的 **ASCII 图**（带 X/Z 标尺与调色板图例）。`{axis, index, range?, legend}`。**精确编辑的主力工具** | v0 |
| `get_region` | 小区域的紧凑结构描述（RLE 或分层 ASCII） | v0 |
| `measure` | 包围盒、体积、方块直方图、非空气占比、层高分布 | v0 |
| `find_blocks` | 按方块名/标签查找坐标（返回聚类摘要而非全部坐标，避免爆 token） | v0 |
| `raycast` | 从一点沿方向找到第一个非空气方块 + 命中面法线。"在墙上开窗"这类需求靠它定位 | v0 |
| **`verify`** | **结构化自检**：LLM 提交一组 `claims`（预期），引擎逐条判定 pass/fail 并给出 actual vs expected。**把"读回确认"从口头约定变成函数调用**（详见 §9.4） | v0 |
| `analyze_structure` | **建筑 linter**：悬空方块检测、无支撑悬挑、门洞高度、对称性评分、调色板一致性、内部是否空心、楼层净高是否可通行 | v1 |
| `get_history` | 最近的 op 列表（让 LLM 知道自己的进度） | v0 |

`slice` 的返回样例（喂给 LLM 实际长这样）：

```
slice(axis=y, index=3)  range x[0..15] z[0..15]   legend:
  # = minecraft:oak_planks     . = minecraft:air
     x→ 0         1
 z   +01234567890123456789
 ↓ 0 |################|
   1 |#..............#|
   2 |#..............#|
   3 |#....######....#|
   4 |#..............#|
   ... (共 16 行)
```

这比一张 1024×1024 的图便宜**几个数量级**，而且不会看错格子。

### 8.3 视图 / 输出类

| 工具 | 说明 |
|------|------|
| `screenshot` | 见 §7.1。返回 image + 文本元信息（"camera: iso_ne, revision: 184, bounds: ..."） |
| `compare_screenshots` | 两张截图的并排 + 像素差异高亮图，用于"这次改动达到预期了吗" |
| `export_model` | 导出 `schem` / `litematic` / `obj`。**不做成 LLM 工具**——导出是一次性的交付动作，不是设计动作，做成工具只会让模型在会话中间乱导文件。落地形态是 `architect export <工程.mcai> --out <文件>`（§8.5） |
| `define_volume` | 设定/调整可写工区 |
| `set_palette` | 限定可用方块集（风格约束，如"只用中世纪材质"） |
| `ask_user` | 人在环路：提出问题并给选项，UI 弹出等待回答 |
| `save_version` | 标记里程碑版本（`"v1 初稿"`） |
| `finish` | 结束设计，输出总结报告 |

### 8.5 互操作与导出（M7）

**导出不进工具集**，理由与上面那条相反：导出是"交付"，不是"设计"。让 LLM 在会话中间导出文件
没有任何收益，只会多一个能写磁盘的工具面。所以它是 CLI 命令 + 界面按钮。

| 命令 | 作用 |
|------|------|
| `architect export <工程.mcai> --out x.schem [--to <rev>]` | 导出 Sponge v3（游戏里 WorldEdit `//schem load` 直接用）|
| `architect export ... --out x.litematic` | 导出 Litematica v6（新版紧凑位打包）|
| `architect export ... --out x.obj` | 导出 Wavefront OBJ + MTL（按碰撞盒几何，进 Blender 看）|
| `architect import <file.schem\|.litematic> --out x.mcai [--size W,H,D]` | 导入外部 schematic 继续编辑 |

`--to` 可以导出**任意历史版本**——"把第 40 版那个屋顶方案单独导出来看看"不用重跑 agent。

### 8.4 工具返回值的通用规范

**永远返回三样东西**：紧凑的文本结果 + 结构化数据 + 可选的图像。

```jsonc
{
  "ok": true,
  "summary": "Filled 1,024 blocks of minecraft:spruce_planks from (0,4,0) to (15,19,15) [mode=replace]. Clipped 0 blocks outside build volume. 12 block states auto-corrected.",
  "data": { "changed": 1024, "clipped": 0, "revision": 185, "bounds": [[0,4,0],[15,19,15]] },
  "image": { "id": "cap_a91f", "width": 768, "height": 768 },
  "cost": { "tokensIn": 1840, "tokensOut": 210, "usd": 0.0031, "ms": 812 }
}
```

错误也必须**可自纠**：

```jsonc
{
  "ok": false,
  "error": "UNKNOWN_BLOCK",
  "message": "\"minecraft:spruce_plank\" is not a valid block. Did you mean: minecraft:spruce_planks, minecraft:spruce_slab, minecraft:spruce_stairs?",
  "hint": "Call search_blocks(name) if unsure."
}
```

---

## 9. Agent 循环与上下文工程

### 9.1 循环结构

```
用户: "设计一座海边灯塔，3 层，顶部有灯室，周围有礁石"
  │
  ├─ [阶段 1 规划]  纯文本、关闭工具 → 输出设计纲要（写进 DesignNotes）
  │     · 尺寸估算、层高、材质方案、分 4~6 个建造阶段
  │
  ├─ [阶段 2 地基]  循环：screenshot → 编辑工具 → screenshot → 自我批评
  │     · 地形/礁石用 extrude + 噪声扰动
  │
  ├─ [阶段 3 塔身]  extrude 圆环轮廓 + fill_line 收分（taper）
  │     · 每完成一段，存 checkpoint，拍 iso 截图自检比例
  │
  ├─ [阶段 4 细节]  closeup 截图 + slice 精确编辑（门窗、栏杆、梯子）
  │
  ├─ [阶段 5 评审]  切到"批评者"角色/模型，看最终 2x2 contact sheet，列问题清单
  │
  └─ [阶段 6 修订]  按清单逐条修，最多 N 轮；不收敛则 ask_user
```

### 9.2 上下文预算管理

这是这个项目**最容易失控**的地方。但策略**取决于 provider 的缓存计费**，不能一刀切。

#### Regime A：有前缀缓存 + 超长上下文（DeepSeek 默认路径）

实测 DeepSeek 定价（每 1M token）：`input $0.14` / `output $0.28` / **`cacheRead $0.0028`** / **`cacheWrite $0`**。
即：**缓存命中便宜 50 倍，而且写缓存不要钱。**

前缀缓存按**逐字节前缀匹配**工作：

> 一旦回头修改历史中间的任何一段——删一轮对话、把旧图换成文字占位——
> 它**之后的所有 token 缓存全部失效**，要以全价重算一次。

算一笔账：

| 操作 | 收益/代价 |
|------|----------|
| 剪掉一张 369 token 的旧图 | 省 `369 × $0.14/1M ≈ $0.00005` |
| 但它后面 100k token 的缓存全废 | 重算 `100k × $0.14/1M ≈ $0.014` |

**剪图省下的钱，比破坏缓存亏掉的钱少三个数量级。**

| 维度 | 做法 | 理由 |
|------|------|------|
| 历史 | **只追加、永不修改** | 让旧内容自然沉淀进缓存前缀 |
| 图像 | **不剪** | 已进缓存的图每个请求只花约 `369 × $0.0028/1M`，可忽略 |
| 省钱点 | **靠 §7.3 的内容寻址缓存在"加进来之前"拦住重复图** | 重复图根本不进上下文，这才是真正的节省 |
| 压缩 | 只在逼近上下文上限时做一次 **compaction** | 付一次全价重写，然后重新稳定 |
| 前缀设计 | `[system prompt][工具 schema][项目简报][DesignNotes]` 必须**逐字节稳定** | 任何动态内容（时间戳、随机 id、当前 revision）一律放到后面 |

配套的工程约束：
- **消息数组只 push，不 splice。** 代码层面禁止改写历史（除非走显式的 `compact()` 路径）。
- **状态行只在历史最前面出现一次。** 首轮把 `[STATE] revision=… blocks=…` 作为第一条 user 消息塞进去；
  之后 revision 的变化由**每条工具结果自己回显**（`writeResultToTool` 每次都带 `revision`），
  不再往历史中间插新消息——插一条就是在中间动刀，它后面的前缀缓存全部失效。
- **禁止在 system prompt 里插时间戳/随机数**（哪怕看着无害），它会把整个前缀缓存打掉。
- **`DesignNotes` 放在前缀末尾而不是历史里**，这样更新它只失效它自己之后的部分。
- 上下文窗口 1M token、输出上限 384k token，所以**上下文长度本身不是约束，成本才是**。

#### Regime B：无缓存或短上下文（本地小模型 / 其他 provider）

退回保守策略：

| 手段 | 做法 |
|------|------|
| **阶段摘要** | 每阶段让 LLM 写 200 字以内的 `DesignNotes`；原始轮次可丢。实现见 `update_notes`（D-71） |
| **滑动窗口** | 只保留最近 K 轮（默认 K=6） |
| **图像剪枝** | 最多保留最近 M 张图（默认 M=3） |
| **优先文本** | prompt 明确指示"精确定位用 slice/measure/raycast，不要为了看清某一格去截图" |
| **工具结果压缩** | `find_blocks` 返回聚类摘要而非 400 个坐标；实现成了“按 regime 的字符上限 + 明说截断了多少”（见 §9.2 状态表） |

由 `ProviderConfig.capabilities` 里的 `promptCache: "auto" | "explicit" | "none"` 与 `contextWindow` 决定走哪个 regime。**两套都要实现，但不能同时开。**

判据落在 `packages/agent/src/context.ts` 的 `contextPolicyFor()`，规则就两条（按顺序）：

1. `promptCache === 'none'` → B。没有缓存，旧 token 每个请求都要全价重付。
2. `promptCache` 有缓存但 `contextWindow < 100k` → 也是 B。这跟钱无关了：**不裁剪就放不下**。

其余情况走 A（包括"能力未知"——宁可多花钱，也不要在未知 provider 上悄悄丢历史）。

**窗口是"请求视图"的变换，不是对历史的修改。** `windowMessages()` 只裁这一次发出去的
那份消息数组；`state.messages` 仍然只追加。混起来的话，B 的裁剪会把用户的对话档案
（以及 `.mcai` 里那份）一起剪掉。裁的时候还有一条硬约束：**`tool` 消息必须跟着它所属的
那条 assistant 一起留下或一起丢掉**——只留 `tool` 会得到一个 API 层面就非法的请求。

实现状况（如实记）：

| Regime B 的手段 | 状态 |
|---|---|
| 滑动窗口（K=6 轮） | ✅ `windowMessages()` |
| 图像剪枝（M=3 张，从**最新往回**数） | ✅ 同上；被剪的那条消息留一句 `(N screenshot(s) omitted)‵，位置与轮次关系不变 |
| 丢掉哪几轮的说明 | ✅ 一句机械生成的 `[CONTEXT]` 占位（头之后、保留轮之前）。**不额外花一次 LLM 调用** |
| 阶段摘要（让 LLM 写 `DesignNotes`） | ✅ `update_notes` 工具（D-71）：**替换式**写入、上限 1200 字符，从**下一轮**起进系统提示的 `[DESIGN NOTES]` 段；落进 `manifest.designNotes`，重开工程不失忆 |
| 阶段摘要（真模型实测） | ✅ `deepseek-flash` 20 轮 / 30 次工具 / 4105 方块 / 6 张截图 / **$0.0386**（98% 缓存命中，`completed`）：模型在**计划确定**与**完工**时各写了一次 `update_notes`，内容确实是"坐标 + 尺寸 + 不允许改的约束"，不是复述需求 |
| 工具结果压缩 | ✅ `formatToolResult` 在进对话前按**策略里的上限**截断：A 12 000 字符、B 4 000 字符（约 3K / 1K token）。截断标记写明少了几百字符、切在行边界上——模型必须知道“这不是全部”，否则会在缺数据的基础上接着下结论。事件与档案发的是**同一份被压过的文本**（否则“模型为什么漏看后半截”在档案里查不出来） |
| "优先文本"的 prompt 指示 | ✅ 现有 prompt 已经有（"精确坐标用 slice，截图只用来看观感"） |

### 9.3 System Prompt 骨架（**英文**，D-11）

> **prompt 用英文、面向用户的对话与 UI 文案用中文**（D-11）。两者受众不同：
> 英文 prompt 的 tool-calling 稳定性更好、token 更省；而用户看到的一切走 §10.4 的 i18n。
> **注意**：这个 block 属于 §9.2 Regime A 的稳定缓存前缀，**逐字节固定**——不许插时间戳、版本号、随机 id。

```
You are ArchItect, a design engine for Minecraft voxel architecture.

[COORDINATES] +X = east, +Y = up, +Z = south. One block = one metre.
[BUILD VOLUME] Writable region: (0,0,0) to (63,63,63). Blocks outside are clipped.
[PALETTE] Only these 24 block types may be used: ...
[TOOL RULES]
 1. Prefer batch tools (fill_box / fill_line / extrude / symmetrize) over per-block place_block.
 2. To locate an exact cell, read an ASCII layer with slice(). Never guess coordinates from a screenshot.
 3. Use screenshots only to judge appearance (proportion, massing, style). One per revision is enough.
 4. Group related edits into a single run_batch call to reduce round trips.
 5. Call measure() before editing to confirm dimensions.
 6. Buildings must be structurally sound: no floating blocks, doorways >= 2 blocks high,
    stairs traversable.

[VERIFICATION DISCIPLINE] (violating these fails the task)
 7. Always refer to positions as absolute coordinates [x,y,z]. Never say "to the left" or "above".
 8. After ANY mutating tool call you MUST call at least one inspection tool
    (slice / measure / verify) to read the result back before claiming completion.
    Never say "done" or "fixed" without a read-back.
 9. Before calling verify() you MUST write down your expectation (expect).
    If you cannot state an expectation, you do not yet know what you are doing.
10. When you cite a screenshot, check its revision against the current revision.
    If they differ, discard that judgement and take a fresh screenshot.
11. When a tool reports willOverwriteNonAir > 0, first explain what is being overwritten
    and why that is acceptable.

12. At every milestone (plan settled / one stage done / a constraint discovered), call
    update_notes with the COMPLETE current plan (<1200 chars). Older turns may be trimmed away,
    and the notes are the only thing that survives; record what a later turn must not undo.

[COMPLETION CHECKLIST] All must pass before you claim the build is done:
 [ ] measure() confirms the dimensions match the request
 [ ] verify() confirms key features (door / windows / stairs) exist at the right positions
 [ ] analyze_structure() reports no floating blocks and doorway clearance >= 2
 [ ] screenshots from at least 2 angles confirm the appearance

[WORKFLOW] Plan -> build in stages -> screenshot + read back after each stage
           -> holistic review when complete -> revise.
[OUTPUT LANGUAGE] Reply to the user in <the interface language>. Keep tool arguments and coordinates in ASCII.
```

**关于 `[OUTPUT LANGUAGE]` 这一条**：prompt 是英文的，但**对用户输出的自然语言要跟界面语言走**（D-01）。
这行必须在 prompt 里显式声明，否则模型会顺着英文 prompt 一路用英文回答——界面切成中文也一样。

### 9.4 写后读：提示词上怎么让 LLM 确认方块摆放

这是 harness 质量的分水岭。先把**三种"确认"拆开**，它们的负责方完全不同：

| 确认类型 | 问题 | 谁来判定 | 手段 |
|---------|------|---------|------|
| **执行确认** | 方块真的写进世界了吗？ | **harness（权威）** | 引擎自己算出了精确的 BlockChangeSet，直接返回 |
| **意图确认** | 我参数写出来的，是我想要的那个形状吗？ | **LLM 自己** | 读回 + 结构化 `verify` |
| **效果确认** | 看起来对不对（比例/风格/体量）？ | LLM（视觉） | 截图 |

> **最常见的误解**是让 LLM 去"确认方块放下了没有"。引擎已经知道答案了，让 LLM 再读一遍纯属浪费。
> 真正需要 LLM 确认的是**第 2 和第 3 类**——那是只有它能判断的。

#### 机制 1：把"读回"从口头约定变成工具调用 —— `verify`

不要靠 prompt 求 LLM 自觉，而是给一个工具，让"验证"变成一次函数调用。**关键是它必须先声明预期**：

```jsonc
verify({
  claims: [
    { check: "block_at",  pos: [7, 6, 1], expect: "minecraft:air" },
    { check: "block_at",  pos: [7, 5, 1], expect: "minecraft:oak_planks" },
    { check: "count",     match: { blocks: ["minecraft:oak_planks"] }, expect: { min: 900, max: 1100 } },
    { check: "no_tag",    tag: "minecraft:logs", within: { from:[0,0,0], to:[15,20,15] } },
    { check: "supported", within: { from:[0,0,0], to:[15,20,15] } },   // 无悬空方块
    { check: "symmetric", axis: "x", coordinate: 8 }
  ]
})
// →
{ ok: false, results: [
    { check:"block_at", pass: true  },
    { check:"block_at", pass: true  },
    { check:"count",    pass: false, actual: 1024, expected: "900..1100" },
    { check:"no_tag",   pass: true  },
    { check:"supported",pass: false, failures: [[6,12,3],[7,12,3]], hint:"这些方块下方无支撑" },
    { check:"symmetric",pass: true  }
] }
```

为什么这个设计有效：
- **强迫 LLM 先写下预期**。"我认为 (7,6,1) 应该是 air" —— 这本身就是一次自检，比"看一眼说 OK"强得多。
- **判定由机器做**，不依赖 LLM 的视觉判断或记性。
- **失败直接给 actual vs expected**，下一次工具调用就能修，不需要额外一轮来回。

**`expect` 写出来的属性是"必须匹配"，没写的不约束。** `expect: "minecraft:oak_stairs[facing=west]"`
只检查朝西，不会因为 `half` / `shape` / `waterlogged` 没写就判失败。写成"全串相等"是错的：
工具描述鼓励的那种自然写法会稳定误判，而且 `actual is …` 里给出的完整状态反而成了噪音。
一个属性都不写时退化成只比方块名，与早期行为一致。

#### 机制 1b：完成闸门认"结构化读回"，不认工具名

§13.1 里那条"改完必须读回"的硬约束，在实现上落在**工具结果的 `data.readback === true`** 上：

| 工具 | 什么时候置 `readback: true` |
|------|---------------------------|
| `verify` | 全部 claim 通过 |
| `analyze_structure` | 没有 error 级问题（`score` 可以是 100 以下，warn/info 不拦） |

循环里只判这一个标志，**不需要认识任何一个具体工具名**——将来加新的读回工具（`compare_screenshots`、
`raycast` 复核）不用改循环。这也让"什么算读回"成为工具自己的声明，而不是散落在循环里的特判。

`analyze_structure` 的 error/warn 分级**直接决定闸门会不会卡死**，所以分级必须是"客观可判定"的：

| finding | 级别 | 为什么 |
|---------|------|--------|
| `floating` | **error** | 整列到工区底板都没有支撑、正上方也没东西——这是客观事实，没有歧义 |
| `doorway` | **warn** | 这道检查只能看出"开口不足 2 格高"，**分不清"本该走人的门洞"和"故意开的小窗"**。当 error 就是把闸门压在一个主观判断上 |
| `cantilever` / `headroom` / `leaky` | warn | 都是风格与舒适度问题 |
| `palette` / `symmetry` | info | 只提供信息，永不扣分 |

"主观的检查当 error"是个陷阱：它会让完成闸门变得**不可通过**，而 agent 一旦卡住就会开始乱试。
error 只留给客观事实。

#### 机制 2：带预期的写入（assertive write）

把"写"和"验"压进同一次调用，直接消灭最常见的失败模式——"我以为这里是空的，结果盖掉了刚做好的地板"：

```jsonc
fill_box({
  from: [0,4,0], to: [15,4,15], block: "minecraft:oak_planks",
  expect: { changed: 256, overwrittenNonAir: 0 }    // 不满足 → 整个 op 回滚并报错
})
```

`overwrittenNonAir` 是这里最有价值的指标：**破坏性覆盖**是唯一真正需要确认的操作。

#### 机制 3：破坏性操作强制 dry-run

```
修改类工具（非 keep 模式，或 erase/replace 大面积）→ 引擎先返回预检：
{
  "ok": true, "dryRun": true, "needsConfirm": true,
  "willChange": 4096, "willOverwriteNonAir": 3800,
  "overwriteBreakdown": { "minecraft:oak_planks": 3200, "minecraft:glass": 600 },
  "sample": [[0,4,0],[0,4,1], /* ...20 个 */]
}
```
LLM 必须要么改参数，要么显式 `confirm: true` 重发一次。system prompt 里写死了：`willOverwriteNonAir > 0` 时必须先解释为什么可以覆盖。

#### 机制 4：revision 锚定，防"看着旧截图下结论"

每张截图和每个工具返回都带 `revision`。**过期截图 = 过期推理**——这是多轮视觉 agent 最隐蔽的 bug：
LLM 拿 5 轮前的一张图说"这里没问题"，而那个位置早就被改掉了。

- `screenshot` 返回值里回显 `revision`、`camera`、`target`、`bounds`；
- 上下文里被剪枝的旧图替换为 `"[图 cap_a91f: iso_ne 视角, rev 184, 已过期 → 当前 rev 191]"`；
- prompt 第 10 条要求 LLM 核对 revision 不一致就丢弃该判断。

#### 机制 5：few-shot 范例（纪律性规则光靠描述学不会）

```
用户：在南墙开一扇 2×1 的窗

助手：先确认南墙的位置和材质。
  → raycast({ origin:[8,8,0], direction:[0,0,1] })
  ← 命中 minecraft:oak_planks @ [8,8,1]，面法线 [0,0,-1]
  南墙在 z=1，材质 oak_planks。我在 x=7..8, y=6..7 开窗（净高 2，满足可通行规范）。
  → fill_box({ from:[7,6,1], to:[8,7,1], block:"minecraft:air", mode:"replace",
               expect:{ changed:4, overwrittenNonAir:4 } })
  ← ok: changed=4, overwrittenNonAir=4, revision=185
  现在读回确认（预期：x=7..8,y=6..7 为 air，下方 y=5 仍是 oak_planks）。
  → slice({ axis:"z", index:1, range:{ x:[6,9], y:[5,8] } })
  ← （ASCII 平面图）
  读回与预期一致。
  → verify({ claims:[
       { check:"block_at", pos:[7,6,1], expect:"minecraft:air" },
       { check:"block_at", pos:[8,7,1], expect:"minecraft:air" },
       { check:"block_at", pos:[7,5,1], expect:"minecraft:oak_planks" } ] })
  ← ok: true (3/3)
  完成：窗开在南墙 z=1，范围 x=7..8, y=6..7，净高 2，下方结构完整。
```

#### 机制 6：明确列出"什么不算确认"（anti-pattern）

```
【以下行为不算完成确认】
✗ 只看自己刚才那次工具调用的返回值就宣布完成
   （引擎只保证"执行到了"，不保证"是你要的"）
✗ 只截图不核对 revision / 机位
✗ 用"看起来没问题"代替具体的坐标陈述
✗ 一次 run_batch 里塞入多个未经单独验证的改动
✗ 用 slice 之外的相对描述确认位置（"窗户在门的左边"）
```

#### 机制 7：人在环路（UI 侧）

"每步确认"模式下，修改类工具在 UI 上弹出待批准卡片（显示 dry-run 数据 + 影响范围预览图），人点过才提交。
`verify` 的失败项也在 UI 上高亮，用户可以直接接管某个 claim 去手改。

### 9.5 Provider 抽象

```ts
interface LLMProvider {
  id: "openai" | "anthropic" | "ollama" | "openai-compatible";
  chat(req: {
    model: string;
    system: string;
    messages: Message[];          // 含 image 内容块
    tools: ToolSchema[];
    toolChoice?: "auto" | "required" | { name: string };
    temperature?: number;
    maxTokens?: number;
    cacheHints?: boolean;
  }): Promise<{
    text: string;
    toolCalls: { id: string; name: string; args: unknown }[];
    usage: { in: number; out: number; cachedIn?: number };
    finishReason: string;
  }>;
}
```

- **不内置默认供应商**（D-02）。`ProviderRegistry` 由用户在设置里配置实例，每个实例是一条 `ProviderConfig`：

```ts
interface ProviderConfig {
  id: string                    // 用户自取的实例名，如 "DeepSeek"
  kind: "openai-compatible" | "anthropic"   // 只做这两种协议适配
  baseURL: string               // 云端或本地，同一字段
  apiKeyRef: string             // 指向 safeStorage 里的密文，**绝不落明文、绝不进 .mcai**
  model: string                 // 由 GET /models 发现后由用户选定，**不预填**
  capabilities: {               // 全部由探针实测写回，**不预填、不读静态表**
    vision: boolean
    toolCalling: "native" | "json-mode" | "prompted"
    maxImageEdge?: number
    promptCache: "auto" | "explicit" | "none"   // 决定走 §9.2 的哪个 regime
    contextWindow?: number
    imageTokenCost?: number     // 探针测出的单图 token 数
  }
  cost?: { inPerMTok: number; outPerMTok: number; cacheReadPerMTok?: number }
  compat?: Record<string, unknown>   // 按 provider 覆盖序列化行为（见下方排查清单）
}
```

#### 内置预设：DeepSeek（D-12，M4 联调目标）

预填协议层信息与默认模型；**能力在用户点「测试连接」时实测发现**：

| 字段 | 值 |
|------|-----|
| `kind` | `openai-compatible` |
| `baseURL` | `https://api.deepseek.com` |
| `model` | 默认 **DeepSeek V4.1 Flash**；启动时用 `GET /models` 校验其存在性与能力，可由用户改为账号内的其他模型 |
| `capabilities` | 由探针实测写回（见下），不读静态表 |

> **默认值 + 运行时校验**：预设给出默认模型（V4.1 Flash），但**能力不靠任何静态表断言**——
> 模型清单与多模态支持是运行时事实，官方上新、账号权限差异都会让静态表过期。
> 因此启动时用 `GET /models` 校验，并用探针实测"是否吃图、单图多少 token"，结果写回 `capabilities`。

正确做法是三条都靠运行时发现：

1. **`GET /models`** → 列出该账号真实可用的模型 id
2. **探针请求**（设置页「测试连接」）→ 发一张小图，看是否被接受、`usage` 里图像 token 是多少
3. 把探测结果写回 `capabilities`，此后所有决策读运行时值，**不读静态表**

这样换模型、换账号、官方上新模型都不需要改代码。

**兼容开关（首次调用时验证）**：下面是排查清单，不是先验事实——**首次请求若返回 400，优先怀疑这几项**：

| 疑点 | 含义 | 命中时的处理 |
|---|---|---|
| `requiresReasoningContentOnAssistantMessages` | 回传 assistant 消息时需带上此前的 `reasoning_content` | 在消息序列化层保留该字段 |
| `maxTokensField: "max_tokens"` | 用 `max_tokens` 而非 `max_completion_tokens` | 按 provider 切换字段名 |
| `supportsDeveloperRole: false` / `supportsStore: false` | 不传 `developer` role 与 `store` | 序列化时剔除 |

实现上就是一个 `compat` 对象，按 provider 覆盖默认序列化行为——**是数据，不是硬编码分支**。

**默认值是 `'auto'`，由适配层自己试出来并把结果记住**，而不是让用户去猜：

| 开关 | `'auto'` 的行为 |
|------|----------------|
| `maxTokensField` | 先发 `max_tokens`；**仅当** 400 的正文里明确提到 `max_completion_tokens` 时才换字段重发一次，并把能用的那个记住。判据必须是"正文提到另一个字段名"——否则一次普通的参数错误会被误判，白打一次请求还会把真错误盖掉。 |
| `reasoningContent` | 只有当这个模型**确实返回过** `reasoning_content` 时才在回传 assistant 消息时带上它。DeepSeek 不带会直接报错，OpenAI 收到这个未知字段同样会报错——`'auto'` 两边都对。 |

这样"排查清单"就不需要人工执行：正常路径永远只有一次请求，出问题的那一次自己会走通。

#### 图像 token 计费口径（实测）

用 DeepSeek V4.1 Flash 的视觉计费公式实跑（`PATCH_SIZE=14`、`DOWNSAMPLE_RATIO=3`、`MAX_IMAGE_TOKENS=384`、像素预算 640 000）：

| 输入分辨率 | 实际受理 | **模型真正看到** | 网格 | tokens |
|-----------|---------|----------------|------|-------:|
| 256×256 | 256×256 | 392×392 | 10×10 | 117 |
| 512×512 | 512×512 | 518×518 | 13×13 | 201 |
| 768×768 | 768×768 | 756×756 | 18×18 | 349 |
| 1024×1024 | 800×800 | 756×756 | 18×18 | **349** |
| 4096×4096 | 800×800 | 756×756 | 18×18 | **349** |
| 1920×1080 | 1066×600 | **1036×588** | 25×14 | **369** |

**四条直接影响设计的结论：**

1. **超过约 830×830 的分辨率是免费的**——1024² 与 4096² 同价 349 token。
   所以**不要为了省 token 压缩截图**，按可读性渲染即可。
2. **模型真正看到的天花板是 ~1036×588**。超出的像素**不是变模糊，是压根没送过去**。
   → **永远不要指望 LLM 从截图里数清某一格**。这独立地验证了 §2/D3：
   精确编辑必须走 `slice` 的 ASCII 文本，图像只用于判断观感。
3. **16:9 优于正方形**：有效像素 0.609M vs 0.572M，且更贴合建筑立面。
   正方形**永远达不到 384 封顶**（640k 像素预算先卡住），实测最大 349。
   → **截图默认按 16:9 渲染，约 1280×720**；再大只是浪费渲染时间与字节。
4. **图像成本可以忽略**：单图 369 token ≈ `$0.000052`，8 张 ≈ 2 952 token ≈ `$0.0004`，走缓存再降 50 倍。
   → **"拼 contact sheet 省 token"不划算**：4 张独立 16:9 视图 = 1 476 token（≈$0.0002），
   而拼成一张后每视图有效分辨率从 1036×588 掉到 ~518×294（**差 4 倍**）。
   **默认发多张独立视图，只在上下文吃紧时才拼图。**

**额度与陷阱：**

| 限制 | 值 | 后果 |
|------|-----|------|
| 单图字节记账上限 | 1 MB | 超出部分不计入总账 |
| 单请求累计字节 | 128 MB | 超限时**最旧的图被替换成文字引用** |
| 单请求图片数 | 600 | 超限时同样**最旧优先丢弃** |

后两条的"最旧优先"正好配合 §9.2 的 append-only 策略——**长会话里旧图由服务方自动降级为文字**，不需要我们自己剪。
但要监控一点：**图被静默降级后 `visualTokens` 记为 0**，账面上"很省"，实际是模型已经看不见了。
→ 截图一律压到 **< 1 MB**（PNG 很容易超，必要时转 JPEG），并在工具层断言。

#### 通用约定

- **一份配置同时覆盖云端与本地**：Ollama / vLLM / LM Studio / llama.cpp 全都提供 OpenAI 兼容端点（D-03），走 `kind: "openai-compatible"` 即可，没有特殊分支。
- `capabilities.toolCalling` 是**关键开关**：本地小模型往往没有稳定的 native function calling，需要退化为 `json-mode`（要求模型输出 JSON 并校验）或 `prompted`（用文本协议解析）。**这三种路径必须在 tools 层统一，而不是在 provider 里各写一套**。
- `maxImageEdge` 让本地模型可以配置更小的截图（省显存与延迟），云端模型可以配大图。
- 统一处理各家 tool-calling 与图像格式差异（base64 data URI vs. content block）。
- **所有网络请求只在 Main 进程发起**（见 §13.3）。
- 重试与容错：429/5xx 指数退避；工具参数 JSON 解析失败 → 把原始错误回灌给模型重试一次；连续 N 次解析失败则中止该轮并报错给用户。
- **首次启动引导**（D-14）：提供 4 个预填模板——**DeepSeek / OpenAI / Ollama 本地 / 自定义**。
  模板只填 `baseURL` 与字段格式，**模型 id 与能力一律靠发现与探针得到**，用户只需填 key。
- 设置页「测试连接」是**唯一的真相来源**，它按固定顺序打四个很小的请求：

  | 步骤 | 请求 | 结论 |
  |------|------|------|
  | ① | `GET /models` | 这个 key 到底能调哪些模型。**鉴权失败立刻停下**——后面每一步都会以同样的理由失败，白花钱 |
  | ② | 挑模型 | 按预设的**偏好序列**在真实列表里做 精确 > 前缀 > 包含 匹配。一个都没命中时取列表第一个并标 `guessed`（本地模型命名无法预判，先用上再让用户改） |
  | ③ | 纯文本 + 一个玩具工具 | 能不能调通、`toolCalling` 是 `native` / `json-mode` / `prompted` |
  | ④ | **同一句话，一次带图一次不带** | 两次 `prompt_tokens` 的**差**就是这张图真实的 token 成本。差为 0 说明该网关不单列图像 token——那就**不报数**，报 0 会让成本表盘骗人 |

  探针图是 8×8 的红蓝棋盘，**必须非均匀**：纯色图连"根本没看"都能蒙对。
  结果写回 `capabilities` 并标 `source: 'probe'`；UI 要如实区分"本次实测"和"用户手填"，不能把猜测说成实测。
  部分失败也是结论——"能调通但吃不了图"本身就要写回去，不能整次放弃。

---

## 10. Electron 应用设计

### 10.1 窗口与面板

```
┌─────────────────────────────────────────────────────────────────────┐
│ 菜单 / 工具栏：新建 打开 保存 导出 撤销 重做 │ 模型选择 │ 成本 $0.42│
├──────────────┬──────────────────────────────────┬───────────────────┤
│              │                                  │  对话面板          │
│   调色板      │        3D 视口 (three.js)         │  ├ 用户: 设计灯塔  │
│   搜索/分类   │        · 自由轨道相机              │  ├ AI: 规划...    │
│   可点击放置  │        · 工区线框                 │  ├ 🔧 extrude(...) │
│              │        · 上次编辑高亮              │  ├ 🖼 [缩略图]     │
│   图层/切片   │        · 坐标标尺                 │  ├ 🔧 fill_line(..)│
│   切片轴+索引 │                                  │  └ ⏳ 思考中...    │
├──────────────┴──────────────────────────────────┤                   │
│  时间线：●━━━━━━━━━━━━━━━━━━━━━━━━━━━●          │  输入框 / 停止按钮 │
│  rev 184 · 拖动可预览任意历史版本 · 分支按钮     │                   │
└─────────────────────────────────────────────────┴───────────────────┘
```

**关键交互**：

- **机位面板**：左栏可以直接输入机位——「按角度」填方位/仰角/滚转/缩放，「按坐标」填相机位置与注视点。
  勾上「模型用这个机位」后，它写进**会话相机**（和 `set_camera` 是同一个字段），
  于是模型接下来的截图就从用户看的那个位置拍（D-52）。默认**不共享**：
  随手转两下不该悄悄改掉模型下一张截图的机位。
- **人手接管**：左栏调色板选一个方块，在视口里点一下 = 放置，⌥/Alt + 点 = 挖掉，⌘/Ctrl + 点 = 吸取。
  拖动仍然是转视角（移动不超过 4px 才算点击）。**人改的和模型改的完全同权**——
  都走同一条 op 日志（`source: 'user'`），所以撤销、时间线、导出、`.mcai` 保存全都是现成的。
  ⚠️ **当前左栏调色板整块从界面上隐藏了**（含它里面的「编辑模式」开关，所以视口点击暂不改世界）；
  实现与接线都在，去掉 `index.html` 上的一个 `hidden` 即可恢复。
- **时间线拖动** = 时间旅行。拖到 rev 120，视口立刻变成那时的样子；点"从这里分支"开始另开一条设计路线。
- **工具调用检查器**：每次 LLM 调用工具，时间线上打一个点；点击可展开完整参数、影响范围、耗时、token 消耗，并能"只回滚这一步"。
- **对话是流式的（D-74）**：模型一开始想，列表里立刻出现一条「思考中…」（思考模型还会带上"已经想了多少字"），
  正文到达时**逐字往上长**、末尾一个闪烁光标；重试时上一次的半句话会被丢掉，不会出现重复。
  失败照样在列表里落一条红色消息。⚠️ 这条提示**不在**顶栏状态行上——那行是隐藏的。
- **视口是**第一人称透视的自由相机（D-75 / D-76）**：`WASD` 平移（W/S 沿视线前后，所以抬头按 W 就是上升），
  **空格上升 / Shift 下降**（沿**世界 Y** 的垂直电梯，不跟视线俯仰走，所以抬头时按空格不会斜着飞；
  这里不设加速键——走速本来就随内容包围盒缩放），拖动是**原地转头**——角度绕相机自己的轴转、
  位置一动不动，方向是**画面跟着手走**（往右拖 = 画面往右移 = 相机左转，往下拖 = 相机抬头）；
  拖动灵敏度 = `360 / 视口高度 × 0.75`（按视口归一，且比"一屏转一圈"慢一点，见 `dragUnitFor()`）；
  滚轮改**视场角**（变焦，人不动），双击回到自动取景。
  相机落了地（第一次转头/平移）之后就归用户，自动取景不再插手中途；
  **换工程 / 换预设 / 双击 /「按角度」应用**都会把位置丢掉、重新框住内容。
  模型自己的截图仍是正交等轴测（D-76），所以它看到的是同一个方向上的另一种画法。
- **人在环路**：`ask_user` 工具触发时对话框内联出现选项卡；也可开启"每步确认"模式，由用户点 ✔ 才提交 LLM 的 op。
- **成本表盘**：实时显示本次会话 token 与美元花费，可设上限，超限暂停。
  ⚠️ **当前从界面上隐藏了**（顶栏那格 `#cost`），写入点还在。
- ⚠️ **当前从界面上隐藏的还有**：左栏机位面板、顶栏状态行（机位读数 /「本轮结束（reason）」）、
  顶栏「设置」按钮。**已删除**的：对话面板的「清空」、时间线的「回到最新」、输入框上方的需求模板行，
  以及左栏工程信息里的五行诊断信息（调色板条目数 / Minecraft 版本 / 包围盒 / 模型机位 / 纹理来源）——
  工程信息只留名称、版本（rev / 总步数）、方块数（打开过的工程再加一行文件名）。
  实现都还在，恢复方式见 `apps/desktop/src/renderer/index.html` 与 `renderPanel` 里的注释；
  对应的 i18n 文案随行一起删了（数据仍在 `StudioState` 上）。

### 10.2 进程与 IPC

| 通道 | 方向 | 内容 |
|------|------|------|
| `world:patch` | Worker → Renderer | 增量方块变更（二进制 patch，避免整世界序列化） |
| `world:snapshot` | Worker → Renderer | 打开项目/时间旅行时的全量快照 |
| `ui:viewport` | Renderer → — | 视口自身用 three.js 直接渲染 Worker 给的 chunk mesh |
| `cap:request` | Worker → Main | 截图请求 / 响应 |
| `llm:chat` | Worker → Main | LLM 请求 / 响应（含流式增量） |
| `project:*` | Renderer → Main | 新建/打开/保存/导出 |
| `secret:*` | Renderer → Main | 设置 API Key（只写不读） |

- 视口渲染：Worker 只提供体素数据与"脏 chunk"通知，**mesh 化在 Renderer 做**（需要 three.js 对象），或提供 `mesh` 数据传过去。v0 简单做法：Renderer 侧维护一个镜像 WorldStore（同一个 core 包），通过 patch 同步——省掉 mesh 序列化协议。
- 大世界传输：patch 用 delta 编码（坐标 delta + 调色板索引），实测比 JSON 小两个数量级。
- **截图的方向是 Main → Renderer**，所以走 `webContents.executeJavaScript` 而不是 `ipcRenderer.invoke`
  （后者只能反着走）：页面里挂一个 `window.__architectCaptureShot`，它画完把 PNG 的 data URL 返回。
  几何不跟着过去——渲染进程按 `revision` 自己拉一次 `studio:scene`，那份数据本来就按版本缓存着。
  版本对不上就返回 `null`，主进程退回软件光栅器（D-50 / D-51）。

### 10.3 打包

- `electron-builder`：macOS `.dmg`、Windows NSIS、Linux AppImage。
- `fileAssociations` 注册 `.mcai` → 双击直接打开项目。
- 自动更新（electron-updater）+ 崩溃上报（可选、默认关、明确告知）。

#### 体积：从 837 MB 到 748 MB，以及"什么能裁、什么不能"

`--dir` 打包实测（macOS arm64）：

| 项 | 一开始 | 现在 |
|----|--------|------|
| 整个 `.app` | 837 MB | **748 MB** |
| `app.asar` | 592 MB | 509 MB |
| 其中 `minecraft-data` | 427 MB | 427 MB（**没动**，原因见下） |
| 其中 `minecraft-assets` | 65 275 个文件 | 66.7 MB（只留 1.21.4 的方块贴图） |
| `dist/main.cjs` | 65 MB（含被误打进来的资源包） | 1.3 MB |

裁掉的三块：

1. **`minecraft-assets` 只带 1.21.4 的方块贴图**（~300 MB）。运行时只会按 `fs` 读
   当前版本那一份，其余版本的贴图目录没有用。
   ⚠️ **但每个版本的 `*.json` 必须全留着**：`index.js` 在加载期静态 `require` 它们，
   少一个就是"启动即 `Cannot find module`"。
2. **`three` 挪到 devDependencies**（13 MB）：它已经被 esbuild 打进渲染进程的 bundle，
   运行时不需要再在 `node_modules` 里躺一份。
3. **渲染元数据改成烘出来的 JSON**（65 MB）：`bake.ts` 把方块状态表、模型表、
   方块→纹理反查表、纹理平均色烘成 `packages/render/data/<版本>/*.json`（2.3 MB）。
   不烘的话，主进程的 bundle 会顺着一条 `import` 边把 352 MB 的资源包**整个打进去**
   （实测 65 MB 的 `main.cjs`）——那不是配置问题，是一条 import 边的后果。

**`minecraft-data` 那块 427 MB 动不了**，这条值得记下来：它的 `data.js` 在**加载期
跨版本静态 `require`**（读 1.21.4 会去 require `1.21.1/enchantments.json`），
按目录裁会得到一个"启动即 `Cannot find module`"的包——**试过，就是这么炸的**。
要真砍下去只有一条路：**按"实际被 require 到的文件"生成精确白名单**
（hook `Module._load` 跑一次 `require('minecraft-data')('1.21.4')`，记下它碰过的每个文件）。
预计能从 427 MB 砍到个位数 MB、App 落到 ~330 MB，但它改的是依赖的数据面，
属于"要么不做、要么做到底并写清约束"的那类事——**留作待定（§17.2）**。

> 打包的**正确性**已经验证过：`electron-builder --dir` 产出的 `.app` 直接跑
> `--smoke`（世界 → 截图 → 崩溃恢复 → 导出/导入全过）与窗口抓图（真实纹理正常）
> 都通过。这证明被 esbuild 标成 external 的
> `minecraft-data` / `minecraft-assets` / `prismarine-*` / `fflate` 在 asar 里
> 都能被 require 到——这是打包最容易翻车的地方（当年 pnpm 的隔离 node_modules
> 就踩过一次）。体积是**成本问题**，不是**可用性问题**。

#### 纹理从哪儿来（D-69）

纹理走一个可插拔的 `TexturePack`（`packages/render/src/texturepack.ts`），四种来源：

| 来源 | 什么时候用 | 谁解析 |
|------|-----------|--------|
| **内置资源包** | 默认。装完就有真实纹理，不需要先装 Minecraft | 桌面端主进程 `assetsTexturePack()` |
| 用户资源包目录 / zip / 客户端 jar | 想换自己的材质包 | CLI `--textures <path>`；`resolveTexturePack({kind:'pack'})` |
| 用户的 `.minecraft` 客户端 jar | 自动探测标准安装位置 | `resolveTexturePack({kind:'minecraft'})`（`ARCHITECT_MINECRAFT_DIR` 可指定） |
| **烘好的平均色** | 最兜底一级：没有资源时每格一块纯色，形状/UV/明暗照旧 | `bakedColorTexturePack()` |

两级兜底都是**真实的降级**而不是"渲染坏了"：平均色那一路仍然走同一套网格化与光栅化，
所以画面不会变成满屏洋红棋盘格（那正是"图集里一张纹理都没有"时会出现的症状）。
⚠️ 界面上原来有一行**纹理来源**把当前用的是哪一种写出来，**已按要求移除**（连同左栏
另外四行诊断信息，见 §10.1）：代价是"为什么我的石头没有纹理"不再有一行现成答案，
要恢复就往 `renderPanel` 的 `rows` 里加回一行（`StudioState.texture` 一直都在）。

### 10.4 国际化（D-01：缺省英文，环境或设置说中文才用中文，走 i18n）

**做法：从第一行代码起就用 `i18next` 取文案，绝不硬编码中文字符串。** 缺省语言是 `en-US`——开源项目的读者不一定是中文读者；中文只在环境（`LANG` 一族，或系统语言）说了，或者用户在设置里选了才用。模型对用户的回话语言也跟着它走（§9.3 的 `[OUTPUT LANGUAGE]`）。

落地形态是 `packages/i18n` 一个小包：`src/locales/zh-CN.ts` 是**基准表**，`en-US.ts` 用
`satisfies DeepStrings<typeof zhCN>` 做结构约束——**哪边漏了一个键就是编译错误**，
不会等到运行时在界面上看到一个裸键。包出口是一个类型化的 `t()`：键是编译期校验的点分路径，
写成 `t('chat.plcaeholder')` 直接编译不过。

它是**唯一被打进渲染进程的 workspace 包**：没有 Node 依赖，所以 esbuild 能把它连同 `i18next`
一起塞进浏览器 bundle，翻一句话不需要往返主进程。为此 `detectLocale()` 取环境变量走的是
`globalThis.process?.env` 而不是直接写 `process.env`——浏览器里没有 `process`。

```ts
// packakges/i18n 或 apps/desktop/renderer/i18n
i18n.init({
  fallbackLng: 'zh-CN',
  supportedLngs: ['zh-CN', 'en-US'],
  resources: { 'zh-CN': zhCN, 'en-US': enUS },
  interpolation: { escapeValue: false },
})
```

`zh-CN.json` 的分组结构（按界面区域划分，便于翻译与查找）：

```jsonc
{
  "app":        { "name": "ArchItect", "untitled": "未命名项目" },
  "menu":       { "file": "文件", "new": "新建", "open": "打开", "export": "导出…" },
  "viewport":   { "camera": { "iso_ne": "等轴测·东北", "front": "正立面" },
                  "overlay": { "ruler": "坐标标尺", "lastEdit": "上次编辑高亮" } },
  "chat":       { "placeholder": "描述你想建造的建筑…", "stop": "停止",
                  "toolCall": "调用工具", "thinking": "思考中…" },
  "timeline":   { "revision": "版本 {{rev}}", "branch": "从这里分支", "revert": "回滚这一步" },
  "verify":     { "pass": "通过", "fail": "未通过",
                  "expected": "预期", "actual": "实际" },      // §9.4 的 verify 结果面板
  "settings":   { "llm": { "title": "模型配置", "baseURL": "接口地址",
                           "apiKey": "API Key", "model": "模型名",
                           "test": "测试连接", "vision": "支持图像输入" } },
  "error":      { "UNKNOWN_BLOCK": "未知方块 {{name}}，是否想用：{{suggestions}}",   // 工具错误也要 i18n
                  "CLIPPED": "{{count}} 个方块超出工区被裁剪" },
  "cost":       { "usd": "${{amount}}", "tokens": "{{in}} 入 / {{out}} 出" }
}
```

需要注意的几处：

1. **工具错误信息也要走 i18n**（`error.*`）。§8.4 里说错误信息要"可自纠"——但**给用户看的那一份**要本地化，**给 LLM 看的那一份**保持英文稳定（见 §17.2 第 3 条：prompt 英文、UI 中文）。这两份由同一个错误码 + 参数生成，互不影响。
2. **CLI 也走同一套 i18n**（`packages/cli` 复用 `packages/i18n`），CI 里用 `LANG=en-US` 输出英文日志。
3. **数字/日期格式**用 `Intl.NumberFormat`，不要手写。
4. 语言切换即时生效（`i18n.changeLanguage` + React 重渲染），不需要重启。
5. **不翻译的**：方块 id（`minecraft:oak_stairs`）、`.mcai` 字段名、工具名。这些是协议标识符，翻译会导致 bug。

---

## 11. 目录结构与包划分

pnpm workspace 单仓多包。**约束：`packages/*` 全部不依赖 Electron、不依赖 DOM**（`render` 包中 WebGL 后端除外，它只依赖 three.js 抽象）。

```
ArchItect/
├── package.json                    # pnpm workspaces 根
├── pnpm-workspace.yaml
├── tsconfig.base.json
├── plan.md                         # 本文档
├── docs/
│   ├── mcai-format.md              # .mcai 格式正式规范（手写，但路径/版本/字段由测试核对）
│   ├── tool-reference.md           # 完整工具参考（英文外壳）——**从 JSON Schema 生成**，过期即测试失败
│   ├── tool-reference.zh-CN.md     # 同一份，中文外壳（正文两种语言里都是英文：那是给 LLM 的 prompt）
│   └── prompt-library.md           # 建筑风格 prompt 模板（给用户的输入模板）
├── examples/
│   ├── forest-hut.mcai             # 示例工程：含方块、编辑记录、对话记录、截图
│   └── README.md                   # 怎么看它、怎么重新生成
├── packages/
│   ├── core/                       # 体素世界、调色板、EditOp、UndoStack、Replay
│   │   └── src/{world,palette,editops,geometry,hash,undo}.ts
│   ├── mcai/                       # .mcai 编解码、zip、迁移、WAL、校验
│   │   └── src/{reader,writer,manifest,migrate,wal}.ts
│   ├── render/                     # CameraSpec、网格化、纹理来源、软件光栅器
│   │   ├── src/{camera,atlas,texturepack,assets,baked,bake,mesher,isometric,pick}.ts
│   │   ├── data/<版本>/{render,blockmap}.json   # bake:gen 烘出来的元数据（可复现）
│   │   └── test/golden/*.png                    # 软件光栅器的逐字节基线（4 张）
│   ├── tools/                      # 工具定义 + JSON Schema + 执行器 + 校验
│   │   └── src/{registry,executors/*,schema/*}.ts
│   ├── agent/                      # Agent 循环、上下文管理、prompts、DesignNotes、Provider 配置与发现
│   │   └── src/{loop,context,prompts,usage}.ts + providers/{config,discover,settings,openai,...}.ts
│   ├── i18n/                       # 文案资源（zh-CN 是基准表）+ 类型化 t() 封装
│   ├── interop/                    # schem/litematic/obj 导入导出、NBT、版本迁移
│   └── cli/                        # 无头 CLI：build / replay / shoot / providers / bench
├── apps/
│   └── desktop/                    # Electron
│       ├── main/                   # 主进程：窗口、ProjectService、CaptureService、LLMService
│       ├── preload/
│       └── renderer/               # React + three.js UI（同时充当截图窗口的 bundle）
└── fixtures/                       # 测试用 .mcai、op 脚本、golden 图像
```

**CLI 优先**：`packages/cli` 先于 Electron UI 完成。理由——agent 循环的正确性、成本、成功率，用 CLI 验证比在 UI 里点快 10 倍；UI 只是给同一内核套壳。M4 结束时就应该能用命令行跑出第一个建筑。

---

## 12. 技术选型

| 领域 | 选择 | 理由 |
|------|------|------|
| 语言 | TypeScript (strict, ESM) | — |
| 运行时 | Node.js 22 LTS | — |
| 包管理 | pnpm workspaces | — |
| 桌面 | Electron 33+ | 需要 Chromium 的 WebGL 与隐藏窗口截图 |
| 构建 | electron-vite + Vite | 主/预加载/渲染三端统一配置，HMR 好 |
| UI | React 18 + Tailwind + Radix primitives | — |
| 3D 渲染 | three.js（**最新版，自研渲染器**） | 视口与截图共用；**不用 prismarine-viewer 的渲染器**（见 §7.0） |
| 体素容器 | `prismarine-chunk` 的 `ChunkColumn` | 生态原生 chunk，渲染/导出/施工/协议**四处零转换**（见 §4.2） |
| 体素语义层 | 自研 `packages/core` | `ChunkColumn` 没有历史/工区/撤销/dry-run，必须自己包一层 |
| MC 数据 | `minecraft-data` + `prismarine-block` | 方块注册表 + state 编解码（§4.5 已全量核实） |
| 模型/纹理资源 | `minecraft-assets` | 1.21.4 的 blocksStates / blocksModels / textureContent |
| 几何 mesher | **vendor** `prismarine-viewer` 的 `models.js` + `modelsBuilder.js` | 653 行、**0 处 three 依赖**、MIT（§7.0.2） |
| 导出 | `prismarine-nbt` + `prismarine-schematic` | schem / litematic 读写 |
| 国际化 | `i18next` + `react-i18next` | 缺省 `en-US`；环境或设置说中文才用 `zh-CN`（§10.4） |
| 压缩 | `zstd` (wasm/native) + node `zlib` | 世界与 patch 压缩 |
| 哈希 | `blake3` (或 `node:crypto` sha256 兜底) | worldHash、去重 |
| 校验 | `zod` | 工具参数、manifest、配置文件统一校验 |
| 测试 | `vitest` + `playwright`(Electron E2E) | — |
| 日志 | `pino` | 结构化、可附着到 `meta/log.txt` |
| LLM 调用 | 自研统一 Provider 适配层，**无内置默认供应商** | 用户自行配置（§9.5） |

**不引入**：`headless-gl`（原生编译 + Apple Silicon 麻烦）、`node-canvas-webgl`（`prismarine-viewer` 的 headless 路径依赖它，见 §7.0.5）、`puppeteer`（Electron 自带 Chromium）、`canvas`（同上）、`mineflayer` 本体（**不做真实服务器施工**，见 §1）。

**已明确排除的能力**（不是延后，是不做）：

- ❌ 连接真实 Minecraft 服务器施工 / 用 `mineflayer` 连服务器
- ❌ 实时多人协作、红石逻辑、实体与生物、生存玩法、程序化大世界生成

---

## 13. 安全、预算与可观测性

### 13.1 结构性约束（不靠 prompt 自觉）

- **工区硬边界**：越界写入被裁剪，且计数上报。
- **调色板白名单**：不在表内的方块直接被拒。
- **单 op 影响上限**：默认 50 000 格，超出需 `confirm: true`；硬上限（可配）触发即拒绝。
- **每轮工具调用上限**：默认 40 次，防止 LLM 陷入死循环。
- **每会话预算上限**：token / 美元 / 墙钟时间三重上限，任一触发即暂停并通知。
- **大破坏性操作**：`erase` 全区域、`replace` 全区域等标记为 `destructive`，在"每步确认"模式下必须人工点过。
- **文件系统**：只写项目目录与用户显式指定的导出路径；无 shell 执行；无任意 URL 抓取。

### 13.2 可观测性

- 每次 LLM 调用的完整请求/响应（含图像哈希而非图像本体）落 `chat/messages.jsonl`，可用于复盘与成本归因。
- `meta/stats.json` 累计：op 数、方块数、截图数、token、美元、平均每 op 耗时。
- 内置"回放器"：给一个 `.mcai`，能逐 op 重演出整个设计过程并渲染成视频/序列帧——既是调试工具也是演示工具。
- 结构化日志分级（error/warn/info/debug），debug 级别可 dump 完整 prompt（**但密钥必须打码，见 §13.3**）。

### 13.3 密钥（SK）安全：绝不进 git，绝不进 `.mcai`

**两条独立的红线，必须同时守住：**

> **红线 1**：密钥不进版本库。
> **红线 2**：密钥不进 `.mcai`。**`.mcai` 是要分享给别人的工程文件**——
> 发给朋友、传到论坛、提交到示例仓库，都是正常用法。里面出现明文 key 就是事故。

#### 存储

配置与密钥**分开存**，因为它们的安全等级不同：配置可以随便看、随便贴，密钥不行。

| 场景 | 做法 |
|------|------|
| 桌面应用 · 配置 | `app.getPath('userData')/settings.json`。里面**没有放密钥的地方**——只有 `apiKeyRef: "safe:<id>"` 这样的指针 |
| 桌面应用 · 密钥 | `safeStorage.encryptString(key)` → `app.getPath('userData')/secrets.json`（`mode 0600`）。**不在项目目录里**，也不在任何 git 仓库里 |
| CLI / CI | 只读环境变量，引用写成 `env:ARCHITECT_API_KEY`，**永不读文件** |
| 项目文件 `.mcai` | `project.json` 里只存 **`providerId` 引用**，不存 key 也不存 `apiKeyRef`。打开别人的 `.mcai` 时，用本机的密钥配置去匹配 provider |
| 日志 / 错误信息 | 一律过一层 `redactSecret()`，输出 `***`——**不是打码前几位**，`sk-` 加几个字符已经够用来撞库 |

**`safeStorage.isEncryptionAvailable()` 为假时坚决不落盘**：不降级、不提示"是否仍要保存"，
直接告诉用户改用环境变量。红线是"绝不落明文"，不是"尽量加密"——留一个"就这一次"的口子，
它迟早会变成默认路径。

`parseSettings()` 做两件防守：遇到 `apiKey` / `token` / `secret` 这类字段直接丢弃并记一条 issue
（用户手改 json、或从别处粘配置时很容易带进来）；遇到 `apiKeyRef` 里是密钥长相（`sk-…`）的值
则拒绝启用并明确提示要填引用。**密钥读不回来**：桌面端的桥里没有任何一条通道能把 key 取回渲染进程。

#### `.gitignore` 必须覆盖

`.gitignore` 需要覆盖：

```gitignore
# ArchItect secrets & local state
.env
.env.*
!.env.example
*.key
secrets.json
secrets.bin
.architect/
*.mcai.d/          # 会话期解压工作目录，可能含中间态
**/userData/
```

#### 代码层面的强制约束

1. **密钥类型不可序列化**：定义一个 `SecretRef`（只是个 id 字符串），全代码库**没有任何函数接受裸 key 作为可序列化参数**。类型系统上就传不进 `project.json`。
2. **`.mcai` 写入前扫一遍**：打包时对所有文本条目跑一遍正则（`sk-[A-Za-z0-9]{16,}`、`Bearer\s+\S+`、`api[_-]?key` 等），命中就**中止保存并报警**。这是防御 LLM 把 key 复述进对话记录的兜底。
3. **`chat/messages.jsonl` 落盘前过同一套 redact**。LLM 完全有可能在推理过程里把看到的 key 打印出来。
4. **UI 上密钥字段 write-only**：只显示后 4 位（`sk-****abcd`），设置页读不回明文。
5. **CI 门禁**：加一个 `gitleaks`（或自写正则脚本）到 pre-commit + CI，扫描整个仓库历史。
6. **`.env.example`** 只放占位符 `ARCHITECT_API_KEY=`，且这个文件**是**提交的（作为文档）。

> 我在 M4 联调时你给的 SK：我会用环境变量注入，**不写进任何文件**，不进 `plan.md`，不进示例代码。
> 如果你在对话里贴给我，我会当作一次性输入用完即弃，并提醒你事后去控制台轮换。

---

## 14. 测试与评估

| 层次 | 手段 |
|------|------|
| 单元 | core 几何运算（Bresenham 线、平面、多边形挤出、镜像、旋转 state 重映射）；边界裁剪；调色板校验 |
| 属性测试 | 任意 op 序列 → replay 结果 == 增量应用结果（**最重要的不变式**）；`undo` 后 worldHash 等于历史值；`symmetrize` 幂等；`fix_states` 幂等 |
| **全量枚举测试** | 变换（旋转/镜像）在 **1.21.4 全部 27 866 个 state × 9 种变换**上：结果仍是同种方块的合法 state、在每个方块的区间上是**双射**、旋转四次/镜像两次回到原值。三条不变式用一次扫描同时验，约 1 秒 |
| **文档一致性测试** | 工具参考与生成的版本**逐字节**对比（过期即失败）；格式规范里的路径常量、格式版本、manifest 字段名与代码核对 |
| **协议级端到端** | 起一个按 DeepSeek/OpenAI 兼容协议回话的假端点，用真的 `architect build` 跑完整条链路，然后断言**服务器真正收到的字节**：鉴权头、`stream:true` + `stream_options.include_usage`、工具 schema、图像 part、思维链回传，以及 `max_tokens` 被 400 顶回后自动改用 `max_completion_tokens`。假端点回的是**切碎的 SSE**（正文与工具参数都分片），不拼就过不去 |
| **示例工程夹具** | `examples/forest-hut.mcai` 每次跑测试都真的打开一次，核对方块数、对话条数、截图字节。单元测试是拆开验的，它把链路串起来 |
| 格式测试 | `.mcai` 往返读写 hash 相等；确定性打包；版本迁移（构造旧版 fixture 打开）；WAL 崩溃恢复（杀进程模拟） |
| 渲染测试 | 软件等轴测后端 **golden PNG 逐字节比对**（`packages/render/test/golden/`，4 张：纯色等轴测+叠加层 / 正视 / 俯视 / 纹理路径逐像素采样）；WebGL 后端只做“非空白 + 尺寸正确”的弱断言。基线只吃**确定性输入**（哈希配色或烘好的平均色），所以不依赖 `minecraft-assets`、CI 上逐字节一致；重新签：`ARCHITECT_UPDATE_GOLDEN=1 pnpm test packages/render/test/golden.test.ts` |
| 工具测试 | 每个工具的正常/越界/非法方块/空区域/超大区域用例 |
| Agent 测试 | **录制回放（VCR）**：把真实 LLM 交互录成 fixture，CI 不联网重跑，断言工具调用序列与最终 worldHash |
| E2E | Playwright 驱动 Electron：新建项目 → 输入需求 → mock LLM → 截图 → 保存 → 重开验证 |
| 质量指标 | ① op 一次成功率 ② 每建筑 token 成本 ③ 工具参数 JSON 解析失败率 ④ LLM 截图次数/编辑次数比值 ⑤ 人工评分（1-5） |

**黄金基准任务**（用来量化 prompt 与工具的迭代效果，固定不变）：
1. 10×10×6 小屋，带门、两窗、坡屋顶、烟囱。
2. 半径 6 的圆塔，高 24，顶部雉堞。
3. 15×15 对称庭院，四面回廊，中央喷泉。
4. 跨 30 格的中世纪石桥，带桥墩与拱。
5. 海崖灯塔（综合：地形 + 挤出 + 收分 + 细节）。

每个任务记录：完成时间、token 成本、成功率、人工打分。**这五个数字是本项目唯一真正的进度指标。**

### 14.1 实测基线（`deepseek-flash`，2026-11）

`pnpm bench --max-turns 40 --max-usd 0.25 --out-dir <dir>`，五个黄金任务各跑一遍：

| 任务 | 验收 | 结束原因 | 轮数 | 工具 | 截图 | 输入 tok | 输出 tok | 耗时 |
|---|---|---|---|---|---|---|---|---|
| 小屋 | 6/7 | `completed` | 15 | 21 | 4 | 482 764 | 28 374 | 127 s |
| 圆塔 | 6/6 | `completed` | 8 | 14 | 1 | 413 488 | 51 530 | 211 s |
| 对称庭院 | 6/6 | `completed` | 15 | 27 | 6 | 537 207 | 35 304 | 153 s |
| 中世纪石桥 | 3/4 | `completed` | 32 | 39 | 8 | 2 822 483 | 102 996 | 434 s |
| 海崖灯塔 | 5/5 | `completed` | 24 | 41 | 5 | 1 528 024 | 75 193 | 325 s |

**达成 3/5**；合计 5 783 966 入 / 293 397 出（**99% 输入命中前缀缓存**），约 **$0.19**。
五个任务全部是 `completed`（没有一个是撞轮数上限或被预算刹住的），`--max-usd 0.25` 对单个任务绰绰有余。

两处没过的都是"形状要求没执行到位"，不是 harness 故障：
小屋要"至少两扇窗"，实际 0（模型把墙面填满了）；石桥要"桥面下方有拱形空腔"，实际 0 个架空列。
两座建筑的渲染图都是认得出的木顶小屋与石桥——**验收项没全过 ≠ 建筑不像**。

`bench` 在验收没全过时退出码非 0，这是故意的：它要能直接当 CI 信号用。

### 14.2 录音回放（VCR）

`--record <file.jsonl>` 把每次请求与响应录成一行一条，`--replay <file.jsonl>` 之后**完全不联网**重跑同一遍。

实测：同一段小屋录单（15 轮 / 21 次工具 / 6 张截图 / 654 524 入 / 82 314 出 / 验收 5/7 / 534 格），
实时跑耗时 **359 s**、花费真金白银，回放耗时 **1.7 s**、花费 0，**每一个数字逐项相同**。
"工具执行是确定性的，所以同一段对话必然走到同一处"这条假设因此站得住——回放不需要校验请求体，
走岔了自然会对不上轮数。

有一条边界必须知道：**录音是在响应到手之后才追加的**。一次被打断的跑（超预算、402、断网）
只会留下**已经拿到回复的那几轮**。回放到尽头会直接报"录音只有 N 轮，但对话已经走到第 N+1 轮"
并停下，而不是拿空响应接着跑完——宁可停下来让人一眼看出录音不完整，也不要让重放悄悄产出另一座建筑。
（本次验证用的那段录音正好就是这样断的：倒数第二个请求撞上 402 余额不足。）

---

## 15. 里程碑与验收标准

| 里程碑 | 内容 | 验收标准 |
|--------|------|----------|
| **M0 脚手架** | pnpm 工作区、TS strict、eslint/prettier、vitest、electron-vite 骨架 | `pnpm test` 与 `pnpm dev` 都能跑通空壳 |
| **M1 体素内核** | palette、稀疏 chunk、BuildVolume、EditOp、几何算法（box/line/plane/extrude/symmetrize）、UndoStack | 单元+属性测试全绿；能脚本化搭出一座房子 |
| **M2 .mcai 格式** | zip 读写、manifest、edits.jsonl、replay、checkpoint、WAL、**版本策略**（迁移器暂无，理由见 `docs/mcai-format.md` §7）、CLI `architect info/replay` | 往返 hash 相等；replay 任意 rev 与增量结果一致；杀进程后能恢复；未知字段原样保留、缺可选字段照常打开（有测试钉住） |
| **M3 渲染管线** | CameraSpec、预设机位、叠加层（标尺/坐标轴/高亮）、隐藏窗口截图、内容寻址缓存、软件等轴测后端、CLI `architect shoot` | CLI 能出六视图 contact sheet；重复请求命中缓存；**iso 后端 golden 测试通过**（4 张签名图，改渲染就重新签，见 §14） |
| **M4 工具层 + Agent 循环** | 全部 v0 工具的 JSON Schema 与执行器、工具返回规范、Provider 适配、上下文管理、CLI `architect build "需求"` | **给定文字需求，CLI 能自主产出 `.mcai`，其中有一座可辨认的建筑**；黄金任务 1、2 通过 |

> **M4 的验收分两半，它们需要的东西不一样：**
>
> | 要证明的事 | 怎么证 | 状态 |
> |---|---|---|
> | 整条链路**技术上**是通的：真实 HTTP、请求体字段名、鉴权头、图像 content part、`reasoning_content` 回传、400 的自动重试、`.mcai` 落盘 | **协议级假模型端点**（`packages/cli/test/mock-deepseek.ts`）+ 真跑 `architect build` | ✅ 已证 |
> | 模型**设计得出来**一座可辨认的建筑 | 真模型 + 黄金任务 | ✅ 已证（见下） |
>
> 前者是"代码对不对"，后者是"模型行不行"。把两者混在一起等，会让"代码早就通了"这件事看不出来。
>
> **真模型那一半的实测记录**（`deepseek-flash`，需求就是 v0 那句"设计一座海边灯塔……"）：
>
> | 口径 | 实测 |
> |---|---|
> | 结束原因 | `completed`（不是 `max_turns`，也不是被预算刹住） |
> | 规模 | 31 轮 / 30 次工具调用 / 9 个 op / **4091 方块** / 6 张截图 |
> | 自检 | `verify` 15/15 通过；`analyze_structure` **errors 0**（只剩良性警告） |
> | 花费 | **$0.0524**（输入 1.97M token，其中 **98% 命中前缀缓存**），317 秒 |
> | 产物 | 白石英塔身 + 红色锥顶 + 玻璃灯室 + 礁岩岛 + 木栈桥——**一眼认得出是灯塔** |
> | 可回放 | `architect replay --to 5` 与 `architect shoot` 都能跑；重开哈希一致 |
>
> 同一句需求后来又跑了一次（在游标语义、人手接管、Regime B 都落地之后，用来确认没有回归）：
> 13 轮 / 5 个 op / **2927 方块** / `completed` / **$0.0383**，`verify` 14/14、
> `analyze_structure` 0 错误，同样是一眼认得出的灯塔（形制不同，都成立）。
>
> 花费那一栏值得单独看：两次都**超过 98% 的输入走了缓存**。这正是 §9.2 Regime A 选择
> "不裁剪"的依据——裁一次历史，这 98% 会全部以全价重算。
| **M5 Electron UI** | 3D 视口、对话面板（内联截图）、时间线时间旅行、工具调用检查器、调色板、成本表盘、人在环路 | 全流程可在 GUI 完成；拖动时间线能看到历史状态；双击 `.mcai` 能打开。三条都由 `pnpm desktop:gui-smoke` 里的 DOM 断言钉住（在页面里真派发点击与拖动，而不是读内部状态）。⚠️ 调色板与成本表盘后来按要求**从界面上隐藏**（见 §10.1），"模板填得进输入框"那条验收随模板行删除作废 |
| **M6 高级编辑** | copy/rotate/mirror（含 state 重映射）、fix_states、analyze_structure linter、run_batch 优化 | linter 能抓出测试 fixture 里预埋的 5 类**结构**问题（实现里另加 2 类 info，共 7 个 id） |
| **M7 互操作与导出** | `.schem` / `.litematic` 往返、`.obj` 导出（附录 E.4：碰撞盒几何还原不了状态，所以**故意不做导入**）、导入侧版本迁移、纹理来源（内置资源包 / 用户资源包或客户端 jar / `.minecraft` 自动探测 / 平均色兜底，见 D-69） | 导出的 `.schem` **逐格正确还原**（换一个世界导入后 `contentHash` 对拍）；能导入外部 `.schem` 继续编辑 |
| **M8 打磨** | 安装包、自动保存、崩溃恢复、i18n 补全、文档、prompt 库、示例项目 | 三平台能打包安装；新用户 5 分钟内能产出第一座建筑 |
| | | **打包实测（arm64 Mac）**：macOS `dmg`+`zip` ✅ 出包（136/132 MB，图标已进包）；Linux `dir` ✅ 出目录；`AppImage` 与 Windows `nsis` ⛔ 卡在 electron-builder 自带的 **x86_64** 工具（`mksquashfs` / `wine64`），这台机器没装 Rosetta。出这两个包需要 Rosetta、Docker 或对应平台的 CI——**是工具链架构问题，不是项目配置问题** |

> **打包已实测可用，但体积 837 MB 而不是预估的 220 MB**——差在 `minecraft-assets`
> 把整个资源包装了进去（65 275 个文件）。见 §10.3：这是成本问题不是可用性问题，
> 根本解法是"不内置素材，让用户指向自己的 `.minecraft`"。

> **自动保存是 WAL，不是"每隔几秒存一遍整个工程"。** 全量快照是 O(工区)——
> 64³ 就是 50 万格，而工区**没有尺寸上限**（D-10），256³ 会变成几十 MB 的重复写盘。
> 一次编辑真正新增的信息量是**一个 op**（几十到几百字节），所以只把新 op 追加进一卷小文件；
> 崩溃后拿"上次保存的工程 + WAL 里多出来的 op"恢复。保存成功时基准推进，
> 于是 WAL 的长度只与**保存频率**有关，与工区大小无关。

> **M8 里"文档"这一项有一个硬要求**：工具参考**不允许手写**。schema 是唯一真相，
> `docs/tool-reference.md`（与中文外壳的 `.zh-CN.md`）由 `packages/tools/src/docs.ts` 生成，
> `pnpm test` 在它过期时直接失败。
> 手写的工具文档一定会漂移，而读到错契约的人不会知道自己在读错的。

> **M7 不做 `mineflayer` 连服务器施工**（已决策排除）。这一期的终点是**导出文件**，用户自己拿文件去游戏里粘贴。
> 好处是砍掉了整个"网络连接 / 鉴权 / 断线重连 / 反作弊 / 权限"的复杂度，也去掉了 `mineflayer` 这个依赖。

**v0 = M0–M4**。v0 的判定标准很明确：**命令行里输入一句"设计一座海边灯塔"，得到一个能打开、能回放、能被真人认可为"灯塔"的 `.mcai` 文件。**

---

## 16. 风险与对策

| 风险 | 影响 | 对策 |
|------|------|------|
| **单轮输出不设上限时，连接可能被掐** | 中 | 实测：**非流式**下不设 `maxOutputTokens` 时，`deepseek-flash` 的一轮思考可能超过 **50 秒**，网关在 50 s 处把连接切断（客户端表现为 `agent.network.invalidJson` + `terminated`，正文只读到一半）。根因是"整个响应准备好才发第一个字节"，所以**解法是流式**：请求恒定 `stream: true`（D-73），字节一直在流动，那堵墙不成立，输出也不再设任何上限。兜底两层：流没读出收尾（没有 `[DONE]`、没有 `finish_reason`）判成可重试的 `TRUNCATED`，原样重发一次；真失败时界面上有那条红色失败，而不是"发出去没反应" |
| **LLM 空间推理弱**：看不出自己错在哪，反复改不对 | 高 | ① 坐标标尺/坐标轴/高亮叠加层 ② 优先 ASCII slice 做精确编辑 ③ 用确定性几何工具（extrude/symmetrize）替代逐格操作 ④ 小体量起步（v0 工区 ≤ 64³）⑤ 批评者模型二次评审 |
| **成本失控**：截图多、轮次多 | 高 | 内容寻址缓存、contact sheet 合并视图、图像剪枝、prompt 缓存、模型分级、硬预算上限 |
| **方块 state 错误**（楼梯朝向、栅栏不连） | 中 | 自动推断 + `fix_states` 后处理 + linter 检查 + 专门测试 |
| **WebGL 截图在无头/CI 环境不稳定** | 中 | 软件等轴测后端做确定性测试与兜底；三层降级链 |
| **`.mcai` 随规模变大而变慢** | 中 | 稀疏 chunk + 分片 + zstd + 增量 WAL + 部分读取；工区硬上限 |
| **资源包纹理授权** | 中 | 默认让用户指向本地 `.minecraft` 自行提取；不内置 Mojang 素材；提供纯色/自绘替代材质包 |
| **Minecraft 版本差异** | 中 | 版本钉死在 manifest；`minecraft-data` 驱动注册表；导入导出做版本映射校验 |
| **Electron 隐藏窗口截图取到空帧** | 低 | 同步 `render()` + `preserveDrawingBuffer` 是主路径（不依赖合成）；`show:false` + 离屏定位 + `backgroundThrottling:false`；`capturePage()` 兜底；启动时自检并告警 |
| **LLM 走偏/幻觉工具名或参数** | 中 | zod 严格校验 + 候选建议式错误 + 一轮自动重试 + 每轮调用数上限 |
| **范围蔓延**（红石、生物、多人、地形生成器…） | 高 | 明确非目标（见下），所有新想法进 `docs/backlog.md` 而不是当轮实现 |

**明确的非目标（v0/v1 不做）**：连接真实服务器施工（D-04）、红石逻辑电路、命令方块、实体/生物布置、生存模式玩法、多人协作编辑、移动端、程序化地形大世界生成、实时游戏内同步预览。

---

## 17. 决策记录

### 17.1 设计决策

| # | 决策 | 结论 | 影响 |
|---|------|------|------|
| D-01 | 界面语言 | **缺省英文**，通过 `i18next` 走 i18n 调用，`en-US` 为默认 locale；环境（`LANG` 一族 / 系统语言）说中文、或用户在设置里选了，才用 `zh-CN` | §10.4；UI 文案与错误信息从一开始就过 i18n；模型的回话语言跟着它走 |
| D-02 | LLM 供应商 | **不绑定**。统一让用户配置 API；**内置 DeepSeek 预设作为默认**（D-12） | §9.5 配置驱动 + 预设模板 |
| D-03 | 本地模型 | **接受**。与云端共用同一套 Provider 配置（OpenAI 兼容端点覆盖 Ollama / vLLM / LM Studio） | 不做特殊分支 |
| D-04 | 真实服务器施工 | **不做**。本产品只是软件，**只预留导出功能** | 移除 `mineflayer` 依赖与 M7 施工适配器 |
| D-05 | Minecraft 版本 | **1.21.4** | 钉死在 `manifest.json`，另写迁移器 |
| D-06 | 渲染层 | **自研渲染器 + vendor `prismarine-viewer` 的 mesher**（653 行、0 处 three 依赖、MIT） | §7.0；成本估计 3–5 天 |
| D-07 | 世界数据层 | `prismarine-chunk` 的 `ChunkColumn` | §4.2 |
| D-08 | v0 范围 | M0–M4，CLI 优先、UI 后置 | §15 |
| D-09 | 方块 state 存储 | 磁盘存规范字符串，内存用全局 stateId，查表转换 | §4.5 |
| D-10 | **建筑尺寸** | **不设上限**。工区是项目级设置，只有内存仪表没有闸门 | §4.2（含内存换算表） |
| D-11 | **prompt 语言** | **prompt 英文；面向用户的对话与 UI 中文** | §9.3、§10.4 |
| D-12 | **M4 联调目标** | **DeepSeek**，默认模型 **V4.1 Flash**；能力由 `GET /models` + 探针实测写回 | §9.5 |
| D-13 | **密钥安全** | **不进 git、不进 `.mcai`**（`.mcai` 是可分享文件） | §13.3 |
| D-14 | **配置引导模板** | 预填 4 项：**DeepSeek / OpenAI / Ollama 本地 / 自定义** | §9.5、§10 |
| D-15 | **兼容开关的默认值** | `'auto'`：`maxTokensField` 与 `reasoningContent` 由适配层按 400 正文与实际返回**自己试出来并记住**，用户不用猜 | §9.5；两条最常见集成 bug 变成自愈的 |
| D-16 | **密钥引用模型** | 配置里只有 `env:NAME` / `safe:<id>` 两种**指针**；系统钥匙串不可用时**拒绝落盘**而不是退回明文 | §13.3；配置可安全落盘、进日志、贴 issue |
| D-17 | **能力发现** | `GET /models` + 三条探针（文本 / 工具 / 视觉），结果写回 `capabilities` 并标 `source` | §9.5；模型 id 与"吃不吃图"是运行时事实 |
| D-18 | **完成闸门认标志不认工具名** | 读回由工具结果里的 `data.readback === true` 声明（`verify` 全过 / `analyze_structure` 无 error） | §9.4 机制 1b；加新读回工具不必改循环 |
| D-19 | **linter 只有客观事实算 error** | 主观检查（门洞够不够高、悬挑远不远）一律 warn/info；error 只留 `floating` | §9.4 机制 1b；"主观检查当 error"会让闸门不可通过 |
| D-20 | **变换与状态重映射共用一个矩阵** | 坐标怎么转与朝向怎么转是同一个 3×3 带符号置换；不可表示时保留原值而不是猜 | §8.1、附录 D；这是复制/旋转最经典的 bug 源头 |
| D-21 | **`.schem` 写 v3、读 v2+v3** | 1.20+ 的规范是 v3（VarInt 编码）；网上大多数存量文件是 v2（定宽大端），导入必须认 | 附录 E.1；只写最新、但读要向后兼容 |
| D-22 | **跨版本迁移只做"精确 + 显式改名表 + 报告"** | 认不出来的方块记进 `unknown` 并给候选，**绝不静默填空气**；不做覆盖全部方块的静态表 | 附录 E.5；"看起来成功"比明确报错难查一百倍 |
| D-23 | **导出不进 LLM 工具集** | 导出是交付动作而不是设计动作，落地为 CLI 命令 + 界面按钮 | §8.5；少一个能写磁盘的工具面 |
| D-24 | **互操作的验收靠 hash 对拍 + 手算期望值** | 游戏内无法自动测，所以把"能测的测到底"，并把"不等于游戏一定能读"如实写进命令输出 | 附录 E.6；自测往返证明的是自洽，不是兼容 |
| D-25 | **`.mcai` 存面向人的对话记录，不存原始消息** | `chat/messages.jsonl` 记"说了什么 / 调了什么 / 结果如何"；system prompt、工具 schema、图片 base64 **一律不进工程文件** | §5.1；工程文件会被分享，档案与缓存前缀是两回事 |
| D-26 | **对话与截图缺失不算工程损坏** | 老工程/裁剪工程照常打开；索引与文件对不上只报告不阻断 | §5.1；方块数据可用性不该被附件绑架 |
| D-27 | **工具参考文档从 schema 生成，过期即测试失败** | `pnpm docs:gen` 生成，`docs:check` 与 `pnpm test` 校验；说明文字逐字取自工具描述 | M8；手写文档必然漂移，而读到错契约的人不会知道 |
| D-28 | **示例工程进仓库，并且每次测试都真的打开一次** | 生成完全确定性（固定时间戳/会话 id/脚本 provider），所以 `git diff` 能反映导出逻辑的变化 | M8；它是唯一把"格式→渲染→agent→导出"串起来的夹具 |
| D-29 | **自动保存用 WAL（只追加新 op），不做周期性全量快照** | 一卷 WAL 的长度只与保存频率有关，与工区大小无关；保存成功时基准推进 | M8；工区无上限（D-10），全量快照会被工区大小拖垮 |
| D-30 | **崩溃恢复只在基准工程还在原处时自动进行** | 基准丢了就说不清"恢复出来的是什么"，那时宁可如实说明也不要硬凑 | M8；恢复出一个来路不明的世界比不恢复更糟 |
| D-31 | **`EditOp` 的磁盘形状只能有一个真相** | `encodeEditOp` / `decodeEditOp` 从 core 导出，WAL 复用它们 | WAL 自己 `JSON.stringify(op)` 会把 `patch` 序列化成对象，读回来直接崩（已踩过一次） |
| D-32 | **打包体积不作为可用性门槛** | 先用 `--dir` 验证"能跑"，体积问题留给发布前按需裁剪或改为用户自带资源包 | §10.3；837 MB 是成本问题，不是能不能用的问题 |
| D-33 | **可复现的夹具要注入时钟** | `AgentSession` 接受可选的 `now`；示例工程、回归基线这类产物用它把时间戳钉死 | 不注入的话每次生成都带新时间戳，`git diff` 全是噪音，"这次改了什么"看不出来 |
| D-34 | **预算触顶是停止原因，不是错误** | `StopReason` 加 `budget`，并 emit 一个带用量与金额的 `budget` 事件；CLI 退出码 1、界面单独显示 | 用户填了 `$2` 就必须在 $2 停下——只记账不刹车比不记账更糟 |
| D-35 | **给了美元上限就一定要把预算传下去** | 不在调用点判"有没有价格表"；没有价格表时由 `checkBudget` 判为越界并说明原因 | 在调用点悄悄丢掉，用户就会以为上限生效了（CLI 上刚踩过一次） |
| D-36 | **假模型的断言建立在"服务器收到的字节"上** | 协议级端点记录每一次请求的字段名/鉴权/图像 part/思维链回显，测试断言的是这份日志 | 断言"我们以为发出去的东西"等于什么都没验 |
| D-37 | **单轮输出上限默认不设** | 不发 `max_tokens`，让服务端用它自己的默认（思考模式 64K）；要压成本才用 `--max-output-tokens` 显式设。用户写在设置文件里的值会被 `parseSettings` 原样保留 | 官方口径是"未设置时非思考模式默认 8K、思考模式默认 64K"，比 harness 猜的任何数字都准。真机事故：猜 8192 时思考模型把额度全烧在思维链上，`finish_reason` 回 `length`、正文空、工具调用零，而循环还报 `completed`（后半段已由 D-38 修掉）。**曾经**因为"不设上限 → 单轮生成太久 → 网关 50 s 处掐断"而把默认改成 8000，那条**已废弃**：真正的解法是 D-73 的流式，不是压缩输出 |
| D-38 | **截断与空回复都不是"完成"** | `finish_reason === 'length'` 时先要模型收敛一次，续不动就以 `max_tokens` 停下并说明；空回复单独报 `empty` | "静默失败"是这里最坏的失败模式：用户会看到一个 0 方块的工程和一句"结束原因：completed"，不知道该查什么 |
| D-39 | **默认渲染是纹理渲染，不是平均色** | 走 vendored 的 prismarine mesher（真实方块模型 + 逐面 UV + 原版方向明暗 + AO）；`--plain` 才退回纯色 | 平均色会**抹掉材料差异**：`stone_bricks` 与 `stone` 的平均色只差 4/255，`smooth_quartz` 与 `quartz_bricks` 差 2/255。模型在截图上分不出自己砌的是哪一种，"写后读"这道闸门在材料这件事上等于瞎的 |
| D-40 | **几何用原版方块模型，不用碰撞盒** | §7.0.3 改判：几何来源从 `blockCollisionShapes` 换成 `blocksStates` + `blocksModels` | 碰撞盒不是视觉形状：栅栏没有横杆、玻璃板不连成片、楼梯只是两块盒子。渲染给 LLM 看的图，几何错了就是在给错误的反馈 |
| D-41 | **vendored mesher 必须修掉上游的空气判断** | 上游 `block.name.includes('air')` 改成 `name === 'air' || name.endsWith('_air')` | `oak_stairs` 含 "st**air**s"，1.21.4 里有 **57 种楼梯**被当成空气静默跳过——有楼梯的建筑渲染出来会凭空少掉楼梯。这是唯一一处对上游算法的改动 |
| D-42 | **`screenshot` 必须支持任意机位** | 加 `azimuth` / `elevation` / `scale` / `target` 四个参数；相机解析收在 `cameraForShot` 一处，预设机位退化成"没给角度时的回退值" | 9 个预设覆盖不了"这个屋檐从侧面挑得太远了吗"这类判断。`scale` + `target` 让同一个角度还能变成局部特写，否则模型只能靠猜坐标 |
| D-43 | **交互视口按 revision 缓存网格** | 桌面端拖动只重做光栅化；网格化（3 万格 → 带 UV 的三角形）按 revision 缓存，角度变化不失效 | 实测：32³ 的灯塔网格化 ~180 ms、光栅化 ~10–30 ms。不缓存的话拖动最多 5 fps，"拖不动"就等于没有这个功能 |
| D-44 | **canvas 后备存储尺寸整个会话不变** | 拖动中的半分辨率草稿帧先画进离屏画布，再**放大**贴到固定 900×640 的 canvas 上；绝不改 `canvas.width/height` | 改尺寸会让元素重排、CSS 又把小的那张按 1:1 显示成一小块——真机症状是"画面里叠了好几张图"。固定尺寸从结构上消除了这一类 bug |
| D-45 | **相机有三个自由度：`azimuth` / `elevation` / `roll`，并支持 `eye` + `lookAt`** | `CameraSpec.roll` 绕视线轴滚转；`orientationFromEye` 把"相机放在哪、看向哪"反解成角度；`set_camera` 工具把机位**存进会话**，之后每次 `screenshot` 都用它 | "让用户自己定义相机的坐标、朝向"是这个项目最初的需求之一。`roll` 不能省：少了它，"朝向完全由我指定"就是假的 |
| D-46 | **正交投影下相机距离不影响成像，这一条必须写进工具描述** | `eye` 与 `lookAt` 之间只取方向，`lookAt` 成为画面中心；想放大要调 `scale` | 不写的话模型（和人）都会自然地以为"把相机放远一点建筑就变小了"，然后反复用错误的杠杆调构图 |
| D-47 | **交互视口用 three.js（WebGL），截图按环境选后端** | 桌面渲染进程用 three.js 画方块（MSAA、mipmap、GPU 60 fps），叠加层仍是 2D 画布；主进程的软件光栅器保留给 CLI 与无 GPU 环境（模型截图怎么选后端见 D-50） | 两者的诉求相反：**交互要好看**（抗锯齿、纹理不闪、跟手），**截图要可复现**（CI 与 golden 测试没有 GPU）。早期为了统一而让交互走"每帧 IPC 拿 RGBA"，结果两头不讨好：没有抗锯齿、拖动还得降分辨率 |
| D-48 | **几何与相机在两条渲染路径之间共享** | 两条路都吃 mesher 的输出（世界坐标 + UV + AO 顶点色），都用 `cameraBasis` / `fitCamera` | 各写一套的话，视口里看到的和模型看到的会是**两个不同的世界**，而"模型以为自己在看什么"正是这个项目最不能出错的地方 |
| D-49 | **地面标尺网格必须是 3D 线段，不能画在 2D 叠加层上** | three 场景里放 `LineSegments`，参与深度测试；`drawOverlayGrid` 只给软件路径用 | 2D 叠加层永远在最上面，格线会横穿建筑表面（真机截图里就是这个观感，一眼就看出不对） |
| D-50 | **桌面端模型看到的图也由 three.js 画**（`ShotRenderer` 注入点 + `--shot` 诊断出口） | `AgentSession` 收一个可选的 `render` 后端：给了就先问它，返回 `undefined`/抛错就退回软件光栅器；桌面端把它接到渲染进程（`executeJavaScript` → 离屏 `WebGLRenderTarget` 超采样 → PNG data URL） | 只把交互换成 three.js 会让"用户看 GPU 版、模型看软件版"——而模型的判断全部来自那张图，模型的眼睛比用户的眼睛重要。软件路径必须留着：CLI 没有 Electron，golden 测试要逐字节可复现 |
| D-51 | **回落必须是静默可恢复的，但要能被看见** | 外部分支拒绝/抛错/`revision` 对不上时都只记一条 `renderFallback` 然后走软件光栅器；不抛异常、不中断对话 | 截图是模型的眼睛：整轮对话不能因为一次渲染失败就变成盲改。但"图为什么忽然变糊了"必须能解释，所以原因留着给界面显示 |
| D-52 | **人机共用机位：界面上定的机位与 `set_camera` 写的是同一个字段** | 左栏机位面板（按角度 / 按坐标两种输入）勾上「模型用这个机位」才推给会话；不勾就只是本地视角 | 用户会说"从这个角度看看檐口"——如果模型不知道用户在看哪，这句话就没法执行。但**默认不共享**：随手转两下不该悄悄改掉模型下一张截图的机位 |
| D-53 | **机位标签必须带上注视点**（`az45/el30→(8,5,8)`） | `shotCameraLabel` 在给了 `lookAt`/`target` 时拼进去；会话按**合并后**的相机算标签，不按原始请求 | 同一组角度、不同注视点是两张不同的图。只写角度的话，档案里"看整栋楼"和"盯着檐口"会长得一模一样，而档案正是事后追责"模型当时看到了什么"的唯一依据 |
| D-54 | **没有 WebGL 时视口退回软件光栅器，界面必须还能用** | `SceneViewport` 两个实现：`Viewport`（three.js）与 `SoftwareViewport`（向主进程要 RGBA）。拖动时降 1/2 边长、跳过叠加层，松手补一张全分辨率的 | `new THREE.WebGLRenderer()` 在没有 WebGL 的机器上直接抛，而这一抛会把对话面板一起带走——用户连"描述需求"都做不到。慢和糊可以忍，用不了不行 |
| D-55 | **兜底路径也要保留交互的三条时序性质** | `SoftwareViewport`：① 同时只允许一个请求在飞，飞行途中来的相机只保留最新那个；② 版本 + 尺寸 + 机位相同的帧直接跳过；③ 尺寸在半路变了的帧丢掉 | 不合并请求会让画面越拖越落后（"橡皮筋"）；不按指纹去重会让每次状态事件（对话多一条消息、自动保存）都白跑一次光栅化 + 几 MB 的 IPC；不丢过期帧就会贴错位置。这三条都是**时序**性质，所以 `SoftwareViewport` 刻意不碰 DOM——它只往 `FrameSink` 里塞帧，能在 Node 里直接测 |
| D-56 | **拒收截图必须带上原因** | 渲染进程返回 `{ dataUrl }` 或 `{ error }`；主进程把 `error` 一路记进 `renderFallback`，界面显示 | 这台机器有没有 WebGL、场景版本对不对得上，**只有渲染进程知道**。退化成一个裸的"截图失败"，用户看到的就是"图忽然变糊了"而没有任何解释 |
| D-57 | **撤销 / 重做是游标移动，不是反向补丁** | `ReplaySession.undo()` = `seek(rev-1)`；`store.revision` 是**唯一**游标（`ReplaySession` 不再自存一份）；`WorldStore` 里那个内存撤销栈改名为 `revertLastWrite()`，并明确写成"不参与事件溯源" | 早先撤销会打一个反向补丁并把版本号 **+1**：世界写着 rev 4、日志只有 3 条。后果是重放、时间线、`.mcai` 往返同时坏掉，而且坏得很安静（只有 `verifyReplay` 对不上）。改名是为了让"哪个撤销"一眼分得清 |
| D-58 | **在历史版本上编辑 = 截断式分叉，且宿主必须申报写入后的版本** | `EditLog.record` 收 `worldRevision`：比日志短就先 `truncate`，然后校验新 op 的编号正好等于它，不等就抛 `EditLogError` | 不截断就会写出两条 `rev: 4`；不校验就会在"宿主忘了传"时安静地脱节。校验真的抓到了东西：导入与实际夹具都曾让世界版本跑在日志前面 |
| D-59 | **用户停在历史版本上时不许发消息** | `StudioService.send()` 拒绝，界面禁用输入框并解释；模型自己 `undo` 之后再编辑不受限 | 用户在时间线上翻到 rev 3 是在**看**，不是在选择"从这里重来"。让模型这时动手，它的第一笔就会把 rev 4..N 截断丢掉——那是用户的工作。模型自己的 `undo` 是它主动做的，接着改就是正常的"撤销后换个做法" |
| D-60 | **`.mcai` 的 `revision` 是游标；日志全量写入** | `packProject`：`revision = baseRevision = store.revision`（不是 `log.length`）；`counters.ops = log.length`；游标之后的 op 照写，重开之后还能重做 | 保存时写 `log.length` 会存下一份**谎报**：快照是撤销后的内容，manifest 却说它在最新版本，日志里那条被撤销的 op 看上去"已经应用了"。重开之后世界与日志就此对不上 |
| D-61 | **人手接管与模型编辑共用一条通路** | 界面的"点哪儿改哪儿"走 `StudioService.editBlock` → `session.applyEdit`（`source: 'user'`），与工具调用写进同一个 op 日志 | 给人手编辑另开一条数据通路的话，撤销、时间线、导出、`.mcai` 往返每一样都要重做一遍，而迟早会漏一样。同一份日志意味着"谁改的"只是一个字段的差别（`source`），其余全部免费 |
| D-62 | **拾取在主进程做，用与渲染同一份相机与几何** | `pickBlock`（CPU 正交射线 + Möller–Trumbore）吃 `viewportCamera()` 与 `geometryFor()` 的输出，就是画出那一帧的同一份 | ① 没有 WebGL 的兜底视口根本没有 three 场景可以 raycast；② 拾取与渲染各建一个相机，两边会以"差一格"的形式飘开，而且只在某些角度才飘——最难查的一种 |
| D-63 | **调色板不预置"所有可放置方块"表，只给"用过的" + 搜索** | 「用过的」直接来自 `state().histogram`；搜索由主进程在 `minecraft-data` 里做（按名字长度排序，短的在前面） | 1.21.4 有 1095 种方块，混着大量技术方块（`moving_piston`…），筛一张正确的表本身就是个坑；而用户真正要的多半是"我刚用过的"或"我搜得到的那几个" |
| D-64 | **上下文策略由 provider 能力决定，且只能选一套** | `contextPolicyFor()`：`promptCache === 'none'` → 滑动窗口；有缓存但 `contextWindow < 100k` → 也是滑动窗口（不裁剪就放不下）；其余 → 不裁剪 | 有缓存时剪掉一张 369 token 的旧图省 `$0.00005`，却让它后面 100k token 的缓存全废、要以全价重算约 `$0.014`——**少三个数量级**。反过来没有缓存时，那些 token 每个请求都要全价重付。两套同时开就是"一边付缓存的钱一边把缓存打掉" |
| D-65 | **窗口裁的是"请求视图"，历史仍然只追加** | `windowMessages()` 返回一份新的消息数组给这次请求；`state.messages` 一个字节都不动 | 混起来的话，Regime B 的裁剪会把用户的对话档案（以及 `.mcai` 里那份）也剪掉——那是一个**只在不缓存时才发生的数据丢失**，最难被发现 |
| D-66 | **图像的预算是从最新往回数的** | `keepImages` 优先给最后几轮，被剪的消息留住文字并标明剪了几张 | 模型最需要的是"我刚改完的样子"。实现时两层循环只有一层倒着走，结果预算花在了最旧的那一轮上——被测试里"留下的应当是最后那两张"这句断言抓住 |
| D-67 | **裁剪要留在档案里** | 新增 `context` 事件 → `TranscriptEvent` 的 `note: 'context'` 与界面上的 `[CONTEXT]` 一行 | 事后看"模型为什么忘了前面那几步"，答案在这里：那些轮次**根本没发出去**。不记的话，只能归因成"模型变笨了" |
| D-68 | **回放走到录音尽头就停下，绝不补一个空响应** | `ReplayProvider.chat` 在 `cursor` 用尽时抛错（"录音只有 N 轮，但对话已经走到第 N+1 轮"），只有显式要求"用完就停"时才返回空回复 | 录音是响应到手之后才追加的，所以被打断的跑（超预算、402、断网）留下的是一段**短的**录音。这时安静地接着跑，会重放出一座完全不同的建筑，而且没有任何地方看得出不对——错得最贵的一种。宁可失败得吵（§14.2） |
| D-69 | **纹理默认内置，来源可换成用户自己的** | `TexturePack` 抽象四种来源（内置资源包 / 用户资源包或客户端 jar / `.minecraft` 自动探测 / 烘好的平均色），桌面端默认注入内置资源包；CLI 用 `--textures` 换 | 一开始按“不内置素材”做的（省体积、避开素材授权），结果是**这台机器上没装 Minecraft 就直接没有纹理**——用户明确不接受：装完就该看到真实纹理。于是默认改回内置，把“换自己的包”降级成一个选项。代价是包里多背 66.7 MB，这是**有意买下来的**取舍 |
| D-70 | **往后退逐条反向，不清空重建** | `ReplaySession.seek(rev)` 在 `target < 当前` 时循环 `store.applyPatch(log.at(cur-1).patch.inverted())` 并让游标减一；向前仍然是逐条 `applyPatch` | 早先往后退是 `store.clear()` + 从头重放，它默认了“rev 0 = 空世界”。但导入的工程 rev 0 就是导进来的内容（D-58），于是用户撤销到最开始会把整栋建筑删掉——那是数据丢失，不是撤销。这个 bug 是写“导入后继续编辑”的闭环测试时撞出来的 |
| D-71 | **设计笔记写在 manifest 里，而且必须替换式** | `update_notes`（`ctx.notes` 句柄）→ `AgentSession.designNotes` → `buildSystem()` 的 `[DESIGN NOTES]` 段；保存时进 `manifest.designNotes`，打开时交回新会话。**写入只影响下一轮**（本轮的系统提示已经发出去了，改它就是把前缀缓存打掉） | 笔记要活过 Regime B 的裁剪，所以它必须进**稳定前缀**而不是某条会被丢掉的工具结果；而替换式（而不是追加）是因为它进的是**每个请求**的前缀——追加会越滚越长，等于每轮多付一遍钱。上限 1200 字符、超了直接拒绝并报出当前长度，让模型自己删 |
| D-72 | **golden 基线只签确定性输入** | `packages/render/test/golden/` 四张基线全部用 `plain` 哈希配色或**烘好的平均色**资源包渲染；纹理路径也走 `bakedColorTexturePack`，绝不引 `minecraft-assets` | 签名图的价值全在“人看过一眼、知道它为什么长这样”。如果输入依赖某个 npm 包的资源版本，那它一变基线就要重签，而“为什么这次签变了”会变成一件说不清的事——还不如让纹理那部分交给“逐位素采样是否真的在采样”这类性质断言去管 |
| D-73 | **永远流式（SSE）：不给模型输出设任何上限** | 请求恒定 `stream: true` + `stream_options: {include_usage: true}`；provider 里自己拼 SSE（正文 / `reasoning_content` / 按 `index` 分片累加的工具参数 / usage chunk），拼不出收尾（没有 `[DONE]` 也没有 `finish_reason`）就判成**可重试的掐断**。中途试过"设 8000 上限堵住掐断"，**已废弃**：上限就是在限制模型输出 | §16 那条风险（单轮生成超过 50 s、网关切连接、客户端只拿到半截正文）的根因是**非流式**——"整个响应准备好才发第一个字节"，服务端思考多久这条连接就干等多久。流式下字节一直在流动，那堵墙不成立，于是**不需要**再用 `max_tokens` 去压缩输出（D-37 因此保持有效）。代价是 provider 复杂了一档，两个真机坑：① 工具参数是跨 chunk 的 JSON 碎片，必须按 `index` 累加到最后才解析；② **每个 chunk 都带 `usage`，且除最后一帧外都是 `null`**——第一版把判据写成 `!== undefined`，于是在 `null` 上读 `.prompt_tokens` 抛 TypeError，而那个 TypeError 又被"读流失败→TRUNCATED"的 catch 包装成"连接被掐断"，报了一个**假原因**、还白白重试两次。所以现在的分工是死的：**只有 `reader.read()` 本身的失败才是网络故障**，`consume()` 抛的一律原样上抛。假端点因此**故意回切碎的 SSE，并且每帧都带 `usage: null`**，不拼就过不去（`stream_options` 不被支持时自动去掉重发并记住，少一份用量也不能少一次回答） |
| D-74 | **流式碎片只喂界面，不进档案；「思考中…」长在对话列表里** | `LlmProvider.chat(request, onDelta)` 把正文/思维链碎片在到达的当下报出来；`runAgent` 把它转成 `assistant_delta` 事件（`TranscriptEvent` 里**显式列出但不录**）。桌面端在 `turn` 事件上就落一条流式占位（正文为空 = 画「思考中…」，思维链只累加字数**不显示内容**），碎片往里接，收口的 `assistant` 事件用完整正文**覆盖**碎片；`retry` 事件把上一次尝试的碎片丢掉；推送按 40 ms 合并 | 顶栏那行状态是**隐藏**的，"思考中…"写在那里等于没写——用户看到的是"消息发出去了，然后什么都不动"，只能反复重发。碎片不能进档案（D-25）：`.mcai` 存的是成型的消息，碎片进去就是把每条回复切成几百片，而且档案会被分享。最终响应必须覆盖碎片：重试与拼接都可能少一块，`assistant` 才是权威那一份。合并推送是因为逐 token 推一份完整视图会把 IPC 与整列重绘打到几十次/秒，而画面上没有区别 |
| D-75 | **视口是一台真的第一人称相机：位置是真的，拖动只转头** | 交互相机持有 `eye`（世界坐标）+ 朝向 + 视场角（`renderer/freecamera.ts`）；拖动只改角度（`turn`），`WASD` 沿自己的轴平移（`moveStep`：W/S 走完整视线，A/D 走水平右方），滚轮改视场角，第一次交互时 `settleCamera()` 用 `fitPerspective` 把相机落到"框住内容"的位置。**拖动的方向按"画面跟着手走"定**：往右拖 = 画面里的东西往右移（`azimuth` 增）、往下拖 = 东西往下移（`elevation` 减） | 用户原话："不管怎么拖动，画面都是围绕中心旋转，不能更改视角面向的方向""不要相对目标点旋转，要相对相机旋转"。旧实现里"画面中心"是一个**钉死**的注视点（默认内容中心），于是拖动必然表现为"建筑原地自转"，而且没有位置概念，`WASD` 无从谈起。第一步把位置变成真的（转头时世界从眼前扫过），但**光有位置还不够**：正交投影下没有近大远小，转起来仍然像"托盘上的模型"，见 D-76。**枢轴一换，拖动的手感就翻了**：同样是"往右拖 = 方位角减小"，绕画面中心转时建筑跟着手往右走，原地转头时却往左走——用户的下一句反馈就是"拖动视角反了"。教训是**方向要对着屏幕上的实际位移定，不能对着角度符号定**，所以 `turn` 的符号按"画面跟手"写，并且 `test/freecamera.test.ts` 里把两个世界点真的投影出来、断言它们往哪边挪（改回旧符号这条就红） |
| D-76 | **交互视口是透视投影（第一人称），模型截图仍是正交等轴测** | `CameraSpec.perspective = { eye, fov }`：给了它 `projectPoint` 做透视除法、`screenRay` 从相机出发、光栅器走**裁剪 + `1/z` 加权**那条内层循环；不给就是原来的正交。`fitPerspective` 解"相机该站多远才框得住"（按八个角点解不等式，不是估包围球）。桌面视口走透视；`cameraForShot`（模型截图、CLI、golden）**不开**透视 | 用户："我要的是透视投影，第一视角——渲染一个画面需要输入相机坐标、相机朝向，拖动鼠标调整的是相机朝向。" 正交下无论怎么改相机，成像只差一个旋转+平移，近处的墙和远处的墙一样大，观感永远是"托盘上的模型"；透视才有近大远小、才有"站在世界里"的感觉。**模型那条路故意不跟进**：等轴测图两张之间可以直接比（近大远小会让同一座建筑因为站位不同而没法比），而且 golden 签名图、工具描述、提示词都是按它写的。代价：同一个机位，人看到的是透视、模型拍到的是正交——这是**有意的差别**，不是漏了。光栅器那条路必须自己裁近平面（顶点落到相机后面时除以 z 会把三角形翻到画面另一侧），`PERSPECTIVE_NEAR` 两条路取同一个值（0.1），否则"贴着墙站"时 GPU 与兜底视口会画出不同的东西 |

### 17.2 待定

**M4 验收标准的具体数字**：黄金任务（§14）的通过率阈值、单任务成本上限、允许的轮数上限。
基线已经测出来了（§14.1：3/5，约 $0.19 跑完五个任务，五个都 `completed`，单任务 8–32 轮），
但**阈值怎么定仍然没定**。基线只说明"现在能做到哪儿"，不说明"低于多少算回归"；
真实模型每次的方差本身就不小（同一句灯塔需求两次跑，一次 31 轮 4091 格、一次 13 轮 2927 格，
两边都成立），钉一个硬阈值需要先有几轮重复测量，否则定出来的数字只会制造假失败。

**分支 fork**：撤销/重做是游标移动，但在历史版本上继续编辑走的是**截断式分叉**（D-58）——
被覆盖的那条分支会丢。要不要留分支（多游标 / 分支树），等真正出现"同时比较两个方案"的用法再定。

**录音进仓库**：`--record` 的产出能不能当 CI 基线提交进去。它不含密钥、可离线重放、
能防住"改 prompt 改坏了没人发现"，但一段真模型录音是几百 KB 的 JSONL，
而且**模型或 price 表一变它就过期**。倾向是"按需生成、不提交"，还没定。

**`minecraft-data` 的精确白名单**：它占包里 427 MB，按目录裁不安全（`data.js` 跨版本
静态 `require`，试过、启动即报错）。可行的做法是 hook `Module._load` 跑一次
`require('minecraft-data')('1.21.4')`、记下实际被 require 的每个文件，生成一份精确白名单
（预计 App 从 748 MB 落到 ~330 MB）。没做的理由：它把“我们只支持 1.21.4”这条约束
从一句注释变成一条**打包期规则**，将来要开第二个版本时会静默缺文件——
要做就得连“版本白名单”一起设计，不能只裁文件。

**软件光栅器的 golden 基线**：✅ 已落地（4 张，见 §14）。接受"改渲染就要重新签"这个代价，
因为换来的是"砖缝糊了 / AO 丢了 / z-buffer 失效"这类**看得见的 diff**——
以前那些弱断言（非空白 + 尺寸对）对这三种退化一律放行。

---

## 附录 A：`fill_line` 的语义定义（示范"把工具写清楚"的标准）

```
fill_line(from, to, block, radius=0, taper=null, step=1, mode="replace", hollow=false)

沿 from → to 的 3D Bresenham 直线放置方块。
radius 的语义：**方块中心到轴线的距离上限**，所以整数 R 恰好给出 2R+1 格粗的柱体
（R=1 → 3 格，R=2 → 5 格，R=3 → 7 格）。两头是球冠（capsule），不是平口。
半径按 taper=[起, 止] 沿线的参数 t∈[0,1] 线性插值（做锥形塔尖、尖顶、树干收分）。
step > 1 时沿线每隔 step 格采样一次（做栅栏柱、脚手架、虚线）。
hollow=true 时只保留一格外壳（内部掏空，两端球冠的极点仍在壳上）。
mode 语义见 fill_box。
返回：changed / clipped / 受影响包围盒。

例：从 (0,0,0) 到 (15,15,15) 放 1 格粗的橡木梁
     → fill_line(from=[0,0,0], to=[15,15,15], block="minecraft:oak_log")
例：3 格粗的立柱
     → fill_line(from=[8,0,8], to=[8,20,8], block="minecraft:stone_bricks", radius=1)
例：锥形塔尖，底半径 3（7 格粗）收到顶半径 0，高 20
     → fill_line(from=[8,20,8], to=[8,39,8], block="minecraft:dark_prismarine",
                 radius=3, taper=[3,0], hollow=true)
```

**同类工具必须达到这个文档标准**——因为工具描述就是 LLM 的说明书，写不清楚，LLM 就用不对。

## 附录 C：几何算子的坐标语义（三者的口径必须一致）

工具描述就是 LLM 的说明书。**最容易出错的是"这个坐标算不算被覆盖"**，所以三个算子的口径统一如下：

| 算子 | 语义 | `(0,0)-(4,4)` 覆盖 |
|------|------|-------------------|
| `fill_box(from, to)` | **闭区间**，含两端 | 5×5 = **25** |
| `extrude(polygon, ...)` | 顶点**就是方块坐标**，覆盖 = 内部格心填充 ∪ 边线走格 | 5×5 = **25** |
| `fill_plane(p1,p2,p3)` | 区域**严格限制在三点的包围盒内**；厚度只影响法线方向 | 5×5 = **25**（轴对齐时） |

三条容易踩的规则：

1. **多边形填充必须补边线**。纯格心扫描线会漏掉恰好落在多边形边上的那一圈方块——而对建筑来说那一圈正是**墙**。
   所以 `extrude` 的截面 = 扫描线填充 **∪** 边的 Bresenham 走格。
   副作用是凹多边形的凹角会多覆盖一格边界，这是**有意的**（墙要连续）。
2. **`fill_plane` 不扩包围盒**。平面在数学上是无限的，不裁剪就会铺满整个世界；厚度也不该用来扩张区域，
   否则 `(0,5,0)-(4,5,0)-(0,5,4)` 这种轴对齐平面会从 25 格变成 81 格。
3. **`extrude` 只沿 +Y 挤出**。多边形定义在 XZ 平面。斜面和任意轴交给 `fill_plane` / `fill_line`，
   不要为了"通用性"把 API 做复杂——LLM 用不对一个复杂的 API。

`hollow: true` 的 `extrude` 是"墙 + 可选楼板/屋顶"：`capBottom`/`capTop` 控制是否用完整截面封住两端，
关掉就是纯墙体（层高 = `height`）。

**同类工具必须达到这个文档标准**——写不清楚，LLM 就用不对。

## 附录 B：v0 必做的 6 个工具

如果时间极紧，只做这 6 个就能跑通完整闭环：

1. `screenshot`（多视图 + 标尺叠加）
2. `slice`（ASCII 层视图）
3. `fill_box`（长方体填充，含 hollow/outline）
4. `fill_line`（**对角批量填充**，含 radius/taper）
5. `measure`（尺寸与直方图）
6. `verify`（结构化自检，见 §9.4）

加上 `undo`，就足以让 LLM 盖出可辨认的建筑。其余工具都是效率与质量的放大器。

> `update_notes`（D-71）不在这 6 个里，但**用小窗口的本地模型时它几乎同样重要**：
> 裁剪一发生，模型就忘了自己当初为什么这么设计——而它自己不会意识到这一点。

> `verify` 之所以是 v0 而不是 v1：**没有它，LLM 会大量地"声称完成但没完成"**，而且这个失败模式在长会话里会累积到无法收拾。它是 harness 可信度的下限。

---

## 附录 D：变换的语义（`symmetrize` / `copy_region` / `paste_region`）

**坐标怎么动，朝向就必须怎么动。** 这是体素工具最经典的 bug：一座朝东的楼梯原样搬到
旋转后的位置，立刻变成嵌在墙里的错块。所以这两件事在实现上**共用同一个整数矩阵**
（`packages/core/src/transform.ts`），不各写一套。

### 变换的定义

```
rotate: 0 | 90 | 180 | 270   # 绕 +Y，俯视（+X 东、+Z 南）顺时针
mirror: 'x' | 'y' | 'z'      # 沿该轴翻转
```

**`mirror` 先做，`rotate` 后做。** 两个都给时结果不等价于反过来，所以这个顺序是契约的一部分。

矩阵是**带符号置换**，从它推导出三件事：

| 派生量 | 怎么来 |
|--------|--------|
| 方向词（`north`/`east`/`up`/…） | 把方向向量过一遍矩阵再读回来 |
| `det < 0` ⇒ **手性翻转** | `hinge=left`、楼梯 `shape=outer_left`、双箱 `type=left` 左右互换。旋转保持手性，镜像反转手性 |
| `axis` | 轴是无向量：`x` 轴映射后仍是某条轴，读它落在哪一根上 |
| `rotation`(0..15) | 仿射：`r → det·r + t (mod 16)`，其中 `t` 是"南"映射到的那一档 |

### 三个必须一起处理的细节

1. **属性名本身可能是方向。** 69 个方块（栅栏、墙、玻璃板、铁栏杆、红石线）把连接状态
   直接写成了 `north`/`south`/`east`/`west` 属性。旋转时**属性名要跟着转**：
   原本 `north=true` 的那一格，转完应写 `east=true`。只转值是错的。
2. **组合值的拼写顺序由声明决定。** `rail[shape=north_east]` 转 90° 后是 `south_east`，
   不是 `east_south`——所以映射完词元要去 `property.values` 里**找**回规范的写法，
   而不是自己拼字符串。这个查找**只对"全是水平方向词"的值生效**：`orientation` 的
   `east_up` 词元顺序是有语义的（先面、后指向），按集合去凑会错配成 `down_east`。
3. **不可表示时保留原值，不猜。** 1.21.4 里有三类映射不出对应值的情形：
   墙/玻璃板的 `up` 没有配对的 `down`；`jigsaw`/`crafter` 的 `orientation` 只声明了
   24 种组合中的 12 种；漏斗的 `facing` 没有 `up`。这些格子**保住一个能编码的近似**，
   而不是造一个不存在的状态或抛异常。工具的错误/摘要必须如实说明这一点。

### 区域变换的坐标口径

粘贴时 `at` 是**新区域的最小角**。区域内的落点用整数运算：

```
mirror x:  x' = sx-1-x
mirror z:  z' = sz-1-z
rotate 90: (x,z) → (sz-1-z, x)，尺寸变 (sz, sy, sx)
```

**奇数尺寸时中心落在某一格上，偶数尺寸时落在两格之间**，两种情况下上式都精确给出
互补格——不会出现半格。90°/270° 会把占地尺寸的 x/z 换位：4×6 的复制体用完 `rotate=90`
占 6×4。

### `run_batch` 的批处理语义

- **顺序生效**：后面的 op 看得到前面 op 的结果，同一个格子以最后一个 op 为准。
- **整体原子**：任何一个 op 的计划失败（方块名拼错等），整批中止、**一格都不写**，
  错误信息指明是第几个 op。
- **模式按"进入这批之前的世界 + 本批已定的结果"判定**：批内的 `mode=keep` 会看到
  同一批里前面 op 的意图，而不是被前面的 op 改之前的世界。
- **一次提交**：一个 revision、一次 dry-run 确认（预览覆盖全部 op 合并后的结果）、
  一条 `EditLog` 记录、一次撤销可整体回退。
- **只收纯几何操作**（`fill_box`/`fill_line`/`fill_plane`/`extrude`/`place_block`/
  `erase`/`paste_region`）。`symmetrize` / `replace_blocks` / `fix_states` 要读整片世界，
  塞进批处理会让"看哪一版世界"说不清，所以必须单独调用——工具的报错要**说清这一点**。

### `fix_states` 与 linter 的分工

| | 做什么 | 是否改世界 |
|---|--------|-----------|
| `fix_states` | 局部一致性的**修复** pass：栅栏/墙/玻璃板的连接位、墙的 `up`、楼梯 `shape`、被包住的半砖/楼梯只报不改 | 是，一次 revision，且**幂等**（跑两次第二次 `changed: 0`） |
| `analyze_structure` | 整体结构的**体检**：悬空、悬挑、门洞、层高、内部是否连通到外部、调色板噪声、对称性评分 | 否，只读 |

### linter 的三条判据必须写死，否则会稳定误报

**① 地面是工区底板，不是分析范围的底。** 默认分析范围是内容包围盒——而一块悬空平台
自己的底面就是那个包围盒的最低层。拿"范围最低层"当地面的话，**最该被抓到的悬空平台永远不报**。
判据是"从这一格往下一直找到工区底板 `volume.min.y`，整列都没有非空气"。

**② 吊挂也算支撑。** 灯笼吊在链子上、挂式告示牌挂在墙上时，下面本来就是空的。
只看下方会把所有悬挂物误判成悬空，而悬空是 error——**一个误报就能把完成闸门卡死**。
所以"正上方有非空气"同样算支撑。

**③ 门的判据是"上面缺了"，不是"上面有东西"。** 门的上半扇之上当然是墙，这是所有正常门的做法。
反过来判会把每一扇装在墙里的门都报成问题。正确判据：`*_door[half=lower]` 的正上方不是它自己的
`half=upper` → 这个门是残的。

变换（`copy`/`rotate`/`mirror`）**不替代** `fix_states`：变换保证"朝向跟着几何走"，
但它不知道邻居是谁；`fix_states` 补的正是邻居关系（栅栏连不连、楼梯拐不拐角）。

---

## 附录 E：互操作格式的坑（`.schem` / `.litematic` / `.obj`）

这三种格式各有**一个只有对着字节才能发现的陷阱**。它们都不会在自测往返里暴露——
往返是自洽的，错的是"和别人对不对得上"。所以每一条都必须用手算的期望值钉死。

### E.1 Sponge `.schem`：索引顺序 `x + z*Width + y*Width*Length`

**y 在最外层。** 写成 `x + z*Width + y*Height*Width`、或者把 y 放最内层，
自测往返全都通过，但游戏里读出来整体错位。这是本模块唯一**无法靠自测发现**的错误。

另一处：**v2 与 v3 的 `Data` 编码不同**。

| | 版本 | `Data` 编码 | 备注 |
|---|---|---|---|
| v2 | 1.13–1.19 | 定宽 2 字节大端 | 需要 `PaletteMax`；网上大多数 `.schem` 还是这个 |
| v3 | 1.20+ | **VarInt（LEB128）** | 不需要 `PaletteMax`；我们写这个 |

**写 v3，读 v2 和 v3 都认**。`Version` 字段缺失时按 v2 试——老文件里本来就可能没有它。

调色板的键就是方块状态字符串，而且和我们的规范形式一致，所以两边几乎零转换。
属性顺序无所谓：解析按 `key=value` 读，不依赖顺序。

`Offset` 要保留：粘贴时用不到，但丢掉它就不是无损往返了。

### E.2 Litematica `.litematic`：位打包，以及**必须按无符号处理**

`BlockStates` 是 long 数组，每格占 `max(2, ceil(log2(调色板大小)))` 位。
**两代打包不兼容**：

| | 判据 | 布局 |
|---|---|---|
| 新式（我们写 v6） | `Version >= 4` | 每格**完整落在一个 long 内**：`longIndex = i / entriesPerLong`，`offset = (i % entriesPerLong) * bits` |
| 老式 | `Version < 4` | 整个数组是一条连续位流，条目可跨 long 边界 |

**第二个坑：最高位。** 64 位里 bit 63 经常被用上（调色板够大、或者最后一个 long 的高位有残留）。
用带符号右移（`>>`）会补符号位，把索引变成负数——**这个 bug 只在特定调色板大小下才出现**
（要 `bits` 能整除出 offset 48 那一格），所以测试必须**把调色板撑到触发它的规模**：
`bitsFor(40000) = 16` → 每 long 4 格 → 第 4 格落在 bit 48..63。

**第三个坑：打包结果必须是 NBT 能接受的有符号 64 位。** `BigInt.asUintN(64, …)` 得到的位模式
在最高位为 1 时超过 `2^63-1`，`prismarine-nbt` 会直接抛 `ERR_OUT_OF_RANGE`。
有符号转换收口在 `packBlockStates` 里，调用方不必再想着这件事。

时间戳固定写 0：**同样的世界必须导出逐字节相同的文件**，否则"导出是否稳定"没法测，
也没法做内容寻址。

### E.3 NBT 本身：复合列表的元素是**裸字段表**

NBT 的列表里，元素类型字节已经说明"每个元素是一个 compound"，所以元素**直接写字段表**，
不再套一层 `{type:'compound', value}`。多套一层的话序列化结果会变成
"字段名叫 `type` 和 `value` 的 compound"——**文件看起来写成功了，读回来整个错位**
（报错是 `Missing characters in string, found size is 53 expected size was 29834` 这种看不懂的）。

读的时候两种形状都认（`asCompoundList`），因为上游解析器给的是裸字段表，
而手写构造的树可能是包装过的。

### E.4 Wavefront `.obj`：几何取自**碰撞盒**，面剔除只对整块之间做

- 用 `registry.shapesOf(stateId)` 而不是"所有方块都是立方体"。楼梯是两块、栅栏是细柱、
  门是薄板——只画整块的 OBJ 会让楼梯变成实心台阶，看起来完全不是那回事。
- **面剔除只对"整块并排整块"做**。非整块的形状之间到底挡不挡得住要真正做 CSG 才能判定，
  猜错的代价是"模型上多了几个洞"，比多画几个面糟糕得多。
- 顶点去重：相邻方块的公共角点只写一次。
- 坐标系与 MC 一致（+X 东、+Y 上、+Z 南）。导入软件后如果觉得是镜像的，
  那是 +Z 方向的定义差异，不是算错了。
- `mtllib` 里的文件名**必须和实际写出的 `.mtl` 同名**，否则模型能打开但全是灰的。

### E.5 跨版本迁移：三层降级，**永不静默丢东西**

`.schem` 里的 `DataVersion` 只告诉你"这是哪个版本写的"，**不会帮你改方块**。

| 层 | 处理 |
|---|---|
| 1 | 当前位置的表里有这个名字 → 直接用 |
| 2 | 显式改名表命中（`grass_path`→`dirt_path`、1.14 扁平化的 `sign`→`oak_sign`…）→ 换名字，属性**按新方块自己的声明逐项过滤**，其余从默认状态继承 |
| 3 | 认不出来 → **记进 `unknown` 并给候选**，那一格留空，其余照常导入 |

**第 3 层是重点**：绝不静默替换成空气，也绝不因为一个名字对不上就中断整次导入。
一份"看起来导进去了、其实少了半面墙"的工程，比一个明确的报错难查一百倍。

不做覆盖全部方块的静态表：那份表永远不完整，而且每加一个版本就要维护一次。
名字对不上时，**如实报告 + 给候选**比假装成功有用得多。

### E.6 验收怎么测（游戏里没法自动测，那就把能测的测到底）

| 手段 | 覆盖什么 |
|------|---------|
| **`contentHash()` 对拍** | 导出 → 导入到**全新世界**（不复用调色板）→ hash 必须相等。这是 M7 的验收口径 |
| **1000+ 种状态的大样本往返** | 从注册表里确定性抽样（每个方块取若干 state 变体）铺满一片区域再对拍。只测几种方块会漏掉带属性的状态 |
| **手算期望值** | 索引顺序、VarInt 逐字节、位打包的 long 值——这些"自洽但可能对不上别人"的地方，只能拿手算值钉死 |
| **法线朝向断言** | OBJ 每个面的法线必须指向立方体外侧（右手法则绕序） |
| **确定性** | 同样的世界导出两次，字节必须相同 |

**测不到的部分要如实说**：以上全部证明"我们的编解码自洽且符合规范文字"，
**不等于"游戏里一定能读"**。最终确认仍然要在游戏里粘贴一次——
这一条写在 `export` 命令的输出里，提醒用户自己验一次。
