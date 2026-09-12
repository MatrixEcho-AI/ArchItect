# `.mcai` 工程格式规范 / `.mcai` project format

### [中文](#%E4%B8%AD%E6%96%87) | [English](#english)

---

<div lang="zh-CN">

## 中文

**格式版本 `0.1`**（独立于应用版本）。这个数字在 `manifest.formatVersion` 里，主版本变化表示不兼容。

> 本文是**规范**：它描述文件里有什么、每个字节什么意思、读方必须容忍什么。
> 为什么这样设计、以及取舍的理由在 `plan.md` 的 §4（世界模型）与 §5（工程格式）。
> 路径常量与校验逻辑以 `packages/mcai/src/manifest.ts` 与 `project.ts` 为准。

---

### 1. 容器

`.mcai` 就是一个**普通 zip**（deflate，不加密），扩展名注册到 Electron 的文件关联。

两条硬性约定：

1. **条目顺序固定**（见 §3 的表），**时间戳一律写成 1980-01-01**（zip 纪元起点）。
2. 因此**相同内容必然产生相同字节**。内容寻址与"这份工程有没有变过"的判断都建立在
   它上面。

读方**不得**依赖条目顺序——zip 的条目顺序不是语义的一部分，只有写方需要保证确定性。

---

### 2. 目录布局

```
project.mcai
├── manifest.json           # 格式版本、项目 id、MC 版本、revision、校验和
├── project.json            # 用户设置：工区、允许调色板、provider 引用
├── world/
│   ├── palette.json        # 有序方块状态表（磁盘层）
│   └── base.mcvox          # 基准体素快照（二进制）
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

### 3. 条目顺序与必需性

| # | 路径 | 必需 | 缺失时的行为 |
|---|------|:----:|-------------|
| 1 | `manifest.json` | ✅ | 报错：不是一个有效的 `.mcai` |
| 2 | `project.json` | — | 用默认工区（`0,minY,0` .. `15,minY+15,15`） |
| 3 | `world/palette.json` | ✅ | 报错：无法解释方块数据 |
| 4 | `world/base.mcvox` | ✅ | 报错：工程没有方块数据 |
| 5 | `history/edits.jsonl` | — | 空的编辑日志（世界等于快照） |
| 6 | `history/checkpoints.json` | — | 无检查点 |
| 7 | `chat/sessions.json` | — | 无会话记录 |
| 8 | `chat/messages.jsonl` | — | 无对话记录 |
| 9 | `captures/index.json` | — | 无截图索引 |
| 10 | `meta/stats.json` | — | 不提供统计 |
| 11 | `meta/log.txt` | — | 无日志 |
| 12… | `captures/<id>.png` | — | 见 §5.2 |

---

### 4. `manifest.json`

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

#### 4.1 `project.json`

```jsonc
{
  "volume": { "min": {"x":0,"y":0,"z":0}, "max": {"x":63,"y":63,"z":63} },
  "paletteAllowlist": ["minecraft:oak_planks", "minecraft:stone_bricks"],  // 省略 = 不限制
  "providerId": "DeepSeek"   // **只是名字引用，绝不存密钥**
}
```

**`.mcai` 是要分享给别人的文件**——发给朋友、传到论坛、提交到示例仓库都是正常用法。
所以里面出现明文 API key 就是事故。写方在任何情况下都不得写入密钥或密钥引用。

#### 4.2 `world/palette.json`

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

#### 4.3 `world/base.mcvox`

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

#### 4.4 `history/edits.jsonl`

一行一个 `EditOp`：

```jsonc
{"id":"op_000001","parent":null,"tool":"extrude","args":{…},"ts":"…",
 "correlationId":"turn-1","source":"llm",
 "result":{"changed":1024,"clipped":0,"truncated":false,"revision":1},
 "patch":{"bounds":[[0,4,0],[15,19,15]],"runs":[…]}}
