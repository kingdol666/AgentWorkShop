/**
 * DELETE /api/workshop/daq/:id —— 删除数采节点(广播 removed;绑定设备不受影响)。
 * 鉴权:与 PATCH 同口径 —— 删除会级联清理该节点的全部 Agent 绑定与配方监控窗口,
 * 属控制面写操作,须对产线有「可操控」权限(早先此处只 resolveUser,
 * 任何登录用户可删任意节点,而它的兄弟 PATCH 却已校验 —— 前后不一致)。
 */
import { getRouterParam } from 'h3'
import { resolveUser } from '@/server/api/workshop/caller'
import { defineApiHandler } from '@/server/utils/response'
import { requireLineMode } from '@/server/services/workshop/permissions'
import { bindDaqHost } from '@/server/services/workshop/daq/host-bindings'
import { getDaqController } from '@/server/services/workshop/daq/daq-controller'
import { broadcastSceneEvent } from '../../../services/workshop/scene-events'
import { recordOps } from '../../../services/workshop/ops/ops'

export default defineApiHandler((event) => {
  const user = resolveUser(event)
  bindDaqHost(broadcastSceneEvent)
  const id = getRouterParam(event, 'id') ?? ''
  const node = getDaqController().byId(id)
  // 节点不存在时保持原有的幂等删除语义(返回 id),但不得借不存在绕过权限
  if (node) requireLineMode(user, node.lineId, 'operate')
  getDaqController().remove(id)
  recordOps({
    actor: user.id,
    actorName: user.name,
    actorKind: 'user',
    action: 'daq.node.delete',
    kind: 'daq',
    targetKind: 'daq-node',
    targetId: id,
    summary: `删除数采节点「${node?.name ?? id}」`,
    lineId: node?.lineId ?? '',
  })
  return { id }
})
