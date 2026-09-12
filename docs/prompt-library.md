# Prompt 库 / Prompt library

### [中文](#%E4%B8%AD%E6%96%87) | [English](#english)

---

<div lang="zh-CN">

## 中文

建筑风格需求模板。选一个模板贴进对话框，改掉方括号里的内容即可。

### 怎么写出好需求

四个要素：

| 要素 | 例子 | 缺了会怎样 |
|------|------|-----------|
| **尺寸与层数** | `12×12 双层，檐高 8 格` | 模型按默认 8×8 造，往往偏小 |
| **材质倾向** | `深色橡木 + 石砖 + 少量玻璃` | 得到一堆随机方块，风格不统一 |
| **必须有的特征物** | `正门朝南、二层带阳台、屋顶有烟囱` | 特征物被漏掉，或者位置不对 |
| **工区** | `工区 32×32×32` | 建筑可能被工区边界裁掉一角 |

再加一条**验收条件**，例如"门洞净高至少 2 格"。

### 住宅

#### 林间小屋 · 入门

```
造一座 9×9 的单层林间小屋，工区 24×24×24。
材质：云杉木板做墙，圆石做地基与壁炉，深色橡木做框架，玻璃板开窗。
必须有：正门朝南（门洞净高 2 格）、东西各一扇窗、斜坡屋顶、屋顶一个烟囱。
屋顶要比墙外扩 1 格做屋檐。
完成后用 verify 确认门洞净高，并拍两个角度的截图。
```

#### 双层住宅 · 带阳台

```
造一座 13×11 的双层住宅，工区 32×32×32。
一层：客厅 + 厨房，层高 4 格（地板到天花板）。
二层：两间卧室，层高 3 格。二层南面出一个 6×2 的阳台，木栏杆围一圈。
材质：白色混凝土 + 深色橡木立柱 + 石砖基座；屋顶用深色橡木阶梯做四坡顶。
必须有：南面正门、对称的两组窗、可上二层的楼梯（要真的能走上去，净高 ≥2）。
```

#### 中世纪排屋

```
造一排 3 户连排的中世纪房子，每户 7 格宽，总长 21 格，工区 40×32×32。
每户都有：自己的人字屋顶（高 5 格）、二层出一扇老虎窗、底楼一扇门 + 一扇窗。
三户之间错开 1 格的进深，屋顶高度依次差 1 格，避免看起来是一个盒子。
材质：石砖 + 云杉木板 + 白桦木框架；屋顶用深板岩砖。
```

### 公共建筑

#### 海边灯塔 · 收分塔身

```
设计一座海边灯塔，工区 32×40×32。
基座：八角形，高 2 格，直径 17 格。
塔身：从直径 11 格收分到 5 格，高 26 格，**用 fill_line 的 radius + taper 做收分**，不要一层层手画。
顶部：直径 7 格的玻璃灯室，高 3 格，上面一个深色锥顶。
必须有：南面一个门洞（净高 3 格）、塔身每隔 8 格一圈装饰线脚。
```

#### 石桥

```
造一座跨 24 格的石桥，工区 40×24×16。
桥面宽 5 格、厚 1 格；两侧各 2 个桥墩，从桥面直落到地面。
桥两侧做 1 格高的石砖护栏（要有立柱，每 4 格一根）。
材质：石砖 + 深板岩砖；桥墩底部用苔石砖做旧。
用 verify 的 supported 检查确认没有悬空方块。
```

#### 城墙与门楼

```
造一段 32 格长、高 7 格的城墙，中间留一个 5 格宽的门楼，工区 40×24×24。
城墙厚 2 格，顶部有城垛（每个垛口间隔 1 格）。
门楼比城墙高 3 格，两侧各一座方塔，塔顶是四坡顶。
必须留出可通行的门洞：净高 4 格、净宽 3 格。
```

### 结构与装饰

#### 对称的亭子（练 `symmetrize`）

```
造一座 11×11 的四角亭，工区 24×24×24。
先只造西半边（x < 5 的部分）：4 根圆石柱、木质台基、护栏。
然后用 symmetrize 沿 x=5 镜像出另外半边。
屋顶做四坡顶，中央用 fill_line 做一根宝顶。
完成后用 verify 的 symmetric 检查确认对称。
```

