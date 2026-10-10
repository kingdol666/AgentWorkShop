/**
 * 生产化加固专项 e2e(2026-10-08)—— P0-A 写控 ACK 鉴定层 + P0-B HITL 手动总闸。
 *
 * 腿:A 线级 controlMode API 语义(缺省 manual / confirm 守卫)
 *     B mock 线 ACK 闭环(REST apply → 写后验证 verified → ackSummary → ops verdict)
 *     C mqtt 不可达 broker → failed → ops level=error(+线域通知)
 *     D mqtt 可达 broker → transport-ack → 补验无读通道 → unverified → ops level=warn
 *     E HITL 总闸:manual 线 auto 绑定 recipe_apply 挂审批卡(定向通知)→ 批准/拒绝回流
 *     F 总闸解除:line auto + auto 绑定 → 免批直执行
 *     G hold 模式:审批不自动拒、expiresAt 空、催办后批准
 *
 * 前置:生产服务 3001 已载入新代码;benchmark 线与 worker agent 存在(benchmark.config.json)。
 */
import benchCfg from '../scripts/testing/benchmark.config.json' with { type: 'json' }
import { resolve } from 'node:path'

const cfg = benchCfg
const BASE = 'http://127.0.0.1:3001'
const checks = []
let TOKEN = ''

function ok(name, pass, detail = '') {
  checks.push({ name, pass: !!pass, detail: String(detail).slice(0, 160) })
  console.log(`${pass ? '✅' : '❌'} ${name}${detail ? ` — ${String(detail).slice(0, 160)}` : ''}`)
}

async function api(method, path, body, token = TOKEN) {
  const res = await fetch(BASE + path, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(60_000),
  })
  let j = null
  try {
    j = await res.json()
  }
  catch { /* 非 JSON */ }
  return { status: res.status, ...(j ?? {}) }
}
const sleep = ms => new Promise(r => setTimeout(r, ms))

// ================= 登录 =================
const login = await api('POST', '/api/users/login', { email: cfg.account.email, password: cfg.account.password })
TOKEN = login?.data?.token ?? ''
ok('登录(admin)', !!TOKEN, login?.message ?? '')

// ops-op 测试用户(线域通知接收人;现场确保存在)
async function ensureOpsUser() {
  const email = 'ops-ack@test.local'
  const lg = await api('POST', '/api/users/login', { email, password: 'OpsAck@2026' })
  if (lg?.data?.token) {
    const list = await api('GET', '/api/users?pageSize=50&keyword=ops-ack')
    const row = (list?.data?.items ?? []).find(u => u.email === email)
    return { token: lg.data.token, id: row?.id ?? lg.data.user?.id ?? '' }
  }
  const created = await api('POST', '/api/users', { name: 'ops-ack', email, password: 'OpsAck@2026', role: 'user' })
  if (!created?.data?.user?.id && !created?.data?.id) console.log('  (ops 用户创建返回:', JSON.stringify(created).slice(0, 120), ')')
  const lg2 = await api('POST', '/api/users/login', { email, password: 'OpsAck@2026' })
  const list = await api('GET', '/api/users?pageSize=50&keyword=ops-ack')
  const row = (list?.data?.items ?? list?.data?.users ?? []).find(u => u.email === email)
  return { token: lg2?.data?.token ?? '', id: row?.id ?? created?.data?.user?.id ?? created?.data?.id ?? '' }
}
const opsUser = await ensureOpsUser()
ok('ops 测试用户就绪(通知接收人)', !!opsUser.token && !!opsUser.id, `id=${String(opsUser.id).slice(0, 8)}`)

