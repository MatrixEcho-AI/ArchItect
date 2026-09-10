export * from './schema.js'
export * from './types.js'
export * from './registry.js'
export * from './tools/edit.js'
export * from './tools/inspect.js'
export * from './tools/view.js'
export * from './tools/transform.js'
export * from './tools/batch.js'
export * from './tools/analyze.js'
export * from './docs.js'
export * from './tools/fixstates.js'

import { ToolRegistry } from './registry.js'
import {
  eraserTool,
  extrudeTool,
  fillBoxTool,
  fillLineTool,
  fillPlaneTool,
  placeBlockTool,
  symmetrizeTool,
} from './tools/edit.js'
import {
  getBlockTool,
  getRegionTool,
  measureTool,
  searchBlocksTool,
  sliceTool,
  verifyTool,
} from './tools/inspect.js'
import { screenshotTool, setCameraTool, undoRedoTools } from './tools/view.js'
import { copyRegionTool, pasteRegionTool } from './tools/transform.js'
import { replaceBlocksTool, runBatchTool } from './tools/batch.js'
import { analyzeStructureTool } from './tools/analyze.js'
import { fixStatesTool } from './tools/fixstates.js'

/**
 * v0 的默认工具集。
 *
 * 顺序有讲究：**批量工具排在单格工具前面**，因为工具顺序会影响 LLM 的选择倾向
 * （plan §2/D1：让 LLM 出"意图与几何参数"，不要逐格摆放）。
 */
export function createDefaultRegistry(): ToolRegistry {
  return new ToolRegistry()
    .register(runBatchTool)
    .register(extrudeTool)
    .register(fillBoxTool)
    .register(fillLineTool)
    .register(fillPlaneTool)
    .register(symmetrizeTool)
    .register(copyRegionTool)
    .register(pasteRegionTool)
    .register(replaceBlocksTool)
    .register(fixStatesTool)
    .register(eraserTool)
    .register(placeBlockTool)
    .register(sliceTool)
    .register(measureTool)
    .register(verifyTool)
    .register(getBlockTool)
    .register(getRegionTool)
    .register(searchBlocksTool)
    .register(analyzeStructureTool)
    .register(screenshotTool)
    .register(setCameraTool)
    .register(undoRedoTools[0]!)
    .register(undoRedoTools[1]!)
}
