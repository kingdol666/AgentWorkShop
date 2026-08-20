/**
 * 终端功能全栈 e2e(两阶段,针对 .output 生产构建;AW_BASE 指向目标服务)。
 *
 * Phase A — mock 环境(功能集成回归):
 *  A1. mock channel(lead+worker)任务生命周期跑通至 COMPLETED
 *  A2. GET /channels/:id/terminals → 空数组(mock 无 omp 进程,无终端镜像)
 *  A3. WS 以 mock agent 的 agentId 连接 → NO_SESSION 优雅拒绝
 *  A4. /api/system/monitor:mock agent process=null(in-proc),无 omp 进程行
 *
 * Phase B — omp 环境(简单任务全链路,rpc-ui HITL):
 *  B1. WS 鉴权负例(无 token → USER_UNAUTHORIZED;不存在 pid → NO_SESSION)
 *  B2. omp lead channel + 任务 → 进程 spawn;monitor 进程行 terminal:true
 *  B3. terminals 端点返回该成员会话(agentId 寻址数据源)
 *  B4. WS agentId 连接:term.init(meta 归属)+ 帧流回放(会话事件)
 *  B5. 空闲注入(follow_up)→ __human_input 广播 + omp 受理
 *  B6. 诱导 ask → extension_ui_request 实时帧 → ui_response 应答 →
 *      ask 工具收到 "User selected"(tool_execution_end 可见)
 *  B7. 应答后任务完成(COMPLETED)
 *  B8. 清理:终止进程 + 删除 channel
 *
 * 运行:node scripts/test-terminal-e2e.mjs(默认 http://127.0.0.1:3101;需 omp CLI)
 */
const BASE = process.env.AW_BASE ?? 'http://127.0.0.1:3101'
const WS_BASE = BASE.replace(/^http/, 'ws')

let failures = 0
let passed = 0
function check(name, ok, detail = '') {
  const tag = ok ? 'PASS' : 'FAIL'
  console.log(`  ${tag}  ${name}${detail ? ` — ${detail}` : ''}`)
  if (ok) passed += 1
  else failures += 1
}
function section(title) {
  console.log(`\n━━━ ${title} ━━━`)
}
const sleep = ms => new Promise(r => setTimeout(r, ms))

async function waitUntil(name, cond, timeoutMs = 240_000, intervalMs = 500) {
  const deadline = Date.now() + timeoutMs
  let last = null
  while (Date.now() < deadline) {
    try {
      last = await cond()
      if (last) return last
    }
    catch (e) { last = e }
    await sleep(intervalMs)
  }
  throw new Error(`waitUntil timeout: ${name} (last=${String(last).slice(0, 160)})`)
}

/** 终端 WS 客户端:收集消息;frames() 聚合全部帧;send() 上行 */
function openTerminalWs(query) {
  const messages = []
  const ws = new WebSocket(`${WS_BASE}/api/system/monitor/terminal/ws?${query}`)
  ws.addEventListener('message', (ev) => {
    try {
      messages.push(JSON.parse(ev.data))
    }
    catch { /* ignore */ }
  })
  const waitClose = () => new Promise((resolve) => {
    if (ws.readyState === WebSocket.CLOSED) return resolve(true)
    ws.addEventListener('close', () => resolve(true))
    setTimeout(() => resolve(false), 8000)
  })
  return {
    ws,
    messages,
    waitClose,
    frames: () => messages.filter(m => m.type === 'term.frames').flatMap(m => m.frames),
    send: obj => ws.send(JSON.stringify(obj)),
  }
}

const api = async (method, path, { body, token } = {}) => {
  const headers = { 'content-type': 'application/json' }
  if (token) headers.authorization = `Bearer ${token}`
  const res = await fetch(`${BASE}${path}`, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined })
  return { status: res.status, ...(await res.json().catch(() => ({}))) }
}

async function registerUser(label) {
  const user = await api('POST', '/api/users/register', {
    body: { email: `${label}-${Date.now().toString(36)}@test.local`, password: 'Passw0rd!123', name: label },
  })
  const token = user.data?.token
  if (!token) throw new Error(`用户注册失败: ${JSON.stringify(user).slice(0, 160)}`)
  return token
}

async function createChannel(token, name, leadHarness) {
  const ch = await api('POST', '/api/workshop/channels', {
    body: { name, description: 'terminal e2e', leadAgent: { name: `${name}-lead`, harness: leadHarness } },
    token,
  })
  if (ch.code !== 0 || !ch.data?.channelId) throw new Error(`channel 创建失败: ${JSON.stringify(ch).slice(0, 160)}`)
  return { channelId: ch.data.channelId, leadAgentId: ch.data.leadAgentId }
}

async function taskState(token, channelId, taskId) {
  const tasks = await api('GET', `/api/workshop/channels/${channelId}/tasks`, { token })
  return (tasks.data ?? []).find(t => t.id === taskId)?.state ?? null
}