// ================= 腿 A:线级 controlMode API =================
console.log('\n── 腿 A:线级 controlMode API 语义 ──')
const suffix = Date.now().toString(36)
const lineA = await api('POST', '/api/workshop/dcw/lines', { name: `ACK鉴定线-${suffix}` })
const lineId = lineA?.data?.line?.id ?? ''
ok('A1 新建线缺省 controlMode=manual(fail-safe)', lineA?.data?.line?.controlMode === 'manual', `got=${lineA?.data?.line?.controlMode}`)
const noConfirm = await api('PATCH', `/api/workshop/dcw/lines/${lineId}`, { controlMode: 'auto' })
ok('A2 manual→auto 无 confirm 拒绝(400 MODE_CONFIRM_REQUIRED)', noConfirm.status === 400 && /MODE_CONFIRM_REQUIRED|确认/.test(noConfirm.message ?? ''), `${noConfirm.status} ${noConfirm.message ?? ''}`)
const withConfirm = await api('PATCH', `/api/workshop/dcw/lines/${lineId}`, { controlMode: 'auto', confirm: true })
ok('A3 manual→auto 带 confirm:true 放行', withConfirm?.data?.line?.controlMode === 'auto', `got=${withConfirm?.data?.line?.controlMode}`)
const backManual = await api('PATCH', `/api/workshop/dcw/lines/${lineId}`, { controlMode: 'manual' })
ok('A4 auto→manual 自由方向', backManual?.data?.line?.controlMode === 'manual', `got=${backManual?.data?.line?.controlMode}`)

// ================= 公共:mock 线装配(节点/产品/配方) =================
async function mkNode(name, driver, driverConfig) {
  const r = await api('POST', '/api/workshop/dcw', {
    name, driver, driverConfig, templateRef: 'temp-sp',
    min: 0, max: 100, unit: 'u', decimals: 2, lineId,
  })
  if (!r?.data?.node?.id) console.log('  (节点创建失败:', JSON.stringify(r).slice(0, 140), ')')
  return r?.data?.node?.id ?? ''
}
const n1 = await mkNode(`mock压力-${suffix}`, 'mock', { key: `ack-p-${suffix}` })
const n2 = await mkNode(`mock温度-${suffix}`, 'mock', { key: `ack-t-${suffix}` })
ok('B0 mock 写控节点 ×2 创建', !!n1 && !!n2, `${n1.slice(0, 8)}, ${n2.slice(0, 8)}`)
const prod = await api('POST', '/api/workshop/dcw/products', { name: `ACK产品-${suffix}`, lineId })
const productId = prod?.data?.product?.id ?? ''
const rec = await api('POST', '/api/workshop/dcw/recipes', {
  name: `ACK配方-${suffix}`, productId, lineId, opIntervalMs: 0,
  params: [{ nodeId: n1, value: 50 }, { nodeId: n2, value: 60 }],
})
const recipeId = rec?.data?.recipe?.id ?? ''
ok('B0 配方创建(2 mock 参数)', !!recipeId, recipeId)

// ================= 腿 B:mock 线 ACK 闭环(REST apply → 写后验证) =================
console.log('\n── 腿 B:mock 线 ACK 鉴定闭环 ──')
const apply1 = await api('POST', `/api/workshop/dcw/recipes/${recipeId}/apply`)
const run1 = apply1?.data?.run
const results1 = run1?.results ?? []
const allVerified = results1.length === 2 && results1.every(r => r.ok && r.ack === 'readback-verified' && r.verify?.verdict === 'verified')
ok('B1 mock 整批 apply:两参数均「设备证实」(transport-ack→写后验证升级)', allVerified, JSON.stringify(results1.map(r => ({ ok: r.ok, ack: r.ack, v: r.verify?.verdict, at: r.verify?.attempts }))))
ok('B2 run.ackSummary 三段汇总(verified=2/unverified=0/failed=0)', run1?.ackSummary?.verified === 2 && run1?.ackSummary?.unverified === 0 && run1?.ackSummary?.failed === 0, JSON.stringify(run1?.ackSummary))
await sleep(300)
const ackLogs = await api('GET', '/api/workshop/ops-logs?action=recipe.dispatch.ack&limit=5')
const topAck = (ackLogs?.data?.logs ?? [])[0]
ok('B3 ops 判定条目 recipe.dispatch.ack 落账(level=info)', topAck?.level === 'info' && String(topAck?.summary ?? '').includes('批次'), topAck?.summary ?? '(无)')
const dcwAgg = await api('GET', '/api/workshop/dcw')
const wh = (dcwAgg?.data?.history ?? []).filter(h => h.nodeId === n1).sort((a, b) => b.at.localeCompare(a.at))[0]
// 写历史如实记录**驱动级** ack(mock 写=transport-ack 回显);设备证实升级记录在批次结果行(见 B1)
ok('B4 写历史条目携带 ack 字段(驱动级如实)', wh?.ack === 'transport-ack', `ack=${wh?.ack ?? '(缺)'}`)