#### 重复的连廊（练 `copy_region` / `paste_region`）

```
造一条 3 开间的连廊，工区 40×24×24。
先造 1 个开间（7 格宽）：两根柱子 + 一个拱形门洞 + 顶上的横梁。
用 copy_region 复制这一个开间，然后 paste_region 沿 +X 贴两次，中间不留缝。
材质：砂岩 + 平滑砂岩 + 少量玻璃。
注意：粘贴出来的柱子朝向要一致，不能有的朝里有的朝外。
```

#### 上色与换材质（练 `replace_blocks`）

```
把现在这栋建筑里所有的 oak_planks 和 oak_log 换成 spruce_planks 与 spruce_log，
不要重建，用 replace_blocks 一次换掉。
然后给屋顶单独刷一层深板岩砖。
```

### 修问题

#### 体检并修复

```
先调用 analyze_structure 体检，把报出来的问题逐条修掉：
- floating（悬空）：给悬空的部分加柱子撑到地面
- doorway（开口不足）：把门洞开到净高 2 格以上
- headroom（净高不足）：把爬行空间抬高到 2 格
修完再跑一次 analyze_structure，确认 error 归零。
```

#### 状态修正

```
现在的栅栏没有连起来、楼梯的拐角方向也不对。
用 fix_states 跑一遍自动修正，然后用 slice 看一层平面图确认。
```

### 只改局部

模型看不见精确坐标，所以"把门往左挪一格"这类需求要先让它用 `slice` 看平面图：

```
先 slice(axis=y, index=1) 看一眼一层的平面图，确认门的坐标。
然后只把门往 +X 方向挪 1 格（原来那格填回墙），别动其他任何东西。
改完再 slice 一次，确认改动只有这两格。
```

### 模板之外的用法

- **先规划再动手**：`先只输出方案与分阶段计划，不要调用任何工具，等我确认。`
- **限定材质表**：在工程文件的 `project.json` 里填 `paletteAllowlist`，之后只能使用表内的方块。
- **要求自检**：`每完成一个阶段就 verify 一次并说明检查了什么`。
- **要历史版本**：`保存一份 .mcai，命名 "屋顶方案 A"`；导出时用
  `architect export x.mcai --to <rev>` 可以把任意历史版本单独导出来。

</div>

---

<div lang="en">

## English

Request templates by building type. Paste one into the chat box and change what is in
brackets.

### Writing a good request

Four elements:

| Element | Example | If it is missing |
|---------|---------|------------------|
| **Size and storeys** | `12x12, two storeys, eaves at 8` | the model builds its 8x8 default, usually too small |
| **Material preference** | `dark oak + stone bricks + a little glass` | a pile of random blocks with no consistent style |
| **Features it must have** | `door facing south, a balcony upstairs, a chimney` | features get dropped, or land in the wrong place |
| **Build area** | `build area 32x32x32` | the building can be clipped at the edge of the area |

Add an **acceptance condition** as well, for example "the doorway clears at least 2 blocks".

### Houses

#### Forest cabin · starter

```
Build a single-storey 9x9 forest cabin, build area 24x24x24.
Materials: spruce planks for the walls, cobblestone for the foundation and the fireplace, dark oak for the frame, glass panes for the windows.
Must have: a south-facing front door (2 blocks of clearance), one window each on the east and west sides, a pitched roof, and a chimney.
Overhang the roof by 1 block past the walls for eaves.
When it is done, use verify to confirm the doorway clearance and take screenshots from two angles.
```

#### Two-storey house · with a balcony

```
Build a two-storey 13x11 house, build area 32x32x32.
Ground floor: living room and kitchen, 4 blocks from floor to ceiling.
Upper floor: two bedrooms, 3 blocks high. Put a 6x2 balcony on its south side, enclosed by a wooden railing.
Materials: white concrete, dark oak posts and a stone brick base; a hipped dark oak stair roof.
Must have: a front door on the south side, two matching groups of windows, and a staircase to the upper floor that can actually be walked up (2 blocks of clearance).
```

#### Medieval terrace

