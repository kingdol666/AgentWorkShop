/**
 * GET /api/workshop/optimization/profiles —— Profile 列表(用户私有:owner+admin 可见,D16)
 * POST —— 登记 draft(校验模型/求解器兼容;published 不可变)
 */
import { getQuery, readBody } from 'h3'
import { defineApiHandler } from '@/server/utils/response'
import { requireRole } from '@/server/api/workshop/caller'
import { getAmlRuntime } from '@/server/services/workshop/aml/runtime'
import { getProfileRepo, parseProfileRow } from '@/server/services/workshop/optimization/profile.repo'
import { assertProfileSolverCompatible, type OptimizationProfile } from '@/server/services/workshop/optimization/contracts'
import { canSeeProfile, recordConfigAction } from '@/server/services/workshop/optimization/access'
import { AppError } from '@/server/utils/errors'

export default defineApiHandler(async (event) => {
  const user = requireRole(event, ['admin', 'editor'])
  const method = event.method?.toUpperCase() ?? 'GET'
  if (method === 'GET') {
    const q = getQuery(event)
    // 列表静默过滤(不枚举他人 Profile;跨用户访问走 assertOptimizationAccess 显式拒绝+审计)
    const rows = getProfileRepo().list({ status: typeof q.status === 'string' ? q.status : undefined, limit: 200 })
      .filter(r => canSeeProfile(user, r))
    return { profiles: rows.map(r => ({ ...r, profile: parseProfileRow(r) })) }
  }
  const body = await readBody<Record<string, unknown>>(event) ?? {}
  const profile = body as unknown as OptimizationProfile
  if (!profile?.id || !profile.modelRef?.modelId || !profile.solverRef || !profile.problemTemplateRef) {
    throw new AppError(422, 'PROFILE_INVALID', 'id / modelRef / solverRef / problemTemplateRef 必填')
  }
  const model = getAmlRuntime().repo.model.get(profile.modelRef.modelId)
  if (!model) throw new AppError(404, 'MODEL_NOT_FOUND', `模型 ${profile.modelRef.modelId} 不存在`)
  // 模型工件类型/接口以注册表为准(客户端不能自填)
  profile.modelRef.artifactKind = (model.artifactKind || 'onnx_one_step@1') as OptimizationProfile['modelRef']['artifactKind']
  profile.modelRef.modelInterface = (model.modelInterface || 'one_step') as OptimizationProfile['modelRef']['modelInterface']
  profile.modelRef.artifactHash = model.artifactHash || profile.modelRef.artifactHash || ''
  profile.modelRef.stage = model.stage
  assertProfileSolverCompatible(profile)
  const row = getProfileRepo().insert({ ...profile, status: 'draft' }, user.id)
  recordConfigAction(user, 'optimizer.profile.create', { kind: 'optimizer_profile', id: `${profile.id}@${profile.version}` },
    `登记 Optimizer Profile ${profile.id}@${profile.version}(solver=${profile.solverRef})`, { solverRef: profile.solverRef, modelId: profile.modelRef.modelId })
  return { profile: row }
})
