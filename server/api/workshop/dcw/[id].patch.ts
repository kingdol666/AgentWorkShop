/**
 * PATCH /api/workshop/dcw/:id —— 单节点参数(名称/驱动/保写周期/量程/启停/落点)。
 *
 * 鉴权:与 write/test/bind 同口径 requireLineMode(..., 'operate')。
 * 本端点可改 driverConfig(落点 host:register)、min/max(直接决定 writeTolerance)、
 * holdIntervalMs(保写心跳周期)与 enabled —— 改完之后**网关自己的心跳**就会把
 * 该节点的既有设定值写进攻击者指定的目标。即「改参数」等价于「远程写 PLC」,
 * 早先此处只有 resolveUser,任何登录用户(零产线授权)都能改任意节点。
 */
import { createError, getRouterParam, readBody } from 'h3'
import type { DcwPatchInput } from '@/server/services/workshop/dcw/dcw-controller'
import { resolveUser } from '@/server/api/workshop/caller'
import { defineApiHandler } from '@/server/utils/response'
import { AppError } from '@/server/utils/errors'
import { requireLineMode } from '@/server/services/workshop/permissions'
import { bindDcwBroadcast, getDcwController } from '@/server/services/workshop/dcw/dcw-controller'
import { broadcastSceneEvent } from '@/server/services/workshop/scene-events'
import { recordOps } from '@/server/services/workshop/ops/ops'

export default defineApiHandler(async (event) => {
  const user = resolveUser(event)
  bindDcwBroadcast(broadcastSceneEvent)
  const id = getRouterParam(event, 'id') ?? ''
  const body = await readBody<DcwPatchInput>(event) ?? {}
  const node0 = getDcwController().byId(id)
  if (!node0) throw createError({ statusCode: 404, statusMessage: `控制节点不存在: ${id}` })
  // 目标产线:允许本次 PATCH 迁移产线,则新产线也须有操控权(防止把节点搬到无权产线)
  const targetLine = body.lineId !== undefined ? String(body.lineId || '') || null : node0.lineId
  requireLineMode(user, targetLine, 'operate')
  // 落点/安全配置分权(2026-10-28):operate 只能改运行参数,不能改"往哪个设备写、
  // 量程/步限/保持窗、标定函数"。driverConfig 支持 hook/任意 host,等价于代码执行与
  // 跨线重定向,必须与 create 同权(admin)。此前这里只校验 operate。
  const ADMIN_ONLY_FIELDS = ['driver', 'driverConfig', 'transform', 'min', 'max', 'decimals', 'stepLimit', 'writeLockSeconds', 'lineId'] as const
  const deniedFields = ADMIN_ONLY_FIELDS.filter(k => body[k] !== undefined)
  if (deniedFields.length > 0 && user.role !== 'admin') {
    throw new AppError(403, 'DCW_CONFIG_ADMIN_ONLY', `字段「${deniedFields.join('/')}」决定设备落点与安全限界，仅管理员可修改（当前角色 ${user.role}）。运行参数（name/enabled/holdIntervalMs/readIntervalMs/semantics/位置）可由产线操控者调整。`)
  }
  const node = getDcwController().patch(id, body)
  // 节点参数/落点/量程/启停变更 = 产线可写面变更,必须进产线日志(含跨线迁移)
  const changed = Object.keys(body)
  recordOps({
    actor: user.id, actorName: user.name, actorKind: 'user',
    action: 'dcw.patch', kind: 'line', targetKind: 'dcw-node', targetId: id,
    lineId: node.lineId ?? '',
    summary: `修改数控节点「${node.name}」(${changed.join('/') || '无变更'})${node0.lineId !== node.lineId ? `:产线 ${node0.lineId || '(无)'} → ${node.lineId || '(无)'}` : ''}`,
    detail: { keys: changed, fromLine: node0.lineId ?? '', toLine: node.lineId ?? '' },
  })
  return { node: node.toView() }
})
