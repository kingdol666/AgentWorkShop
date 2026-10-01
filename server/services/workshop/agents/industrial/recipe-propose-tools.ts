/**
 * 整包方案工具(recipe_propose)—— 产线 Co-Pilot P2「诊断工程师」的结构化下发面(计划 §5.4)。
 *
 * 语义:Agent 提交 1~3 套候选参数包 → 服务端逐参数预检(镜像 recipe 真实执行限界)→
 * 一张结构化审批单(kind='dcw',nodeId=`recipe-propose:<recipeId>`,payload.schemaVersion=1)
 * → 人类在产线页审批卡**选定一套**批准(choice)→ 走既有 applyRecipe(overrides,trial) 管线
 * 整批下发 → 回执逐参数映射并固定携带 runId(供后续轮次效果回访)。
 *
 * 铁律落点:
 *  - recipe 级整包无论绑定 mode 永远挂审批单(本工具不查 binding mode,任何模式都审批);
 *  - AML 优化循环活动期间硬禁下发(时间互斥,自动降级建议报告);
 *  - 预检先于审批:越界参数在审批单生成前剔除,「批准必被拒包」不可达;
 *  - 无依据(basis)与经验引用(exp_ref)的参数不得入包;
 *  - 多方案批准未携带有效 choice 一律按拒绝收敛(fail-closed,见 tool-approvals.normalizeRecipeProposeDecision)。
 */
import { agentBadgeLabel } from '../agent-badge'
import { getToolApprovals } from '../tool-approvals'
import { getAgentNodeBindingRepo } from '../node-bindings.repo'
import { securityRecipeDispatchTimeoutMs } from '../../settings'
import { getDcwController } from '../../dcw/dcw-controller'
import { getDcwLineRepo } from '../../dcw/dcw-line.repo'
import { recordOps } from '../../ops/ops'
import { evaluateRecipeParamLimits } from '../../dcw/dcw-controller/write'
import { amlActivityForLine } from './aml-activity'
import { agentOpsScope } from './ops-tools'

/** 候选包上限(防审批卡被刷屏;1~3 套) */
const MAX_PACKAGES = 3

/** 入参:单参数声明(snake_case;from 允许缺省 = 服务端自取节点当前值) */
export interface RecipeProposeParamInput {
  node_id?: string
  from?: number | string
  to?: number | string
  unit?: string
  basis?: string
  exp_ref?: string
}

/** 入参:单套候选包 */
export interface RecipeProposePackageInput {
  name?: string
  rationale?: string
  params?: RecipeProposeParamInput[]
}

/** 审批单 payload 内的参数行(契约:schemaVersion=1;前端审批卡按此渲染) */
export interface RecipeProposePayloadParam {
  nodeId: string
  paramName: string
  from: number | null
  to: number
  unit: string
  basis: string
  exp_ref: string
  preflight: { ok: boolean, reason?: string }
}

/** 审批单 payload(结构化审批卡与回执映射的共同事实源) */
export interface RecipeProposePayload {
  schemaVersion: 1
  recipeId: string
  lineId: string
  packages: Array<{ name: string, rationale: string, params: RecipeProposePayloadParam[] }>
}

/** 参数行的单行渲染(审批单 detail 文本降级 + 预检明细共用) */
function paramLine(p: RecipeProposePayloadParam, nodeLabel: string): string {
  const range = p.from != null ? `${p.from}→${p.to}` : `→${p.to}`
  const pf = p.preflight.ok ? '预检通过' : `预检失败:${p.preflight.reason ?? '未知原因'}`
  return `· ${nodeLabel} ${range}${p.unit}${p.preflight.ok ? '' : `【${pf},已从下发集剔除】`}`
}

