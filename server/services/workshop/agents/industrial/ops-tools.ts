/**
 * 运维日志与配方变更史(ops_log / recipe_* / line_context)
 * (由 server/services/workshop/agents/industrial-tools.ts 按职责拆出;内容逐行原文搬运)
 */
import { agentBadgeLabel } from '../agent-badge'
import { getActiveLineRun } from '../../dcw/line-run'
import { getAgentNodeBindingRepo } from '../node-bindings.repo'
import { getDaqNodeRepo } from '../../daq/daq-node.repo'
import { getDcwController } from '../../dcw/dcw-controller'
import { getDcwLineRepo } from '../../dcw/dcw-line.repo'
import { getDcwProductRepo } from '../../dcw/dcw-product.repo'
import { getDcwRecipeRepo } from '../../dcw/dcw-recipe.repo'
import { getOps } from '../../ops/ops'

// ================================================================
// 运维日志 / Recipe 变更史查询(Agent 自查面:负责产线 scoped)
// ================================================================

/** Agent 负责范围 = 绑定节点的全集(节点 id 集 + 这些节点所属产线集);无绑定 = 无范围 */
export function agentOpsScope(agentId: string): { lineIds: string[], nodeIds: Set<string> } | null {
  const bindings = getAgentNodeBindingRepo().byAgent(agentId)
  if (bindings.length === 0) return null
  const lineIds = new Set<string>()
  const nodeIds = new Set<string>()
  for (const b of bindings) {
    nodeIds.add(b.nodeId)
    try {
      const n = b.kind === 'dcw' ? getDcwController().byId(b.nodeId) : getDaqNodeRepo().byId(b.nodeId)
      if (n?.lineId) lineIds.add(n.lineId)
    }
    catch { /* 节点刚被删等情况忽略 */ }
  }
  return { lineIds: [...lineIds], nodeIds }
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

/** 工具:ops_log —— 负责产线的运维/审计日志查询(全部下发/判定/回退/配方/产线事件)。
 *  权限:仅自己绑定节点所覆盖的产线;node_id 须为绑定节点。来源(actor_kind)区分 Agent/用户/系统。 */
export async function toolOpsLog(agentId: string, args: {
  line_id?: string
  node_id?: string
  kind?: string
  actor_kind?: string
  minutes?: number | string
  limit?: number | string
  mine?: boolean | string
}): Promise<{ text: string, isError?: boolean }> {
  const audit = getOps()?.audit
  if (!audit) return { text: '审计仓储未装配(服务未就绪),请稍后重试。', isError: true }
  const scope = agentOpsScope(agentId)
  if (!scope) return { text: '你尚未绑定任何工业节点,无日志可查(日志权限跟随节点绑定)。', isError: true }
  const nodeId = String(args.node_id ?? '').trim()
  const lineId = String(args.line_id ?? '').trim()
  if (nodeId && !scope.nodeIds.has(nodeId))
    return { text: `无权查询节点 ${nodeId} 的日志(仅可查自己绑定的节点;用 my_industrial_nodes 查看绑定)。`, isError: true }
  if (lineId && !scope.lineIds.includes(lineId))
    return { text: `无权查询产线 ${lineId} 的日志(你的负责产线:${scope.lineIds.join(', ') || '(绑定节点均未分配产线)'})。`, isError: true }
  const kind = String(args.kind ?? '').trim() || undefined
  const actorKind = String(args.actor_kind ?? '').trim() || undefined
  const mine = args.mine === true || args.mine === 'true'
  const minutes = Number(args.minutes) || 1440
  const limit = Math.min(Number(args.limit) || 20, 100)
  const from = new Date(Date.now() - minutes * 60_000).toISOString()

  const lines = lineId ? [lineId] : scope.lineIds
  const byId = new Map<string, Record<string, unknown>>()
  for (const lid of lines) {
    for (const r of audit.query({ lineId: lid, kind, actorKind, actor: mine ? agentId : undefined, from, limit }))
      byId.set(String(r.id), r)
  }
  let rows = [...byId.values()]
  if (nodeId) rows = rows.filter(r => r.targetId === nodeId)
  rows.sort((a, b) => String(b.at).localeCompare(String(a.at)))
  rows = rows.slice(0, limit)
  if (rows.length === 0) return { text: `窗口(近 ${minutes} 分钟)内无匹配日志。可调大 minutes,或放宽 kind/actor_kind/node_id 过滤。` }

  const body = rows.map((r) => {
    const src = OPS_ACTOR_LABEL[String(r.actorKind)] ?? String(r.actorKind)
    return `- [${fmtAuditAt(String(r.at))}] 来源=${src} 操作者=${String(r.actorName) || String(r.actor)} | ${String(r.action)} | ${String(r.summary)}`
  })
  const scopeNote = lineId ? `产线 ${lineId}` : `负责产线 ${scope.lineIds.length} 条`
  return {
    text: `运维日志(${scopeNote},近 ${minutes} 分钟,${rows.length} 条,新→旧):\n${body.join('\n')}\n\n说明:来源=Agent 的操作者格式为「Channel名/成员名」;需要节点级参数值变更史用 dcw_journal,配方下发/回退专门视图用 recipe_log。`,
  }
}

/** 工具:recipe_log —— 负责产线的配方下发与回退历史(recipe.apply + 优化开窗/判定/回退)。
 *  Agent 据此知道 Recipe 层面发生过哪些下发变更、谁做的、是否已回退。 */
export async function toolRecipeLog(agentId: string, args: {
  line_id?: string
  recipe_id?: string
  minutes?: number | string
  limit?: number | string
}): Promise<{ text: string, isError?: boolean }> {
  const audit = getOps()?.audit
  if (!audit) return { text: '审计仓储未装配(服务未就绪),请稍后重试。', isError: true }
  const scope = agentOpsScope(agentId)
  if (!scope) return { text: '你尚未绑定任何工业节点,无 Recipe 历史可查(权限跟随节点绑定)。', isError: true }
  const lineId = String(args.line_id ?? '').trim()
  if (lineId && !scope.lineIds.includes(lineId))
    return { text: `无权查询产线 ${lineId} 的 Recipe 历史(你的负责产线:${scope.lineIds.join(', ') || '(无)'})。`, isError: true }
  const recipeId = String(args.recipe_id ?? '').trim() || undefined
  const minutes = Number(args.minutes) || 1440
  const limit = Math.min(Number(args.limit) || 20, 100)
  const from = new Date(Date.now() - minutes * 60_000).toISOString()

  const lines = lineId ? [lineId] : scope.lineIds
  const byId = new Map<string, Record<string, unknown>>()
  for (const lid of lines) {
    for (const kind of ['recipe', 'rollback']) {
      for (const r of audit.query({ lineId: lid, kind, recipeId, from, limit }))
        byId.set(String(r.id), r)
    }
  }
  const rows = [...byId.values()].sort((a, b) => String(b.at).localeCompare(String(a.at))).slice(0, limit)
  if (rows.length === 0) return { text: `窗口(近 ${minutes} 分钟)内无配方下发/回退记录。可调大 minutes 或换 line_id。` }

  const body = rows.map((r) => {
    const src = OPS_ACTOR_LABEL[String(r.actorKind)] ?? String(r.actorKind)
    const action = String(r.action)
    const tag = action === 'recipe.apply'
      ? '配方下发'
      : action === 'optimization.open'
        ? '优化开窗'
        : action === 'optimization.judge'
          ? '优化判定'
          : action === 'optimization.rollback'
            ? '回退执行'
            : action
    return `- [${fmtAuditAt(String(r.at))}] ${tag} 来源=${src} 操作者=${String(r.actorName) || String(r.actor)} | ${String(r.summary)}${r.recipeId ? `(配方 ${String(r.recipeId).slice(0, 8)})` : ''}`
  })
  return {
    text: `Recipe 变更史(${lineId ? `产线 ${lineId}` : `负责产线 ${scope.lineIds.length} 条`},近 ${minutes} 分钟,${rows.length} 条,新→旧):\n${body.join('\n')}\n\n说明:配方下发=整批参数写命令;优化开窗=单次设定变更(含 Agent 假设);回退执行=已恢复基线值。节点级参数值逐笔历史用 dcw_journal(node_id)。`,
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
  if (!scope) return { text: '你尚未绑定任何工业节点,暂无产线上下文(请先在数字孪生界面绑定节点)。' }
  const wanted = String(args.line_id ?? '').trim()
  const lineIds = wanted ? [wanted] : scope.lineIds
  if (wanted && !scope.lineIds.includes(wanted)) {
    return { text: `产线 ${wanted} 不在你的负责范围(你绑定节点覆盖的产线:${scope.lineIds.join(', ') || '无'})。`, isError: true }
  }
  if (lineIds.length === 0) return { text: '你绑定的节点均未分配产线(未挂线的节点没有产线/产品/配方上下文)。' }

  const sections: string[] = []
  for (const lid of lineIds) {
    const line = getDcwLineRepo().byId(lid)
    const run = getActiveLineRun(lid)
    const recipe = run?.recipeId ? getDcwController().listRecipes().find(r => r.id === run.recipeId) : undefined
    const parts: string[] = []
    parts.push(`■ 产线 ${line?.name ?? lid}(${lid})· 状态:${run ? '运行中' : '待机/停线'}`)
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
    parts.push(`  我绑定的节点:数控 [${myDcw.map(n => n!.name).join(', ') || '无'}];数采 [${myDaq.map(n => n!.name).join(', ') || '无'}]`)
    if (recipe) {
      parts.push(`  配方「${recipe.name}」(${recipe.id}) v${recipe.version ?? 1}${recipe.description ? ` — ${recipe.description}` : ''}`)
      for (const p of recipe.params) {
        const node = getDcwController().byId(p.nodeId)
        const mine = myDcw.some(n => n!.id === p.nodeId)
        const stale = nodeRefStatus(p.nodeId, recipe.lineId)
        const staleTag = stale ? ` [${stale.label},参数不下发]` : ''
        const cur = node?.value != null ? node.value : '?'
        const win = p.min != null || p.max != null ? `(窗口 ${p.min ?? '-∞'}~${p.max ?? '+∞'})` : ''
        parts.push(`    · ${node?.name ?? p.nodeId} = ${p.value}${node?.unit ?? ''}${win} | PLC 当前 ${cur}${node?.unit ?? ''}${mine ? ' [我负责]' : ''}${staleTag}`)
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
    text: `你控制的产线全景(${sections.length} 条):\n\n${sections.join('\n\n')}\n\n说明:配方目标=开跑批次冻结的工艺窗口;PLC 当前值=实时读数。把验证过的最佳参数固化到配方用 recipe_update;回退配方到稳定版本用 recipe_rollback;逐节点参数变更史用 dcw_journal;配方版本史用 recipe_versions。`,
  }
}

/** 工具:recipe_versions —— 配方参数版本史(谁/何时/为什么改了什么;旧→新)。
 *  每条含 by(user/agent/system)、操作者人话名、变更描述、参数 diff。 */
export async function toolRecipeVersions(agentId: string, args: { recipe_id?: string, limit?: number | string }): Promise<{ text: string, isError?: boolean }> {
  const recipeId = String(args.recipe_id ?? '').trim()
  if (!recipeId) return { text: 'recipe_id 必填(line_context 可看到当前配方的 id)。', isError: true }
  const recipe = getDcwController().listRecipes().find(r => r.id === recipeId)
  if (!recipe) return { text: `配方 ${recipeId} 不存在。`, isError: true }
  const scope = agentOpsScope(agentId)
  if (!scope || !recipe.lineId || !scope.lineIds.includes(recipe.lineId)) {
    return { text: `无权查看配方 ${recipeId} 的版本史(该配方不在你负责的产线上)。`, isError: true }
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

/** 工具:recipe_update —— 把验证过的最佳参数保存进配方(生成新版本,带归因与原因)。
 *  只改配方定义(下一批次生效);不改运行中 PLC 当前值(那用 dcw_control 逐节点下发)。 */
export async function toolRecipeUpdate(agentId: string, args: {
  recipe_id?: string
  params?: Array<{ node_id?: string, value?: number | string, min?: number | string, max?: number | string }>
  reason?: string
  task_id?: string
}): Promise<{ text: string, isError?: boolean }> {
  const recipeId = String(args.recipe_id ?? '').trim()
  const reason = String(args.reason ?? '').trim()
  if (!recipeId) return { text: 'recipe_id 必填(line_context 可看到当前配方的 id)。', isError: true }
  if (!reason) return { text: 'reason 必填:保存参数必须说明依据(如数采证据/判定结论),便于版本史追溯。', isError: true }
  const list = (args.params ?? []).filter(p => p && String(p.node_id ?? '').trim() && Number.isFinite(Number(p.value)))
  if (list.length === 0) return { text: 'params 至少提供一条 {node_id, value}(value 必须为数字)。', isError: true }
  const recipe = getDcwController().listRecipes().find(r => r.id === recipeId)
  if (!recipe) return { text: `配方 ${recipeId} 不存在。`, isError: true }
  const repo = getAgentNodeBindingRepo()
  for (const p of list) {
    const nodeId = String(p.node_id).trim()
    const node = getDcwController().byId(nodeId)
    if (!node) return { text: `节点 ${nodeId} 已删除,不能作为配方参数保存。请改用仍在线的节点。`, isError: true }
    if (node.lineId !== recipe.lineId) return { text: `节点「${node.name}」已取消绑定(不在配方「${recipe.name}」所在产线),不可混入。`, isError: true }
    if (!node.enabled) return { text: `节点「${node.name}」已停用,参数保存被拒。请先让用户恢复节点控制,或保存到其他节点。`, isError: true }
    if (!repo.find(agentId, nodeId, 'dcw')) {
      return { text: `无权修改节点「${node.name}」的配方参数(仅可改自己绑定 dcw 的节点)。`, isError: true }
    }
  }
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
      if (!patch) return { nodeId: p.nodeId, templateRef: p.templateRef, value: p.value, min: p.min, max: p.max }
      const out: { nodeId: string, templateRef?: string, value: number, min?: number, max?: number } = { nodeId: p.nodeId, templateRef: p.templateRef, value: Number(patch.value) }
      if (p.min != null) out.min = p.min
      if (patch.min != null && Number.isFinite(Number(patch.min))) out.min = Number(patch.min)
      if (p.max != null) out.max = p.max
      if (patch.max != null && Number.isFinite(Number(patch.max))) out.max = Number(patch.max)
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
      const before = recipe.params.find(x => x.nodeId === String(p.node_id).trim())?.value
      return `${node?.name ?? p.node_id} ${before ?? '?'}→${Number(p.value)}`
    }).join(';')
    const droppedNote = dropped.length > 0 ? `\n注意:已自动剔除失效参数(${dropped.join('、')}:节点已删除或改挂其他产线),这些参数不再属于本配方。` : ''
    return {
      text: `已保存为 v${updated.version ?? 1}:「${updated.name}」参数 ${changedNodes};原因:${reason}。${droppedNote}\n注意:配方定义已更新,运行中批次仍按开跑时冻结的参数生产,新参数从下次开跑/一键下发生效;要把新值写入运行中的 PLC,用 dcw_control 逐节点下发(走安全联锁)。回退用 recipe_rollback。`,
    }
  }
  catch (err) {
    return { text: `保存失败:${err instanceof Error ? err.message : String(err)}`, isError: true }
  }
}

/** 工具:recipe_rollback —— 回退配方参数到稳定版本(指定历史版本或已知良好批次快照)。
 *  生成新版本(非破坏,历史保留);不改运行中 PLC 当前值。 */
export async function toolRecipeRollback(agentId: string, args: {
  recipe_id?: string
  version?: number | string
  to_last_good?: boolean | string
  reason?: string
}): Promise<{ text: string, isError?: boolean }> {
  const recipeId = String(args.recipe_id ?? '').trim()
  const reason = String(args.reason ?? '').trim()
  const toLastGood = args.to_last_good === true || args.to_last_good === 'true'
  const version = Number(args.version)
  if (!recipeId) return { text: 'recipe_id 必填。', isError: true }
  if (!reason) return { text: 'reason 必填:回退必须说明原因(如优化翻车/越限),便于版本史追溯。', isError: true }
  if (!toLastGood && !Number.isFinite(version)) return { text: '需提供 version(历史版本号)或 to_last_good=true。', isError: true }
  const recipe = getDcwController().listRecipes().find(r => r.id === recipeId)
  if (!recipe) return { text: `配方 ${recipeId} 不存在。`, isError: true }
  const scope = agentOpsScope(agentId)
  if (!scope || !recipe.lineId || !scope.lineIds.includes(recipe.lineId)) {
    return { text: `无权回退配方 ${recipeId}(该配方不在你负责的产线上)。`, isError: true }
  }
  if (!toLastGood && Number.isFinite(version) && version >= (recipe.version ?? 1)) {
    return { text: `不能回退到 v${version}(当前已是 v${recipe.version ?? 1};回退目标是更早的版本)。`, isError: true }
  }
  try {
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
      text: `回退完成:配方「${updated.name}」已生成 v${updated.version ?? 1},参数恢复为目标版本(${toLastGood ? '已知良好批次冻结' : `v${version}`});原因:${reason}。\n运行中批次不受影响(仍按开跑冻结参数);新参数下次开跑生效。版本史用 recipe_versions 复核。`,
    }
  }
  catch (err) {
    return { text: `回退失败:${err instanceof Error ? err.message : String(err)}`, isError: true }
  }
}
