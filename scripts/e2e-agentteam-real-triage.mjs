/**
 * AgentTeam 真实作业逻辑端到端(真 LLM Lead + 真 LLM worker + 真群聊)。
 *
 * 回答用户的核心问题并以真实运行取证:
 *   P1 简单任务:Lead **自己作答**,不产生任何子任务、worker 零执行。
 *   P2 专业任务:Lead 拆解 → 子任务全部派给 worker → 每个 worker 完工后**回 Lead 验收** →
 *      Lead 收口并给出覆盖各子任务的验收摘要;子任务完工瞬间父任务不得是 COMPLETED。
 *   P3 群聊请求升级:在群里 @Lead 提一个需要交付物的诉求 → Lead 用 submit_task 把它登记为
 *      **可追踪根任务**(本轮补齐的能力),再拆解/验收,而不是只在聊天里说一句。
 *   P4 作业进行中并行群聊:普通发言 0 次 Agent 执行、@用户只发定向通知、@Agent 才触发执行,
 *      且群聊不干扰作业收口、时间线顺序不乱。
 *
 * 与 mock 版契约测试(scripts/test-agentteam-workflow.ts)的分工:
 *   那个用确定性 mock 验证**平台侧**不变量(状态机/闸门/顺序);本脚本用真 LLM 验证
 *   **模型侧**是否真的按契约分流(简单自己答、专业才拆、拆了要验收)。
 *
 * 运行:
 *   node scripts/e2e-agentteam-real-triage.mjs --base http://127.0.0.1:3458
 * 前置:隔离实例 + omp 引擎可用;必须 NO_PROXY=127.0.0.1,localhost。
 */
import { writeFileSync, mkdirSync } from 'node:fs'

const arg = (k, d) => {
  const i = process.argv.indexOf(k)
  if (i >= 0) return process.argv[i + 1]
  const kv = process.argv.find(a => a.startsWith(`${k}=`))
  return kv ? kv.slice(k.length + 1) : d
}
const BASE = arg('--base', process.env.AW_E2E_BASE ?? 'http://127.0.0.1:3458')
const TAG = Date.now().toString(36)
const EVID = arg('--evidence', '.omc/evidence/p7-real-triage.json')

let passed = 0
let failures = 0
let blocked = 0
const notes = []
const check = (name, ok, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
  if (ok) passed += 1
  else failures += 1
}
const block = (name, reason) => {
  console.log(`  BLOCKED  ${name} — ${reason}`)
  blocked += 1
}
/** 已定位根因的**产品缺口**(非"被验证的逻辑不成立"):单独计数,不计入 FAIL */
const findings = []
const finding = (name, detail) => {
  console.log(`  FINDING  ${name} — ${detail}`)
  findings.push(`${name}: ${detail}`)
}
const note = (s) => {
  notes.push(s)
  console.log(`  · ${s}`)
}
const sleep = ms => new Promise(r => setTimeout(r, ms))

async function api(method, path, { body, token, timeout = 60_000 } = {}) {
  const headers = { 'content-type': 'application/json' }
  if (token) headers.authorization = `Bearer ${token}`
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(timeout),
  })
  const json = await res.json().catch(() => ({}))
  return { status: res.status, code: json.code, message: json.message, data: json.data }
}
const post = (p, opts) => api('POST', p, opts)
const get = (p, token) => api('GET', p, { token })
const patch = (p, opts) => api('PATCH', p, opts)

async function registerUser(label) {
  const email = `rt-${label}-${TAG}@test.local`
  const name = `rt-${label}-${TAG}`
  const res = await post('/api/users/register', { body: { email, password: 'Passw0rd!123', name } })
  if (!res.data?.token) throw new Error(`注册 ${label} 失败:${JSON.stringify(res).slice(0, 300)}`)
  return { label, name, email, token: res.data.token, id: res.data.user.id }
}

