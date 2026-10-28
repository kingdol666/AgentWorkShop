/**
 * tool-verify —— 工业工具调用的统一预检(参数形状 + 引用归属)。
 *
 * 背景(2026-10-17 审计):dispatch 层此前只有产线级 grant 复核(guardIndustrialToolGrant)
 * 与 AML profile 门控,**没有对调用参数做「最小形状 + 引用归属」的集中校验**;逐工具
 * 自校验覆盖面不齐——dcw_journal.recipe_id、aml_dataset_stats/job_*、aml_training_plan_*、
 * optimization_explore.target_node_id、line_status.line_id 等一度可被任意 id 命中(跨线读;
 * 见逐工具审计表)。本模块把这些判定收敛为单一口径:任何工业工具调用在分发给 handler
 * **之前**必须过此闸门。
 *
 * 判定规则(与既有逐工具校验的合法集合对齐,不松不紧):
 *  - **参数形状**:声明的必填引用(atLeastOne)缺失 → 结构化拒绝(带 hint 说明该传什么);
 *    引用参数类型不是字符串 → 拒绝。
 *  - **引用归属**:从调用者(agent)当前绑定面计算合法引用面,引用不在面内 → 拒绝,
 *    并把「你的绑定面 + 下一步动作」写进回包,Agent 能据此自我纠正:
 *      nodeFace   = agent 绑定节点(dcw/daq/配方参数节点)
 *                 ∪ 频道绑线数采节点(v28 只读扩权,与 daqTargetsOf 同源)
 *                 ∪ 绑定配方所在产线的节点(配方扩展参数场景,与 recipe 面语义一致)
 *      lineFace   = agentOpsScope 可读线(节点授权线 ∪ 配方绑定线 ∪ 频道绑线)
 *      recipeFace = 绑定配方 ∪ 可读线上的配方(与 recipe_versions 口径一致)
 *      chainFace  = dataset/job/model/plan/scene:创建者本人 或 其 lineId ∈ lineFace
 *  - 逐工具自带的更严校验(requireDcwBinding / daqTargetsOf / assertRecipeOperation /
 *    mesDatasetVisible …)原样保留:本层只拦「任何合法路径都到不了」的引用,不放宽任何
 *    既有门槛(defense in depth);授权性拒绝入册 audit(level=warn),供 /logs 追溯。
 *  - 本层自身故障 → fail-closed(与 grant-guard 同纪律:不因实现缺陷放行)。
 */
import type { HostToolResult } from '../host-tool-bridge/types'
import { AppError } from '@/server/utils/errors'
import { getAgentNodeBindingRepo } from '../node-bindings.repo'
import { channelBoundLineId } from './ops-tools'
import { getDaqNodeRepo } from '../../daq/daq-node.repo'
import { getDcwController } from '../../dcw/dcw-controller'
import { getAmlRuntime } from '../../aml/runtime'
import { getTrainingPlan } from '../../aml/twin/training-plans'
import { createTwinRepo } from '../../aml/twin/repo'
import { recordOps } from '../../ops/ops'
import { declaredReferenceSpec, type ToolVerifySpec } from '../tool-reference-spec'
import { LEGACY_VERIFY_SPECS } from './tool-verify-legacy-specs'

/** 一次调用解析一次的引用面(校验与拒绝文案共用,避免重复查询) */
export interface ToolRefFaces {
  agentId: string
  /** 绑定面节点:dcw+daq 绑定节点 ∪ 绑定配方参数节点 */
  boundNodes: Set<string>
  /** 写授权面 W(a):dcw 绑定节点 ∪ 绑定配方参数节点(节点级写授权,与 recipe-gate 同口径;
   *  daq 只读绑定与频道绑线只读扩权不进写面) */
  writeFace: Set<string>
  /** 仅数采绑定(dcw 工具只认 dcw 绑定,读取面只认 daq 绑定——分面保留) */
  daqBoundNodes: Set<string>
  /** 绑定的配方(kind='recipe' 的绑定,nodeId 字段存 recipeId) */
  boundRecipes: Set<string>
  /** 绑定配方所在产线(配方扩展参数场景的合法节点线) */
  recipeLines: Set<string>
  /** 可读产线 = agentOpsScope 语义(节点授权线 ∪ 配方绑定线 ∪ 频道绑线) */
  readableLines: Set<string>
  /** 频道绑定产线(未绑定为空串) */
  channelLineId: string
  /** 频道绑线下的数采节点(v28 只读扩权面) */
  channelLineNodes: Set<string>
  /** 产线配方管理权(kind='line-recipe'):lineId → 授权(2026-10-28) */
  managedLines: Map<string, { mode: 'auto' | 'manual' }>
}

