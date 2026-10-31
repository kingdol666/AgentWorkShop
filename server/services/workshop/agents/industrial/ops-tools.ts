/**
 * 运维日志与配方变更史(ops_log / recipe_* / line_context)
 * (由 server/services/workshop/agents/industrial-tools.ts 按职责拆出;内容逐行原文搬运)
 */
import type { RecipeView } from '../../../../../shared/dcw-protocol'
import { agentBadgeLabel } from '../agent-badge'
import { getActiveLineRun } from '../../dcw/line-run'
import { getAgentNodeBindingRepo } from '../node-bindings.repo'
import { getDaqNodeRepo } from '../../daq/daq-node.repo'
import { getDcwController } from '../../dcw/dcw-controller'
import { getDcwLineRepo } from '../../dcw/dcw-line.repo'
import { getDcwProductRepo } from '../../dcw/dcw-product.repo'
import { getDcwRecipeRepo } from '../../dcw/dcw-recipe.repo'
import { assertRecipeOpInterval } from '../../dcw/recipe-op-anchor'
import { getDcwParamRepo } from '../../dcw/param-map.repo'
import { getOps, recordOps } from '../../ops/ops'
import { settingOf } from '../../settings'
import { fanoutQuery, windowOf } from './audit-query'
import { assertRecipeCreate, assertRecipeOperation, recipeApprovalPayload, type ActiveRecipeContext } from './recipe-gate'
import { RECOVERY_RETRY_HINT, RECOVERY_TRACE_HINT, RECOVERY_VERIFY_HINT } from './fallback-hints'
import { approvalOnlyTrialReceipt } from './bench-approval-only'
import { currentToolInvocation } from '../governance-harness-audit'
import { executionModeOfAgent } from '../execution-mode'

// ================================================================
// 运维日志 / Recipe 变更史查询(Agent 自查面:负责产线 scoped)
// ================================================================

/** v18:频道绑定产线(只读扩权)——经全局 manager 读;manager 未装配/未绑定 = null
 *  (export 供 analysis-tools 等同族工具复用「频道绑线=默认目标产线」语义) */
export function channelBoundLineId(agentId: string): string | null {
  try {
    const g = globalThis as typeof globalThis & {
      __workshopManager?: { channelLineBindingOf(id: string): string | null }
    }
    return g.__workshopManager?.channelLineBindingOf(agentId) ?? null
  }
  catch {
    return null
  }
}

/** Agent 负责范围 = 绑定节点的全集(节点 id 集 + 这些节点所属产线集)
 *  ∪ 绑定配方所在产线(kind='recipe';v2 权限模型:配方绑定授予该线的读面+配方操作面)
 *  ∪ 频道绑定产线(boundLineIds;v18 只读扩权:日志/配方史/上下文可读)。 */
export function agentOpsScope(agentId: string): { lineIds: string[], nodeIds: Set<string>, boundLineIds: string[] } | null {
  const bindings = getAgentNodeBindingRepo().byAgent(agentId)
  const boundLine = channelBoundLineId(agentId)
  const boundLineIds = new Set<string>(boundLine ? [boundLine] : [])
  if (bindings.length === 0 && boundLineIds.size === 0) return null
  const lineIds = new Set<string>()
  const nodeIds = new Set<string>()
  for (const b of bindings) {
    if (b.kind === 'recipe') {
      // 配方绑定:配方所在产线进读面(boundLineIds);配方参数节点进可见节点集(mes_fetch/line_context)
      try {
        const recipe = getDcwController().listRecipes().find(r => r.id === b.nodeId)
        if (recipe?.lineId) {
          boundLineIds.add(recipe.lineId)
          lineIds.add(recipe.lineId)
          for (const p of recipe.params) nodeIds.add(p.nodeId)
        }
      }
      catch { /* 配方刚被删等情况忽略 */ }
      continue
    }
    nodeIds.add(b.nodeId)
    try {
      const n = b.kind === 'dcw' ? getDcwController().byId(b.nodeId) : getDaqNodeRepo().byId(b.nodeId)
      if (n?.lineId) lineIds.add(n.lineId)
    }
    catch { /* 节点刚被删等情况忽略 */ }
  }
  return { lineIds: [...lineIds], nodeIds, boundLineIds: [...boundLineIds] }
}

/** 读工具的可见产线全集 = 节点授权线 ∪ 频道绑定线(去重) */
function readableLineIds(scope: { lineIds: string[], boundLineIds: string[] }): string[] {
  return [...new Set([...scope.lineIds, ...scope.boundLineIds])]
}

/** 产线展示标注:仅频道绑定(非节点授权)的线标注只读来源 */
function lineTag(lid: string, scope: { lineIds: string[], boundLineIds: string[] }): string {
  return scope.lineIds.includes(lid) ? '' : '(频道绑定,只读)'
}

/** 配方参数的节点失效态(数据一致性展示/Agent 提示共用):null=正常 */
export function nodeRefStatus(nodeId: string, lineId: string): { code: 'deleted' | 'disabled' | 'unbound', label: string } | null {
  const node = getDcwController().byId(nodeId)
  if (!node) return { code: 'deleted', label: '已删除' }
  if (!node.enabled) return { code: 'disabled', label: '已停用' }
  if (node.lineId !== lineId) return { code: 'unbound', label: '已取消绑定' }
  return null
}

export const OPS_ACTOR_LABEL: Record<string, string> = { agent: 'Agent', user: '用户', system: '系统' }

export function fmtAuditAt(iso: string): string {
  return iso.length >= 19 ? iso.slice(5, 19).replace('T', ' ') : iso
}

/** 日志行归属标签所需的名称索引(一次构建,行内复用) */
function scopeMaps() {
  return {
    lines: new Map(getDcwLineRepo().all().map(l => [l.id, l.name])),
    products: new Map(getDcwProductRepo().all().map(p => [p.id, p.name])),
    recipes: new Map(getDcwController().listRecipes().map(r => [r.id, r.name])),
  }
}

type ScopeMaps = ReturnType<typeof scopeMaps>

/** 产线标签:名称[完整 id](Agent 可直接把 id 回传给 line_id) */
function lineLabelOf(id: string, maps: ScopeMaps): string {
  if (!id) return ''
  return `${maps.lines.get(id) ?? '(产线已删除)'}[${id}]`
}

function productLabelOf(id: string, maps: ScopeMaps): string {
  if (!id) return ''
  return `${maps.products.get(id) ?? '(产品已删除)'}[${id}]`
}

function recipeLabelOf(id: string, maps: ScopeMaps): string {
  if (!id) return ''
  return `${maps.recipes.get(id) ?? '(配方已删除)'}[${id}]`
}

/** 单行的域标识 + 归属串:scope + 产线 + 配方 + 产品(空维度显式写 -) */
function rowScopeOf(row: Record<string, unknown>, maps: ScopeMaps): string {
  const lid = String(row.lineId ?? '')
  const rid = String(row.recipeId ?? '')
  const pid = String(row.productId ?? '')
  const scope = String(row.scope ?? (lid ? 'line' : 'system'))
  return `scope=${scope} 产线=${lineLabelOf(lid, maps) || '-'} 配方=${recipeLabelOf(rid, maps) || '-'} 产品=${productLabelOf(pid, maps) || '-'}`
}

/** 节点归属产线(dcw 优先,daq 兜底);节点不存在/未挂线返回空串 */
function nodeLineOf(nodeId: string): string {
  try {
    const dcw = getDcwController().byId(nodeId)
    if (dcw) return dcw.lineId ?? ''
    const daq = getDaqNodeRepo().byId(nodeId)
    return daq?.lineId ?? ''
  }
  catch {
    return ''
  }
}

/** 工具:ops_log —— 产线日志查询(下发/判定/回退/配方/产线/数采/告警/人工记录)。
 *
 *  **只返回产线域记录**(line_id 非空);登录/用户管理/系统设置/备份等全局审计不进本工具。
 *  权限:节点授权线 ∪ 配方绑定线 ∪ 频道绑定线;line_id/recipe_id 只能缩小范围,不能放大。
 *  时间:from/to 绝对时间优先,否则 minutes 回看;结果行逐条带产线与配方归属。
 */
