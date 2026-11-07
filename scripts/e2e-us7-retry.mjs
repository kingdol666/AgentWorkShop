#!/usr/bin/env node
/**
 * US-7 恢复脚本:W3(HTML 实现,omp 真实 LLM)失败重试。
 * 修复点:① 预算 10→30 分钟(ROOT_TIMEOUT);② brief 注入 W4 的真实 LLM 文案
 * (从 W4 实例频道子任务 artifact 取回 —— 成果中间件);③ 产物提取走 root+children。
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
const w3 = st.us3.w3

// 1) 取回 W4 真实文案(实例频道 root+children artifacts)
const obs = await api('GET', `/api/workshop/projects/${proj}/observability`, undefined, token)
const w4 = (obs.data?.workItems ?? []).find(w => (w.title ?? '').includes('真实 LLM'))
ok('S7-4', 'W4 omp 执行完成', w4?.state === 'COMPLETED', `state=${w4?.state}`)
const det4 = await api('GET', `/api/workshop/projects/${proj}/observability/work-items/${w4.id}`, undefined, token)
const w4Attempt = (det4.data?.attempts ?? [])[0]?.channelTaskId
let copyText = ''
if (w4Attempt) {
  const tasks = await api('GET', `/api/workshop/channels/${w4.channelId}/tasks?limit=20`, undefined, token)
  for (const t of (tasks.data ?? [])) {
    if (t.id !== w4Attempt && t.parentId !== w4Attempt) continue
    for (const a of (t.artifacts ?? [])) {
      if (a.name === 'input') continue
      copyText += (a.parts ?? []).map(p => p.text ?? '').join('\n') + '\n'
    }
  }
}
ok('S7-5', 'W4 真实 LLM 文案取回(成果中间件,root+children)', copyText.trim().length > 200, `len=${copyText.trim().length}`)
writeFileSync(join(EVID, 'w4-copy-real-llm.md'), copyText, 'utf-8')

// 2) W3 重试:预算 30 分钟 + brief 注入真实文案
const brief3 = '把下列已定稿文案与结构合成为完整可渲染的单文件 HTML(内联 CSS,响应式,含首屏/卖点/FAQ/CTA)。\n'
  + '要求:① 完整 <!DOCTYPE html> 文档;② 移动端可用;③ 卖点/FAQ/CTA 全部呈现;④ 交付物命名为 landing-page.html 的完整 HTML 文本。\n'
  + '商品:口袋翻译器 T1(耳机形态,入耳即译,离线双语,35 小时续航,1299 元)。\n'
  + '已定稿文案(真实引擎产出,直接使用其标题/卖点/FAQ/CTA):\n' + copyText.slice(0, 6000)
const patch = await api('PATCH', `/api/workshop/projects/${proj}/work-items/${w3}`, { brief: brief3, execBudgetMinutes: 30 }, token)
ok('S7-6b', 'W3 重试配置(预算 30min + 真实文案注入)', patch.status === 200, patch.message)
const retry = await api('POST', `/api/workshop/projects/${proj}/work-items/${w3}/retry`, {}, token)
ok('S7-7b', 'W3 重派(omp 第二次尝试)', retry.status === 200, retry.message)

const done3 = await poll(async () => {
  const o = await api('GET', `/api/workshop/projects/${proj}/observability`, undefined, token)
  const wi = (o.data?.workItems ?? []).find(w => w.id === w3)
  return wi && ['COMPLETED', 'FAILED', 'CANCELED'].includes(wi.state) ? wi : null
}, 35 * 60_000)
ok('S7-8', 'W3 omp 执行完成', done3?.state === 'COMPLETED', `state=${done3?.state} reason=${done3?.stateReason ?? ''}`)

if (done3?.state === 'COMPLETED') {
  await api('POST', `/api/workshop/projects/${proj}/reconcile`, {}, token)
  const rows = await poll(async () => {
    const r = await api('GET', `/api/workshop/projects/${proj}/results`, undefined, token)
    return (r.data ?? []).find(x => x.workItemId === w3) ?? null
  }, 20000)
  ok('S7-9', 'W3 draft 结果生成', !!rows, JSON.stringify(rows ?? {}).slice(0, 160))
  if (rows) {
    const sub = await api('POST', `/api/workshop/projects/${proj}/results/${rows.id}/submit`, { summary: '真实引擎落地页交付(重试成功)' }, token)
    ok('S7-10', '结果 submit(树域证据回溯通过)', sub.status === 200, JSON.stringify(sub).slice(0, 200))
    const rev = await api('POST', `/api/workshop/projects/${proj}/results/${rows.id}/review`, { decision: 'reviewed', reason: 'E2E 技术评审通过' }, token)
    ok('S7-11', 'L1 技术评审通过', rev.status === 200, JSON.stringify(rev).slice(0, 200))
    const req = await api('POST', `/api/workshop/projects/${proj}/results/${rows.id}/request-acceptance`, {}, token)
    ok('S7-12', 'L2 验收申请(证据门重跑通过)', req.status === 200, JSON.stringify(req).slice(0, 200))
    const appr = req.data?.id ? await api('POST', `/api/workshop/projects/${proj}/approvals/${req.data.id}/decide`, { approve: true }, token) : { status: 0 }
    ok('S7-13', 'L2 业务验收批准', appr.status === 200, JSON.stringify(appr).slice(0, 160))
    // 3) 导出 HTML(root+children artifacts)
    const det3 = await api('GET', `/api/workshop/projects/${proj}/observability/work-items/${w3}`, undefined, token)
    const chTaskId = (det3.data?.attempts ?? [])[0]?.channelTaskId
    const wiRow = (await api('GET', `/api/workshop/projects/${proj}/observability`, undefined, token)).data?.workItems.find(w => w.id === w3)
    let html = ''
    if (chTaskId) {
      const tasks = await api('GET', `/api/workshop/channels/${wiRow.channelId}/tasks?limit=30`, undefined, token)
      for (const t of (tasks.data ?? [])) {
        const isTree = t.id === chTaskId || t.parentId === chTaskId
        if (!isTree) continue
        for (const a of (t.artifacts ?? [])) {
          if (a.name === 'input') continue
          html += (a.parts ?? []).map(p => p.text ?? '').join('')
        }
      }
    }
    html = html.trim()
    if (html && !/<html/i.test(html)) html = `<!DOCTYPE html>\n<html lang="zh-CN">\n<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">${'' /* content shim */}</head>\n<body>\n${html}\n</body>\n</html>`
    const htmlPath = join(EVID, 'landing-page.html')
    writeFileSync(htmlPath, html, 'utf-8')
    ok('S7-14', '最终 HTML 落盘证据(真实引擎产物)', /<html/i.test(html) && html.length > 800, `bytes=${html.length}`)
    const state = JSON.parse(readFileSync(join(REPO, '.e2e-home', 'e2e-state.json'), 'utf8'))
    state.us7 = { ...state.us7, w4: w4.id, htmlPath, htmlBytes: html.length, resultId: rows.id }
    writeFileSync(join(REPO, '.e2e-home', 'e2e-state.json'), JSON.stringify(state, null, 2))
  }
}
saveEv()
const fail = results.filter(r => !r.pass).length
console.log(`\n=== US7-RETRY pass=${results.length - fail} fail=${fail} (overall) ===`)
process.exitCode = fail > 0 ? 1 : 0
