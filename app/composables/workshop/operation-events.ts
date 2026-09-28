/* eslint-disable no-useless-assignment */
import type { AepEnvelope } from '#shared/workshop-protocol'

export type OperationKind = 'dcw' | 'daq' | 'aml' | 'twin' | 'safety' | 'other'
export type OperationSeverity = 'normal' | 'attention' | 'critical'

export interface OperationMeta {
  kind: OperationKind
  severity: OperationSeverity
  label: string
  icon: string
  summary: string
  value?: string
}

function textOf(e: AepEnvelope): string {
  const p = e.payload as Record<string, unknown> | undefined
  if (!p) return ''
  if (typeof p.text === 'string') return p.text
  if (typeof p.summary === 'string') return p.summary
  if (typeof p.message === 'string') return p.message
  if (e.type === 'agent.message' || e.type === 'a2a.message') {
    const parts = Array.isArray(p.parts) ? p.parts as Array<{ text?: string }> : []
    return parts.map(x => x.text ?? '').join(' ')
  }
  return ''
}

/** 产线工业工具名 → 域(与 host-tools.json 工业族对齐;用于消息文本的可靠着色) */
const INDUSTRIAL_TOOL_KIND: Array<[RegExp, OperationKind]> = [
  [/dcw_control|dcw_read|dcw_judge|dcw_rollback|dcw_journal|param_control|param_read|line_context|recipe_update|recipe_versions|recipe_rollback|recipe_log/, 'dcw'],
  [/my_industrial_nodes|ops_log|daq_frames|daq_query/, 'daq'],
  [/optimization_explore|aml_|twin_calibration/, 'aml'],
  [/twin_|mpc_optimize/, 'twin'],
]

function operationFromText(text: string): OperationKind {
  const s = text.toLowerCase()
  for (const [re, kind] of INDUSTRIAL_TOOL_KIND) {
    if (re.test(s)) return kind
  }
  if (/dcw|param_control|dcw_control|setpoint|写入|下发|plc/.test(s)) return 'dcw'
  if (/daq|daq_query|采集|数采|telemetry|reading/.test(s)) return 'daq'
  if (/aml|训练|training|dataset|模型|pinn|residual/.test(s)) return 'aml'
  if (/twin|孪生|mpc|gate|shadow|recommendation|物理模型/.test(s)) return 'twin'
  if (/reject|拒绝|超限|联锁|安全|safety|step_limit|interval/.test(s)) return 'safety'
  return 'other'
}

