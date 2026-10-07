/**
 * DcwControllerRecipes —— 配方 CRUD / 版本回退 / 应用
 * (拆分层,承 DcwControllerParams;方法体与原文件逐行一致)
 */
import { DcwControllerParams } from './params'
import type { DcwWriteHistoryEntry } from '../dcw-recipe.repo'
import type { RecipeInput, RecipeRunView, RecipeView } from '../../../../../shared/dcw-protocol'
import { AppError, ErrorCodes } from '../../../../utils/errors'
import { getDcwRecipeRepo } from '../dcw-recipe.repo'
import { assertRecipeOpIntervalForExecution, recordRecipeOpAnchor } from '../recipe-op-anchor'
import { hydrateTrialLastAt, setTrialLastAt } from './gate-persist'
import { recordOps } from '../../ops/ops'

export abstract class DcwControllerRecipes extends DcwControllerParams {
  listRecipes() {
    return getDcwRecipeRepo().list()
  }

  createRecipe(input: RecipeInput) {
    return getDcwRecipeRepo().create(input)
  }

  updateRecipe(id: string, patch: Partial<RecipeInput>, meta?: { by: 'user' | 'agent' | 'system', actorName: string, actor: string, description: string }) {
    const recipe = getDcwRecipeRepo().update(id, patch, meta)
    // 配方参数版本变更 → 运维日志(版本号 + 归因;与版本历史同点入册)
    if (patch.params !== undefined) {
      try {
        recordOps({
          actor: meta?.actor ?? 'user',
          actorName: meta?.actorName ?? meta?.actor ?? 'user',
          actorKind: meta?.by ?? 'user',
          action: meta?.by === 'agent' ? 'recipe.update.agent' : 'recipe.update',
          kind: 'recipe',
          targetKind: 'recipe',
          targetId: id,
          summary: `更新配方「${recipe.name}」→ v${recipe.version ?? 1}${meta?.description ? `:${meta.description.slice(0, 80)}` : ''}`,
          lineId: recipe.lineId ?? '',
          productId: recipe.productId ?? '',
          recipeId: id,
          detail: { version: recipe.version ?? 1, description: meta?.description ?? '' },
        })
      }
      catch { /* 日志失败不影响更新 */ }
    }
    return recipe
  }

  /** 回退配方参数到历史版本/lastGood(生成新版本;非破坏)。allowNoop:定义已在目标态时原样返回(统一回退的 PLC 恢复腿仍要执行) */
  revertRecipe(id: string, target: { version?: number, toLastGood?: boolean }, meta: { by: 'user' | 'agent' | 'system', actorName: string, actor: string, description: string }, opts?: { allowNoop?: boolean }) {
    const recipe = getDcwRecipeRepo().revertToVersion(id, target, meta, opts)
    try {
      recordOps({
        actor: meta.actor,
        actorName: meta.actorName,
        actorKind: meta.by,
        action: 'recipe.revert',
        kind: 'recipe',
        targetKind: 'recipe',
        targetId: id,
        summary: `回退配方「${recipe.name}」→ v${recipe.version ?? 1}${meta.description ? `:${meta.description.slice(0, 80)}` : ''}`,
        lineId: recipe.lineId ?? '',
        productId: recipe.productId ?? '',
        recipeId: id,
        detail: { version: recipe.version ?? 1, description: meta.description },
      })
    }
    catch { /* 日志失败不影响回退 */ }
    return recipe
  }

  recipeVersions(id: string) {
    return getDcwRecipeRepo().versions(id)
  }

  removeRecipe(id: string): void {
    if (!getDcwRecipeRepo().remove(id)) throw new AppError(404, ErrorCodes.NOT_FOUND, `Recipe 不存在: ${id}`)
  }

  listRuns() {
    return getDcwRecipeRepo().listRuns()
  }

  listHistory(limit = 100): DcwWriteHistoryEntry[] {
    return getDcwRecipeRepo().historyList(limit)
  }

