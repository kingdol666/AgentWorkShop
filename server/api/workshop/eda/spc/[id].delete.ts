/**
 * DELETE /api/workshop/eda/spc/:id —— 删除控制图(见 [id].get.ts;Nitro 方法分文件)。
 */
import { getRouterParam } from 'h3'
import { resolveUser } from '@/server/api/workshop/caller'
import { defineApiHandler } from '@/server/utils/response'
import { AppError } from '@/server/utils/errors'
import { deleteSpcChart } from '@/server/services/workshop/eda/spc'

export default defineApiHandler(async (event) => {
  const user = resolveUser(event)
  const id = getRouterParam(event, 'id') ?? ''
  const ok = deleteSpcChart(user, id)
  if (!ok) throw new AppError(404, 'NOT_FOUND' as never, `控制图不存在或不可见: ${id}`)
  return { deleted: true }
})
