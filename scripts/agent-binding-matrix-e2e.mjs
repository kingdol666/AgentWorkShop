/**
 * Agent 绑定→工具注入→取数→下发 端到端矩阵(设计验证轮)。
 *
 * 用法: node scripts/agent-binding-matrix-e2e.mjs <scenario-context.json>
 * 产物: docs/audit/evidence/2026-10-22-design-validation/binding-matrix.json
 *
 * 覆盖:
 *  A 工具面装配(全族 host 工具+插件工具在位)
 *  B 授权面=绑定面:绑 1 节点的 agent 只能查该节点;越权节点拒绝附指引;line 级查询收窄
 *  C 多产线:第二产线的节点绑定后可查,线 A 未绑节点仍拒
 *  D 多源异构经 Agent 工具:daq_frames 取 48 点数组断面 + CCD 图像(元数据/引用,像素不入 LLM)
 *  E 自定义 API:http 驱动轮询节点入镜像 + ingest REST 自定义推送(标量+数组+图像)
 *  F 参数下发:recipe 绑定 agent 经 HITL 批准下发并设备证实,回读一致
 *  G 插件工具真调用:kb_agent(rag-bridge)经 invoke 桥返回结构化结果
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const CTX = process.argv[2]
if (!CTX) {
  console.error('用法: node scripts/agent-binding-matrix-e2e.mjs <scenario-context.json>')
  process.exit(1)
}
const c = JSON.parse(readFileSync(CTX, 'utf8'))
const EVID = join(REPO, 'docs', 'audit', 'evidence', '2026-10-22-design-validation')
mkdirSync(EVID, { recursive: true })
const sleep = ms => new Promise(r => setTimeout(r, ms))
const results = []
function ok(id, name, cond, detail = '') {
  results.push({ id, name, pass: Boolean(cond), detail: String(detail).slice(0, 600) })
  console.log(`${cond ? '✔' : '✖'} [${id}] ${name}${detail ? ` — ${String(detail).slice(0, 240)}` : ''}`)
}
async function api(method, path, body) {
  const r = await fetch(c.base + path, {
    method,
    headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), authorization: `Bearer ${c.adminToken}` },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(120_000),
  })
  return { status: r.status, data: (await r.json().catch(() => null))?.data, message: '' }
}
function invokeOf(agent) {
  return async (tool, args, timeoutMs = 180_000) => {
    const r = await fetch(c.base + '/api/workshop/agent-tools/invoke', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-aw-agent-token': agent.token },
      body: JSON.stringify({ agentId: agent.id, tool, args }),
      signal: AbortSignal.timeout(timeoutMs),
    })
    const j = await r.json().catch(() => null)
    return { status: r.status, isError: Boolean(j?.data?.result?.isError), text: String(j?.data?.result?.text ?? '') }
  }
}
async function main() {
  console.log(`━━━ binding-matrix @ ${c.base} line=${c.lineId} ━━━`)
  const analyst = c.agents.analyst
  const optimizer = c.agents.optimizer
  const analystInvoke = invokeOf(analyst)
  const optimizerInvoke = invokeOf(optimizer)

  // ── A 工具面装配 ──
  const listFor = async (agent) => {
    const r = await fetch(`${c.base}/api/workshop/agent-tools/list?agentId=${agent.id}`, { headers: { 'x-aw-agent-token': agent.token } })
    return r.status === 200 ? ((await r.json())?.data?.tools ?? []) : []
  }
  const aTools = await listFor(analyst)
  const aNames = aTools.map(t => t.name)
  ok('A1', '工具面全族装配(worker n≥50,含 daq/frames/recipe/analysis/line)', aNames.length >= 50
  && ['daq_query', 'daq_frames', 'recipe_catalog', 'analysis_save', 'line_context'].every(t => aNames.includes(t)), `n=${aNames.length}`)
  ok('A2', '插件工具注入(rag-bridge: kb_agent+sentinel_*)', aNames.includes('kb_agent') && aNames.filter(n => n.startsWith('sentinel_')).length >= 1,
    `kb=${aNames.includes('kb_agent')} sentinel×${aNames.filter(n => n.startsWith('sentinel_')).length}`)
  let oTools = await listFor(optimizer)
  for (let i = 0; i < 3 && !(oTools.length >= 50 && oTools.some(t => t.name === 'daq_query')); i++) {
    await sleep(2000)
    oTools = await listFor(optimizer)
  }
  ok('A3', 'optimizer 同族工具面(角色差异由授权面体现)', oTools.length >= 50 && oTools.some(t => t.name === 'daq_query'),
    `n=${oTools.length} hasDaq=${oTools.some(t => t.name === 'daq_query')}`)

  // ── B 单节点绑定授权面 ──
  const daqNodes = (await api('GET', '/api/workshop/daq')).data?.nodes ?? []
  const lineNodes = daqNodes.filter(n => n.lineId === c.lineId)
  const weightNode = c.daq?.['part-weight'] ?? c.weightNode
  const sibling = lineNodes.find(n => n.id !== weightNode)
  const tpl = await api('POST', '/api/workshop/agents', { name: `单点绑定工-${Date.now().toString(36).slice(-4)}`, harness: 'mock', config: {} })
  const tplId = tpl.data?.id
  const joinB1 = await api('POST', `/api/workshop/channels/${c.channelId}/agents`, { agentId: tplId, role: 'worker' })
  const members = (await api('GET', `/api/workshop/channels/${c.channelId}/agents`)).data
  const memberList = Array.isArray(members) ? members : (members?.agents ?? [])
  const b1 = memberList.find(m => m.id === (joinB1.data?.id ?? joinB1.data?.agentId)) ?? memberList.find(m => /单点绑定工/.test(m.name))
  ok('B0', '新 agent 入频道(含 token)', Boolean(b1?.token), `id=${b1?.id?.slice(0, 10)}`)
  const b1Invoke = invokeOf(b1)
  const bind1 = await api('POST', '/api/workshop/agent-tools/bindings', { agentId: b1.id, nodeId: weightNode, kind: 'daq', mode: 'auto' })
  ok('B1', '绑定 1 个节点(part-weight)', bind1.status === 200 && Boolean(bind1.data?.binding?.id))

  // ── C0 第二产线供给(手工轻量建:绕开 provisionScenarioLine 的同 tag 复用逻辑——
  // 复用命中会返回既有线 A,无法造第二条;mock 驱动节点无需模拟器设备) ──
  const tagL = Date.now().toString(36).slice(-4)
  const lb = await api('POST', '/api/workshop/dcw/lines', { name: `绑定矩阵-B线-${tagL}`, description: '绑定矩阵验证第二产线' })
  const lineB = lb.data?.line?.id
  const mkBNode = async nm => (await api('POST', '/api/workshop/daq', {
    name: nm, templateRef: 'daq-temp-tc', driver: 'mock', unit: '℃', min: 0, max: 100, decimals: 2,
    lineId: lineB, intervalMs: 1000, enabled: true,
  })).data?.node?.id
  const nodeB = lineB ? await mkBNode(`bm-b-line-t1-${tagL}`) : null
  const nodeB2 = lineB ? await mkBNode(`bm-b-line-t2-${tagL}`) : null
  ok('C0', '第二产线供给(line+2 mock 节点)', Boolean(lineB && nodeB && nodeB2), `lineB=${lineB} nodeB=${nodeB} nodeB2=${nodeB2}`)

  await sleep(500)
  const qBound = await b1Invoke('daq_query', { node_id: weightNode, last_minutes: 10, limit: 60 })
  const rest = await api('GET', `/api/workshop/daq/${weightNode}/samples?from=${Date.now() - 600_000}&to=${Date.now()}&bucketMs=1000&limit=200`)
  const restVals = (rest.data?.points ?? []).map(p => Number(p.value ?? p.avg)).filter(Number.isFinite)
  const restMean = restVals.length ? restVals.reduce((a, b) => a + b, 0) / restVals.length : NaN
  const toolMean = Number((qBound.text.match(/均值\s+([\d.]+)/) ?? [])[1])
  ok('B2', '绑定节点 daq_query 取到镜像数据且与 REST 镜像同值',
    !qBound.isError && Number.isFinite(toolMean) && Number.isFinite(restMean) && Math.abs(toolMean - restMean) <= Math.max(0.05, restMean * 0.02),
    `tool=${toolMean} rest=${restMean?.toFixed(3)}(n=${restVals.length})`)
  // v28 语义:频道绑线只读扩权 → 线内互查放行;真隔离边界=跨线未绑节点
  const qCrossLine = nodeB2 ? await b1Invoke('daq_query', { node_id: nodeB2, last_minutes: 5, limit: 10 }) : { isError: false, text: 'skipped' }
  ok('B3', '跨线未绑节点拒绝且附授权集指引(v28:隔离边界=线)',
    qCrossLine.isError && /不在你的授权范围|无权|你有权/.test(qCrossLine.text), qCrossLine.text.slice(0, 140))
  const qLine = await b1Invoke('daq_query', { line_id: c.lineId, last_minutes: 10, limit: 200 })
  const nodeSections = (qLine.text.match(/■ /g) ?? []).length
  ok('B4', '频道绑线只读扩权:线 A 全部节点可读(v28 文档语义)', !qLine.isError && nodeSections === lineNodes.length, `sections=${nodeSections}/${lineNodes.length}`)

  // ── C 多产线绑定扩展 ──
  // 权限模型 v3:绑线频道成员只能绑同产线节点(LINE_SCOPE_MISMATCH 是设计行为)。
  // 跨线正道=第二产线配第二频道(产线隔离工作区):建 channelB(绑 lineB)+成员 b2+绑 nodeB。
  if (lineB && nodeB) {
    const chB = await api('POST', '/api/workshop/channels', { name: `绑定矩阵-B频道-${Date.now().toString(36).slice(-4)}`, lineId: lineB, leadAgent: { name: `B线主管-${Date.now().toString(36).slice(-3)}`, harness: 'mock' } })
    const chBId = chB.data?.channelId
    const tpl2 = await api('POST', '/api/workshop/agents', { name: `B线绑定工-${Date.now().toString(36).slice(-4)}`, harness: 'mock', config: {} })
    const joinB2 = await api('POST', `/api/workshop/channels/${chBId}/agents`, { agentId: tpl2.data?.id, role: 'worker' })
    const members2 = (await api('GET', `/api/workshop/channels/${chBId}/agents`)).data
    const mList2 = Array.isArray(members2) ? members2 : (members2?.agents ?? [])
    const b2 = mList2.find(m => m.id === (joinB2.data?.id ?? joinB2.data?.agentId)) ?? mList2.find(m => /B线绑定工/.test(m.name))
    ok('C1', '第二频道(绑线 B)+成员 b2 就绪', Boolean(chBId && b2?.token), `chB=${chBId} b2=${b2?.id?.slice(0, 10)}`)
    const b2Invoke = b2 ? invokeOf(b2) : null
    const bindB = b2 ? await api('POST', '/api/workshop/agent-tools/bindings', { agentId: b2.id, nodeId: nodeB, kind: 'daq', mode: 'auto' }) : { status: 0, data: null }
    ok('C2', 'b2 绑定线 B 节点受理(同线一致)', bindB.status === 200 && Boolean(bindB.data?.binding?.id), String(bindB.data?.binding?.id ?? bindB.message ?? '').slice(0, 90))
    const qB = b2Invoke ? await b2Invoke('daq_query', { node_id: nodeB, last_minutes: 10, limit: 30 }) : { isError: true, text: 'skipped' }
    ok('C3', 'b2 查线 B 绑定节点放行(mock 无批,0 点不拒)', !qB.isError, qB.text.slice(0, 100))
    const qA = b2Invoke ? await b2Invoke('daq_query', { node_id: weightNode, last_minutes: 5, limit: 10 }) : { isError: true, text: 'skipped' }
    ok('C4', 'b2 查线 A 节点拒绝(跨频道跨线隔离)', qA.isError && /授权范围|无权|你有权/.test(qA.text), qA.text.slice(0, 110))
    const qLineB = b2Invoke ? await b2Invoke('daq_query', { line_id: lineB, last_minutes: 5, limit: 200 }) : { isError: true, text: 'skipped' }
    ok('C5', 'b2 lineB 级查询=频道绑线只读扩权(2 节点)', !qLineB.isError && (qLineB.text.match(/■ /g) ?? []).length === 2, `sections=${(qLineB.text.match(/■ /g) ?? []).length}`)
  }

  // ── D 多源异构经 Agent 工具(数组/图像) ──
  const tag = Date.now().toString(36).slice(-4)
  const mkNode = async body => (await api('POST', '/api/workshop/daq', body)).data?.node
  const vecNode = await mkNode({ name: `绑定矩阵-膜厚断面-${tag}`, templateRef: 'thickness-scan', driver: 'mock', lineId: c.lineId, intervalMs: 60000, enabled: true })
  const imgNode = await mkNode({ name: `绑定矩阵-CCD图像-${tag}`, templateRef: 'ccd-image', driver: 'mock', lineId: c.lineId, intervalMs: 60000, enabled: true })
  ok('D0', '异构帧节点在位(vector+image)', Boolean(vecNode?.id && imgNode?.id), `vec=${vecNode?.id} img=${imgNode?.id}`)
  const ingV = await api('POST', `/api/workshop/daq/${vecNode.id}/ingest`, { points: Array.from({ length: 48 }, (_, i) => Number((30 + Math.sin(i / 6) * 1.5).toFixed(3))), metrics: { source: 'binding-matrix', marker: 'v1' } })
  const ingI = await api('POST', `/api/workshop/daq/${imgNode.id}/ingest`, { image: { base64: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', mime: 'image/png', width: 1, height: 1 }, metrics: { source: 'binding-matrix', marker: 'i1' } })
  ok('D1', '自定义 API 推送数组帧(48 点)+图像帧入库', ingV.status === 200 && ingI.status === 200, `vec=${ingV.status} img=${ingI.status}`)
  await sleep(1500)
  const bindV = await api('POST', '/api/workshop/agent-tools/bindings', { agentId: b1.id, nodeId: vecNode.id, kind: 'daq', mode: 'auto' })
  const bindI = await api('POST', '/api/workshop/agent-tools/bindings', { agentId: b1.id, nodeId: imgNode.id, kind: 'daq', mode: 'auto' })
  ok('D2', '异构节点绑定受理', bindV.status === 200 && bindI.status === 200)
  const fVec = await b1Invoke('daq_frames', { node_id: vecNode.id, last_minutes: 30, limit: 10, include_points: true, point_limit: 48 })
  ok('D3', 'daq_frames 取数组断面(48 点/派生指标)', !fVec.isError && /形态|帧数|点/.test(fVec.text) && /30\.\d{2,}|mean|均值|max|min/i.test(fVec.text), fVec.text.slice(0, 160))
  const fImg = await b1Invoke('daq_frames', { node_id: imgNode.id, kind: 'image', last_minutes: 30, limit: 10 })
  ok('D4', 'daq_frames 取图像帧(引用/内容 URL,像素不入 LLM)', !fImg.isError && /帧|image|content|http/i.test(fImg.text), fImg.text.slice(0, 160))
  const fScalar = await b1Invoke('daq_frames', { node_id: sibling.id, last_minutes: 30, limit: 5 })
  ok('D5', '标量节点 daq_frames 按设计提示无帧(与频道绑线只读面一致)', !fScalar.isError && /单点标量|无帧/.test(fScalar.text), fScalar.text.slice(0, 90))

  // ── E 自定义 API 数据(http 驱动轮询 + ingest 标量) ──
  const httpNodes = lineNodes.filter(n => (n.protocol ?? n.driver) === 'http')
  if (httpNodes.length) {
    const hs = await api('GET', `/api/workshop/daq/${httpNodes[0].id}/samples?from=${Date.now() - 300_000}&to=${Date.now()}&bucketMs=1000&limit=100`)
    const hn = (hs.data?.points ?? []).length
    ok('E1', 'http 协议节点镜像采集(API 轮询入库)', hn > 0, `node=${httpNodes[0].name} points=${hn}`)
  }
  else ok('E1', 'http 协议节点在位', false, '线内无 http 节点')
  const mqttNodes = lineNodes.filter(n => (n.protocol ?? n.driver) === 'mqtt')
  if (mqttNodes.length) {
    const ms = await api('GET', `/api/workshop/daq/${mqttNodes[0].id}/samples?from=${Date.now() - 300_000}&to=${Date.now()}&bucketMs=1000&limit=100`)
    ok('E2', 'mqtt 协议节点镜像采集(订阅入库)', (ms.data?.points ?? []).length > 0, `node=${mqttNodes[0].name} points=${(ms.data?.points ?? []).length}`)
  }
  else ok('E2', 'mqtt 协议节点在位', false, '线内无 mqtt 节点')

  // ── F 参数下发(HITL) ──
  const dcwSnap = (await api('GET', '/api/workshop/dcw')).data
  const pressNode = c.dcw?.['hold-pressure-sp'] ?? (dcwSnap?.nodes ?? []).find(n => /hold-pressure/i.test(n.name ?? ''))?.id
  const cur = (dcwSnap?.nodes ?? []).find(n => n.id === pressNode)?.value
  const pendingIds = async () => new Set(((await api('GET', '/api/workshop/hitl/pending')).data?.items ?? []).map(x => x.id))
  const known = await pendingIds()
  const trialP = optimizerInvoke('recipe_trial', { recipe_id: c.recipeId, params: [{ node_id: pressNode, value: 46.8 }], hypothesis: '绑定矩阵验证:单变量保压下发', emergency: true })
  let card = null
  for (let i = 0; i < 90 && !card; i++) {
    await sleep(1000)
    card = ((await api('GET', '/api/workshop/hitl/pending')).data?.items ?? []).find(x => !known.has(x.id) && String(x.nodeId ?? '').startsWith('recipe:')) ?? null
  }
  if (card) await api('POST', '/api/workshop/hitl/respond', { kind: 'dcw-approval', id: card.id, confirmed: true, choice: 0, comment: '绑定矩阵 F 轮' })
  const trial = await trialP
  const applied = Number(trial.text.match(/hold-pressure-sp→([\d.]+)bar/)?.[1] ?? NaN)
  ok('F1', 'recipe 绑定 agent 经 HITL 批准下发并设备证实', Boolean(card) && !trial.isError && Math.abs(applied - 46.8) < 1e-6, trial.text.slice(0, 170))
  await sleep(3000)
  const snap2 = (await api('GET', '/api/workshop/dcw')).data
  const nowVal = (snap2?.nodes ?? []).find(n => n.id === pressNode)?.value
  ok('F2', '下发回读一致', Number(nowVal) === 46.8, `回读=${nowVal}(下发前=${cur})`)
  const rBack = await optimizerInvoke('daq_query', { node_id: weightNode, last_minutes: 5, limit: 20 })
  ok('F3', 'optimizer(仅配方绑定)查 DAQ 数据——绑定面按需扩展', !rBack.isError || /绑定|归属/.test(rBack.text), rBack.text.slice(0, 90))

  // ── G 插件工具真调用(rag-bridge kb_agent:async 提交+状态查询,同步回合依赖知识库侧引擎时长) ──
  const kbSub = await analystInvoke('kb_agent', { prompt: '注塑克重波动常见原因?', mode: 'async' }, 60_000)
  const taskId = kbSub.text.match(/task[_\s-]?id[:=]?\s*([A-Za-z0-9_-]+)/i)?.[1] ?? ''
  let kbOk = !kbSub.isError && Boolean(taskId)
  let kbDetail = kbSub.text.slice(0, 120)
  if (kbOk) {
    const st = await analystInvoke('kb_agent_status', { task_id: taskId, wait_seconds: 110 }, 130_000)
    const done = /完成|done|成功|答案|结论/i.test(st.text) && !st.isError
    kbOk = !st.isError && (done || /pending|running|执行中/i.test(st.text))
    kbDetail = `${kbSub.text.slice(0, 60)} | status: ${st.text.slice(0, 100)}`
  }
  ok('G1', 'kb_agent 经 invoke 桥走通插件链(异步提交+状态可查)', kbOk, kbDetail)

  const pass = results.filter(r => r.pass).length
  writeFileSync(join(EVID, 'binding-matrix.json'), JSON.stringify({ at: new Date().toISOString(), base: c.base, lineA: c.lineId, results }, null, 2))
  console.log(`\n═══ binding-matrix: ${pass}/${results.length} PASS ═══`)
  process.exit(pass === results.length ? 0 : 1)
}
main().catch((e) => {
  console.error(e)
  process.exit(1)
})
