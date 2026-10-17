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

/** 一次调用解析一次的引用面(校验与拒绝文案共用,避免重复查询) */
export interface ToolRefFaces {
  agentId: string
  /** 绑定面节点:dcw+daq 绑定节点 ∪ 绑定配方参数节点 */
  boundNodes: Set<string>
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
}

/** 解析调用者的合法引用面(只读,不缓存——绑定可在调用间隙被用户改写) */
export function resolveRefFaces(agentId: string): ToolRefFaces {
  const bindings = getAgentNodeBindingRepo().byAgent(agentId)
  const boundNodes = new Set<string>()
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
      for (const p of (r?.params ?? [])) boundNodes.add(p.nodeId)
      continue
    }
    boundNodes.add(b.nodeId)
    if (b.kind === 'daq') daqBoundNodes.add(b.nodeId)
    const n = b.kind === 'dcw' ? getDcwController().byId(b.nodeId) : getDaqNodeRepo().byId(b.nodeId)
    if (n?.lineId) readableLines.add(n.lineId)
  }
  const channelLineId = channelBoundLineId(agentId) ?? ''
  if (channelLineId) readableLines.add(channelLineId)
  const channelLineNodes = new Set<string>()
  if (channelLineId) {
    for (const n of getDaqNodeRepo().all()) if (n.lineId === channelLineId) channelLineNodes.add(n.id)
  }
  return { agentId, boundNodes, daqBoundNodes, boundRecipes, recipeLines, readableLines, channelLineId, channelLineNodes }
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

type ChainKind = 'dataset' | 'job' | 'model' | 'plan' | 'scene'

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
  // scene:需带版本(scene_id 多版本并存);取不到记录 → 交工具自身
  const version = String(args.scene_version ?? '').trim()
  if (!version) return null
  const rec = createTwinRepo(rt.db).getScene(id, version)
  return rec ? { lineId: rec.lineId, createdBy: rec.createdBy } : null
}

// ===== 工具声明表 =====

interface VerifySpec {
  /** 必填引用:至少提供一个(hint 给 Agent 该传什么) */
  atLeastOne?: Array<{ params: string[], hint: string }>
  /** 浅层字符串引用参数 → 判定类别 */
  refs?: Array<{ param: string, kind: 'node' | 'line' | 'recipe' }>
  /** 浅层节点 id 数组参数 */
  nodeLists?: string[]
  /** 深路径节点引用(如 'params[].node_id' / 'packages[].params[].node_id') */
  deepNodeRefs?: string[]
  /** 链式引用(dataset_id/job_id/model_id/plan_id/scene_id) */
  chained?: Array<{ param: string, kind: ChainKind }>
}

