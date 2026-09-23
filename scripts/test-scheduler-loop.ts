/**
 * SchedulerLoop 调度循环测试(node + tsx 直跑,无浏览器)。
 *
 * 覆盖:
 *  1. MockAgentImpl 默认 simple/complex triage 与 child artifact 验收摘要
 *  2. wake() 立即触发一轮;空/异常 supervise 不触发盲派或父任务验收
 *  3. worker 失败重试与 busy stall watchdog 故障恢复
 *  4. 显式 goal/pipeline/loop 模式、stop() 与 createAgentImpl 工厂
 *
 * 装配:真实 :memory: repo + 真实 TaskEngine + 真实 ChannelRuntime + 真实 Mailbox
 *      + 真实 AgentRuntime(MockAgentImpl lead/worker)+ 真实 SchedulerLoop。
 */

import './test-scheduler-loop/main'