```
Build a terrace of 3 medieval houses, each 7 blocks wide, 21 blocks in all, build area 40x32x32.
Each house has its own gable roof 5 blocks tall, a dormer on the upper floor, and a door plus a window on the ground floor.
Stagger the three by 1 block in depth and step the roof heights by 1 block, so they do not read as a single box.
Materials: stone bricks, spruce planks and birch framing; dark slate bricks for the roofs.
```

### Public buildings

#### Seaside lighthouse · tapering shaft

```
Design a seaside lighthouse, build area 32x40x32.
Base: octagonal, 2 blocks tall, 17 blocks across.
Shaft: taper from 11 blocks across to 5, 26 blocks tall — use fill_line with radius + taper rather than drawing each ring by hand.
Top: a glass lantern room 7 blocks across, 3 blocks tall, with a dark conical roof above it.
Must have: a doorway on the south side (3 blocks of clearance) and a decorative ring every 8 blocks up the shaft.
```

#### Stone bridge

```
Build a stone bridge spanning 24 blocks, build area 40x24x16.
The deck is 5 blocks wide and 1 block thick; two piers on each side running from the deck down to the ground.
Add a 1-block stone brick parapet on both sides, with a post every 4 blocks.
Materials: stone bricks and dark slate bricks; mossy stone bricks at the foot of each pier.
Use verify's supported check to confirm there are no floating blocks.
```

#### City wall and gatehouse

```
Build a wall 32 blocks long and 7 blocks tall with a 5-block-wide gatehouse in the middle, build area 40x24x24.
The wall is 2 blocks thick with battlements along the top, one gap every block.
The gatehouse stands 3 blocks above the wall, with a square tower on each side under a hipped roof.
Leave a passable opening: 4 blocks of clearance and 3 blocks wide.
```

### Structure and decoration

#### Symmetric pavilion (practises `symmetrize`)

```
Build an 11x11 pavilion with four corner posts, build area 24x24x24.
Build only the western half first (the part with x < 5): four cobblestone pillars, a wooden platform and railings.
Then mirror the other half across x=5 with symmetrize.
Give the roof a hipped shape and run a finial up the middle with fill_line.
When it is done, use verify's symmetric check to confirm the two halves match.
```

#### Repeating arcade (practises `copy_region` / `paste_region`)

```
Build a 3-bay arcade, build area 40x24x24.
Build one bay first (7 blocks wide): two posts, an arched opening and a beam across the top.
Copy that bay with copy_region, then paste_region it twice along +X with no gaps between them.
Materials: sandstone, smooth sandstone and a little glass.
Note: the pasted posts must all face the same way — none turned inward and none outward.
```

#### Recolour and swap materials (practises `replace_blocks`)

```
Replace every oak_planks and oak_log in the current building with spruce_planks and spruce_log.
Do not rebuild it — use replace_blocks to swap them in one call.
Then give the roof a layer of dark slate bricks on its own.
```

### Fixing problems

#### Check up and repair

```
Run analyze_structure first, then fix each problem it reports:
- floating: support the floating parts down to the ground with posts
- doorway: open the doorway to at least 2 blocks of clearance
- headroom: raise the crawl spaces to 2 blocks
When they are all fixed, run analyze_structure again and confirm the error count is zero.
```

#### Fixing block states

```
The fences are not connecting and the stairs turn the wrong way at the corners.
Run fix_states to repair them, then look at one layer with slice to confirm.
```

### Changing one part

The model cannot see exact coordinates, so a request like "move the door one block to the
left" has to begin with `slice`:

```
Run slice(axis=y, index=1) to look at the ground floor plan and confirm where the door is.
Then move only the door 1 block in the +X direction (filling the old cells back in with wall), and change nothing else.
Run slice again afterwards and confirm that only those two cells moved.
```

### Beyond the templates

- **Plan before building:** `Output a plan and a staged schedule only, without calling any tool, and wait for my confirmation.`
- **Restrict the palette:** put `paletteAllowlist` in the project file's `project.json`, and only those blocks can be used afterwards.
- **Ask for self-checking:** `Run verify at the end of every stage and say what it checked.`
- **Keep a version:** `Save a .mcai named "roof option A"`; to export any historical revision on its own, use `architect export x.mcai --to <rev>`.

</div>