/** 覆盖:全部「接收引用型参数」的工业工具。未列入 = 无引用参数或已由 v2 禁用桩自答。 */
const VERIFY_SPECS: Record<string, VerifySpec> = {
  // 数控/数采面(v2 禁用桩 handler 自答替代路径,无需预检)
  dcw_control: {},
  param_control: {},
  dcw_rollback: {},
  daq_query: { refs: [{ param: 'node_id', kind: 'node' }, { param: 'line_id', kind: 'line' }] },
  daq_frames: { refs: [{ param: 'node_id', kind: 'node' }, { param: 'line_id', kind: 'line' }] },
  daq_export: { refs: [{ param: 'line_id', kind: 'line' }], nodeLists: ['node_ids'] },
  dcw_judge: { atLeastOne: [{ params: ['record_id'], hint: 'record_id 必填(优化记录 id,opt-*);配方面链路判定不用 dcw_judge,达标用 recipe_update 固化、劣化用 recipe_rollback。' }] },
  dcw_journal: {
    atLeastOne: [{ params: ['node_id', 'recipe_id'], hint: 'node_id 或 recipe_id 至少提供一个:查某节点的参数变更史传 node_id;查配方面优化记录传 recipe_id(全节点不落权限面,不提供)。' }],
    refs: [{ param: 'node_id', kind: 'node' }, { param: 'recipe_id', kind: 'recipe' }],
  },
  // 判定/日志/配方/前哨面
  ops_log: { refs: [{ param: 'line_id', kind: 'line' }, { param: 'node_id', kind: 'node' }] },
  recipe_log: { refs: [{ param: 'line_id', kind: 'line' }] },
  line_context: { refs: [{ param: 'line_id', kind: 'line' }] },
  line_status: { refs: [{ param: 'line_id', kind: 'line' }] },
  line_start: { refs: [{ param: 'recipe_id', kind: 'recipe' }] },
  recipe_versions: { refs: [{ param: 'recipe_id', kind: 'recipe' }] },
  recipe_update: { refs: [{ param: 'recipe_id', kind: 'recipe' }], deepNodeRefs: ['params[].node_id'] },
  recipe_rollback: { refs: [{ param: 'recipe_id', kind: 'recipe' }] },
  recipe_trial: { refs: [{ param: 'recipe_id', kind: 'recipe' }], deepNodeRefs: ['params[].node_id'] },
  recipe_apply: { refs: [{ param: 'recipe_id', kind: 'recipe' }] },
  recipe_propose: { refs: [{ param: 'recipe_id', kind: 'recipe' }], deepNodeRefs: ['packages[].params[].node_id'] },
  // 分析与经验面
  analysis_save: { refs: [{ param: 'line_id', kind: 'line' }, { param: 'recipe_id', kind: 'recipe' }] },
  analysis_query: { refs: [{ param: 'line_id', kind: 'line' }] },
  aml_activity: { refs: [{ param: 'line_id', kind: 'line' }] },
  exp_collect: { refs: [{ param: 'line_id', kind: 'line' }, { param: 'lineId', kind: 'line' }] },
  // 寻优/孪生面
  optimization_explore: { refs: [{ param: 'control_node_id', kind: 'node' }, { param: 'target_node_id', kind: 'node' }] },
  twin_scene_compile: { refs: [{ param: 'line_id', kind: 'line' }, { param: 'recipe_id', kind: 'recipe' }], nodeLists: ['node_ids'] },
  twin_scene_freeze: { chained: [{ param: 'scene_id', kind: 'scene' }] },
  twin_calibration_request: { refs: [{ param: 'line_id', kind: 'line' }, { param: 'recipe_id', kind: 'recipe' }] },
  twin_gate_evaluate: { chained: [{ param: 'model_id', kind: 'model' }] },
  // AML 面
  aml_dataset_build: { refs: [{ param: 'line_id', kind: 'line' }, { param: 'recipe_id', kind: 'recipe' }], deepNodeRefs: ['nodes[].node_id'] },
  aml_dataset_stats: { chained: [{ param: 'dataset_id', kind: 'dataset' }] },
  aml_leaderboard: { chained: [{ param: 'dataset_id', kind: 'dataset' }] },
  aml_job_submit: { chained: [{ param: 'dataset_id', kind: 'dataset' }] },
  aml_job_status: { chained: [{ param: 'job_id', kind: 'job' }] },
  aml_job_logs: { chained: [{ param: 'job_id', kind: 'job' }] },
  aml_job_cancel: { chained: [{ param: 'job_id', kind: 'job' }] },
  aml_model_promote: { chained: [{ param: 'model_id', kind: 'model' }] },
  aml_training_plan_create: { refs: [{ param: 'line_id', kind: 'line' }, { param: 'recipe_id', kind: 'recipe' }] },
  aml_training_plan_train: { chained: [{ param: 'plan_id', kind: 'plan' }] },
  // MES 面(ids 为 MES 数控节点,归属判定与 mes-controller 可见面同源)
  mes_fetch: { nodeLists: ['ids'] },
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
 * 工业工具调用统一预检。返回 null = 通过;返回结果 = 拒绝(可直接回给 Agent 的 isError 文本)。
 * 调用点:dispatch.ts 工业工具族分流处(grant 复核之后、handler 之前)。
 */
export function verifyIndustrialToolCall(agentId: string, toolName: string, args: Record<string, unknown>): HostToolResult | null {
  const spec = VERIFY_SPECS[toolName]
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
        const exists = nodeRow(id) !== null
        if (!exists || !nodeAllowed(faces, id)) return denyNode(faces, toolName, args, ref.param, id, exists)
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
      const row = chainLineOf(chain.kind, id, args)
      if (!row) continue
      const mine = row.createdBy === agentId
      const readable = !!row.lineId && faces.readableLines.has(row.lineId)
      if (!mine && !readable) {
        const label = { dataset: '数据集', job: '训练作业', model: '模型', plan: '建模任务', scene: '场景' }[chain.kind]
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
