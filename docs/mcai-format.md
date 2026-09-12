# `.mcai` 工程格式规范

**格式版本 `0.1`**（独立于应用版本）。这个数字在 `manifest.formatVersion` 里，主版本变化表示不兼容。

> 本文是**规范**：它描述文件里有什么、每个字节什么意思、读方必须容忍什么。
> 为什么这样设计、以及取舍的理由在 `plan.md` 的 §4（世界模型）与 §5（工程格式）。
> 路径常量与校验逻辑以 `packages/mcai/src/manifest.ts` 与 `project.ts` 为准。

---

## 1. 容器

`.mcai` 就是一个**普通 zip**（deflate，不加密），扩展名注册到 Electron 的文件关联。

两条硬性约定：

1. **条目顺序固定**（见 §3 的表），**时间戳一律写成 1980-01-01**（zip 纪元起点）。
2. 因此**相同内容必然产生相同字节**。内容寻址与"这份工程有没有变过"的判断都建立在
   它上面。

读方**不得**依赖条目顺序——zip 的条目顺序不是语义的一部分，只有写方需要保证确定性。

---

## 2. 目录布局

```
project.mcai
├── manifest.json           # 格式版本、项目 id、MC 版本、revision、校验和
├── project.json            # 用户设置：工区、允许调色板、provider 引用
├── world/
│   ├── palette.json        # 有序方块状态表（磁盘层）
│   ├── base.mcvox          # 基准体素快照（二进制）
│   ├── entities.jsonl      # 实体基快照（空则不写这个条目）
│   └── block-entities.jsonl # 方块实体基快照（空则不写这个条目）
├── history/
│   ├── edits.jsonl         # 追加式 EditOp 事件日志
│   └── checkpoints.json    # 命名检查点（预留，当前写 []）
├── chat/
│   ├── sessions.json       # 会话元信息
│   └── messages.jsonl      # 面向人的对话记录
├── captures/
│   ├── index.json          # 截图索引
│   └── <id>.png            # 对话中引用过的截图，内容寻址
├── meta/
│   ├── stats.json          # 方块数、列数、消息数、截图数
│   └── log.txt             # 人类可读的活动日志
└── (未识别的条目)            # 原样保留，见 §7
```

**只有 `manifest.json`、`world/palette.json`、`world/base.mcvox` 是必需的。**
其余全部缺失时工程仍然可用——见 §6。

---

## 3. 条目顺序与必需性

| # | 路径 | 必需 | 缺失时的行为 |
|---|------|:----:|-------------|
| 1 | `manifest.json` | ✅ | 报错：不是一个有效的 `.mcai` |
| 2 | `project.json` | — | 用默认工区（`0,minY,0` .. `15,minY+15,15`） |
| 3 | `world/palette.json` | ✅ | 报错：无法解释方块数据 |
| 4 | `world/base.mcvox` | ✅ | 报错：工程没有方块数据 |
| 5 | `world/entities.jsonl` | — | 没有实体（空） |
| 6 | `world/block-entities.jsonl` | — | 没有方块实体（空） |
| 7 | `history/edits.jsonl` | — | 空的编辑日志（世界等于快照） |
| 8 | `history/checkpoints.json` | — | 无检查点 |
| 9 | `chat/sessions.json` | — | 无会话记录 |
| 10 | `chat/messages.jsonl` | — | 无对话记录 |
| 11 | `captures/index.json` | — | 无截图索引 |
| 12 | `meta/stats.json` | — | 不提供统计 |
| 13 | `meta/log.txt` | — | 无日志 |
| 14… | `captures/<id>.png` | — | 见 §5.2 |

---

## 4. `manifest.json`

```jsonc
{
  "formatVersion": "0.1",       // 本规范的版本，与 app 版本无关
  "appVersion": "0.1.0",        // 写这份文件的应用版本
  "projectId": "01LIGHTHOUSE",  // 项目标识，导出/导入时保留
  "name": "海边灯塔",
  "minecraftVersion": "1.21.4", // **钉死**。全局 stateId 跨版本不稳定，见 §4.3
  "createdAt": "2026-01-01T00:00:00.000Z",
  "modifiedAt": "2026-01-01T02:59:59.120Z",
  "revision": 185,              // **游标**：世界现在对应哪个版本（已应用的 op 数）
  "baseRevision": 185,          // world/base.mcvox 对应的版本
  "worldHash": "…",             // WorldStore.contentHash()，打开后应当核对
  "minY": -64,                  // 世界 Y 下界
  "worldHeight": 384,           // 世界 Y 高度
  "counters": { "ops": 185, "captures": 4, "llmCalls": 37 },
  // 可选：模型自己写的设计笔记（`update_notes` 工具）。它是"这栋建筑的当前计划"，
  // 跨会话有效——关掉再打开，模型不该失忆。省略表示没有笔记。
  "designNotes": "八角基座 17 格，塔身收到 5 格；门朝南非，净高 3 格不能堵"
}
```

