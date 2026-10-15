/**
 * 工艺参数语义面辅助(参数引用解析/量程文本/写容差)与 param_control 的 v2 禁用桩
 * (由 server/services/workshop/agents/industrial-tools.ts 按职责拆出;内容逐行原文搬运)
 */
import type { DcwParamView } from '../../../../../shared/dcw-protocol'
import { getDcwController } from '../../dcw/dcw-controller'
import { getDcwParamRepo } from '../../dcw/param-map.repo'
import { limitsBreakdownOf } from '../../dcw/param-limits'

/** 读/设定偏差对照容差(与服务端回读死区同口径) */
export function writeToleranceOf(node: { decimals: number, min: number, max: number }): number {
  return Math.max(0.5 * 10 ** -node.decimals, (node.max - node.min) * 0.005)
}

/** 工艺参数解析(param_control/param_read 共用):pp-id 优先,其次按 key;跨产线同名需 line_id 消歧 */
export function resolveParamRef(ref: string, lineId?: string): { ok: true, param: DcwParamView } | { ok: false, text: string, isError: true } {
  const repo = getDcwParamRepo()
  const trimmed = String(ref ?? '').trim()
  if (!trimmed) {
    return { ok: false, text: 'param 必填:工艺参数 id(pp-*)或参数 key(见 my_industrial_nodes)。', isError: true }
  }
  const row = trimmed.startsWith('pp-') ? repo.byId(trimmed) : undefined
  if (row) {
    const view = repo.viewOf(row)
    if (!view) return { ok: false, text: `工艺参数 ${trimmed} 的执行节点已不存在(映射悬空)。`, isError: true }
    if (lineId && view.lineId !== lineId) {
      return { ok: false, text: `工艺参数 ${view.key} 不属于产线 ${lineId}(实际归属:${view.lineId || '未分配'})。`, isError: true }
    }
    return { ok: true, param: view }
  }
  const hits = repo.byKey(trimmed)
    .map(r => repo.viewOf(r))
    .filter((v): v is DcwParamView => v != null)
  const scoped = lineId ? hits.filter(v => v.lineId === lineId) : hits
  if (scoped.length === 1) return { ok: true, param: scoped[0]! }
  if (scoped.length === 0) {
    const catalog = repo.listViews().slice(0, 12).map(v => `${v.key}(${v.name})`).join('、')
    return { ok: false, text: `未找到工艺参数「${trimmed}」${lineId ? `(产线 ${lineId})` : ''}。可用参数:${catalog || '无 —— 请先让用户创建写控节点生成参数面'}。`, isError: true }
  }
  return { ok: false, text: `工艺参数「${trimmed}」命中 ${scoped.length} 条同名映射,请附加 line_id 消歧或改用参数 id(${scoped.map(v => v.id).join(' / ')})。`, isError: true }
}

/** 参数面权限摘要(工具回包统一口径;不透出寄存器等 PLC 寻址细节) */
export function paramLimitsText(param: DcwParamView): string {
  const node = getDcwController().byId(param.nodeId)
  if (!node) return '执行节点已删除'
  const bd = limitsBreakdownOf(node)
  const layers = bd.layers.filter(l => l.min != null || l.max != null).map(l => l.label).join(' ∩ ')
  return `有效写入区间 ${bd.effective.min}~${bd.effective.max}${param.unit}(约束层:${layers || '无'});单步上限=${bd.stepLimit == null ? '未配置' : `${bd.stepLimit}${param.unit}`}(${bd.stepLimitSource});Agent写入间隔≥60s`
}

/** 工具:param_control —— 按工艺参数下发设定值(推荐的参数语义寻址面)。
 *  权限沿用节点绑定(参数 → 执行节点);限界联锁(参数基准 ∩ 产品 ∩ 配方 ∩ 节点安全量程)
 *  在网关咽喉点统一生效。args.hypothesis 声明本次假设(入册),args.task_id 关联任务。 */
export async function toolParamControl(agentId: string, args: {
  param?: string
  value?: number | string
  hypothesis?: string
  task_id?: string
  line_id?: string
}, channelId?: string): Promise<{ text: string, isError?: boolean }> {
  void agentId
  void args
  void channelId
  return {
    text: '参数直写已禁用(权限模型 v2):Agent 不再直接改写运行中的工艺参数。请改用绑定的配方 —— recipe_update(写入新版本)/ recipe_apply(整批下发)/ recipe_trial(候选试验);治理联锁与 HITL 在配方面照常生效。',
    isError: true,
  }
}
