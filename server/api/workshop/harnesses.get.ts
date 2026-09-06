/**
 * GET /api/workshop/harnesses —— 可用执行引擎注册表(前端下拉/能力徽标/可用性)。
 * 数据源 HARNESS_REGISTRY(单一事实源;与 factory/manager 校验同源)。
 * available = 环境探测:进程内引擎恒可用;进程型引擎按 PATH 探测外部 CLI。
 * ?refresh=1 跳过 30s 探测缓存强制重探(装包/改命令后立即见效)。
 */
import { getQuery } from 'h3'
import { resolveUser } from '@/server/api/workshop/caller'
import { defineApiHandler } from '@/server/utils/response'
import { checkAllHarnessAvailability } from '@/server/services/workshop/agents/harness-availability'
import { harnessMetas } from '@/server/services/workshop/agents/registry'

export default defineApiHandler(async (event) => {
  resolveUser(event)
  const q = getQuery(event)
  const refresh = q.refresh === '1' || q.refresh === 'true'
  const avail = checkAllHarnessAvailability({ refresh })
  const byId = new Map(avail.map(a => [a.id, a]))
  return {
    harnesses: harnessMetas().map(m => ({
      ...m,
      ...(byId.get(m.id) ?? { available: false, inprocess: false, command: null, resolvedPath: null, error: '探测失败' }),
    })),
  }
})
