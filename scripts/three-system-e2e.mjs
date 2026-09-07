/**
 * 三系统集成 e2e — AgentWorkShop × industrial-deep-diagnostic × rag-knowledge
 *
 * 覆盖(对应 .omc/plans/2026-09-07-three-system-integration.md 验收标准):
 *   Stage 1 系统与插件健康:四服务存活特征 / 插件装载 / 插件路由鉴权门(auth:'user')
 *   Stage 2 工具链与团队演示:DAQ 实时→快照 CSV / kb_index+kb_search 回环 / kb_store /
 *           双团队(数据分析组+闭环控制组)/ 跨通道消息 / DCW(manual)→HITL→写回
 *   Stage 3(--full)真实诊断:diag_run(omp 引擎)→ 轮询至完成 → 报告自动入 KB → 检索命中
 *   Stage 4 插件启停:plugins-state.json 热重载 → 工具与路由同时消失/恢复
 *
 * 用法:node scripts/three-system-e2e.mjs [--full]
 * 鉴权:沿用 api-live-e2e 惯例(env AW_E2E_TOKEN 复用,否则注册临时用户);
 *       产线权限由脚本直接向 users.sqlite 种一行 user_line_grants(测试夹具,非平台面)。
 */
import { DatabaseSync } from 'node:sqlite'
import { existsSync, readFileSync, writeFileSync, renameSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(__dirname, '..')
const FULL = process.argv.includes('--full')

const BASE = process.env.AW_BASE ?? 'http://localhost:3021'
const KB = process.env.KB_BASE ?? 'http://127.0.0.1:8770'
const KBWEB = process.env.KB_WEB ?? 'http://127.0.0.1:6789'
const DIAG = process.env.DIAG_BASE ?? 'http://127.0.0.1:3210'
const LINE = process.env.E2E_LINE ?? 'ln-af002514' // 1号产线(6 个 mock 数采节点)
const DCW_NODE = process.env.E2E_DCW_NODE ?? 'dw-e92bb0e7' // 压力设定器(mock 驱动)
const CH_A = '产线数据分析组'
const CH_B = '闭环控制组'

let pass = 0
let fail = 0
const failures = []
function ok(cond, label, detail = '') {
  if (cond) {
    pass++
    console.log(`  ✔ ${label}${detail ? ` —— ${detail}` : ''}`)
  }
  else {
    fail++
    failures.push(label)
    console.error(`  ✘ ${label}${detail ? ` —— ${detail}` : ''}`)
  }
}
const sleep = ms => new Promise(r => setTimeout(r, ms))

async function raw(method, url, { body, token, agent, timeoutMs = 20000 } = {}) {
  const headers = {}
  if (body !== undefined) headers['content-type'] = 'application/json'
  if (token) headers.authorization = `Bearer ${token}`
  if (agent) headers['x-aw-agent-token'] = agent.token
  const res = await fetch(url, {
    method, headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(timeoutMs),
  })
  const json = await res.json().catch(() => null)
  return { status: res.status, json }
}
const api = (method, path, opts = {}) => raw(method, `${BASE}${path}`, opts)
const envelopeData = r => r?.json?.data
const resultText = r => String(r?.json?.data?.result?.text ?? '')
const invoke = (agent, tool, args, timeoutMs = 60000) => api('POST', '/api/workshop/agent-tools/invoke', {
  agent, timeoutMs, body: { agentId: agent.id, tool, args },
})

// ── 0. 用户 token(持久化演示账号 → env → 现场注册)────────────────────────
console.log('\n══ 三系统集成 e2e ══')
const TOKEN_FILE = join(ROOT, '.AgentWorkShop', 'data', '.three-system-e2e-token.json')
let userToken = ''
let userId = ''
try {
  const saved = JSON.parse(readFileSync(TOKEN_FILE, 'utf8'))
  userToken = saved.token ?? ''
  userId = saved.uid ?? ''
}
catch { /* 首跑 */ }
if (!userToken && process.env.AW_E2E_TOKEN) userToken = process.env.AW_E2E_TOKEN
if (!userToken) {
  const name = `e2e3sys-${Date.now().toString(36)}`
  const reg = await api('POST', '/api/workshop/users/register', { body: { name } })
  userToken = reg?.json?.data?.token ?? ''
  userId = reg?.json?.data?.id ?? ''
  try {
    writeFileSync(TOKEN_FILE, JSON.stringify({ token: userToken, uid: userId, name }))
  }
  catch { /* 忽略 */ }
  ok(Boolean(userToken), '注册 e2e 用户拿 token', userToken ? 'ok' : `resp=${JSON.stringify(reg.json).slice(0, 120)}`)
  if (!userToken) process.exit(1)
}
else { console.log('  · 复用持久化演示账号 token') }

// ── 0b. 夹具种子:e2e 用户对目标产线 operate 授权(users.sqlite 直插,测试专用)──
try {
  const dbPath = join(ROOT, '.AgentWorkShop', 'data', 'users.sqlite')
  if (!existsSync(dbPath)) throw new Error(`users.sqlite 不存在: ${dbPath}`)
  let uid = userId
  if (!uid) {
    const db = new DatabaseSync(dbPath)
    db.exec('PRAGMA busy_timeout=4000')
    const cand = db.prepare('SELECT id FROM users ORDER BY created_at DESC LIMIT 200').all()
      .find(() => true) // 兜底:下面按 token 哈希反查不可行,直接用最新 e2e 用户
    uid = cand?.id ?? ''
    db.close()
  }
  if (uid) {
    const db2 = new DatabaseSync(dbPath)
    db2.exec('PRAGMA busy_timeout=4000')
    db2.prepare(`INSERT OR REPLACE INTO user_line_grants (user_id, line_id, mode, granted_by, granted_at) VALUES (?, ?, 'operate', 'three-system-e2e', ?)`)
      .run(uid, LINE, new Date().toISOString())
    db2.close()
    console.log(`  · 已为用户 ${uid} 种入产线 ${LINE} operate 授权(测试夹具)`)
  }
  else {
    console.log('  ! 未能取得 user id,产线授权未种(相关断言可能失败)')
  }
}
catch (err) {
  console.log(`  ! 授权夹具异常(继续): ${err?.message ?? err}`)
}

// ══ Stage 1:四服务健康 + 插件装载 + 鉴权门 ═══════════════════════════════
console.log('\n── Stage 1 系统与插件健康 ──')
{
  const awsGate = await api('GET', '/api/workshop/plugins')
  ok(awsGate.status === 401, 'AWS 3021 活着(无 token 401 信封)', `status=${awsGate.status}`)

  const kbH = await raw('GET', `${KB}/api/v1/health`)
  ok(kbH.json?.status === 'healthy', 'rag-knowledge 后端 8770 healthy', JSON.stringify(kbH.json))
  const kbWeb = await raw('GET', `${KBWEB}/api/kb/catalog`)
  ok(kbWeb.json?.success === true, 'rag-knowledge web 6789 catalog 可用', `count=${kbWeb.json?.count}`)
  const dgH = await raw('GET', `${DIAG}/api/health`)
  ok(dgH.json?.status === 'ok', '诊断服务 3210 healthy', `activeRuns=${dgH.json?.checks?.activeRuns}`)
  const rgH = await raw('GET', 'http://127.0.0.1:8764/health', { timeoutMs: 5000 }).catch(e => ({ json: { status: String(e) } }))
  ok(rgH.json?.status === 'healthy', '诊断 RAG 引擎 8764 healthy(降级容忍)', JSON.stringify(rgH.json ?? {}))

  const plugs = await api('GET', '/api/workshop/plugins', { token: userToken })
  // 兼容两种形状:顶层 {plugins:[...]}(插件清单端点未包信封)/ 信封 data.plugins
  const list = plugs.json?.plugins ?? envelopeData(plugs)?.plugins ?? []
  const names = list.map(p => p?.name)
  const enabled = n => list.find(p => p?.name === n)?.enabled === true
  ok(Array.isArray(list) && list.length > 0, '插件清单可读', list.length ? `count=${list.length}` : `resp=${JSON.stringify(plugs.json).slice(0, 160)}`)
  ok(names.includes('rag-bridge'), 'rag-bridge 已装载')
  ok(names.includes('diag-bridge'), 'diag-bridge 已装载')
  ok(enabled('rag-bridge') && enabled('diag-bridge'), '两桥接插件均为启用态')

  const noAuthRag = await raw('GET', `${BASE}/api/plugins/rag-bridge/health`)
  const noAuthDiag = await raw('GET', `${BASE}/api/plugins/diag-bridge/health`)
  ok(noAuthRag.status === 401 && noAuthDiag.status === 401, '插件路由鉴权门生效(auth:user → 无 token 401)', `rag=${noAuthRag.status} diag=${noAuthDiag.status}`)

  const ragH = await raw('GET', `${BASE}/api/plugins/rag-bridge/health`, { token: userToken })
  ok(ragH.status === 200 && ragH.json?.outbound === true && ragH.json?.kb?.id, 'rag-bridge 健康(kb.id 就绪)', `kb=${ragH.json?.kb?.id}`)
  const diagH = await raw('GET', `${BASE}/api/plugins/diag-bridge/health`, { token: userToken })
  ok(diagH.status === 200 && diagH.json?.remote?.status === 'ok', 'diag-bridge 健康(3210 可达)', `activeRuns=${diagH.json?.remote?.activeRuns}`)
}

// ══ Stage 2:双团队 + 工具链 + 跨通道 + HITL ═══════════════════════════════
let leadA
let toolInvoker // 工具直调执行器(omp;mock lead 不实现 dispatch 面)
let leadB
let channelA
let channelB
{
  console.log('\n── Stage 2 团队与工具链 ──')
  async function ensureChannel(name, leadName, execName) {
    const found = await api('GET', '/api/workshop/channels', { token: userToken })
    const items = envelopeData(found) ?? []
    const hit = (Array.isArray(items) ? items : []).find(c => c?.name === name)
    let channelId = hit?.id ?? ''
    if (!channelId) {
      let created = await api('POST', '/api/workshop/channels', {
        token: userToken,
        body: { name, description: `三系统集成示例团队(e2e 创建)`, leadAgent: { name: leadName, harness: 'mock' } },
      })
      if (!(created.status === 200 && envelopeData(created)?.channelId)) {
        // 同名频道被其他账号占用 → 加随机后缀重建(演示语义不变)
        name = `${name}-${Math.random().toString(36).slice(2, 6)}`
        created = await api('POST', '/api/workshop/channels', {
          token: userToken,
          body: { name, description: `三系统集成示例团队(e2e 创建)`, leadAgent: { name: leadName, harness: 'mock' } },
        })
      }
      channelId = envelopeData(created)?.channelId ?? ''
    }
    const readMembers = async () => (envelopeData(await api('GET', `/api/workshop/channels/${channelId}/agents`, { token: userToken })) ?? [])
    let members = await readMembers()
    // 每队配一个 omp「执行器」成员:REST 直调工具经共享 host-tool-bridge 分发,零 LLM 会话
    if (!members.some(m => m?.name === execName)) {
      await api('POST', `/api/workshop/channels/${channelId}/agents`, {
        token: userToken,
        body: { name: execName, harness: 'omp', role: 'worker' },
      })
      members = await readMembers()
    }
    const lead = members.find(m => m?.role === 'lead')
    const exec = members.find(m => m?.name === execName)
    return { channelId, lead, exec, name }
  }
  const a = await ensureChannel(CH_A, '分析组长', '数据分析执行器')
  const b = await ensureChannel(CH_B, '控制组长', '控制执行器')
  channelA = a.channelId
  channelB = b.channelId
  leadA = a.lead
  leadB = b.lead
  const execA = a.exec
  const execB = b.exec
  const nameB = b.name ?? CH_B
  ok(Boolean(channelA && leadA?.id && leadA?.token), `团队A「${a.name ?? CH_A}」就绪(lead=${leadA?.name})`)
  ok(Boolean(channelB && leadB?.id && leadB?.token), `团队B「${nameB}」就绪(lead=${leadB?.name})`)
  ok(Boolean(execA?.id && execA?.token), '团队A 执行器(omp)就绪', execA?.name)
  ok(Boolean(execB?.id && execB?.token), '团队B 执行器(omp)就绪', execB?.name)
  toolInvoker = execA ?? leadA

  // 工具清单:5 工具可见 + 无 url/base_url/host 参数(SSRF 面)
  const listR = await api('GET', `/api/workshop/agent-tools/list?agentId=${toolInvoker.id}`, { agent: toolInvoker })
  const tools = listR?.json?.tools ?? listR?.json?.data?.tools ?? []
  const toolNames = tools.map(t => t?.name)
  for (const t of ['diag_run', 'diag_status', 'kb_search', 'kb_store', 'kb_index']) {
    ok(toolNames.includes(t), `agent 工具清单含 ${t}`)
  }
  const bridge = tools.filter(t => ['diag_run', 'diag_status', 'kb_search', 'kb_store', 'kb_index'].includes(t?.name))
  const leak = bridge.some(t => Object.keys(t?.parameters?.properties ?? {}).some(k => /url|host/i.test(k)))
  ok(bridge.length === 5 && !leak, '桥接工具参数面无 url/host 注入口', `tools=${bridge.length}`)

  // DAQ 实时数据 → 快照导出
  let snap = await api('POST', '/api/plugins/diag-bridge/snapshot', {
    token: userToken,
    body: { line: LINE, from_ms: Date.now() - 15 * 60_000, to_ms: Date.now() },
  })
  if (snap.json?.success === false) {
    snap = await api('POST', '/api/plugins/diag-bridge/snapshot', {
      token: userToken,
      body: { line: LINE, from_ms: Date.now() - 120 * 60_000, to_ms: Date.now() },
    })
  }
  ok(snap.json?.success === true && snap.json?.rows > 0, 'DAQ 实时数采 → 快照 CSV 导出成功', `rows=${snap.json?.rows} nodes=${snap.json?.nodes} path=${snap.json?.csvPath}`)
  if (snap.json?.csvPath) {
    ok(String(snap.json.csvPath).startsWith('data/aw-snapshots/'), '快照落诊断服务 aw-snapshots 目录(相对路径)', snap.json.csvPath)
  }

  // KB 回环:kb_index 入库独特自然语句 → kb_search 命中(嵌入/分词对自然语句才可靠);kb_store 沉淀经验
  const marker = `三系统验证密语${Date.now().toString(36)}:青花瓷泵站三十七号叶片于黄昏完成校准`
  const idx = await invoke(toolInvoker, 'kb_index', {
    title: `三系统集成验证 ${Date.now().toString(36)}`,
    content: `# 三系统集成验证\n\n${marker}。\n\n本文由 three-system-e2e 经 rag-bridge 插件写入,验证 文档写盘 → 向量索引 → kb_search 检索 全链路。\n`,
    tags: ['e2e'],
  })
  ok(resultText(idx).includes('已入库'), 'kb_index 文档入库成功', resultText(idx).slice(0, 80))
  let hit = ''
  for (let i = 0; i < 10; i++) { // 首次检索可能触发 BGE-M3 模型加载,放宽到 10×3s
    await sleep(3000)
    const s = await invoke(toolInvoker, 'kb_search', { query: marker })
    hit = resultText(s)
    if (hit.includes(marker)) break
  }
  ok(hit.includes(marker), 'kb_search 检索命中刚入库文档', hit.split('\n')[1]?.slice(0, 90) ?? hit.slice(0, 90))

  const store = await invoke(toolInvoker, 'kb_store', {
    title: `e2e 经验:${marker} 快照导出前先确认产线在采样`,
    category: 'troubleshooting',
    problem: 'diag_run 报「时窗内无数采样本」',
    solution: '先查产线 LineRun 是否活动、节点 publishIntervalMs 是否在节拍上,再缩窗重试。',
    key_lessons: ['空窗先查打标窗口', 'bucket 5s 可对齐多节点'],
    tags: ['e2e', 'daq'],
  })
  ok(resultText(store).includes('已沉淀'), 'kb_store 经验沉淀成功', resultText(store).slice(0, 80))

  // 跨通道:分析组长 → 控制组长(require_reply;用频道 ID 定向,避免跨账号同名频道歧义)
  const xmsg = await invoke(leadA, 'send_cross_channel_message', {
    to_channel_id: channelB,
    message: `分析组已完成 ${LINE} 最近时窗的数据诊断与知识检索;请控制组给出 ${DCW_NODE}(压力设定器)的控制策略建议。`,
    require_reply: true,
  }, 120000)
  ok(!xmsg.json?.result?.isError, '分析组长 → 控制组长 跨通道消息发送成功', resultText(xmsg).slice(0, 80))
  let landedB = ''
  for (let i = 0; i < 8; i++) {
    await sleep(1000)
    const msgs = await api('GET', `/api/workshop/channels/${channelB}/messages`, { token: userToken })
    const items = envelopeData(msgs)?.items ?? envelopeData(msgs) ?? []
    const arr = Array.isArray(items) ? items : (items?.messages ?? [])
    landedB = JSON.stringify(arr)
    if (landedB.includes('控制策略建议')) break
  }
  ok(landedB.includes('控制策略建议'), '跨通道消息落入控制组频道')

  // DCW(manual)→ HITL → 写回
  const dcwView = await api('GET', '/api/workshop/dcw', { token: userToken })
  const dcwNodes = envelopeData(dcwView)?.nodes ?? []
  const node = dcwNodes.find(n => n?.id === DCW_NODE)
  ok(Boolean(node), `DCW 节点 ${DCW_NODE} 对授权用户可见`, `driver=${node?.driver} value=${node?.value}`)
  const target = Number(node?.value ?? 0)
  const bind = await api('POST', '/api/workshop/agent-tools/bindings', {
    token: userToken,
    body: { agentId: execB.id, nodeId: DCW_NODE, kind: 'dcw', mode: 'manual' },
  })
  ok(bind.status === 200 && Boolean(envelopeData(bind)?.binding?.id), '控制执行器绑定 DCW 节点(manual)', bind.status === 200 ? `mode=${envelopeData(bind)?.binding?.mode}` : JSON.stringify(bind.json).slice(0, 120))
  ok(envelopeData(bind)?.binding?.mode === 'manual', '绑定模式确为 manual(审批路径生效前置)')

  const pendingInvoke = invoke(execB, 'dcw_control', {
    node_id: DCW_NODE,
    value: target,
    hypothesis: `依据分析组诊断结论与历史经验,维持设定值 ${target}(e2e 闭环演示)`,
  }, 300000)
  let approved = false
  let pendRaw = '[]'
  for (let i = 0; i < 15 && !approved; i++) {
    await sleep(2000)
    const pend = await api('GET', '/api/workshop/hitl/pending', { token: userToken })
    const pd = envelopeData(pend)
    const arr = Array.isArray(pd) ? pd : (pd?.items ?? pd?.pending ?? [])
    pendRaw = JSON.stringify(arr)
    const item = arr.find(x => x?.kind === 'dcw-approval' && x?.agentId === execB.id)
    if (item?.id) {
      const resp = await api('POST', '/api/workshop/hitl/respond', {
        token: userToken,
        body: { kind: 'dcw-approval', id: item.id, confirmed: true, comment: 'three-system-e2e 批准' },
      })
      approved = resp.status === 200
    }
  }
  const writeRes = await pendingInvoke
  ok(approved, 'HITL 待办出现并经 respond 批准', approved ? 'ok' : `pending=${pendRaw.slice(0, 200)}`)
  ok(resultText(writeRes).includes('下发成功'), 'dcw_control 经审批写回成功', resultText(writeRes).slice(0, 120))
}

// ══ Stage 3:真实诊断(kickoff 常跑;--full 才轮询到完成)═══════════════════
let runId = ''
{
  console.log('\n── Stage 3 真实深度诊断(omp 引擎)──')
  let r = null
  for (const mins of [30, 180, 1440]) { // 采样间歇(共享实例节拍被并行调节)→ 逐步加宽窗口
    r = await invoke(toolInvoker, 'diag_run', {
      line: LINE,
      from_ms: Date.now() - mins * 60_000,
      to_ms: Date.now(),
      question: `${LINE} 近期数采数据深度根因诊断(three-system-e2e,窗口 ${mins} 分钟)`,
      scene: 'three_system_e2e',
    }, 120000)
    if (resultText(r).includes('runId=')) break
    console.log(`  … ${mins} 分钟窗无样本,加宽重试`)
    await sleep(2000)
  }
  const text = resultText(r)
  runId = (text.match(/runId=([a-z0-9-]+)/i) ?? [])[1] ?? ''
  ok(Boolean(runId), 'diag_run 异步发起并返回 runId', runId || `resp=${JSON.stringify(r.json).slice(0, 260)}`)

  if (FULL && runId) {
    let done = false
    let lastText = ''
    for (let i = 0; i < 135 && !done; i++) { // ≤45min
      await sleep(20_000)
      const s = await invoke(toolInvoker, 'diag_status', { run_id: runId }, 30000)
      lastText = resultText(s)
      if (/状态=completed/.test(lastText)) done = true
      else if (/状态=(failed|stopped)/.test(lastText)) break
      if (i % 6 === 5) console.log(`  … 轮询中(${(i + 1) * 20}s):${(lastText.match(/状态=\S+/) ?? [''])[0]}`)
    }
    ok(done, '真实诊断跑至 completed', (lastText.match(/评分=\S+|状态=\S+/g) ?? []).join(' '))
    if (done) {
      let stored = ''
      for (let i = 0; i < 6; i++) {
        await sleep(5000)
        const runs = await raw('GET', `${BASE}/api/plugins/diag-bridge/runs`, { token: userToken })
        const mine = (runs.json?.runs ?? []).find(x => x.runId === runId)
        stored = JSON.stringify(mine ?? {})
        if (mine?.stored === true) break
      }
      ok(stored.includes('"stored":true'), '报告自动入库(diag-bridge → KB)')
      let kbHit = ''
      for (let i = 0; i < 8; i++) {
        await sleep(5000)
        const s = await invoke(leadA, 'kb_search', { query: `${LINE} 深度根因诊断 three_system_e2e 结论` }, 60000)
        kbHit = resultText(s)
        if (!kbHit.startsWith('未检索到') && kbHit.length > 0) break
      }
      ok(!kbHit.startsWith('未检索到') && kbHit.length > 0, 'kb_search 检索到诊断报告/经验', kbHit.split('\n')[0]?.slice(0, 90))
    }
  }
  else {
    console.log('  ·(未加 --full:不等待诊断完成;完成后的入库由 diag-bridge 轮询器自动完成,可重跑 --full 或用 diag_status 观察)')
  }
}

// ══ Stage 4:插件启停(热重载 → 工具与路由同时生灭)═════════════════════════
{
  console.log('\n── Stage 4 插件启停 ──')
  const candidates = [join(ROOT, '.AgentWorkShop', 'plugins-state.json'), join(process.env.USERPROFILE ?? process.env.HOME ?? '', '.AgentWorkShop', 'plugins-state.json')]
  const statePath = candidates.find(p => existsSync(p))
  ok(Boolean(statePath), '定位 plugins-state.json', statePath ?? '未找到')
  if (statePath && leadA?.id) {
    const readState = () => JSON.parse(readFileSync(statePath, 'utf8'))
    const writeState = (obj) => {
      const tmp = `${statePath}.tmp`
      writeFileSync(tmp, JSON.stringify(obj, null, 2))
      renameSync(tmp, statePath)
    }
    const st0 = readState()
    const disabled0 = Array.isArray(st0.disabled) ? st0.disabled : []
    writeState({ ...st0, disabled: [...new Set([...disabled0, 'diag-bridge'])], updatedAt: new Date().toISOString() })
    // 热重载会停止并重建 agent 运行时,每轮重新取成员(拿最新 token)再断言
    const freshLead = async () => {
      const members = await api('GET', `/api/workshop/channels/${channelA}/agents`, { token: userToken })
      return (envelopeData(members) ?? []).find(m => m?.role === 'lead') ?? leadA
    }
    let gone = false
    for (let i = 0; i < 20 && !gone; i++) {
      await sleep(1500)
      const fl = await freshLead()
      const h = await raw('GET', `${BASE}/api/plugins/diag-bridge/health`, { token: userToken })
      const l = await api('GET', `/api/workshop/agent-tools/list?agentId=${fl.id}`, { agent: fl })
      const names4 = (l?.json?.data?.tools ?? l?.json?.tools ?? []).map(t => t?.name)
      gone = h.status === 404 && !names4.includes('diag_run')
    }
    ok(gone, '停用 diag-bridge → 路由 404 且 diag_run 从工具清单消失(热重载 + 工具注销)')

    writeState({ ...st0, disabled: disabled0, updatedAt: new Date().toISOString() })
    let back = false
    for (let i = 0; i < 25 && !back; i++) {
      await sleep(1500)
      const fl = await freshLead()
      const h = await raw('GET', `${BASE}/api/plugins/diag-bridge/health`, { token: userToken })
      const l = await api('GET', `/api/workshop/agent-tools/list?agentId=${fl.id}`, { agent: fl })
      const names4 = (l?.json?.data?.tools ?? l?.json?.tools ?? []).map(t => t?.name)
      back = h.status === 200 && names4.includes('diag_run')
    }
    ok(back, '重新启用 diag-bridge → 路由与工具恢复')
  }
}

// ══ 汇总 ══════════════════════════════════════════════════════════════════
console.log(`\n══ 结果:${pass} 通过 / ${fail} 失败 ══`)
if (failures.length) {
  console.error('失败项:')
  for (const f of failures) console.error(`  - ${f}`)
}
if (!FULL && runId) console.log(`\n提示:本次发起的诊断 runId=${runId},完成可加 --full 重跑或调 diag_status 观察。`)
process.exit(fail > 0 ? 1 : 0)