```

- **追加式**：一行一条，追加写入不需要重写整个文件，坏了一行也只丢那一行。
- `revision` = 从 1 开始的序号；`baseRevision` 之前的 op **已经包含在快照里**，
  打开时只重放其后的部分。重复重放虽然幂等，但既白做功，又会掩盖 `baseRevision` 的语义错误。
- `correlationId` 让"同一次 LLM 响应里的多个 op"能一起回滚。
- `source` 是 `llm` / `user` / `system`——回放时能区分"模型改的"和"人改的"。

---

### 5. 对话与截图

这两部分同样是文件内容：只存方块，用户拿到的是一张图；存了对话，用户能看见
"为什么长成这样"。

#### 5.1 `chat/`

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

#### 5.2 `captures/`

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

### 6. 读方的容忍度

这一节是**规范的一部分**，不是建议。写方按上面的规则写，读方按下面三条容忍：

1. **附件缺失不算损坏。** `chat/`、`captures/`、`meta/` 全缺的工程必须能正常打开，
   方块数据必须完好。"没有对话"不是一个错误状态。
2. **未知条目原样保留。** 不在上表里的条目（未来版本加的、或者别的工具塞的）读进
   `extra`，重新打包时原样写回——**不要丢**，否则一次打开+保存就会毁掉别人的数据。
3. **索引与内容对不上就报告，不要抛错。** 抛错会让用户丢掉整份工程，
   而他能接受的结果是"图没了，方块还在"。

反过来说，**必需条目缺失必须报错**，而且要报得具体（缺的是哪个文件、期望什么格式），
不要只抛出 `undefined is not a function` 这类信息。

---

### 7. 版本与迁移

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

### 8. 最小示例

一个合法的、最小的 `.mcai`（只有必需的三个条目）：

```
manifest.json          {"formatVersion":"0.1",…,"revision":0,"baseRevision":0,…}
world/palette.json     {"minecraftVersion":"1.21.4","entries":["minecraft:air"]}
world/base.mcvox       header + zlib(空 body)
```

它能被打开、能被继续编辑、能被导出。`unpackProject` 对这样的文件不会报任何错。

</div>

---

<div lang="en">

## English

**Format version `0.1`** (independent of the app version). The number lives in
`manifest.formatVersion`; a major change means incompatibility.

> This is a **specification**: it describes what is in the file, what each byte means, and
> what a reader must tolerate. Why it is designed this way, and the trade-offs, are in
> `plan.md` §4 (world model) and §5 (project format). The path constants and the validation
> logic are authoritative in `packages/mcai/src/manifest.ts` and `project.ts`.

### 1. Container

A `.mcai` is an **ordinary zip** (deflate, not encrypted), with the extension registered with
Electron for file association.

Two hard rules:

1. **The entry order is fixed** (see the table in §3), and **timestamps are always written as
   1980-01-01** (the zip epoch).
2. The same content therefore always produces the same bytes. Content addressing, hashing for
   regression tests, and the question "has this project changed" all rest on it.

A reader **must not** depend on the entry order — the order of zip entries is not part of the
semantics; only the writer has to guarantee determinism.

### 2. Directory layout

```
project.mcai
├── manifest.json           # format version, project id, MC version, revision, checksums
├── project.json            # user settings: build area, allowed palette, provider reference
├── world/
│   ├── palette.json        # ordered block state table (the on-disk layer)
│   └── base.mcvox          # base voxel snapshot (binary)
├── history/
│   ├── edits.jsonl         # append-only EditOp event log
│   └── checkpoints.json    # named checkpoints (reserved; currently [])
├── chat/
│   ├── sessions.json       # session metadata
│   └── messages.jsonl      # the human-facing conversation record
├── captures/
│   ├── index.json          # capture index
│   └── <id>.png            # captures referenced by the conversation, content-addressed
├── meta/
│   ├── stats.json          # block count, column count, message count, capture count
│   └── log.txt             # a human-readable activity log
└── (unrecognised entries)  # preserved verbatim, see §6.2
```

**Only `manifest.json`, `world/palette.json` and `world/base.mcvox` are required.** With
everything else missing the project still works — see §6.

### 3. Entry order and required entries

| # | Path | Required | Behaviour when missing |
|---|------|:--------:|------------------------|
| 1 | `manifest.json` | yes | error: not a valid `.mcai` |
| 2 | `project.json` | — | the default build area (`0,minY,0` .. `15,minY+15,15`) |
| 3 | `world/palette.json` | yes | error: the block data cannot be read |
| 4 | `world/base.mcvox` | yes | error: the project has no block data |
| 5 | `history/edits.jsonl` | — | an empty edit log (the world equals the snapshot) |
| 6 | `history/checkpoints.json` | — | no checkpoints |
| 7 | `chat/sessions.json` | — | no session records |
| 8 | `chat/messages.jsonl` | — | no conversation |
| 9 | `captures/index.json` | — | no capture index |
| 10 | `meta/stats.json` | — | no statistics |
| 11 | `meta/log.txt` | — | no log |
| 12… | `captures/<id>.png` | — | see §5.2 |

### 4. `manifest.json`

```jsonc
{
  "formatVersion": "0.1",       // the version of this specification, not of the app
  "appVersion": "0.1.0",        // the app version that wrote the file
  "projectId": "01LIGHTHOUSE",  // project identity, preserved across export and import
  "name": "Seaside lighthouse",
  "minecraftVersion": "1.21.4", // **pinned**. Global state ids are not stable across versions, see §4.3
  "createdAt": "2026-01-01T00:00:00.000Z",
  "modifiedAt": "2026-01-01T02:59:59.120Z",
  "revision": 185,              // the **cursor**: which revision the world is at (applied op count)
  "baseRevision": 185,          // the revision world/base.mcvox corresponds to
  "worldHash": "…",             // WorldStore.contentHash(); verify it after opening
  "minY": -64,                  // world Y lower bound
  "worldHeight": 384,           // world Y height
  "counters": { "ops": 185, "captures": 4, "llmCalls": 37 },
  // Optional: design notes the model wrote itself (the `update_notes` tool). They are
  // "the current plan for this building" and survive across sessions — closing and
  // reopening should not make the model forget. Omitted means there are none.
  "designNotes": "Octagonal base 17 across, shaft tapering to 5; door faces south, 3 blocks of clearance, keep it clear"
}
```

A reader must check: `baseRevision <= revision <= counters.ops`; `counters.ops` equals the
number of lines in `edits.jsonl` (when the log exists); and `worldHash` after restoring the
world.

- `revision` is **a cursor**, not "how long the log is". Undo and time travel only move it
  back and forth and write no new op (plan §6). So `revision < counters.ops` is a **legal and
  common** state: it means "the world is on a historical revision, and the ops after it are
  the redo branch".
- `designNotes` is a short text **for the model** (at most 1200 characters, enforced by the
  tool). A reader puts it in the system prompt's `[DESIGN NOTES]` section; it takes part in
  no validation.
- `counters.ops` is the line count of the log, **written in full** — including the redo branch
  past the cursor, so that reopening a project can still redo.
- On save, `baseRevision` takes **the cursor**, not the log length: the snapshot holds what
  the world looks like now, and the world is now at the cursor. The log length would write a
  lie (the snapshot is the undone content while the manifest says it is the latest revision),
  and the world and the log would disagree after reopening.

#### 4.1 `project.json`

```jsonc
{
  "volume": { "min": {"x":0,"y":0,"z":0}, "max": {"x":63,"y":63,"z":63} },
  "paletteAllowlist": ["minecraft:oak_planks", "minecraft:stone_bricks"],  // omitted = unrestricted
  "providerId": "DeepSeek"   // **a name reference only, never a key**
}
```

**A `.mcai` is a file people share** — sending it to a friend, posting it on a forum or
committing it to a sample repository are all normal. A plaintext API key inside is therefore
an incident. A writer must never store a key or a key reference, under any circumstances.

#### 4.2 `world/palette.json`

```jsonc
{
  "minecraftVersion": "1.21.4",
  "entries": ["minecraft:air", "minecraft:oak_planks", "minecraft:oak_stairs[facing=north,half=bottom,…]"]
}
```

**The index is the value stored per cell in `world/base.mcvox`.** Three rules:

- `entries[0]` must be `minecraft:air`.
- What is stored is the **canonical state string** (properties in **alphabetical order**,
  defaults **not** omitted), not a global state id. That is what makes a snapshot portable
  across Minecraft versions: the same string means the same block in 1.16 and in 1.21, while
  a global state id changes (`oak_log` is 136 in 1.21.4 and something else elsewhere).
- **Compare by string, never by index** — the index is an internal convention of this file,
  and the same block can easily land on different indices in two palettes.

#### 4.3 `world/base.mcvox`

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

- All integers are **little-endian**.
- One column is a 16×16 horizontal chunk, and `indices` is indexed by
  `(((y - minY) & 15) << 8) | (z << 4) | x` — **the same as `prismarine-chunk`'s
  `ChunkColumn`**, so restoring needs no conversion.
- **Only non-empty columns are written** (`columnCount` is the real column count). When the
  build area is large and the building is small, the file size follows the building rather
  than the area.
- `paletteSize` must equal `entries.length` in `palette.json`; otherwise the file is corrupt.

#### 4.4 `history/edits.jsonl`

One `EditOp` per line:

```jsonc
{"id":"op_000001","parent":null,"tool":"extrude","args":{…},"ts":"…",
 "correlationId":"turn-1","source":"llm",
 "result":{"changed":1024,"clipped":0,"truncated":false,"revision":1},
 "patch":{"bounds":[[0,4,0],[15,19,15]],"runs":[…]}}
