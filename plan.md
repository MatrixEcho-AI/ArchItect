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

#### 7.0.3 所以"自研渲染器"到底有多难？—— 不难

| 部分 | 难度 | 来源 |
|------|------|------|
| 方块模型 → 几何体（本来是最难的一步） | ~~困难~~ **已有** | vendor 653 行 MIT 代码，原生支持 1.21.4 |
| 模型数据 + 纹理 | **中** | `minecraft-assets@1.19.0`（2026-08 更新）提供 1.21.4 的 `blocksStates` / `blocksModels` / `textureContent`；`prismarine-viewer/public/` 里也预置了 `1.21.4.json` |
| three.js 绑定 | 易（~50 行） | 照抄 `worldrenderer.js` 的 9 处调用 |
| 相机 / 控制器 | 易 | `OrbitControls` + 正交相机 |
| 叠加层（标尺/坐标轴/高亮/选区） | 易 | 本来就该自己控制——这正是不能用现成 viewer 的原因 |
| AO / 光照 | 易（~50 行） | 顶点 AO |
| chunk 增量更新 | 中 | 脏 section 队列 + worker |

→ **净成本估计 3–5 天**，瓶颈在纹理图集与增量更新，**不在几何**。这比"从零写体素渲染器"（那确实要几周）便宜一个数量级。

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
| `export_model` | 导出 `schem` / `litematic` / `mcstructure` / `obj` |
| `define_volume` | 设定/调整可写工区 |
| `set_palette` | 限定可用方块集（风格约束，如"只用中世纪材质"） |
| `ask_user` | 人在环路：提出问题并给选项，UI 弹出等待回答 |
| `save_version` | 标记里程碑版本（`"v1 初稿"`） |
| `finish` | 结束设计，输出总结报告 |

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
- **禁止在 system prompt 里插时间戳/随机数**（哪怕看着无害），它会把整个前缀缓存打掉。
- **`DesignNotes` 放在前缀末尾而不是历史里**，这样更新它只失效它自己之后的部分。
- 上下文窗口 1M token、输出上限 384k token，所以**上下文长度本身不是约束，成本才是**。

#### Regime B：无缓存或短上下文（本地小模型 / 其他 provider）

退回保守策略：

| 手段 | 做法 |
|------|------|
| **阶段摘要** | 每阶段让 LLM 写 200 字以内的 `DesignNotes`；原始轮次可丢 |
| **滑动窗口** | 只保留最近 K 轮（默认 K=6） |
| **图像剪枝** | 最多保留最近 M 张图（默认 M=3） |
| **优先文本** | prompt 明确指示"精确定位用 slice/measure/raycast，不要为了看清某一格去截图" |
| **工具结果压缩** | `find_blocks` 返回聚类摘要而非 400 个坐标 |

由 `ProviderConfig.capabilities` 里的 `promptCache: "auto" | "explicit" | "none"` 与 `contextWindow` 决定走哪个 regime。**两套都要实现，但不能同时开。**

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

[COMPLETION CHECKLIST] All must pass before you claim the build is done:
 [ ] measure() confirms the dimensions match the request
 [ ] verify() confirms key features (door / windows / stairs) exist at the right positions
 [ ] analyze_structure() reports no floating blocks and doorway clearance >= 2
 [ ] screenshots from at least 2 angles confirm the appearance

[WORKFLOW] Plan -> build in stages -> screenshot + read back after each stage
           -> holistic review when complete -> revise.
