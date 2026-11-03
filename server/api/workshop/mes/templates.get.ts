/**
 * GET /api/workshop/mes/templates —— MES 映射模板库目录(H8)。
 * 只返回模板元数据(路径骨架/参数/能力位),不返回任何凭据或节点配置。
 */
import { resolveUser } from '@/server/api/workshop/caller'
import { defineApiHandler } from '@/server/utils/response'
import { listMesTemplates } from '@/server/services/workshop/mes/mes-templates'

export default defineApiHandler(async (event) => {
  resolveUser(event)
  const templates = listMesTemplates()
  return { templates, count: templates.length }
})
