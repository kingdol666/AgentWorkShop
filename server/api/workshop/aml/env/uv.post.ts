/**
 * POST /api/workshop/aml/env/uv —— 一键安装 uv 到 <amlRoot>/tools。
 * 异步:立即返回任务快照(kind=install-uv,status=running),进度经 GET /aml/env 轮询。
 * 权限:admin/editor —— 安装动作会在服务器上落可执行文件并触发网络下载。
 */
import { defineApiHandler } from '@/server/utils/response'
import { requireRole } from '@/server/api/workshop/caller'
import { recordOps } from '@/server/services/workshop/ops/ops'
import { startInstallUv } from '@/server/services/workshop/aml/env-manager'

export default defineApiHandler(async (event) => {
  const user = requireRole(event, ['admin', 'editor'])
  const task = startInstallUv()
  recordOps({
    actor: user.id, actorName: user.name, actorKind: 'user',
    action: 'aml.env.install_uv', kind: 'system',
    summary: `一键安装 uv(任务 ${task.id}),安装目录 = ./aml/tools`,
    targetKind: 'aml_env', targetId: task.id,
  })
  return { task }
})
