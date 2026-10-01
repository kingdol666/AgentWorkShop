/**
 * PlatformNotice —— 平台 → Agent 主动通告面。
 *
 * 两条链路共用一个投递管道(持久化 mailbox + 空闲唤醒):
 *  ① 异步工具结果回执:后台作业(AML 训练/深度诊断/KB 入库)完成时,把结果以消息
 *     形式补送给发起调用的 Agent——不再依赖 Agent 自觉轮询;先到先得去重:Agent 已
 *     通过 status 工具看到结果的作业不补发(省一次无谓回合)。
 *  ② HITL 决议补送:审批的等待方已死(运行时被中断/进程重启对账)时,人类的
 *     批准/拒绝决议与附言仍要以消息形式到达 Agent——人机交互不因链路断裂而丢话。
 *
 * 投递语义:
 *  - 直接落 messages 表(pending):信箱关闭/Agent 未装配也不丢,下次装配按 FIFO 消费;
 *  - 已装配的 Agent 即时 wakeMailbox(空闲则立即起回合处理回执——"完成即唤醒");
 *  - 未接线(单测脚手架)时全部 no-op 返回 false,调用方零负担。
 *
 * 依赖倒置:本模块只暴露全局 sink;真实实现由 Manager 构造期接线
 * (见 ManagerState.wirePlatformNoticeSink)——服务层(aml/plugin/hitl)只 import 本模块,
 * 不反向依赖 manager,无循环装载。
 */
import { randomUUID } from 'node:crypto'

/** 异步工具结果回执(claim 键 = tool:jobId;先到先得) */
export interface PlatformToolResultNotice {
  kind: 'tool-result'
  tool: string
  jobId: string
  agentId: string
  /** 缺省按 agentId 反查所属 channel */
  channelId?: string
  taskId?: string
  ok: boolean
  title: string
  summary: string
}

/** HITL 决议/平台事件补送(无 claim 语义,调用方自行保证低频) */
export interface PlatformHitlNotice {
  kind: 'hitl-note'
  agentId: string
  channelId?: string
  title: string
  summary: string
}

export type PlatformNotice = PlatformToolResultNotice | PlatformHitlNotice

export interface PlatformNoticeSink {
  /**
   * 投递通告:原子 claim + 落库 + 唤醒。
   * 返回 true = 已投递;false = 重复(已投过/已被轮询认领)或不可达(成员已移除/无归属 channel)。
   * 不可达也视为已消费(成员行不会复活,重试无意义)。
   */
  deliver(notice: PlatformNotice): boolean
  /** 轮询方认领:status 工具把终态结果亲自交给 Agent 时调用,取消后续补送 */
  claim(tool: string, jobId: string): boolean
}

const g = globalThis as typeof globalThis & { __platformNoticeSink?: PlatformNoticeSink }

/** Manager 构造期接线(幂等,后到覆盖) */
export function setPlatformNoticeSink(sink: PlatformNoticeSink): void {
  g.__platformNoticeSink = sink
}

export function platformNoticeWired(): boolean {
  return Boolean(g.__platformNoticeSink)
}

/** 异步工具结果回执(未接线 → false,作业收口方零负担) */
export function sendToolResult(input: Omit<PlatformToolResultNotice, 'kind'>): boolean {
  const sink = g.__platformNoticeSink
  if (!sink) return false
  try {
    return sink.deliver({ kind: 'tool-result', ...input })
  }
  catch {
    return false
  }
}

/** 轮询方认领(未接线 → false;两侧都不存在,语义自洽) */
export function claimToolResult(tool: string, jobId: string): boolean {
  const sink = g.__platformNoticeSink
  if (!sink) return false
  try {
    return sink.claim(tool, jobId)
  }
  catch {
    return false
  }
}

/** HITL 决议/平台事件补送 */
export function sendHitlNote(input: Omit<PlatformHitlNotice, 'kind'>): boolean {
  const sink = g.__platformNoticeSink
  if (!sink) return false
  try {
    return sink.deliver({ kind: 'hitl-note', ...input })
  }
  catch {
    return false
  }
}

/** 通告键(tool-result 去重主键;hitl-note 无去重需求但保留键空间一致性) */
export function platformNoticeKey(notice: PlatformNotice): string {
  return notice.kind === 'tool-result' ? `${notice.tool}:${notice.jobId}` : `hitl:${notice.agentId}:${notice.title}`
}

/** 消息 id(落库用) */
export function newPlatformNoticeId(): string {
  return `pn-${randomUUID()}`
}
