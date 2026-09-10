# ArchItect

**用多模态 LLM 设计 Minecraft 建筑的 harness。**

你说一句"设计一座海边灯塔，塔身收分，顶部有玻璃灯室"，它自主规划、调工具、拍截图自检、
改到满意，最后产出一个可回放、可导出、可分享的 `.mcai` 工程文件。

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

**模型的眼睛和你的眼睛是同一套渲染器。** 桌面端模型收到的截图由渲染进程里的
three.js 画（和视口共用同一份几何与相机）；CLI、CI 与无 GPU 环境走自研的软件光栅器，
那条路逐字节可复现，golden 测试靠它。两条路共用相机与叠加层，所以换后端不会换构图。

---

## 5 分钟上手

```bash
pnpm install

# 1. 看一眼它长什么样（不需要 API key）
pnpm demo:v0                     # 脚本化造一座灯塔 → /tmp/v0demo/lighthouse.mcai
pnpm desktop                     # 打开界面（Electron）

# 2. 接一个模型
pnpm providers                   # 先探测端点：有哪些模型、吃不吃图、单图多少 token
#    没配好的话它会告诉你要 export 哪个环境变量

# 3. 让它真的设计一座
export ARCHITECT_API_KEY=sk-...
pnpm architect build "造一座 9x9 的林间小屋，云杉木板墙、圆石地基、斜坡屋顶，正门朝南开" \
  --out hut.mcai

# 4. 看结果
pnpm architect slice hut.mcai --axis y --index 1     # ASCII 平面图
pnpm architect shoot hut.mcai --out hut.png --view iso_ne
pnpm architect export hut.mcai --out hut.schem       # 拿去游戏里 //schem load
```

**不想接云模型也行**：Ollama 本地跑同样一套 Provider 配置（`--provider ollama`）。
它没有前缀缓存，harness 会**自动切到保守的上下文策略**：只保留最近 6 轮、最多 3 张截图，
并在历史里留一句"前面 N 轮被裁掉了"。反过来，有前缀缓存的 provider（DeepSeek）**一轮都不裁**——
剪掉一张旧图省下的钱，比把它后面十万 token 的缓存打掉亏掉的钱少三个数量级。
（判据在 `packages/agent/src/context.ts`，两套只在其中一套上跑。）

---

## 它凭什么比"直接让模型写代码"强

| 问题 | 做法 |
|------|------|
| **模型看不出自己错在哪** | 截图上叠坐标标尺与坐标轴；改动范围高亮；`verify` 让"读回确认"变成一次函数调用而不是口头约定 |
| **模型数不清格子** | 截图会被下采样到约 800×800，一格只有几个像素——所以**精确编辑一律走 `slice` 的 ASCII 文本**，图只用来看观感 |
| **逐格摆放太慢太贵** | 工具集以批量几何为主：`extrude` 画一层平面图长成建筑、`fill_line` 做任意方向的梁与收分、`run_batch` 把多个操作压成**一个 revision** |
| **复制旋转之后朝向全错** | `copy_region`/`paste_region`/`symmetrize` 用**同一个矩阵**同时算坐标与朝向；在 1.21.4 全部 27 866 个 state × 9 种变换上验证过是双射 |
| **成本失控** | 截图内容寻址去重、前缀缓存友好的 append-only 上下文（DeepSeek 缓存命中便宜 50 倍）、实时成本表盘 |
| **改了却不说改没改** | 完成闸门：改过东西之后必须有一次通过的结构化读回才允许结束 |
| **说不清"从这个角度看"** | 机位面板可以填精确的角度或相机坐标/注视点；勾上「模型用这个机位」，模型接下来的截图就从你看的那个位置拍——**人机共用机位**。截图里的标签会带上注视点（`az45/el30→(8,5,8)`），档案里能分辨"看整栋楼"和"盯着檐口" |
| **模型改不到的地方人手补** | 左栏调色板选方块，视口里点一下 = 放置、Alt+点 = 挖掉、Cmd/Ctrl+点 = 吸取。**人改的和模型改的完全同权**：同一条 op 日志（只差 `source` 字段），所以撤销、时间线、导出、`.mcai` 保存全都照常 |
| **改错一步只能重来** | 撤销 / 重做是**时间线游标前后移动 + 重放**，不写新的 op——所以撤销之后时间线、`.mcai` 往返、导出全都仍然自洽。停在历史版本上时发送框会锁住并说明原因：此时让模型改，它的第一笔就会把后面的步骤覆盖掉 |

---

## 工程结构

```
packages/
  core       体素内核 · 状态编解码 · 几何算子 · 世界存储 · 历史回放 · 朝向变换 · linter
  mcai       .mcai 容器 · 对话与截图存档 · 崩溃恢复 WAL
  render     软件光栅器 · 原版方块模型网格化 · 纹理图集 · 相机与叠加层 · 正交射线拾取 · PNG 编解码
  tools      23 个 LLM 工具 · JSON Schema 校验 · 文档生成
  interop    .schem / .litematic / .obj · 版本迁移
  agent      Agent 循环 · 完成闸门 · Provider 适配与能力发现
  i18n       中文优先的文案层（zh-CN 是基准表）
  cli        无头命令行
apps/
  desktop    Electron 桌面端
docs/        格式规范 · 工具参考（生成） · prompt 库
examples/    示例工程
```

