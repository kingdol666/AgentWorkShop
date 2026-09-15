/**
 * api-4-attribution-readback —— 回读闭环与归因核查（不变式 I2 + D7）：
 *   1) 在窗写入 → 驱动回读 → |read − target| ≤ τ（死区公式，论文式(2)）
 *   2) 每笔写dcw journal 账本可追溯：actor/source/prevValue/newValue/recipeRunId
 * 归因率目标 100% —— "每一次物理写入都能回答谁在何时把什么改成什么"。
 */
import { result } from '../util.mjs'
import { writeTolerance, sleep } from '../util.mjs'

const meta = { id: 'api-4-attribution-readback', title: '回读闭环与写入归因', tier: 'api', dims: ['D2', 'D7'], weight: 3, requires: ['server'] }

export default [{
  meta,
  async run(ctx) {
    const f = ctx.fixture
    if (!f.dw?.length) return result(meta.id, meta, 'skip', 0, {}, [], '夹具未就绪')
    const node = f.dw[0]
    const tol = writeTolerance(120, 260, 1) // max(0.5·10^-1, 0.5%·140) = 0.7℃

    // 写前账本水位
    const before = await ctx.api.call('GET', `/api/workshop/dcw/journal?nodeId=${node}&limit=200`)
    const beforeN = before.data?.anchors?.length ?? 0

    const targets = [182, 191, 197]
    let written = 0, readbackOk = 0
    const log = []
    for (const v of targets) {
      const w = await ctx.api.call('POST', `/api/workshop/dcw/${node}/write`, { value: v })
      if (w.status !== 200) { log.push(`✘ 写入 v=${v} 失败 HTTP ${w.status} ${String(w.message).slice(0, 50)}`); continue }
      written++
      const out = w.data?.outcome ?? {}
      const rbVal = out.readback ?? out.value ?? out.rb
      await sleep(300)
      const rd = await ctx.api.call('POST', `/api/workshop/dcw/${node}/read`, {})
      const cur = rd.data?.read?.value ?? rd.data?.read?.current ?? rd.data?.value
      if (typeof cur === 'number' && Math.abs(cur - v) <= tol) readbackOk++
      log.push(`✔ 写 v=${v}${rbVal != null ? ` 回读(outcome)=${rbVal}` : ''} → read=${cur ?? 'n/a'} (τ=${tol})`)
      await sleep(250)
    }

    const after = await ctx.api.call('GET', `/api/workshop/dcw/journal?nodeId=${node}&limit=200`)
    const anchors = after.data?.anchors ?? []
    const newAnchors = anchors.slice(0, Math.max(0, anchors.length - beforeN))
    // 归因判据（审计员修正）：actor(谁) + source(来源) + at(何时) + 值证据(改什么) 四项齐全
    const fullFields = newAnchors.filter(a => a.actor != null && a.source != null && a.at != null && (a.prevValue != null || a.newValue != null))
    const attributionRate = written ? Math.min(1, fullFields.length / written) : 0

    const readbackRate = written ? readbackOk / written : 0
    const score = written ? readbackRate * 0.5 + attributionRate * 0.5 : 0
    return result(meta.id, meta, score === 1 ? 'pass' : score >= 0.7 ? 'warn' : 'fail', score,
      {
        writes: written, readback_ok: readbackOk, readback_rate: Number(readbackRate.toFixed(4)),
        new_anchors: newAnchors.length, attribution_rate: Number(attributionRate.toFixed(4)),
        tolerance: tol,
      },
      [...log, `账本新增锚点 ${newAnchors.length} 条（四项判据齐全 ${fullFields.length}）`],
      score === 1 ? '回读闭环与全链路归因成立（I2 + 可追溯性）' : '回读或归因存在缺口，见证据')
  },
}]