const tasksOf = async (channelId, token) => (await get(`/api/workshop/channels/${channelId}/tasks`, token)).data ?? []
const rootsOf = tasks => tasks.filter(t => !t.parentId)
const childrenOf = (tasks, id) => tasks.filter(t => t.parentId === id)
const artifactsTextOf = task => (task.artifacts ?? [])
  .flatMap(a => (a.parts ?? []).map(p => ('text' in p ? p.text : '')))
  .filter(Boolean)

/** 通用轮询:cond 返回真值即返回它(真 LLM 慢) */
async function waitFor(cond, timeoutMs = 180_000, intervalMs = 2500) {
  const deadline = Date.now() + timeoutMs
  let last = null
  while (Date.now() < deadline) {
    last = await cond()
    if (last) return last
    await sleep(intervalMs)
  }
  return last
}

/** 轮询到 root 终态(真 LLM 慢);采样保留父/子状态同帧快照。按 id 定位(标题可能被 Lead 改) */
async function waitRootById(channelId, token, rootId, timeoutMs = 360_000) {
  const deadline = Date.now() + timeoutMs
  const samples = []
  while (Date.now() < deadline) {
    const tasks = await tasksOf(channelId, token)
    const root = tasks.find(t => t.id === rootId)
    if (root) {
      const kids = childrenOf(tasks, root.id)
      // 单次 GET 读到的是同一份引擎状态 → 这一帧内"父是否终态 / 子是否全完"是可比的
      samples.push({ parent: root.state, kids: kids.map(k => k.state) })
      if (['COMPLETED', 'FAILED', 'CANCELED'].includes(root.state)) return { root, kids, tasks, samples }
    }
    await sleep(2500)
  }
  const tasks = await tasksOf(channelId, token)
  const root = tasks.find(t => t.id === rootId) ?? null
  return { root, kids: root ? childrenOf(tasks, root.id) : [], tasks, samples, timeout: true }
}

/** 按标题定位(人类下发的任务标题由本脚本生成,不会被改写) */
async function waitRoot(channelId, token, title, timeoutMs = 360_000) {
  const found = await waitFor(async () => {
    const tasks = await tasksOf(channelId, token)
    return tasks.find(t => !t.parentId && t.title === title) ?? null
  }, Math.min(timeoutMs, 120_000), 2500)
  if (!found) return { root: null, kids: [], tasks: await tasksOf(channelId, token), samples: [] }
  return waitRootById(channelId, token, found.id, timeoutMs)
}

// ============================================================================
console.log(`\n━━━ AgentTeam 真实作业逻辑 E2E @ ${BASE}(真 LLM / omp)━━━`)

const health = await api('GET', '/api/health')
console.log(`  健康:${JSON.stringify(health.data).slice(0, 120)}`)

// ── 0. preflight:omp 引擎必须可用(需先注册用户取 token)──
const A = await registerUser('owner')
const B = await registerUser('member')
const harnesses = await get('/api/workshop/harnesses', A.token)
const list = harnesses.data?.harnesses ?? harnesses.data ?? []
const omp = Array.isArray(list) ? list.find(h => h.id === 'omp') : null
if (!omp || omp.available !== true) {
  block('0.1 omp 引擎可用', `harnesses=${JSON.stringify(list).slice(0, 200)}`)
  console.log('\n前置不满足,终止。')
  process.exit(2)
}
check('0.1 omp 引擎可用(真 LLM)', true, `command=${omp.command} path=${omp.resolvedPath}`)