/** 解析调用者的合法引用面(只读,不缓存——绑定可在调用间隙被用户改写) */
export function resolveRefFaces(agentId: string): ToolRefFaces {
  const bindings = getAgentNodeBindingRepo().byAgent(agentId)
  const boundNodes = new Set<string>()
  const writeFace = new Set<string>()
  const daqBoundNodes = new Set<string>()
  const boundRecipes = new Set<string>()
  const recipeLines = new Set<string>()
  const readableLines = new Set<string>()
  for (const b of bindings) {
    if (b.kind === 'recipe') {
      boundRecipes.add(b.nodeId)
      const r = getDcwController().listRecipes().find(x => x.id === b.nodeId)
      if (r?.lineId) {
        recipeLines.add(r.lineId)
        readableLines.add(r.lineId)
      }
      for (const p of (r?.params ?? [])) {
        boundNodes.add(p.nodeId)
        writeFace.add(p.nodeId)
      }
      continue
    }
    boundNodes.add(b.nodeId)
    if (b.kind === 'daq') daqBoundNodes.add(b.nodeId)
    else writeFace.add(b.nodeId)
    const n = b.kind === 'dcw' ? getDcwController().byId(b.nodeId) : getDaqNodeRepo().byId(b.nodeId)
    if (n?.lineId) readableLines.add(n.lineId)
  }
  const channelLineId = channelBoundLineId(agentId) ?? ''
  if (channelLineId) readableLines.add(channelLineId)
  const channelLineNodes = new Set<string>()
  if (channelLineId) {
    for (const n of getDaqNodeRepo().all()) if (n.lineId === channelLineId) channelLineNodes.add(n.id)
  }
  // 产线配方管理权:该线全部配方的参数进入写面(下发仍受「绑 dcw 即收窄」规则约束,
  // 精确判定在 recipe-gate;预检面放宽到线配方参数,避免管理操作在预检被误拦)
  const managedLines = new Map<string, { mode: 'auto' | 'manual' }>()
  for (const b of bindings) {
    if (b.kind !== 'line-recipe') continue
    if (managedLines.has(b.nodeId)) continue
    managedLines.set(b.nodeId, { mode: b.mode })
    for (const r of getDcwController().listRecipes()) {
      if (r.lineId !== b.nodeId) continue
      for (const p of (r.params ?? [])) {
        boundNodes.add(p.nodeId)
        writeFace.add(p.nodeId)
      }
    }
  }
  return { agentId, boundNodes, writeFace, daqBoundNodes, boundRecipes, recipeLines, readableLines, channelLineId, channelLineNodes, managedLines }
}

// ===== 归属判定 =====

function nodeRow(id: string): { lineId: string, name: string } | null {
  const dcw = getDcwController().byId(id)
  if (dcw) return { lineId: dcw.lineId ?? '', name: dcw.name }
  const daq = getDaqNodeRepo().byId(id)
  if (daq) return { lineId: daq.lineId ?? '', name: daq.name }
  return null
}

function nodeAllowed(faces: ToolRefFaces, id: string): boolean {
  if (faces.boundNodes.has(id) || faces.channelLineNodes.has(id)) return true
  if (faces.recipeLines.size === 0) return false
  const row = nodeRow(id)
  return !!row?.lineId && faces.recipeLines.has(row.lineId)
}

/** 列表化面信息(拒绝文案用;空面显式写「(无)」) */
function listOf(set: Set<string>): string {
  return set.size > 0 ? [...set].join(', ') : '(无)'
}

