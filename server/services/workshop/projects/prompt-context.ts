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
    return brief.isLeader ? renderPrompt('project-leader', vars) : renderPrompt('project-member', vars)
  }
  catch {
    return ''
  }
}
