#!/usr/bin/env node
/**
 * omp-project-single-live.mjs —— omp(ustc/deepseek-flash) 单工作项项目全链（长预算）。
 *
 * 背景：2026-11-09 实机测得该 provider 单回合 40s–4min；两个任务并行会互相拖慢。
 * 本脚本只跑「一个工作项」全链，预算 25 分钟，用于补证「omp 在 Project 任务实例里
 * 真的完成 LLM 交付」这一段；Channel/会话隔离证据见 omp-channel-project-session-live。
 */
import { spawn } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = resolve(HERE, '..', '..')
const STAMP = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)
const OUT = resolve(REPO, 'docs/audit/evidence/2026-11-09-omp-channel-project-session')
mkdirSync(OUT, { recursive: true })
const HOME = join(tmpdir(), `aw-omp-single-${STAMP}`)
mkdirSync(HOME, { recursive: true })
const PORT = Number(process.env.OMP_PORT ?? 3157)
const BASE = `http://127.0.0.1:${PORT}`
process.env.NO_PROXY = '127.0.0.1,localhost'
const sleep = ms => new Promise(r => setTimeout(r, ms))
const results = []
const ok = (id, name, cond, detail = '') => {
  results.push({ id, name, pass: Boolean(cond), detail: String(detail).slice(0, 600) })
  console.log(`${cond ? '✔' : '✖'} [${id}] ${name}${detail ? ` · ${String(detail).slice(0, 220)}` : ''}`)
}
async function api(method, path, body, token, timeoutMs = 120_000) {
  const res = await fetch(BASE + path, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  })
  const j = await res.json().catch(() => null)
  return { status: res.status, data: j?.data, message: j?.message ?? '' }
}
async function waitFor(fn, { timeout = 1_500_000, interval = 5000, label = 'condition' } = {}) {
  const t0 = Date.now()
  let last
  while (Date.now() - t0 < timeout) {
    try { const v = await fn(); if (v) return v; last = v }
    catch (e) { last = e }
    await sleep(interval)
  }
  throw new Error(`${label} 超时 ${timeout}ms (last=${String(last?.message ?? last).slice(0, 160)})`)
}

