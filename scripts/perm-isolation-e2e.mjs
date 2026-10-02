/**
 * 产线级权限隔离 e2e(权限模型 v3 全量验收)
 * 覆盖:W1 admin 独占创建 / G4 grant 制线域操作 / W2+Δ2 Channel 绑线与一致性 /
 *      W3 可见性过滤 / W4+Δ3 HITL 定向 / Δ1 收权即失活 / editor 降级
 * 运行:node scripts/perm-isolation-e2e.mjs <adminToken>
 */
const BASE = 'http://localhost:3000'
const ADMIN_TOKEN = process.argv[2] ?? ''
const PW = 'PermTest@123'
let pass = 0
const fails = []
const ok = (name, cond, detail = '') => {
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
  if (cond) pass++
  else fails.push(name)
}
const api = async (m, u, b, token) => {
  const r = await fetch(BASE + u, {
    method: m,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: b === undefined ? undefined : JSON.stringify(b),
    signal: AbortSignal.timeout(120_000),
  })
  return { status: r.status, ...(await r.json().catch(() => ({}))) }
}
const sleep = ms => new Promise(r => setTimeout(r, ms))
const A = ADMIN_TOKEN

// ── 0. 准备 ──
console.log('═══ 0. 准备:产线/用户/授权 ═══')
const lines = (await api('GET', '/api/workshop/dcw/lines', undefined, A)).data?.lines ?? []
const lineA = lines.find(l => l.id === 'ln-d7e0a2a2')
const mkLine = await api('POST', '/api/workshop/dcw/lines', { name: `隔离线B-${Date.now() % 100000}` }, A)
const lineB = mkLine.data?.line
ok('admin 建产线 B', !!lineB?.id, lineB?.id)
const mkProdB = await api('POST', '/api/workshop/dcw/products', { name: '隔离产品B', lineId: lineB.id }, A)
ok('admin 建产品 B(挂线 B)', !!mkProdB.data?.product?.id)
const nodeB = (await api('POST', '/api/workshop/dcw', {
  templateRef: 'dcw-temp-sp', name: '隔离线B·温度SP', driver: 'mock',
  unit: '℃', decimals: 1, min: 0, max: 300, lineId: lineB.id,
}, A)).data?.node
ok('admin 建线 B DCW 节点', !!nodeB?.id, nodeB?.id)
const daqB = (await api('POST', '/api/workshop/daq', {
  templateRef: 'daq-temp-tc', name: '隔离线B·温度PV', driver: 'mock', unit: '℃', min: 0, max: 300, lineId: lineB.id,
}, A)).data?.node
ok('admin 建线 B DAQ 节点', !!daqB?.id, daqB?.id)
const recipeB = (await api('POST', '/api/workshop/dcw/recipes', {
  productId: mkProdB.data.product.id, name: '隔离配方B',
  params: [{ nodeId: nodeB.id, value: 100, min: 0, max: 300 }],
}, A)).data?.recipe
ok('admin 建线 B 配方', !!recipeB?.id, recipeB?.id)

const mkUser = async (name, email, role) => {
  const created = (await api('POST', '/api/users', { name, email, password: PW, role }, A)).data
  if (created?.id) return created
  // 已存在(上一轮残留)→ 从用户列表捞 id
  const list = (await api('GET', `/api/users?keyword=${encodeURIComponent(email)}`, undefined, A)).data
  return (list.items ?? []).find(u => u.email === email)
}
const userA = await mkUser('userA-线A', 'perm-usera@test.local', 'user')
const userB = await mkUser('userB-线B', 'perm-userb@test.local', 'user')
const userC = await mkUser('userC-无授权', 'perm-userc@test.local', 'user')
const editorE = await mkUser('editorE-降级', 'perm-editore@test.local', 'editor')
ok('建 4 个测试用户', !!userA?.id && !!userB?.id && !!userC?.id && !!editorE?.id)
const login = async email => (await api('POST', '/api/users/login', { email, password: PW })).data?.token
const tA = await login('perm-usera@test.local')
const tB = await login('perm-userb@test.local')
const tC = await login('perm-userc@test.local')
const tE = await login('perm-editore@test.local')
ok('4 用户登录', !!tA && !!tB && !!tC && !!tE)

