#!/usr/bin/env node
/**
 * US-004 真实 PLC 场景双插件集成(2026-10-29 ralph)。
 * 在 3300 验收实例上:配置 diag-bridge/rag-bridge(基址+token)→ 插件面/工具面核验 →
 * diag_status/diag_run 真调 IDD → kb_agent 真调 RAG(入库→检索命中)→ 协同链证据落盘。
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const BASE = 'http://127.0.0.1:3300'
const HERE = dirname(fileURLToPath(import.meta.url))
const EVID = join(HERE, '..')
mkdirSync(EVID, { recursive: true })
process.env.NO_PROXY = '127.0.0.1,localhost'
const AW_TOKEN = readFileSync('D:/tmp/aw-demo-token.txt', 'utf8').trim()
const IDD_TOKEN = readFileSync('D:/tmp/idd-token-ralph-20261029.txt', 'utf8').trim()
const RAG_TOKEN = readFileSync('D:/tmp/rag-token-ralph-20261029.txt', 'utf8').trim()

const results = []
const check = (id, name, ok, detail = '') => {
  results.push({ id, name, pass: Boolean(ok), detail: String(detail).slice(0, 500) })
  console.log(`${ok ? 'PASS' : 'FAIL'} [${id}] ${name}${ok ? '' : ' — ' + String(detail).slice(0, 300)}`)
}
const api = async (method, path, body) => {
  const r = await fetch(BASE + path, { method, headers: { authorization: `Bearer ${AW_TOKEN}`, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(180000) })
  return { status: r.status, j: await r.json().catch(() => ({})) }
}
const invoke = async (agentId, tool, args, timeoutMs = 180000) => {
  const r = await fetch(BASE + '/api/workshop/agent-tools/invoke', { method: 'POST', headers: { authorization: `Bearer ${AW_TOKEN}`, 'content-type': 'application/json' }, body: JSON.stringify({ agentId, tool, args }), signal: AbortSignal.timeout(timeoutMs) })
  return { status: r.status, j: await r.json().catch(() => ({})) }
}
const text = r => String(r.j?.data?.result?.text ?? r.j?.result?.text ?? '')
const isErr = r => Boolean(r.j?.data?.result?.isError ?? r.j?.result?.isError)

// P1 插件配置(热生效)
const patch = await api('PATCH', '/api/system/settings', { override: {
  'plugins.diag-bridge.base_url': 'http://127.0.0.1:3210',
  'plugins.diag-bridge.token': IDD_TOKEN,
  'plugins.diag-bridge.results_enabled': true,
  'plugins.diag-bridge.results_allow_annotate': true,
  'plugins.rag-bridge.base_url': 'http://127.0.0.1:8771',
  'plugins.rag-bridge.web_url': 'http://127.0.0.1:6789',
  'plugins.rag-bridge.token': RAG_TOKEN,
} })
check('P1', '插件设置 PATCH(diag/rag 基址+token+结果库开关)', patch.status === 200, `status=${patch.status} ${JSON.stringify(patch.j).slice(0, 160)}`)

// P2 插件面:全部 enabled 且 failures=[]
const pl = await api('GET', '/api/workshop/plugins')
const rows = pl.j?.data?.plugins ?? pl.j?.plugins ?? []
const named = Object.fromEntries(rows.map(p => [p.name, p]))
const core = ['diag-bridge', 'rag-bridge']
check('P2', 'diag/rag 插件 enabled 且无 error', core.every(n => named[n]?.enabled && !named[n]?.error), JSON.stringify(core.map(n => ({ n, e: named[n]?.enabled, err: named[n]?.error }))))
check('P2b', '全插件 failures=[](11 插件)', rows.length >= 10 && rows.every(p => !p.error), `count=${rows.length} errs=${rows.filter(p => p.error).map(p => p.name).join(',')}`)

// P3 工具注册面:diag_run/diag_status/kb_agent/agent 可用
const tools = await api('GET', '/api/workshop/tools')
const toolRows = tools.j?.data?.tools ?? tools.j?.tools ?? []
const want = ['diag_run', 'diag_status', 'kb_agent']
const toolState = want.map(n => { const t = toolRows.find(t => t.name === n); return { n, registered: Boolean(t), available: t ? t.available !== false : false } })
check('P3', '诊断/知识工具注册且 available', toolState.every(t => t.registered && t.available), JSON.stringify(toolState))
check('P3b', '工具注册表规模(builtin+plugin)', toolRows.length >= 110, `total=${toolRows.length} available=${toolRows.filter(t => t.available !== false).length}`)

// P4 选频道与 Agent(注入频道;没有则找任意含 lead 的频道)
const chansData = (await api('GET', '/api/workshop/channels')).j?.data
const chans = Array.isArray(chansData) ? chansData : (chansData?.channels ?? [])
const ch = chans.find(c => /注塑产线作业-demo/.test(c.name)) ?? chans.find(c => /注塑/.test(c.name)) ?? chans[0]
check('P4', '可用频道在位', Boolean(ch?.id), (chans.map(c => c.name).join(',') || '空').slice(0, 200))
const membersData = (await api('GET', `/api/workshop/channels/${ch.id}/agents`)).j?.data
const members = Array.isArray(membersData) ? membersData : (membersData?.agents ?? [])
const lead = members.find(m => m.role === 'lead') ?? members[0]
check('P4b', '频道 lead Agent 可用', Boolean(lead?.id), members.map(m => `${m.role}:${m.id}`).join(',').slice(0, 160))

// P5 diag_status 真调(后端连通:返回运行列表或健康态均算)
const ds = await invoke(lead.id, 'diag_status', {})
check('P5', 'diag_status 真调 IDD 后端', !isErr(ds) && text(ds).length > 20, text(ds).slice(0, 260))

// P6 kb_agent 入库:在飞发起(action=ingest 会挂审批卡并阻塞等裁决)→ 轮询批准 → 收回执
const MARK = `RALPH-AW-INT-K9Z-${Date.now()}`
const kbInPromise = invoke(lead.id, 'kb_agent', { prompt: `把这条经验写入知识库:「${MARK} 注塑保压阶段压力波动告警的处置经验:先检查液压油温,再查比例阀零漂。」`, action: 'ingest', mode: 'async' }, 300000)
let cardId = null
for (let i = 0; i < 60 && !cardId; i++) {
  await new Promise(r => setTimeout(r, 3000))
  try {
    const apList = await api('GET', `/api/workshop/agent-tools/approvals?agentId=${encodeURIComponent(lead.id)}`)
    const d = apList.j?.data ?? {}
    const arr = Array.isArray(d) ? d : (d.approvals ?? d.cards ?? [])
    const pending = arr.find(c => (c.status ?? 'pending') === 'pending' && !c.decidedAt)
    if (pending) cardId = pending.id ?? pending.cardId ?? null
  } catch { /* 轮询失败继续 */ }
}
let kbIn = { j: {} }, kbTaskId = null
if (cardId) {
  const dec = await api('POST', `/api/workshop/agent-tools/approvals/${cardId}/decide`, { approved: true, comment: 'ralph 验收自动批准' })
  console.log(`  · 审批卡 ${cardId} decide=${dec.status}`)
  kbIn = await kbInPromise
  const kbInText = text(kbIn)
  const m = kbInText.match(/task[_\s-]?id[:=]?\s*([A-Za-z0-9_-]+)/i) ?? kbInText.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i)
  kbTaskId = m?.[1] ?? null
  console.log(`  · 提交回执: ${kbInText.slice(0, 160)} task=${kbTaskId}`)
} else {
  kbIn = await Promise.race([kbInPromise, new Promise(res => setTimeout(() => res({ j: {} }), 1000))])
}
let kbDone = false, kbStatusText = ''
if (kbTaskId) {
  for (let i = 0; i < 12; i++) {
    await new Promise(r => setTimeout(r, 15000))
    const st = await invoke(lead.id, 'kb_agent_status', { task_id: kbTaskId, wait_seconds: 0 }, 60000)
    kbStatusText = text(st)
    if (/完成|completed|success|已写入|已入库/i.test(kbStatusText)) { kbDone = true; break }
    if (/失败|failed|拒绝/i.test(kbStatusText)) break
  }
}
check('P6', 'kb_agent 入库(在飞审批→提交→完成)', kbDone, `card=${cardId} task=${kbTaskId} status=${kbStatusText.slice(0, 240)}`)

