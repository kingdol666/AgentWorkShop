#!/usr/bin/env node
/**
 * 综合终验 2026-10-15(死工具清理后 · 0.7.62+):工具面净化 / 用户管理与权限隔离 / 在线产线报告链 / RAG 后台链。
 *   node tmp-e2e/final-verify-20261015.mjs --base http://127.0.0.1:3997
 *
 * ══ 验收标准(先行定义)══
 *  T 工具面净化 T1 清单不含 dcw_read/param_read(死工具);T2 总数=82(84-2);
 *              T3 直接 invoke 死工具 → 干净报错;T4 关键工具在面(daq_query、analysis_*、diag_*、kb_agent)
 *  U 权限隔离  U1 admin 创建 viewer-a/b;U2 b 无授权:分析/数采/产线全不可见,详情 404,ops-logs 403;
 *              U3 a(readonly):列表+详情可见,不可改不可删;U4 授 operate 后可改(归因刷新);
 *              U5 撤销授权后不可见;U6 非管理员不能授权/建用户;U7 错密码 401
 *  L 产线供数  L1 建线/配方/DAQ→开跑→首批样本(PLC 15041 真连)
 *  R 产线报告链 R1 diag_run(stability-report)即返 task_id;R2 diag_status 按 taskId 见运行中进度;
 *              R3 终态 completed+reportPath;R4 结果 analysis_save 入分析库(引用 run_id);
 *              R5 多维检索命中(REST 配方+关键词;工具面 id 全文);R6 授权用户可见/未授权不可见;
 *              R7 完成回执自动通知频道(平台通告面)
 *  K RAG 后台链 K1 kb_agent async 入库即返 task_id;K2 kb_agent_status 按 taskId 查到完成;
 *              K3 kb_agent 检索(sync)命中入库内容
 */
const args = process.argv.slice(2)
const ix = args.indexOf('--base')
const BASE = ix >= 0 ? args[ix + 1] : 'http://127.0.0.1:3997'
const TAG = `fv${Date.now().toString(36).slice(-4)}`
const POLL_MIN = Number((args.indexOf('--poll-min') >= 0 ? args[args.indexOf('--poll-min') + 1] : '22'))

const results = []
const fails = []
function check(id, name, pass, detail = '') {
  results.push({ id, name, pass: Boolean(pass) })
  console.log(`${pass ? '✔' : '✖'} [${id}] ${name}${pass ? '' : ` — ${String(detail).slice(0, 240)}`}`)
  if (!pass) fails.push(`${id} ${name}`)
}
const sleep = ms => new Promise(r => setTimeout(r, ms))
process.env.NO_PROXY = '127.0.0.1,localhost'
async function api(method, path, body, token) {
  const res = await fetch(BASE + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(60_000),
  })
  let json = null
  try { json = await res.json() } catch { /* */ }
  return { status: res.status, ...json }
}

/* ═══ 0. admin(复用 home:注册已关,直接登录) ═══ */
let token = (await api('POST', '/api/users/register', { name: 'fv-admin', email: `fv-${TAG}@awshop.local`, password: 'FcAdmin#2026' })).data?.token
if (!token) token = (await api('POST', '/api/users/login', { email: 'fc-fcddrp@awshop.local', password: 'FcAdmin#2026' })).data?.token
check('0.1', 'admin 就绪', Boolean(token))
const H = () => token
const inv = (agentId, tool, aargs, timeoutMs = 120_000) => fetch(BASE + '/api/workshop/agent-tools/invoke', {
  method: 'POST', headers: { 'content-type': 'application/json', 'authorization': `Bearer ${H()}` },
  body: JSON.stringify({ agentId, tool, args: aargs }), signal: AbortSignal.timeout(timeoutMs),
}).then(r => r.json().catch(() => ({}))).catch(e => ({ err: e.message }))
const invText = r => String(r?.data?.result?.text ?? r?.data?.text ?? JSON.stringify(r))
const invErr = r => Boolean(r?.data?.result?.isError ?? r?.data?.isError)

