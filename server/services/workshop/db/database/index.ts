/**
 * workshop 持久化层:建表 SQL / 内置种子 / 行类型 / 打开与迁移
 *
 * 由原单文件按职责拆分而来;此处保持**原文件的公开 API 与 import 路径不变**
 * (目录 index 解析),外部调用方无需改动。
 *
 * 模块划分:
 *   schema.ts              建表 SQL(SCHEMA_SQL:全部表/索引/触发器)
 *   seed-data.ts           内置 Agent 模板与内置编组常量
 *   seed.ts                内置 Channel 模板常量与首启种子写入
 *   rows.ts                各表行类型(Row)定义
 *   open.ts                打开/初始化数据库(PRAGMA、建表、种子、sqlite-vec)
 *   migrations.ts          历史库迁移(v17 群聊、补列、外键、遗留 schema)
 *   json.ts                JSON 列读写小工具
 */
export type { ChannelRow, ChannelMemberRow, ChatMessageRow, ChatDeliveryRow, UserNotificationRow, OutboxEventRow, HitlRequestRow, UserRow, ChannelEventRow, WorkspaceRow, AgentRow, TeamRow, ChannelTemplateRow, TeamMemberRow, MemoryKind, MemoryRow, ChannelAgentRow, MessageRow, SubscriptionRow, TaskRow, ScheduledTaskRow, ScheduledTaskRunRow } from './rows'
export { openWorkshopDb, initWorkshopDb } from './open'
export { parseJson } from './json'
