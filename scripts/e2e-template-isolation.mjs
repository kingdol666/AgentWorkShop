/**
 * 模板用户隔离 + 权限系统 端到端验证(v10)
 * ============================================================
 * 前置:dev server 运行于 BASE(默认 :3001);内置 admin 账号 zhangwei@awshop.io / Awshop@123。
 *
 * 验证矩阵:
 *  A. Agent 模板:私有不可见 → 公开可见可用(仅属主可改删)→ 回私;内置不可改删(user+admin)
 *  B. AgentTeam:同上 + 公开编组含私有成员时他人部署被拒
 *  C. Channel 模板:内置 2 个;从 channel 捕获(私有→公开);他人实例化+挂载;权限拒改删
 *  D. Channel 实例:scenarioPrompt/workspace 热更新
 *  E. 监控隔离:user 只见本人;admin 全量 + ownerName;用户管理接口 admin 门
 */
const BASE = process.env.BASE_URL ?? 'http://localhost:3001'
const ADMIN_EMAIL = 'zhangwei@awshop.io'
const ADMIN_PASSWORD = 'Awshop@123'

let pass = 0
let fail = 0
function check(name, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
  if (ok) {
    pass++
  }
  else {
    fail++
  }
}

const api = async (method, path, { body, token } = {}) => {
  const headers = { 'content-type': 'application/json' }
  if (token) headers.authorization = `Bearer ${token}`
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  })
  let json
  try {
    json = await res.json()
  }
  catch {
    json = { code: 'BAD_JSON', message: `HTTP ${res.status}` }
  }
  return { status: res.status, code: json.code, message: json.message, data: json.data }
}
const ok = r => r.status === 200 && r.code === 0
const failsWith = (r, code) => r.status >= 400 && r.code === code

