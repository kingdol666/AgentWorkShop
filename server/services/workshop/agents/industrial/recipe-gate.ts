/**
 * Recipe 操作统一鉴权门(权限模型 v2 + 2026-10-28 节点级写授权双轨 + 产线配方管理权)。
 *
 * 对产线的全部写动作仍收敛在配方管道上;授权面有三条轨(取并集):
 *   ① 绑定门:
 *      - recipe 绑定(kind='recipe',nodeId 字段=配方 id)= **单配方操作权**
 *        (update/apply/trial/rollback 全部放行,维持权限模型 v2 语义);
 *      - line-recipe 绑定(kind='line-recipe',nodeId 字段=产线 id)= **产线配方管理权**
 *        (2026-10-28 新增):对该产线**全部配方**(含未来新建)可 查看/新建/修改/回退;
 *      - dcw 节点绑定(kind='dcw')= **点位写授权**(非直写入口):同时是下发范围的收窄器 ——
 *        ▸ 下发授权规则(trial/apply):
 *          - Agent 持有 recipe 级授权(单配方绑定 ∨ 产线管理权)且**未绑任何 dcw**:
 *            默认可对该(线)配方全部参数下发(向下兼容,存量行为不变);
 *          - Agent 绑了 dcw:下发覆盖集必须 ⊆ dcw 绑定面(部分覆盖即拒,列出缺失节点);
 *          - Agent 无任何 recipe 级授权:覆盖集 ⊆ dcw 绑定面才放行(纯点位轨)。
 *        ▸ 版本操作(update/rollback)只认 recipe 级授权:dcw 绑定不授予版本权。
 *   ② 认证门:recipe.access.requireAuth=true 时,只有 authorizedAgentIds 清单内的
 *      Agent 可操作(fail-closed:开认证但清单为空 = 无人可操作);
 *   ③ 运行门:配方必须**正在执行**(该产线存在本配方的活动批次)—— 未运行的配方
 *      一律不可操作(参数写入/下发/试验/回退同样受限);
 *   ④ HITL 判定:授权绑定的 mode='manual' → 每次动作挂起等人工批准(必带 Agent 理由);
 *      mode='auto'(显式确认切换)→ 免批。dcw 点位轨覆盖该批次任一 manual 同样强制。
 *      线级总闸(2026-10-08):line.controlMode='manual'(缺省,fail-safe)时 auto 绑定
 *      也强制人工审批;频道层钳位(三模式)同理。
 */
import { getAgentNodeBindingRepo, type AgentNodeBinding } from '../node-bindings.repo'
import { getDcwController } from '../../dcw/dcw-controller'
import { getDcwLineRepo } from '../../dcw/dcw-line.repo'
import { getActiveLineRun } from '../../dcw/line-run'
import { executionModeOfAgent } from '../execution-mode'

export type RecipeOp = 'update' | 'dispatch' | 'trial' | 'rollback' | 'create'

export type ActiveRecipeContext = {
  lineId: string
  runId: string
  recipeId: string
  productId: string
}

export type RecipeGateResult
  = | { ok: true, binding: AgentNodeBinding, hitlRequired: boolean, activeContext: ActiveRecipeContext }
    | { ok: false, text: string }

/** 运行门:该配方当前是否有活动批次(未结束的 run) */
export function activeRunOfRecipe(recipeId: string): ActiveRecipeContext | null {
  const run = getDcwController().listRuns().find(r => r.recipeId === recipeId && !r.endedAt)
  if (!run) return null
  // 反僵尸交叉校验(鲁棒性):DB 行未结束 ≠ 产线在运行 —— 多次 apply/崩溃/重启会泄漏
  // endedAt=null 的历史行,若只查 DB,运行门会被僵尸批次永久放行(停止后仍可下发)。
  // 权威运行态是 line-run 注册表(内存+line-runs.json 落盘,崩溃可恢复):
  // run 所属产线必须在注册表中运行,且注册表的活跃批次就是本批次。
  const active = getActiveLineRun(run.lineId)
  if (!active || active.runId !== run.id || active.recipeId !== recipeId) return null
  return {
    lineId: active.lineId,
    runId: active.runId,
    recipeId: active.recipeId,
    productId: active.productId,
  }
}

/** 节点展示名(拒绝文案用;节点已删除时退回 id) */
function nodeLabel(nodeId: string): string {
  const n = getDcwController().byId(nodeId)
  return n ? `${n.name}(${nodeId})` : nodeId
}

function listNodes(ids: string[]): string {
  return ids.length > 0 ? ids.map(nodeLabel).join('、') : '(无)'
}

/** 统一鉴权门:绑定(配方级 ∪ 产线管理级 ∪ 点位级)→ 二级认证 → 运行门;返回绑定与 HITL 判定(不做挂起,挂起由调用方执行)
 *  targetNodeIds:本次动作实际覆盖的节点集;缺省 = 配方全部参数(整批 apply)。
 *  下发规则:持 recipe 级授权(单配方 ∨ 产线管理)且未绑任何 dcw → 全参数放行(向下兼容);
 *  绑了 dcw → 覆盖集 ⊆ dcw 绑定面;两者都无 → 纯点位轨(覆盖集 ⊆ dcw 面)。 */
