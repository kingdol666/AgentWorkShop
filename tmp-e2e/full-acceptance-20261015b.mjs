#!/usr/bin/env node
/**
 * 全功能验收 2026-10-15b(v0.7.64+:ESLint 全绿/冗余清理后 · 按 skill 验收流程+新增内容)。
 *   node tmp-e2e/full-acceptance-20261015b.mjs
 *
 * ══ 验收标准(先行定义,逐条判定)══
 *  A 健康      A1 平台 0.7.64 workshop ready;A2 diag+rag 双桥 token 接受;A3 工具面 82 无死工具
 *  B 数采镜像链 B1 建线/配方/DAQ(modbus)→开跑;B2 真实样本落库;B3 daq_query 工具面取数
 *  C MES 双模式
 *   C1 直连实时  mes_fetch(current) 返回值与直 curl MES API 一致(凭证经 secretRef→env 注入)
 *   C2 直连历史  mes_fetch 大窗→异步数据集 mesds-*→mes_datasets→mes_dataset_read(stats+rows)
 *   C3 镜像轮询  daq http 节点轮询 MES current→本地 TSDB 增长
 *   C4 镜像证明  停 MES 模拟器后:daq_query 仍有数据(本地镜像)而 mes_fetch 报错(直连语义)
 *   C5 目录作用域 mes_catalog 只见授权产线条目
 *  D 权限隔离  D1-D12:无授权全不可见(列表空/详情 403/数采产线不可见/审计 403/HITL 过滤);
 *              readonly 可读不可改;operate 可改归因刷新;撤权即消失;非管理员不能授权建号
 *  E 治理链    E1 recipe_update 挂卡→批准→v2 落版本;E2 trial 应急卡→拒绝附指导回流+零改动;
 *              E3 频控拦截二次下发
 *  F 分析台账  F1 真实统计入账;F2 工具面 id 全文;F3 REST 配方/时间/关键词;F4 授权可见性
 *  G IDD 意图  G1 diag_run(quick-screen) 受理即返 task_id(情景问题注入);G2 diag_status 进度+意图标签
 *  H 审计留痕  H1 recipe.apply/recipe.update.agent/analysis.save 均有 agent 归因
 * 判定:A-F、H 全绿 + G1/G2 绿 ⇒ 系统通过(G 任务完成态尽力,受理+路由机制已证)。
 */
import { exec, spawn } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'

const BASE = 'http://127.0.0.1:3997'
const MES = 'http://127.0.0.1:15060'
const MES_TOKEN = 'mes-demo-token-2026'
const TAG = `fa${Date.now().toString(36).slice(-4)}`
process.env.NO_PROXY = '127.0.0.1,localhost'

