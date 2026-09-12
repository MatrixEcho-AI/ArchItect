# 参与开发

面向要改这个项目的人。只想用的话看根目录的 [`README.md`](../README.md)。

## 提交前检查

```bash
pnpm install
pnpm typecheck                   # 9 个项目一起过类型
pnpm test                        # 全量测试
pnpm docs:check && pnpm bake:check   # 两个「生成物有没有过期」的闸门
```

`pnpm test` 里已经含文档一致性与真实 HTTP 的端到端，但**类型检查不在里面**，所以上面几条都要跑。

## 工程结构

```
packages/
  core       体素内核 · 状态编解码 · 几何算子 · 世界存储 · 历史回放 · 朝向变换 · linter
  mcai       .mcai 容器 · 对话与截图存档 · 崩溃恢复 WAL
  render     软件光栅器 · 原版方块模型网格化 · 纹理图集 · 相机与叠加层 · 正交射线拾取 · PNG 编解码
  tools      29 个 LLM 工具 · JSON Schema 校验 · 文档生成
  interop    .schem / .litematic / .obj · 版本迁移
  agent      Agent 循环 · 完成闸门 · Provider 适配与能力发现
  i18n       中文优先的文案层（zh-CN 是基准表）
  cli        无头命令行
apps/
  desktop    Electron 桌面端（React 18 + antd 5，白色主题）
docs/        格式规范 · 工具参考（生成） · prompt 库
examples/    示例工程
```

约束：`packages/*` 全部不依赖 Electron、不依赖 DOM。

渲染进程里有一条硬边界：**三份视图（世界 / 对话 / 设置）由 React 持有，视口与相机在
React 之外**（`viewport-shell.ts`）。拖动的每个像素都不进 `useState`——WebGL 上下文只建
一次，高频的那一半留给按帧合流的命令式代码。文案一律走 `t()`（键是编译期校验的点分
路径），语言切换同时驱动 `@architect/i18n` 与 antd 的 `ConfigProvider`。

## 上下文策略：按 provider 分两套

Ollama 那类本地 provider **没有前缀缓存**，harness 会自动切到保守策略：只保留最近 6 轮、
最多 3 张截图，并在历史里留一句「前面 N 轮被裁掉了」。反过来，有前缀缓存的 provider
（DeepSeek）**一轮都不裁**——剪掉一张旧图省下的钱，比把它后面十万 token 的缓存打掉亏掉的
钱少三个数量级。判据在 `packages/agent/src/context.ts`，两套只在其中一套上跑。

## 常用命令

| 命令 | 作用 |
|------|------|
| `pnpm test` | 全部测试（含全量枚举、文档一致性、**真实 HTTP 的端到端**） |
| `pnpm typecheck` | 九个项目一起过类型 |
| `pnpm docs:gen` | 重新生成工具参考（过期时 `pnpm test` 会失败）。脚本名带 `:gen` 是有原因的：单独一个 `docs` 会被 pnpm 的内建命令抢走，变成打开包的文档页 |
| `ARCHITECT_UPDATE_GOLDEN=1 pnpm test packages/render/test/golden.test.ts` | 重新签软件光栅器的 golden 基线（改过渲染之后；**签之前先看一眼新图**） |
| `pnpm bake:gen` / `pnpm bake:check` | 从 `minecraft-assets` 烘出渲染元数据（方块状态表、模型表、方块→纹理反查表、纹理平均色 → `packages/render/data/<版本>/*.json`）；`--check` 在过期时失败 |
| `pnpm demo:v0` | 不需要 API key 的完整闭环演示 |
| `pnpm providers` | 探测模型端点：列模型、选模型、实测能力 |
| `npx vitest run packages/cli` | 起一个协议级假模型端点，用真 `architect build` 跑完整条链路（不需要 API key） |
| `pnpm bench` | 跑黄金任务出评分表（真模型，五个任务约 $0.19）。`--record <f.jsonl>` 录下全部模型交互，`--replay <f.jsonl>` 之后**完全不联网**重跑同一遍——实测每个数字逐项相同，耗时从 359 s 降到 1.7 s |
| `pnpm architect <命令>` | CLI：`info` / `ops` / `measure` / `slice` / `replay` / `shoot` / `build` / `export` / `import` |
| `pnpm desktop` | 打开桌面端 |
| `pnpm example` | 重新生成 `examples/forest-hut.mcai`（时间戳钉死，所以输出可复现） |
| `pnpm icon` | 重新生成应用图标（代码画的等轴测方块，1024×1024 PNG） |
| `pnpm --filter @architect/desktop package:dir` | 打一个不打签名、不做安装包的目录版（验打包用） |

## 生成物与一致性闸门

仓库里有三份**生成物**进了版本库，各自有闸门守着它不过期：

| 生成物 | 谁生成 | 谁守 |
|--------|--------|------|
| `docs/tool-reference.md` | `pnpm docs:gen`（从工具 JSON Schema） | `scripts/gen-docs.ts --check` + `pnpm test` |
| `packages/render/data/<版本>/*.json` | `pnpm bake:gen`（从 `minecraft-assets`） | `scripts/bake-render-data.ts --check` + `pnpm test` |
| `packages/render/test/golden/*.png` | `ARCHITECT_UPDATE_GOLDEN=1` 重签 | golden 测试逐字节比对 |

