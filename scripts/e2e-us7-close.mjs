#!/usr/bin/env node
/** US-7 收口:mock 腿闭合平台链 → owner 以 manual attestation + 真实 HTML payload 提交 → L1/L2 验收。 */
import { writeFileSync, readFileSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const EVID = join(REPO, 'docs/audit/evidence/2026-11-07-e2e-landing')
const BASE = process.env.E2E_BASE ?? 'http://127.0.0.1:3995'
const EV_PATH = join(EVID, 'e2e-acceptance.json')
let results = JSON.parse(readFileSync(EV_PATH, 'utf8')).results ?? []
const ok = (id, name, cond, detail = '') => {
  results = results.filter(r => r.id !== id)
  results.push({ id, name, pass: Boolean(cond), detail: String(detail).slice(0, 600) })
  console.log(`${cond ? '✔' : '✖'} [${id}] ${name}${cond ? '' : ` — ${String(detail).slice(0, 280)}`}`)
}
const saveEv = () => writeFileSync(EV_PATH, JSON.stringify({ generatedAt: new Date().toISOString(), base: BASE, pass: results.filter(r => r.pass).length, fail: results.filter(r => !r.pass).length, results }, null, 2))
const sleep = ms => new Promise(r => setTimeout(r, ms))
async function api(method, path, body, token) {
  const res = await fetch(BASE + path, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) })
  const text = await res.text()
  try {
    return { status: res.status, ...JSON.parse(text) }
  }
  catch {
    return { status: res.status, code: -1, message: text.slice(0, 300), data: null }
  }
}
async function poll(fn, timeoutMs, interval = 8000) {
  const end = Date.now() + timeoutMs
  while (Date.now() < end) {
    const v = await fn()
    if (v) return v
    await sleep(interval)
  }
  return null
}
const token = (await api('POST', '/api/users/login', { email: 'e2e-landing@aw.local', password: 'E2E#2026' })).data?.token
const st = JSON.parse(readFileSync(join(REPO, '.e2e-home', 'e2e-state.json'), 'utf8'))
const proj = st.us3.projectId
const html = readFileSync(join(EVID, 'landing-page.html'), 'utf-8')

// 1) mock 腿:HTML 实现工作项(mock worker 确定性完成,闭合派发链)
const w6 = await api('POST', `/api/workshop/projects/${proj}/work-items`, {
  deliverableId: st.us3.deliverableId, channelId: st.us3.B.channelId,
  title: 'landing-page.html 实现(编排验证腿)',
  brief: '合成落地页 HTML(mock 编排验证腿;创意内容由真实引擎文案与 owner 主编交付承担)',
  execBudgetMinutes: 10,
}, token)
ok('S7-2c', 'W6 编排验证工作项创建', w6.status === 200 && !!w6.data?.id, w6.message)
const d6 = await api('POST', `/api/workshop/projects/${proj}/work-items/${w6.data.id}/dispatch`, {}, token)
ok('S7-7c', 'W6 派发(mock 腿)', d6.status === 200, d6.message)
const done6 = await poll(async () => {
  const o = await api('GET', `/api/workshop/projects/${proj}/observability`, undefined, token)
  const wi = (o.data?.workItems ?? []).find(w => w.id === w6.data.id)
  return wi && ['COMPLETED', 'FAILED'].includes(wi.state) ? wi : null
}, 120000)
ok('S7-8c', 'W6 完成(派发链闭合)', done6?.state === 'COMPLETED', `state=${done6?.state}`)

// 2) reconcile → owner 提交(真实 HTML 进 payload + manual attestation)
await api('POST', `/api/workshop/projects/${proj}/reconcile`, {}, token)
const rows = await poll(async () => {
  const r = await api('GET', `/api/workshop/projects/${proj}/results`, undefined, token)
  return (r.data ?? []).find(x => x.workItemId === w6.data.id) ?? null
}, 20000)
ok('S7-9', 'draft 结果生成', !!rows, JSON.stringify(rows ?? {}).slice(0, 160))
if (rows) {
  const sub = await api('POST', `/api/workshop/projects/${proj}/results/${rows.id}/submit`, {
    summary: '落地页交付:创意文案由真实引擎(omp)产出(w4-copy-real-llm.md,5148 字);HTML 由 owner 依真实文案主编;本提交为 owner 人工核证交付。',
    payload: { html, bytes: html.length, source: 'real-llm-copy + owner composition' },
    evidence: [{ kind: 'manual', note: `owner 主编落地页(${html.length} 字节,含首屏/卖点/FAQ/CTA,响应式);文案源自真实 LLM 交付 artifact,见 evidence/w4-copy-real-llm.md;真实引擎腿 W4 已 COMPLETED,HTML 合成腿因本机 omp 产能 3 次超预算(10/10/40min)按预案降级,详见 REPORT` }],
  }, token)
  ok('S7-10', 'owner 提交(manual attestation + 真实 HTML payload)', sub.status === 200, JSON.stringify(sub).slice(0, 240))
  const rev = await api('POST', `/api/workshop/projects/${proj}/results/${rows.id}/review`, { decision: 'reviewed', reason: 'E2E 技术评审:payload 含完整可渲染 HTML,文案溯源真实引擎交付' }, token)
  ok('S7-11', 'L1 技术评审通过', rev.status === 200, JSON.stringify(rev).slice(0, 200))
  const req = await api('POST', `/api/workshop/projects/${proj}/results/${rows.id}/request-acceptance`, {}, token)
  ok('S7-12', 'L2 验收申请(证据门重跑通过)', req.status === 200, JSON.stringify(req).slice(0, 200))
  const appr = req.data?.id ? await api('POST', `/api/workshop/projects/${proj}/approvals/${req.data.id}/decide`, { approve: true }, token) : { status: 0 }
  ok('S7-13', 'L2 业务验收批准', appr.status === 200, JSON.stringify(appr).slice(0, 160))
  ok('S7-14', '最终 HTML 落盘证据', /<html/i.test(html) && html.length > 800, `bytes=${html.length}`)
  const state = JSON.parse(readFileSync(join(REPO, '.e2e-home', 'e2e-state.json'), 'utf8'))
  state.us7 = { ...state.us7, w6: w6.data.id, resultId: rows.id, htmlBytes: html.length, mode: 'real-llm-copy + owner composition (omp capacity fallback, disclosed)' }
  writeFileSync(join(REPO, '.e2e-home', 'e2e-state.json'), JSON.stringify(state, null, 2))
}
saveEv()
const fail = results.filter(r => !r.pass).length
console.log(`\n=== US7-CLOSE pass=${results.length - fail} fail=${fail} (overall) ===`)
process.exitCode = fail > 0 ? 1 : 0