// ═══════════════════ Phase A:mock 环境 ═══════════════════

async function phaseMock() {
  section('Phase A — mock 环境(功能集成回归)')
  const token = await registerUser('term-e2e-mock')
  check('A0 用户注册 + token', true)

  // A1:mock channel 任务生命周期
  const { channelId, leadAgentId } = await createChannel(token, `mock-e2e-${Date.now().toString(36)}`, 'mock')
  check('A1 创建 mock lead channel', true, `channel=${channelId.slice(0, 8)}`)
  const w = await api('POST', `/api/workshop/channels/${channelId}/agents`, { body: { name: 'mock-worker', harness: 'mock', role: 'worker' }, token })
  check('A1 添加 mock worker', w.code === 0)
  const workerId = w.data?.id ?? null

  const task = await api('POST', `/api/workshop/channels/${channelId}/tasks`, {
    body: { title: 'mock-lifecycle', description: 'mock 任务生命周期验证' },
    token,
  })
  const taskId = task.data?.id
  const finalState = await waitUntil('mock 任务终态', () => taskState(token, channelId, taskId).then(s => (s === 'COMPLETED' || s === 'FAILED' ? s : null)), 120_000)
  check('A1 mock 任务生命周期跑通', finalState === 'COMPLETED', `state=${finalState}`)

  // A2:terminals 端点 → 空数组
  const terms = await api('GET', `/api/workshop/channels/${channelId}/terminals`, { token })
  check('A2 GET /channels/:id/terminals 形状(数组)', terms.code === 0 && Array.isArray(terms.data))
  check('A2 mock channel 无终端会话(omp 专属)', (terms.data ?? []).length === 0, `count=${terms.data?.length}`)

  // A3:WS 以 mock agent 的 agentId 连接 → NO_SESSION
  {
    const t = openTerminalWs(`agentId=${leadAgentId}&channelId=${channelId}&token=${token}`)
    const closed = await t.waitClose()
    check('A3 WS mock agentId → NO_SESSION 优雅拒绝', closed && t.messages.some(m => m.type === 'term.error' && m.code === 'NO_SESSION'), `msgs=${t.messages.map(m => m.type).join(',')}`)
  }

  // A4:monitor 快照,mock agent in-proc
  const mon = await api('GET', '/api/system/monitor', { token })
  const mockAgent = (mon.data?.agents ?? []).find(a => a.agentId === leadAgentId)
  check('A4 monitor:mock agent 无子进程(in-proc)', mockAgent?.process === null || mockAgent?.process === undefined)
  const ompProcs = (mon.data?.processes ?? []).filter(p => p.harness === 'omp')
  check('A4 monitor:当前无 omp 进程行', ompProcs.length === 0, `omp=${ompProcs.length}`)

  // 清理
  await api('DELETE', `/api/workshop/channels/${channelId}`, { token })
  void workerId
}

// ═══════════════════ Phase B:omp 环境 ═══════════════════

