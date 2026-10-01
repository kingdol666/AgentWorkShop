/**
 * DcwControllerWrite —— 数控写入(联锁/量程/租约)与驱动探测
 * (拆分层,承 DcwControllerBindings;方法体与原文件逐行一致)
 */
import { DcwControllerBindings } from './bindings'
import type { DcwDriverKind, DcwWriteMeta } from '../../../../../shared/dcw-protocol'
import type { DcwNode } from '../dcw-node'
import { AppError, ErrorCodes } from '../../../../utils/errors'
import { assertWithinLimits, assertStepLimit } from '../param-limits'
import { getRecipeRollBackManager } from '../recipe-rollback-manager'
import { normalizeDcwDriverKind, resolveDcwDriver } from '../drivers'
import { recordDcwWriteOps } from './write-audit'
import { recordOps } from '../../ops/ops'

// ================================================================
// 只读预检谓词(产线 Co-Pilot P2:recipe_propose 整包方案的预审批校验)
// ================================================================

/** 预检结果:ok=false 时 violations[0] 即 write() 咽喉点会抛出的同文错误(单点收敛,消息零漂移) */
export interface RecipeParamPreflight {
  ok: boolean
  violations: string[]
  /** 原始错误(assertWithinLimits 抛出的 AppError;预检方需要复刻拒绝语义时原样复抛) */
  error?: AppError
}

/**
 * 限界预检(只读,不写不下发不锁窗):对「节点+目标工程量」复跑 write() 咽喉点的
 * assertWithinLimits 断言,把 throw 式拒绝归一为 { ok, violations } 结果。
 * 选项镜像 write() 的真实语义:skipRecipe=true 即配方下发路径(量程∩参数基准∩产品三层,
 * **不含**步长/60s 间隔/保持窗 —— recipe 执行路径本就不走这些,预检不得擅自收紧);
 * 缺省 skipRecipe=false 即在线写路径(含活动配方工艺窗口)。
 * 消费方:① write() 咽喉点(行为零变化: violations[0]/error 复刻原 throw);
 *        ② recipe_propose 预检(越界参数在审批单生成前剔除,「批准必被拒包」不可达)。
 */
