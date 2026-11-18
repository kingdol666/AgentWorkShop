/**
 * 回执与结果归一(WS-2 I6):sweep / diag_status / wait 循环共用同一套
 * 完成态字段与回执文本,避免三处各自拼装导致形状漂移。
 */
import { intentLabel } from './intents.mjs'

/** 终态集合(v1 六态去掉 awaiting_input —— awaiting_input 单列,不冒充终态) */
export const TERMINAL_STATUSES = new Set(['completed', 'failed', 'stopped', 'interrupted', 'expired'])

/** 该状态是否终态(awaiting_input 不计) */
export function isTerminal(status) {
  return TERMINAL_STATUSES.has(String(status ?? ''))
}

/** 回执通告(v1/legacy 同构;reportPath 可为绝对路径或 inline reportUrl 指引) */
export function buildNotice(meta, id) {
  const intent = meta.intent ?? 'deep-diagnosis'
  const label = intentLabel(intent)
  if (meta.status === 'completed') {
    const reportPath = meta.reportPath ?? null
    const reportUrl = meta.reportUrl ?? null
    return {
      kind: 'tool-result',
      tool: 'diag_run',
      jobId: id,
      agentId: meta.agentId,
      ...(meta.channelId ? { channelId: meta.channelId } : {}),
      ok: true,
      title: `${label}完成(产线 ${meta.line})`,
      summary: [
        meta.score != null ? `评分=${meta.score}` : '',
        meta.verdict ? `结论=${meta.verdict}` : '',
        meta.summary ? `总结=${String(meta.summary).slice(0, 400)}` : '',
        reportPath ? `report_md_path=${reportPath}` : '',
        reportUrl ? `report_url=${reportUrl}` : '',
        `入库知识库:调用 diag_deposit(run_id=${id})(一键入 aw-docs 文档库并检索自查);需要结构化经验沉淀时再用 kb_agent(action=ingest,目标 aw-industrial)。`,
      ].filter(Boolean).join(';'),
    }
  }
  const statusText = meta.status === 'stopped' ? '已停止' : meta.status === 'expired' ? '已过期' : '失败'
  return {
    kind: 'tool-result',
    tool: 'diag_run',
    jobId: id,
    agentId: meta.agentId,
    ...(meta.channelId ? { channelId: meta.channelId } : {}),
    ok: false,
    title: `${label}${statusText}(产线 ${meta.line})`,
    summary: meta.error
      ? `原因:${meta.error}`
      : `任务以 ${meta.status} 结束;可用 diag_status(run_id=${id}) 查询详情。`,
  }
}

/** 完成态字段落 kv 的统一形状(legacy/v1 共用) */
export function completedMeta(cur, normalized, extra = {}) {
  return {
    ...cur,
    ...extra,
    status: 'completed',
    completedAt: cur.completedAt ?? Date.now(),
    score: normalized.score ?? null,
    verdict: normalized.verdict ?? null,
    summary: normalized.summary ?? '',
    reportPath: normalized.reportPath ?? null,
    reportUrl: normalized.reportUrl ?? null,
    pollErrors: 0,
    deliverPending: Boolean(cur.agentId),
  }
}

/** 非完成终态的统一形状 */
export function terminalMeta(cur, status, error, extra = {}) {
  return {
    ...cur,
    ...extra,
    status,
    completedAt: Date.now(),
    error: error ?? cur.error ?? null,
    pollErrors: 0,
    deliverPending: Boolean(cur.agentId),
  }
}
