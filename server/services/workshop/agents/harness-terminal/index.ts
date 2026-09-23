/**
 * Harness 终端会话 tap:帧净化 / 会话内部状态 / park 倒计时 / 对外 API 与 IO
 *
 * 由原单文件按职责拆分而来;此处保持**原文件的公开 API 与 import 路径不变**
 * (目录 index 解析),外部调用方无需改动。
 *
 * 模块划分:
 *   shared.ts              模块头 / 会话与 hub 状态类型 / 全局 hub
 *   sanitize.ts            帧净化:内容抽取 / 截断 / 预览 / 敏感字段清洗
 *   session.ts             会话内部:入帧缓冲 / 定时刷帧 / 广播 / 状态与 HITL 视图
 *   park.ts                park 倒计时(无人观看挂起 / 接入暂停 / 待办过期)
 *   api.ts                 对外 API:挂接/摘除 tap、退出标记、查询与快照
 *   io.ts                  对外 IO:订阅 / 输入 / 中断 / UI 应答
 */
export { attachTerminalTap, detachTerminalTap, markTerminalSessionExit, hasTerminalSession, findLiveTerminalPidByAgent, listTerminalSessions, sweepTerminalSessions, terminalSessionSnapshot } from './api'
export type { TerminalSessionView } from './api'
export { subscribeTerminal, sendTerminalInput, abortTerminal, respondTerminalUi } from './io'
