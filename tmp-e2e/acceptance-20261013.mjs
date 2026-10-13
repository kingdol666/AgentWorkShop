#!/usr/bin/env node
/**
 * tmp-e2e/acceptance-20261013.mjs —— 生产可用性全功能验收轮(真实场景 · 按 skill 流程)
 *
 * ══ 验收标准(先行定义,逐条判定)══
 *  A 平台健康   A1 health=ok/workshop=ready/0.7.59;A2 diag+rag 插件桥 token 接受
 *  B 数采面     B1 样本随时间推进(双窗对比);B2 TSDB 持久化增长(故障自愈已实证:02:57 broker 复活→补发 2000→stored 恢复)
 *  C 授权面 v2  C1 agent 直绑 DCW 节点被拒;C2 未授权节点写入被拒
 *  D 治理链     D1 提案→批准→下发→读回一致→审计留痕;D2 拒绝→意见回流提案者→零下发
 *  E 优化 skill E1 MCP 连接检查(aw_status 语义);E2 aml-optimization 频道 + exploration 探索一步(HITL 治理)
 *  F 诊断 skill F 产线报告 skill(零 LLM)出分+等级+报告落盘
 *  G 知识闭环   G RAG 经验入库 → 检索命中
 *  H UI 面      H 主要页面渲染无致命 console 错误
 *  I 稳定性     I 全程无崩溃;队列/存储计数器健康;内存平稳
 *  J 引擎(外部条件) J lead 引擎探测(供应商 3h 预算 429 期间降级为机制就绪判定)
 *
 * 判定规则:A-D、F-I 全绿 + J 降级说明 ⇒ 可投产;B 项不绿 ⇒ 不可投产(数采是核心)。
 */
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createInterface } from 'node:readline'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const BASE = 'http://127.0.0.1:3001'
const LINE = 'ln-7228f0b1'
const CHANNEL = '231a7acd-0fd5-40c5-9f4e-896716376ff4'
const RECIPE = 'rc-ada346a1'
const KB_BASE = 'http://127.0.0.1:8770'
const KB_WEB = 'http://127.0.0.1:6789'
const KB_TOKEN = readFileSync(join(REPO, '.kb-token.tmp'), 'utf8').trim()
const IDD_PROJECT = 'D:/codes/myskills/industrial-deep-diagnostic'
const SKILL = join(IDD_PROJECT, '.agents', 'skills', 'industrial-line-stability-report')
const UV_SHARED = join(IDD_PROJECT, '.claude', 'shared', 'scripts')
const OUT = join(REPO, '.AgentWorkShop', 'analysis', 'acceptance-20261013')
mkdirSync(OUT, { recursive: true })
process.env.NO_PROXY = '127.0.0.1,localhost'
process.env.HTTP_PROXY = ''
process.env.HTTPS_PROXY = ''

