#!/usr/bin/env node
/* eslint-disable @stylistic/max-statements-per-line */
/**
 * e2e-idd-results —— diag-bridge 结果库集成真机验收(A2-A13)。
 *
 * 前置:演示实例 3300(admin token 在 D:/tmp/aw-demo-token.txt;频道「注塑产线作业-demo」
 * 含 lead/worker Agent)+ 真实 IDD 后端 3210(results_demo 的 idd_ token 在 D:/tmp/idd-token.txt)。
 * 运行:node scripts/e2e-idd-results.mjs [--base http://127.0.0.1:3300]
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

const BASE = process.argv.includes('--base') ? process.argv[process.argv.indexOf('--base') + 1] : 'http://127.0.0.1:3300'
const AW_TOKEN = readFileSync('D:/tmp/aw-demo-token.txt', 'utf8').trim()
const IDD_TOKEN = readFileSync('D:/tmp/idd-token.txt', 'utf8').trim()
const EVID = 'docs/audit/evidence/2026-10-25-idd-results'
mkdirSync(EVID, { recursive: true })
process.env.NO_PROXY = '127.0.0.1,localhost'

const results = []
function check(id, name, ok, detail = '') {
  results.push({ id, name, pass: Boolean(ok), detail: String(detail).slice(0, 400) })
  console.log(`${ok ? '✔' : '✖'} [${id}] ${name}${ok ? '' : ` — ${String(detail).slice(0, 300)}`}`)
}
const H = { 'authorization': `Bearer ${AW_TOKEN}`, 'content-type': 'application/json' }
const api = async (method, path, body) => {
  const r = await fetch(BASE + path, { method, headers: H, body: body === undefined ? undefined : JSON.stringify(body) })
  return { status: r.status, j: await r.json().catch(() => ({})) }
}
const invoke = async (agentId, tool, args) => api('POST', '/api/workshop/agent-tools/invoke', { agentId, tool, args })
const text = r => String(r.j?.data?.result?.text ?? r.j?.result?.text ?? '')
const isErr = r => Boolean(r.j?.data?.result?.isError ?? r.j?.result?.isError)
const patchSettings = async kv => api('PATCH', '/api/system/settings', { override: kv })

// ── 0) 环境与身份 ──
const chansData = (await api('GET', '/api/workshop/channels')).j?.data
const chans = Array.isArray(chansData) ? chansData : (chansData?.channels ?? [])
const ch = chans.find(c => /注塑/.test(c.name))
check('A0.1', '演示频道在线', Boolean(ch), chans.map(c => c.name).join(','))
const membersData = (await api('GET', `/api/workshop/channels/${ch.id}/agents`)).j?.data
const members = Array.isArray(membersData) ? membersData : (membersData?.agents ?? [])
const lead = members.find(m => m.role === 'lead') ?? members[0]
check('A0.2', '频道 Agent 可用', Boolean(lead?.id), JSON.stringify(members.map(m => [m.id, m.role])))

// ── A2 关闭态:三工具都短路且不发起 HTTP ──
await patchSettings({ 'plugins.diag-bridge.results_enabled': false, 'plugins.diag-bridge.results_allow_annotate': false })
const off1 = await invoke(lead.id, 'diag_results', {})
const off2 = await invoke(lead.id, 'diag_result_get', { result_id: 'whatever' })
const off3 = await invoke(lead.id, 'diag_result_annotate', { result_id: 'whatever', description: 'x' })
check('A2.1', '关闭态 diag_results → 未启用回执', isErr(off1) && text(off1).includes('未启用'), text(off1).slice(0, 120))
check('A2.2', '关闭态 diag_result_get → 未启用回执', isErr(off2) && text(off2).includes('未启用'), text(off2).slice(0, 120))
check('A2.3', '关闭态 annotate → 未启用回执', isErr(off3) && text(off3).includes('未启用'), text(off3).slice(0, 120))

// ── 开启:总开关 + token + (暂不开 annotate) ──
await patchSettings({
  'plugins.diag-bridge.base_url': 'http://127.0.0.1:3210',
  'plugins.diag-bridge.token': IDD_TOKEN,
  'plugins.diag-bridge.results_enabled': true,
})

// ── A3 索引与 brief ──
const idx = await invoke(lead.id, 'diag_results', {})
const idxText = text(idx)
check('A3.1', 'diag_results 返回 total/limit/offset', !isErr(idx) && /total=\d+ limit=\d+ offset=\d+/.test(idxText), idxText.slice(0, 160))
const idxBrief = await invoke(lead.id, 'diag_results', { limit: 3 })
check('A3.2', 'brief 默认 true(文本含 brief=true)', !isErr(idxBrief) && text(idxBrief).includes('brief=true'), text(idxBrief).slice(0, 120))
// brief=false 时卡片必须带 key_numbers(IDD 在非 brief 模式返回该字段)
const idxFull = await invoke(lead.id, 'diag_results', { limit: 5, brief: false })
const fullText = text(idxFull)
check('A3.3', 'brief=false 卡片带 key_numbers', !isErr(idxFull) && fullText.includes('key_numbers='), fullText.slice(0, 260))
const firstId = (idxText.match(/^- (\w+) \|/m) ?? [])[1]
check('A3.4', '可从索引文本解析首个 result_id', Boolean(firstId), idxText.slice(0, 200))

// ── A4 过滤 ──
const qR = await invoke(lead.id, 'diag_results', { q: '注入' })
check('A4.1', 'q 过滤正常返回', !isErr(qR), text(qR).slice(0, 120))
const intentR = await invoke(lead.id, 'diag_results', { intent: 'stability-report', limit: 5 })
check('A4.2', 'intent 过滤:仅含 stability-report 行', !isErr(intentR) && !text(intentR).includes('| deep-diagnosis |'), text(intentR).slice(0, 200))
const scoreR = await invoke(lead.id, 'diag_results', { min_score: 90, limit: 5 })
check('A4.3', 'min_score 过滤正常', !isErr(scoreR), text(scoreR).slice(0, 120))
const sortR = await invoke(lead.id, 'diag_results', { sort: 'score_desc', limit: 3 })
check('A4.4', 'score_desc 排序正常', !isErr(sortR), text(sortR).slice(0, 120))
const badSort = await invoke(lead.id, 'diag_results', { sort: 'bogus' })
check('A4.5', '非法 sort → RESULTS_QUERY_INVALID 中文指引', isErr(badSort) && text(badSort).includes('查询参数非法'), text(badSort).slice(0, 160))

// ── A5 详情 ──
const det = await invoke(lead.id, 'diag_result_get', { result_id: firstId })
const detText = text(det)
check('A5.1', '详情默认不带 md 正文、报告 URL 已绝对化',
  !isErr(det) && /报告=http:\/\/127\.0\.0\.1:3210\//.test(detText) && !detText.includes('report.md:\n'), detText.slice(0, 220))
const detMd = await invoke(lead.id, 'diag_result_get', { result_id: firstId, include_md: true })
const mdText = text(detMd)
check('A5.2', 'include_md=true 携带 md 且遵守截断上限', !isErr(detMd) && mdText.includes('report.md'), mdText.slice(0, 160))

// ── A9 截断真实触发:现有库内报告 ~545 字符,用 500 下限截断它 ──
// ── A9 长报告截断(全库扫描候选,优先已知长样本;避免依赖短 mock 报告) ──
const longCandidates = (text(await invoke(lead.id, 'diag_results', { limit: 200 })).match(/^- (\w+) \|/gm) ?? [])
  .map(line => line.replace(/^- /, '').replace(/ \|.*$/, ''))
const probeOrder = [...new Set(['46894aff', firstId, ...longCandidates].filter(Boolean))].slice(0, 16)
let longId = null
for (const id of probeOrder) {
  const probe = await invoke(lead.id, 'diag_result_get', { result_id: id, include_md: true, md_max_chars: 50000 })
  const m = /截断 50000\/(\d+)/.exec(text(probe))
  if (m && Number(m[1]) > 600) { longId = id; break }
  // 未触发 50000 截断:用输出总量估算 md 长度(头部字段约 300 字符)
  if (!m && text(probe).length > 1200) { longId = id; break }
}
check('A9.0', '库内存在 md 字符数>600 的长报告样本', Boolean(longId), longId ?? '(未找到)')
const detSmall = await invoke(lead.id, 'diag_result_get', { result_id: longId ?? firstId, include_md: true, md_max_chars: 500 })
const smallText = text(detSmall)
check('A9.1', 'md_max_chars=500 触发真实截断(标记+总长)',
  !isErr(detSmall) && smallText.includes('已截断') && /截断 500\/\d+/.test(smallText), smallText.slice(0, 160))

// ── A6 编辑回读(先开 annotate) ──
const stamp = `AW 集成验收 ${new Date().toISOString().slice(0, 16)}`
await patchSettings({ 'plugins.diag-bridge.results_allow_annotate': true })
// 用 AW 自己发起过的结果做属主内编辑(演示 token=results_demo 名下有历史 run)
const mine = await invoke(lead.id, 'diag_results', { q: 'results-lib-demo', brief: false })
const mineId = (text(mine).match(/^- (\w+) \|/m) ?? [])[1]
check('A6.0', '找到本 token 属主的结果(results-lib-demo)', Boolean(mineId), text(mine).slice(0, 200))
const ann = await invoke(lead.id, 'diag_result_annotate', { result_id: mineId, description: stamp, tags: ['aws-e2e', 'results'] })
check('A6.1', 'annotate 成功并回读 description/tags', !isErr(ann) && text(ann).includes('已更新') && text(ann).includes('aws-e2e'), text(ann).slice(0, 200))
const verify = await invoke(lead.id, 'diag_result_get', { result_id: mineId })
check('A6.2', '详情回读含新描述(display_text 优先)', text(verify).includes(stamp.slice(0, 12)), text(verify).slice(0, 240))

// ── A7 负例(逐条严格断言) ──
const nf = await invoke(lead.id, 'diag_result_get', { result_id: 'deadbeef99' })
check('A7.1', '不存在 id → RESULT_NOT_FOUND 指引', isErr(nf) && text(nf).includes('不存在'), text(nf).slice(0, 160))
// 仅给 summary:工具层必须拒绝(不把只读字段送进 PATCH)
const onlySummary = await invoke(lead.id, 'diag_result_annotate', { result_id: mineId, summary: 'hack' })
check('A7.2a', '只给 summary → 本地拒绝(至少给可编辑字段之一)', isErr(onlySummary) && text(onlySummary).includes('至少给'), text(onlySummary).slice(0, 160))
// description+summary:summary 必须被丢弃,只有 description 生效
const withSummary = await invoke(lead.id, 'diag_result_annotate', { result_id: mineId, description: `${stamp} (summary过滤)`, summary: 'hack' })
check('A7.2b', '混合给 summary → 仅 description 生效(summary 被过滤)', !isErr(withSummary) && text(withSummary).includes('已更新'), text(withSummary).slice(0, 200))
// 非属主 403 需要一个「属主明确」的结果:新建一条(results_demo 的 token 创建 → user_id 已归属),
// 不能用修复前创建的存量行(其 user_id 为 NULL,任何 token 都可编辑,属已知历史边界)。
const freshRun = await fetch('http://127.0.0.1:3210/api/external/v1/analyze', {
  method: 'POST', headers: { 'content-type': 'application/json', 'authorization': `Bearer ${IDD_TOKEN}` },
  body: JSON.stringify({ folderPath: 'aw-snapshots', analysisIntent: 'quick-screen', harness: 'mock', sceneName: 'aws-owner-probe', question: '属主校验探针', wait: true, wait_timeout_minutes: 3 }),
}).then(r => r.json()).catch(() => ({}))
const ownedId = freshRun?.data?.run_id
check('A7.3a', '新结果已归属当前 Token(results_demo)', Boolean(ownedId) && freshRun?.data?.status === 'completed', JSON.stringify(freshRun).slice(0, 200))
// 属主自己可编辑
const ownerEdit = ownedId ? await invoke(lead.id, 'diag_result_annotate', { result_id: ownedId, description: `${stamp} (属主自证)` }) : null
check('A7.3b', '属主编辑新结果成功', Boolean(ownerEdit) && !isErr(ownerEdit), ownerEdit ? text(ownerEdit).slice(0, 160) : 'no-run')
// 第二账号 token → 同一结果应 403
const secondLogin = await fetch('http://127.0.0.1:3210/api/auth/login', {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ username: 'results_demo2', password: 'Demo1234!x' }),
}).then(r => r.json()).catch(() => ({}))
const secondJwt = secondLogin?.data?.session_token ?? secondLogin?.data?.token
let secondToken = ''
if (secondJwt) {
  const minted = await fetch('http://127.0.0.1:3210/api/auth/tokens', {
    method: 'POST', headers: { 'content-type': 'application/json', 'authorization': `Bearer ${secondJwt}` },
    body: JSON.stringify({ name: `aws-e2e-second-${Date.now().toString(36)}`, expires_in_days: 1 }),
  }).then(r => r.json()).catch(() => ({}))
  secondToken = minted?.data?.token ?? ''
}
if (secondToken && ownedId) {
  await patchSettings({ 'plugins.diag-bridge.token': secondToken })
  const forbid = await invoke(lead.id, 'diag_result_annotate', { result_id: ownedId, description: '越权测试' })
  await patchSettings({ 'plugins.diag-bridge.token': IDD_TOKEN })
  check('A7.3', '非属主(第二 token)编辑 → 403 如实回执', isErr(forbid) && text(forbid).includes('不属于'), text(forbid).slice(0, 180))
}
else {
  check('A7.3', '非属主编辑(第二账号/新结果不可用)', false, `secondToken=${Boolean(secondToken)} ownedId=${ownedId ?? '-'}`)
}

// ── A8 写闸门:关掉 annotate 后再编辑被拒 ──
await patchSettings({ 'plugins.diag-bridge.results_allow_annotate': false })
const gate = await invoke(lead.id, 'diag_result_annotate', { result_id: mineId, description: 'x' })
check('A8.1', 'allow_annotate=false → 本地拒绝(不发起 PATCH)', isErr(gate) && text(gate).includes('未开放'), text(gate).slice(0, 160))
await patchSettings({ 'plugins.diag-bridge.results_allow_annotate': true })

// ── A10 版本探测/连通性:坏 base_url → 可行动回执(计划 §5 文案) ──
await patchSettings({ 'plugins.diag-bridge.base_url': 'http://127.0.0.1:3999' })
const badBase = await invoke(lead.id, 'diag_results', {})
check('A10.1', '不可达 base_url → 「诊断服务不可达({base})」可行动回执',
  isErr(badBase) && text(badBase).includes('诊断服务不可达') && text(badBase).includes('127.0.0.1:3999'), text(badBase).slice(0, 200))
await patchSettings({ 'plugins.diag-bridge.base_url': 'http://127.0.0.1:3210' })

// ── A12 REST 路由面(面板同源) ──
const rIdx = await fetch(`${BASE}/api/plugins/diag-bridge/results?limit=5&brief=false`, { headers: H })
const rIdxJ = await rIdx.json().catch(() => ({}))
check('A12.1', 'GET /results(面板) 返回索引', rIdx.status === 200 && rIdxJ?.success && Array.isArray(rIdxJ?.data?.results), JSON.stringify(rIdxJ).slice(0, 160))
const rDet = await fetch(`${BASE}/api/plugins/diag-bridge/results/detail?id=${encodeURIComponent(mineId ?? firstId)}`, { headers: H })
const rDetJ = await rDet.json().catch(() => ({}))
check('A12.2', 'GET /results/detail 返回详情', rDet.status === 200 && rDetJ?.data?.result_id, JSON.stringify(rDetJ).slice(0, 120))
const rEdit = await fetch(`${BASE}/api/plugins/diag-bridge/results/edit?id=${encodeURIComponent(mineId)}`, { method: 'PATCH', headers: H, body: JSON.stringify({ description: `${stamp} (面板)` }) })
const rEditJ = await rEdit.json().catch(() => ({}))
check('A12.3', 'PATCH /results/edit(面板) 编辑成功', rEdit.status === 200 && rEditJ?.success && String(rEditJ?.data?.description ?? '').includes('面板'), JSON.stringify(rEditJ).slice(0, 160))
const rCat = await fetch(`${BASE}/api/plugins/diag-bridge/results/categories`, { headers: H })
check('A12.4', 'GET /results/categories 可用', rCat.status === 200, `status=${rCat.status}`)

// ── A13 回归:既有 diag 工具与路由不受影响 ──
const st = await invoke(lead.id, 'diag_status', {})
check('A13.1', 'diag_status 仍正常(最近记录/空态)', !isErr(st), text(st).slice(0, 120))
const hlt = await fetch(`${BASE}/api/plugins/diag-bridge/health`, { headers: H })
const hltJ = await hlt.json().catch(() => ({}))
check('A13.2', '/health 路由仍正常(token accepted)', hlt.status === 200 && hltJ?.token?.accepted !== false, JSON.stringify(hltJ).slice(0, 140))
const runs = await fetch(`${BASE}/api/plugins/diag-bridge/runs`, { headers: H })
check('A13.3', '/runs 路由仍正常', runs.status === 200, `status=${runs.status}`)

// ── 报告 ──
const pass = results.filter(r => r.pass).length
writeFileSync(join(EVID, 'report.json'), JSON.stringify({ script: 'scripts/e2e-idd-results.mjs', generatedAt: new Date().toISOString(), base: BASE, pass, total: results.length, results }, null, 2))
console.log(`\nIDD-RESULTS E2E: ${pass}/${results.length} passed, ${results.length - pass} failed\nevidence: ${join(process.cwd(), EVID)}`)
process.exit(pass === results.length ? 0 : 1)
