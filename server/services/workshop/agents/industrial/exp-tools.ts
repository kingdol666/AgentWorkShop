/**
 * 经验采集工具(exp_collect)—— 产线 Co-Pilot「经验工程师」Channel 的采集入口(计划 §5.1)。
 *
 * 行为:对可见产线(节点授权线 ∪ 频道绑线,权限口径 mirror ops_log 的 agentOpsScope)
 * 逐线执行 collectEpisodes(平台动作锚账本增量归因 + 推断动作快照 diff 入待确认队列),
 * 返回中文文本汇报:每条平台 episode 一行(时间/节点/旧→新/来源归因/证据锚/人工意见)、
 * 推断 pending 计数与提示、经验注册表概况。纯只读采集(不写产线,只写 exp-state)。
 */
import { agentOpsScope, fmtAuditAt } from './ops-tools'
import { collectEpisodes } from '../../exp/exp-collector'
import { getExpStateRepo } from '../../exp/exp-state.repo'
import { getDcwController } from '../../dcw/dcw-controller'
import { getDcwLineRepo } from '../../dcw/dcw-line.repo'

/** episode 来源 → 人话标签(汇报行内归因) */
const EXP_SOURCE_LABEL: Record<string, string> = {
  manual: '用户',
  agent: 'Agent',
  recipe: '配方/系统',
  inferred: '推断',
}

/** 经验注册表概况(按置信度计数;key 前缀 = `${lineId}:`) */
function registrySummary(lineId: string): string {
  const registry = getExpStateRepo().getState().registry
  let total = 0
  let watch = 0
  let cand = 0
  let stable = 0
  for (const [key, e] of Object.entries(registry)) {
    if (!key.startsWith(`${lineId}:`)) continue
    total++
    if (e.confidence === '观察') watch++
    else if (e.confidence === '候选') cand++
    else stable++
  }
  if (total === 0) return '经验注册表:暂无条目(总结入库后登记)'
  return `经验注册表:共 ${total} 条(观察 ${watch} / 候选 ${cand} / 稳 ${stable})`
}

/** 单条平台 episode 的汇报行(时间/节点/旧→新/来源归因/证据锚/人工意见) */
function episodeLine(e: { at: string, source: string, actor: string, params: Array<{ nodeId: string, from: number | null, to: number, unit?: string }>, anchors: string[], comments: string[] }): string {
  const src = EXP_SOURCE_LABEL[e.source] ?? e.source
  const changes = e.params.map((p) => {
    const node = getDcwController().byId(p.nodeId)
    return `${node?.name ?? p.nodeId} ${p.from ?? '?'}→${p.to}${p.unit ?? (node?.unit ?? '')}`
  }).join(';')
  const anchors = e.anchors.length > 0 ? ` | 锚:${e.anchors.join(',')}` : ''
  const comments = e.comments.length > 0 ? ` | 人工意见:${e.comments.join(' / ')}` : ''
  return `- [${fmtAuditAt(e.at)}] ${changes} | 来源=${src} 操作者=${e.actor || '—'}${anchors}${comments}`
}

/** 工具:exp_collect —— 采集产线经验动作(平台动作归因 + 推断动作待确认;重复调用幂等)。 */
export async function toolExpCollect(agentId: string, args: {
  line_id?: string
  lineId?: string
} = {}): Promise<{ text: string, isError?: boolean }> {
  const scope = agentOpsScope(agentId)
  if (!scope) return { text: '你尚未绑定任何工业节点,所在频道也未绑定产线,无可采集的产线(采集权限跟随节点绑定或频道绑线)。', isError: true }
  const readable = [...new Set([...scope.lineIds, ...scope.boundLineIds])]
  const wanted = String(args.line_id ?? args.lineId ?? '').trim()
  if (wanted && !readable.includes(wanted)) {
    return { text: `无权采集产线 ${wanted}(你的可读产线:${readable.join(', ') || '(无)'})。`, isError: true }
  }
  const lineIds = wanted ? [wanted] : readable
  if (lineIds.length === 0) return { text: '没有可采集的产线(绑定的节点均未挂线)。' }

  const sections: string[] = []
  let totalEpisodes = 0
  let totalPending = 0
  for (const lid of lineIds) {
    const line = getDcwLineRepo().byId(lid)
    try {
      const { episodes, confirmations } = await collectEpisodes(lid)
      totalEpisodes += episodes.length
      totalPending += confirmations.pending
      const parts: string[] = [`■ 产线 ${line?.name ?? lid}(${lid})`]
      if (episodes.length === 0) {
        parts.push('  平台动作:无新增(水位内无未消费的锚写入)')
      }
      else {
        parts.push(`  平台动作 ${episodes.length} 条(已入账,待总结):`)
        for (const e of episodes) parts.push(`  ${episodeLine(e)}`)
      }
      // 待总结作业队列:含历史入账的平台 episode 与"人工已确认转正"的推断 episode
      // ——学习 Channel 的总结对象以本队列为准(本轮新增只在首轮出现,确认转正发生在轮间)
      const workQueue = getExpStateRepo().listEpisodes({ lineId: lid, status: 'pending' })
      const inferredReady = workQueue.filter(e => e.kind === 'inferred')
      if (inferredReady.length > 0) {
        parts.push(`  已确认的推断动作 ${inferredReady.length} 条(已入账,待总结):`)
        for (const e of inferredReady) parts.push(`  ${episodeLine(e)} | 推断(人类已确认)`)
      }
      parts.push(`  推断动作:本轮新增 ${confirmations.added} 条待确认,累计 ${confirmations.pending} 条 —— 推断动作待人类在产线页确认后才会进入总结。`)
      parts.push(`  ${registrySummary(lid)}`)
      sections.push(parts.join('\n'))
    }
    catch (err) {
      sections.push(`■ 产线 ${line?.name ?? lid}(${lid})\n  采集失败:${err instanceof Error ? err.message : String(err)}(本线跳过,不阻塞其他产线)`)
    }
  }
  return {
    text: `经验采集完成(可读产线 ${lineIds.length} 条,新增 episode ${totalEpisodes} 条,待确认累计 ${totalPending} 条):\n\n${sections.join('\n\n')}\n\n说明:平台动作=平台有写入留痕的变更(锚账本证据 + audit_log 来源归因 + 人工裁决意见),可直接构造「情境→动作→效果」三元组;推断动作=SET 变化且时间窗内平台无写入(疑似现场本地调整),仅入待确认队列,未经人工确认不会进入经验总结(铁律)。采集幂等:水位与哈希双剔重,重复调用不产生重复 episode;经验总结入库后用 markEpisode 推进状态(pending→summarized→done)。`,
  }
}