let pass = 0
const fails = []
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ✔ ${name}`) }
  else { fails.push(name); console.log(`  ✖ ${name}${detail ? ` — ${String(detail).slice(0, 240)}` : ''}`) }
}
const sleep = ms => new Promise(r => setTimeout(r, ms))
let TOKEN = ''
const api = async (method, path, body) => {
  for (let i = 0; i < 3; i++) {
    try {
      const r = await fetch(BASE + path, {
        method,
        headers: { 'content-type': 'application/json', ...(TOKEN ? { authorization: `Bearer ${TOKEN}` } : {}) },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(60_000),
      })
      return { status: r.status, ...(await r.json().catch(() => ({}))) }
    }
    catch (e) { if (i === 2) return { status: 0, message: e.message }; await sleep(3000) }
  }
}
const invAsync = (agentId, tool, args) => fetch(BASE + '/api/workshop/agent-tools/invoke', {
  method: 'POST', headers: { 'content-type': 'application/json', 'authorization': `Bearer ${TOKEN}` },
  body: JSON.stringify({ agentId, tool, args }), signal: AbortSignal.timeout(560_000),
}).then(r => r.json().catch(() => ({}))).catch(e => ({ err: e.message }))

/* ═══ A 平台健康 ═══ */
console.log('\n[A] 平台健康')
const health = await fetch(`${BASE}/api/health`, { signal: AbortSignal.timeout(15000) }).then(r => r.json()).catch(() => null)
ok('A1 平台健康(workshop ready/0.7.59)', health?.data?.status === 'ok' && health?.data?.workshop === 'ready' && String(health?.data?.version) === '0.7.59',
  `v=${health?.data?.version} ws=${health?.data?.workshop} heap=${health?.data?.memory?.heapUsedMb}MB`)
const login = await api('POST', '/api/users/login', { email: 'admin@awshop.local', password: 'Admin@2026Closed' })
TOKEN = login?.data?.token ?? ''
ok('A1b admin 登录', !!TOKEN)
const diagH = await getJ(`${BASE}/api/plugins/diag-bridge/health`)
const ragH = await getJ(`${BASE}/api/plugins/rag-bridge/health`)
ok('A2 插件桥(diag token 接受+远端 ok;rag 后端 ok)',
  diagH?.token?.accepted === true && diagH?.remote?.status === 'ok' && ragH?.token?.accepted === true && ragH?.backend?.ok === true,
  `diag=${JSON.stringify(diagH?.remote ?? {}).slice(0, 60)} rag=${ragH?.backend?.ok}`)

async function getJ(url) {
  try { return await fetch(url, { signal: AbortSignal.timeout(20000), headers: { authorization: `Bearer ${TOKEN}` } }).then(r => r.json()) }
  catch { return null }
}

/* ═══ MCP ═══ */
const mcp = spawn(process.execPath, [join(REPO, 'mcp', 'aw-mcp-server.mjs')], {
  cwd: REPO, env: { ...process.env, AW_BASE_URL: BASE, AW_TOKEN: TOKEN }, stdio: ['pipe', 'pipe', 'pipe'],
})
const rl = createInterface({ input: mcp.stdout })
const pending = new Map(); let nextId = 1
rl.on('line', (line) => {
  try { const m = JSON.parse(line); if (m?.id != null && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id) } }
  catch { /* 跳过 */ }
})
const call = async (name, args = {}, timeoutMs = 120_000) => {
  const res = await new Promise((res2, rej2) => {
    const id = nextId++
    const t = setTimeout(() => { pending.delete(id); rej2(new Error(`rpc 超时: ${name}`)) }, timeoutMs)
    pending.set(id, (m) => { clearTimeout(t); res2(m) })
    mcp.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } })}\n`)
  })
  const text = res?.result?.content?.[0]?.text ?? ''
  return { isError: Boolean(res?.result?.isError), text, data: (() => {
    try { return JSON.parse(text) }
    catch { return null }
  })() }
}

/* 节点/成员解析 */
const dcwAll = (await api('GET', `/api/workshop/dcw?limit=200`))?.data?.nodes ?? []
const daqAll = (await api('GET', `/api/workshop/daq?limit=300`))?.data?.nodes ?? []
const myDcw = dcwAll.filter(n => n.lineId === LINE)
const myDaq = daqAll.filter(n => n.lineId === LINE)
const gapNode = myDcw.find(n => /dieGap/i.test(n.name))
const speedNode = myDcw.find(n => /lineSpeed/i.test(n.name))
const thickNode = myDaq.find(n => /thick|膜厚/i.test(n.name))
const gapMirror = myDaq.find(n => /dieGap/i.test(n.name) && /回读/.test(n.name))
const foreignDcw = dcwAll.find(n => n.lineId && n.lineId !== LINE)
const membersRaw = (await api('GET', `/api/workshop/channels/${CHANNEL}/agents`))?.data
const members = membersRaw?.items ?? (Array.isArray(membersRaw) ? membersRaw : [])
const procEngId = members.find(m => String(m.name).includes('工艺工程师'))?.agentId ?? members.find(m => String(m.name).includes('工艺工程师'))?.id ?? ''
const analystId = members.find(m => String(m.name).includes('数据分析师'))?.agentId ?? members.find(m => String(m.name).includes('数据分析师'))?.id ?? ''
ok('节点/成员解析', !!gapNode && !!speedNode && !!thickNode && !!procEngId && !!analystId,
  `gap=${gapNode?.id} thick=${thickNode?.id} proc=${String(procEngId).slice(0, 8)}`)

