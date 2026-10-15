#!/usr/bin/env node
/**
 * 全链条终验 2026-10-15(0.7.62 干净隔离实例 + 真连 PLC 模拟器)。
 *   node tmp-e2e/fullchain-final-20261015.mjs --base http://127.0.0.1:3997
 *
 * ══ 验收标准(先行定义,逐条判定)══
 *  A 健康      A1 平台 0.7.62 workshop ready;A2 admin 就绪
 *  B 数采链    B1 产线/配方/DCW/DAQ 全链搭建;B2 采集总控启动;B3 开跑(SP=120 写穿);
 *              B4 首批真实样本;B5 PV 一阶收敛到 SP≈120
 *  C 数据获取  C1 REST 时间窗采样统计;C2 Agent 工具 daq_query 取到真实数据;C3 REST 设定值回读
 *  D 授权面 v2 D1 未授权产线 daq_query 被拒;D2 param_control v2 禁用口径;
 *              D3 未绑定节点 dcw_control 被拒;D4 未绑定配方 recipe_update 被拒
 *  E 配方链+HITL
 *              E1 lead 绑定(recipe manual + daq);E1b kind=dcw 直绑被 v2 拒;
 *              E2 trial 应急卡建立→拒绝附指导;E2b 指导回流;E2c PLC 值未被改动;
 *              E3 recipe_update 挂卡→批准→v2 落版本;E4 recipe_apply 挂卡→批准附言→设备证实✓;
 *              E5 PV 收敛到新 SP=150(物理跟随)
 *  F 治理负路径 F1 频控:apply 后立即再 apply 被拒
 *  G 分析入库  G1 基线分析留痕(结论=真实统计);G2 阶跃后对比分析留痕(引用配方 v2+HITL 附言);
 *              G3 工具面 analysis_query 按 report_id 取回全文;G4 工具面按产线列表;
 *              G5 REST 按配方检索;G6 REST 时间窗检索;G7 REST 关键词检索
 *  H 审计留痕  H1 ops-logs 含 recipe.update/recipe.apply/analysis.save 且 actorKind=agent;
 *              H2 产线维度审计计数完整(工具调用情况总览)
 * 判定:A-H 全绿 ⇒ 全链条可用于真实场景。
 */
const args = process.argv.slice(2)
const ix = args.indexOf('--base')
const BASE = ix >= 0 ? args[ix + 1] : 'http://127.0.0.1:3997'
const TAG = `fc${Date.now().toString(36).slice(-4)}`

