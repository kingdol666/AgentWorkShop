/**
 * 项目上下文提示词（V1 PR8）：leader/member 回合自动注入。
 *
 * 事实源：ProjectService.agentProjectBrief（不返回凭证/配置）；
 * 任何解析失败都降级为空串，不阻断非项目 Channel 的既有 prompt 组装。
 */
import { renderPrompt } from '../prompts/loader'
import { parseJson } from '../db/database'
import { getProjectService } from './service'

function listOrNone(lines: string[]): string {
  return lines.length > 0 ? lines.join('\n') : '- (无)'
}

export function projectPromptSection(agentId: string): string {
  try {
    const brief = getProjectService().agentProjectBrief(agentId)
    const p = brief.project
    const successCriteria = parseJson<string[]>(p.successCriteriaJson, []).join('；') || '(未定义)'
    const deliverables = listOrNone(brief.deliverables.map(d =>
      `- ${d.name} [${d.status}]${d.required === 1 ? ' (必选)' : ''} id=${d.id}${d.ownerChannelId ? ` channel=${d.ownerChannelId}` : ''}`,
    ))
    const workItems = listOrNone(brief.workItems.map(w =>
      `- ${w.title} [${w.state}] channel=${w.channelId} budget=${w.execBudgetMinutes}min id=${w.id}`,
    ))
    const vars = {
      projectName: p.name,
      projectId: p.id,
      officeChannelId: p.officeChannelId ?? '',
      objective: p.objective,
      successCriteria,
      status: p.status,
      planVersion: p.planVersion,
      pendingApprovals: brief.pendingApprovals,
      deliverables,
      workItems,
      channelId: brief.channelId,
      role: brief.role,
    }
    const rendered = brief.isLeader ? renderPrompt('project-leader', vars) : renderPrompt('project-member', vars)
    // P1-8 Leader 重开对账惯例（代码级单源，避免 home 模板分歧）：状态机侧 reconcile
    // 由内核 tick 自动补齐，但 leader（LLM）自身的推理上下文不会自动刷新——重开/久隔
    // 后首回合先 project_get_status 对账，再继续发言。
    const preamble = brief.isLeader
      ? '【对账惯例】回合开始时先调用 project_get_status 自对账（离线期间的事件已由内核自动补齐，以状态查询结果为准），再继续决策或发言。\n\n'
      : ''
    return preamble + rendered
  }
  catch {
    return ''
  }
}
