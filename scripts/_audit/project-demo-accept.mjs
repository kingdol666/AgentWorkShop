#!/usr/bin/env node
/**
 * project-demo-accept.mjs —— 项目双任务并行演示的验收快照（2026-11-07）。
 *
 * 对指定项目核验并出证：
 *   ① 两个工作项均 COMPLETED
 *   ② 每个工作项有独立实例 Channel（互不相同）+ 任务会话（kind=task，已 closed）
 *   ③ 每个工作项有成果草稿（draft）且带 artifact 证据
 *   ④ 实例 workspace 落盘文件存在（大小 + sha256 前 12 位 + 首行摘要）
 *   ⑤ observability lanes[].sessions 与 workItems 的实例/会话字段齐备
 *
 * 用法：node scripts/_audit/project-demo-accept.mjs --base http://127.0.0.1:3581 --project <id>
 */
import { writeFileSync, mkdirSync, existsSync, readFileSync, statSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = resolve(HERE, '..', '..')
const args = process.argv.slice(2)
const arg = (k, d) => { const i = args.indexOf(`--${k}`); return i >= 0 ? (args[i + 1] ?? '') : d }
const base = arg('base', 'http://127.0.0.1:3581').replace(/\/$/, '')
const projectId = arg('project', '')
const outDir = resolve(arg('out', join(REPO, 'bench', 'results', `${new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)}-project-demo-accept`)))
const workspaceRoot = resolve(REPO, 'data', 'workspaces')

let token = ''
const steps = []
const step = (name, ok, detail) => {
  steps.push({ name, ok, detail: String(detail ?? '').slice(0, 420) })
  console.log(`${ok ? '✔' : '✘'} [${name}] ${String(detail ?? '').slice(0, 300)}`)
  return ok
}
async function api(method, path, body) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  })
  const json = await res.json().catch(() => null)
  return { status: res.status, data: json?.data, message: json?.message ?? '' }
}
const sha = (buf) => createHash('sha256').update(buf).digest('hex').slice(0, 12)
const artifactOf = (dir, file) => {
  const p = join(workspaceRoot, dir, file)
  if (!existsSync(p)) return null
  const buf = readFileSync(p)
  const text = buf.toString('utf8')
  const title = (text.match(/<title>([^<]*)<\/title>/i) ?? [])[1]
    ?? (text.match(/<h1[^>]*>([^<]*)<\/h1>/i) ?? [])[1]
    ?? text.split('\n').find(l => l.trim())?.slice(0, 80)
    ?? ''
  const firstLine = text.split('\n').find(l => l.trim())?.trim().slice(0, 100) ?? ''
  return { file, path: p, bytes: statSync(p).size, sha256_12: sha(buf), title: String(title).trim().slice(0, 90), firstLine }
}

