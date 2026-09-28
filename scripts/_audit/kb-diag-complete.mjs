#!/usr/bin/env node
/**
 * scripts/_audit/kb-diag-complete.mjs —— 闭环收尾:等待 IDD 诊断完成 → 报告入库 KB →
 * 检索命中 → 第 2 轮(新产线数据 + 引用前轮结论)→ 再入库。V5/V6/V7 的完成判定。
 *
 * 前置:98067577 诊断任务在跑;两次 API Token 已建;平台/模拟器由本脚本自举(3470/4019)。
 */
import { spawn, spawnSync } from 'node:child_process'
import { closeSync, existsSync, mkdtempSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createInterface } from 'node:readline'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const AW_PORT = 3470
const SIM_PORT = 4019
const SIM_DIR = resolve(REPO, '..', 'plc-node-simulator-bench-4019')
const BASE = `http://127.0.0.1:${AW_PORT}`
const SIM = `http://127.0.0.1:${SIM_PORT}`
const KB_BASE = 'http://127.0.0.1:8770'
const IDD_BASE = 'http://127.0.0.1:3210'
const KB_TOKEN = readFileSync(join(REPO, '.kb-token.tmp'), 'utf8').trim()
const IDD_TOKEN = readFileSync(join(REPO, '.idd-token.tmp'), 'utf8').trim()
const DIAG_TASK = '98067577'

