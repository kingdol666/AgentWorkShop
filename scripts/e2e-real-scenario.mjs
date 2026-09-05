/**
 * 多 Harness 真实场景端到端(针对真实运行中的 AgentWorkShop 服务)。
 *
 * 前置:服务已启动(pnpm dev / npm start),且服务进程 PATH 上有 omp/codex/dsh。
 * 运行:node scripts/e2e-real-scenario.mjs [--base http://127.0.0.1:3000]
 *
 * 场景:
 *  0. 注册测试用户 + WS 事件监控(全程录制 AEP 帧)+ REST 事件历史轮询(权威记录)
 *  1. 产线:新建产线 + DCW 温控节点(mock)+ DAQ 温度采集节点(mock)
 *  2. 班组:AgentChannel(lead=omp)+ worker-codex + worker-dsh,绑定工业节点
 *     (dsh↔DCW manual / dsh↔DAQ auto / codex↔DCW manual)
 *  3. 兼容性对话:人类→codex、人类→dsh(要求回执);codex 经工具跨引擎发信 dsh
 *  4. 团队作业:goal 任务 → lead 派发 → dsh 数采(daq_query)→ 数控写入(dcw_control
 *     触发 dcw-approval HITL)→ 测试员批准 → 写入生效 → 复读确认 → 任务闭环
 *  5. HITL 超时:再次写入,故意不批准 → 等满 security.hitl_timeout_ms →
 *     自动按拒绝收敛(expired)→ worker 收到拒绝结果并汇报
 */
const BASE = process.env.AW_BASE ?? 'http://127.0.0.1:3000'
const WS_BASE = BASE.replace(/^http/, 'ws')

let failures = 0
let passed = 0
const timeline = []

const ts = () => new Date().toISOString().slice(11, 23)
const log = (line) => {
  console.log(`[${ts()}] ${line}`)
  timeline.push(`[${ts()}] ${line}`)
}
const check = (name, ok, detail = '') => {
  const tag = ok ? 'PASS' : 'FAIL'
  log(`  ${tag}  ${name}${detail ? ` — ${detail}` : ''}`)
  if (ok) {
    passed += 1
  }
  else {
    failures += 1
  }
  return ok
}
const sleep = ms => new Promise(r => setTimeout(r, ms))

// ---------- 用户与 API ----------
const reg = await fetch(`${BASE}/api/workshop/users/register`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ name: 'live-scen-' + Math.random().toString(36).slice(2, 8) }),
}).then(r => r.json()).catch(() => null)
const TOKEN = reg?.data?.token
if (!TOKEN) {
  console.error('用户注册失败 — 服务未启动或接口不可用:', JSON.stringify(reg))
  process.exit(1)
}
log(`测试用户已注册(token=${TOKEN.slice(0, 8)}…)BASE=${BASE}`)

async function api(method, path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { 'content-type': 'application/json', 'authorization': `Bearer ${TOKEN}` },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
  const json = await res.json().catch(() => ({}))
  return { status: res.status, ...json }
}

/** 回执判定:平台代投/模型回执(in_reply_to 帧)或时间线产物含预期文本(兜底) */
function matchReply(frames, from, mid, textPattern) {
  return frames.find(f => f.type === 'a2a.message' && f.payload?.metadata?.['x-aw-in-reply-to'] === mid)
    ?? frames.find(f => (f.type === 'a2a.artifact' || f.type === 'agent.status.message')
      && textPattern.test(JSON.stringify(f.payload ?? ''))) ?? null
}

async function waitUntil(name, cond, timeoutMs, intervalMs = 1000) {
  const deadline = Date.now() + timeoutMs
  let last = null
  while (Date.now() < deadline) {
    try {
      last = await cond()
    }
    catch (e) {
      last = e
    }
    if (last) return last
    await sleep(intervalMs)
  }
  return last ?? null
}

// ---------- 事件监控:REST 历史轮询(权威)+ WS 实时 ----------
const eventFrames = []
let lastSeq = 0
let wsSeen = 0