function deny(toolName: string, args: Record<string, unknown>, heads: string[], faces: ToolRefFaces | null, hint: string, ref?: { param: string, value: string, lineId?: string }): HostToolResult {
  // 授权性拒绝入册(level=warn;形状类拒绝只有 heads 无 ref,不入册避免噪音)
  if (ref && faces) {
    recordOps({
      actor: faces.agentId,
      actorName: faces.agentId,
      actorKind: 'agent',
      action: 'tool.call.denied',
      kind: 'system',
      level: 'warn',
      targetKind: 'tool',
      targetId: toolName,
      summary: `工具调用被拒(引用校验):${ref.param}=${ref.value} 不在授权面`,
      detail: { tool: toolName, param: ref.param, value: ref.value, args },
    })
  }
  return { text: `${heads.join('\n')}\n${hint}`, isError: true }
}

/** node 引用拒绝文案:点名参数、列出绑定面、给下一步 */
function denyNode(faces: ToolRefFaces, toolName: string, args: Record<string, unknown>, param: string, id: string, exists: boolean): HostToolResult {
  const row = exists ? nodeRow(id) : null
  const where = row ? `(节点「${row.name}」${row.lineId ? `,归属产线 ${row.lineId}` : ''})` : '(节点不存在或已删除)'
  const faceLine = `你的绑定节点:${listOf(faces.boundNodes)}${faces.channelLineNodes.size > 0 ? `;频道绑线「${faces.channelLineId}」只读数采节点:${listOf(faces.channelLineNodes)}` : ''}`
  const hint = exists
    ? `该节点不在你的绑定范围内。${faceLine}。如需访问,请让用户或 lead 在数字孪生界面为你绑定该节点(可用 my_industrial_nodes 查看现有绑定);或改用上述范围内的节点重试。`
    : `请核对节点 id(先用 my_industrial_nodes / line_context 查看在线对象);节点被删除时原绑定会失效,需要重新绑定。`
  return deny(toolName, args, [
    `工具调用被拒(引用校验,${toolName}):${param} = 「${id}」不在你的授权范围内${where}。`,
  ], faces, hint, { param, value: id, lineId: row?.lineId })
}

/** 写面拒绝(2026-10-28):参数要写到的节点必须落在 W(a)=dcw 绑定 ∪ 绑定配方参数节点 ∪ 管理线配方参数。
 *  比 denyNode 更明确:读得到 ≠ 写得到(频道绑线只读扩权/他配方节点都不构成写授权)。 */
function denyWriteNode(faces: ToolRefFaces, toolName: string, args: Record<string, unknown>, param: string, id: string, exists: boolean): HostToolResult {
  const row = exists ? nodeRow(id) : null
  const where = row ? `(节点「${row.name}」${row.lineId ? `,归属产线 ${row.lineId}` : ''})` : '(节点不存在或已删除)'
  const managedNote = faces.managedLines.size > 0
    ? `你持有产线配方管理权的线:[${[...faces.managedLines.keys()].join(', ')}](仅覆盖这些线上的配方参数)。`
    : ''
  const hint = `该节点不在你的写授权面(节点绑定=点位写授权;配方绑定=配方操作权;产线管理权=该线配方参数)。你的可写节点:${listOf(faces.writeFace)}。${managedNote} 如需写入,请让用户或 lead 为你绑定该数控节点(dcw),或授予配方绑定/产线配方管理权。`
  return deny(toolName, args, [
    `工具调用被拒(写授权校验,${toolName}):参数节点「${id}」不在你的写授权面内${where}。`,
  ], faces, hint, { param, value: id, lineId: row?.lineId })
}

