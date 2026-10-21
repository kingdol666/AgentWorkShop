/**
 * api-3-interlock-f5 —— F5 越界写攻击套件（E1 的动态核）：
 * 对激活配方窗的产线发起 seed 化越界写攻击 + 合法写对照：
 *   拦截率 intercept_rate = 被拒越界写 / 越界写总数      （目标 100%）
 *   误拦率 false_block_rate = 被拒合法写 / 合法写总数    （目标 0%）
 * 对应论文不变式 I1 与 §VII-B 主表，是"治理是否真实起作用"的直接证据。
 */
import { result } from '../util.mjs'
import { sleep } from '../util.mjs'

const meta = { id: 'api-3-interlock-f5', title: 'F5 越界写攻击（联锁拦截率）', tier: 'api', dims: ['D2'], weight: 3, requires: ['server'] }

export default [{
  meta,
  async run(ctx) {
    const f = ctx.fixture
    if (!f.dw?.length || !f.window) return result(meta.id, meta, 'skip', 0, {}, [], '夹具未就绪')
    const rng = ctx.rng
    const [lo, hi] = [f.window.min, f.window.max] // 配方窗 175–205；全局量程 120–260

    // 越界攻击（6 类 × seeded 抖动）：全局量程下/上、窗上/窗外高、窗外低、极端值
    const attacks = [
      { kind: 'below-global', v: 120 - 1 - Math.floor(rng() * 20) },
      { kind: 'above-global', v: 260 + 1 + Math.floor(rng() * 20) },
      { kind: 'above-window', v: hi + 2 + Math.floor(rng() * 15) },
      { kind: 'below-window', v: lo - 2 - Math.floor(rng() * 15) },
      { kind: 'extreme', v: 1e6 },
      { kind: 'negative', v: -Math.floor(10 + rng() * 90) },
    ]
    const legit = [
      { kind: 'in-window-low', v: lo + 5 },
      { kind: 'in-window-mid', v: Math.round((lo + hi) / 2) },
      { kind: 'in-window-high', v: hi - Math.floor(3 + rng() * 5) },
    ]

    let intercepted = 0
    const attackLog = []
    for (const a of attacks) {
      const r = await ctx.api.call('POST', `/api/workshop/dcw/${f.dw[0]}/write`, { value: a.v })
      const rejected = r.status >= 400
      if (rejected) intercepted++
      attackLog.push(`${rejected ? '拦截' : '!!穿透'} ${a.kind}(v=${a.v}) → HTTP ${r.status} ${r.code ?? ''} ${String(r.message).slice(0, 60)}`)
      await sleep(150)
    }

    let legitOk = 0, legitBlocked = 0
    const legitLog = []
    for (const l of legit) {
      const r = await ctx.api.call('POST', `/api/workshop/dcw/${f.dw[0]}/write`, { value: l.v })
      if (r.status === 200) legitOk++
      else legitBlocked++
      legitLog.push(`${r.status === 200 ? '成功' : '误拦'} ${l.kind}(v=${l.v}) → HTTP ${r.status} ${String(r.message).slice(0, 60)}`)
      await sleep(250)
    }

    // 边界值探针（审稿人 M3：决策边界覆盖）——窗沿 ±1 最小刻度
    const boundary = [
      { kind: 'edge-max-accept', v: f.window.max, expect: 'accept' },
      { kind: 'above-edge-reject', v: f.window.max + 0.1, expect: 'reject' },
      { kind: 'below-edge-reject', v: f.window.min - 0.1, expect: 'reject' },
    ]
    let boundaryOk = 0
    for (const b of boundary) {
      const r = await ctx.api.call('POST', `/api/workshop/dcw/${f.dw[0]}/write`, { value: b.v })
      const got = r.status === 200 ? 'accept' : 'reject'
      if (got === b.expect) boundaryOk++
      legitLog.push(`${got === b.expect ? '符合' : '!!不符'} 边界 ${b.kind}(v=${b.v}) 期望${b.expect} → HTTP ${r.status}`)
      await sleep(250)
    }

    // Eq.(1) 分支覆盖：无活动批次时全局量程接管（软联锁仅在批次期间替换）
    const stop = await ctx.api.call('POST', `/api/workshop/dcw/lines/${f.lineId}/stop`, {})
    await sleep(400)
    const gAttack = await ctx.api.call('POST', `/api/workshop/dcw/${f.dw[0]}/write`, { value: 300 })
    const gLegal = await ctx.api.call('POST', `/api/workshop/dcw/${f.dw[0]}/write`, { value: 130 })
    const branchOk = gAttack.status >= 400 && gLegal.status === 200
    legitLog.push(`${gAttack.status >= 400 ? '符合' : '!!不符'} 无批次分支: 越全局 300 → HTTP ${gAttack.status}（应拒）`)
    legitLog.push(`${gLegal.status === 200 ? '符合' : '!!不符'} 无批次分支: 窗外全局内 130 → HTTP ${gLegal.status}（应受理,全局量程接管）`)
    await ctx.api.call('POST', `/api/workshop/dcw/lines/${f.lineId}/start`, { recipeId: f.recipeId })
    await sleep(400)

    const interceptRate = intercepted / attacks.length
    const falseBlock = legitBlocked / legit.length
    const score = interceptRate * 0.55 + (1 - falseBlock) * 0.2 + (boundaryOk / boundary.length) * 0.15 + (branchOk ? 0.1 : 0)
    const allOk = interceptRate === 1 && falseBlock === 0 && boundaryOk === boundary.length && branchOk
    return result(meta.id, meta, allOk ? 'pass' : interceptRate >= 0.9 ? 'warn' : 'fail', score,
      {
        intercept_rate: Number(interceptRate.toFixed(4)),
        false_block_rate: Number(falseBlock.toFixed(4)),
        attacks: attacks.length, intercepted, legit: legit.length, legit_ok: legitOk,
        boundary_cases: boundary.length, boundary_ok: boundaryOk,
        eq1_branch_coverage: branchOk ? 'pass' : 'fail',
      },
      [...attackLog, ...legitLog],
      allOk ? 'I1 动态成立 + 决策边界覆盖 + Eq.(1) 双分支覆盖' : '存在穿透/边界/分支失败——治理失效，必须修复')
  },
}]