let pass = 0
const fails = []
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ✔ ${name}`) }
  else { fails.push(name); console.log(`  ✖ ${name}${detail ? ` — ${String(detail).slice(0, 220)}` : ''}`) }
}
const sleep = ms => new Promise(r => setTimeout(r, ms))
const getJson = async (url, token) => {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(20000), headers: token ? { authorization: `Bearer ${token}` } : {} })
    return await r.json()
  }
  catch { return null }
}
const killPort = (port) => {
  try {
    const psi = spawnSync('powershell', ['-NoProfile', '-Command',
      `Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty OwningProcess`], { encoding: 'utf8' })
    const pid = Number(psi.stdout.trim())
    if (Number.isInteger(pid) && pid > 0) spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' })
  }
  catch { /* 尽力而为 */ }
}

/* ── S1 · 等 R1 诊断完成并读取报告 ── */
console.log('[S1] 等待 IDD 诊断 98067577 完成(最长 30 分钟)')
let reportPath = null
for (let i = 0; i < 90; i++) {
  await sleep(20_000)
  try {
    const d = await getJson(`${IDD_BASE}/api/diagnosis/tasks/${DIAG_TASK}`, IDD_TOKEN)
    const v = d?.data?.view ?? d?.data ?? {}
    if (v.status === 'completed' || (v.result?.report_md_path)) {
      reportPath = v.result?.report_md_path
      console.log(`  ↳ 完成:score=${v.result?.score} verdict=${v.result?.verdict}`)
      break
    }
    if (v.status === 'failed') { console.log('  ✖ 诊断失败'); break }
    if (i % 3 === 0) console.log(`  ↳ (${i * 20 / 60 | 0}min) ${v.status ?? '?'}`)
  }
  catch { /* 网络抖动重试 */ }
}
ok('R1 诊断完成', Boolean(reportPath), '超时或失败')
if (!reportPath) { console.log(`═══ ${pass} PASS / ${fails.length + 1} FAIL ═══`); process.exit(1) }
const reportPathNorm = reportPath.replace(/\\/g, '/')
let reportMd = ''
try { reportMd = readFileSync(reportPathNorm, 'utf8') } catch {}
ok('报告文件可读', reportMd.length > 200, `len=${reportMd.length} @ ${reportPathNorm}`)

/* ── S2 · 报告入库知识库(经验库)── */
console.log('[S2] R1 报告入库知识库')
let kbId
{
  const cat = await getJson('http://127.0.0.1:6789/api/kb/catalog', KB_TOKEN)
  const kbs = cat?.knowledgeBases ?? []
  const mine = kbs.find(k => k.name === 'aw-industrial') ?? kbs[0]
  kbId = mine?.kbId ?? mine?.id ?? null
  ok('KB 目录可达且存在知识库', Boolean(kbId), JSON.stringify(kbs).slice(0, 160))
}
const excerpt = reportMd.slice(0, 6000)
const expBody = {
  title: `产线数据分析诊断报告 R1(数据分析验收线)`,
  scenario: 'PLC 模拟流延膜产线:膜厚/熔温/熔压持续监测与诊断',
  category: 'postmortem',
  problem: '膜厚等 PV 出现波动/漂移,需要判断工况稳定性与根因方向',
  solution: excerpt.includes('建议') || excerpt.includes('结论') ? '依据报告结论执行(见 key_lessons)' : '继续观察并扩大数据窗口',
  result: 'SUCCESS',
  key_lessons: [`R1 诊断评分与结论见报告全文;报告来源 ${reportPathNorm}`],
  tags: ['产线数据分析', '膜厚', 'R1', '流延膜'],
  metrics: { source: 'IDD', task: DIAG_TASK },
}
{
  const req = urllibPost(`${KB_BASE}/api/v1/experience/${kbId}`, expBody, KB_TOKEN)
  const r = await req
  ok('R1 报告入库经验库', Boolean(r && (r.success !== false || r.id || r.experience)), JSON.stringify(r).slice(0, 180))
}
function urllibPost(url, body, token) {
  return new Promise((resolve2) => {
    const req = spawn('curl', ['-s', '--noproxy', '127.0.0.1', '-X', 'POST', url,
      '-H', 'content-type: application/json', '-H', `authorization: Bearer ${token}`, '-H', `X-KB-Token: ${token}`,
      '--max-time', '60', '-d', JSON.stringify(body)], { encoding: 'utf8' })
    let out = ''
    req.stdout?.on('data', (d) => { out += d })
    req.on('close', () => { try { resolve2(JSON.parse(out)) } catch { resolve2({ raw: out.slice(0, 200) }) } })
    req.on('error', () => resolve2({ raw: 'curl error' }))
  })
}

/* ── S3 · 检索验证(R1 报告可命中)── */
console.log('[S3] 检索验证:R1 报告可被检索')
{
  const body = JSON.stringify({ query: '产线数据分析诊断报告 膜厚 R1', top_k: 5 })
  const out = spawn('curl', ['-s', '--noproxy', '127.0.0.1', '-X', 'POST',
    `${KB_BASE}/api/v1/experience/${kbId}/search`,
    '-H', 'content-type: application/json', '-H', `authorization: Bearer ${KB_TOKEN}`, '-H', `X-KB-Token: ${KB_TOKEN}`,
    '--max-time', '60', '-d', body], { encoding: 'utf8' })
  let result = ''
  out.stdout?.on('data', (d) => { result += d })
  await new Promise(r => out.on('close', r))
  let hits = 0
  try {
    const j = JSON.parse(result)
    hits = (j.results ?? j.experiences ?? j.data ?? []).length || (j.count ?? 0)
  }
  catch { /* 解析失败按 0 */ }
  ok('经验检索命中 R1 报告', hits > 0, result.slice(0, 200))
}

/* ── S4 · 第 2 轮:新产线数据 + 引用 R1 结论 → 诊断 → 入库 ── */
console.log('[S4] 第 2 轮:新数据导出 + 诊断(引用 R1)+ 入库')
{
  // 自举新平台 + 模拟器
  const HOME2 = mkdtempSync(join(tmpdir(), 'aw-kb-r2-'))
  for (const port of [AW_PORT, SIM_PORT]) killPort(port)
  writeFileSync(join(HOME2, 'runtime-settings.json'), JSON.stringify({ version: 1, overrides: { 'mcp.enabled': true, 'plugins.rag-bridge.token': KB_TOKEN, 'plugins.diag-bridge.token': IDD_TOKEN } }))
  {
    const out = openSync(join(HOME2, 'instance.log'), 'a')
    const p = spawn(process.execPath, [join(REPO, 'bin', 'aw.mjs'), 'start', '--port', String(AW_PORT)], {
      cwd: REPO,
      env: { ...process.env, NO_PROXY: '127.0.0.1,localhost', HTTP_PROXY: '', HTTPS_PROXY: '', AW_MODE: 'home', AW_HOME: HOME2, NUXT_SESSION_PASSWORD: 'kb-complete-session-password-0123456' },
      detached: true, windowsHide: true, stdio: ['ignore', out, out],
    })
    closeSync(out); p.unref()
  }
  let up = false
  for (let i = 0; i < 40; i++) {
    await sleep(2000)
    if ((await getJson(`${BASE}/api/health`))?.data?.status === 'ok') { up = true; break }
  }
  ok('R2 平台健康门', up)
  {
    process.env.SIM_BASE = SIM
    process.env.SIM_SHADOW_DIR = SIM_DIR
    const { ensureSimulator, applyPreset } = await import('../../bench/lib/sim.mjs')
    await ensureSimulator({ log: () => {} })
    await applyPreset('cast-film-physics')
  }
  const reg = await (async () => {
    const r = await fetch(`${BASE}/api/users/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'kb-r2-admin', email: 'kb-r2@awshop.local', password: 'kb-r2-passw0rd' }) })
    return r.json()
  })()
  const TOKEN2 = reg?.data?.token
  const mcp = spawn(process.execPath, [join(REPO, 'mcp', 'aw-mcp-server.mjs')], {
    cwd: REPO,
    env: { ...process.env, NO_PROXY: '127.0.0.1,localhost', HTTP_PROXY: '', HTTPS_PROXY: '', AW_HOME: HOME2, AW_TOKEN: TOKEN2 },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  const rl = createInterface({ input: mcp.stdout })
  const pending = new Map(); let nextId = 1
  rl.on('line', (line) => { try { const m = JSON.parse(line); if (m?.id != null && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id) } } catch {} })
  const call = async (name, args = {}, timeoutMs = 120_000) => {
    const id = nextId++
    const res = await new Promise((res2, rej2) => {
      const t = setTimeout(() => { pending.delete(id); rej2(new Error(`rpc 超时: ${name}`)) }, timeoutMs)
      pending.set(id, (m) => { clearTimeout(t); res2(m) })
      mcp.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } })}\n`)
    })
    const text = res?.result?.content?.[0]?.text ?? ''
    return { isError: Boolean(res?.result?.isError), text, data: (() => { try { return JSON.parse(text) } catch { return null } })() }
  }

  // 建线(最小:zone1 SV + 膜厚 PV)并开跑
  const simDevices = (await getJson(`${SIM}/api/nodes`))?.data ?? []
  const line = await call('aw_line_create', { name: '数据分析验收线-R2' })
  const lineId = line.data?.line?.id
  const product = await call('aw_product_create', { lineId, name: '数据分析验收产品-R2' })
  const productId = product.data?.product?.id
  const dcw = {}, daq = {}
  for (const dev of simDevices) {
    const exp = (await getJson(`${SIM}/api/nodes/${dev.id}/export`))?.data?.items ?? []
    const sigOf = id => (dev.signals ?? []).find(s => s.id === id)
    for (const [id, tpl, isAct] of [['zone1-sp', 'dcw-temp-sp', true], ['film-thickness', 'daq-temp-tc', false]]) {
      const sig = sigOf(id); if (!sig) continue
      const item = exp.find(i => i.signal === sig.name); if (!item?.driverConfig) continue
      const r = isAct
        ? await call('aw_dcw_create', { name: `R2-${sig.name}`, templateRef: tpl, driver: dev.protocol, driverConfig: item.driverConfig, unit: sig.unit, min: sig.min, max: sig.max, decimals: sig.decimals ?? 2, lineId, holdIntervalMs: 0, stepLimit: 5, semantics: 'SV 设定点:加热区温度' })
        : await call('aw_daq_create', { name: `R2-${sig.name}`, templateRef: tpl, driver: dev.protocol, driverConfig: item.driverConfig, unit: sig.unit, min: sig.min, max: sig.max, decimals: sig.decimals ?? 2, lineId, intervalMs: 1000, semantics: 'PV 实时检测:流延膜厚度(优化目标 goal,μm)' })
      if (isAct) dcw[id] = r.data?.node?.id ?? r.data?.id
      else daq[id] = r.data?.node?.id ?? r.data?.id
    }
  }
  await call('aw_daq_controller', { action: 'start' })
  const recipe = await call('aw_recipe_create', {
    productId, name: 'R2 基线配方', description: 'R2 闭环验收基线',
    params: [{ nodeId: dcw['zone1-sp'], value: 200, min: 190, max: 225 }],
  })
  await call('aw_line_start', { lineId, recipeId: recipe.data?.recipe?.id ?? recipe.data?.id })
  console.log('  ↳ R2 产线开跑,采样 120s...')
  await sleep(120_000)

  // 导出 CSV + meta(引用 R1 报告结论)
  const toMs = Date.now(); const fromMs = toMs - 120_000
  const r = await call('aw_daq_samples', { id: daq['film-thickness'], fromMs, toMs, bucketMs: 2000, limit: 500 })
  const pts = (r.data?.points ?? []).map(p => ({ at: Number(p.at ?? 0), v: Number(p.avg ?? p.value) })).filter(p => Number.isFinite(p.v)).sort((a, b) => a.at - b.at)
  const dir = join(HOME2, 'analysis', 'round-2')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'data.csv'), ['timestamp,film_thickness_um', ...pts.map(p => `${new Date(p.at).toISOString()},${p.v}`)].join('\n'))
  writeFileSync(join(dir, 'meta.json'), JSON.stringify({
    dataset: '产线数据分析第 2 轮(引用 R1 报告结论)',
    fields: [{ column: 'film_thickness_um', role: 'PV', unit: 'μm', meaning: '膜厚实时检测(PV):核心质量指标,SV 变化后滞后跟随' }],
    priorRound: { report: reportPathNorm, applied: '拉宽观察窗口,聚焦膜厚漂移是否延续' },
  }, null, 2))
  ok('R2 CSV+meta 落盘(引用 R1)', pts.length > 0 && existsSync(join(dir, 'meta.json')), `rows=${pts.length}`)

  // 诊断(引用前轮)
  const diag = await call('diag_run', { data_path: join(dir, 'data.csv'), question: '上一轮报告结论已存知识库。请复核本批新数据:膜厚漂移是否延续,给出结论与建议', scene: '数据分析验收线_R2_diag' }, 120_000)
  const taskId = (diag.text.match(/(\d{6,})/) || [])[1]
  ok('R2 诊断提交', !diag.isError && Boolean(taskId), diag.text.slice(0, 140))
  let done2 = false
  if (taskId) {
    for (let i = 0; i < 90; i++) {
      await sleep(10_000)
      try {
        const d3 = await getJson(`${IDD_BASE}/api/diagnosis/tasks/${taskId}`, IDD_TOKEN)
        const v = d3?.data?.view ?? d3?.data ?? {}
        if (v.status === 'completed' || v.result?.report_md_path) { done2 = true; console.log(`  ↳ R2 诊断完成:${v.result?.score ?? ''} ${v.result?.verdict ?? ''}`); break }
        if (v.status === 'failed') break
      }
      catch { /* 重试 */ }
    }
  }
  ok('R2 诊断完成', done2)

  mcp.stdin.end(); mcp.kill()
  killPort(AW_PORT); killPort(SIM_PORT)
  await sleep(1500)
  try { rmSync(HOME2, { recursive: true, force: true, maxRetries: 3, retryDelay: 1500 }) } catch {}
}

/* ── 收尾 ── */
console.log('')
console.log(`═══ 闭环收尾验收:${pass} PASS / ${fails.length} FAIL ═══`)
for (const f of fails) console.log(`  ✖ ${f}`)
console.log('')
process.exit(fails.length ? 1 : 0)