function denyLine(faces: ToolRefFaces, toolName: string, args: Record<string, unknown>, param: string, id: string): HostToolResult {
  const exists = getDcwController().listLines().some(l => l.id === id)
  const hint = `你的可读产线:${listOf(faces.readableLines)}${faces.channelLineId ? `(其中「${faces.channelLineId}」来自频道绑线,只读)` : ''}。如需访问该产线,请让用户授予对应产线权限(权限管理),或把当前频道绑定到该产线;也可以改用上述可读产线重试。`
  return deny(toolName, args, [
    `工具调用被拒(引用校验,${toolName}):${param} = 「${id}」${exists ? '' : '(产线不存在)'}不在你的可读范围内。`,
  ], faces, hint, { param, value: id })
}

function denyRecipe(faces: ToolRefFaces, toolName: string, args: Record<string, unknown>, param: string, id: string): HostToolResult {
  const r = getDcwController().listRecipes().find(x => x.id === id)
  const where = r ? `(配方「${r.name}」,归属产线 ${r.lineId || '未分配'})` : '(配方不存在或已删除)'
  const hint = `你绑定的配方:${listOf(faces.boundRecipes)};可读产线上的配方也可读版本史/日志。配方操作(update/apply/trial/rollback)必须先由用户或 lead 把该配方绑定给你(绑定后该配方参数节点同时进入你的操作面)。`
  return deny(toolName, args, [
    `工具调用被拒(引用校验,${toolName}):${param} = 「${id}」不在你可读/可操作的配方范围内${where}。`,
  ], faces, hint, { param, value: id })
}

/** 链式引用(dataset/job/model/plan/scene):经谱系回溯到产线,按「创建者本人 ∪ 可读线」判定 */
function chainDeny(faces: ToolRefFaces, toolName: string, args: Record<string, unknown>, param: string, id: string, kindLabel: string, lineId: string): HostToolResult {
  const hint = `该${kindLabel}不属于你可读的产线,也不是由你创建。你的可读产线:${listOf(faces.readableLines)}${faces.channelLineId ? `(含频道绑线「${faces.channelLineId}」)` : ''}。如需跨线使用,请让用户把频道绑定到目标产线或为你的 Agent 绑定该产线的节点;也可以在自己的产线上重建${kindLabel}。`
  return deny(toolName, args, [
    `工具调用被拒(引用校验,${toolName}):${param} = 「${id}」越出你的数据范围(谱系产线 ${lineId || '未知'})。`,
  ], faces, hint, { param, value: id, lineId })
}

function draftLineId(draftJson: string): string {
  try {
    return (JSON.parse(draftJson || '{}') as { lineId?: string }).lineId ?? ''
  }
  catch {
    return ''
  }
}

type ChainKind = 'dataset' | 'job' | 'model' | 'plan' | 'scene' | 'binding' | 'run' | 'recommendation' | 'ontology_draft' | 'ontology_version'

/** 优化运行/建议 → 所属 Agent(经 binding 反查);不存在返回 null(交工具兜底)。 */
function optimizerOwnership(id: string, kind: 'run' | 'recommendation'): { agentId: string } | null {
  const db = getAmlRuntime().db
  if (kind === 'run') {
    const row = db.prepare('SELECT b.channel_agent_id AS agentId FROM optimizer_runs r JOIN optimizer_bindings b ON b.id = r.binding_id WHERE r.id = ?').get(id) as { agentId: string } | undefined
    return row ?? null
  }
  const row = db.prepare('SELECT b.channel_agent_id AS agentId FROM optimizer_recommendations rc JOIN optimizer_runs r ON r.id = rc.run_id JOIN optimizer_bindings b ON b.id = r.binding_id WHERE rc.id = ?').get(id) as { agentId: string } | undefined
  return row ?? null
}

function denyBinding(toolName: string, args: Record<string, unknown>, param: string, id: string, reason: string) {
  return {
    text: `工具调用被拒(引用校验,${toolName}):${param} = ${id} ${reason}(BINDING_NOT_OWNED)。请用 optimizer_capabilities 查看本 Agent 的绑定 id。`,
    isError: true,
  }
}

