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
import { hostToolsForRole } from './catalog'
import { getAgentNodeBindingRepo } from '../node-bindings.repo'
import { getDaqController } from '../../daq/daq-controller'
import { getDcwController } from '../../dcw/dcw-controller'

/** 需要追加“可见资源”描述的工具族 */
const DAQ_TOOLS = new Set(['daq_query', 'daq_frames', 'daq_export'])
const RECIPE_TOOLS = new Set(['recipe_catalog', 'recipe_log', 'recipe_versions', 'recipe_update', 'recipe_rollback', 'recipe_trial', 'recipe_apply', 'recipe_propose'])
const MES_TOOLS = new Set(['mes_catalog', 'mes_fetch', 'mes_export', 'mes_dataset_read', 'mes_datasets'])

export interface AgentToolResourceView {
  /** Agent 显式绑定的数采节点(kind=daq) */
  daqNodes: Array<{ id: string, name: string, unit: string }>
  /** 频道绑线带来的只读数采节点(v28;执行面 daqTargetsOf 同样并入) */
  daqLineNodes: Array<{ id: string, name: string, unit: string }>
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
  const out: AgentToolResourceView = { daqNodes: [], daqLineNodes: [], recipes: [], mesNodes: [] }
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

const listText = (items: Array<{ id: string, name: string, unit?: string }>): string =>
  items.map(x => `${x.name}(${x.id}${x.unit ? `,${x.unit}` : ''})`).join('、')

/** 在角色过滤后的工具面上追加 Agent 绑定资源描述 */
export function hostToolsForAgent(agentId: string, role: 'lead' | 'worker', channelId?: string) {
  const tools = hostToolsForRole(role, channelId)
  const res = agentToolResources(agentId)
  const lineOnlyDaq = res.daqLineNodes.filter(n => !res.daqNodes.some(x => x.id === n.id))
  if (res.daqNodes.length === 0 && lineOnlyDaq.length === 0 && res.recipes.length === 0) return tools
  const daqParts = [
    res.daqNodes.length > 0 ? `本 Agent 直接绑定的数采节点(仅这些可查):${listText(res.daqNodes)}` : '',
    lineOnlyDaq.length > 0 ? `频道绑线只读数采节点(可查):${listText(lineOnlyDaq)}` : '',
  ].filter(Boolean)
  const daqLine = daqParts.length > 0 ? `\n\n${daqParts.join('\n')}` : ''
  const recipeLine = res.recipes.length > 0
    ? `\n\n本 Agent 已绑定的配方(仅这些可写/下发):${res.recipes.map(r => `${r.name}(${r.id},v${r.version};参数:${r.params.map(p => `${p.name}(${p.nodeId})`).join('、') || '无'})`).join(';')}`
    : ''
  const mesLine = res.mesNodes.length > 0
    ? `\n\n本 Agent 可经配方参数面取数的 MES 点位:${listText(res.mesNodes)}`
    : ''
  return tools.map((t) => {
    let suffix = ''
    if (DAQ_TOOLS.has(t.name)) suffix = daqLine
    else if (RECIPE_TOOLS.has(t.name)) suffix = recipeLine
    else if (MES_TOOLS.has(t.name)) suffix = mesLine
    if (!suffix) return t
    return { ...t, description: `${t.description ?? ''}${suffix}` }
  })
}