async function pollEvents(channelId) {
  const res = await api('GET', `/api/workshop/channels/${channelId}/events?limit=500`)
  const list = res?.data?.items ?? []
  for (const f of list) {
    const seq = Number(f.seq ?? 0)
    if (seq > lastSeq) {
      lastSeq = seq
      eventFrames.push(f)
      const t = f.type
      if (['hitl.request', 'hitl.resolved', 'task.status', 'a2a.message', 'a2a.artifact', 'error'].includes(t)) {
        const p = f.payload ?? {}
        const brief = t === 'a2a.message'
          ? `${p.fromAgentId ?? p.from ?? '?'}→${p.toAgentId ?? p.to ?? '?'}: ${(p.parts ?? []).map(x => x.text ?? '').join(' ').slice(0, 110)}`
          : t === 'hitl.request'
            ? `${p.kind}:${p.title ?? ''}`
            : t === 'hitl.resolved'
              ? `${p.kind} outcome=${p.outcome}`
              : t === 'task.status'
                ? `${(p.title ?? '').slice(0, 40)} → ${p.state}`
                : t === 'a2a.artifact'
                  ? `artifact(${p.artifact?.name ?? '?'})`
                  : JSON.stringify(p).slice(0, 120)
        log(`  [事件] #${seq} ${t} ${brief}`)
      }
    }
  }
}

function startPolling(channelId) {
  const timer = setInterval(() => {
    void pollEvents(channelId).catch(() => {})
  }, 2000)
  return () => clearInterval(timer)
}

async function startWs(channelId) {
  try {
    const { createRequire } = await import('node:module')
    const req = createRequire(import.meta.url)
    let WebSocket = null
    try {
      WebSocket = req('D:/codes/ABO/AgentWorkShop/node_modules/.pnpm/ws@8.21.3/node_modules/ws')
    }
    catch (e) {
      log(`ws 模块加载失败: ${e.message}`)
    }
    if (!WebSocket) {
      log('WS 客户端不可用,仅用 REST 轮询监控')
      return () => {}
    }
    const ws = new WebSocket(`${WS_BASE}/api/workshop/ws`)
    ws.on('open', () => {
      ws.send(JSON.stringify({ type: 'sub', channelId, token: TOKEN }))
      log('WS 监控已接入(AEP 实时帧)')
    })
    ws.on('message', (raw) => {
      wsSeen++
      try {
        const f = JSON.parse(String(raw))
        if (f.type === 'hitl.request') log(`  [WS/hitl.request] ${f.payload?.kind}: ${f.payload?.title ?? ''}`)
        if (f.type === 'hitl.resolved') log(`  [WS/hitl.resolved] ${f.payload?.kind} outcome=${f.payload?.outcome}`)
      }
      catch { /* 忽略 */ }
    })
    ws.on('error', e => log(`WS 错误(不影响 REST 权威记录): ${e.message}`))
    return () => {
      try {
        ws.close()
      }
      catch { /* ignore */ }
    }
  }
  catch (e) {
    log(`WS 初始化失败(仅 REST 轮询): ${e.message}`)
    return () => {}
  }
}

// ---------- 工具调用(REST 直调,用于验证/准备;worker 侧走 MCP 桥) ----------
async function invokeTool(agentId, tool, args) {
  return await api('POST', '/api/workshop/agent-tools/invoke', { agentId, tool, args })
}

/**
 * 确保 worker-dsh 在组(lead 可能自主移除成员——实测发生过):不在则重建并重绑工业节点。
 * 返回当前可用的 dsh 实例 id。
 */
async function ensureDshWorker() {
  const members = await api('GET', `/api/workshop/channels/${channelId}/agents`)
  const live = (members?.data ?? []).find(m => m.name === 'worker-dsh' && m.enabled !== 0)
  if (live) return live.id
  log('  [自愈] worker-dsh 已不在组(被 lead 移除?)→ 重建并重绑工业节点')
  const w = await createWorker('worker-dsh', 'dsh', { promptTimeoutMs: 600_000 })
  if (!w.agentId) throw new Error(`重建 worker-dsh 失败: ${w.err}`)
  await api('POST', '/api/workshop/agent-tools/bindings', { agentId: w.agentId, nodeId: dcwNodeId, kind: 'dcw', mode: 'manual' })
  await api('POST', '/api/workshop/agent-tools/bindings', { agentId: w.agentId, nodeId: daqNodeId, kind: 'daq', mode: 'auto' })
  await sleep(1500)
  return w.agentId
}

