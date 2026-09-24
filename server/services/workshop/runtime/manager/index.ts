/**
 * runtime/manager —— 原 runtime/manager.ts(单文件 god class)拆分后的门面。
 *
 * 结构:
 *   types.ts              依赖类型与对外 DTO(纯类型)
 *   helpers.ts            模块级纯工具(无 this)
 *   contracts.ts          跨层能力契约(42 个抽象方法签名)
 *   state.ts              运行时状态 / 依赖注入 / TaskEngine / 编年史 / 空闲反思
 *   bus.ts                ChannelBus 装配与订阅面(事件/任务/成员/群聊/记忆)
 *   runtime-wiring.ts     实例装配、调度器挂载、卸载与空闲清扫
 *   runtime-observe.ts    运行时监控视图、进程终止与 shutdown
 *   workspace.ts          AgentWorkspace 能力面与 lead 根任务登记
 *   access.ts             用户面、owner/member 守卫、群成员管理
 *   chat.ts               群聊事实层:消息落库、投递、@ 解析、快照投影
 *   chat-reply.ts         群聊回复回写与事件发布
 *   notifications.ts      用户级通知与群聊审计
 *   admin-channel.ts      Channel / Agent 模板管理面
 *   admin-agents.ts       Channel 实例管理、记忆与成员增改删
 *   lead-team.ts          lead 自主团队管理面(扩容/调参/裁撤)
 *   teams.ts              AgentTeam 编组与批量部署
 *   channel-templates.ts  Channel 模板与一键实例化
 *   tasks.ts              任务作业面:提交/派发/验收/队列/HITL
 *   a2a.ts                Agent 间消息与跨 Channel 协作
 *   host-tools.ts         宿主工具调用入口与信箱面
 *   schedules.ts          定时任务管理面与 restore
 *   internal.ts           内部辅助:路由、唤醒、作用域守卫
 *
 * 外部 `from ".../runtime/manager"` 的 import 无需改动(目录 index 解析)。
 */
export { AgentChannelManager, createAgentChannelManager, initWorkshopManager, getWorkshopManagerOrNull } from './facade'
export type { AllRepos } from './types'
export type { ManagerDeps } from './types'
export type { ActingUser } from './types'
export type { AgentTemplateDetail } from './types'
export type { AgentTeamDetail } from './types'
export type { ChannelTemplateDetail } from './types'
export type { RuntimeChannelView } from './types'
export type { RuntimeAgentView } from './types'
export type { RuntimeProcessView } from './types'
export type { RuntimeMonitorSnapshot } from './types'
export type { ScheduleView } from './types'
export { resolveOwnerName } from './helpers'
