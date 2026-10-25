#!/usr/bin/env node
/**
 * A11 重启持久性抽检:复用上一轮 live 实例的 home,重启服务后
 * 规格/Profile/绑定仍在,且用同一绑定可再次求解。
 */
import { spawn } from 'node:child_process'
import { existsSync, openSync, writeFileSync, mkdirSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import { DatabaseSync } from 'node:sqlite'

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const HOME = resolve(process.env.AW_E2E_HOME || join(tmpdir(), 'aw-optimizer-live-e2e', 'home'))
const EVID = resolve(process.env.AW_E2E_EVIDENCE_DIR || join(REPO, 'docs', 'audit', 'evidence', '2026-10-23-optimizer-live'))
mkdirSync(EVID, { recursive: true })
if (!existsSync(join(HOME, 'data', 'workshop.sqlite'))) throw new Error('无持久 home 可检')
process.env.NO_PROXY = '127.0.0.1,localhost'
const out = []
const ok = (id, name, cond, detail = '') => {
  out.push({ id, name, pass: Boolean(cond), detail: String(detail).slice(0, 500) })
  console.log(`${cond ? '✔' : '✘'} [${id}] ${name}${detail ? ` — ${String(detail).slice(0, 180)}` : ''}`)
}

const db0 = new DatabaseSync(join(HOME, 'data', 'workshop.sqlite'), { readOnly: true })
const userDb = new DatabaseSync(join(HOME, 'data', 'users.sqlite'), { readOnly: true })
const email = userDb.prepare(`SELECT email FROM users WHERE role = 'admin' LIMIT 1`).get()?.email
userDb.close()
const row = db0.prepare(`SELECT b.id AS bindingId, b.channel_agent_id AS agentId, b.profile_id AS profileId,
    p.process_spec_ref AS specRef
  FROM optimizer_bindings b JOIN optimizer_profiles p ON p.id = b.profile_id AND p.version = b.profile_version
  WHERE p.status = 'published' AND p.process_spec_ref LIKE 'pms-%' AND p.process_spec_ref NOT LIKE 'pms-static-%'
  ORDER BY b.created_at DESC LIMIT 1`).get()
const spec = db0.prepare('SELECT id, version, line_id AS lineId, spec_json AS specJson FROM process_model_specs WHERE id = ? AND version = 1').get(String(row?.specRef ?? '').split('@')[0])
db0.close()
if (!email || !row || !spec) throw new Error('缺少持久资产(admin/binding/spec)')
const specObj = JSON.parse(spec.specJson)

let port = 0
for (const p of [3989, 3988, 3987]) {
  try {
    const r = await fetch(`http://127.0.0.1:${p}/api/health`, { signal: AbortSignal.timeout(800) })
    if (r.ok) continue
  }
  catch { /* 空闲 */ }
  port = p
  break
}
const BASE = `http://127.0.0.1:${port}`
const logFd = openSync(join(HOME, '..', 'restart.log'), 'a')
const child = spawn(process.execPath, [join(REPO, 'bin', 'aw.mjs'), 'dev', '--port', String(port)], {
  cwd: REPO,
  env: { ...process.env, AW_MODE: 'home', AW_HOME: HOME, AW_RATE_LIMIT_OFF: '1', NUXT_SESSION_PASSWORD: 'OptimizerLive#2026-e2e-session-key', NO_PROXY: '127.0.0.1,localhost' },
  stdio: ['ignore', logFd, logFd],
  windowsHide: true,
})
const sleep = ms => new Promise(r => setTimeout(r, ms))
let healthy = false
for (let i = 0; i < 100; i++) {
  await sleep(1500)
  try {
    const h = await fetch(`${BASE}/api/health`, { signal: AbortSignal.timeout(3000) })
    const j = await h.json()
    if (j?.data?.status === 'ok' && j?.data?.workshop === 'ready') {
      healthy = true
      break
    }
  }
  catch { /* 未就绪 */ }
}
ok('P1', '同一 home 重启后 workshop ready', healthy, `port=${port}`)
if (!healthy) {
  child.kill()
  process.exit(1)
}
const api = async (method, path, body, token) => {
  const r = await fetch(BASE + path, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(120_000),
  })
  let j = null
  try {
    j = await r.json()
  }
  catch { /* 非 JSON */ }
  return { status: r.status, ...(j ?? {}) }
}
const login = await api('POST', '/api/users/login', { email, password: 'OptLive#2026' })
const token = login?.data?.token
ok('P2', '重启后可登录(用户持久)', Boolean(token), `status=${login.status}`)
const specs = await api('GET', `/api/workshop/process-model/specs?lineId=${encodeURIComponent(spec.lineId)}`, undefined, token)
ok('P3', '规格持久可读', (specs?.data?.specs ?? []).some(s => s.id === spec.id), `n=${(specs?.data?.specs ?? []).length}`)
const profiles = await api('GET', '/api/workshop/optimization/profiles', undefined, token)
ok('P4', 'Profile 持久(含发布态)', (profiles?.data?.profiles ?? []).some(p => p.id === row.profileId && p.status === 'published'), `n=${(profiles?.data?.profiles ?? []).length}`)
const bindings = await api('GET', `/api/workshop/optimization/bindings?agentInstanceId=${encodeURIComponent(row.agentId)}`, undefined, token)
ok('P5', '绑定持久且归属不变', (bindings?.data?.bindings ?? []).some(b => b.id === row.bindingId), `n=${(bindings?.data?.bindings ?? []).length}`)

