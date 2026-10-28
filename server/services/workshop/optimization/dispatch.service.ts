/**
 * Optimizer 治理下发服务(SW5/D9–D14/D23/D24)。
 *
 * 链路:互校一致的建议 → 结构化审批卡(nodeId=`optimizer-recipe:<recipeId>`,payload.schemaVersion=1
 * 复用 recipe-propose 契约,归一/裁决链零改动)→ **单一咽喉 decideOptimizerDispatch**
 * (两个裁决入口同路由)→ D13 八项重验(fail-closed)→ approval 原子抢占(提交点)→
 * applyRecipe 整批写 → 回读 → recordOps → 解 pending。
 *
 * 铁律:
 *  - D11 防伪:REST body 只收 recommendation_id;payload 全部服务端落库回查构造;
 *  - D14 幂等锚:dispatched_at 建卡时 idle→dispatched 原子抢占(不回滚);committed 抢占 = 写提交点,
 *    提交点后撤权不回滚已提交写;取消/批准同条件原子转移;未建卡(idle)批准/取消 → 409;
 *  - D14 在飞去重:recipeWriteInFlight 检查 recipe:/recipe-propose:/optimizer-recipe: 三前缀(建卡不排除自身、批准排除);
 *  - D24 步限:首步相对**当前 MV 实测值**在模型单位比较(|firstMove−(cur*scale+offset)|≤maxStep+ε);
 *  - D23 单位:下发卡写工程值(firstMoveEngineering),批准回读 ≈ 写入值。
 */
import { AppError } from '../../../utils/errors'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ResolvedUser } from '../../../api/workshop/caller'
import { recordOps } from '../ops/ops'
import { securityRecipeDispatchTimeoutMs } from '../settings'
import { getAmlRuntime } from '../aml/runtime'
import { getProcessModelSpecRepo } from '../process-model/spec.repo'
import { parseProcessModelSpec, assertSpecControlNodes } from '../process-model/spec'
import { buildProblemIR, type ModelArtifact } from './problem-builder'
import { computeProblemIrHash } from './contracts'
import { parseProfileRow, getProfileRepo } from './profile.repo'
import { getRunRepo } from './run.repo'
import { getBindingRepo } from './binding.repo'
import { deriveDualState } from './crosscheck.service'
import { assertRecommendationUsable } from './recommendation.service'
import { toModel } from '@/shared/units'
import { getDcwController } from '../dcw/dcw-controller'
import { evaluateRecipeParamLimits } from '../dcw/dcw-controller/write'
import { getDcwLineRepo } from '../dcw/dcw-line.repo'
import { getActiveLineRun } from '../dcw/line-run'
import { assertRecipeOpInterval } from '../dcw/recipe-op-anchor'
import { getToolApprovals } from '../agents/tool-approvals'
import { amlActivityForLine } from '../agents/industrial/aml-activity'
import { assertOntologyUnchanged, evaluateOntologyGuardsForNodes } from '../ontology/ontology.service'
import type { RecipeProposePayload } from '../agents/industrial/recipe-propose-tools'

export function isOptimizerDispatchCard(nodeId: string): boolean {
  return nodeId.startsWith('optimizer-recipe:')
}

/** D14 在飞去重:三前缀共享;建卡不排除自身(此时还没有卡),批准排除当前 approvalId */
export function recipeWriteInFlight(recipeId: string, options: { excludeApprovalId?: string } = {}): string[] {
  const prefixes = ['recipe:', 'recipe-propose:', 'optimizer-recipe:']
  return getToolApprovals().listPending()
    .filter(a => prefixes.some(p => a.nodeId === `${p}${recipeId}`) && a.id !== options.excludeApprovalId)
    .map(a => a.id)
}

function db() {
  return getAmlRuntime().db
}

