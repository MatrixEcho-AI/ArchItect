<!-- 由 packages/tools/src/docs.ts 生成，请勿手工编辑。 -->
<!-- 重新生成：pnpm docs:gen -->

# 工具参考

> **本文件是生成的。** 唯一真相是工具自己的 JSON Schema（`packages/tools/src/tools/*.ts`），
> 改 schema 之后跑 `pnpm docs:gen` 重新生成；文档过期时 `pnpm test` 会失败。
>
> 参数表能说清"有哪些参数"，说不清"这个语义为什么这样设计"。后者在 `plan.md` 里：
> **附录 A**（`fill_line` 的半径/锥度语义）、**附录 C**（几何算子的坐标口径）、
> **附录 D**（变换与批处理语义）、**附录 E**（导出格式的坑）。
>
> 工具描述本身是写给 LLM 的 prompt，所以是**英文**；这份文档是写给人看的，所以是**中文**。

## 一览

| 工具 | 改世界 | 破坏性 | 一句话 |
|------|:------:|:------:|--------|
| [`run_batch`](#run_batch) | ✅ | ⚠️ | **Pack several edits into one atomic commit** — one revision, one confirmation, … |
| [`extrude`](#extrude) | ✅ | — | Extrude an XZ-plane polygon along +Y — **one of the most efficient tools**: draw… |
| [`fill_box`](#fill_box) | ✅ | ⚠️ | Fill an axis-aligned box. |
| [`fill_line`](#fill_line) | ✅ | — | **Bulk fill along a diagonal or any direction**: place blocks along the 3D line … |
| [`fill_plane`](#fill_plane) | ✅ | — | Fill an **arbitrary plane** defined by three points — sloped roofs, braces, non-… |
| [`symmetrize`](#symmetrize) | ✅ | ⚠️ | Mirror across a plane: copy the source half **verbatim** onto the other half (pr… |
| [`copy_region`](#copy_region) | — | — | Copy a box into the session clipboard. |
| [`paste_region`](#paste_region) | ✅ | — | Paste the clipboard so its **minimum corner** lands on `at`. |
| [`replace_blocks`](#replace_blocks) | ✅ | — | **Material swap**: inside the box, replace every cell whose block is one of `blo… |
| [`fix_states`](#fix_states) | ✅ | — | Repair block states that are locally inconsistent with their neighbours: fence /… |
| [`erase`](#erase) | ✅ | ⚠️ | Delete blocks inside a box (equivalent to fill_box + mode=destroy, but more dire… |
| [`place_block`](#place_block) | ✅ | — | Place a **single** block. |
| [`place_entity`](#place_entity) | ✅ | — | Place one or more **entities** (boats, minecarts, armour stands, item frames…) i… |
| [`edit_block_entity`](#edit_block_entity) | ✅ | — | Write the block entity data on one cell — sign text, banner patterns, container … |
| [`remove_entity`](#remove_entity) | ✅ | ⚠️ | Remove entities, either by the ids that place_entity / list_entities gave you, o… |
| [`slice`](#slice) | — | — | Render one slice as an **ASCII plan view** (with coordinate rulers and a legend)… |
| [`measure`](#measure) | — | — | World size and material histogram: bounding box, width/height/depth, total non-a… |
| [`verify`](#verify) | — | — | **Structured self-check**: submit a set of "expectations"; the engine judges eac… |
| [`get_block`](#get_block) | — | — | Read the block at a single cell (returns the full state string, e.g. |
| [`get_region`](#get_region) | — | — | Render a region layer by layer as ASCII (equivalent to calling slice per layer a… |
| [`search_blocks`](#search_blocks) | — | — | Search available blocks by name substring (e.g. |
| [`list_entities`](#list_entities) | — | — | List the entities in the world (or in a box), with their ids, types, positions a… |
| [`get_block_entity`](#get_block_entity) | — | — | Read the block entity data hanging on one cell — sign text, banner patterns, con… |
| [`analyze_structure`](#analyze_structure) | — | — | Building linter (read-only, does not change the world). |
| [`screenshot`](#screenshot) | — | — | Render a screenshot for you to look at. |
| [`set_camera`](#set_camera) | — | — | Position the camera explicitly and KEEP it for every later screenshot. |
| [`update_notes`](#update_notes) | — | — | Write down your design plan so it survives context trimming. |
| [`undo`](#undo) | ✅ | — | Move the version cursor back one step and replay, undoing the last edit. |
| [`redo`](#redo) | ✅ | — | Move the version cursor forward one step and replay, reapplying an edit you undi… |

## 批量编辑

一次调用改很多格——**这类工具是主力**，逐格摆放是最后手段。

## `extrude`

```
Extrude an XZ-plane polygon along +Y — **one of the most efficient tools**: draw one floor plan and grow it directly into a building.
Vertices are block coordinates, and the covered range includes the boundary (the rectangle (0,0)-(4,4) covers 5×5 cells).
hollow=true extrudes only the outline (walls); combined with capBottom (floor) / capTop (roof) you get a house "with floor, walls and roof".
```

| 参数 | 类型 | 必填 | 取值 / 范围 | 默认 | 说明 |
|------|------|:----:|-------------|------|------|
| `points` | 数组<数组<整数>> | ✅ | ≥ 3 项 | — | Polygon vertices, closed in order, at least 3. Each item is [x,z]. |
| `baseY` | 整数 | ✅ | — | — | Y of the base plane. |
| `height` | 整数 | ✅ | ≥ 1 | — | Extrusion height (cells). |
| `block` | 字符串 | ✅ | — | — | Block reference (or material pattern). |
| `hollow` | 布尔 | — | — | — | Extrude only the outline (walls), leaving the inside empty. |
| `capTop` | 布尔 | — | — | — | Whether to cap the top when hollow (roof). Default true. |
| `capBottom` | 布尔 | — | — | — | Whether to cap the bottom when hollow (floor). Default true. |
| `confirm` | 布尔 | — | — | — | Explicitly confirm an operation that exceeds the threshold. Decide after reading the dry-run preview. |

## `fill_line`

```
**Bulk fill along a diagonal or any direction**: place blocks along the 3D line from→to. Use it for columns, beams, braces and spires; do not fill cell by cell in a loop.
radius is the "upper bound on the distance from a block center to the axis", so an integer R gives a column exactly 2R+1 cells thick (R=1→3 cells, R=3→7 cells). The ends are spherical caps, not flat.
taper=[start,end] varies the radius linearly along the line, for tapered spires or tree-trunk taper. step>1 samples sparsely along the line (scaffolding, fence posts).
hollow=true keeps only a one-cell shell.
```

| 参数 | 类型 | 必填 | 取值 / 范围 | 默认 | 说明 |
|------|------|:----:|-------------|------|------|
| `from` | 数组<整数> | ✅ | 3..3 项 | — | start coordinate [x,y,z] |
| `to` | 数组<整数> | ✅ | 3..3 项 | — | end coordinate [x,y,z] |
| `block` | 字符串 | ✅ | — | — | Block reference. |
| `radius` | 数字 | — | ≥ 0 | — | Radius. 0 (default) is a one-cell-thick line. An integer R gives 2R+1 cells thick. |
| `taper` | 数组<数字> | — | 2..2 项 | — | Start and end radius along the line [start,end], for a taper. Overrides radius. |
| `step` | 整数 | — | ≥ 1 | — | Sample every step cells along the line; 1 (default) is continuous. |
| `hollow` | 布尔 | — | — | — | Keep only a one-cell shell (only effective when radius > 0). |
| `mode` | 枚举 | — | `replace` / `keep` / `overlay` | — | Write mode. replace = unconditional overwrite; keep = only write where there is air; overlay = only overwrite non-air (recolor an existing structure). |
| `confirm` | 布尔 | — | — | — | Explicitly confirm an operation that exceeds the threshold. Decide after reading the dry-run preview. |

## `fill_plane`

```
Fill an **arbitrary plane** defined by three points — sloped roofs, braces, non-axis-aligned walls.
The plane passes through the cell centers of the three points; by default it **fills the whole plane inside the bounding box of the three points** (which is what you want for a roof); pass triangle: true to fill only that triangle.
Three collinear points raise an error.
```

| 参数 | 类型 | 必填 | 取值 / 范围 | 默认 | 说明 |
|------|------|:----:|-------------|------|------|
| `p1` | 数组<整数> | ✅ | 3..3 项 | — | first point [x,y,z] |
| `p2` | 数组<整数> | ✅ | 3..3 项 | — | second point [x,y,z] |
| `p3` | 数组<整数> | ✅ | 3..3 项 | — | third point [x,y,z] |
| `block` | 字符串 | ✅ | — | — | Block reference. |
| `thickness` | 数字 | — | ≥ 1 | — | Thickness (cells), default 1 (exactly one layer). |
| `triangle` | 布尔 | — | — | — | Fill only the triangle formed by the three points instead of the whole bounding-box plane. Default false. |
| `confirm` | 布尔 | — | — | — | Explicitly confirm an operation that exceeds the threshold. Decide after reading the dry-run preview. |

## `paste_region`

```
Paste the clipboard so its **minimum corner** lands on `at`.
**Facing is remapped**: rotate 90 turns an east-facing stair into a south-facing one, a mirror swaps door hinges, sign rotation moves to the mirrored value.
rotate is applied **after** mirror. rotate 90/270 swaps the footprint: a 4x6 copy pasted with rotate=90 occupies 6x4.
```

| 参数 | 类型 | 必填 | 取值 / 范围 | 默认 | 说明 |
|------|------|:----:|-------------|------|------|
| `at` | 数组<整数> | ✅ | 3..3 项 | — | Where the minimum corner of the pasted copy goes [x,y,z]. |
| `rotate` | 枚举 | — | `0` / `90` / `180` / `270` | — | Rotation about +Y in degrees: 0 (default) / 90 / 180 / 270. 90 is clockwise seen from above. |
| `mirror` | 枚举 | — | `x` / `y` / `z` | — | Mirror the clipboard before rotating. x flips along X (east<->west), z along Z (north<->south), y flips vertically (up<->down). |
| `mode` | 枚举 | — | `replace` / `keep` / `overlay` | — | replace (default, overwrite) / keep (only into air, to graft onto existing structure) / overlay (only onto non-air, to recolor). |
| `confirm` | 布尔 | — | — | — | Explicitly confirm an operation above the confirmation threshold. Review the dry-run preview first. |

## `replace_blocks`

```
**Material swap**: inside the box, replace every cell whose block is one of `blocks` with `with`.
Use it to recolor a finished shape (e.g. swap all oak_planks and oak_log for spruce) instead of rebuilding it. Only the block **name** is matched — properties like stair facing are ignored on purpose, so a whole staircase recolors in one call.
Reads the world, so it cannot be nested inside run_batch.
```

| 参数 | 类型 | 必填 | 取值 / 范围 | 默认 | 说明 |
|------|------|:----:|-------------|------|------|
| `from` | 数组<整数> | ✅ | 3..3 项 | — | One corner of the box [x,y,z]. |
| `to` | 数组<整数> | ✅ | 3..3 项 | — | The opposite corner [x,y,z]. Inclusive. |
| `blocks` | 数组<字符串> | ✅ | ≥ 1 项 | — | Block names to replace. Matching ignores properties, so "minecraft:oak_stairs" catches every facing. |
| `with` | 字符串 | ✅ | — | — | The block to write in their place. |
| `confirm` | 布尔 | — | — | — | Explicitly confirm an operation above the confirmation threshold. Review the dry-run preview first. |

## `fix_states`

```
Repair block states that are locally inconsistent with their neighbours: fence / wall / glass-pane / iron-bars connection booleans (north, south, east, west), the wall post (up), and stair shape (straight / inner_* / outer_*). waterlogged is never touched.
Run it after symmetrize, paste_region, rotate or any bulk fill that placed connection blocks with their default side values.
Only cells that are actually inconsistent are rewritten, and the whole pass commits as exactly ONE revision, so a single undo removes it entirely. It is idempotent: running it a second time changes nothing.
from and to optionally restrict the repair to a box (both must be given together); omit both to repair the whole world. The result reports how many cells each rule fixed. Half-slabs or stairs that are completely enclosed by solid blocks are reported but NOT modified.
```

| 参数 | 类型 | 必填 | 取值 / 范围 | 默认 | 说明 |
|------|------|:----:|-------------|------|------|
| `from` | 数组<整数> | — | 3..3 项 | — | Optional first corner [x,y,z] of the box to repair. Give it together with to, or omit both. |
| `to` | 数组<整数> | — | 3..3 项 | — | Optional opposite corner [x,y,z] of the box to repair. Give it together with from, or omit both. |
| `confirm` | 布尔 | — | — | — | Explicitly confirm a repair that exceeds the confirm threshold. Decide after reading the dry-run preview. |

## `place_block`

```
Place a **single** block. Use it only when you really need to change one cell (e.g. patch a gap) — for bulk work use fill_box / fill_line / extrude.
```

| 参数 | 类型 | 必填 | 取值 / 范围 | 默认 | 说明 |
|------|------|:----:|-------------|------|------|
| `pos` | 数组<整数> | ✅ | 3..3 项 | — | block coordinate [x,y,z] |
| `block` | 字符串 | ✅ | — | — | Block reference. |

## `place_entity`

```
Place one or more **entities** (boats, minecarts, armour stands, item frames…) into the world.
This is the only tool that creates entities. It does not touch blocks, so an entity can sit in the same cell as whatever you already built.
Positions are **integer cells**; `offset` moves within the cell in 1/16ths and defaults to the cell centre sitting on the floor.
**One call = one revision = one undo step**, so place a whole row of eight boats in a single call instead of eight calls.
The result lists the ids it assigned — keep them if you want to move or remove those entities later.
Entities are **not** shown in `measure`; use `list_entities` to see them and `verify` with an entity_at claim to read them back.
```

| 参数 | 类型 | 必填 | 取值 / 范围 | 默认 | 说明 |
|------|------|:----:|-------------|------|------|
| `entities` | 对象数组 | ✅ | 1..256 项 | — | The entities to place. A row of eight boats is eight entries **in one call**. |

`entities[]` 的每一项：

| 字段 | 类型 | 必填 | 说明 |
|------|------|:----:|------|
| `type` | 字符串 | ✅ | Entity type, e.g. "minecraft:oak_boat" — **not** a block name. Unknown types come back with suggestions; entities are counted separately from blocks. |
| `at` | 数组<整数> | ✅ | The cell to place it in. |
| `offset` | 数组<整数> | — | Offset within the cell in 1/16ths, each 0..15. Default [8,0,8] = centred, on the floor. Raise y to hang something (an item frame is usually at y=8). |
| `facing` | 枚举 | — | Cardinal facing; ignored when yaw is given. north = -Z, south = +Z, east = +X, west = -X. |
| `yaw` | 整数 | — | Facing as a 0..15 step of 22.5°: 0 = south (+Z), 4 = west, 8 = north, 12 = east. Overrides facing. |
| `pitch` | 数字 | — | Pitch in degrees. |
| `data` | 对象 | — | Extra payload for this entity type (armour stand pose, item frame contents, custom name…). Stored verbatim and written out to .schem / .litematic, so it must be NBT-representable: no null, no mixed-type arrays. |

## `edit_block_entity`

```
Write the block entity data on one cell — sign text, banner patterns, container contents, skull owner…
The cell must already hold a block that carries a block entity (a chest, a sign, a banner…); putting one on stone is rejected rather than stored, because the game would drop it and the file would look fine.
The kind is derived from the block, so you never write it — putting sign text on a chest is not something you can express.
The payload is stored verbatim and later written to .schem / .litematic, so it must be NBT-representable (no null, no mixed-type arrays).
```

| 参数 | 类型 | 必填 | 取值 / 范围 | 默认 | 说明 |
|------|------|:----:|-------------|------|------|
| `at` | 数组<整数> | ✅ | 3..3 项 | — | The cell (integer block coordinates). |
| `data` | 对象 | ✅ | — | — | The payload to store. Replaces the existing payload unless merge is true. |
| `merge` | 布尔 | — | — | — | Merge into the existing payload instead of replacing it. Default false. |

## 破坏性编辑

会删掉已有内容，触发确认阈值时需要先解释清楚再带 `confirm: true` 重发。

## `run_batch`

```
**Pack several edits into one atomic commit** — one revision, one confirmation, one screenshot. This is the main lever on round trips: prefer one run_batch of 5 edits over 5 separate calls.
Ops run **in order** and later ops win on overlapping cells. If any op is invalid the whole batch is aborted and **nothing is written**.
Allowed op tools: fill_box, fill_line, fill_plane, extrude, place_block, erase, paste_region. symmetrize / replace_blocks / fix_states / copy_region read wide swathes of the world and must be called on their own.
`mode: keep` / `overlay` inside a batch are evaluated against the world before the batch plus what earlier ops in the same batch decided.
```

| 参数 | 类型 | 必填 | 取值 / 范围 | 默认 | 说明 |
|------|------|:----:|-------------|------|------|
| `ops` | 对象数组 | ✅ | 1..64 项 | — | Operations in execution order. Each item is {tool, args} where tool is one of the allowed names and args is that tool's own argument object. |
| `confirm` | 布尔 | — | — | — | Explicitly confirm an operation above the confirmation threshold. The dry-run preview covers **all** ops combined, so you only need to confirm once. |

`ops[]` 的每一项：

| 字段 | 类型 | 必填 | 说明 |
|------|------|:----:|------|
| `tool` | 枚举 | ✅ | Which tool to run. |
| `args` | 对象 | ✅ | That tool's arguments, exactly as if you had called it directly (omit confirm). |

## `fill_box`

```
Fill an axis-aligned box. This is the most-used bulk tool: one call can change thousands of cells — do not place blocks one by one with place_block.
mode: replace (default, unconditional overwrite) / keep (only write where there is air, without destroying existing content) / overlay (only overwrite non-air, recolor a structure)/ hollow (keep only the shell, hollow out the inside) / outline (keep only the 12 edges) / destroy (delete, ignores the block argument).
from and to are two corners of a closed interval, in any order. The world has no writable boundary, so any X/Z is accepted; only world height (Y) is clipped, and clipping is reported faithfully.
```

| 参数 | 类型 | 必填 | 取值 / 范围 | 默认 | 说明 |
|------|------|:----:|-------------|------|------|
| `from` | 数组<整数> | ✅ | 3..3 项 | — | start coordinate [x,y,z] |
| `to` | 数组<整数> | ✅ | 3..3 项 | — | end coordinate [x,y,z] |
| `block` | 字符串 | ✅ | — | — | block, e.g. "minecraft:stone" or "oak_stairs[facing=east]". Ignored when mode=destroy. |
| `mode` | 枚举 | — | `replace` / `keep` / `overlay` / `hollow` / `outline` / `destroy` | `"replace"` | Write mode and shape, see the tool description. |
| `confirm` | 布尔 | — | — | — | Explicitly confirm an operation that exceeds the threshold. Decide after reading the dry-run preview. |

## `symmetrize`

```
Mirror across a plane: copy the source half **verbatim** onto the other half (preserving stair facing and material distribution). Build only half of a symmetric building, then call this.
The mirror plane passes through the **center** of the coordinate cell, so coordinate-1 maps to coordinate+1 and the coordinate cell maps to itself.
clear=false means "fill gaps only", without overwriting what already exists on the target side.
Block facing **is remapped**: an east-facing stair becomes west-facing, door hinges swap sides, and sign rotation lands on the mirrored value. (A few orientations have no mirror-image encoding in 1.21.4 — walls have no `down` counterpart, and jigsaw `orientation` only declares 12 of 24 combinations. Those cells keep their original facing rather than being guessed.)
```

| 参数 | 类型 | 必填 | 取值 / 范围 | 默认 | 说明 |
|------|------|:----:|-------------|------|------|
| `axis` | 枚举 | ✅ | `x` / `y` / `z` | — | Which axis the mirror plane is perpendicular to. |
| `coordinate` | 整数 | ✅ | — | — | Coordinate of the mirror plane. |
| `source` | 枚举 | ✅ | `negative` / `positive` | — | Which side is the source. negative = the side with coordinates less than coordinate. |
| `clear` | 布尔 | — | — | — | Clear the target side before mirroring. Default true; false fills gaps only. |
| `confirm` | 布尔 | — | — | — | Explicitly confirm an operation that exceeds the threshold. Decide after reading the dry-run preview. |

## `erase`

```
Delete blocks inside a box (equivalent to fill_box + mode=destroy, but more direct).
```

| 参数 | 类型 | 必填 | 取值 / 范围 | 默认 | 说明 |
|------|------|:----:|-------------|------|------|
| `from` | 数组<整数> | ✅ | 3..3 项 | — | start [x,y,z] |
| `to` | 数组<整数> | ✅ | 3..3 项 | — | end [x,y,z] |
| `confirm` | 布尔 | — | — | — | Explicitly confirm an operation that exceeds the threshold. Decide after reading the dry-run preview. |

## `remove_entity`

```
Remove entities, either by the ids that place_entity / list_entities gave you, or everywhere inside a box.
This never touches blocks — removing the water under a boat is `erase`, removing the boat is this.
Prefer a single call with several ids over several calls: one call is one revision and one undo step.
```

| 参数 | 类型 | 必填 | 取值 / 范围 | 默认 | 说明 |
|------|------|:----:|-------------|------|------|
| `ids` | 数组<字符串> | — | — | — | Entity ids to remove (as returned by place_entity or list_entities). |
| `region` | 对象 | — | — | — | A closed box in world coordinates. |

## 检视（只读，不产生 revision）

读回与定位。**精确改格子必须靠 `slice` 的 ASCII 图，不能靠数截图里的像素。**

## `copy_region`

```
Copy a box into the session clipboard. **Read-only** — it neither changes the world nor the revision.
Only non-air cells are stored and facing is preserved exactly; paste_region remaps facing when you rotate or mirror.
Copy once, paste many times: this is how you build repeated wings, towers and arches.
```

| 参数 | 类型 | 必填 | 取值 / 范围 | 默认 | 说明 |
|------|------|:----:|-------------|------|------|
| `from` | 数组<整数> | ✅ | 3..3 项 | — | One corner of the box [x,y,z]. |
| `to` | 数组<整数> | ✅ | 3..3 项 | — | The opposite corner [x,y,z]. Inclusive. |
| `only` | 数组<字符串> | — | — | — | Copy only these block names (e.g. ["minecraft:oak_planks"]). Omit to copy everything non-air. |

## `slice`

```
Render one slice as an **ASCII plan view** (with coordinate rulers and a legend) — **this is your main tool for precise editing**.
Use it to confirm "is this cell the block I think it is"; do not guess coordinates from a screenshot (one cell is only a few pixels there).
axis=y is a top-down plan (columns are x, rows are z); axis=x / axis=z are elevations (rows are y, top to bottom).
Limiting the range with the x/y/z arguments can compress the output to a few dozen lines. If the range is too large it errors and tells you how far to shrink it.
```

| 参数 | 类型 | 必填 | 取值 / 范围 | 默认 | 说明 |
|------|------|:----:|-------------|------|------|
| `axis` | 枚举 | ✅ | `x` / `y` / `z` | — | Which axis the slice is perpendicular to. |
| `index` | 整数 | ✅ | — | — | Coordinate of the slice. |
| `x` | 数组<整数> | — | 2..2 项 | — | Render only this closed interval of x [start,end]. |
| `y` | 数组<整数> | — | 2..2 项 | — | Render only this closed interval of y [start,end]. |
| `z` | 数组<整数> | — | 2..2 项 | — | Render only this closed interval of z [start,end]. |
| `maxCells` | 整数 | — | ≥ 16 | — | Cell limit, default 4096. |

## `measure`

```
World size and material histogram: bounding box, width/height/depth, total non-air blocks, and the count and share of each block type.
**Use it to confirm scale before you start** ("how long is this wall really"), and before claiming completion to check the size against the requirement.
```

**无参数。**

## `verify`

```
**Structured self-check**: submit a set of "expectations"; the engine judges each one pass/fail and reports the actual value.
After any modification call it to read back the result before claiming completion — **it is forbidden to say "done" without reading back**.
Before calling it you must write down your expectations in claims; if you cannot, you have not thought through what you are doing.
Available checks: block_at (a cell is a given block — write properties in brackets to also constrain them, e.g. `minecraft:oak_stairs[facing=west]`; properties you omit are not constrained) / air_at (a cell is air) / count (the count of a block is within a range)/ supported (no floating blocks in a region — floating means the whole column below is empty down to the reference region floor AND nothing sits directly above; a ceiling on a wall or a hanging lantern is fine) / symmetric (symmetric across a plane) / entity_at (an entity of a given type is in a cell — **use this after place_entity**) / entity_count (how many entities of a type are in a region; give min and/or max) / block_entity_at (a cell carries block entity data, optionally of a given kind).
```

| 参数 | 类型 | 必填 | 取值 / 范围 | 默认 | 说明 |
|------|------|:----:|-------------|------|------|
| `claims` | 对象数组 | ✅ | ≥ 1 项 | — | List of expectations. Each item looks like {check:"block_at", pos:[x,y,z], expect:"minecraft:air"}. |

`claims[]` 的每一项：

| 字段 | 类型 | 必填 | 说明 |
|------|------|:----:|------|
| `check` | 枚举 | ✅ | Check type. |
| `pos` | 数组<整数> | — | Coordinate used by block_at / air_at. |
| `expect` | 字符串 | — | Expected block for block_at. With no brackets only the block name is compared. With brackets, **every property you write must match** and properties you omit are ignored — so `minecraft:oak_stairs[facing=west]` checks the facing without pinning half/shape. |
| `block` | 字符串 | — | Block name used by count. |
| `type` | 字符串 | — | Entity type used by entity_at (what entity_at expects) and entity_count (what it counts), e.g. "minecraft:oak_boat". **Not** a block name — entities are a separate layer from blocks. |
| `from` | 数组<整数> | — | Region start for count / supported / symmetric. |
| `to` | 数组<整数> | — | Region end for count / supported / symmetric. |
| `min` | 整数 | — | Lower bound for count. |
| `max` | 整数 | — | Upper bound for count. |
| `axis` | 枚举 | — | Symmetry axis for symmetric. |
| `coordinate` | 整数 | — | Mirror coordinate for symmetric. |

## `get_block`

```
Read the block at a single cell (returns the full state string, e.g. minecraft:oak_stairs[facing=east,...]).
```

| 参数 | 类型 | 必填 | 取值 / 范围 | 默认 | 说明 |
|------|------|:----:|-------------|------|------|
| `pos` | 数组<整数> | ✅ | 3..3 项 | — | block coordinate [x,y,z] |

## `get_region`

```
Render a region layer by layer as ASCII (equivalent to calling slice per layer and concatenating). Use it only for small regions — with many layers the output gets long; usually calling slice for a single layer is better.
```

| 参数 | 类型 | 必填 | 取值 / 范围 | 默认 | 说明 |
|------|------|:----:|-------------|------|------|
| `from` | 数组<整数> | ✅ | 3..3 项 | — | start [x,y,z] |
| `to` | 数组<整数> | ✅ | 3..3 项 | — | end [x,y,z] |
| `axis` | 枚举 | — | `x` / `y` / `z` | — | Which axis to slice along, default y. |
| `maxCells` | 整数 | — | ≥ 16 | — | Cell limit per layer, default 1024. |

## `search_blocks`

```
Search available blocks by name substring (e.g. "stairs", "planks", "oak"). Use it when unsure how a block name is spelled.
```

| 参数 | 类型 | 必填 | 取值 / 范围 | 默认 | 说明 |
|------|------|:----:|-------------|------|------|
| `query` | 字符串 | ✅ | — | — | Search substring, case-insensitive. |
| `limit` | 整数 | — | ≥ 1 | — | Maximum number to return, default 20. |

## `list_entities`

```
List the entities in the world (or in a box), with their ids, types, positions and facing.
Use it to get the ids before remove_entity, and to check what is already there before adding more.
This is a plain listing, **not** a verification — read back with `verify` (entity_at / entity_count) before claiming you are done.
```

| 参数 | 类型 | 必填 | 取值 / 范围 | 默认 | 说明 |
|------|------|:----:|-------------|------|------|
| `region` | 对象 | — | — | — | A closed box in world coordinates. |
| `type` | 字符串 | — | — | — | Only list this entity type, e.g. "minecraft:oak_boat". |
| `limit` | 整数 | — | 1..512 | — | Maximum number of entities to list, default 64. |

## `get_block_entity`

```
Read the block entity data hanging on one cell — sign text, banner patterns, container contents, skull owner…
Returns the kind and the stored payload, or says there is none. Block entities only exist on blocks that carry them (a chest, a sign, a banner…); putting one on stone is rejected rather than stored.
```

| 参数 | 类型 | 必填 | 取值 / 范围 | 默认 | 说明 |
|------|------|:----:|-------------|------|------|
| `at` | 数组<整数> | ✅ | 3..3 项 | — | The cell (integer block coordinates). |

## `analyze_structure`

```
Building linter (read-only, does not change the world). Runs seven structural checks over the whole build or an optional region, and returns a score plus one entry per problem:
1. floating (error): a block with nothing supporting it anywhere below in its own column; blocks with no collision shape (torches, flowers, signs) are ignored because they are legitimately airborne.
2. cantilever (warn): a block whose nearest support one level below is more than maxOverhang blocks away horizontally.
3. doorway (warn): an opening at floor level in a wall that is less than minDoorClearance blocks high (it may be an intended window, so this is a warning, not an error), or a *_door lower half with no matching upper half above it (an incomplete door). A normal door with wall above it is correct and NOT reported.
4. headroom (warn): a walkable cell with less than minHeadroom blocks of clearance to the ceiling above.
5. leaky (warn): interior air that connects to the outside across the content bounding box (intended doors and windows count as connections).
6. palette (info): how many distinct block types are used, and which types appear in fewer than 3 cells.
7. symmetry (info): how well the build mirrors across a plane (score 0..1).
Severity matters: only `floating` is an error, and errors are what block completion — warnings and info are advice. A passing analyze_structure (no errors) satisfies the completion gate. score is 0..100 and is 100 when there are no errors and no warnings. Sample coordinates are capped at 8 per finding, so the output stays cheap. Run it at the end of a build stage, and always before claiming the build is complete.
```

| 参数 | 类型 | 必填 | 取值 / 范围 | 默认 | 说明 |
|------|------|:----:|-------------|------|------|
| `from` | 数组<整数> | — | 3..3 项 | — | First corner [x,y,z] of the region to analyze. Omit to analyze all content. |
| `to` | 数组<整数> | — | 3..3 项 | — | Second corner [x,y,z] of the region to analyze. Must be given together with from. |
| `maxOverhang` | 整数 | — | ≥ 0 | — | How many blocks of horizontal offset still count as supported, default 4. |
| `minDoorClearance` | 整数 | — | ≥ 1 | — | Minimum walkable opening height in blocks, default 2. |
| `minHeadroom` | 整数 | — | ≥ 1 | — | Minimum head clearance for a walkable cell in blocks, default 2. |
| `symmetryAxis` | 枚举 | — | `x` / `y` / `z` | — | Axis of the mirror plane to test, default x. When omitted, the centre planes on x, y and z are all tested and the best-scoring one is reported as the dominant plane. |
| `symmetryCoordinate` | 数字 | — | — | — | Coordinate of the mirror plane (may sit between cells, e.g. 2.5). Default: centre of the analyzed region. |

## `screenshot`

```
Render a screenshot for you to look at. **Use it only to judge appearance** (proportions, massing, style, symmetry), not to read coordinates —
the image the model sees is downscaled to about 800×800, one block cell is only a few pixels wide, and counting cells will always be wrong.
Use slice when you need precise positioning.
One shot per modification is enough; repeating the same camera hits the cache and costs nothing extra.
The result carries a revision — **check it against the current version; if they differ the image is stale and your judgement is void**.
```

| 参数 | 类型 | 必填 | 取值 / 范围 | 默认 | 说明 |
|------|------|:----:|-------------|------|------|
| `view` | 枚举 | — | `iso_ne` / `iso_nw` / `iso_se` / `iso_sw` / `front` / `back` / `left` / `right` / `top` | `"iso_ne"` | Named camera preset. iso_* are the four isometric corners, the rest are orthographic elevations/top. Default iso_ne. Ignored when azimuth/elevation are given (it then only labels the shot). |
| `azimuth` | 数字 | — | -360..720 | — | Free camera: horizontal angle in degrees (0 = looking from +Z toward -Z, increasing counter-clockwise seen from above). Use it when the 9 presets do not give you the direction you need to judge (e.g. an overhang seen from the side). The model is built around the content, so you do not need to compute coordinates. |
| `elevation` | 数字 | — | -180..180 | — | Free camera: elevation angle in degrees. 1 = almost level with the horizon, 89 = almost straight down. Clamped to 1..89 (at exactly 90 the view collapses). |
| `scale` | 数字 | — | 0.2..80 | — | Pixels per block. Omit to auto-frame the content. Set it larger for a close-up of a detail (pair it with target), smaller to see the whole site. |
| `target` | 数组<整数> | — | 3..3 项 | — | Look-at point in world coordinates [x, y, z]. Omit to look at the centre of the content. Use it with a large scale to inspect one detail closely. |
| `eye` | 数组<整数> | — | 3..3 项 | — | Camera position in world coordinates. Give it together with lookAt to aim the camera at a specific point instead of using an orbit angle. NOTE: the projection is orthographic, so the DISTANCE between eye and lookAt does not change the image size — only the direction matters. Use scale to zoom. |
| `lookAt` | 数组<整数> | — | 3..3 项 | — | Point the camera looks at; also becomes the centre of the image. |
| `roll` | 数字 | — | -180..180 | — | Roll around the view axis in degrees. 0 keeps the horizon level (the usual choice). Default 0. |
| `width` | 整数 | — | 64..4096 | — | Image width, default 1024. |
| `height` | 整数 | — | 64..4096 | — | Image height, default 768. |
| `highlightLast` | 布尔 | — | — | — | Highlight the affected range of the last edit, to confirm "what I just changed". Default true. |
| `plain` | 布尔 | — | — | — | Use the deterministic fallback palette (does not read a resource pack). Usually unnecessary. |

## `set_camera`

```
Position the camera explicitly and KEEP it for every later screenshot.
Give eye + lookAt to aim the camera at a point, or azimuth + elevation for an orbit angle.
The projection is ORTHOGRAPHIC: the distance between eye and lookAt does NOT change the image size, only the direction does — use scale to zoom.
This does not render anything. It only sets the camera; call screenshot afterwards to look.
reset:true clears it and goes back to the default preset.
```

| 参数 | 类型 | 必填 | 取值 / 范围 | 默认 | 说明 |
|------|------|:----:|-------------|------|------|
| `eye` | 数组<整数> | — | 3..3 项 | — | Camera position in world coordinates [x, y, z]. Needs lookAt to define a direction. Distance to lookAt is ignored by the orthographic projection. |
| `lookAt` | 数组<整数> | — | 3..3 项 | — | Point the camera looks at. Also becomes the centre of the image. |
| `azimuth` | 数字 | — | -360..720 | — | Orbit alternative to eye/lookAt: horizontal angle in degrees. |
| `elevation` | 数字 | — | -180..180 | — | Orbit alternative to eye/lookAt: elevation angle in degrees, clamped to 1..89. |
| `roll` | 数字 | — | -180..180 | — | Roll around the view axis in degrees. 0 keeps the horizon level. |
| `scale` | 数字 | — | 0.2..80 | — | Pixels per block. Omit to auto-frame the content. |
| `reset` | 布尔 | — | — | — | Clear the stored camera and go back to the default preset. |

## `update_notes`

```
Write down your design plan so it survives context trimming. The notes become part of the system prompt from the NEXT turn onwards, so keep them short and current.
REPLACE semantics: you always send the complete, up-to-date notes — not a diff and not an append.
Good notes: what is already built, the dimensions and materials you settled on, what is next, and any decision a later turn must not undo (e.g. 'door faces south, keep the 2-block clearance').
Call it at milestones, not every turn. Aim for about 2000 characters; anything over 5000 is rejected. Send an empty string to clear the notes.
```

| 参数 | 类型 | 必填 | 取值 / 范围 | 默认 | 说明 |
|------|------|:----:|-------------|------|------|
| `notes` | 字符串 | ✅ | — | — | The complete notes, replacing whatever was stored before. Empty string clears them. |

## 其他

## `undo`

```
Move the version cursor back one step and replay, undoing the last edit. Use it when you just made a change you regret.
IMPORTANT: editing after an undo DISCARDS everything after the cursor (there is no branching yet). If you only want to look at an earlier state, use screenshot/slice instead of undo.
```

**无参数。**

## `redo`

```
Move the version cursor forward one step and replay, reapplying an edit you undid. Only meaningful right after undo.
```

**无参数。**