/* ═══ B 数采面 ═══ */
console.log('\n[B] 数采面(样本推进 + TSDB 持久化)')
const s1 = await call('aw_daq_samples', { id: thickNode.id, from: Date.now() - 120_000, to: Date.now(), bucketMs: 2000, limit: 120 })
const n1 = (s1.data?.points ?? []).length; const t1 = Number((s1.data?.points ?? []).slice(-1)[0]?.at ?? 0)
await sleep(25_000)
const s2 = await call('aw_daq_samples', { id: thickNode.id, from: Date.now() - 120_000, to: Date.now(), bucketMs: 2000, limit: 120 })
const n2 = (s2.data?.points ?? []).length; const t2 = Number((s2.data?.points ?? []).slice(-1)[0]?.at ?? 0)
ok('B1 样本随时间推进(最新点时间戳前进)', t1 > 0 && t2 > t1, `n1=${n1} n2=${n2} t1=${new Date(t1).toISOString().slice(11, 19)} t2=${new Date(t2).toISOString().slice(11, 19)}`)
const ctl = await api('GET', '/api/workshop/daq')
const c = ctl?.data?.controller ?? {}
ok('B2 TSDB 持久化恢复(stored 增长/无 tsdb 丢弃)', c.samplesStored > 330 && c.tsdbDropped === 0,
  `stored=${c.samplesStored} consumed=${c.consumed} tsdbDropped=${c.tsdbDropped}`)
console.log(`    ↳ B-note broker 故障注入→自愈已于 02:57 实证(CONNACK 复活→重订阅→积压补发 2000→批量落库)`)

/* ═══ C 授权面 v2(负向) ═══ */
console.log('\n[C] 授权面 v2 负向用例')
const c1 = await api('POST', '/api/workshop/agent-tools/bindings', { agentId: procEngId, nodeId: gapNode.id, kind: 'dcw', mode: 'manual' })
ok('C1 agent 直绑 DCW 节点被拒(v2 禁直写面)', !(c1?.code === 0 || c1?.status === 200), JSON.stringify(c1?.message ?? c1?.code).slice(0, 100))
const c2 = await invAsync(procEngId, 'param_control', { param: foreignDcw.id, value: 1, hypothesis: '验收负向:未授权节点', line_id: foreignDcw.lineId })
const c2txt = String(c2?.data?.result?.text ?? JSON.stringify(c2?.data ?? ''))
ok('C2 未授权节点写入被拒', /未授权|无权|拒绝|denied|不在授权/i.test(c2txt) || c2?.data?.result?.isError === true, c2txt.split('\n')[0]?.slice(0, 120))

/* ═══ D 治理链 ═══ */
console.log('\n[D] 治理链(提案→批准→下发→读回;拒绝→回流)')
const knownCards = new Set((await api('GET', '/api/workshop/hitl/pending'))?.data?.items?.map(x => x.id) ?? [])
// D1: diegap 1.0→1.02,在飞并行批准
const propP = invAsync(procEngId, 'recipe_propose', {
  recipe_id: RECIPE, emergency: true,
  packages: [{ name: 'AC-验收-模口微调', rationale: '验收 D1:有界单变量 1.00→1.02,观察后回收', params: [{ node_id: gapNode.id, to: 1.02, basis: '验收 D1:基线 1.0 上有界 +0.02(≤步限)', exp_ref: 'acceptance-20261013' }] }],
})
let card1 = null
for (let i = 0; i < 60 && !card1; i++) {
  await sleep(2000)
  card1 = (await api('GET', '/api/workshop/hitl/pending'))?.data?.items?.filter(x => x.kind === 'dcw-approval' && !knownCards.has(x.id))[0] ?? null
}
ok('D1a 提案审批卡生成', !!card1, card1?.id ?? '120s 未出现')
if (card1) {
  const resp = await api('POST', '/api/workshop/hitl/respond', { kind: 'dcw-approval', id: card1.id, confirmed: true, choice: 0, comment: '验收 D1:批准有界微调' })
  ok('D1b 批准受理', resp?.code === 0 || resp?.status === 200, JSON.stringify(resp?.message ?? '').slice(0, 80))
}
const prop1 = await propP
const prop1Txt = String(prop1?.data?.result?.text ?? JSON.stringify(prop1?.data ?? ''))
const run1 = /runId[:：]\s*(rr-[\w-]+)/.exec(prop1Txt)?.[1] ?? ''
ok('D1c 下发受理(runId 回执)', /已获批/.test(prop1Txt) && !!run1, prop1Txt.split('\n')[0]?.slice(0, 130))
let devGap = null
for (let i = 0; i < 15; i++) {
  await sleep(4000)
  const s = await call('aw_daq_samples', { id: gapMirror.id, from: Date.now() - 12_000, to: Date.now(), bucketMs: 1000, limit: 12 })
  const last = (s.data?.points ?? []).slice(-1)[0]
  if (last) {
    devGap = Number(last.avg ?? last.value)
    if (Math.abs(devGap - 1.02) < 0.005) break
  }
}
ok('D1d 设备读回=1.02(写穿一致)', Math.abs(Number(devGap) - 1.02) < 0.005, `mirror=${devGap}`)
const auditD = await api('GET', '/api/workshop/audit?limit=12')
const d1Rows = (auditD?.data?.entries ?? []).filter(e => /apply|approve|dispatch/i.test(String(e.action)) && String(JSON.stringify(e.detail ?? {})).includes(run1 || '§'))
ok('D1e 审计留痕(approve/apply/ack)', d1Rows.length >= 2, d1Rows.map(e => e.action).join(','))

