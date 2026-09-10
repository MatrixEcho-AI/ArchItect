/**
 * vendored 的方块模型继承解析器的类型声明（`modelsBuilder.js`）。
 *
 * 它做的事：沿 `parent` 递归展开模型、把纹理名解析成图集矩形、按原版规则补默认 UV。
 * 详见 `modelsBuilder.js` 顶部。
 */

import type { AtlasRect } from './models.js'

/** `minecraft-assets` 加载出来的对象里我们用到的两个字段。 */
export interface McAssetsForModels {
  blocksStates: Record<string, unknown>
  blocksModels: Record<string, unknown>
}

/** 图集句柄。形状对齐 prismarine-viewer 的 `atlas.json`。 */
export interface AtlasHandle {
  json: { size: number; textures: Record<string, AtlasRect> }
}

/**
 * **原地**改写 `mcAssets.blocksStates`：把每个 variant 的 `model` 换成展开并解析好的模型。
 *
 * ⚠️ 因为是原地改写，**同一个 `mcAssets` 只能调用一次**——第二次会把已经解析过的
 * 模型再解析一遍（`cleanupBlockName` 拿不到图集项，UV 会算错）。
 */
export declare function prepareBlocksStates(
  mcAssets: McAssetsForModels,
  atlas: AtlasHandle,
): Record<string, unknown>