export async function toolOpsLog(agentId: string, args: {
  line_id?: string
  recipe_id?: string
  product_id?: string
  node_id?: string
  kind?: string
  actor_kind?: string
  minutes?: number | string
  from?: string
  to?: string
  limit?: number | string
  mine?: boolean | string
}): Promise<{ text: string, isError?: boolean }> {
  const audit = getOps()?.audit
  if (!audit) return { text: '审计仓储未装配(服务未就绪),请稍后重试。', isError: true }
  const scope = agentOpsScope(agentId)
  if (!scope) return { text: '你尚未绑定任何工业节点,所在频道也未绑定产线,无日志可查(日志权限跟随节点绑定或频道绑线)。', isError: true }
  const nodeId = String(args.node_id ?? '').trim()
  const wantedLine = String(args.line_id ?? '').trim()
  const recipeId = String(args.recipe_id ?? '').trim()
  const productId = String(args.product_id ?? '').trim()
  const readable = readableLineIds(scope)
  if (wantedLine && !readable.includes(wantedLine))
    return { text: `无权查询产线 ${wantedLine} 的日志(你的可读产线:${readable.join(', ') || '(无)'})。`, isError: true }

  // 配方/产品过滤:存在性 + 归属产线校验;它们同时决定默认产线(避免跨线混合结果)
  const recipe = recipeId ? getDcwController().listRecipes().find(r => r.id === recipeId) : undefined
  if (recipeId && !recipe)
    return { text: `配方 ${recipeId} 不存在(用 line_context 查看当前配方 id)。`, isError: true }
  if (recipe?.lineId && !readable.includes(recipe.lineId))
    return { text: `无权查询配方 ${recipeId} 的日志(该配方归属产线 ${recipe.lineId},不在你的可读产线:${readable.join(', ') || '(无)'})。`, isError: true }
  if (wantedLine && recipe?.lineId && recipe.lineId !== wantedLine)
    return { text: `配方「${recipe.name}」归属产线 ${recipe.lineId},与 line_id=${wantedLine} 不一致;请用正确产线或只传 recipe_id。`, isError: true }
  const product = productId ? getDcwProductRepo().byId(productId) : undefined
  if (productId && !product)
    return { text: `产品 ${productId} 不存在(用 line_context 查看当前产品 id)。`, isError: true }
  if (product?.lineId && !readable.includes(product.lineId))
    return { text: `无权查询产品 ${productId} 的日志(该产品归属产线 ${product.lineId},不在你的可读产线:${readable.join(', ') || '(无)'})。`, isError: true }
  if (wantedLine && product?.lineId && product.lineId !== wantedLine)
    return { text: `产品「${product.name}」归属产线 ${product.lineId},与 line_id=${wantedLine} 不一致。`, isError: true }

  // 节点过滤:只读面允许读可读产线上的任意节点(与 tool-verify 的频道绑线只读扩权同口径)
  const nodeLine = nodeId ? nodeLineOf(nodeId) : ''
  if (nodeId && !nodeLine)
    return { text: `节点 ${nodeId} 不存在或未分配产线(用 my_industrial_nodes / line_context 查看在线节点)。`, isError: true }
  if (nodeId && !readable.includes(nodeLine))
    return { text: `无权查询节点 ${nodeId} 的日志(节点归属产线 ${nodeLine},不在你的可读产线:${readable.join(', ') || '(无)'})。`, isError: true }
  if (wantedLine && nodeLine && nodeLine !== wantedLine)
    return { text: `节点 ${nodeId} 归属产线 ${nodeLine},与 line_id=${wantedLine} 不一致。`, isError: true }

  const win = windowOf(args)
  if (win.error) return { text: win.error, isError: true }
  const { minutes, limit, from, to } = win
  const kind = String(args.kind ?? '').trim() || undefined
  const actorKind = String(args.actor_kind ?? '').trim() || undefined
  const mine = args.mine === true || args.mine === 'true'

  // 默认产线优先级:显式 line_id > 配方 > 产品 > 节点 > 频道绑线 > 全部可读线
  const channelLine = channelBoundLineId(agentId)
  const lines = wantedLine
    ? [wantedLine]
    : recipe?.lineId
      ? [recipe.lineId]
      : product?.lineId
        ? [product.lineId]
        : nodeLine
          ? [nodeLine]
          : channelLine && readable.includes(channelLine)
            ? [channelLine]
            : readable

  const maps = scopeMaps()
  let rows = fanoutQuery(audit, lines, lid => ({
    scope: 'line',
    lineId: lid,
    recipeId: recipeId || undefined,
    productId: productId || undefined,
    kind,
    actorKind,
    actor: mine ? agentId : undefined,
    targetId: nodeId || undefined,
    from,
    ...(to ? { to } : {}),
    limit,
  }))
  rows.sort((a, b) => String(b.at).localeCompare(String(a.at)))
  rows = rows.slice(0, limit)

  const lineNote = lines.length === 1 ? `产线 ${lineLabelOf(lines[0]!, maps)}` : `可读产线 ${lines.length} 条`
  const filterBits = [lineNote]
  if (recipeId) filterBits.push(`配方 ${recipeLabelOf(recipeId, maps)}`)
  if (productId) filterBits.push(`产品 ${productLabelOf(productId, maps)}`)
  if (nodeId) filterBits.push(`节点 ${nodeId}`)
  if (kind) filterBits.push(`分类 ${kind}`)
  if (actorKind) filterBits.push(`来源 ${actorKind}`)
  if (mine) filterBits.push('仅我自己')
  const windowNote = to
    ? `时间窗 ${String(from).slice(0, 19).replace('T', ' ')} ~ ${String(to).slice(0, 19).replace('T', ' ')}`
    : `近 ${minutes} 分钟`
  if (rows.length === 0) {
    return {
      text: `${windowNote}内无匹配的产线日志(${filterBits.join('; ')})。可调大 minutes / 放宽 kind、actor_kind、node_id,或确认 line_id/recipe_id 是否正确;先 line_context 核对产线与配方 id。`,
    }
  }

  const body = rows.map((r) => {
    const src = OPS_ACTOR_LABEL[String(r.actorKind)] ?? String(r.actorKind)
    return `- [${fmtAuditAt(String(r.at))}] ${rowScopeOf(r, maps)} | 来源=${src} 操作者=${String(r.actorName) || String(r.actor)} | ${String(r.action)} | ${String(r.summary)}`
  })
  return {
    text: `产线日志(${filterBits.join('; ')}, ${windowNote}, ${rows.length} 条, 新→旧):\n${body.join('\n')}\n\n说明:只含产线域记录(登录/用户管理/系统设置/备份等全局审计不在本工具);来源=Agent 的操作者格式为「Channel名/成员名」;节点级参数值变更史用 dcw_journal,配方下发/回退专门视图用 recipe_log。`,
  }
}

/** 工具:recipe_log —— 产线的配方变更史(创建/更新/试验/正式下发/ACK 鉴定/回退)。
 *
 *  **只返回产线域记录**(line_id 非空);按 action 前缀 recipe. 跨 kind 取全族
 *  (recipe.apply 的 ACK 行 kind=write 也会命中),再叠加 optimization.* 回退记录。
 *  时间:from/to 绝对时间优先,否则 minutes 回看;结果行逐条带产线与配方归属。
 */
export async function toolRecipeLog(agentId: string, args: {
  line_id?: string
  recipe_id?: string
  product_id?: string
  minutes?: number | string
  from?: string
  to?: string
  limit?: number | string
}): Promise<{ text: string, isError?: boolean }> {
  const audit = getOps()?.audit
  if (!audit) return { text: '审计仓储未装配(服务未就绪),请稍后重试。', isError: true }
  const scope = agentOpsScope(agentId)
  if (!scope) return { text: '你尚未绑定任何工业节点,所在频道也未绑定产线,无 Recipe 历史可查(权限跟随节点绑定或频道绑线)。', isError: true }
  const wantedLine = String(args.line_id ?? '').trim()
  const recipeId = String(args.recipe_id ?? '').trim()
  const productId = String(args.product_id ?? '').trim()
  const readable = readableLineIds(scope)
  if (wantedLine && !readable.includes(wantedLine))
    return { text: `无权查询产线 ${wantedLine} 的 Recipe 历史(你的可读产线:${readable.join(', ') || '(无)'})。`, isError: true }

  const recipe = recipeId ? getDcwController().listRecipes().find(r => r.id === recipeId) : undefined
  if (recipeId && !recipe)
    return { text: `配方 ${recipeId} 不存在(用 line_context 查看当前配方 id)。`, isError: true }
  if (recipe?.lineId && !readable.includes(recipe.lineId))
    return { text: `无权查询配方 ${recipeId} 的 Recipe 历史(该配方归属产线 ${recipe.lineId},不在你的可读产线:${readable.join(', ') || '(无)'})。`, isError: true }
  if (wantedLine && recipe?.lineId && recipe.lineId !== wantedLine)
    return { text: `配方「${recipe.name}」归属产线 ${recipe.lineId},与 line_id=${wantedLine} 不一致;请用正确产线或只传 recipe_id。`, isError: true }
  const product = productId ? getDcwProductRepo().byId(productId) : undefined
  if (productId && !product)
    return { text: `产品 ${productId} 不存在(用 line_context 查看当前产品 id)。`, isError: true }
  if (product?.lineId && !readable.includes(product.lineId))
    return { text: `无权查询产品 ${productId} 的 Recipe 历史(该产品归属产线 ${product.lineId},不在你的可读产线:${readable.join(', ') || '(无)'})。`, isError: true }

  const win = windowOf(args)
  if (win.error) return { text: win.error, isError: true }
  const { minutes, limit, from, to } = win

  const channelLine = channelBoundLineId(agentId)
  const lines = wantedLine
    ? [wantedLine]
    : recipe?.lineId
      ? [recipe.lineId]
      : product?.lineId
        ? [product.lineId]
        : channelLine && readable.includes(channelLine)
          ? [channelLine]
          : readable

  const maps = scopeMaps()
  const rows = fanoutQuery(audit, lines, lid => [
    // recipe.* 全族:创建/更新/试验/正式下发/ACK 鉴定/回退定义(跨 kind=recipe/write)
    { scope: 'line', lineId: lid, recipeId: recipeId || undefined, productId: productId || undefined, actionPrefix: 'recipe.', from, ...(to ? { to } : {}), limit },
    // 开跑/停线也属于"配方下发作业"(lineStart 会整批下发该配方参数)
    { scope: 'line', lineId: lid, recipeId: recipeId || undefined, productId: productId || undefined, action: 'line.start', from, ...(to ? { to } : {}), limit },
    { scope: 'line', lineId: lid, recipeId: recipeId || undefined, productId: productId || undefined, action: 'line.stop', from, ...(to ? { to } : {}), limit },
    // 优化记录的开窗/判定/回退(kind=rollback,action=optimization.*)
    { scope: 'line', lineId: lid, recipeId: recipeId || undefined, productId: productId || undefined, kind: 'rollback', from, ...(to ? { to } : {}), limit },
  ]).sort((a, b) => String(b.at).localeCompare(String(a.at))).slice(0, limit)

  const lineNote = lines.length === 1 ? `产线 ${lineLabelOf(lines[0]!, maps)}` : `可读产线 ${lines.length} 条`
  const filterBits = [lineNote]
  if (recipeId) filterBits.push(`配方 ${recipeLabelOf(recipeId, maps)}`)
  if (productId) filterBits.push(`产品 ${productLabelOf(productId, maps)}`)
  const windowNote = to
    ? `时间窗 ${String(from).slice(0, 19).replace('T', ' ')} ~ ${String(to).slice(0, 19).replace('T', ' ')}`
    : `近 ${minutes} 分钟`
  if (rows.length === 0) {
    return {
      text: `${windowNote}内无配方变更记录(${filterBits.join('; ')})。可调大 minutes / 放宽时间窗,或确认 line_id/recipe_id 是否正确;先 line_context 核对产线与配方 id。`,
    }
  }

  const tagOf = (action: string): string => ({
    'recipe.apply': '配方下发',
    'recipe.dispatch.ack': '下发回执',
    'recipe.trial': '配方试验',
    'recipe.update': '配方更新',
    'recipe.update.agent': 'Agent 配方更新',
    'recipe.revert': '配方回退',
    'recipe.create': '配方创建',
    'recipe.delete': '配方删除',
    'recipe.propose': '方案审批',
    'recipe.mark-good': '标记良好批次',
    'recipe.rollback-good': '回退到良好批次',
    'line.start': '开跑整批下发',
    'line.stop': '停线',
    'optimization.open': '优化开窗',
    'optimization.judge': '优化判定',
    'optimization.rollback': '回退执行',
  } as Record<string, string>)[action] ?? action

  const body = rows.map((r) => {
    const src = OPS_ACTOR_LABEL[String(r.actorKind)] ?? String(r.actorKind)
    const action = String(r.action)
    return `- [${fmtAuditAt(String(r.at))}] ${tagOf(action)} ${rowScopeOf(r, maps)} | 来源=${src} 操作者=${String(r.actorName) || String(r.actor)} | ${String(r.summary)}`
  })
  return {
    text: `Recipe 变更史(${filterBits.join('; ')}, ${windowNote}, ${rows.length} 条, 新→旧):\n${body.join('\n')}\n\n说明:只含产线域记录;配方下发=整批参数写命令;下发回执=逐参数 ACK 鉴定;配方试验=候选整批下发(不写版本);优化开窗/判定/回退=单次设定变更与恢复。节点级参数值逐笔历史用 dcw_journal(node_id)。`,
  }
}

// ================================================================
// 产线上下文 + Recipe 版本管理(Agent 操控闭环:知道改什么 → 保存 → 可回退)
// ================================================================

/** 工具:line_context —— 我控制的产线/产品/Recipe 全景(归属认知 + 完整参数面)。
 *  逐产线输出:产线名/运行态、活动批次(产品/配方/版本/参数)、我的节点绑定、
 *  配方目标 vs PLC 当前值对照、lastGood 批次。 */