function loadRec(recId: string) {
  const rec = getRunRepo().getRecommendation(recId)
  if (!rec) throw new AppError(404, 'RECOMMENDATION_NOT_FOUND', `建议 ${recId} 不存在`)
  const run = getRunRepo().getRun(rec.runId)
  if (!run) throw new AppError(404, 'RUN_NOT_FOUND', `建议所属运行 ${rec.runId} 不存在`)
  const binding = getBindingRepo().get(run.bindingId)
  if (!binding) throw new AppError(404, 'BINDING_NOT_FOUND', `运行绑定 ${run.bindingId} 不存在`)
  const profileRow = getProfileRepo().get(binding.profileId, binding.profileVersionNumber)
  if (!profileRow) throw new AppError(404, 'PROFILE_NOT_FOUND', `Profile ${binding.profileId}@${binding.profileVersionNumber} 不存在`)
  const profile = parseProfileRow(profileRow)
  const specRow = getProcessModelSpecRepo().get(profile.processSpecRef.split('@')[0]!, Number(profile.processSpecRef.split('@')[1] || undefined))
  if (!specRow) throw new AppError(404, 'SPEC_NOT_FOUND', `ProcessModelSpec ${profile.processSpecRef} 不存在`)
  const spec = parseProcessModelSpec(JSON.parse(specRow.specJson))
  const candidate = db().prepare('SELECT controls_json AS controlsJson, predicted_json AS predictedJson, verified AS feasible FROM optimizer_candidates WHERE id = ?')
    .get(rec.candidateId) as { controlsJson: string, predictedJson: string, feasible: number } | undefined
  if (!candidate) throw new AppError(404, 'CANDIDATE_NOT_FOUND', `候选 ${rec.candidateId} 不存在`)
  const recipe = getDcwController().listRecipes().find(r => r.id === spec.recipeId)
  if (!recipe) throw new AppError(404, 'RECIPE_NOT_FOUND', `配方 ${spec.recipeId} 不存在`)
  return { rec, run, binding, profile, spec, candidate, recipe }
}

/**
 * D12 结构/工件未漂移谓词:重编译入参一律取 run 冻结值
 * (profile_id/version → spec → artifact;context 用 run 快照),hash 必须 == rec.problem_ir_hash。
 * 只检测结构与工件漂移;操作点漂移由 D24 步限复核覆盖。
 */
function assertNoDrift(rec: { id: string, problemIrHash: string, modelArtifactHash: string }, runId: string): void {
  const runMeta = db().prepare('SELECT binding_id AS bindingId, profile_id AS profileId, profile_version AS profileVersion FROM optimizer_runs WHERE id = ?').get(runId) as { bindingId: string, profileId: string, profileVersion: number } | undefined
  if (!runMeta) throw new AppError(409, 'DISPATCH_PROFILE_GONE', '运行已不存在;按拒收敛')
  const snapshotJson = String((db().prepare('SELECT context_snapshot_json AS s FROM optimizer_runs WHERE id = ?').get(runId) as { s?: string } | undefined)?.s ?? '{}')
  const binding = getBindingRepo().get(runMeta.bindingId)
  if (!binding) throw new AppError(409, 'DISPATCH_PROFILE_GONE', '运行绑定已不存在;按拒收敛')
  const profileRow = getProfileRepo().get(binding.profileId, binding.profileVersionNumber)
  if (!profileRow) throw new AppError(409, 'DISPATCH_PROFILE_GONE', '运行冻结的 Profile 已不存在(被删除/重版本);按拒收敛')
  const profile = parseProfileRow(profileRow)
  const specRow = getProcessModelSpecRepo().get(profile.processSpecRef.split('@')[0]!, Number(profile.processSpecRef.split('@')[1] || undefined))
  if (!specRow) throw new AppError(409, 'DISPATCH_SPEC_GONE', '运行冻结的 ProcessModelSpec 已不存在;按拒收敛')
  const spec = parseProcessModelSpec(JSON.parse(specRow.specJson))
  // 工件:候选行 model_id → 当前工件;文件 hash 必须 == 建议冻结 hash(D8 同源)
  const modelRow = db().prepare(`SELECT path, artifact_hash AS hash, artifact_kind AS kind FROM aml_models
    WHERE id = (SELECT model_id FROM optimizer_candidates WHERE id = (SELECT candidate_id FROM optimizer_recommendations WHERE id = ?))`)
    .get(rec.id) as { path: string, hash: string, kind: string } | undefined
  if (!modelRow || (modelRow.hash || '') !== rec.modelArtifactHash) {
    throw new AppError(409, 'DISPATCH_MODEL_REPLACED', `模型工件已替换(建议冻结 ${rec.modelArtifactHash.slice(0, 12)});请重新 solve→互校→dispatch`)
  }
  const artifact = JSON.parse(readFileSync(join(modelRow.path, 'model.json'), 'utf8')) as ModelArtifact
  // 重编译 IR(结构 hash 排除 context 实例量,快照只用于填 x0/uPrev)
  const snapshot = JSON.parse(snapshotJson) as Parameters<typeof buildProblemIR>[0]['context']
  const ir = buildProblemIR({ profile, spec, artifact, context: snapshot, runId: `drift-check:${runId}` })
  const hash = computeProblemIrHash(ir)
  if (hash !== rec.problemIrHash) {
    throw new AppError(409, 'DISPATCH_DRIFTED',
      `问题结构已漂移(建议冻结 ${rec.problemIrHash.slice(0, 12)},现编译 ${hash.slice(0, 12)});请重新 solve→互校→dispatch`)
  }
}