// ============================================================
console.log('\n━━━ 0. 服务连通性 ━━━')
const harnesses = await api('GET', '/api/workshop/harnesses')
const hIds = (harnesses?.data?.harnesses ?? []).map(h => h.id)
check('服务可达且为多引擎版本(注册表含 codex/dsh/opencode)', hIds.includes('codex') && hIds.includes('dsh') && hIds.includes('opencode'), `harnesses=${hIds.join(',')}`)

// ============================================================
console.log('\n━━━ 1. 产线与工业节点 ━━━')
const line = await api('POST', '/api/workshop/dcw/lines', { name: '多引擎联调线' })
const lineId = line?.data?.line?.id
check('新建产线', !!lineId, `line=${line?.data?.line?.name ?? JSON.stringify(line).slice(0, 80)}`)

const dcwNode = await api('POST', '/api/workshop/dcw', {
  templateRef: 'dcw-temp-sp', name: '联调温度设定器', driver: 'mock', lineId,
  readIntervalMs: 2000, unit: '℃', min: 150, max: 200,
})
const dcwNodeId = dcwNode?.data?.node?.id
check('新建 DCW 数控节点(mock 温控)', !!dcwNodeId, `id=${dcwNodeId}`)

const daqNode = await api('POST', '/api/workshop/daq', {
  templateRef: 'daq-temp-tc', name: '联调温度采集', driver: 'mock', lineId,
  intervalMs: 1000,
})
const daqNodeId = daqNode?.data?.node?.id
check('新建 DAQ 数采节点(mock 温度)', !!daqNodeId, `id=${daqNodeId} driver=${daqNode?.data?.node?.driver}`)

// ============================================================
console.log('\n━━━ 2. 班组(多引擎 AgentChannel)━━━')
const ch = await api('POST', '/api/workshop/channels', {
  name: '多引擎联调-产线班组',
  scenarioPrompt: '多引擎兼容性联调班组:成员来自不同 Agent Harness(omp/codex/dsh),协作完成产线数采与数控写入。所有写入必须走审批流程,如实汇报执行结果。',
  leadAgent: { name: 'lead-omp', harness: 'omp', config: { provider: 'zhipu-coding-plan', model: 'glm-5.2' } },
})
const channelId = ch?.data?.channelId
check('创建 AgentChannel(lead=omp)', !!channelId, `channelId=${channelId}`)

async function createWorker(name, harness, config) {
  // 一步创建(新建模板并克隆):响应即 channel 内实例(独立 id,后续绑定/调用一律用实例 id)
  const add = await api('POST', `/api/workshop/channels/${channelId}/agents`, { name, harness, role: 'worker', config })
  const agentId = add?.data?.id
  if (!agentId) return { agentId: null, err: JSON.stringify(add).slice(0, 200) }
  return { agentId, err: null }
}

const codex = await createWorker('worker-codex', 'codex', {
  approvalPolicy: 'on-request', sandbox: 'workspace-write', promptTimeoutMs: 600_000,
  systemPromptPrefix: '执行要直接:按任务指令调用平台工具并汇报,不探索文件系统。',
})
check('创建 worker-codex 并入组(harness=codex)', !!codex.agentId, codex.err ?? codex.agentId)
const dsh = await createWorker('worker-dsh', 'dsh', { promptTimeoutMs: 600_000 })
check('创建 worker-dsh 并入组(harness=dsh)', !!dsh.agentId, dsh.err ?? dsh.agentId)

if (!channelId || !codex.agentId || !dsh.agentId || !dcwNodeId || !daqNodeId) {
  log('前置实体创建失败,中止场景')
  console.log(`FAILURES=${failures} PASSED=${passed}`)
  process.exit(1)
}

const stopPoll = startPolling(channelId)
const stopWs = await startWs(channelId)
await sleep(2500)
await pollEvents(channelId)

// ---------- 绑定工业节点 ----------
const b1 = await api('POST', '/api/workshop/agent-tools/bindings', { agentId: dsh.agentId, nodeId: dcwNodeId, kind: 'dcw', mode: 'manual' })
check('绑定 dsh↔DCW(manual,HITL 模式)', !!b1?.data?.binding?.id, `mode=${b1?.data?.binding?.mode}`)
const b2 = await api('POST', '/api/workshop/agent-tools/bindings', { agentId: dsh.agentId, nodeId: daqNodeId, kind: 'daq', mode: 'auto' })
check('绑定 dsh↔DAQ(auto,数采)', !!b2?.data?.binding?.id)
const b3 = await api('POST', '/api/workshop/agent-tools/bindings', { agentId: codex.agentId, nodeId: dcwNodeId, kind: 'dcw', mode: 'manual' })
check('绑定 codex↔DCW(manual)', !!b3?.data?.binding?.id)