export async function toolLineContext(agentId: string, args: { line_id?: string } = {}): Promise<{ text: string, isError?: boolean }> {
  const scope = agentOpsScope(agentId)
  if (!scope) return { text: '你尚未绑定任何工业节点,所在频道也未绑定产线,暂无产线上下文(可在频道设置绑定产线获得只读上下文,或在数字孪生界面绑定节点)。' }
  const wanted = String(args.line_id ?? '').trim()
  const readable = readableLineIds(scope)
  const lineIds = wanted ? [wanted] : readable
  if (wanted && !readable.includes(wanted)) {
    return { text: `产线 ${wanted} 不在你的可读范围(节点授权与频道绑定覆盖:${readable.join(', ') || '无'})。`, isError: true }
  }
  if (lineIds.length === 0) return { text: '你绑定的节点均未分配产线(未挂线的节点没有产线/产品/配方上下文)。' }

  const sections: string[] = []
  for (const lid of lineIds) {
    const line = getDcwLineRepo().byId(lid)
    const run = getActiveLineRun(lid)
    const recipe = run?.recipeId ? getDcwController().listRecipes().find(r => r.id === run.recipeId) : undefined
    const parts: string[] = []
    parts.push(`■ 产线 ${line?.name ?? lid}(${lid})${lineTag(lid, scope)} · 状态:${run ? '运行中' : '待机/停线'}`)
    // 场景描述(产线/产品的本体说明;不透出则 Agent 不知道这条线是干什么的)
    if (line?.description?.trim()) parts.push(`  场景说明: ${line.description.trim().slice(0, 220)}`)
    if (run) {
      parts.push(`  活动批次 ${run.runId.slice(0, 8)} · 产品「${run.productName}」(${run.productId}) · 开跑 ${run.startedAt.slice(11, 19)} · 已打标 ${run.taggedSamples} 样本`)
    }
    const myDcw = getAgentNodeBindingRepo().byAgent(agentId)
      .filter(b => b.kind === 'dcw')
      .map(b => getDcwController().byId(b.nodeId))
      .filter(n => n?.lineId === lid)
    const myDaq = getAgentNodeBindingRepo().byAgent(agentId)
      .filter(b => b.kind === 'daq')
      .map(b => getDaqNodeRepo().byId(b.nodeId))
      .filter(n => n?.lineId === lid)
    const myRecipeIds = getAgentNodeBindingRepo().byAgent(agentId)
      .filter(b => b.kind === 'recipe')
      .map(b => b.nodeId)
    const myRecipes = myRecipeIds
      .map(id => getDcwController().listRecipes().find(r => r.id === id))
      .filter((r): r is NonNullable<typeof r> => !!r && r.lineId === lid)
    parts.push(`  我绑定的节点:数控 [${myDcw.map(n => n!.name).join(', ') || '无'}];数采 [${myDaq.map(n => n!.name).join(', ') || '无'}]`)
    if (myRecipes.length > 0) parts.push(`  我绑定的配方: [${myRecipes.map(r => `${r.name}(v${r.version ?? 1}${getDcwController().listRuns().some(x => x.recipeId === r.id && !x.endedAt) ? ',执行中' : ',未运行'})`).join('; ')}]`)
    if (recipe) {
      parts.push(`  配方「${recipe.name}」(${recipe.id}) v${recipe.version ?? 1}${recipe.description ? ` — ${recipe.description}` : ''}`)
      const product = recipe.productId ? getDcwProductRepo().byId(recipe.productId) : undefined
      if (product?.description?.trim()) parts.push(`  产品说明(${product.name}): ${product.description.trim().slice(0, 160)}`)
      for (const p of recipe.params) {
        const node = getDcwController().byId(p.nodeId)
        const mine = myDcw.some(n => n!.id === p.nodeId)
        const stale = nodeRefStatus(p.nodeId, recipe.lineId)
        const staleTag = stale ? ` [${stale.label},参数不下发]` : ''
        const cur = node?.value != null ? node.value : '?'
        const win = p.min != null || p.max != null ? `(窗口 ${p.min ?? '-∞'}~${p.max ?? '+∞'})` : ''
        const pv = getDcwParamRepo().listViews().find(v => v.nodeId === p.nodeId)
        parts.push(`    · ${node?.name ?? p.nodeId} = ${p.value}${node?.unit ?? ''}${win} | PLC 当前 ${cur}${node?.unit ?? ''}${mine ? ' [我负责]' : ''}${staleTag}${pv ? ` | 参数键 ${pv.key}` : ''}${pv?.desc ? ` | ${pv.desc.slice(0, 90)}` : ''}`)
      }
      const good = recipe.lastGoodRunId ? getDcwRecipeRepo().runById(recipe.lastGoodRunId) : undefined
      parts.push(`  已知良好批次:${good ? `${good.id.slice(0, 8)}(${good.startedAt.slice(0, 19).replace('T', ' ')})` : '未标记'};当前参数版本 v${recipe.version ?? 1}`)
    }
    else {
      // 无活动批次:列出该产线的配方定义(产线未开跑也有配方上下文)
      const lineRecipes = getDcwController().listRecipes().filter(r => r.lineId === lid).slice(0, 3)
      if (lineRecipes.length === 0) {
        parts.push('  当前无活动配方(产线未开跑;该产线也暂无配方定义)')
      }
      else {
        parts.push(`  当前无活动批次;产线已有 ${lineRecipes.length} 个配方定义(开跑时绑定):`)
        for (const r of lineRecipes) {
          const product = r.productId ? getDcwProductRepo().byId(r.productId) : undefined
          const pp = r.params.map((p) => {
            const node = getDcwController().byId(p.nodeId)
            const cur = node?.value != null ? node.value : '?'
            const stale = nodeRefStatus(p.nodeId, r.lineId)
            const tag = stale ? `[${stale.label},参数不下发]` : ''
            return `${node?.name ?? p.nodeId}=${p.value}${node?.unit ?? ''}(PLC 当前 ${cur})${tag}`
          }).join(', ')
          parts.push(`    · 配方「${r.name}」(${r.id}) v${r.version ?? 1} · 产品「${product?.name ?? r.productId}」: ${pp}${r.lastGoodRunId ? ` [良好批次 ${r.lastGoodRunId.slice(0, 8)}]` : ''}`)
        }
      }
    }
    sections.push(parts.join('\n'))
  }
  return {
    text: `你控制的产线全景(${sections.length} 条):\n\n${sections.join('\n\n')}\n\n说明:配方目标=开跑批次冻结的工艺窗口;PLC 当前值=实时读数;(频道绑定,只读)= 该线来自频道绑定的只读授权,可看日志/配方/状态,参数下发仍需节点授权。把验证过的最佳参数固化到配方用 recipe_update;回退配方到稳定版本用 recipe_rollback;逐节点参数变更史用 dcw_journal;配方版本史用 recipe_versions。`,
  }
}

/** 工具:recipe_catalog —— 可读产线上的配方目录(找 id / 当前执行配方 / 产品归属)。
 *  解决 Agent 只能从 line_context 文本里猜 recipe_id 的问题:按产线/产品/关键字过滤,
 *  每条给出 id、版本、产品、参数数量与当前 PLC 值、是否正在执行、良好批次。 */
export async function toolRecipeCatalog(agentId: string, args: { line_id?: string, product_id?: string, q?: string, limit?: number | string } = {}): Promise<{ text: string, isError?: boolean }> {
  const scope = agentOpsScope(agentId)
  if (!scope) return { text: '你尚未绑定任何工业节点,所在频道也未绑定产线,无可见配方(权限跟随节点绑定或频道绑线)。', isError: true }
  const readable = readableLineIds(scope)
  const wantedLine = String(args.line_id ?? '').trim()
  if (wantedLine && !readable.includes(wantedLine)) {
    return { text: `无权查看产线 ${wantedLine} 的配方(你的可读产线:${readable.join(', ') || '(无)'})。`, isError: true }
  }
  const productId = String(args.product_id ?? '').trim()
  const product = productId ? getDcwProductRepo().byId(productId) : undefined
  if (productId && !product) return { text: `产品 ${productId} 不存在。`, isError: true }
  if (product?.lineId && !readable.includes(product.lineId)) return { text: `无权查看产品 ${productId} 的配方(产品归属产线 ${product.lineId} 不在你的可读范围)。`, isError: true }
  const q = String(args.q ?? '').trim().toLowerCase()
  const limit = Math.min(Math.max(Math.round(Number(args.limit)) || 20, 1), 100)
  const lines = wantedLine ? [wantedLine] : product?.lineId ? [product.lineId] : readable
  const all = getDcwController().listRecipes().filter(r => lines.includes(r.lineId))
  const filtered = all.filter((r) => {
    if (productId && r.productId !== productId) return false
    if (q && !`${r.name} ${r.description ?? ''}`.toLowerCase().includes(q)) return false
    return true
  })
  const shown = filtered.slice(0, limit)
  const maps = scopeMaps()
  const body = shown.map((r) => {
    const active = getActiveLineRun(r.lineId)
    const running = active?.recipeId === r.id
    const prod = getDcwProductRepo().byId(r.productId)
    const pp = r.params.map((p) => {
      const node = getDcwController().byId(p.nodeId)
      const cur = node?.value != null ? `→PLC ${node.value}${node.unit ?? ''}` : ''
      return `${node?.name ?? p.nodeId}=${p.value}${node?.unit ?? ''}${cur}`
    }).join(', ')
    return `- ${r.name}(id=${r.id}) v${r.version ?? 1} | 产线 ${lineLabelOf(r.lineId, maps)} | 产品 ${prod?.name ?? r.productId}(${r.productId}) | ${running ? '**当前执行中**' : '未执行'} | 参数 ${r.params.length} 项: ${pp}${r.lastGoodRunId ? ` | 良好批次 ${r.lastGoodRunId.slice(0, 8)}` : ''}`
  })
  return {
    text: `配方目录(${filtered.length} 个${wantedLine ? `,产线 ${wantedLine}` : ''}${productId ? `,产品 ${productId}` : ''}${q ? `,关键字「${args.q}」` : ''};显示 ${shown.length} 条):\n${body.join('\n') || '(无匹配配方)'}${filtered.length > shown.length ? `\n(另有 ${filtered.length - shown.length} 个未显示,可收紧过滤或调大 limit)` : ''}\n\n说明:recipe_apply/recipe_trial/recipe_update 需要 recipe_id;若只知产线,可直接传 line_id 让工具解析当前执行配方。新建/另存配方用 recipe_create(manual 线需人工批准)。`,
  }
}

/** 工具:recipe_create —— 把当前配方/批次冻结参数另存为新配方(不触产线)。
 *  典型用法:优化验证后把"当前有效配方 + 实测参数"固化成新配方(如产品换型/新工艺基线)。
 *  权限:需在该产线已有写向绑定(数控节点或配方);manual 线/绑定 → 人工批准。
 *  新建后不会自动绑定给 Agent,需用户/lead 在界面绑定后才能继续 update/apply(返回文案会提示)。 */
