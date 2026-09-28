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

/** 同节点写入去重节流表(eng+10s 窗内视为同一次下发的重试回执) */
export const opsWriteMemo = new Map<string, { eng: number, at: number }>()

export function recordDcwWriteOps(args: {
  id: string
  node: { name: string, unit?: string, lineId: string }
  eng: number
  prevValue: number | null
  outcome: { ok: boolean, message: string }
  src: DcwWriteSource
  meta?: DcwWriteMeta
  recipeRunId: string | null
}): void {
  const memo = opsWriteMemo.get(args.id)
  const now = Date.now()
  if (memo && memo.eng === args.eng && now - memo.at <= 10_000) return
  opsWriteMemo.set(args.id, { eng: args.eng, at: now })
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
    detail: { eng: args.eng, prevValue: args.prevValue, ok: args.outcome.ok, message: args.outcome.message, taskId: args.meta?.taskId ?? null },
  })
  // 插件钩子:写控 ACK 观察(与运维入册同点同去重节流)
  emitDcwWrite({ nodeId: args.id, name: args.node.name, eng: args.eng, prevValue: args.prevValue, ok: args.outcome.ok, source: args.src, lineId: args.node.lineId ?? '', at: new Date().toISOString() })
}