let pass = 0
const fails = []
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ✔ ${name}`) }
  else { fails.push(name); console.log(`  ✖ ${name}${detail ? ` — ${String(detail).slice(0, 230)}` : ''}`) }
}
const sleep = ms => new Promise(r => setTimeout(r, ms))
async function api(method, path, body, token) {
  const res = await fetch(BASE + path, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(60_000),
  })
  return { status: res.status, ...(await res.json().catch(() => ({}))) }
}
const invText = r => String(r?.data?.result?.text ?? r?.data?.text ?? JSON.stringify(r))
const invErr = r => Boolean(r?.data?.result?.isError ?? r?.data?.isError)

let token = (await api('POST', '/api/users/register', { name: 'fa-admin', email: `fa-${TAG}@awshop.local`, password: 'FcAdmin#2026' })).data?.token
if (!token) token = (await api('POST', '/api/users/login', { email: 'fc-fcddrp@awshop.local', password: 'FcAdmin#2026' })).data?.token
const H = () => token
const inv = (agentId, tool, args, timeoutMs = 180_000) => fetch(BASE + '/api/workshop/agent-tools/invoke', {
  method: 'POST', headers: { 'content-type': 'application/json', 'authorization': `Bearer ${H()}` },
  body: JSON.stringify({ agentId, tool, args }), signal: AbortSignal.timeout(timeoutMs),
}).then(r => r.json().catch(() => ({})))

/* ═══ A 健康 ═══ */
console.log('\n[A] 平台健康')
const health = await api('GET', '/api/health')
ok(`A1 平台健康(v=${health?.data?.version}, workshop=${health?.data?.workshop})`,
  health?.data?.status === 'ok' && health?.data?.workshop === 'ready')
{
  const d = await api('GET', '/api/plugins/diag-bridge/health', undefined, H())
  const r = await api('GET', '/api/plugins/rag-bridge/health', undefined, H())
  ok('A2 双插件桥 token 接受(diag 远端 ok + rag 后端 ok)',
    d?.token?.accepted === true && d?.remote?.status === 'ok' && r?.token?.accepted === true && r?.backend?.ok === true,
    JSON.stringify({ diag: d?.token, rag: r?.token }).slice(0, 140))
}
let agentId = ''
{
  const defs = JSON.parse(readFileSync('.AgentWorkShop/prompts/host-tools.json', 'utf-8'))
  ok(`A3 定义面 ${defs.length} 工具,无死工具`, defs.length === 82 && !defs.some(t => ['dcw_read', 'param_read'].includes(t.name)))
  globalThis.__ch = (await api('POST', '/api/workshop/channels', { name: `全功能验收-${TAG}`, templateKey: 'legacy' }, H())).data?.channelId
  agentId = ((await api('POST', `/api/workshop/channels/${globalThis.__ch}/agents`, { name: `验收工程师-${TAG}`, role: 'lead', harness: 'omp' }, H())).data)?.id
  ok('A3b 验收频道/lead 就绪', Boolean(agentId))
}

/* ═══ B 数采镜像链(PLC Modbus) ═══ */
console.log('\n[B] 数采镜像链')
const lineId = (await api('POST', '/api/workshop/dcw/lines', { name: `烘干产线-${TAG}` }, H())).data?.line?.id
const productId = (await api('POST', '/api/workshop/dcw/products', { lineId, name: `隔膜产品-${TAG}` }, H())).data?.product?.id
const tplKey = (await api('POST', '/api/workshop/dcw/templates', { name: `烘干SP-${TAG}`, ch: '烘干温度', unit: '℃', min: 0, max: 260, decimals: 1 }, H())).data?.template?.key
const dcwNodeId = (await api('POST', '/api/workshop/dcw', {
  templateRef: tplKey, name: `烘干SP-${TAG}`, driver: 'modbus-tcp', lineId, stepLimit: 60, holdIntervalMs: 0,
  driverConfig: { host: '127.0.0.1', port: 15041, unitId: 1, register: 40021, dataType: 'float32', byteOrder: 'big' },
}, H())).data?.node?.id
const recipeId = (await api('POST', '/api/workshop/dcw/recipes', {
  productId, name: `标准烘干-${TAG}`, params: [{ nodeId: dcwNodeId, value: 130, min: 40, max: 220 }],
}, H())).data?.recipe?.id
const daqNodeId = (await api('POST', '/api/workshop/daq', {
  templateRef: 'daq-temp-tc', name: `烘干PV-${TAG}`, driver: 'modbus-tcp', lineId, intervalMs: 1000, publishIntervalMs: 0,
  driverConfig: { host: '127.0.0.1', port: 15041, unitId: 1, register: 40001, registerType: 'holding', dataType: 'float32', byteOrder: 'big' },
}, H())).data?.node?.id
const bindLine = await api('PUT', `/api/workshop/channels/${globalThis.__ch}/line`, { lineId }, H())
ok('B0 频道绑线(只读扩权)', bindLine.status === 200, JSON.stringify(bindLine).slice(0, 100))
await api('POST', '/api/workshop/daq/controller', { action: 'start' }, H())
const lineStart = await api('POST', `/api/workshop/dcw/lines/${lineId}/start`, { recipeId }, H())
ok('B1 建线/配方/DAQ+开跑(SP=130 写穿)', lineStart.status === 200 && Boolean(daqNodeId && recipeId), lineStart.message ?? '')
{
  let has = false
  for (let i = 0; i < 24; i++) {
    await sleep(5000)
    const w = await api('GET', `/api/workshop/daq/${daqNodeId}/samples?bucketMs=1000&limit=5`, undefined, H())
    if ((w.data?.points ?? []).length > 0) { has = true; break }
  }
  ok('B2 真实样本落库', has)
  const dq = await inv(agentId, 'daq_query', { node_id: daqNodeId, last_minutes: 5, bucket_ms: 2000 })
  ok('B3 daq_query 工具面取数', !invErr(dq) && /\d/.test(invText(dq)), invText(dq).slice(0, 120))
  await sleep(15_000)
}

/* ═══ C MES 双模式 ═══ */
console.log('\n[C] MES 双模式(镜像轮询 vs 直连 API)')
const MES_LINE = (await api('POST', '/api/workshop/dcw/lines', { name: `MES产线-${TAG}` }, H())).data?.line?.id
const mesTpl = (await api('POST', '/api/workshop/dcw/templates', { name: `MES参数-${TAG}`, ch: 'MES温度', unit: '℃', min: 0, max: 200, decimals: 1 }, H())).data?.template?.key
const mesNodeId = (await api('POST', '/api/workshop/dcw', {
  templateRef: mesTpl, name: `MES直连-${TAG}`, driver: 'mes-rest', lineId: MES_LINE, stepLimit: 60,
  driverConfig: {
    baseUrl: MES, authType: 'header', secretRef: 'MES_DEMO', allowPrivateHost: 'true',
    desc: '全功能验收直连节点',
    readMap: JSON.stringify({
      method: 'GET', path: '/api/v1/params/{tag}/current', query: { tag: 'melt_temp' },
      response: { valuePath: 'data.value', tsPath: 'data.ts', tsFormat: 'epoch_ms' },
    }),
    historyMap: JSON.stringify({
      method: 'GET', path: '/api/v1/params/{tag}/history',
      query: { tag: 'melt_temp', from: '{{from}}', to: '{{to}}', cursor: '{{cursor}}', size: '{{pageSize}}' },
      response: { rowsPath: 'data.rows[*]', valuePath: 'value', tsPath: 'ts', tsFormat: 'iso', nextCursorPath: 'data.nextCursor' },
      pageSize: 200, maxPages: 40,
    }),
  },
}, H())).data?.node?.id
ok('C0 mes-rest 直连节点创建', Boolean(mesNodeId))
// v3 一线一工作空间:MES 双模式用独立频道(绑线频道只能绑同产线对象 —— 产线隔离设计)
const mesCh = (await api('POST', '/api/workshop/channels', { name: `MES频道-${TAG}`, templateKey: 'legacy' }, H())).data?.channelId
const mesAgentId = ((await api('POST', `/api/workshop/channels/${mesCh}/agents`, { name: `MES分析员-${TAG}`, role: 'lead', harness: 'omp' }, H())).data)?.id
await api('PUT', `/api/workshop/channels/${mesCh}/line`, { lineId: MES_LINE }, H())
const mesRecipeId = (await api('POST', '/api/workshop/dcw/recipes', {
  productId: (await api('POST', '/api/workshop/dcw/products', { lineId: MES_LINE, name: `MES产品-${TAG}` }, H())).data?.product?.id,
  name: `MES直读-${TAG}`, params: [{ nodeId: mesNodeId, value: 55, min: 0, max: 200 }],
}, H())).data?.recipe?.id
const mesBind = await api('POST', '/api/workshop/agent-tools/bindings', { agentId: mesAgentId, nodeId: mesRecipeId, kind: 'recipe', mode: 'manual' }, H())
ok('C0b MES 频道/绑线/配方绑定(v2 读面)', Boolean(mesAgentId) && Boolean(mesBind.data), JSON.stringify(mesBind.data ?? mesBind).slice(0, 120))
globalThis.__mesAgent = mesAgentId
// 目录可见性(mes_catalog 经 scope_line_ids 严格过滤)
const cat = await inv(mesAgentId, 'mes_catalog', { line_id: MES_LINE })
ok('C5 mes_catalog 作用域含 mes 点位', !invErr(cat) && invText(cat).includes(mesNodeId), invText(cat).slice(0, 150))

/* C1 直连实时:mes_fetch vs 直 curl */
{
  let liveVal = null
  for (let i = 0; i < 3 && liveVal == null; i++) {
    const live = await fetch(`${MES}/api/v1/params/melt_temp/current`, { headers: { 'x-api-token': MES_TOKEN } }).then(r => r.json()).catch(() => null)
    liveVal = Number(live?.data?.value)
    if (!Number.isFinite(liveVal)) { liveVal = null; await sleep(3000) }
  }
  const mesAgent = globalThis.__mesAgent
  const mf = await inv(mesAgent, 'mes_fetch', { ids: [mesNodeId], max_rows: 5 })
  const txt = invText(mf)
  const vals = (txt.match(/\d+\.\d{2,}/g) ?? []).map(Number)
  ok(`C1 直连实时(mes_fetch 值域命中 API 现值 ${liveVal ?? '?'})`,
    !invErr(mf) && Number.isFinite(liveVal) && vals.some(v => Math.abs(v - liveVal) < 8), txt.slice(0, 180))
}

/* C2 直连历史+异步数据集 */
let dsId = ''
{
  const to = new Date().toISOString()
  const from = new Date(Date.now() - 40 * 60_000).toISOString()
  await sleep(6500) // mes_fetch 节流窗
  const mf = await inv(globalThis.__mesAgent, 'mes_fetch', { ids: [mesNodeId], from, to, max_rows: 5000 }, 240_000)
  const txt = invText(mf)
  dsId = (txt.match(/mesds-[0-9a-z]+/i) ?? [])[0] ?? ''
  ok('C2a 直连历史大窗→异步数据集落盘', Boolean(dsId), txt.slice(0, 180))
  if (dsId) {
    // 数据集可见性=创建者(MES lead)口径;异步登记有延迟,轮询清单
    let listed = false
    for (let i = 0; i < 6 && !listed; i++) {
      await sleep(5000)
      const list = await inv(globalThis.__mesAgent, 'mes_datasets', { limit: 10 })
      listed = invText(list).includes(dsId)
    }
    ok('C2b mes_datasets 清单含数据集(创建者可见)', listed)
    const stats = await inv(globalThis.__mesAgent, 'mes_dataset_read', { dataset_id: dsId, mode: 'stats' })
    ok('C2c mes_dataset_read stats(行数/统计/sha256)', !invErr(stats) && /数值行数/.test(invText(stats)), invText(stats).slice(0, 160))
    const rows = await inv(globalThis.__mesAgent, 'mes_dataset_read', { dataset_id: dsId, mode: 'rows', offset: 0 })
    ok('C2d mes_dataset_read rows 分页读原文', !invErr(rows) && /分页/.test(invText(rows)), invText(rows).slice(0, 140))
  }
}

/* C3 镜像轮询:daq http 节点轮询 MES current → 本地 TSDB */
const mesMirrorId = (await api('POST', '/api/workshop/daq', {
  templateRef: 'daq-temp-tc', name: `MES镜像-${TAG}`, driver: 'http', lineId, intervalMs: 1500, publishIntervalMs: 0,
  driverConfig: {
    url: `${MES}/api/v1/params/melt_temp/current`,
    headersJSON: JSON.stringify({ 'x-api-token': MES_TOKEN }),
    jsonPath: 'data.value',
  },
}, H())).data?.node?.id
ok('C3a MES 镜像 daq 节点创建(http 轮询)', Boolean(mesMirrorId))
{
  let grown = false
  let prev = -1
  for (let i = 0; i < 24; i++) {
    await sleep(5000)
    const w = await api('GET', `/api/workshop/daq/${mesMirrorId}/samples?bucketMs=1000&limit=200`, undefined, H())
    const n = (w.data?.points ?? []).length
    if (n >= 3 && n > prev) { grown = true; prev = n }
    if (n >= 12) break
  }
  ok(`C3b 镜像轮询持续入库(TSDB ${prev} 桶)`, grown)
  const dq = await inv(agentId, 'daq_query', { node_id: mesMirrorId, last_minutes: 5, bucket_ms: 2000 })
  ok('C3c Agent 经 daq_query 读镜像(与普通节点同面)', !invErr(dq) && /\d/.test(invText(dq)), invText(dq).slice(0, 120))
}

/* C4 镜像 vs 直连对照(停 MES 模拟器) */
{
  // 找到 MES sim 进程并停(按端口)
  await new Promise((resolve) => {
    exec('powershell -NoProfile -Command "$c = Get-NetTCPConnection -State Listen -LocalPort 15060 -ErrorAction SilentlyContinue; if ($c) { taskkill /PID $($c[0].OwningProcess) /T /F }"', () => resolve())
  })
  await sleep(4000)
  const dq = await inv(agentId, 'daq_query', { node_id: mesMirrorId, last_minutes: 10, bucket_ms: 2000 })
  ok('C4a API 宕机后镜像可读(daq_query 走本地库)', !invErr(dq) && /\d/.test(invText(dq)), invText(dq).slice(0, 120))
  const mf = await inv(agentId, 'mes_fetch', { ids: mesNodeId, max_rows: 5 }, 90_000)
  ok('C4b API 宕机后直连报错(实连语义)', invErr(mf) || /失败|ECONNREFUSED|HTTP|超时|错误/.test(invText(mf)), invText(mf).slice(0, 160))
  // 恢复 MES sim(后续段不需要 API,但保持环境完整)
  const child = spawn(process.execPath, ['scripts/dev-mes-simulator.mjs', '--port', '15060'], {
    cwd: process.cwd(), detached: true, stdio: 'ignore', windowsHide: true,
    env: { ...process.env, MES_SIM_TOKEN: MES_TOKEN },
  })
  child.unref()
  await sleep(5000)
}

/* ═══ D 权限隔离 ═══ */
console.log('\n[D] 权限隔离')
{
  // 基线分析(权限标的)
  const pts = await api('GET', `/api/workshop/daq/${daqNodeId}/samples?bucketMs=1000&limit=20`, undefined, H())
  const vals = (pts.data?.points ?? []).map(p => Number(p.avg ?? p.v)).filter(Number.isFinite)
  const mean = vals.length ? Math.round((vals.reduce((a, b) => a + b, 0) / vals.length) * 100) / 100 : 0
  const save = await inv(agentId, 'analysis_save', {
    title: `基线工况-${TAG}`,
    summary: `SP=130 基线:PV 均值 ${mean}℃,真实采样 ${vals.length} 点`,
    conclusions: [`均值 ${mean}℃`, `采样 ${vals.length} 点`],
    report: `## 基线\n\n产线 ${lineId},配方 ${recipeId}。`,
    category: 'quality', recipe_id: recipeId,
    data_sources: `daq ${daqNodeId}`,
    metrics: { mean_c: mean, n: vals.length },
  })
  const baseReportId = invText(save).match(/ar-[0-9a-f]{8}/)?.[0]
  ok('D0 基线分析入账(权限标的)', Boolean(baseReportId), invText(save).slice(0, 100))

  const ua = await api('POST', '/api/users', { name: `fa-viewer-a-${TAG}`, email: `viewer-a-${TAG}@awshop.local`, password: 'Viewer@2026' }, H())
  const ub = await api('POST', '/api/users', { name: `fa-viewer-b-${TAG}`, email: `viewer-b-${TAG}@awshop.local`, password: 'Viewer@2026' }, H())
  const viewerA = ua.data?.user?.id ?? ua.data?.id ?? ''
  const viewerB = ub.data?.user?.id ?? ub.data?.id ?? ''
  const tokenA = (await api('POST', '/api/users/login', { email: `viewer-a-${TAG}@awshop.local`, password: 'Viewer@2026' })).data?.token
  const tokenB = (await api('POST', '/api/users/login', { email: `viewer-b-${TAG}@awshop.local`, password: 'Viewer@2026' })).data?.token
  ok('D1 建号+登录(viewer-a/b)', Boolean(viewerA && viewerB && tokenA && tokenB))

  const bList = await api('GET', '/api/workshop/analysis?limit=50', undefined, tokenB)
  const bDetail = await api('GET', `/api/workshop/analysis/${baseReportId}`, undefined, tokenB)
  ok('D2 无授权:分析列表空+详情 403/404', (bList.data?.count ?? 0) === 0 && [403, 404].includes(bDetail.status), `count=${bList.data?.count} detail=${bDetail.status}`)
  const bDaq = await api('GET', '/api/workshop/daq', undefined, tokenB)
  const bLines = await api('GET', '/api/workshop/dcw/lines', undefined, tokenB)
  ok('D3 无授权:数采节点与产线不可见', !(bDaq.data?.nodes ?? []).some(n => n.lineId === lineId) && !(bLines.data?.lines ?? []).some(l => l.id === lineId))
  const bOps = await api('GET', '/api/workshop/ops-logs?limit=10', undefined, tokenB)
  ok('D4 无授权:运维审计 403', bOps.status === 403 || bOps.error === true, `status=${bOps.status}`)

  await api('PUT', '/api/workshop/permissions', { userId: viewerA, grants: [{ lineId, mode: 'readonly' }] }, H())
  const aList = await api('GET', '/api/workshop/analysis?limit=50', undefined, tokenA)
  const aDetail = await api('GET', `/api/workshop/analysis/${baseReportId}`, undefined, tokenA)
  ok('D5 readonly:列表+详情可见', (aList.data?.reports ?? []).some(r => r.id === baseReportId) && aDetail.status === 200)
  const aPatch = await api('PATCH', `/api/workshop/analysis/${baseReportId}`, { summary: '越权改' }, tokenA)
  const aDel = await api('DELETE', `/api/workshop/analysis/${baseReportId}`, undefined, tokenA)
  ok('D6 readonly:改/删被拒(403)', aPatch.status === 403 && aDel.status === 403, `${aPatch.status}/${aDel.status}`)

  await api('PUT', '/api/workshop/permissions', { userId: viewerA, grants: [{ lineId, mode: 'operate' }] }, H())
  const aPatch2 = await api('PATCH', `/api/workshop/analysis/${baseReportId}`, { summary: `人工复核-${TAG}` }, tokenA)
  ok('D7 operate:修改成功且归因刷新', aPatch2.status === 200 && String(aPatch2.data?.report?.updatedByName ?? '').includes('viewer-a'))

  await api('PUT', '/api/workshop/permissions', { userId: viewerA, grants: [{ lineId, mode: null }] }, H())
  const aList2 = await api('GET', '/api/workshop/analysis?limit=50', undefined, tokenA)
  ok('D8 撤权即不可见', !(aList2.data?.reports ?? []).some(r => r.id === baseReportId))

  const aGrant = await api('PUT', '/api/workshop/permissions', { userId: viewerB, grants: [{ lineId, mode: 'operate' }] }, tokenA)
  const aCreate = await api('POST', '/api/users', { name: 'x', email: `x-${TAG}@awshop.local`, password: 'X@2026' }, tokenA)
  ok('D9 非管理员授权/建号被拒', [aGrant.status, aCreate.status].every(s => s === 403 || s === 401), `${aGrant.status}/${aCreate.status}`)
  const bad = await api('POST', '/api/users/login', { email: `viewer-a-${TAG}@awshop.local`, password: 'Wrong#2026' })
  ok('D10 错密码 401', bad.status === 401 || bad.error === true)

  // 恢复 viewer-a 只读(F4 用)
  await api('PUT', '/api/workshop/permissions', { userId: viewerA, grants: [{ lineId, mode: 'readonly' }] }, H())
  // F4 授权可见性(报告在 F 段落账后立刻验)
  globalThis.__fa = { tokenA, tokenB, viewerA }
}

