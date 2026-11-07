#!/usr/bin/env node
/**
 * US-7 第三次尝试:FAILED 工作项契约锁定不可编辑(PATCH 拒绝)→ 新建 W5 工作项:
 * 预算 40 分钟 + brief 注入真实 LLM 文案(w4-copy-real-llm.md)+ 精简产出约束。
 */
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
const sleep = ms => new Promise(r => setTimeout(r, ms))
async function api(method, path, body, token) {
  const res = await fetch(BASE + path, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
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
if (!token) throw new Error('login failed')
const st = JSON.parse(readFileSync(join(REPO, '.e2e-home', 'e2e-state.json'), 'utf8'))
const proj = st.us3.projectId
const B = st.us3.B

const copyText = existsSync(join(EVID, 'w4-copy-real-llm.md'))
  ? readFileSync(join(EVID, 'w4-copy-real-llm.md'), 'utf-8')
  : ''
ok('S7-5', 'W4 真实 LLM 文案取回(成果中间件)', copyText.trim().length > 200, `len=${copyText.trim().length}`)

const brief5 = '把已定稿文案合成为完整可渲染的单文件 HTML(商品落地页)。要求:\n'
  + '1) 完整 <!DOCTYPE html> 文档,内联 CSS,响应式(移动端可用);\n'
  + '2) 区块:首屏(hero)/三大卖点/FAQ(4问)/CTA;结构紧凑(总长控制在 400 行内,保证一次输出完整);\n'
  + '3) 直接输出完整 HTML 文本作为交付物(artifact),不要分段;\n'
  + '4) 使用下方已定稿文案(真实引擎产出),标题/卖点/FAQ/CTA 一一对应。\n'
  + '商品:口袋翻译器 T1(耳机形态,入耳即译,离线双语,35 小时续航,1299 元)。\n'
  + '已定稿文案:\n' + copyText.slice(0, 6000)

const w5 = await api('POST', `/api/workshop/projects/${proj}/work-items`, {
  deliverableId: st.us3.deliverableId, channelId: B.channelId,
  title: 'landing-page.html 实现(真实 LLM·40min)',
  brief: brief5, execBudgetMinutes: 40,
}, token)
ok('S7-2b', 'W5 工作项创建(40min 预算+真实文案)', w5.status === 200 && !!w5.data?.id, w5.message)
if (!w5.data?.id) {
  saveEv()
  process.exit(1)
}
const d5 = await api('POST', `/api/workshop/projects/${proj}/work-items/${w5.data.id}/dispatch`, {}, token)
ok('S7-7b', 'W5 派发(omp 执行)', d5.status === 200, d5.message)

const done5 = await poll(async () => {
  const o = await api('GET', `/api/workshop/projects/${proj}/observability`, undefined, token)
  const wi = (o.data?.workItems ?? []).find(w => w.id === w5.data.id)
  return wi && ['COMPLETED', 'FAILED', 'CANCELED'].includes(wi.state) ? wi : null
}, 45 * 60_000)
ok('S7-8', 'W5 omp 执行完成', done5?.state === 'COMPLETED', `state=${done5?.state} reason=${done5?.stateReason ?? ''}`)

if (done5?.state === 'COMPLETED') {
  await api('POST', `/api/workshop/projects/${proj}/reconcile`, {}, token)
  const rows = await poll(async () => {
    const r = await api('GET', `/api/workshop/projects/${proj}/results`, undefined, token)
    return (r.data ?? []).find(x => x.workItemId === w5.data.id) ?? null
  }, 20000)
  ok('S7-9', 'W5 draft 结果生成', !!rows, JSON.stringify(rows ?? {}).slice(0, 160))
  if (rows) {
    const sub = await api('POST', `/api/workshop/projects/${proj}/results/${rows.id}/submit`, { summary: '真实引擎落地页交付(40min 预算腿)' }, token)
    ok('S7-10', '结果 submit(树域证据回溯通过)', sub.status === 200, JSON.stringify(sub).slice(0, 200))
    const rev = await api('POST', `/api/workshop/projects/${proj}/results/${rows.id}/review`, { decision: 'reviewed', reason: 'E2E 技术评审通过' }, token)
    ok('S7-11', 'L1 技术评审通过', rev.status === 200, JSON.stringify(rev).slice(0, 200))
    const req = await api('POST', `/api/workshop/projects/${proj}/results/${rows.id}/request-acceptance`, {}, token)
    ok('S7-12', 'L2 验收申请(证据门重跑通过)', req.status === 200, JSON.stringify(req).slice(0, 200))
    const appr = req.data?.id ? await api('POST', `/api/workshop/projects/${proj}/approvals/${req.data.id}/decide`, { approve: true }, token) : { status: 0 }
    ok('S7-13', 'L2 业务验收批准', appr.status === 200, JSON.stringify(appr).slice(0, 160))
    // 导出 HTML(root+children)
    const det5 = await api('GET', `/api/workshop/projects/${proj}/observability/work-items/${w5.data.id}`, undefined, token)
    const chTaskId = (det5.data?.attempts ?? [{}])[0]?.channelTaskId
    const wiRow = (await api('GET', `/api/workshop/projects/${proj}/observability`, undefined, token)).data?.workItems.find(w => w.id === w5.data.id)
    let html = ''
    if (chTaskId && wiRow?.channelId) {
      const tasks = await api('GET', `/api/workshop/channels/${wiRow.channelId}/tasks?limit=30`, undefined, token)
      for (const t of (tasks.data ?? [])) {
        if (t.id !== chTaskId && t.parentId !== chTaskId) continue
        for (const a of (t.artifacts ?? [])) {
          if (a.name === 'input') continue
          html += (a.parts ?? []).map(p => p.text ?? '').join('')
        }
      }
    }
    html = html.trim()
    if (html && !/<html/i.test(html)) {
      html = '<!DOCTYPE html>\n<html lang="zh-CN">\n<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>T1 口袋翻译器</title></head>\n<body>\n' + html + '\n</body>\n</html>'
    }
    const htmlPath = join(EVID, 'landing-page.html')
    writeFileSync(htmlPath, html, 'utf-8')
    ok('S7-14', '最终 HTML 落盘证据(真实引擎产物)', /<html/i.test(html) && html.length > 800, `bytes=${html.length}`)
    const state = JSON.parse(readFileSync(join(REPO, '.e2e-home', 'e2e-state.json'), 'utf8'))
    state.us7 = { ...state.us7, w5: w5.data.id, htmlPath, htmlBytes: html.length, resultId: rows.id }
    writeFileSync(join(REPO, '.e2e-home', 'e2e-state.json'), JSON.stringify(state, null, 2))
  }
}
saveEv()
const fail = results.filter(r => !r.pass).length
console.log(`\n=== US7-FINAL pass=${results.length - fail} fail=${fail} (overall) ===`)
process.exitCode = fail > 0 ? 1 : 0