// dsh 引擎侧工具可见性验证(my_industrial_nodes 直调;worker 实际经 MCP 桥)
const mine = await invokeTool(dsh.agentId, 'my_industrial_nodes', {})
check('dsh 工具面可见绑定节点(my_industrial_nodes)', /温度设定器|联调温度/.test(String(mine?.data?.result?.text ?? '')), String(mine?.data?.result?.text ?? '').replace(/\n/g, ' ').slice(0, 120))

// ============================================================
console.log('\n━━━ 3. 兼容性对话(三通道)━━━')
const seq0 = lastSeq

// 3a. 人类 → codex(要求回执)
const m1 = await api('POST', `/api/workshop/channels/${channelId}/messages`, {
  toAgentId: codex.agentId, fromLabel: '测试员', requireReply: true, priority: 'task',
  text: '兼容性检查:请用一句话汇报你正在运行的引擎类型(如 codex),然后调用 report_progress 工具上报 10% 进度(无任务上下文则忽略报错),最后原样回复"codex 在线"。',
})
check('人类→codex 消息已投递', m1.status === 200 || !!m1?.data?.messageId, `status=${m1.status}`)

const codexReply = await waitUntil('codex 回执', async () => {
  await pollEvents(channelId)
  return matchReply(eventFrames.slice(seq0), codex.agentId, m1?.data?.messageId ?? m1?.messageId, /codex 在线/)
}, 240_000)
check('codex 回执到达(真实引擎回合)', !!codexReply,
  codexReply ? `内容=${(codexReply.payload?.parts ?? []).map(x => x.text ?? '').join('').slice(0, 80)}` : '240s 未回')

// 3b. 人类 → dsh(要求回执)
const seqA = lastSeq
const m2 = await api('POST', `/api/workshop/channels/${channelId}/messages`, {
  toAgentId: dsh.agentId, fromLabel: '测试员', requireReply: true, priority: 'task',
  text: '兼容性检查:请用一句话汇报你正在运行的引擎类型(如 dsh/ACP),然后原样回复"dsh 在线"。',
})
check('人类→dsh 消息已投递', m2.status === 200 || !!m2?.data?.messageId, `status=${m2.status}`)
const dshReply = await waitUntil('dsh 回执', async () => {
  await pollEvents(channelId)
  return matchReply(eventFrames.slice(seqA), dsh.agentId, m2?.data?.messageId ?? m2?.messageId, /dsh 在线/)
}, 240_000)
check('dsh 回执到达(真实引擎回合)', !!dshReply,
  dshReply ? `内容=${(dshReply.payload?.parts ?? []).map(x => x.text ?? '').join('').slice(0, 80)}` : '240s 未回')

// 3c. codex →(工具)→ dsh 跨引擎发信
const seqB = lastSeq
const m3 = await api('POST', `/api/workshop/channels/${channelId}/messages`, {
  toAgentId: codex.agentId, fromLabel: '测试员', requireReply: true, priority: 'task',
  text: '请使用 send_message_to_agent 工具向同事 worker-dsh 发送一句话:"跨引擎测试:请回复你的引擎类型",并设置 require_reply=true;发送完成后回复我"已发送"。',
})
check('人类→codex(要求跨引擎发信)已投递', m3.status === 200 || !!m3?.data?.messageId, `status=${m3.status}`)
const crossReply = await waitUntil('跨引擎回执', async () => {
  await pollEvents(channelId)
  return matchReply(eventFrames.slice(seqB), codex.agentId, m3?.data?.messageId ?? m3?.messageId, /已发送|发送完/)
}, 240_000)
check('codex 经工具跨引擎发信完成', !!crossReply,
  crossReply ? `内容=${(crossReply.payload?.parts ?? []).map(x => x.text ?? '').join('').slice(0, 80)}` : '240s 未回')