  /**
   * 逐参数写核心(apply 与产线开跑共用):**节点级寻址** —— 每个参数显式指向
   * 控制节点(节点才是真实控制 PLC 工艺参数的执行体)→ 逐参数写命令
   * (runId 入写历史)→ 结果快照。节点不存在 → 该参数记失败不阻塞其余。
   * v19 trial:传入 merged params(候选覆盖集),批次与写命令按候选值落账。
   */
  protected async writeRecipeParams(recipe: RecipeView, run: RecipeRunView): Promise<void> {
    const results: RecipeRunView['results'] = []
    for (const param of recipe.params) {
      const node = param.nodeId ? this.repo.byId(param.nodeId) : undefined
      if (!node) {
        results.push({ templateRef: param.templateRef ?? param.nodeId, nodeId: null, ok: false, message: `已跳过:节点 ${param.nodeId} 已删除,参数未下发`, value: param.value })
        continue
      }
      // 停用/解绑守卫:节点已停用或已不在配方所属产线(被解绑/改挂)→ 不下发,
      // 明确记因(run.results 可见),其余参数照常
      if (!node.enabled) {
        results.push({ templateRef: node.templateRef, nodeId: node.id, ok: false, message: `已跳过:节点「${node.name}」已停用,参数未下发`, value: param.value })
        continue
      }
      if (node.lineId !== recipe.lineId) {
        results.push({ templateRef: node.templateRef, nodeId: node.id, ok: false, message: `已跳过:节点「${node.name}」已取消绑定(${node.lineId ? '已改挂其他产线' : '已从产线移除'}),参数未下发`, value: param.value })
        continue
      }
      try {
        const outcome = await this.write(node.id, param.value, run.id, { source: 'recipe', actor: 'recipe' })
        results.push({ templateRef: node.templateRef, nodeId: node.id, ok: outcome.ok, message: outcome.message, value: param.value })
      }
      catch (err) {
        results.push({ templateRef: node.templateRef, nodeId: node.id, ok: false, message: err instanceof Error ? err.message : String(err), value: param.value })
      }
    }
    run.results = results
    getDcwRecipeRepo().updateRun(run)
  }

  /** v19 试验节拍:同产线两次 trial 的最小间隔(防连发震荡;env 可调)。
   *  P1-5 落盘:重启读盘续算(防"重启即绕试验节拍")。 */
  private static readonly TRIAL_INTERVAL_MS = Math.max(0, Number(process.env.AW_TRIAL_INTERVAL_MS) || 5 * 60_000)
  private trialLastAt = new Map<string, number>(
    Object.entries(hydrateTrialLastAt()).map(([k, v]) => [k, Number(v)]),
  )

  private assertTrialCadence(lineId: string): void {
    if (DcwControllerRecipes.TRIAL_INTERVAL_MS <= 0) return
    const last = this.trialLastAt.get(lineId) ?? 0
    const elapsed = Date.now() - last
    if (elapsed < DcwControllerRecipes.TRIAL_INTERVAL_MS) {
      throw new AppError(429, ErrorCodes.WRITE_FREQUENT, `本产线上一次配方试验距今仅 ${Math.floor(elapsed / 1000)}s,试验节拍为 ≥${Math.round(DcwControllerRecipes.TRIAL_INTERVAL_MS / 1000)}s(防连发震荡),请等待 ${Math.ceil((DcwControllerRecipes.TRIAL_INTERVAL_MS - elapsed) / 1000)}s 后再试`)
    }
  }

