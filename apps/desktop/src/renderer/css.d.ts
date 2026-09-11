/**
 * 样式文件的模块声明。
 *
 * 渲染进程 `import './styles.css'` 与 `import 'antd/dist/reset.css'`，esbuild 会把它们
 * 打进 `main.js`（运行时注入 `<style>`，所以 CSP 的 `style-src` 必须带 `'unsafe-inline'`）。
 * TypeScript 不认识这两个后缀，这里告诉它"引进来的东西没有导出、也没有副作用类型"。
 */
declare module '*.css' {
  const content: void
  export default content
}