```

- **Append-only**: one line per op, so appending needs no rewrite, and one corrupt line costs
  only that line.
- `revision` is a sequence number starting at 1. Ops before `baseRevision` are **already in
  the snapshot**, so opening replays only what follows. Replaying all of them again is
  idempotent, but it wastes work and hides a wrong `baseRevision`.
- `correlationId` lets "several ops from one LLM response" be rolled back together.
- `source` is `llm` / `user` / `system` — so a replay can tell "the model changed this" from
  "a person changed this".

### 5. Conversation and captures

These two are file content as well: storing only blocks gives the reader a picture, while
storing the conversation lets them see why it looks like that.

#### 5.1 `chat/`

`chat/sessions.json`:

```jsonc
[{ "id":"s1", "title":"Design a seaside lighthouse", "createdAt":"…",
   "model":"deepseek-v4.1-flash", "providerId":"DeepSeek",
   // Usage for this session. **Stored** because opening a project has to show "how many
   // turns / tool calls / captures" as they were, and deriving them from the message count
   // is wrong (assistant messages are not turns: one turn can carry text and several tool
   // calls). Older projects lack this; a reader treats it as a lower-bound estimate.
   "totals": { "in":1970000, "out":61721, "cachedIn":1931000,
               "turns":13, "toolCalls":18, "screenshots":3 } }]