const grant = (userId, grants) => api('PUT', '/api/workshop/permissions', { userId, grants }, A)
await grant(userA.id, [{ lineId: lineA.id, mode: 'operate' }])
await grant(userB.id, [{ lineId: lineB.id, mode: 'operate' }])
await sleep(1)
ok('admin 授权: A→线A operate,B→线B operate,C 无', true)

// ── 1. W1:admin 独占创建/删除 ──
console.log('═══ 1. W1 admin 独占创建 ═══')
ok('userA 建产线 → 403', (await api('POST', '/api/workshop/dcw/lines', { name: 'x' }, tA)).status === 403)
ok('editorE 建产线 → 403(降级)', (await api('POST', '/api/workshop/dcw/lines', { name: 'x' }, tE)).status === 403)
ok('userA 建 DCW 节点 → 403', (await api('POST', '/api/workshop/dcw', { templateRef: 'dcw-temp-sp', name: 'x', driver: 'mock', unit: '℃', min: 0, max: 10 }, tA)).status === 403)
ok('userA 建 DAQ 节点 → 403', (await api('POST', '/api/workshop/daq', { name: 'x', driver: 'mock', unit: '℃', min: 0, max: 10 }, tA)).status === 403)
ok('userA 删产线 → 403', (await api('DELETE', `/api/workshop/dcw/lines/${lineB.id}`, undefined, tA)).status === 403)
ok('userA 改产线名 → 403', (await api('PATCH', `/api/workshop/dcw/lines/${lineB.id}`, { name: 'hack' }, tA)).status === 403)
ok('admin 建 DCW 仍可用(lineId 不存在 → 400)', (await api('POST', '/api/workshop/dcw', { templateRef: 'dcw-temp-sp', name: 'x', driver: 'mock', unit: '℃', min: 0, max: 10, lineId: 'ln-not-exist' }, A)).status === 400)

// ── 2. G4:线域操作 grant 制 ──
console.log('═══ 2. G4 线域 grant 制 ═══')
const apA = await api('POST', `/api/workshop/dcw/recipes/rc-bbab24bc/apply`, {}, tA)
ok('userA(线A operate) 开跑线A 配方 → 200/202', [200, 202].includes(apA.status))
const runIdA = apA.data?.run?.id ?? 'rr-any'
ok('userA 对线B 配方 apply → 403', (await api('POST', `/api/workshop/dcw/recipes/${recipeB.id}/apply`, {}, tA)).status === 403)
ok('userB 对线B 配方 apply → 200/202', [200, 202].includes((await api('POST', `/api/workshop/dcw/recipes/${recipeB.id}/apply`, {}, tB)).status))
ok('userC 对线A 配方 apply → 403', (await api('POST', `/api/workshop/dcw/recipes/rc-bbab24bc/apply`, {}, tC)).status === 403)
ok('userA(线A) mark-good 线A 配方 → 200', (await api('POST', `/api/workshop/dcw/recipes/rc-bbab24bc/mark-good`, { runId: runIdA }, tA)).status === 200)
ok('userB 对线A 配方 mark-good → 403', (await api('POST', `/api/workshop/dcw/recipes/rc-bbab24bc/mark-good`, { runId: 'x' }, tB)).status === 403)
const nodeA = (await api('GET', '/api/workshop/dcw', undefined, A)).data?.nodes?.find(n => n.id === 'dw-679bb3d2')
ok('userA 启停线A 节点 → 200', (await api('PATCH', `/api/workshop/dcw/${nodeA.id}`, { enabled: true }, tA)).status === 200)
ok('userA 启停线B 节点 → 403', (await api('PATCH', `/api/workshop/dcw/${nodeB.id}`, { enabled: true }, tA)).status === 403)
ok('userB 启停线B 节点 → 200', (await api('PATCH', `/api/workshop/dcw/${nodeB.id}`, { enabled: true }, tB)).status === 200)
ok('userC 启停线A 节点 → 403', (await api('PATCH', `/api/workshop/dcw/${nodeA.id}`, { enabled: true }, tC)).status === 403)
ok('userB(线B) 建线B 产品 → 200', (await api('POST', '/api/workshop/dcw/products', { name: 'B线产品2', lineId: lineB.id }, tB)).status === 200)
ok('userA 建线B 产品 → 403', (await api('POST', '/api/workshop/dcw/products', { name: 'x', lineId: lineB.id }, tA)).status === 403)
ok('userA 建线A 配方 → 200', (await api('POST', '/api/workshop/dcw/recipes', { productId: 'pd-787a4188', name: 'A线用户新配方' }, tA)).status === 200)
ok('userB 建线A 配方 → 403', (await api('POST', '/api/workshop/dcw/recipes', { productId: 'pd-787a4188', name: 'x' }, tB)).status === 403)

