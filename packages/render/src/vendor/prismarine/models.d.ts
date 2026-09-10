/**
 * vendored 的 prismarine mesher 的类型声明。
 *
 * 源码是 `.js`（为了与上游逐行一致，见 `models.js` 顶部说明），所以类型在这里手写。
 * 声明文件必须与 `.js` **同名同目录**（`models.d.ts` ↔ `models.js`），
 * TS 才会在 `import './models.js'` 时用它。
 *
 * 只声明我们真正用到的部分。`getSectionGeometry` 的入参契约是整个适配层最容易
 * 出错的地方，值得写清楚而不是 `any`。
 */

/** 图集里一张纹理的归一化矩形，由 `modelsBuilder` 写进每个面。 */
export interface AtlasRect {
  u: number
  v: number
  su: number
  sv: number
}

/** `getSectionGeometry` 需要的世界视图。**这就是 mesher 对我们提出的全部要求。** */
export interface MesherWorld {
  /**
   * 取一个方块。返回 `null`/`undefined` 表示**世界外**，mesher 据此决定要不要剔除面。
   *
   * 返回的对象要满足 `prismarine-block` 的形状：
   * `name` / `type`（全局 stateId）/ `metadata` / `position` / `biome.name` /
   * `isCube` / `transparent` / `material` / `getProperties()`。
   */
  getBlock: (pos: { x: number; y: number; z: number }) => MesherBlock | null | undefined
}

export interface MesherBlock {
  name: string
  type: number
  metadata?: number
  /** **必须设**：mesher 用 `neighbor.position.y < 0` 判世界底面。 */
  position: unknown
  biome?: { name: string }
  /** `prismarine-block` 自己不算这个字段，要由适配层按 `shapes` 补上。 */
  isCube?: boolean
  transparent?: boolean
  material?: string
  getProperties: () => Record<string, string | number | boolean>
  /** mesher 会把解析出来的 model 变体缓存在这里，别预置。 */
  variant?: unknown
}

/** `getSectionGeometry` 的返回值：一块 16³ 区域的三角形汤。 */
export interface SectionGeometry {
  /** **以段中心为原点**的顶点；世界坐标要加上 `sx + 8`。 */
  positions: Float32Array
  normals: Float32Array
  /** 逐顶点颜色（AO × 生物群系着色）。**不含**方向明暗——那一步在光栅器里做。 */
  colors: Float32Array
  /** 逐顶点 UV，已经归一化到图集坐标。 */
  uvs: Float32Array
  indices: number[]
}

/** 网格化 16×16×16 的一段世界。`sx/sy/sz` 是**段原点**（16 的倍数）。 */
export declare function getSectionGeometry(
  sx: number,
  sy: number,
  sz: number,
  world: MesherWorld,
  blocksStates: Record<string, unknown>,
): SectionGeometry

/**
 * 按版本载入生物群系着色表（草/树叶/水）。**必须在 `getSectionGeometry` 之前调用。**
 * 上游把版本写死成 1.16.2，这里改成注入（见 `models.js` 顶部「改动 2/3」）。
 */
export declare function configureTints(version: string): void