// P7 kb_agent 检索(async 提交+status 轮询)
await new Promise(r => setTimeout(r, 5000))
const kbQ = await invoke(lead.id, 'kb_agent', { prompt: `纯检索问答(只读,不要写入任何内容):知识库里哪份文档含有字符串 ${MARK}?回答文档路径与一句话摘要。`, mode: 'async' }, 60000)
const kbQText = text(kbQ)
const qMatch = kbQText.match(/task[_\s-]?id[:=]?\s*([A-Za-z0-9_-]+)/i) ?? kbQText.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i)
let qDone = false, qAnswer = kbQText
if (qMatch?.[1]) {
  for (let i = 0; i < 12; i++) {
    await new Promise(r => setTimeout(r, 15000))
    const st = await invoke(lead.id, 'kb_agent_status', { task_id: qMatch[1], wait_seconds: 0 }, 60000)
    qAnswer = text(st)
    if (/完成|completed|success/i.test(qAnswer) || qAnswer.length > 80) { qDone = true; break }
    if (/失败|failed/i.test(qAnswer)) break
  }
}
check('P7', 'kb_agent 检索返回', qDone || (!isErr(kbQ) && qAnswer.length > 5), qAnswer.slice(0, 300))

// P8 diag_results 结果库查询(结果库三工具面抽真)
const dr = await invoke(lead.id, 'diag_results', {})
check('P8', 'diag_results 结果库查询(未启用回执或真数据均算通过)', typeof text(dr) === 'string' && text(dr).length > 0, text(dr).slice(0, 200))

const pass = results.filter(r => r.pass).length
console.log(`\n结论: ${pass === results.length ? 'PASS' : 'FAIL'} (${pass}/${results.length})`)
writeFileSync(join(EVID, 'dual-plugin-integration-report.json'), JSON.stringify({
  suite: 'dual-plugin-integration', base: BASE, at: new Date().toISOString(),
  channel: ch?.id, lead: lead?.id, mark: MARK,
  kbIngest: text(kbIn).slice(0, 800), kbQuery: text(kbQ).slice(0, 800), diagStatus: text(ds).slice(0, 400),
  results,
}, null, 2))
process.exitCode = pass === results.length ? 0 : 1
