/**
 * per-agent.ts —— 按 Agent 绑定的节点/配方增强工具描述。
 *
 * 目的:同一份 host-tools.json 在注入不同 Agent 时,`daq_query`/`recipe_*`/`mes_*`
 * 的描述应带上**该 Agent 实际可见的节点与配方**,让模型不必先猜/先探测绑定面。
 * 注入面(MCP tools/list、omp set_host_tools、pi registerTool)全部经本函数,
 * 与执行面(dispatch 的 grant-guard)同源,不会出现“描述里有、执行时无权”的错位。
 *
 * 只读装配:不改变工具集合(角色/插件/档位过滤仍由 hostToolsForRole 决定),
 * 仅在描述尾部追加可见资源清单。无绑定 → 原样返回,零行为变化。
 */
import { hostToolsForRole, OPTIMIZER_TOOL_NAMES } from './catalog'
import { getAgentNodeBindingRepo } from '../node-bindings.repo'
import { getDaqController } from '../../daq/daq-controller'
import { getDcwController } from '../../dcw/dcw-controller'
import { listBindingsForAgent } from '../../optimization/binding.service'
import { foldList as foldListImpl, sortedById } from './description-budget'
import { promptLocaleOf, tr, type PromptLocale } from '../prompt-i18n'

/** 需要追加“可见资源”描述的工具族 */
const DAQ_TOOLS = new Set(['daq_query', 'daq_frames', 'daq_export'])
const RECIPE_TOOLS = new Set(['recipe_catalog', 'recipe_log', 'recipe_versions', 'recipe_update', 'recipe_rollback', 'recipe_trial', 'recipe_apply', 'recipe_propose'])
const MES_TOOLS = new Set(['mes_catalog', 'mes_fetch', 'mes_export', 'mes_dataset_read', 'mes_datasets'])

export interface AgentToolResourceView {
  /** Agent 显式绑定的数采节点(kind=daq) */
  daqNodes: Array<{ id: string, name: string, unit: string }>
  /** 频道绑线带来的只读数采节点(v28;执行面 daqTargetsOf 同样并入) */
  daqLineNodes: Array<{ id: string, name: string, unit: string }>
  /** Agent 显式绑定的数控节点(kind=dcw)= 点位写授权面(2026-10-28 双轨授权) */
  writeNodes: Array<{ id: string, name: string, unit: string }>
  /** 产线配方管理权(kind=line-recipe):该 Agent 可管理全部配方的产线 */
  managedLines: Array<{ id: string, name: string }>
  recipes: Array<{ id: string, name: string, version: number, params: Array<{ nodeId: string, name: string, unit: string }> }>
  mesNodes: Array<{ id: string, name: string, unit: string }>
}

/** 频道绑线(与 daqTargetsOf 同源;globalThis 单例避免 per-agent → manager 循环依赖) */
function channelLineOf(agentId: string): string {
  try {
    const g = globalThis as typeof globalThis & {
      __workshopManager?: { channelLineBindingOf?(id: string): string | null }
    }
    return g.__workshopManager?.channelLineBindingOf?.(agentId) ?? ''
  }
  catch {
    return ''
  }
}

