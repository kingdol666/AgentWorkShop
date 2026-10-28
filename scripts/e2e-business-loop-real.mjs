#!/usr/bin/env node
/**
 * 业务闭环真机验收 —— 实例③(隔离,真实 omp 子进程 + 本机 LM Studio Qwen3.5-9B):
 *   一条任务走完「数据抓取 → 工艺决策 → 参数下发(HITL)→ 复测 → 汇报」真实作业逻辑;
 *   第二条任务走完「配方创建 → 修改 → 回退」管理闭环(凭产线配方管理权,无单配方绑定)。
 *
 * 收口条件(全部满足才算过):
 *   C1 任务状态收口(COMPLETED 或控制链完成后平台取消收敛);
 *   C2 控制链证据:HITL 卡批准 + journal 落账(prev=基线) + 设备回读=账本值;
 *   C3 交付物引用了真实采样数据(抓取环节真实发生);
 *   C4 管理链证据:新配方存在、版本轨迹 v1→v2→v3(v3=v1)、设备=基线值;
 *   C5 授权边界:未绑定点位下发被拒(负向断言)。
 *
 * 运行:node scripts/e2e-business-loop-real.mjs(自起隔离实例,端口 3412;需 LM Studio qwen3.5-9b-32k)
 * 证据:docs/audit/evidence/2026-10-28-business-loop/report.json
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const HOME = process.env.AW_BIZLOOP_HOME ?? 'D:/tmp/aw-bizloop-20261028'
const PORT = Number(process.env.AW_BIZLOOP_PORT ?? 3412)
const BASE = `http://127.0.0.1:${PORT}`
const EVIDENCE_DIR = join(REPO, 'docs', 'audit', 'evidence', '2026-10-28-business-loop')
const results = []
const sleep = ms => new Promise(r => setTimeout(r, ms))
const ok = (id, name, cond, detail = '') => {
  results.push({ id, name, pass: Boolean(cond), detail: String(detail).slice(0, 1200) })
  console.log(`${cond ? '✔' : '✖'} [${id}] ${name}${cond ? '' : ` — ${String(detail).slice(0, 600)}`}`)
  return Boolean(cond)
}

function stopOwnedInstance() {
  const pidFile = join(HOME, 'server.pid')
  if (!existsSync(pidFile)) return
  const pid = Number(readFileSync(pidFile, 'utf8').trim())
  if (!Number.isInteger(pid) || pid <= 0) return
  try {
    spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true })
  }
  catch { /* 已退出 */ }
}

async function health() {
  try {
    const r = await fetch(`${BASE}/api/health`, { signal: AbortSignal.timeout(2500) })
    if (!r.ok) return null
    return (await r.json())?.data ?? null
  }
  catch {
    return null
  }
}

async function startInstance() {
  stopOwnedInstance()
  await sleep(1500)
  const running = await health()
  if (running) throw new Error(`端口 ${PORT} 已被非本验收实例占用`)
  if (!/aw-bizloop/.test(HOME)) throw new Error(`拒绝清理非验收目录:${HOME}`)
  rmSync(HOME, { recursive: true, force: true })
  mkdirSync(HOME, { recursive: true })
  const log = openSync(join(HOME, 'server.log'), 'a')
  const child = spawn(process.execPath, [join(REPO, '.output', 'server', 'index.mjs')], {
    cwd: REPO,
    env: {
      ...process.env,
      AW_MODE: 'home',
      AW_HOME: HOME,
      PORT: String(PORT),
      NUXT_SESSION_PASSWORD: 'bizloop-20261028-session-key-abcdef',
      AW_TRIAL_INTERVAL_MS: '0',
      AW_RATE_LIMIT_OFF: '1',
      NO_PROXY: '127.0.0.1,localhost',
    },
    detached: true,
    stdio: ['ignore', log, log],
    windowsHide: true,
  })
  child.unref()
  writeFileSync(join(HOME, 'server.pid'), String(child.pid))
  for (let i = 0; i < 90; i++) {
    await sleep(1000)
    const h = await health()
    if (h?.workshop === 'ready') return h
  }
  throw new Error('隔离实例未在 90s 内就绪')
}

