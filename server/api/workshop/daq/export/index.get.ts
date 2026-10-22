/**
 * GET /api/workshop/daq/export —— 我的可见导出任务台账(新→旧)。
 */
import { getQuery } from 'h3'
import { resolveUser } from '@/server/api/workshop/caller'
import { defineApiHandler } from '@/server/utils/response'
import { visibleExportJobs } from '@/server/services/workshop/eda/data-export'

export default defineApiHandler(async (event) => {
  const user = resolveUser(event)
  const q = getQuery(event)
  const limit = Number(q.limit) || 50
  const jobs = visibleExportJobs(user, limit)
  return { jobs, count: jobs.length }
})