const dshGotCross = await waitUntil('dsh 收到跨引擎消息', async () => {
  await pollEvents(channelId)
  return eventFrames.slice(seqB).find(f => f.type === 'a2a.message'
    && String(f.payload?.metadata?.['x-aw-from-agent'] ?? '') === codex.agentId
    && f.payload?.toAgentId === dsh.agentId)
}, 120_000)
check('dsh 侧收到 codex 来信', !!dshGotCross)

// ============================================================
console.log('\n━━━ 4. 团队作业:数采 → 数控写入(HITL 确认)→ 复读 ━━━')
dsh.agentId = await ensureDshWorker()
const task = await api('POST', `/api/workshop/channels/${channelId}/tasks`, {
  title: '温度工艺整定(数采+数控)',
  mode: 'goal',
  description: [
    '班组作业目标:完成一次温度设定整定并留痕。',
    '1. 让 worker-dsh 用 daq_query 工具查询其绑定的温度采集节点最近 5 分钟数据,并向你汇报均值;',
    '2. 让 worker-dsh 用 dcw_control 工具将其绑定的「联调温度设定器」写入 175.0(该写入走人工审批:若平台弹出审批请求,等待测试员批准后再继续;不要绕过审批);',
    '3. 写入成功后让 worker-dsh 用 dcw_read 复读设定值并向你确认;',
    '4. 全部完成后调用 complete_task 汇总结果。',
    '注意:写入节点 id 以 worker 的 my_industrial_nodes 工具输出为准。',
  ].join('\n'),
})
const taskId = task?.data?.id
check('团队作业(goal)已提交至 lead', !!taskId, `taskId=${taskId} state=${task?.data?.state}`)

// 等待 HITL 审批出现
const hitlAt = Date.now()
const approval = await waitUntil('dcw-approval 出现', async () => {
  await pollEvents(channelId)
  const pending = await api('GET', '/api/workshop/hitl/pending')
  const items = pending?.data?.items ?? []
  return items.find(i => i.kind === 'dcw-approval') ?? null
}, 600_000)
check('数控写入触发 dcw-approval HITL(worker-dsh)', !!approval,
  approval ? `id=${approval.id} detail=${String(approval.detail ?? '').slice(0, 90)}` : '600s 内未触发(检查 worker 是否调用了 dcw_control)')
log(`审批从提交到出现耗时 ${(Date.now() - hitlAt) / 1000}s`)

if (approval) {
  log('测试员批准审批(模拟用户确认)…')
  const resp = await api('POST', '/api/workshop/hitl/respond', { kind: 'dcw-approval', id: approval.id, confirmed: true, comment: '场景测试批准' })
  check('HITL 批准应答成功(respond 200)', resp.status === 200 || resp?.data?.ok === true, `status=${resp.status} ${JSON.stringify(resp).slice(0, 100)}`)
}

// 等待任务闭环 + 读回验证
const taskDone = await waitUntil('团队任务闭环', async () => {
  await pollEvents(channelId)
  const t = await api('GET', `/api/workshop/tasks/${taskId}`)
  const state = t?.data?.state
  if (state === 'COMPLETED' || state === 'FAILED' || state === 'CANCELED') return state
  return null
}, 900_000)
check('团队任务闭环 COMPLETED', taskDone === 'COMPLETED', `state=${taskDone}`)

// 数控写入是否真实生效(平台侧直读节点)
let readBack = await invokeTool(dsh.agentId, 'dcw_read', { node_id: dcwNodeId })
let rbText = String(readBack?.data?.result?.text ?? '')
if (!rbText) {
  dsh.agentId = await ensureDshWorker()
  readBack = await invokeTool(dsh.agentId, 'dcw_read', { node_id: dcwNodeId })
  rbText = String(readBack?.data?.result?.text ?? '')
}
check('写入生效:dcw_read 读回 175 附近', /17[4-6]/.test(rbText), rbText.replace(/\n/g, ' ').slice(0, 120))