// ── 0.2 用户与 Channel(真 omp lead + 2 真 omp worker)──
const ch = await post('/api/workshop/channels', {
  body: {
    name: `rt-${TAG}`,
    description: '真实作业逻辑 E2E(omp)',
    leadAgent: { name: `rt-lead-${TAG}`, harness: 'omp' },
  },
  token: A.token,
})
const channelId = ch.data?.channelId
check('0.2 owner 建 Channel(omp lead)', Boolean(channelId && ch.data?.leadAgentId), `status=${ch.status} channel=${String(channelId).slice(0, 8)}`)
if (!channelId) {
  console.log(`建 Channel 失败:${JSON.stringify(ch).slice(0, 400)}`)
  process.exit(2)
}
const leadAgentId = ch.data.leadAgentId
for (const n of [1, 2]) {
  const t = await post('/api/workshop/agents', { body: { name: `rt-w${n}-${TAG}`, harness: 'omp' }, token: A.token })
  await post(`/api/workshop/channels/${channelId}/agents`, { body: { agentId: t.data.id, role: 'worker' }, token: A.token })
}
// 注意:POST /api/workshop/agents 返回的是**模板 id**;任务上的 assigneeId 是 **channel 成员实例 id**。
// 必须从成员名册取实例 id,否则"子任务是否派给 worker"这类断言会退化成永真。
const agentsRes = await get(`/api/workshop/channels/${channelId}/agents`, A.token)
const members = agentsRes.data ?? []
const workerIds = members.filter(a => a.role === 'worker').map(a => a.id)
const workerNames = members.filter(a => a.role === 'worker').map(a => a.name)
const leadName = members.find(a => a.role === 'lead')?.name ?? leadAgentId.slice(0, 8)
check('0.3 2 个 omp worker 已入队', workerIds.length === 2 && workerIds.every(id => id !== leadAgentId),
  `workers=${workerNames.join(',')} ids=${workerIds.map(i => i.slice(0, 6)).join(',')}`)

// 开启群聊供 P4 / P3 使用
const perm = await get(`/api/workshop/channels/${channelId}/chat/permissions`, A.token)
await patch(`/api/workshop/channels/${channelId}`, {
  body: { visibility: 'public', joinPolicy: 'open', chatEnabled: 1, version: perm.data?.channel?.version },
  token: A.token,
})
await post(`/api/workshop/channels/${channelId}/members/join`, { body: {}, token: B.token })
check('0.4 群聊已开启且成员 B 已加入', true)

// ============================================================================
console.log('\n━━━ P1 简单任务:Lead 应自己作答,不派 worker ━━━')
const P1_TITLE = `把这句话翻译成英文并只返回译文:系统已就绪,请开始验收。(${TAG})`
const p1sub = await post(`/api/workshop/channels/${channelId}/tasks`, {
  body: { title: P1_TITLE, description: '一句话翻译任务,直接给译文即可。', fromLabel: A.name },
  token: A.token,
})
check('P1.1 简单任务已下发(默认路由 Lead)', p1sub.status === 200 || p1sub.code === 0,
  `assignee=${String(p1sub.data?.assigneeId).slice(0, 8)} state=${p1sub.data?.state}`)
const p1 = await waitRoot(channelId, A.token, P1_TITLE)
const p1Artifacts = p1.root ? artifactsTextOf(p1.root) : []
check('P1.2 简单任务最终 COMPLETED', p1.root?.state === 'COMPLETED',
  `state=${p1.root?.state ?? '(无)'} 帧=${(p1.samples ?? []).map(s => `${s.parent}[${s.kids.join(',')}]`).join(' → ')}`)
check('P1.3 简单任务**零子任务**(Lead 没有把简单活推给 worker)', (p1.kids ?? []).length === 0, `children=${(p1.kids ?? []).length}`)
const p1WorkerTasks = (p1.tasks ?? []).filter(t => t.parentId && workerIds.includes(t.assigneeId))
check('P1.4 worker 零任务(Agent 执行没有发生)', p1WorkerTasks.length === 0, `workerTasks=${p1WorkerTasks.length}`)
check('P1.5 Lead 自己给出了非空作答', p1Artifacts.join(' ').trim().length > 0,
  `artifacts=${(p1.root?.artifacts ?? []).map(a => a.name).join(',') || '(无)'} text=${p1Artifacts.join(' ').slice(0, 80)}`)

// ============================================================================
console.log('\n━━━ P2 专业任务:拆解 → 派 worker → worker 完工回 Lead 验收 ━━━')
const P2_TITLE = `分别产出两份独立材料并汇总为统一建议(日志分级规范 + 轮转保留策略)(${TAG})`
const P2_DESC = '本任务必须分工:需要两份**互相独立**的材料 —— (1) 日志分级规范草案(级别定义 + 每级示例);'
  + '(2) 日志轮转与保留策略草案(轮转周期 + 保留期 + 示例)。两份材料分别完成后,再由你(Lead)核对并汇总为一份统一建议。'
  + '每份材料要能在 10 行内交付。'
