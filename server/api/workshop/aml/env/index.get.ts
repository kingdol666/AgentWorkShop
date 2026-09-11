/**
 * GET /api/workshop/aml/env —— AML 运行环境自检(只读)。
 * 返回 uv/Python 探测结果、./aml/.venv 就绪状态、资产根布局、进行中的环境任务与作业前置条件。
 * 前端「运行环境」面板的数据源:未装 uv 时据 uv.ok 显示「一键安装 uv」。
 */
import { defineApiHandler } from '@/server/utils/response'
import { resolveUser } from '@/server/api/workshop/caller'
import { envStatus } from '@/server/services/workshop/aml/env-manager'

export default defineApiHandler(async (event) => {
  resolveUser(event)
  return envStatus()
})