读方必须校验：`baseRevision <= revision <= counters.ops`；
`counters.ops === edits.jsonl` 的行数（若日志存在）；`worldHash` 在恢复世界之后核对。

- `revision` 是**游标**，不是"日志有多长"。撤销 / 时间旅行只把它前后移动，
  不写新的 op（plan §6）。所以 `revision < counters.ops` 是**合法且常见**的状态：
  它表示"世界停在历史版本上，日志后面那几步是重做分支"。
- `designNotes` 是**给模型看的**一段短文（上限 1200 字符，由工具自己把关），
  读方把它塞进系统提示的 `[DESIGN NOTES]` 段即可；它不参与任何校验。
- `counters.ops` 才是日志的行数，**全量写入**——包括游标之后的重做分支，
  这样重开工程之后仍然能重做。
- 保存时 `baseRevision` 取**游标**而不是日志长度：快照写的是世界现在的样子，
  而世界现在停在游标那里。取日志长度会写出一份谎报（快照 = 撤销后的内容，
  manifest 却说它在最新版本），重开之后世界与日志就对不上了。

### 4.1 `project.json`

```jsonc
{
  "volume": { "min": {"x":0,"y":0,"z":0}, "max": {"x":63,"y":63,"z":63} },
  "paletteAllowlist": ["minecraft:oak_planks", "minecraft:stone_bricks"],  // 省略 = 不限制
  "providerId": "DeepSeek"   // **只是名字引用，绝不存密钥**
}
```

**`.mcai` 是要分享给别人的文件**——发给朋友、传到论坛、提交到示例仓库都是正常用法。
所以里面出现明文 API key 就是事故。写方在任何情况下都不得写入密钥或密钥引用。

### 4.2 `world/palette.json`

```jsonc
{
  "minecraftVersion": "1.21.4",
  "entries": ["minecraft:air", "minecraft:oak_planks", "minecraft:oak_stairs[facing=north,half=bottom,…]"]
}
```

**下标就是 `world/base.mcvox` 里每格存的值。** 三项约定：

- `entries[0]` 必须是 `minecraft:air`。
- 存的是**规范状态字符串**（属性的**字母序**、**不省略**默认值），不是全局 stateId。
  这样快照跨 Minecraft 版本可迁移：同一个字符串在 1.16 和 1.21 指向同一个方块，
  而全局 stateId 会变（`oak_log` 在 1.21.4 是 136，在别的版本不是）。
- **相等性一律按字符串比，不按下标比**——下标是这份文件的内部约定，两张调色板的同一个
  方块完全可能落在不同下标上。

### 4.3 `world/base.mcvox`

```
header (32 bytes)
  magic[8]      = "MCAVOX\0\0"
  version:u32   = 1
  minY:i32
  worldHeight:u32
  paletteSize:u32
  columnCount:u32
  reserved:u32
body = zlib( for each column:
  chunkX:i32 | chunkZ:i32 | indices:u16[worldHeight * 256]
)
```

- 所有整数**小端**。
- 一列 = 一个 16×16 的水平区块，`indices` 按
  `(((y - minY) & 15) << 8) | (z << 4) | x` 索引——**与 `prismarine-chunk` 的
  `ChunkColumn` 一致**，所以恢复时不需要任何转换。
- **只有非空的列会被写入**（`columnCount` 是实际列数）。工区很大但建筑很小时，
  文件大小由建筑决定，而不是由工区决定。
- `paletteSize` 必须等于 `palette.json` 的 `entries.length`，否则判为文件损坏。

### 4.4 `world/entities.jsonl`

一行一个实体。**空集合不写这个条目**——与"读方缺了就当空"对称，
也让没用到这一层的工程字节和以前一模一样。

```jsonc
{"id":"e_3_1","type":"minecraft:oak_boat","x":3.5,"y":1,"z":4.5,"yaw":8,
 "data":{"passengers":[{"type":"minecraft:pig"}]}}
```

- `type` 是**规范类型串**，版本无关——和 `palette.json` 存状态字符串而不是 stateId
  同一个理由（§4.2）。
- `x` / `y` / `z` 是**精确 double**：工具层把入参量化到 1/16 格，容器这一层不量化，
  所以从别的格式导入进来的位置不会被悄悄改动。`yaw` 是 0..15（每步 22.5°）。
- `id` 形如 `e_<op 序号>_<第几个>`，由**写入方**分配并写进 `edits.jsonl` 的差分里。
  这样重放是纯机械应用，读方不需要持久化一个"下一个号是多少"的计数器。
- `data` 是按类型封闭 schema 的附加数据，本规范不管它的内容，但读方必须原样保留。
- **`rev <= baseRevision` 的部分在这里**；其后的变更在 `edits.jsonl` 的 `entityChanges` 里。