export async function toolRecipeCreate(agentId: string, args: {
  name?: string
  description?: string
  product_id?: string
  line_id?: string
  source_recipe_id?: string
  from_run_id?: string
  use_active_run?: boolean | string
  params?: Array<{ node_id?: string, value?: number | string, min?: number | string, max?: number | string, step_limit?: number | string }>
  daq_windows?: Array<{ node_id?: string, min?: number | string, max?: number | string }>
  access?: { require_auth?: boolean, authorized_agent_ids?: string[] }
  reason?: string
}): Promise<{ text: string, isError?: boolean }> {
  const name = String(args.name ?? '').trim()
  const reason = String(args.reason ?? '').trim()
  if (!name) return { text: 'name 必填:新配方名称。', isError: true }
  if (!reason) return { text: 'reason 必填:说明为什么另存为新配方(依据/用途),便于版本史与人工审批。', isError: true }
  const records = getDcwController().listRecipes()
  const sourceId = String(args.source_recipe_id ?? '').trim()
  let source = sourceId ? records.find(r => r.id === sourceId) : undefined
  if (sourceId && !source) return { text: `源配方 ${sourceId} 不存在。`, isError: true }
  const runId = String(args.from_run_id ?? '').trim()
  let run = runId ? getDcwRecipeRepo().runById(runId) : undefined
  if (runId && !run) return { text: `批次 ${runId} 不存在。`, isError: true }
  if (!source && run) {
    const runRecipeId = run.recipeId
    source = records.find(r => r.id === runRecipeId)
  }
  const scope = agentOpsScope(agentId)
  const readable = scope ? readableLineIds(scope) : []
  let lineId = String(args.line_id ?? '').trim() || source?.lineId || (run as { lineId?: string } | undefined)?.lineId || ''
  if (!lineId) {
    const active = getActiveLineRun(channelBoundLineId(agentId) ?? '')
    lineId = active?.lineId ?? readable[0] ?? ''
  }
  // use_active_run:显式要求以当前活动批次为源(参数用批次冻结快照)
  if (!run && (args.use_active_run === true || args.use_active_run === 'true') && lineId) {
    const active = getActiveLineRun(lineId)
    if (active) {
      run = getDcwRecipeRepo().runById(active.runId)
      if (!source) source = records.find(r => r.id === active.recipeId)
    }
  }
  if (!lineId) return { text: '无法确定产线:请提供 line_id 或 source_recipe_id(from_run_id 也可推断)。', isError: true }
  if (!readable.includes(lineId)) return { text: `无权在产线 ${lineId} 新建配方(你的可读产线:${readable.join(', ') || '(无)'})。`, isError: true }
  let productId = String(args.product_id ?? '').trim() || source?.productId || (run?.productId ?? '')
  if (!productId && lineId) {
    // 只给 line_id 时:该线仅挂一个产品则自动归属(与"只传 line_id 即可操作"的工具哲学一致;
    // 多产品歧义仍要求显式 product_id,fail-closed)
    const lineProducts = getDcwProductRepo().all().filter(p => p.lineId === lineId)
    if (lineProducts.length === 1) productId = lineProducts[0]!.id
  }
  const product = productId ? getDcwProductRepo().byId(productId) : undefined
  if (!productId || !product) return { text: `产品 ${productId || '(未提供)'} 不存在;新配方必须归属产品(product_id、源配方推断,或该产线恰好只挂一个产品时自动归属)。`, isError: true }
  if (product.lineId !== lineId) return { text: `产品「${product.name}」归属产线 ${product.lineId},与目标产线 ${lineId} 不一致。`, isError: true }
  if (source && source.lineId !== lineId) return { text: `源配方「${source.name}」归属产线 ${source.lineId},与目标产线 ${lineId} 不一致。`, isError: true }

  // 参数来源优先级:显式 params > 批次冻结快照 > 源配方定义
  type NewParam = { nodeId: string, value: number, min?: number, max?: number, stepLimit?: number, templateRef?: string }
  let params: NewParam[]
  if (Array.isArray(args.params) && args.params.length > 0) {
    params = []
    for (const p of args.params) {
      const nodeId = String(p?.node_id ?? '').trim()
      const value = Number(p?.value)
      if (!nodeId || !Number.isFinite(value)) return { text: 'params 每项必须提供 node_id 与数值 value。', isError: true }
      const node = getDcwController().byId(nodeId)
      if (!node) return { text: `节点 ${nodeId} 不存在。`, isError: true }
      if (node.lineId !== lineId) return { text: `节点「${node.name}」不在目标产线 ${lineId},不能写入新配方。`, isError: true }
      if (!node.enabled) return { text: `节点「${node.name}」已停用,不能写入新配方。`, isError: true }
      const one: NewParam = { nodeId, value }
      if (p?.min != null && Number.isFinite(Number(p.min))) one.min = Number(p.min)
      if (p?.max != null && Number.isFinite(Number(p.max))) one.max = Number(p.max)
      if (p?.step_limit != null && Number.isFinite(Number(p.step_limit))) one.stepLimit = Number(p.step_limit)
      params.push(one)
    }
  }
  else if (run?.paramsSnapshot?.length) {
    params = run.paramsSnapshot.map(p => ({ nodeId: p.nodeId, value: p.value, min: p.min, max: p.max, stepLimit: p.stepLimit, templateRef: p.templateRef }))
  }
  else if (source) {
    params = source.params.map(p => ({ nodeId: p.nodeId, value: p.value, min: p.min, max: p.max, stepLimit: p.stepLimit, templateRef: p.templateRef }))
  }
  else {
    return { text: '没有可另存的参数:请提供 params,或给 source_recipe_id/from_run_id。', isError: true }
  }
  const windows = Array.isArray(args.daq_windows)
    ? args.daq_windows
        .map((w) => {
          const nodeId = String(w?.node_id ?? '').trim()
          const min = w?.min != null && Number.isFinite(Number(w.min)) ? Number(w.min) : undefined
          const max = w?.max != null && Number.isFinite(Number(w.max)) ? Number(w.max) : undefined
          return { nodeId, ...(min !== undefined ? { min } : {}), ...(max !== undefined ? { max } : {}) }
        })
        .filter(w => w.nodeId)
    : (source?.daqWindows ?? [])
  const access = args.access
    ? {
        requireAuth: args.access.require_auth === true,
        authorizedAgentIds: (args.access.authorized_agent_ids ?? []).map(x => String(x ?? '').trim()).filter(Boolean),
      }
    : source?.access

  const gate = assertRecipeCreate(agentId, lineId)
  if (!gate.ok) return { text: gate.text, isError: true }
  let hitlNote = ''
  if (gate.hitlRequired) {
    const gateDecision = await hitlDispatchGate(
      agentId,
      `new-${lineId}`,
      `新建配方「${name}」:产线 ${lineId} / 产品「${product.name}」(${productId}) | 参数 ${params.length} 项: ${params.map((p) => {
        const node = getDcwController().byId(p.nodeId)
        return `${node?.name ?? p.nodeId}=${p.value}${node?.unit ?? ''}`
      }).join(';')} | 来源 ${run ? `批次 ${run.id.slice(0, 8)} 冻结快照` : source ? `配方「${source.name}」v${source.version ?? 1}` : '显式参数'} | 理由:${reason} | 批准=创建配方定义(不下发产线)`,
      '新建配方审批',
      {
        payload: {
          schemaVersion: 1,
          kind: 'recipe-gate',
          op: 'create',
          recipeId: '',
          recipeName: name,
          lineId,
          productId,
          reason,
          params: params.map((p) => {
            const node = getDcwController().byId(p.nodeId)
            return { nodeId: p.nodeId, name: node?.name ?? p.nodeId, from: null, to: p.value, unit: node?.unit }
          }),
          ...(run ? { runId: run.id } : {}),
        },
      },
    )
    if (!gateDecision.approved) {
      return { text: `人工未批准新建配方。人工指导:${gateDecision.comment || '(无附言)'}。请按指导调整参数/命名后重试。` }
    }
    if (gateDecision.comment) hitlNote = `\n人工附言:${gateDecision.comment}`
    const again = assertRecipeCreate(agentId, lineId)
    if (!again.ok) return { text: `人工已批准,但审批期间授权已失效,本次未创建:${again.text}`, isError: true }
  }
  try {
    const created = getDcwController().createRecipe({
      name,
      productId,
      description: String(args.description ?? '').trim() || `另存自${run ? `批次 ${run.id.slice(0, 8)}` : source ? `配方「${source.name}」v${source.version ?? 1}` : 'Agent 参数'}`,
      params,
      daqWindows: windows,
      ...(access ? { access } : {}),
    })
    try {
      const { recordOps } = await import('../../ops/ops')
      recordOps({
        actor: agentId, actorName: agentBadgeLabel(agentId), actorKind: 'agent',
        action: 'recipe.create', kind: 'recipe', targetKind: 'recipe', targetId: created.id,
        lineId: created.lineId, productId: created.productId, recipeId: created.id,
        summary: `新建配方「${created.name}」v${created.version ?? 1}(另存自${run ? `批次 ${run.id.slice(0, 8)} 冻结参数` : source ? `配方「${source.name}」v${source.version ?? 1}` : '显式参数'}) | 理由:${reason}`,
        detail: { sourceRecipeId: source?.id ?? null, sourceRunId: run?.id ?? null, params: params.length, reason },
      })
    }
    catch { /* 审计失败不影响创建 */ }
    return {
      text: `已创建配方「${created.name}」(id=${created.id},v${created.version ?? 1},产品 ${product.name},参数 ${params.length} 项)。${hitlNote}\n注意:新配方尚未绑定给你 —— 请让用户/lead 在配方管理中把「${created.name}」绑定给你的 Agent(首绑 manual,需人工批准),之后才能 recipe_update/recipe_apply。当前产线未因此发生变化(仅创建定义,未下发)。`,
    }
  }
  catch (err) {
    return { text: `新建配方失败:${err instanceof Error ? err.message : String(err)}`, isError: true }
  }
}

/** 工具:recipe_versions —— 配方参数版本史(谁/何时/为什么改了什么;旧→新)。
 *  每条含 by(user/agent/system)、操作者人话名、变更描述、参数 diff。 */
export async function toolRecipeVersions(agentId: string, args: { recipe_id?: string, limit?: number | string }): Promise<{ text: string, isError?: boolean }> {
  const recipeId = String(args.recipe_id ?? '').trim()
  if (!recipeId) return { text: 'recipe_id 必填(line_context 可看到当前配方的 id)。', isError: true }
  const recipe = getDcwController().listRecipes().find(r => r.id === recipeId)
  if (!recipe) return { text: `配方 ${recipeId} 不存在。`, isError: true }
  // 只读面:节点授权线 ∪ 频道绑定线均可看版本史(回退走 toolRecipeRollback 的写门)
  const scope = agentOpsScope(agentId)
  const readable = scope ? readableLineIds(scope) : []
  if (!recipe.lineId || !readable.includes(recipe.lineId)) {
    return { text: `无权查看配方 ${recipeId} 的版本史(该配方不在你可读的产线上)。`, isError: true }
  }
  const rows = getDcwController().recipeVersions(recipeId)
  const limit = Math.min(Number(args.limit) || 20, 50)
  const shown = rows.slice(-limit)
  const srcLabel: Record<string, string> = { user: '用户', agent: 'Agent', system: '系统' }
  const lines = shown.map((v, i) => {
    const prev = shown[i - 1]
    let diff = '初始版本'
    if (prev) {
      const nodeName = (id: string): string => {
        const n = getDcwController().byId(id)
        return n ? n.name : `${id}(已删除)`
      }
      const changed = v.params
        .map(p => ({ p, old: prev.params.find(x => x.nodeId === p.nodeId) }))
        .filter(({ p, old }) => !old || old.value !== p.value)
        .map(({ p, old }) => `${nodeName(p.nodeId)} ${old?.value ?? '新增'}→${p.value}`)
      const removed = prev.params.filter(o => !v.params.some(x => x.nodeId === o.nodeId)).map(o => `${nodeName(o.nodeId)} 移除`)
      const all = [...changed, ...removed]
      diff = all.length > 0 ? `变更:${all.join(';')}` : '参数未变'
    }
    const src = v.by ? (srcLabel[v.by] ?? v.by) : '—'
    return `- v${v.version} [${v.at.slice(0, 19).replace('T', ' ')}] 来源=${src} 操作者=${v.actorName ?? '—'}${v.description ? ` | ${v.description}` : ''}\n    ${diff}`
  })
  return {
    text: `配方「${recipe.name}」版本史(当前 v${recipe.version ?? 1},共 ${rows.length} 条,旧→新):\n${lines.join('\n')}\n\n回退用 recipe_rollback(recipe_id + version 或 to_last_good=true);保存新参数用 recipe_update。`,
  }
}

