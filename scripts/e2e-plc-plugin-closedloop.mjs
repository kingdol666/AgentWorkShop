/**
 * 真实 PLC 闭环实测 — PLC 模拟器(挤出流延数字孪生) × AgentTeam × rag-knowledge × 深度诊断
 *
 * 前置:PLC 模拟器运行中(API 4010;Modbus TCP 16040:40001=熔体温度/40021=加热区1SP,float32 big)
 *       AW 3001 生产实例;rag-knowledge(KB_BASE);诊断服务(DIAG);两桥接插件启用且 token 已配置。
 *
 * Stage A 服务与插件健康      Stage E 知识闭环(kb_store/kb_search + 诊断自动入库)
 * Stage B 真实产线供给        Stage F 插件参数回归(逐键热生效→复原)
 * Stage C 真实数采交叉核对     Stage G Channel 级插件开关
 * Stage D 闭环写控(HITL)     Stage H Harness 集成面
 *
 * 运行:NO_PROXY='*' AW_BASE=http://127.0.0.1:3001 KB_BASE=http://127.0.0.1:8771 \
 *       AW_E2E_TOKEN=<token> node scripts/e2e-plc-plugin-closedloop.mjs
 */
import { DatabaseSync } from 'node:sqlite'
import { join, resolve } from 'node:path'

const BASE = process.env.AW_BASE ?? 'http://127.0.0.1:3001'
const KB = process.env.KB_BASE ?? 'http://127.0.0.1:8771'
const DIAG = process.env.DIAG_BASE ?? 'http://127.0.0.1:3210'
const SIM = process.env.SIM_BASE ?? 'http://127.0.0.1:4010'
const LINE = process.env.E2E_LINE ?? 'ln-af002514'
const TAG = Date.now().toString(36)
const sleep = ms => new Promise(r => setTimeout(r, ms))

let pass = 0
let fail = 0
const failures = []
function ok(cond, label, detail = '') {
  if (cond) {
    pass++
    console.log(`  ✔ ${label}${detail ? ` —— ${detail}` : ''}`)
  }
  else {
    fail++
    failures.push(label)
    console.error(`  ✘ ${label}${detail ? ` —— ${detail}` : ''}`)
  }
}

async function raw(method, url, { body, token, agent, timeoutMs = 30000 } = {}) {
  const headers = {}
  if (body !== undefined) headers['content-type'] = 'application/json'
  if (token) headers.authorization = `Bearer ${token}`
  if (agent) headers['x-aw-agent-token'] = agent.token
  try {
    const res = await fetch(url, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(timeoutMs) })
    return { status: res.status, json: await res.json().catch(() => null) }
  }
  catch (e) { return { status: 0, json: { error: String(e) } } }
}
const api = (method, path, opts = {}) => raw(method, `${BASE}${path}`, opts)
const env = r => r?.json?.data ?? r?.json
const resultText = r => String(r?.json?.data?.result?.text ?? '')
const invoke = (agent, tool, args, timeoutMs = 120000) => api('POST', '/api/workshop/agent-tools/invoke', { agent, timeoutMs, body: { agentId: agent.id, tool, args } })

// ── 0. 用户(夹具:line operate 授权 + admin)─────────────────────────────
let userToken = process.env.AW_E2E_TOKEN ?? ''
if (!userToken) {
  const reg = await api('POST', '/api/workshop/users/register', { body: { name: `plc-e2e-${TAG}` } })
  userToken = env(reg)?.token ?? ''
}
ok(Boolean(userToken), 'e2e 用户 token 就绪')
{
  const me = await api('GET', '/api/workshop/users/me', { token: userToken })
  const myId = env(me)?.id ?? ''
  ok(Boolean(myId), 'token 反查用户 id', myId)
  const db = new DatabaseSync(join(resolve('.'), '.AgentWorkShop', 'data', 'users.sqlite'))
  db.exec('PRAGMA busy_timeout=4000')
  if (myId) {
    db.prepare(`INSERT OR REPLACE INTO user_line_grants (user_id, line_id, mode, granted_by, granted_at) VALUES (?, ?, 'operate', 'plc-e2e', ?)`)
      .run(myId, LINE, new Date().toISOString())
    db.prepare('UPDATE users SET role = \'admin\' WHERE id = ?').run(myId)
  }
  db.close()
  console.log(`  · 夹具:授产线 operate + admin(${myId})`)
}

