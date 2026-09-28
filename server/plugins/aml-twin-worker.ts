/**
 * AML Twin 持续校准 worker 定时插件。
 *
 * 每 60s 消费 twin_update_runs 的 queued 信号 → 自动提交 hybrid_residual 重训候选
 * (冻结场景 + 最新编译 PhysicsSpec + 该配方最新数据集);只产 candidate,晋升仍走
 * HITL + Twin Gate。调度模式同 retention/backup:setInterval + globalThis key 防
 * HMR 重复 + unref();AML_TWIN_WORKER_DISABLED=1 可整体关闭。
 */
import { processQueuedTwinUpdates } from '@/server/services/workshop/aml/twin/calibration-worker'
import { processTrainingPlans } from '@/server/services/workshop/aml/twin/training-plans'
import { amlTwinFeatureFlags } from '@/server/services/workshop/aml/twin/feature-flags'

const g = globalThis as typeof globalThis & { __awAmlTwinWorkerTimer?: NodeJS.Timeout }

function tick(): void {
  try {
    const flags = amlTwinFeatureFlags()
    if (!flags.channelEnabled || !flags.trainingEnabled) return
    processQueuedTwinUpdates()
    // 建模任务编排(解耦计划):auto 策略的 plan 检测新批次 → 修正训练
    processTrainingPlans()
  }
  catch { // AML runtime 未就绪(极早启动)或单测环境:静默跳过,下一拍重试
  }
}

export default defineNitroPlugin(() => {
  if (process.env.AML_TWIN_WORKER_DISABLED === '1') return
  if (g.__awAmlTwinWorkerTimer) return
  g.__awAmlTwinWorkerTimer = setInterval(tick, 60_000)
  g.__awAmlTwinWorkerTimer.unref()
})
