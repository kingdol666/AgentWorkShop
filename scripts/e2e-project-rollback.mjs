#!/usr/bin/env node
/**
 * Project 层回滚演练（G6/R 演练）：真实文件级 DB 恢复。
 *
 * R0 隔离实例 → R1 基线对象（真实产线+绑线频道）→ R2 停服备份 DB 文件 →
 * R3 重启跑完整项目流（回滚目标）→ R4 停服恢复备份 → R5 重启验证（频道在/项目消失/平台健康）
 * → R6 证据 JSON 落盘。
 */
import { spawn } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, openSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const ROOT = join(tmpdir(), 'aw-project-rollback')
rmSync(ROOT, { recursive: true, force: true })
const HOME = join(ROOT, 'home')
mkdirSync(join(HOME, 'data'), { recursive: true })
const DB = join(HOME, 'data', 'workshop.sqlite')
const BACKUP_DIR = join(ROOT, 'backup')
mkdirSync(BACKUP_DIR, { recursive: true })
const EVID = join(REPO, 'docs/audit/evidence/2026-11-03-project-layer')
mkdirSync(EVID, { recursive: true })

const results = []
const ok = (id, name, cond, detail = '') => {
  results.push({ id, name, pass: Boolean(cond), detail: String(detail).slice(0, 400) })
  console.log(`${cond ? '✔' : '✖'} [${id}] ${name}${cond ? '' : ` — ${String(detail).slice(0, 300)}`}`)
}
const sleep = ms => new Promise(r => setTimeout(r, ms))

let port = 0
for (const p of [3979, 3978, 3977]) {
  try {
    const r = await fetch(`http://127.0.0.1:${p}/api/health`, { signal: AbortSignal.timeout(1000) })
    if (r.ok) continue
  }
  catch { /* free */ }
  port = p
  break
}
if (!port) throw new Error('无空闲端口')
const BASE = `http://127.0.0.1:${port}`
process.env.NO_PROXY = '127.0.0.1,localhost'

let child = null
function boot() {
  const logFd = openSync(join(ROOT, 'dev.log'), 'a')
  child = spawn(process.execPath, [join(REPO, 'bin/aw.mjs'), 'dev', '--port', String(port)], {
    cwd: REPO,
    env: {
      ...process.env,
      AW_MODE: 'home',
      AW_HOME: HOME,
      AW_RATE_LIMIT_OFF: '1',
      NUXT_SESSION_PASSWORD: 'Rollback#2026-drill-key',
      NO_PROXY: '127.0.0.1,localhost',
    },
    stdio: ['ignore', logFd, logFd],
    windowsHide: true,
  })
}

async function waitHealthy(timeoutMs = 180_000) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    try {
      const h = await api('GET', '/api/health', undefined, undefined, 3000)
      if (h.data?.status === 'ok' && h.data?.workshop === 'ready') return true
    }
    catch { /* wait */ }
    await sleep(2000)
  }
  return false
}

async function stop() {
  if (!child) return
  const c = child
  child = null
  try {
    c.kill()
  }
  catch { /* ignore */ }
  const exited = await new Promise((resolveExit) => {
    const t = setTimeout(() => resolveExit(false), 20_000)
    c.on('exit', () => {
      clearTimeout(t)
      resolveExit(true)
    })
  })
  // WAL 文件合并窗口
  await sleep(1500)
  return exited
}

async function api(method, path, body, token, timeoutMs = 120_000) {
  const res = await fetch(BASE + path, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  })
  let json = null
  try {
    json = await res.json()
  }
  catch { /* non-json */ }
  return { status: res.status, ...json }
}

function snapshotDb(label) {
  for (const suffix of ['', '-wal', '-shm']) {
    const src = `${DB}${suffix}`
    if (existsSync(src)) copyFileSync(src, join(BACKUP_DIR, `workshop.sqlite${suffix}`))
  }
  const size = statSync(DB).size
  console.log(`[backup:${label}] ${size} bytes`)
  return size
}

function restoreDb() {
  for (const suffix of ['', '-wal', '-shm']) {
    const backup = join(BACKUP_DIR, `workshop.sqlite${suffix}`)
    const live = `${DB}${suffix}`
    if (existsSync(backup)) copyFileSync(backup, live)
    else if (existsSync(live)) rmSync(live)
  }
}