### 4.5 `world/block-entities.jsonl`

一行一个方块实体。键是**位置**（一格最多一个），空集合同样不写条目。

```jsonc
{"x":2,"y":1,"z":2,"kind":"chest","data":{"items":[{"slot":0,"id":"minecraft:diamond","count":3}]}}
```

- 与实体层最大的差别是它**寄生**于方块：方块被换成不带方块实体的类型，它就随之消失。
  这个"消失"记在 `edits.jsonl` 的 `blockEntityChanges` 里，而且**由写方自己产出**——
  只有它同时知道"哪个格子被改了"和"这个格子上原本挂着什么"。
- 两份文件的行序都是**确定的**（实体按 id 排、方块实体按 y→z→x 排），所以同样的世界
  必然打出同样的字节（§1 的确定性要求）。

### 4.6 `history/edits.jsonl`

一行一个 `EditOp`。`patch` 是 `ChangeSet` 的 base64，另外两个可选字段是纯 JSON 的稀疏层差分：

```jsonc
{"id":"op_000001","rev":1,"ts":"2026-01-01T00:00:00.000Z","source":"llm","actor":"assistant",
 "tool":"extrude","args":{…},"correlationId":"turn_1",
 "result":{"changed":1024,"overwrittenNonAir":0,"clipped":0},
 "patch":"AAAAAA…"}
```

- **追加式**：一行一条，追加写入不需要重写整个文件。只有**最后一行**的不完整被容忍
  （写到一半掉电），中间坏行判为日志损坏。
- `patch` **恒在，可以是空集**：一条只改稀疏层的 op 也带一个长度为 0 的 `patch`。
  读方不能把"空"当成省略——**缺这个字段是坏文件**（老读方会直接抛错，整份工程打不开）。
- `rev` 是从 1 开始的序号；`baseRevision` 之前的 op **已经包含在快照里**，
  打开时只重放其后的部分。重复重放虽然幂等，但既白做功，又会掩盖 `baseRevision` 的语义错误。
- `correlationId` 让"同一次 LLM 响应里的多个 op"能一起回滚。
- `source` 是 `llm` / `user` / `import` / `system`——回放时能区分"模型改的"和"人改的"。
- 两个可选字段承载世界的另外两层，形状都是 `{key, before, after}` 的数组：`after`
  缺席表示删除、`before` 缺席表示新增，反演 = 交换两者**并把顺序倒过来**（同一个键
  可以在一组里出现两次，比如同一格"先剪除旧的、再写入新的"）：

```jsonc
"blockEntityChanges":[{"key":"2,1,2","before":{"x":2,"y":1,"z":2,"kind":"chest","data":{…}}}],
"entityChanges":[{"key":"e_3_1","after":{"id":"e_3_1","type":"minecraft:oak_boat",…}}]
```

- **老 op 没有这两个字段**，读回来是 `undefined`，语义等同于空数组——这不是坏文件。

---

## 5. 对话与截图

这两部分同样是文件内容：只存方块，用户拿到的是一张图；存了对话，用户能看见
"为什么长成这样"。

### 5.1 `chat/`

`chat/sessions.json`：

```jsonc
[{ "id":"s1", "title":"设计一座海边灯塔", "createdAt":"…",
   "model":"deepseek-v4.1-flash", "providerId":"DeepSeek",
   // 这一场会话的用量计数。**存下来**是因为打开工程时界面要把"几轮 / 几次工具 /
   // 几张截图"原样显示出来，而按消息数反推是错的（assistant 消息数 ≠ 轮数：
   // 一轮里可能既有正文又有多次工具调用）。老工程没有这一项，读方按"估一个下界"处理。
   "totals": { "in":1970000, "out":61721, "cachedIn":1931000,
               "turns":13, "toolCalls":18, "screenshots":3 } }]
```

`chat/messages.jsonl`，一行一条：

```jsonc
{"id":2,"role":"assistant","text":"方案：八角基座…","ts":"…",
 "toolCalls":[{"id":"c1","name":"measure","args":{}}]}
{"id":3,"role":"tool","text":"size 17x32x17","ts":"…",
 "toolCallId":"c1","toolName":"measure","ok":true}
{"id":4,"role":"tool","text":"screenshot iso_ne","ts":"…",
 "toolName":"screenshot","ok":true,"imageIds":["ba336d7c27b01d43"]}
{"id":9,"role":"assistant","text":"灯塔完成。","ts":"…",
 "usage":{"in":9397,"out":285,"cachedIn":0},"model":"deepseek-v4.1-flash"}
```

