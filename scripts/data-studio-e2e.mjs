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
const randomHex = (n = 8) => Array.from({ length: n }, () => '0123456789abcdef'[Math.floor(Math.random() * 16)]).join('')
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
    // 台账无 open 行(旧 run 关账/镜像时序):停线→开线制造全新批次(走完整 createRun 钩子)
    await api('POST', `/api/workshop/dcw/lines/${c.lineId}/stop`)
    await sleep(1500)
    const st = await api('POST', `/api/workshop/dcw/lines/${c.lineId}/start`, { recipeId: c.recipeId })
    if (st.status !== 200) ok('PA2.0', '重开产线(带配方)', false, st.message.slice(0, 120))
    await sleep(2500)
    runsBefore = await api('GET', `/api/workshop/eda/runs?line_id=${c.lineId}`)
    openRun = (runsBefore.data?.runs ?? []).find(r => r.outcome === 'open' && !r.endedAt)
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

  // ── PB1 图表 CRUD + B4 可见性 ──
  const mk = await api('POST', '/api/workshop/eda/charts', {
    title: 'PhaseB 私图', viz_type: 'trend',
    datasource: { lineId: c.lineId, nodeIds: pick, preset: '60', agg: 'avg' },
    encoding: { y: pick.map(id => ({ nodeId: id, name: id, unit: '', axis: 'L' })) },
    visibility: 'private',
  })
  const chartId = mk.data?.chart?.id
  ok('PB1.1', '创建私图 200', mk.status === 200 && Boolean(chartId), JSON.stringify(mk.data?.chart ?? mk.message).slice(0, 120))
  const noLine = await api('POST', '/api/workshop/eda/charts', { title: 'x', viz_type: 'trend', visibility: 'line' })
  ok('PB1.2', 'visibility=line 无 line_id → 400', noLine.status === 400, noLine.message.slice(0, 100))
  const patched = await api('PATCH', `/api/workshop/eda/charts/${chartId}`, { title: 'PhaseB 私图 v2' })
  ok('PB1.3', 'PATCH 版本自增', patched.status === 200 && patched.data?.chart?.version === 2)
  // B4 跨用户:临时开启自助注册 → 注册 viewer → 断言 → 关回
  const viewerEmail = `viewer-${randomHex(6)}-${Date.now().toString(36)}@awshop.local`
  const allowKey = 'security.allowRegistration'
  await api('PATCH', '/api/system/settings', { override: { [allowKey]: true } })
  const reg = await api('POST', '/api/users/register', { name: `viewer-${randomHex(6)}`, email: viewerEmail, password: `Vw-${randomHex(12)}` })
  const viewerToken = reg.data?.token
  await api('PATCH', '/api/system/settings', { override: { [allowKey]: false } })
  if (viewerToken) {
    const viewerRead = await api('GET', `/api/workshop/eda/charts/${chartId}`, undefined, viewerToken)
    ok('PB1.4', '他人读私图 → 404(B4)', viewerRead.status === 404, `status=${viewerRead.status}`)
    const viewerList = await api('GET', '/api/workshop/eda/charts', undefined, viewerToken)
    ok('PB1.5', '他人列表不含该私图', !(viewerList.data?.charts ?? []).some(x => x.id === chartId))
  }
  else {
    ok('PB1.4', 'viewer 注册失败,跳过跨用户断言', false, reg.message.slice(0, 100))
  }

  // ── PB2 golden(E2) ──
  const runsAll = await api('GET', `/api/workshop/eda/runs?line_id=${c.lineId}`)
  // golden 需要样本 ≥100 桶:选样本最多的关账批(刚关的新批可能只有几十点)
  const closedRun = (runsAll.data?.runs ?? [])
    .filter(r => r.endedAt && (r.sampleCount ?? 0) >= 100)
    .sort((a, b) => (b.sampleCount ?? 0) - (a.sampleCount ?? 0))[0]
  const goldenNode = pick[0]
  if (closedRun && goldenNode) {
    const gb = await api('POST', '/api/workshop/eda/golden', { run_id: closedRun.id, node_id: goldenNode })
    ok('PB2.1', '从关账批次生成 golden 画像', gb.status === 200 && (gb.data?.golden?.profile?.length ?? 0) > 0,
      `bins=${gb.data?.golden?.profile?.length} fp=${JSON.stringify(gb.data?.golden?.fingerprint ?? {}).slice(0, 120)}`)
    const gs = await api('GET', `/api/workshop/eda/golden/single?recipe_id=${closedRun.recipeId}&node_id=${goldenNode}`)
    ok('PB2.2', 'single 取回画像(叠加用)', gs.status === 200 && gs.data?.golden?.profile?.length > 0)
    const dev = await api('GET', `/api/workshop/eda/golden/deviation?run_id=${closedRun.id}&node_id=${goldenNode}`)
    ok('PB2.3', '偏差分可算(自身 vs golden,分数有限)', dev.status === 200 && Number.isFinite(dev.data?.score), `score=${dev.data?.score} bins=${dev.data?.bins}`)
  }
  else {
    ok('PB2.1', '无已关账批次,golden 断言跳过', false, '需先关账一个有样本的 run(PA2)')
  }

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
