/**
 * POST /api/workshop/tasks/:id/recovery-disposition —— 显式释放 legacy 恢复保留(admin only)。
 * 处置语义(fail-closed 设计的另一半):
 *  - action 必须 = "release"(显式操作,无默认行为);note 记入审计
 *  - 清除本连接树上全部 hold 标记(保留其余 close_reason 内容)
 *  - 在飞 consuming 消息按重投预算复位(pending/dead);pending 联动消息自动恢复可投递
 *  - 任务状态不改动:重新执行必须走显式 retry/reopen,绝不自动重放
 *  - 全程写 audit_log(task.recovery_disposition)
 */
import { getRouterParam, readBody } from 'h3'
import { requireAdmin } from '@/server/api/workshop/caller'
import { AppError } from '@/server/utils/errors'
import { defineApiHandler } from '@/server/utils/response'
import { getWorkshopManager } from '@/server/plugins/workshop'
import type { AgentChannelManager } from '@/server/services/workshop/runtime/manager'
import type { TaskEngine } from '@/server/services/workshop/runtime/agent-runtime'

function taskEngineOf(manager: AgentChannelManager): TaskEngine {
  return (manager as unknown as { getTaskEngine(): TaskEngine }).getTaskEngine()
}

export default defineApiHandler(async (event) => {
  const taskId = getRouterParam(event, 'id')!
  const user = requireAdmin(event)
  const body = await readBody<{ action?: string, note?: string }>(event) ?? {}
  if (body.action !== 'release') {
    throw new AppError(400, 'VALIDATION_ERROR', 'action 必须显式为 "release"(处置无默认行为)')
  }
  const manager = getWorkshopManager()
  const engine = taskEngineOf(manager)
  return engine.disposeLegacyRecoveryHold(taskId, { id: user.id, name: user.name }, body.note)
})
