#!/usr/bin/env node
/**
 * 统一验收：三维度修复的 HTTP 级验证（针对 acceptance 构建）。
 * 用法: AW_BASE=http://127.0.0.1:3011 node scripts/demo/accept-harness-fix.mjs
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const EVID = join(REPO, 'docs/audit/evidence/2026-11-09-harness-fix-acceptance')
mkdirSync(EVID, { recursive: true })
const BASE = process.env.AW_BASE || 'http://127.0.0.1:3011'
const EMAIL = process.env.AW_EMAIL || 'visual@awshop.local'
const PASS = process.env.AW_PASS || 'Visual2026'

const results = []
const ok = (id, name, cond, detail = '') => {
  results.push({ id, name, pass: Boolean(cond), detail: String(detail).slice(0, 400) })
  console.log(`${cond ? '✔' : '✖'} [${id}] ${name}${cond ? '' : ` — ${String(detail).slice(0, 240)}`}`)
}
const sleep = ms => new Promise(r => setTimeout(r, ms))

async function call(method, path, body, token, timeoutMs = 60_000) {
  const res = await fetch(BASE + path, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: (body === undefined || body === null) ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  })
  const json = await res.json().catch(() => null)
  return { http: res.status, code: json?.code, data: json?.data, message: json?.message, raw: json }
}
const arr = d => (Array.isArray(d) ? d : [])

const main = async () => {
  const login = await call('POST', '/api/users/login', { email: EMAIL, password: PASS })
  const token = login.data?.token
  ok('A0', '登录', Boolean(token), login.message)

  /* ===== 场景：项目 + 交付物 + 工作项 ===== */
  const pr = (await call('POST', '/api/workshop/projects', {
    name: `验收-${Date.now().toString(36).slice(-5)}`, objective: '三维度修复 HTTP 验收', leaderHarness: 'mock',
  }, token)).data
  const ch = (await call('POST', '/api/workshop/channels', {
    name: `验收频道-${Date.now().toString(36).slice(-4)}`, scenarioPrompt: 'x',
    leadAgent: { name: 'Acc Lead', harness: 'mock', config: {} },
  }, token)).data
  await call('POST', `/api/workshop/projects/${pr.id}/channels`, { channelId: ch.channelId, charter: 'x' }, token)
  const dv = (await call('POST', `/api/workshop/projects/${pr.id}/deliverables`, {
    name: '验收交付物', ownerChannelId: ch.channelId, required: true, acceptanceCriteria: ['产物存在'],
  }, token)).data
  const wi = (await call('POST', `/api/workshop/projects/${pr.id}/work-items`, {
    deliverableId: dv.id, channelId: ch.channelId, title: '验收工作项', dedupeKey: `acc-${Date.now().toString(36)}`,
  }, token)).data
  ok('A1', '夹具建立(项目/频道/交付物/工作项)', Boolean(pr?.id && dv?.id && wi?.id))

  /* ===== PR-3：子资源主路径 GET ===== */
  const wiGet = await call('GET', `/api/workshop/projects/${pr.id}/work-items/${wi.id}`, null, token)
  ok('G1', 'GET 工作项主路径 200（原 404 非信封）', wiGet.http === 200 && wiGet.data?.id === wi.id, `http=${wiGet.http} code=${wiGet.code}`)
  const dvGet = await call('GET', `/api/workshop/projects/${pr.id}/deliverables/${dv.id}`, null, token)
  ok('G2', 'GET 交付物主路径 200', dvGet.http === 200 && dvGet.data?.id === dv.id, `http=${dvGet.http}`)
  const cross = await call('GET', `/api/workshop/projects/${pr.id}/work-items/not-exist-id`, null, token)
  ok('G3', '跨项目/不存在 id → 404 统一信封', cross.http === 404 && cross.code === 'NOT_FOUND' && cross.data === null,
    `http=${cross.http} code=${cross.code} data=${JSON.stringify(cross.data)}`)

  /* ===== PR-2：写面 schema（400 精确到字段） ===== */
  const dcwBad = await call('POST', '/api/workshop/dcw/params/nope/write', { value: 'abc' }, token)
  ok('S1', 'dcw 参数写:value 非数值 → 400 且字段精确', dcwBad.http === 400 && /^value:/.test(String(dcwBad.message ?? '')),
    `http=${dcwBad.http} msg=${wiSafe(dcwBad.message)}`)
  const dcwNan = await call('POST', '/api/workshop/dcw/params/nope/write', { value: {} }, token)
  ok('S2', 'dcw 参数写:对象值 → 400（旧实现 Number({})=NaN 会带进控制器）', dcwNan.http === 400 && /^value:/.test(String(dcwNan.message ?? '')),
    `http=${dcwNan.http} msg=${wiSafe(dcwNan.message)}`)
  const invBad = await call('POST', '/api/workshop/agent-tools/invoke', { agentId: '', tool: '' }, token)
  ok('S3', '工具桥:空 agentId → 400 字段精确', invBad.http === 400 && /^(agentId|tool):/.test(String(invBad.message ?? '')),
    `http=${invBad.http} msg=${wiSafe(invBad.message)}`)
  const invBadTool = await call('POST', '/api/workshop/agent-tools/invoke', { agentId: 'a', tool: 'bad tool!' }, token)
  ok('S4', '工具桥:非法 tool 名 → 400', invBadTool.http === 400 && /^tool:/.test(String(invBadTool.message ?? '')),
    `http=${invBadTool.http} msg=${wiSafe(invBadTool.message)}`)
  const invArgs = await call('POST', '/api/workshop/agent-tools/invoke', { agentId: 'a', tool: 'ok', args: [1, 2] }, token)
  ok('S5', '工具桥:args 非对象 → 400', invArgs.http === 400 && /^args:/.test(String(invArgs.message ?? '')),
    `http=${invArgs.http} msg=${wiSafe(invArgs.message)}`)
  const hitlBad = await call('POST', '/api/workshop/hitl/respond', { kind: 'made-up', id: 'x' }, token)
  ok('S6', 'HITL:未知 kind → 400', hitlBad.http === 400, `http=${hitlBad.http}`)
  const permBad = await call('PUT', '/api/workshop/permissions', { userId: 'u', grants: [{ lineId: 'l', mode: 'root' }] }, token)
  ok('S7', '权限:非法 mode → 400（原 as string 落库）', permBad.http === 400 && /grants/.test(String(permBad.message ?? '')),
    `http=${permBad.http} msg=${wiSafe(permBad.message)}`)
  const secretBad = await call('PUT', '/api/workshop/mes/secrets', { ref: '  ', value: 'x' }, token)
  ok('S8', 'MES 凭据:空 ref → 400', secretBad.http === 400 && /^ref:/.test(String(secretBad.message ?? '')),
    `http=${secretBad.http} msg=${wiSafe(secretBad.message)}`)
  const twinBad = await call('POST', '/api/workshop/device-twins/x/control', { command: '' }, token)
  ok('S9', '孪生控制:空 command → 400', twinBad.http === 400, `http=${twinBad.http}`)

  /* ===== 2026-11-10 P0：写值形状 + 审批显式布尔 ===== */
  // 旧实现 Number(null)===0 → 真实的 0 设定下发;现必须 400 且字段精确
  const nullWrite = await call('POST', '/api/workshop/dcw/no-such-node/write', { value: null }, token)
  ok('S10', 'dcw 核心写:{value:null} → 400（旧实现 Number(null)=0 会下发 0）',
    nullWrite.http === 400 && /^value:/.test(String(nullWrite.message ?? '')),
    `http=${nullWrite.http} msg=${wiSafe(nullWrite.message)}`)
  const arrWrite = await call('POST', '/api/workshop/dcw/params/no-such-param/write', { value: [] }, token)
  ok('S11', 'dcw 参数写:{value:[]} → 400（coerce 折叠 0 链已堵）',
    arrWrite.http === 400 && /^value:/.test(String(arrWrite.message ?? '')),
    `http=${arrWrite.http} msg=${wiSafe(arrWrite.message)}`)
  // approved 必须显式布尔:{} / "false" / 0 一律 400(fail-open 回归守卫)
  const decideEmpty = await call('POST', '/api/workshop/approvals/no-such-approval/decide', {}, token)
  ok('S12', '复核裁决:缺 approved → 400（旧实现 {} 也算批准）',
    decideEmpty.http === 400 && /^approved:/.test(String(decideEmpty.message ?? '')),
    `http=${decideEmpty.http} msg=${wiSafe(decideEmpty.message)}`)

  /* ===== 2026-11-10 契约：plugins 信封 / harness 工具面 / 停机端点 ===== */
  const plugins = await call('GET', '/api/workshop/plugins', null, token)
  ok('C1', 'GET /plugins 已走统一信封（data.plugins）',
    plugins.http === 200 && plugins.code === 0 && Array.isArray(plugins.data?.plugins),
    `http=${plugins.http} code=${plugins.code} keys=${Object.keys(plugins.data ?? {}).join(',')}`)
  const harnesses = await call('GET', '/api/workshop/harnesses', null, token)
  const hlist = Array.isArray(harnesses.data) ? harnesses.data : (harnesses.data?.harnesses ?? [])
  const manualSurface = hlist.filter(h => h?.toolSurface === 'manual').map(h => h.id).sort()
  ok('C2', 'GET /harnesses 下发 toolSurface（dsh/hermes/crush 标 manual）',
    manualSurface.join(',') === 'crush,dsh,hermes', `manual=[${manualSurface.join(',')}] total=${hlist.length}`)
  // 无令牌/无头 → 绝不允许 200(dev 实例 404;aw start 实例 403)
  const shutdownNoAuth = await call('POST', '/api/system/shutdown', {}, token)
  ok('C3', '停机端点未持令牌时拒绝（404 未启用 / 403 令牌无效）',
    [403, 404].includes(shutdownNoAuth.http) && shutdownNoAuth.code !== 0,
    `http=${shutdownNoAuth.http} code=${shutdownNoAuth.code}`)

  /* ===== PR-6：剩余四个子资源 GET（404 一律统一信封；不存在的 id 即可验证路由存在） ===== */
  const missingId = 'no-such-id-acceptance'
  const g1 = await call('GET', `/api/workshop/aml/models/${missingId}`, null, token)
  ok('G4', 'GET /aml/models/:id 路由存在（404 统一信封，非 h3 默认体）',
    g1.http === 404 && g1.code === 'AML_MODEL_MISSING' && g1.data === null, `http=${g1.http} code=${g1.code}`)
  const g2 = await call('GET', `/api/workshop/aml/training-plans/${missingId}`, null, token)
  ok('G5', 'GET /aml/training-plans/:id 路由存在（404 统一信封）',
    g2.http === 404 && g2.code === 'TRAINING_PLAN_MISSING' && g2.data === null, `http=${g2.http} code=${g2.code}`)
  const g3 = await call('GET', `/api/workshop/dcw/${missingId}`, null, token)
  ok('G6', 'GET /dcw/:id 路由存在（404 统一信封）',
    g3.http === 404 && g3.code === 'NOT_FOUND', `http=${g3.http} code=${g3.code}`)
  const g4 = await call('GET', `/api/workshop/daq/${missingId}`, null, token)
  ok('G7', 'GET /daq/:id 路由存在（404 统一信封）',
    g4.http === 404 && g4.code === 'NOT_FOUND', `http=${g4.http} code=${g4.code}`)
  const g5 = await call('GET', `/api/workshop/dcw/lines/${missingId}`, null, token)
  ok('G8', 'GET /dcw/lines/:id 产线详情路由存在（404 统一信封）',
    g5.http === 404 && g5.code === 'NOT_FOUND', `http=${g5.http} code=${g5.code}`)
  // 列表端点仍可用（query schema 不误伤合法请求）
  // 注:line_id/node_ids 至少一个是既有业务规则(DataQueryError),与 query schema 无关;
  // 这里只断言「不再出现字段级解析错误」,业务规则 400 属正常。
  const listDaq = await call('GET', '/api/workshop/daq/query?line_id=no-such-line&last_minutes=5', null, token)
  ok('Q1', 'GET /daq/query 合法 last_minutes 不被 schema 误拒',
    !/^last_minutes:/.test(String(listDaq.message ?? '')), `http=${listDaq.http} msg=${wiSafe(listDaq.message)}`)
  const badNum = await call('GET', '/api/workshop/daq/query?line_id=L&last_minutes=abc', null, token)
  ok('Q2', 'GET /daq/query 非法数值 → 400 精确到字段',
    badNum.http === 400 && /last_minutes/.test(String(badNum.message ?? '')), `http=${badNum.http} msg=${wiSafe(badNum.message)}`)
  const badAgg = await call('GET', '/api/workshop/daq/query?line_id=L&agg=bogus', null, token)
  ok('Q3', 'GET /daq/query 非法 agg → 400', badAgg.http === 400, `http=${badAgg.http}`)
  const emptyOk = await call('GET', '/api/workshop/daq/query?line_id=L&last_minutes=', null, token)
  ok('Q4', 'GET /daq/query 空串参数=未提供（旧语义保持）',
    !/^last_minutes:/.test(String(emptyOk.message ?? '')), `http=${emptyOk.http} msg=${wiSafe(emptyOk.message)}`)
  const ds = await call('GET', '/api/workshop/aml/datasets?lineId=&productId=', null, token)
  ok('Q5', 'GET /aml/datasets 空串过滤不误拒', ds.http === 200, `http=${ds.http} code=${ds.code}`)
  const jobs = await call('GET', '/api/workshop/aml/jobs?status=&datasetId=', null, token)
  ok('Q6', 'GET /aml/jobs 空串过滤不误拒', jobs.http === 200, `http=${jobs.http} code=${jobs.code}`)

  /* ===== PR-1：omp 会话身份（terminate → 重建 → sessionId 非空且不等于旧值） ===== */
  const chOmp = (await call('POST', '/api/workshop/channels', {
    name: `身份验收-${Date.now().toString(36).slice(-4)}`, scenarioPrompt: 'x',
    leadAgent: { name: 'Sid Probe', harness: 'omp', config: { promptTimeoutMs: 1_800_000 } },
  }, token)).data
  const mon = async () => {
    const m = (await call('GET', '/api/system/monitor', null, token)).data ?? {}
    const a = arr(m.agents).find(x => x.agentId === chOmp?.leadAgentId)
    return { sid: a?.continuity?.sessionId ?? null, pid: a?.process?.pid ?? null, state: a?.state }
  }
  await call('POST', `/api/workshop/channels/${chOmp.channelId}/messages`, {
    toAgentId: chOmp.leadAgentId, text: '请只回复 OK 两个字母。', requireReply: true, priority: 'immediate',
  }, token)
  let first = null
  for (let i = 0; i < 30; i++) {
    await sleep(10_000)
    first = await mon()
    if (first.sid) break
  }
  ok('H1', '基线:首次 spawn 建立 sessionId', Boolean(first?.sid), JSON.stringify(first))
  // terminate → 触发重建 → 发消息 → 期望 sessionId 非空且 ≠ 旧值
  await call('POST', '/api/system/monitor/terminate', { channelId: chOmp.channelId, agentId: chOmp.leadAgentId }, token)
  await sleep(8_000)
  await call('POST', `/api/workshop/channels/${chOmp.channelId}/messages`, {
    toAgentId: chOmp.leadAgentId, text: '请只回复 OK。', requireReply: true, priority: 'immediate',
  }, token)
  let second = null
  for (let i = 0; i < 30; i++) {
    await sleep(10_000)
    second = await mon()
    if (second.sid && second.pid) break
  }
  ok('H2', '重建后 sessionId 非空（重绑成功）', Boolean(second?.sid), JSON.stringify(second))
  ok('H3', '重建后 sessionId ≠ 旧值（无陈旧绑定）', Boolean(second?.sid) && second.sid !== first?.sid,
    `old=${String(first?.sid).slice(0, 12)} new=${String(second?.sid).slice(0, 12)}`)

  const summary = {
    generatedAt: new Date().toISOString(), base: BASE,
    pass: results.filter(r => r.pass).length, fail: results.filter(r => !r.pass).length, results,
  }
  writeFileSync(join(EVID, 'acceptance.json'), `${JSON.stringify(summary, null, 2)}\n`, 'utf8')
  console.log(`\n=== ACCEPT pass=${summary.pass} fail=${summary.fail} → ${EVID} ===`)
  process.exitCode = summary.fail > 0 ? 1 : 0
}
const wiSafe = s => String(s ?? '').slice(0, 90)
main().catch((e) => {
  console.error('验收异常:', String(e).slice(0, 300))
  process.exit(1)
})