export type DispatchGateResult = { ok: true } | { ok: false, code: string, comment: string }

/** D13 批准时刻八项重验(fail-closed)。任一失败 → {ok:false,code,comment}。
 *  overrides:建卡时刻预检用 —— 卡尚未挂出,payload 不可读,由调用方传入本地构造值。 */
export async function assertDispatchApprovable(recId: string, overrides?: { modelFirstMove?: Record<string, number>, packages?: Array<{ params: Array<{ nodeId: string, to: number }> }> }, opts: { requireRunning?: boolean } = {}): Promise<DispatchGateResult> {
  try {
    const { rec, run, binding, profile, spec, candidate, recipe } = loadRec(recId)
    // ① 建议:未过期(显式持久失效)+ 最新 crosscheck 行 pass 且读时 stale=false
    const fresh = assertRecommendationUsable(rec)
    if (fresh.status !== 'verified') {
      return { ok: false, code: 'DISPATCH_GATE_UNVERIFIED', comment: `建议状态 ${fresh.status}(需 verified;请走 solve→互校→dispatch 链)` }
    }
    const dual = deriveDualState(recId)
    if (!dual.dual || !dual.latest) {
      return { ok: false, code: 'DISPATCH_GATE_NOT_CROSSCHECKED', comment: `互校不一致或已失效(verdict=${dual.latest?.verdict ?? 'none'},stale=${dual.latest?.stale ?? 'n/a'});请重新互校` }
    }
    // ② 绑定 active/revision 未变
    const currentBinding = getBindingRepo().get(run.bindingId)
    if (!currentBinding || currentBinding.channelAgentId !== binding.channelAgentId || currentBinding.profileId !== binding.profileId) {
      return { ok: false, code: 'DISPATCH_GATE_BINDING_CHANGED', comment: '运行绑定已被撤销/更换;按拒收敛' }
    }
    if (currentBinding.revision !== run.bindingRevision) {
      return { ok: false, code: 'DISPATCH_GATE_BINDING_REVISION', comment: `绑定 revision 已变(${run.bindingRevision}→${currentBinding.revision});请重新 solve` }
    }
    // ③ D12 结构/工件未漂移
    assertNoDrift(rec, run.id)
    // ④ controlNodeId:存在/启用/同线/∈配方参数面
    assertSpecControlNodes(spec, { required: true, recipeParams: recipe.params })
    const controlNodes = spec.variables.filter(v => v.role === 'mv').map(v => ({ mv: v, node: getDcwController().byId(v.controlNodeId!) }))
    for (const { mv, node } of controlNodes) {
      if (!node) return { ok: false, code: 'DISPATCH_GATE_CONTROL_NODE_GONE', comment: `MV ${mv.id} 的执行节点 ${mv.controlNodeId} 已不存在` }
      if (node.lineId !== spec.lineId) return { ok: false, code: 'DISPATCH_GATE_CONTROL_NODE_LINE', comment: `执行节点 ${node.id} 不在规格产线 ${spec.lineId}` }
      if (!node.enabled) return { ok: false, code: 'DISPATCH_GATE_CONTROL_NODE_DISABLED', comment: `执行节点 ${node.id} 已停用` }
    }
    // ⑤ AML 活动互斥(双写者铁律)
    const activity = amlActivityForLine(spec.lineId)
    if (activity.active) {
      return { ok: false, code: 'DISPATCH_GATE_AML_ACTIVE', comment: `AML 优化循环活动中,禁止下发:${activity.reasons.join(';')}` }
    }
    // ⑥ 当前操作点:MV 步限(模型单位)+ CV 新鲜度
    const line = getDcwLineRepo().byId(spec.lineId)
    if (!line) return { ok: false, code: 'DISPATCH_GATE_LINE_GONE', comment: `产线 ${spec.lineId} 不存在` }
    // 运行门(2026-10-28):D13 八项重验此前不含"产线在跑" —— 停线检修中的设备仍会收到
    // 首步下发(applyRecipe 自身也无运行门)。批准时刻再查一次(decide 会重跑本函数)。
    // 建卡时刻不做运行门(允许先备好方案,开线后再批准),由调用方传 requireRunning:false。
    if (opts.requireRunning !== false) {
      const activeLine = getActiveLineRun(spec.lineId)
      if (!activeLine) {
        return { ok: false, code: 'DISPATCH_GATE_LINE_NOT_RUNNING', comment: '产线当前未运行(无活动批次):真实下发已拒绝。请先开线并确认参数写入完成后再批准。' }
      }
      if (activeLine.recipeId !== recipe.id) {
        return { ok: false, code: 'DISPATCH_GATE_RECIPE_NOT_ACTIVE', comment: `活动批次正在执行配方 ${activeLine.recipeId},与本建议配方 ${recipe.id} 不一致;请重新 solve 或切换产线配方。` }
      }
      if (recipe.productId && activeLine.productId !== recipe.productId) {
        return { ok: false, code: 'DISPATCH_GATE_PRODUCT_MISMATCH', comment: `活动批次产品 ${activeLine.productId} 与配方产品 ${recipe.productId} 不一致;按拒收敛。` }
      }
    }
    const modelFirstMove = overrides?.modelFirstMove
      ?? (getToolApprovals().listPending().map(a => a.payload).find(p => (p as { recommendationId?: string } | null)?.recommendationId === recId) as (RecipeProposePayload & { modelFirstMove?: Record<string, number> }) | undefined)?.modelFirstMove
      ?? {}
    for (const { mv, node } of controlNodes) {
      if (!node) return { ok: false, code: 'DISPATCH_GATE_CONTROL_NODE_GONE', comment: `MV ${mv.id} 的执行节点已不存在` }
      const currentEng = typeof node.value === 'number' ? node.value : (typeof node.readValue === 'number' ? node.readValue : null)
      if (currentEng == null) return { ok: false, code: 'DISPATCH_GATE_CURRENT_MV_UNKNOWN', comment: `执行节点 ${node.id} 无当前实测值;无法做步限复核` }
      const currentModel = toModel(currentEng, { scale: mv.scale, offset: mv.offset }, `MV ${mv.id}`)
      const modelTo = modelFirstMove[mv.id]
      if (modelTo == null || !Number.isFinite(modelTo)) return { ok: false, code: 'DISPATCH_GATE_FIRSTMOVE_MISSING', comment: `MV ${mv.id} 缺模型单位首步值` }
      const maxStep = mv.maxStep ?? spec.effectiveDomain.mv[mv.id]?.maxStep
      if (maxStep != null && Math.abs(modelTo - currentModel) > maxStep + 1e-9) {
        return { ok: false, code: 'DISPATCH_STEP_EXCEEDED', comment: `MV ${mv.id} 首步超步限(|${modelTo.toFixed(4)}−${currentModel.toFixed(4)}|>${maxStep});请重新 solve` }
      }
    }
    // ⑦ preflight 复跑(工程值;配方窗口不豁免)
    const paramPackages = overrides?.packages
      ?? (getToolApprovals().listPending().map(a => a.payload).find(p => (p as { recommendationId?: string } | null)?.recommendationId === recId) as (RecipeProposePayload & { modelFirstMove?: Record<string, number> }) | undefined)?.packages
      ?? []
    for (const pkg of paramPackages) {
      for (const p of pkg.params) {
        const node = getDcwController().byId(p.nodeId)
        if (!node) return { ok: false, code: 'DISPATCH_GATE_NODE_GONE', comment: `参数节点 ${p.nodeId} 已不存在` }
        const pf = evaluateRecipeParamLimits(node, p.to, { skipRecipe: false })
        if (!pf.ok) return { ok: false, code: 'DISPATCH_GATE_PREFLIGHT', comment: `${node.name ?? p.nodeId}:${pf.violations[0] ?? '写入限界校验失败'}` }
      }
    }
    void candidate
    void profile
    void recipe
    // ⓪ 发起人复验在 REST 层(assertOptimizationAccess);⑧ recipe 级间隔卡控:
    try {
      assertRecipeOpInterval(recipe, { emergency: false })
    }
    catch (err) {
      return { ok: false, code: 'DISPATCH_GATE_OP_INTERVAL', comment: err instanceof Error ? err.message : String(err) }
    }
    return { ok: true }
  }
  catch (err) {
    if (err instanceof AppError && err.status === 409) {
      return { ok: false, code: err.code, comment: err.message }
    }
    return { ok: false, code: 'DISPATCH_GATE_ERROR', comment: err instanceof Error ? err.message : String(err) }
  }
}

