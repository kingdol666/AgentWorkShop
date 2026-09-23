/**
 * HITL 决策域:载荷校验 / 渠道可见性与决策权 / 启动对账 / 原生派发器 / 决策落库与通知
 *
 * 由原单文件按职责拆分而来;此处保持**原文件的公开 API 与 import 路径不变**
 * (目录 index 解析),外部调用方无需改动。
 *
 * 模块划分:
 *   shared.ts              模块头 / 领域类型 / 两个错误类 / 原生失败判别
 *   payload.ts             决策载荷校验与状态映射
 *   answers.ts             回答归一(问题 id ↔ 文本/选项)
 *   visibility.ts          渠道可见性 / 决策权断言 / 行快照
 *   reconcile.ts           启动对账(恢复悬挂的待审批)
 *   dispatcher.ts          原生派发器注册与默认派发
 *   decide.ts              决策主流程 / 一次性对账 / 问题解析 / 结果通知
 */
export { HitlDeliveryUnknownError, HitlRetryableError } from './shared'
export type { HitlActingUser, HitlDecisionPayload, HitlDecisionInput, HitlDecisionResult } from './shared'
export { assertDecisionPayload, statusOfDecision } from './payload'
export { resolveAnswers } from './answers'
export { assertCanDecideHitlChannel, canDecideHitlChannel, snapshotOfRow } from './visibility'
export { reconcileHitlOnStartup } from './reconcile'
export { registerHitlNativeDispatcher } from './dispatcher'
export type { HitlNativeDispatchContext, HitlNativeDispatcher } from './dispatcher'
export { decideHitlRequest, ensureHitlReconciled } from './decide'
