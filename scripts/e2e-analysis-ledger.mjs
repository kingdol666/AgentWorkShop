#!/usr/bin/env node
/**
 * 数据分析台账 E2E —— 实例④(隔离,mock harness 确定性):
 *   Agent 把数据分析结果持久化(analysis_save,append-only 台账)
 *   → 按条件检索(analysis_query 列表/关键词/类别/时间窗)
 *   → 精确查回详情(analysis_query report_id 完整正文+结论+指标)
 *   → REST /analysis 面与权限边界(跨线不可见、append-only、人工修订归因)。
 *
 * 收口条件:全部断言 PASS。
 * 运行:node scripts/e2e-analysis-ledger.mjs(自起隔离实例,端口 3416)
 * 证据:docs/audit/evidence/2026-10-28-analysis-ledger/report.json
 */
import { spawn } from 'node:child_process'
import { mkdirSync, openSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import { DatabaseSync } from 'node:sqlite'

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const TAG = `al${Date.now().toString(36).slice(-4)}`
const ROOT = join(tmpdir(), `aw-analysis-e2e-${TAG}`)
mkdirSync(join(ROOT, 'home'), { recursive: true })
const results = []
const ok = (id, name, cond, detail = '') => {
  results.push({ id, name, pass: Boolean(cond), detail: String(detail).slice(0, 700) })
  console.log(`${cond ? '✔' : '✖'} [${id}] ${name}${cond ? '' : ` — ${String(detail).slice(0, 500)}`}`)
  return Boolean(cond)
}
const sleep = ms => new Promise(r => setTimeout(r, ms))

let port = 0
for (const p of [3416, 3417]) {
  try {
    const r = await fetch(`http://127.0.0.1:${p}/api/health`, { signal: AbortSignal.timeout(1200) })
    if (r.ok) continue
  }
  catch { /* 空闲 */ }
  port = p
  break
}
if (!port) {
  console.error('无空闲端口')
  process.exit(1)
}
const BASE = `http://127.0.0.1:${port}`
process.env.NO_PROXY = '127.0.0.1,localhost'
const logFd = openSync(join(ROOT, 'dev.log'), 'a')
const child = spawn(process.execPath, [join(REPO, 'bin', 'aw.mjs'), 'dev', '--port', String(port)], {
  cwd: REPO,
  env: { ...process.env, AW_MODE: 'home', AW_HOME: join(ROOT, 'home'), AW_RATE_LIMIT_OFF: '1', NUXT_SESSION_PASSWORD: 'AnalysisLedger#2026-key', NO_PROXY: '127.0.0.1,localhost' },
  stdio: ['ignore', logFd, logFd],
  windowsHide: true,
})

async function api(method, path, body, token, extraHeaders = {}, timeoutMs = 120_000) {
  const res = await fetch(BASE + path, {
    method,
    headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}), ...extraHeaders },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  })
  let json = null
  try {
    json = await res.json()
  }
  catch { /* 非 JSON */ }
  return { status: res.status, ...json }
}
const invText = r => String(r?.data?.result?.text ?? r?.data?.text ?? '')
const invErr = r => Boolean(r?.data?.result?.isError ?? r?.data?.isError)
const callAs = (agentId, token, tool, args) => api('POST', '/api/workshop/agent-tools/invoke', { agentId, tool, args }, undefined, { 'x-aw-agent-token': token })