/** 配方目标解析:recipe_id 优先;只给 line_id 时解析该线当前活动批次的配方。
 *  这样 Agent 可以直接对"当前在跑的配方"下发,不必先从文本里抠 id。 */
function resolveRecipeTarget(recipeIdRaw: unknown, lineIdRaw: unknown): { ok: true, recipe: RecipeView } | { ok: false, text: string } {
  const recipeId = String(recipeIdRaw ?? '').trim()
  const lineId = String(lineIdRaw ?? '').trim()
  if (recipeId) {
    const recipe = getDcwController().listRecipes().find(r => r.id === recipeId)
    if (!recipe) return { ok: false, text: `配方 ${recipeId} 不存在(用 recipe_catalog/line_context 查看配方 id)。` }
    if (lineId && recipe.lineId !== lineId) return { ok: false, text: `配方「${recipe.name}」归属产线 ${recipe.lineId},与 line_id=${lineId} 不一致。` }
    return { ok: true, recipe }
  }
  if (!lineId) return { ok: false, text: 'recipe_id 与 line_id 至少提供一个:只给 line_id 时按该产线当前活动批次解析配方。' }
  const active = getActiveLineRun(lineId)
  if (!active) return { ok: false, text: `产线 ${lineId} 当前没有活动批次,无法解析"当前配方";请先开跑配方,或直接提供 recipe_id。` }
  const recipe = getDcwController().listRecipes().find(r => r.id === active.recipeId)
  if (!recipe) return { ok: false, text: `活动批次引用的配方 ${active.recipeId} 不存在或已删除。` }
  return { ok: true, recipe }
}

/** 工具:recipe_update —— 把验证过的最佳参数保存进配方(生成新版本,带归因与原因)。
 *  权限模型 v2:需绑定该 recipe(kind='recipe')且通过二级认证与运行门(配方须在执行);
 *  绑定 manual 时本次保存挂 HITL 等人工批准(理由随审批卡展示)。
 *  只改配方定义;要把参数推到运行中的产线用 recipe_apply(整批下发)。 */
export async function toolRecipeUpdate(agentId: string, args: {
  recipe_id?: string
  line_id?: string
  params?: Array<{ node_id?: string, value?: number | string, min?: number | string, max?: number | string }>
  reason?: string
  task_id?: string
}): Promise<{ text: string, isError?: boolean }> {
  const reason = String(args.reason ?? '').trim()
  if (!reason) return { text: 'reason 必填:保存参数必须说明依据(如数采证据/判定结论),便于版本史追溯与人工审批判断。', isError: true }
  const list = (args.params ?? []).filter(p => p && String(p.node_id ?? '').trim() && Number.isFinite(Number(p.value)))
  if (list.length === 0) return { text: 'params 至少提供一条 {node_id, value}(value 必须为数字)。', isError: true }
  const target = resolveRecipeTarget(args.recipe_id, args.line_id)
  if (!target.ok) return { text: target.text, isError: true }
  const recipe = target.recipe
  const recipeId = recipe.id
  // 权限模型 v2 + 2026-10-28 双轨:版本操作只认 recipe 绑定(节点绑定不授予版本权)
  const gate = assertRecipeOperation(agentId, recipe, 'update', list.map(p => String(p.node_id).trim()))
  if (!gate.ok) return { text: gate.text, isError: true }
  for (const p of list) {
    const nodeId = String(p.node_id).trim()
    const node = getDcwController().byId(nodeId)
    if (!node) return { text: `节点 ${nodeId} 已删除,不能作为配方参数保存。请改用仍在线的节点。`, isError: true }
    if (node.lineId !== recipe.lineId) return { text: `节点「${node.name}」已取消绑定(不在配方「${recipe.name}」所在产线),不可混入。`, isError: true }
    if (!node.enabled) return { text: `节点「${node.name}」已停用,参数保存被拒。请先让用户恢复节点控制,或保存到其他节点。`, isError: true }
  }
  // HITL:manual 绑定(或全局下发审批开关)→ 保存前挂人工审批,理由随审批卡展示
  // B-P1-4(2026-10-28 审查):审批卡展示的是"此刻的"配方定义;审批窗口内若有人并发
  // 编辑同一配方,旧实现会把批准结果静默并进**已变的**定义(本次只改列出的参数,其余
  // 取最新值),人工批准的语义被偷换。进入审批前记录定义指纹,批准后逐字比对。
  const approvedDefinitionSnapshot = JSON.stringify({
    version: recipe.version ?? 1,
    params: recipe.params.map(p => ({ nodeId: p.nodeId, value: p.value, min: p.min ?? null, max: p.max ?? null })),
  })
  let hitlNote = ''
  if (gate.hitlRequired) {
    const gateDecision = await hitlDispatchGate(
      agentId,
      recipe.id,
      `配方参数写入:「${recipe.name}」v${recipe.version ?? 1} 拟保存 ${list.map((p) => {
        const node = getDcwController().byId(String(p.node_id).trim())
        const old = recipe.params.find(x => x.nodeId === String(p.node_id).trim())?.value
        return `${node?.name ?? p.node_id} ${old ?? '?'}→${Number(p.value)}${node?.unit ?? ''}`
      }).join(';')} | 理由:${reason} | 批准=写入新版本(不下发产线);拒绝可附指导`,
      '配方参数写入审批',
      { payload: recipeApprovalPayload('update', recipe.id, recipe.name, {
        reason,
        params: list.map((p) => {
          const node = getDcwController().byId(String(p.node_id).trim())
          const old = recipe.params.find(x => x.nodeId === String(p.node_id).trim())?.value
          return { nodeId: String(p.node_id).trim(), name: node?.name ?? String(p.node_id), from: old ?? null, to: Number(p.value), unit: node?.unit }
        }),
        context: gate.activeContext,
      }) },
    )
    if (!gateDecision.approved) {
      return {
        text: `人工未批准本次参数写入。人工指导:${gateDecision.comment || '(无附言)'}。请按人工指导修订参数与理由后重新提交 recipe_update。`,
      }
    }
    if (gateDecision.comment) hitlNote = `\n人工附言:${gateDecision.comment}`
    const stale = await revalidateApprovedAction(agentId, recipe, 'update', 'recipe_update', { recipe_id: recipeId, params: list.map(p => ({ node_id: p.node_id })) }, gate.activeContext)
    if (stale) return stale
    // B-P1-4:批准后复核配方定义 —— 审批窗口内的并发编辑不得被静默并入已批版本。
    const latestRecipe = getDcwRecipeRepo().byId(recipeId)
    const latestSnapshot = latestRecipe
      ? JSON.stringify({
          version: latestRecipe.version ?? 1,
          params: latestRecipe.params.map(p => ({ nodeId: p.nodeId, value: p.value, min: p.min ?? null, max: p.max ?? null })),
        })
      : ''
    if (!latestRecipe || latestSnapshot !== approvedDefinitionSnapshot) {
      return {
        text: `人工已批准,但审批期间配方「${recipe.name}」的定义已被其他操作修改(v${recipe.version ?? 1} → v${latestRecipe?.version ?? '已删除'});`
          + `为避免把本次批准静默并入已变更的定义,本次未执行、配方未改动。`
          + `请调用 recipe_catalog/recipe_versions 重新读取最新参数与理由后,基于最新定义重新提交 recipe_update。`,
        isError: true,
      }
    }
  }
  // 旧值快照(repo.update 原地改写 recipe.params,事后再取会把 before 读成新值)
  const beforeOf = new Map(recipe.params.map(p => [p.nodeId, p.value]))
  // 部分合并:只更新提供的节点,其余参数保持不变;
  // 基线中的失效参数(节点已删除/已解绑/已改挂)自动剪除并如实告知 —— 否则整次保存会被归一化拒绝
  const dropped: string[] = []
  const merged = recipe.params
    .filter((p) => {
      const node = getDcwController().byId(p.nodeId)
      if (!node || node.lineId !== recipe.lineId) {
        dropped.push(node?.name ?? p.nodeId)
        return false
      }
      return true
    })
    .map((p) => {
      const patch = list.find(x => String(x.node_id).trim() === p.nodeId)
      // stepLimit 必须随行携带:丢了会被 normParams 视为"参数有变化"(同值也空转增版),
      // 且配方层单步限幅被静默抹掉(退化为参数/节点层默认)——治理数据完整性
      const out: { nodeId: string, templateRef?: string, value: number, min?: number, max?: number, stepLimit?: number } = {
        nodeId: p.nodeId,
        templateRef: p.templateRef,
        value: patch ? Number(patch.value) : p.value,
      }
      if (p.min != null) out.min = p.min
      if (patch?.min != null && Number.isFinite(Number(patch.min))) out.min = Number(patch.min)
      if (p.max != null) out.max = p.max
      if (patch?.max != null && Number.isFinite(Number(patch.max))) out.max = Number(patch.max)
      if (p.stepLimit != null) out.stepLimit = p.stepLimit
      return out
    })
  const extra = list.filter(p => !recipe.params.some(x => x.nodeId === String(p.node_id).trim()))
  for (const p of extra) merged.push({ nodeId: String(p.node_id).trim(), value: Number(p.value) })
  try {
    const updated = getDcwController().updateRecipe(recipeId, { params: merged }, {
      by: 'agent',
      actorName: agentBadgeLabel(agentId),
      actor: agentId,
      description: reason,
    })
    const changedNodes = list.map((p) => {
      const node = getDcwController().byId(String(p.node_id).trim())
      const before = beforeOf.get(String(p.node_id).trim())
      return `${node?.name ?? p.node_id} ${before ?? '?'}→${Number(p.value)}`
    }).join(';')
    const droppedNote = dropped.length > 0 ? `\n注意:已自动剔除失效参数(${dropped.join('、')}:节点已删除或改挂其他产线),这些参数不再属于本配方。` : ''
    return {
      text: `已保存为 v${updated.version ?? 1}:「${updated.name}」参数 ${changedNodes};原因:${reason}。${droppedNote}${hitlNote}\n注意:配方定义已更新,运行中批次仍按开跑时冻结的参数生产;要把新参数推到运行中的产线(经治理联锁整批下发),用 recipe_apply。回退用 recipe_rollback。`,
    }
  }
  catch (err) {
    return { text: `保存失败:${err instanceof Error ? err.message : String(err)}`, isError: true }
  }
}

/** 工具:recipe_rollback —— 回退配方参数到稳定版本(指定历史版本或已知良好批次快照)。
 *  生成新版本(非破坏,历史保留);不改运行中 PLC 当前值。
 *  v19 dispatch=true = **统一回退**:定义回退 + 该版本参数整批重下发到 PLC(批次级恢复)。 */