/**
 * 单一咽喉(SW5.4):两个裁决入口(hitl/respond 与 approvals/:id/decide)对
 * optimizer-recipe:* 卡一律路由到此。业务拒绝一律 {approved:false, code, comment}
 * 写回 effective decision;仅基础设施故障抛错。
 */
export async function decideOptimizerDispatch(input: {
  cardId: string
  approved: boolean
  comment: string
  choice?: number
  actingUser: { id: string, name: string }
  via: string
}): Promise<{ handled: false } | { handled: true, approved: boolean, comment: string, code?: string, execution?: Record<string, unknown> }> {
  const pending = getToolApprovals().listPending().find(a => a.id === input.cardId)
  if (!pending || !isOptimizerDispatchCard(pending.nodeId)) return { handled: false }
  const payload = (pending.payload ?? {}) as { recommendationId?: string }
  const recId = String(payload.recommendationId ?? '')
  const reject = (code: string, comment: string): { handled: true, approved: false, comment: string, code: string } => {
    transitionDispatchState(recId, 'denied')
    getToolApprovals().decide(input.cardId, false, `[${code}] ${comment}`, input.actingUser.id, input.actingUser.name)
    recordOps({
      actor: input.actingUser.id, actorName: input.actingUser.name, actorKind: 'user',
      action: 'optimizer.dispatch.reject', kind: 'system', level: 'warn',
      targetKind: 'optimizer_recommendation', targetId: recId,
      summary: `下发卡被拒收敛(${code}):${comment}`,
      detail: { cardId: input.cardId, code, via: input.via, comment },
    })
    return { handled: true, approved: false, comment: `[${code}] ${comment}`, code }
  }

  if (!input.approved) {
    return reject('DISPATCH_REJECTED', input.comment || '(人工拒绝)')
  }
  // D13 八项重验(失败不落 approval_id / execute 审计)
  const gate = await assertDispatchApprovable(recId)
  if (!gate.ok) return reject(gate.code, gate.comment)
  // 原子抢占 = 写提交点(D14);取消先赢 → changes=0
  const claim = db().prepare(`UPDATE optimizer_recommendations SET dispatch_state = 'committed', approval_id = ?
    WHERE id = ? AND dispatch_state = 'dispatched' AND dispatched_at IS NOT NULL`).run(input.cardId, recId)
  if (Number(claim.changes) === 0) {
    return reject('DISPATCH_ALREADY_CLAIMED', '该建议已被并发裁决/取消;同配方请重新 solve→互校→dispatch')
  }
  // 执行:选定包整批下发(单包;choice 由归一链保证)
  const cardPayload = (pending.payload ?? {}) as RecipeProposePayload & { modelFirstMove?: Record<string, number> }
  const chosenIdx = Number.isInteger(input.choice) ? (input.choice as number) : 0
  const chosen = cardPayload.packages[chosenIdx] ?? cardPayload.packages[0]
  if (!chosen) {
    transitionDispatchState(recId, 'failed')
    return reject('DISPATCH_PACKAGE_MISSING', '审批卡缺少候选包;按拒收敛')
  }
  const overrides = chosen.params.map(p => ({ nodeId: p.nodeId, value: p.to }))
  try {
    const run = await getDcwController().applyRecipe(cardPayload.recipeId, {
      overrides,
      trial: true,
      agentDispatch: true,
      agentApprovalId: input.cardId,
    })
    db().prepare(`UPDATE optimizer_recommendations SET dispatch_state = 'executed' WHERE id = ?`).run(recId)
    const acks = run.ackSummary ?? { verified: run.results.filter(r => r.ok).length, unverified: 0, failed: run.results.filter(r => !r.ok).length, total: run.results.length }
    recordOps({
      actor: input.actingUser.id, actorName: input.actingUser.name, actorKind: 'user',
      action: 'optimizer.dispatch.execute', kind: 'system',
      level: acks.failed > 0 ? 'error' : acks.unverified > 0 ? 'warn' : 'info',
      targetKind: 'optimizer_recommendation', targetId: recId,
      summary: `优化器建议下发执行(证实 ${acks.verified}/${acks.total},未证实 ${acks.unverified},失败 ${acks.failed},批次 ${run.id.slice(0, 8)})`,
      detail: { cardId: input.cardId, recommendationId: recId, runId: run.id, acks, via: input.via, initiatorUserId: readInitiator(recId) },
    })
    getToolApprovals().decide(input.cardId, true, input.comment, input.actingUser.id, input.actingUser.name, chosenIdx)
    return { handled: true, approved: true, comment: input.comment, execution: { runId: run.id, acks } }
  }
  catch (err) {
    db().prepare(`UPDATE optimizer_recommendations SET dispatch_state = 'failed' WHERE id = ?`).run(recId)
    const message = err instanceof Error ? err.message : String(err)
    getToolApprovals().decide(input.cardId, false, `[DISPATCH_WRITE_FAILED] ${message};产线未变更,请重新 solve→互校→dispatch`, input.actingUser.id, input.actingUser.name)
    recordOps({
      actor: input.actingUser.id, actorName: input.actingUser.name, actorKind: 'user',
      action: 'optimizer.dispatch.execute', kind: 'system', level: 'error',
      targetKind: 'optimizer_recommendation', targetId: recId,
      summary: `优化器建议下发执行失败(已抢占提交点,不回滚):${message}`,
      detail: { cardId: input.cardId, recommendationId: recId, via: input.via, error: message },
    })
    return { handled: true, approved: false, comment: `[DISPATCH_WRITE_FAILED] ${message}`, code: 'DISPATCH_WRITE_FAILED' }
  }
}