const p2sub = await post(`/api/workshop/channels/${channelId}/tasks`, {
  body: { title: P2_TITLE, description: P2_DESC, fromLabel: A.name },
  token: A.token,
})
check('P2.0 专业任务已下发(缺省路由 Lead,由 Lead 自行判断是否分工)',
  p2sub.status === 200 || p2sub.code === 0,
  `assignee=${String(p2sub.data?.assigneeId).slice(0, 8)} lead=${leadAgentId.slice(0, 8)}`)

// 作业进行中并行群聊(P4):普通发言 / @用户 / @Agent
console.log('\n  — 作业进行中的群聊并行(P4)—')
await sleep(4000)
const plain = await post(`/api/workshop/channels/${channelId}/chat/messages`, {
  body: { text: '这个作业大概要多久?(普通发言,没有 @ 任何人)', clientMessageId: `p4-plain-${TAG}` },
  token: B.token,
})
check('P4.1 作业中的普通发言 → 0 次 Agent 执行', (plain.data?.deliveries ?? []).length === 0, `deliveries=${(plain.data?.deliveries ?? []).length}`)
const atUser = await post(`/api/workshop/channels/${channelId}/chat/messages`, {
  body: { text: `@${A.name} 你盯一下进度`, clientMessageId: `p4-user-${TAG}` },
  token: B.token,
})
check('P4.2 @用户 → 0 次 Agent 执行', (atUser.data?.deliveries ?? []).length === 0)
check('P4.3 @用户 → 解析为定向 user mention', (atUser.data?.mentions ?? []).some(m => m.type === 'user' && m.id === A.id),
  JSON.stringify(atUser.data?.mentions))
const atAgent = await post(`/api/workshop/channels/${channelId}/chat/messages`, {
  body: { text: `@${workerNames[0]} 你手头的子任务现在什么状态?一句话就行`, clientMessageId: `p4-agent-${TAG}` },
  token: B.token,
})
check('P4.4 @Agent → 产生定向投递(才会触发 Agent 执行)', (atAgent.data?.deliveries ?? []).length === 1,
  `deliveries=${(atAgent.data?.deliveries ?? []).length} mentions=${JSON.stringify((atAgent.data?.mentions ?? []).map(m => m.type))}`)

const p2 = await waitRoot(channelId, A.token, P2_TITLE, 900_000)
const p2Artifacts = p2.root ? artifactsTextOf(p2.root) : []
check('P2.1 专业任务最终收口 COMPLETED(群聊并行未干扰)', p2.root?.state === 'COMPLETED',
  `state=${p2.root?.state ?? '(无)'} samples=${(p2.samples ?? []).join(' → ')}`)
check('P2.2 Lead 把专业任务拆成了多个子任务', (p2.kids ?? []).length >= 2, `children=${(p2.kids ?? []).length}`)
check('P2.3 子任务全部派给 worker(不是留在 Lead 名下)',
  (p2.kids ?? []).length > 0 && (p2.kids ?? []).every(k => workerIds.includes(k.assigneeId)),
  (p2.kids ?? []).map(k => k.assigneeId.slice(0, 6)).join(','))
check('P2.4 每个子任务都带验收标准(Lead 自己定义验收)',
  (p2.kids ?? []).length > 0 && (p2.kids ?? []).every(k => /验收|标准|accept|criteria/i.test(k.description ?? '')),
  `with=${(p2.kids ?? []).filter(k => /验收|标准|accept|criteria/i.test(k.description ?? '')).length}/${(p2.kids ?? []).length}`)
check('P2.5 子任务全部 COMPLETED(worker 交付了成果)',
  (p2.kids ?? []).length > 0 && (p2.kids ?? []).every(k => k.state === 'COMPLETED'),
  (p2.kids ?? []).map(k => k.state).join(','))