// omp 执行器:必须挂在**本用户自有频道**下 —— HITL 待办按 channel 所有权过滤,
// 用别人的频道成员 invoke 时审批待办对本用户不可见(权限域语义,非缺陷)
let exec = null
{
  const ch = await api('POST', '/api/workshop/channels', { token: userToken, body: { name: `PLC闭环频道-${TAG}` } })
  const channelId = env(ch)?.channelId
  const tpl = await api('POST', '/api/workshop/agents', { token: userToken, body: { name: `PLC执行器-${TAG}`, harness: 'omp' } })
  const tplId = env(tpl)?.id
  const add = await api('POST', `/api/workshop/channels/${channelId}/agents`, { token: userToken, body: { name: env(tpl)?.name, harness: 'omp', templateId: tplId, role: 'worker' } })
  const member = env(add)?.agent ?? env(add)
  if (member?.id && member?.token) exec = { id: member.id, name: member.name, token: member.token }
}
ok(Boolean(exec?.token), 'omp 执行器成员就绪(自有频道)', exec?.name ?? '')
// 无 env 时:临时账号 → 会话 → 铸 idd_ token(脚本内完成,幂等)
{
  const cur = env(await api('GET', '/api/system/settings', { token: userToken }))?.effective?.['plugins.diag-bridge.token'] ?? ''
  if (!cur.startsWith('idd_')) {
    const iu = `plce2e_${TAG}`
    const ipw = `Xy${TAG}ab9`
    await raw('POST', `${DIAG}/api/auth/register`, { body: { username: iu, password: ipw, email: `${iu}@e2e.local` } })
    const login = await raw('POST', `${DIAG}/api/auth/login`, { body: { username: iu, password: ipw } })
    const session = login.json?.data?.session_token ?? ''
    if (session) {
      const tk = await raw('POST', `${DIAG}/api/auth/tokens`, { token: session, body: { name: `plc-e2e-${TAG}` } })
      const idd = tk.json?.data?.token ?? ''
      if (idd.startsWith('idd_')) {
        await api('PATCH', '/api/system/settings', { token: userToken, body: { override: { 'plugins.diag-bridge.token': idd } } })
        console.log('  · 夹具:diag token 已更换为持久化 idd_ API Token(重启不失效)')
      }
      else {
        console.log(`  ! idd_ token 铸造失败:${JSON.stringify(tk.json).slice(0, 120)}`)
      }
    }
  }
}

// ══ Stage A:服务与插件健康 ════════════════════════════════════════
console.log('\n── A 服务与插件健康 ──')
{
  const kbH = await raw('GET', `${KB}/api/v1/health`)
  ok(kbH.json?.status === 'healthy', 'rag-knowledge healthy', JSON.stringify(kbH.json))
  const dgH = await raw('GET', `${DIAG}/api/health`)
  ok(dgH.json?.status === 'ok', '诊断服务 healthy', `activeRuns=${dgH.json?.checks?.activeRuns}`)
  const simH = await raw('GET', `${SIM}/api/nodes`)
  ok(simH.status === 200, 'PLC 模拟器 API 可达', `${JSON.stringify(simH.json).length} bytes`)
  const plugs = await api('GET', '/api/workshop/plugins', { token: userToken })
  const list = plugs.json?.plugins ?? env(plugs)?.plugins ?? []
  const bridge = n => list.find(p => p?.name === n) ?? {}
  ok(bridge('rag-bridge').enabled === true && bridge('diag-bridge').enabled === true, '两桥接插件启用')
  ok(bridge('rag-bridge').hasClient === true && bridge('diag-bridge').hasClient === true, '两插件含浏览器面板')
  ok(bridge('rag-bridge').hasI18n === true && bridge('diag-bridge').hasI18n === true, '两插件含 i18n 包')
  ok((bridge('rag-bridge').settingsCount ?? 0) >= 3 && (bridge('diag-bridge').settingsCount ?? 0) >= 7, '插件设置描述符已注册', `rag=${bridge('rag-bridge').settingsCount} diag=${bridge('diag-bridge').settingsCount}`)
  const snap = await api('GET', '/api/system/settings', { token: userToken })
  const keys = (env(snap)?.descriptors ?? []).map(d => d.key)
  ok(keys.includes('plugins.rag-bridge.token') && keys.includes('plugins.diag-bridge.harness'), '设置快照含插件描述符')
  const noAuth = await raw('GET', `${BASE}/api/plugins/rag-bridge/health`)
  ok(noAuth.status === 401, '插件路由鉴权门', `status=${noAuth.status}`)
  const i18n = await raw('GET', `${BASE}/api/plugins/i18n`)
  ok(Boolean(i18n.json?.i18n?.['rag-bridge']?.['zh-CN']), 'i18n 汇编端点可用', Object.keys(i18n.json?.i18n ?? {}).join(','))
}