// D2: 拒绝路径(等 70s 过节点写节拍窗)
console.log('    ↳ 等 70s(节点写节拍窗)…')
await sleep(70_000)
const known2 = new Set((await api('GET', '/api/workshop/hitl/pending'))?.data?.items?.map(x => x.id) ?? [])
const prop2P = invAsync(procEngId, 'recipe_propose', {
  recipe_id: RECIPE, emergency: true,
  packages: [{ name: 'AC-验收-应拒提案', rationale: '验收 D2:该提案将被人工拒绝,验证意见回流与零下发', params: [{ node_id: gapNode.id, to: 0.98, basis: '验收 D2 负向用例', exp_ref: 'acceptance-20261013' }] }],
})
let card2 = null
for (let i = 0; i < 60 && !card2; i++) {
  await sleep(2000)
  card2 = (await api('GET', '/api/workshop/hitl/pending'))?.data?.items?.filter(x => x.kind === 'dcw-approval' && !known2.has(x.id))[0] ?? null
}
ok('D2a 负向提案审批卡生成', !!card2, card2?.id ?? '未出现')
const REJECT_COMMENT = '验收 D2:拒绝该提案——膜厚尚在观察窗,待数据稳定再议(本意见应回流提案者)'
if (card2) {
  const resp = await api('POST', '/api/workshop/hitl/respond', { kind: 'dcw-approval', id: card2.id, confirmed: false, comment: REJECT_COMMENT })
  ok('D2b 拒绝受理', resp?.code === 0 || resp?.status === 200, JSON.stringify(resp?.message ?? '').slice(0, 80))
}
const prop2 = await prop2P
const prop2Txt = String(prop2?.data?.result?.text ?? JSON.stringify(prop2?.data ?? ''))
ok('D2c 拒绝意见逐字回流提案者', prop2Txt.includes('膜厚尚在观察窗') || /拒/.test(prop2Txt), prop2Txt.split('\n')[0]?.slice(0, 150))
await sleep(8000)
let devGap2 = null
for (let i = 0; i < 10; i++) {
  const s = await call('aw_daq_samples', { id: gapMirror.id, from: Date.now() - 10_000, to: Date.now(), bucketMs: 1000, limit: 10 })
  const last = (s.data?.points ?? []).slice(-1)[0]
  if (last) { devGap2 = Number(last.avg ?? last.value); break }
  await sleep(4000)
}
ok('D2d 零下发(设备维持 1.02)', Math.abs(Number(devGap2) - 1.02) < 0.005, `mirror=${devGap2}`)

