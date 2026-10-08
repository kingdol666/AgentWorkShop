/**
 * Recipe 操作统一鉴权门(权限模型 v2)。
 *
 * Agent 不再直碰数控节点 —— 对产线的全部写动作收敛到「绑定的 recipe」上:
 *   ① 绑定门:必须持有该 recipe 的绑定(kind='recipe';可绑定多个配方);
 *   ② 认证门:recipe.access.requireAuth=true 时,只有 authorizedAgentIds 清单内的
 *      Agent 可操作(fail-closed:开认证但清单为空 = 无人可操作);
 *   ③ 运行门:配方必须**正在执行**(该产线存在本配方的活动批次)—— 未运行的配方
 *      一律不可操作(参数写入/下发/试验/回退同样受限);
 *   ④ HITL 判定:绑定 mode='manual' → 每次动作挂起等人工批准(必带 Agent 理由);
 *      mode='auto'(显式确认切换)→ 免批直执行。全局开关 security.recipeDispatchApproval
 *      保持兼容:开启时即便 auto 绑定也挂审批。
 *      线级总闸(2026-10-08):line.controlMode='manual'(缺省,fail-safe)时 auto 绑定
 *      也强制人工审批 —— 手动模式下人类必须过目每一次写动作。
 */
import { getAgentNodeBindingRepo, type AgentNodeBinding } from '../node-bindings.repo'
import { getDcwController } from '../../dcw/dcw-controller'
import { getDcwLineRepo } from '../../dcw/dcw-line.repo'
import { getActiveLineRun } from '../../dcw/line-run'

export type RecipeOp = 'update' | 'dispatch' | 'trial' | 'rollback'

export type RecipeGateResult
  = | { ok: true, binding: AgentNodeBinding, hitlRequired: boolean, activeRunId: string }
    | { ok: false, text: string }

/** 运行门:该配方当前是否有活动批次(未结束的 run) */
export function activeRunOfRecipe(recipeId: string): { id: string } | null {
  const run = getDcwController().listRuns().find(r => r.recipeId === recipeId && !r.endedAt)
  if (!run) return null
  // 反僵尸交叉校验(鲁棒性):DB 行未结束 ≠ 产线在运行 —— 多次 apply/崩溃/重启会泄漏
  // endedAt=null 的历史行,若只查 DB,运行门会被僵尸批次永久放行(停止后仍可下发)。
  // 权威运行态是 line-run 注册表(内存+line-runs.json 落盘,崩溃可恢复):
  // run 所属产线必须在注册表中运行,且注册表的活跃批次就是本批次。
  const active = getActiveLineRun(run.lineId)
  if (!active || active.runId !== run.id) return null
  return { id: run.id }
}

/** 统一鉴权门:绑定 → 二级认证 → 运行门;返回绑定与 HITL 判定(不做挂起,挂起由调用方执行) */
export function assertRecipeOperation(
  agentId: string,
  recipe: { id: string, name: string, lineId?: string, access?: { requireAuth?: boolean, authorizedAgentIds?: string[] } },
  op: RecipeOp,
): RecipeGateResult {
  const opLabel = op === 'update' ? '参数写入' : op === 'dispatch' ? '下发' : op === 'trial' ? '试验下发' : '回退'
  // ① 绑定门(kind='recipe';nodeId 字段 = recipeId)
  const binding = getAgentNodeBindingRepo().find(agentId, recipe.id, 'recipe')
  if (!binding) {
    return {
      ok: false,
      text: `无权${opLabel}配方「${recipe.name}」(${recipe.id}):你未绑定该配方。权限模型 v2 下 Agent 不直接操作数控节点 —— 通过绑定 recipe 获得参数写入与下发能力(可绑定多个配方);请让用户或 lead 为你绑定(recipe 绑定首绑默认 manual,每次动作需人工批准)。`,
    }
  }
  // ② 二级认证(用户在配方编辑里开启并勾选授权 Agent)
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
  // ④ HITL 判定:manual 绑定 → 逐动作人工批准;auto → 免批。
  //    线级总闸(2026-10-08 生产化):line.controlMode='manual'(缺省)时,即便绑定为
  //    auto 也强制人工审批 —— 手动模式下人类必须过目每一次写动作(fail-safe)。
  const lineManual = recipe.lineId ? getDcwLineRepo().controlModeOf(recipe.lineId) === 'manual' : false
  // ⑤ 全局开关兼容位:security.recipeDispatchApproval 开启时即便 auto 也挂审批(保留语义)
  const globalGate = false // 由调用方按 settingOf('security.recipeDispatchApproval') 叠加(本模块不依赖设置服务)
  void globalGate
  return { ok: true, binding, hitlRequired: binding.mode === 'manual' || lineManual, activeRunId: run.id }
}

/** 审批单载荷(结构化;前端审批卡渲染理由/参数/批次) */
export function recipeApprovalPayload(op: RecipeOp, recipeId: string, recipeName: string, extra: {
  reason: string
  params?: Array<{ nodeId: string, name: string, from: number | null, to: number, unit?: string }>
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
    ...(extra.runId ? { runId: extra.runId } : {}),
  }
}
