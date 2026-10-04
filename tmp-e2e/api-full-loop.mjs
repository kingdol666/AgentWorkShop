// ============================================================
// API 全表面循环测试(正向 + 负向;零系统代码改动,只读为主,测试数据自清理)
// 覆盖:auth/users/channels/tasks/messages/agents/dcw/daq/agent-tools/
//       hitl/ops/audit/permissions(隔离负向)/memories/plugins/teams/notifications
// ============================================================
const B = 'http://localhost:3001'
let pass = 0, fail = 0
const ok = (name, cond, detail = '') => {
  console.log(`${cond ? '✅' : '❌'} ${name}${detail ? ' — ' + detail : ''}`)
  cond ? pass++ : fail++
}
const j = async r => r.json()
const api = async (m, u, body, tok, raw = false) => {
  const r = await fetch(B + u, { method: m, headers: { 'content-type': 'application/json', ...(tok ? { authorization: `Bearer ${tok}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) })
  return raw ? r : j(r)
}

// ---------- ① 认证 ----------
const loginBad = await api('POST', '/api/users/login', { email: 'visual@awshop.local', password: 'wrong-pass' })
ok('auth:错误密码被拒', loginBad.code !== 0 && loginBad.code === 'UNAUTHORIZED', `code=${loginBad.code}`)
const ADM = (await api('POST', '/api/users/login', { email: 'visual@awshop.local', password: 'Visual2026' })).data?.token
ok('auth:admin 登录', !!ADM)
const me = await api('GET', '/api/users/me', undefined, ADM)
ok('auth:/me 身份', (me.data?.user?.role ?? me.data?.role) === 'admin', `role=${me.data?.user?.role ?? me.data?.role}`)
const noAuth = await api('GET', '/api/workshop/channels')
ok('auth:无 token 拒绝', noAuth.code !== 0, `code=${noAuth.code}`)

// ---------- ② 用户管理 + 建人 ----------
const users = await api('GET', '/api/users', undefined, ADM)
const uCount = users.data?.items?.length ?? users.data?.length ?? 0
ok('users:列表', uCount > 5, `count=${uCount}`)
const suffix = Date.now().toString(36)
const created = await api('POST', '/api/users', { name: 'loop-' + suffix, email: `loop-${suffix}@t.local`, password: 'Loop@12345', role: 'user' }, ADM)
const newUserId = created.data?.user?.id ?? created.data?.id
ok('users:建测试用户', !!newUserId, created.message ?? '')
const newTok = (await api('POST', '/api/users/login', { email: `loop-${suffix}@t.local`, password: 'Loop@12345' })).data?.token
ok('users:新用户可登录', !!newTok)

// ---------- ③ 权限隔离(负向) ----------
const chListAdmin = await api('GET', '/api/workshop/channels', undefined, ADM)
const chAll = chListAdmin.data?.items ?? chListAdmin.data ?? []
ok('channels:admin 全量可见', chAll.length > 10, `count=${chAll.length}`)
const chListNew = await api('GET', '/api/workshop/channels', undefined, newTok)
const chNew = chListNew.data?.items ?? chListNew.data ?? []
ok('permissions:无 grant 用户看不到绑线频道', chNew.filter(c => c.lineId).length === 0, `visible=${chNew.length},绑线=${chNew.filter(c => c.lineId).length}`)
const usersForbidden = await api('GET', '/api/users', undefined, newTok)
ok('permissions:普通用户禁用户管理', usersForbidden.code !== 0, `code=${usersForbidden.code}`)
const forbiddenCreate = await api('POST', '/api/workshop/dcw', { name: 'x', driver: 'modbus-tcp' }, newTok)
ok('permissions:普通用户禁建写控节点', forbiddenCreate.code !== 0, `code=${forbiddenCreate.code}`)

// ---------- ④ Channel 生命周期 ----------
const chC = await api('POST', '/api/workshop/channels', { name: 'API循环测试-' + suffix, description: '全表面测试', leadAgent: { name: 'loop-lead', harness: 'mock' } }, ADM)
const chId = chC.data?.channelId
ok('channels:创建', !!chId, chC.message ?? '')
const chGet = await api('GET', `/api/workshop/channels/${chId}`, undefined, ADM)
ok('channels:读取', chGet.data?.name === 'API循环测试-' + suffix)
const chP = await api('PATCH', `/api/workshop/channels/${chId}`, { description: '全表面测试-已更新' }, ADM)
ok('channels:更新', chP.code === 0 || !!chP.data, chP.message ?? '')
const msgP = await api('POST', `/api/workshop/channels/${chId}/messages`, { toAgentId: (chGet.data?.leadAgentId ?? chGet.data?.channel?.leadAgentId) ?? undefined, text: '全表面测试消息(系统投递)', fromLabel: 'tester' }, ADM)
ok('messages:发送(或无 lead 频道的明确指引)', msgP.code === 0 || String(msgP.message ?? '').includes('lead'), msgP.code === 0 ? 'ok' : String(msgP.message ?? '').slice(0, 40))
const ev = await api('GET', `/api/workshop/channels/${chId}/events?limit=5`, undefined, ADM)
const evArr = ev.data?.items ?? ev.data ?? []
ok('events:事件流端点(空频道允许为空)', Array.isArray(evArr), `count=${evArr.length}`)

// ---------- ⑤ 任务面(判重回归) ----------
const taskBody = { title: 'API循环·判重探针', description: '用于判重验证,不执行实质作业。' }
const tA = await api('POST', `/api/workshop/channels/${chId}/tasks`, taskBody, ADM)
const tB = await api('POST', `/api/workshop/channels/${chId}/tasks`, taskBody, ADM)
ok('tasks:创建', !!tA.data?.id, tA.message ?? '')
const tAState = (await api('GET', `/api/workshop/channels/${chId}/tasks`, undefined, ADM)).data?.find?.(x => x.id === tA.data?.id)?.state
ok('tasks:判重或 mock 秒终后新建(均为正确语义)', tA.data?.id === tB.data?.id || (tAState && tAState !== 'SUBMITTED' && tAState !== 'ASSIGNED'), `same=${tA.data?.id === tB.data?.id},tA=${tAState}`)
const queue = await api('GET', `/api/workshop/channels/${chId}/queue`, undefined, ADM)
ok('queue:队列视图', queue.code === 0 || Array.isArray(queue.data))

// ---------- ⑥ DCW/产线面 ----------
const dcw = await api('GET', '/api/workshop/dcw', undefined, ADM)
ok('dcw:节点/配方/批次聚合', (dcw.data?.nodes ?? []).length > 5 && (dcw.data?.recipes ?? []).length > 5, `nodes=${dcw.data?.nodes?.length},recipes=${dcw.data?.recipes?.length}`)
const line1 = (dcw.data?.lineStates ?? []).find(s => s.lineId === 'ln-d7e0a2a2')
ok('dcw:线1运行中(T7 复启批次)', line1?.active === true, `run=${line1?.runId?.slice(0, 8)},tagged=${line1?.taggedSamples}`)
const conflict = await api('POST', `/api/workshop/dcw/lines/ln-d7e0a2a2/start`, { recipeId: 'rc-bbab24bc' }, ADM)
ok('dcw:重复开线被拒(运行门)', conflict.code === 'CONFLICT', String(conflict.message ?? '').slice(0, 50))
const hist = dcw.data?.history ?? []
ok('dcw:写历史留痕', hist.length > 10, `rows=${hist.length}`)
const runs = dcw.data?.runs ?? []
ok('dcw:批次台账', runs.length > 3, `rows=${runs.length}`)

// ---------- ⑦ DAQ 面 ----------
const daq = await api('GET', '/api/workshop/daq', undefined, ADM)
ok('daq:控制器在线', daq.data?.controller?.running === true && daq.data?.controller?.nodesOnline === 12)
const now = Date.now()
const samples = await api('GET', `/api/workshop/daq/dn-0183240d/samples?from=${now - 300000}&to=${now}&bucketMs=30000`, undefined, ADM)
const pts = samples.data?.points ?? []
ok('daq:真实时序样本', pts.length >= 5, `points=${pts.length},最新=${pts.length ? pts[pts.length - 1].avg.toFixed(2) : 'n/a'}℃`)
const alarms = await api('GET', '/api/workshop/daq/alarms?limit=5', undefined, ADM)
ok('daq:告警面', alarms.code === 0 || Array.isArray(alarms.data))
const infra = await api('GET', '/api/workshop/daq/infra', undefined, ADM)
ok('daq:基础设施(mqtt/tsdb/oss)', !!infra.data, JSON.stringify(infra.data).slice(0, 80))
const badNode = await api('GET', '/api/workshop/daq/dn-notexist/samples', undefined, ADM)
ok('daq:不存在节点报错', badNode.code !== 0 || badNode.error, JSON.stringify(badNode).slice(0, 60))

// ---------- ⑧ Agent 工具面(运行时守卫负向 + 正向) ----------
const WORKER = '80dc9b41-6ae3-4dce-a185-21537f0ad7c7'
const inv = async (tool, args, agentId = WORKER) => api('POST', '/api/workshop/agent-tools/invoke', { agentId, tool, args }, ADM)
const nodes = await inv('my_industrial_nodes', {})
ok('tools:my_industrial_nodes 正向', String(nodes.data?.result?.text ?? '').includes('dn-') || !nodes.data?.result?.isError, String(nodes.data?.result?.text ?? '').slice(0, 60))
const dcwDead = await inv('dcw_control', { node_id: 'dw-679bb3d2', value: 200 })
ok('tools:dcw_control 已禁用(v2 守卫)', String(dcwDead.data?.result?.text ?? '').includes('禁用') || dcwDead.data?.result?.isError === true)
const unknown = await inv('no_such_tool', {})
ok('tools:未知工具报错', unknown.code !== 0 || unknown.data?.result?.isError === true || String(unknown.message ?? '').length > 0)
const oplog = await inv('ops_log', { limit: 5 })
ok('tools:ops_log 运维记录可读', String(oplog.data?.result?.text ?? '').length > 50)
const bindings = await api('GET', '/api/workshop/agent-tools/bindings', undefined, ADM)
ok('tools:绑定清单', (bindings.data?.bindings ?? []).length > 10, `count=${bindings.data?.bindings?.length}`)

// ---------- ⑨ HITL / 运维 / 审计 ----------
const pend = await api('GET', '/api/workshop/hitl/pending', undefined, ADM)
ok('hitl:待办快照可用', pend.code === 0 && Array.isArray(pend.data?.items))
const ops = await api('GET', '/api/workshop/ops-logs?limit=10', undefined, ADM)
const opsArr = ops.data?.items ?? ops.data?.logs ?? ops.data ?? []
ok('ops:运维日志', Array.isArray(opsArr) && opsArr.length > 5, `count=${Array.isArray(opsArr) ? opsArr.length : 'shape:' + JSON.stringify(ops.data).slice(0, 40)}`)
const audit = await api('GET', '/api/workshop/audit?limit=5', undefined, ADM)
ok('audit:审计面', audit.code === 0 || !!audit.data)

// ---------- ⑩ 记忆 / 插件 / 团队 / 通知 ----------
const mem = await api('GET', '/api/workshop/channels/06e6880e-7f6a-4d86-9dd1-088944468b90/agents/80dc9b41-6ae3-4dce-a185-21537f0ad7c7/memories', undefined, ADM)
const memArr = mem.data?.items ?? mem.data?.memories ?? mem.data ?? []
ok('memory:频道记忆可读', Array.isArray(memArr) && memArr.length > 0, `count=${Array.isArray(memArr) ? memArr.length : 'shape:' + JSON.stringify(mem.data).slice(0, 60)}`)
const plugins = await api('GET', '/api/workshop/plugins', undefined, ADM)
const plList = plugins.data?.plugins ?? plugins.plugins ?? []
ok('plugins:插件目录', plList.length >= 3, `count=${plList.length},样例=${plList.slice(0, 3).map(p => p.name).join(',')}`)
const teams = await api('GET', '/api/workshop/teams', undefined, ADM)
ok('teams:团队面', teams.code === 0 || !!teams.data)
const notif = await api('GET', '/api/workshop/notifications?limit=3', undefined, ADM)
ok('notifications:通知面', notif.code === 0 || !!notif.data)
const memSearch = await api('POST', '/api/workshop/channels/06e6880e-7f6a-4d86-9dd1-088944468b90/agents/80dc9b41-6ae3-4dce-a185-21537f0ad7c7/memories/search', { query: '断流' }, ADM)
const msArr = memSearch.data?.items ?? memSearch.data?.results ?? memSearch.data ?? []
ok('memory:语义检索(断流)', Array.isArray(msArr) && msArr.length > 0, `hits=${Array.isArray(msArr) ? msArr.length : JSON.stringify(memSearch.data).slice(0, 60)}`)

// ---------- ⑪ 测试数据清理(删测试频道与用户;不触产线) ----------
const del = await api('DELETE', `/api/workshop/channels/${chId}`, undefined, ADM)
ok('cleanup:删测试频道', del.code === 0 || del.code === undefined, del.message ?? '')
const delU = await api('DELETE', `/api/users/${newUserId}`, undefined, ADM)
ok('cleanup:删测试用户', delU.code === 0 || !!delU.data || delU.message === undefined, delU.message ?? '')

console.log(`\n=== API 全表面循环测试: ${pass} pass / ${fail} fail ===`)
process.exit(fail ? 1 : 0)