/* ═══ E 治理链 HITL ═══ */
console.log('\n[E] 治理链 HITL')
const decideCard = async (rid, { approved, comment }, maxSec = 40) => {
  for (let i = 0; i < Math.ceil((maxSec * 1000) / 1500); i++) {
    await sleep(1500)
    const p = await api('GET', '/api/workshop/hitl/pending', undefined, H())
    const card = (p.data?.items ?? []).find(x => x.kind === 'dcw-approval' && String(x.nodeId ?? '').includes(rid))
    if (card) {
      await api('POST', '/api/workshop/hitl/respond', { kind: 'dcw-approval', id: card.id, confirmed: approved, comment, choice: 0 }, H())
      return card
    }
  }
  return null
}
{
  const b1 = await api('POST', '/api/workshop/agent-tools/bindings', { agentId, nodeId: recipeId, kind: 'recipe', mode: 'manual' }, H())
  ok('E0 lead 绑定配方(manual)', Boolean(b1.data))
  // E2 先做拒绝路径(批准前引擎未唤醒,卡即建)
  const rtP = inv(agentId, 'recipe_trial', { recipe_id: recipeId, params: [{ node_id: dcwNodeId, value: 200 }], hypothesis: '跳步提产(负路径)', emergency: true }, 300_000)
  const card = await decideCard(recipeId, { approved: false, comment: '步幅过大,先小步并附数采依据' }, 60)
  const rt = await rtP
  ok('E1 trial 应急卡→拒绝附指导回流', Boolean(card) && /未批准/.test(invText(rt)) && /步幅过大/.test(invText(rt)), invText(rt).slice(0, 150))
  // E1 recipe_update 批准 → v2
  const ruP = inv(agentId, 'recipe_update', { recipe_id: recipeId, params: [{ node_id: dcwNodeId, value: 150 }], reason: `基线 ${'稳定'},工艺提温至 150(全功能验收)` }, 300_000)
  const card2 = await decideCard(recipeId, { approved: true, comment: '同意写入新版本' }, 60)
  const ru = await ruP
  ok('E2 recipe_update 挂卡→批准→v2', Boolean(card2) && !invErr(ru) && /v2|版本/.test(invText(ru)), invText(ru).slice(0, 140))
  // 等 60s 写入窗口后 apply
  const since = Date.now() - 0
  await sleep(Math.max(0, 68_000 - since))
  const raP = inv(agentId, 'recipe_apply', { recipe_id: recipeId, reason: 'v2 固化值下发(全功能验收)' }, 300_000)
  const card3 = await decideCard(recipeId, { approved: true, comment: '批准下发,注意观察' }, 60)
  const ra = await raP
  ok('E3 recipe_apply 挂卡→批准→设备证实+附言回流',
    Boolean(card3) && !invErr(ra) && /证实/.test(invText(ra)) && /人工附言/.test(invText(ra)), invText(ra).slice(0, 160))
  // E4 频控
  const ra2 = await inv(agentId, 'recipe_apply', { recipe_id: recipeId, reason: '频控负路径' }, 240_000)
  ok('E4 频控拦截二次下发', invErr(ra2), invText(ra2).slice(0, 120))
}