let admin = ''
try {
  let healthy = false
  for (let i = 0; i < 90; i++) {
    await sleep(2000)
    try {
      const h = await api('GET', '/api/health', undefined, undefined, {}, 3000)
      if (h?.data?.status === 'ok' && h?.data?.workshop === 'ready') {
        healthy = true
        break
      }
    }
    catch { /* 未就绪 */ }
  }
  ok('A0', '隔离实例④启动 + workshop ready', healthy, `port=${port}`)
  if (!healthy) throw new Error('实例未就绪')
  admin = (await api('POST', '/api/users/register', { name: `al-admin-${TAG}`, email: `al-${TAG}@awshop.local`, password: 'AlAdmin#2026' })).data?.token
  ok('A0b', 'admin 注册', Boolean(admin))

  // ── 场景:两线各带数采;频道绑线A;两个 Agent(w1 绑线A 数采,w2 无绑定) ──
  const lineA = (await api('POST', '/api/workshop/dcw/lines', { name: `台账线A-${TAG}` }, admin)).data?.line?.id
  const lineB = (await api('POST', '/api/workshop/dcw/lines', { name: `台账线B-${TAG}` }, admin)).data?.line?.id
  const dnA = (await api('POST', '/api/workshop/daq', { name: `数采A-${TAG}`, driver: 'mock', templateRef: 'daq-temp-tc', lineId: lineA, intervalMs: 1000, publishIntervalMs: 0 }, admin)).data?.node?.id
  const ch = (await api('POST', '/api/workshop/channels', { name: `台账频道-${TAG}`, lineId: lineA, leadAgent: { name: `al-lead-${TAG}`, harness: 'mock' } }, admin)).data
  const mkWorker = async (name) => {
    const w = (await api('POST', `/api/workshop/channels/${ch.channelId}/agents`, { name, harness: 'mock', role: 'worker' }, admin)).data
    return String(w?.id ?? w?.agentId ?? '')
  }
  const w1 = await mkWorker(`al-w1-${TAG}`)
  const w2 = await mkWorker(`al-w2-${TAG}`)
  void w2
  await api('POST', '/api/workshop/daq/controller', { action: 'start' }, admin)
  await sleep(6000)
  const b1 = await api('POST', '/api/workshop/agent-tools/bindings', { agentId: w1, nodeId: dnA, kind: 'daq', mode: 'auto' }, admin)
  ok('A1', '场景就绪(两线/数采/频道/双 worker/绑定)', Boolean(lineA && lineB && dnA && w1 && w2) && b1.status === 200, JSON.stringify({ lineA, lineB, dnA, w1, w2 }))
  const tok1 = (() => {
    const db = new DatabaseSync(join(ROOT, 'home', 'data', 'workshop.sqlite'))
    try {
      return String(db.prepare('SELECT token FROM channel_agents WHERE id = ?').get(w1)?.token ?? '')
    }
    finally {
      db.close()
    }
  })()
  void w2

  // ── Agent 持久化分析结果(先抓真实数据再留痕) ──
  const data = await callAs(w1, tok1, 'daq_query', { node_id: dnA, last_minutes: 5 })
  const sampleOk = !invErr(data)
  const nowIso = new Date().toISOString()
  const saved1 = await callAs(w1, tok1, 'analysis_save', {
    title: `腔体温度趋势分析-${TAG}`,
    summary: '近5分钟温度稳定在设定带内,无越限趋势',
    conclusions: '1) 样本充足;2) 均值接近设定值;3) 无报警趋势',
    report: `# 腔体温度趋势分析\n\n数据来源 daq_query(${dnA}),窗口最近5分钟。逐桶统计显示温度围绕设定值窄幅波动,无单向漂移;建议维持当前配方。`,
    category: 'trend',
    line_id: lineA,
    window_from: nowIso,
    window_to: nowIso,
    data_sources: [`daq_query:${dnA}`],
    metrics: { sampleCount: 30, meanTempC: 60.2, maxDeviationC: 1.8 },
  })
  const save1Text = invText(saved1)
  const reportId = save1Text.match(/ar-[a-z0-9]+/i)?.[0] ?? ''
  ok('A2', `Agent analysis_save 持久化(先抓数据:采样=${sampleOk})→ 返回台账 id`, sampleOk && !invErr(saved1) && Boolean(reportId), save1Text.slice(0, 240))
  const saved2 = await callAs(w1, tok1, 'analysis_save', {
    title: `压力越限筛查-${TAG}`,
    summary: '压力测点无越限记录,筛查通过',
    conclusions: '无越限',
    report: '压力筛查:窗口内无越限样本。',
    category: 'alarm-review',
    line_id: lineA,
  })
  ok('A2b', '第二条留痕(不同类别)', !invErr(saved2), invText(saved2).slice(0, 200))

  // ── 检索:列表 / 关键词 / 类别 / 详情 ──
  const qList = await callAs(w1, tok1, 'analysis_query', { line_id: lineA, limit: 20 })
  const listText = invText(qList)
  ok('A3', 'analysis_query 按线列表 → 两条可见', !invErr(qList) && listText.includes(`趋势分析-${TAG}`) && listText.includes(`越限筛查-${TAG}`), listText.slice(0, 260))
  const qKw = await callAs(w1, tok1, 'analysis_query', { q: '越限筛查' })
  ok('A3b', '关键词检索命中目标报告', !invErr(qKw) && invText(qKw).includes(`压力越限筛查-${TAG}`), invText(qKw).slice(0, 220))
  const qDetail = await callAs(w1, tok1, 'analysis_query', { report_id: reportId })
  const detailText = invText(qDetail)
  ok('A4', 'report_id 精确查回详情(完整正文+结论+指标)',
    !invErr(qDetail) && detailText.includes('腔体温度趋势分析') && detailText.includes('逐桶统计') && detailText.includes('60.2') && detailText.includes('样本充足'),
    detailText.slice(0, 320))

  // ── 权限边界:跨线不可见;append-only(工具面无修改);人工修订走 REST 且带归因 ──
  const qB = await callAs(w1, tok1, 'analysis_query', { line_id: lineB })
  ok('A5', '跨线查询不泄漏他线报告', !invText(qB).includes(`趋势分析-${TAG}`), invText(qB).slice(0, 160))
  const toolsW1 = (await api('GET', `/api/workshop/agent-tools/list?agentId=${encodeURIComponent(w1)}`, undefined, undefined, { 'x-aw-agent-token': tok1 })).data?.tools ?? []
  const analysisTools = toolsW1.filter(t => t.name.startsWith('analysis_')).map(t => t.name)
  ok('A5b', 'Agent 分析工具面=save+query(无修改/删除,append-only)', analysisTools.includes('analysis_save') && analysisTools.includes('analysis_query') && !analysisTools.some(t => /edit|delete|update/.test(t)), analysisTools.join(','))
  const w1Row = (await api('GET', `/api/workshop/agent-tools/list?agentId=${encodeURIComponent(w1)}`, undefined, undefined, { 'x-aw-agent-token': tok1 }))
  void w1Row
  // 人工修订(REST,editor 归因)→ Agent 查回的是修订后内容
  const patched = await api('PATCH', `/api/workshop/analysis/${reportId}`, { summary: '近5分钟温度稳定(人工复核修订)' }, admin)
  ok('A6', '人工经 REST 修订摘要(admin/editor 通道)', patched.status === 200, `status=${patched.status} msg=${String(patched?.message ?? '').slice(0, 120)}`)
  const qAfter = await callAs(w1, tok1, 'analysis_query', { report_id: reportId })
  ok('A6b', 'Agent 查回修订后内容(台账修订留痕)', !invErr(qAfter) && invText(qAfter).includes('人工复核修订'), invText(qAfter).slice(0, 200))
  // REST 列表面(前端 /analysis 数据源)
  const restList = await api('GET', `/api/workshop/analysis?lineId=${lineA}&limit=20`, undefined, admin)
  const restRows = restList?.data?.reports ?? restList?.data?.items ?? restList?.data ?? []
  const restHit = JSON.stringify(restRows).includes(`腔体温度趋势分析-${TAG}`)
  ok('A7', 'REST /analysis 列表面可见台账(前端 /analysis 页数据源)', restList.status === 200 && restHit, `status=${restList.status} rows=${Array.isArray(restRows) ? restRows.length : '?'} hit=${restHit}`)
}
catch (err) {
  ok('FATAL', 'E2E 未捕获异常', false, err instanceof Error ? `${err.message}\n${err.stack ?? ''}` : String(err))
}
finally {
  try {
    child.kill()
  }
  catch { /* noop */ }
  const passed = results.filter(r => r.pass).length
  const total = results.length
  const evidenceDir = join(REPO, 'docs', 'audit', 'evidence', '2026-10-28-analysis-ledger')
  mkdirSync(evidenceDir, { recursive: true })
  const evidencePath = join(evidenceDir, 'report.json')
  writeFileSync(evidencePath, JSON.stringify({
    at: new Date().toISOString(),
    env: { base: BASE, home: join(ROOT, 'home'), devLog: join(ROOT, 'dev.log'), instance: '④-analysis-ledger', mode: 'isolated', harness: 'mock(deterministic)' },
    summary: { total, passed, failed: total - passed, verdict: passed === total ? 'PASS' : 'FAIL' },
    results,
  }, null, 2))
  console.log(`\n结论:${passed === total ? 'PASS' : 'FAIL'}(${passed}/${total})`)
  console.log(`证据:${evidencePath}`)
  process.exit(passed === total ? 0 : 1)
}
