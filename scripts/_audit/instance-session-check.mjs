#!/usr/bin/env node
/**
 * instance-session-check.mjs —— 任务级多会话证据核查(AC-J10)。
 * 找到指定项目(或最新的 注塑工艺协同优化* 项目)的任务实例 Channel,断言其存在 channel_sessions 会话行。
 * 用法:node scripts/_audit/instance-session-check.mjs --base http://127.0.0.1:4001 [--project <pid>]
 * 证据:docs/audit/evidence/2026-11-08-multisession-opt/instance-sessions.json
 */
import { writeFileSync, mkdirSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = resolve(HERE, '..', '..')
const args = process.argv.slice(2)
const arg = (k, d) => { const i = args.indexOf(`--${k}`); return i >= 0 ? (args[i + 1] ?? '') : d }
const base = (arg('base', process.env.AW_BASE ?? 'http://127.0.0.1:4001')).replace(/\/$/, '')
const EVID = resolve(arg('out', join(REPO, 'docs/audit/evidence/2026-11-08-multisession-opt')))
mkdirSync(EVID, { recursive: true })

let token = ''
async function api(method, path, body) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const j = await res.json().catch(() => null)
  return { status: res.status, data: j?.data, message: j?.message ?? '' }
}

const results = []
const step = (id, name, ok, detail = '') => {
  results.push({ id, name, pass: Boolean(ok), detail: String(detail ?? '').slice(0, 600) })
  console.log(`${ok ? '✔' : '✖'} [${id}] ${name} ${String(detail).slice(0, 200)}`)
}

async function main() {
  token = (await api('POST', '/api/users/login', { email: 'admin@awshop.local', password: 'admin123' })).data?.token ?? ''
  if (!token) { step('I0', '登录', false, 'login failed'); return finish() }
  let pid = arg('project', '')
  if (!pid) {
    const projects = (await api('GET', '/api/workshop/projects')).data ?? []
    const mine = projects.filter(p => String(p.name ?? '').startsWith('注塑工艺协同优化')).sort((a, b) => String(b.createdAt ?? '').localeCompare(String(a.createdAt ?? '')))
    pid = mine[0]?.id
    step('I1', '定位协同优化项目', Boolean(pid), `pid=${String(pid ?? '').slice(0, 8)} name=${mine[0]?.name ?? '?'}`)
    if (!pid) return finish()
  }
  const obs = (await api('GET', `/api/workshop/projects/${pid}/observability`)).data
  const wis = obs?.workItems ?? []
  const instChannels = [...new Set(wis.map(w => w.instanceChannelId).filter(Boolean))]
  step('I2', '工作项均持有任务实例 Channel', instChannels.length >= 1 && wis.every(w => Boolean(w.instanceChannelId)),
    `workItems=${wis.length} instanceChannels=${instChannels.length}`)
  if (!instChannels.length) return finish()
  // 实例 Channel 的会话行:任务级多会话(PR#69/#70)在 DB 的落地形态
  const allSessions = []
  for (const ch of instChannels) {
    const rows = (await api('GET', `/api/workshop/channels/${ch}/sessions`)).data ?? []
    allSessions.push({ channelId: ch, sessions: rows.map(s => ({ id: s.id, status: s.status, title: s.title ?? '' })) })
  }
  const withSessions = allSessions.filter(x => x.sessions.length >= 1)
  step('I3', '任务实例 Channel 存在会话行(任务级多会话)', withSessions.length === instChannels.length,
    allSessions.map(x => `${String(x.channelId).slice(0, 8)}:${x.sessions.length}行`).join(' '))
  finish()
}

function finish() {
  const pass = results.length > 0 && results.every(r => r.pass)
  writeFileSync(join(EVID, 'instance-sessions.json'), JSON.stringify({ at: new Date().toISOString(), base, pass: results.filter(r => r.pass).length, fail: results.filter(r => !r.pass).length, results }, null, 2))
  console.log(`\n判定: ${pass ? 'PASS' : 'FAIL'} (${results.filter(r => r.pass).length}/${results.length})`)
  process.exitCode = pass ? 0 : 1
}

main().catch(e => { console.error('FAIL:', e?.message ?? e); process.exitCode = 1 })
