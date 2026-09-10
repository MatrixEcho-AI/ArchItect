# 示例工程

## `forest-hut.mcai`

一座 9×9 的单层林间小屋，用来演示一个 `.mcai` 里**都该有什么**。

| | |
|---|---|
| 方块 | 330 格，7 步编辑记录 |
| 对话 | 22 条消息（用户需求 → 工具调用 → 结果 → 模型收尾） |
| 截图 | 1 张（内容寻址存档在 `captures/`） |
| 会话 | 模型、provider 名（**不含任何密钥**） |

打开它：

```bash
pnpm architect info examples/forest-hut.mcai        # 看清单与调色板
pnpm architect ops examples/forest-hut.mcai         # 看编辑记录
pnpm architect slice examples/forest-hut.mcai --axis y --index 1
pnpm architect shoot examples/forest-hut.mcai --out /tmp/hut.png --view iso_ne
pnpm architect export examples/forest-hut.mcai --out /tmp/hut.schem   # 拿去游戏里用
```

或者直接双击（装了桌面版的话），或者在界面里「打开…」。

## 它为什么在仓库里

1. **一份活的端到端夹具。** `packages/mcai/test/examples.test.ts` 会打开它、核对
   方块数、对话条数与截图，所以格式演进时它不会悄悄烂掉——坏了测试就红。
2. **格式的可读样例。** 想看清 `.mcai` 内部长什么样，直接：

   ```bash
   unzip -l examples/forest-hut.mcai
   unzip -p examples/forest-hut.mcai chat/messages.jsonl | head -3
   unzip -p examples/forest-hut.mcai manifest.json
   ```

   规范见 `docs/mcai-format.md`。

## 重新生成

```bash
pnpm example
```

生成是**完全确定性**的（固定时间戳、固定会话 id、脚本 provider），
所以同样的代码必然产出逐字节相同的文件——`git diff` 能如实反映"导出逻辑改了"。
