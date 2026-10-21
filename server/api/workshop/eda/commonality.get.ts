/**
 * GET /api/workshop/eda/commonality?line_id=&factor=node|chamber|recipe|hour
 * —— E5 坏批共性分析(lift 降序;bad 集=特征违例涉及批次)。
 */
import { getQuery } from 'h3'
import { resolveUser } from '@/server/api/workshop/caller'
import { defineApiHandler } from '@/server/utils/response'
import { AppError } from '@/server/utils/errors'
import { commonality, CommonalityError, type CommonalityFactor } from '@/server/services/workshop/eda/commonality'

const FACTORS: CommonalityFactor[] = ['node', 'chamber', 'recipe', 'hour']

export default defineApiHandler(async (event) => {
  const user = resolveUser(event)
  const q = getQuery(event)
  const lineId = String(q.line_id ?? '')
  const factor = String(q.factor ?? 'node') as CommonalityFactor
  if (!lineId) throw new AppError(400, 'VALIDATION_ERROR' as never, 'line_id 必填。')
  if (!FACTORS.includes(factor)) throw new AppError(400, 'VALIDATION_ERROR' as never, `factor 只支持 ${FACTORS.join('/')}`)
  try {
    return commonality(user, { lineId, factor })
  }
  catch (err) {
    if (err instanceof CommonalityError) throw new AppError(err.status, 'SCOPE_VIOLATION' as never, err.message)
    throw err
  }
})