// ============================================================
console.log('\n━━━ 5. HITL 超时路径(不批准 → 等满上限 → 自动拒绝)━━━')
dsh.agentId = await ensureDshWorker()
const seqD = lastSeq
const m4Text = '请用 dcw_control 工具将「联调温度设定器」下调至 160.0(hypothesis=超时路径验证)。该写入需要人工审批:请发起审批后耐心等待;若审批被拒绝或超时未批,请如实汇报等待与结果,不要重复发起。'
let m4 = await api('POST', `/api/workshop/channels/${channelId}/messages`, {
  toAgentId: dsh.agentId, fromLabel: '测试员', requireReply: true, priority: 'task', text: m4Text,
})
if (m4.status !== 200) {
  // 成员可能在上一阶段被 lead 自主移除:自愈后重发
  await sleep(3000)
  dsh.agentId = await ensureDshWorker()
  m4 = await api('POST', `/api/workshop/channels/${channelId}/messages`, {
    toAgentId: dsh.agentId, fromLabel: '测试员', requireReply: true, priority: 'task', text: m4Text,
  })
}
check('超时场景消息已投递(下调 160)', m4.status === 200 || !!m4?.data?.messageId, `status=${m4.status}`)

const approval2 = await waitUntil('第二次审批出现', async () => {
  await pollEvents(channelId)
  const pending = await api('GET', '/api/workshop/hitl/pending')
  const items = pending?.data?.items ?? []
  return items.find(i => i.kind === 'dcw-approval') ?? null
}, 300_000)
check('第二次写入触发审批', !!approval2, approval2 ? `id=${approval2.id} expiresAt=${approval2.expiresAt}` : '300s 未触发')

if (approval2) {
  log('测试员故意不批准 — 等待审批超时上限(security.hitl_timeout_ms,默认 180s)…')
  const expiryMs = Math.max(0, Date.parse(approval2.expiresAt) - Date.now()) + 15_000
  const expired = await waitUntil('审批超时自动拒绝', async () => {
    await pollEvents(channelId)
    return eventFrames.slice(seqD).find(f => f.type === 'hitl.resolved'
      && f.payload?.id === approval2.id
      && (f.payload?.outcome === 'expired' || f.payload?.outcome === 'cancelled')) ?? null
  }, expiryMs + 60_000)
  check('审批到上限自动收敛(expired)', !!expired,
    expired ? `outcome=${expired.payload?.outcome}` : '超时窗内未观察到 resolved 帧')
  const stillPending = await api('GET', '/api/workshop/hitl/pending')
  const remains = (stillPending?.data?.items ?? []).filter(i => i.id === approval2.id)
  check('审批从待办清单移除', remains.length === 0)

  // 值未被写入(160 ≠ 当前 175)
  const readBack2 = await invokeTool(dsh.agentId, 'dcw_read', { node_id: dcwNodeId })
  const rb2 = String(readBack2?.data?.result?.text ?? '')
  check('拒绝后值未变(仍 ~175,非 160)', /17[4-6]/.test(rb2) && !/160/.test(rb2.split('\n').find(l => /当前|设定|值/i.test(l)) ?? rb2), rb2.replace(/\n/g, ' ').slice(0, 120))

  // worker 汇报(回执应说明等待/拒绝)
  const workerReport = await waitUntil('worker 汇报超时结果', async () => {
    await pollEvents(channelId)
    return eventFrames.slice(seqD).find(f => f.type === 'a2a.message'
      && f.payload?.metadata?.['x-aw-in-reply-to'] === (m4?.data?.messageId ?? m4?.messageId)) ?? null
  }, 300_000)
  check('worker 回执汇报超时/拒绝结果', !!workerReport,
    workerReport ? `内容=${(workerReport.payload?.parts ?? []).map(x => x.text ?? '').join('').slice(0, 120)}` : '300s 未回')
}

// ============================================================
console.log('\n━━━ 6. 事件监控汇总 ━━━')
const byType = {}
for (const f of eventFrames) byType[f.type] = (byType[f.type] ?? 0) + 1
log(`REST 事件历史共 ${eventFrames.length} 帧;WS 实时收到 ${wsSeen} 帧`)
log('帧分布: ' + JSON.stringify(byType))
check('事件流覆盖关键类型(task/status/message/hitl)',
  (byType['task.status'] ?? 0) > 0 && (byType['hitl.request'] ?? 0) > 0,
  JSON.stringify(byType).slice(0, 160))

stopPoll()
stopWs()
try {
  const { writeFileSync } = await import('node:fs')
  writeFileSync('scripts/_dbg-real-scenario-timeline.log', timeline.join('\n'), 'utf-8')
}
catch { /* ignore */ }

console.log(`\n━━━ 场景结论:PASS=${passed} FAIL=${failures} ━━━`)
process.exit(failures === 0 ? 0 : 1)