export function classifyOperation(e: AepEnvelope): OperationMeta | null {
  const p = e.payload as Record<string, unknown> | undefined
  const text = textOf(e)
  let kind: OperationKind = 'other'
  let severity: OperationSeverity = 'normal'
  let label = '作业'
  let icon = 'i-tabler-activity'
  let summary = text || e.type
  let value: string | undefined

  if (e.type === 'dcw.written') {
    kind = p?.ok ? 'dcw' : 'safety'
    severity = p?.ok ? 'attention' : 'critical'
    label = p?.ok ? 'DCW 已下发' : 'DCW 被拒绝'
    icon = p?.ok ? 'i-tabler-adjustments-horizontal' : 'i-tabler-shield-x'
    const node = String(p?.nodeName ?? p?.nodeId ?? '控制节点')
    const val = p?.value ?? p?.eng
    value = val == null ? undefined : String(val)
    summary = `${node}${value != null ? ` → ${value}` : ''}${p?.message ? ` · ${String(p.message)}` : ''}`
  }
  else if (e.type === 'dcw.optimization.changed') {
    kind = 'dcw'
    label = '调控闭环'
    icon = 'i-tabler-adjustments'
    summary = String((p?.record as Record<string, unknown> | undefined)?.hypothesis ?? p?.event ?? '优化记录更新')
  }
  else if (e.type === 'daq.reading') {
    kind = 'daq'
    label = 'DAQ 采集'
    icon = 'i-tabler-wave-sine'
    const node = String(p?.nodeName ?? p?.nodeId ?? '数采节点')
    const val = p?.value ?? p?.avg ?? p?.reading
    value = val == null ? undefined : String(val)
    summary = `${node}${value != null ? ` · ${value}` : ''}`
  }
  else if (e.type === 'daq.alarm' || e.type === 'daq.alarm.changed') {
    kind = 'safety'
    severity = e.type === 'daq.alarm' ? 'critical' : 'attention'
    label = '数采告警'
    icon = 'i-tabler-alert-triangle'
    summary = text || String(p?.rule ?? p?.metric ?? 'DAQ 告警状态变化')
  }
  else if (e.type === 'ops.log') {
    const action = String(p?.action ?? '')
    kind = /dcw|recipe|write|param/.test(action) ? 'dcw' : /daq|sample|reading/.test(action) ? 'daq' : /aml|train|dataset/.test(action) ? 'aml' : /twin|mpc|gate|shadow/.test(action) ? 'twin' : operationFromText(String(p?.summary ?? ''))
    severity = /reject|denied|拒绝|fail|error|超限/.test(String(p?.summary ?? '').toLowerCase()) ? 'critical' : 'attention'
    label = kind === 'dcw' ? '产线写控' : kind === 'daq' ? '数采作业' : kind === 'aml' ? 'AML 训练' : kind === 'twin' ? '孪生/MPC' : '运维事件'
    icon = kind === 'dcw' ? 'i-tabler-adjustments-horizontal' : kind === 'daq' ? 'i-tabler-wave-sine' : kind === 'aml' ? 'i-tabler-brain' : 'i-tabler-timeline'
    summary = String(p?.summary ?? p?.action ?? '运维事件')
  }
  else if (e.type === 'error') {
    kind = 'safety'
    severity = 'critical'
    label = '系统拒绝'
    icon = 'i-tabler-shield-x'
    summary = String(p?.message ?? '系统错误')
  }
  else if (e.type === 'agent.status.message' || e.type === 'agent.message' || e.type === 'a2a.message') {
    kind = operationFromText(text)
    if (kind === 'other') return null
    label = kind === 'dcw' ? 'Agent 写控' : kind === 'daq' ? 'Agent 取数' : kind === 'aml' ? 'Agent 训练' : kind === 'twin' ? 'Agent 孪生' : '安全卡控'
    icon = kind === 'dcw' ? 'i-tabler-adjustments-horizontal' : kind === 'daq' ? 'i-tabler-wave-sine' : kind === 'aml' ? 'i-tabler-brain' : kind === 'twin' ? 'i-tabler-timeline' : 'i-tabler-shield-lock'
    severity = /reject|拒绝|超限|failed|error|失败/.test(text.toLowerCase()) ? 'critical' : 'attention'
  }
  else if (e.type === 'task.status' || e.type === 'task.progress') {
    kind = operationFromText(String(p?.title ?? p?.state ?? ''))
    if (kind === 'other') return null
    label = kind === 'aml' ? 'AML 任务' : kind === 'twin' ? '孪生任务' : '产线任务'
    icon = kind === 'aml' ? 'i-tabler-brain' : kind === 'twin' ? 'i-tabler-timeline' : 'i-tabler-player-play'
    summary = String(p?.title ?? p?.state ?? '任务状态')
  }
  else {
    return null
  }

  return { kind, severity, label, icon, summary: summary.replace(/\s+/g, ' ').trim().slice(0, 220), value }
}

export function operationPhase(items: AepEnvelope[]): { label: string, tone: OperationSeverity } {
  let phase = '监视'
  let tone: OperationSeverity = 'normal'
  for (const e of items) {
    const text = textOf(e).toLowerCase()
    if (/production|online|生产/.test(text)) {
      phase = '生产'
      tone = 'attention'
    }
    else if (/shadow|影子/.test(text)) {
      phase = '影子验证'
      tone = 'attention'
    }
    else if (/precise_search|gate passed|gate通过|门禁通过/.test(text)) {
      phase = '推荐搜索'
      tone = 'attention'
    }
    else if (/safe_small_step|exploration|探索/.test(text)) {
      phase = '探索 · 小步'
      tone = 'attention'
    }
  }
  return { label: phase, tone }
}
