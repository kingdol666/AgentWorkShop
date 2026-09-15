/**
 * api-2-semantic-card —— 语义卡与审计面核查：Agent 看到的物理语义
 * （硬联锁量程/单位/精度/产线归属）与账本查询面（journal）是否真实可用。
 */
import { result } from '../util.mjs'

const meta = { id: 'api-2-semantic-card', title: '语义卡字段与账本面', tier: 'api', dims: ['D2', 'D7'], weight: 1, requires: ['server'] }

export default [{
  meta,
  async run(ctx) {
    const f = ctx.fixture
    const sub = []
    const add = (label, ok, detail) => sub.push({ label, ok: !!ok, detail: String(detail ?? '') })

    const list = await ctx.api.call('GET', '/api/workshop/dcw')
    const node = (list.data?.nodes ?? list.data ?? []).find?.(n => n.id === f.dw?.[0]) ?? null
    add('数控节点可列出', Boolean(node), node ? 'found' : 'not found')
    add('硬联锁量程字段', Boolean(node && node.min != null && node.max != null), node ? `min=${node.min} max=${node.max}` : '-')
    add('显示精度字段', Boolean(node && node.decimals != null), node ? `decimals=${node.decimals}` : '-')
    add('产线归属（五维打标）', Boolean(node && node.lineId === f.lineId), node ? node.lineId : '-')

    const j = await ctx.api.call('GET', `/api/workshop/dcw/journal?lineId=${f.lineId}&limit=50`)
    add('写控账本可查询', j.status === 200 && Array.isArray(j.data?.anchors), `anchors=${j.data?.anchors?.length ?? 'n/a'}`)

    const dl = await ctx.api.call('GET', '/api/workshop/daq')
    const dn = (dl.data?.nodes ?? []).find?.(n => n.id === f.dn) ?? null
    add('数采节点可列出', Boolean(dn), dn ? 'found' : 'not found')

    const okN = sub.filter(s => s.ok).length
    const score = okN / sub.length
    return result(meta.id, meta, score === 1 ? 'pass' : score >= 0.6 ? 'warn' : 'fail', score,
      { ok: okN, total: sub.length },
      sub.map(s => `${s.ok ? '✔' : '✘'} ${s.label} — ${s.detail}`),
      '语义卡=Agent 的物理语义地基（论文 §III-D），缺失即治理失效')
  },
}]
