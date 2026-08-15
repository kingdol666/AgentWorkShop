/**
 * AgentTeam 端到端真实测试(对运行中的 dev server):
 *  1. 创建 Agent 模板(mock harness,真实任务执行)
 *  2. AgentTeam CRUD + 成员加入/移除(含 409 冲突)
 *  3. 批量部署 AgentTeam → Channel(一次部署 3 实例,免逐个放置)
 *  4. 向 channel 提交任务 → lead 分发 → worker 真实执行 → COMPLETED
 *  5. 成员移除 / team 更新 / 删除
 * 运行: node scripts/e2e-agent-team.mjs [--base http://127.0.0.1:3000]
 */
const BASE = (process.argv.find(a => a.startsWith('--base='))?.slice(7) ?? 'http://127.0.0.1:3000') + '/api/workshop'

let pass = 0
let fail = 0
const results = []

function check(name, ok, detail = '') {
  const line = `  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`
  results.push(line)
  console.log(line)
  ok ? pass++ : fail++
}

async function req(method, path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: body ? { 'content-type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  })
  return { status: res.status, json: await res.json().catch(() => null) }
}

const sleep = ms => new Promise(r => setTimeout(r, ms))

async function waitTaskTerminal(taskId, timeoutMs) {
  const start = Date.now()
  let state = ''
  while (Date.now() - start < timeoutMs) {
    const { json } = await req('GET', `/tasks/${taskId}`)
    state = json?.data?.state ?? ''
    if (['COMPLETED', 'FAILED', 'CANCELED'].includes(state)) return { state, json }
    await sleep(500)
  }
  return { state, json: null }
}

const cleanup = { channelId: null, agentIds: [], teamId: null }

async function main() {
  console.log('━━━ 1. 创建 Agent 模板(mock harness)━━━')
  const lead = await req('POST', '/agents', { name: 'team-lead', harness: 'mock' })
  const w1 = await req('POST', '/agents', { name: 'team-worker-1', harness: 'mock' })
  const w2 = await req('POST', '/agents', { name: 'team-worker-2', harness: 'mock' })
  const LEAD = lead.json.data.id, W1 = w1.json.data.id, W2 = w2.json.data.id
  cleanup.agentIds = [LEAD, W1, W2]
  check('创建 3 个模板', !!LEAD && !!W1 && !!W2, `lead=${LEAD.slice(0, 8)}…`)

  console.log('━━━ 2. AgentTeam CRUD + 成员管理 ━━━')
  const team = await req('POST', '/teams', { name: 'E2E Team', description: 'e2e test team' })
  const TEAM = team.json.data.id
  cleanup.teamId = TEAM
  check('创建 team', team.json.code === 0 && !!TEAM, `team=${TEAM.slice(0, 8)}…`)

  const addLead = await req('POST', `/teams/${TEAM}/members`, { agentId: LEAD, role: 'lead' })
  check('加入 lead 成员', addLead.json.data.members.length === 1 && addLead.json.data.members[0].role === 'lead')
  await req('POST', `/teams/${TEAM}/members`, { agentId: W1 })
  const addW2 = await req('POST', `/teams/${TEAM}/members`, { agentId: W2 })
  check('加入 2 个 worker 成员', addW2.json.data.members.length === 3, `members=${addW2.json.data.members.length}`)

  const dup = await req('POST', `/teams/${TEAM}/members`, { agentId: W1 })
  check('重复加入 → 409 ALREADY_MEMBER', dup.json.code === 'ALREADY_MEMBER')

  const dupLead = await req('POST', `/teams/${TEAM}/members`, { agentId: W2, role: 'lead' })
  check('重复 lead → 409', dupLead.json.code === 'LEAD_EXISTS' || dupLead.json.code === 'ALREADY_MEMBER', `code=${dupLead.json.code}`)

  const missingTpl = await req('POST', `/teams/${TEAM}/members`, { agentId: '00000000-0000-0000-0000-000000000000' })
  check('加入不存在的模板 → 404', missingTpl.json.code === 'NOT_FOUND')

  const got = await req('GET', `/teams/${TEAM}`)
  check('GET team 详情', got.json.data.name === 'E2E Team' && got.json.data.members.length === 3)

  const membersList = await req('GET', `/teams/${TEAM}/members`)
  check('GET team 成员列表', membersList.json.data.length === 3)

  const listAll = await req('GET', '/teams')
  check('GET teams 列表含新 team', listAll.json.data.some(t => t.id === TEAM))

  console.log('━━━ 3. 批量部署 AgentTeam → Channel ━━━')
  const ch = await req('POST', '/channels', { name: 'team-channel', description: 'deployed from team' })
  const CH = ch.json.data.channelId
  cleanup.channelId = CH
  check('创建空 channel', ch.json.code === 0 && !!CH, `channel=${CH.slice(0, 8)}…`)

  const deploy = await req('POST', `/teams/${TEAM}/deploy`, { channelId: CH })
  const agents = deploy.json.data?.agents ?? []
  check('一次部署 3 实例', agents.length === 3, JSON.stringify(agents.map(a => `${a.name}:${a.role}`)))
  const chLead = agents.find(a => a.role === 'lead')
  check('部署结果含 lead 实例', !!chLead)

  const chDetail = await req('GET', `/channels/${CH}`)
  check('channel 含 3 个 agent 实例', chDetail.json.data.agents.length === 3)
  check('channel leadAgentId 已设定', chDetail.json.data.leadAgentId === chLead?.id)

  const redeploy = await req('POST', `/teams/${TEAM}/deploy`, { channelId: CH })
  check('二次部署 → 409 LEAD_EXISTS', redeploy.json.code === 'LEAD_EXISTS')

  const deploy404 = await req('POST', `/teams/00000000-0000-0000-0000-000000000000/deploy`, { channelId: CH })
  check('部署不存在的 team → 404', deploy404.json.code === 'NOT_FOUND')

  console.log('━━━ 4. 通过 channel 提交任务 → 真实执行 ━━━')
  const task = await req('POST', `/channels/${CH}/tasks`, {
    title: 'team e2e task',
    description: 'verify team-deployed channel executes tasks',
  })
  const TASK = task.json.data?.id
  check('提交任务到 channel', task.json.code === 0 && !!TASK, `task=${TASK?.slice(0, 8)}…`)

  const { state, json } = await waitTaskTerminal(TASK, 30_000)
  check('任务真实执行至 COMPLETED', state === 'COMPLETED', `state=${state}`)
  const t = json?.data
  if (t) {
    console.log(`  task: state=${t.state} progress=${t.progress} artifacts=${t.artifacts.length} history=${t.history.length}`)
  }
  // 部署的 worker 实例应消费了子任务:channel 内应有 COMPLETED 的子任务且 assignee 非 lead
  const chTasks = await req('GET', `/channels/${CH}/tasks`)
  const childDone = (chTasks.json.data ?? []).filter(x => x.state === 'COMPLETED' && x.id !== TASK)
  check('lead 分发子任务且 worker 完成', childDone.length >= 1, `completed children=${childDone.length}`)

  console.log('━━━ 5. 成员移除 + team 更新/删除 ━━━')
  const rm = await req('DELETE', `/teams/${TEAM}/members/${W2}`)
  check('移除成员 → 剩 2 个', rm.json.data.members.length === 2)

  const rmAgain = await req('DELETE', `/teams/${TEAM}/members/${W2}`)
  check('再删同成员 → 404', rmAgain.json.code === 'NOT_FOUND')

  const patch = await req('PATCH', `/teams/${TEAM}`, { name: 'E2E Team v2' })
  check('PATCH team 改名', patch.json.data.name === 'E2E Team v2')

  const del = await req('DELETE', `/teams/${TEAM}`)
  check('DELETE team', del.json.data.removed === true)
  const gone = await req('GET', `/teams/${TEAM}`)
  check('删除后 GET → 404', gone.json.code === 'NOT_FOUND')

  console.log(`\n━━━ 结果: PASS=${pass} FAIL=${fail} ━━━`)
}

try {
  await main()
}
finally {
  // 清理测试数据(channel 级联清实例/任务;再删模板)
  if (cleanup.channelId) await req('DELETE', `/channels/${cleanup.channelId}`)
  for (const id of cleanup.agentIds) await req('DELETE', `/agents/${id}`)
}
process.exit(fail === 0 ? 0 : 1)
