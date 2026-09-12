import { obj, str } from '../schema.js'
import { defineTool, failure } from '../types.js'

/**
 * `update_notes`：**让模型把自己的设计计划写下来，好让它活过上下文裁剪**（§9.2 的阶段摘要）。
 *
 * 为什么需要它：无前缀缓存的 provider（本地小模型、短窗口）靠滑动窗口丢旧轮次。
 * 一旦丢掉，模型就"忘了"自己当初为什么这么设计——于是它开始反复重新勘察、
 * 或者在同一处改来改去。让它在关键节点用几句话把计划固定下来，这几句话会进
 * **系统提示的稳定前缀**，下一轮起一直在（`prompts.ts` 的 `[DESIGN NOTES]` 段）。
 *
 * 两个刻意的设计：
 *
 * 1. **写在轮内不影响本轮的前缀**。系统提示是每轮（每次用户发言）构建一次的，
 *    所以模型这轮写下的笔记从**下一轮**开始生效。这是为了前缀缓存：
 *    中途改系统提示会把缓存整段打掉，而 Regime A 的 98% 命中率就是这么来的。
 * 2. **替换而不是追加**。笔记是"当前计划"，不是流水账；追加会越滚越长，
 *    而它进的是**每个请求**的前缀（长笔记 = 每轮都多付一遍钱）。
 *    所以这里有硬上限，超了直接拒绝并给出当前长度，让模型自己删。
 *
 * ## 硬墙 5000，提示词里说"大约 2000"
 *
 * 这两个数**故意不一样**（用户要求的）：
 *
 * - 5000 是**校验**用的硬墙，只负责挡住"模型把整段对话抄进笔记"这种失控。
 *   它不该在模型正常写计划时把它顶回来——一次 `INVALID_ARGS` 要花一整轮去修，
 *   而修的结果往往是**砍掉真正有用的那条约束**。
 * - 2000 是**提示词里的期望值**。告诉模型"上限 5000"，它就会写到 5000：模型对显式
 *   数字的服从度很高，而这个长度进每一轮的前缀，长笔记就是每轮都多付钱。
 *
 * 软目标负责省 token，硬墙负责兜底。改这两个数之前先想清楚你动的是哪一个。
 */
export const MAX_DESIGN_NOTES_CHARS = 5_000

/** 提示词里告诉模型的期望长度（**软目标**，不是校验）。见上面那段。 */
export const SUGGESTED_DESIGN_NOTES_CHARS = 2_000

export const updateNotesTool = defineTool<{ notes: string }>({
  name: 'update_notes',
  description:
    'Write down your design plan so it survives context trimming. The notes become part of the system ' +
    'prompt from the NEXT turn onwards, so keep them short and current.\n' +
    'REPLACE semantics: you always send the complete, up-to-date notes — not a diff and not an append.\n' +
    'Good notes: what is already built, the dimensions and materials you settled on, what is next, ' +
    "and any decision a later turn must not undo (e.g. 'door faces south, keep the 2-block clearance').\n" +
    `Call it at milestones, not every turn. Aim for about ${SUGGESTED_DESIGN_NOTES_CHARS} characters; ` +
    `anything over ${MAX_DESIGN_NOTES_CHARS} is rejected. ` +
    'Send an empty string to clear the notes.',
  parameters: obj({ notes: str('The complete notes, replacing whatever was stored before. Empty string clears them.') }, [
    'notes',
  ]),
  execute: (ctx, args) => {
    if (ctx.notes === undefined) {
      // 宿主没接这个能力（比如某个只跑工具子集的测试夹具）：如实说，别假装记下了
      return failure(
        'UNSUPPORTED',
        'This session has no place to store design notes',
        'The host did not wire ctx.notes; continue without it.',
      )
    }
    const notes = args.notes.trim()
    if (notes.length > MAX_DESIGN_NOTES_CHARS) {
      return failure(
        'INVALID_ARGS',
        `Notes are ${notes.length} characters, over the ${MAX_DESIGN_NOTES_CHARS} limit`,
        'Shorten them: keep the plan and the constraints, drop the narration.',
        { length: notes.length, limit: MAX_DESIGN_NOTES_CHARS },
      )
    }
    ctx.notes.set(notes.length === 0 ? undefined : notes)
    return {
      ok: true,
      summary:
        notes.length === 0
          ? 'Design notes cleared.'
          : `Design notes stored (${notes.length}/${MAX_DESIGN_NOTES_CHARS} characters). They take effect from the next turn:\n${notes}`,
      data: { length: notes.length, limit: MAX_DESIGN_NOTES_CHARS },
    }
  },
})