async function phaseOmp() {
  section('Phase B — omp 环境(简单任务全链路 + rpc-ui HITL)')
  const token = await registerUser('term-e2e-omp')

  // B1:WS 鉴权负例
  {
    const t = openTerminalWs('pid=999999')
    const closed = await t.waitClose()
    check('B1 无 token → USER_UNAUTHORIZED', closed && t.messages.some(m => m.type === 'term.error' && m.code === 'USER_UNAUTHORIZED'))
  }
  {
    const t = openTerminalWs(`pid=999999&token=${token}`)
    const closed = await t.waitClose()
    check('B1 有效 token + 不存在 pid → NO_SESSION', closed && t.messages.some(m => m.type === 'term.error' && m.code === 'NO_SESSION'))
  }
  {
    const t = openTerminalWs(`token=${token}`)
    const closed = await t.waitClose()
    check('B1 缺 pid/agentId → BAD_PID', closed && t.messages.some(m => m.type === 'term.error' && m.code === 'BAD_PID'))
  }

  // B2:omp channel + 任务 → spawn
  const { channelId, leadAgentId } = await createChannel(token, `omp-e2e-${Date.now().toString(36)}`, 'omp')
  check('B2 创建 omp lead channel', true, `channel=${channelId.slice(0, 8)}`)
  const task = await api('POST', `/api/workshop/channels/${channelId}/tasks`, {
    body: { title: 'hitl-e2e', description: 'Wait for further instructions from the human operator via the terminal.' },
    token,
  })
  const taskId = task.data?.id
  check('B2 提交任务(触发 supervise → omp spawn)', task.code === 0, `task=${taskId.slice(0, 8)}`)

  const proc = await waitUntil('omp 进程 spawn(terminal:true)', async () => {
    const snap = await api('GET', '/api/system/monitor', { token })
    return (snap.data?.processes ?? []).find(p => p.harness === 'omp' && p.alive && p.terminal && p.agentId === leadAgentId) ?? null
  })
  check('B2 monitor:omp 进程存活且 terminal:true', true, `pid=${proc.pid} name=${proc.name}`)

  // B3:terminals 端点
  const terms = await api('GET', `/api/workshop/channels/${channelId}/terminals`, { token })
  const mine = (terms.data ?? []).find(t => t.agentId === leadAgentId)
  check('B3 terminals 端点返回该成员会话', !!mine && mine.pid === proc.pid && mine.alive === true, `pid=${mine?.pid} running=${mine?.running}`)

  // B4:WS agentId 连接
  const t = openTerminalWs(`agentId=${leadAgentId}&channelId=${channelId}&token=${token}`)
  await waitUntil('term.init', () => t.messages.some(m => m.type === 'term.init'))
  const init = t.messages.find(m => m.type === 'term.init')
  check('B4 term.init(agentId 解析,meta 归属 lead)', init?.meta?.pid === proc.pid && init.meta.agentId === leadAgentId && init.meta.role === 'lead', `pid=${init?.meta?.pid}`)
  await waitUntil('帧流到达', () => t.frames().length > 0)
  const frameTypes = new Set(t.frames().map(f => String(f.frame.type)))
  check('B4 帧流回放含会话事件', frameTypes.has('agent_start') || frameTypes.has('message_start') || frameTypes.has('message_update'), `types=${[...frameTypes].slice(0, 8).join(',')}`)

  // B5:ping/pong
  t.send({ type: 'ping' })
  await waitUntil('pong', () => t.messages.some(m => m.type === 'pong'), 10_000)
  check('B5 ping → pong', true)

  // B6:等 lead 空闲 → 注入 ask 指令(follow_up)
  await waitUntil('lead 空闲', () => {
    const state = t.messages.findLast(m => m.type === 'term.state')
    return state ? state.running === false : init?.running === false
  }, 240_000).catch(() => console.log('  (等待空闲超时,仍尝试注入)'))

  t.send({ type: 'input', text: 'Use the ask tool NOW to ask me: Proceed? with options yes and no. After I answer, call complete_task with the deliverable set to my answer.' })
  const humanEcho = await waitUntil('__human_input 广播', () => t.frames().some(f => f.frame.type === '__human_input'), 30_000).catch(() => null)
  check('B6 注入 → __human_input 帧广播', humanEcho !== null)
  const accepted = await waitUntil('注入受理', () => {
    return t.frames().some(f => f.frame.type === 'response' && (f.frame.command === 'follow_up' || f.frame.command === 'steer') && f.frame.success === true)
  }, 60_000).catch(() => null)
  check('B6 omp 受理注入(steer/follow_up response)', accepted !== null)

  // B7:extension_ui_request 实时帧 → 应答 → ask 收到答案
  const dialog = await waitUntil('extension_ui_request 实时帧', () => {
    const f = t.frames().findLast(f => f.frame.type === 'extension_ui_request' && ['select', 'confirm', 'input', 'editor'].includes(String(f.frame.method)))
    return f ?? null
  }, 240_000)
  const dlg = dialog.frame
  check('B7 ask 对话框实时到达(extension_ui_request)', dlg.method === 'select' && String(dlg.title).includes('Proceed'), `method=${dlg.method} options=${JSON.stringify(dlg.options).slice(0, 80)}`)

  t.send({ type: 'ui_response', id: String(dlg.id), value: 'yes' })
  const askResult = await waitUntil('ask 工具收到答案', () => {
    return t.frames().some(f => f.frame.type === 'tool_execution_end' && String(f.frame.toolName) === 'ask' && String(f.frame.result).includes('yes')) ?? null
  }, 120_000)
  check('B7 ui_response 应答 → ask 工具收到 "yes"', askResult !== null)

  // B8:任务完成
  const finalState = await waitUntil('任务终态', () => taskState(token, channelId, taskId).then(s => (s === 'COMPLETED' || s === 'FAILED' ? s : null)), 240_000)
  check('B8 HITL 应答后任务完成', finalState === 'COMPLETED', `state=${finalState}`)

  // 断开
  t.ws.close()

  // 清理:终止进程 + 删除 channel
  const stop = await api('POST', '/api/system/monitor/terminate', { body: { channelId, agentId: leadAgentId }, token })
  check('B9 终止 lead 进程(runtime 卸载)', stop.code === 0)
  const del = await api('DELETE', `/api/workshop/channels/${channelId}`, { token })
  check('B9 删除 channel', del.code === 0)
}

async function main() {
  console.log(`目标: ${BASE}(生产构建 .output)\n`)
  await phaseMock()
  await phaseOmp()
  console.log(`\n★ 结果: ${passed} passed, ${failures} failed`)
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((err) => {
  console.error('e2e 异常:', err.message)
  process.exit(1)
})
