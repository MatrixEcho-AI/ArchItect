# 示例工程 / Example project

### [中文](#%E4%B8%AD%E6%96%87) | [English](#english)

---

<div lang="zh-CN">

## 中文

### 两份

| 文件 | 语言 |
|------|------|
| `forest-hut.mcai` | 英文 |
| `forest-hut.zh-CN.mcai` | 中文 |

两座小屋是同一座：同一段脚本、同一批坐标、同样的 330 格方块与 22 条消息，差别只有需求、模型那句话和工程名。

**为什么要两份。** 示例里装着对话记录，而对话是**内容**——它没法像界面文案那样跟着语言切换。所以一种语言生成一份，程序加载时按**已经定下来的**界面语言挑：英文界面载 `forest-hut.mcai`，中文界面载 `forest-hut.zh-CN.mcai`。

### 里面有什么

| 项目 | 内容 |
|------|------|
| 方块 | 330 格，7 步编辑记录 |
| 对话 | 22 条消息 |
| 截图 | 1 张 |
| 会话 | 模型与 provider 名，不含任何密钥 |

### 查看

```bash
pnpm architect info examples/forest-hut.mcai        # 清单与调色板
pnpm architect ops examples/forest-hut.mcai         # 编辑记录
pnpm architect slice examples/forest-hut.mcai --axis y --index 1
pnpm architect shoot examples/forest-hut.mcai --out hut.png --view iso_ne
pnpm architect export examples/forest-hut.mcai --out hut.schem   # 导出为 WorldEdit 结构
```

装了桌面版时也可以直接双击打开，或者在界面里用「打开…」。

也可以用 `unzip` 看它的内部结构，格式规范见 [`docs/mcai-format.md`](../docs/mcai-format.md)。

```bash
unzip -l examples/forest-hut.mcai
unzip -p examples/forest-hut.mcai chat/messages.jsonl | head -3
unzip -p examples/forest-hut.mcai manifest.json
```

### 重新生成

```bash
pnpm example
```

两份一起重新生成。

</div>

---

<div lang="en">

## English

### Two samples

| File | Language |
|------|----------|
| `forest-hut.mcai` | English |
| `forest-hut.zh-CN.mcai` | Chinese |

Both are the same hut: one script, the same coordinates, the same 330 blocks and 22 messages. Only the request, the model’s line and the project name differ.

**Why two.** A sample carries a conversation, and a conversation is *content* — it cannot follow the interface language the way a label can. So there is one per language, and the app loads the one matching the interface language it has already settled on: `forest-hut.mcai` for English, `forest-hut.zh-CN.mcai` for Chinese.

### What is in it

| Item | Contents |
|------|----------|
| Blocks | 330 cells over 7 edit records |
| Conversation | 22 messages |
| Screenshots | 1 |
| Session | model and provider names, no keys |

### Look at it

```bash
pnpm architect info examples/forest-hut.mcai        # manifest and palette
pnpm architect ops examples/forest-hut.mcai         # edit log
pnpm architect slice examples/forest-hut.mcai --axis y --index 1
pnpm architect shoot examples/forest-hut.mcai --out hut.png --view iso_ne
pnpm architect export examples/forest-hut.mcai --out hut.schem   # as a WorldEdit schematic
```

With the desktop app installed, double-clicking the file opens it too, as does “Open…” in the interface.

`unzip` shows the structure inside; the format is specified in [`docs/mcai-format.md`](../docs/mcai-format.md).

```bash
unzip -l examples/forest-hut.mcai
unzip -p examples/forest-hut.mcai chat/messages.jsonl | head -3
unzip -p examples/forest-hut.mcai manifest.json
```

### Regenerate it

```bash
pnpm example
```

That regenerates both.

</div>
