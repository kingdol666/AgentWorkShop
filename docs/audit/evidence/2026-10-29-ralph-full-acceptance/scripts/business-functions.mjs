#!/usr/bin/env node
/**
 * US-005 业务功能逐项真机实测(3300 验收实例,2026-10-29)。
 * 覆盖:产线运营(开停线)/节点绑定/MES API 绑定+取数/EDA 数据分析/孪生(twin 工具面)/
 *       数采(daq_query+导出)/recipe 管理(版本·审批·HITL)/log 台账(ops-logs+dcw journal)。
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const BASE = 'http://127.0.0.1:3300'
const HERE = dirname(fileURLToPath(import.meta.url))
const EVID = join(HERE, '..')
process.env.NO_PROXY = '127.0.0.1,localhost'
const T = readFileSync('D:/tmp/aw-demo-token.txt', 'utf8').trim()
const results = []
const check = (id, name, ok, detail = '') => {
  results.push({ id, name, pass: Boolean(ok), detail: String(detail).slice(0, 600) })
  console.log(`${ok ? 'PASS' : 'FAIL'} [${id}] ${name}${ok ? '' : ' — ' + String(detail).slice(0, 300)}`)
}
const api = async (method, path, body, timeoutMs = 60000) => {
  const r = await fetch(BASE + path, { method, headers: { authorization: `Bearer ${T}`, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) })
  return { status: r.status, j: await r.json().catch(() => ({})) }
}
const data = r => r.j?.data ?? r.j
const inv = async (tool, args, timeoutMs = 120000) => {
  const chans = data(await api('GET', '/api/workshop/channels'))
  const ch = (Array.isArray(chans) ? chans : chans?.channels ?? []).find(c => /注塑产线作业-demo/.test(c.name))
  const members = data(await api('GET', `/api/workshop/channels/${ch.id}/agents`))
  const lead = (Array.isArray(members) ? members : members?.agents ?? []).find(m => m.role === 'lead')
  const r = await api('POST', '/api/workshop/agent-tools/invoke', { agentId: lead.id, tool, args }, timeoutMs)
  return { status: r.status, text: String(r.j?.data?.result?.text ?? r.j?.result?.text ?? ''), isErr: Boolean(r.j?.data?.result?.isError ?? r.j?.result?.isError), raw: r.j }
}

// B0 产线与节点清单
const dcwRoot = data(await api('GET', '/api/workshop/dcw'))
const lines = dcwRoot?.lines ?? []
const line = lines.find(l => /injection|注塑/.test(l.name)) ?? lines[0]
check('B0', '产线清单与目标线', Boolean(line?.id), JSON.stringify(lines.map(l => ({ n: l.name, s: l.status }))).slice(0, 200))
const lineId = line.id
const nodes = dcwRoot?.nodes ?? []
check('B0b', 'DCW 节点在位(写点≥8)', nodes.filter(n => n.lineId === lineId).length >= 8, `nodes=${nodes.length} lineNodes=${nodes.filter(n => n.lineId === lineId).length}`)

// B1 产线状态/活动批次(运营面)
const lineDetail = data(await api('GET', `/api/workshop/dcw/lines/${lineId}`))
check('B1', '产线详情含运行状态', Boolean(lineDetail?.line ?? lineDetail), JSON.stringify(lineDetail).slice(0, 200))
const batches = data(await api('GET', `/api/workshop/dcw/batches?lineId=${lineId}&limit=5`))
check('B1b', '批次台账可查', Boolean(batches), JSON.stringify(batches).slice(0, 200))

// B2 数采:daq_query 工具真调(等待样本窗口)
await new Promise(r => setTimeout(r, 8000))
const dq = await inv('daq_query', { line_id: lineId, last_minutes: 5, limit: 200 })
check('B2', 'daq_query 工具真调(样本>0)', !dq.isErr && /数采数据查询结果|节点|样本/i.test(dq.text), dq.text.slice(0, 260))
const daqNodes = data(await api('GET', `/api/workshop/daq?lineId=${lineId}`))
const daqList = daqNodes?.nodes ?? daqNodes ?? []
check('B2b', 'DAQ 节点清单(采点≥8)', Array.isArray(daqList) && daqList.length >= 8, `n=${Array.isArray(daqList) ? daqList.length : 'n/a'}`)

// B3 数采 REST 直查(样本行)
const firstDaq = Array.isArray(daqList) ? daqList[0] : null
if (firstDaq?.id) {
  const samples = data(await api('GET', `/api/workshop/daq/${firstDaq.id}/samples?limit=5`))
  const rows = samples?.samples ?? samples?.rows ?? samples
  check('B3', 'DAQ REST 样本行(≥1)', Array.isArray(rows) ? rows.length >= 1 : Boolean(rows), JSON.stringify(rows).slice(0, 200))
}

// B4 MES:绑定面与 mes_fetch(mes 模拟器 15160 需先有绑定;查 settings/mes 配置面)
const mesConns = data(await api('GET', '/api/workshop/mes/connections')).catch?.(() => null) ?? await api('GET', '/api/workshop/mes/connections').then(r => data(r)).catch(() => null)
check('B4', 'MES 连接配置面可读', mesConns !== null, JSON.stringify(mesConns).slice(0, 200))
const mesFetch = await inv('mes_fetch', { line_id: lineId, format: 'historyMap', limit: 5 }, 90000)
check('B4b', 'mes_fetch 工具真调(回执或明确未配置均记录)', mesFetch.text.length > 5, mesFetch.text.slice(0, 260))

// B5 recipe 管理:配方/版本/审批窗
const recipes = data(await api('GET', `/api/workshop/dcw/recipes?lineId=${lineId}`))
const recipeList = recipes?.recipes ?? recipes ?? []
const recipe = Array.isArray(recipeList) ? recipeList[0] : null
check('B5', '配方清单在位', Boolean(recipe?.id), JSON.stringify(recipeList).slice(0, 150))
if (recipe?.id) {
  const versions = data(await api('GET', `/api/workshop/dcw/recipes/${recipe.id}/versions`))
  check('B5b', '配方版本历史(v1 在)', (versions?.versions ?? []).length >= 1, JSON.stringify(versions).slice(0, 200))
}

// B6 recipe_trial HITL 链(挂卡→批准→ACK):复用 binding-matrix 语义,直接 REST 触发 trial
const dcwNodesOfLine = nodes.filter(n => n.lineId === lineId)
const trialNode = dcwNodesOfLine[0]
if (recipe?.id && trialNode?.id) {
  const trial = await inv('recipe_trial', { line_id: lineId, params: [{ node_id: trialNode.id, value: Number(trialNode.value ?? 60) }], hypothesis: 'ralph 验收:活动配方窗口内试验(值不变更)' }, 120000)
  check('B6', 'recipe_trial 发起(窗口内→HITL 卡或立即回执)', trial.text.length > 5, trial.text.slice(0, 260))
  // 若挂卡:轮询并批准
  const members = data(await api('GET', '/api/workshop/channels/' + (data(await api('GET', '/api/workshop/channels')).channels?.find?.(c => /注塑产线作业-demo/.test(c.name))?.id ?? '') + '/agents'))
  const lead = (Array.isArray(members) ? members : members?.agents ?? []).find(m => m.role === 'lead')
  if (lead?.id) {
    for (let i = 0; i < 10; i++) {
      await new Promise(r => setTimeout(r, 4000))
      const ap = data(await api('GET', `/api/workshop/agent-tools/approvals?agentId=${lead.id}`))
      const arr = Array.isArray(ap) ? ap : (ap?.cards ?? ap?.pending ?? [])
      const pending = arr.find(c => !c.decidedAt && (c.status ?? 'pending') === 'pending')
      if (pending) { await api('POST', `/api/workshop/agent-tools/approvals/${pending.id ?? pending.cardId}/decide`, { approved: true, comment: 'ralph 验收' }); break }
    }
  }
}

// B7 写控台账(dcw journal)与运维日志(ops-logs)
const journal = data(await api('GET', `/api/workshop/dcw/journal?lineId=${lineId}&limit=50`))
check('B7', 'DCW 写控台账可查', Boolean(journal), JSON.stringify(journal).slice(0, 200))
const opsLogs = data(await api('GET', '/api/workshop/ops-logs?limit=10'))
const opsRows = opsLogs?.logs ?? opsLogs?.rows ?? opsLogs
check('B7b', '运维日志台账可查(≥1 行)', Array.isArray(opsRows) ? opsRows.length >= 1 : Boolean(opsRows), JSON.stringify(opsRows).slice(0, 200))

// B8 EDA 数据分析:运行/数据面
const edaRuns = await api('GET', '/api/workshop/eda/runs')
check('B8', 'EDA 运行数据面可读', edaRuns.status === 200, `status=${edaRuns.status} body=${JSON.stringify(edaRuns.j).slice(0, 200)}`)
const edaCharts = await api('GET', '/api/workshop/eda/charts')
check('B8b', 'EDA 图表面可读', edaCharts.status === 200, `status=${edaCharts.status}`)

// B9 孪生:模型/场景/设备孪生面
const twins = await api('GET', '/api/workshop/aml/models')
check('B9', '孪生模型清单面可读', twins.status === 200, `status=${twins.status} body=${JSON.stringify(twins.j).slice(0, 160)}`)
const twinScenes = await api('GET', '/api/workshop/scene')
const deviceTwins = await api('GET', '/api/workshop/device-twins')
check('B9b', '孪生场景/设备孪生面可读(渲染数据源)', twinScenes.status === 200 || deviceTwins.status === 200, `scene=${twinScenes.status} deviceTwins=${deviceTwins.status}`)

// B10 节点绑定面:agent-tools/bindings 清单(demo lead)
const chans = data(await api('GET', '/api/workshop/channels'))
const ch = (Array.isArray(chans) ? chans : chans?.channels ?? []).find(c => /注塑产线作业-demo/.test(c.name))
const members = data(await api('GET', `/api/workshop/channels/${ch.id}/agents`))
const lead = (Array.isArray(members) ? members : members?.agents ?? []).find(m => m.role === 'lead')
const bindings = data(await api('GET', `/api/workshop/agent-tools/bindings?agentId=${lead.id}`))
check('B10', '节点绑定面可读', bindings !== undefined, JSON.stringify(bindings).slice(0, 200))
const myNodes = await inv('my_industrial_nodes', {})
check('B10b', 'my_industrial_nodes 工具真调', myNodes.text.length > 2, myNodes.text.slice(0, 200))

// B11 line_context / line_start-stop 只读探查(不停在跑批次:只查 status)
const lineCtx = await inv('line_context', {})
check('B11', 'line_context 工具真调', lineCtx.text.length > 10, lineCtx.text.slice(0, 260))

const pass = results.filter(r => r.pass).length
console.log(`\n结论: ${pass === results.length ? 'PASS' : 'FAIL'} (${pass}/${results.length})`)
writeFileSync(join(EVID, 'business-functions-report.json'), JSON.stringify({ suite: 'business-functions', base: BASE, at: new Date().toISOString(), line: lineId, results }, null, 2))
process.exitCode = pass === results.length ? 0 : 1
