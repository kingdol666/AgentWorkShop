/**
 * GET /api/workshop/daq/export-file?job=&path= —— 导出产物安全下载。
 * 二进制响应**必须**走裸 defineEventHandler(过 defineApiHandler 会把 Buffer 序列化成
 * {type:'Buffer',...} 文本 —— frames/content.get.ts 记录的 84 字节事故)。
 * path 白名单:manifest.json | README.md | merged.csv | nodes/<safeId>.csv。
 */
import { getQuery, setHeader, defineEventHandler, createError } from 'h3'
import { readFileSync } from 'node:fs'
import { resolveUser } from '@/server/api/workshop/caller'
import { resolveExportFile } from '@/server/services/workshop/eda/data-export'

export default defineEventHandler(async (event) => {
  const user = resolveUser(event)
  const q = getQuery(event)
  const jobId = String(q.job ?? '')
  const rel = String(q.path ?? '')
  const hit = resolveExportFile(user, jobId, rel)
  if (!hit) {
    throw createError({ statusCode: 404, statusMessage: 'file not found' })
  }
  const buf = readFileSync(hit.abs)
  setHeader(event, 'content-type', hit.mime)
  setHeader(event, 'content-disposition', `attachment; filename="${rel.split('/').pop()}"`)
  setHeader(event, 'cache-control', 'no-store')
  return buf
})
