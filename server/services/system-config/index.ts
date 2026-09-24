/**
 * server/services/system-config.ts 拆分后的门面(目录 index 解析,外部 import 路径不变)。
 *
 * 结构:
 *   types.ts      依赖类型与 DTO
 *   helpers.ts    模块级纯工具/常量
 *   contracts.ts  跨层能力契约(5 个抽象方法)
 *   state.ts      状态字段与派生视图
 *   init.ts       构造 / 初始化 / 描述符索引重建
 *   groups.ts     配置分组 CRUD 与广播
 *   plugins.ts    插件描述符注入 / 旧键迁移 / 取值与运行时应用
 *   recompute.ts  有效值重算与磁盘重载
 *   snapshot.ts   文件监听 / 快照 / 路径访问器
 *   mutate.ts     写入 / 重置 / 重载 / 订阅与广播
 *   dispose.ts    销毁
 *   facade.ts     最终类 + 模块级尾码
 */
export { SystemConfigService, getSystemConfigService, useSystemConfig } from './facade'
export type { ConfigGroup } from './types'
export type { PublicSnapshot } from './types'
export type { ConfigEventPayload } from './types'