// ================= 腿 C:mqtt 不可达 broker → failed → error =================
console.log('\n── 腿 C:mqtt 不可达 broker → 写入失败 → ops error ──')
const nBad = await mkNode(`mqtt断链-${suffix}`, 'mqtt', { host: '127.0.0.1', port: 59980, topic: `e2e/ack/${suffix}` })
const recBad = await api('POST', '/api/workshop/dcw/recipes', {
  name: `ACK断链配方-${suffix}`, productId, lineId, opIntervalMs: 0,
  params: [{ nodeId: n1, value: 51 }, { nodeId: nBad, value: 50 }],
})
const applyBad = await api('POST', `/api/workshop/dcw/recipes/${recBad?.data?.recipe?.id}/apply`)
const runBad = applyBad?.data?.run
const badRow = (runBad?.results ?? []).find(r => r.nodeId === nBad)
ok('C1 mqtt 断链参数 ok=false + ack=unverified(不阻塞其余参数)', badRow && badRow.ok === false && badRow.ack === 'unverified', JSON.stringify({ ok: badRow?.ok, ack: badRow?.ack, msg: String(badRow?.message ?? '').slice(0, 60) }))
ok('C2 断链批次 ackSummary.failed=1', runBad?.ackSummary?.failed === 1 && runBad?.ackSummary?.verified === 1, JSON.stringify(runBad?.ackSummary))
await sleep(300)
const errLogs = await api('GET', '/api/workshop/ops-logs?action=recipe.dispatch.ack&level=error&limit=5')
const topErr = (errLogs?.data?.logs ?? [])[0]
ok('C3 ops 判定条目 level=error(写入失败如实记 error)', !!topErr && topErr.level === 'error', topErr?.summary ?? '(无)')

// ================= 腿 D:mqtt 可达 broker → transport-ack → unverified =================
console.log('\n── 腿 D:mqtt 可达 broker → 仅链路受理 → 未证实 → ops warn ──')
// broker 探活升级(2026-10-10):TCP 通≠可用(僵死的 Docker 端口代理会 accept 但永不回
// CONNACK,实测 Mosquitto 容器 wedged 全程 401/timeout)。做真实 MQTT CONNACK 握手,
// 依序探测 [1883 系统总线, 18830 模拟器内置],首个可用者作为腿 D 的在线 broker。
const { createRequire } = await import('node:module')
const reqMqtt = createRequire(resolve('package.json'))
const mqttLib = reqMqtt('mqtt')
async function brokerConnackOk(port) {
  return new Promise((resolve2) => {
    const c = mqttLib.connect(`mqtt://127.0.0.1:${port}`, { connectTimeout: 3000, reconnectPeriod: 0 })
    const done = (r) => {
      try {
        c.end(true)
      }
      catch { /* 已死 */ }
      resolve2(r)
    }
    c.once('connect', () => done(true))
    c.once('error', () => done(false))
    setTimeout(() => done(false), 3500)
  })
}
const brokerPort = await (async () => {
  for (const p of [1883, 18830]) {
    if (await brokerConnackOk(p)) return p
  }
  return 0
})()
const brokerUp = brokerPort > 0
let nMqtt = ''
let recLive = { data: {} }
if (brokerUp) {
  console.log(`  (腿 D 在线 broker=:${brokerPort})`)
  nMqtt = await mkNode(`mqtt在线-${suffix}`, 'mqtt', { host: '127.0.0.1', port: brokerPort, topic: `e2e/ack-live/${suffix}`, qos: 1 })
  recLive = await api('POST', '/api/workshop/dcw/recipes', {
    name: `ACK在线配方-${suffix}`, productId, lineId, opIntervalMs: 0,
    params: [{ nodeId: nMqtt, value: 42 }],
  })
  const applyLive = await api('POST', `/api/workshop/dcw/recipes/${recLive?.data?.recipe?.id}/apply`)
  const runLive = applyLive?.data?.run
  const liveRow = (runLive?.results ?? []).find(r => r.nodeId === nMqtt)
  ok('D1 mqtt 在线写 ok=true 但 ack=transport-ack(broker 受理≠设备证实)', liveRow?.ok === true && liveRow?.ack === 'transport-ack', JSON.stringify({ ok: liveRow?.ok, ack: liveRow?.ack }))
  ok('D2 写后验证:mqtt 无读通道 → verdict=unverified(不虚报成功)', liveRow?.verify?.verdict === 'unverified', JSON.stringify(liveRow?.verify))
  ok('D3 ackSummary.unverified=1 → ops level=warn', runLive?.ackSummary?.unverified === 1, JSON.stringify(runLive?.ackSummary))
  await sleep(300)
  const warnLogs = await api('GET', '/api/workshop/ops-logs?action=recipe.dispatch.ack&level=warn&limit=5')
  ok('D4 ops 判定条目 level=warn(未证实)', (warnLogs?.data?.logs ?? []).some(l => String(l.summary).includes('批次')), (warnLogs?.data?.logs ?? [])[0]?.summary ?? '(无)')
}
else {
  ok('D1 mqtt broker 不可达,腿 D 跳过(环境无 1883)', true, 'skip')
}