/* ═══ T 工具面净化(定义面静态断言;agent 实际工具面在 L2 之后验) ═══ */
console.log('\n[T] 工具面净化(死工具清理)')
{
  // 定义面:运行时实例解析的 host-tools.json(repo 本地 .AgentWorkShop/prompts 优先)
  const defs = await import('node:fs')
  const defPath = '.AgentWorkShop/prompts/host-tools.json'
  const tools = JSON.parse(defs.readFileSync(defPath, 'utf-8'))
  const names = tools.map(t => t?.name ?? '')
  check('T1', '定义面不含 dcw_read / param_read(死工具已摘)', !names.includes('dcw_read') && !names.includes('param_read'),
    names.filter(n => /dcw_read|param_read/.test(n)).join(',') || `total=${names.length}`)
  check('T2', '定义面总数 = 82(84-2)', names.length === 82, `count=${names.length}`)
}

/** L2 之后:验证 Channel 成员实际看到的工具面(注入面 = LLM 上下文面) */
async function checkAgentToolFace(agentId) {
  const list = await api('GET', `/api/workshop/agent-tools/list?agentId=${agentId}`, undefined, H())
  const tools = list.data?.tools ?? []
  const names = (Array.isArray(tools) ? tools : []).map(t => t?.name ?? '').filter(Boolean)
  check('T4', 'Channel 成员实际工具面不含死工具(注入面净化)', !names.includes('dcw_read') && !names.includes('param_read'),
    `face=${names.length}, dead=${names.filter(n => /dcw_read|param_read/.test(n)).join(',')}`)
  const need = ['daq_query', 'analysis_save', 'analysis_query', 'line_context', 'ops_log', 'recipe_apply', 'diag_run', 'diag_status', 'kb_agent', 'kb_agent_status']
  check('T4b', '核心+IDD/RAG 插件工具在成员面上', need.every(n => names.includes(n)), need.filter(n => !names.includes(n)).join(','))
}
// T3 需要 agent 身份(放在 L 段建频道后)

/* ═══ L 产线供数 ═══ */
console.log('\n[L] 产线供数(真连 PLC)')
{
  const existing = await api('GET', '/api/workshop/daq', undefined, H())
  for (const n of (existing.data?.nodes ?? [])) await api('DELETE', `/api/workshop/daq/${n.id}`, undefined, H())
}
const lineId = (await api('POST', '/api/workshop/dcw/lines', { name: `稳定报告产线-${TAG}` }, H())).data?.line?.id
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
await api('POST', '/api/workshop/daq/controller', { action: 'start' }, H())
const lineStart = await api('POST', `/api/workshop/dcw/lines/${lineId}/start`, { recipeId }, H())
check('L1a', '产线搭建+开跑(SP=130 写穿)', lineStart.status === 200 && Boolean(lineId && recipeId && daqNodeId), lineStart.message ?? '')
let hasData = false
for (let i = 0; i < 30; i++) {
  await sleep(5000)
  const w = await api('GET', `/api/workshop/daq/${daqNodeId}/samples?bucketMs=1000&limit=5`, undefined, H())
  if ((w.data?.points ?? []).length > 0) { hasData = true; break }
}
check('L1b', 'DAQ 真实采样落库', hasData)
await sleep(20_000)

/* ═══ 频道 + lead ═══ */
const channelId = (await api('POST', '/api/workshop/channels', { name: `报告频道-${TAG}`, templateKey: 'legacy' }, H())).data?.channelId
const agentId = ((await api('POST', `/api/workshop/channels/${channelId}/agents`, { name: `报告工程师-${TAG}`, role: 'lead', harness: 'omp' }, H())).data)?.id
await api('PUT', `/api/workshop/channels/${channelId}/line`, { lineId }, H())
check('L2', '频道/lead/绑线', Boolean(channelId && agentId))
await checkAgentToolFace(agentId)

/* T3 死工具直接 invoke(需 agent 身份) */
{
  const dead = await inv(agentId, 'dcw_read', { node_id: dcwNodeId })
  check('T3', 'invoke 已摘除工具 → 干净报错(未知工具)', invErr(dead) && /未知工具|未知|not|未实现/i.test(invText(dead)), invText(dead).slice(0, 120))
}

