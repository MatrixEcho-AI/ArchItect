# 示例工程

## `forest-hut.mcai`

一座 9×9 的单层林间小屋，用来演示一个 `.mcai` 里都有什么。

| 项目 | 内容 |
|------|------|
| 方块 | 330 格，7 步编辑记录 |
| 对话 | 22 条消息（用户需求 → 工具调用 → 结果 → 模型收尾） |
| 截图 | 1 张（内容寻址存档在 `captures/`） |
| 会话 | 模型与 provider 名，不含任何密钥 |

## 用途

`packages/mcai/test/examples.test.ts` 会打开它、核对方块数、对话条数与截图。格式改动与
它不符时测试会失败，所以它不会与规范脱节。它同时是 `.mcai` 内部结构的可读样例。

## 查看

```bash
pnpm architect info examples/forest-hut.mcai        # 看清单与调色板
pnpm architect ops examples/forest-hut.mcai         # 看编辑记录
pnpm architect slice examples/forest-hut.mcai --axis y --index 1
pnpm architect shoot examples/forest-hut.mcai --out hut.png --view iso_ne
pnpm architect export examples/forest-hut.mcai --out hut.schem   # 拿去游戏里用
```

装了桌面版时也可以直接双击打开，或者在界面里用「打开…」。

也可以用 `unzip` 直接看它的内部结构，格式规范见 [`docs/mcai-format.md`](../docs/mcai-format.md)。

```bash
unzip -l examples/forest-hut.mcai
unzip -p examples/forest-hut.mcai chat/messages.jsonl | head -3
unzip -p examples/forest-hut.mcai manifest.json
```

## 重新生成

```bash
pnpm example
```

生成完全确定（固定时间戳、固定会话 id、脚本 provider），同样的代码产出逐字节相同的文件，
所以 `git diff` 能如实反映导出逻辑的改动。