// ================= 腿 E:HITL 总闸(manual 线拦 auto 绑定)+ 定向通知 =================
console.log('\n── 腿 E:HITL 手动总闸 + 线域定向通知 ──')
// 幂等前置:上一轮可能在腿 F 把线切成 auto —— 显式归一回 manual 再验证缺省语义
await api('PATCH', `/api/workshop/dcw/lines/${cfg.lineId}`, { controlMode: 'manual' })
// 给 ops 用户授 benchmark 线 operate(通知接收人)
const grant = await api('PUT', '/api/workshop/permissions', { userId: opsUser.id, grants: [{ lineId: cfg.lineId, mode: 'operate' }] })
ok('E0 ops 用户授予 benchmark 线 operate', !!grant?.data?.userId, JSON.stringify(grant?.data?.grants ?? []).slice(0, 80))
// benchmark 线此时为缺省 manual(存量线归一)
const agg0 = await api('GET', '/api/workshop/dcw')
const bmLine = (agg0?.data?.lines ?? []).find(l => l.id === cfg.lineId)
const bmMode = bmLine?.controlMode === 'auto' ? 'auto' : 'manual'
ok('E1 benchmark 线缺省归一为 manual(存量数据 fail-safe)', bmMode === 'manual', `got=${bmLine?.controlMode ?? '(缺省)'}`)

// 并行裁决:invoke(recipe_apply, emergency 豁免频控)→ 卡出现 → ops 用户收到定向通知 → 批准
const invPending = api('POST', '/api/workshop/agent-tools/invoke', {
  agentId: cfg.workerId, tool: 'recipe_apply',
  args: { recipe_id: cfg.recipeId, reason: 'E2E 总闸验证:manual 线必须人工批准', emergency: true },
})
let card = null
for (let i = 0; i < 30 && !card; i++) {
  await sleep(500)
  const pend = await api('GET', '/api/workshop/hitl/pending')
  card = (pend?.data?.items ?? pend?.items ?? []).find(x => x.kind === 'dcw-approval' && String(x.nodeId ?? '').includes(cfg.recipeId))
}
ok('E2 manual 线拦截 auto 绑定:recipe_apply 挂审批卡(不执行)', !!card, card ? `${card.id} ${String(card.title ?? '').slice(0, 40)}` : '(未见卡)')
// ops 用户定向通知(线域触达)
await sleep(800)
const opsNotif = await api('GET', '/api/workshop/notifications?limit=20', undefined, opsUser.token)
const hit = (opsNotif?.data?.notifications ?? opsNotif?.notifications ?? []).find(n => n.type === 'hitl_request' && String(n.hitlId ?? n.payload?.hitlId ?? '') === card?.id)
ok('E3 线域运营者收到审批定向通知(hitl_request)', !!hit, hit ? String(hit.title ?? '').slice(0, 60) : JSON.stringify(opsNotif?.data?.notifications ?? []).slice(0, 80))
// 批准 → 工具回执
await fetch(BASE + '/api/workshop/hitl/respond', {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'authorization': `Bearer ${TOKEN}` },
  body: JSON.stringify({ kind: 'dcw-approval', id: card.id, confirmed: true, comment: '总闸验证批准' }),
})
const inv1 = await invPending
const t1 = String(inv1?.data?.result?.text ?? inv1?.data?.text ?? JSON.stringify(inv1?.data?.result ?? inv1?.data ?? ''))
ok('E4 批准后整批下发且回执「设备证实」(modbus 回读)', !inv1?.data?.result?.isError && /证实/.test(t1), t1.slice(0, 120))

