/**
 * api-5-daq-freshness —— 数采新鲜度与查询性能（D1/D8）：
 *   1) mock 采集运行中 → 时序库 samples 有近 30s 内的数据点（采集链路活性）
 *   2) samples API 时延 p50/p95（8 次调用）——查询面性能抽样
 * 注意：这是 API 侧抽样，不是论文 §VI 定义的 daq_e2e_latency（模拟器发帧→落库，
 * 那需要 D3 控制端口对账，属 E4 全量实验）。
 */
import { result } from '../util.mjs'
import { sleep } from '../util.mjs'

const meta = { id: 'api-5-daq-freshness', title: '数采新鲜度与查询时延', tier: 'api', dims: ['D1', 'D8'], weight: 1, requires: ['server'] }

export default [{
  meta,
  async run(ctx) {
    const f = ctx.fixture
    if (!f.dn) return result(meta.id, meta, 'skip', 0, {}, [], '夹具未就绪')
    await sleep(4000) // 攒样本（intervalMs=1000）

    const lat = []
    let points = []
    for (let i = 0; i < 20; i++) {
      const t0 = Date.now()
      const r = await ctx.api.call('GET', `/api/workshop/daq/${f.dn}/samples?limit=30&bucketMs=1000`)
      lat.push(Date.now() - t0)
      if (r.status === 200 && Array.isArray(r.data?.points) && r.data.points.length) points = r.data.points
      await sleep(250)
    }
    lat.sort((a, b) => a - b)
    const p50 = lat[Math.floor(lat.length / 2)] ?? 0
    const p95 = lat[Math.max(0, Math.ceil(lat.length * 0.95) - 1)] ?? 0

    const last = points[points.length - 1] ?? {}
    const rawTs = last.at ?? last.ts ?? last.t ?? last.time ?? 0
    const lastTs = typeof rawTs === 'number' ? rawTs : Date.parse(rawTs)
    const ageS = lastTs ? Math.max(0, (Date.now() - lastTs) / 1000) : -1
    const fresh = ageS >= 0 && ageS < 30
    const hasData = points.length > 0

    const score = (hasData ? 0.5 : 0) + (fresh ? 0.3 : 0) + (p95 < 1500 ? 0.2 : 0)
    return result(meta.id, meta, score >= 0.9 ? 'pass' : score >= 0.5 ? 'warn' : 'fail', score,
      {
        points: points.length, latest_age_s: Number(ageS.toFixed(1)),
        samples_api_p50_ms: p50, samples_api_p95_ms: p95,
      },
      [
        `${hasData ? '✔' : '✘'} 时序数据点 ${points.length} 个（最新距 now ${ageS.toFixed(1)}s）`,
        `samples API p50=${p50}ms p95=${p95}ms（${lat.length} 次抽样）`,
        '注：API 侧抽样，非 daq_e2e_latency（后者由 E4 对账实验给出）',
      ],
      '采集链路活性与查询面性能抽样')
  },
}]
