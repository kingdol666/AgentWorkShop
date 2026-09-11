/**
 * POST /api/system/config-groups —— 新建配置分组(设置页隔离分区)。
 *
 * body: { id?, label, labelKey?, description?, order?, collapsed?, collapsible?, icon? }
 *   id 省略时由 label 派生化名(耗时仍非法 → 400)。id 永久不可改(描述符按 id 归属)。
 * 新建分组落在 user 来源(管理员自建),可改可删。
 * 插件请走声明式通道(ctx.config.defineGroup / manifest.configGroups),
 * 那样插件卸载时分组会被自动摘除,不会残留空分区。
 *
 * 鉴权:仅 admin(改的是全局设置页结构)。
 */
import { readBody } from 'h3'
import { defineApiHandler } from '../../../utils/response'
import { requireRole } from '../../workshop/caller'
import { getSystemConfigService } from '../../../services/system-config'

/** 由展示名派生合法 id(中文等非 ASCII 直接丢弃,A…Z0-9_- 保留) */
function slugify(label: string): string {
  const ascii = label
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32)
  return ascii || `group-${Date.now().toString(36)}`
}

export default defineApiHandler(async (event) => {
  requireRole(event, ['admin'])
  const body = (await readBody(event)) ?? {}
  const id = String(body.id ?? '').trim() || slugify(String(body.label ?? ''))
  const group = getSystemConfigService().createGroup({ ...body, id })
  return { ok: true, group }
})