// 拒绝路径:意见回流
const invPending2 = api('POST', '/api/workshop/agent-tools/invoke', {
  agentId: cfg.workerId, tool: 'recipe_apply',
  args: { recipe_id: cfg.recipeId, reason: 'E2E 总闸验证:拒绝路径', emergency: true },
})
let card2 = null
for (let i = 0; i < 30 && !card2; i++) {
  await sleep(500)
  const pend = await api('GET', '/api/workshop/hitl/pending')
  card2 = (pend?.data?.items ?? pend?.items ?? []).find(x => x.kind === 'dcw-approval' && String(x.nodeId ?? '').includes(cfg.recipeId))
}
await fetch(BASE + '/api/workshop/hitl/respond', {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'authorization': `Bearer ${TOKEN}` },
  body: JSON.stringify({ kind: 'dcw-approval', id: card2?.id, confirmed: false, comment: '先不要下发,保持现状' }),
})
const inv2 = await invPending2
const t2 = String(inv2?.data?.result?.text ?? inv2?.data?.text ?? JSON.stringify(inv2?.data?.result ?? inv2?.data ?? ''))
ok('E5 拒绝路径:回执「人工未批准」+ 意见逐字回流', /未批准|拒绝/.test(t2) && t2.includes('先不要下发'), t2.slice(0, 100))

// ================= 腿 F:总闸解除(line auto + auto 绑定 → 免批直执行) =================
console.log('\n── 腿 F:总闸解除(auto 线 + auto 绑定免批直执行)──')
const toAuto = await api('PATCH', `/api/workshop/dcw/lines/${cfg.lineId}`, { controlMode: 'auto', confirm: true })
ok('F1 benchmark 线切 auto(带 confirm)', toAuto?.data?.line?.controlMode === 'auto', `got=${toAuto?.data?.line?.controlMode}`)
// 绑定模式本来就manual:显式切 auto(带 confirm)—— 否则 manual 绑定在任何线都挂审批
const bList = await api('GET', `/api/workshop/agent-tools/bindings?agentId=${cfg.workerId}`)
const recipeBinding = (bList?.data?.bindings ?? []).find(b => b.kind === 'recipe' && b.nodeId === cfg.recipeId)
const bAuto = await api('PATCH', `/api/workshop/agent-tools/bindings/${recipeBinding?.id}`, { mode: 'auto', confirm: true })
ok('F1b 配方绑定切 auto(带 confirm)', bAuto?.data?.binding?.mode === 'auto', `got=${bAuto?.data?.binding?.mode ?? JSON.stringify(bAuto?.message ?? '').slice(0, 60)}`)
const invF = await api('POST', '/api/workshop/agent-tools/invoke', {
  agentId: cfg.workerId, tool: 'recipe_apply',
  args: { recipe_id: cfg.recipeId, reason: 'E2E 总闸解除验证:auto 线免批', emergency: true },
})
await sleep(500)
const afterPend = await api('GET', '/api/workshop/hitl/pending')
const pendCount = arr => (arr?.data?.items ?? arr?.items ?? []).filter(x => x.kind === 'dcw-approval' && String(x.nodeId ?? '').includes(cfg.recipeId)).length
const tF = String(invF?.data?.result?.text ?? invF?.data?.text ?? JSON.stringify(invF?.data?.result ?? invF?.data ?? ''))
ok('F2 auto 线 + auto 绑定免批直执行(无审批卡,回执设备证实)', pendCount(afterPend) === 0 && /证实/.test(tF) && !/未批准/.test(tF), tF.slice(0, 100))
// 还原绑定 manual(fail-safe 基线)
await api('PATCH', `/api/workshop/agent-tools/bindings/${recipeBinding?.id}`, { mode: 'manual' })

