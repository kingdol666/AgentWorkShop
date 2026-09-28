/** GET /api/workshop/aml/training-plans —— 建模任务列表(AML 界面「建模任务」区块数据源) */
import { resolveUser } from '@/server/api/workshop/caller'
import { defineApiHandler } from '@/server/utils/response'
import { listTrainingPlans } from '@/server/services/workshop/aml/twin/training-plans'

export default defineApiHandler((event) => {
  resolveUser(event)
  return { plans: listTrainingPlans() }
})