function readInitiator(recId: string): string {
  return String((db().prepare('SELECT initiator_user_id AS u FROM optimizer_recommendations WHERE id = ?').get(recId) as { u?: string } | undefined)?.u ?? '')
}

function transitionDispatchState(recId: string, state: string): void {
  db().prepare('UPDATE optimizer_recommendations SET dispatch_state = ? WHERE id = ?').run(state, recId)
}

/**
 * 建卡(SW5.3):REST 建卡即返回(HITL promise fire-and-forget,无 agent 回合等待)。
 * 外层 assertOptimizationAccess('dispatch') 由 REST 路由先行;本函数做 D11 防伪回查 + 闸序预检 + 幂等建卡。
 */
export async function createDispatchCard(initiator: ResolvedUser, recommendationId: string, note: string): Promise<{
  cardId: string
  agentInstanceId: string
  recipeId: string
  payload: RecipeProposePayload & { recommendationId: string, modelFirstMove: Record<string, number> }
  detail: string
}> {
  const { rec, spec } = loadRec(recommendationId)
  ;(await import('./access')).assertOptimizationAccess(initiator, 'dispatch', { kind: 'recommendation', runId: rec.runId })
  // D11 防伪 + 状态门:只有「verified + 互校一致 + 未 stale」能建卡
  if (assertRecommendationUsable(rec).status !== 'verified') {
    throw new AppError(403, 'DISPATCH_GATE_UNVERIFIED', `建议状态非 verified;只有 verified 建议可申请下发(请走 solve→互校→dispatch 链)`)
  }
  const dual = deriveDualState(recommendationId)
  if (!dual.dual || !dual.latest) {
    throw new AppError(403, 'DISPATCH_GATE_NOT_CROSSCHECKED', `互校不一致或未互校(verdict=${dual.latest?.verdict ?? 'none'});先 POST .../crosscheck`)
  }
  if (dual.latest.stale) throw new AppError(409, 'DISPATCH_GATE_STALE', '互校行已 stale(模型/绑定已变);请重新互校')
  // 本地构造模型首步与参数包(卡尚未挂出,payload 不可读;与下方落库回查同源)
  const candidate = db().prepare('SELECT controls_json AS controlsJson FROM optimizer_candidates WHERE id = ?')
    .get(rec.candidateId) as { controlsJson: string } | undefined
  const firstMoveModel = (candidate ? JSON.parse(candidate.controlsJson || '[[]]')[0] ?? [] : []) as number[]
  const mvs = spec.variables.filter(v => v.role === 'mv')
  const modelFirstMove: Record<string, number> = {}
  mvs.forEach((mv, m) => {
    modelFirstMove[mv.id] = Number(firstMoveModel[m] ?? 0)
  })
  const paramRows = mvs.map((mv) => {
    const node = getDcwController().byId(mv.controlNodeId!)
    const modelTo = modelFirstMove[mv.id] ?? 0
    const engTo = (modelTo - mv.offset) / mv.scale
    const currentEng = node ? (typeof node.value === 'number' ? node.value : typeof node.readValue === 'number' ? node.readValue : null) : null
    return {
      nodeId: mv.controlNodeId!,
      paramName: node?.name ?? mv.controlNodeId!,
      from: currentEng,
      to: engTo,
      unit: node?.unit ?? mv.unit,
      basis: `optimizer-recommendation:${recommendationId}`,
      exp_ref: rec.runId,
      preflight: { ok: true },
    }
  })
  const { recipe } = loadRec(recommendationId)
  // 本体运行时守卫(ONT):已发布本体的 block 级守卫对本次下发意图求值。
  // 只增拒不放行;无本体/无守卫时零开销。批准时刻 D13 仍全量重验。
  const ontologyGuard = evaluateOntologyGuardsForNodes(spec.lineId, paramRows.map(p => ({ nodeId: p.nodeId, from: p.from, to: p.to })))
  if (ontologyGuard.blocked) {
    const violation = ontologyGuard.violations[0]!
    throw new AppError(409, 'ONTOLOGY_GUARD_BLOCKED',
      `本体运行时守卫阻断下发:${violation.message}(规则 ${violation.ruleId};本体包 ${ontologyGuard.packHash.slice(0, 12)})`)
  }
  // Profile 冻结的本体引用漂移:独立校验(不进 IR hash,不变更 D13 八项语义)
  const dispatchRun = db().prepare('SELECT profile_id AS profileId, profile_version AS profileVersion FROM optimizer_runs WHERE id = ?')
    .get(rec.runId) as { profileId?: string, profileVersion?: number } | undefined
  if (dispatchRun?.profileId) {
    const dispatchProfileRow = getProfileRepo().get(dispatchRun.profileId, Number(dispatchRun.profileVersion ?? 1))
    if (dispatchProfileRow) assertOntologyUnchanged(parseProfileRow(dispatchProfileRow).ontologyRefs)
  }
  // 闸序预检(建卡时刻;批准时刻 D13 全量重验)
  const gate = await assertDispatchApprovable(recommendationId, { modelFirstMove, packages: [{ params: paramRows }] }, { requireRunning: false })
  if (!gate.ok) throw new AppError(gate.code.startsWith('DISPATCH_GATE') || gate.code === 'DISPATCH_STEP_EXCEEDED' ? 403 : 409, gate.code, gate.comment)
  // 在飞去重(三前缀;建卡时无自身卡可排除)
  const inflight = recipeWriteInFlight(recipe.id)
  if (inflight.length > 0) {
    throw new AppError(409, 'DISPATCH_RECIPE_IN_FLIGHT', `同配方已有在飞下发卡(${inflight.map(i => i.slice(0, 24)).join(', ')});拒绝/超时收敛后再试`)
  }
  // 幂等锚:idle→dispatched 原子抢占(不回滚;被拒后走重 solve)
  const claim = db().prepare(`UPDATE optimizer_recommendations SET dispatch_state = 'dispatched', dispatched_at = ?, initiator_user_id = ?
    WHERE id = ? AND dispatch_state = 'idle'`)
    .run(new Date().toISOString(), initiator.id, recommendationId)
  if (Number(claim.changes) === 0) {
    throw new AppError(409, 'DISPATCH_ALREADY_DISPATCHED', '该建议已建过下发卡(幂等锚已占);拒绝/超时收敛后请重新 solve')
  }
  // 卡载荷:服务端落库回查构造(D11 —— body 只有 recommendation_id,这里全部回查)
  const packages = [{
    name: `优化器建议 ${recommendationId.slice(0, 18)}`,
    rationale: note || 'Optimizer 双重校验候选(verified + 互校一致);详见 optimizer_runs 台账',
    params: paramRows,
  }]
  const payload = {
    schemaVersion: 1 as const,
    recommendationId,
    recipeId: recipe.id,
    lineId: spec.lineId,
    modelFirstMove,
    packages,
  }
  const dualInfo = `互校 maxDev=${dual.latest.maxDev === null ? 'n/a' : dual.latest.maxDev.toExponential(3)}(tol=${dual.latest.tol})`
  const detail = [
    `优化器建议下发:建议 ${recommendationId}(verified + ${dualInfo},rowHash ${dual.latest.rowHash.slice(0, 12)});配方「${recipe.name}」v${recipe.version ?? 1}。`,
    `方案「${packages[0]!.name}」`,
    ...paramRows.map(p => `  · ${p.paramName} ${p.from ?? '?'}→${Number(p.to.toFixed(6))}${p.unit} | 依据:${p.basis} | 引用:${p.exp_ref}`),
    note ? `发起备注:${note}` : '',
    '批准即按 D13 八项重验后整批下发;未通过重验将按拒收敛(零写)。',
  ].filter(Boolean).join('\n')

  const cardId = `optimizer-recipe:${recipe.id}`
  const agentInstance = (db().prepare(`SELECT channel_agent_id AS a FROM optimizer_bindings WHERE id =
    (SELECT binding_id FROM optimizer_runs WHERE id = (SELECT run_id FROM optimizer_recommendations WHERE id = ?))`)
    .get(recommendationId) as { a?: string } | undefined)?.a ?? ''
  // fire-and-forget:卡挂到审批面(审批面板/hitl/respond/decide 三面可见);无 agent 回合等待
  void getToolApprovals().request(agentInstance, cardId, 'dcw', detail, {
    title: `优化器建议下发:${recipe.name}`,
    timeoutMs: securityRecipeDispatchTimeoutMs(),
    payload,
  }).catch(() => { /* 超时/取消由收敛链处理 */ })
  recordOps({
    actor: initiator.id, actorName: initiator.name, actorKind: 'user',
    action: 'optimizer.dispatch.request', kind: 'system',
    targetKind: 'optimizer_recommendation', targetId: recommendationId,
    summary: `申请下发优化器建议 ${recommendationId}(卡 ${cardId};${dualInfo})`,
    detail: { recommendationId, cardId, runId: rec.runId, initiatorUserId: initiator.id, rowHash: dual.latest.rowHash },
  })
  return { cardId, agentInstanceId: agentInstance, recipeId: recipe.id, payload, detail }
}