[OUTPUT LANGUAGE] Reply to the user in Chinese. Keep tool arguments and coordinates in ASCII.
```

**关于 `[OUTPUT LANGUAGE]` 这一条**：prompt 是英文的，但**对用户输出的自然语言要是中文**（D-01）。
这行必须在 prompt 里显式声明，否则模型会顺着英文 prompt 一路用英文回答。

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

实现上就是一个 `compat?: Record<string, unknown>`，按 provider 覆盖默认序列化行为——**是数据，不是硬编码分支**。

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
- 设置页「测试连接」是**唯一的真相来源**：一次调用完成三件事——
  ① `GET /models` 列出可用模型；② 发一张小图验证视觉能力；③ 从 `usage` 读出图像 token 计费口径。
  结果写回 `capabilities`，之后所有决策读运行时值。

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

- **时间线拖动** = 时间旅行。拖到 rev 120，视口立刻变成那时的样子；点"从这里分支"开始另开一条设计路线。
- **工具调用检查器**：每次 LLM 调用工具，时间线上打一个点；点击可展开完整参数、影响范围、耗时、token 消耗，并能"只回滚这一步"。
- **人在环路**：`ask_user` 工具触发时对话框内联出现选项卡；也可开启"每步确认"模式，由用户点 ✔ 才提交 LLM 的 op。
- **成本表盘**：实时显示本次会话 token 与美元花费，可设上限，超限暂停。

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

### 10.3 打包

- `electron-builder`：macOS `.dmg`、Windows NSIS、Linux AppImage。
- `fileAssociations` 注册 `.mcai` → 双击直接打开项目。
- 自动更新（electron-updater）+ 崩溃上报（可选、默认关、明确告知）。
- 体积预期：Electron ~200 MB（含 Chromium），资源包纹理 ~20 MB。可接受。

### 10.4 国际化（D-01：中文优先，走 i18n）

**做法：从第一行代码起就用 `i18next` 取文案，绝不硬编码中文字符串。** 语言顺序是"中文优先"而不是"只有中文"。

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
│   ├── mcai-format.md              # .mcai 格式正式规范
│   ├── tool-reference.md           # 完整工具参考（也用于生成 LLM schema）
│   └── prompt-library.md           # 建筑风格 prompt 模板
├── packages/
│   ├── core/                       # 体素世界、调色板、EditOp、UndoStack、Replay
│   │   └── src/{world,palette,editops,geometry,hash,undo}.ts
│   ├── mcai/                       # .mcai 编解码、zip、迁移、WAL、校验
│   │   └── src/{reader,writer,manifest,migrate,wal}.ts
│   ├── render/                     # CameraSpec、场景构建、叠加层、后端(webgl/iso)
│   │   └── src/{camera,scene,overlays,backends/{webgl,isometric}}.ts
│   ├── tools/                      # 工具定义 + JSON Schema + 执行器 + 校验
│   │   └── src/{registry,executors/*,schema/*}.ts
│   ├── agent/                      # Agent 循环、上下文管理、prompts、DesignNotes
│   │   └── src/{loop,context,prompts,providers/*}.ts
│   ├── i18n/                       # 文案资源（zh-CN 默认）+ t() 封装
│   ├── interop/                    # schem/litematic/mcstructure/obj 导入导出、版本迁移
│   └── cli/                        # 无头 CLI：architect build / replay / export
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
| 国际化 | `i18next` + `react-i18next` | 中文优先，`zh-CN` 为默认 locale（§10.4） |
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

| 场景 | 做法 |
|------|------|
| 桌面应用 | `safeStorage.encryptString(key)` → 写入 `app.getPath('userData')/secrets.bin`。**不在项目目录里**，也不在任何 git 仓库里 |
| CLI / CI | 只读环境变量 `ARCHITECT_API_KEY`，或 OS keychain（`keytar`），**永不读文件** |
| 项目文件 `.mcai` | `project.json` 里只存 **`providerId` 引用**，不存 key。打开别人的 `.mcai` 时，用本机的密钥配置去匹配 provider |
| 日志 | pino redact 规则：`apiKey` / `authorization` / `*_KEY` 全部打码为 `sk-***` |

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
| 格式测试 | `.mcai` 往返读写 hash 相等；确定性打包；版本迁移（构造旧版 fixture 打开）；WAL 崩溃恢复（杀进程模拟） |
| 渲染测试 | 软件等轴测后端 golden PNG 像素比对；WebGL 后端只做"非空白 + 尺寸正确"的弱断言 |
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

---

## 15. 里程碑与验收标准

| 里程碑 | 内容 | 验收标准 |
|--------|------|----------|
| **M0 脚手架** | pnpm 工作区、TS strict、eslint/prettier、vitest、electron-vite 骨架 | `pnpm test` 与 `pnpm dev` 都能跑通空壳 |
| **M1 体素内核** | palette、稀疏 chunk、BuildVolume、EditOp、几何算法（box/line/plane/extrude/symmetrize）、UndoStack | 单元+属性测试全绿；能脚本化搭出一座房子 |
| **M2 .mcai 格式** | zip 读写、manifest、edits.jsonl、replay、checkpoint、WAL、迁移框架、CLI `architect info/replay` | 往返 hash 相等；replay 任意 rev 与增量结果一致；杀进程后能恢复 |
| **M3 渲染管线** | CameraSpec、预设机位、叠加层（标尺/坐标轴/高亮）、隐藏窗口截图、内容寻址缓存、软件等轴测后端、CLI `architect shoot` | CLI 能出六视图 contact sheet；重复请求命中缓存；iso 后端 golden 测试通过 |
| **M4 工具层 + Agent 循环** | 全部 v0 工具的 zod schema 与执行器、工具返回规范、Provider 适配、上下文管理、CLI `architect build "需求"` | **给定文字需求，CLI 能自主产出 `.mcai`，其中有一座可辨认的建筑**；黄金任务 1、2 通过 |
| **M5 Electron UI** | 3D 视口、对话面板（内联截图）、时间线时间旅行、工具调用检查器、调色板、成本表盘、人在环路 | 全流程可在 GUI 完成；拖动时间线能看到历史状态；双击 `.mcai` 能打开 |
| **M6 高级编辑** | copy/rotate/mirror（含 state 重映射）、fix_states、analyze_structure linter、run_batch 优化 | linter 能抓出测试 fixture 里预埋的 5 类结构问题 |
| **M7 互操作与导出** | `.schem` / `.litematic` / `.mcstructure` / `.obj` 导入导出、资源包纹理提取、版本迁移器 | 导出的 `.schem` 在游戏内**逐格正确还原**（用 `worldHash` 对拍）；能导入外部 `.schem` 继续编辑 |
| **M8 打磨** | 安装包、自动保存、崩溃恢复、i18n 补全、文档、prompt 库、示例项目 | 三平台能打包安装；新用户 5 分钟内能产出第一座建筑 |

> **M7 不做 `mineflayer` 连服务器施工**（已决策排除）。这一期的终点是**导出文件**，用户自己拿文件去游戏里粘贴。
> 好处是砍掉了整个"网络连接 / 鉴权 / 断线重连 / 反作弊 / 权限"的复杂度，也去掉了 `mineflayer` 这个依赖。

**v0 = M0–M4**。v0 的判定标准很明确：**命令行里输入一句"设计一座海边灯塔"，得到一个能打开、能回放、能被真人认可为"灯塔"的 `.mcai` 文件。**

---

## 16. 风险与对策

| 风险 | 影响 | 对策 |
|------|------|------|
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
| D-01 | 界面语言 | **中文优先**，通过 `i18next` 走 i18n 调用，`zh-CN` 为默认 locale | §10.4；UI 文案与错误信息从一开始就过 i18n |
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

### 17.2 待定

**M4 验收标准的具体数字**：黄金任务（§14）的通过率阈值、单任务成本上限、允许的轮数上限。
先跑通再定基线，避免拍脑袋。

---

## 附录 A：`fill_line` 的语义定义（示范"把工具写清楚"的标准）

```
fill_line(from, to, block, radius=0, taper=null, step=1, mode="replace", hollow=false)