export async function toolRecipeRollback(agentId: string, args: {
  recipe_id?: string
  version?: number | string
  to_last_good?: boolean | string
  dispatch?: boolean | string
  reason?: string
  emergency?: boolean | string
}): Promise<{ text: string, isError: true } | { text: string, isError?: boolean }> {
  const recipeId = String(args.recipe_id ?? '').trim()
  const reason = String(args.reason ?? '').trim()
  const toLastGood = args.to_last_good === true || args.to_last_good === 'true'
  const dispatch = args.dispatch === true || args.dispatch === 'true'
  const emergency = args.emergency === true || args.emergency === 'true'
  const version = Number(args.version)
  if (!recipeId) return { text: 'recipe_id 必填。', isError: true }
  if (!reason) return { text: 'reason 必填:回退必须说明原因(如优化翻车/越限),便于版本史追溯。', isError: true }
  if (!toLastGood && !Number.isFinite(version)) return { text: '需提供 version(历史版本号)或 to_last_good=true。', isError: true }
  const recipe = getDcwController().listRecipes().find(r => r.id === recipeId)
  if (!recipe) return { text: `配方 ${recipeId} 不存在。`, isError: true }
  // 权限模型 v2:绑定 → 二级认证 → 运行门(未在执行的配方不可回退)
  const gate = assertRecipeOperation(agentId, recipe, 'rollback')
  if (!gate.ok) return { text: gate.text, isError: true }
  if (!toLastGood && Number.isFinite(version) && version >= (recipe.version ?? 1)) {
    return { text: `不能回退到 v${version}(当前已是 v${recipe.version ?? 1};回退目标是更早的版本)。`, isError: true }
  }
  // Recipe 级下发间隔卡控:仅统一回退(dispatch=true,含 PLC 整批重下发)受控;仅定义回退不触产线不卡
  if (dispatch) {
    const cadence = recipeOpIntervalGate(recipe, emergency)
    if (cadence) return cadence
  }
  // HITL:manual 绑定(或全局开关)→ 回退前挂人工审批(定义回退与统一回退都改状态,同受门控)
  let hitlNote = ''
  let gateApprovalId = ''
  if (gate.hitlRequired) {
    const gateDecision = await hitlDispatchGate(
      agentId,
      recipe.id,
      `${emergency ? '【应急豁免频控】' : ''}配方回退:「${recipe.name}」→ ${toLastGood ? '已知良好批次冻结' : `v${version}`}${dispatch ? '(统一回退:定义回退+整批重下发)' : '(仅定义回退)'} | 理由:${reason} | 批准=执行回退;拒绝可附指导`,
      `${emergency ? '【应急】' : ''}配方回退审批`,
      { payload: { ...recipeApprovalPayload('rollback', recipe.id, recipe.name, { reason, context: gate.activeContext }), ...(emergency ? { emergency: true } : {}) } },
    )
    gateApprovalId = gateDecision.id
    if (!gateDecision.approved) {
      return {
        text: `人工未批准本次回退。人工指导:${gateDecision.comment || '(无附言)'}。请按人工指导补充证据或调整回退目标后重新提交。`,
      }
    }
    if (gateDecision.comment) hitlNote = `\n人工附言:${gateDecision.comment}`
    const stale = await revalidateApprovedAction(agentId, recipe, 'rollback', 'recipe_rollback', { recipe_id: recipeId }, gate.activeContext)
    if (stale) return stale
  }
  try {
    if (dispatch) {
      if (gate.hitlRequired) {
        const staleAtDispatch = approvedContextError(agentId, recipe, 'rollback', gate.activeContext)
        if (staleAtDispatch) return staleAtDispatch
      }
      const { recipe: updated, run, definitionNoop } = await getDcwController().rollbackRecipeAndDispatch(recipeId, {
        version: toLastGood ? undefined : version,
        toLastGood,
        by: 'agent',
        actorName: agentBadgeLabel(agentId),
        actor: agentId,
        description: reason,
        agentDispatch: true,
        agentApprovalId: gateApprovalId,
        emergency,
      })
      const okN = run.results.filter(r => r.ok).length
      const acks = run.ackSummary ?? { verified: okN, unverified: 0, failed: run.results.length - okN, total: run.results.length }
      const defNote = definitionNoop
        ? `定义已在目标版本 v${updated.version ?? 1}(未生成新版本)`
        : `已生成 v${updated.version ?? 1}`
      // 整批重下发全部失败(典型:节点写入保持窗/节流未放行)→ 响亮失败:定义已回退但产线仍运行
      // 旧参数,Agent 必须知道并稍后重发(再调本工具会再生成一个回退版本,或按 RECOVERY_RETRY_HINT 整批重试)。
      if (run.results.length > 0 && okN === 0) {
        return {
          text: `回退部分失败:配方「${updated.name}」${defNote},但整批重下发 0/${run.results.length} 参数成功(节点写入保持窗/节流未放行)。产线仍在运行旧参数 —— ${RECOVERY_RETRY_HINT}(回退目标 v${updated.version ?? 1});原因:${reason}。`,
          isError: true,
        }
      }
      // ACK 鉴定铁律:回退是安全动作,未证实/失败必须响亮(否则人以为已恢复实际没有)
      if (acks.failed > 0 || acks.unverified > 0) {
        return {
          text: [
            `统一回退执行,但 ACK 鉴定未全绿:配方「${updated.name}」${defNote},设备证实 ${acks.verified}/${acks.total},未证实 ${acks.unverified},失败 ${acks.failed}(回退目标:${toLastGood ? '已知良好批次冻结' : `v${version}`});原因:${reason}。${hitlNote}`,
            `「未证实」参数可能未真正恢复到目标值 —— 请立即核实:${RECOVERY_VERIFY_HINT},并把清单写入汇报提醒人类。`,
          ].join('\n'),
          isError: true,
        }
      }
      return {
        text: `统一回退完成:配方「${updated.name}」${defNote},参数恢复为目标版本(${toLastGood ? '已知良好批次冻结' : `v${version}`}),并已整批重下发到 PLC 且全部设备证实(${acks.verified}/${acks.total});原因:${reason}。${hitlNote}\n用 daq_query 复测确认恢复效果;版本史用 recipe_versions 复核。`,
      }
    }
    const updated = getDcwController().revertRecipe(recipeId, {
      version: toLastGood ? undefined : version,
      toLastGood,
    }, {
      by: 'agent',
      actorName: agentBadgeLabel(agentId),
      actor: agentId,
      description: reason,
    })
    return {
      text: `回退完成:配方「${updated.name}」已生成 v${updated.version ?? 1},参数恢复为目标版本(${toLastGood ? '已知良好批次冻结' : `v${version}`});原因:${reason}。${hitlNote}\n注意:仅回退了配方定义,运行中 PLC 未变动;要把恢复参数写入产线(统一回退),用 recipe_rollback 并带 dispatch=true。版本史用 recipe_versions 复核。`,
    }
  }
  catch (err) {
    return { text: `回退失败:${err instanceof Error ? err.message : String(err)}`, isError: true }
  }
}

/**
 * v19.5 HITL 下发裁决门:绑定 manual(或全局开关)时,配方动作不直接执行 ——
 * 挂起等待人工裁决(复用 ToolApprovalService,人类批/拒理由原样回流;结构化 payload
 * 随单落库,审批卡可渲染 Agent 的理由与参数明细):
 *   批准       → 按原逻辑执行下发,回执附人工附言;
 *   拒绝(可附指导)→ 工具回包携带人工指导文本,Agent 按指导修订候选后重新提交 ——
 *   即"改好配方交给人类判断是否下发;不下发则人告诉 Agent 怎么修"的真实作业语义。
 * 超时(默认 security.recipe_dispatch_timeout_ms,30min)自动按拒绝收敛。
 */
async function hitlDispatchGate(agentId: string, recipeId: string, detail: string, title: string, opts?: {
  payload?: unknown
  trialTargets?: Array<{ id: string, driver: string, driverConfig: Record<string, unknown> }>
  lineId?: string
}): Promise<{ approved: boolean, comment: string, id: string, approval_bypassed?: true }> {
  if (opts?.trialTargets) {
    const receipt = approvalOnlyTrialReceipt({ recipeId, line: getDcwLineRepo().byId(opts.lineId ?? ''), nodes: opts.trialTargets })
    if (receipt) {
      recordOps({
        actor: agentId, actorName: agentBadgeLabel(agentId), actorKind: 'agent',
        action: 'recipe.approval.bypassed', kind: 'recipe', targetKind: 'recipe', targetId: recipeId,
        lineId: opts.lineId ?? '', recipeId,
        summary: '隔离模拟器审批消融:仅跳过人工审批等待,无人工批准记录',
        detail: receipt,
      })
      return { approved: true, comment: '', id: '', approval_bypassed: true }
    }
  }
  const { getToolApprovals } = await import('../tool-approvals')
  const timeoutMs = Number(settingOf('security.recipe_dispatch_timeout_ms')) || undefined
  // nodeId = `recipe:<id>`:审批卡分流键(与 recipe-propose:<id> 平行;kind 保持 'dcw' 兼容既有裁决端点)
  const decision = await getToolApprovals().request(agentId, `recipe:${recipeId}`, 'dcw', detail, {
    title,
    ...(opts?.payload !== undefined ? { payload: opts.payload } : {}),
    ...(timeoutMs ? { timeoutMs } : {}),
  })
  return { approved: decision.approved, comment: decision.comment, id: decision.id }
}

/**
 * 审批返回「批准」后的二次状态复核:审批可能挂起数分钟,
 * 期间绑定/产线授权/活动产线上下文都可能变化。批准不等于授权与上下文仍然有效:
 *  - 重新跑 assertRecipeOperation(绑定/二级认证/运行门);
 *  - 将当前 line/product/recipe/run 元组与审批时快照比较,变化即拒绝;
 *  - 重新跑 grant-guard(频道属主的产线 grant,收权即失活)。
 * 任一失败 → 本次不执行,回包说明原因(Agent 可据此核实上下文并重新申请)。
 */
function approvedContextError(
  agentId: string,
  recipe: { id: string, name: string, lineId?: string, params?: Array<{ nodeId: string }>, access?: { requireAuth?: boolean, authorizedAgentIds?: string[] } },
  op: 'update' | 'dispatch' | 'trial' | 'rollback',
  expectedContext: ActiveRecipeContext,
  targetNodeIds?: string[],
  approvalBypassed = false,
): { text: string, isError: true } | null {
  const prefix = approvalBypassed ? '实验审批已旁路,但执行前' : '人工已批准,但审批期间'
  const currentGate = assertRecipeOperation(agentId, recipe, op, targetNodeIds)
  if (!currentGate.ok) {
    return { text: `${prefix}授权已失效,本次未执行:${currentGate.text}`, isError: true }
  }
  const current = currentGate.activeContext
  if (current.lineId !== expectedContext.lineId
    || current.runId !== expectedContext.runId
    || current.recipeId !== expectedContext.recipeId
    || current.productId !== expectedContext.productId) {
    return {
      text: `${prefix}产线/产品/配方/批次上下文已变化,本次未执行。请核查当前运行上下文后重新提交。`,
      isError: true,
    }
  }
  return null
}

/** 从审批时的工具参数还原「本次覆盖的节点集」(trial/update 只写声明节点;其余=整批)。 */
function targetNodesFromArgs(op: 'update' | 'dispatch' | 'trial' | 'rollback', args: Record<string, unknown>): string[] | undefined {
  if (op !== 'trial' && op !== 'update') return undefined
  const params = Array.isArray(args.params) ? args.params : []
  const ids = params
    .map(p => String((p as { node_id?: unknown } | null)?.node_id ?? '').trim())
    .filter(Boolean)
  return ids.length > 0 ? ids : undefined
}