/** 工具:recipe_propose —— 提交整包候选方案,挂一张结构化审批单等待人工裁决。 */
export async function toolRecipePropose(agentId: string, args: {
  recipe_id?: string
  packages?: RecipeProposePackageInput[]
}): Promise<{ text: string, isError?: boolean }> {
  // ---------- ① 参数校验(packages 1..3;每参数 node_id/to/basis/exp_ref 必填) ----------
  const recipeId = String(args.recipe_id ?? '').trim()
  if (!recipeId) return { text: 'recipe_id 必填(line_context 可看到当前配方 id)。', isError: true }
  const rawPackages = Array.isArray(args.packages) ? args.packages.filter(p => p && typeof p === 'object') : []
  if (rawPackages.length === 0) return { text: 'packages 必填:至少 1 套候选方案(每套 { name, rationale, params: [{ node_id, to, basis, exp_ref }] });整包审批的意义就是多方案一次裁决。', isError: true }
  if (rawPackages.length > MAX_PACKAGES) return { text: `packages 最多 ${MAX_PACKAGES} 套候选方案(收到 ${rawPackages.length} 套);更多方案请分批提交。`, isError: true }

  const problems: string[] = []
  const packages: Array<{ name: string, rationale: string, params: RecipeProposePayloadParam[] }> = []
  rawPackages.forEach((pkg, pi) => {
    const name = String(pkg.name ?? '').trim()
    if (!name) {
      problems.push(`方案 ${pi + 1}:缺 name(为方案起名,供审批卡展示)`)
      return
    }
    const rationale = String(pkg.rationale ?? '').trim()
    const rawParams = Array.isArray(pkg.params) ? pkg.params.filter(p => p && typeof p === 'object') : []
    if (rawParams.length === 0) {
      problems.push(`方案「${name}」:params 为空(至少 1 条参数)`)
      return
    }
    const params: RecipeProposePayloadParam[] = []
    rawParams.forEach((p, x) => {
      const nodeId = String(p.node_id ?? '').trim()
      const to = Number(p.to)
      const basis = String(p.basis ?? '').trim()
      const expRef = String(p.exp_ref ?? '').trim()
      const where = `方案「${name}」第 ${x + 1} 条参数`
      if (!nodeId) problems.push(`${where}:缺 node_id`)
      if (!Number.isFinite(to)) problems.push(`${where}:to 必须为数字(收到 ${String(p.to)})`)
      if (p.from !== undefined && p.from !== null && String(p.from).trim() !== '' && !Number.isFinite(Number(p.from))) problems.push(`${where}:from 需为数字或缺省(缺省=服务端自取当前值)`)
      if (!basis) problems.push(`${where}:缺 basis(为什么这样调;无依据的参数不得入包)`)
      if (!expRef) problems.push(`${where}:缺 exp_ref(经验/证据引用;无引用的参数不得入包)`)
      if (!nodeId || !Number.isFinite(to) || !basis || !expRef) return
      params.push({
        nodeId,
        paramName: nodeId,
        from: p.from === undefined || p.from === null || String(p.from).trim() === '' ? null : Number(p.from),
        to,
        unit: String(p.unit ?? '').trim(),
        basis,
        exp_ref: expRef,
        preflight: { ok: true },
      })
    })
    if (params.length > 0) packages.push({ name, rationale, params })
    else problems.push(`方案「${name}」:全部 ${rawParams.length} 条参数均未通过必填校验(见上),该方案未入审`)
  })
  if (packages.length === 0) {
    return { text: `参数校验失败,未提交审批:\n${problems.map(p => `- ${p}`).join('\n')}\n请补齐后重新提交(每参数必须带 basis 与 exp_ref)。`, isError: true }
  }

  // ---------- ② 配方存在性与产线归属(权限 mirror toolRecipeApply:节点授权线 ∪ 频道绑线 + 配方内至少一个授权节点) ----------
  const recipe = getDcwController().listRecipes().find(r => r.id === recipeId)
  if (!recipe) return { text: `配方 ${recipeId} 不存在。`, isError: true }
  const scope = agentOpsScope(agentId)
  const readableLineIds = scope ? [...new Set([...scope.lineIds, ...scope.boundLineIds])] : []
  if (!scope || !recipe.lineId || !readableLineIds.includes(recipe.lineId)) {
    return { text: `无权提交配方 ${recipeId} 的整包方案(该配方不在你负责的产线上)。`, isError: true }
  }
  const boundInRecipe = getAgentNodeBindingRepo().byAgent(agentId)
    .some(b => b.kind === 'dcw' && recipe.params.some(p => p.nodeId === b.nodeId))
  if (!boundInRecipe) {
    return { text: `无权提交配方 ${recipeId} 的整包方案(需持有该配方至少一个数控节点的授权;找 lead 用 team_grant_nodes 授予)。`, isError: true }
  }
  const line = getDcwLineRepo().byId(recipe.lineId)

  // ---------- ③ AML 活动硬闸(时间互斥:活动期间禁止整包下发,降级为建议报告) ----------
  const activity = amlActivityForLine(recipe.lineId)
  if (activity.active) {
    return {
      text: [
        'AML 优化循环活动期间禁止整包下发,已降级为建议 —— 本次方案未提交审批、产线无任何变更。',
        ...activity.reasons.map(r => `- ${r}`),
        '请把候选方案改写为建议报告沉淀入知识库(标签:建议、产线),并提醒人类:AML 循环结束(aml_activity 不活动)后再重新提交 recipe_propose。时间互斥是防「双写者」的铁律。',
      ].join('\n'),
      isError: true,
    }
  }

  // ---------- ④ 在飞去重(同一配方的 pending 单存在 → 软提示;拒绝/超时后自然解除) ----------
  // 不分 agent(防跨成员对同一配方各挂一张单、双双获批造成重复下发);本工具只会创建
  // 精确 nodeId = recipe-propose:<recipeId> 的单,等值判定即前缀语义。
  const inflight = getToolApprovals().listPending().filter(a => a.nodeId === `recipe-propose:${recipeId}`)
  if (inflight.length > 0) {
    return {
      text: `已有在飞方案审批单(${inflight.map(a => a.id).join(', ')}),等待人类裁决;同一配方同时只保留一张在飞单。拒绝/超时后该单收敛,即可吸收意见修订重提;请勿重复提交,可先在汇报中提醒人类尽快处置。`,
    }
  }

  // ---------- ⑤ 预检(镜像 recipe 真实执行限界:量程∩参数∩产品;步长/60s/保持窗本就不适用 recipe) ----------
  const preflightNotes: string[] = []
  for (const pkg of packages) {
    pkg.params = pkg.params.filter((p) => {
      const node = getDcwController().byId(p.nodeId)
      const label = node?.name ?? p.nodeId
      const fail = (reason: string): boolean => {
        p.preflight = { ok: false, reason }
        p.paramName = label
        preflightNotes.push(`方案「${pkg.name}」${label}:${reason}(已剔除)`)
        return false
      }
      if (!node) return fail('节点已删除,参数不可下发')
      if (node.lineId !== recipe.lineId) return fail('节点已不在配方所在产线(解绑/改挂),参数不可下发')
      if (!node.enabled) return fail('节点已停用,参数不可下发')
      if (!recipe.params.some(rp => rp.nodeId === p.nodeId)) return fail('参数不在配方内(整包下发只能覆盖配方已有参数;新增参数请先走 recipe_update)')
      p.paramName = node.name
      if (p.from == null) {
        // 服务端自取当前值:优先平台现值,其次读回值;都无则保持 null(审批卡显示 "?→to")
        p.from = typeof node.value === 'number' ? node.value : (typeof node.readValue === 'number' ? node.readValue : null)
      }
      if (!p.unit) p.unit = node.unit ?? ''
      // 只读限界谓词(skipRecipe:true = 配方下发路径真实语义)
      const pf = evaluateRecipeParamLimits(node, p.to, { skipRecipe: true })
      if (!pf.ok) return fail(pf.violations[0] ?? '写入限界校验失败')
      return true
    })
  }
  // 整包全失败 → 丢该包;全部包失效 → isError 附明细
  const alivePackages = packages.filter(pkg => pkg.params.some(p => p.preflight.ok))
  if (alivePackages.length === 0) {
    return {
      text: [
        '预检失败:全部候选方案无一参数通过限界校验,未提交审批、产线无任何变更。「批准必被拒包」的方案不得入审:',
        ...problems.map(p => `- 校验:${p}`),
        ...preflightNotes.map(p => `- ${p}`),
        '请按各条失败原因修订(越界值改到「节点量程∩参数基准∩产品限界」交集内;失效参数剔除或先恢复节点),再重新提交。',
      ].join('\n'),
      isError: true,
    }
  }

  // ---------- ⑥ 提交结构化审批单(kind='dcw',nodeId=recipe-propose:<id>,payload.schemaVersion=1) ----------
  const payload: RecipeProposePayload = {
    schemaVersion: 1,
    recipeId,
    lineId: recipe.lineId,
    packages: alivePackages.map(pkg => ({ ...pkg, params: pkg.params.filter(p => p.preflight.ok) })),
  }
  const detail = [
    `整包方案审批:配方「${recipe.name}」v${recipe.version ?? 1}(产线 ${line?.name ?? recipe.lineId}),${alivePackages.length} 套候选方案。请在产线页结构化审批卡选择方案批准(或拒绝并附指导);未携带方案序号的批准按拒绝收敛。`,
    ...alivePackages.map((pkg) => {
      const rows = pkg.params.map((p) => {
        const node = getDcwController().byId(p.nodeId)
        return `  ${paramLine(p, node?.name ?? p.nodeId)} | 依据:${p.basis} | 引用:${p.exp_ref}`
      })
      return `方案「${pkg.name}」${pkg.rationale ? `:${pkg.rationale}` : ''}\n${rows.join('\n')}`
    }),
    ...(preflightNotes.length > 0 ? [`预检剔除(不入下发集):`, ...preflightNotes.map(p => `  - ${p}`)] : []),
  ].join('\n')

  const approvalId = `recipe-propose:${recipeId}`
  let decision
  try {
    // 挂起前先入审计(方案提交留痕;裁决与下发另录)
    try {
      recordOps({
        actor: agentId, actorName: agentBadgeLabel(agentId), actorKind: 'agent',
        action: 'recipe.propose', kind: 'recipe', targetKind: 'recipe', targetId: recipeId, recipeId, lineId: recipe.lineId,
        summary: `提交整包方案审批(${alivePackages.length} 套/${alivePackages.reduce((n, p) => n + p.params.length, 0)} 参数,单 ${approvalId}):${alivePackages.map(p => p.name).join('、')}`,
      })
    }
    catch { /* 审计失败不影响提交 */ }
    decision = await getToolApprovals().request(agentId, approvalId, 'dcw', detail, {
      title: `整包方案审批:${recipe.name}`,
      timeoutMs: securityRecipeDispatchTimeoutMs(),
      payload,
    })
  }
  catch (err) {
    return { text: `提交整包方案审批失败:${err instanceof Error ? err.message : String(err)}`, isError: true }
  }

  // ---------- ⑦a 拒绝/超时:软拒绝,comment 逐字回流,指引修订后重提(mirror recipe 下发拒绝口径) ----------
  if (!decision.approved) {
    return {
      text: [
        `方案未获批准(超时未批或人工拒绝),未做任何下发。人工意见:${decision.comment || '(无附言,仅不同意候选)'}`,
        '请逐字吸收人工意见修订方案(每参数仍须带 basis 与 exp_ref;人类拒绝过的方案不得原样重提),然后重新提交 recipe_propose。',
      ].join('\n'),
    }
  }

  // ---------- ⑦b 批准(choice 已由 decide 链 fail-closed 归一):选定包整批下发 ----------
  // 归一后的 decision.choice 必为合法下标(由 normalizeRecipeProposeDecision 保证;此处兜底防呆)
  const chosenIdx = decision.choice ?? 0
  const chosen = payload.packages[chosenIdx] ?? payload.packages[0]!
  const overrides = chosen.params.map(p => ({ nodeId: p.nodeId, value: p.to }))
  let run
  try {
    // mirror toolRecipeApply 实际下发路径:trial 语义(整批候选、不写配方版本),overrides 限配方内节点
    run = await getDcwController().applyRecipe(recipeId, { overrides, trial: true })
  }
  catch (err) {
    // 响亮失败(典型:同线试验节拍未放行):方案已批准但产线未动 —— 指引稍后重试/直发,口径同 recipe_rollback
    return {
      text: [
        `方案「${chosen.name}」已获批准,但整批下发启动失败:${err instanceof Error ? err.message : String(err)}`,
        '产线未做任何变更;请等待节拍窗放行后用 dcw_control 逐节点直发本方案参数,或稍后重新提交 recipe_propose。',
      ].join('\n'),
      isError: true,
    }
  }
  const okN = run.results.filter(r => r.ok).length
  // 批准下发留痕(mirror toolRecipeApply 的 recipe.apply 审计;附审批单与选定包溯源)
  try {
    recordOps({
      actor: agentId, actorName: agentBadgeLabel(agentId), actorKind: 'agent',
      action: 'recipe.apply', kind: 'recipe', targetKind: 'recipe', targetId: recipeId, recipeId, lineId: recipe.lineId,
      summary: `整包方案审批后下发(${okN}/${run.results.length} 参数成功,批次 ${run.id.slice(0, 8)},单 ${decision.id},选定方案「${chosen.name}」#${chosenIdx})`,
      detail: { approvalId: decision.id, choice: chosenIdx, runId: run.id },
    })
  }
  catch { /* 审计失败不影响下发结果 */ }

  // 逐参数回执:选定包参数对照 from→to;配方内其余参数随批下发(值未改动)
  const chosenByNode = new Map(chosen.params.map(p => [p.nodeId, p]))
  const rows = run.results.map((r) => {
    const node = r.nodeId ? getDcwController().byId(r.nodeId) : undefined
    const label = node?.name ?? r.templateRef ?? r.nodeId ?? '?'
    const spec = r.nodeId ? chosenByNode.get(r.nodeId) : undefined
    const change = spec ? `${spec.from ?? '?'}→${spec.to}` : `${r.value}(随批整发,本方案未改动)`
    return `- ${label} ${change}${node?.unit ?? ''}${r.ok ? '' : ` 被拒:${String(r.message).slice(0, 80)}`}`
  })
  const feedback = decision.comment ? `\n[人工反馈] ${decision.comment}` : ''
  const runIdNote = `runId:${run.id}(后续轮次按此回访效果并回写经验)`
  // 部分失败/全失败响亮化(口径 mirror recipe_trial/recipe_rollback 先例:统一回退指引)
  if (run.results.length > 0 && okN === 0) {
    return {
      text: [
        `整包下发失败:方案「${chosen.name}」已获批准,但整批下发 0/${run.results.length} 参数成功(典型:节点写入保持窗/节流未放行)。${runIdNote}${feedback}`,
        '产线仍在运行原参数 —— 请等待约 60s 后用 dcw_control 逐节点直发本方案参数,或用 recipe_rollback(recipe_id, dispatch=true) 统一回退到已知良好版本;并把失败原因写入汇报提醒人类。',
      ].join('\n'),
      isError: true,
    }
  }
  const partialWarn = okN < run.results.length
    ? `\n注意:部分参数未生效(${okN}/${run.results.length}),未落盘节点请用 dcw_control 复查后单独直发;必要时 recipe_rollback(dispatch=true) 统一回退。`
    : ''
  return {
    text: [
      `方案「${chosen.name}」已获批准并整批下发(${okN}/${run.results.length} 参数成功,批次 ${run.id.slice(0, 8)})。${runIdNote}${feedback}`,
      ...rows,
      partialWarn,
      '请等待工艺惯性后 daq_query 复测判读:有进步 → 效果回访时回写经验到知识库;劣化 → 立即 recipe_rollback(recipe_id, dispatch=true) 统一回退并通报。',
    ].filter(Boolean).join('\n'),
  }
}