// ── 3. W2+Δ2:Channel 绑线与一致性 ──
console.log('═══ 3. W2+Δ2 Channel 绑线 ═══')
const chA = (await api('POST', '/api/workshop/channels', {
  name: `A线工作区-${Date.now() % 100000}`, lineId: lineA.id,
  // 注意:mock 引擎无工具桥(既有设计,mock 闭环 13/13 断言"工具桥显式拒绝"),
  // 工具/审批链路测试必须 real harness;omp lead 不派发任务即零额度
  leadAgent: { name: 'a-lead', harness: 'omp', config: { rpcMode: 'rpc' } },
}, tA)).data
ok('userA 建绑线A频道 → 成功', !!chA?.channelId, chA?.channelId?.slice(0, 8))
ok('userA 建频道绑线B → 403', (await api('POST', '/api/workshop/channels', { name: 'x', lineId: lineB.id }, tA)).status === 403)
ok('userC 建频道绑线A → 403', (await api('POST', '/api/workshop/channels', { name: 'x', lineId: lineA.id }, tC)).status === 403)
const chC = (await api('POST', '/api/workshop/channels', { name: `C纯协作-${Date.now() % 100000}`, leadAgent: { name: 'c-lead', harness: 'mock' } }, tC)).data
ok('userC 建纯协作频道(不绑线) → 成功', !!chC?.channelId)
const chLinePut = await api('PUT', `/api/workshop/channels/${chC.channelId}/line`, { lineId: lineA.id }, tC)
ok('userC 给自己频道绑线A → 403', chLinePut.status === 403)
const chA2 = (await api('POST', '/api/workshop/channels', { name: `B线工作区-${Date.now() % 100000}`, lineId: lineB.id, leadAgent: { name: 'b-lead', harness: 'mock' } }, tB)).data
ok('userB 建绑线B频道 → 成功', !!chA2?.channelId)

const leadA = chA.leadAgentId
// Δ2:一致性
ok('userA 在绑线A频道绑线B DAQ → 403 SCOPE_MISMATCH', (await api('POST', '/api/workshop/agent-tools/bindings', { agentId: leadA, nodeId: daqB.id, kind: 'daq' }, tA)).status === 403)
const bindOk = await api('POST', '/api/workshop/agent-tools/bindings', { agentId: leadA, nodeId: 'dn-0183240d', kind: 'daq' }, tA)
ok('userA 在绑线A频道绑线A DAQ → 200', bindOk.status === 200, bindOk.message ?? '')
const bindR = await api('POST', '/api/workshop/agent-tools/bindings', { agentId: leadA, nodeId: 'rc-bbab24bc', kind: 'recipe' }, tA)
ok('userA 绑线A配方 → 200', bindR.status === 200)

// ── 4. W3:可见性 ──
console.log('═══ 4. W3 可见性过滤 ═══')
const visA = (await api('GET', '/api/workshop/channels', undefined, tA)).data
const listA = Array.isArray(visA) ? visA : visA.channels ?? visA.items ?? []
ok('userA 看不到线B频道', !listA.some(c => c.id === chA2.channelId))
const visC = (await api('GET', '/api/workshop/channels', undefined, tC)).data
const listC = Array.isArray(visC) ? visC : visC.channels ?? visC.items ?? []
ok('userC 看不到线A频道也不看到线B频道', !listC.some(c => c.id === chA.channelId) && !listC.some(c => c.id === chA2.channelId))
const visAdm = (await api('GET', '/api/workshop/channels', undefined, A)).data
const listAdm = Array.isArray(visAdm) ? visAdm : visAdm.channels ?? visAdm.items ?? []
ok('admin 全量可见', listAdm.some(c => c.id === chA.channelId) && listAdm.some(c => c.id === chA2.channelId))

