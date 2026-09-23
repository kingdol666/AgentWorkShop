/**
 * 插件宿主 —— **对外入口薄壳**。
 *
 * 实现按职责拆到 ./host/ 下(配置与 i18n / 运行时服务种子 / 状态与发现 / 初始化 /
 * 装载 / 回滚 / 重载 / 开关 / 对外查询)。这里保留 `.mjs` 这个路径本身,是因为调用方
 * `server/plugins/aw-plugins.ts` 是以 `@/server/services/workshop/plugins/host.mjs`
 * **显式带扩展名**导入的 —— 保留薄壳即可零改动对外接口。
 */
export * from './host/index.mjs'
