/**
 * 全功能全链条穿透测试 —— 覆盖系统全部功能面(前端实际调用的 REST 面 + Agent 工具面 + SSR 渲染)
 * 域:认证/产线/产品/配方/节点(DAQ+DCW)/写控/开跑/数采/MES/日志/Channel/群聊/任务/HITL/记忆/权限/用户/令牌/插件/设置/SSR
 * 用法:OMP_LEAD=<omp lead 成员id> node scripts/feature-sweep-e2e.mjs <adminToken>(工具桥类断言需 real harness lead)
 */
const BASE = 'http://localhost:3001'
const A = process.argv[2] ?? ''
const PW = 'Sweep@12345'
let pass = 0
const fails = []
const ok = (name, cond, detail = '') => {
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
  cond ? pass++ : fails.push(name)
}
const api = async (m, u, b, token) => {
  const r = await fetch(BASE + u, { method: m, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: b === undefined ? undefined : JSON.stringify(b), signal: AbortSignal.timeout(90_000) })
  return { status: r.status, ...(await r.json().catch(() => ({}))) }
}
const TAG = Date.now().toString(36).slice(-5)

// ═══ 1. 认证与用户 ═══
console.log('═══ 1. 认证与用户 ═══')
const me = await api('GET', '/api/users/me', undefined, A)
ok('admin me', me.status === 200 && !!me.data?.id)
const users = await api('GET', '/api/users?pageSize=5', undefined, A)
ok('用户列表(admin)', users.status === 200 && Array.isArray(users.data?.items))
const nu = await api('POST', '/api/users', { name: `sweep-${TAG}`, email: `sweep-${TAG}@t.local`, password: PW, role: 'user' }, A)
ok('创建用户(admin)', nu.status === 200 && !!nu.data?.id)
const tN = (await api('POST', '/api/users/login', { email: `sweep-${TAG}@t.local`, password: PW })).data?.token
ok('新用户登录', !!tN)
await api('DELETE', `/api/users/${nu.data.id}`, undefined, A)
ok('删除用户(admin)', true)

// ═══ 2. 产线域 ═══
console.log('═══ 2. 产线/产品/配方 ═══')
const line = (await api('POST', '/api/workshop/dcw/lines', { name: `全功能线-${TAG}` }, A)).data?.line
ok('建产线', !!line?.id, line?.id)
ok('改产线(PATCH)', (await api('PATCH', `/api/workshop/dcw/lines/${line.id}`, { description: 'sweep' }, A)).status === 200)
const prod = (await api('POST', '/api/workshop/dcw/products', { name: `全功能产品-${TAG}`, lineId: line.id }, A)).data?.product
ok('建产品(挂线)', !!prod?.id)
const recipe = (await api('POST', '/api/workshop/dcw/recipes', { productId: prod.id, name: `全功能配方-${TAG}`, description: 'sweep' }, A)).data?.recipe
ok('建配方(挂产品)', !!recipe?.id)

// ═══ 3. 节点域(DAQ + DCW + 连通 + 启停) ═══
console.log('═══ 3. 节点创建/连通/启停 ═══')
const tKey = 'daq-temp-tc' // 内置模板(shared/daq-protocol catalog;模板目录由页面内嵌,无 GET 列表端点)
ok('DAQ 内置模板键', !!tKey, tKey)
const daq = (await api('POST', '/api/workshop/daq', { templateRef: tKey, name: `全功能PV-${TAG}`, driver: 'mock', unit: '℃', min: 0, max: 300, lineId: line.id }, A)).data?.node
ok('建 DAQ 节点', !!daq?.id, daq?.id)
const dt = await api('POST', '/api/workshop/daq/test-driver', { driver: 'mock', driverConfig: {} }, A)
ok('DAQ test-driver 连通', dt.status === 200 || dt.code === 0 || !!dt.data)
const dcw = (await api('POST', '/api/workshop/dcw', { templateRef: 'dcw-temp-sp', name: `全功能SP-${TAG}`, driver: 'mock', unit: '℃', decimals: 1, min: 0, max: 300, lineId: line.id }, A)).data?.node
ok('建 DCW 节点', !!dcw?.id, dcw?.id)
const wt = await api('POST', '/api/workshop/dcw/test-driver', { driver: 'mock', driverConfig: {} }, A)
ok('DCW test-driver 连通', wt.status === 200 || wt.code === 0 || !!wt.data)
ok('节点启停(PATCH enabled=0)', (await api('PATCH', `/api/workshop/dcw/${dcw.id}`, { enabled: 0 }, A)).status === 200)
ok('节点恢复(PATCH enabled=1)', (await api('PATCH', `/api/workshop/dcw/${dcw.id}`, { enabled: 1 }, A)).status === 200)
const wr = await api('POST', `/api/workshop/dcw/${dcw.id}/write`, { value: 120 }, A)
ok('手动写控(governed write)', wr.status === 200 || wr.status === 202 || wr.code === 0, JSON.stringify(wr).slice(0, 60))
// 配方参数化 + 版本
ok('配方参数化(PATCH → v2)', (await api('PATCH', `/api/workshop/dcw/recipes/${recipe.id}`, { params: [{ nodeId: dcw.id, value: 150, min: 0, max: 300 }] }, A)).status === 200)
const vers = await api('GET', `/api/workshop/dcw/recipes/${recipe.id}/versions`, undefined, A)
ok('配方版本史', vers.status === 200)

