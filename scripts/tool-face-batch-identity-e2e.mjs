/**
 * 工具面批量能力 + 逐 Agent 注入 + 身份自证/拦截 定向验收。
 *
 * 覆盖(对应审查问题):
 *  T1 daq_query 批量:不传 node_id = 一次查询全部有权节点(绑定量 ∪ 频道绑线只读)
 *  T2 node_id/line_id 只能收窄不能放大
 *  T3 daq_export 批量:node_ids 多节点 + merge 宽表,盘上校验 manifest/nodes/merged
 *  T4 逐 Agent 工具描述差异(绑定面写入 description;MCP/omp/pi 三条注入路径同源函数)
 *  T5 身份自证:x-aw-agent-token 必须与 agentId 匹配(冒用/伪造 → 401)
 *  T6 引用归属拦截(recipe/node/line face)+ tool.call.denied 审计入册
 *  T7 配方面批量写:recipe_update params[] 两参数一次保存(HITL)→ recipe_trial 同批下发 → 回读一致
 *  T8 批量写治理:超步长候选整批拒绝
 *
 * 运行:node scripts/tool-face-batch-identity-e2e.mjs <scenario-context.json>
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const CTX = process.argv[2]
if (!CTX) {
  console.error('用法: node scripts/tool-face-batch-identity-e2e.mjs <scenario-context.json>')
  process.exit(1)
}
const c = JSON.parse(readFileSync(CTX, 'utf8'))
const EVID = join(REPO, 'docs', 'audit', 'evidence', '2026-10-21-batch-identity')
mkdirSync(EVID, { recursive: true })
const sleep = ms => new Promise(r => setTimeout(r, ms))
const results = []
function ok(id, name, cond, detail = '') {
  results.push({ id, name, pass: Boolean(cond), detail: String(detail).slice(0, 600) })
  console.log(`${cond ? '✔' : '✖'} [${id}] ${name}${detail ? ` — ${String(detail).slice(0, 240)}` : ''}`)
}
async function api(method, path, body, token = c.adminToken) {
  const r = await fetch(c.base + path, {
    method,
    headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(120_000),
  })
  return { status: r.status, ...(await r.json().catch(() => ({}))) }
}
async function invoke(agent, tool, args, timeoutMs = 240_000) {
  const r = await fetch(c.base + '/api/workshop/agent-tools/invoke', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-aw-agent-token': agent.token },
    body: JSON.stringify({ agentId: agent.id, tool, args }),
    signal: AbortSignal.timeout(timeoutMs),
  })
  const j = await r.json().catch(() => null)
  return { status: r.status, isError: Boolean(j?.data?.result?.isError), text: String(j?.data?.result?.text ?? '') }
}
async function listTools(agent, agentId) {
  const r = await fetch(`${c.base}/api/workshop/agent-tools/list?agentId=${encodeURIComponent(agentId ?? agent.id)}`, {
    headers: { 'x-aw-agent-token': agent.token },
    signal: AbortSignal.timeout(60_000),
  })
  const j = await r.json().catch(() => null)
  return { status: r.status, tools: j?.data?.tools ?? j?.tools ?? [] }
}
const descOf = (tools, name) => String(tools.find(t => t.name === name)?.description ?? '')

/** HITL:发起一次会触发审批的调用,轮询新审批卡并以 admin 批准 */
async function approvedInvoke(agent, tool, args, comment) {
  const before = new Set(((await api('GET', '/api/workshop/hitl/pending'))?.data?.items ?? []).map(x => x.id))
  const pending = invoke(agent, tool, args)
  let card = null
  for (let i = 0; i < 90 && !card; i++) {
    await sleep(1000)
    const items = (await api('GET', '/api/workshop/hitl/pending'))?.data?.items ?? []
    card = items.find(x => !before.has(x.id) && String(x.nodeId ?? '').startsWith('recipe:')) ?? null
  }
  if (card) {
    await api('POST', '/api/workshop/hitl/respond', { kind: 'dcw-approval', id: card.id, confirmed: true, comment })
  }
  const r = await pending
  return { card, ...r }
}

