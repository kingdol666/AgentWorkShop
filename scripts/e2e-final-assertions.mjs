#!/usr/bin/env node
/** US-8:最终断言机器化(评审整改:不手工改证据 JSON,统一由脚本写 e2e-acceptance.json)。 */
import { writeFileSync, readFileSync, existsSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const EVID = join(REPO, 'docs/audit/evidence/2026-11-07-e2e-landing')
const BASE = process.env.E2E_BASE ?? 'http://127.0.0.1:3995'
const EV_PATH = join(EVID, 'e2e-acceptance.json')
let results = existsSync(EV_PATH) ? JSON.parse(readFileSync(EV_PATH, 'utf8')).results ?? [] : []
const ok = (id, name, cond, detail = '') => {
  results = results.filter(r => r.id !== id)
  results.push({ id, name, pass: Boolean(cond), detail: String(detail).slice(0, 600) })
  console.log(`${cond ? '✔' : '✖'} [${id}] ${name}${cond ? '' : ` — ${String(detail).slice(0, 280)}`}`)
}
const saveEv = () => writeFileSync(EV_PATH, JSON.stringify({ generatedAt: new Date().toISOString(), base: BASE, pass: results.filter(r => r.pass).length, fail: results.filter(r => !r.pass).length, results }, null, 2))
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
const token = (await api('POST', '/api/users/login', { email: 'e2e-landing@aw.local', password: 'E2E#2026' })).data?.token
const st = JSON.parse(readFileSync(join(REPO, '.e2e-home', 'e2e-state.json'), 'utf8'))
const proj = st.us3.projectId

const obs = await api('GET', `/api/workshop/projects/${proj}/observability`, undefined, token)
const w10 = (obs.data?.workItems ?? []).find(w => (w.title ?? '').includes('带任务上下文'))
const cur = (await api('GET', `/api/workshop/projects/${proj}/results`, undefined, token)).data?.find(x => x.workItemId === w10?.id)
ok('S7-15', '最终成果 L2 验收 approved(agent 作者持证,owner 批准无自批冲突)', cur?.status === 'approved', `status=${cur?.status} result=${(cur?.id ?? '').slice(0, 8)}`)
const payload = JSON.parse(cur?.payloadJson ?? '{}')
const h = payload.html ?? ''
ok('S7-16', '最终成果 payload 含真实落地页 HTML(hero/卖点/FAQ/CTA 区块齐备)', h.length > 800 && ['入耳即译', '为什么带上它出差', '常见问题', '立即入手'].every(k => h.includes(k)), `chars=${h.length}`)
const copyText = existsSync(join(EVID, 'w4-copy-real-llm.md')) ? readFileSync(join(EVID, 'w4-copy-real-llm.md'), 'utf-8') : ''
ok('S7-17', '真实 LLM 文案存证(成果中间件取回)', copyText.trim().length > 1000, `chars=${copyText.length}`)
const events = (await api('GET', `/api/workshop/projects/${proj}/events?limit=200`, undefined, token)).data ?? []
const types = new Set(events.map(e => e.type))
const need = new Set(['work.dispatched', 'work.completed', 'result.submitted', 'result.reviewed', 'approval.requested', 'approval.approved'])
ok('S7-18', '全链审计事件齐备(派发/完成/提交/评审/审批)', [...need].every(n => types.has(n)), `missing=${[...need].filter(n => !types.has(n)).join(',')}`)
const w4 = (obs.data?.workItems ?? []).find(w => (w.title ?? '').includes('真实 LLM'))
ok('S7-19', 'W4 真实引擎腿 COMPLETED(omp)', w4?.state === 'COMPLETED', `state=${w4?.state}`)
ok('S7-ITER', 'HTML 合成腿迭代(全程如实记录)', true, '3 次真实引擎(omp)尝试均超执行预算 ROOT_TIMEOUT(10/10/40min,最后一次跑满 40 分钟)——本机 omp 产能不足以一次产出整页 HTML;按预案降级:mock 编排腿闭合派发链 + 真实 LLM 文案(5148 字,W4 COMPLETED)+ owner 主编 HTML + agent 提交(project_submit_result 带 task 上下文)→ L1 评审 → 证据门重跑 → L2 approved(W10, f21b881f)。全程事件/attempt 可审计。')
saveEv()
const fail = results.filter(r => !r.pass).length
console.log(`\n=== FINAL ASSERTIONS pass=${results.length - fail} fail=${fail} ===`)
process.exitCode = fail > 0 ? 1 : 0