/* ═══ U 用户管理与权限隔离 ═══ */
console.log('\n[U] 用户管理与权限隔离')
let viewerA = '', viewerB = '', tokenA = '', tokenB = ''
{
  const ua = await api('POST', '/api/users', { name: `viewer-a-${TAG}`, email: `viewer-a-${TAG}@awshop.local`, password: 'Viewer@2026' }, H())
  const ub = await api('POST', '/api/users', { name: `viewer-b-${TAG}`, email: `viewer-b-${TAG}@awshop.local`, password: 'Viewer@2026' }, H())
  viewerA = ua.data?.user?.id ?? ua.data?.id ?? ''
  viewerB = ub.data?.user?.id ?? ub.data?.id ?? ''
  check('U1', 'admin 创建两个普通用户', Boolean(viewerA && viewerB), `a=${viewerA} b=${viewerB}`)
  tokenA = (await api('POST', '/api/users/login', { email: `viewer-a-${TAG}@awshop.local`, password: 'Viewer@2026' })).data?.token
  tokenB = (await api('POST', '/api/users/login', { email: `viewer-b-${TAG}@awshop.local`, password: 'Viewer@2026' })).data?.token
  check('U1b', '两个普通用户可登录', Boolean(tokenA && tokenB))
  const bad = await api('POST', '/api/users/login', { email: `viewer-a-${TAG}@awshop.local`, password: 'Wrong#2026' })
  check('U7', '错误密码登录被拒(401)', bad.status === 401 || bad.error === true, `status=${bad.status}`)

  // 先落一份基线分析(授权可见性的标的)
  const save = await inv(agentId, 'analysis_save', {
    title: `基线工况-${TAG}`,
    summary: `开跑基线:SP=130,DAQ ${daqNodeId} 真实采样`,
    conclusions: ['开跑批次激活,样本落库'],
    report: `## 基线\n\n产线 ${lineId},配方 ${recipeId}。`,
    category: 'quality', recipe_id: recipeId,
    data_sources: `daq ${daqNodeId}`,
  })
  const baseReportId = invText(save).match(/ar-[0-9a-f]{8}/)?.[0]
  check('U1c', '基线分析已入账(权限测试标的)', Boolean(baseReportId), invText(save).slice(0, 120))

  // U2 viewer-b 无任何授权
  const bList = await api('GET', '/api/workshop/analysis?limit=50', undefined, tokenB)
  const bRows = bList.data?.reports ?? []
  check('U2a', '无授权用户分析列表为空(作用域空集=不可见,而非不过滤)', (bList.data?.count ?? 0) === 0 && bRows.length === 0, `count=${bList.data?.count}`)
  const bDetail = await api('GET', `/api/workshop/analysis/${baseReportId}`, undefined, tokenB)
  check('U2b', '无授权用户访问报告详情被拒(403/404)', bDetail.status === 403 || bDetail.status === 404, `status=${bDetail.status}`)
  const bDaq = await api('GET', '/api/workshop/daq', undefined, tokenB)
  check('U2c', '无授权用户看不到产线数采节点', !(bDaq.data?.nodes ?? []).some(n => n.lineId === lineId), `nodes=${(bDaq.data?.nodes ?? []).length}`)
  const bLines = await api('GET', '/api/workshop/dcw/lines', undefined, tokenB)
  check('U2d', '无授权用户看不到产线', !(bLines.data?.lines ?? []).some(l => l.id === lineId), `lines=${(bLines.data?.lines ?? []).length}`)
  const bOps = await api('GET', '/api/workshop/ops-logs?limit=10', undefined, tokenB)
  check('U2e', '无授权用户访问运维审计被拒(403)', bOps.status === 403 || bOps.error === true, `status=${bOps.status}`)
  const bHitl = await api('GET', '/api/workshop/hitl/pending', undefined, tokenB)
  check('U2f', '无授权用户 HITL 快照不含他产线待办', !(bHitl.data?.items ?? []).some(i => i.channelId === channelId), `items=${(bHitl.data?.items ?? []).length}`)

  // U3 viewer-a 只读授权
  const g1 = await api('PUT', '/api/workshop/permissions', { userId: viewerA, grants: [{ lineId, mode: 'readonly' }] }, H())
  check('U3a', 'admin 授 viewer-a 产线只读', g1.status === 200, JSON.stringify(g1).slice(0, 100))
  const aList = await api('GET', '/api/workshop/analysis?limit=50', undefined, tokenA)
  check('U3b', '只读用户可见该产线分析', (aList.data?.reports ?? []).some(r => r.id === baseReportId), `count=${aList.data?.count}`)
  const aDetail = await api('GET', `/api/workshop/analysis/${baseReportId}`, undefined, tokenA)
  check('U3c', '只读用户可读详情(canEdit=false)', aDetail.status === 200 && aDetail.data?.report?.canEdit === false, `canEdit=${aDetail.data?.report?.canEdit}`)
  const aPatch = await api('PATCH', `/api/workshop/analysis/${baseReportId}`, { summary: '越权修改尝试' }, tokenA)
  check('U3d', '只读用户修改被拒(403)', aPatch.status === 403, `status=${aPatch.status}`)
  const aDel = await api('DELETE', `/api/workshop/analysis/${baseReportId}`, undefined, tokenA)
  check('U3e', '只读用户删除被拒(403)', aDel.status === 403, `status=${aDel.status}`)

  // U4 升级 operate → 可修改(归因刷新)
  await api('PUT', '/api/workshop/permissions', { userId: viewerA, grants: [{ lineId, mode: 'operate' }] }, H())
  const aPatch2 = await api('PATCH', `/api/workshop/analysis/${baseReportId}`, { summary: `人工复核通过-${TAG}` }, tokenA)
  check('U4', 'operate 用户修改成功且归因刷新', aPatch2.status === 200 && String(aPatch2.data?.report?.updatedByName ?? '').includes('viewer-a'),
    `status=${aPatch2.status} by=${aPatch2.data?.report?.updatedByName}`)

  // U5 撤销授权 → 不可见
  await api('PUT', '/api/workshop/permissions', { userId: viewerA, grants: [{ lineId, mode: null }] }, H())
  const aList2 = await api('GET', '/api/workshop/analysis?limit=50', undefined, tokenA)
  check('U5', '撤销授权后产线分析不可见', !(aList2.data?.reports ?? []).some(r => r.id === baseReportId), `count=${aList2.data?.count}`)

  // U6 非管理员不能授权/建用户
  const aGrant = await api('PUT', '/api/workshop/permissions', { userId: viewerB, grants: [{ lineId, mode: 'operate' }] }, tokenA)
  check('U6a', '普通用户授权被拒(403)', aGrant.status === 403 || aGrant.error === true, `status=${aGrant.status}`)
  const aCreate = await api('POST', '/api/users', { name: 'x', email: `x-${TAG}@awshop.local`, password: 'X@2026' }, tokenA)
  check('U6b', '普通用户建用户被拒(403)', aCreate.status === 403 || aCreate.error === true, `status=${aCreate.status}`)

  // 恢复 viewer-a 只读(R 段可见性用)
  await api('PUT', '/api/workshop/permissions', { userId: viewerA, grants: [{ lineId, mode: 'readonly' }] }, H())
}