// 复写上下文尾巴(复用最近样本值,刷新时间)
const tsdb = new DatabaseSync(join(HOME, 'data', 'daq-timeseries.sqlite'))
tsdb.exec('PRAGMA busy_timeout=8000')
const beat = specObj.timing.beatMs
const tEnd = Math.floor(Date.now() / beat) * beat
const ins = tsdb.prepare(`INSERT OR IGNORE INTO daq_samples (node_id, ts_ms, value, state, line_id, product_id, recipe_id, run_id, ingested_at) VALUES (?, ?, ?, 'ok', ?, ?, ?, ?, ?)`)
tsdb.exec('BEGIN')
for (const v of specObj.variables) {
  const last = tsdb.prepare('SELECT value FROM daq_samples WHERE node_id = ? ORDER BY ts_ms DESC LIMIT 1').get(v.nodeId)
  const value = Number(last?.value ?? 50)
  for (let i = 0; i < specObj.timing.historySteps; i++) {
    ins.run(v.nodeId, tEnd - (specObj.timing.historySteps - 1 - i) * beat, value, spec.lineId, specObj.productId, specObj.recipeId, 'restart-check', Date.now())
  }
}
tsdb.exec('COMMIT')
tsdb.close()
const solve = await api('POST', '/api/workshop/optimization/solve', { agentInstanceId: row.agentId }, token)
ok('P6', '重启后同一绑定可再次求解(optimal)', solve.status === 200 && solve?.data?.result?.status === 'optimal' && Boolean(solve?.data?.runId), `status=${solve?.data?.result?.status} msg=${solve.message ?? ''}`)
const list = await api('GET', `/api/workshop/agent-tools/list?agentId=${encodeURIComponent(row.agentId)}`, undefined, token)
const names = (list?.data?.tools ?? []).map(t => t.name)
ok('P7', '重启后工具面仍按绑定注入', names.includes('optimizer_solve'), names.filter(n => n.startsWith('optimizer_')).join(','))
writeFileSync(join(EVID, 'restart-check.json'), JSON.stringify({ at: new Date().toISOString(), base: BASE, email, binding: row, spec: spec.id, results: out }, null, 2))
console.log(`restart ${out.filter(x => x.pass).length}/${out.length}`)
child.kill()
await sleep(300)
process.exit(out.every(x => x.pass) ? 0 : 1)