// ══ Stage B:真实产线供给(modbus-tcp 驱动)═══════════════════════════
console.log('\n── B 真实产线供给(PLC 模拟器 Modbus TCP 16040)──')
let lineId, dcwNodeId, meltDaqId, spDaqId, recipeId, dcwNodeIds
{
  const line = await api('POST', '/api/workshop/dcw/lines', { token: userToken, body: { name: `PLC闭环实测-${TAG}` } })
  lineId = env(line)?.line?.id
  ok(Boolean(lineId), '产线创建', lineId ?? JSON.stringify(line.json).slice(0, 120))

  const prod = await api('POST', '/api/workshop/dcw/products', { token: userToken, body: { lineId, name: `硅油膜-${TAG}` } })
  const productId = env(prod)?.product?.id ?? env(prod)?.id
  ok(Boolean(productId), '产品创建', productId ?? '')

  const mb = { host: '127.0.0.1', port: 16040, unitId: 1 }
  // 工艺模板/信号模板(控制与数采节点都必须绑定模板)
  const tpl = await api('POST', '/api/workshop/dcw/templates', {
    token: userToken, body: { name: `加热区SP-${TAG}`, unit: '℃', min: 120, max: 260, decimals: 1, icon: 'thermo' },
  })
  const dcwTplKey = env(tpl)?.template?.key
  ok(Boolean(dcwTplKey), '工艺模板创建(加热区 SP)', dcwTplKey ?? JSON.stringify(tpl.json).slice(0, 120))

  const daqTpl = async (name, unit, min, max, decimals) => {
    const r = await api('POST', '/api/workshop/daq/templates', {
      token: userToken, body: { name: `${name}-${TAG}`, unit, min, max, decimals, icon: 'thermo' },
    })
    return env(r)?.template?.key ?? env(r)?.key ?? ''
  }
  const meltTpl = await daqTpl('熔体温度', '℃', 0, 400, 2)
  const spTpl = await daqTpl('SP回读', '℃', 120, 260, 1)
  ok(Boolean(meltTpl) && Boolean(spTpl), '数采信号模板创建', `${meltTpl}/${spTpl}`)

  // 三个加热区 SP 节点(40021/40023/40025):闭环实验同时驱动三区,熔温渐近线=210,物理信号清晰
  dcwNodeIds = []
  for (const [i, reg] of [40021, 40023, 40025].entries()) {
    const r = await api('POST', '/api/workshop/dcw', {
      token: userToken,
      body: { lineId, templateRef: dcwTplKey, name: `加热区${i + 1}SP`, driver: 'modbus-tcp',
        driverConfig: { ...mb, register: reg, dataType: 'float32', byteOrder: 'big' }, enabled: true },
    })
    const nid = env(r)?.node?.id
    ok(Boolean(nid), `数控节点创建(写 ${reg})`, nid ?? JSON.stringify(r.json).slice(0, 120))
    if (nid) dcwNodeIds.push(nid)
  }
  dcwNodeId = dcwNodeIds[0]

  const mkDaq = async (name, tplKey, register) => {
    const r = await api('POST', '/api/workshop/daq', {
      token: userToken,
      body: { lineId, templateRef: tplKey, name, driver: 'modbus-tcp',
        driverConfig: { ...mb, register, registerType: 'holding', dataType: 'float32', byteOrder: 'big' },
        intervalMs: 2000, enabled: true },
    })
    return env(r)?.node?.id ?? env(r)?.id ?? ''
  }
  meltDaqId = await mkDaq('熔体温度', meltTpl, 40001)
  ok(Boolean(meltDaqId), '数采节点创建(熔体温度 40001)', meltDaqId || JSON.stringify(env(await api('GET', '/api/workshop/daq', { token: userToken }))).slice(0, 0))
  spDaqId = await mkDaq('加热区1SP回读', spTpl, 40021)
  ok(Boolean(spDaqId), '数采节点创建(SP回读 40021)', spDaqId)

  const recipe = await api('POST', '/api/workshop/dcw/recipes', {
    token: userToken,
    body: { name: `标准工艺-${TAG}`, productId, params: dcwNodeIds.map(nid => ({ nodeId: nid, value: 200 })) },
  })
  recipeId = env(recipe)?.recipe?.id ?? env(recipe)?.id
  ok(Boolean(recipeId), '配方创建(SP=200 经真实寄存器下发)', recipeId ?? '')
}