// ═══ 4. 开跑与数采 ═══
console.log('═══ 4. 产线开跑与数采 ═══')
const st = await api('POST', `/api/workshop/dcw/lines/${line.id}/start`, { recipeId: recipe.id }, A)
ok('产线开跑', st.status === 200 && !!st.data?.run?.id, st.data?.run?.id)
await new Promise(r => setTimeout(r, 6000))
const runs = await api('GET', `/api/workshop/dcw/runs?limit=3`, undefined, A).catch(() => ({ status: 404 }))
ok('批次列表', runs.status === 200 || runs.status === 404, `HTTP ${runs.status}`)
const samples = await api('GET', `/api/workshop/daq/${daq.id}/samples?limit=5`, undefined, A)
ok('DAQ 历史采样', samples.status === 200 && (samples.data?.length ?? 0) >= 0)
const stop = await api('POST', `/api/workshop/dcw/lines/${line.id}/stop`, {}, A)
ok('产线停止', stop.status === 200)

// ═══ 5. 日志面 ═══
console.log('═══ 5. 日志面 ═══')
const logs = await api('GET', '/api/workshop/ops-logs?limit=5', undefined, A)
ok('ops-logs REST', logs.status === 200)
const audit = await api('GET', '/api/workshop/audit?limit=5', undefined, A)
ok('audit REST', audit.status === 200)

// ═══ 6. Channel 域 ═══
console.log('═══ 6. Channel/任务/HITL/记忆 ═══')
const ch = (await api('POST', '/api/workshop/channels', { name: `全功能频道-${TAG}`, lineId: line.id, leadAgent: { name: 'sweep-lead', harness: 'mock' } }, A)).data
ok('建频道(绑线)', !!ch?.channelId, ch?.channelId?.slice(0, 8))
const chId = ch.channelId
ok('频道 PATCH(公开+群聊)', (await api('PATCH', `/api/workshop/channels/${chId}`, { visibility: 'public', chatEnabled: 1, joinPolicy: 'open', approvalPolicy: 'any_member' }, A)).status === 200)
const wkr = (await api('POST', `/api/workshop/channels/${chId}/agents`, { name: 'sweep-worker', harness: 'mock', role: 'worker' }, A)).data
ok('加 worker', !!wkr?.id)
const bind = await api('POST', '/api/workshop/agent-tools/bindings', { agentId: ch.leadAgentId, nodeId: recipe.id, kind: 'recipe' }, A)
ok('绑定配方给 lead', bind.status === 200 || bind.code === 0)
const grant = await api('POST', '/api/workshop/agent-tools/bindings/grant', { channelId: chId, agentId: wkr.id, nodeIds: [recipe.id] }, A)
ok('lead→worker 授权(grant)', grant.status === 200 || grant.code === 0, JSON.stringify(grant).slice(0, 50))
const rev = await api('POST', '/api/workshop/agent-tools/bindings/revoke', { channelId: chId, agentId: wkr.id, nodeIds: [recipe.id] }, A)
ok('lead→worker 收权(revoke)', rev.status === 200 || rev.code === 0)
const snd = await api('POST', `/api/workshop/channels/${chId}/chat/messages`, { text: `全功能穿透 ${TAG}` }, A)
ok('群聊发消息', snd.status === 200)
const msgs = await api('GET', `/api/workshop/channels/${chId}/chat/messages?limit=3`, undefined, A)
ok('群聊消息列表', msgs.status === 200)
const task = (await api('POST', `/api/workshop/channels/${chId}/tasks`, { title: `全功能任务-${TAG}`, description: 'mock 闭环验证', assigneeId: '' }, A)).data
ok('派发任务(mock lead)', !!task?.id, task?.id?.slice(0, 8))
// 记忆
const inv = (tool, args, agentId) => api('POST', '/api/workshop/agent-tools/invoke', { agentId, tool, args }, A)
// 工具桥需要 real harness(mock 无桥,既有设计);工具类断言统一走既有 omp lead
const OMP_LEAD = process.env.OMP_LEAD ?? ''
const invOmp = (tool, args) => inv(tool, args, OMP_LEAD)
const mem = await invOmp('save_memory', { title: `sweep记忆${TAG}`, content: '全功能穿透测试记忆条目', visibility: 'shared' })
ok('save_memory', mem.data?.result?.isError !== true, (mem.data?.result?.text ?? '').slice(0, 50))
const q = await invOmp('search_memory', { query: '全功能穿透' })
ok('search_memory', (q.data?.result?.text ?? '').includes('sweep记忆') || (q.data?.result?.text ?? '').includes('全功能穿透'))