/** 链式解析:返回 null 表示「无法判定/对象不存在」——放行给工具自身兜底(存在性文案更准确) */
function chainLineOf(kind: ChainKind, id: string, args: Record<string, unknown>): { lineId: string, createdBy: string } | null {
  const rt = getAmlRuntime()
  if (kind === 'dataset') {
    const row = rt.repo.dataset.get(id)
    return row ? { lineId: row.lineId, createdBy: row.createdBy } : null
  }
  if (kind === 'job') {
    const job = rt.repo.job.get(id)
    if (!job) return null
    const ds = rt.repo.dataset.get(job.datasetId)
    return { lineId: ds?.lineId ?? '', createdBy: job.agentId ?? '' }
  }
  if (kind === 'model') {
    const m = rt.repo.model.get(id)
    return m ? { lineId: m.lineId, createdBy: m.createdBy } : null
  }
  if (kind === 'plan') {
    const p = getTrainingPlan(id)
    return p ? { lineId: p.lineId, createdBy: '' } : null
  }
  // 本体草稿:归属 = 草稿属主(agent 起草时 owner=agentId);取不到 → 交工具自身
  if (kind === 'ontology_draft') {
    const row = rt.db.prepare('SELECT owner_user_id AS ownerUserId, draft_json AS draftJson FROM ontology_drafts WHERE id = ?').get(id) as { ownerUserId?: string, draftJson?: string } | undefined
    if (!row) return null
    let lineId = draftLineId(row.draftJson ?? '')
    if (!lineId) {
      const v = rt.db.prepare('SELECT line_id AS lineId FROM ontology_versions WHERE id = (SELECT ontology_id FROM ontology_drafts WHERE id = ?) ORDER BY version DESC LIMIT 1').get(id) as { lineId?: string } | undefined
      lineId = v?.lineId ?? ''
    }
    return { lineId, createdBy: row.ownerUserId ?? '' }
  }
  // 本体版本:id@version 或 (ontology_id, version);归属 = 版本产线
  if (kind === 'ontology_version') {
    const ontologyId = id
    const wantsVersion = args.version !== undefined ? Number(args.version) : Number.NaN
    const row = Number.isInteger(wantsVersion)
      ? rt.db.prepare('SELECT line_id AS lineId FROM ontology_versions WHERE id = ? AND version = ?').get(ontologyId, wantsVersion) as { lineId?: string } | undefined
      : rt.db.prepare(`SELECT line_id AS lineId FROM ontology_versions WHERE id = ? AND status = 'published' ORDER BY version DESC LIMIT 1`).get(ontologyId) as { lineId?: string } | undefined
    if (!row) return null
    return { lineId: row.lineId ?? '', createdBy: '' }
  }
  // scene:需带版本(scene_id 多版本并存);取不到记录 → 交工具自身
  const version = String(args.scene_version ?? '').trim()
  if (!version) return null
  const rec = createTwinRepo(rt.db).getScene(id, version)
  return rec ? { lineId: rec.lineId, createdBy: rec.createdBy } : null
}

// ===== 工具声明表(声明→单源;旧代码表仅回滚/等价回退) =====

/** 声明来源:host-tools.json 的 `references` / `noRefs`(WP5 起为默认路径);
 *  env AW_TOOL_VERIFY_LEGACY_SPECS=1 时整表回退旧代码表(一个版本周期的回滚开关)。 */
function legacyMode(): boolean {
  return process.env.AW_TOOL_VERIFY_LEGACY_SPECS === '1'
}

let warnedUndelcaredAt = 0

function resolveSpec(toolName: string): ToolVerifySpec | null {
  if (legacyMode()) return LEGACY_VERIFY_SPECS[toolName] ?? null
  const { declared, spec } = declaredReferenceSpec(toolName)
  if (declared) return spec
  // 未声明:回退旧表(单测/目录未装配的等价回退);两表都没有则由注册期登记制拦截,
  // 执行期保持既有「未登记=无引用参数」契约(未知工具错误语义不变)。
  const fallback = LEGACY_VERIFY_SPECS[toolName]
  if (!fallback && Date.now() - warnedUndelcaredAt > 60_000) {
    warnedUndelcaredAt = Date.now()
    recordOps({
      actor: 'system',
      actorName: 'tool-verify',
      actorKind: 'system',
      action: 'tool.call.undeclared',
      kind: 'system',
      level: 'warn',
      targetKind: 'tool',
      targetId: toolName,
      summary: `工具「${toolName}」未声明引用面(references/noRefs),已按无引用放行`,
    })
  }
  return fallback ?? null
}