export function assertRecipeOperation(
  agentId: string,
  recipe: { id: string, name: string, lineId?: string, params?: Array<{ nodeId: string }>, access?: { requireAuth?: boolean, authorizedAgentIds?: string[] } },
  op: RecipeOp,
  targetNodeIds?: string[],
): RecipeGateResult {
  const opLabel = op === 'update' ? '参数写入' : op === 'dispatch' ? '下发' : op === 'trial' ? '试验下发' : '回退'
  // ① 绑定门(三轨):recipe=单配方操作权;line-recipe=产线配方管理权;dcw=点位写授权(兼下发收窄器)
  const bindings = getAgentNodeBindingRepo().byAgent(agentId)
  const recipeBinding = bindings.find(b => b.kind === 'recipe' && b.nodeId === recipe.id)
  const lineBinding = recipe.lineId
    ? bindings.find(b => b.kind === 'line-recipe' && b.nodeId === recipe.lineId)
    : undefined
  const dcwBindings = bindings.filter(b => b.kind === 'dcw')
  const dcwBound = new Set(dcwBindings.map(b => b.nodeId))
  const recipeNodes = (recipe.params ?? []).map(p => p.nodeId).filter(Boolean)
  const targets = (targetNodeIds && targetNodeIds.length > 0 ? targetNodeIds : recipeNodes)
    .map(id => String(id ?? '').trim())
    .filter(Boolean)
  const versionOp = op === 'update' || op === 'rollback'
  // 配方级授权锚:单配方绑定 或 产线管理权(版本操作 + 「无 dcw 即全参数下发」的载体)
  const recipeLevelGrant = recipeBinding ?? lineBinding
  let coveringBindings: AgentNodeBinding[] = []
  if (!recipeLevelGrant) {
    if (versionOp) {
      return {
        ok: false,
        text: `无权${opLabel}配方「${recipe.name}」(${recipe.id}):节点绑定(dcw)只授予参数下发/试验权(点位授权),配方版本操作(参数保存/回退)需要配方级授权 —— 绑定该配方(kind='recipe')或持有其产线的配方管理权(kind='line-recipe')。请让用户或 lead 为你授权(recipe 绑定首绑默认 manual,每次动作需人工批准)。`,
      }
    }
    if (targets.length === 0) {
      return {
        ok: false,
        text: `无权${opLabel}配方「${recipe.name}」:配方没有参数节点,无法确认授权覆盖集。请先为配方配置参数节点,或让用户/lead 授予你配方级授权。`,
      }
    }
    const missing = targets.filter(id => !dcwBound.has(id))
    if (missing.length > 0) {
      return {
        ok: false,
        text: `无权${opLabel}配方「${recipe.name}」:本次覆盖的节点中有 ${missing.length} 个不在你的数控节点绑定面内 —— ${listNodes(missing)}。你已绑定的可写节点:${listNodes([...dcwBound])}。请让用户或 lead 为你补绑这些节点(节点绑定 = 点位写授权),或改用已授权节点重试;若要对整批配方操作,可请用户授予配方绑定(kind='recipe')或产线配方管理权(kind='line-recipe')。`,
      }
    }
    coveringBindings = dcwBindings.filter(b => targets.includes(b.nodeId))
  }
  else if (dcwBindings.length > 0 && !versionOp) {
    // 绑了 dcw = 下发范围收窄到这些点位(部分覆盖即拒);版本操作不受 dcw 收窄影响
    const missing = targets.filter(id => !dcwBound.has(id))
    if (missing.length > 0) {
      return {
        ok: false,
        text: `下发被收窄:你已绑定数控节点,${opLabel}只能覆盖这些点位。本次覆盖的节点中有 ${missing.length} 个未绑定 —— ${listNodes(missing)}。你已绑定的可写节点:${listNodes([...dcwBound])}。请只对已绑定节点下发,或让用户/lead 补绑后再试(未绑定任何数控节点时才默认对配方全部参数放行)。`,
      }
    }
    coveringBindings = dcwBindings.filter(b => targets.includes(b.nodeId))
  }
  // ② 二级认证(用户在配方编辑里开启并勾选授权 Agent;三轨共用)
  if (recipe.access?.requireAuth && !(recipe.access.authorizedAgentIds ?? []).includes(agentId)) {
    return {
      ok: false,
      text: `配方「${recipe.name}」已开启二级认证,你不在其授权 Agent 清单内,${opLabel}被拒。请让用户在配方编辑中把你的 Agent 加入授权清单(或关闭认证)。`,
    }
  }
  // ③ 运行门:未运行的配方不可操作(参数写入也一样 —— 运行外改动没有可下发载体,且防误改基线)
  const run = activeRunOfRecipe(recipe.id)
  if (!run) {
    return {
      ok: false,
      text: `配方「${recipe.name}」当前未在执行(产线上没有本配方的活动批次),按运行门约束${opLabel}被拒。请先由用户在产线开跑本配方,再进行参数写入/下发。`,
    }
  }
  // ④ HITL 判定:授权绑定 manual → 逐动作人工批准;auto → 免批。
  //    线级总闸(2026-10-08 生产化):line.controlMode='manual'(缺省)时,即便绑定为
  //    auto 也强制人工审批 —— 手动模式下人类必须过目每一次写动作。
  //    频道层钳位(2026-10-28 三模式):Agent 所属频道 executionMode='manual' 时同理强制;
  //    'auto'(中性缺省)/'observe'(分发层已拒写,不可达)不改变本判定。
  const lineManual = recipe.lineId ? getDcwLineRepo().controlModeOf(recipe.lineId) === 'manual' : false
  const channelManual = executionModeOfAgent(agentId) === 'manual'
  // ⑤ 全局开关兼容位:security.recipeDispatchApproval 开启时即便 auto 也挂审批(保留语义)
  const globalGate = false // 由调用方按 settingOf('security.recipeDispatchApproval') 叠加(本模块不依赖设置服务)
  void globalGate
  // dcw 点位轨的 manual 语义:覆盖本次批点的 dcw 绑定任一 manual 即挂审批(fail-safe)
  const nodeManual = coveringBindings.some(b => b.mode === 'manual')
  const binding = recipeLevelGrant ?? coveringBindings[0]
  if (!binding) {
    // 理论上不可达(配方级授权或全部覆盖必有其一);fail-closed 防实现漂移
    return { ok: false, text: `无权${opLabel}配方「${recipe.name}」:未找到有效授权绑定。` }
  }
  return { ok: true, binding, hitlRequired: binding.mode === 'manual' || nodeManual || lineManual || channelManual, activeContext: run }
}

