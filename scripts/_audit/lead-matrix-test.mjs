/**
 * lead-matrix-test.mjs —— 判定「任务被取消」到底是不是 mock lead 的问题
 * ------------------------------------------------------------
 * 同一套任务文案、同一台服务器,只换 lead/worker 的 harness 组合:
 *   A: lead=omp   + worker=omp     ← 用户的猜想:换成真实 harness lead 是否就正常
 *   B: lead=mock  + worker=omp     ← 复现上一轮 CANCELED 的组合
 *   C: lead=mock  + worker=mock    ← 已知可完成的对照组
 *   D: lead=omp   + worker=mock    ← 隔离出「真实 lead 会不会正确调度一个确定性 worker」
 *
 * 每个组合:建 Channel → 建 worker → 入队 → 派任务 → 轮询到终态(带超时),
 * 并把全过程的时间线打出来,便于定位卡在哪一步。
 */
import { writeFileSync } from 'node:fs'

const BASE = (() => {
  const i = process.argv.indexOf('--base')
  return (i > 0 ? process.argv[i + 1] : 'http://127.0.0.1:3112').replace(/\/$/, '')
})()
const PER_CASE_MS = Number((() => {
  const i = process.argv.indexOf('--budget')
  return i > 0 ? process.argv[i + 1] : 240_000
})())
const ONLY = (() => {
  const i = process.argv.indexOf('--case')
  return i > 0 ? process.argv[i + 1] : ''
})()
/**
 * --bind:把既有产线的 3 数采 + 3 数控绑到本轮 worker 上。
 * ⚠️ 不绑定的话,"汇报产线状态"这个任务对真实 LLM 是**无解的** —— 它会正确地
 * 调用 line_context/my_industrial_nodes 查出"尚未绑定节点"然后拒绝执行
 * (这本身是正确行为,但会把矩阵结果误读成"omp worker 不可用")。
 */
const DO_BIND = process.argv.includes('--bind')

let TOKEN = null
async function api(method, path, { body } = {}) {
  const headers = { 'content-type': 'application/json' }
  if (TOKEN) headers.authorization = `Bearer ${TOKEN}`
  const res = await fetch(`${BASE}${path}`, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined })
  return { status: res.status, ...(await res.json().catch(() => ({}))) }
}
const data = r => r?.data ?? {}
const sleep = ms => new Promise(r => setTimeout(r, ms))
const t0 = Date.now()
const stamp = () => `+${String(Math.round((Date.now() - t0) / 1000)).padStart(4)}s`

const CASES = [
  { id: 'A', lead: 'omp', worker: 'omp', label: '真实 harness lead + 真实 worker' },
  { id: 'B', lead: 'mock', worker: 'omp', label: 'mock lead + 真实 worker(复现失败组合)' },
  { id: 'C', lead: 'mock', worker: 'mock', label: 'mock lead + mock worker(对照组)' },
  { id: 'D', lead: 'omp', worker: 'mock', label: '真实 harness lead + mock worker' },
]

TOKEN = data(await api('POST', '/api/users/login', { body: { email: 'plant@awshop.local', password: 'Plant!2026' } })).token
if (!TOKEN) { console.error('✖ 登录失败'); process.exitCode = 2; throw new Error('login') }

