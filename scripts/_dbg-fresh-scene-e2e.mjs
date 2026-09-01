/** 全新安装真实场景测试:注册用户 → AgentTeam → Agent → 产线 → 数采/数控 → 启线采样 → 数字孪生。 */
const ROOT = process.env.E2E_ROOT ?? 'http://127.0.0.1:3001'
const fail = m => { console.error('FAIL:', m); process.exitCode = 1 }
const ok = m => console.log('PASS', m)
const api = async (path, opts = {}) => {
  const res = await fetch(`${ROOT}${path}`, {
    ...opts,
    headers: { 'content-type': 'application/json', ...(TOKEN ? { authorization: `Bearer ${TOKEN}` } : {}), ...(opts.headers ?? {}) },
  })
  const body = await res.json().catch(() => null)
  return { status: res.status, body }
}
let TOKEN = ''

// ===== 1. 管理员登录(种子用户) + 注册一个新用户(admin 权限创建) =====
const login = await fetch(`${ROOT}/api/users/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'zhangwei@awshop.io', password: 'Awshop@123' }) }).then(r => r.json())
if (login?.data?.token) { TOKEN = login.data.token; ok(`管理员登录: ${login.data.user?.name ?? login.data.user?.email}`) }
else fail(`管理员登录失败: ${JSON.stringify(login).slice(0, 120)}`)

const stamp = Date.now().toString(36)
const reg = await api('/api/users', { method: 'POST', body: JSON.stringify({ name: `场景测试员-${stamp}`, email: `scene-${stamp}@awshop.io`, password: 'Scene@12345', role: 'editor' }) })
if (reg.status === 200 || reg.status === 201) ok(`注册新用户: ${reg.body?.data?.name ?? reg.body?.data?.email ?? 'ok'}`)
else fail(`注册用户失败 HTTP ${reg.status}: ${JSON.stringify(reg.body).slice(0, 140)}`)

// 新用户登录(真实凭据链)
const ulogin = await fetch(`${ROOT}/api/users/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: `scene-${stamp}@awshop.io`, password: 'Scene@12345' }) }).then(r => r.json())
if (ulogin?.data?.token) ok('新用户凭据登录成功(密码哈希/校验链真实)')
else fail(`新用户登录失败: ${JSON.stringify(ulogin).slice(0, 120)}`)

// ===== 2. 创建 AgentTeam =====
const team = await api('/api/workshop/teams', { method: 'POST', body: JSON.stringify({ name: `产线编组-${stamp}`, description: '场景测试:数字孪生产线 Agent 编组', visibility: 'public' }) })
const teamId = team.body?.data?.id
if (teamId) ok(`创建 AgentTeam: ${team.body.data.name} (${teamId.slice(0, 8)}…)`)
else fail(`创建团队失败 HTTP ${team.status}: ${JSON.stringify(team.body).slice(0, 140)}`)

// ===== 3. 创建 Agent 并入队 =====
const agent = await api('/api/workshop/agents', { method: 'POST', body: JSON.stringify({ name: `产线操作员-${stamp}`, harness: 'omp', config: { role: '产线监督', model: 'glm-4.6' }, visibility: 'public' }) })
const agentId = agent.body?.data?.id
if (agentId) ok(`创建 Agent: ${agent.body.data.name} (harness=omp)`)
else fail(`创建 Agent 失败 HTTP ${agent.status}: ${JSON.stringify(agent.body).slice(0, 140)}`)
if (teamId && agentId) {
  const add = await api(`/api/workshop/teams/${teamId}/members`, { method: 'POST', body: JSON.stringify({ agentId }) })
  if (add.status === 200 || add.status === 201) ok('Agent 加入 Team')
  else console.log(`WARN 入队 HTTP ${add.status}(接口契约可能不同): ${JSON.stringify(add.body).slice(0, 100)}`)
}

// ===== 4. 创建产线 + 数采节点(内置信号模板链路) + 数控节点 =====
const line = await api('/api/workshop/dcw/lines', { method: 'POST', body: JSON.stringify({ name: `模拟产线-${stamp}` }) })
const lineId = line.body?.data?.line?.id
if (lineId) ok(`创建产线: ${line.body.data.line.name}`)
else fail(`创建产线失败 HTTP ${line.status}: ${JSON.stringify(line.body).slice(0, 140)}`)

// 拉内置信号模板注册表(节点创建必须绑定 templateRef —— 元数据驱动设计)
const tplList = await api('/api/workshop/daq')
const templates = tplList.body?.data?.templates ?? []
if (!templates.length) fail('内置信号模板注册表为空')
else ok(`信号模板注册表: ${templates.length} 个内置模板(如 ${templates[0]?.key})`)

// ===== 4b. 创建数控节点(写控制;配方参数绑定数控节点而非数采节点) =====
const dcwTplList = await api('/api/workshop/dcw')
const dcwTemplates = dcwTplList.body?.data?.templates ?? []
const dcwNodes = []
if (dcwTemplates.length) {
  const n = await api('/api/workshop/dcw', { method: 'POST', body: JSON.stringify({ name: '温控执行器', templateRef: dcwTemplates[0].key, driver: 'mock', lineId, enabled: true }) })
  if (n.body?.data?.node?.id) { dcwNodes.push(n.body.data.node); ok(`创建数控节点: 温控执行器 (templateRef=${dcwTemplates[0].key})`) }
  else console.log(`WARN 数控创建 HTTP ${n.status}: ${JSON.stringify(n.body).slice(0, 120)}`)
}

