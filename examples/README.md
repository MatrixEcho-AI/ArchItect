# 示例工程

## `forest-hut.mcai`

一座 9×9 的单层林间小屋。

| 项目 | 内容 |
|------|------|
| 方块 | 330 格，7 步编辑记录 |
| 对话 | 22 条消息 |
| 截图 | 1 张 |
| 会话 | 模型与 provider 名，不含任何密钥 |

## 查看

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

## 重新生成

```bash
pnpm example
```