/** 新建配方的授权门(尚无 recipe 可绑定):要求 Agent 在该线至少有一个授权锚
 *  (dcw 节点、已有配方,或 2026-10-28 起的产线配方管理权 kind='line-recipe'),
 *  并且 line 存在;manual 线/绑定 → 人工批准。
 *  频道绑线是只读扩权,不能单独作为新建配方的依据(否则只读频道可凭空造配方)。 */
export function assertRecipeCreate(agentId: string, lineId: string): { ok: true, hitlRequired: boolean } | { ok: false, text: string } {
  if (!lineId) return { ok: false, text: '新建配方需要明确产线(line_id 或 source_recipe_id 可推断)。' }
  const bindings = getAgentNodeBindingRepo().byAgent(agentId)
  let lineBound = false
  let manualBound = false
  for (const b of bindings) {
    if (b.kind === 'line-recipe') {
      // 产线配方管理权:对该线全部配方(含新建)的管理授权锚
      if (b.nodeId === lineId) {
        lineBound = true
        if (b.mode === 'manual') manualBound = true
      }
      continue
    }
    if (b.kind === 'recipe') {
      const r = getDcwController().listRecipes().find(x => x.id === b.nodeId)
      if (r?.lineId === lineId) {
        lineBound = true
        if (b.mode === 'manual') manualBound = true
      }
      continue
    }
    if (b.kind === 'dcw') {
      const n = getDcwController().byId(b.nodeId)
      if (n?.lineId === lineId) {
        lineBound = true
        if (b.mode === 'manual') manualBound = true
      }
    }
  }
  if (!lineBound) {
    return {
      ok: false,
      text: `无权在产线 ${lineId} 新建配方:你尚未持有该产线的任何授权锚(数控节点绑定、配方绑定或产线配方管理权)。新建配方会创建可下发的参数基线,必须由用户/lead 先授予 —— 绑定该线节点/配方,或授予产线配方管理权(kind='line-recipe';绑定首绑默认 manual,人工批准)。`,
    }
  }
  const lineManual = getDcwLineRepo().controlModeOf(lineId) === 'manual'
  const channelManual = executionModeOfAgent(agentId) === 'manual'
  return { ok: true, hitlRequired: manualBound || lineManual || channelManual }
}

/** 审批单载荷(结构化;前端审批卡渲染理由/参数/批次) */
export function recipeApprovalPayload(op: RecipeOp, recipeId: string, recipeName: string, extra: {
  reason: string
  params?: Array<{ nodeId: string, name: string, from: number | null, to: number, unit?: string }>
  context?: ActiveRecipeContext
  runId?: string
}): Record<string, unknown> {
  return {
    schemaVersion: 1,
    kind: 'recipe-gate',
    op,
    recipeId,
    recipeName,
    reason: extra.reason,
    ...(extra.params ? { params: extra.params } : {}),
    ...(extra.context ? { context: { ...extra.context }, runId: extra.context.runId } : extra.runId ? { runId: extra.runId } : {}),
  }
}
