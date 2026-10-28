#!/usr/bin/env node
/**
 * 核心桥梁矩阵 E2E —— 实例②(隔离,mock harness 确定性,无 LLM):
 *   A 动态工具注册:注入面按 Agent 绑定实时编译(绑/解绑即变,同工具集不同描述)
 *   B 工具调用认证放行:agent token 自证/错配 401/无身份 401/引用面越线拒/写面预检拒
 *   C 数据采集:DAQ 真实采样落库,daq_query 按授权面取数
 *   D 控制参数下发:点位绑定 + HITL 批准 → 四层限界 → ACK 证实 → journal 落账
 *   E 产线配方管理权:管理操作全线放行,下发仍按点位收窄
 *
 * 收口条件:全部断言 PASS(负向断言按预期拒绝才算过)。
 * 运行:node scripts/e2e-core-bridges-matrix.mjs(自起隔离实例,端口 3411)
 * 证据:docs/audit/evidence/2026-10-28-core-bridges/report.json
 */
import { spawn } from 'node:child_process'
import { mkdirSync, openSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import { DatabaseSync } from 'node:sqlite'

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const TAG = `cb${Date.now().toString(36).slice(-4)}`
const ROOT = join(tmpdir(), `aw-bridges-e2e-${TAG}`)
mkdirSync(join(ROOT, 'home'), { recursive: true })
writeFileSync(join(ROOT, 'home', 'runtime-settings.json'), JSON.stringify({ version: 1, overrides: { 'security.hitl_timeout_ms': 60_000, 'security.recipe_dispatch_timeout_ms': 60_000 } }))
const results = []
const ok = (id, name, cond, detail = '') => {
  results.push({ id, name, pass: Boolean(cond), detail: String(detail).slice(0, 700) })
  console.log(`${cond ? '✔' : '✖'} [${id}] ${name}${cond ? '' : ` — ${String(detail).slice(0, 500)}`}`)
  return Boolean(cond)
}
const sleep = ms => new Promise(r => setTimeout(r, ms))

let port = 0
for (const p of [3411, 3413, 3414]) {
  try {
    const r = await fetch(`http://127.0.0.1:${p}/api/health`, { signal: AbortSignal.timeout(1200) })
    if (r.ok) continue
  }
  catch { /* 空闲 */ }
  port = p
  break
}
if (!port) {
  console.error('无空闲端口')
  process.exit(1)
}
const BASE = `http://127.0.0.1:${port}`
process.env.NO_PROXY = '127.0.0.1,localhost'
const logFd = openSync(join(ROOT, 'dev.log'), 'a')
const child = spawn(process.execPath, [join(REPO, 'bin', 'aw.mjs'), 'dev', '--port', String(port)], {
  cwd: REPO,
  env: {
    ...process.env,
    AW_MODE: 'home',
    AW_HOME: join(ROOT, 'home'),
    AW_RATE_LIMIT_OFF: '1',
    AW_TRIAL_INTERVAL_MS: '0',
    NUXT_SESSION_PASSWORD: 'CoreBridges#2026-e2e-key',
    NO_PROXY: '127.0.0.1,localhost',
  },
  stdio: ['ignore', logFd, logFd],
  windowsHide: true,
})

async function api(method, path, body, token, extraHeaders = {}, timeoutMs = 120_000) {
  const res = await fetch(BASE + path, {
    method,
    headers: {
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...extraHeaders,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  })
  let json = null
  try {
    json = await res.json()
  }
  catch { /* 非 JSON */ }
  return { status: res.status, ...json }
}
const invText = r => String(r?.data?.result?.text ?? r?.data?.text ?? '')
const invErr = r => Boolean(r?.data?.result?.isError ?? r?.data?.isError)
const dbPath = join(ROOT, 'home', 'data', 'workshop.sqlite')
function agentTokenOf(agentId) {
  const db = new DatabaseSync(dbPath)
  try {
    return String(db.prepare('SELECT token FROM channel_agents WHERE id = ?').get(agentId)?.token ?? '')
  }
  finally {
    db.close()
  }
}
const callAs = (agentId, token, tool, args) => api('POST', '/api/workshop/agent-tools/invoke', { agentId, tool, args }, undefined, { 'x-aw-agent-token': token })
const bind = (agentId, nodeId, kind, mode) => api('POST', '/api/workshop/agent-tools/bindings', { agentId, nodeId, kind, ...(mode ? { mode } : {}) }, admin)
const setMode = (id, mode, confirm = false) => api('PATCH', `/api/workshop/agent-tools/bindings/${id}`, confirm ? { mode, confirm: true } : { mode }, admin)
const toolListOf = async (agentId, token) => {
  const r = await api('GET', `/api/workshop/agent-tools/list?agentId=${encodeURIComponent(agentId)}`, undefined, undefined, { 'x-aw-agent-token': token })
  return r?.data?.tools ?? []
}
const descOf = (tools, name) => String(tools.find(t => t.name === name)?.description ?? '')
async function pendingOf(agentId) {
  const r = await api('GET', `/api/workshop/agent-tools/approvals?agentId=${encodeURIComponent(agentId)}`, undefined, admin)
  return (r?.data?.approvals ?? []).filter(a => a.status === 'pending')
}

let admin = ''
try {
  let healthy = false
  for (let i = 0; i < 90; i++) {
    await sleep(2000)
    try {
      const h = await api('GET', '/api/health', undefined, undefined, {}, 3000)
      if (h?.data?.status === 'ok' && h?.data?.workshop === 'ready') {
        healthy = true
        break
      }
    }
    catch { /* 未就绪 */ }
  }
  ok('X0', '隔离实例②启动 + workshop ready', healthy, `port=${port}`)
  if (!healthy) throw new Error('实例未就绪')
  admin = (await api('POST', '/api/users/register', { name: `cb-admin-${TAG}`, email: `cb-${TAG}@awshop.local`, password: 'CbAdmin#2026' })).data?.token
  ok('X0b', 'admin 注册', Boolean(admin))

  // ── 场景:两线;线A = 2 数采 + 2 数控(配方双参数,开跑);线B = 数采+数控(不开跑) ──
  const mkLine = async name => (await api('POST', '/api/workshop/dcw/lines', { name }, admin)).data?.line?.id
  const lineA = await mkLine(`桥梁线A-${TAG}`)
  const lineB = await mkLine(`桥梁线B-${TAG}`)
  const tpl = (await api('POST', '/api/workshop/dcw/templates', { name: `桥梁参数-${TAG}`, ch: '温度', unit: '℃', min: 0, max: 100, decimals: 1 }, admin)).data?.template?.key
  const mkDaq = (name, lineId) => api('POST', '/api/workshop/daq', {
    name, driver: 'mock', templateRef: 'daq-temp-tc', lineId, intervalMs: 1000, publishIntervalMs: 0, min: 0, max: 100,
  }, admin).then(r => r.data?.node?.id)
  const mkDcw = (name, lineId, key) => api('POST', '/api/workshop/dcw', {
    name, driver: 'mock', templateRef: tpl, lineId, stepLimit: 20, writeLockSeconds: 0, readIntervalMs: 0, driverConfig: { key },
  }, admin).then(r => r.data?.node?.id)
  const dnA1 = await mkDaq(`数采A1-${TAG}`, lineA)
  const dnA2 = await mkDaq(`数采A2-${TAG}`, lineA)
  const dnB = await mkDaq(`数采B-${TAG}`, lineB)
  const dwA1 = await mkDcw(`数控A1-${TAG}`, lineA, `cb-a1-${TAG}`)
  const dwA2 = await mkDcw(`数控A2-${TAG}`, lineA, `cb-a2-${TAG}`)
  const dwB = await mkDcw(`数控B-${TAG}`, lineB, `cb-b-${TAG}`)
  const prodA = (await api('POST', '/api/workshop/dcw/products', { lineId: lineA, name: `桥梁产品A-${TAG}` }, admin)).data?.product?.id
  const rcA = (await api('POST', '/api/workshop/dcw/recipes', {
    productId: prodA, name: `桥梁配方A-${TAG}`, opIntervalMs: 0,
    params: [{ nodeId: dwA1, value: 50, min: 0, max: 100 }, { nodeId: dwA2, value: 50, min: 0, max: 100 }],
  }, admin)).data?.recipe?.id
  ok('X1', '两线/数采/数控/产品/双参数配方就绪', Boolean(lineA && lineB && dnA1 && dnA2 && dnB && dwA1 && dwA2 && dwB && prodA && rcA),
    JSON.stringify({ lineA, lineB, dnA1, dnA2, dnB, dwA1, dwA2, dwB, rcA }))
  const daqStart = await api('POST', '/api/workshop/daq/controller', { action: 'start' }, admin)
  ok('X1b', 'DAQ 控制器开采', daqStart.status === 200, `status=${daqStart.status}`)
  const startA = await api('POST', `/api/workshop/dcw/lines/${lineA}/start`, { recipeId: rcA }, admin)
  ok('X1c', '线A开跑(活动批次,配方整批下发)', startA.status === 200, `status=${startA.status}`)
  // 线总闸切 auto:让 auto 绑定的管理/下发免批(X6 的 manual 点位绑定仍挂 HITL)
  const lineAuto = await api('PATCH', `/api/workshop/dcw/lines/${lineA}`, { controlMode: 'auto', confirm: true }, admin)
  ok('X1d', '线A controlMode 切 auto(confirm)', lineAuto.status === 200 && lineAuto?.data?.line?.controlMode === 'auto', `status=${lineAuto.status}`)

  // ── 频道绑线A + 3 worker(差异化绑定) ──
  const ch = (await api('POST', '/api/workshop/channels', { name: `桥梁频道-${TAG}`, lineId: lineA, leadAgent: { name: `cb-lead-${TAG}`, harness: 'mock' } }, admin)).data
  const channelId = ch?.channelId
  const mkWorker = async (name) => {
    const w = (await api('POST', `/api/workshop/channels/${channelId}/agents`, { name, harness: 'mock', role: 'worker' }, admin)).data
    return String(w?.id ?? w?.agentId ?? '')
  }
  const w1 = await mkWorker(`cb-w1-${TAG}`)
  const w2 = await mkWorker(`cb-w2-${TAG}`)
  const w3 = await mkWorker(`cb-w3-${TAG}`)
  ok('X2', '频道绑线A + 3 worker', Boolean(channelId && w1 && w2 && w3), JSON.stringify({ channelId, w1, w2, w3 }))
  const tok = { w1: agentTokenOf(w1), w2: agentTokenOf(w2), w3: agentTokenOf(w3) }
  const b1 = await bind(w1, dnA1, 'daq', 'auto')
  const b1r = await bind(w1, rcA, 'recipe', 'auto')
  const b2 = await bind(w2, dnA2, 'daq', 'auto')
  const b3 = await bind(w3, dwA1, 'dcw', 'auto')
  ok('X2b', '差异化绑定落库(w1=daqA1+recipeA / w2=daqA2 / w3=dcwA1)', b1.status === 200 && b1r.status === 200 && b2.status === 200 && b3.status === 200,
    `status=${b1.status}/${b1r.status}/${b2.status}/${b3.status}`)

  // ── A 动态工具注册 ──
  const listW1 = await toolListOf(w1, tok.w1)
  const listW2 = await toolListOf(w2, tok.w2)
  ok('X3', 'Agent 工具面非空且同工具集(视图编译非克隆)', listW1.length > 20 && JSON.stringify(listW1.map(t => t.name).sort()) === JSON.stringify(listW2.map(t => t.name).sort()),
    `w1=${listW1.length} w2=${listW2.length}`)
  const daqDescW1 = descOf(listW1, 'daq_query')
  const daqDescW2 = descOf(listW2, 'daq_query')
  // 只看「直接绑定」段:频道绑线只读段本来就会列出全线数采节点(正确行为)
  const directSeg = (desc) => {
    const m = desc.match(/直接绑定的数采节点\(仅这些可查\):([^\n]*)/)
    return m?.[1] ?? ''
  }
  ok('X3b', '注入面按绑定差异化:直接绑定段 w1 只见 dnA1;w2 只见 dnA2',
    directSeg(daqDescW1).includes(dnA1) && !directSeg(daqDescW1).includes(dnA2) && directSeg(daqDescW2).includes(dnA2) && !directSeg(daqDescW2).includes(dnA1),
    `w1=[${directSeg(daqDescW1)}] w2=[${directSeg(daqDescW2)}]`)
  const updDescW1 = descOf(listW1, 'recipe_update')
  const updDescW2 = descOf(listW2, 'recipe_update')
  ok('X3c', '配方注入面只进持配方授权的 Agent', updDescW1.includes(rcA) && !updDescW2.includes(rcA), `w1=${updDescW1.slice(-140)}`)
  const trialDescW3 = descOf(await toolListOf(w3, tok.w3), 'recipe_trial')
  ok('X3d', '点位写授权面注入 w3 的下发工具描述', trialDescW3.includes(dwA1) && /写授权面/.test(trialDescW3), trialDescW3.slice(-160))
  // 动态:解绑即从注入面消失
  await api('DELETE', `/api/workshop/agent-tools/bindings/${b2?.data?.binding?.id}`, undefined, admin)
  const listW2After = await toolListOf(w2, tok.w2)
  const directSegAfter = directSeg(descOf(listW2After, 'daq_query'))
  ok('X3e', '解绑后注入面即时收窄:直接绑定段不再含 dnA2(无绑定时段整体消失,节点只留在频道只读段)', !directSegAfter.includes(dnA2), `direct=[${directSegAfter}]`)
  // 动态:授产线管理权即出现
  const lg = await bind(w2, lineA, 'line-recipe', 'auto')
  const lgId = String(lg?.data?.binding?.id ?? '')
  await setMode(lgId, 'auto', true)
  const listW2Mgr = await toolListOf(w2, tok.w2)
  ok('X3f', '授予产线管理权后注入面即时声明(动态注册)', descOf(listW2Mgr, 'recipe_update').includes(lineA) && /配方管理权/.test(descOf(listW2Mgr, 'recipe_update')),
    descOf(listW2Mgr, 'recipe_update').slice(-160))
  // 观察频道:写面摘除
  const obsCh = (await api('POST', '/api/workshop/channels', { name: `桥梁观察频道-${TAG}`, lineId: lineA, leadAgent: { name: `cb-obs-${TAG}`, harness: 'mock' } }, admin)).data
  await api('PATCH', `/api/workshop/channels/${obsCh.channelId}/execution-mode`, { mode: 'observe' }, admin)
  const obsAgent = String(obsCh?.leadAgent?.id ?? obsCh?.leadAgentId ?? '')
  const obsTok = agentTokenOf(obsAgent)
  const obsTools = await toolListOf(obsAgent, obsTok)
  ok('X3g', 'observe 频道注入面零写族(动态摘除)', obsTools.length > 10 && !obsTools.some(t => /recipe_trial|recipe_apply|recipe_update|recipe_rollback|recipe_create/.test(t.name)),
    `tools=${obsTools.length} writeTools=${obsTools.filter(t => /recipe_|line_start|line_stop/.test(t.name)).map(t => t.name).join(',')}`)

  // ── B 认证放行 ──
  const badTok = await api('POST', '/api/workshop/agent-tools/invoke', { agentId: w1, tool: 'daq_query', args: {} }, undefined, { 'x-aw-agent-token': 'wrong-token-xxxx' })
  ok('X4', '错误 agent token → 401', badTok.status === 401, `status=${badTok.status}`)
  const mismatch = await callAs(w1, tok.w2, 'daq_query', {})
  ok('X4b', 'token 与 agentId 错配 → 401(自证失败)', mismatch.status === 401, `status=${mismatch.status}`)
  const noAuth = await api('POST', '/api/workshop/agent-tools/invoke', { agentId: w1, tool: 'daq_query', args: {} })
  ok('X4c', '无任何身份 invoke → 401', noAuth.status === 401, `status=${noAuth.status}`)
  const crossLine = await callAs(w1, tok.w1, 'daq_query', { node_id: dnB })
  ok('X4d', 'w1 查他线节点 → 引用面拒绝', invErr(crossLine) && /工具调用被拒/.test(invText(crossLine)), invText(crossLine).slice(0, 200))
  const ownQuery = await callAs(w1, tok.w1, 'daq_query', { node_id: dnA1 })
  ok('X4e', 'w1 查自己绑定节点 → 放行', !invErr(ownQuery), invText(ownQuery).slice(0, 160))
  const lineExpansion = await callAs(w2, tok.w2, 'daq_query', { node_id: dnA1 })
  ok('X4f', '频道绑线只读扩权:w2(绑 dnA2,频道绑线A)可读 dnA1', !invErr(lineExpansion), invText(lineExpansion).slice(0, 160))

  // ── C 数据采集(真实采样落库) ──
  await sleep(8000)
  const samples = await callAs(w1, tok.w1, 'daq_query', { node_id: dnA1, last_minutes: 5 })
  const sampleText = invText(samples)
  const sampleMatch = sampleText.match(/样本\s*(\d+)\s*点/)
  ok('X5', 'DAQ 采样落库且 daq_query 可取(真实采集)', !invErr(samples) && Number(sampleMatch?.[1] ?? 0) > 0, sampleText.slice(0, 260))

  // ── D 控制参数下发(点位绑定 + HITL + ACK + 账本) ──
  const trialNoAuth = await callAs(w3, tok.w3, 'recipe_trial', { line_id: lineA, params: [{ node_id: dwA2, value: 55 }], hypothesis: '未绑定节点应被写面拒绝' })
  ok('X6', '下发未绑定节点 → 写面预检拒绝(点名节点)', invErr(trialNoAuth) && /写授权|绑定面/.test(invText(trialNoAuth)) && invText(trialNoAuth).includes(dwA2), invText(trialNoAuth).slice(0, 240))
  const trialP = callAs(w3, tok.w3, 'recipe_trial', { line_id: lineA, params: [{ node_id: dwA1, value: 55 }], hypothesis: 'E2E:点位绑定 + HITL 下发' })
  let card = (await pendingOf(w3))[0]
  for (let i = 0; i < 150 && !card; i++) {
    await sleep(200)
    card = (await pendingOf(w3))[0]
  }
  ok('X6b', '首绑 manual → trial 挂人工审批卡', Boolean(card), card ? `card=${card.id}` : '未出现')
  if (card) {
    const decide = await api('POST', `/api/workshop/agent-tools/approvals/${card.id}/decide`, { approved: true, comment: 'E2E:批准点位下发' }, admin)
    ok('X6c', '人工批准(附言回流路径)', decide.status === 200, `status=${decide.status}`)
  }
  const trialOut = await trialP
  ok('X6d', '批准后下发执行且 ACK 设备证实', !invErr(trialOut) && /试验已整批下发.*证实/.test(invText(trialOut)), invText(trialOut).slice(0, 240))
  const jr = await api('GET', `/api/workshop/dcw/journal?lineId=${lineA}&limit=50`, undefined, admin)
  const jA1 = (jr?.data?.anchors ?? []).find(a => a.nodeId === dwA1 && a.prevValue === 50 && a.newValue === 55)
  ok('X6e', '下发落 journal 账本(50→55,绑定 run)', Boolean(jA1), JSON.stringify(jA1 ?? null).slice(0, 240))
  const dwList = await api('GET', '/api/workshop/dcw', undefined, admin)
  const dwA1Row = (dwList?.data?.nodes ?? []).find(n => n.id === dwA1)
  ok('X6f', '设备侧现值=账本新值(独立回读)', Number(dwA1Row?.value) === 55, `value=${dwA1Row?.value}`)

  // ── E 产线配方管理权:管理放行 + 下发收窄 ──
  const updMgr = await callAs(w2, tok.w2, 'recipe_update', { line_id: lineA, params: [{ node_id: dwA2, value: 52 }], reason: 'E2E:管理权直接修改全线配方' })
  ok('X7', '管理权 Agent 修改线A配方(无单配方绑定)→ 成功生成新版本', !invErr(updMgr) && /已保存|新版本|v\d/.test(invText(updMgr)), invText(updMgr).slice(0, 240))
  const trialFull = await callAs(w2, tok.w2, 'recipe_trial', { line_id: lineA, params: [{ node_id: dwA2, value: 56 }], hypothesis: 'E2E:管理权无 dcw → 全参数下发' })
  ok('X7b', '管理权 + 无 dcw 绑定 → trial 全参数放行(向下兼容)', !invErr(trialFull) && /试验已整批下发/.test(invText(trialFull)), invText(trialFull).slice(0, 220))
  const w2d = await bind(w2, dwA1, 'dcw', 'auto')
  await setMode(String(w2d?.data?.binding?.id ?? ''), 'auto', true)
  const trialNarrow = await callAs(w2, tok.w2, 'recipe_trial', { line_id: lineA, params: [{ node_id: dwA2, value: 57 }], hypothesis: 'E2E:收窄后未绑点应拒' })
  ok('X7c', '补绑 dcw 后下发收窄:未绑定节点拒(点名)', invErr(trialNarrow) && /下发被收窄|只能覆盖这些点位/.test(invText(trialNarrow)) && invText(trialNarrow).includes(dwA2), invText(trialNarrow).slice(0, 260))
  const trialScoped = await callAs(w2, tok.w2, 'recipe_trial', { line_id: lineA, params: [{ node_id: dwA1, value: 57 }], hypothesis: 'E2E:绑定点位内放行' })
  ok('X7d', '收窄后绑定点位内 trial 放行', !invErr(trialScoped) && /试验已整批下发/.test(invText(trialScoped)), invText(trialScoped).slice(0, 220))
  const updAfter = await callAs(w2, tok.w2, 'recipe_update', { line_id: lineA, params: [{ node_id: dwA2, value: 53 }], reason: 'E2E:收窄后版本操作仍放行' })
  ok('X7e', 'dcw 收窄不影响版本操作(管理权仍可 update 成功)', !invErr(updAfter) && /已保存|新版本|v\d/.test(invText(updAfter)), invText(updAfter).slice(0, 200))
  const lgRevoke = await api('DELETE', `/api/workshop/agent-tools/bindings/${lgId}`, undefined, admin)
  const updAfterRevoke = await callAs(w2, tok.w2, 'recipe_update', { line_id: lineA, params: [{ node_id: dwA2, value: 54 }], reason: 'E2E:收回管理权后应拒绝' })
  ok('X7f', '收回产线管理权后 recipe_update → 拒绝(需配方级授权)', lgRevoke.status === 200 && invErr(updAfterRevoke) && /配方级授权|版本操作|配方管理权/.test(invText(updAfterRevoke)), `status=${lgRevoke.status} ${invText(updAfterRevoke).slice(0, 240)}`)
}
catch (err) {
  ok('FATAL', 'E2E 未捕获异常', false, err instanceof Error ? `${err.message}\n${err.stack ?? ''}` : String(err))
}
finally {
  try {
    child.kill()
  }
  catch { /* noop */ }
  const passed = results.filter(r => r.pass).length
  const total = results.length
  const evidenceDir = join(REPO, 'docs', 'audit', 'evidence', '2026-10-28-core-bridges')
  mkdirSync(evidenceDir, { recursive: true })
  const evidencePath = join(evidenceDir, 'report.json')
  writeFileSync(evidencePath, JSON.stringify({
    at: new Date().toISOString(),
    env: { base: BASE, home: join(ROOT, 'home'), devLog: join(ROOT, 'dev.log'), instance: '②-core-bridges', mode: 'isolated', harness: 'mock(deterministic)' },
    summary: { total, passed, failed: total - passed, verdict: passed === total ? 'PASS' : 'FAIL' },
    results,
  }, null, 2))
  console.log(`\n结论:${passed === total ? 'PASS' : 'FAIL'}(${passed}/${total})`)
  console.log(`证据:${evidencePath}`)
  process.exit(passed === total ? 0 : 1)
}