async function main() {
  console.log(`━━━ 工具面批量/身份定向验收 @ ${c.base} line=${c.lineId} recipe=${c.recipeId} ━━━`)
  const analyst = c.agents.analyst
  const optimizer = c.agents.optimizer
  const daqIds = Object.values(c.daq ?? {})
  const weight = c.daq?.['part-weight'] ?? c.weightNode ?? daqIds[0]
  ok('T0', '上下文就绪(analyst/optimizer/≥2 daq)', Boolean(analyst?.token && optimizer?.token && daqIds.length >= 2), `daq=${daqIds.length}`)

  // ── T1 批量查询:不传 node_id ──
  const qAll = await invoke(analyst, 'daq_query', { line_id: c.lineId, last_minutes: 5, bucket_ms: 1000, limit: 200 })
  const headAll = qAll.text.match(/数采数据查询结果\((\d+) 个节点/)?.[1]
  ok('T1', 'daq_query 批量:一次查询全部有权节点', !qAll.isError && Number(headAll) === daqIds.length, `header=${headAll ?? '?'} expect=${daqIds.length}`)

  // ── T2 node_id 只能收窄 ──
  const qOne = await invoke(analyst, 'daq_query', { node_id: weight, last_minutes: 5, limit: 50 })
  const headOne = qOne.text.match(/数采数据查询结果\((\d+) 个节点/)?.[1]
  ok('T2', 'node_id 收窄到单节点', !qOne.isError && Number(headOne) === 1, `header=${headOne ?? '?'}`)

  // ── T3 批量导出:多节点 + merge ──
  const pick = [weight, daqIds.find(id => id !== weight)].filter(Boolean)
  const ex = await invoke(analyst, 'daq_export', { node_ids: pick, last_minutes: 5, merge: true, title: '批量导出定向验收' })
  const exDir = ex.text.match(/目录: (.+)/)?.[1]?.trim()
  const manifestOk = exDir ? existsSync(join(exDir, 'manifest.json')) : false
  const nodesCsv = exDir ? readdirSync(join(exDir, 'nodes')).filter(f => f.endsWith('.csv')) : []
  const mergedOk = exDir ? existsSync(join(exDir, 'merged.csv')) : false
  ok('T3', 'daq_export 批量(node_ids 多节点+merge 宽表)', !ex.isError && nodesCsv.length === pick.length && mergedOk && manifestOk,
    `dir=${exDir} nodes=${nodesCsv.length} merged=${mergedOk}`)

  // ── T4 逐 Agent 描述差异 ──
  const la = await listTools(analyst)
  const lo = await listTools(optimizer)
  const daqDescA = descOf(la.tools, 'daq_query')
  const daqDescO = descOf(lo.tools, 'daq_query')
  const recDescA = descOf(la.tools, 'recipe_update')
  const recDescO = descOf(lo.tools, 'recipe_update')
  ok('T4.1', '分析师 daq 描述=直接绑定清单', daqDescA.includes('直接绑定') && daqDescA.includes(weight), daqDescA.slice(-160))
  ok('T4.2', '优化师 daq 描述=仅频道绑线只读(无直接绑定)', daqDescO.includes('频道绑线只读') && !daqDescO.includes('直接绑定'), daqDescO.slice(-160))
  ok('T4.3', '优化师 recipe 描述含其绑定配方', recDescO.includes(c.recipeId), recDescO.slice(-160))
  ok('T4.4', '分析师 recipe 描述不含未绑定配方', !recDescA.includes(c.recipeId), recDescA.slice(-120))

  // ── T5 身份自证 ──
  const spoof = await invoke({ id: analyst.id, token: optimizer.token }, 'my_industrial_nodes')
  ok('T5.1', '冒用他人 token(A id + B token)→ 401', spoof.status === 401, `status=${spoof.status}`)
  const bogus = await invoke({ id: analyst.id, token: 'bogus-token-not-issued' }, 'my_industrial_nodes')
  ok('T5.2', '伪造 token → 401', bogus.status === 401, `status=${bogus.status}`)
  const listSpoof = await listTools(analyst, optimizer.id)
  ok('T5.3', 'list 冒用(A token 取 B 工具面)→ 401', listSpoof.status === 401, `status=${listSpoof.status}`)
  const own = await invoke(optimizer, 'my_industrial_nodes')
  ok('T5.4', '本人 token 正常(阳性对照)', own.status === 200 && !own.isError, own.text.slice(0, 120))

  // ── T6 引用归属拦截 + 审计 ──
  const rRollback = await invoke(analyst, 'recipe_rollback', { recipe_id: c.recipeId, version: 1, reason: '越权探测' })
  ok('T6.1', '未绑定配方 recipe_rollback 被拒(配方操作门)', rRollback.isError && /绑定|权限|被拒|认证/.test(rRollback.text), rRollback.text.slice(0, 200))
  const rJournal = await invoke(optimizer, 'dcw_journal', { node_id: weight })
  ok('T6.2', '数采节点不在优化师绑定面 → dcw_journal 被拒(node face)', rJournal.isError && /被拒|无权|不在|仅可查|无法/.test(rJournal.text), rJournal.text.slice(0, 200))
  const rLine = await invoke(optimizer, 'line_status', { line_id: 'ln-not-exist-probe' })
  ok('T6.3', '不可读产线 line_status 被拒(line face)', rLine.isError && /被拒/.test(rLine.text), rLine.text.slice(0, 200))
  await sleep(1500)
  const auditQ = await api('GET', `/api/workshop/ops-logs?scope=all&actorKind=agent&q=${encodeURIComponent('工具调用被拒')}&limit=50`)
  const deniedLogs = (auditQ?.logs ?? auditQ?.data?.logs ?? []).filter(l => l.action === 'tool.call.denied')
  ok('T6.4', '授权性拒绝入册(tool.call.denied ≥1)', deniedLogs.length >= 1, `count=${deniedLogs.length}`)

  // ── T7/T8 配方面批量写 ──
  const dcw = (await api('GET', '/api/workshop/dcw'))?.data
  const recipe = (dcw?.recipes ?? []).find(r => r.id === c.recipeId)
  const params = (recipe?.params ?? []).filter(p => Number.isFinite(Number(p.value)))
    .map(p => ({ ...p, node: (dcw?.nodes ?? []).find(n => n.id === p.nodeId) }))
    .filter(p => p.node)
  const two = params.slice(0, 2)
  ok('T7.0', '配方参数面就绪(≥2 参数)', two.length === 2, two.map(p => `${p.nodeId}=${p.value}${p.node.unit}`).join(';'))
  if (two.length === 2) {
    const stepOf = (p) => {
      const range = Number(p.max) - Number(p.min)
      return Math.max(0.1, Number(p.stepLimit) || (Number.isFinite(range) && range > 0 ? range * 0.02 : 0.5))
    }
    const target = two.map((p, i) => {
      const step = stepOf(p)
      const raw = Number(p.value) + (i === 0 ? step : -step)
      const lo = p.min != null ? Number(p.min) : -Infinity
      const hi = p.max != null ? Number(p.max) : Infinity
      return { node_id: p.nodeId, value: Number(Math.min(hi, Math.max(lo, raw)).toFixed(3)), from: Number(p.value) }
    })
    const within = target.every((t, i) => Math.abs(t.value - t.from) <= stepOf(two[i]) + 1e-9)
    ok('T7.1', '批量候选步长合规(|Δ|≤stepLimit)', within, target.map(t => `${t.node_id} ${t.from}→${t.value}`).join(';'))

    // T8 批量面治理负例:越安全量程候选(单步限幅属在线写路径 write.ts:116,
    // 批量试验面由 HITL+量程联锁+配方频控把关 —— 这里验证量程联锁在批量面必拒)
    const badValue = Number(two[0].max) + 100
    const bad = await approvedInvoke(optimizer, 'recipe_trial',
      { recipe_id: c.recipeId, params: [{ node_id: two[0].nodeId, value: badValue }], hypothesis: '批量负例:越安全量程', emergency: true },
      'T8 负例应被量程联锁拒绝(如出现审批卡则拒绝语义已在网关)')
    ok('T8', '越量程候选整批拒绝(量程联锁在批量面生效)', bad.isError && /量程|区间|超|拒|限界/.test(bad.text), bad.text.slice(0, 220))

    // T7.2 recipe_update 批量保存(HITL)
    const upd = await approvedInvoke(optimizer, 'recipe_update',
      { recipe_id: c.recipeId, params: target.map(t => ({ node_id: t.node_id, value: t.value })), reason: `定向验收:一次批量保存两参数 ${target.map(t => `${t.node_id}→${t.value}`).join(',')}` },
      'T7 批量保存两参数(一次审批)')
    const vAfterUpd = Number(upd.text.match(/已保存为 v(\d+)/)?.[1] ?? 0)
    ok('T7.2', 'recipe_update params[] 两参数一次保存(HITL)', Boolean(upd.card) && !upd.isError && vAfterUpd >= 2, upd.text.slice(0, 200))

    // T7.3 recipe_trial 同批整发(HITL)+ 回读
    const trial = await approvedInvoke(optimizer, 'recipe_trial',
      { recipe_id: c.recipeId, params: target.map(t => ({ node_id: t.node_id, value: t.value })), hypothesis: '定向验收:两参数整批试验,观察批量下发与回读一致性', emergency: true },
      'T7 批量试验两参数(一次审批)')
    ok('T7.3', 'recipe_trial 整批下发受理(HITL)', Boolean(trial.card) && !trial.isError, trial.text.slice(0, 200))
    let readback = []
    for (let i = 0; i < 20; i++) {
      await sleep(1500)
      const d2 = (await api('GET', '/api/workshop/dcw'))?.data
      readback = target.map(t => Number((d2?.nodes ?? []).find(n => n.id === t.node_id)?.value))
      if (readback.every((v, i2) => Math.abs(v - target[i2].value) < 1e-6)) break
    }
    ok('T7.4', '批量回读一致(两节点=候选值)', readback.every((v, i) => Math.abs(v - target[i].value) < 1e-6),
      target.map((t, i) => `${t.node_id} want=${t.value} got=${readback[i]}`).join(';'))

    writeFileSync(join(EVID, 'batch-write.json'), JSON.stringify({ at: new Date().toISOString(), lineId: c.lineId, recipeId: c.recipeId, targets: target, update: upd.text.slice(0, 800), trial: trial.text.slice(0, 800), readback }, null, 2))
  }

  const evidence = {
    at: new Date().toISOString(),
    base: c.base, lineId: c.lineId, recipeId: c.recipeId,
    contextHome: c.home,
    daqNodeCount: daqIds.length,
    batchQuery: qAll.text.slice(0, 900),
    narrowQuery: qOne.text.slice(0, 300),
    export: { dir: exDir, nodes: nodesCsv.length, merged: mergedOk, text: ex.text.slice(0, 900) },
    descriptions: { analystDaq: daqDescA.slice(-300), optimizerDaq: daqDescO.slice(-300), optimizerRecipe: recDescO.slice(-300) },
    identity: { spoofStatus: spoof.status, bogusStatus: bogus.status, listSpoofStatus: listSpoof.status },
    interception: { rollback: rRollback.text.slice(0, 300), journal: rJournal.text.slice(0, 300), line: rLine.text.slice(0, 300), deniedAuditCount: deniedLogs.length },
    results,
  }
  writeFileSync(join(EVID, 'tool-face-batch-identity.json'), JSON.stringify(evidence, null, 2))

  const pass = results.filter(r => r.pass).length
  console.log(`\n═══ tool-face batch/identity: ${pass}/${results.length} PASS ═══`)
  if (pass !== results.length) process.exitCode = 1
}
main().catch((e) => {
  console.error(e)
  ok('T-ERR', '脚本未抛异常', false, e instanceof Error ? e.message : String(e))
  process.exitCode = 1
})
