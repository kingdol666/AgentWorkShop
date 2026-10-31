/**
 * 生产服务器实时 API 端到端验证(针对 npm run start 起的 3001 服务)。
 *
 * 覆盖:
 *  - 持久化恢复(重启前的 channels/agents/tasks 在 API 可见)
 *  - AGENT 模板 CRUD + 实例化(clone 进 channel)
 *  - CHANNEL CRUD + activate + 成员管理
 *  - TASK 提交与生命周期:goal / loop(maxIterations 限次)/ pipeline 三模式
 *    SUBMITTED → ASSIGNED → WORKING → 进度上报 → COMPLETED,parent/child 聚合
 *    (goal 收口按 2026-10-30 证据闸:lead 经 REST complete 显式附真实交付物)
 *  - dispatch / report / complete / cancel 状态机
 *  - Bearer token 作用域:现建一次性 B 频道取其 lead 有效 token —— 同 channel 列表可见,
 *    异频道列表不含本频道任务、读详情 → 精确 403 SCOPE_VIOLATION
 *  - a2a 点对点 + mailbox 拉取 + channel 消息历史
 *  - agents/subscribe 订阅
 *  - WebSocket Hub 增量广播(agent.status / task.status / task.progress)
 *  - MCP Streamable HTTP initialize(Agent harness 作业面)
 *
 * 运行: node scripts/api-live-e2e.mjs
 */
const BASE = process.env.AW_BASE ?? 'http://127.0.0.1:3001'
const WS_BASE = BASE.replace(/^http/, 'ws')

// 网络层瞬断（本机代理 churn 间歇占满回环临时端口 → fetch failed/EADDRINUSE）
// 用退避重试吸收；HTTP 语义错误不重试。与 bench/lib 侧瞬断策略一致。
const rawFetch = globalThis.fetch.bind(globalThis)
globalThis.fetch = async (input, init = {}) => {
  let lastErr
  for (let attempt = 1; attempt <= 8; attempt++) {
    try {
      return await rawFetch(input, { ...init, signal: init.signal ?? AbortSignal.timeout(30_000) })
    }
    catch (err) {
      lastErr = err
      if (init.signal?.aborted) throw err
      if (attempt < 8) await new Promise(r => setTimeout(r, Math.min(800 * 2 ** (attempt - 1), 8000)))
    }
  }
  throw lastErr
}

let failures = 0
let passed = 0
let step = 0

function check(name, ok, detail = '') {
  const tag = ok ? 'PASS' : 'FAIL'
  console.log(`  ${tag}  ${name}${detail ? ` — ${detail}` : ''}`)
  if (ok) passed += 1
  else failures += 1
}

function section(title) {
  step += 1
  console.log(`\n━━━ ${step}. ${title} ━━━`)
}

// 用户级隔离:注册测试用户;管理面 API 全程携带用户 token。
// 跨重启复用 AW_E2E_TOKEN(持久化恢复章节要求"重启前的 channel"属于同一用户;
// 新注册用户看不到旧用户的 channel,必须沿用同一 token)。
let __user
if (process.env.AW_E2E_TOKEN) {
  __user = { data: { token: process.env.AW_E2E_TOKEN } }
}
else {
  __user = await fetch(BASE + '/api/workshop/users/register', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'e2e-' + Math.random().toString(36).slice(2, 10) }),
  }).then(r => r.json()).catch(() => null)
}
const __userToken = __user?.data?.token
if (!__userToken) {
  console.error('用户注册失败')
  process.exit(1)
}

async function api(method, path, { body, token } = {}) {
  const headers = { 'content-type': 'application/json' }
  headers.authorization = `Bearer ${token ?? __userToken}`
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
  const json = await res.json().catch(() => ({}))
  return { status: res.status, ...json }
}

const sleep = ms => new Promise(r => setTimeout(r, ms))

/** 轮询直到断言通过或超时 */
async function waitUntil(name, cond, timeoutMs = 20_000, intervalMs = 250) {
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
  throw new Error(`waitUntil timeout: ${name} (last=${JSON.stringify(String(last)).slice(0, 200)})`)
}

const tag = Date.now().toString(36)
const ids = {
  channel: null, template: null, lead: null, worker: null, leadToken: null, workerToken: null,
  channelB: null, leadB: null, leadBToken: null,
}

/** 日志脱敏:token 只露前 4 位,全量 token 严禁出现在输出里 */
const maskToken = t => (typeof t === 'string' && t.length > 0 ? `${t.slice(0, 4)}***` : '(empty)')