/** 深路径取值:'params[].node_id' / 'packages[].params[].node_id' */
function collectDeep(args: unknown, dotted: string): string[] {
  const segs = dotted.split('.')
  const out: string[] = []
  const walk = (cur: unknown, i: number): void => {
    if (i >= segs.length) {
      const s = String(cur ?? '').trim()
      if (s) out.push(s)
      return
    }
    const seg = segs[i]!
    const isList = seg.endsWith('[]')
    const key = isList ? seg.slice(0, -2) : seg
    const val = (cur as Record<string, unknown> | null | undefined)?.[key]
    if (isList) {
      if (Array.isArray(val)) for (const item of val) walk(item, i + 1)
    }
    else walk(val, i + 1)
  }
  walk(args, 0)
  return out
}

/**
 * 工业工具调用统一预检(声明解析 → 实时校验)。返回 null = 通过;返回结果 = 拒绝。
 * 调用点:dispatch.ts 工业工具族分流处(grant 复核之后、handler 之前)。
 *
 * 声明来源优先级:env 回滚开关 > host-tools.json `references`/`noRefs` > 旧代码表(等价回退)。
 * 无论声明从哪来,**归属面都在本次调用实时重算**(不缓存:绑定可在调用间隙被改写)。
 */
export function verifyIndustrialToolCall(agentId: string, toolName: string, args: Record<string, unknown>): HostToolResult | null {
  return verifyToolReferences(agentId, toolName, args, resolveSpec(toolName))
}

/**
 * 按显式声明校验一次调用(插件工具与 host 工具共用同一实现 —— 声明在哪、校验就一套)。
 * spec=null(显式 noRefs/无规则)→ 直接放行。
 */