export async function revalidateApprovedAction(
  agentId: string,
  recipe: { id: string, name: string, lineId?: string, params?: Array<{ nodeId: string }>, access?: { requireAuth?: boolean, authorizedAgentIds?: string[] } },
  op: 'update' | 'dispatch' | 'trial' | 'rollback',
  toolName: string,
  args: Record<string, unknown>,
  expectedContext: ActiveRecipeContext,
  approvalBypassed = false,
): Promise<{ text: string, isError: true } | null> {
  const prefix = approvalBypassed ? '实验审批已旁路,但执行前' : '人工已批准,但审批期间'
  const targetNodeIds = targetNodesFromArgs(op, args)
  const initialContextError = approvedContextError(agentId, recipe, op, expectedContext, targetNodeIds, approvalBypassed)
  if (initialContextError) return initialContextError
  try {
    // manager 未装配(单测/嵌入)→ 只做绑定与运行门复核;装配后叠加产线 grant 复核
    const g = globalThis as typeof globalThis & {
      __workshopManager?: { deps?: { repos?: { channelAgents?: { findById(id: string): { channelId?: string } | undefined } } } }
    }
    const channelId = g.__workshopManager?.deps?.repos?.channelAgents?.findById(agentId)?.channelId ?? ''
    if (channelId) {
      const { guardIndustrialToolGrant } = await import('./grant-guard')
      const denied = await guardIndustrialToolGrant({ agentId, channelId }, toolName, args)
      if (denied) return { text: `${prefix}产线授权已被收回,本次未执行:${denied.text}`, isError: true }
    }
  }
  catch (err) {
    return { text: `${prefix}权限复核不可用,本次未执行:${err instanceof Error ? err.message : String(err)}。请稍后重试。`, isError: true }
  }
  // Grant lookup is asynchronous. Re-read the active tuple after that await so
  // queued line/run changes cannot pass between the initial comparison and the
  // caller's dispatch continuation.
  const changedAfterGrantCheck = approvedContextError(agentId, recipe, op, expectedContext, targetNodeIds, approvalBypassed)
  if (changedAfterGrantCheck) return changedAfterGrantCheck
  return null
}

/**
 * Recipe 级下发间隔卡控(提案早拒):距上次已批准/已执行下发不足 opIntervalMs 时,
 * 在挂审批卡**之前**拒绝(不建卡、不产线变动),报错含剩余秒数与应急豁免指引。
 */
function recipeOpIntervalGate(recipe: { id: string, name: string, opIntervalMs?: number }, emergency: boolean): { text: string, isError: true } | null {
  try {
    assertRecipeOpInterval(recipe, { emergency })
    return null
  }
  catch (err) {
    return { text: err instanceof Error ? err.message : String(err), isError: true }
  }
}

/** 工具:recipe_trial —— 多参数候选整批试验下发(v19 配方链路核心)。
 *  权限模型 v2:需绑定该 recipe 且过二级认证+运行门;候选值只覆盖列出节点(须为配方内节点)。
 *  绑定 manual 时整批试验挂 HITL(理由随审批卡);整批一次落产线,不写配方版本 ——
 *  复测判读:有进步/达标 → recipe_update 固化;劣化 → recipe_rollback(dispatch=true) 统一回退。
 *  受同线试验节拍卡控(默认 ≥5 分钟,防连发震荡);四层限界(量程∩参数∩产品)照常拦截。 */
export async function toolRecipeTrial(agentId: string, args: {
  recipe_id?: string
  line_id?: string
  params?: Array<{ node_id?: string, value?: number | string }>
  hypothesis?: string
  emergency?: boolean | string
}): Promise<{ text: string, isError?: boolean, approval_bypassed?: true }> {
  const hypothesis = String(args.hypothesis ?? '').trim()
  const emergency = args.emergency === true || args.emergency === 'true'
  if (!hypothesis) return { text: 'hypothesis 必填:试验必须声明依据(知识库条目/数据分析结论),便于审计追溯与人工审批判断。', isError: true }
  const list = (args.params ?? []).filter(p => p && String(p.node_id ?? '').trim() && Number.isFinite(Number(p.value)))
    .map(p => ({ nodeId: String(p.node_id).trim(), value: Number(p.value) }))
  if (list.length === 0) return { text: 'params 至少提供一条 {node_id, value}(value 必须为数字);试验的意义就是多参数一次整批改动。', isError: true }
  const target = resolveRecipeTarget(args.recipe_id, args.line_id)
  if (!target.ok) return { text: target.text, isError: true }
  const recipe = target.recipe
  const recipeId = recipe.id
  // 权限模型 v2 + 2026-10-28 双轨:recipe 绑定 ∨ 本次候选覆盖集 ⊆ dcw 节点绑定面
  const gate = assertRecipeOperation(agentId, recipe, 'trial', list.map(p => p.nodeId))
  if (!gate.ok) return { text: gate.text, isError: true }
  if (process.env.AW_BENCH_APPROVAL_ONLY === '1' && !gate.hitlRequired) {
    return { text: 'Approval-only trial refused: the normal manual approval gate must remain enabled', isError: true }
  }
  for (const p of list) {
    const node = getDcwController().byId(p.nodeId)
    if (!node) return { text: `节点 ${p.nodeId} 已删除,不能纳入试验。`, isError: true }
    if (node.lineId !== recipe.lineId) return { text: `节点「${node.name}」不在配方「${recipe.name}」所在产线,不可混入试验。`, isError: true }
    if (!node.enabled) return { text: `节点「${node.name}」已停用,试验被拒。`, isError: true }
    if (!recipe.params.some(x => x.nodeId === p.nodeId)) {
      return { text: `节点「${node.name}」不是配方「${recipe.name}」的参数节点;试验候选只能覆盖配方内参数。`, isError: true }
    }
  }
  // Recipe 级下发间隔卡控(提案早拒):距上次已批准下发不足 opIntervalMs 即拒,不建卡
  const cadence = recipeOpIntervalGate(recipe, emergency)
  if (cadence) return cadence
  try {
    // HITL 门:manual 绑定(或全局开关)时,整批试验前先挂起等人工裁决(拒绝附指导 → 回给 Agent 修订)
    let hitlNote = ''
    let gateApprovalId = ''
    let approvalBypassed = false
    if (gate.hitlRequired) {
      const gateDecision = await hitlDispatchGate(
        agentId,
        recipe.id,
        `${emergency ? '【应急豁免频控】' : ''}配方试验候选(整批 ${list.length} 参数):${list.map((p) => {
          const node = getDcwController().byId(p.nodeId)
          const old = recipe.params.find(x => x.nodeId === p.nodeId)?.value
          return `${node?.name ?? p.nodeId} ${old ?? '?'}→${p.value}${node?.unit ?? ''}`
        }).join(';')} | 假设:${hypothesis} | 批准=整批下发试验(不写版本);拒绝可附指导`,
        `${emergency ? '【应急】' : ''}配方试验(整批候选)下发审批`,
        { lineId: recipe.lineId, trialTargets: list.map(p => getDcwController().byId(p.nodeId)!), payload: { ...recipeApprovalPayload('trial', recipe.id, recipe.name, {
          reason: hypothesis,
          params: list.map((p) => {
            const node = getDcwController().byId(p.nodeId)
            const old = recipe.params.find(x => x.nodeId === p.nodeId)?.value
            return { nodeId: p.nodeId, name: node?.name ?? p.nodeId, from: old ?? null, to: p.value, unit: node?.unit }
          }),
          context: gate.activeContext,
        }), ...(emergency ? { emergency: true } : {}) } },
      )
      gateApprovalId = gateDecision.id
      approvalBypassed = gateDecision.approval_bypassed === true
      if (!gateDecision.approved) {
        return {
          text: `人工未批准本次试验下发。人工指导:${gateDecision.comment || '(无附言,仅不同意候选)'}。请按人工指导修订候选参数(必要时先 recipe_update 调整基线),然后重新提交 recipe_trial。`,
        }
      }
      // 人工附言随批准回执回流(Agent 与审计都能看到放行时人的原话)
      if (approvalBypassed) hitlNote = '\n实验审批旁路:approval_bypassed=true;仅用于隔离模拟器,未获得人工批准。'
      else if (gateDecision.comment) hitlNote = `\n人工附言:${gateDecision.comment}`
      const stale = await revalidateApprovedAction(agentId, recipe, 'trial', 'recipe_trial', { recipe_id: recipeId, params: list.map(p => ({ node_id: p.nodeId })) }, gate.activeContext, approvalBypassed)
      if (stale) return { ...stale, ...(approvalBypassed ? { approval_bypassed: true as const } : {}) }
      const staleAtDispatch = approvedContextError(agentId, recipe, 'trial', gate.activeContext, list.map(p => p.nodeId), approvalBypassed)
      if (staleAtDispatch) return { ...staleAtDispatch, ...(approvalBypassed ? { approval_bypassed: true as const } : {}) }
    }
    // 2026-10-28 执行点复核(双轨授权,D13 同款):审批/节拍等待期间绑定可能被撤销,
    // 下发前最后一次同步重算覆盖集 —— 收回即失活,不把授权变更带进写入。
    const execGate = assertRecipeOperation(agentId, recipe, 'trial', list.map(p => p.nodeId))
    if (!execGate.ok) return { text: `下发前授权复核未通过,本次未执行:${execGate.text}`, isError: true }
    // Recheck the qualified driver/PID after the asynchronous grant revalidation.
    if (approvalBypassed) approvalOnlyTrialReceipt({ recipeId, line: getDcwLineRepo().byId(recipe.lineId), nodes: list.map(p => getDcwController().byId(p.nodeId)!) })
    const invocation = currentToolInvocation()
    const run = await getDcwController().applyRecipe(recipeId, {
      overrides: list, trial: true, agentDispatch: true, agentApprovalId: gateApprovalId, emergency,
      agentTrialMeta: {
        actor: agentId, actorName: agentBadgeLabel(agentId), hypothesis,
        ...(invocation?.agentId === agentId && invocation.taskId ? { taskId: invocation.taskId } : {}),
        executionMode: executionModeOfAgent(agentId),
      },
    })
    // ACK 鉴定三段口径(2026-10-08):ok 只是命令受理,未证实/失败必须如实回给 Agent
    const acks = run.ackSummary ?? { verified: run.results.filter(r => r.ok).length, unverified: 0, failed: run.results.filter(r => !r.ok).length, total: run.results.length }
    // 批次级留痕:试验动作入审计(逐参数写已有 write-audit;这里是"一次试验"粒度)
    try {
      const { recordOps } = await import('../../ops/ops')
      recordOps({
        actor: agentId, actorName: agentBadgeLabel(agentId), actorKind: 'agent',
        action: 'recipe.trial', kind: 'recipe', targetKind: 'recipe', targetId: recipeId, recipeId, lineId: recipe.lineId, productId: recipe.productId,
        level: acks.failed > 0 ? 'error' : acks.unverified > 0 ? 'warn' : 'info',
        summary: `${emergency ? '【应急】' : ''}配方试验整批下发(证实 ${acks.verified}/${acks.total},未证实 ${acks.unverified},失败 ${acks.failed},批次 ${run.id.slice(0, 8)}):${list.map(p => `${p.nodeId.slice(0, 8)}→${p.value}`).join(';')} | 假设:${hypothesis}`,
        detail: { runId: run.id, ackSummary: acks, ...(emergency ? { emergency: true } : {}), ...(approvalBypassed ? { approval_bypassed: true } : {}) },
      })
    }
    catch { /* 审计失败不影响试验结果 */ }
    const ackTagOf = (r: typeof run.results[number]): string => {
      if (!r.ok) return ''
      return r.verify?.verdict === 'verified' || r.ack === 'readback-verified' ? ' [证实✓]' : ' [未证实⚠]'
    }
    const changed = run.results.map((r) => {
      const node = r.nodeId ? getDcwController().byId(r.nodeId) : undefined
      const reason = r.ok ? '' : `(${String(r.message).slice(0, 60)})`
      return `${node?.name ?? r.templateRef}→${r.value}${node?.unit ?? ''}${ackTagOf(r)}${r.ok ? '' : ` 被拒${reason}`}`
    }).join(';')
    // 未证实/失败一律 isError(ACK 鉴定铁律:不许把"仅链路受理"报成试验成功)
    if (acks.failed > 0 || acks.unverified > 0) {
      return {
        text: [
          `试验下发 ACK 鉴定未全绿(证实 ${acks.verified}/${acks.total},未证实 ${acks.unverified},失败 ${acks.failed},批次 ${run.id.slice(0, 8)}):${changed}。假设:${hypothesis}。${hitlNote}`,
          '「未证实」=命令已发到链路但设备侧未确认生效;请用 daq_query 复测这些参数的真实状态后再判读试验效果,必要时对未证实参数单独重发或 recipe_rollback 统一回退,并写入汇报提醒人类。',
        ].join('\n'),
        isError: true,
        ...(approvalBypassed ? { approval_bypassed: true as const } : {}),
      }
    }
    return {
      text: `试验已整批下发并全部设备证实(${acks.verified}/${acks.total},批次 ${run.id.slice(0, 8)}):${changed}。假设:${hypothesis}。${hitlNote}注意:本次试验**未写入配方版本** —— 等待工艺惯性后 daq_query 复测判读:有进步/达标 → recipe_update 把候选值固化进配方(同 id 版本+1);无进步/劣化 → recipe_rollback(recipe_id, dispatch=true, reason=…) 统一回退(定义回退+PLC 整批恢复)。`,
      ...(approvalBypassed ? { approval_bypassed: true as const } : {}),
    }
  }
  catch (err) {
    return { text: `试验下发失败:${err instanceof Error ? err.message : String(err)}`, isError: true }
  }
}