  /**
   * Recipe 手动应用 / Agent 试验(一键下发工艺参数集;不激活产线窗口)。
   * v19 trial 语义:**声明式覆盖集** —— 提供 overrides 时只写 overrides 列出的节点
   * (实测教训 2026-10-04 场景C:两参试验曾把配方内未提及的 zone1 一并写向旧值,
   * 覆盖 lastGood 200.6 → 190);不提供 overrides = 整批(全部配方参数)。
   * trial 不写配方版本(复测有进步才由 Agent recipe_update 固化);受同线节拍卡控;
   * 四层限界在 write() 咽喉点照常拦截(量程∩参数∩产品)。
   */
  async applyRecipe(recipeId: string, opts: {
    overrides?: Array<{ nodeId: string, value: number }>
    trial?: boolean
    /** Agent 下发族标记:置真才受 recipe 级下发间隔卡控(人工 REST/系统路径豁免) */
    agentDispatch?: boolean
    /** 本次下发的审批单 id(锚自豁免:自己刚获批的那次不卡自己;不同 id 且锚新鲜 = 竞态拦截) */
    agentApprovalId?: string
    /** 应急豁免:仅跳过 recipe 级频控(审批/四层限界/试验节拍照常) */
    emergency?: boolean
  } = {}) {
    this.ensureLoop()
    const repo = getDcwRecipeRepo()
    const recipe = repo.byId(recipeId)
    if (!recipe) throw new AppError(404, ErrorCodes.NOT_FOUND, `Recipe 不存在: ${recipeId}`)
    if (recipe.params.length === 0) throw new AppError(400, ErrorCodes.VALIDATION_ERROR, 'Recipe 无工艺参数,无可下发内容')
    const overrides = opts.overrides ?? []
    const unknown = overrides.filter(o => !recipe.params.some(p => p.nodeId === o.nodeId))
    if (unknown.length) {
      throw new AppError(400, ErrorCodes.VALIDATION_ERROR, `覆盖参数不在配方内: ${unknown.map(o => o.nodeId).join(', ')}(试验只能修改配方已有参数的值;新增参数请先 recipe_update)`)
    }
    if (opts.trial) this.assertTrialCadence(recipe.lineId)
    // Recipe 级下发间隔卡控(执行时兜底):仅 Agent 路径;approvalId 自豁免防审批竞态
    if (opts.agentDispatch) assertRecipeOpIntervalForExecution(recipe, { approvalId: opts.agentApprovalId, emergency: opts.emergency })
    // 声明式覆盖集:有 overrides 只写声明的节点(未声明参数保持现状,绝不顺带整批);
    // 无 overrides(手动应用/统一回退重下发)= 整批语义
    const effective = overrides.length > 0
      ? overrides.map((o) => {
          const p = recipe.params.find(x => x.nodeId === o.nodeId)!
          return { ...p, value: o.value }
        })
      : recipe.params
    const run = repo.createRun(recipe, effective)
    await this.writeRecipeParams({ ...recipe, params: effective }, run)
    if (opts.trial) {
      this.trialLastAt.set(recipe.lineId, Date.now())
      setTrialLastAt(recipe.lineId, Date.now()) // P1-5 落盘
    }
    // Agent 下发成功即前移锚(封 auto 绑定无审批连发:两次已生效下发也须 ≥ opIntervalMs)
    if (opts.agentDispatch) {
      recordRecipeOpAnchor({
        recipeId,
        at: Date.now(),
        approvalId: opts.agentApprovalId ?? '',
        agentId: '',
        op: opts.trial ? 'trial' : 'apply',
        source: 'agent-executed',
      })
    }
    return run
  }

  closeRun(id: string) {
    return getDcwRecipeRepo().closeRun(id)
  }

  /**
   * v19 统一回退:定义回退到目标版本(非破坏,生成新版本)+ **该版本参数整批重下发到 PLC**
   * (与 recipe_rollback 仅改定义的区别:本方法把恢复值真正写回产线,批次级恢复)。
   * 下发走 write() 咽喉点,四层限界照常(回退值是历史已固化参数,量程/参数/产品层兜底)。
   */
  async rollbackRecipeAndDispatch(recipeId: string, opts: {
    version?: number
    toLastGood?: boolean
    by?: 'user' | 'agent' | 'system'
    actorName?: string
    actor?: string
    description?: string
    agentDispatch?: boolean
    agentApprovalId?: string
    emergency?: boolean
  }): Promise<{ recipe: RecipeView, run: RecipeRunView, definitionNoop?: boolean }> {
    const versionBefore = getDcwRecipeRepo().byId(recipeId)?.version ?? 1
    const updated = this.revertRecipe(recipeId, {
      version: opts.toLastGood ? undefined : opts.version,
      toLastGood: opts.toLastGood === true,
    }, {
      by: opts.by ?? 'agent',
      actorName: opts.actorName ?? 'Agent',
      actor: opts.actor ?? 'system',
      description: opts.description ?? '统一回退(定义回退+PLC 整批恢复)',
    }, { allowNoop: true })
    // 定义已在目标态(allowNoop)≠PLC 已在目标态:整批恢复照常执行
    const definitionNoop = (updated.version ?? 1) === versionBefore
    const run = await this.applyRecipe(recipeId, {
      agentDispatch: opts.agentDispatch,
      agentApprovalId: opts.agentApprovalId,
      emergency: opts.emergency,
    })
    return { recipe: updated, run, definitionNoop }
  }

  // ---------- 产线(实体 CRUD;节点/产品/配方挂载其下实现隔离) ----------
}
