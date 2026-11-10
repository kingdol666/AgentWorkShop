/**
 * POST /api/workshop/channels/:id/harness-bench-runs —— 落库一次配对评测（bench 门证据）。
 *
 * body: { profileId, baselineProfileId?, pValue?, primaryDelta?, costDelta?, seeds?, perSeed[], excluded? }
 * 权限：channel owner/admin（评测证据只能由人提交；Agent 工具面不可达）。
 *
 * 服务端不信任汇总值：用 perSeed 复算 primaryDelta/costDelta，与自报不一致直接拒绝；
 * 落库后 promote→active 只能引用返回的 runId。
 */
import { z } from 'zod'
import { getRouterParam, readValidatedBody } from 'h3'
import { zValidator } from '../../../../../utils/validate'
import { defineApiHandler } from '../../../../../utils/response'
import { AppError } from '../../../../../utils/errors'
import { getWorkshopManager } from '../../../../../plugins/workshop'
import { resolveUser } from '../../../caller'
import { getAmlRuntime } from '../../../../../services/workshop/aml/runtime'
import { recordBenchRun } from '../../../../../services/workshop/experience/bench-run'

const seedRow = z.object({
  seed: z.number(),
  a: z.number(),
  b: z.number(),
  costA: z.number().optional(),
  costB: z.number().optional(),
})

const schema = z.object({
  profileId: z.string().trim().min(1, 'profileId required'),
  baselineProfileId: z.string().trim().optional(),
  pValue: z.number().min(0).max(1).nullable().optional(),
  primaryDelta: z.number().optional(),
  costDelta: z.number().optional(),
  seeds: z.array(z.number()).optional(),
  perSeed: z.array(seedRow).min(1, 'perSeed 不能为空'),
  excluded: z.number().int().nonnegative().optional(),
})

export default defineApiHandler(async (event) => {
  const channelId = getRouterParam(event, 'id')!
  const user = resolveUser(event)
  const manager = getWorkshopManager()
  const ch = manager.getChannelForUser(channelId, user.id)
  manager.requireOwned(ch.ownerUserId, user.id, 'channel')
  const body = await readValidatedBody(event, zValidator(schema))
  const res = recordBenchRun(getAmlRuntime().db, { channelId, actor: user.id, artifact: body })
  if (!res.ok) throw new AppError(400, 'BENCH_INVALID', res.reasons.join('；'))
  return {
    runId: res.run.id,
    pValue: res.run.pValue,
    primaryDelta: res.run.primaryDelta,
    costDelta: res.run.costDelta,
    pairs: res.run.pairs,
    excluded: res.run.excluded,
    artifactSha256: res.run.artifactSha256,
  }
})