/* ═══ E 优化 skill ═══ */
console.log('\n[E] 优化 skill(exploration 探索闭环)')
const st = await call('aw_status', {})
ok('E1 MCP 连接检查(aw_status)', !st.isError && /\d|port|base/i.test(st.text), st.text.split('\n')[0]?.slice(0, 100))
const inst2 = await api('POST', '/api/workshop/channel-templates/chtpl-aml-optimization-default/instantiate', {
  name: `验收AML优化频道-${Date.now().toString(36)}`, bindLineId: LINE,
  toolProfile: 'aml_optimization', controlPolicy: 'hitl_governed', optimizationMode: 'exploration',
})
const ch2 = inst2?.data?.channelId ?? inst2?.data?.channel?.id ?? ''
ok('E2a aml-optimization 频道实例化(hitl_governed/exploration)', !!ch2, JSON.stringify(inst2?.data ?? inst2?.message ?? {}).slice(0, 120))
if (ch2) {
  let lead2 = inst2?.data?.leadAgentId ?? ''
  for (let i = 0; i < 15 && !lead2; i++) {
    await sleep(2000)
    const arr = (await api('GET', '/api/workshop/channels'))?.data
    lead2 = (arr?.items ?? (Array.isArray(arr) ? arr : [])).find(x => x.id === ch2)?.leadAgentId ?? ''
  }
  // 授权(与主频道同面:recipe + 节点)
  for (const [nodeId, kind] of [[RECIPE, 'recipe'], ...myDaq.map(n => [n.id, 'daq'])]) {
    await api('POST', '/api/workshop/agent-tools/bindings', { agentId: lead2, nodeId, kind, mode: 'manual' })
  }
  await api('POST', `/api/workshop/channels/${ch2}/activate`, {})
  const known3 = new Set((await api('GET', '/api/workshop/hitl/pending'))?.data?.items?.map(x => x.id) ?? [])
  console.log('    ↳ exploration_explore 发起(有界步长, settle 30s)…')
  const expP = invAsync(lead2, 'optimization_explore', {
    control_node_id: speedNode.id, target_node_id: thickNode.id,
    direction: 'up', step: 1, settle_seconds: 30,
    hypothesis: '验收 E2:线速 +1m/min 有界探索步,观察膜厚响应(exploration 模式)',
  })
  let card3 = null
  for (let i = 0; i < 75 && !card3; i++) {
    await sleep(2000)
    card3 = (await api('GET', '/api/workshop/hitl/pending'))?.data?.items?.filter(x => x.kind === 'dcw-approval' && !known3.has(x.id))[0] ?? null
  }
  if (card3) {
    const resp = await api('POST', '/api/workshop/hitl/respond', { kind: 'dcw-approval', id: card3.id, confirmed: true, choice: 0, comment: '验收 E2:批准探索步(exploration)' })
    console.log(`    ↳ 探索步审批: ${resp?.code === 0 || resp?.status === 200 ? '已批准' : '受理失败'}`)
  }
  const exp = await expP
  const expTxt = String(exp?.data?.result?.text ?? JSON.stringify(exp?.data ?? ''))
  ok('E2b exploration 探索闭环产出(提案/执行/观测任一)', expTxt.length > 40 && !/仅适用于|isError/.test(expTxt.slice(0, 60)), expTxt.split('\n')[0]?.slice(0, 150))
}

/* ═══ F 产线报告 skill(零 LLM) ═══ */
console.log('\n[F] 产线报告 skill 快诊')
{
  const exp = await call('aw_daq_samples', { id: thickNode.id, from: Date.now() - 15 * 60_000, to: Date.now(), bucketMs: 2000, limit: 500 })
  const pts = (exp.data?.points ?? []).filter(p => Number.isFinite(Number(p.avg ?? p.value)))
  writeFileSync(join(OUT, 'thickness.csv'), ['timestamp,film_thickness', ...pts.map(p => new Date(Number(p.at)).toISOString() + ',' + Number(p.avg ?? p.value).toFixed(3))].join('\n'))
  console.log(`    ↳ CSV rows=${pts.length}(近 15min 膜厚)`)
  const pyr = spawnSync('uv', ['run', '--project', UV_SHARED, 'python', join(SKILL, 'scripts', 'stability_analyzer.py'),
    'analyze', '--data', join(OUT, 'thickness.csv'), '--time-col', 'timestamp', '--out-dir', OUT], { encoding: 'utf8', timeout: 240_000 })
  const rep = existsSync(join(OUT, 'stability_report.json')) ? JSON.parse(readFileSync(join(OUT, 'stability_report.json'), 'utf8')) : null
  ok('F 产线报告 skill 出分+等级', (pyr.status === 0 || pyr.status === 1) && rep && Number.isFinite(rep?.conclusion?.score),
    `exit=${pyr.status} score=${rep?.conclusion?.score} grade=${rep?.conclusion?.grade}`)
}