/** 读取 Agent 的绑定面(只读;异常降级为空,绝不影响工具注入) */
export function agentToolResources(agentId: string): AgentToolResourceView {
  const out: AgentToolResourceView = { daqNodes: [], daqLineNodes: [], writeNodes: [], managedLines: [], recipes: [], mesNodes: [] }
  if (!agentId) return out
  try {
    const bindings = getAgentNodeBindingRepo().byAgent(agentId)
    const daq = getDaqController()
    const dcw = getDcwController()
    const lineId = channelLineOf(agentId)
    if (lineId) {
      for (const n of daq.listViews()) {
        if (n.lineId === lineId) out.daqLineNodes.push({ id: n.id, name: n.name, unit: n.unit ?? '' })
      }
    }
    for (const b of bindings) {
      if (b.kind === 'daq') {
        const n = daq.byId(b.nodeId)
        if (n) out.daqNodes.push({ id: n.id, name: n.name, unit: n.unit ?? '' })
      }
      else if (b.kind === 'dcw') {
        // 点位写授权面:让模型不必先探测就知道自己能对哪些节点 trial/apply
        const n = dcw.byId(b.nodeId)
        if (n) out.writeNodes.push({ id: n.id, name: n.name, unit: n.unit ?? '' })
      }
      else if (b.kind === 'line-recipe') {
        // 产线配方管理权:该线全部配方(含未来新建)可 查看/新建/修改/回退
        const line = dcw.listLines().find(l => l.id === b.nodeId)
        if (line) out.managedLines.push({ id: line.id, name: line.name })
      }
      else if (b.kind === 'recipe') {
        const r = dcw.listRecipes().find(x => x.id === b.nodeId)
        if (!r) continue
        const params: AgentToolResourceView['recipes'][number]['params'] = []
        for (const p of r.params ?? []) {
          const n = dcw.byId(p.nodeId)
          params.push({ nodeId: p.nodeId, name: n?.name ?? p.nodeId, unit: n?.unit ?? '' })
          // MES 取数授权配方:仅 mes-rest 驱动的参数节点才是 MES 点位
          // (forge-channel 3b 用配方参数面授权历史-only MES 节点;普通产线配方不冒充 MES)。
          if (n?.driver === 'mes-rest' && !out.mesNodes.some(x => x.id === p.nodeId)) {
            out.mesNodes.push({ id: p.nodeId, name: n.name, unit: n.unit ?? '' })
          }
        }
        out.recipes.push({ id: r.id, name: r.name, version: r.version ?? 1, params })
      }
    }
  }
  catch {
    /* 绑定仓储不可用(单测/启动早期)→ 不增强 */
  }
  return out
}

/**
 * WP6 描述预算:大绑定面不再全量拼进 description(撑上下文 + 放大 10s 轮询载荷 + 触发
 * 无意义 list_changed)。折叠确定性由 description-budget 叶子模块保证。
 * env AW_DESC_BUDGET=0 关闭折叠(回退原行为)。
 */
const foldList = (prefix: string, items: string[]): string => foldListImpl(prefix, items)

