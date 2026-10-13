/**
 * DesignBridge Studio —— 宿主半边。
 *
 * 这是一个**纯客户端插件**：所有能力都在 `./client.js` 里，宿主半边按官方模板
 * 只导出一个空 `apply()`，作用是让 bundle 能被挂进 profile。
 *
 * 之所以为空而不是省略：bundle 的每一行都需要一个可 `require` 的入口，
 * 客户端 bundle 由 `dsh.client` 声明另行加载。
 */

/** 挂载点。渲染与交互全部由 Client 模块负责。 */
export function apply() {}
