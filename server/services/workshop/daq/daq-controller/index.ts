/**
 * server/services/workshop/daq/daq-controller.ts 拆分后的门面(目录 index 解析,外部 import 路径不变)。
 *
 * 结构:
 *   types.ts      依赖类型与 DTO
 *   helpers.ts    模块级纯工具/常量
 *   contracts.ts  跨层能力契约(12 个抽象方法)
 *   00-state.ts              字段 / 采样循环 / 运行时设置 / 单节点采样
 *   01-ingest.ts             样本与帧的入库、发布、告警评估
 *   02-sweep-alarms.ts       巡检 / 运行时同步 / 告警处理与确认
 *   03-tsdb-twin.ts          TSDB 落库 / 孪生遥测回写
 *   04-views.ts              视图投影 / 状态与广播装配 / 队列重挂
 *   05-frames.ts             帧缓冲:检索、淘汰、内容与点列
 *   06-runtime-control.ts    后端与运行时总控(启停/暂停/配置)
 *   07-crud.ts               节点 CRUD 与设备绑定
 *   08-driver-probe.ts       驱动探测、目录与遗留孪生补齐
 *   facade.ts     最终类 + 模块级尾码
 */
export { getDaqController, bindDaqBroadcast } from './facade'
export type { DaqCreateInput } from './types'
export type { DaqPatchInput } from './types'
export { setQueueBackend } from './helpers'