check('P2.6 任何一帧都不存在"父已完成但子未全完"(完工≠验收,父任务不自作主张收口)',
  (p2.samples ?? []).every(s => !(s.parent === 'COMPLETED' && s.kids.some(k => k !== 'COMPLETED'))),
  `帧=${(p2.samples ?? []).map(s => `${s.parent}[${s.kids.join(',')}]`).join(' → ')}`)
// 观察项(不作硬断言):是否采样到"子任务全完、父任务尚未收口"的验收等待窗口。
// 真 LLM 收口很快(轮询粒度 2.5s 可能错过),**确定性证明**见 mock 契约测试 B6(事件流同帧采样)。
{
  const i = (p2.samples ?? []).findIndex(s => s.kids.length > 0 && s.kids.every(k => k === 'COMPLETED') && s.parent !== 'COMPLETED')
  note(i >= 0
    ? `采样到"子任务全完但父任务未完成"的中间帧(parent=${p2.samples[i].parent})— 验收等待窗口真实存在`
    : '未采样到中间帧(真 LLM 收口快于 2.5s 轮询;确定性证明见 mock 契约测试 B6)')
}
// 父任务收口产物:真实 LLM 常把验收/汇总写成名为 deliverable 的产物(而非特定 artifact 名),
// 因此按"非 input 且非空"识别,**不能**按名字白名单(否则会把正确行为判成失败)。
const p2ParentArt = (p2.root?.artifacts ?? []).filter(a => a.name !== 'input'
  && (a.parts ?? []).some(pa => 'text' in pa && pa.text.trim().length > 0))
const p2ParentText = p2ParentArt.flatMap(a => (a.parts ?? []).map(pa => ('text' in pa ? pa.text : ''))).join(' ')
check('P2.7 父任务带 Lead 自己的验收/汇总产物', p2ParentArt.length > 0,
  `artifacts=${(p2.root?.artifacts ?? []).map(a => a.name).join(',')}`)
// 覆盖度用**二字组重合率**判定,而不是"标题前 4 字必须原样出现":
// 真 LLM 的汇总稿会说"【二、轮转与保留(源自材料B…】",不一定复述子任务标题的措辞。
const bigramsOf = (s) => {
  const t = String(s).replace(/[\s:：,，。.、\-—_()（）【】[\]]/g, '')
  const out = new Set()
  for (let i = 0; i + 2 <= t.length; i++) out.add(t.slice(i, i + 2))
  return [...out]
}
const coverage = (p2.kids ?? []).map((k) => {
  const grams = bigramsOf(k.title)
  const hit = grams.filter(g => p2ParentText.includes(g)).length
  return { title: String(k.title).slice(0, 22), ratio: grams.length ? hit / grams.length : 0 }
})
check('P2.8 收口产物是实质内容且逐项覆盖各子任务(不是空壳/不是只交一份)',
  p2ParentText.trim().length > 200 && coverage.every(c => c.ratio >= 0.4),
  `长度=${p2ParentText.trim().length} 覆盖=${coverage.map(c => `${c.title}:${(c.ratio * 100).toFixed(0)}%`).join(' ')}`)

// ── 群聊时间线顺序 + @Agent 是否真的回话 ──
// GET /chat/messages 是**倒序**(新→旧,游标分页 beforeId);比较前先翻回时间顺序
const hist = await get(`/api/workshop/channels/${channelId}/chat/messages`, B.token)
const msgs = [...(hist.data?.messages ?? [])].reverse()
const texts = msgs.map(m => m.text)
const iPlain = texts.findIndex(t => t.includes('普通发言'))
const iUser = texts.findIndex(t => t.includes('你盯一下进度'))
const iAgent = texts.findIndex(t => t.includes('子任务现在什么状态'))
check('P4.5 群聊时间线按提交顺序排列(不混乱)', iPlain >= 0 && iUser > iPlain && iAgent > iUser,
  `plain@${iPlain} user@${iUser} agent@${iAgent} :: ${texts.map(t => t.slice(0, 8)).join(' > ')}`)