前两份是**整串相等**比对（生成侧恒用 `\n`），所以仓库里有一份 `.gitattributes` 把检出换行符钉成 LF——
没有它的话，Windows 上全新 clone 出来就必红，而且报的是「文档过期」这种误导人的话。

## 桌面端调试开关

都要先 `pnpm --filter @architect/desktop build`。它们可以**叠加**，比如 `--no-webgl --drag-test`
验的是「没有 WebGL 时拖动还能不能用」：

```bash
cd apps/desktop
npx --no-install electron . --demo --gui-smoke             # 全链路冒烟：GPU 截图 + 一串 DOM 断言（时间线拖得动、编辑记录点得开、WASD 真的移动了相机、拖动是原地转头）；任何一条不过就退 1
npx --no-install electron . --demo --capture /tmp/gui.png  # 抓用户看到的窗口
npx --no-install electron . --demo --shot /tmp/eye.png     # 抓**模型收到的那张图**
npx --no-install electron . --demo --no-webgl              # 强制走软件视口（验兜底路径）
npx --no-install electron . --demo --undo-test             # 合成两次撤销（停在历史版本上的样子）
npx --no-install electron . --demo --paint-test            # 合成一次「人手放一格」
```

> 上面 `/tmp/...` 是 Linux/macOS 的写法。Windows 上请写 `%TEMP%\gui.png`：
> `/tmp/gui.png` 会被解析成**当前盘符根目录**下的 `tmp\gui.png`（例如 `D:\tmp\gui.png`）。

`--capture` 与 `--shot` 不是一回事：`--capture` 是用户的视口，`--shot` 走 `ctx.shoot`，
尺寸、叠加层、用哪条渲染路径都和模型真实收到的一致。排查「模型为什么看错了」时先看 `--shot` 那张。

没有 WebGL 的机器上界面也能用：视口会退回主进程的软件光栅器（慢、无抗锯齿、
拖动降分辨率），并在对话面板上明说这件事。模型截图那条路不受影响——它本来就
优先走渲染进程的 WebGL，拿不到才退回软件光栅器。

## 打包

```bash
pnpm --filter @architect/desktop package          # dmg / nsis / AppImage
pnpm --filter @architect/desktop package:dir      # 只出 .app/.exe 目录，验打包用
pnpm icon                                         # 重新生成图标（apps/desktop/build/icon.png）
```

**三个平台的差别很大**（下面这些数字来自一台 arm64 Mac）：

| 目标 | 结果 | 产物 |
|------|------|------|
| macOS `dmg` + `zip` | ✅ 出来了 | `Architect-0.1.0-arm64.dmg`（136 MB）/ `-mac.zip`（132 MB） |
| Linux `dir`（可运行的目录版） | ✅ 出来了 | `release/linux-arm64-unpacked/`（796 MB 未压缩） |
| Linux `AppImage` | ⛔ 卡在工具链 | `mksquashfs: bad CPU type in executable` |
| Windows `nsis` / `zip` | ⛔ 卡在工具链 | `wine64: bad CPU type in executable` |

后两条**不是项目配置的问题**：electron-builder 给 macOS 下的 `mksquashfs` 与 `wine64` 都是
**x86_64** 二进制，而那台机器没装 Rosetta（`arch -x86_64 /usr/bin/true` 直接报 `Bad CPU type`）。
要出这两个包，任选一条：装 Rosetta；用 Docker 的 `electronuserland/builder` 镜像；换 x86_64 的机器或 CI。

图标是**代码画的**（`scripts/make-icon.ts`，用渲染包自己的 Canvas，等轴测方块 + 界面同色），
不往仓库里塞二进制：electron-builder 从这一张 1024×1024 PNG 自己转 icns/ico。

已验证：`--dir` 打出来的 `.app` 直接跑 `--smoke`（从世界、截图、崩溃恢复一路到导出/导入）都通过
——即被标成 external 的 `minecraft-data` / `minecraft-assets` / `prismarine-*` 在 asar 里都能 require 到。

**体积 748 MB**（原 837 MB）。包里最重的是 `minecraft-data`（427 MB）：它的 `data.js` 在
**加载期跨版本静态 `require`**（读 1.21.4 会去 require `1.21.1/enchantments.json`），所以
**按目录裁不安全**——试过一次，打包版启动即 `Cannot find module`。真正砍掉的是这些：

| 动作 | 省下 |
|------|------|
| `minecraft-assets` 只带 1.21.4 的方块贴图（其余版本的贴图目录约 280 MB 不进包；**所有版本的 `*.json` 都留着**，`index.js` 静态 require 它们） | ~300 MB |
| `three` 挪到 devDependencies（它已被 esbuild 打进渲染进程的 bundle，运行时不需要再躺一份） | ~13 MB |
| 自己的渲染元数据改成烘出来的 2.3 MB JSON（`pnpm bake:gen`），不再把资源包整个拖进主进程 | ~65 MB |
