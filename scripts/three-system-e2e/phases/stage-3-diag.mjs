/**
 * Stage 3:真实诊断(kickoff 常跑;--full 才轮询到完成)—— 原 L542–607
 * (由 scripts/three-system-e2e.mjs 按职责拆出;语句逐行原文搬运,仅跨模块引用/状态访问机械改写)
 *
 * 原阶段级 runId(toolInvoker/leadA/LINE 同理)已移入 state.mjs。
 */
import { BASE, FULL, invoke, ok, raw, resultText, sleep } from '../lib.mjs'
import { getLINE, getLeadA, getRunId, getToolInvoker, getUserToken, setRunId } from '../state.mjs'

export async function run() {
  console.log('\n── Stage 3 真实深度诊断(omp 引擎)──')
  let r = null
  for (const mins of [30, 180, 1440]) { // 采样间歇(共享实例节拍被并行调节)→ 逐步加宽窗口
    r = await invoke(getToolInvoker(), 'diag_run', {
      line: getLINE(),
      from_ms: Date.now() - mins * 60_000,
      to_ms: Date.now(),
      question: `${getLINE()} 近期数采数据深度根因诊断(three-system-e2e,窗口 ${mins} 分钟)`,
      scene: 'three_system_e2e',
    }, 120000)
    if (resultText(r).includes('runId=')) break
    console.log(`  … ${mins} 分钟窗无样本,加宽重试`)
    await sleep(2000)
  }
  const text = resultText(r)
  setRunId((text.match(/runId=([a-z0-9-]+)/i) ?? [])[1] ?? '')
  if (!getRunId()) {
    // 产线上已有在跑诊断(如事件自动触发)→ 收养它继续验证,而非报错
    const adopted = (text.match(/run_id=([a-z0-9-]+)/i) ?? [])[1] ?? ''
    if (adopted) {
      setRunId(adopted)
      console.log(`  · 产线已有在跑诊断,收养 run_id=${adopted} 继续验证`)
    }
  }
  ok(Boolean(getRunId()), 'diag_run 异步发起(或收养在跑诊断)拿到 runId', getRunId() || `resp=${JSON.stringify(r.json).slice(0, 260)}`)

  if (FULL && getRunId()) {
    let done = false
    let lastText = ''
    const maxIter = Math.round(Number(process.env.FULL_WAIT_MIN ?? 45) * 3) // 每 20s 一轮
    for (let i = 0; i < maxIter && !done; i++) {
      await sleep(20_000)
      const s = await invoke(getToolInvoker(), 'diag_status', { run_id: getRunId() }, 30000)
      lastText = resultText(s)
      if (/状态=completed/.test(lastText)) done = true
      else if (/状态=(failed|stopped)/.test(lastText)) break
      if (i % 6 === 5) console.log(`  … 轮询中(${(i + 1) * 20}s):${(lastText.match(/状态=\S+/) ?? [''])[0]}`)
    }
    ok(done, '真实诊断跑至 completed', (lastText.match(/评分=\S+|状态=\S+/g) ?? []).join(' '))
    if (done) {
      let stored = ''
      for (let i = 0; i < 6; i++) {
        await sleep(5000)
        const runs = await raw('GET', `${BASE}/api/plugins/diag-bridge/runs`, { token: getUserToken() })
        const mine = (runs.json?.runs ?? []).find(x => x.runId === getRunId())
        stored = JSON.stringify(mine ?? {})
        if (mine?.stored === true) break
      }
      ok(stored.includes('"stored":true'), '报告自动入库(diag-bridge → KB)')
      let kbHit = ''
      for (let i = 0; i < 8; i++) {
        await sleep(5000)
        const s = await invoke(getLeadA(), 'kb_search', { query: `${getLINE()} 深度根因诊断 three_system_e2e 结论` }, 60000)
        kbHit = resultText(s)
        if (!kbHit.startsWith('未检索到') && kbHit.length > 0) break
      }
      ok(!kbHit.startsWith('未检索到') && kbHit.length > 0, 'kb_search 检索到诊断报告/经验', kbHit.split('\n')[0]?.slice(0, 90))
    }
  }
  else {
    console.log('  ·(未加 --full:不等待诊断完成;完成后的入库由 diag-bridge 轮询器自动完成,可重跑 --full 或用 diag_status 观察)')
  }
}