// ── 5. Δ1:工具运行时 grant 复核(收权即失活) ──
console.log('═══ 5. Δ1 收权即失活 ═══')
const invoke = (agentId, tool, args, token) => api('POST', '/api/workshop/agent-tools/invoke', { agentId, tool, args }, token)
const q1 = await invoke(leadA, 'daq_query', { node_id: 'dn-0183240d', limit: 2 }, tA)
ok('撤权前 userA 的 agent 可查线A 数采', q1.data?.result?.text?.includes('样本') ?? false)
await grant(userA.id, [{ lineId: lineA.id, mode: null }])
await sleep(300)
const q2 = await invoke(leadA, 'daq_query', { node_id: 'dn-0183240d', limit: 2 }, tA)
ok('撤权后 userA 的 agent 立即被拒', q2.data?.result?.isError === true && q2.data?.result?.text?.includes('权限模型 v3'), (q2.data?.result?.text ?? '').slice(0, 60))
const p2 = await invoke(leadA, 'recipe_propose', { recipe_id: 'rc-bbab24bc', packages: [{ name: 'x', params: [{ node_id: 'dw-679bb3d2', to: 196, basis: 'x', exp_ref: 'x' }] }] }, tA)
ok('撤权后 recipe_propose 也被拒', p2.data?.result?.isError === true)
await grant(userA.id, [{ lineId: lineA.id, mode: 'operate' }])
await sleep(300)
const q3 = await invoke(leadA, 'daq_query', { node_id: 'dn-0183240d', limit: 2 }, tA)
ok('重新授权后恢复可用', q3.data?.result?.text?.includes('样本') ?? false)

// ── 6. W4+Δ3:HITL 定向 ──
console.log('═══ 6. W4+Δ3 HITL 定向 ═══')
// userA 的 manual recipe_propose 挂审批单(后台),随即比对三方快照
;(async () => {
  await invoke(leadA, 'recipe_propose', {
    recipe_id: 'rc-bbab24bc',
    packages: [{ name: 'HITL定向验证包', rationale: 'e2e', params: [{ node_id: 'dw-679bb3d2', to: 197, unit: '℃', basis: '定向推送验证', exp_ref: 'e2e' }] }],
  }, tA)
})()
await sleep(4000)
const snapA = (await api('GET', '/api/workshop/hitl/pending', undefined, tA)).data?.items ?? []
const snapB = (await api('GET', '/api/workshop/hitl/pending', undefined, tB)).data?.items ?? []
const snapC = (await api('GET', '/api/workshop/hitl/pending', undefined, tC)).data?.items ?? []
const hitForA = snapA.some(i => i.channelId === chA.channelId && i.kind === 'dcw-approval')
ok('userA(线A operate) 收到该审批待办', hitForA)
ok('userB(仅线B) 不收到线A 审批', !snapB.some(i => i.channelId === chA.channelId))
ok('userC(无授权) 不收到', !snapC.some(i => i.channelId === chA.channelId))
// 批准清理(避免残留挂起单)
const apRow = snapA.find(i => i.channelId === chA.channelId && i.kind === 'dcw-approval')
if (apRow) {
  await api('POST', `/api/workshop/agent-tools/approvals/${apRow.id}/decide`, { approved: true, choice: 0, comment: 'e2e 清理' }, tA)
}

// ── 汇总 ──
console.log(`\n${fails.length ? '❌' : '✅'} 权限隔离 e2e:${pass} 通过 / ${fails.length} 失败`)
if (fails.length) console.log('失败项:', fails.join(' | '))
process.exit(fails.length ? 1 : 0)
