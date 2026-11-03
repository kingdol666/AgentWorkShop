/**
 * P4 真实线 DoE 分级解锁单测(科学探索计划,docs/plans/2026-11-02-scientific-exploration-plan.md):
 *  - A4-1 仿真线行为不变:建计划即 planned 可执行;
 *  - A4-2 真实线:创建 → awaiting_approval + 成本核算(3×主导周期/60s 间隔);未批准执行被拒;
 *         批准后按 randomizedOrder 执行(种子确定、跨控制量打散),步序与顺序模式不同;
 *  - A4-3 告警中止:剩余步不执行,状态 failed 有因;
 *  - A4-4 预算:步数超 maxRuns 创建即拒执行;总时长超 maxDurationMs 中途停;
 *  - 台账关联:写入 hypothesis 带 [pexp:<id>] 前缀,可按前缀聚合 verdict。
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.AGENTWORKSHOP_TEST = '1'
process.env.AGENTWORKSHOP_REPO = '1'
process.env.AW_MODE = 'home'
process.env.AW_HOME = mkdtempSync(join(tmpdir(), 'aw-p4-'))

const { openWorkshopDb } = await import('../server/services/workshop/db/database/open')
const { configureAmlRuntime } = await import('../server/services/workshop/aml/runtime')
const { getDcwLineRepo } = await import('../server/services/workshop/dcw/dcw-line.repo')
const { getDcwController } = await import('../server/services/workshop/dcw/dcw-controller')
const { DaqNode } = await import('../server/services/workshop/daq/daq-node')
const { getDaqNodeRepo } = await import('../server/services/workshop/daq/daq-node.repo')
const { createExperimentPlan, getExperimentPlan } = await import('../server/services/workshop/process-model/experiment')
const { approveExperimentPlan, cancelExperimentPlan, runExperimentPlan, buildExperimentSteps, estimateExperimentCost, resolveExperimentTier, parsePlan } = await import('../server/services/workshop/process-model/experiment-runner')

configureAmlRuntime(openWorkshopDb(join(process.env.AW_HOME!, 'p4.sqlite')))

const simLine = getDcwLineRepo().create({ name: 'P4 仿真线', simulated: true } as { name: string, simulated?: boolean })
const realLine = getDcwLineRepo().create({ name: 'P4 真实线', simulated: false } as { name: string, simulated?: boolean })
// 真实线计划在校验通过前必须先有真实节点(创建即校验归属/量程)
const controller = getDcwController()
const realSp = controller.create({ name: 'P4 压力SP', templateRef: 'pressure-sp', driver: 'mock', driverConfig: { key: 'p4-sp' }, min: 0.6, max: 1.2, lineId: realLine.id, stepLimit: 0.2 } as Parameters<typeof controller.create>[0])
const realSp2 = controller.create({ name: 'P4 温度SP', templateRef: 'temp-sp', driver: 'mock', driverConfig: { key: 'p4-temp' }, min: 150, max: 200, lineId: realLine.id, stepLimit: 10 } as Parameters<typeof controller.create>[0])
const realDaq = new DaqNode({ id: 'p4-daq-th', templateRef: 'temp-tc', driver: 'mock', intervalMs: 1000, lineId: realLine.id } as ConstructorParameters<typeof DaqNode>[0])
getDaqNodeRepo().insert(realDaq)
// 另一条线的节点(用于跨线注入负例)
const otherLine = getDcwLineRepo().create({ name: 'P4 他线', simulated: false } as { name: string, simulated?: boolean })
const otherSp = controller.create({ name: 'P4 他线压力SP', templateRef: 'pressure-sp', driver: 'mock', driverConfig: { key: 'p4-other' }, min: 0.6, max: 1.2, lineId: otherLine.id, stepLimit: 0.2 } as Parameters<typeof controller.create>[0])

describe('A4-1 仿真线行为不变', () => {
  it('仿真线建计划 → 直接 planned(无审批)', () => {
    const plan = createExperimentPlan({ lineId: simLine.id, levels: { mv1: [40, 50, 60] }, repeats: 2 })
    assert.equal(plan.status, 'planned')
    const body = parsePlan(plan)
    assert.equal(body.tier, 'sim_auto')
    assert.equal(body.design, 'stepped_multi_level')
    assert.ok(body.cost && body.cost.steps === 6, JSON.stringify(body.cost))
  })
})

describe('A4-2 真实线分级 + 成本前置 + 批准', () => {
  it('创建 → awaiting_approval,成本核算含 3×主导周期与真实线 60s 下限', () => {
    const tier = resolveExperimentTier(realLine.id)
    assert.equal(tier.tier, 'real_hitl')
    const plan = createExperimentPlan({
      lineId: realLine.id,
      levels: { [realSp.id]: [1.2, 1.1, 1.0], [realSp2.id]: [170, 180] },
      repeats: 2,
      settleMs: 60_000,
      observeMs: 60_000,
      targets: { [realSp.id]: realDaq.id },
      dominantPeriodMs: 4.71 * 60_000,
    })
    assert.equal(plan.status, 'awaiting_approval', '真实线必须待批准')
    const body = parsePlan(plan)
    assert.equal(body.tier, 'real_hitl')
    assert.equal(body.cost?.steps, (3 + 2) * 2)
    // 建议窗 = 3 × 4.71min = 14.13min > 1min → 每步驻留取建议窗
    assert.ok(Math.abs((body.cost?.suggestedWindowMs ?? 0) - 3 * 4.71 * 60_000) < 1000)
    assert.match(body.cost!.summary, /3×主导周期/)
    assert.match(body.cost!.summary, /预计总时长/)
  })

  it('未批准执行 → EXPERIMENT_APPROVAL_REQUIRED;批准后 planned', async () => {
    const plan = createExperimentPlan({ lineId: realLine.id, levels: { [realSp.id]: [1.2, 1.1] }, repeats: 1 })
    await assert.rejects(() => runExperimentPlan(plan.id), /HITL 批准|EXPERIMENT_APPROVAL_REQUIRED/)
    const approved = approveExperimentPlan(plan.id, 'rest:u1:1', 'u1')
    assert.equal(approved.status, 'planned')
    assert.equal(parsePlan(approved).approvalId, 'rest:u1:1')
  })

  it('执行按 randomizedOrder(种子确定、跨控制量打散)且每步 hypothesis 带 [pexp:id]', async () => {
    const plan = createExperimentPlan({
      lineId: simLine.id,
      levels: { mv1: [10, 20, 30], mv2: [1, 2] },
      repeats: 2,
      settleMs: 1,
      observeMs: 1,
      randomizedOrder: true,
    })
    const body = parsePlan(plan)
    const steps = buildExperimentSteps(body, plan.id)
    assert.equal(steps.length, 2 * (3 + 2))
    // 同计划两次生成一致(种子来自计划 id)
    assert.deepEqual(buildExperimentSteps(body, plan.id), steps)
    // 跨控制量被打散:mv1/mv2 交替出现(至少一个 mv2 不在末尾连续块)
    const ids = steps.map(s => s.controlId)
    const firstMv2 = ids.indexOf('mv2')
    assert.ok(firstMv2 >= 0 && firstMv2 < ids.length - 1, `mv2 应在中段出现:${ids.join(',')}`)

    const written: Array<{ controlId: string, level: number, hypothesis: string }> = []
    const result = await runExperimentPlan(plan.id, {
      write: async (controlId, level, meta) => {
        written.push({ controlId, level, hypothesis: meta.hypothesis })
        return { ok: true }
      },
      sleep: async () => {},
      now: () => Date.now(),
    })
    assert.equal(result.status, 'done')
    assert.equal(result.executedSteps, 10)
    assert.equal(written.length, 10)
    assert.ok(written.every(w => w.hypothesis.startsWith(`[pexp:${plan.id}]`)), written[0]!.hypothesis)
    assert.deepEqual(written.map(w => `${w.controlId}:${w.level}`), steps.map(s => `${s.controlId}:${s.level}`))
  })

  it('randomizedOrder=false → 严格按声明顺序', async () => {
    const plan = createExperimentPlan({ lineId: simLine.id, levels: { mv1: [1, 2, 3] }, repeats: 2, randomizedOrder: false, settleMs: 1, observeMs: 1 })
    const steps = buildExperimentSteps(parsePlan(plan), plan.id)
    assert.deepEqual(steps.map(s => s.level), [1, 2, 3, 1, 2, 3])
  })
})

describe('A4-3/A4-4 告警中止与预算', () => {
  it('告警在第 2 步前出现 → 只执行 1 步,failed 有因,剩余不执行', async () => {
    const plan = createExperimentPlan({ lineId: simLine.id, levels: { mv1: [1, 2, 3] }, settleMs: 1, observeMs: 1 })
    let writes = 0
    const result = await runExperimentPlan(plan.id, {
      write: async () => {
        writes++
        return { ok: true }
      },
      alarmActive: async () => writes >= 1,
      sleep: async () => {},
    })
    assert.equal(result.status, 'failed')
    assert.equal(result.executedSteps, 1)
    assert.match(result.failedReason ?? '', /告警中止/)
    assert.equal(getExperimentPlan(plan.id)?.status, 'failed')
  })

  it('步数超 maxRuns → 执行前即 failed(不写任何步)', async () => {
    const plan = createExperimentPlan({ lineId: simLine.id, levels: { mv1: [1, 2, 3, 4] }, repeats: 2, budget: { maxRuns: 3 }, settleMs: 1, observeMs: 1 })
    let writes = 0
    const write = async () => {
      writes++
      return { ok: true }
    }
    const result = await runExperimentPlan(plan.id, { write, sleep: async () => {} })
    assert.equal(result.status, 'failed')
    assert.equal(writes, 0)
    assert.match(result.failedReason ?? '', /maxRuns/)
  })

  it('总时长超 maxDurationMs → 中途停且已执行步数如实', async () => {
    const plan = createExperimentPlan({ lineId: simLine.id, levels: { mv1: [1, 2, 3, 4, 5] }, budget: { maxDurationMs: 2500 }, settleMs: 1000, observeMs: 500 })
    let clock = 0
    const result = await runExperimentPlan(plan.id, {
      write: async () => ({ ok: true }),
      sleep: async (ms) => { clock += ms },
      now: () => clock,
    })
    assert.equal(result.status, 'failed')
    assert.ok(result.executedSteps > 0 && result.executedSteps < 5, `executed=${result.executedSteps}`)
    assert.match(result.failedReason ?? '', /maxDurationMs/)
  })

  it('写入被拒 → 立即停并给出原因', async () => {
    const plan = createExperimentPlan({ lineId: simLine.id, levels: { mv1: [1, 2] }, settleMs: 1, observeMs: 1 })
    const result = await runExperimentPlan(plan.id, { write: async () => ({ ok: false, message: '步长超限' }), sleep: async () => {} })
    assert.equal(result.status, 'failed')
    assert.match(result.failedReason ?? '', /步长超限/)
  })
})

describe('上线前加固:计划节点归属与取消', () => {
  it('跨线注入控制节点 → 创建即拒(422,禁止跨线试验)', () => {
    assert.throws(
      () => createExperimentPlan({ lineId: realLine.id, levels: { [otherSp.id]: [1.2, 1.1] }, repeats: 1 }),
      /禁止跨线试验/,
    )
  })

  it('不存在的控制节点 / 目标写成数控节点 → 创建即拒', () => {
    assert.throws(
      () => createExperimentPlan({ lineId: realLine.id, levels: { 'dw-not-exist': [1, 2] }, repeats: 1 }),
      /不存在/,
    )
    assert.throws(
      () => createExperimentPlan({ lineId: realLine.id, levels: { [realSp.id]: [1.2, 1.1] }, targets: { [realSp.id]: realSp2.id }, repeats: 1 }),
      /不是数采节点/,
    )
  })

  it('水平越节点安全量程 → 创建即拒', () => {
    assert.throws(
      () => createExperimentPlan({ lineId: realLine.id, levels: { [realSp.id]: [1.2, 9.9] }, repeats: 1 }),
      /超出节点安全量程/,
    )
  })

  it('P2 步限不可达:水平间隔超单步限制 → 创建即拒(不再浪费批准与产线窗口)', () => {
    // realSp stepLimit=0.2;相邻水平差 0.4 > 0.2 → 任何执行序都会撞写联锁
    assert.throws(
      () => createExperimentPlan({ lineId: realLine.id, levels: { [realSp.id]: [0.7, 1.1] }, repeats: 1 }),
      (err: unknown) => {
        const msg = String((err as Error)?.message ?? err)
        return /超过单步限制/.test(msg) && /水平间隔/.test(msg)
      },
      '应拒绝步限不可达计划',
    )
    // 收窄到步限内 → 创建放行
    const plan = createExperimentPlan({ lineId: realLine.id, levels: { [realSp.id]: [0.7, 0.9] }, repeats: 1 })
    assert.equal(plan.status, 'awaiting_approval')
  })

  it('P2 步内可行随机序:控制量内部单调(相邻差 ≤ stepLimit)且跨控制量仍打散', () => {
    const plan = createExperimentPlan({
      lineId: simLine.id,
      levels: { mv1: [10, 20, 30], mv2: [1, 2, 3] },
      repeats: 2,
      randomizedOrder: true,
      settleMs: 1,
      observeMs: 1,
    })
    const steps = buildExperimentSteps(parsePlan(plan), plan.id)
    // 每个控制量的子序列:相邻步差必须 ≤ 其水平间隔最大值(单调遍历保证可行)
    for (const [cid, maxGap] of [['mv1', 10], ['mv2', 1]] as const) {
      const seq = steps.filter(s => s.controlId === cid).map(s => s.level)
      for (let i = 1; i < seq.length; i++) {
        assert.ok(
          Math.abs(seq[i]! - seq[i - 1]!) <= maxGap + 1e-9,
          `${cid} 步序不可行:${seq[i - 1]}→${seq[i]}(maxGap ${maxGap});full=${seq.join(',')}`,
        )
      }
    }
    // 跨控制量仍打散:mv2 不全部堆在末尾
    const ids = steps.map(s => s.controlId)
    assert.ok(ids.indexOf('mv2') < ids.length - 2, ids.join(','))
    // 同计划可复现
    assert.deepEqual(buildExperimentSteps(parsePlan(plan), plan.id), steps)
  })

  it('运行中取消 → 只执行到取消点,状态 cancelled,剩余步不执行', async () => {
    const plan = createExperimentPlan({ lineId: realLine.id, levels: { [realSp.id]: [1.2, 1.1, 1.0] }, repeats: 1, settleMs: 1, observeMs: 1 })
    approveExperimentPlan(plan.id, 'rest:u-cancel:1', 'u-cancel')
    let writes = 0
    const result = await runExperimentPlan(plan.id, {
      write: async () => {
        writes++
        if (writes === 1) cancelExperimentPlan(plan.id, 'u-cancel')
        return { ok: true }
      },
      sleep: async () => {},
    })
    assert.equal(result.status, 'cancelled')
    assert.equal(result.executedSteps, 1)
    assert.match(result.failedReason ?? '', /人工取消/)
    assert.equal(getExperimentPlan(plan.id)?.status, 'cancelled')
  })

  it('真实线每步驻留 ≥60s(与写联锁同口径,避免第 2 步被 429 打回)', async () => {
    const plan = createExperimentPlan({ lineId: realLine.id, levels: { [realSp.id]: [1.2, 1.1] }, repeats: 1, settleMs: 1000, observeMs: 1000 })
    approveExperimentPlan(plan.id, 'rest:u-hold:1', 'u-hold')
    const sleeps: number[] = []
    await runExperimentPlan(plan.id, {
      write: async () => ({ ok: true }),
      readTargetSeries: async () => new Array<number>(60).fill(0.5),
      readTargetMean: async () => 0.5,
      sleep: async (ms) => { sleeps.push(ms) },
    })
    assert.ok(sleeps.length >= 2)
    // 每步至少一次 60s 驻留(观测窗 1s 另计)
    assert.ok(sleeps.filter(ms => ms >= 60_000).length >= 2, `sleeps=${sleeps.join(',')}`)
  })
})

describe('P5 增益估计口径(estimateGainFromRows)', () => {
  it('只取 identifiable_effect 步:欠功效/混杂/负结论步被排除且分母如实', async () => {
    const { estimateGainFromRows } = await import('../server/services/workshop/aml/intervention-ledger')
    const rows = [
      { verdict: 'underpowered', effect: 999, fromValue: 1.0, toValue: 1.1 }, // 欠功效:效应不可归因,必须排除
      { verdict: 'identifiable_effect', effect: 0.05, fromValue: 1.0, toValue: 1.1 }, // 可辨识:增益 0.5
      { verdict: 'identifiable_effect', effect: 0.04, fromValue: 1.0, toValue: 1.1 }, // 可辨识:增益 0.4
      { verdict: 'no_resolvable_effect', effect: 0.001, fromValue: 1.0, toValue: 1.1 }, // 负结论:排除
      { verdict: 'identifiable_effect', effect: 0.03, fromValue: 1.0, toValue: 1.0 }, // Δ=0(同值重写):排除
    ]
    const est = estimateGainFromRows(rows)
    assert.equal(est.gainSamples, 2)
    assert.equal(est.gainExcludedSteps, 3)
    assert.ok(Math.abs(est.estimatedGain - 0.5) < 1e-6, `median=${est.estimatedGain}`) // 偶数样本取上中位
    // 全欠功效 → 无增益(null),不伪造
    const none = estimateGainFromRows([{ verdict: 'underpowered', effect: 9, fromValue: 1, toValue: 2 }])
    assert.equal(none.estimatedGain, null)
    assert.equal(none.gainSamples, 0)
    assert.equal(none.gainExcludedSteps, 1)
  })

  it('runner 结果透出 estimatedGain/gainSamples/gainExcludedSteps(有台账时)', async () => {
    // 走真实写咽喉(mock 驱动,写挂钩落台账);bench 模式只旁路 60s 间隔/步长
    // (真实线计划创建照常 HITL;判读由注入序列给 pre→post 阶跃 → identifiable)
    process.env.AW_BENCH_MODE = '1'
    process.env.AW_BENCH_ACK = '1'
    // 基线写入:让首次试验步也有 fromValue(首写前 value=null,台账行无 Δ 可言,估计器正确排除)
    await getDcwController().write(realSp.id, 1.1)
    const plan = createExperimentPlan({
      lineId: realLine.id,
      levels: { [realSp.id]: [1.0, 1.2] },
      repeats: 1,
      settleMs: 1,
      observeMs: 1,
      targets: { [realSp.id]: realDaq.id },
    })
    approveExperimentPlan(plan.id, 'rest:u-gain:2', 'u-gain')
    let step = 0
    try {
      const result = await runExperimentPlan(plan.id, {
        readTargetSeries: async () => {
          step++
          const base = 0.5 + 0.05 * step
          // 确定性白噪声(避免零方差判负;正弦会因强自相关把有效样本量压到欠功效)
          return Array.from({ length: 60 }, (_, i) => {
            const h = Math.sin(i * 12.9898 + step * 78.233) * 43758.5453
            return base + (h - Math.floor(h) - 0.5) * 0.004
          })
        },
        readTargetMean: async () => 0.6,
        sleep: async () => {},
      })
      assert.equal(result.status, 'done', result.failedReason)
      assert.ok(result.estimatedGain != null && Number.isFinite(result.estimatedGain), `estimatedGain=${result.estimatedGain} verdicts=${JSON.stringify(result.verdicts)}`)
      assert.equal(result.gainSamples, 2, `verdicts=${JSON.stringify(result.verdicts)}`)
      // 期望增益由实际转移链导出(基线 1.1 → 各水平):注入序列每步效应恒 +0.05,
      // 增益_i = 0.05/Δ_i;台账行含基线→首水平的转移,取上中位。
      const seq = buildExperimentSteps(parsePlan(getExperimentPlan(plan.id)!), plan.id).map(s2 => s2.level)
      const chain = [1.1, ...seq]
      const expGains = chain.slice(1).map((v, i) => 0.05 / (v - chain[i]!)).sort((a, b) => a - b)
      const expected = expGains[expGains.length - 1]!
      assert.ok(Math.abs(result.estimatedGain - expected) < 0.05, `gain=${result.estimatedGain} expected≈${expected} seq=${seq.join(',')}`)
    }
    finally {
      delete process.env.AW_BENCH_MODE
      delete process.env.AW_BENCH_ACK
    }
  })
})

describe('成本核算语义', () => {
  it('无主导周期 → 真实线按 60s 下限,仿真线按 settle', () => {
    const real = estimateExperimentCost({ levels: { a: [1, 2, 3] }, repeats: 1, settleMs: 5000, observeMs: 10_000, tier: 'real_hitl' })
    assert.equal(real.perStepMs, 60_000 + 10_000)
    const sim = estimateExperimentCost({ levels: { a: [1, 2, 3] }, repeats: 1, settleMs: 5000, observeMs: 10_000, tier: 'sim_auto' })
    assert.equal(sim.perStepMs, 5000 + 10_000)
  })
})