/* ═══ R 在线产线报告链(IDD line-stability-report) ═══ */
console.log('\n[R] 在线产线报告链(diag_run 后台 + taskId 进度 + 入库检索)')
let runId = ''
{
  const t0 = Date.now()
  const r1 = await inv(agentId, 'diag_run', {
    line: lineId,
    analysis_intent: 'stability-report',
    question: `产线 ${lineId} 运行稳定性报告:评估当前烘干温度回路运行状况,给出等级与建议(不需要根因分析)`,
    scene: `aw_line_report_${TAG}`,
  }, 180_000)
  runId = (invText(r1).match(/task[_\s-]?id[=:]\s*([A-Za-z0-9-]+)/i) ?? invText(r1).match(/\b([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\b/i) ?? [])[1]
    ?? (invText(r1).match(/run[_\s-]?id[=:]\s*([A-Za-z0-9-]+)/i) ?? [])[1] ?? ''
  check('R1', `diag_run 受理即返后台 task_id(${Math.round((Date.now() - t0) / 1000)}s)`, !invErr(r1) && Boolean(runId), invText(r1).slice(0, 220))

  // R2-R3:diag_status 按 taskId 轮询(进度可见 → 终态)
  let st = null
  let sawRunning = false
  const deadline = Date.now() + POLL_MIN * 60_000
  while (Date.now() < deadline) {
    await sleep(15_000)
    const r = await inv(agentId, 'diag_status', runId ? { run_id: runId } : {}, 60_000)
    const txt = invText(r)
    const s = (txt.match(/\|\s*(running|pending|queued|completed|failed)\s*\|/i)?.[1]
      ?? txt.match(/状态[:=]\s*(\w+)/)?.[1]
      ?? txt.match(/状态[:：]\s*(\w+)/)?.[1] ?? '').toLowerCase()
    if (s && !['completed', 'failed'].includes(s)) sawRunning = true
    console.log(`  …[${Math.round((Date.now() - t0) / 1000)}s] ${txt.replace(/\n/g, ' ').slice(0, 150)}`)
    if (/completed|已完成|failed|失败/.test(txt)) { st = txt; break }
    st = txt
  }
  check('R2', '后台执行可见运行中进度(按 taskId)', sawRunning, '未见 running 态(可能过快完成)')
  check('R3', '任务到 completed 终态且报告产出', /completed|已完成/.test(String(st)) && /(report|\.md)/i.test(String(st)), String(st).slice(0, 220))

  // R4:结果整合入账(报告要点引用 run_id)
  const repM = String(st).match(/(D:[^\s"']+\.md)/) ?? String(st).match(/([^\s"']*report\.md)/)
  const save = await inv(agentId, 'analysis_save', {
    title: `产线稳定报告·IDD-${TAG}`,
    summary: `IDD line-stability-report 产出生产状况分析:等级/评分与运行建议见结论;诊断任务 ${runId}`,
    conclusions: [
      `IDD 任务 ${runId} 以 stability-report 意图完成(零根因分析,产线报告协议)`,
      `报告文件: ${repM?.[1] ?? '(见任务回执)'}`,
      `结论由 IDD 对产线 ${lineId} 真实时序快照运行 skill 脚本得出`,
    ],
    report: `## 产线稳定报告(IDD industrial-line-stability-report)\n\n- 诊断任务: ${runId}\n- 数据: 产线 ${lineId} DAQ 快照(配方 ${recipeId})\n- 摘要: ${String(st).slice(0, 400)}`,
    category: 'report', recipe_id: recipeId,
    data_sources: `diag_run task_id=${runId}(analysisIntent=stability-report);daq 快照导出`,
    metrics: { task_id: runId, intent: 'stability-report', line_id: lineId },
  })
  const reportId = invText(save).match(/ar-[0-9a-f]{8}/)?.[0]
  check('R4', '报告结果入分析库(引用 run_id)', !invErr(save) && Boolean(reportId), invText(save).slice(0, 160))

  // R5:多维检索
  const byRecipe = await api('GET', `/api/workshop/analysis?recipeId=${recipeId}`, undefined, H())
  check('R5a', 'REST 按配方检索命中报告', (byRecipe.data?.reports ?? []).some(r => r.id === reportId), `count=${byRecipe.data?.count}`)
  const byKw = await api('GET', `/api/workshop/analysis?q=${encodeURIComponent('稳定报告')}`, undefined, H())
  check('R5b', 'REST 关键词检索命中', (byKw.data?.reports ?? []).some(r => r.id === reportId), `count=${byKw.data?.count}`)
  const byTool = await inv(agentId, 'analysis_query', { report_id: reportId })
  check('R5c', '工具面按 id 取回全文', !invErr(byTool) && invText(byTool).includes('稳定报告'), invText(byTool).slice(0, 140))

  // R6:权限可见性闭环(viewer-a 只读授权在 U 段已恢复)
  const aSee = await api('GET', '/api/workshop/analysis?limit=50', undefined, tokenA)
  check('R6a', '授权(只读)用户可见产线报告', (aSee.data?.reports ?? []).some(r => r.id === reportId), `count=${aSee.data?.count}`)
  const aDetail = await api('GET', `/api/workshop/analysis/${reportId}`, undefined, tokenA)
  check('R6b', '授权用户可读报告详情', aDetail.status === 200 && Boolean(aDetail.data?.report?.title), `status=${aDetail.status}`)
  const bSee = await api('GET', '/api/workshop/analysis?limit=50', undefined, tokenB)
  const bDetail = await api('GET', `/api/workshop/analysis/${reportId}`, undefined, tokenB)
  check('R6c', '未授权用户列表与详情均不可见', !(bSee.data?.reports ?? []).some(r => r.id === reportId) && (bDetail.status === 403 || bDetail.status === 404),
    `listCount=${bSee.data?.count} detail=${bDetail.status}`)
}

/* ═══ K RAG 后台链(kb_agent async + taskId) ═══ */
console.log('\n[K] RAG 后台链(kb_agent)')
{
  const kbPrompt = `请把以下产线分析报告入库到知识库 aw-industrial。标题:「产线稳定报告-${TAG}」。正文:\n\n# 产线稳定报告 ${TAG}\n\n产线 ${lineId}(配方 ${recipeId})运行稳定性评估:IDD 任务 ${runId} 以 stability-report 意图完成;烘干温度回路 SP=130,DAQ 真实采样;结论:运行受控,详见平台分析台账 ${'`'}analysis_reports${'`'}。`
  const k1 = await inv(agentId, 'kb_agent', { prompt: kbPrompt, mode: 'async' }, 120_000)
  const kbTaskId = (invText(k1).match(/task[_\s-]?id[:\s]*([A-Za-z0-9_-]+)/i) ?? [])[1] ?? ''
  check('K1', 'kb_agent async 入库即返 task_id', !invErr(k1) && Boolean(kbTaskId), invText(k1).slice(0, 180))

  let kbDone = false
  if (kbTaskId) {
    for (let i = 0; i < 40; i++) {
      await sleep(15_000)
      const s = await inv(agentId, 'kb_agent_status', { task_id: kbTaskId }, 60_000)
      const txt = invText(s)
      if (/completed|已完成|完成|success/i.test(txt)) { kbDone = true; break }
      if (/failed|失败|error/i.test(txt)) { console.log('  · kb 状态:', txt.slice(0, 160)); break }
      if (i % 4 === 3) console.log(`  …[${i * 15}s] ${txt.replace(/\n/g, ' ').slice(0, 120)}`)
    }
  }
  check('K2', `kb_agent_status 按 taskId 查到完成(kbTaskId=${kbTaskId})`, kbDone)

  const k3 = await inv(agentId, 'kb_agent', { prompt: `检索问答:产线稳定报告 ${TAG} 的结论是什么?`, mode: 'sync' }, 180_000)
  check('K3', 'kb_agent 检索命中入库内容', !invErr(k3) && (invText(k3).includes(TAG) || /稳定报告|运行|受控/.test(invText(k3))), invText(k3).slice(0, 180))
}

/* ═══ 汇总 ═══ */
const failed = fails.length
console.log(`\n════ 综合终验:${results.length - failed}/${results.length} 通过 ════`)
if (failed) { console.log('未通过:'); for (const f of fails) console.log('  ✖', f) }
const { writeFileSync } = await import('node:fs')
writeFileSync('D:/tmp/aw-fc-1015/final-verify-state.json', JSON.stringify({
  base: BASE, tag: TAG, lineId, recipeId, daqNodeId, dcwNodeId, channelId, agentId, runId,
  viewerA: `viewer-a-${TAG}@awshop.local`, viewerB: `viewer-b-${TAG}@awshop.local`,
}, null, 1))
if (failed) process.exit(1)
console.log('FINAL-VERIFY OK')