export function evaluateRecipeParamLimits(node: DcwNode, eng: number, opts?: { includeSoft?: boolean, skipRecipe?: boolean }): RecipeParamPreflight {
  try {
    assertWithinLimits(node, eng, { includeSoft: opts?.includeSoft !== false, skipRecipe: opts?.skipRecipe === true })
    return { ok: true, violations: [] }
  }
  catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return {
      ok: false,
      violations: [msg],
      // 复刻 write() 原分类:AppError 原样透传;非 AppError 按 400 归一(与原 catch 同口径)
      error: err instanceof AppError ? err : new AppError(400, ErrorCodes.VALIDATION_ERROR, msg),
    }
  }
}

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
    // v18 拒绝留痕:治理咽喉点的每一次拒绝(量程/配方窗/步限/间隔/保持窗)入审计 ——
    // 安全审计需要"谁在何时试图把参数写到哪、被哪条防线拦下";给调用方的反馈由错误消息承担。
    const reject = (err: AppError): never => {
      try {
        recordOps({
          actor: meta?.actor ?? 'system', actorName: meta?.actorName ?? '', actorKind: meta?.source === 'agent' ? 'agent' : (meta?.source === 'manual' ? 'user' : 'system'),
          action: 'dcw.write.rejected', kind: 'write', targetKind: 'dcw', targetId: id, lineId: node.lineId,
          summary: `设定 ${eng}${node.unit || ''} 被拒:${err.message}`,
        })
      }
      catch { /* 审计失败不改变拒绝语义 */ }
      throw err
    }
    try {
      getRecipeRollBackManager().beforeWrite(node, eng, meta)
    }
    catch (err) {
      reject(err instanceof AppError ? err : new AppError(409, ErrorCodes.CONFLICT, String(err instanceof Error ? err.message : err)))
    }
    // 写入限界分层联锁(param-limits):节点安全量程(结构层,驱动内 validateEng 结构性兜底)
    // ∩ 工艺参数基准限界 ∩ 活动产品限界 ∩ 活动配方工艺窗口 —— 逐层收窄取交集,
    // 手动 REST / Agent 工具 / 配方下发 / 回退四路共用本咽喉点,越界一律拒绝。
    // D8 基准消融:仅 AW_BENCH_MODE=1 且 meta.benchArm='no-interlock'/'ungated' 时
    // 旁路软联锁层(参数/产品/配方);结构层与硬量程校验结构性不可旁路;
    // 生产模式(env 缺省)恒为 full 臂。
    const benchNoInterlock = process.env.AW_BENCH_MODE === '1' && (meta?.benchArm === 'no-interlock' || meta?.benchArm === 'ungated')
    // 配方下发路径(recipeRunId != null)跳过配方窗口层:下发值已在配方保存时对自身窗口校验,
    // 且中途应用新配方不应被旧批次配方窗口误伤;产品/参数基准层对配方下发照常约束。
    // 预检谓词(evaluateRecipeParamLimits)与本咽喉点共用同一断言:结果 ok=false 时
    // 复抛其捕获的原始错误 —— 拒绝语义/错误码/消息与原 inline throw 逐字节一致。
    const limits = evaluateRecipeParamLimits(node, eng, { includeSoft: !benchNoInterlock, skipRecipe: recipeRunId != null })
    if (!limits.ok) {
      reject(limits.error ?? new AppError(400, ErrorCodes.VALIDATION_ERROR, limits.violations[0] ?? '写入限界校验失败'))
    }
    const srcForLock = meta?.source ?? (recipeRunId ? 'recipe' : 'manual')
    const benchBypass = process.env.AW_BENCH_MODE === '1'
    // 在线 Agent/人工控制都走安全小步与 60s 最小间隔:这是探索阶段的硬卡控，
    // 不依赖提示词也不依赖前端，驱动调用前完成拒绝。recipe/rollback 仍由其
    // 专用路径管理，避免启动批次时把整套配方误判为在线探索步。
    if ((srcForLock === 'agent' || srcForLock === 'manual') && !benchBypass) {
      const previous = typeof node.value === 'number'
        ? node.value
        : (typeof node.readValue === 'number' ? node.readValue : null)
      try {
        assertStepLimit(node, eng, { includeSoft: !benchNoInterlock, skipRecipe: false }, previous)
      }
      catch (err) {
        reject(err instanceof AppError ? err : new AppError(409, ErrorCodes.STEP_LIMIT_EXCEEDED, String(err instanceof Error ? err.message : err)))
      }
      const previousAt = node.lastWriteAt ? Date.parse(node.lastWriteAt) : NaN
      if (Number.isFinite(previousAt)) {
        const elapsed = Date.now() - previousAt
        if (elapsed < 60_000) {
          reject(new AppError(429, ErrorCodes.WRITE_INTERVAL_NOT_ELAPSED, `DCW 节点「${node.name}」两次在线写入间隔必须至少 60s，当前还需 ${Math.ceil((60_000 - elapsed) / 1000)}s`))
        }
      }
    }
    // 写入保持窗(防参数震荡):agent/manual 写成功一次即锁定节点 writeLockSeconds;
    // 锁定期间的新写一律 429 快速拒绝(不排队 —— 排队写会在窗满后立刻落库,等同
    // 为持续篡改保留通道)。rollback(安全恢复)/recipe(批量下发)不受保持窗约束;
    // AW_BENCH_MODE=1 基准旁路(基准多轮连续写同节点,锁会破坏既有证据可复现性)。
    // 顺序在限界联锁之后:越量程/越窗是确定性非法(400),不得被暂时性限频(429)
    // 抢答,否则客户端会对非法值做 30s 的无谓重试。
    const configuredLockMs = Math.max(0, Math.round((node.writeLockSeconds ?? 30) * 1000))
    const lockMs = (srcForLock === 'agent' || srcForLock === 'manual') && !benchBypass ? Math.max(60_000, configuredLockMs) : configuredLockMs
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
        reject(new AppError(
          429,
          ErrorCodes.WRITE_FREQUENT,
          `当前写入频繁:「${node.name}」处于写入保持窗口(剩余 ${Math.ceil((until - now) / 1000)}s),请稍后再试`,
        ))
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
      // 运维日志 + 插件钩子:所有下发路径(manual/recipe/agent/rollback)单点入册(write-audit)
      try {
        recordDcwWriteOps({ id, node, eng, prevValue, outcome, src: srcForLock as DcwWriteMeta['source'], meta, recipeRunId })
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