try {
  // R0 boot1
  boot()
  ok('R0', '隔离实例启动（boot1）', await waitHealthy(), `port=${port}`)

  // R1 基线：真实产线 + 绑线频道
  const reg = await api('POST', '/api/users/register', { name: 'rb-admin', email: 'rb@awshop.local', password: 'Rollback#2026' })
  const token = reg.data?.token
  const line = (await api('POST', '/api/workshop/dcw/lines', { name: '回滚基线线' }, token)).data?.line?.id
  const member = (await api('POST', '/api/workshop/channels', {
    name: '回滚基线频道',
    lineId: line,
    leadAgent: { name: 'RB Lead', harness: 'mock' },
  }, token)).data
  ok('R1', '基线对象（产线+绑线频道）', Boolean(line && member?.channelId), `line=${line} ch=${member?.channelId}`)

  // R2 停服 + 备份
  ok('R2a', '停服', await stop(), 'graceful kill')
  const backupSize = snapshotDb('baseline')
  ok('R2b', 'DB 文件备份', backupSize > 0, `${backupSize} bytes`)

  // R3 重启 + 完整项目流（回滚目标状态）
  boot()
  ok('R3a', '重启（boot2）', await waitHealthy())
  const project = (await api('POST', '/api/workshop/projects', {
    name: '回滚目标项目',
    objective: '演练后应消失',
    leaderHarness: 'mock',
  }, token)).data
  const dResp = await api('POST', `/api/workshop/projects/${project.id}/deliverables`, { name: '演练交付物' }, token)
  if (!dResp.data) console.error('[diag] deliverables resp:', JSON.stringify(dResp).slice(0, 300), 'tokenHead=', String(token).slice(0, 12))
  const d = dResp.data
  const bindResp = await api('POST', `/api/workshop/projects/${project.id}/channels`, { channelId: member.channelId, charter: '回滚演练绑定' }, token)
  if (bindResp.status !== 200) console.error('[diag] bind resp:', JSON.stringify(bindResp).slice(0, 300))
  const wResp = await api('POST', `/api/workshop/projects/${project.id}/work-items`, {
    deliverableId: d.id, channelId: member.channelId, title: '演练工作项', dedupeKey: 'rb',
  }, token)
  if (!wResp.data) console.error('[diag] work-items resp:', JSON.stringify(wResp).slice(0, 300), 'channel=', member.channelId, 'deliverable=', d.id)
  const w = wResp.data
  const actResp = await api('POST', `/api/workshop/projects/${project.id}/activate`, {}, token)
  if (actResp.status !== 200) console.error('[diag] activate resp:', JSON.stringify(actResp).slice(0, 300))
  // PR13 计划门：派发前 owner 批准 v1
  const planReq = await api('POST', `/api/workshop/projects/${project.id}/plan/request-approval`, { version: 1, plan: { facts: ['rb'] } }, token)
  if (planReq.data) await api('POST', `/api/workshop/projects/${project.id}/approvals/${planReq.data.id}/decide`, { approve: true }, token)
  const disp = await api('POST', `/api/workshop/projects/${project.id}/work-items/${w.id}/dispatch`, {}, token)
  const rotate = await api('POST', `/api/workshop/channels/${member.channelId}/agents/${member.leadAgentId}/rotate-token`, {}, token)
  const tasks = await api('GET', `/api/workshop/channels/${member.channelId}/tasks`, undefined, token)
  const root = (tasks.data ?? []).find(t => t.source === 'project')
  await api('POST', `/api/workshop/tasks/${root.id}/complete`, {
    artifacts: [{ artifactId: 'rb-art', name: 'x.md', parts: [{ text: 'rb' }] }],
  }, rotate.data?.token)
  await api('POST', `/api/workshop/projects/${project.id}/reconcile`, {}, token)
  const flowOk = Boolean(project?.id && disp.status === 200 && root)
  ok('R3b', '完整项目流（派发/完成/对账）', flowOk, `project=${project?.id} disp=${disp.status}`)

  // R4 停服 + 恢复备份
  ok('R4a', '停服', await stop())
  restoreDb()
  ok('R4b', 'DB 恢复到基线备份', existsSync(DB), 'file restored')

  // R5 重启验证
  boot()
  ok('R5a', '重启（boot3）', await waitHealthy())
  const projectsAfter = (await api('GET', '/api/workshop/projects', undefined, token)).data ?? []
  const channelsAfter = (await api('GET', '/api/workshop/channels', undefined, token)).data ?? []
  const linesAfter = (await api('GET', '/api/workshop/dcw', undefined, token)).data ?? {}
  ok('R5b', '回滚生效：项目消失', Array.isArray(projectsAfter) && projectsAfter.length === 0, `projects=${projectsAfter.length}`)
  ok('R5c', '基线保留：频道仍在', Array.isArray(channelsAfter) && channelsAfter.some(c => c.id === member.channelId), `channels=${channelsAfter.length}`)
  ok('R5d', '产线业务面正常', Array.isArray(linesAfter.lines) && linesAfter.lines.some(l => l.id === line), `lines=${(linesAfter.lines ?? []).length}`)

  // R6 证据
  const summary = {
    generatedAt: new Date().toISOString(),
    port,
    pass: results.filter(r => r.pass).length,
    fail: results.filter(r => !r.pass).length,
    results,
  }
  writeFileSync(join(EVID, 'rollback-drill.json'), `${JSON.stringify(summary, null, 2)}\n`)
  console.log(`\n=== ROLLBACK pass=${summary.pass} fail=${summary.fail} ===`)
  process.exitCode = summary.fail > 0 ? 1 : 0
}
catch (err) {
  console.error('回滚演练异常:', err)
  process.exitCode = 1
}
finally {
  try {
    await stop()
  }
  catch { /* ignore */ }
}