async function main() {
  token = (await api('POST', '/api/users/login', { email: 'admin@awshop.local', password: 'admin123' })).data?.token ?? ''
  if (!step('E0-auth', Boolean(token), 'owner token ok')) return finish(false)
  if (!projectId) { step('E0-project', false, '缺少 --project <id>'); return finish(false) }

  const obs = await api('GET', `/api/workshop/projects/${projectId}/observability`)
  const o = obs.data
  if (!step('E1-observability', obs.status === 200 && Boolean(o), `project=${o?.project?.name ?? '?'} status=${o?.project?.status ?? '?'}`)) return finish(false)

  const items = o.workItems ?? []
  step('E2-two-completed', items.length >= 2 && items.every(w => w.state === 'COMPLETED'),
    items.map(w => `${w.title.slice(0, 14)}=${w.state}`).join(' | '))

  const inst = items.map(w => w.instanceChannelId)
  step('E3-distinct-instances', inst.filter(Boolean).length === items.length && new Set(inst).size === items.length,
    items.map((w, i) => `${w.title.slice(0, 10)}→${String(inst[i]).slice(0, 8)}`).join(' | '))

  const sessRows = []
  for (const w of items) {
    const r = await api('GET', `/api/workshop/channels/${w.instanceChannelId}/sessions`)
    const s = (r.data ?? [])[0]
    sessRows.push({ workItemId: w.id, title: w.title, sessionId: s?.id, status: s?.status, kind: s?.instanceKind, projectId: s?.projectId, wiOk: s?.projectWorkItemId === w.id })
  }
  step('E4-task-sessions-closed', sessRows.every(s => s.kind === 'task' && s.status === 'closed' && s.wiOk && s.projectId === projectId),
    sessRows.map(s => `${s.title.slice(0, 10)}→${String(s.sessionId).slice(0, 8)}/${s.status}/${s.kind}`).join(' | '))

  const res = await api('GET', `/api/workshop/projects/${projectId}/results`)
  const results = res.data ?? []
  const withEvidence = results.filter(r => {
    try {
      const ev = JSON.parse(String(r.evidenceJson ?? '[]'))
      return Array.isArray(ev) && ev.length > 0
    }
    catch { return false }
  })
  step('E5-results-evidence', results.length >= items.length && withEvidence.length >= 2,
    `results=${results.length} 带证据=${withEvidence.length}（${results.slice(0, 3).map(r => `${String(r.title).slice(0, 12)}/${r.status}`).join(' | ')}）`)

  const artifacts = items.map(w => {
    const dir = w.instanceChannelId
    const cand = w.title.includes('pricing') ? 'pricing.html' : 'index.html'
    return { workItemId: w.id, title: w.title, instanceChannelId: dir, ...(artifactOf(dir, cand) ?? { file: cand, missing: true }) }
  })
  step('E6-artifacts-on-disk', artifacts.every(a => !a.missing),
    artifacts.map(a => a.missing ? `${a.file}=缺失` : `${a.file}=${a.bytes}B sha=${a.sha256_12} title="${a.title}"`).join(' | '))

  const lane = (o.channels ?? []).find(c => (c.sessions ?? []).length >= 2)
  step('E7-lane-sessions', Boolean(lane) && (lane.sessions ?? []).every(s => s.sessionId),
    lane ? `${lane.name} sessions=${lane.sessions.length}（${lane.sessions.map(s => `${String(s.sessionTitle).slice(0, 10)}/${s.sessionStatus}`).join(' | ')}）` : '未找到含 2 个任务会话的 lane')

  // 归档证据（供报告引用）
  const evidence = {
    at: new Date().toISOString(),
    base,
    project: { id: projectId, name: o.project?.name, status: o.project?.status },
    workItems: items.map(w => ({ id: w.id, title: w.title, state: w.state, instanceChannelId: w.instanceChannelId, sessionId: w.sessionId, sessionStatus: w.sessionStatus, result: w.lastResultStatus })),
    sessions: sessRows,
    results: results.map(r => ({ id: r.id, title: r.title, status: r.status, channelId: String(r.channelId).slice(0, 8) })),
    artifacts,
    lanes: (o.channels ?? []).map(c => ({ channelId: c.channelId, name: c.name, workItems: c.workItems, inFlight: c.inFlight, sessions: c.sessions })),
  }
  finish(steps.every(s => s.ok), evidence)
}

function finish(pass, evidence = {}) {
  mkdirSync(outDir, { recursive: true })
  const verdict = pass ? 'PASS' : 'FAIL'
  writeFileSync(join(outDir, 'project-demo-accept.json'), JSON.stringify({ verdict, steps, ...evidence }, null, 2))
  const md = [
    `# 项目双任务并行演示验收 · ${verdict}`, '',
    `- base=${base}`, `- project=${evidence?.project?.name ?? '?'} (${evidence?.project?.id ?? '?'})`, '',
    ...steps.map(s => `- ${s.ok ? '✔' : '✘'} **${s.name}** ${s.detail}`), '',
    '## 产物清单', '',
    ...(evidence.artifacts ?? []).map((a) => a.missing
      ? `- ✘ ${a.file}（缺失）`
      : `- ✔ ${a.file} — ${a.bytes} bytes, sha256:${a.sha256_12}, title: ${a.title}`), '',
  ].join('\n')
  writeFileSync(join(outDir, 'project-demo-accept.md'), md)
  console.log(`\n判定: ${verdict} → ${outDir}`)
  process.exitCode = pass ? 0 : 1
}

main().catch((err) => { console.error('FAIL:', err?.message ?? err); finish(false) })
