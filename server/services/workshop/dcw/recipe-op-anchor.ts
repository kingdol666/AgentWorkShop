/**
 * Recipe 下发操作间隔锚点(治理频控)。
 *
 * 语义(用户需求):每个 recipe 可配 opIntervalMs(缺省 60s);Agent 的下发族操作
 * (trial/apply/propose/rollback-dispatch)两次**已批准**下发之间必须 ≥ 该间隔;
 * 计时锚 = 上一次审批(HITL approve)时刻或该次下发执行成功时刻(封 auto 绑定连发);
 * 提案未获批(挂起/拒绝/超时)不产生新锚、不计时。
 *
 * 键控:按 recipeId 全局共享(跨 Agent;防多 Agent 轮番绕频控)。
 * 持久化:落盘 dcw-recipe-op-anchors.json(重启不清零,防"重启即绕频控");
 *         写失败仅告警不反噬主流程(与审批历史 remember 同口径)。
 * 豁免:人工 REST 下发与系统路径(产线开跑/基准恢复)不查不锚——它们不经
 *       agentDispatch 标记;emergency 仅豁免本频控,不豁免审批/四层限界/试验节拍。
 */
import { join } from 'node:path'
import { ensureDataDir } from '@/shared/config/home.mjs'
import { loadJsonFile, saveJsonFileAtomic } from '../json-store.mjs'
import { recipeOpIntervalMs } from './dcw-recipe.repo'
import { AppError, ErrorCodes } from '../../../utils/errors'

const ANCHORS_PATH = join(ensureDataDir(), 'dcw-recipe-op-anchors.json')
const ANCHORS_CAP = 200
const ANCHOR_TTL_MS = 24 * 3600_000

export interface RecipeOpAnchor {
  recipeId: string
  /** epoch ms(锚定时刻:审批 decidedAt 或下发执行完成) */
  at: number
  /** 审批单 id;auto 绑定无审批执行时为 '' */
  approvalId: string
  agentId: string
  op: 'trial' | 'apply' | 'propose' | 'rollback'
  source: 'hitl-approved' | 'agent-executed'
}

type Store = { anchors: RecipeOpAnchor[] }
const g = globalThis as unknown as { __recipeOpAnchors?: Store }
function store(): Store {
  if (!g.__recipeOpAnchors) g.__recipeOpAnchors = loadJson<Store>(ANCHORS_PATH, { anchors: [] })
  return g.__recipeOpAnchors
}
function loadJson<T>(file: string, fallback: T): T {
  return loadJsonFile(file, fallback) as T
}

function persist(): void {
  const s = store()
  // GC:超 TTL 的锚在写入时顺手清理(cap 双保险)
  const now = Date.now()
  s.anchors = s.anchors.filter(a => now - a.at < ANCHOR_TTL_MS).slice(-ANCHORS_CAP)
  try {
    saveJsonFileAtomic(ANCHORS_PATH, s)
  }
  catch (err) {
    console.warn('[recipe-op-anchor] 落盘失败(仅告警,不影响主流程):', err instanceof Error ? err.message : err)
  }
}

export function recordRecipeOpAnchor(a: RecipeOpAnchor): void {
  const s = store()
  s.anchors = s.anchors.filter(x => x.recipeId !== a.recipeId)
  s.anchors.push(a)
  persist()
}

export function getRecipeOpAnchor(recipeId: string): RecipeOpAnchor | null {
  return store().anchors.find(a => a.recipeId === recipeId) ?? null
}

/** 仅供测试:清空全部锚(内存+落盘) */
export function resetRecipeOpAnchors(): void {
  g.__recipeOpAnchors = { anchors: [] }
  persist()
}

/**
 * 频控判定:距上一锚不足 opIntervalMs 即抛 429(提案早拒与执行兜底共用)。
 * - emergency=true 豁免(审批不可豁免,由调用方保证照常挂卡)
 * - approvalId 命中锚内 id = 自己刚获批的那次,放行(防审批竞态:后批者胜出,先批者滞后执行被弹回)
 */
export function assertRecipeOpInterval(
  recipe: { id: string, name: string, opIntervalMs?: number },
  opts: { approvalId?: string, emergency?: boolean } = {},
): void {
  if (opts.emergency) return
  const interval = recipeOpIntervalMs(recipe)
  if (interval <= 0) return
  const anchor = getRecipeOpAnchor(recipe.id)
  if (!anchor) return
  if (opts.approvalId && anchor.approvalId && anchor.approvalId === opts.approvalId) return
  const elapsed = Date.now() - anchor.at
  if (elapsed >= interval) return
  const remainSec = Math.max(1, Math.ceil((interval - elapsed) / 1000))
  throw new AppError(429, ErrorCodes.RECIPE_OP_INTERVAL_NOT_ELAPSED,
    `配方「${recipe.name}」下发操作间隔卡控生效:上一次已批准/已执行的下发距现在仅 ${Math.floor(elapsed / 1000)}s`
    + `(审批 ${anchor.approvalId || '无单号'},操作者 ${anchor.agentId || 'auto'}),本配方要求 ≥${Math.round(interval / 1000)}s。`
    + `请等待约 ${remainSec}s 后重新提交;等待期间可用 daq_query 复测上一批次的工艺响应。`
    + `确属应急(如超限纠偏/安全恢复)可在调用时带 emergency=true 豁免频控——审批卡将标注【应急】并仍需人工批准,滥用会留审计痕迹。`)
}

/** 执行兜底用变体:存在更新的已批单抢先落锚时,文案区分"竞态拦截" */
export function assertRecipeOpIntervalForExecution(
  recipe: { id: string, name: string, opIntervalMs?: number },
  opts: { approvalId?: string, emergency?: boolean } = {},
): void {
  try {
    assertRecipeOpInterval(recipe, opts)
  }
  catch (err) {
    const anchor = getRecipeOpAnchor(recipe.id)
    if (anchor && opts.approvalId && anchor.approvalId && anchor.approvalId !== opts.approvalId && Date.now() - anchor.at < recipeOpIntervalMs(recipe)) {
      throw new AppError(429, ErrorCodes.RECIPE_OP_INTERVAL_NOT_ELAPSED,
        `配方「${recipe.name}」下发被间隔卡控拦截(执行时兜底):存在更新的已批准下发(审批 ${anchor.approvalId})已落锚,本方案审批(${opts.approvalId})未获执行。产线未做任何变更;请吸收最新已批方案意图后按指引重新提交。`)
    }
    throw err
  }
}