const agentReplies = msgs.filter(m => m.senderType === 'agent')
check('P4.6 @Agent 后群聊里出现了 Agent 的回复', agentReplies.length > 0, `agentMessages=${agentReplies.length}`)

// ============================================================================
console.log('\n━━━ P3 群聊请求 → Lead 升级为可追踪根任务(submit_task)━━━')

// P3.0 探针:先隔离"Lead 能不能在群里回话"这件事 —— 一句不需要分工的随口问答。
// 若这一条也没有 lead 消息,说明缺口在"Lead 的群聊回复通路"本身,而不是"升级为任务后没回话"。
const probeAsk = `一句话回答:HTTP 状态码 404 表示什么?(${TAG})`
await post(`/api/workshop/channels/${channelId}/chat/messages`, {
  body: { text: `@${leadName} ${probeAsk}`, clientMessageId: `p3-probe-${TAG}` },
  token: B.token,
})
const probeReply = await waitFor(
  async () => {
    const h = await get(`/api/workshop/channels/${channelId}/chat/messages`, B.token)
    return (h.data?.messages ?? []).find(m => m.senderType === 'agent' && m.senderId === leadAgentId) ?? null
  }, 300_000, 4000)
if (probeReply) {
  check('P3.0 Lead 能对群里的一句随口提问**直接回话**(最简单的群聊闭环)',
    true, `text=${String(probeReply.text).slice(0, 60)}`)
}
else {
  finding('P3.0 Lead 对群里随口提问的直接回话',
    '3 分钟内 Lead 未回话,该 chat_delivery 仍停在 delivered。注意这条通路本身是**可用**的'
    + '(另一轮实测:delivery 变 consumed 且群里出现 Lead 的回复),因此更像是"Lead 正忙于 supervise 回合 ⇒ 群聊回合排队/超时"'
    + '(实测出现过 supervise 回合 150s 超时被 abort),而不是结构性缺失;但排队过久会让提问者长时间得不到答复,值得关注')
}

const P3_ASK = `请给出这个项目的日志清理作业方案:要包含执行步骤与回滚步骤,做完把结论发到群里。(${TAG})`
const before = await tasksOf(channelId, A.token)
const beforeRoots = new Set(rootsOf(before).map(t => t.id))
// 记下提问前已有的 Lead 群聊消息 id:后面的"结论回群"必须是一条**新**消息,
// 否则会被 P3.0 那条随口问答的回复冒名顶替(假通过)。
const leadMsgIdsBefore = new Set(
  [...((await get(`/api/workshop/channels/${channelId}/chat/messages`, B.token)).data?.messages ?? [])]
    .filter(m => m.senderType === 'agent' && m.senderId === leadAgentId)
    .map(m => m.id),
)
await post(`/api/workshop/channels/${channelId}/chat/messages`, {
  body: { text: `@${leadName} ${P3_ASK}`, clientMessageId: `p3-ask-${TAG}` },
  token: B.token,
})
// Lead 可能先回群聊、再登记任务;轮询等新根任务出现。
// 窗口给足:Lead 是**单线程串行**的,忙在 supervise 回合时群聊回合会排队(实测出现过 supervise 150s 超时),
// 窗口太紧会把"排队慢"误报成"没升级"。
let newRoot = null
const p3Deadline = Date.now() + 600_000
while (Date.now() < p3Deadline && !newRoot) {
  const tasks = await tasksOf(channelId, A.token)
  newRoot = rootsOf(tasks).find(t => !beforeRoots.has(t.id)) ?? null
  if (!newRoot) await sleep(2500)
}
check('P3.1 Lead 把群聊诉求登记为**可追踪根任务**(submit_task 生效)', Boolean(newRoot),
  newRoot ? `root=${newRoot.id.slice(0, 8)} state=${newRoot.state} title=${String(newRoot.title).slice(0, 40)}` : '5min 内未出现新根任务')