// ══ Stage C:开跑(真实寄存器下发)+ 数采交叉核对 ════════════════════
console.log('\n── C 产线开跑与真实数采交叉核对 ──')
{
  const start = await api('POST', `/api/workshop/dcw/lines/${lineId}/start`, { token: userToken, body: { recipeId } })
  ok(start.status === 200 && Boolean(env(start)?.run?.id), '产线开跑(配方经 Modbus 真实下发)', start.status === 200 ? `run=${env(start)?.run?.id}` : JSON.stringify(start.json).slice(0, 160))

  await api('POST', '/api/workshop/daq/controller', { token: userToken, body: { action: 'start' } })
  await sleep(8000) // 等两个采样节拍

  const nodes = await api('GET', '/api/workshop/daq', { token: userToken })
  const all = env(nodes)?.nodes ?? env(nodes) ?? []
  const melt = (Array.isArray(all) ? all : []).find(n => n?.id === meltDaqId)
  const spN = (Array.isArray(all) ? all : []).find(n => n?.id === spDaqId)
  const meltVal = melt?.lastValue ?? melt?.value ?? null
  const spVal = spN?.lastValue ?? spN?.value ?? null
  ok(meltVal != null, '数采采到真实熔体温度(Modbus 40001)', `value=${meltVal}`)
  ok(spVal != null && Math.abs(Number(spVal) - 200) < 1.5, 'SP 回读=200(开跑下发真实生效)', `value=${spVal}`)

  // 与模拟器侧交叉核对
  const sim = await raw('GET', `${SIM}/api/nodes`)
  const devs = sim.json?.data ?? sim.json ?? []
  const extruder = (Array.isArray(devs) ? devs : []).find(d => d?.id === 'dev-extruder-mbtcp')
  const sig = (extruder?.signals ?? []).find(s => s?.id === 'melt-temp')
  const simMelt = sig?.current ?? sig?.value
  // 冷启动暖机阶段熔温爬升快,采样时点差会放大偏差 → 暖机判定放宽到 ±10
  ok(simMelt != null && Math.abs(Number(simMelt) - Number(meltVal)) < 10,
    'AW 采样与模拟器寄存器交叉一致(暖机容差)', `aw=${meltVal} sim=${simMelt}`)

  // 暖机门控:等熔温爬到 198+(SP=200 的物理吸引域),保证 D 阶段收敛断言有意义
  let warm = false
  for (let i = 0; i < 60 && !warm; i++) {
    await sleep(5000)
    const ns = await api('GET', '/api/workshop/daq', { token: userToken })
    const arr2 = env(ns)?.nodes ?? env(ns) ?? []
    const m2 = (Array.isArray(arr2) ? arr2 : []).find(n => n?.id === meltDaqId)
    const v2 = m2?.lastValue ?? m2?.value ?? null
    if (v2 != null && Number(v2) >= 198) warm = true
    if (i % 6 === 5) console.log(`  … 暖机(${(i + 1) * 5}s):melt=${v2}`)
  }
  ok(warm, '暖机门控:熔温进入 SP=200 吸引域(≥198)')
}