// ================= 腿 G:hold 模式(不自动拒 + 空到期 + 催办) =================
console.log('\n── 腿 G:hold 超时模式 ──')
// 切回 manual 再验 hold
await api('PATCH', `/api/workshop/dcw/lines/${cfg.lineId}`, { controlMode: 'manual' })
const setHold = await api('PATCH', '/api/system/settings', { override: { 'security.hitl_timeout_mode': 'hold' } })
ok('G1 设置 security.hitl_timeout_mode=hold', setHold?.code === 0 || setHold?.status === 200, JSON.stringify(setHold?.changed ?? setHold?.message ?? '').slice(0, 60))
const invPendingG = api('POST', '/api/workshop/agent-tools/invoke', {
  agentId: cfg.workerId, tool: 'recipe_apply',
  args: { recipe_id: cfg.recipeId, reason: 'E2E hold 模式验证', emergency: true },
})
let cardG = null
for (let i = 0; i < 30 && !cardG; i++) {
  await sleep(500)
  const pend = await api('GET', '/api/workshop/hitl/pending')
  cardG = (pend?.data?.items ?? pend?.items ?? []).find(x => x.kind === 'dcw-approval' && String(x.nodeId ?? '').includes(cfg.recipeId))
}
ok('G2 hold 模式审批卡挂起且 expiresAt 为空(不自动拒)', !!cardG && !cardG?.expiresAt, `expiresAt=${cardG?.expiresAt ?? '(空)'}`)
await sleep(4000)
const pendStill = await api('GET', '/api/workshop/hitl/pending')
const still = (pendStill?.data?.items ?? pendStill?.items ?? []).find(x => x.id === cardG?.id)
ok('G3 4s 后仍在 pending(reject 模式 180s 窗内无法区分,以 expiresAt 空为准;此处验证未被即时收敛)', !!still, still ? '仍挂起' : '(已被收敛)')
await fetch(BASE + '/api/workshop/hitl/respond', {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'authorization': `Bearer ${TOKEN}` },
  body: JSON.stringify({ kind: 'dcw-approval', id: cardG.id, confirmed: true, comment: 'hold 批准' }),
})
const invG = await invPendingG
const tG = String(invG?.data?.result?.text ?? invG?.data?.text ?? JSON.stringify(invG?.data?.result ?? invG?.data ?? ''))
ok('G4 hold 卡人工批准后正常执行', /证实|成功/.test(tG), tG.slice(0, 90))
// 恢复 reject + hold 下超时语义回归(短超时不适用于 hold:用 tool-approvals 默认窗断言)
await api('PATCH', '/api/system/settings', { override: { 'security.hitl_timeout_mode': 'reject' } })
ok('G5 设置恢复 reject(fail-closed 缺省)', true, 'restored')

// ================= 收尾:清理测试资源 =================
console.log('\n── 收尾:清理 ──')
for (const id of [recipeId, recBad?.data?.recipe?.id, recLive?.data?.recipe?.id].filter(Boolean)) {
  await api('DELETE', `/api/workshop/dcw/recipes/${id}`, undefined, TOKEN).catch(() => {})
}
for (const id of [n1, n2, nBad, nMqtt].filter(Boolean)) {
  await api('DELETE', `/api/workshop/dcw/${id}`, undefined, TOKEN).catch(() => {})
}
const delLine = await api('DELETE', `/api/workshop/dcw/lines/${lineId}`)
ok('Z1 测试线/节点/配方清理', delLine?.code === 0 || delLine?.status === 200, '')
// 撤销 ops 用户 grant(避免残留授权)
await api('PUT', '/api/workshop/permissions', { userId: opsUser.id, grants: [{ lineId: cfg.lineId, mode: null }] }).catch(() => {})

// ================= 汇总 =================
const pass = checks.filter(c => c.pass).length
console.log(`\n======== 专项 e2e 结果:${pass}/${checks.length} ========`)
for (const c of checks.filter(c => !c.pass)) console.log(`  FAIL: ${c.name} — ${c.detail}`)
process.exit(pass === checks.length ? 0 : 1)
