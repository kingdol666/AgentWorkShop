/**
 * industrial_resources —— 按 Agent 绑定面分页枚举可用资源(WP6)。
 *
 * 动机:绑定面很大时不再把全量节点/配方塞进工具描述(描述预算折叠),模型改为按需分页查询。
 * 只读、零引用参数(数据面就是调用者自己的绑定面 —— 不存在越权读取的引用可校验);
 * 与注入面/执行面同源(agentToolResources + optimizer bindings)。
 */
import type { HostToolResult } from '../host-tool-bridge/types'
import { agentToolResources } from '../host-tool-bridge/per-agent'
import { listBindingsForAgent } from '../../optimization/binding.service'
import { paginateResourceItems } from './resource-paging'

type ResourceKind = 'daq' | 'line-daq' | 'recipe' | 'mes' | 'optimizer' | 'all'

interface ResourceItem {
  kind: Exclude<ResourceKind, 'all'>
  id: string
  name: string
  detail?: string
}

export async function toolIndustrialResources(agentId: string, args: Record<string, unknown>): Promise<HostToolResult> {
  const kindRaw = String(args.kind ?? 'all').trim().toLowerCase()
  const kind: ResourceKind = (['daq', 'line-daq', 'recipe', 'mes', 'optimizer', 'all'].includes(kindRaw) ? kindRaw : 'all') as ResourceKind
  const q = String(args.query ?? '').trim().toLowerCase()

  const res = agentToolResources(agentId)
  const items: ResourceItem[] = []
  const want = (k: Exclude<ResourceKind, 'all'>): boolean => kind === 'all' || kind === k

  if (want('daq')) {
    for (const n of res.daqNodes) items.push({ kind: 'daq', id: n.id, name: n.name, detail: `绑定数采节点${n.unit ? `,单位 ${n.unit}` : ''}` })
  }
  if (want('line-daq')) {
    const bound = new Set(res.daqNodes.map(n => n.id))
    for (const n of res.daqLineNodes) {
      if (bound.has(n.id)) continue
      items.push({ kind: 'line-daq', id: n.id, name: n.name, detail: `频道绑线只读${n.unit ? `,单位 ${n.unit}` : ''}` })
    }
  }
  if (want('recipe')) {
    for (const r of res.recipes) {
      items.push({
        kind: 'recipe',
        id: r.id,
        name: r.name,
        detail: `v${r.version};参数 ${r.params.length} 个${r.params.length ? `:${r.params.map(p => `${p.name}(${p.nodeId})`).join('、')}` : ''}`,
      })
    }
  }
  if (want('mes')) {
    for (const n of res.mesNodes) items.push({ kind: 'mes', id: n.id, name: n.name, detail: `MES 点位(经配方参数面取数)${n.unit ? `,单位 ${n.unit}` : ''}` })
  }
  if (want('optimizer')) {
    let bindings: ReturnType<typeof listBindingsForAgent> = []
    try {
      bindings = listBindingsForAgent(agentId)
    }
    catch { /* 优化器未装配 → 空 */ }
    for (const b of bindings) {
      items.push({ kind: 'optimizer', id: b.id, name: b.id, detail: `profile ${b.profileVersion},${b.mode};能力 ${b.capabilities.join('/')}` })
    }
  }

  const { page, total, hasMore, offset, limit } = paginateResourceItems(items, { query: q, offset: Number(args.offset), limit: Number(args.limit) })

  if (total === 0) {
    return {
      text: `你的绑定面中没有${kind === 'all' ? '任何资源' : ` kind=${kind} 的资源`}${q ? `(筛选:${q})` : ''}。\n如需访问产线对象,请让用户或 lead 在数字孪生界面为你绑定节点/配方(或把频道绑定到产线获得只读数采面);也可用 my_industrial_nodes 查看当前绑定。`,
    }
  }
  const body = page.map(it => `- [${it.kind}] ${it.name}(${it.id})${it.detail ? ` — ${it.detail}` : ''}`).join('\n')
  const footer = hasMore
    ? `\n\n还有 ${total - offset - page.length} 项:继续用 offset=${offset + page.length} 分页查询。`
    : `\n\n(共 ${total} 项,已全部列出)`
  return {
    text: `绑定面资源(kind=${kind}${q ? `,query=${q}` : ''};offset=${offset} limit=${limit}):\n${body}${footer}`,
  }
}
