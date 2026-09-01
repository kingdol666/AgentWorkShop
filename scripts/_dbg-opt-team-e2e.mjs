/**
 * M3 e2e:omp 团队活体 —— Agent 闭环控制策略(设定→复测→判定→回退)真实 LLM 全链。
 * 复用 1号产线 demo 资产;worker(auto 绑定)被要求:dcw_control(带 hypothesis)→
 * daq_query 复测 → dcw_judge 落判定 →(判 rollback 时)dcw_rollback 执行 → dcw_journal 复盘。
 * 硬断言:该节点出现 agentId=worker 的优化记录且 judge.by='agent'(判定真的由 LLM 落下)。
 * 用法:ADMIN_TOKEN=<token> node scripts/_dbg-opt-team-e2e.mjs [--monitor]
 */
const BASE = 'http://127.0.0.1:3000'
const MONITOR = process.argv.includes('--monitor')
const adminToken = process.env.ADMIN_TOKEN ?? ''
let H = { 'content-type': 'application/json' }
const sleep = ms => new Promise(r => setTimeout(r, ms))
const J = async (u, m = 'GET', b) => {
  const r = await fetch(BASE + u, { method: m, headers: H, body: b ? JSON.stringify(b) : undefined })
  return r.json()
}

// ---- 登录 ----
if (!adminToken) {
  const login = await fetch(`${BASE}/api/users/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'zhangwei@awshop.io', password: 'Awshop@123' }),
  }).then(r => r.json())
  H.authorization = `Bearer ${login.data.token}`
} else {
  H.authorization = `Bearer ${adminToken}`
}

const d = (await J('/api/workshop/dcw')).data
const line = d.lines.find(l => l.name === '1号产线')
const dwTemp = d.nodes.find(n => n.name === '温度设定器(示例)')
if (!line || !dwTemp) { console.error('FAIL 1号产线/温度设定器缺失'); process.exit(1) }
// 确保产线在跑(记录需要 recipeId 归属)
const st = d.lineStates?.find(s => s.lineId === line.id)
if (!st?.active) {
  const recipe = d.recipes.find(r => r.lineId === line.id)
  const s = await J(`/api/workshop/dcw/lines/${line.id}/start`, 'POST', { recipeId: recipe.id })
  console.log('lineStart:', s.code === 0 ? 'OK' : JSON.stringify(s).slice(0, 120))
}
console.log(`目标 → ${dwTemp.name}(当前 ${dwTemp.value}℃,窗口 176~188)`)

// ---- monitor 模式:只观察最近的记录与判定 ----
if (MONITOR) {
  const recs = (await J(`/api/workshop/dcw/optimizations?nodeId=${dwTemp.id}&limit=6`)).data.records
  for (const r of recs) {
    console.log(`[${r.status}] ${r.id} ${r.setAt.slice(11, 19)} ${r.params[0]?.from}→${r.params[0]?.to} judge=${r.judge ? `${r.judge.by}:${r.judge.verdict}` : '未判定'}${r.judge ? `(${r.judge.reason.slice(0, 46)})` : ''}`)
  }
  process.exit(0)
}

// ---- 1. Channel + 团队(worker=omp 真实 LLM,auto 绑定以便 Agent 全程自主) ----
const rand = Math.random().toString(36).slice(2, 6)
const ch = (await J('/api/workshop/channels', 'POST', { name: `闭环优化团队(${rand})`, description: '设定→判定→回退 闭环活体验证' })).data
const team = (await J('/api/workshop/teams', 'POST', { name: `闭环优化组(${rand})` })).data
await J(`/api/workshop/teams/${team.id}/members`, 'POST', { agentId: 'tpl-default-lead', role: 'lead' })
const workerTpl = (await J('/api/workshop/agents', 'POST', {
  name: `闭环调控工程师(${rand})`, harness: 'omp',
  config: {
    intro: '负责产线工艺参数的闭环优化:设定→复测→判定→必要回退',
    systemPromptPrefix: '你是产线闭环调控工程师,严格执行七步作业环:1) my_industrial_nodes 读节点;2) daq_query 观察工况;'
      + '3) 声明假设并用 dcw_control 小步下发(必带 hypothesis 参数);4) 等待 60 秒后 daq_query 复测;'
      + '5) 用 dcw_judge 对返回的优化记录 id 落判定(keep/rollback/uncertain,理由必须引用复测数值);'
      + '6) 若判 rollback,立即用 dcw_rollback(record_id) 执行回退并复测;'
      + '7) dcw_journal 查看在册记录,汇报记录 id 与判定结论。所有数值带单位。',
  },
})).data
await J(`/api/workshop/teams/${team.id}/members`, 'POST', { agentId: workerTpl.id, role: 'worker' })
const dep = await J(`/api/workshop/teams/${team.id}/deploy`, 'POST', { channelId: ch.channelId })
void dep
const chAgents = (await J(`/api/workshop/channels/${ch.channelId}/agents`)).data
const workerInst = chAgents.find(a => a.role === 'worker' && a.harness === 'omp')
if (!workerInst) { console.error('FAIL worker 实例缺失'); process.exit(1) }
console.log('worker 实例:', workerInst.id.slice(0, 8), '(omp)')

// ---- 2. 绑定:daq auto + dcw auto(Agent 全程自主;系统有越限兜底) ----
const daqAll = (await J('/api/workshop/daq')).data
const dqTemp = daqAll.nodes.find(n => n.name === '温度传感器 01' && n.lineId === line.id)
if (dqTemp) await J('/api/workshop/agent-tools/bindings', 'POST', { agentId: workerInst.id, nodeId: dqTemp.id, kind: 'daq', mode: 'auto' })
await J('/api/workshop/agent-tools/bindings', 'POST', { agentId: workerInst.id, nodeId: dwTemp.id, kind: 'dcw', mode: 'auto' })
console.log('绑定完成(daq auto + dcw auto)')

// ---- 3. 工具冒烟(闭环面) ----
const invoke = (tool, args) => J('/api/workshop/agent-tools/invoke', 'POST', { agentId: workerInst.id, tool, args }).then(r => r.data?.result)
const mine = await invoke('my_industrial_nodes', {})
console.log('[冒烟] my_industrial_nodes:', (mine?.text ?? '').slice(0, 80).replace(/\n/g, ' '))

// ---- 4. 派发闭环任务(直发 worker:assigneeId 指定成员,绕过 lead 调度不确定性) ----
const valueBefore = (await J('/api/workshop/dcw')).data.nodes.find(n => n.id === dwTemp.id).value
const goal = `闭环调控任务:烘箱温度当前设定 ${valueBefore}℃,工艺窗口 176~188℃。请严格执行七步作业环:daq_query 观察后,用 dcw_control 将设定调整到 178℃(hypothesis 写明假设);等待约 60 秒 daq_query 复测;然后必须用 dcw_judge 对优化记录落判定(引用复测数值;若复测显示温度向错误方向移动或越窗,判 rollback 并用 dcw_rollback 执行);最后 dcw_journal 确认记录在册。汇报:记录 id、判定结论、依据数值。`
const task = (await J(`/api/workshop/channels/${ch.channelId}/tasks`, 'POST', { title: `烘箱温度闭环调控(${rand})`, parts: [{ text: goal }], mode: 'loop', assigneeId: workerInst.id })).data
const taskId = task?.task?.id ?? task?.id
if (!taskId) { console.error('FAIL 任务派发失败:', JSON.stringify(task).slice(0, 150)); process.exit(1) }
console.log('任务已直发 worker:', taskId.slice(0, 10), `(${valueBefore} → 178,期望判定+必要回退)`)

// ---- 5. 轮询:任务工件 + 优化记录判定 ----
const deadline = Date.now() + 12 * 60_000
let done = false
let agentJudgeSeen = false
while (Date.now() < deadline) {
  await sleep(20_000)
  const env = await J(`/api/workshop/channels/${ch.channelId}/tasks`)
  const t = env.data ?? []
  const me = t.find(x => x.id === taskId)
  const status = me?.status ?? '?'
  const recs = (await J(`/api/workshop/dcw/optimizations?nodeId=${dwTemp.id}&limit=8`)).data.records
  const mine2 = recs.filter(r => r.agentId === workerInst.id)
  agentJudgeSeen = mine2.some(r => r.judge?.by === 'agent')
  console.log(`  [${new Date().toISOString().slice(11, 19)}] task=${status} | 优化记录 ${mine2.length} 条(判定 ${mine2.filter(r => r.judge).length})`)
  if (me && ['COMPLETED', 'FAILED', 'CANCELED'].includes(status)) {
    done = status === 'COMPLETED'
    const art = me.artifacts?.[0]?.parts?.map(p => p.text ?? '').join(' ') ?? ''
    console.log('  worker 结论片段:', art.slice(-400).replace(/\n+/g, ' | '))
    break
  }
}

// ---- 6. 硬断言:Agent 判定真的落下 ----
const recs = (await J(`/api/workshop/dcw/optimizations?nodeId=${dwTemp.id}&limit=10`)).data.records
const mineFinal = recs.filter(r => r.agentId === workerInst.id)
const judged = mineFinal.find(r => r.judge?.by === 'agent')
let pass = 0
let fail = 0
const ok = (cond, label) => { if (cond) { pass++; console.log(`PASS ${label}`) } else { fail++; console.log(`FAIL ${label}`) } }
ok(!!judged, `Agent 判定入册(judge.by=agent,verdict=${judged?.judge?.verdict ?? '-'})`)
ok(mineFinal.length > 0, `优化记录在册(${mineFinal.length} 条,含假设:${mineFinal[0]?.hypothesis?.slice(0, 30) ?? '-'})`)
if (judged?.verdict === 'rollback') {
  const rb = mineFinal.find(r => r.rollbackOf === judged.id)
  ok(!!rb, 'rollback 判定已被执行(回退记录在册)')
}
ok(done || agentJudgeSeen, `任务完成/判定达成(done=${done},agentJudge=${agentJudgeSeen})`)
console.log(`\n=== 结果:${pass} PASS / ${fail} FAIL ===`)
process.exit(fail > 0 ? 1 : 0)