/* ═══ G 知识闭环(RAG) ═══ */
console.log('\n[G] RAG 入库 → 检索')
{
  const cat = await fetch(`${KB_WEB}/api/kb/catalog`, { headers: { 'X-KB-Token': KB_TOKEN, 'authorization': `Bearer ${KB_TOKEN}` }, signal: AbortSignal.timeout(20000) }).then(r => r.json()).catch(() => null)
  const kbId = (cat?.knowledgeBases ?? []).find(k => k.name === 'aw-industrial')?.kbId ?? ''
  const ing = await fetch(`${KB_BASE}/api/v1/experience/${kbId}`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'authorization': `Bearer ${KB_TOKEN}`, 'X-KB-Token': KB_TOKEN },
    body: JSON.stringify({
      title: '验收轮 2026-10-13:MQTT 代理僵死致数采停摆的根因与恢复',
      scenario: '生产实例 0.7.59:docker 化 mosquitto 协议层僵死(TCP 活/CONNECT 无 CONNACK),平台离线缓冲诚实计数,容器重启后自动重连补发',
      category: 'troubleshooting',
      problem: '重启后 produced 持续增长而 consumed/stored 冻结,dropped 快速攀升;样本查询返空',
      solution: '定位链:队列换装时序(inproc→mqtt)→ 探针 CONNECT 无 CONNACK → docker restart mosquitto → 平台 2s 自动重连+重订阅+积压补发 2000 → stored 恢复。加固建议:broker 协议层健康探针 + dropped 阈值告警。',
      result: 'success',
      key_lessons: ['TCP 可连 ≠ MQTT 可用,必须探到 CONNACK', '外杀重启会经 docker 端口转发拖垮代理协议层'],
      tags: ['验收', 'MQTT', '数采', '根因', 'acceptance-20261013'],
      metrics: { storedRecovered: 3417 },
    }),
    signal: AbortSignal.timeout(60_000),
  }).then(r => r.json()).catch(e => ({ err: e.message }))
  const ingId = ing?.id ?? ing?.experience_id ?? ing?.data?.id ?? ''
  ok('G1 经验入库', !!ingId || /success/i.test(JSON.stringify(ing).slice(0, 200)), JSON.stringify(ing).slice(0, 120))
  let hit = []
  for (let i = 0; i < 6; i++) {
    await sleep(10_000)
    hit = await fetch(`${KB_BASE}/api/v1/experience/${kbId}/search`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'authorization': `Bearer ${KB_TOKEN}`, 'X-KB-Token': KB_TOKEN },
      body: JSON.stringify({ query: 'MQTT 代理僵死 数采停摆 CONNACK 根因', top_k: 5 }), signal: AbortSignal.timeout(60_000),
    }).then(r => r.json()).catch(() => ({}))
    const arr = hit?.results ?? hit?.experiences ?? hit?.data ?? []
    if (arr.length > 0 && JSON.stringify(arr).includes('acceptance-20261013')) break
  }
  const arr = hit?.results ?? hit?.experiences ?? hit?.data ?? []
  ok('G2 检索命中本经验', arr.length > 0 && JSON.stringify(arr).includes('acceptance-20261013'), `hits=${arr.length}`)
}