```

`chat/messages.jsonl`, one per line:

```jsonc
{"id":2,"role":"assistant","text":"Plan: octagonal base…","ts":"…",
 "toolCalls":[{"id":"c1","name":"measure","args":{}}]}
{"id":3,"role":"tool","text":"size 17x32x17","ts":"…",
 "toolCallId":"c1","toolName":"measure","ok":true}
{"id":4,"role":"tool","text":"screenshot iso_ne","ts":"…",
 "toolName":"screenshot","ok":true,"imageIds":["ba336d7c27b01d43"]}
{"id":9,"role":"assistant","text":"The lighthouse is done.","ts":"…",
 "usage":{"in":9397,"out":285,"cachedIn":0},"model":"deepseek-v4.1-flash"}
```

| Field | Meaning |
|-------|---------|
| `role` | `user` / `assistant` / `tool` |
| `toolCalls` | tool calls the assistant asked for. **Several calls from one LLM response are merged into a single message** |
| `toolCallId` / `toolName` / `ok` | the call a tool message answers, and its result |
| `imageIds` | references `captures/<id>.png`; **no image bytes go in a message** |
| `usage` / `model` | only on assistant messages that carry usage |
| `note` | `gate` (completion-gate reminder) / `retry`. **Not something the model said**; the interface has to show it differently |

Three reader conventions:

- **What is stored is the human-facing record, not the raw messages sent to the model.** The
  latter carry the system prompt, tool schemas and base64 images; they are not in this file,
  and a reader must not expect to rebuild the prompt from it.
- **Skip a corrupt line** and lose only that line, rather than making the whole archive
  unopenable.
- **A missing conversation is not corruption**: an older project, or a minimal project with
  the attachments stripped, is still fully usable.

#### 5.2 `captures/`

`captures/index.json`:

```jsonc
[{ "id":"ba336d7c27b01d43", "revision":6, "camera":"iso_ne",
   "width":320, "height":240, "bytes":6663,
   "sha256":"ba336d7c27b01d43f574523b8ce15f28e3b6c404a5ebab044a56c102541c013b",
   "file":"captures/ba336d7c27b01d43.png", "messageId":20 }]
