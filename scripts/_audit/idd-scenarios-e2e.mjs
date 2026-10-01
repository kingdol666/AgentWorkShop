/**
 * IDD(industrial-deep-diagnostic)独立多场景实测 —— 不依赖 AgentWorkShop 平台。
 *
 * 覆盖:鉴权(register→token)/ 数据上传(单文件/多文件/manifest 数据集)/
 * 异步诊断任务(五种典型工况场景)/ chat 原生会话(mock 引擎)/
 * 负路径(未鉴权 401、路径穿越 403、未知引擎 400)/ 报告落盘与评分提取。
 * 引擎固定 mock(秒级、确定性);要验真引擎管线加 --real(单场景 omp,3~12 分钟)。
 *
 * 用法:node scripts/_audit/idd-scenarios-e2e.mjs [--base http://127.0.0.1:3210] [--real]
 */
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const args = process.argv.slice(2)
const flag = (name, def) => {
  const i = args.indexOf(name)
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : (i >= 0 ? true : def)
}
const BASE = String(flag('--base', 'http://127.0.0.1:3210')).replace(/\/+$/, '')
const REAL = args.includes('--real')
const OUT = mkdtempSync(join(tmpdir(), 'idd-scen-'))

let passed = 0
let failed = 0
const results = []
function check(name, ok, detail = '') {
  ok ? passed++ : failed++
  results.push({ name, ok, detail: String(detail).slice(0, 160) })
  console.log(`${ok ? '✔' : '✖'} ${name}${detail && !ok ? ` — ${detail}` : ''}`)
}

async function api(method, path, { token, body, form, timeoutMs = 30000 } = {}) {
  const headers = {}
  if (token) headers.authorization = `Bearer ${token}`
  if (body) headers['content-type'] = 'application/json'
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: form ?? (body ? JSON.stringify(body) : undefined),
    signal: AbortSignal.timeout(timeoutMs),
  })
  const json = await res.json().catch(() => null)
  return { status: res.status, json }
}
const unwrap = r => r.json?.data ?? r.json ?? null

// ── 0) 鉴权:注册(随机用户)→ 持久 API token ────────────────────────────────
const user = `awscen_${createHash('md5').update(String(Date.now()) + String(Math.random())).digest('hex').slice(0, 10)}`
const reg = await api('POST', '/api/auth/register', { body: { username: user, password: 'Scen#2026Ok' } })
const regData = unwrap(reg)
const sessionToken = regData?.session_token ?? regData?.token ?? ''
check('S0 注册返回会话 token', reg.status === 200 && Boolean(sessionToken), `HTTP ${reg.status} ${JSON.stringify(reg.json)?.slice(0, 120)}`)
const tok = await api('POST', '/api/auth/tokens', { token: sessionToken, body: { name: 'aw-scenarios', expires_in_days: 1 } })
const tokData = unwrap(tok)
const apiToken = tokData?.token ?? tokData?.plaintext ?? ''
check('S0 创建 idd_ API token', tok.status === 200 && String(apiToken).startsWith('idd_'), `HTTP ${tok.status} ${JSON.stringify(tok.json)?.slice(0, 120)}`)
const T = apiToken || sessionToken

// ── 负路径 ──────────────────────────────────────────────────────────────────
const anon = await api('GET', '/api/diagnosis/list')
check('N1 未鉴权访问任务列表被拒(401)', anon.status === 401, `HTTP ${anon.status}`)
const trav = await api('POST', '/api/diagnosis/tasks', { token: T, body: { dataPath: '../../.auth-jwt-secret', sceneName: 'traversal', harness: 'mock' } })
check('N2 路径穿越被拦(403/404)', trav.status === 403 || trav.status === 404, `HTTP ${trav.status} ${JSON.stringify(trav.json)?.slice(0, 120)}`)
const badH = await api('POST', '/api/diagnosis/tasks', { token: T, body: { dataPath: 'data/x.csv', harness: 'no-such-engine' } })
check('N3 未知引擎被拒(400)', badH.status === 400, `HTTP ${badH.status}`)