/** D17/D14:权限变更/撤权收敛某用户发起的在飞 optimizer-recipe 卡(条件转移,只收敛未提交的) */
export function cancelPendingDispatchForUser(userId: string, reason: string): number {
  const recIds = (db().prepare(`SELECT id FROM optimizer_recommendations WHERE initiator_user_id = ? AND dispatch_state = 'dispatched'`).all(userId) as Array<{ id: string }>).map(r => r.id)
  let n = 0
  for (const recId of recIds) {
    const runId = String((db().prepare('SELECT run_id AS r FROM optimizer_recommendations WHERE id = ?').get(recId) as { r?: string } | undefined)?.r ?? '')
    const pending = getToolApprovals().listPending().find(a => isOptimizerDispatchCard(a.nodeId) && (a.payload as { recommendationId?: string } | null)?.recommendationId === recId)
    if (!pending) continue
    const claim = db().prepare(`UPDATE optimizer_recommendations SET dispatch_state = 'cancelled'
      WHERE id = ? AND dispatch_state = 'dispatched' AND dispatched_at IS NOT NULL AND approval_id IS NULL`).run(recId)
    if (Number(claim.changes) === 0) continue
    getToolApprovals().cancelPendingFor(pending.agentId, pending.nodeId)
    void runId
    recordOps({
      actor: 'system', actorName: 'system', actorKind: 'system', action: 'optimizer.dispatch.cancel',
      kind: 'system', level: 'warn', targetKind: 'optimizer_recommendation', targetId: recId,
      summary: `发起人权限变更,在飞下发卡已收敛:${reason}`, detail: { initiatorUserId: userId },
    })
    n++
  }
  return n
}

