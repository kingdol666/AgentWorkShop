/**
 * api-1-fixture —— 种子化基准夹具：产线→产品→数控模板→2 数控节点→配方→数采节点
 * →开采集→开批次（激活配方软联锁窗口）。全部走真实 REST，tag 隔离可重复。
 * teardown 压栈：run 结束后停线/停采（数据留存可追溯，不删库）。
 */
import { result } from '../util.mjs'
import { sleep } from '../util.mjs'

const meta = { id: 'api-1-fixture', title: '基准夹具（产线+配方窗+数采）', tier: 'api', dims: ['D1', 'D2'], weight: 2, requires: ['server'] }

export default [{
  meta,
  async run(ctx) {
    const api = ctx.api
    const sfx = `awb${ctx.seed.toString(36)}${ctx.rep ?? 0}${Date.now().toString(36).slice(-4)}`
    const f = ctx.fixture
    const steps = []
    const must = (label, cond, detail) => { steps.push({ label, ok: !!cond, detail: String(detail ?? '') }); return cond }

    const line = await api.call('POST', '/api/workshop/dcw/lines', { name: `Bench线 ${sfx}` })
    f.lineId = line.data?.line?.id
    must('产线', f.lineId, line.message || f.lineId)

    const product = await api.call('POST', '/api/workshop/dcw/products', { lineId: f.lineId, name: `Bench产品 ${sfx}` })
    f.productId = product.data?.product?.id
    must('产品', f.productId, product.message || f.productId)

    const tpl = await api.call('POST', '/api/workshop/dcw/templates', {
      key: `awb-tpl-${sfx}`, name: `Bench温度 ${sfx}`, ch: '温度', unit: '℃', min: 120, max: 260, decimals: 1,
    })
    f.tplKey = tpl.data?.template?.key
    must('数控模板', f.tplKey, tpl.message || f.tplKey)

    const mkDcw = async (name) => {
      const r = await api.call('POST', '/api/workshop/dcw', {
        name, templateRef: f.tplKey, driver: 'mock', unit: '℃', min: 120, max: 260, decimals: 1,
        lineId: f.lineId, holdIntervalMs: 0,
      })
      return r.data?.node?.id
    }
    f.dw = [await mkDcw(`Bench一段 ${sfx}`), await mkDcw(`Bench二段 ${sfx}`)].filter(Boolean)
    must('数控节点 ×2', f.dw.length === 2, f.dw.join('/'))

    // 配方窗：一段 [175,205]（软联锁窗口，测试用），二段 [190,225]
    f.window = { min: 175, max: 205 }
    const recipe = await api.call('POST', '/api/workshop/dcw/recipes', {
      productId: f.productId, name: `Bench工艺 ${sfx}`, description: 'benchmark fixture',
      params: [
        { nodeId: f.dw[0], value: 190, min: f.window.min, max: f.window.max },
        { nodeId: f.dw[1], value: 205, min: 190, max: 225 },
      ],
    })
    f.recipeId = recipe.data?.recipe?.id
    must('配方（软联锁窗）', f.recipeId, recipe.message || f.recipeId)

    const dn = await api.call('POST', '/api/workshop/daq', {
      driver: 'mock', lineId: f.lineId, intervalMs: 1000, publishIntervalMs: 0,
      name: `Bench测温 ${sfx}`, templateRef: 'daq-temp-tc',
    })
    f.dn = dn.data?.node?.id
    must('数采节点', f.dn, dn.message || f.dn)

    await api.call('POST', '/api/workshop/daq/gateway/start', {})
    if (f.dn) { await api.call('POST', `/api/workshop/daq/${f.dn}/enable`, {}); await api.call('POST', `/api/workshop/daq/${f.dn}/start`, {}) }
    must('采集已启动', Boolean(f.dn), 'gateway+node start')

    const run = await api.call('POST', `/api/workshop/dcw/lines/${f.lineId}/start`, { recipeId: f.recipeId })
    must('批次开跑（软联锁激活）', run.status === 200, run.message || 'line running')

    ctx.teardownStack.push(async () => {
      await api.call('POST', `/api/workshop/dcw/lines/${f.lineId}/stop`, {}).catch(() => {})
      if (f.dn) await api.call('POST', `/api/workshop/daq/${f.dn}/stop`, {}).catch(() => {})
    })

    await sleep(1200) // 让 mock 采样起稳
    const okN = steps.filter(s => s.ok).length
    const score = okN / steps.length
    return result(meta.id, meta, score === 1 ? 'pass' : 'fail', score,
      { created: okN, steps: steps.length, lineId: f.lineId, window: `${f.window.min}-${f.window.max}℃` },
      steps.map(s => `${s.ok ? '✔' : '✘'} ${s.label} — ${s.detail}`),
      score === 1 ? '夹具就绪，软联锁窗口已激活' : '夹具不完整，后续 API 检查的可信度受限')
  },
}]
