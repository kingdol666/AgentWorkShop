/**
 * AML 优化循环活动状态(产线 Co-Pilot P2:只读查询 + `aml_activity` 工具)。
 *
 * 权威信号(按可用性组合,任一命中即「活动」;时间互斥是 recipe_propose 的硬闸,
 * 误报方向安全 —— 只会把下发降级为建议报告,不会漏禁):
 *   ① 绑定该产线的 Channel profile:非 legacy 档位 + 绑定模型 stage='production'
 *      +(control_policy 非 recommendation_only 或 optimization_mode='aml')
 *      —— 投用中的优化 Channel 是真实的「双写者」;
 *   ② aml_jobs 最近 running/queued 的优化作业,经 datasetId 联查 dataset.lineId
 *      (AmlJobRow 无 lineId 列);训练在跑 = 循环在动。
 *   注:不再用 audit 的 optimization.* 事件做兜底 —— 平台对每次 Agent 写都会记
 *   优化开窗(写路径 afterWrite),该口径会把普通 Agent 写误判成 AML 循环活动,
 *   令 Co-Pilot 被硬禁 30 分钟(实测假阳性,2026-10-01 主套件抓出后移除)。
 */
import { getAmlRuntime } from '../../aml/runtime'
import { getDcwLineRepo } from '../../dcw/dcw-line.repo'
import { agentOpsScope } from './ops-tools'

/** 信号②:仍在跑的作业状态(queued 起步,evaluating 收尾;done/failed/cancelled/interrupted/timeout 不算) */
const ACTIVE_JOB_STATUSES = ['queued', 'provisioning', 'training', 'evaluating'] as const

export interface AmlActivity {
  active: boolean
  reasons: string[]
}

/**
 * 信号归并(纯函数,可测):两路信号的理由行归并去重;任一理由即 active。
 * 单路信号自身异常由调用方消化(try/catch 后按「无信号」传入),不在此吞错。
 */
export function combineAmlActivitySignals(signals: {
  profileReasons: string[]
  jobReasons: string[]
}): AmlActivity {
  const reasons = [...signals.profileReasons, ...signals.jobReasons]
    .map(r => r.trim())
    .filter(r => r.length > 0)
  const seen = new Set<string>()
  const unique = reasons.filter((r) => {
    if (seen.has(r)) return false
    seen.add(r)
    return true
  })
  return { active: unique.length > 0, reasons: unique }
}

/** 信号①:绑定该产线的 Channel profile 投用判定(异常按无信号) */
function profileSignal(lineId: string): string[] {
  try {
    const rt = getAmlRuntime()
    const rows = rt.db.prepare(`
      SELECT p.channel_id AS channelId, p.profile AS profile, p.control_policy AS controlPolicy,
             p.optimization_mode AS optimizationMode, p.bound_model_id AS boundModelId
      FROM aml_channel_profiles p
      JOIN channels c ON c.id = p.channel_id
      WHERE c.line_id = ? AND c.enabled = 1
    `).all(lineId) as Array<{ channelId: string, profile: string, controlPolicy: string, optimizationMode: string | null, boundModelId: string | null }>
    const reasons: string[] = []
    for (const r of rows) {
      if (!r.profile || r.profile === 'legacy') continue
      // 投用判定:绑定模型须在 production(候选/退役不算);控制策略须非「仅建议」,
      // 或显式 aml 优化模式(策略缺省 recommendation_only 的 aml 模式 Channel 仍是真实写者)
      if (!r.boundModelId) continue
      const policyActive = (r.controlPolicy && r.controlPolicy !== 'recommendation_only') || r.optimizationMode === 'aml'
      if (!policyActive) continue
      const model = rt.repo.model.get(r.boundModelId)
      if (!model || model.stage !== 'production') continue
      reasons.push(`频道 ${r.channelId} 已投用 AML 优化模型 ${r.boundModelId}(production,策略 ${r.controlPolicy || '默认'}${r.optimizationMode === 'aml' ? ',aml 模式' : ''})`)
    }
    return reasons
  }
  catch {
    // AML 运行时未装配/查询失败 = 该路信号不可用(不阻断其余信号)
    return []
  }
}

/** 信号②:在跑优化作业经 datasetId 联查产线(异常按无信号) */
function jobSignal(lineId: string): string[] {
  try {
    const rt = getAmlRuntime()
    const reasons: string[] = []
    for (const status of ACTIVE_JOB_STATUSES) {
      for (const job of rt.repo.job.list({ status, limit: 50 })) {
        const ds = rt.repo.dataset.get(job.datasetId)
        if (ds?.lineId !== lineId) continue
        reasons.push(`AML 优化作业 ${job.id.slice(0, 8)} 进行中(${status},数据集 ${job.datasetId.slice(0, 8)})`)
      }
    }
    return reasons
  }
  catch {
    return []
  }
}

/** 产线 AML 优化循环活动判定(内部查询面;recipe_propose 硬闸与 aml_activity 工具共用) */
export function amlActivityForLine(lineId: string): AmlActivity {
  return combineAmlActivitySignals({
    profileReasons: profileSignal(lineId),
    jobReasons: jobSignal(lineId),
  })
}

/** 工具:aml_activity —— 查询产线 AML 优化循环是否活动(硬闸自查面;只读,不下发)。 */
export async function toolAmlActivity(agentId: string, args: {
  line_id?: string
} = {}): Promise<{ text: string, isError?: boolean }> {
  const scope = agentOpsScope(agentId)
  if (!scope) return { text: '你尚未绑定任何工业节点,所在频道也未绑定产线,无产线可查(权限跟随节点绑定或频道绑线)。', isError: true }
  const readable = [...new Set([...scope.lineIds, ...scope.boundLineIds])]
  const wanted = String(args.line_id ?? '').trim()
  if (wanted && !readable.includes(wanted)) {
    return { text: `无权查询产线 ${wanted} 的 AML 活动状态(你的可读产线:${readable.join(', ') || '(无)'})。`, isError: true }
  }
  const lineIds = wanted ? [wanted] : readable
  if (lineIds.length === 0) return { text: '没有可查询的产线(绑定的节点均未挂线)。' }

  const sections = lineIds.map((lid) => {
    const line = getDcwLineRepo().byId(lid)
    const state = amlActivityForLine(lid)
    const head = `■ 产线 ${line?.name ?? lid}(${lid}):AML 优化循环${state.active ? '**活动**' : '不活动'}`
    if (!state.active) {
      return `${head}\n  判定依据:两路信号(频道投用模型 / 在跑优化作业)均无命中。`
    }
    return `${head}\n${state.reasons.map(r => `  - ${r}`).join('\n')}`
  })
  return {
    text: `AML 优化循环活动状态(产线 ${lineIds.length} 条):\n\n${sections.join('\n\n')}\n\n说明:活动 = 存在投用中的 AML 优化 Channel(production 模型)或在跑的优化作业。**活动期间禁止整包下发(recipe_propose 会被硬闸拒绝)**,请降级为建议报告;时间互斥是防「双写者」的铁律,不适用于单参数只读查询。普通 Agent 参数写的优化记录不计入(非 AML 循环)。`,
  }
}