/** 工具:recipe_apply —— 把配方当前已固化参数整批下发到产线(改配方(recipe_update)之后用)。
 *  权限模型 v2:需绑定该 recipe 且过二级认证+运行门;绑定 manual 时挂 HITL(理由随审批卡)。 */
export async function toolRecipeApply(agentId: string, args: {
  recipe_id?: string
  line_id?: string
  reason?: string
  emergency?: boolean | string
}): Promise<{ text: string, isError?: boolean }> {
  const emergency = args.emergency === true || args.emergency === 'true'
  const target = resolveRecipeTarget(args.recipe_id, args.line_id)
  if (!target.ok) return { text: target.text, isError: true }
  const recipe = target.recipe
  const recipeId = recipe.id
  // 理由强制:下发必须让人(产线专家)看懂为什么这样调 —— 无描述的下发不得进入审批/执行
  const reason = String(args.reason ?? '').trim()
  if (!reason) return { text: 'reason 必填:整批下发必须说明依据(如数采证据/试验结论/GOAL 差距分析),产线专家要在审批卡上看懂你为什么这样调。', isError: true }
  // 权限模型 v2:绑定 → 二级认证 → 运行门
  const gate = assertRecipeOperation(agentId, recipe, 'dispatch')
  if (!gate.ok) return { text: gate.text, isError: true }
  // Recipe 级下发间隔卡控(提案早拒):距上次已批准下发不足 opIntervalMs 即拒,不建卡
  const cadence = recipeOpIntervalGate(recipe, emergency)
  if (cadence) return cadence
  // 审批展示与执行共用值副本;仓库会原地更新 recipe,不能把其引用当作已批准快照。
  const approvedDefinition = JSON.stringify(recipe)
  const dispatch = { name: recipe.name, version: recipe.version ?? 1, params: recipe.params.map(p => ({ ...p })) }
  try {
    // HITL 门:manual 绑定(或全局开关)时,正式下发前先挂起等人工裁决(拒绝附指导 → 回给 Agent 修订)
    let hitlNote = ''
    let gateApprovalId = ''
    if (gate.hitlRequired) {
      const gateDecision = await hitlDispatchGate(
        agentId,
        recipe.id,
        `${emergency ? '【应急豁免频控】' : ''}配方正式下发:「${dispatch.name}」v${dispatch.version} 全参数整批(${dispatch.params.length} 项):${dispatch.params.map((p) => {
          const node = getDcwController().byId(p.nodeId)
          return `${node?.name ?? p.nodeId}=${p.value}${node?.unit ?? ''}`
        }).join(';')} | 理由:${reason} | 批准=整批下发;拒绝可附指导`,
        `${emergency ? '【应急】' : ''}配方下发审批`,
        { payload: { ...recipeApprovalPayload('dispatch', recipe.id, recipe.name, {
          reason,
          params: dispatch.params.map((p) => {
            const node = getDcwController().byId(p.nodeId)
            return { nodeId: p.nodeId, name: node?.name ?? p.nodeId, from: null, to: p.value, unit: node?.unit }
          }),
          context: gate.activeContext,
        }), recipeVersion: dispatch.version, ...(emergency ? { emergency: true } : {}) } },
      )
      gateApprovalId = gateDecision.id
      if (!gateDecision.approved) {
        return {
          text: `人工未批准本次配方下发。人工指导:${gateDecision.comment || '(无附言)'}。请按人工指导修订配方(recipe_update)后重新提交 recipe_apply。`,
        }
      }
      // 人工附言随批准回执回流(与 recipe_trial 同口径)
      if (gateDecision.comment) hitlNote = `\n人工附言:${gateDecision.comment}`
      const stale = await revalidateApprovedAction(agentId, recipe, 'dispatch', 'recipe_apply', { recipe_id: recipeId }, gate.activeContext)
      if (stale) return stale
    }
    // 放在最后一次 await 之后,与 applyRecipe 的同步取值/建批之间不再让出执行权。
    const currentRecipe = getDcwRecipeRepo().byId(recipeId)
    if (!currentRecipe || JSON.stringify(currentRecipe) !== approvedDefinition) {
      return { text: '配方在审批期间已变更,与本次审批展示的快照不一致,本次未执行。请核查最新配方后重新提交 recipe_apply。', isError: true }
    }
    if (gate.hitlRequired) {
      const staleAtDispatch = approvedContextError(agentId, recipe, 'dispatch', gate.activeContext)
      if (staleAtDispatch) return staleAtDispatch
    }
    // 2026-10-28 执行点复核(双轨授权):recipe 绑定或节点覆盖集在下发前再算一次
    const execGate = assertRecipeOperation(agentId, recipe, 'dispatch')
    if (!execGate.ok) return { text: `下发前授权复核未通过,本次未执行:${execGate.text}`, isError: true }
    // 完整覆盖集让控制器复制每个已批准值,逐参数异步写期间也不再共享可变配方参数。
    const run = await getDcwController().applyRecipe(recipeId, { overrides: dispatch.params, agentDispatch: true, agentApprovalId: gateApprovalId, emergency })
    // ACK 鉴定三段口径(2026-10-08):ok 只是命令受理,未证实/失败必须如实回给 Agent
    const acks = run.ackSummary ?? { verified: run.results.filter(r => r.ok).length, unverified: 0, failed: run.results.filter(r => !r.ok).length, total: run.results.length }
    // 逐参数标注:被跳过/失败的参数(节点停用/已删除/限界拒绝)必须透出给 Agent,
    // 否则回包只见 N/N 成功数,无法定位哪些参数未生效(与 recipe_trial 的逐参数渲染同口径)。
    const skipped = run.results.filter(r => !r.ok)
      .map((r) => {
        const node = r.nodeId ? getDcwController().byId(r.nodeId) : undefined
        return `${node?.name ?? r.templateRef ?? r.nodeId ?? '?'}: ${String(r.message).slice(0, 80)}`
      })
    // 未证实参数(ok 但仅链路受理)单独点名 —— 这正是"参数真实正确下发"要堵的盲区
    const unverified = run.results.filter(r => r.ok && r.verify?.verdict !== 'verified' && r.ack !== 'readback-verified')
      .map((r) => {
        const node = r.nodeId ? getDcwController().byId(r.nodeId) : undefined
        return `${node?.name ?? r.templateRef ?? r.nodeId ?? '?'}: ${String(r.message).slice(0, 100)}`
      })
    const skippedNote = skipped.length > 0 ? `\n未生效参数(${skipped.length}):\n  - ${skipped.join('\n  - ')}` : ''
    const unverifiedNote = unverified.length > 0 ? `\n未证实参数(${unverified.length};命令已受理但设备侧未确认):\n  - ${unverified.join('\n  - ')}` : ''
    try {
      const { recordOps } = await import('../../ops/ops')
      recordOps({
        actor: agentId, actorName: agentBadgeLabel(agentId), actorKind: 'agent',
        action: 'recipe.apply', kind: 'recipe', targetKind: 'recipe', targetId: recipeId, recipeId, lineId: recipe.lineId, productId: recipe.productId,
        level: acks.failed > 0 ? 'error' : acks.unverified > 0 ? 'warn' : 'info',
        summary: `${emergency ? '【应急】' : ''}Agent 整批下发配方 v${dispatch.version}(证实 ${acks.verified}/${acks.total},未证实 ${acks.unverified},失败 ${acks.failed},批次 ${run.id.slice(0, 8)}) | 原因:${reason}`,
        detail: { runId: run.id, ackSummary: acks, ...(emergency ? { emergency: true } : {}) },
      })
    }
    catch { /* 审计失败不影响下发结果 */ }
    if (acks.failed > 0 || acks.unverified > 0) {
      return {
        text: [
          `配方「${dispatch.name}」v${dispatch.version} 整批下发 ACK 鉴定未全绿(证实 ${acks.verified}/${acks.total},未证实 ${acks.unverified},失败 ${acks.failed},批次 ${run.id.slice(0, 8)})。${hitlNote}`,
          `${skippedNote}${unverifiedNote}`,
          `${RECOVERY_VERIFY_HINT};必要时用 recipe_rollback(dispatch=true) 统一回退,${RECOVERY_TRACE_HINT},并把清单写入汇报提醒人类。`,
        ].filter(Boolean).join('\n'),
        isError: true,
      }
    }
    return {
      text: `配方「${dispatch.name}」v${dispatch.version} 已整批下发并全部设备证实(${acks.verified}/${acks.total},批次 ${run.id.slice(0, 8)})。${skippedNote}${hitlNote}用 daq_query 复测确认工艺响应。`,
    }
  }
  catch (err) {
    return { text: `配方下发失败:${err instanceof Error ? err.message : String(err)}`, isError: true }
  }
}
