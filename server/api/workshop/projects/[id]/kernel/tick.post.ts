/**
 * POST /api/workshop/projects/:id/kernel/tick —— owner 手动触发内核单项目处理
 * （事件消费/reconcile/effects/watchdog 扫描）。运维与验收用；定时器之外的确定性入口。
 */
import { getRouterParam } from 'h3'
import { defineApiHandler } from '../../../../../utils/response'
import { resolveUser } from '../../../caller'
import { getProjectService } from '../../../../../services/workshop/projects/service'
import { getProjectKernel } from '../../../../../services/workshop/projects/kernel'

export default defineApiHandler(async (event) => {
  const user = resolveUser(event)
  const id = getRouterParam(event, 'id')!
  getProjectService().assertProjectOwner(id, user)
  let kernel: ReturnType<typeof getProjectKernel>
  try {
    kernel = getProjectKernel()
  }
  catch {
    return { ok: false, reason: 'KERNEL_NOT_INITIALIZED' }
  }
  return { ok: true, ...(await kernel.processProject(id)) }
})