const results = []
for (const c of CASES) {
  if (ONLY && ONLY !== c.id) continue
  console.log(`\n━━━ 组合 ${c.id}:${c.label}(lead=${c.lead} / worker=${c.worker})━━━`)
  const tag = `${Date.now().toString(36).slice(-4)}`
  const timeline = []
  const mark = (msg) => { timeline.push(`${stamp()} ${msg}`); console.log(`  ${stamp()} ${msg}`) }

  // lead 用 mock 时必须给 config.delayMs,否则 supervise 回合节奏不可控
  const leadCfg = c.lead === 'mock' ? { delayMs: 40 } : {}
  const created = await api('POST', '/api/workshop/channels', {
    body: {
      name: `矩阵-${c.id}-${tag}`,
      description: `lead=${c.lead} worker=${c.worker}`,
      leadAgent: { name: `调度长${c.id}-${tag}`, harness: c.lead, config: leadCfg },
    },
  })
  const channelId = data(created).channelId ?? data(created).id
  if (!channelId) {
    mark(`✖ Channel 创建失败:${JSON.stringify(created).slice(0, 200)}`)
    results.push({ case: c.id, ok: false, reason: 'channel create failed', timeline })
    continue
  }
  mark(`Channel 建好 ${channelId.slice(0, 8)}`)

  const workerCfg = c.worker === 'mock' ? { delayMs: 30 } : {}
  const worker = data(await api('POST', '/api/workshop/agents', {
    body: { name: `执行员${c.id}-${tag}`, harness: c.worker, config: workerCfg },
  }))
  if (!worker.id) {
    mark(`✖ worker 创建失败:${JSON.stringify(worker).slice(0, 200)}`)
    results.push({ case: c.id, ok: false, reason: 'worker create failed', timeline })
    continue
  }
  await api('POST', `/api/workshop/channels/${channelId}/agents`, { body: { agentId: worker.id, role: 'worker' } })
  mark(`worker 入队 ${worker.id.slice(0, 8)}`)

  // 绑定工业节点:数采 auto(只读)/ 数控 manual(写入需审批)—— 不绑定则任务无数据源。
  // ⚠️ 绑定主体必须是**频道成员 id**(worker.id 是 Agent 模板 id,会被接口拒绝)
  let boundAgentId = worker.id
  if (DO_BIND) {
    const membersRaw = data(await api('GET', `/api/workshop/channels/${channelId}/agents`))
    const members = Array.isArray(membersRaw) ? membersRaw : (membersRaw.agents ?? [])
    const member = members.find(m => m.role === 'worker' && (m.templateId === worker.id || m.id === worker.id))
    boundAgentId = member?.id ?? worker.id
    const daqNodes = data(await api('GET', '/api/workshop/daq')).nodes ?? []
    const dcwNodes = data(await api('GET', '/api/workshop/dcw')).nodes ?? []
    let n = 0
    const fails = []
    for (const nd of daqNodes) {
      const r = await api('POST', '/api/workshop/agent-tools/bindings', { body: { agentId: boundAgentId, nodeId: nd.id, kind: 'daq', mode: 'auto' } })
      if (r.code === 0) n++
      else fails.push(`${nd.name}: ${r.code}`)
    }
    for (const nd of dcwNodes) {
      const r = await api('POST', '/api/workshop/agent-tools/bindings', { body: { agentId: boundAgentId, nodeId: nd.id, kind: 'dcw', mode: 'manual' } })
      if (r.code === 0) n++
      else fails.push(`${nd.name}: ${r.code}`)
    }
    const visible = data(await api('GET', `/api/workshop/agent-tools/bindings?agentId=${boundAgentId}`))
    const vList = Array.isArray(visible) ? visible : (visible.bindings ?? [])
    mark(`绑定工业节点 创建 ${n}/6 · 成员侧可见 ${vList.length}${fails.length ? ' · 失败:' + fails.join(',') : ''}`)
  }

  // 直发 worker(与上一轮失败的场景完全一致)
  const taskRes = await api('POST', `/api/workshop/channels/${channelId}/tasks`, {
    body: {
      title: `巡检-${c.id}-${tag}`,
      parts: [{
        text: DO_BIND
          ? '用 daq_query 读取已绑定的三路数采最近 5 分钟数据,汇总均值与波动并给出稳态判定,然后把结论写进 complete_task。'
          : '汇报当前产线状态,给出稳态判定。',
      }],
      assigneeId: boundAgentId,
    },
  })
  if (taskRes.status !== 200 || taskRes.code !== 0) {
    mark(`✖ 任务创建失败:${JSON.stringify(taskRes).slice(0, 200)}`)
    results.push({ case: c.id, ok: false, reason: `task create ${taskRes.status}`, timeline })
    continue
  }
  const taskId = data(taskRes).task?.id ?? data(taskRes).id
  mark(`任务下发 ${taskId.slice(0, 8)}(直发 worker)`)

  const seen = new Set()
  let final = null
  const deadline = Date.now() + PER_CASE_MS
  while (Date.now() < deadline) {
    await sleep(2500)
    const list = data(await api('GET', `/api/workshop/channels/${channelId}/tasks`)) ?? []
    const me = (Array.isArray(list) ? list : []).find(x => x.id === taskId)
    if (!me) continue
    const key = `${me.state}:${me.progress}`
    if (!seen.has(key)) {
      seen.add(key)
      mark(`任务状态 ${me.state} progress=${me.progress}`)
    }
    if (['COMPLETED', 'FAILED', 'CANCELED'].includes(me.state)) { final = me; break }
  }
  if (!final) {
    const list = data(await api('GET', `/api/workshop/channels/${channelId}/tasks`)) ?? []
    final = (Array.isArray(list) ? list : []).find(x => x.id === taskId) ?? { state: '(超时未终态)' }
    mark(`超时:${final.state} progress=${final.progress ?? '?'}`)
  }
  const okDone = final?.state === 'COMPLETED'
  mark(`${okDone ? '✅' : '✖'} 终态=${final?.state} progress=${final?.progress ?? '?'}`)
  results.push({ case: c.id, lead: c.lead, worker: c.worker, ok: okDone, final: final?.state, progress: final?.progress, timeline })
}

console.log('\n━━━ 矩阵汇总 ━━━')
for (const r of results) {
  console.log(`  ${r.ok ? '✅' : '✖'}  ${r.case}  lead=${r.lead ?? '?'}/${r.worker ?? '?'}  终态=${r.final ?? r.reason}  progress=${r.progress ?? '?'}`)
}
writeFileSync('D:/codes/ABO/aw-plc-clean/lead-matrix.json', JSON.stringify(results, null, 2), 'utf8')
console.log('\n明细已写入 D:/codes/ABO/aw-plc-clean/lead-matrix.json')
process.exitCode = results.every(r => r.ok) ? 0 : 1