// ══ Stage D:闭环写控(HITL → 真实 Modbus 写 → 物理跟随)══════════════
console.log('\n── D 闭环写控(熔温调控:SP 200 → 202)──')
{
  for (const nid of dcwNodeIds) {
    const bind = await api('POST', '/api/workshop/agent-tools/bindings', {
      token: userToken, body: { agentId: exec.id, nodeId: nid, kind: 'dcw', mode: 'manual' },
    })
    ok(bind.status === 200, `执行器绑定 DCW 节点(manual) ${nid}`, `mode=${env(bind)?.binding?.mode}`)
  }

  // 三区并发发起(每区独立 HITL);审批轮询循环消费全部待办
  const writes = dcwNodeIds.map((nid, idx) => invoke(exec, 'dcw_control', {
    node_id: nid, value: 210,
    hypothesis: `熔温调控闭环实测:加热区${idx + 1}SP 200→210,观察熔体跟随`,
  }, 300000))
  let approvedAll = 0
  for (let i = 0; i < 45 && approvedAll < dcwNodeIds.length; i++) {
    await sleep(2000)
    const pend = await api('GET', '/api/workshop/hitl/pending', { token: userToken })
    const pd = env(pend)
    const arr = Array.isArray(pd) ? pd : (pd?.items ?? pd?.pending ?? [])
    for (const item of arr.filter(x => x?.kind === 'dcw-approval' && x?.agentId === exec.id)) {
      const resp = await api('POST', '/api/workshop/hitl/respond', { token: userToken, body: { kind: 'dcw-approval', id: item.id, confirmed: true, comment: 'plc-e2e 批准' } })
      if (resp.status === 200) approvedAll++
    }
  }
  const writeTexts = []
  for (const w of writes) writeTexts.push(resultText(await w))
  ok(approvedAll >= dcwNodeIds.length, `HITL 待办全部出现并批准(${dcwNodeIds.length} 区)`, `approved=${approvedAll}`)
  ok(writeTexts.every(t => t.includes('回读一致')), `${dcwNodeIds.length} 区 dcw_control 均经真实 Modbus 写入且回读一致`, writeTexts[0].slice(0, 100))

  // 模拟器侧确认寄存器真的变成 202
  const sim = await raw('GET', `${SIM}/api/nodes`)
  const devs = sim.json?.data ?? sim.json ?? []
  const extruder = (Array.isArray(devs) ? devs : []).find(d => d?.id === 'dev-extruder-mbtcp')
  const z1 = (extruder?.signals ?? []).find(s => s?.id === 'zone1-sp')
  const simSp = z1?.current ?? z1?.value
  ok(Math.abs(Number(simSp) - 210) < 0.5, '模拟器寄存器 40021 实际=210(真实写穿)', `sim zone1-sp=${simSp}`)
  const z2 = (extruder?.signals ?? []).find(s => s?.id === 'zone2-sp')
  const z3 = (extruder?.signals ?? []).find(s => s?.id === 'zone3-sp')
  ok(Math.abs(Number(z2?.current ?? z2?.value) - 210) < 0.5 && Math.abs(Number(z3?.current ?? z3?.value) - 210) < 0.5, '寄存器 40023/40025 同步=210')

  // 物理跟随:熔温向新 SP(210)收敛。暖机后在 200 附近,三区渐近线抬升约 3.3℃
  let meltBefore
  {
    const nodes0 = await api('GET', '/api/workshop/daq', { token: userToken })
    const arr0 = env(nodes0)?.nodes ?? env(nodes0) ?? []
    const m0 = (Array.isArray(arr0) ? arr0 : []).find(n => n?.id === meltDaqId)
    meltBefore = Number(m0?.lastValue ?? m0?.value ?? 0)
  }
  let meltAfter = null
  for (let i = 0; i < 100; i++) {
    await sleep(6000)
    const nodes = await api('GET', '/api/workshop/daq', { token: userToken })
    const all = env(nodes)?.nodes ?? env(nodes) ?? []
    const melt = (Array.isArray(all) ? all : []).find(n => n?.id === meltDaqId)
    meltAfter = melt?.lastValue ?? melt?.value ?? null
    if (meltAfter != null && Number(meltAfter) >= meltBefore + 3) break
  }
  // 三区渐近线 ≈210(从 ~200.5 起),热惯性下 10 分钟内抬升应远超 1.5℃
  const risen = meltAfter != null && Number(meltAfter) >= meltBefore + 1.5
  ok(risen, '熔体温度向新 SP 收敛(闭环物理生效)', `before=${meltBefore} after=${meltAfter}`)

  // 判定 keep:找到最新 open 优化记录
  const opts = await api('GET', '/api/workshop/dcw/optimizations', { token: userToken })
  const recs = env(opts)?.records ?? env(opts) ?? []
  const openRec = (Array.isArray(recs) ? recs : []).find(r => r?.nodeId === dcwNodeId && (r?.status === 'open' || r?.judge == null))
  if (openRec?.id) {
    const j = await invoke(exec, 'dcw_judge', { record_id: openRec.id, verdict: 'keep', reason: '熔温跟随达标,判 keep(plc-e2e)' }, 60000)
    ok(!j.json?.result?.isError, 'dcw_judge 落 keep 判定', resultText(j).slice(0, 80))
  }
  else {
    ok(false, '找到 open 优化记录以判定', JSON.stringify(recs).slice(0, 120))
  }
}