/* ═══ F 分析台账 + F4 可见性 ═══ */
console.log('\n[F] 分析台账')
let reportId2 = ''
{
  const step = await sampleMean(daqNodeId)
  const s2 = await inv(agentId, 'analysis_save', {
    title: `SP150 复测-${TAG}`,
    summary: `recipe v2 下发后 PV 均值 ${step}℃(真实统计)`,
    conclusions: [`下发后均值 ${step}℃`, '治理链:人工批准写入 v2 → 批准下发 → 设备证实'],
    report: `## 复测\n\n均值 ${step}℃。`,
    category: 'trend', recipe_id: recipeId,
    data_sources: `daq ${daqNodeId};recipe_apply 批次`,
    metrics: { step_mean_c: step },
  })
  reportId2 = invText(s2).match(/ar-[0-9a-f]{8}/)?.[0]
  ok('F1 阶跃复测入账', Boolean(reportId2), invText(s2).slice(0, 120))
  const q = await inv(agentId, 'analysis_query', { report_id: reportId2 })
  ok('F2 工具面 id 取回全文', !invErr(q) && invText(q).includes('复测'), invText(q).slice(0, 120))
  const byR = await api('GET', `/api/workshop/analysis?recipeId=${recipeId}`, undefined, H())
  const byK = await api('GET', `/api/workshop/analysis?q=${encodeURIComponent('复测')}`, undefined, H())
  ok('F3 REST 配方+关键词检索', (byR.data?.reports ?? []).length >= 2 && (byK.data?.reports ?? []).some(r => r.id === reportId2), `recipe=${byR.data?.count} kw=${byK.data?.count}`)
  const { tokenA, tokenB } = globalThis.__fa ?? {}
  if (tokenA && tokenB) {
    const aSee = await api('GET', '/api/workshop/analysis?limit=50', undefined, tokenA)
    const bSee = await api('GET', '/api/workshop/analysis?limit=50', undefined, tokenB)
    ok('F4 授权可见/未授权不可见', (aSee.data?.reports ?? []).some(r => r.id === reportId2) && !(bSee.data?.reports ?? []).some(r => r.id === reportId2))
  }
  else ok('F4 授权可见性(跳过:D 段未取到 token)', false)
}

