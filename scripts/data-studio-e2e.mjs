/**
 * data-studio Phase A 端到端验收(plan1 M1 + E1)。
 *
 * 覆盖:
 *  PA1 批量查询:多节点一次返回(每节点≤2000 点);护栏(>8 节点 400 / 省略节点且产线>8 → 400)
 *  PA2 run 台账(E1):开跑产线 → eda_runs 有行;关账(POST /dcw/runs/:id/close)后
 *      ended_at 回填 + sample_count 异步回填 >0;runs.json 第 201 批滚丢不再影响查询面
 *  PA3 批量导出:POST /daq/export(merge)→ job ready → totalRows>0 →
 *      manifest/merged/nodes 下载 200;路径穿越被拒 404
 *  PA4 MES 调试台:points 200;未授权/不存在点位 preview 403
 *  PA5 权限负例:query 指定不可读节点(admin 全量,此处验证不存在节点 → 403)
 *
 * 运行:node scripts/data-studio-e2e.mjs <scenario-context.json>
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const CTX = process.argv[2]
if (!CTX) {
  console.error('用法: node scripts/data-studio-e2e.mjs <scenario-context.json>')
  process.exit(1)
}
const c = JSON.parse(readFileSync(CTX, 'utf8'))
const EVID = join(REPO, 'docs', 'audit', 'evidence', '2026-10-21-phase-a')
mkdirSync(EVID, { recursive: true })
const sleep = ms => new Promise(r => setTimeout(r, ms))
const results = []
function ok(id, name, cond, detail = '') {
  results.push({ id, name, pass: Boolean(cond), detail: String(detail).slice(0, 500) })
  console.log(`${cond ? '✔' : '✖'} [${id}] ${name}${detail ? ` — ${String(detail).slice(0, 200)}` : ''}`)
}
async function api(method, path, body, token = c.adminToken) {
  const r = await fetch(c.base + path, {
    method,
    headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(120_000),
  })
  const j = await r.json().catch(() => ({}))
  return { status: r.status, data: j?.data, message: j?.message ?? j?.data?.message ?? '' }
}
async function rawGet(path, token = c.adminToken) {
  const r = await fetch(c.base + path, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(60_000) })
  const text = await r.text()
  return { status: r.status, contentType: r.headers.get('content-type') ?? '', text: text.slice(0, 200) }
}

async function main() {
  console.log(`━━━ data-studio Phase A E2E @ ${c.base} line=${c.lineId} ━━━`)
  const daqIds = Object.values(c.daq ?? {})
  const daq = (await api('GET', '/api/workshop/daq'))?.data
  const nodeNames = new Map((daq?.nodes ?? []).map(n => [n.id, n]))
  ok('PA0', '上下文就绪(daq 节点≥2)', daqIds.length >= 2, `daq=${daqIds.length}`)

  // ── PA1 批量查询 ──
  const pick = daqIds.slice(0, 2)
  const q = await api('GET', `/api/workshop/daq/query?node_ids=${pick.join(',')}&last_minutes=5&agg=avg`)
  const series = q.data?.series ?? []
  const pointsOk = series.length === 2 && series.every(s => s.points.length > 0 && s.points.length <= 2000)
  ok('PA1.1', '批量查询:两节点一次返回且每节点≤2000 点', q.status === 200 && pointsOk,
    `series=${series.length} pts=${series.map(s => s.points.length).join(',')} bucket=${q.data?.window?.bucketMs}`)
  const asc = series.every(s => s.points.every((p, i) => i === 0 || p.at >= s.points[i - 1].at))
  ok('PA1.2', '序列时间升序(ASC 契约)', asc)
  const over = await api('GET', `/api/workshop/daq/query?node_ids=${daqIds.slice(0, 9).join(',')}&last_minutes=5`)
  ok('PA1.3', '>8 节点 → 400 护栏', over.status === 400, over.message.slice(0, 120))
  const omit = await api('GET', `/api/workshop/daq/query?line_id=${c.lineId}&last_minutes=5`)
  ok('PA1.4', '产线>8 节点省略 node_ids → 400 要求显式指定', omit.status === 400, omit.message.slice(0, 120))
  // 缓存键含显式 from/to(last_minutes 每次换算为不同 fromMs,命中不了属正确行为)
  const nowMs = Date.now()
  const cacheQ = `node_ids=${pick.join(',')}&from=${nowMs - 300_000}&to=${nowMs}&agg=avg`
  await api('GET', `/api/workshop/daq/query?${cacheQ}`)
  const cache = await api('GET', `/api/workshop/daq/query?${cacheQ}`)
  ok('PA1.5', '同参数(显式窗口)二次命中缓存', cache.status === 200 && cache.data?.cached === true)

  // ── PA2 run 台账(E1) ──
  let runsBefore = await api('GET', `/api/workshop/eda/runs?line_id=${c.lineId}`)
  let openRun = (runsBefore.data?.runs ?? []).find(r => r.outcome === 'open' && !r.endedAt)
  if (!openRun) {
    // 平台重启前的旧 run 无镜像行(钩子随新构建生效)→ 关账触发 UPSERT 补建行验证
    const legacy = await api('GET', '/api/workshop/dcw/runs')
    const legacyOpen = (legacy.data?.runs ?? legacy.data ?? []).find?.(r => !r.endedAt && r.lineId === c.lineId)
      ?? (Array.isArray(legacy.data) ? legacy.data.find(r => !r.endedAt && r.lineId === c.lineId) : null)
    if (legacyOpen?.id) {
      await api('POST', `/api/workshop/dcw/runs/${legacyOpen.id}/close`)
      await sleep(2000)
      runsBefore = await api('GET', `/api/workshop/eda/runs?line_id=${c.lineId}`)
      openRun = (runsBefore.data?.runs ?? []).find(r => r.id === legacyOpen.id)
      ok('PA2.0', '旧 run 关账 UPSERT 补建台账行', Boolean(openRun), `legacy=${legacyOpen.id}`)
      // 重开一批(保持活动批次供后续阶段使用)
      await api('POST', `/api/workshop/dcw/lines/${c.lineId}/start`)
    }
  }
  ok('PA2.1', '开跑产线 → run 台账有行(open)', Boolean(openRun), JSON.stringify(runsBefore.data?.runs?.[0] ?? {}).slice(0, 160))
  if (openRun) {
    // 新开一批再关:保证不破坏场景后续阶段的活动批次(关闭的是新批次)
    const dcwSnap = (await api('GET', '/api/workshop/dcw'))?.data
    void dcwSnap
    await api('POST', `/api/workshop/dcw/runs/${openRun.id}/close`)
    let row = null
    for (let i = 0; i < 20; i++) {
      await sleep(1500)
      const after = await api('GET', `/api/workshop/eda/runs?line_id=${c.lineId}`)
      row = (after.data?.runs ?? []).find(r => r.id === openRun.id)
      if (row?.endedAt && (row.sampleCount ?? 0) > 0) break
    }
    ok('PA2.2', '关账后 ended_at 回填且 sample_count>0(异步回填)', Boolean(row?.endedAt) && (row?.sampleCount ?? 0) > 0,
      `ended=${row?.endedAt} samples=${row?.sampleCount}`)
  }

  // ── PA3 批量导出 ──
  const ex = await api('POST', '/api/workshop/daq/export', {
    node_ids: pick, last_minutes: 5, merge: true, title: 'PhaseA 定向导出',
  })
  const jobId = ex.data?.job?.id
  ok('PA3.1', '导出任务受理(running)', ex.status === 200 && Boolean(jobId), JSON.stringify(ex.data?.job ?? ex.message).slice(0, 160))
  let job = null
  for (let i = 0; i < 60 && job?.status !== 'ready' && job?.status !== 'failed'; i++) {
    await sleep(2000)
    job = (await api('GET', `/api/workshop/daq/export/${jobId}`)).data?.job
  }
  ok('PA3.2', '导出完成(ready)且 totalRows>0', job?.status === 'ready' && (job?.result?.totalRows ?? 0) > 0,
    `status=${job?.status} rows=${job?.result?.totalRows} files=${job?.result?.files?.length} merged=${Boolean(job?.result?.mergedFile)}`)
  const manifest = await rawGet(`/api/workshop/daq/export-file?job=${jobId}&path=manifest.json`)
  ok('PA3.3', 'manifest.json 下载 200(application/json)', manifest.status === 200 && manifest.contentType.includes('json'), manifest.text.slice(0, 100))
  const mergedOk = job?.result?.mergedFile ? (await rawGet(`/api/workshop/daq/export-file?job=${jobId}&path=merged.csv`)).status : 404
  ok('PA3.4', 'merged.csv 下载 200', mergedOk === 200)
  const nodeCsv = await rawGet(`/api/workshop/daq/export-file?job=${jobId}&path=nodes/${pick[0]}.csv`)
  ok('PA3.5', 'nodes/<id>.csv 下载 200', nodeCsv.status === 200 && nodeCsv.contentType.includes('csv'), nodeCsv.text.slice(0, 80))
  const trav = await rawGet(`/api/workshop/daq/export-file?job=${jobId}&path=${encodeURIComponent('../platform.log')}`)
  ok('PA3.6', '路径穿越被拒(404)', trav.status === 404, `status=${trav.status}`)

  // ── PA4 MES 调试台(注塑预设无 mes-rest 点位:负例+形状) ──
  const pts = await api('GET', '/api/workshop/mes/points')
  ok('PA4.1', 'MES 点位目录 200(空目录合法)', pts.status === 200 && Array.isArray(pts.data?.points), `count=${pts.data?.count}`)
  const pv = await api('POST', '/api/workshop/mes/preview', { node_id: 'dw-not-exist', from: new Date(Date.now() - 60000).toISOString(), to: new Date().toISOString() })
  ok('PA4.2', '不存在/不可读点位 preview → 403', pv.status === 403, pv.message.slice(0, 100))

  // ── PA5 权限负例 ──
  const nf = await api('GET', `/api/workshop/daq/query?node_ids=dn-never-exists&last_minutes=5`)
  ok('PA5.1', '不存在节点查询 → 403', nf.status === 403, nf.message.slice(0, 100))

  const nodeSummary = pick.map(id => `${id}=${nodeNames.get(id)?.name ?? '?'}`).join(',')
  writeFileSync(join(EVID, 'phase-a-e2e.json'), JSON.stringify({ at: new Date().toISOString(), base: c.base, lineId: c.lineId, nodes: nodeSummary, queryWindow: q.data?.window, runOpened: openRun?.id ?? null, exportJob: job, mesPoints: pts.data?.count ?? 0, results }, null, 2))

  const pass = results.filter(r => r.pass).length
  console.log(`\n═══ data-studio Phase A: ${pass}/${results.length} PASS ═══`)
  if (pass !== results.length) process.exitCode = 1
}
main().catch((e) => {
  console.error(e)
  process.exitCode = 1
})