/** 在角色过滤后的工具面上追加 Agent 绑定资源描述 + 优化器绑定裁剪 */
export function hostToolsForAgent(agentId: string, role: 'lead' | 'worker', channelId?: string, localeInput?: PromptLocale) {
  const locale = localeInput ?? promptLocaleOf(agentId, channelId)
  const tools = hostToolsForRole(role, channelId, locale)
  // G4.3 #10:无有效绑定时移除 solve/status/cancel/plan_get(保留 capabilities 作解释入口);
  // 多绑定时在描述中列出 bindingId(solve 需显式选择)。过滤不改变返回类型。
  const bindings = listOptimizerBindings(agentId)
  const filtered = bindings.length
    ? tools
    : tools.filter(t => !OPTIMIZER_REQUIRES_BINDING.has(t.name))
  const optimizerLine = bindings.length
    ? `${tr(locale, '\n\n本 Agent 的优化器绑定:', '\n\nOptimizer bindings of this agent:')}${bindings.map(b => `${b.id}(profile ${b.profileVersion},${b.mode};${tr(locale, '能力:', 'capabilities:')}${b.capabilities.join('/')})`).join('; ')}${bindings.length > 1 ? tr(locale, '\n多绑定:调用 optimizer_solve 必须显式传 binding_id。', '\nMultiple bindings: optimizer_solve requires an explicit binding_id.') : ''}`
    : ''
  const res = agentToolResources(agentId)
  // WP6:排序保证同一绑定面确定性输出(折叠/不折叠都稳定)
  const sortedDaq = sortedById(res.daqNodes)
  const sortedWrite = sortedById(res.writeNodes)
  const sortedManaged = sortedById(res.managedLines)
  const sortedRecipes = sortedById(res.recipes)
  const sortedMes = sortedById(res.mesNodes)
  const lineOnlyDaq = sortedById(res.daqLineNodes.filter(n => !sortedDaq.some(x => x.id === n.id)))
  if (sortedDaq.length === 0 && lineOnlyDaq.length === 0 && sortedWrite.length === 0 && sortedManaged.length === 0 && sortedRecipes.length === 0 && !bindings.length) return filtered
  const daqParts = [
    sortedDaq.length > 0 ? foldList(tr(locale, `本 Agent 直接绑定的数采节点(仅这些可查):`, `DAQ nodes bound directly to this agent (queryable):`), sortedDaq.map(x => `${x.name}(${x.id}${x.unit ? `,${x.unit}` : ''})`)) : '',
    lineOnlyDaq.length > 0 ? foldList(tr(locale, `频道绑线只读数采节点(可查):`, `Read-only DAQ nodes from the channel line binding:`), lineOnlyDaq.map(x => `${x.name}(${x.id}${x.unit ? `,${x.unit}` : ''})`)) : '',
  ].filter(Boolean)
  const daqLine = daqParts.length > 0 ? `\n\n${daqParts.join('\n')}` : ''
  const writeLine = sortedWrite.length > 0
    ? foldList(
        tr(locale, `\n\n本 Agent 的数控节点写授权面(点位写授权;可在这些节点上 trial/apply,换配方仍有效):`, `\n\nDCW node write-authorization face of this agent (point-level; trial/apply allowed on these nodes, survives recipe switches):`),
        sortedWrite.map(x => `${x.name}(${x.id}${x.unit ? `,${x.unit}` : ''})`),
      )
    : ''
  const managedLine = sortedManaged.length > 0
    ? foldList(
        tr(locale, `\n\n本 Agent 持有的产线配方管理权(可 查看/新建/修改/回退 该线全部配方;下发仍受点位绑定约束:未绑定任何数控节点时默认可对配方全部参数下发,绑了数控节点则只能下发这些点位):`, `\n\nLine recipe-management grants of this agent (view/create/update/rollback ALL recipes on these lines; dispatch still follows point-binding rules: with no DCW bindings at all, all recipe params are dispatchable; with DCW bindings, only those points):`),
        sortedManaged.map(x => `${x.name}(${x.id})`),
      )
    : ''
  const recipeLine = sortedRecipes.length > 0
    ? foldList(
        tr(locale, `\n\n本 Agent 已绑定的配方(仅这些可写/下发):`, `\n\nRecipes bound to this agent (writable/dispatchable):`),
        sortedRecipes.map(r => `${r.name}(${r.id},v${r.version};${tr(locale, '参数:', 'params:')}${r.params.map(p => `${p.name}(${p.nodeId})`).join(tr(locale, '、', ', ')) || tr(locale, '无', 'none')})`),
      )
    : ''
  const mesLine = sortedMes.length > 0
    ? foldList(tr(locale, `\n\n本 Agent 可经配方参数面取数的 MES 点位:`, `\n\nMES points this agent can read through its recipe parameters:`), sortedMes.map(x => `${x.name}(${x.id}${x.unit ? `,${x.unit}` : ''})`))
    : ''
  return filtered.map((t) => {
    let suffix = ''
    if (DAQ_TOOLS.has(t.name)) suffix = daqLine
    else if (RECIPE_TOOLS.has(t.name)) suffix = `${recipeLine}${writeLine}${managedLine}`
    else if (MES_TOOLS.has(t.name)) suffix = mesLine
    else if (OPTIMIZER_TOOL_NAMES.has(t.name)) suffix = optimizerLine
    if (!suffix) return t
    return { ...t, description: `${t.description ?? ''}${suffix}` }
  })
}

/** 优化器中必须绑定才能注入/调用的四个工具(capabilities 始终保留)。 */
const OPTIMIZER_REQUIRES_BINDING = new Set(['optimizer_solve', 'optimizer_status', 'optimizer_cancel', 'optimizer_plan_get'])

function listOptimizerBindings(agentId: string): Array<{ id: string, profileVersion: string, mode: string, capabilities: string[] }> {
  try {
    return listBindingsForAgent(agentId).map(b => ({ id: b.id, profileVersion: b.profileVersion, mode: b.mode, capabilities: b.capabilities as string[] }))
  }
  catch {
    return []
  }
}