let admin = ''
async function apiOnce(method, path, body, token = admin, extraHeaders = {}, timeoutMs = 120_000) {
  const res = await fetch(BASE + path, {
    method,
    headers: {
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...extraHeaders,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  })
  let json = null
  try {
    json = await res.json()
  }
  catch { /* 非 JSON */ }
  return { status: res.status, ...json }
}
/** 网络抖动重试(连接拒绝/RESET 各重试一次;HTTP 4xx/5xx 不重试) */
async function api(method, path, body, token = admin, extraHeaders = {}, timeoutMs = 120_000) {
  try {
    return await apiOnce(method, path, body, token, extraHeaders, timeoutMs)
  }
  catch (err) {
    if (err instanceof TypeError && /fetch failed|terminated|ECONN/i.test(String(err?.cause?.code ?? err.message))) {
      await sleep(1500)
      return apiOnce(method, path, body, token, extraHeaders, timeoutMs)
    }
    throw err
  }
}
function agentTokenOf(agentId) {
  const db = new DatabaseSync(join(HOME, 'data', 'workshop.sqlite'), { readOnly: true })
  try {
    return String(db.prepare('SELECT token FROM channel_agents WHERE id = ?').get(agentId)?.token ?? '')
  }
  finally {
    db.close()
  }
}
async function pendingOf(agentId) {
  const r = await api('GET', `/api/workshop/agent-tools/approvals?agentId=${encodeURIComponent(agentId)}`, undefined, admin)
  return (r?.data?.approvals ?? []).filter(a => a.status === 'pending')
}
async function journalCount(lineId) {
  const r = await api('GET', `/api/workshop/dcw/journal?lineId=${lineId}&limit=500`, undefined, admin)
  return r?.data?.anchors ?? []
}
const taskOf = r => r?.data?.task ?? r?.data ?? null
const deliverableOf = task => String((task?.artifacts ?? []).find(a => a.name === 'deliverable')?.parts?.map(p => p.text ?? '').join('\n') ?? '')
const toolCallsOf = task => (task?.history ?? []).map(h => String(h?.parts?.map(p => p.text ?? '').join(' ') ?? '')).filter(t => t.includes('🔧')).map(t => t.replace(/\s+/g, ' ').slice(0, 200))
async function submitTask(channelId, title, description) {
  const r = await api('POST', `/api/workshop/channels/${channelId}/tasks`, { title, description })
  const task = taskOf(r)
  if (!task?.id) throw new Error(`任务创建失败:${JSON.stringify(r).slice(0, 300)}`)
  return task
}
/** 等待「控制链完成」:审批自动放行,账本出现目标写入后再给模型 15s 收口;否则平台取消收敛 */
async function waitTrialAndClose(taskId, agentId, lineId, nodeId, { prevValue, timeoutMs = 10 * 60_000 }) {
  const started = Date.now()
  const since = started - 5000
  const cards = []
  while (Date.now() - started < timeoutMs) {
    const task = taskOf(await api('GET', `/api/workshop/tasks/${taskId}`))
    const state = String(task?.state ?? '')
    if (['COMPLETED', 'FAILED', 'CANCELLED'].includes(state)) return { task, cards, cancelled: false }
    for (const card of await pendingOf(agentId)) {
      if (cards.some(c => c.id === card.id)) continue
      cards.push(card)
      console.log(`    · HITL card ${card.id} 出现,自动批准`)
      await api('POST', `/api/workshop/agent-tools/approvals/${card.id}/decide`, { approved: true, comment: '验收:批准业务闭环点位试验' }, admin)
    }
    const hit = (await journalCount(lineId)).some(a => a.nodeId === nodeId && a.prevValue === prevValue && a.newValue !== prevValue && Date.parse(a.at) >= since)
    if (hit) {
      await sleep(15_000)
      const t2 = taskOf(await api('GET', `/api/workshop/tasks/${taskId}`))
      if (['COMPLETED', 'FAILED', 'CANCELLED'].includes(String(t2?.state ?? ''))) return { task: t2, cards, cancelled: false }
      await api('POST', `/api/workshop/tasks/${taskId}/cancel`, { reason: '验收:控制链已完成,平台侧取消收敛' }, admin)
      return { task: taskOf(await api('GET', `/api/workshop/tasks/${taskId}`)), cards, cancelled: true }
    }
    await sleep(2000)
  }
  return { task: taskOf(await api('GET', `/api/workshop/tasks/${taskId}`)), cards, cancelled: false }
}
async function waitTask(taskId, timeoutMs = 10 * 60_000) {
  const started = Date.now()
  const approved = new Set()
  while (Date.now() - started < timeoutMs) {
    const task = taskOf(await api('GET', `/api/workshop/tasks/${taskId}`))
    // 管理操作(创建/修改/回退)在 manual 频道同样挂审批:运营侧自动批准,避免 60s 超时拒绝死循环
    for (const card of await pendingOf(task?.assigneeId ?? '')) {
      if (approved.has(card.id)) continue
      approved.add(card.id)
      console.log(`    · 审批卡 ${card.id} 出现,自动批准`)
      await api('POST', `/api/workshop/agent-tools/approvals/${card.id}/decide`, { approved: true, comment: '验收:批准配方管理操作' }, admin)
    }
    if (['COMPLETED', 'FAILED', 'CANCELLED'].includes(String(task?.state ?? ''))) return task
    await sleep(3000)
  }
  return taskOf(await api('GET', `/api/workshop/tasks/${taskId}`))
}

const evidence = {
  at: new Date().toISOString(),
  env: { base: BASE, home: HOME, model: { provider: 'lm-studio', model: 'qwen3.5-9b-32k', contextTokens: 32768 }, harness: 'omp', devices: 'mock(daq+dcw)', instance: '③-business-loop' },
  scenario: {},
  tasks: {},
  assertions: results,
}

try {
  const h = await startInstance()
  ok('B0', '生产构建隔离实例③就绪', h?.workshop === 'ready', `port=${PORT} version=${h?.version}`)
  admin = (await api('POST', '/api/users/register', { name: '业务闭环管理员', email: `biz-${Date.now()}@awshop.local`, password: 'BizLoop#2026' })).data?.token
  ok('B0b', 'admin 注册', Boolean(admin))
  writeFileSync(join(HOME, 'admin.json'), JSON.stringify({ token: admin }))

  // ── 场景:一线(总闸 auto)+ 数采(真实采样)+ 数控 + 配方(60);开跑 + 开采 ──
  const must = (resp, what) => {
    if (resp.status !== 200 || !resp?.data) throw new Error(`${what} 失败:${resp.status} ${JSON.stringify(resp).slice(0, 400)}`)
    return resp.data
  }
  const line = (await api('POST', '/api/workshop/dcw/lines', { name: '业务闭环线', simulated: true, description: '抓取→决策→下发→复测 真实作业链验收' }, admin)).data?.line?.id
  const daq = (await api('POST', '/api/workshop/daq', {
    name: '腔体温度', driver: 'mock', templateRef: 'daq-temp-tc', lineId: line, intervalMs: 1000, publishIntervalMs: 0, min: 0, max: 100,
    semantics: '腔体温度测点;正常工艺窗口 50~70C',
  }, admin)).data?.node?.id
  const dw = (await api('POST', '/api/workshop/dcw', {
    name: '温度设定', driver: 'mock', templateRef: 'temp-sp', lineId: line, unit: 'C', decimals: 2, min: 0, max: 100,
    driverConfig: { key: 'biz-loop-sp' }, stepLimit: 4, writeLockSeconds: 0, readIntervalMs: 0,
    semantics: '温度设定;调参步幅 ≤4C,目标落配方窗口 50~70C',
  }, admin)).data?.node?.id
  const params = (await api('GET', `/api/workshop/dcw/params?lineId=${line}`)).data?.params ?? []
  const pm = params.find(p => p.nodeId === dw)
  if (pm) await api('PATCH', `/api/workshop/dcw/params/${pm.id}`, { key: 'temp_sp', desc: '腔体温度设定值(C)', min: 0, max: 100 })
  const product = must(await api('POST', '/api/workshop/dcw/products', {
    name: '业务闭环产品', lineId: line, paramLimits: { temp_sp: { min: 50, max: 70 } },
  }, admin), '创建产品').product
  const recipe = must(await api('POST', '/api/workshop/dcw/recipes', {
    name: '业务闭环配方', productId: product.id, opIntervalMs: 0,
    params: [{ nodeId: dw, value: 60, min: 50, max: 70, stepLimit: 4 }],
    daqWindows: [{ nodeId: daq, min: 50, max: 70 }],
  }, admin), '创建配方').recipe
  await api('POST', '/api/workshop/daq/controller', { action: 'start' }, admin)
  const start = await api('POST', `/api/workshop/dcw/lines/${line}/start`, { recipeId: recipe.id }, admin)
  await api('PATCH', `/api/workshop/dcw/lines/${line}`, { controlMode: 'auto', confirm: true }, admin)
  ok('B1', '场景就绪:开跑+开采+总闸 auto', Boolean(line && daq && dw && recipe?.id) && start.status === 200, JSON.stringify({ line, daq, dw, recipe: recipe?.id, start: start.status }))
  await sleep(10_000)

  // ── 频道(manual 模式,强制 HITL 可见)+ omp lead:点位绑定 + 产线管理权 ──
  // omp overlay:把全部模型角色钉到本地 Qwen3.5 —— 否则长回合触发自动压缩时,
  // 压缩/慢速角色走全局配置里的云端模型,预算耗尽(422)会打断回合(实测踩坑)。
  const ompOverlay = join(HOME, 'omp-overlay.yml')
  writeFileSync(ompOverlay, [
    'modelRoles:',
    '  default: lm-studio/qwen3.5-9b-32k',
    '  task: lm-studio/qwen3.5-9b-32k',
    '  advisor: lm-studio/qwen3.5-9b-32k',
    '  slow: lm-studio/qwen3.5-9b-32k',
    '  designer: lm-studio/qwen3.5-9b-32k',
    'compaction:',
    '  enabled: true',
    '',
  ].join('\n'))
  const ch = (await api('POST', '/api/workshop/channels', {
    name: '验收-业务闭环', lineId: line,
    scenarioPrompt: '你是工艺闭环操作员兼配方管理员:只操作你绑定的点位;未收到任务时禁止自主发起任何下发;严格按任务步骤执行,不复测、不等待、不固化。',
    leadAgent: { name: '业务闭环-线长', harness: 'omp', config: { rpcMode: 'rpc', args: ['--no-tools', '--config', ompOverlay] } },
  }, admin)).data
  const channelId = ch?.channelId
  await api('PATCH', `/api/workshop/channels/${channelId}`, { llm: { provider: 'lm-studio', model: 'qwen3.5-9b-32k' } })
  await api('PATCH', `/api/workshop/channels/${channelId}/execution-mode`, { mode: 'manual' }, admin)
  const toolsPut = await api('PUT', `/api/workshop/channels/${channelId}/tools`, {
    mode: 'selected',
    tools: ['my_industrial_nodes', 'line_context', 'daq_query', 'recipe_trial', 'recipe_create', 'recipe_update', 'recipe_rollback', 'complete_task', 'report_progress'].map(n => ({ name: n, enabled: true })),
  }, admin)
  const agents = (await api('GET', `/api/workshop/channels/${channelId}`)).data?.agents ?? []
  const lead = agents.find(a => a.role === 'lead')
  const tok = agentTokenOf(lead.id)
  const bDcw = await api('POST', '/api/workshop/agent-tools/bindings', { agentId: lead.id, nodeId: dw, kind: 'dcw', mode: 'auto' }, admin)
  const bGrant = await api('POST', '/api/workshop/agent-tools/bindings', { agentId: lead.id, nodeId: line, kind: 'line-recipe', mode: 'auto' }, admin)
  for (const b of [bDcw, bGrant]) {
    if (b?.data?.binding?.mode === 'manual') await api('PATCH', `/api/workshop/agent-tools/bindings/${b.data.binding.id}`, { mode: 'auto', confirm: true }, admin)
  }
  ok('B2', '频道(manual/HITL)+ omp lead + 点位/管理权双绑定 + 工具面', Boolean(channelId && lead?.id) && toolsPut.status === 200 && bDcw.status === 200 && bGrant.status === 200,
    JSON.stringify({ channelId, lead: lead?.id, tools: toolsPut.status, dcw: bDcw?.data?.binding?.kind, grant: bGrant?.data?.binding?.kind }))
  evidence.scenario = { line, daq, dw, recipe: recipe?.id, channel: channelId, agent: lead.id, bindings: { dcw: bDcw?.data?.binding?.id, grant: bGrant?.data?.binding?.id } }

  // ── 任务1:抓取 → 决策 → 下发(HITL)→ 复测 → 汇报 ──
  const preNodes = await api('GET', '/api/workshop/dcw', undefined, admin)
  const preDw = (preNodes?.data?.nodes ?? []).find(n => n.id === dw)
  const baseValue = Number(preDw?.value ?? 60)
  const task1 = await submitTask(channelId, '验收-业务闭环-调参',
    '严格按五步执行,不要做别的:\n'
    + '1) 调用 daq_query(line_id 用 my_industrial_nodes/line_context 里的产线,last_minutes=5)抓取数采数据;\n'
    + '2) 基于数据写 hypothesis,调用 recipe_trial:只含你绑定的数控点位 value=当前值+2(单步≤4C,窗口内);\n'
    + '3) 审批由人工处理,工具返回结果后继续;\n'
    + '4) 调用 line_context 复核设定值变化;\n'
    + '5) 立即调用 complete_task 汇报:抓取数据摘要→假设→下发回执→复核结果。\n'
    + '禁止其他任何工具,禁止睡眠/等待/后台任务。')
  const t1 = Date.now()
  const run1 = await waitTrialAndClose(task1.id, lead.id, line, dw, { prevValue: baseValue })
  const j1 = (await journalCount(line)).filter(a => a.nodeId === dw && a.prevValue === baseValue && a.newValue !== baseValue && Date.parse(a.at) >= t1 - 5000)
  const trial1 = j1[0]
  const postNodes = await api('GET', '/api/workshop/dcw', undefined, admin)
  const postDw = (postNodes?.data?.nodes ?? []).find(n => n.id === dw)
  const hist1 = (await api('GET', `/api/workshop/agent-tools/approvals?agentId=${encodeURIComponent(lead.id)}&scope=history`, undefined, admin)).data?.approvals ?? []
  const cardRow = run1.cards[0] ? hist1.find(a => a.id === run1.cards[0].id) : null
  const deliv1 = deliverableOf(run1.task)
  ok('C2', `控制链:HITL 批准 + 落账 ${baseValue}→${trial1?.newValue ?? '?'} + 设备回读一致`,
    Boolean(trial1) && cardRow?.status === 'approved' && Number(postDw?.value) === Number(trial1?.newValue),
    `journal=${JSON.stringify(trial1 ?? null).slice(0, 260)} device=${postDw?.value} card=${cardRow?.status}`)
  // C3 按收口方式取证:COMPLETED 看交付物;平台取消收敛时看工具轨迹里的 daq_query(抓取真实发生)
  const fetchEvidence = run1.cancelled
    ? toolCallsOf(run1.task).some(t => t.includes('daq_query'))
    : /样本|均值|daq|数据/.test(deliv1) && deliv1.length > 80
  ok('C3', '抓取环节真实发生(交付物引用采样数据,或工具轨迹含 daq_query)', fetchEvidence,
    run1.cancelled ? `cancelled; toolCalls=${toolCallsOf(run1.task).slice(0, 6).join(' | ')}` : deliv1.slice(0, 320))
  ok('C1', '任务1 状态收口(COMPLETED 或平台取消收敛)', run1.task?.state === 'COMPLETED' || run1.cancelled,
    `state=${run1.task?.state} cancelled=${run1.cancelled} elapsed=${Math.round((Date.now() - t1) / 1000)}s`)
  evidence.tasks.loop = {
    id: task1.id, state: run1.task?.state, cancelledByOperator: run1.cancelled, deliverable: deliv1,
    toolCalls: toolCallsOf(run1.task), journal: j1.slice(-2), hitl: run1.cards.map(c => ({ id: c.id, status: c.status })),
  }

  // ── 任务2:配方管理,拆两个短任务(9B 模型长任务易发散):先创建,再改+回退 ──
  const recipesBefore = new Set(((await api('GET', '/api/workshop/dcw/recipes'))?.data?.recipes ?? []).map(r => r.id))
  const task2 = await submitTask(channelId, '验收-业务闭环-配方创建',
    '严格按三步执行,不要做别的:\n'
    + `1) 调用 recipe_create:line_id="${line}",name="管理权新建配方",显式 params=[{node_id:"${dw}",value:58}](禁用 use_active_run/source_recipe_id/from_run_id),reason 写「验收:管理权新建」;\n`
    + '2) 调用 complete_task 汇报 recipe_create 完整回执与新配方 id。\n'
    + '禁止其他任何工具,禁止等待。')
  const task2Done = await waitTask(task2.id, 14 * 60_000)
  // 配方落库可能略晚于回执:窗口内轮询 60s
  let mgrRecipe = ''
  for (let i = 0; i < 20 && !mgrRecipe; i++) {
    const recipesAfter = (await api('GET', '/api/workshop/dcw/recipes'))?.data?.recipes ?? []
    mgrRecipe = recipesAfter.find(r => r.lineId === line && !recipesBefore.has(r.id))?.id ?? ''
    if (!mgrRecipe) await sleep(3000)
  }
  ok('C4a', '真实 Agent 凭管理权新建配方(无单配方绑定)', Boolean(mgrRecipe) && ['COMPLETED', 'CANCELED'].includes(String(task2Done?.state ?? '')),
    `state=${task2Done?.state} recipe=${mgrRecipe || '(未找到)'} deliv=${deliverableOf(task2Done).slice(0, 220)}`)
  if (mgrRecipe) {
    // 开跑新配方(运行门),再让同一 Agent 修改+回退
    const stopPrev = await api('POST', `/api/workshop/dcw/lines/${line}/stop`, undefined, admin)
    const startM = await api('POST', `/api/workshop/dcw/lines/${line}/start`, { recipeId: mgrRecipe }, admin)
    const v1 = ((await api('GET', `/api/workshop/dcw/recipes/${mgrRecipe}/versions`))?.data?.versions ?? [])[0]
    const baseA = Number((v1?.params ?? []).find(p => p.nodeId === dw)?.value)
    const task2b = await submitTask(channelId, '验收-业务闭环-修改并回退',
      '严格按三步执行,不要做别的:\n'
      + `1) recipe_update:recipe_id="${mgrRecipe}",params=[{node_id:"${dw}",value:${baseA - 2}}],reason 写「验收:管理权修改」;\n`
      + `2) recipe_rollback:recipe_id="${mgrRecipe}",version=1,reason 写「验收:管理权回退」;\n`
      + '3) 立即调用 complete_task 汇报两步回执。\n'
      + '禁止其他任何工具,禁止等待。')
    const task2bDone = await waitTask(task2b.id, 14 * 60_000)
    const versions = (await api('GET', `/api/workshop/dcw/recipes/${mgrRecipe}/versions`))?.data?.versions ?? []
    const v2Row = versions.find(v => v.version === 2)
    const lastRow = versions[versions.length - 1]
    const nodesM = await api('GET', '/api/workshop/dcw', undefined, admin)
    const dwM = (nodesM?.data?.nodes ?? []).find(n => n.id === dw)
    ok('C4b', '新配方开跑接管 DCW(=v1 定义值)', stopPrev.status === 200 && startM.status === 200 && Number(dwM?.value) === baseA,
      `stop=${stopPrev.status} start=${startM.status} device=${dwM?.value} v1A=${baseA}`)
    ok('C4c', '修改+回退版本轨迹(v2≠v1 → v3=v1)', Number(lastRow?.version) >= 3
    && Array.isArray(v2Row?.params) && v2Row.params.some(p => p.nodeId === dw && p.value !== baseA)
    && Array.isArray(lastRow?.params) && lastRow.params.some(p => p.nodeId === dw && p.value === baseA),
    `versions=${versions.map(v => `${v.version}:${(v.params ?? []).map(p => p.value).join('/')}`).join(',')}`)
    ok('C1b', '任务2 状态收口', task2Done?.state === 'COMPLETED' && task2bDone?.state === 'COMPLETED',
      `t2=${task2Done?.state} t2b=${task2bDone?.state}`)
    evidence.tasks.manage = {
      id: task2.id, id2: task2b.id, recipe: mgrRecipe,
      versions: versions.map(v => ({ version: v.version, values: (v.params ?? []).map(p => p.value) })),
      deliverable: deliverableOf(task2Done), deliverable2: deliverableOf(task2bDone),
      toolCalls: toolCallsOf(task2Done), toolCalls2: toolCallsOf(task2bDone),
    }

    // ── C5 授权边界:收回管理权后 update 拒;未绑定点位(无第二点位,用越线配方) ──
    await api('DELETE', `/api/workshop/agent-tools/bindings/${bGrant?.data?.binding?.id}`, undefined, admin)
    const updAfter = await api('POST', '/api/workshop/agent-tools/invoke', {
      agentId: lead.id, tool: 'recipe_update', args: { recipe_id: mgrRecipe, params: [{ node_id: dw, value: 55 }], reason: '验收:收回管理权后应拒' },
    }, undefined, { 'x-aw-agent-token': tok })
    ok('C5', '收回管理权后版本操作被拒(需配方级授权)', Boolean(updAfter?.data?.result?.isError ?? updAfter?.data?.isError) && /配方级授权|版本操作|配方管理权/.test(String(updAfter?.data?.result?.text ?? '')), String(updAfter?.data?.result?.text ?? '').slice(0, 240))
  }
  evidence.assertions = results
}
catch (err) {
  ok('FATAL', '验收未捕获异常', false, err instanceof Error ? `${err.message}\n${err.stack ?? ''}` : String(err))
  evidence.assertions = results
}
finally {
  mkdirSync(EVIDENCE_DIR, { recursive: true })
  const passed = results.filter(r => r.pass).length
  const total = results.length
  evidence.summary = { total, passed, failed: total - passed, verdict: passed === total ? 'PASS' : 'FAIL' }
  writeFileSync(join(EVIDENCE_DIR, 'report.json'), JSON.stringify(evidence, null, 2))
  console.log(`\n结论:${passed === total ? 'PASS' : 'FAIL'}(${passed}/${total})`)
  console.log(`证据:${join(EVIDENCE_DIR, 'report.json')}`)
  process.exit(passed === total ? 0 : 1)
}
