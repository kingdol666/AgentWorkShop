/**
 * DcwControllerWrite —— 数控写入(联锁/量程/租约)与驱动探测
 * (拆分层,承 DcwControllerBindings;方法体与原文件逐行一致)
 */
import { DcwControllerBindings } from './bindings'
import type { DcwDriverKind, DcwWriteMeta } from '../../../../../shared/dcw-protocol'
import { AppError, ErrorCodes } from '../../../../utils/errors'
import { assertWithinLimits } from '../param-limits'
import { emitDcwWrite } from '@/server/services/workshop/plugins/host.mjs'
import { getActiveLineRun } from '../line-run'
import { getRecipeRollBackManager } from '../recipe-rollback-manager'
import { normalizeDcwDriverKind, resolveDcwDriver } from '../drivers'
import { opsActorKindOf, opsWriteMemo } from './helpers'
import { recordOps } from '../../ops/ops'

export abstract class DcwControllerWrite extends DcwControllerBindings {
  /** 手动设定:用户提交工程量,网关校验/换算/下发/回读校验。
   *  配方联锁:产线运行中,写入值还须落在活动配方对该参数的工艺窗口内
   *  (节点全局量程之外的第二道约束 —— 换配方即换工艺窗口)。
   *  meta(F7):账本与优化记录的身份信息 —— 手动/配方/Agent/回退四路共用本入口,
   *  缺省按 manual/user 记账;调控闭环护栏(Agent 互斥/回退冷却)在 beforeWrite。 */
  async write(id: string, eng: number, recipeRunId: string | null = null, meta?: DcwWriteMeta) {
    this.ensureLoop()
    const rt = this.runtimes.get(id)
    if (!rt) throw new AppError(404, ErrorCodes.NOT_FOUND, `控制节点不存在: ${id}`)
    const node = rt.node
    // 控制暂停双重门控:网关全局暂停(暂停全部控制)或节点级暂停 → 一律拒绝下发。
    // 手动 REST / 配方下发 / 产线开跑 / Agent 工具共用本入口,拒绝语义单点收敛。
    if (!this.running) {
      throw new AppError(409, ErrorCodes.CONFLICT, '控制网关已暂停(暂停全部控制):设定下发被拒绝,请先「恢复全部控制」')
    }
    if (!node.enabled) {
      throw new AppError(409, ErrorCodes.CONFLICT, `当前节点暂停:「${node.name}」控制已暂停,仅开启控制的节点可被设定`)
    }
    // 调控闭环护栏(F1/F8):Agent 互斥(open 记录他人持有)+ 回退冷却方向性
    getRecipeRollBackManager().beforeWrite(node, eng, meta)
    // 写入限界分层联锁(param-limits):节点安全量程(结构层,驱动内 validateEng 结构性兜底)
    // ∩ 工艺参数基准限界 ∩ 活动产品限界 ∩ 活动配方工艺窗口 —— 逐层收窄取交集,
    // 手动 REST / Agent 工具 / 配方下发 / 回退四路共用本咽喉点,越界一律拒绝。
    // D8 基准消融:仅 AW_BENCH_MODE=1 且 meta.benchArm='no-interlock'/'ungated' 时
    // 旁路软联锁层(参数/产品/配方);结构层与硬量程校验结构性不可旁路;
    // 生产模式(env 缺省)恒为 full 臂。
    const benchNoInterlock = process.env.AW_BENCH_MODE === '1' && (meta?.benchArm === 'no-interlock' || meta?.benchArm === 'ungated')
    // 配方下发路径(recipeRunId != null)跳过配方窗口层:下发值已在配方保存时对自身窗口校验,
    // 且中途应用新配方不应被旧批次配方窗口误伤;产品/参数基准层对配方下发照常约束。
    assertWithinLimits(node, eng, { includeSoft: !benchNoInterlock, skipRecipe: recipeRunId != null })
    // 写入保持窗(防参数震荡):agent/manual 写成功一次即锁定节点 writeLockSeconds;
    // 锁定期间的新写一律 429 快速拒绝(不排队 —— 排队写会在窗满后立刻落库,等同
    // 为持续篡改保留通道)。rollback(安全恢复)/recipe(批量下发)不受保持窗约束;
    // AW_BENCH_MODE=1 基准旁路(基准多轮连续写同节点,锁会破坏既有证据可复现性)。
    // 顺序在限界联锁之后:越量程/越窗是确定性非法(400),不得被暂时性限频(429)
    // 抢答,否则客户端会对非法值做 30s 的无谓重试。
    const srcForLock = meta?.source ?? (recipeRunId ? 'recipe' : 'manual')
    const benchBypass = process.env.AW_BENCH_MODE === '1'
    const lockMs = Math.max(0, Math.round((node.writeLockSeconds ?? 30) * 1000))
    const lockable = (srcForLock === 'agent' || srcForLock === 'manual') && lockMs > 0 && !benchBypass
    if (lockable) {
      const now = Date.now()
      const until = this.writeLocks.get(id) ?? 0
      // 过期条目顺手清掉,防注册表随节点删除/长时运行无限增长
      if (this.writeLocks.size > 500) {
        for (const [k, t] of this.writeLocks) {
          if (t <= now) this.writeLocks.delete(k)
        }
      }
      if (now < until) {
        throw new AppError(
          429,
          ErrorCodes.WRITE_FREQUENT,
          `当前写入频繁:「${node.name}」处于写入保持窗口(剩余 ${Math.ceil((until - now) / 1000)}s),请稍后再试`,
        )
      }
    }
    // D8: no-readback / ungated 臂 → 容差置 MAX,回读差异不致败(假成功语义,供 I2 消融)
    const benchNoReadback = process.env.AW_BENCH_MODE === '1' && (meta?.benchArm === 'no-readback' || meta?.benchArm === 'ungated')
    const benchToleranceOverride = benchNoReadback ? Number.MAX_VALUE : undefined
    const prevValue = typeof node.value === 'number' ? node.value : null
    const outcome = await rt.write(eng, recipeRunId, benchToleranceOverride)
    // 调控闭环入册:仅成功写记锚/开记录(失败写不动账本 —— PLC 值未变更);
    // 窗口聚合异步回填(F2)
    if (outcome.ok !== false) {
      // 写成功 → 锁定写入保持窗(agent/manual 路径;recipe/rollback 豁免)
      if (lockable) this.writeLocks.set(id, Date.now() + lockMs)
      try {
        const rbInfo = getRecipeRollBackManager().afterWrite(
          node,
          eng,
          prevValue,
          meta ?? { source: recipeRunId ? 'recipe' : 'manual', actor: 'user' },
          recipeRunId,
        )
        if (rbInfo) {
          outcome.recordId = rbInfo.recordId
          outcome.anchorId = rbInfo.anchorId
        }
      }
      catch (err) {
        console.error('[dcw] 调控闭环入册失败(不影响写结果):', err)
      }
      // 运维日志:所有下发路径(manual/recipe/agent/rollback)单点入册 + 实时事件
      try {
        const src = meta?.source ?? (recipeRunId ? 'recipe' : 'manual')
        const memo = opsWriteMemo.get(id)
        const now = Date.now()
        if (!memo || memo.eng !== eng || now - memo.at > 10_000) {
          opsWriteMemo.set(id, { eng, at: now })
          if (opsWriteMemo.size > 500)
            opsWriteMemo.clear()
          const runNow = getActiveLineRun(node.lineId)
          recordOps({
            actor: meta?.actor ?? 'user',
            actorName: meta?.actorName ?? meta?.actor ?? 'user',
            actorKind: opsActorKindOf(src),
            action: `dcw.write.${src}`,
            kind: 'write',
            targetKind: 'dcw-node',
            targetId: id,
            summary: `下发设定「${node.name}」→ ${eng}${node.unit ?? ''}(${src === 'manual' ? '手动' : src === 'agent' ? 'Agent' : src === 'rollback' ? '回退恢复' : '配方'})`,
            lineId: node.lineId ?? '',
            productId: runNow?.productId ?? '',
            recipeId: runNow?.recipeId ?? recipeRunId ?? '',
            detail: { eng, prevValue, ok: outcome.ok, message: outcome.message, taskId: meta?.taskId ?? null },
          })
          // 插件钩子:写控 ACK 观察(与运维入册同点同去重节流)
          emitDcwWrite({ nodeId: id, name: node.name, eng, prevValue, ok: outcome.ok, source: src, lineId: node.lineId ?? '', at: new Date().toISOString() })
        }
      }
      catch {
        // 日志失败不影响写结果
      }
    }
    return outcome
  }

  /** 连接测试 */
  async testDriver(kind: DcwDriverKind, driverConfig: Record<string, unknown>) {
    return resolveDcwDriver(normalizeDcwDriverKind(kind)).test(driverConfig)
  }

  async testNode(id: string) {
    const node = this.repo.byId(id)
    if (!node) throw new AppError(404, ErrorCodes.NOT_FOUND, `控制节点不存在: ${id}`)
    return this.testDriver(node.driver, node.driverConfig)
  }

  // ---------- 工艺参数映射面(用户/Agent 的唯一语义读写面)----------
}