| 字段 | 说明 |
|------|------|
| `role` | `user` / `assistant` / `tool` |
| `toolCalls` | assistant 请求的工具调用。**一次 LLM 响应里的多个调用合并在同一条消息上** |
| `toolCallId` / `toolName` / `ok` | tool 消息对应的调用与结果 |
| `imageIds` | 引用 `captures/<id>.png`；**消息里不放图片字节** |
| `usage` / `model` | 只挂在带用量的 assistant 消息上 |
| `note` | `gate`（完成闸门提醒）/ `retry`（重试）。**不是模型说的话**，界面要区别显示 |

三条读方约定：

- **存的是面向人的记录，不是发给模型的原始消息。** 后者带着 system prompt、工具 schema、
  图片 base64，既不进这个文件，读方也不该指望能从这里完整重建 prompt。
- **坏行跳过**，只丢那一行，不让整份档案打不开。
- **缺了对话不算损坏**：老工程、或被裁剪过的最小工程仍然完全可用。

### 5.2 `captures/`

`captures/index.json`：

```jsonc
[{ "id":"ba336d7c27b01d43", "revision":6, "camera":"iso_ne",
   "width":320, "height":240, "bytes":6663,
   "sha256":"ba336d7c27b01d43f574523b8ce15f28e3b6c404a5ebab044a56c102541c013b",
   "file":"captures/ba336d7c27b01d43.png", "messageId":20 }]
```

- **`id` = `sha256` 的前 16 位**，同时是文件名。同一张图只存一份，
  所以索引与文件天然一一对应——不存在"索引指向一个不存在的文件"这种状态。
- **索引与文件对不上只报告，不阻断打开**：少一张图是能看见的问题，
  而方块数据仍然完好，为它拒绝打开整份工程是本末倒置。
- 截图在 zip 里的条目名是**动态**的（由内容决定），所以排在固定条目之后、**按名字排序**，
  以保证打包的确定性。

---

## 6. 读方的容忍度

这一节是**规范的一部分**，不是建议。写方按上面的规则写，读方按下面三条容忍：

1. **附件缺失不算损坏。** `chat/`、`captures/`、`meta/` 全缺的工程必须能正常打开，
   方块数据必须完好。"没有对话"不是一个错误状态。
2. **未知条目原样保留。** 不在上表里的条目（未来版本加的、或者别的工具塞的）读进
   `extra`，重新打包时原样写回——**不要丢**，否则一次打开+保存就会毁掉别人的数据。
   （这一条曾经只是承诺：`unpackProject` 老老实实收了 `extra`，但 `packProject`
   从来不写回来，于是"新版本加了条目 → 旧版本打开 → 保存"就等于把条目删了。
   现在写方通过 `PackInput.extra` 把它写回去。这也是"格式演进只加条目"能成立的前提。）
3. **索引与内容对不上就报告，不要抛错。** 抛错会让用户丢掉整份工程，
   而他能接受的结果是"图没了，方块还在"。

反过来说，**必需条目缺失必须报错**，而且要报得具体（缺的是哪个文件、期望什么格式），
不要只抛出 `undefined is not a function` 这类信息。

---

## 7. 版本与迁移

- `formatVersion` 的主版本变化表示**不兼容**：读方遇到比自己新的主版本应当拒绝打开，
  并明确告诉用户"这份文件是更新的版本写的"。
- 次版本变化表示**向后兼容的追加**（新增可选条目/字段）。读方忽略不认识的字段即可，
  但必须按 §6.2 原样保留。
- `minecraftVersion` 与 `formatVersion` 是**两个独立的版本轴**：前者是方块语义，
  后者是文件结构。迁移器只处理前者（方块改名），文件结构的迁移是另一套代码。
- 从旧版 `.mcai` 打开时，读方**不应**就地改写用户的文件；升级发生在下一次保存。

这套策略的现状：文件结构的**迁移器还没有**，因为到目前为止
没有任何一次改动需要它——`designNotes`（manifest）、`totals`（会话记录）这类
新增都是**可选字段**：老文件缺它们照样能打开，新文件里多出来的字段老读方会原样保留
（§6.2）。

什么时候才真的需要迁移器：**破坏性**改动，也就是下面这几类——
重命名或改变某个字段的**语义**、把一个可选字段变成必填、改变快照/调色板的编码、
拆分或合并条目。真出现那种改动时：主版本 +1、`migrate/` 里加一个**纯函数**
（`旧结构 → 新结构`，不碰磁盘）、并且在打开旧文件时**先迁移再校验**。
在那之前不需要空的迁移框架。

---

## 8. 最小示例

一个合法的、最小的 `.mcai`（只有必需的三个条目）：

```
manifest.json          {"formatVersion":"0.1",…,"revision":0,"baseRevision":0,…}
world/palette.json     {"minecraftVersion":"1.21.4","entries":["minecraft:air"]}
world/base.mcvox       header + zlib(空 body)
```

它能被打开、能被继续编辑、能被导出。`unpackProject` 对这样的文件不会报任何错。
