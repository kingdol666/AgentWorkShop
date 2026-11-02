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
const { createExperimentPlan, getExperimentPlan } = await import('../server/services/workshop/process-model/experiment')
const { approveExperimentPlan, runExperimentPlan, buildExperimentSteps, estimateExperimentCost, resolveExperimentTier, parsePlan } = await import('../server/services/workshop/process-model/experiment-runner')

configureAmlRuntime(openWorkshopDb(join(process.env.AW_HOME!, 'p4.sqlite')))

const simLine = getDcwLineRepo().create({ name: 'P4 仿真线', simulated: true } as Parameters<typeof getDcwLineRepo>['create'] extends never ? never : { name: string, simulated?: boolean })
const realLine = getDcwLineRepo().create({ name: 'P4 真实线', simulated: false } as { name: string, simulated?: boolean })

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
      levels: { 'dw-sp': [2.6, 2.5, 2.4] },
      repeats: 2,
      settleMs: 60_000,
      observeMs: 60_000,
      targets: { 'dw-sp': 'daq-thickness' },
      dominantPeriodMs: 4.71 * 60_000,
    })
    assert.equal(plan.status, 'awaiting_approval', '真实线必须待批准')
    const body = parsePlan(plan)
    assert.equal(body.tier, 'real_hitl')
    assert.equal(body.cost?.steps, 6)
    // 建议窗 = 3 × 4.71min = 14.13min > 1min → 每步驻留取建议窗
    assert.ok(Math.abs((body.cost?.suggestedWindowMs ?? 0) - 3 * 4.71 * 60_000) < 1000)
    assert.match(body.cost!.summary, /3×主导周期/)
    assert.match(body.cost!.summary, /预计总时长/)
  })

  it('未批准执行 → EXPERIMENT_APPROVAL_REQUIRED;批准后 planned', async () => {
    const plan = createExperimentPlan({ lineId: realLine.id, levels: { 'dw-sp': [2.6, 2.4] }, repeats: 1 })
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

describe('成本核算语义', () => {
  it('无主导周期 → 真实线按 60s 下限,仿真线按 settle', () => {
    const real = estimateExperimentCost({ levels: { a: [1, 2, 3] }, repeats: 1, settleMs: 5000, observeMs: 10_000, tier: 'real_hitl' })
    assert.equal(real.perStepMs, 60_000 + 10_000)
    const sim = estimateExperimentCost({ levels: { a: [1, 2, 3] }, repeats: 1, settleMs: 5000, observeMs: 10_000, tier: 'sim_auto' })
    assert.equal(sim.perStepMs, 5000 + 10_000)
  })
})
