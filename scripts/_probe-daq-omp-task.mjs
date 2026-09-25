/**
 * 临时:omp 实测 daq_query 的配方作用域(简单、单回合)
 *  A) 直调工具桥(不经 LLM,零 token):同参数两次查询 —— 不带 recipe 过滤 vs 带当前活动配方
 *  B) 真实 omp 单回合任务:让 agent 自己调 daq_query 并回报
 * 用法:AW_BASE=http://127.0.0.1:3300 AW_LINE=ln-f1b1c060 node scripts/_probe-daq-omp-task.mjs
 */
const BASE = process.env.AW_BASE ?? 'http://127.0.0.1:3300'
const LINE = process.env.AW_LINE ?? 'ln-f1b1c060'

const j = async (method, path, body, token) => {
  const r = await fetch(BASE + path, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  return { status: r.status, ...(await r.json().catch(() => ({}))) }
}
const sleep = ms => new Promise(r => setTimeout(r, ms))
const token = (await j('POST', '/api/users/login', { email: 'admin@awshop.local', password: 'admin123' })).data?.token

// ── 确保产线在跑(有活动批次 = 数采才落库且逐样本打标)──
const dcw0 = (await j('GET', '/api/workshop/dcw', undefined, token)).data
let line = dcw0.lines.find(l => l.id === LINE)
const mineRecipes = dcw0.recipes.filter(r => r.lineId === LINE)
const curRecipe = line?.activeRecipeId ?? mineRecipes[mineRecipes.length - 1]?.id
if (!line?.activeRunId) {
  const st = await j('POST', `/api/workshop/dcw/lines/${LINE}/start`, { recipeId: curRecipe }, token)
  console.log(`开跑: status=${st.status} ${st.code ?? ''} ${st.message ?? 'ok'}`)
  await sleep(6000)
}
const dcw = (await j('GET', '/api/workshop/dcw', undefined, token)).data
line = dcw.lines.find(l => l.id === LINE)
const activeRun = line?.activeRunId ?? null
const activeRecipe = line?.activeRecipeId ?? curRecipe
console.log(`产线 ${line.name}\n活动批次 run=${activeRun} recipe=${activeRecipe}`)

// ── DAQ 节点(注意:必须取数采节点,不是数控节点)──
const daq = (await j('GET', '/api/workshop/daq', undefined, token)).data
const all = daq.nodes.filter(n => n.lineId === LINE)
const picked = (all.filter(n => /melt-temp|part-weight|mold-temp/i.test(n.name)).slice(0, 3).length
  ? all.filter(n => /melt-temp|part-weight|mold-temp/i.test(n.name)).slice(0, 3)
  : all.slice(0, 3)).map(n => ({ id: n.id, name: n.name }))
console.log(`选用数采节点:${picked.map(p => `${p.name}(${p.id})`).join(' / ')}`)

// ── 频道 + omp agent + DAQ 绑定 ──
const ch = await j('POST', '/api/workshop/channels', { name: `DAQ配方作用域探针-${Date.now().toString(36).slice(-4)}`, leadAgent: { name: 'probe-lead', harness: 'mock', config: { delayMs: 50 } } }, token)
const channelId = ch.data.channelId
const tpl = await j('POST', '/api/workshop/agents', { name: `probe-daq-agent-${Date.now().toString(36).slice(-4)}`, harness: 'omp', config: {} }, token)
const member = await j('POST', `/api/workshop/channels/${channelId}/agents`, { agentId: tpl.data.id, role: 'worker' }, token)
const agentId = member.data.id
for (const p of picked) {
  const b = await j('POST', '/api/workshop/agent-tools/bindings', { agentId, nodeId: p.id, kind: 'daq', mode: 'auto' }, token)
  if (b.code !== 0) console.log(`绑定失败 ${p.name}: ${b.message}`)
}
console.log(`频道=${channelId} agent=${agentId} 绑定=${picked.length}`)

const invoke = async (tool, args) => {
  const r = await j('POST', '/api/workshop/agent-tools/invoke', { agentId, tool, args }, token)
  return r.data?.result?.text ?? JSON.stringify(r).slice(0, 300)
}

const fromMs = Date.now() - 6 * 60_000
const toMs = Date.now()
const common = { node_id: picked[0].id, from_ms: fromMs, to_ms: toMs, bucket_ms: 30_000, limit: 50 }

console.log('\n════ A1 直调:不带 recipe 过滤(窗口内全部样本)════')
console.log((await invoke('daq_query', { ...common })).slice(0, 1500))

console.log('\n════ A2 直调:带 recipe_id=当前活动配方 ════')
console.log((await invoke('daq_query', { ...common, recipe_id: activeRecipe })).slice(0, 1500))

console.log('\n════ A3 直调:对照配方(非当前运行的配方)════')
const otherRecipe = mineRecipes.find(r => r.id !== activeRecipe)?.id
console.log(otherRecipe ? (await invoke('daq_query', { ...common, recipe_id: otherRecipe })).slice(0, 800) : '(无其他配方可对照)')

console.log('\n════ B 真实 omp 任务(单回合,短指令)════')
const desc = [
  `只做一件事:调用 daq_query 两次,然后各报一行结论。`,
  `第 1 次:{"node_id":"${picked[0].id}","last_minutes":5,"bucket_ms":30000} —— 不带 recipe 过滤。`,
  `第 2 次:同样参数再加 "recipe_id":"${activeRecipe}" —— 只取当前运行配方的样本。`,
  `然后 complete_task,交付物只用中文写三行:①不带过滤的样本数/均值;②带 recipe 过滤的样本数/均值;③一句话说明差异原因(样本逐条按当轮配方打标)。不要做其他动作,不要额外查询。`,
].join('\n')
const task = await j('POST', `/api/workshop/channels/${channelId}/tasks`, { title: '[mock:complex] DAQ 配方作用域核对', description: desc, assigneeId: agentId }, token)
const taskId = task.data?.id
console.log(`任务=${taskId}`)
if (!taskId) {
  console.log('任务创建失败:', JSON.stringify(task).slice(0, 300))
  process.exit(1)
}
for (let i = 0; i < 100; i++) {
  await sleep(4000)
  const ts = (await j('GET', `/api/workshop/channels/${channelId}/tasks`, undefined, token)).data ?? []
  const t = ts.find(x => x.id === taskId)
  if (t && ['COMPLETED', 'FAILED', 'CANCELED'].includes(t.state)) {
    console.log(`终态=${t.state}`)
    const arts = (t.artifacts ?? []).map(a => (a.parts ?? []).map(p => p.text ?? '').join('\n')).join('\n---\n')
    console.log('交付物:\n' + arts.slice(0, 1500))
    break
  }
}
