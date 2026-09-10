/**
 * **浏览器安全的入口**。渲染进程只从这里 import `@architect/render`。
 *
 * 包的默认入口（`index.ts`）会拉进 `mesher.ts` / `atlas.ts` / `colors.ts`，
 * 那三个都要 `node:fs`、`minecraft-assets`、`prismarine-block`——在 Chromium 里
 * import 到就整包崩，而且 esbuild 会试图把 352 MB 的资源包塞进 bundle。
 *
 * 这里只导出**没有 Node 依赖**的部分：相机、画布、PNG 编解码、叠加层、软件光栅器。
 * 桌面视口用 three.js 画方块 + 这一份叠加层，两边共用同一个 `cameraBasis`，
 * 所以标尺、坐标轴、工区线框的投影与主进程渲染出来的图**完全对齐**。
 *
 * 加东西之前先问一句：它会不会在 import 期碰 `node:*` 或原生模块？会就别放这儿。
 */

export * from './atlas-format.js'
export * from './camera.js'
export * from './canvas.js'
export * from './font.js'
export * from './overlay.js'
export * from './png.js'
export * from './raster.js'
export * from './pick.js'
