/**
 * server/services/workshop/dcw/dcw-controller.ts 拆分后的门面(目录 index 解析,外部 import 路径不变)。
 *
 * 结构:
 *   types.ts      依赖类型与 DTO
 *   helpers.ts    模块级纯工具/常量
 *   contracts.ts  跨层能力契约(2 个抽象方法)
 *   00-state.ts              字段 / 巡检循环 / 运行时同步 / 宿主
 *   01-actuation.ts          写执行 / 读执行 / 变更广播
 *   02-control.ts            视图状态 / 广播装配 / 启停暂停恢复
 *   03-crud.ts               节点 CRUD
 *   04-bindings.ts           设备绑定
 *   05-write.ts              数控写入(联锁/量程/租约)与驱动探测
 *   06-params.ts             工艺参数映射与读写
 *   07-recipes.ts            配方 CRUD / 版本回退 / 应用
 *   08-lines.ts              产线 / 运行 / 查询
 *   09-products.ts           产品 CRUD 与运行数据
 *   facade.ts     最终类 + 模块级尾码
 */
export { getDcwController, bindDcwBroadcast } from './facade'
export type { DcwCreateInput } from './types'
export type { DcwPatchInput } from './types'
