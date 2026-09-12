# 示例工程 / Example project

### [中文](#%E4%B8%AD%E6%96%87) | [English](#english)

---

<div lang="zh-CN">

## 中文

### `forest-hut.mcai`

一座 9×9 的单层林间小屋。

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

</div>

---

<div lang="en">

## English

### `forest-hut.mcai`

A single-storey 9×9 forest hut.

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

With the desktop app installed, double-clicking the file opens it too, as does “Open…”
in the interface.

`unzip` shows the structure inside; the format is specified in
[`docs/mcai-format.md`](../docs/mcai-format.md).

```bash
unzip -l examples/forest-hut.mcai
unzip -p examples/forest-hut.mcai chat/messages.jsonl | head -3
unzip -p examples/forest-hut.mcai manifest.json
```

### Regenerate it

```bash
pnpm example
```

</div>