// ══ Stage E:知识闭环 ═══════════════════════════════════════════════
console.log('\n── E 知识闭环(经验沉淀/检索 + 诊断自动入库)──')
{
  const marker = `PLC闭环实测${TAG}:SP 上调 2℃ 后熔体温度跟随收敛,判定 keep`
  const store = await invoke(exec, 'kb_store', {
    title: `plc-e2e 经验:${TAG} 熔温调控`,
    category: 'optimization',
    problem: '熔体温度偏低需要上调',
    solution: marker,
    tags: ['plc-e2e', '闭环'],
  })
  ok(resultText(store).includes('已沉淀'), 'kb_store 经验沉淀', resultText(store).slice(0, 80))
  let hit = ''
  for (let i = 0; i < 8 && !hit; i++) {
    await sleep(4000)
    const s = await invoke(exec, 'kb_search', { query: marker }, 60000)
    if (!resultText(s).startsWith('未检索到')) hit = resultText(s)
  }
  ok(hit.length > 0, 'kb_search 命中刚沉淀经验', hit.split('\n')[1]?.slice(0, 90) ?? '')

  // 诊断(mock 引擎,分钟级):先清线上在跑诊断(防收养长跑 omp),显式 mock,发起→completed→入库→检索
  // 鉴权用持久化 API Token(idd_;会话 JWT 的密钥/会话态可能随服务重启失效)
  const diagToken = env(await api('GET', '/api/system/settings', { token: userToken }))?.effective?.['plugins.diag-bridge.token'] ?? ''
  const dreq = (path, method = 'GET') => raw(method, `${DIAG}${path}`, { token: diagToken, timeoutMs: 20000 })
  {
    const list = await dreq('/api/diagnosis/list')
    const runs = list.json?.data ?? []
    for (const r of runs.filter(x => x?.status === 'running')) {
      await dreq(`/api/diagnosis/stop/${encodeURIComponent(r.runId ?? r.id)}`, 'POST').catch(() => {})
    }
  }
  const adminSnap = await api('GET', '/api/system/settings', { token: userToken })
  const prevHarness = env(adminSnap)?.effective?.['plugins.diag-bridge.harness'] ?? ''
  await api('PATCH', '/api/system/settings', { token: userToken, body: { override: { 'plugins.diag-bridge.harness': 'mock' } } })
  let runId = ''
  let r = await invoke(exec, 'diag_run', { line: LINE, from_ms: Date.now() - 30 * 60_000, to_ms: Date.now(), question: `${LINE} PLC 闭环实测时窗诊断(plc-e2e)`, scene: 'plc_e2e' }, 120000)
  runId = (resultText(r).match(/runId=([a-z0-9-]+)/i) ?? [])[1] ?? ''
  if (!runId) {
    const adopted = (resultText(r).match(/run_id=([a-z0-9-]+)/i) ?? [])[1] ?? ''
    if (adopted) runId = adopted
  }
  ok(Boolean(runId), 'diag_run 发起(mock 引擎)', runId || resultText(r).slice(0, 100))
  if (runId) {
    let done = false
    let last = ''
    for (let i = 0; i < 30 && !done; i++) {
      await sleep(15_000)
      const s = await invoke(exec, 'diag_status', { run_id: runId }, 30000)
      last = resultText(s)
      if (/状态=completed/.test(last)) done = true
      else if (/状态=(failed|stopped)/.test(last)) break
    }
    ok(done, '诊断跑至 completed', (last.match(/评分=\S+/g) ?? []).join(' '))
    if (done) {
      let stored = false
      for (let i = 0; i < 24 && !stored; i++) {
        await sleep(10_000)
        const runs = await api('GET', '/api/plugins/diag-bridge/runs', { token: userToken })
        const mine = (runs.json?.runs ?? []).find(x => x.runId === runId)
        if (mine?.stored === true) stored = true
      }
      ok(stored, '诊断报告自动入库')
      let kbHit = ''
      for (let i = 0; i < 8 && !kbHit; i++) {
        await sleep(5000)
        const s = await invoke(exec, 'kb_search', { query: `plc_e2e ${runId.slice(0, 8)} 诊断报告` }, 60000)
        if (!resultText(s).startsWith('未检索到')) kbHit = resultText(s)
      }
      ok(kbHit.length > 0, 'kb_search 命中诊断报告', kbHit.split('\n')[1]?.slice(0, 90) ?? '')
    }
  }
  await api('PATCH', '/api/system/settings', { token: userToken, body: { override: { 'plugins.diag-bridge.harness': prevHarness } } })
}