// ── 场景数据生成器 ──────────────────────────────────────────────────────────
function csvOf(rows) {
  const head = 'ts,value,state'
  return [head, ...rows.map(r => `${r.t},${r.v.toFixed(4)},${r.s ?? 'ok'}`)].join('\r\n')
}
const t0 = 1_760_000_000_000
function stepOvershoot() {
  const rows = []
  for (let i = 0; i < 300; i++) {
    let v = 50
    if (i >= 100) v = 75 + (i < 130 ? 7 * Math.exp(-(i - 100) / 8) : 0) + Math.sin(i / 7) * 0.4
    rows.push({ t: new Date(t0 + i * 1000).toISOString(), v })
  }
  return csvOf(rows)
}
function driftCross(series = 0) {
  const rows = []
  for (let i = 0; i < 360; i++) {
    const v = series === 0
      ? 60 + i * 0.09 + Math.sin(i / 9) * 1.2 // 缓慢漂移,末端越过 90
      : series === 1 ? 2.4 + Math.sin(i / 30) * 0.1 : 120 + Math.sin(i / 5) * 3
    rows.push({ t: new Date(t0 + i * 1000).toISOString(), v, s: series === 0 && v > 90 ? 'alarm' : 'ok' })
  }
  return csvOf(rows)
}
function oscillation(offset = 0) {
  const rows = []
  for (let i = 0; i < 420; i++) {
    const v = 60 + 15 * Math.sin((2 * Math.PI * i) / 24) + offset + Math.sin(i / 3) * 0.5
    rows.push({ t: new Date(t0 + i * 1000).toISOString(), v })
  }
  return csvOf(rows)
}
function exportDataset(id) {
  const dir = join(OUT, id, 'nodes')
  mkdirSync(dir, { recursive: true })
  const nodes = ['temp', 'press', 'flow']
  for (const n of nodes) writeFileSync(join(dir, `${n}.csv`), n === 'temp' ? driftCross(0) : n === 'press' ? driftCross(1) : driftCross(2))
  const manifest = {
    schema: 'aw.daq-export/1',
    export_id: id,
    title: '温度越限数据集',
    note: 'temp 缓慢漂移越限(>90 报警),press/flow 正常;请判根因(传感器漂移 vs 真实工艺失稳)',
    window: { from_ms: t0, to_ms: t0 + 360_000 },
    lines: [{ lineId: 'line-a', lineName: '示范产线' }],
    nodes: nodes.map(n => ({ id: n, unit: n === 'temp' ? '℃' : n === 'press' ? 'MPa' : 'm3/h', file: `nodes/${n}.csv` })),
  }
  writeFileSync(join(OUT, id, 'manifest.json'), JSON.stringify(manifest, null, 2))
  return { dir: join(OUT, id), files: ['manifest.json', ...nodes.map(n => `nodes/${n}.csv`)] }
}

async function upload(files, folder) {
  const fd = new FormData()
  fd.append('folder', folder)
  for (const f of files) fd.append('files', new Blob([readFileSync(f.abs ?? f)], { type: 'text/plain' }), f.name ?? f.split(/[\\/]/).pop())
  const res = await fetch(`${BASE}/api/files/data/upload`, { method: 'POST', body: fd, headers: { authorization: `Bearer ${T}` }, signal: AbortSignal.timeout(60000) })
  const json = await res.json().catch(() => null)
  if (!res.ok || json?.success !== true) throw new Error(`upload HTTP ${res.status}`)
  return json.data.map(d => d.path)
}

/** 发起 + 轮询到终态;返回任务视图 */
async function runDiag(payload, tag, timeoutMs = 180_000) {
  const started = await api('POST', '/api/diagnosis/tasks', { token: T, body: { ...payload, harness: payload.harness ?? 'mock', reportLanguage: 'zh' } })
  const sd = unwrap(started)
  const id = sd?.task_id ?? sd?.runId
  if (!id) throw new Error(`${tag} 发起失败: HTTP ${started.status} ${JSON.stringify(started.json)?.slice(0, 160)}`)
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 2000))
    const st = unwrap(await api('GET', `/api/diagnosis/tasks/${id}`, { token: T }))
    if (st && ['completed', 'failed', 'stopped'].includes(String(st.status))) return { id, st }
  }
  throw new Error(`${tag} 轮询超时(${timeoutMs}ms)`)
}

async function scenario(name, payload, expect) {
  try {
    const { st } = await runDiag(payload, name, REAL ? 900_000 : 180_000)
    const ok = st.status === 'completed'
    check(`${name} 完成`, ok, `status=${st.status} ${JSON.stringify(st.result ?? st)?.slice(0, 160)}`)
    if (!ok) return
    const score = st.result?.score
    check(`${name} 评分提取`, typeof score === 'number' && score > 0, `score=${score}`)
    const rp = st.result?.report_md_path ?? ''
    check(`${name} 报告路径就绪`, Boolean(rp) && existsSync(rp), rp)
    if (rp && existsSync(rp)) {
      const md = readFileSync(rp, 'utf8')
      check(`${name} 报告含 Judge Score`, /Judge Score/i.test(md), md.slice(0, 80))
      if (expect) check(`${name} ${expect.label}`, md.includes(expect.contains), expect.contains)
    }
  }
  catch (err) {
    check(name, false, err.message)
  }
}

