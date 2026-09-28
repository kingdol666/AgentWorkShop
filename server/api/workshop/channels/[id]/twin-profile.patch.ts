/**
 * PATCH /api/workshop/channels/:id/twin-profile —— 更新 Channel 的 AML 孪生 profile。
 *
 * 支持三组互不冲突的更新(均可单独提交):
 *  - optimizationMode: 'exploration'|'aml'(仅 aml_optimization profile;切 aml 需已有绑定或同请求绑定)
 *  - objective: ObjectiveProfile(goal 下发;补齐历史缺口 —— 此前 objective 只能模板注入)
 *  - boundModelId: 绑定/解绑模型。绑定 fail-closed 校验:谱系(产线)与场景一致 + Twin Gate
 *    全过(recommendationEligible/uq/ood/physics)+ stage ∈ production/shadow,否则 409。
 *    解绑(boundModelId=null)自动回落探索模式。
 * controlPolicy 同步可改(治理档位)。
 */
import { z } from 'zod'
import { getRouterParam, readValidatedBody } from 'h3'
import { resolveUser } from '@/server/api/workshop/caller'
import { zValidator } from '@/server/utils/validate'
import { defineApiHandler } from '@/server/utils/response'
import { AppError } from '@/server/utils/errors'
import { getChannelTwinProfile, setHybridChannelProfile, assertModelBindableToChannel } from '@/server/services/workshop/aml/twin/channel-profile'
import { getWorkshopManager } from '@/server/plugins/workshop'

const patchSchema = z.object({
  optimizationMode: z.enum(['exploration', 'aml']).optional(),
  controlPolicy: z.enum(['recommendation_only', 'hitl_governed', 'bounded_auto']).optional(),
  objective: z.record(z.string(), z.unknown()).optional(),
  boundModelId: z.string().min(1).nullable().optional(),
})

export default defineApiHandler(async (event) => {
  resolveUser(event)
  const id = getRouterParam(event, 'id') ?? ''
  if (!id) throw new AppError(400, 'VALIDATION_ERROR', 'channel id 必填')
  const body = await readValidatedBody(event, zValidator(patchSchema))
  const prev = getChannelTwinProfile(id)
  if (prev.profile !== 'aml_optimization' && prev.profile !== 'hybrid_twin') {
    throw new AppError(409, 'AML_PROFILE_NOT_TUNABLE', `Channel profile=${prev.profile} 无优化控制配置可更新(仅 aml_optimization/hybrid_twin)。`)
  }
  const next = { ...prev }

  if (body.objective !== undefined) next.objective = body.objective
  if (body.controlPolicy !== undefined) next.controlPolicy = body.controlPolicy

  if (body.boundModelId !== undefined) {
    if (body.boundModelId === null) {
      next.boundModelId = undefined
      next.boundAt = undefined
      if (next.profile === 'aml_optimization') next.optimizationMode = 'exploration'
    }
    else {
      if (prev.profile !== 'aml_optimization' && prev.profile !== 'hybrid_twin') throw new AppError(409, 'AML_BIND_NOT_OPTIMIZATION', '仅工艺优化 Channel 可绑定模型。')
      const ok = assertModelBindableToChannel(id, body.boundModelId)
      next.boundModelId = ok.modelId
      next.boundAt = new Date().toISOString()
      if (prev.profile === 'aml_optimization') next.optimizationMode = 'aml'
    }
  }
  if (body.optimizationMode !== undefined) {
    if (prev.profile !== 'aml_optimization') throw new AppError(409, 'AML_MODE_NOT_OPTIMIZATION', 'optimizationMode 仅适用于工艺优化 Channel。')
    if (body.optimizationMode === 'aml' && !next.boundModelId) {
      throw new AppError(409, 'AML_MODE_REQUIRES_MODEL', '切换到 aml 模式前需先绑定通过门禁的模型(同请求可一并提交 boundModelId)。')
    }
    next.optimizationMode = body.optimizationMode
  }

  setHybridChannelProfile({ ...next, createdBy: 'api' })
  // 模式/绑定/goal 变更 → 回收成员运行时:下次装配由 prompt-composer 注入新工况提示词
  try {
    await getWorkshopManager().recycleChannelForTwinProfile(id)
  }
  catch { /* runtime 未就绪(如单测):跳过回收 */ }
  const saved = getChannelTwinProfile(id)
  return { profile: saved, mode: saved.optimizationMode === 'aml' && saved.boundModelId ? 'model_backed' : 'exploration' }
})