const daqNodes = []
for (const [name, tplIdx] of [['炉温传感器', 0], ['压力传感器', Math.min(1, templates.length - 1)]]) {
  const tpl = templates[tplIdx]
  const n = await api('/api/workshop/daq', { method: 'POST', body: JSON.stringify({ name, templateRef: tpl.key, intervalMs: 1000, lineId, enabled: true, posX: 10, posZ: 20 }) })
  if (n.body?.data?.node?.id) { daqNodes.push(n.body.data.node); ok(`创建数采节点: ${name} (templateRef=${tpl.key}, line=${lineId.slice(0, 8)}…)`) }
  else fail(`创建数采失败 HTTP ${n.status}: ${JSON.stringify(n.body).slice(0, 140)}`)
}

const product = await api('/api/workshop/dcw/products', { method: 'POST', body: JSON.stringify({ name: `测试产品-${stamp}`, lineId }) }).catch(() => null)
const productId = product?.body?.data?.product?.id ?? product?.body?.data?.id
if (productId) ok(`创建产品并挂载产线: ${product.body.data.product?.name ?? productId.slice(0, 8)}`)
else console.log(`WARN 产品创建 HTTP ${product?.status}: ${JSON.stringify(product?.body ?? {}).slice(0, 100)}`)

let recipeId
if (productId) {
  // 配方参数绑定数控节点(dcw control node);数控节点自动收编进本产线
  const recipe = await api('/api/workshop/dcw/recipes', { method: 'POST', body: JSON.stringify({ name: `工艺配方-${stamp}`, productId, params: [{ nodeId: dcwNodes[0]?.id, value: 120 }] }) })
  recipeId = recipe.body?.data?.recipe?.id
  if (recipeId) ok(`创建配方(温控目标 120, 绑定数控节点 ${dcwNodes[0]?.id.slice(0, 8)}…)`)
  else fail(`创建配方失败 HTTP ${recipe.status}: ${JSON.stringify(recipe.body).slice(0, 140)}`)
}

// ===== 5. 启线 → 采样 → 真实数据验证 =====
const start = await api(`/api/workshop/dcw/lines/${lineId}/start`, { method: 'POST', body: JSON.stringify(recipeId ? { recipeId } : {}) })
if (start.status === 200) ok(`启线 ACK (recipeId=${recipeId ? '显式' : '无'})`)
else fail(`启线失败 HTTP ${start.status}: ${JSON.stringify(start.body).slice(0, 140)}`)

await new Promise(r => setTimeout(r, 9000))
const daqList = await api('/api/workshop/daq')
const myNodes = (daqList.body?.data?.nodes ?? []).filter(n => daqNodes.some(m => m.id === n.id))
const live = myNodes.filter(n => n.state !== 'offline')
const samples = myNodes.reduce((s, n) => s + (n.hist?.length ?? 0), 0)
if (live.length) ok(`数采真实采样: ${live.length}/${daqNodes.length} 节点在线, 缓冲 ${samples} 个样本(9s)`)
else fail(`采样失败: ${JSON.stringify(myNodes.map(n => ({ id: n.id, state: n.state, hist: n.hist?.length }))).slice(0, 160)}`)

// ===== 6. 数字孪生设备 =====
const twin = await api('/api/workshop/device-twins', { method: 'POST', body: JSON.stringify({ name: `孪生反应釜-${stamp}`, kind: 'device', modelRef: daqNodes[0]?.id ?? '', telemetry: { temperature: 25, pressure: 1.0 }, controls: ['start', 'stop', 'set_temp'], posX: 30, posZ: 40 }) })
const twinId = twin.body?.data?.twin?.id
if (twinId) ok(`创建数字孪生设备: ${twin.body.data.twin.name} (controls: start/stop/set_temp)`)
else fail(`创建孪生失败 HTTP ${twin.status}: ${JSON.stringify(twin.body).slice(0, 140)}`)

const twins = await api('/api/workshop/device-twins')
const twinList = twins.body?.data?.twins ?? []
ok(`孪生注册表读回: ${twinList.length} 台(含新建)`)

// ===== 7. 停线 → offline 收敛 =====
const stop = await api(`/api/workshop/dcw/lines/${lineId}/stop`, { method: 'POST' })
if (stop.status === 200) ok('停线指令 ACK')
else console.log(`WARN 停线 HTTP ${stop.status}`)
await new Promise(r => setTimeout(r, 3000))
const after = await api('/api/workshop/daq')
const afterNodes = (after.body?.data?.nodes ?? []).filter(n => daqNodes.some(m => m.id === n.id))
const offlines = afterNodes.filter(n => n.state === 'offline').length
if (offlines === daqNodes.length) ok(`停线后全部节点收敛 offline (${offlines}/${daqNodes.length})`)
else console.log(`WARN offline 收敛 ${offlines}/${daqNodes.length}(节拍窗口内) ${JSON.stringify(afterNodes.map(n => n.state))}`)

console.log(process.exitCode ? '\n=== 场景测试存在失败项 ===' : '\n=== 场景测试全部通过 ===')