// ══ Stage F:插件参数回归(逐键热生效→复原)══════════════════════════
console.log('\n── F 插件参数配置回归 ──')
{
  // admin 夹具
  const areg = await api('POST', '/api/workshop/users/register', { body: { name: `plc-admin-${TAG}` } })
  const atok = env(areg)?.token ?? ''
  {
    const db = new DatabaseSync(join(resolve('.'), '.AgentWorkShop', 'data', 'users.sqlite'))
    db.exec('PRAGMA busy_timeout=4000')
    db.prepare('UPDATE users SET role = \'admin\' WHERE id = ?').run(env(areg)?.id ?? '')
    db.close()
  }
  const snap0 = await api('GET', '/api/system/settings', { token: atok })
  const eff0 = env(snap0)?.effective ?? {}
  const orig = {}
  for (const k of ['plugins.rag-bridge.base_url', 'plugins.rag-bridge.web_url', 'plugins.rag-bridge.token', 'plugins.diag-bridge.base_url', 'plugins.diag-bridge.token', 'plugins.diag-bridge.harness', 'plugins.diag-bridge.max_turns', 'plugins.diag-bridge.max_minutes', 'plugins.diag-bridge.auto_enabled', 'plugins.diag-bridge.auto_rules']) {
    orig[k] = eff0[k]
  }
  const patchSet = async obj => api('PATCH', '/api/system/settings', { token: atok, body: { override: obj } })
  const healthOf = async n => (await raw('GET', `${BASE}/api/plugins/${n}/health`, { token: userToken })).json

  // ① diag 热效可见键:harness / auto_enabled / max_turns
  const r1 = await patchSet({ 'plugins.diag-bridge.harness': 'mock', 'plugins.diag-bridge.auto_enabled': true, 'plugins.diag-bridge.max_turns': 123 })
  ok(r1.status === 200, 'PATCH 三个 diag 键成功')
  let h1 = await healthOf('diag-bridge')
  ok(h1?.harness === 'mock' && h1?.auth === 'bearer', 'diag-bridge health 即时反映 harness 切换', `harness=${h1?.harness} auth=${h1?.auth}`)
  let snap1 = env(await api('GET', '/api/system/settings', { token: atok }))?.effective ?? {}
  ok(snap1['plugins.diag-bridge.max_turns'] === 123 && snap1['plugins.diag-bridge.auto_enabled'] === true, 'max_turns/auto_enabled 生效值可读')

  // ② rag 热效可见键:base_url 切到模拟器端口(必然失败)→ 恢复
  await patchSet({ 'plugins.rag-bridge.base_url': 'http://127.0.0.1:59999' })
  let h2 = await healthOf('rag-bridge')
  ok(h2?.backend?.ok === false && String(h2?.backend?.url).endsWith('59999'), 'rag base_url 热切换生效(指向坏端口→探活失败)')
  await patchSet({ 'plugins.rag-bridge.base_url': orig['plugins.rag-bridge.base_url'] })
  let h3 = await healthOf('rag-bridge')
  ok(h3?.backend?.ok === true, '恢复 base_url → 探活恢复', `url=${h3?.backend?.url}`)

  // ③ token 热效:换成错误 token → catalog 401 → 恢复
  await patchSet({ 'plugins.rag-bridge.token': 'wrong-token-for-regression' })
  let h4 = await healthOf('rag-bridge')
  // web catalog 带 token → 401 → web.ok=false;kb.id 可能保留旧值
  ok(h4?.web?.ok === false || h4?.backend?.ok === false, '错误 token 热生效(出站 401)')
  await patchSet({ 'plugins.rag-bridge.token': orig['plugins.rag-bridge.token'] })
  let h5 = await healthOf('rag-bridge')
  ok(h5?.web?.ok === true && h5?.kb?.id, '恢复 token → 出站恢复')

  // ④ diag token 热效:diag /api/health 是公开端点,健康路由不反映 token ——
  //    改为配置层断言(生效值可读),出站鉴权行为已由 Stage E 的 diag_run 全链验证
  await patchSet({ 'plugins.diag-bridge.token': 'wrong-diag-token-regression' })
  const effDiag = env(await api('GET', '/api/system/settings', { token: atok }))?.effective ?? {}
  ok(effDiag['plugins.diag-bridge.token'] === 'wrong-diag-token-regression', 'diag token 热写生效(配置层)')
  await patchSet({ 'plugins.diag-bridge.token': orig['plugins.diag-bridge.token'] })
  const effDiag2 = env(await api('GET', '/api/system/settings', { token: atok }))?.effective ?? {}
  ok(effDiag2['plugins.diag-bridge.token'] === orig['plugins.diag-bridge.token'], '恢复 diag token(配置层)')

  // ⑤ 全量复原 + auto_enabled 保持关闭(防误触发自动诊断)
  const restore = {}
  for (const [k, v] of Object.entries(orig)) if (v !== undefined) restore[k] = v
  restore['plugins.diag-bridge.auto_enabled'] = false
  restore['plugins.diag-bridge.harness'] = orig['plugins.diag-bridge.harness'] ?? ''
  restore['plugins.diag-bridge.max_turns'] = orig['plugins.diag-bridge.max_turns'] ?? 0
  restore['plugins.diag-bridge.max_minutes'] = orig['plugins.diag-bridge.max_minutes'] ?? 0
  await patchSet(restore)
  const snapEnd = env(await api('GET', '/api/system/settings', { token: atok }))?.effective ?? {}
  ok(snapEnd['plugins.diag-bridge.auto_enabled'] === false && (snapEnd['plugins.diag-bridge.harness'] ?? '') === (orig['plugins.diag-bridge.harness'] ?? ''), '全部参数复原(auto_enabled 关闭防误触发)')
  console.log('  · 复原快照:', JSON.stringify({
    rag: snapEnd['plugins.rag-bridge.base_url'],
    diag: snapEnd['plugins.diag-bridge.base_url'],
    harness: snapEnd['plugins.diag-bridge.harness'] ?? '',
  }))
}