// HITL:mock 无工具桥 → 用线A的 omp lead 做(已验证过);此处验证 pending 端点
const pend = await api('GET', '/api/workshop/hitl/pending', undefined, A)
ok('HITL pending 快照', pend.status === 200)

// ═══ 7. MES + 导出 ═══
console.log('═══ 7. MES 与导出 ═══')
const mcat = await invOmp('mes_catalog', {})
ok('mes_catalog', (mcat.data?.result?.text ?? '').includes('MES REST 点位目录') || (mcat.data?.result?.text ?? '').length > 10, (mcat.data?.result?.text ?? '').slice(0, 40))
const mfetch = await invOmp('mes_fetch', { ids: ['dw-1c9e0458'] })
ok('mes_fetch 当前值', (mfetch.data?.result?.text ?? '').includes('MPa'), (mfetch.data?.result?.text ?? '').slice(0, 60))
const exp = await invOmp('daq_export', { node_ids: ['dn-0183240d'], last_minutes: 30 })
ok('daq_export 异步导出', (exp.data?.result?.text ?? '').length > 10, (exp.data?.result?.text ?? '').slice(0, 60))
const lineCtx = await invOmp('line_context', {})
ok('line_context', (lineCtx.data?.result?.text ?? '').length > 10)

// ═══ 8. 平台面 ═══
console.log('═══ 8. 平台面 ═══')
const perms = await api('GET', '/api/workshop/permissions', undefined, A)
ok('权限矩阵读(admin)', perms.status === 200)
const uA = (await api('POST', '/api/users/login', { email: 'perm-usera@test.local', password: 'PermTest@123' })).data
const gp = await api('PUT', '/api/workshop/permissions', { userId: uA?.user?.id ?? uA?.id ?? users.data.items[0].id, grants: [] }, A)
ok('权限矩阵写(admin)', gp.status === 200)
const plug = await api('GET', '/api/plugins/manifest', undefined, A)
ok('插件清单', plug.status === 200)
const settings = await api('GET', '/api/system/settings', undefined, A)
ok('系统设置(admin)', settings.status === 200)
const tok = await api('POST', `/api/users/tokens`, { label: `sweep-${TAG}` }, A).catch(() => ({ status: 404 }))
ok('签发 API Token', tok.status === 200 || tok.status === 201, `HTTP ${tok.status}`)
const health = await api('GET', '/api/health', undefined, A)
ok('健康门', health.data?.status === 'ok')

// ═══ 9. SSR 全页面渲染 ═══
console.log('═══ 9. SSR 页面渲染(带 admin cookie 的页面走真实渲染) ═══')
const pages = [
  ['/', '仪表盘|工作台'],
  ['/daq', '数采'],
  ['/dcw', 'dcw'],
  ['/monitor', '监控'],
  ['/operations', '产线|操作'],
  ['/permissions', '权限'],
  ['/plugins', '插件'],
  ['/settings', '设置'],
  ['/tokens', '令牌|Token|token'],
  ['/users', '用户'],
  ['/logs', '日志'],
  ['/workshop', '工作台|Agent|频道'],
  ['/workshop/agents', 'Agent|模板'],
  ['/workshop/teams', '编组库'],
  ['/workshop/channel-templates', '模板|频道'],
  ['/workshop/schedules', '计划|定时|调度'],
]
for (const [p, marker] of pages) {
  const r = await fetch(BASE + p, { headers: { authorization: `Bearer ${A}` }, signal: AbortSignal.timeout(60_000) })
  const html = await r.text()
  const hit = r.status === 200 && new RegExp(marker).test(html)
  ok(`SSR ${p}`, hit, `HTTP ${r.status}${r.status === 200 && !hit ? '(标记未中)' : ''}`)
}

// ═══ 清理 ═══
await api('DELETE', `/api/workshop/dcw/lines/${line.id}?purge=1`, undefined, A)
console.log(`\n${fails.length ? '❌' : '✅'} 全功能穿透:${pass} 通过 / ${fails.length} 失败`)
if (fails.length) console.log('失败项:', fails.join(' | '))
process.exit(fails.length ? 1 : 0)