async function main() {
  // ===== 0. 账号就绪 =====
  const stamp = Date.now().toString(36)
  const mkUser = async (name) => {
    const email = `${name}-${stamp}@tpl-e2e.test`
    const reg = await api('POST', '/api/users/register', { body: { name: `${name}-${stamp}`, email, password: 'Passw0rd!123' } })
    if (!ok(reg)) throw new Error(`注册 ${name} 失败: ${reg.message}`)
    return { email, token: reg.data.token, id: reg.data.user.id, name: reg.data.user.name }
  }
  const alice = await mkUser('alice')
  const bob = await mkUser('bob')
  const adminLogin = await api('POST', '/api/users/login', { body: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD } })
  if (!ok(adminLogin)) {
    throw new Error(`admin 登录失败(${ADMIN_EMAIL}): ${adminLogin.message};请确认 data/users.sqlite 已种子 admin 账号`)
  }
  const admin = { token: adminLogin.data.token, id: adminLogin.data.user.id }
  console.log(`  账号就绪: alice=${alice.id.slice(0, 8)} bob=${bob.id.slice(0, 8)} admin=${admin.id.slice(0, 8)}`)
  const createdChannels = []
  const createdTemplates = []
  const createdTeams = []
  const createdChannelTemplates = []

  // ===== A. Agent 模板隔离 =====
  console.log('\n=== A. Agent 模板用户隔离 ===')
  const a1 = await api('POST', '/api/workshop/agents', {
    token: alice.token,
    body: { name: `alice-私有-${stamp}`, harness: 'mock', config: { role: 'worker' } },
  })
  check('A1 alice 创建私有模板', ok(a1) && a1.data.visibility === 'private' && a1.data.isBuiltin === false)
  const aliceTpl = a1.data

  const bobList1 = await api('GET', '/api/workshop/agents', { token: bob.token })
  check('A2 bob 列表不见 alice 私有模板', ok(bobList1) && !bobList1.data.some(t => t.id === aliceTpl.id))

  const bobGet = await api('GET', `/api/workshop/agents/${aliceTpl.id}`, { token: bob.token })
  check('A3 bob 直接读取 → 403 SCOPE_VIOLATION', failsWith(bobGet, 'SCOPE_VIOLATION'), bobGet.message)

  const bobPatch = await api('PATCH', `/api/workshop/agents/${aliceTpl.id}`, { token: bob.token, body: { name: 'hijack' } })
  const bobDel = await api('DELETE', `/api/workshop/agents/${aliceTpl.id}`, { token: bob.token })
  check('A4 bob 改/删他人模板 → 403', failsWith(bobPatch, 'SCOPE_VIOLATION') && bobDel.status === 403)

  const aPub = await api('PATCH', `/api/workshop/agents/${aliceTpl.id}`, { token: alice.token, body: { visibility: 'public' } })
  check('A5 alice 设为公开', ok(aPub) && aPub.data.visibility === 'public')
  const bobList2 = await api('GET', '/api/workshop/agents', { token: bob.token })
  const bobSees = bobList2.data.find(t => t.id === aliceTpl.id)
  check('A6 bob 可见公开模板(含属主名)', !!bobSees && bobSees.ownerName === alice.name, `ownerName=${bobSees?.ownerName}`)

  // bob 使用 alice 公开模板:建 channel + addAgentToChannel
  const bobCh = await api('POST', '/api/workshop/channels', { token: bob.token, body: { name: `bob-ch-${stamp}` } })
  check('A7 bob 建 channel', ok(bobCh))
  createdChannels.push(bobCh.data.channelId)
  const bobUse = await api('POST', `/api/workshop/channels/${bobCh.data.channelId}/agents`, {
    token: bob.token, body: { agentId: aliceTpl.id, role: 'worker' },
  })
  check('A8 bob 可使用他人公开模板克隆实例', ok(bobUse))

  const bobPatchPub = await api('PATCH', `/api/workshop/agents/${aliceTpl.id}`, { token: bob.token, body: { visibility: 'private' } })
  check('A9 bob 不能修改公开模板可见性', bobPatchPub.status === 403)

  // 内置模板:任何人都不可改删
  const builtinPatch = await api('PATCH', '/api/workshop/agents/tpl-default-lead', { token: alice.token, body: { name: 'x' } })
  const builtinDel = await api('DELETE', '/api/workshop/agents/tpl-default-lead', { token: alice.token })
  const builtinPatchAdmin = await api('PATCH', '/api/workshop/agents/tpl-default-lead', { token: admin.token, body: { name: 'x' } })
  check('A10 内置模板 user/admin 均不可改删(TEMPLATE_BUILTIN)',
    failsWith(builtinPatch, 'TEMPLATE_BUILTIN') && failsWith(builtinDel, 'TEMPLATE_BUILTIN') && failsWith(builtinPatchAdmin, 'TEMPLATE_BUILTIN'))

  const aliceList = await api('GET', '/api/workshop/agents', { token: alice.token })
  check('A11 alice 可见内置模板(公开)', ok(aliceList) && aliceList.data.some(t => t.id === 'tpl-default-lead' && t.isBuiltin))

  // ===== B. AgentTeam 隔离 =====
  console.log('\n=== B. AgentTeam 用户隔离 ===')
  const alicePrivTpl2 = await api('POST', '/api/workshop/agents', {
    token: alice.token, body: { name: `alice-成员-${stamp}`, harness: 'mock', config: { role: 'worker' } },
  })
  createdTemplates.push(alicePrivTpl2.data?.id)
  const b1 = await api('POST', '/api/workshop/teams', {
    token: alice.token, body: { name: `alice-组-${stamp}`, description: 'e2e' } })
  check('B1 alice 创建私有编组', ok(b1) && b1.data.visibility === 'private')
  const aliceTeam = b1.data
  createdTeams.push(aliceTeam.id)
  await api('POST', `/api/workshop/teams/${aliceTeam.id}/members`, {
    token: alice.token, body: { agentId: aliceTpl.id, role: 'lead' },
  })
  await api('POST', `/api/workshop/teams/${aliceTeam.id}/members`, {
    token: alice.token, body: { agentId: alicePrivTpl2.data.id, role: 'worker' },
  })

  const bobTeams1 = await api('GET', '/api/workshop/teams', { token: bob.token })
  check('B2 bob 不见 alice 私有编组', ok(bobTeams1) && !bobTeams1.data.some(t => t.id === aliceTeam.id))

  await api('PATCH', `/api/workshop/teams/${aliceTeam.id}`, { token: alice.token, body: { visibility: 'public' } })
  const bobTeams2 = await api('GET', '/api/workshop/teams', { token: bob.token })
  check('B3 公开后 bob 可见', bobTeams2.data.some(t => t.id === aliceTeam.id))

  // 公开编组含 bob 不可读的私有成员(alicePrivTpl2)→ bob 部署被拒
  const bobDeploy = await api('POST', `/api/workshop/teams/${aliceTeam.id}/deploy`, {
    token: bob.token, body: { channelId: bobCh.data.channelId } })
  check('B4 公开编组含他人私有成员 → 部署 403', bobDeploy.status === 403, bobDeploy.message)

  const teamBuiltinPatch = await api('PATCH', '/api/workshop/teams/team-default-fullstack', { token: admin.token, body: { name: 'x' } })
  check('B5 内置编组 admin 也不可改', failsWith(teamBuiltinPatch, 'TEMPLATE_BUILTIN'))

  // ===== C. Channel 模板 =====
  console.log('\n=== C. Channel 模板 ===')
  const tplListAlice = await api('GET', '/api/workshop/channel-templates', { token: alice.token })
  check('C1 内置 Channel 模板 2 个全员可见', ok(tplListAlice) && tplListAlice.data.filter(t => t.isBuiltin).length === 2)
  const tplListBob = await api('GET', '/api/workshop/channel-templates', { token: bob.token })
  check('C2 bob 同样可见内置', tplListBob.data.filter(t => t.isBuiltin).length === 2)

  // alice 建 channel(mock lead+worker)→ 捕获为模板
  const aliceCh = await api('POST', '/api/workshop/channels', {
    token: alice.token,
    body: {
      name: `alice-捕获源-${stamp}`,
      scenarioPrompt: `e2e 场景 ${stamp}`,
      leadAgent: { name: 'captain', harness: 'mock', config: { delayMs: 200 } },
    },
  })
  createdChannels.push(aliceCh.data.channelId)
  await api('POST', `/api/workshop/channels/${aliceCh.data.channelId}/agents`, {
    token: alice.token, body: { agentId: 'tpl-default-qa', role: 'worker' },
  })
  const cap = await api('POST', '/api/workshop/channel-templates/from-channel', {
    token: alice.token,
    body: { channelId: aliceCh.data.channelId, name: `alice-ch-tpl-${stamp}`, visibility: 'private' },
  })
  check('C3 从 channel 捕获模板(场景/lead/成员)', ok(cap) && cap.data.scenarioPrompt.includes('e2e 场景') && cap.data.lead?.name === 'captain' && cap.data.members.length === 1)
  const aliceChTpl = cap.data
  createdChannelTemplates.push(aliceChTpl.id)

  const bobTplList1 = await api('GET', '/api/workshop/channel-templates', { token: bob.token })
  check('C4 bob 不见 alice 私有 Channel 模板', !bobTplList1.data.some(t => t.id === aliceChTpl.id))
  const bobTplGet = await api('GET', `/api/workshop/channel-templates/${aliceChTpl.id}`, { token: bob.token })
  check('C5 bob 直接读取 → 403', bobTplGet.status === 403)

  const pubChTpl = await api('PATCH', `/api/workshop/channel-templates/${aliceChTpl.id}`, { token: alice.token, body: { visibility: 'public' } })
  check('C6a alice 将 Channel 模板设为公开', ok(pubChTpl) && pubChTpl.data.visibility === 'public', pubChTpl.message)
  const bobWs = await api('POST', '/api/workshop/workspaces', { token: bob.token, body: { name: `bob-ws-${stamp}` } })
  const bobMount = await api('POST', `/api/workshop/workspaces/${bobWs.data.id}/channel-templates/${aliceChTpl.id}`, { token: bob.token, body: {} })
  check('C6 bob 从公开模板实例化并挂载 workspace', ok(bobMount) && bobMount.data.agentCount === 2,
    ok(bobMount) ? JSON.stringify(bobMount.data).slice(0, 140) : `${bobMount.status}/${bobMount.code}: ${bobMount.message}`)
  createdChannels.push(bobMount.data.channelId)
  const bobMounted = await api('GET', '/api/workshop/workspaces', { token: bob.token })
  check('C7 挂载反映在 workspace channelIds', bobMounted.data.some(w => w.id === bobWs.data.id && w.channelIds.includes(bobMount.data.channelId)))
  const bobInstCh = await api('GET', `/api/workshop/channels/${bobMount.data.channelId}`, { token: bob.token })
  check('C8 实例继承场景 prompt + 属主为 bob', bobInstCh.data.scenarioPrompt.includes('e2e 场景') && bobInstCh.data.ownerUserId === bob.id)

  const bobTplPatch = await api('PATCH', `/api/workshop/channel-templates/${aliceChTpl.id}`, { token: bob.token, body: { name: 'hijack' } })
  const bobTplDel = await api('DELETE', `/api/workshop/channel-templates/${aliceChTpl.id}`, { token: bob.token })
  check('C9 bob 不可改/删他人公开模板', bobTplPatch.status === 403 && bobTplDel.status === 403)

  const chBuiltinPatch = await api('PATCH', '/api/workshop/channel-templates/chtpl-default-fullstack', { token: admin.token, body: { name: 'x' } })
  check('C10 内置 Channel 模板 admin 不可改', failsWith(chBuiltinPatch, 'TEMPLATE_BUILTIN'))

  // ===== D. Channel 实例热更新 =====
  console.log('\n=== D. Channel 实例设置热更新 ===')
  const newScenario = `更新后的场景 ${stamp}`
  const patchCh = await api('PATCH', `/api/workshop/channels/${bobMount.data.channelId}`, {
    token: bob.token, body: { scenarioPrompt: newScenario },
  })
  const getCh = await api('GET', `/api/workshop/channels/${bobMount.data.channelId}`, { token: bob.token })
  check('D1 scenarioPrompt 热更新生效', ok(patchCh) && getCh.data.scenarioPrompt === newScenario)

  // ===== E. 监控隔离 + admin 权限 =====
  console.log('\n=== E. 监控用户级隔离与 admin ===')
  const bobMon = await api('GET', '/api/system/monitor', { token: bob.token })
  check('E1 bob 视图 scope=user 且只见本人 channel',
    ok(bobMon) && bobMon.data.scope === 'user'
    && !bobMon.data.channels.some(c => c.channelId === aliceCh.data.channelId)
    && bobMon.data.channels.some(bc => bc.channelId === bobMount.data.channelId),
    `channels=${bobMon.data?.channels?.length}`)

  const aliceMon = await api('GET', '/api/system/monitor', { token: alice.token })
  check('E2 alice 不见 bob 的 channel', ok(aliceMon) && !aliceMon.data.channels.some(c => c.channelId === bobMount.data.channelId))

  const adminMon = await api('GET', '/api/system/monitor', { token: admin.token })
  const adminSeesBoth = adminMon.data?.channels?.some(c => c.channelId === aliceCh.data.channelId)
    && adminMon.data?.channels?.some(c => c.channelId === bobMount.data.channelId)
  check('E3 admin 全量视图(scope=admin)含双方 channel', ok(adminMon) && adminMon.data.scope === 'admin' && adminSeesBoth)
  const adminOwnName = adminMon.data.channels.find(c => c.channelId === aliceCh.data.channelId)?.ownerName
  check('E4 admin 视图附创建者名', adminOwnName === alice.name, `ownerName=${adminOwnName}`)

  const aliceUsers = await api('GET', '/api/users', { token: alice.token })
  check('E5 非 admin 访问用户管理 → 403', failsWith(aliceUsers, 'ADMIN_REQUIRED'))
  const adminUsers = await api('GET', '/api/users', { token: admin.token })
  check('E6 admin 用户列表可用', ok(adminUsers) && Array.isArray(adminUsers.data.items) && adminUsers.data.items.length >= 3)

  // admin 全量模板视图(含他人私有 + 创建者)
  const adminTpls = await api('GET', '/api/workshop/agents', { token: admin.token })
  const adminSeesAlicePrivate = adminTpls.data.some(t => t.id === alicePrivTpl2.data.id && t.ownerName === alice.name)
  check('E7 admin 可见他人私有模板 + 创建者', adminSeesAlicePrivate)
  const adminTeams = await api('GET', '/api/workshop/teams', { token: admin.token })
  check('E8 admin 可见全部编组', adminTeams.data.some(t => t.id === aliceTeam.id))
  const adminChTpls = await api('GET', '/api/workshop/channel-templates', { token: admin.token })
  check('E9 admin 可见全部 Channel 模板 + 创建者', adminChTpls.data.some(t => t.id === aliceChTpl.id && t.ownerName === alice.name))

  // admin 越权改删(非内置)
  const adminRename = await api('PATCH', `/api/workshop/agents/${alicePrivTpl2.data.id}`, { token: admin.token, body: { name: `admin改-${stamp}` } })
  check('E10 admin 可改他人私有模板', ok(adminRename) && adminRename.data.name === `admin改-${stamp}`)

  // ===== 清理 =====
  for (const id of createdChannels) {
    await api('DELETE', `/api/workshop/channels/${id}`, { token: bob.token }).catch(() => {})
    await api('DELETE', `/api/workshop/channels/${id}`, { token: alice.token }).catch(() => {})
  }
  for (const id of createdChannelTemplates) await api('DELETE', `/api/workshop/channel-templates/${id}`, { token: alice.token }).catch(() => {})
  for (const id of createdTeams) await api('DELETE', `/api/workshop/teams/${id}`, { token: alice.token }).catch(() => {})
  for (const id of createdTemplates) await api('DELETE', `/api/workshop/agents/${id}`, { token: alice.token }).catch(() => {})
  await api('DELETE', `/api/workshop/agents/${aliceTpl.id}`, { token: alice.token }).catch(() => {})
  await api('DELETE', `/api/workshop/workspaces/${bobWs.data.id}`, { token: bob.token }).catch(() => {})

  console.log(`\n${pass} pass / ${fail} fail`)
  process.exit(fail > 0 ? 1 : 0)
}

main().catch((e) => {
  console.error('E2E 崩溃:', e)
  process.exit(1)
})