let child = null
try {
  console.log(`\n=== omp 单工作项 Project 全链 · port=${PORT} · home=${HOME} ===\n`)
  child = spawn(process.execPath, [join(REPO, '.output/server/index.mjs')], {
    cwd: REPO,
    env: { ...process.env, PORT: String(PORT), NITRO_PORT: String(PORT), AW_MODE: 'home', AW_HOME: HOME,
      NUXT_SESSION_PASSWORD: 'OmpSingle#2026-key-0123456789abcdef', BACKUP_DISABLED: '1', NO_PROXY: '127.0.0.1,localhost' },
    stdio: ['ignore', 'ignore', 'ignore'], windowsHide: true,
  })
  const healthy = await waitFor(async () => {
    const h = await api('GET', '/api/health', undefined, undefined, 3000).catch(() => null)
    return h?.data?.status === 'ok' && h?.data?.workshop === 'ready'
  }, { timeout: 120_000, interval: 1000, label: 'ready' }).catch(() => false)
  ok('S1', '隔离实例启动', healthy, `port=${PORT}`)
  if (!healthy) throw new Error('not ready')

  const reg = await api('POST', '/api/users/register', { name: 'single-owner', email: 'owner@single.local', password: 'Owner#2026' })
  const token = reg.data?.token
  const rev = await api('POST', '/api/users', { name: 'single-reviewer', email: 'rev@single.local', password: 'Review#2026', role: 'admin' }, token)
  const revTok = (await api('POST', '/api/users/login', { email: 'rev@single.local', password: 'Review#2026' })).data?.token
  ok('S2', 'owner/reviewer 账号', Boolean(token && revTok), `create=${rev.status}`)

  // effort=low：仍是 ustc/deepseek-flash，但降低 reasoning 预算（该 provider 单回合 40s–4min）
  const ch = await api('POST', '/api/workshop/channels', {
    name: `omp单任务-${STAMP.slice(-5)}`,
    leadAgent: { name: 'OMP Lead', harness: 'omp', config: { provider: 'ustc', model: 'deepseek-flash', effort: 'low' } },
  }, token)
  const cid = ch.data?.channelId
  ok('S3', 'omp Channel（deepseek-flash / effort=low）', ch.status === 200, `channel=${cid}`)

  const pj = await api('POST', '/api/workshop/projects', {
    name: `omp单任务项目-${STAMP.slice(-5)}`,
    objective: 'omp 单工作项 LLM 真实交付验收',
    leaderHarness: 'omp',
    leaderConfig: { provider: 'ustc', model: 'deepseek-flash', effort: 'low' },
    routingPolicy: 'legacy',
  }, token)
  const pid = pj.data?.id
  ok('S4', 'Project（Leader=omp/deepseek-flash）', pj.status === 200, `project=${pid}`)
  await api('POST', `/api/workshop/projects/${pid}/channels`, { channelId: cid, charter: 'omp 单任务' }, token)
  const d = await api('POST', `/api/workshop/projects/${pid}/deliverables`, { name: 'omp 交付物', ownerChannelId: cid, acceptanceCriteria: ['artifact 含 PROJECT-SINGLE-OK'] }, token)
  const w = await api('POST', `/api/workshop/projects/${pid}/work-items`, {
    deliverableId: d.data.id, channelId: cid, title: 'omp 单工作项',
    brief: '立即调用 complete_task，artifact 文本严格为 PROJECT-SINGLE-OK。不要调用其他工具，不要解释。',
    execBudgetMinutes: 30, dedupeKey: `omp-single-${STAMP}`,
  }, token)
  const wid = w.data?.id
  ok('S5', '交付物+工作项创建', d.status === 200 && w.status === 200, `wi=${wid}`)
  const act = await api('POST', `/api/workshop/projects/${pid}/activate`, {}, token)
  ok('S6', '项目激活', act.status === 200 && act.data?.status === 'active', act.data?.status)
  const pr = await api('POST', `/api/workshop/projects/${pid}/plan/request-approval`, { version: 1, plan: { facts: ['single'] } }, token)
  const ap = (await api('GET', `/api/workshop/projects/${pid}/approvals`, undefined, token)).data?.find(a => a.kind === 'plan_approval' && a.status === 'pending')
  if (ap) await api('POST', `/api/workshop/projects/${pid}/approvals/${ap.id}/decide`, { approve: true }, token)
  ok('S7', '计划门通过（planVersion=1）', pr.status === 200 && Boolean(ap), `request=${pr.status}`)

  const disp = await api('POST', `/api/workshop/projects/${pid}/work-items/${wid}/dispatch`, {}, token, 60_000)
  ok('S8', '工作项派发（任务实例）', disp.status === 200, `status=${disp.status} ${disp.message}`)
  const t0 = Date.now()
  const completed = await waitFor(async () => {
    const r = await api('GET', `/api/workshop/projects/${pid}/work-items`, undefined, token)
    const wi = (r.data ?? []).find(x => x.id === wid)
    if ((Date.now() - t0) % 60_000 < 6000) console.log(`  · ${Math.round((Date.now() - t0) / 1000)}s state=${wi?.state} stage=${wi?.stateReason ?? ''}`)
    return wi?.state === 'COMPLETED' ? wi : null
  }, { timeout: 1_500_000, interval: 5000, label: 'LLM task' }).catch(() => null)
  ok('S9', 'omp 真实执行：工作项 COMPLETED', completed?.state === 'COMPLETED', `elapsed=${Math.round((Date.now() - t0) / 1000)}s`)

  if (completed) {
    await api('POST', `/api/workshop/projects/${pid}/reconcile`, {}, token)
    const draft = await waitFor(async () => {
      const r = await api('GET', `/api/workshop/projects/${pid}/results`, undefined, token)
      return (r.data ?? []).find(x => x.workItemId === wid) ?? null
    }, { timeout: 90_000, interval: 3000, label: 'draft' }).catch(() => null)
    ok('S10', '对账生成成果 draft', Boolean(draft), `status=${draft?.status}`)
    const chain = await api('GET', `/api/workshop/projects/${pid}/observability/work-items/${wid}`, undefined, token)
    const art = JSON.stringify(chain.data?.attempts ?? [])
    ok('S11', 'artifact 含 PROJECT-SINGLE-OK', art.includes('PROJECT-SINGLE-OK'), art.slice(0, 200))
    if (draft) {
      const sub = await api('POST', `/api/workshop/projects/${pid}/results/${draft.id}/submit`, { summary: 'omp 单任务真实交付' }, token)
      const rv = await api('POST', `/api/workshop/projects/${pid}/results/${draft.id}/review`, { decision: 'reviewed', reason: 'L1 复核：artifact 符合' }, revTok)
      ok('S12', '成果提交+L1复核', sub.status === 200 && rv.status === 200, `submit=${sub.status} review=${rv.status}`)
      await api('POST', `/api/workshop/projects/${pid}/results/${draft.id}/request-acceptance`, {}, token)
      const acc = await waitFor(async () => {
        const r = await api('GET', `/api/workshop/projects/${pid}/approvals`, undefined, token)
        return (r.data ?? []).find(a => a.kind === 'deliverable_acceptance' && a.status === 'pending') ?? null
      }, { timeout: 60_000, interval: 2000, label: 'acceptance' }).catch(() => null)
      if (acc) await api('POST', `/api/workshop/projects/${pid}/approvals/${acc.id}/decide`, { approve: true }, revTok)
      const done = await api('POST', `/api/workshop/projects/${pid}/complete`, {}, token)
      const cap = await waitFor(async () => {
        const r = await api('GET', `/api/workshop/projects/${pid}/approvals`, undefined, token)
        return (r.data ?? []).find(a => a.kind === 'project_complete' && a.status === 'pending') ?? null
      }, { timeout: 60_000, interval: 2000, label: 'complete approval' }).catch(() => null)
      if (cap) await api('POST', `/api/workshop/projects/${pid}/approvals/${cap.id}/decide`, { approve: true }, revTok)
      const final = await waitFor(async () => {
        const r = await api('GET', `/api/workshop/projects/${pid}`, undefined, token)
        return r.data?.status === 'completed' ? r.data : null
      }, { timeout: 60_000, interval: 2000, label: 'completed' }).catch(() => null)
      ok('S13', 'Project completed', final?.status === 'completed', `complete=${done.status}`)
    }
  }

  const fail = results.filter(r => !r.pass).length
  const summary = { generatedAt: new Date().toISOString(), base: BASE, home: HOME, harness: 'omp/ustc/deepseek-flash effort=low', verdict: fail === 0 ? 'PASS' : 'FAIL', pass: results.length - fail, fail, results }
  writeFileSync(join(OUT, 'omp-single-report.json'), JSON.stringify(summary, null, 2))
  console.log(`\n=== OMP SINGLE ${summary.verdict} pass=${summary.pass} fail=${fail} ===`)
  process.exitCode = fail > 0 ? 1 : 0
}
catch (e) {
  console.error('OMP SINGLE 异常:', e?.stack ?? e)
  writeFileSync(join(OUT, 'omp-single-report.json'), JSON.stringify({ at: new Date().toISOString(), verdict: 'FAIL', error: String(e?.message ?? e), results }, null, 2))
  process.exitCode = 1
}
finally {
  try { child?.kill() } catch { /* ignore */ }
  await sleep(300)
  process.exit(process.exitCode ?? 0)
}
