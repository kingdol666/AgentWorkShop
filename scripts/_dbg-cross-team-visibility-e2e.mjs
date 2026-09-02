/**
 * 跨团队可见性端到端验证:leader 看其他团队任务场景(list_other_teams)、
 * 全员查其他团队共享记忆(search_other_teams_memory)、权限反证(worker 查概览被拒)。
 * 前置:运行中的环境(默认 3000)。运行: node scripts/_dbg-cross-team-visibility-e2e.mjs
 */
const ROOT = process.env.AW_BASE ?? 'http://127.0.0.1:3000'
let TOKEN = ''
const H = () => ({ authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' })
const sleep = (ms) => new Promise(r => setTimeout(r, ms))
let failures = 0
const check = (name, ok, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures++
}
const fail = (m) => { console.error('FATAL:', m); process.exit(1) }

async function api(method, path, body) {
  const res = await fetch(ROOT + path, { method, headers: H(), body: body !== undefined ? JSON.stringify(body) : undefined })
  const json = await res.json().catch(() => ({}))
  return { status: res.status, ...json }
}
const jpost = (u, b) => api('POST', u, b ?? {})
const jget = (u) => api('GET', u)
const invoke = async (agentId, tool, args = {}) => {
  const r = await jpost('/api/workshop/agent-tools/invoke', { agentId, tool, args })
  const result = r.data?.result
  return { status: r.status, text: String(result?.text ?? JSON.stringify(r).slice(0, 200)), isError: result?.isError === true }
}
const cleanup = []
const tag = Math.random().toString(36).slice(2, 8)

async function deployTeam(name, withWorker) {
  const chRes = (await jpost('/api/workshop/channels', { name, description: '跨团队可见性验证' })).data
  cleanup.push(['channel', chRes.channelId])
  const team = (await jpost('/api/workshop/teams', { name: name + '-组', description: '跨团队可见性验证' })).data
  cleanup.push(['team', team.id])
  await jpost(`/api/workshop/teams/${team.id}/members`, { agentId: 'tpl-default-lead', role: 'lead' })
  let worker = null
  if (withWorker) {
    const tpl = (await jpost('/api/workshop/agents', { name: name + '-worker', harness: 'mock', config: {} })).data
    cleanup.push(['agent-tpl', tpl.id])
    await jpost(`/api/workshop/teams/${team.id}/members`, { agentId: tpl.id, role: 'worker' })
  }
  await jpost(`/api/workshop/teams/${team.id}/deploy`, { channelId: chRes.channelId })
  const agents = (await jget(`/api/workshop/channels/${chRes.channelId}/agents`)).data
  const lead = agents.find(a => a.role === 'lead')
  worker = agents.find(a => a.role === 'worker') ?? null
  if (lead) cleanup.push(['channel-agent', `${chRes.channelId}:${lead.id}`])
  if (worker) cleanup.push(['channel-agent', `${chRes.channelId}:${worker.id}`])
  return { channelId: chRes.channelId, lead, worker }
}

async function main() {
  console.log('━━━ 0. 注册与双团队部署 ━━━')
  const reg = await jpost('/api/workshop/users/register', { name: 'xvis-' + tag })
  TOKEN = reg.data?.token
  if (!TOKEN) fail('注册失败: ' + JSON.stringify(reg).slice(0, 120))
  check('注册并取得 token', !!TOKEN)
  const east = await deployTeam('东线团队-' + tag, false)
  const west = await deployTeam('西线团队-' + tag, true)
  check('东线(无 worker)+ 西线(含 worker)就绪', !!east.lead?.id && !!west.lead?.id && !!west.worker?.id,
    `eastLead=${String(east.lead?.id ?? '').slice(0, 8)} westLead=${String(west.lead?.id ?? '').slice(0, 8)}`)

  // ===== 1. 东线沉淀共享记忆(他人将检索的知识)=====
  console.log('\n━━━ 1. 东线共享记忆沉淀 ━━━')
  const mem = await jpost(`/api/workshop/channels/${east.channelId}/memories`, {
    title: '淬火工艺结论-' + tag,
    content: `东线团队完成淬火工序验证:淬火温度 182℃ 保温 30 分钟后硬度达标 HRC58,温度超过 190℃ 会出现过回火软化。结论可用于西线同类工件工艺制定(${tag})。`,
    importance: 0.9,
  })
  check('东线共享记忆写入', mem.status === 200, `status=${mem.status}`)

  // ===== 2. 东线创建进行中场景任务 =====
  console.log('\n━━━ 2. 东线进行中任务 ━━━')
  const task = await jpost(`/api/workshop/channels/${east.channelId}/tasks`, {
    title: '东线批次复检-' + tag,
    parts: [{ text: '对当前批次做复检并记录结论' }],
  })
  const taskId = task.data?.task?.id ?? task.data?.id
  cleanup.push(['task', taskId])
  check('东线任务创建(进行中)', !!taskId, `id=${String(taskId ?? '').slice(0, 8)}`)

  // ===== 3. 西线 lead:list_other_teams 看到东线的任务场景 =====
  console.log('\n━━━ 3. Leader 跨团队观察面 ━━━')
  const ov = await invoke(west.lead.id, 'list_other_teams')
  const ovText = String(ov.text ?? '')
  check('lead 查看其他团队概览', ov.status === 200 && ovText.includes('东线团队-' + tag), `status=${ov.status}`)
  check('概览包含东线进行中任务标题', ovText.includes('东线批次复检-' + tag))
  check('概览包含东线近期完成记录', ovText.includes('近期完成'))

  // ===== 4. 西线 worker:search_other_teams_memory 查到东线共享知识 =====
  console.log('\n━━━ 4. Worker 跨团队记忆检索 ━━━')
  const hit = await invoke(west.worker.id, 'search_other_teams_memory', { query: '淬火 温度 硬度', limit: 5 })
  const hitText = String(hit.text ?? '')
  check('worker 检索到东线共享记忆', hit.status === 200 && hitText.includes('淬火工艺结论-' + tag),
    `status=${hit.status} text=${hitText.slice(0, 60)}`)
  check('检索结果带团队归属', hitText.includes('东线团队-' + tag))

  // ===== 5. 权限反证:worker 查任务概览被拒(仅 lead)=====
  const denied = await invoke(west.worker.id, 'list_other_teams')
  check('worker 查任务概览被拒(仅 lead)', denied.isError === true || denied.status === 403 || String(denied.text ?? '').includes('Leader'),
    `status=${denied.status} text=${String(denied.text ?? '').slice(0, 60)}`)

  // ===== 6. 工作流语义:知识已存在 → lead 直接复用,无需发信 =====
  const reuse = hitText.includes('182') && hitText.includes('HRC58')
  check('跨团队知识可复用(检索内容含结论数值)', reuse)
  console.log('  (工作流:命中知识 → 直接复用;未命中但有相关任务 → lead 用 send_cross_channel_message 发信请求协作)')

  // ===== 清理 =====
  console.log('\n━━━ 清理 ━━━')
  for (const [kind, id] of [...cleanup].reverse()) {
    try {
      if (kind === 'channel') await api('DELETE', `/api/workshop/channels/${id}`)
      else if (kind === 'team') await api('DELETE', `/api/workshop/teams/${id}`)
      else if (kind === 'agent-tpl') await api('DELETE', `/api/workshop/agents/${id}`)
      else if (kind === 'channel-agent') {
        const [cid, aid] = String(id).split(':')
        if (cid && aid) await api('DELETE', `/api/workshop/channels/${cid}/agents/${aid}`)
      }
    }
    catch { /* 清理失败不阻断 */ }
  }
  console.log('清理完成')

  console.log(failures === 0 ? '\nE2E ALL PASS' : `\nE2E ${failures} FAILED`)
  if (failures > 0) process.exit(1)
}

main().catch((e) => { console.error(e); process.exit(1) })
