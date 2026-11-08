/**
 * POST /api/workshop/projects —— 创建 Project（自动创建 private 项目办公室频道 + project_leader）。
 */
import { z } from 'zod'
import { readValidatedBody } from 'h3'
import { resolveUser } from '../caller'
import { zValidator } from '../../../utils/validate'
import { defineApiHandler } from '../../../utils/response'
import { getProjectService } from '../../../services/workshop/projects/service'

const schema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  objective: z.string().min(1),
  successCriteria: z.array(z.string()).optional(),
  mode: z.enum(['observe', 'supervised', 'auto']).optional(),
  // 指控8(2026-11-08 生产审计):去默认 —— 曾 `?? 'mock'` 让用户不选就静默得到测试替身做
  // 生产 Project Leader。现须显式声明;确需 mock(演示/验收)请显式传 'mock'。
  leaderHarness: z.string().min(1, 'leaderHarness 必填:请显式声明项目 Leader 引擎(演示请传 "mock")'),
  leaderConfig: z.record(z.string(), z.unknown()).optional(),
  // PR20 Route 派发闭环：计划批准后按 dependsOn 就绪顺序自动派发（缺省 false）
  autoDispatch: z.boolean().optional(),
  // Router v3：新项目默认 technical（上游成果技术验收后才放行下游）；显式 legacy 可回退旧口径。
  routingPolicy: z.enum(['legacy', 'technical']).optional(),
  // Router v3：Leader route gate（none=提案待 owner 应用；leader=mode=auto 时即时应用）。
  routeGate: z.enum(['none', 'leader']).optional(),
  // Router v3：指定独立评审 Channel（L1 请求优先投递）。
  reviewerChannelId: z.string().optional(),
})

export default defineApiHandler(async (event) => {
  const user = resolveUser(event)
  const body = await readValidatedBody(event, zValidator(schema))
  return getProjectService().create({ ...body, routingPolicy: body.routingPolicy ?? 'technical' }, user)
})