/** 启动对账(D14):approval_id 非空但无 execute 审计的卡,回读 DCW 判定 executed/unknown */
export function reconcileDispatchCards(): { reconciled: number, executed: number, unknown: number } {
  const executed = 0
  let unknown = 0
  const rows = db().prepare(`SELECT id, approval_id AS approvalId FROM optimizer_recommendations
    WHERE dispatch_state = 'committed' AND approval_id IS NOT NULL`).all() as Array<{ id: string, approvalId: string }>
  for (const row of rows) {
    const auditRow = db().prepare(`SELECT COUNT(*) AS n FROM audit_log WHERE action = 'optimizer.dispatch.execute' AND target_id = ?`).get(row.id) as { n: number }
    if (auditRow.n > 0) continue
    // 无执行审计:崩溃窗口。禁自动重放 → 标 failed + 通告
    db().prepare(`UPDATE optimizer_recommendations SET dispatch_state = 'failed' WHERE id = ?`).run(row.id)
    recordOps({
      actor: 'system', actorName: 'system', actorKind: 'system', action: 'optimizer.dispatch.reconcile',
      kind: 'system', level: 'error', targetKind: 'optimizer_recommendation', targetId: row.id,
      summary: `启动对账:下发卡 ${row.approvalId} 停留在 committed 且无执行审计 → 判定 unknown/failed;禁止自动重放,请重新 solve→互校→dispatch`,
      detail: { approvalId: row.approvalId },
    })
    unknown++
  }
  return { reconciled: rows.length, executed, unknown }
}
