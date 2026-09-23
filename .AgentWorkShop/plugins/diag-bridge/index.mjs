/**
 * 诊断桥插件 —— **插件入口薄壳**。
 *
 * 实现按职责拆到 ./host/ 下(常量 / HTTP 与配置辅助 / 快照抽取 / 诊断启动 / 自动巡检 /
 * 插件对象)。插件发现逻辑要求**本目录下必须有 index.mjs**(`discoverPluginDirs` 只扫一层:
 * `<pluginsDir>/<name>/index.mjs`),所以入口文件名与位置保持不变,只是内容变成一行转发;
 * ./host/ 位于插件目录**下一层**,不会被误当成另一个插件。
 */
export { default } from './host/index.mjs'
