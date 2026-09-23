/**
 * Workshop WebSocket Hub(AEP v1)—— 前端观察入口的事件直推实现
 *
 * 由原单文件按职责拆分而来;此处保持**原文件的公开 API 与 import 路径不变**
 * (目录 index 解析),外部调用方无需改动。
 *
 * 模块划分:
 *   shared.ts              协议头注释 / 常量 / WsPeer 与 ChannelStream 类型 / hub 单例
 *   hub.ts                 hub↔manager 绑定自愈 / 查询参数 / 场景 peer / 控制帧与流帧发送
 *   db-buffer.ts           落库聚合缓冲刷盘(400ms 批量事务)
 *   publish.ts             事件发布(seq/环形缓冲/慢消费者断开)与快照构建
 *   event-mapping.ts       AgentEvent → AEP 帧映射
 *   subscriptions.ts       频道总线订阅绑定 / HITL 待办订阅
 *   audience.ts            HITL 受众与管理员集合解析
 *   streams.ts             流生命周期:陈旧重订 / 回收 / 确保存在
 *   peer-sub.ts            peer 订阅/退订与聊天快照投影
 *   handlers.ts            场景布局广播 / 事件记录器预热 / defineWebSocketHandler 入口
 *   notification-uplink.ts 用户级通知上行(subNotifications / unsub / read)
 */
export { ensureStream } from './streams'
export { publishSceneLayoutEvent, ensureAllEventRecorders } from './handlers'
export { broadcastSceneEvent } from './peer-sub'
export { default } from './handlers'