async function main() {
  console.log(`目标: ${BASE} (生产构建 .output + scripts/start.mjs)\n`)

  // 幂等预清理:移除上次异常中止遗留的 api-e2e-* / api-tpl* 数据
  const staleCh = await api('GET', '/api/workshop/channels')
  for (const c of (staleCh.data ?? []).filter(c => String(c.name).startsWith('api-e2e'))) {
    await api('DELETE', `/api/workshop/channels/${c.id}`)
  }
  const staleAg = await api('GET', '/api/workshop/agents')
  for (const a of (staleAg.data ?? []).filter(a => String(a.name).startsWith('api-tpl'))) {
    await api('DELETE', `/api/workshop/agents/${a.id}`)
  }
  const preCh = await api('GET', '/api/workshop/channels')
  if (preCh.data?.some(c => String(c.name).startsWith('api-e2e'))) {
    throw new Error('预清理失败:api-e2e channel 仍存在')
  }
  console.log(`  预清理完成(遗留 api-e2e/api-tpl 数据已移除)`)

  // ═══════════ 1. 持久化恢复 ═══════════
  section('持久化恢复 — 重启前数据经 API 可见')
  const ch0 = await api('GET', '/api/workshop/channels')
  check('GET /channels 恢复 channel 列表', ch0.code === 0 && Array.isArray(ch0.data), `count=${ch0.data?.length}`)
  // 只认**本人可读**的历史 channel:GET /channels 还会返回"公开可发现/本人是成员"的
  // 他人 Channel(带 permissions),直接取 persisted[0] 会拿到他人 channel →
  // 详情 / tasks 必然 403 SCOPE_VIOLATION(非本人),把环境噪声算成产品失败。
  const persisted = (ch0.data ?? []).filter(c => c.leadAgentId && c.permissions?.isOwner === true)
  // 该子检查依赖「上一轮遗留的 channel-with-lead」。首次运行/上轮已清理时按项目
  // 失败语义诚实 skip(bench/PIPELINE.md:环境不具备宁可 skip 并写明原因,绝不伪造通过),
  // 不计入 fail,也不得因缺前置数据而崩溃。
  const hasPersisted = persisted.length >= 1
  if (hasPersisted) {
    check('恢复的 channel 带 lead 实例', true, `with-lead=${persisted.length}`)
  }
  else {
    console.log('  SKIP  恢复的 channel 带 lead 实例 — 本用户无历史 channel-with-lead(新注册用户看不到他人 Channel);跨重启持久化由独立重启演练覆盖')
  }

  const rt0 = await api('GET', '/api/workshop/runtime')
  check('GET /runtime 形状(懒加载状态)', rt0.code === 0 && Array.isArray(rt0.data?.wiredAgents) && Array.isArray(rt0.data?.activeChannels), `wired=${rt0.data?.wiredAgents?.length} active=${rt0.data?.activeChannels?.length}`)
  const rt0Wired = rt0.data?.wiredAgents?.length ?? 0

  // 详情请求触发 ensureChannelActive(懒加载恢复)
  const probeId = hasPersisted ? persisted[0].id : null
  if (probeId) {
    const probe = await api('GET', `/api/workshop/channels/${probeId}`)
    check('GET /channels/:id 详情(含成员)', probe.code === 0 && Array.isArray(probe.data?.agents) && probe.data.agents.length > 0, `agents=${probe.data?.agents?.length}`)
    const rt1 = await api('GET', '/api/workshop/runtime')
    check('详情请求后 lead 运行时装配(懒加载)', rt1.code === 0 && (rt1.data?.wiredAgents?.length ?? 0) >= rt0Wired, `wired=${rt1.data?.wiredAgents?.length} active=${rt1.data?.activeChannels?.length}`)
    const persistedTasks = await api('GET', `/api/workshop/channels/${probeId}/tasks`)
    check('GET /channels/:id/tasks 恢复历史任务', persistedTasks.code === 0, `tasks=${persistedTasks.data?.length}`)
  }
  else {
    console.log('  SKIP  详情/懒加载装配/历史任务 — 无持久化 channel 可探')
  }

  // ═══════════ 2. AGENT 模板 CRUD ═══════════
  section('AGENT 模板 CRUD(全局定义)')
  const tpl = await api('POST', '/api/workshop/agents', { body: { name: `api-tpl-${tag}`, harness: 'mock', config: { delayMs: 120 } } })
  check('POST /agents 创建模板', tpl.code === 0 && tpl.data?.id, `id=${tpl.data?.id?.slice(0, 8)}`)
  ids.template = tpl.data.id

  const tpl2 = await api('POST', '/api/workshop/agents', { body: { name: `api-tpl2-${tag}`, harness: 'mock' } })
  check('POST /agents 第二个模板', tpl2.code === 0)

  const listA = await api('GET', '/api/workshop/agents')
  check('GET /agents 列表含新模板', listA.code === 0 && listA.data.some(a => a.id === ids.template), `count=${listA.data?.length}`)

  const tplGet = await api('GET', `/api/workshop/agents/${ids.template}`)
  check('GET /agents/:id 详情', tplGet.code === 0 && tplGet.data?.name === `api-tpl-${tag}`)

  const tplPatch = await api('PATCH', `/api/workshop/agents/${ids.template}`, { body: { name: `api-tpl-renamed-${tag}`, enabled: 1 } })
  check('PATCH /agents/:id 更新', tplPatch.code === 0 && tplPatch.data?.name === `api-tpl-renamed-${tag}`)

  const badTpl = await api('POST', '/api/workshop/agents', { body: { name: '', harness: '' } })
  check('POST /agents 校验(name 必填 → 400)', badTpl.status === 400 || badTpl.code !== 0)

  // ═══════════ 3. CHANNEL CRUD + 成员 ═══════════
  section('CHANNEL CRUD + lead/worker 装配')
  const ch = await api('POST', '/api/workshop/channels', {
    body: {
      name: `api-e2e-${tag}`,
      description: 'API live e2e',
      leadAgent: { name: 'api-lead', harness: 'mock', config: { delayMs: 80 } },
    },
  })
  check('POST /channels 创建(含 lead)', ch.code === 0 && ch.data?.leadAgentId, `channel=${ch.data?.channelId?.slice(0, 8)}`)
  ids.channel = ch.data.channelId
  ids.lead = ch.data.leadAgentId

  // lead token 轮换提前到 worker 装配前:下方 goal 用例要以 lead 身份经 REST complete
  // 显式收口(2026-10-30 证据闸,见下)。轮换端点一次性返回,整个生命周期只轮换这一次。
  const rotLead = await api('POST', `/api/workshop/channels/${ids.channel}/agents/${ids.lead}/rotate-token`)
  ids.leadToken = rotLead?.data?.token
  check('lead token 经轮换端点一次性获取', Boolean(ids.leadToken), `rot=${rotLead.status} token=${maskToken(ids.leadToken)}`)

  // ── goal 模式提交与显式收口(2026-10-30 证据闸:完成必须附真实交付物,平台合成的
  //    goal-summary 只是记录、不再算证据)──
  // 刻意安排在 worker 克隆【之前】:频道此时尚无 worker,mock lead 的 goal 剧本找不到
  // 可派发的空闲 worker,只能原地等待 —— 由此确定性消除「脚本 REST complete vs mock lead
  // 自动派发+收口」的竞态(自动收口只会附 goal-summary,新契约下不算证据)。任务一旦
  // COMPLETED 即终态,后续 worker 装配不会再触发对该 goal 的任何派发。
  const gtask = await api('POST', `/api/workshop/channels/${ids.channel}/tasks`, {
    body: { title: `goal-${tag}`, description: '验证 goal 模式全链路', mode: 'goal', modeConfig: { goalCriteria: '全部完成' } },
  })
  check('POST /channels/:id/tasks 提交(goal)', gtask.code === 0 && gtask.data?.id && gtask.data?.state === 'SUBMITTED', `state=${gtask.data?.state}`)
  ids.goalTask = gtask.data.id
  check('任务路由到 lead', gtask.data?.assigneeId === ids.lead)

  // 真实交付物(evidence):name 非 input、非 goal-summary、parts 带非空文本 —— 新证据闸唯一认账的形态
  const goalDeliverable = {
    artifactId: 'e2e-evidence-1',
    name: 'report',
    parts: [{ text: `跨频道验收实测结论(goal-${tag}):主频道 lead 任务列表可见本 goal;异频道 lead 列表不含本 goal;异频道 lead 读本 goal 详情 → 403 SCOPE_VIOLATION。` }],
  }
  const goalComplete = await api('POST', `/api/workshop/tasks/${ids.goalTask}/complete`, {
    token: ids.leadToken,
    body: { artifacts: [goalDeliverable] },
  })
  check('goal REST complete 附真实交付物 → COMPLETED(新证据闸)', goalComplete.code === 0 && goalComplete.data?.state === 'COMPLETED',
    `code=${goalComplete.code} state=${goalComplete.data?.state}`)
  check('goal 提交的真实 artifact 已落库', (goalComplete.data?.artifacts ?? []).some(a => a.artifactId === goalDeliverable.artifactId && a.name === goalDeliverable.name))

  const w = await api('POST', `/api/workshop/channels/${ids.channel}/agents`, { body: { agentId: ids.template, role: 'worker' } })
  check('POST /channels/:id/agents 克隆模板为 worker', w.code === 0 && w.data?.id && w.data?.role === 'worker', `id=${w.data?.id?.slice(0, 8)}`)
  ids.worker = w.data.id

  const w2 = await api('POST', `/api/workshop/channels/${ids.channel}/agents`, { body: { agentId: tpl2.data.id, role: 'worker' } })
  check('POST 第二个 worker', w2.code === 0)

  const members = await api('GET', `/api/workshop/channels/${ids.channel}/agents`)
  check('GET /channels/:id/agents 成员列表', members.code === 0 && members.data.length === 3, `members=${members.data?.length}`)
  // 2026-10-28 安全修复:列表不再回显 agent token(防 worker 冒充 lead);
  // 套件改经"轮换端点一次性取全量 token"(owner/admin 可调,响应只此一次)
  const leadInfo = members.data.find(a => a.id === ids.lead)
  const workerInfo = members.data.find(a => a.id === ids.worker)
  check('成员列表不回显 token(防冒充)', Boolean(leadInfo) && !('token' in leadInfo) && !('token' in workerInfo))
  const rotWorker = await api('POST', `/api/workshop/channels/${ids.channel}/agents/${ids.worker}/rotate-token`)
  ids.workerToken = rotWorker?.data?.token
  check('worker token 经轮换端点一次性获取(auth 基础)', Boolean(ids.workerToken),
    `workerRot=${rotWorker.status} token=${maskToken(ids.workerToken)}`)

  const dupLead = await api('POST', `/api/workshop/channels/${ids.channel}/agents`, { body: { agentId: tpl2.data.id, role: 'lead' } })
  check('第二个 lead → 409 LEAD_EXISTS', dupLead.status === 409 || dupLead.code === 'LEAD_EXISTS', `code=${dupLead.code}`)

  const chGet = await api('GET', `/api/workshop/channels/${ids.channel}`)
  check('GET /channels/:id 详情', chGet.code === 0 && chGet.data?.name === `api-e2e-${tag}`)

  const chPatch = await api('PATCH', `/api/workshop/channels/${ids.channel}`, { body: { name: `api-e2e-rn-${tag}` } })
  check('PATCH /channels/:id 更新', chPatch.code === 0 && chPatch.data?.name === `api-e2e-rn-${tag}`)

  const activate = await api('POST', `/api/workshop/channels/${ids.channel}/activate`)
  check('POST /channels/:id/activate 显式激活', activate.code === 0)

  // ═══════════ 4. TASK goal 收口复核(新证据闸) ═══════════
  section('TASK goal 收口复核 — 真实交付物才算证据')
  // goal 的提交与显式收口发生在第 3 节(worker 装配前,规避 mock lead 自动收口竞态)。
  // 2026-10-30 证据闸后不再有「自动执行至终态」可等:mock lead 自动收口只会附平台同构的
  // goal-summary,新契约下不算证据 —— 断言改为复核显式收口结果与提交的真实 artifact 在场。
  const goalDone = await api('GET', `/api/workshop/tasks/${ids.goalTask}`)
  check('GET /tasks/:id 详情(管理面,无 token)', goalDone.code === 0 && goalDone.data?.id === ids.goalTask)
  check('goal 任务终态 COMPLETED(lead 显式收口)', goalDone.data?.state === 'COMPLETED', `state=${goalDone.data?.state} progress=${goalDone.data?.progress}`)
  check('goal 任务含成果 artifacts', Array.isArray(goalDone.data?.artifacts) && goalDone.data.artifacts.length > 0, `artifacts=${goalDone.data?.artifacts?.length}`)
  check('goal 真实交付物在 artifacts(平台 goal-summary 只是记录)', goalDone.data?.artifacts?.some(a => a.artifactId === 'e2e-evidence-1' && a.name === 'report'))
  check('详情含 history 数组', Array.isArray(goalDone.data?.history), `history=${goalDone.data?.history?.length}`)

  // ═══════════ 5. TASK 作用域 + dispatch/report/complete ═══════════
  section('TASK 作用域校验 + dispatch/report/complete 状态机')
  const scoped = await api('GET', '/api/workshop/tasks', { token: ids.workerToken })
  check('带 token 拉取本 channel 任务', scoped.code === 0 && scoped.data.length >= 1, `tasks=${scoped.data?.length}`)

  const badToken = await api('GET', '/api/workshop/tasks', { token: 'deadbeef' })
  check('无效 token → 401', badToken.status === 401, `status=${badToken.status}`)

  // 跨 channel 作用域(2026-10-28 安全修复后 member 列表不再回显 token —— 旧实现经
  // probeId 成员列表取 lead token 恒为 undefined,api() 静默回落用户 token → 401 也能
  // 满足旧 OR 断言,空转假阳性)。正道:现建一次性 B 频道(独立于 probeId/持久化数据,
  // 不依赖跨重启遗留状态),经轮换端点取 B lead 的有效 Agent token,做三条正/负断言。
  const chB = await api('POST', '/api/workshop/channels', {
    body: {
      name: `api-e2e-b-${tag}`,
      description: '跨频道作用域负例专用(一次性)',
      leadAgent: { name: 'api-lead-b', harness: 'mock', config: { delayMs: 80 } },
    },
  })
  check('创建一次性 B 频道(跨频道负例)', chB.code === 0 && chB.data?.leadAgentId, `channel=${chB.data?.channelId?.slice(0, 8)}`)
  ids.channelB = chB.data.channelId
  ids.leadB = chB.data.leadAgentId
  const rotLeadB = await api('POST', `/api/workshop/channels/${ids.channelB}/agents/${ids.leadB}/rotate-token`)
  ids.leadBToken = rotLeadB?.data?.token
  check('B lead token 经轮换端点一次性获取', Boolean(ids.leadBToken), `rot=${rotLeadB.status} token=${maskToken(ids.leadBToken)}`)

  // ① A(主频道)lead token 列表 → 200 且包含 A 自己的 goal task id(同 channel 可见)
  const scopeA = await api('GET', '/api/workshop/tasks', { token: ids.leadToken })
  check('A lead token 列表 → 200 且含本频道 goal 任务', scopeA.status === 200 && scopeA.code === 0
  && Array.isArray(scopeA.data) && scopeA.data.some(t => t.id === ids.goalTask),
  `status=${scopeA.status} tasks=${scopeA.data?.length}`)
  // ② B lead token 列表 → 200(code=0)但不含 A 的 goal task id(列表按 caller channel 过滤)
  const scopeB = await api('GET', '/api/workshop/tasks', { token: ids.leadBToken })
  check('B lead token 列表 → 200 且不含 A 的 goal 任务', scopeB.status === 200 && scopeB.code === 0
  && Array.isArray(scopeB.data) && !scopeB.data.some(t => t.id === ids.goalTask),
  `status=${scopeB.status} tasks=${scopeB.data?.length}`)
  // ③ B lead token 读 A 的 goal task 详情 → 精确 403 + SCOPE_VIOLATION(401/其它码不算过)
  const crossed = await api('GET', `/api/workshop/tasks/${ids.goalTask}`, { token: ids.leadBToken })
  check('跨 channel 读任务详情 → 精确 403 SCOPE_VIOLATION', crossed.status === 403 && crossed.code === 'SCOPE_VIOLATION',
    `status=${crossed.status} code=${crossed.code}`)

  // dispatch 状态机:提交新父任务 → 等 lead 自动派发第 1 个子任务(父转 WAITING)
  // → API 手工 dispatch 第 2 个子任务(WAITING 父上允许) → 全部完成后父汇总
  //
  // 必须显式要求委派:平台的既定行为是「简单任务 Lead 直接完成」(见设计文档 §10 Real OMP 第 1 项),
  // 一步就能做完的父任务不会被派发子任务 —— 断言不能依赖模型的一次性判断。
  const ptask = await api('POST', `/api/workshop/channels/${ids.channel}/tasks`, {
    body: {
      title: `parent-${tag}`,
      description: '父任务聚合验证:本任务必须分解为可并行的子任务,先派发给 worker 执行,等待子任务全部完成后由 lead 汇总收口。不要自己直接完成。',
    },
  })
  check('提交父任务(用于 dispatch)', ptask.code === 0 && ptask.data?.id)
  ids.parentTask = ptask.data.id

  const autoChild = await waitUntil('lead 自动派发第 1 个子任务(父→WAITING)', async () => {
    const t = await api('GET', `/api/workshop/tasks/${ids.parentTask}`)
    const children = await api('GET', `/api/workshop/channels/${ids.channel}/tasks`)
    const kids = (children.data ?? []).filter(x => x.parentId === ids.parentTask)
    return kids.length > 0 && t.data?.state === 'WAITING' ? kids : null
  }, 15_000)
  // mock/真实 lead 可能一次派发多个子任务(空闲 worker 数决定),断言只要求"至少一个自动子任务"
  check('lead 自动派发子任务', autoChild.length >= 1, `autoChild=${autoChild.length}(${autoChild[0]?.id?.slice(0, 8)})`)

  const subtask = await api('POST', `/api/workshop/tasks/${ids.parentTask}/dispatch`, {
    token: ids.leadToken,
    body: { assigneeId: ids.worker, title: `manual-child-${tag}`, description: 'API 手工派发' },
  })
  check('POST /tasks/:id/dispatch 手工派发第 2 个子任务', subtask.code === 0 && subtask.data?.parentId === ids.parentTask, `child=${subtask.data?.id?.slice(0, 8)}`)
  ids.childTask = subtask.data.id

  // worker 上报进度(带 message → 写入 history)
  const rep = await api('POST', `/api/workshop/tasks/${ids.childTask}/report`, {
    token: ids.workerToken,
    body: { progress: 42, message: `人工上报-${tag}` },
  })
  check('POST /tasks/:id/report 上报进度', rep.code === 0 && typeof rep.data?.progress === 'number' && rep.data.progress <= 100, `progress=${rep.data?.progress}`)

  const childDone = await waitUntil('子任务 COMPLETED(worker 剧本)', async () => {
    const t = await api('GET', `/api/workshop/tasks/${ids.childTask}`, { token: ids.workerToken })
    return t.data && (t.data.state === 'COMPLETED' || t.data.state === 'FAILED') ? t.data : null
  }, 15_000)
  check('子任务执行至 COMPLETED', childDone.state === 'COMPLETED', `state=${childDone.state}`)
  const childDetail = await api('GET', `/api/workshop/tasks/${ids.childTask}`)
  check('上报 message 已写入任务 history', (childDetail.data?.history ?? []).some(h => JSON.stringify(h.parts).includes(`人工上报-${tag}`)), `history=${childDetail.data?.history?.length}`)

  // 完成父任务(lead 剧本:子任务全完成 → complete 父)
  const parentDone = await waitUntil('父任务汇总 COMPLETED(两个子任务)', async () => {
    const t = await api('GET', `/api/workshop/tasks/${ids.parentTask}`)
    return t.data && (t.data.state === 'COMPLETED' || t.data.state === 'FAILED') ? t.data : null
  }, 15_000)
  check('父任务自动汇总 COMPLETED', parentDone.state === 'COMPLETED', `state=${parentDone.state}`)

  // complete 状态机:已完成任务再次 complete → 终态幂等(产品刻意支持:防御 Agent/重试重复收口,
  // 与 omp-agent complete_task 的"任务可能已被平台收口,不可重复完成"引导一致):
  // 或 400 INVALID_TRANSITION(旧语义)或 200 code=0 返回原已终态任务(新语义)。
  const reComplete = await api('POST', `/api/workshop/tasks/${ids.childTask}/complete`, {
    token: ids.workerToken,
    body: { artifacts: [{ artifactId: 'a1', name: 'x', parts: [{ text: 'y' }] }] },
  })
  check('终态重复 complete → 幂等成功或 400', reComplete.status === 400
  || reComplete.code === 'INVALID_TRANSITION'
  || (reComplete.code === 0 && reComplete.data?.state === 'COMPLETED'),
  `code=${reComplete.code} state=${reComplete.data?.state}`)

  // ═══════════ 6. cancel 状态机 ═══════════
  section('TASK cancel(系统身份回收)')
  const ctask = await api('POST', `/api/workshop/channels/${ids.channel}/tasks`, {
    body: { title: `cancel-me-${tag}`, description: '将被取消' },
  })
  check('提交待取消任务', ctask.code === 0)
  // 时序现实:mock lead 对一步任务会在首个监督回合直接收口(设计行为),取消请求可能
  // 输掉这场竞态。两种结局都必须正确 —— 仍在途 → CANCELED;已终态 → 终态护栏拒绝
  // (绝不能把 COMPLETED 静默改写为 CANCELED)。断言按实际到场状态分支。
  const preCancel = await api('GET', `/api/workshop/tasks/${ctask.data.id}`)
  const wasOpen = !!preCancel.data && !['COMPLETED', 'FAILED', 'CANCELED'].includes(preCancel.data.state)
  const cancel = await api('POST', `/api/workshop/tasks/${ctask.data.id}/cancel`)
  const cancelAgain = await api('POST', `/api/workshop/tasks/${ctask.data.id}/cancel`)
  if (wasOpen) {
    check('POST /tasks/:id/cancel → CANCELED', cancel.code === 0 && cancel.data?.state === 'CANCELED', `state=${cancel.data?.state}`)
    // 已 CANCELED 的任务重复取消 = 幂等成功(与 TaskEngine.cancel 的既有语义一致)
    check('重复 cancel 幂等(仍 CANCELED)', cancelAgain.code === 0 && cancelAgain.data?.state === 'CANCELED', `state=${cancelAgain.data?.state}`)
  }
  else {
    check('已终态任务的 cancel 被终态护栏拒绝(不改写 COMPLETED)',
      cancel.status === 409 && cancel.code === 'TASK_TERMINAL',
      `status=${cancel.status} code=${cancel.code} state=${cancel.data?.state}`)
    check('重复 cancel 仍被拒绝', cancelAgain.status === 409 && cancelAgain.code === 'TASK_TERMINAL',
      `status=${cancelAgain.status} code=${cancelAgain.code}`)
  }

  // ═══════════ 7. loop 模式(限次) ═══════════
  section('TASK loop 模式(LoopController 限次重放)')
  const loop = await api('POST', `/api/workshop/channels/${ids.channel}/tasks`, {
    body: {
      title: `loop-${tag}`,
      description: 'loop 模式限次验证',
      mode: 'loop',
      modeConfig: { intervalMs: 300, maxIterations: 2 },
    },
  })
  check('POST 提交(loop, max=2)', loop.code === 0 && loop.data?.id, `id=${loop.data?.id?.slice(0, 8)}`)
  ids.loopTask = loop.data.id

  // loop 重放 = 同标题新任务被再次创建;等 2 次迭代后所有 loop 任务终态
  const loopDone = await waitUntil('loop 迭代重放并全部完成', async () => {
    const t = await api('GET', `/api/workshop/channels/${ids.channel}/tasks`)
    const loops = (t.data ?? []).filter(x => x.title === `loop-${tag}`)
    if (loops.length < 2) return null
    return loops.every(x => x.state === 'COMPLETED' || x.state === 'FAILED') ? loops : null
  }, 25_000)
  check('loop 重放 ≥2 次且全部终态', Array.isArray(loopDone) && loopDone.length >= 2, `iterations=${loopDone?.length}`)

  // ═══════════ 8. pipeline 模式(提交与元数据) ═══════════
  section('TASK pipeline 模式(提交 + 模式元数据)')
  const pipe = await api('POST', `/api/workshop/channels/${ids.channel}/tasks`, {
    body: {
      title: `pipe-${tag}`,
      description: '流水线验证',
      mode: 'pipeline',
      modeConfig: { stages: [{ name: 'stage-A', description: '阶段A' }, { name: 'stage-B', description: '阶段B' }] },
    },
  })
  check('POST 提交(pipeline)', pipe.code === 0 && pipe.data?.id)
  const pipeDetail = await api('GET', `/api/workshop/tasks/${pipe.data.id}`)
  const meta = pipeDetail.data?.metadata ?? {}
  check('pipeline 模式元数据编码(mode/stages)', meta['x-aw-exec-mode'] === 'pipeline' || String(pipeDetail.data?.description ?? '').includes('pipeline'), `desc=${String(pipeDetail.data?.description ?? '').slice(0, 80)}`)
  const pipeDone = await waitUntil('pipeline 任务执行至终态', async () => {
    const t = await api('GET', `/api/workshop/tasks/${pipe.data.id}`)
    return t.data && (t.data.state === 'COMPLETED' || t.data.state === 'FAILED') ? t.data : null
  }, 20_000)
  check('pipeline 执行至 COMPLETED', pipeDone.state === 'COMPLETED', `state=${pipeDone.state}`)

  // ═══════════ 9. a2a + mailbox + 消息 ═══════════
  section('A2A 点对点 + mailbox + channel 消息历史')
  const a2a = await api('POST', '/api/workshop/a2a/send', {
    token: ids.workerToken,
    body: { toAgentId: ids.lead, parts: [{ text: `hello-lead-${tag}` }], metadata: { via: 'api-e2e' } },
  })
  check('POST /a2a/send worker→lead', a2a.code === 0 && a2a.data?.messageId, `msg=${a2a.data?.messageId?.slice(0, 8)}`)

  // mock lead 空闲即消费(consumeLoop),pending 队列瞬时清空属正常;
  // 持久化证据 = channel 消息历史(含 from/to 路由)
  const mb = await api('GET', '/api/workshop/mailbox?limit=20', { token: ids.leadToken })
  check('GET /mailbox 端点形状(可拉取队列)', mb.code === 0 && Array.isArray(mb.data), `pending=${mb.data?.length}`)
  const a2aHistory = await api('GET', `/api/workshop/channels/${ids.channel}/messages?limit=50`)
  const a2aMsg = (a2aHistory.data ?? []).find(m => JSON.stringify(m.parts).includes(`hello-lead-${tag}`))
  check('a2a 消息持久化到 channel 历史(from/to 正确)', Boolean(a2aMsg && a2aMsg.fromAgentId === ids.worker && a2aMsg.toAgentId === ids.lead), `from=${a2aMsg?.fromAgentId?.slice(0, 8)} to=${a2aMsg?.toAgentId?.slice(0, 8)}`)
  check('API messageId == 历史 id(可关联)', a2aMsg?.id === a2a.data.messageId, `api=${a2a.data.messageId?.slice(0, 8)} hist=${a2aMsg?.id?.slice(0, 8)}`)

  const badA2a = await api('POST', '/api/workshop/a2a/send', {
    token: ids.workerToken,
    body: { toAgentId: 'not-exist', parts: [{ text: 'x' }] },
  })
  check('a2a 目标不存在 → 404/校验失败', badA2a.status === 404 || badA2a.code !== 0, `status=${badA2a.status}`)

  const msg = await api('POST', `/api/workshop/channels/${ids.channel}/messages`, {
    body: { toAgentId: ids.worker, text: `immediate-${tag}`, priority: 'immediate' },
  })
  check('POST /channels/:id/messages immediate 注入', msg.code === 0, `code=${msg.code}`)

  const history = await api('GET', `/api/workshop/channels/${ids.channel}/messages?limit=50`)
  check('GET /channels/:id/messages 历史含新消息', history.code === 0 && history.data?.some(m => JSON.stringify(m.parts).includes(`immediate-${tag}`)), `msgs=${history.data?.length}`)

  const sub = await api('POST', '/api/workshop/agents/subscribe', {
    token: ids.workerToken,
    body: { agentIds: [ids.lead] },
  })
  check('POST /agents/subscribe 订阅', sub.code === 0 && sub.data?.subscribed === true)

  // ═══════════ 10. WebSocket Hub 增量广播 ═══════════
  section('WebSocket Hub — 前端观察入口')
  const wsEvents = []
  const ws = new WebSocket(`${WS_BASE}/api/workshop/ws?channelId=${ids.channel}&token=${encodeURIComponent(__userToken)}`)
  const wsReady = new Promise((resolve, reject) => {
    ws.onopen = () => resolve(true)
    ws.onerror = e => reject(new Error(`ws error: ${JSON.stringify(e.message ?? e)}`))
    ws.onmessage = (ev) => {
      try {
        wsEvents.push(JSON.parse(ev.data))
      }
      catch {
        // 忽略非 JSON 帧
      }
    }
  })
  await Promise.race([wsReady, sleep(4000).then(() => Promise.reject(new Error('ws open timeout')))])
  check('WS 连接成功', true)

  // 提交新任务观察广播
  const wsTask = await api('POST', `/api/workshop/channels/${ids.channel}/tasks`, {
    body: { title: `ws-${tag}`, description: 'ws 广播验证' },
  })
  await waitUntil('WS 收到 task.status/progress 事件', async () => {
    return wsEvents.some(e => (e.type === 'task.status' || e.type === 'task.progress') && JSON.stringify(e.payload).includes(wsTask.data.id)) ? true : null
  }, 15_000)
  const hasTaskEvents = wsEvents.some(e => (e.type === 'task.status' || e.type === 'task.progress'))
  // a2a 事件与 task.status 几乎同时到达但顺序不定(事件驱动直推),带短窗口等待消除竞态
  const hasA2aEvents = await waitUntil('WS a2a 事件', async () => {
    return wsEvents.some(e => (e.type === 'a2a.artifact' || e.type === 'a2a.message')) ? true : null
  }, 5000).then(() => true, () => false)
  const hasAgentEvents = wsEvents.some(e => e.type === 'agent.status')
  check('WS 广播 task.status/task.progress', hasTaskEvents, `events=${wsEvents.map(e => e.type).join(',')}`)
  check('WS 广播 a2a.artifact/a2a.message', hasA2aEvents)
  // agent.status 为 500ms 快照 diff:mock worker busy 窗口(~400ms)可能夹在两帧之间,
  // 用慢 worker 单独验证过 diff 机制(busy/idle 均会广播);此处仅记录不判失败
  console.log(`  INFO  agent.status diff 事件(mock 忙窗口 < 500ms 轮询时可能不出现): ${hasAgentEvents ? '出现' : '未出现'}`)
  const wsTaskDone = await waitUntil('ws 任务终态', async () => {
    const t = await api('GET', `/api/workshop/tasks/${wsTask.data.id}`)
    return t.data && (t.data.state === 'COMPLETED' || t.data.state === 'FAILED') ? t.data : null
  }, 20_000)
  check('ws 任务执行完成', wsTaskDone.state === 'COMPLETED', `state=${wsTaskDone.state}`)
  ws.close()

  // ═══════════ 11. MCP Streamable HTTP(Agent harness 作业面) ═══════════
  section('MCP 端点 — initialize 会话建立')
  const mcpRes = await fetch(`${BASE}/api/mcp/workshop`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'accept': 'application/json, text/event-stream' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-03-26',
        capabilities: {},
        clientInfo: { name: 'api-e2e', version: '1.0.0' },
      },
    }),
  })
  const mcpBody = await mcpRes.text()
  const mcpOk = mcpRes.status === 200 && mcpBody.includes('serverInfo')
  check('POST /api/mcp/workshop initialize', mcpOk, `status=${mcpRes.status} hasServerInfo=${mcpBody.includes('serverInfo')}`)
  const mcpSid = mcpRes.headers.get('mcp-session-id')
  check('MCP 会话 id 下发(状态复用)', Boolean(mcpSid), `sid=${mcpSid?.slice(0, 8)}`)
  if (mcpSid) {
    const toolsRes = await fetch(`${BASE}/api/mcp/workshop`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'accept': 'application/json, text/event-stream', 'mcp-session-id': mcpSid },
      body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }),
    })
    const toolsBody = await toolsRes.text()
    const toolCount = (toolsBody.match(/"name":"/g) ?? []).length
    check('MCP tools/list 返回工具集', toolCount > 0, `tools≈${toolCount}`)
    // 清理会话
    await fetch(`${BASE}/api/mcp/workshop?sessionId=${mcpSid}`, { method: 'DELETE' })
  }

  // ═══════════ 12. 清理(删除本测试数据) ═══════════
  section('清理与级联删除')
  const delCh = await api('DELETE', `/api/workshop/channels/${ids.channel}`)
  check('DELETE /channels/:id 级联删除', delCh.code === 0 && delCh.data?.ok === true)
  const delChB = await api('DELETE', `/api/workshop/channels/${ids.channelB}`)
  check('DELETE B 频道(一次性跨频道负例清理)', delChB.code === 0 && delChB.data?.ok === true, `code=${delChB.code}`)
  const delTpl = await api('DELETE', `/api/workshop/agents/${ids.template}`)
  check('DELETE /agents/:id', delTpl.code === 0)
  await api('DELETE', `/api/workshop/agents/${tpl2.data.id}`)
  const afterCh = await api('GET', '/api/workshop/channels')
  check('删除后 channel 列表回退(旧数据保留)', afterCh.code === 0 && !afterCh.data.some(c => c.id === ids.channel), `count=${afterCh.data?.length}`)
  check('B 频道已从列表移除', afterCh.code === 0 && !afterCh.data.some(c => c.id === ids.channelB))

  // ═══════════ 结果 ═══════════
  console.log(`\n${failures === 0 ? '★ ALL PASS' : `✗ ${failures} FAILED`}  (${passed} passed)`)
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error('\n[api-live-e2e] 异常中止:', e)
  process.exit(2)
})
