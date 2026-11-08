/**
 * POST /api/workshop/channels/:id/activate —— 显式激活 channel(装配 lead + 调度循环)。
 * 懒加载设计下通常在任务提交时自动激活;此端点供前端主动预热/恢复。
 *
 * P1(2026-11-08 生产审计):装配加 deadline —— 引擎装配异常/缓慢此前让请求悬挂数十秒
 * (实测 43.4s)后才 500;调用方/网关 30s 超时先触发 → 误判失败而服务端仍在跑。
 * 现:超时/异常即有界返回(504 ACTIVATE_TIMEOUT / 502 ACTIVATE_FAILED)并累计失败计数
 * (metrics: awshop_engine_activate_failures_total);装配本身不中断(下次调用/tick 复用)。
 */
import { getRouterParam } from 'h3'

import { resolveUser } from '../../caller'
import { defineApiHandler } from '../../../../utils/response'
import { getWorkshopManager, ensureLeadSchedulerLoop } from '../../../../plugins/workshop'
import { AppError } from '../../../../utils/errors'

/** 装配 deadline(毫秒);AW_ACTIVATE_TIMEOUT_MS 可覆盖(下限 1s) */
function activateTimeoutMs(): number {
  const raw = Number(process.env.AW_ACTIVATE_TIMEOUT_MS ?? '')
  return Number.isFinite(raw) && raw >= 1_000 ? raw : 30_000
}

/** 引擎装配失败/超时计数(由 /api/metrics 消费) */
function bumpActivateFailure(): void {
  const g = globalThis as typeof globalThis & { __awEngineActivateFailures?: number }
  g.__awEngineActivateFailures = (g.__awEngineActivateFailures ?? 0) + 1
}

export default defineApiHandler(async (event) => {
  const channelId = getRouterParam(event, 'id')!
  const manager = getWorkshopManager()
  const user = resolveUser(event)
  const channel = manager.getChannelForUser(channelId, user.id)
  manager.requireWritable(channel.ownerUserId, user, 'channel')

  const ms = activateTimeoutMs()
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('ACTIVATE_TIMEOUT')), ms)
    timer.unref?.()
  })
  try {
    const status = await Promise.race([
      (async () => {
        ensureLeadSchedulerLoop(manager, channelId)
        return manager.runtimeStatus()
      })(),
      deadline,
    ])
    return status
  }
  catch (err) {
    bumpActivateFailure()
    const timeout = err instanceof Error && err.message === 'ACTIVATE_TIMEOUT'
    throw new AppError(
      timeout ? 504 : 502,
      timeout ? 'ACTIVATE_TIMEOUT' : 'ACTIVATE_FAILED',
      timeout
        ? `Channel 装配超过 ${ms}ms 未完成(引擎构造/依赖注入异常?)。装配将在后台继续,稍后重试或查询 /api/metrics 的 awshop_engine_activate_failures_total;若持续失败请检查该 channel 成员的 harness 配置。`
        : `Channel 装配失败: ${err instanceof Error ? err.message : String(err)}`,
    )
  }
  finally {
    if (timer) clearTimeout(timer)
  }
})