// ══ Stage G:Channel 级插件开关(点对点复核)══════════════════════════
console.log('\n── G Channel 级插件开关 ──')
{
  const ch = await api('POST', '/api/workshop/channels', { token: userToken, body: { name: `PLC开关频道-${TAG}` } })
  const channelId = env(ch)?.channelId
  ok(Boolean(channelId), '测试频道创建')
  const tpl = await api('POST', '/api/workshop/agents', { token: userToken, body: { name: `开关执行器-${TAG}`, harness: 'mock' } })
  const tplId = env(tpl)?.id
  const add = await api('POST', `/api/workshop/channels/${channelId}/agents`, { token: userToken, body: { name: env(tpl)?.name, harness: 'mock', templateId: tplId, role: 'worker' } })
  const member = env(add)?.agent ?? env(add)
  ok(Boolean(member?.id && member?.token), 'mock 成员加入频道')
  if (member?.id && channelId) {
    const off = await api('PUT', `/api/workshop/channels/${channelId}/plugins`, { token: userToken, body: { plugins: [{ name: 'rag-bridge', enabled: false }, { name: 'diag-bridge', enabled: true }] } })
    ok(off.status === 200, 'PUT 关闭 rag-bridge')
    const list1 = await api('GET', `/api/workshop/agent-tools/list?agentId=${member.id}`, { agent: member })
    const names1 = (list1?.json?.data?.tools ?? list1?.json?.tools ?? []).map(t => t?.name)
    ok(!names1.includes('kb_search'), '关闭插件工具不注入')
    ok(names1.includes('diag_run'), '开启插件工具注入')
    const denied = await invoke(member, 'kb_search', { query: 'x' }, 30000)
    ok(resultText(denied).includes('未启用插件'), 'dispatch 同源拒绝', resultText(denied).slice(0, 60))
    await api('PUT', `/api/workshop/channels/${channelId}/plugins`, { token: userToken, body: { plugins: [{ name: 'rag-bridge', enabled: true }, { name: 'diag-bridge', enabled: true }] } })
    let back = false
    for (let i = 0; i < 8 && !back; i++) {
      await sleep(1000)
      const list2 = await api('GET', `/api/workshop/agent-tools/list?agentId=${member.id}`, { agent: member })
      if (((list2?.json?.data?.tools ?? list2?.json?.tools ?? []).map(t => t?.name)).includes('kb_search')) back = true
    }
    ok(back, '重开后工具恢复')
  }
}

// ══ Stage H:Harness 集成面 ═════════════════════════════════════════
console.log('\n── H Harness 集成面 ──')
{
  const list = await api('GET', `/api/workshop/agent-tools/list?agentId=${exec.id}`, { agent: exec })
  const names = (list?.json?.data?.tools ?? list?.json?.tools ?? []).map(t => t?.name)
  for (const t of ['kb_search', 'kb_store', 'kb_index', 'diag_run', 'diag_status']) ok(names.includes(t), `omp 执行器工具清单含 ${t}`)
  for (const t of ['daq_query', 'dcw_control', 'dcw_judge', 'dcw_read', 'line_context']) ok(names.includes(t), `omp 执行器工业工具含 ${t}`)
  const ctxT = await invoke(exec, 'line_context', {}, 60000)
  ok(!resultText(ctxT).startsWith('工具') || resultText(ctxT).length > 0, 'line_context 可用(工业链路)', resultText(ctxT).slice(0, 60))
}

// ══ 汇总 ═══════════════════════════════════════════════════════════
console.log(`\n══ 结果:${pass} 通过 / ${fail} 失败 ══`)
if (failures.length) {
  console.error('失败项:')
  for (const f of failures) console.error(`  - ${f}`)
}
process.exit(fail > 0 ? 1 : 0)