沿 from → to 的 3D Bresenham 直线放置方块。
radius > 0 时，生成以该线为轴、半径 radius 的圆柱（radius=0.5 → 3 格粗），
半径按 taper={start,end} 沿线的参数 t∈[0,1] 线性插值（做锥形塔尖、尖顶、树）。
step > 1 时每隔 step 格采样一次（做栅栏柱、脚手架、虚线）。
hollow=true 时只保留圆柱外壳。
mode 语义见 fill_box。
返回：changed / clipped / 受影响包围盒。

例：从 (0,0,0) 到 (15,15,15) 放 1 格粗的橡木梁
     → fill_line(from=[0,0,0], to=[15,15,15], block="minecraft:oak_log")
例：锥形塔尖，底半径 3 收到顶半径 0，高 20
     → fill_line(from=[8,20,8], to=[8,39,8], block="minecraft:dark_prismarine",
                 radius=3, taper={start:3,end:0}, hollow=true)
```

**同类工具必须达到这个文档标准**——因为工具描述就是 LLM 的说明书，写不清楚，LLM 就用不对。

## 附录 B：v0 必做的 6 个工具

如果时间极紧，只做这 6 个就能跑通完整闭环：

1. `screenshot`（多视图 + 标尺叠加）
2. `slice`（ASCII 层视图）
3. `fill_box`（长方体填充，含 hollow/outline）
4. `fill_line`（**对角批量填充**，含 radius/taper）
5. `measure`（尺寸与直方图）
6. `verify`（结构化自检，见 §9.4）

加上 `undo`，就足以让 LLM 盖出可辨认的建筑。其余工具都是效率与质量的放大器。

> `verify` 之所以是 v0 而不是 v1：**没有它，LLM 会大量地"声称完成但没完成"**，而且这个失败模式在长会话里会累积到无法收拾。它是 harness 可信度的下限。