约束：`packages/*` 全部不依赖 Electron、不依赖 DOM。

---

## 常用命令

| 命令 | 作用 |
|------|------|
| `pnpm test` | 全部测试（含全量枚举、文档一致性、**真实 HTTP 的端到端**） |
| `pnpm typecheck` | 八个项目一起过类型 |
| `pnpm docs:gen` | 重新生成工具参考（过期时 `pnpm test` 会失败）。脚本名带 `:gen` 是有原因的：单独一个 `docs` 会被 pnpm 的内建命令抢走，变成打开包的文档页 |
| `pnpm demo:v0` | 不需要 API key 的完整闭环演示 |
| `pnpm providers` | 探测模型端点：列模型、选模型、实测能力 |
| `npx vitest run packages/cli` | 起一个协议级假模型端点，用真 `architect build` 跑完整条链路（不需要 API key） |
| `pnpm bench` | 跑黄金任务出评分表（真模型，五个任务约 $0.19）。`--record <f.jsonl>` 录下全部模型交互，`--replay <f.jsonl>` 之后**完全不联网**重跑同一遍——实测每个数字逐项相同，耗时从 359 s 降到 1.7 s |
| `pnpm architect <命令>` | CLI：`info` / `ops` / `measure` / `slice` / `replay` / `shoot` / `build` / `export` / `import` |
| `pnpm desktop` | 打开桌面端 |
| `pnpm example` | 重新生成 `examples/forest-hut.mcai`（时间戳钉死，所以输出可复现） |
| `pnpm --filter @architect/desktop package:dir` | 打一个不打签名、不做安装包的目录版（验打包用） |

桌面端的几个诊断开关（都要先 `pnpm --filter @architect/desktop build`）。
它们可以**叠加**，比如 `--no-webgl --drag-test` 验的是"没有 WebGL 时拖动还能不能用"：

```bash
cd apps/desktop
npx --no-install electron . --demo --gui-smoke             # 全链路冒烟：GPU 截图 + 一串 DOM 断言（时间线拖得动、编辑记录点得开、模板填得进输入框）；任何一条不过就退 1
npx --no-install electron . --demo --capture /tmp/gui.png  # 抓用户看到的窗口
npx --no-install electron . --demo --shot /tmp/eye.png     # 抓**模型收到的那张图**
npx --no-install electron . --demo --no-webgl              # 强制走软件视口（验兜底路径）
npx --no-install electron . --demo --undo-test             # 合成两次撤销（停在历史版本上的样子）
npx --no-install electron . --demo --paint-test            # 合成一次"人手放一格"
```

后两个不是一回事：`--capture` 是用户的视口，`--shot` 走 `ctx.shoot`，
尺寸、叠加层、用哪条渲染路径都和模型真实收到的一致。
排查"模型为什么看错了"时先看 `--shot` 那张。

**没有 WebGL 的机器上界面照样能用**：视口会退回主进程的软件光栅器（慢、无抗锯齿、
拖动降分辨率），并在对话面板上明说这件事。模型截图那条路不受影响——它本来就
优先走渲染进程的 WebGL，拿不到才退回软件光栅器。

---

## 文档

| 文档 | 内容 |
|------|------|
| [`plan.md`](plan.md) | 设计文档：世界模型、格式、渲染、工具语义、Agent 循环、里程碑、决策记录、四个附录 |
| [`docs/mcai-format.md`](docs/mcai-format.md) | `.mcai` 格式规范（字节级） |
| [`docs/tool-reference.md`](docs/tool-reference.md) | 23 个工具的完整参考——**从 JSON Schema 生成**，不会过期 |
| [`docs/prompt-library.md`](docs/prompt-library.md) | 建筑风格需求模板：住宅 / 公共建筑 / 结构装饰 / 修问题 |
| [`examples/README.md`](examples/README.md) | 示例工程怎么看、怎么重新生成 |

---

## 打包

```bash
pnpm --filter @architect/desktop package          # dmg / nsis / AppImage
pnpm --filter @architect/desktop package:dir      # 只出 .app/.exe 目录，验打包用
```

已验证：`--dir` 打出来的 `.app` 直接跑 `--smoke` 与 `--gui-smoke` 都通过——
即被标成 external 的 `minecraft-data` / `minecraft-assets` / `prismarine-*` 在 asar 里都能 require 到。

**体积 837 MB**，比预期大得多：`minecraft-assets` 把整个资源包（65 275 个文件）装了进来，
而我们只用到其中一小部分纹理。这是成本问题不是可用性问题，两条路见 `plan.md` §10.3——
根本解法是**不内置素材**，让用户指向自己的 `.minecraft`，那同时也解决了素材授权问题。

---

## 非目标

连接真实服务器施工、红石逻辑、命令方块、实体布置、生存玩法、多人协作、移动端、
程序化地形生成。**本产品只是软件，只预留导出功能**——你拿文件自己去游戏里粘贴。

## 明确的安全红线

**API key 不进 git、不进 `.mcai`。** `.mcai` 是要分享给别人的文件，
里面出现明文密钥就是事故。配置里只存 `env:NAME` / `safe:<id>` 这样的**指针**；
系统钥匙串不可用时**拒绝落盘**，而不是退回明文。
