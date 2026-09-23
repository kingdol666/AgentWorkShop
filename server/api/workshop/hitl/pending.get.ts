/**
 * GET /api/workshop/hitl/pending?channelId= —— 全局待人工处理快照。
 *
 * 统一视图:omp ask 对话框 + dcw 工具审批 + 各 harness 原生审批/提问
 * (hitl-registry 内存缓存门面)。WebUI 全局徽标与 TUI /hitl 命令共用;
 * 实时增量走 AEP hitl.request/hitl.resolved 帧,本端点为快照对齐/恢复入口。
 *
 * 鉴权(v17,§13.2):
 *  ① 用户 token;
 *  ② Channel 可见性 = listChannelsVisibleTo ∪ listChannelsForUser(遗留公共行只读兼容);
 *  ③ 逐条按**创建时冻结的策略快照**判定可裁决性(requireCanApprove:成员 + owner_only/
 *     any_member + 创建时资格 ∩ 当前资格)—— owner_only 的 Channel 只对 owner/admin 返回,
 *     普通成员看不到也办不了(与 respond 端点的裁决口径完全一致)。
 * 响应形状保持 `{ items }` 不变。
 */
import { getQuery } from 'h3'
import { resolveUser } from '@/server/api/workshop/caller'
import { defineApiHandler } from '@/server/utils/response'
import { getWorkshopManager } from '@/server/plugins/workshop'
import { getHitlRegistry } from '@/server/services/workshop/agents/hitl-registry'
import { canDecideHitlChannel, ensureHitlReconciled, snapshotOfRow } from '@/server/services/workshop/agents/hitl-decision'
import type { AepHitlItem } from '../../../../shared/workshop-protocol'

export default defineApiHandler(async (event) => {
  const user = resolveUser(event)
  const q = getQuery(event)
  const channelId = typeof q.channelId === 'string' ? q.channelId : ''

  // 重启后第一次触碰 HITL 面:先把上一进程遗留的非终态待办收敛为 failed(绝不自动批准),
  // 避免"死待办"在快照里复活(惰性对账,幂等;插件显式调用等价)。
  ensureHitlReconciled()

  const manager = getWorkshopManager()
  const repo = manager.groupChat.hitl
  const acting = { id: user.id, name: user.name, role: user.role }
  const items = getHitlRegistry()
    .snapshot(channelId || undefined)
    .filter((i: AepHitlItem) => {
      if (!i.channelId) return false
      // 策略/资格以持久化行为准(创建时冻结);无行(降级登记)按当前 Channel 策略判定
      const row = repo.find(i.kind, i.id)
      const opts = row
        ? { policy: row.policy, snapshot: snapshotOfRow(row) }
        : { policy: i.policy }
      return canDecideHitlChannel(i.channelId, acting, opts)
    })
  return { items }
})