export function verifyToolReferences(agentId: string, toolName: string, args: Record<string, unknown>, spec: ToolVerifySpec | null): HostToolResult | null {
  if (!spec) return null
  try {
    // 1) 必填引用(atLeastOne):形状类拒绝,不入册
    for (const need of spec.atLeastOne ?? []) {
      const present = need.params.some(p => String(args[p] ?? '').trim())
      if (!present) {
        return deny(toolName, args, [`工具调用被拒(参数校验,${toolName}):${need.hint}`], null, '参数补齐后重试。')
      }
    }
    // 2) 类型形状:引用参数必须是字符串(ID 而非对象/数组)
    for (const ref of spec.refs ?? []) {
      const v = args[ref.param]
      if (v != null && typeof v !== 'string') {
        return deny(toolName, args, [`工具调用被拒(参数校验,${toolName}):${ref.param} 必须是字符串 ID,收到 ${Array.isArray(v) ? '数组' : typeof v}。`], null, '请按工具描述传单个对象 ID 字符串。')
      }
    }
    for (const key of [...spec.nodeLists ?? [], ...spec.deepNodeRefs ?? []]) {
      const v = key.includes('[]') ? undefined : args[key]
      if (v != null && !key.includes('[]') && !Array.isArray(v)) {
        return deny(toolName, args, [`工具调用被拒(参数校验,${toolName}):${key} 必须是 ID 数组。`], null, '请传字符串数组(如 ["dn-xxx","dw-yyy"])。')
      }
    }
    // 3) 引用归属
    const faces = resolveRefFaces(agentId)
    for (const ref of spec.refs ?? []) {
      const id = String(args[ref.param] ?? '').trim()
      if (!id) continue
      if (ref.kind === 'node') {
        const row = nodeRow(id)
        const readableNode = spec.readableLineNodes && !!row?.lineId && faces.readableLines.has(row.lineId)
        if (!row || (!nodeAllowed(faces, id) && !readableNode)) return denyNode(faces, toolName, args, ref.param, id, Boolean(row))
      }
      else if (ref.kind === 'line') {
        if (!faces.readableLines.has(id)) return denyLine(faces, toolName, args, ref.param, id)
      }
      else {
        const exists = getDcwController().listRecipes().some(x => x.id === id)
        const onReadable = exists && (faces.readableLines.size > 0) && getDcwController().listRecipes().some(x => x.id === id && x.lineId && faces.readableLines.has(x.lineId))
        if (!faces.boundRecipes.has(id) && !onReadable) return denyRecipe(faces, toolName, args, ref.param, id)
      }
    }
    for (const key of spec.nodeLists ?? []) {
      const list = args[key]
      if (!Array.isArray(list)) continue
      for (const raw of list) {
        const id = String(raw ?? '').trim()
        if (!id) continue
        const exists = nodeRow(id) !== null
        if (!exists || !nodeAllowed(faces, id)) return denyNode(faces, toolName, args, key, id, exists)
      }
    }
    // 写入型参数节点:必须落在写授权面 W(a)(只读面/频道绑线/他配方节点不构成写授权)。
    // 先于 deepNodeRefs 检查:nodeAllowed 允许"绑定配方所在产线的任意节点",对写入过宽,
    // 写面判定才是本工具真正的授权边界(拒绝文案也更能行动)。
    for (const path of spec.writeNodeRefs ?? []) {
      const leaf = path.split('.').pop() ?? path
      for (const id of collectDeep(args, path)) {
        const exists = nodeRow(id) !== null
        if (!exists || !faces.writeFace.has(id)) return denyWriteNode(faces, toolName, args, leaf, id, exists)
      }
    }
    for (const path of spec.deepNodeRefs ?? []) {
      // 深路径的 param 名用于文案:取最后一段
      const leaf = path.split('.').pop() ?? path
      for (const id of collectDeep(args, path)) {
        const exists = nodeRow(id) !== null
        if (!exists || !nodeAllowed(faces, id)) return denyNode(faces, toolName, args, leaf, id, exists)
      }
    }
    // 4) 链式引用(谱系回溯;取不到谱系记录 → 放行给工具自身兜底)
    for (const chain of spec.chained ?? []) {
      const id = String(args[chain.param] ?? '').trim()
      if (!id) continue
      if (chain.kind === 'binding') {
        // G4.5:binding_id 必须属于当前 Agent 实例(模板 id/他人绑定一律拒绝)
        const binding = getAmlRuntime().db.prepare('SELECT channel_agent_id AS agentId FROM optimizer_bindings WHERE id = ?').get(id) as { agentId: string } | undefined
        if (!binding) return denyBinding(toolName, args, chain.param, id, '不存在')
        if (binding.agentId !== agentId) return denyBinding(toolName, args, chain.param, id, '不属于当前 Agent')
        continue
      }
      if (chain.kind === 'run' || chain.kind === 'recommendation') {
        const ownership = optimizerOwnership(id, chain.kind)
        if (!ownership) continue
        if (ownership.agentId !== agentId) {
          return { text: `工具调用被拒(引用校验,${toolName}):${chain.param} = ${id} 不属于当前 Agent(BINDING_NOT_OWNED)`, isError: true }
        }
        continue
      }
      const row = chainLineOf(chain.kind, id, args)
      if (!row) continue
      const mine = row.createdBy === agentId
      const readable = !!row.lineId && faces.readableLines.has(row.lineId)
      if (!mine && !readable) {
        const label = { dataset: '数据集', job: '训练作业', model: '模型', plan: '建模任务', scene: '场景', ontology_draft: '本体草稿', ontology_version: '本体版本' }[chain.kind]
        return chainDeny(faces, toolName, args, chain.param, id, label, row.lineId)
      }
    }
    return null
  }
  catch (err) {
    if (err instanceof AppError) return { text: `工具调用被拒(引用校验,${toolName}):${err.message}`, isError: true }
    // 预检自身故障 → fail-closed(与 grant-guard 同纪律)
    return { text: `工具调用被拒(引用校验服务异常,${toolName}):${err instanceof Error ? err.message : String(err)}。请稍后重试;若持续出现请联系管理员。`, isError: true }
  }
}
