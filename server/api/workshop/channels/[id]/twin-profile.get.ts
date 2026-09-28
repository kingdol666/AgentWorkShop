/**
 * GET /api/workshop/channels/:id/twin-profile —— 读 Channel 的 AML 孪生 profile。
 * 返回 profile/optimization_mode/objective/boundModelId/controlPolicy 与派生状态
 * (mode: exploration|model_backed;绑定模型的概要)。供前端 Channel 设置面与徽章消费。
 *
 * ?agentId=<成员实例id> 时附加 promptPreview:该成员当前组装的工况提示词
 * (prompt-composer 产出;模式/goal/绑定节点调试元数据),供设置面核对与验收断言。
 */
import { getRouterParam, getQuery } from 'h3'
import { resolveUser } from '@/server/api/workshop/caller'
import { defineApiHandler } from '@/server/utils/response'
import { AppError } from '@/server/utils/errors'
import { getChannelTwinProfile } from '@/server/services/workshop/aml/twin/channel-profile'
import { getAmlRuntime } from '@/server/services/workshop/aml/runtime'
import { composeChannelSystemPrompt } from '@/server/services/workshop/aml/twin/prompt-composer'
import { getWorkshopManager } from '@/server/plugins/workshop'

export default defineApiHandler((event) => {
  resolveUser(event)
  const id = getRouterParam(event, 'id') ?? ''
  if (!id) throw new AppError(400, 'VALIDATION_ERROR', 'channel id 必填')
  const q = getQuery(event)
  const agentId = typeof q.agentId === 'string' ? q.agentId : ''
  const p = getChannelTwinProfile(id)
  const model = p.boundModelId ? getAmlRuntime().repo.model.get(p.boundModelId) : null
  const mode = p.profile === 'aml_optimization'
    ? (p.optimizationMode === 'aml' && p.boundModelId ? 'model_backed' : 'exploration')
    : (p.profile === 'hybrid_twin' ? 'model_backed' : 'none')
  let promptPreview: string | null = null
  if (agentId) {
    try {
      const scenarioPrompt = getWorkshopManager().channelScenarioPrompt?.(id) ?? ''
      promptPreview = composeChannelSystemPrompt(id, agentId, scenarioPrompt)
    }
    catch { /* manager 未就绪:预览缺省 */ }
  }
  return {
    profile: p,
    derived: {
      mode,
      boundModel: model ? { id: model.id, label: model.label, stage: model.stage, objectiveId: model.objectiveId } : null,
      promptPreview,
    },
  }
})