// ── S1 单文件:阶跃超调(温度控制回路) ─────────────────────────────────────
{
  const p = join(OUT, 's1.csv')
  writeFileSync(p, stepOvershoot())
  const [path] = await upload([p], 'aw-scen/s1')
  await scenario('S1 阶跃超调(单文件异步)', { dataPath: path, sceneName: 'step_overshoot', userQuestion: '温度设定阶跃后出现超调,判回路整定问题还是执行器故障' })
}

// ── S2 多文件(无 manifest):缓慢漂移越限 + 正常对照 ────────────────────────
{
  const dir = join(OUT, 's2')
  mkdirSync(dir, { recursive: true })
  const names = ['temp.csv', 'press.csv', 'flow.csv']
  names.forEach((n, i) => writeFileSync(join(dir, n), driftCross(i)))
  const paths = await upload(names.map(n => join(dir, n)), 'aw-scen/s2')
  await scenario('S2 漂移越限(多文件异步)', { dataPaths: paths, sceneName: 'drift_alarm', userQuestion: 'temp 缓慢漂移越限报警,判传感器漂移或工艺失稳,并用 press/flow 佐证' })
}

// ── S3 单文件:周期振荡(共振) ─────────────────────────────────────────────
{
  const dir = join(OUT, 's3')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'osc-a.csv'), oscillation(0))
  writeFileSync(join(dir, 'osc-b.csv'), oscillation(6))
  const paths = await upload([join(dir, 'osc-a.csv'), join(dir, 'osc-b.csv')], 'aw-scen/s3')
  await scenario('S3 周期振荡(双点位异步)', { dataPaths: paths, sceneName: 'oscillation', userQuestion: '两测点同频振荡相位差恒定,判共振传递还是控制振荡' })
}

// ── S4 daq-export 数据集形状(manifest 首位 + nodes/*.csv) ─────────────────
{
  const ds = exportDataset('daqexp-scen')
  const paths = await upload(ds.files.map(rel => ({ abs: join(ds.dir, rel), name: rel.split('/').pop() })), 'aw-scen/s4')
  check('S4 manifest 上传后路径映射首位', paths[0]?.endsWith('manifest.json'), paths.join(','))
  await scenario('S4 manifest 数据集(平台导出形状)', { dataPaths: paths, sceneName: 'daqexp_shape', userQuestion: '按 manifest 上下文做温度越限根因诊断' })
}

// ── S5 chat 原生会话(mock,异步创建 + 轮询历史) ────────────────────────────
{
  try {
    const started = await api('POST', '/api/chat/start', { token: T, body: { prompt: '用一句话说明:工业时序诊断中,慢漂移与突跳的根因先验有什么不同?', harness: 'mock', title: 'aw-scen-chat' } })
    const sd = unwrap(started)
    const chatId = sd?.chatId ?? sd?.id
    check('S5 chat 会话创建', started.status === 200 && Boolean(chatId), `HTTP ${started.status}`)
    if (chatId) {
      const deadline = Date.now() + 120_000
      let reply = ''
      while (Date.now() < deadline) {
        await new Promise(r => setTimeout(r, 2000))
        const h = unwrap(await api('GET', `/api/chat/history/${chatId}`, { token: T }))
        const msgs = h?.messages ?? h?.history ?? []
        const last = Array.isArray(msgs) ? [...msgs].reverse().find(m => (m.role ?? m.message?.role) === 'assistant') : null
        reply = String(last?.content ?? last?.message?.content ?? '')
        if (reply) break
      }
      check('S5 chat 助手回复到达', reply.length > 0, reply.slice(0, 100))
    }
  }
  catch (err) {
    check('S5 chat 会话', false, err.message)
  }
}

// ── S6(可选)真实 omp 引擎单场景 ──────────────────────────────────────────
if (REAL) {
  const p = join(OUT, 's6.csv')
  writeFileSync(p, driftCross(0))
  const [path] = await upload([p], 'aw-scen/s6')
  await scenario('S6 真实 omp 漂移越限', { dataPath: path, sceneName: 'real_omp', harness: 'omp', userQuestion: '温度缓慢漂移越限根因诊断(真实引擎全管线)' }, undefined)
}

console.log(`\n═══ IDD 场景实测:${passed} 过 / ${failed} 挂(目录 ${OUT})═══`)
if (!REAL) console.log('(提示:--real 可加跑真实 omp 引擎场景,3~12 分钟)')
try { rmSync(OUT, { recursive: true, force: true }) } catch { /* 报告在 IDD 侧,临时目录可清 */ }
process.exit(failed === 0 ? 0 : 1)