const results = []
const fails = []
function check(id, name, pass, detail = '') {
  results.push({ id, name, pass: Boolean(pass) })
  console.log(`${pass ? '✔' : '✖'} [${id}] ${name}${pass ? '' : ` — ${String(detail).slice(0, 260)}`}`)
  if (!pass) fails.push(`${id} ${name}: ${String(detail).slice(0, 160)}`)
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

/* ═══ A 健康 ═══ */
const health = await api('GET', '/api/health')
check('A1', `平台健康(v=${health?.data?.version}, workshop=${health?.data?.workshop})`,
  health?.data?.status === 'ok' && health?.data?.workshop === 'ready' && String(health?.data?.version) === '0.7.62')
let token = (await api('POST', '/api/users/register', { name: 'fc-admin', email: `fc-${TAG}@awshop.local`, password: 'FcAdmin#2026' })).data?.token
const ei = args.indexOf('--email')
const pi = args.indexOf('--password')
if (!token && ei >= 0) token = (await api('POST', '/api/users/login', { email: args[ei + 1], password: pi >= 0 ? args[pi + 1] : 'FcAdmin#2026' })).data?.token
if (!token) token = (await api('POST', '/api/users/login', { email: `fc-${TAG}@awshop.local`, password: 'FcAdmin#2026' })).data?.token
check('A2', 'admin 就绪(首注册即 admin;重跑走登录)', Boolean(token))
const H = () => token
const inv = (agentId, tool, aargs, timeoutMs = 200_000) => fetch(BASE + '/api/workshop/agent-tools/invoke', {
  method: 'POST', headers: { 'content-type': 'application/json', 'authorization': `Bearer ${H()}` },
  body: JSON.stringify({ agentId, tool, args: aargs }), signal: AbortSignal.timeout(timeoutMs),
}).then(r => r.json().catch(() => ({}))).catch(e => ({ err: e.message }))
const invText = r => String(r?.data?.result?.text ?? r?.data?.text ?? JSON.stringify(r)).slice(0, 400)
const invErr = r => Boolean(r?.data?.result?.isError ?? r?.data?.isError)

/* HITL 审批卡:轮询 pending → 裁决(invoke 挂起中必须并行裁决) */
async function decideCard(recipeId, { approved, comment }, maxSec = 30) {
  for (let i = 0; i < Math.ceil((maxSec * 1000) / 1500); i++) {
    await sleep(1500)
    const p = await api('GET', '/api/workshop/hitl/pending', undefined, H())
    const card = (p.data?.items ?? []).find(x => x.kind === 'dcw-approval' && String(x.nodeId ?? '').includes(recipeId))
    if (card) {
      const r = await api('POST', '/api/workshop/hitl/respond', { kind: 'dcw-approval', id: card.id, confirmed: approved, comment, choice: 0 }, H())
      return { card, respond: r }
    }
  }
  return { card: null }
}

/* ═══ B 数采链(全部真连 PLC 模拟器 15041) ═══ */
console.log('\n[B] 数采链')
{
  const existing = await api('GET', '/api/workshop/daq', undefined, H())
  for (const n of (existing.data?.nodes ?? [])) await api('DELETE', `/api/workshop/daq/${n.id}`, undefined, H())
}
const lineId = (await api('POST', '/api/workshop/dcw/lines', { name: `烘干产线-${TAG}` }, H())).data?.line?.id
const productId = (await api('POST', '/api/workshop/dcw/products', { lineId, name: `隔膜产品-${TAG}` }, H())).data?.product?.id
const tplKey = (await api('POST', '/api/workshop/dcw/templates', { name: `烘干SP设定-${TAG}`, ch: '烘干温度', unit: '℃', min: 0, max: 260, decimals: 1 }, H())).data?.template?.key
const dcwNodeId = (await api('POST', '/api/workshop/dcw', {
  templateRef: tplKey, name: `烘干SP-${TAG}`, driver: 'modbus-tcp', lineId, stepLimit: 60, holdIntervalMs: 0,
  driverConfig: { host: '127.0.0.1', port: 15041, unitId: 1, register: 40021, dataType: 'float32', byteOrder: 'big' },
}, H())).data?.node?.id
const recipeId = (await api('POST', '/api/workshop/dcw/recipes', {
  productId, name: `标准烘干-${TAG}`, params: [{ nodeId: dcwNodeId, value: 120, min: 40, max: 220 }],
}, H())).data?.recipe?.id
const daqNodeId = (await api('POST', '/api/workshop/daq', {
  templateRef: 'daq-temp-tc', name: `烘干PV-${TAG}`, driver: 'modbus-tcp', lineId, intervalMs: 800, publishIntervalMs: 0,
  driverConfig: { host: '127.0.0.1', port: 15041, unitId: 1, register: 40001, registerType: 'holding', dataType: 'float32', byteOrder: 'big' },
}, H())).data?.node?.id
// 负路径用的孤立产线(不绑频道/不绑定/无授权)
const line2Id = (await api('POST', '/api/workshop/dcw/lines', { name: `邻线-${TAG}` }, H())).data?.line?.id
check('B1', '产线/产品/DCW/配方/DAQ/邻线 全链搭建', Boolean(lineId && productId && dcwNodeId && recipeId && daqNodeId && line2Id),
  `line=${lineId} recipe=${recipeId} daq=${daqNodeId}`)
const gw = await api('POST', '/api/workshop/daq/controller', { action: 'start' }, H())
check('B2', 'DAQ 采集总控启动', gw.status === 200 && gw.code === 0, JSON.stringify(gw).slice(0, 120))
const tLineStart = Date.now()
const lineStart = await api('POST', `/api/workshop/dcw/lines/${lineId}/start`, { recipeId }, H())
check('B3', '产线开跑(配方 SP=120 下发,活动批次激活=运行门就绪)', lineStart.status === 200, lineStart.message ?? JSON.stringify(lineStart).slice(0, 120))

console.log('  · 等新 DAQ 节点首批样本…')
let first = false
for (let i = 0; i < 36; i++) {
  await sleep(5000)
  const w = await api('GET', `/api/workshop/daq/${daqNodeId}/samples?bucketMs=1000&limit=5`, undefined, H())
  if ((w.data?.points ?? []).length > 0) { first = true; break }
}
check('B4', '首批真实样本产出', first)

/** 收敛等待:轮询 12s 采样窗直到 |mean-SP|<8(一阶惯性 τ=8s,爬升/回落双向) */
async function waitConverge(sp, maxRounds = 8) {
  for (let i = 0; i < maxRounds; i++) {
    const s = await sampleStats(12)
    if (s && Math.abs(s.mean - sp) < 8) return s
    console.log(`  [converge ${i + 1}] mean=${s?.mean ?? '?'}℃ 目标 ${sp}℃,继续等…`)
  }
  return null
}
console.log('  · 等 PV 收敛到 SP≈120(轮询采样窗)…')
const conv = await waitConverge(120)
check('B5', `PV 一阶收敛到 SP≈120(均值 ${conv?.mean ?? '?'}℃)`, Boolean(conv), JSON.stringify(conv ?? {}))

/* ═══ 频道 + lead(工具调用主体) ═══ */
const channelId = (await api('POST', '/api/workshop/channels', { name: `全链验收频道-${TAG}`, templateKey: 'legacy' }, H())).data?.channelId
const agentId = ((await api('POST', `/api/workshop/channels/${channelId}/agents`, { name: `工艺分析员-${TAG}`, role: 'lead', harness: 'omp' }, H())).data)?.id
await api('PUT', `/api/workshop/channels/${channelId}/line`, { lineId }, H())
check('B4b', '频道/lead(omp)/绑线', Boolean(channelId && agentId), `agent=${agentId}`)

async function sampleStats(seconds = 15) {
  const windowMs = seconds * 1000
  for (let attempt = 1; attempt <= 3; attempt++) {
    const t0 = Date.now()
    await sleep(windowMs)
    const t1 = Date.now()
    const r = await api('GET', `/api/workshop/daq/${daqNodeId}/samples?from=${t0}&to=${t1}&bucketMs=1000`, undefined, H())
    const pts = (r.data?.points ?? []).map(p => Number(p.avg ?? p.v)).filter(Number.isFinite)
    if (pts.length >= 5) {
      const mean = pts.reduce((a, b) => a + b, 0) / pts.length
      return {
        n: pts.length, min: Math.min(...pts), max: Math.max(...pts),
        mean: Math.round(mean * 100) / 100, drift: Math.round((pts[pts.length - 1] - pts[0]) * 100) / 100,
        windowFrom: new Date(t0).toISOString(), windowTo: new Date(t1).toISOString(),
      }
    }
    await sleep(5000)
  }
  return null
}

/* ═══ C 数据获取 ═══ */
console.log('\n[C] 数据获取(REST + Agent 工具面)')
const base = conv ?? await sampleStats(15)
check('C1', `REST 时间窗采样统计(n=${base?.n}, mean=${base?.mean}℃, drift=${base?.drift}℃)`,
  base && base.n >= 8 && base.mean > 100 && base.mean < 140, JSON.stringify(base ?? {}))
if (!base) { console.log('基线采样失败,退出'); process.exit(1) }

const dq = await inv(agentId, 'daq_query', { node_id: daqNodeId, last_minutes: 5, bucket_ms: 2000, limit: 50 })
check('C2', 'Agent 工具 daq_query 取到真实数据', !invErr(dq) && /\d/.test(invText(dq)) && invText(dq).length > 80, invText(dq))
const node0 = (await api('GET', '/api/workshop/dcw', undefined, H())).data?.nodes?.find(n => n.id === dcwNodeId)
check('C3', 'REST 设定值回读 SP=120(开跑配方已写穿)', Number(node0?.value) === 120, `value=${node0?.value}`)

/* ═══ D 授权面 v2(负路径,全部应被拒) ═══ */
console.log('\n[D] 授权面 v2(负路径)')
const dq2 = await inv(agentId, 'daq_query', { line_id: line2Id, last_minutes: 5 })
check('D1', '未授权产线 daq_query 被拒(作用域隔离)', invErr(dq2), invText(dq2))
const pc = await inv(agentId, 'param_control', { param: tplKey, value: 150 })
check('D2', 'param_control 按权限 v2 禁用(引导走配方面)', invErr(pc) && /配方/.test(invText(pc)), invText(pc))
const dcc = await inv(agentId, 'dcw_control', { node_id: dcwNodeId, value: 130, hypothesis: '越权尝试' })
check('D3', '未绑定节点 dcw_control 被拒', invErr(dcc), invText(dcc))
const ru0 = await inv(agentId, 'recipe_update', { recipe_id: recipeId, params: [{ node_id: dcwNodeId, value: 150 }], reason: '未绑定尝试' })
check('D4', '未绑定配方 recipe_update 被拒(绑定门)', invErr(ru0) && /绑定/.test(invText(ru0)), invText(ru0))

/* ═══ E 配方链:授权 → HITL 拒绝路径 → 写入 → 下发(批准路径) ═══ */
console.log('\n[E] recipe 链 + HITL(先拒绝后批准,批准前引擎无唤醒)')
const b1 = await api('POST', '/api/workshop/agent-tools/bindings', { agentId, nodeId: recipeId, kind: 'recipe', mode: 'manual' }, H())
const b2 = await api('POST', '/api/workshop/agent-tools/bindings', { agentId, nodeId: daqNodeId, kind: 'daq', mode: 'manual' }, H())
check('E1', 'lead 绑定(recipe manual + daq, v2 操作面)', Boolean(b1.data) && Boolean(b2.data), JSON.stringify([b1.data, b2.data]).slice(0, 120))
const bdcw = await api('POST', '/api/workshop/agent-tools/bindings', { agentId, nodeId: dcwNodeId, kind: 'dcw', mode: 'manual' }, H())
check('E1b', 'kind=dcw 直绑被拒(权限 v2 废除节点直绑,写收敛到配方面)', bdcw.status === 400, JSON.stringify(bdcw).slice(0, 140))

// E2 HITL 拒绝路径(在任何批准发生前:引擎未被唤醒,审批卡即时建立)
console.log('  · recipe_trial 应急候选 200(挂卡→拒绝附指导)…')
const rtP = inv(agentId, 'recipe_trial', {
  recipe_id: recipeId, params: [{ node_id: dcwNodeId, value: 200 }],
  hypothesis: '跳步提产试验(全链验收负路径)', emergency: true,
}, 300_000)
const rtDec = await decideCard(recipeId, { approved: false, comment: '步幅过大,先做小步试验:幅度≤10℃并附数采依据' }, 90)
const rt = await rtP
const rtText = invText(rt)
check('E2', 'recipe_trial 应急豁免频控→HITL 卡建立(卡即建,频控豁免语义)', Boolean(rtDec.card), rtDec.card ? `card=${rtDec.card.id}` : invText(rt))
check('E2b', 'HITL 拒绝→人工指导逐字回流 Agent', !invErr(rt) && /未批准/.test(rtText) && /步幅过大/.test(rtText), rtText)
const nodeNow = (await api('GET', '/api/workshop/dcw', undefined, H())).data?.nodes?.find(n => n.id === dcwNodeId)
check('E2c', '拒绝后 PLC 设定值未被改动(仍 120)', Number(nodeNow?.value) === 120, `value=${nodeNow?.value}`)

// E3 recipe_update:挂 HITL 卡 → 批准 → 写入 v2(不下发)
console.log('  · recipe_update 120→150(挂卡→批准)…')
const ruP = inv(agentId, 'recipe_update', {
  recipe_id: recipeId, params: [{ node_id: dcwNodeId, value: 150 }],
  reason: `数采证据:基线 ${base.mean}℃ 稳定,工艺要求提温至 150℃(全链验收)`,
}, 300_000)
const ruDec = await decideCard(recipeId, { approved: true, comment: '同意写入新版本,先不下发' }, 90)
const ru = await ruP
check('E3', `recipe_update HITL 批准→新版本落库(附言回流=${ruDec.card ? '有卡' : '无卡!'})`,
  Boolean(ruDec.card) && !invErr(ru) && /v2|版本/.test(invText(ru)), invText(ru))
const rv = await inv(agentId, 'recipe_versions', { recipe_id: recipeId })
check('E3b', 'recipe_versions 版本史可见 v2', !invErr(rv) && /2/.test(invText(rv)), invText(rv).slice(0, 200))

// 等开跑下发的写入间隔窗口(60s 治理),再 recipe_apply
const sinceStart = Date.now() - tLineStart
if (sinceStart < 68_000) {
  console.log(`  · 等写入间隔窗口(再 ${Math.ceil((68_000 - sinceStart) / 1000)}s)…`)
  await sleep(68_000 - sinceStart)
}
// E4 recipe_apply:挂 HITL 卡 → 批准附言 → 整批下发(设备证实)
console.log('  · recipe_apply v2 整批下发(挂卡→批准附言)…')
const raP = inv(agentId, 'recipe_apply', {
  recipe_id: recipeId, reason: `配方 v2 固化值下发:基线分析(G1 报告)与人工批准写入,目标 SP=150℃`,
}, 300_000)
const raDec = await decideCard(recipeId, { approved: true, comment: '批准下发,注意观察 PV 收敛,异常即回退' }, 90)
const ra = await raP
const raText = invText(ra)
check('E4', 'recipe_apply HITL 批准→整批下发设备证实✓+人工附言回流',
  Boolean(raDec.card) && !invErr(ra) && (/证实/.test(raText) || /readback|回读/.test(raText)) && /人工附言/.test(raText), raText)
check('E4b', 'apply 回包含审批关联(审计可追溯)', /批次/.test(raText), raText.slice(0, 160))

console.log('  · 等 PV 收敛到 SP≈150(40s)…')
await sleep(40_000)
const step = await sampleStats(15)
check('E5', `PV 物理跟随新 SP=150(n=${step?.n}, mean=${step?.mean}℃)`, step && step.n >= 8 && step.mean > 138 && step.mean < 165, JSON.stringify(step ?? {}))

/* ═══ F 治理负路径(频控) ═══ */
console.log('\n[F] 治理负路径(频控)')
const ra2 = await inv(agentId, 'recipe_apply', { recipe_id: recipeId, reason: '频控负路径:未到间隔再次下发' }, 420_000)
check('F1', '频控/二次拦截:apply 后立即再下发被拒', invErr(ra2), invText(ra2))

/* ═══ G 分析入库 + 多维检索 ═══ */
console.log('\n[G] 数据分析 + 结果入库 + 检索')
const s1 = await inv(agentId, 'analysis_save', {
  title: `烘干基线工况分析-${TAG}`,
  summary: `SP=120 下 PV 均值 ${base.mean}℃(偏差 ${(base.mean - 120).toFixed(2)}℃),窗内漂移 ${base.drift}℃,工况受控`,
  conclusions: [
    `真实采样 ${base.n} 个聚合点:均值 ${base.mean}℃ / 极小 ${base.min}℃ / 极大 ${base.max}℃`,
    `窗内漂移 ${base.drift}℃(${Math.abs(base.drift) < 3 ? '噪声带内,控温回路稳定' : '超出噪声带'})`,
    `SP-PV 静态偏差 ${(base.mean - 120).toFixed(2)}℃,一阶惯性已收敛`,
  ],
  report: `## 基线工况(SP=120)\n\n数据来源:daq ${daqNodeId}(PLC 40001 温度 PV),窗 ${base.windowFrom}~${base.windowTo}。统计由真实采样计算。`,
  category: 'quality', recipe_id: recipeId,
  window_from: base.windowFrom, window_to: base.windowTo,
  data_sources: `daq_query ${daqNodeId}(PLC Modbus 40001)`,
  metrics: { n: base.n, mean_c: base.mean, min_c: base.min, max_c: base.max, drift_c: base.drift, sp_c: 120 },
})
const id1 = invText(s1).match(/ar-[0-9a-f]{8}/)?.[0]
check('G1', '基线分析留痕(结论=真实统计)', !invErr(s1) && Boolean(id1), invText(s1))

const delta = Math.round((step.mean - base.mean) * 100) / 100
const respPct = Math.round((delta / 30) * 1000) / 10
const s2 = await inv(agentId, 'analysis_save', {
  title: `SP 150 下发后复测分析-${TAG}`,
  summary: `recipe v2 下发后 PV ${base.mean}→${step.mean}℃(Δ=${delta}℃,响应率 ${respPct}%),HITL 批准附言已留痕`,
  conclusions: [
    `对比基线:均值 ${base.mean}℃ → ${step.mean}℃(SP 120→150,Δ=${delta}℃)`,
    `稳态响应率 ${respPct}%${respPct > 70 ? ',回路增益符合预期' : ',存在斜率限制或未完全收敛'}`,
    `治理链:recipe_update(人工批准写入 v2)→ recipe_apply(人工批准附言「批准下发,注意观察 PV 收敛」)→ 设备证实`,
  ],
  report: `## SP 阶跃复测(120→150)\n\n基线窗 ${base.windowFrom}~${base.windowTo}(均值 ${base.mean}℃)\n阶跃窗 ${step.windowFrom}~${step.windowTo}(均值 ${step.mean}℃)\n\n下发:HITL 审批卡人工批准(附言在案),整批下发设备证实。`,
  category: 'trend', recipe_id: recipeId,
  window_from: step.windowFrom, window_to: step.windowTo,
  data_sources: `daq ${daqNodeId};recipe_apply 批次(HITL 批准);对比基线报告 ${id1}`,
  metrics: { baseline_mean_c: base.mean, step_mean_c: step.mean, delta_c: delta, sp_step_c: 30, response_pct: respPct },
})
const id2 = invText(s2).match(/ar-[0-9a-f]{8}/)?.[0]
check('G2', '阶跃后对比分析留痕(引用配方 v2+HITL 附言)', !invErr(s2) && Boolean(id2), invText(s2))

const q1 = await inv(agentId, 'analysis_query', { report_id: id1 })
check('G3', `工具面 analysis_query 按 id 取回全文(${id1})`, !invErr(q1) && invText(q1).includes('基线工况'), invText(q1).slice(0, 200))
const q2 = await inv(agentId, 'analysis_query', { line_id: lineId, limit: 10 })
check('G4', '工具面按产线列表(2 份报告)', !invErr(q2) && (invText(q2).match(/ar-[0-9a-f]{8}/g) ?? []).length >= 2, invText(q2).slice(0, 200))

const restR = await api('GET', `/api/workshop/analysis?recipeId=${recipeId}`, undefined, H())
check('G5', 'REST 按配方检索 2 份', restR.data?.count === 2, `count=${restR.data?.count}`)
const restT = await api('GET', `/api/workshop/analysis?from=${encodeURIComponent(base.windowFrom)}&to=${encodeURIComponent(new Date(Date.now() + 60_000).toISOString())}`, undefined, H())
check('G6', 'REST 时间窗检索覆盖 2 份', (restT.data?.count ?? 0) === 2, `count=${restT.data?.count}`)
const restK = await api('GET', `/api/workshop/analysis?q=${encodeURIComponent('复测')}`, undefined, H())
check('G7', 'REST 关键词检索命中阶跃报告', restK.data?.reports?.some(r => r.id === id2), `count=${restK.data?.count}`)

/* ═══ H 审计留痕(工具调用情况) ═══ */
console.log('\n[H] 工具调用留痕(ops-logs 审计)')
const audit = await api('GET', `/api/workshop/ops-logs?lineId=${lineId}&limit=500`, undefined, H())
const logs = audit.data?.logs ?? []
const byAction = {}
for (const l of logs) byAction[l.action] = (byAction[l.action] ?? 0) + 1
console.log('  · 本产线审计动作分布:', JSON.stringify(byAction))
const agentActs = logs.filter(l => l.actorKind === 'agent').map(l => l.action)
const has = a => agentActs.includes(a)
check('H1', '配方写入/下发/分析入库均有 agent 归因审计',
  has('recipe.apply') && has('analysis.save') && agentActs.some(a => /recipe\.update/.test(a)),
  `agent 动作=${[...new Set(agentActs)].join(',').slice(0, 200)}`)
const applyLog = logs.find(l => l.action === 'recipe.apply')
check('H2', 'recipe.apply 审计含 ACK 口径(证实/未证实/失败)', Boolean(applyLog) && /证实/.test(String(applyLog?.summary ?? '')), String(applyLog?.summary ?? '').slice(0, 200))
const updLog = logs.find(l => /recipe\.update/.test(String(l.action)))
check('H3', 'recipe.update 审计含版本理由', Boolean(updLog) && /150/.test(String(updLog?.summary ?? '')), String(updLog?.summary ?? '').slice(0, 160))
const trialLogs = logs.filter(l => /trial/.test(String(l.action)))
check('H4', '试验拒绝有治理留痕(或无下发记录=未产线变动)', trialLogs.length >= 0 && !logs.some(l => l.action === 'recipe.trial' && /证实 [1-9]/.test(String(l.summary ?? ''))), `trial 审计=${trialLogs.length}`)
check('H5', '产线级审计总量(全链留痕密度)', logs.length >= 8, `total=${logs.length}`)

/* ═══ 汇总 ═══ */
const failed = fails.length
console.log(`\n════ 全链条终验:${results.length - failed}/${results.length} 通过 ╨════`.replace(' ╨════', ' ════'))
if (failed) { console.log('未通过:'); for (const f of fails) console.log('  ✖', f) }
const { writeFileSync } = await import('node:fs')
writeFileSync('D:/tmp/aw-fc-1015/fullchain-state.json', JSON.stringify({
  base: BASE, tag: TAG, email: `fc-${TAG}@awshop.local`, password: 'FcAdmin#2026',
  lineId, line2Id, recipeId, dcwNodeId, daqNodeId, channelId, agentId, reportId1: id1, reportId2: id2,
  baseMean: base.mean, stepMean: step.mean, auditActions: byAction,
}, null, 1))
if (failed) process.exit(1)
console.log('FULLCHAIN OK')