```

- **`id` is the first 16 hex digits of the `sha256`**, and also the file name. Each image is
  stored once, so the index and the files correspond one-to-one by construction — there is no
  "the index points at a file that is not there" state.
- **A mismatch between index and files is reported, not fatal**: a missing image is a visible
  problem, the block data is still intact, and refusing to open the whole project over it
  would be backwards.
- Capture entry names in the zip are **dynamic** (decided by content), so they come after the
  fixed entries and are **sorted by name**, which keeps packing deterministic.

### 6. Reader tolerance

This section is part of the specification. A writer follows the rules above; a reader
tolerates these three things:

1. **Missing attachments are not corruption.** A project with no `chat/`, `captures/` or
   `meta/` at all must open normally, and the block data must be intact. "There is no
   conversation" is not an error state.
2. **Unknown entries are preserved verbatim.** Entries not in the table above (added by a
   future version, or by another tool) are read into `extra` and written back unchanged on
   repacking — **do not drop them**, or one open-and-save destroys somebody else's data.
3. **A mismatch between index and content is reported, not thrown.** Throwing loses the
   reader the whole project, when the acceptable outcome is "the images are gone, the blocks
   are still there".

Conversely, **a missing required entry must raise an error**, and a specific one (which file
is missing, what format was expected) — not `undefined is not a function`.

### 7. Versioning and migration

- A major change in `formatVersion` means **incompatibility**: a reader meeting a major
  version newer than its own should refuse to open the file and say so plainly.
- A minor change means a **backward-compatible addition** (a new optional entry or field). A
  reader ignores fields it does not know, but must preserve them per §6.2.
- `minecraftVersion` and `formatVersion` are **two independent version axes**: the former is
  block semantics, the latter is file structure. A migrator handles the former (block
  renames); migrating the file structure is separate code.
- Opening an older `.mcai` must **not** rewrite the reader's file in place; the upgrade
  happens on the next save.

The state of this policy: there is **no migrator for the file structure yet**, because
nothing so far has needed one — additions like `designNotes` (manifest) and `totals`
(sessions) are all **optional fields**: older files open without them, and newer files keep
their extra fields through older readers (§6.2).

What would actually require a migrator: **breaking** changes, that is, renaming or changing
the **meaning** of a field, making an optional field required, changing the snapshot or
palette encoding, or splitting or merging entries. When one arrives: bump the major version,
add a **pure function** under `migrate/` (old structure → new structure, touching no disk),
and migrate before validating when opening an old file. Until then no empty migration
framework is needed.

### 8. Minimal example

A legal, minimal `.mcai` (only the three required entries):

```
manifest.json          {"formatVersion":"0.1",…,"revision":0,"baseRevision":0,…}
world/palette.json     {"minecraftVersion":"1.21.4","entries":["minecraft:air"]}
world/base.mcvox       header + zlib(empty body)
```

It can be opened, edited further and exported. `unpackProject` raises no error on it.

</div>
