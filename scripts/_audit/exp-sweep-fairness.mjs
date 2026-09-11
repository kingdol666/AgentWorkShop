/**
 * 审计实验 6:SWEEP_MAX_CONCURRENCY=8 下 N=50 节点的公平性/吞吐模拟。
 * 逐行复刻 daq-controller.ts:464-482 的 sweep 循环语义:
 *   - 每 250ms 一拍;budget = 8 - inFlight;按 Map 插入序扫描;
 *   - 未到期(now < lastSampleAt + interval)continue;到期则启动并计入 budget;
 *   - started >= budget 立即 break(尾部节点本拍不再考虑);
 *   - lastSampleAt = 采样完成时刻(本模拟按瞬时完成,乐观假设)。
 * 运行:node scripts/_audit/exp-sweep-fairness.mjs
 */
const SWEEP_INTERVAL = 250
const BUDGET = 8

function simulate({ nodes, intervalMs, budget = BUDGET, seconds = 60, sampleCostMs = 0 }) {
  const lastSampleAt = new Array(nodes).fill(Number.NEGATIVE_INFINITY)
  const effectiveInterval = Math.max(1000, intervalMs) // minIntervalMs 缺省 1000
  const counts = new Array(nodes).fill(0)
  let inFlight = 0
  const inFlightUntil = []
  for (let t = 0; t <= seconds * 1000; t += SWEEP_INTERVAL) {
    // 采样完成(耗时 sampleCostMs)
    while (inFlightUntil.length && inFlightUntil[0].doneAt <= t) { const j = inFlightUntil.shift(); lastSampleAt[j.i] = j.doneAt; inFlight-- }
    if (inFlight > 0 && sampleCostMs === 0) { /* 瞬时完成:本拍全部回填 */ }
    let started = 0
    for (let i = 0; i < nodes; i++) {
      if (started >= budget - inFlight) break
      if (t < lastSampleAt[i] + effectiveInterval) continue
      started++
      counts[i]++
      if (sampleCostMs > 0) {
        inFlight++
        inFlightUntil.push({ i, doneAt: t + sampleCostMs })
      }
      else lastSampleAt[i] = t
    }
  }
  const demand = (seconds * 1000) / effectiveInterval * nodes
  const total = counts.reduce((a, b) => a + b, 0)
  return { counts, total, demand, min: Math.min(...counts), max: Math.max(...counts) }
}

for (const cfg of [
  { nodes: 8, intervalMs: 1000, seconds: 60 },
  { nodes: 50, intervalMs: 1000, seconds: 60 },
  { nodes: 50, intervalMs: 1000, seconds: 60, sampleCostMs: 100 },
  { nodes: 50, intervalMs: 1000, seconds: 60, sampleCostMs: 3000 }, // mqtt 驱动最坏:连不上 + 首帧等待 3s
]) {
  const r = simulate(cfg)
  const tail = r.counts.slice(-5).join(',')
  console.log(`nodes=${String(cfg.nodes).padStart(2)} interval=${cfg.intervalMs}ms cost=${cfg.sampleCostMs || 0}ms/拍250ms → 60s 内采样总数=${r.total}(需求 ${r.demand.toFixed(0)},达成 ${(r.total / r.demand * 100).toFixed(1)}%) 每节点 [min=${r.min} max=${r.max}] 末 5 节点=[${tail}]`)
}
