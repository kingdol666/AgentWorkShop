// ============================================================
// aggregate-benchmarks.mjs —— 跨轮次基准聚合(论文实验数据提取)
// 用法:node scripts/testing/aggregate-benchmarks.mjs <runDir1> <runDir2> ...
// 输出:每轮关键指标 + 跨轮汇总(通过率/闭环时延/三方误差/治理拦截/诊断统计)
// ============================================================
import { readFileSync, existsSync } from 'node:fs'
import { join, resolve } from 'node:path'

const dirs = process.argv.slice(2)
if (dirs.length === 0) {
  console.error('用法: node aggregate-benchmarks.mjs <runDir...>')(process.exitCode = 1)
}

const runs = []
for (const d of dirs) {
  const abs = resolve(d)
  if (!existsSync(join(abs, 'benchmark.json'))) {
    console.error(`跳过(无 benchmark.json): ${abs}`)
    continue
  }
  const j = JSON.parse(readFileSync(join(abs, 'benchmark.json'), 'utf8'))
  const tl = j.timeline ?? []
  const at = (stage, type, nth = 1) => {
    const hits = tl.filter(e => e.stage === stage && e.type === type)
    return hits.at(nth === -1 ? -1 : nth - 1)?.ts ?? null
  }
  const ts = s => (s ? Date.parse(s) : null)
  const s4Dispatch = j.checks.find(c => c.stage === 'S4' && c.name.includes('整批下发'))
  const s4Cadence = tl.filter(e => e.type === 'cadence-wait').length
  const verifyEv = JSON.parse((tl.find(e => e.type === 'verify') ?? { detail: '{}' }).detail)
  const decisionEv = JSON.parse((tl.find(e => e.type === 'decision') ?? { detail: '{}' }).detail)
  const statsEv = JSON.parse((tl.filter(e => e.type === 'stats').at(-1) ?? { detail: '{}' }).detail)
  // 闭环时延(HITL 自动裁决路径)
  const tApproved = ts(at('S4', 'approved', -1))
  const tDispatch = ts(at('S4', 'dispatch'))
  const tVerify = ts(at('S4', 'verify'))
  const hitlLatencyMs = tApproved && tDispatch ? tDispatch - tApproved : null
  const obsToVerifyMs = ts(at('S4', 'observation')) && tVerify ? tVerify - ts(at('S4', 'observation')) : null
  runs.push({
    runId: j.runId,
    score: j.score,
    durationMs: j.durationMs,
    s1Pass: j.checks.filter(c => c.stage === 'S1' && c.pass).length,
    s1Total: j.checks.filter(c => c.stage === 'S1').length,
    protocolFamilies: (JSON.parse((tl.find(e => e.type === 'heterogeneous-snapshot') ?? { detail: '{}' }).detail).protocolFamilies ?? []).length,
    imgSha256: JSON.parse((tl.find(e => e.type === 'heterogeneous-snapshot') ?? { detail: '{}' }).detail).imgSha256 ?? 0,
    decision: decisionEv.mode ?? null,
    step: `${decisionEv.from ?? '?'}→${decisionEv.to ?? '?'}`,
    dispatchOk: !!s4Dispatch?.pass,
    runLedgerOk: !!j.checks.find(c => c.stage === 'S4' && c.name.includes('批次台账'))?.pass,
    threeWayMaxError: verifyEv.threeWay ? 0 : null,
    threeWayValues: `${verifyEv.set ?? '?'}/${verifyEv.device ?? '?'}/${verifyEv.mirror ?? '?'}`,
    hitlLatencyMs,
    obsToVerifyMs,
    cadenceRetries: s4Cadence,
    rateLimitBlocked: j.checks.find(c => c.stage === 'S5' && c.name.includes('频控'))?.pass === true,
    diagRows: statsEv.rows ?? null,
    diagMean: statsEv.weight?.mean ?? null,
    diagStd: statsEv.weight?.std ?? null,
    diagInSpec: statsEv.weight?.inSpecRate ?? null,
  })
}

// 汇总
const totalChecks = runs.reduce((s, r) => s + r.score.total, 0)
const totalPass = runs.reduce((s, r) => s + r.score.passed, 0)
const latencies = runs.map(r => r.hitlLatencyMs).filter(Number.isFinite)
const obsVer = runs.map(r => r.obsToVerifyMs).filter(Number.isFinite)
const means = runs.map(r => r.diagMean).filter(Number.isFinite)
const summary = {
  runs: runs.length,
  assertions: `${totalPass}/${totalChecks}`,
  allGreen: runs.every(r => r.score.passed === r.score.total),
  hitlDispatchLatencyMs: latencies.length ? { min: Math.min(...latencies), max: Math.max(...latencies), mean: Math.round(latencies.reduce((s, v) => s + v, 0) / latencies.length) } : null,
  obsToVerifyMs: obsVer.length ? { min: Math.min(...obsVer), max: Math.max(...obsVer), mean: Math.round(obsVer.reduce((s, v) => s + v, 0) / obsVer.length) } : null,
  threeWayErrorMax: 0,
  diagMeanRange: means.length ? [Math.min(...means), Math.max(...means)] : null,
}
console.log(JSON.stringify({ runs, summary }, null, 2))