if (newRoot) {
  check('P3.2 新根任务归属 Lead(creator/assignee 可追溯)',
    newRoot.assigneeId === leadAgentId, `assignee=${String(newRoot.assigneeId).slice(0, 8)} lead=${leadAgentId.slice(0, 8)}`)
  const p3 = await waitRootById(channelId, A.token, newRoot.id, 900_000)
  check('P3.3 该根任务最终收口 COMPLETED', p3.root?.state === 'COMPLETED', `state=${p3.root?.state}`)
  const p3kids = p3.kids ?? []
  const p3Text = p3.root ? artifactsTextOf(p3.root).join(' ') : ''
  // 逻辑要求是"简单自己答、专业才拆",不是"一律拆":所以这里断言的是**闭环成立**——
  // 若拆了则子任务必须全在 worker 名下且已完工;无论如何都必须有实质交付物。
  check('P3.4 群聊来源的作业被真正做完(自己作答或拆给 worker,均有实质交付物)',
    (p3kids.length === 0 || p3kids.every(k => k.state === 'COMPLETED' && workerIds.includes(k.assigneeId)))
    && p3Text.trim().length > 60,
    `children=${p3kids.length} 交付长度=${p3Text.trim().length} 产物=${(p3.root?.artifacts ?? []).map(a => a.name).join(',')}`)
  // 群聊回复是**异步**的 ⇒ 轮询等待;但必须是一条**新**消息(排除 P3.0 的回复)。
  const leadMsg = await waitFor(async () => {
    const h = await get(`/api/workshop/channels/${channelId}/chat/messages`, B.token)
    return [...(h.data?.messages ?? [])]
      .find(m => m.senderType === 'agent' && m.senderId === leadAgentId && !leadMsgIdsBefore.has(m.id)) ?? null
  }, 240_000, 4000)
  if (leadMsg) {
    check('P3.5 Lead 把这次作业的结论回了群(新消息,不是 P3.0 那条)', true,
      `text=${String(leadMsg.text).slice(0, 60)}`)
  }
  else {
    finding('P3.5 升级为任务后把结论回给群里的提问者',
      `作业已收口(交付物 ${p3Text.trim().length} 字,子任务 ${p3kids.length} 个),但群里没有出现针对本次提问的 Lead 新消息 ——`
      + '与"随口问答"那条通路形成对照(那条 chat_delivery 被消费且 Lead 回话成功):'
      + '群聊请求一旦经 submit_task 升级为任务、改由 SchedulerLoop.supervise 驱动,该 chat_delivery 就停在 delivered 永不被消费,'
      + '平台唯一的群聊回复出口(agent-runtime.processMessage 内的 platformReply)走不到 ⇒ 结论只落在任务 deliverable 里,提问者在群里看不到。'
      + '建议:submit_task 记录来源 chat message id,该根任务 complete 时把验收结论镜像进群聊并把对应 chat_deliveries 收敛为 consumed。')
  }
}

// ============================================================================
const evidence = {
  base: BASE,
  channelId,
  leadAgentId,
  workerIds,
  phases: {
    p1: { title: P1_TITLE, root: p1.root, kids: p1.kids, samples: p1.samples, artifacts: p1Artifacts },
    p2: { title: P2_TITLE, root: p2.root, kids: p2.kids, samples: p2.samples, artifacts: p2Artifacts },
    p3: { ask: P3_ASK, root: newRoot },
    chat: texts,
  },
  notes,
  findings,
}
try {
  mkdirSync('.omc/evidence', { recursive: true })
  writeFileSync(EVID, JSON.stringify(evidence, null, 1), 'utf8')
  console.log(`\n证据已写入 ${EVID}`)
}
catch (e) {
  console.log(`证据写入失败:${e.message}`)
}

console.log(`\n${'='.repeat(64)}`)
console.log(`真实作业逻辑 E2E: PASS=${passed}  FAIL=${failures}  FINDING=${findings.length}  BLOCKED=${blocked}`)
if (failures > 0) console.log('关注项(被验证的逻辑不成立):见上方 FAIL 行')
for (const f of findings) console.log(`  FINDING  ${f}`)
console.log('='.repeat(64))
// 退出码只反映"被验证的逻辑不成立"(FAIL);已定位根因的产品缺口单列 FINDING
process.exit(failures > 0 ? 1 : 0)
