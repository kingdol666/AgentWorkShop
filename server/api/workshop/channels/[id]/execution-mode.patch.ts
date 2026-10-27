/**
 * PATCH /api/workshop/channels/:id/execution-mode —— 切换频道执行模式(observe/manual/auto)。
 *
 * 计划:docs/plans/2026-10-28-execution-modes-plan.md(M1)。
 * 语义(fail-safe,max manual):
 *  - observe→manual/auto 与 manual→auto 是**加险方向**(放开写面/放开审批),
 *    必须显式 confirm:true(严格布尔),否则 400 MODE_CONFIRM_REQUIRED;
 *  - auto→manual、auto/manual→observe 是降险方向,免 confirm;
 *  - 同名 mode → noop 直接返回现值。
 * 切换 owner-only(与频道管理字段同守卫);变更 recordOps 审计入档,并回收频道成员
 * 运行时(下次装配注入新执行模式提示,与 twin-profile.patch 同语义)。
 */
import { z } from 'zod'
import { getRouterParam, readValidatedBody } from 'h3'
import { resolveUser } from '../../caller'
import { zValidator } from '../../../../utils/validate'
import { defineApiHandler } from '../../../../utils/response'
import { AppError } from '../../../../utils/errors'
import { getWorkshopManager } from '../../../../plugins/workshop'
import { getChannelTwinProfile, setHybridChannelProfile } from '@/server/services/workshop/aml/twin/channel-profile'
import { normalizeExecutionMode, resolveExecutionModeChange } from '@/server/services/workshop/agents/execution-mode'
import { getAgentNodeBindingRepo } from '@/server/services/workshop/agents/node-bindings.repo'
import { lineIdOfBinding } from '@/server/services/workshop/agents/binding-authz'
import { getDcwLineRepo } from '@/server/services/workshop/dcw/dcw-line.repo'
import { recordOps } from '@/server/services/workshop/ops/ops'

const patchSchema = z.object({
  mode: z.enum(['observe', 'manual', 'auto']),
  confirm: z.boolean().optional(),
})

/** 生效全景(频道模式 × 产线总闸 × 绑定分布):供设置面展示"实际生效什么" */
function effectiveSummary(channelId: string, channelLineId: string) {
  const mode = normalizeExecutionMode(getChannelTwinProfile(channelId).executionMode)
  const lineMode = channelLineId ? getDcwLineRepo().controlModeOf(channelLineId) : null
  let manualCount = 0
  let autoCount = 0
  try {
    if (channelLineId) {
      for (const b of getAgentNodeBindingRepo().all()) {
        if (b.kind !== 'dcw' && b.kind !== 'recipe') continue
        if (lineIdOfBinding(b) !== channelLineId) continue
        if (b.mode === 'manual') manualCount++
        else autoCount++
      }
    }
  }
  catch { /* 绑定面不可得(单测):计数留零 */ }
  return {
    channelMode: mode,
    lineMode,
    bindings: { manual: manualCount, auto: autoCount },
    // auto 被产线总闸压制:频道 auto 但线 manual → 实际每次下发仍挂审批
    suppressed: mode === 'auto' && lineMode === 'manual',
  }
}

export default defineApiHandler(async (event) => {
  const user = resolveUser(event)
  const channelId = getRouterParam(event, 'id') ?? ''
  if (!channelId) throw new AppError(400, 'VALIDATION_ERROR', 'channel id 必填')
  const body = await readValidatedBody(event, zValidator(patchSchema))
  const manager = getWorkshopManager()
  const channel = manager.requireChannelOwner(channelId, user, 'channel')

  const prev = getChannelTwinProfile(channelId)
  const current = normalizeExecutionMode(prev.executionMode)
  const decision = resolveExecutionModeChange(current, body.mode, body.confirm)
  if (!decision.ok) {
    throw new AppError(400, 'MODE_CONFIRM_REQUIRED', decision.error ?? '切换执行模式需显式风险确认')
  }
  if (!decision.noop) {
    setHybridChannelProfile({ ...prev, executionMode: body.mode, createdBy: 'api' })
    recordOps({
      at: new Date().toISOString(),
      actor: user.id,
      actorName: user.name,
      actorKind: 'user',
      action: 'channel.execution_mode',
      kind: 'system',
      summary: `频道执行模式切换 ${current}→${body.mode}`,
      targetKind: 'channel',
      targetId: channelId,
      detail: { channelId, fromMode: current, toMode: body.mode, confirmed: body.confirm === true },
    })
    // 执行模式变更 → 回收成员运行时:下次装配由提示词注入新执行模式卡(与 twin-profile 同语义)
    try {
      await manager.recycleChannelForTwinProfile(channelId)
    }
    catch { /* runtime 未就绪(如单测):跳过回收 */ }
  }
  const saved = normalizeExecutionMode(getChannelTwinProfile(channelId).executionMode)
  return { channelId, executionMode: saved, changed: !decision.noop, effective: effectiveSummary(channelId, channel.lineId ?? '') }
})
