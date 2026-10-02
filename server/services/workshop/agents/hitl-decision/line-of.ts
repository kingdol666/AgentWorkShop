/**
 * line-of —— HITL 条目 → 产线锚点(权限模型 v3 / 定向推送依据)。
 *
 * 推导优先级:
 *   1. 工具审批单的 nodeId 载荷:『recipe-propose:<配方id>』→ 配方所在产线;
 *      裸节点 id(daq/dcw)→ 节点归属产线;
 *   2. 回退 channel.line_id(绑线频道的成员审批);
 *   3. 都没有(纯协作频道的通用 ask)→ undefined = 不做产线过滤。
 * admin 裁决与频道审计轨迹不受本锚点影响 —— 这里只服务「定向推送/快照可见性」。
 */
import { getDcwController } from '../../dcw/dcw-controller'
import { getDaqNodeRepo } from '../../daq/daq-node.repo'

export interface HitlItemLike {
  nodeId?: string
  lineId?: string
  kind?: string
}

export function lineOfHitlItem(item: HitlItemLike, channelLineId?: string | null): string | null | undefined {
  if (item.lineId) return item.lineId
  const nodeId = String(item.nodeId ?? '').trim()
  if (nodeId) {
    const m = /^recipe-propose:(.+)$/.exec(nodeId)
    const recipeId = m ? m[1] : ''
    if (recipeId) {
      const recipe = getDcwController().listRecipes().find(r => r.id === recipeId)
      if (recipe?.lineId) return recipe.lineId
    }
    else {
      const daq = getDaqNodeRepo().byId(nodeId)
      if (daq?.lineId) return daq.lineId
      const dcw = getDcwController().byId(nodeId)
      if (dcw?.lineId) return dcw.lineId
    }
  }
  return channelLineId || undefined
}