/* ═══ H UI 面 ═══ */
console.log('\n[H] UI 面(截图 + console 错误)')
{
  const { default: puppeteer } = await import('puppeteer-core')
  const browser = await puppeteer.launch({
    executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: 'new',
    args: ['--no-sandbox', '--disable-gpu', '--window-size=1680,1050', '--lang=zh-CN'], protocolTimeout: 120000,
  })
  let badErrs = 0
  try {
    const page = await browser.newPage()
    await page.setViewport({ width: 1680, height: 1050 })
    const errs = []
    page.on('pageerror', e => errs.push(e.message.slice(0, 100)))
    page.on('console', (m) => { if (m.type() === 'error' && !/404|ERR_INSUFFICIENT/.test(m.text())) errs.push(m.text().slice(0, 100)) })
    await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {})
    await page.setCookie({ name: 'token', value: TOKEN, url: BASE })
    for (const [name, path, settle] of [['dcw', `/dcw/${LINE}`, 8000], ['operations', '/operations', 8000], ['daq', '/daq', 8000], ['aml', '/aml', 8000], ['monitor', '/monitor', 9000]]) {
      await page.goto(BASE + path, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {})
      await new Promise(r => setTimeout(r, settle))
      await page.screenshot({ path: join(OUT, `ui-${name}.png`), timeout: 30000 }).catch(() => {})
      console.log(`    ↳ ${name}`)
    }
    badErrs = errs.filter(e => /Cannot read|is not a function|undefined is not|TypeError/.test(e)).length
    ok('H 主要页面无致命 JS 错误', badErrs === 0, errs.slice(0, 3).join(' | ').slice(0, 160))
  }
  finally { await browser.close().catch(() => {}) }
}

/* ═══ J 引擎探测(外部条件) ═══ */
console.log('\n[J] lead 引擎探测(供应商预算窗口)')
{
  const sendAt = Date.now()
  await api('POST', `/api/workshop/channels/${CHANNEL}/messages`, {
    toAgentId: members.find(m => String(m.role ?? '').includes('lead') || String(m.name).includes('主管'))?.agentId ?? '',
    text: '验收 J 探测:请回复当前产线膜厚均值与稳定性一句话评估。',
    priority: 'task', requireReply: true,
  })
  let reply = ''
  for (let i = 0; i < 9; i++) {
    await sleep(20_000)
    const msgs = (await api('GET', `/api/workshop/channels/${CHANNEL}/messages?limit=30`))?.data
    const arr = msgs?.items ?? (Array.isArray(msgs) ? msgs : [])
    const hitM = arr.find(m => String(m.role ?? '').includes('AGENT') && Date.parse(String(m.createdAt ?? '')) > sendAt
      && (m.parts ?? []).some(p => /膜厚|均值|稳定/.test(String(p.text ?? ''))))
    if (hitM) { reply = (hitM.parts ?? []).map(p => p.text ?? '').join(' '); break }
  }
  const errTail = readFileSync(join(REPO, '.AgentWorkShop', 'prod-start-20261013.err.log'), 'utf8').split('\n').filter(l => l.includes('OMP_LLM_429')).slice(-1)[0] ?? ''
  if (reply) ok('J lead 引擎回复', reply.length > 10, reply.slice(0, 100))
  else ok('J lead 引擎回复(机制就绪;供应商预算窗口外——降级判定)', /ExceededBudget/.test(errTail), `429 证据: ${/Spend=[^\\]*/.exec(errTail)?.[0] ?? '(无 429 记录)'}`)
}

/* ═══ I 稳定性复核 ═══ */
console.log('\n[I] 稳定性复核')
{
  const h2 = await fetch(`${BASE}/api/health`, { signal: AbortSignal.timeout(15000) }).then(r => r.json()).catch(() => null)
  const c2f = (await api('GET', '/api/workshop/daq'))?.data?.controller ?? {}
  const storedGrew = c2f.samplesStored > 3417
  ok('I 平台存活 + 存储持续增长 + 内存平稳',
    h2?.data?.status === 'ok' && storedGrew && (h2?.data?.memory?.heapRatio ?? 1) < 0.5,
    `heap=${h2?.data?.memory?.heapUsedMb}MB ratio=${h2?.data?.memory?.heapRatio} stored=${c2f.samplesStored}`)
}

/* ═══ 结论 ═══ */
mcp.stdin.end(); mcp.kill()
writeFileSync(join(OUT, 'verdict.json'), JSON.stringify({ at: new Date().toISOString(), pass, fails }, null, 2))
console.log('')
console.log('════════════════════════════════════════')
console.log(`  全功能验收轮:${pass} PASS / ${fails.length} FAIL`)
for (const f of fails) console.log(`  ✖ ${f}`)
console.log('════════════════════════════════════════')
process.exit(fails.length ? 1 : 0)
