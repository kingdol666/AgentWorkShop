/**
 * 写控运维入册(写成功后的单点记账,由 write() 内联块收敛而来):
 *  - recordOps 运维日志(同节点同值 10s 去重节流,防重试风暴刷屏);
 *  - 插件写控 ACK 钩子(与运维入册同点同去重节流)。
 * 与调控闭环入册(afterWrite)分离;调用方保证吞掉本模块异常 —— 日志失败不影响写结果。
 */
import type { DcwWriteMeta, DcwWriteSource } from '../../../../../shared/dcw-protocol'
import { emitDcwWrite } from '@/server/services/workshop/plugins/host.mjs'
import { getActiveLineRun } from '../line-run'
import { opsActorKindOf } from './helpers'
import { recordOps } from '../../ops/ops'
import { recordIntervention } from '../../aml/intervention-ledger'

/** 同节点写入去重节流表(10s 窗内同签名视为同一次下发的重试回执) */
export const opsWriteMemo = new Map<string, { eng: number, sig: string, at: number }>()

export function recordDcwWriteOps(args: {
  id: string
  node: { name: string, unit?: string, lineId: string }
  eng: number
  prevValue: number | null
  outcome: { ok: boolean, message: string, ack?: string, readback?: number | null }
  src: DcwWriteSource
  meta?: DcwWriteMeta
  recipeRunId: string | null
}): void {
  const memo = opsWriteMemo.get(args.id)
  const now = Date.now()
  // 去重签名必须带操作者/审批单/批次:两个不同 Agent(或同一 Agent 的两张审批单)在 10s 内
  // 写同一个值是两笔独立下发,各自都要有审计。旧实现只比 eng,第二笔的 recordOps 与
  // 干预台账被整段跳过 —— 事故复盘会出现"设备已变、台账无行"。
  const sig = `${args.eng}|${args.meta?.actor ?? ''}|${args.meta?.approvalId ?? ''}|${args.recipeRunId ?? ''}`
  if (memo && memo.sig === sig && now - memo.at <= 10_000) return
  opsWriteMemo.set(args.id, { eng: args.eng, sig, at: now })
  if (opsWriteMemo.size > 500)
    opsWriteMemo.clear()
  const runNow = getActiveLineRun(args.node.lineId)
  recordOps({
    actor: args.meta?.actor ?? 'user',
    actorName: args.meta?.actorName ?? args.meta?.actor ?? 'user',
    actorKind: opsActorKindOf(args.src),
    action: `dcw.write.${args.src}`,
    kind: 'write',
    targetKind: 'dcw-node',
    targetId: args.id,
    summary: `下发设定「${args.node.name}」→ ${args.eng}${args.node.unit ?? ''}(${args.src === 'manual' ? '手动' : args.src === 'agent' ? 'Agent' : args.src === 'rollback' ? '回退恢复' : '配方'})`,
    lineId: args.node.lineId ?? '',
    productId: runNow?.productId ?? '',
    recipeId: runNow?.recipeId ?? args.recipeRunId ?? '',
    detail: { eng: args.eng, prevValue: args.prevValue, ok: args.outcome.ok, message: args.outcome.message, taskId: args.meta?.taskId ?? null, hypothesis: args.meta?.hypothesis ?? '', approvalId: args.meta?.approvalId ?? null, executionMode: args.meta?.executionMode ?? null },
  })
  // 插件钩子:写控 ACK 观察(与运维入册同点同去重节流)
  emitDcwWrite({ nodeId: args.id, name: args.node.name, eng: args.eng, prevValue: args.prevValue, ok: args.outcome.ok, source: args.src, lineId: args.node.lineId ?? '', at: new Date().toISOString() })
  // v34 干预台账(科学探索计划 P2):全路径单点入册(与运维日志同点同去重节流)。
  // 只记已受理下发;拒绝路径沿上方 recordOps 的 dcw.write.rejected 审计,不入台账。
  // recordIntervention 内部自吞异常(台账失败绝不改变写结果语义)。
  recordIntervention({
    nodeId: args.id,
    nodeName: args.node.name,
    lineId: args.node.lineId ?? '',
    fromValue: args.prevValue,
    toValue: args.eng,
    actualValue: args.outcome.readback != null && Number.isFinite(Number(args.outcome.readback)) ? Number(args.outcome.readback) : null,
    ack: args.outcome.ack ?? '',
    path: args.src,
    actor: args.meta?.actor ?? 'user',
    actorName: args.meta?.actorName ?? '',
    channelId: args.meta?.channelId ?? '',
    approvalId: args.meta?.approvalId ?? null,
    recipeRunId: args.recipeRunId,
    hypothesis: args.meta?.hypothesis ?? '',
  })
}
