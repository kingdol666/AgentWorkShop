/**
 * AML 作业编排:提交/取消/重试、Python 进程生命周期、阶段与结论、WS 广播
 *
 * 由原单文件按职责拆分而来;此处保持**原文件的公开 API 与 import 路径不变**
 * (目录 index 解析),外部调用方无需改动。
 *
 * 模块划分:
 *   shared.ts              模块头 / 运行中作业与编排器状态类型 / 全局状态
 *   submit.ts              提交作业(参数校验 / 落库 / 启动)
 *   control.ts             取消 / 重试 / 日志尾 / 重启恢复 / 关停 / 心跳定时器
 *   tick.ts                队列推进:tick 取下一个待跑作业
 *   start-job.ts           启动单个作业(环境探测 / 参数组装 / 分支到 stub 或真实进程)
 *   process.ts             Python 进程:退出信息 / 运行与 spawn / 协议行处理
 *   stages.ts              阶段与状态读取 / stub 运行 / 结题
 *   failure.ts             失败与重试决策 / 实验失败 / 杀进程 / 收尾 / 日志与解析工具
 *   broadcast.ts           WS 广播:作业 / 阶段 / 进度
 *   status.ts              运行时状态(Python 可用性等)
 */
export { submitJob } from './submit'
export type { SubmitJobInput } from './submit'
export { cancelJob, retryJob, jobLogsTail, recoverInterruptedJobs, shutdownOrchestrator } from './control'
export { runtimeStatus } from './status'