/* ═══ G IDD 意图 ═══ */
console.log('\n[G] IDD 意图(quick-screen)')
{
  const r1 = await inv(agentId, 'diag_run', {
    line: lineId, analysis_intent: 'quick-screen',
    question: `产线 ${lineId} 运行快速筛查:越限/漂移/冻结异常清单(全功能验收)`,
    scene: `aw_fa_${TAG}`,
  }, 120_000)
  const taskId = (invText(r1).match(/task_id=([A-Za-z0-9-]+)/i) ?? [])[1] ?? ''
  ok('G1 diag_run(quick-screen) 受理即返 task_id', Boolean(taskId), invText(r1).slice(0, 160))
  if (taskId) {
    await sleep(10_000)
    const s = await inv(agentId, 'diag_status', { run_id: taskId }, 60_000)
    ok('G2 diag_status 进度+意图标签', /状态=/.test(invText(s)) && /意图=quick-screen|quick-screen/.test(invText(s)), invText(s).slice(0, 160))
  }
}

/* ═══ H 审计留痕 ═══ */
console.log('\n[H] 工具调用留痕')
{
  const audit = await api('GET', `/api/workshop/ops-logs?lineId=${lineId}&limit=500`, undefined, H())
  const logs = audit.data?.logs ?? []
  const agentActs = logs.filter(l => l.actorKind === 'agent').map(l => l.action)
  ok('H1 配方/分析/下发均有 agent 归因审计',
    agentActs.includes('recipe.apply') && agentActs.includes('analysis.save') && agentActs.some(a => /recipe\.update/.test(a)),
    [...new Set(agentActs)].join(',').slice(0, 160))
  const byAction = {}
  for (const l of logs) byAction[l.action] = (byAction[l.action] ?? 0) + 1
  console.log('  · 产线审计分布:', JSON.stringify(byAction))
}

async function sampleMean(nodeId, seconds = 12) {
  for (let a = 0; a < 3; a++) {
    const t0 = Date.now()
    await sleep(seconds * 1000)
    const r = await api('GET', `/api/workshop/daq/${nodeId}/samples?from=${t0}&to=${Date.now()}&bucketMs=1000`, undefined, H())
    const pts = (r.data?.points ?? []).map(p => Number(p.avg ?? p.v)).filter(Number.isFinite)
    if (pts.length >= 5) return Math.round((pts.reduce((x, y) => x + y, 0) / pts.length) * 100) / 100
    await sleep(4000)
  }
  return 0
}

/* ═══ 汇总 ═══ */
writeFileSync('D:/tmp/aw-fc-1015/full-acceptance-state.json', JSON.stringify({
  base: BASE, tag: TAG, lineId, recipeId, daqNodeId, mesNodeId, agentId,
}, null, 1))
console.log(`\n════ 全功能验收:${pass}/${pass + fails.length} 通过 ════`)
if (fails.length) { console.log('未通过:'); for (const f of fails) console.log('  ✖', f); process.exit(1) }
console.log('FULL-ACCEPTANCE OK')
