#!/usr/bin/env node
/**
 * RSI 真实环境端到端验收（2026-11-09）
 *
 * 在生产构建（.output）隔离实例上，用真实 HTTP API + 真实 SQLite + 真实 DCW/DAQ mock 驱动，
 * 跑完整产线作业链（含项目任务实例 Channel、write_intent、HITL、独立回读）：
 *
 *   A. 任务作业 → 反射器自动沉淀 line 经验（candidate + taskIds 证据）
 *   B. 经验门 fail-closed：单任务证据拒绝晋级
 *   C. 项目任务实例 + write_intent + HITL：line_start / recipe_trial 真实下发 → 干预台账
 *   D. C1→L1：回读 mismatch 让成果 review 被 409 阻断（mismatch/inconclusive ≠ pass）
 *   E. 正向作业：回读 match → review 通过 → 评审经验 + kb_ingest 候选
 *   F. 证据合并（P1 已知缺口策展路径）→ validated → 同产线跨 Channel 可读、异产线零命中
 *   G. B2 配对 → Profile shadow→active 门；preview 含 pin 经验+隔离声明+advisory
 *   H. B4 回滚；C3 元层成功率；看板/DB 事实复核
 *
 * 运行前置：`npx nuxi build` 产出 .output/server/index.mjs。
 * 用法：node scripts/acceptance-rsi-live-e2e.mjs [--keep]
 * 产物：docs/audit/evidence/2026-11-09-rsi-live-e2e/report.{json,md}
 */
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const KEEP = process.argv.includes('--keep')
const TAG = Date.now().toString(36).slice(-5)
const ROOT = join(tmpdir(), `aw-rsi-live-${TAG}`)
const HOME = join(ROOT, 'home')
const EVIDENCE_DIR = join(REPO, 'docs/audit/evidence/2026-11-09-rsi-live-e2e')
mkdirSync(HOME, { recursive: true })
mkdirSync(EVIDENCE_DIR, { recursive: true })

const results = []
const facts = {}
function ok(id, name, cond, detail = '') {
  results.push({ id, name, pass: Boolean(cond), detail: String(detail).slice(0, 500) })
  console.log(`${cond ? 'PASS' : 'FAIL'} ${id} — ${name}${detail ? ` · ${String(detail).slice(0, 240)}` : ''}`)
}
const sleep = ms => new Promise(r => setTimeout(r, ms))

async function waitFor(fn, { timeout = 90_000, interval = 500, label = 'condition' } = {}) {
  const start = Date.now()
  let last
  while (Date.now() - start < timeout) {
    try {
      const v = await fn()
      if (v) return v
      last = v
    }
    catch (err) {
      last = err
    }
    await sleep(interval)
  }
  throw new Error(`${label} 超时 ${timeout}ms（last=${String(last?.message ?? last).slice(0, 200)}）`)
}

// ── 选定空闲端口 + 启动生产实例 ──────────────────────────────────────────────
let port = 0
for (const p of [3141, 3140, 3139, 3138, 3137, 3136]) {
  try {
    const r = await fetch(`http://127.0.0.1:${p}/api/health`, { signal: AbortSignal.timeout(1200) })
    if (r.ok) continue
  }
  catch { /* 空闲 */ }
  port = p
  break
}
if (!port) {
  console.error('无空闲端口')
  process.exit(1)
}
const BASE = `http://127.0.0.1:${port}`
process.env.NO_PROXY = '127.0.0.1,localhost'
const logPath = join(ROOT, 'server.log')
const logFd = openSync(logPath, 'a')
const server = spawn(process.execPath, [join(REPO, '.output/server/index.mjs')], {
  cwd: REPO,
  env: {
    ...process.env,
    NODE_ENV: 'production',
    AW_MODE: 'home',
    AW_HOME: HOME,
    AW_RATE_LIMIT_OFF: '1',
    BACKUP_DISABLED: '1',
    NUXT_SESSION_PASSWORD: 'RsiLive#2026-e2e-session-key-32chars',
    PORT: String(port),
    HOST: '127.0.0.1',
    NO_PROXY: '127.0.0.1,localhost',
  },
  stdio: ['ignore', logFd, logFd],
  windowsHide: true,
})

async function api(method, path, body, token, timeoutMs = 180_000) {
  const res = await fetch(BASE + path, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  })
  let json = null
  try {
    json = await res.json()
  }
  catch { /* 非 JSON */ }
  return { status: res.status, ...(json ?? {}) }
}
const H = () => facts.token
const invText = r => String(r?.data?.result?.text ?? r?.data?.text ?? '')
const invErr = r => Boolean(r?.data?.result?.isError ?? r?.data?.isError)
const parseToolJson = (r) => {
  try {
    return JSON.parse(invText(r))
  }
  catch {
    return null
  }
}
const invokeAgent = (agentId, tool, args) => api('POST', '/api/workshop/agent-tools/invoke', { agentId, tool, args }, H())

let db
function openDb() {
  db = new DatabaseSync(join(HOME, 'data', 'workshop.sqlite'))
  db.exec('PRAGMA busy_timeout = 5000')
}
const qa = (sql, ...args) => db.prepare(sql).all(...args)
const q1 = (sql, ...args) => db.prepare(sql).get(...args)
const qrun = (sql, ...args) => db.prepare(sql).run(...args)

async function pendingCards() {
  return (await api('GET', '/api/workshop/hitl/pending', undefined, H())).data?.items ?? []
}
async function waitCard(known, prefix = '') {
  return waitFor(async () => {
    const items = await pendingCards()
    return items.find(x => !known.has(x.id) && String(x.nodeId ?? x.title ?? '').includes(prefix)) ?? null
  }, { timeout: 60_000, interval: 700, label: `HITL card ${prefix}` })
}
const cardIdSet = async () => new Set((await pendingCards()).map(x => x.id))
const approveCard = card => api('POST', '/api/workshop/hitl/respond', {
  kind: 'dcw-approval', id: card.id, confirmed: true, choice: 0, comment: 'RSI live E2E 批准',
}, H())
const rejectCard = card => api('POST', '/api/workshop/hitl/respond', {
  kind: 'dcw-approval', id: card.id, confirmed: false, comment: 'RSI live E2E 驳回：用于 advisory 采集',
}, H())

function waitTask(taskId, states = ['COMPLETED'], timeout = 120_000) {
  return waitFor(() => {
    const row = q1('SELECT id, state FROM tasks WHERE id = ?', taskId)
    return row && states.includes(row.state) ? row : null
  }, { timeout, interval: 500, label: `task ${taskId} → ${states.join('/')}` })
}

function pick(obj, ...paths) {
  for (const p of paths) {
    const v = p.split('.').reduce((x, k) => (x == null ? x : x[k]), obj)
    if (v !== undefined && v !== null) return v
  }
  return undefined
}

try {
  if (!existsSync(join(REPO, '.output/server/index.mjs'))) throw new Error('缺少 .output/server/index.mjs：请先 npx nuxi build')

  // ── 0. 实例就绪 + 管理员 ────────────────────────────────────────────────
  const healthy = await waitFor(async () => {
    try {
      const h = await api('GET', '/api/health', undefined, undefined, 3000)
      return h?.data?.status === 'ok' && h?.data?.workshop === 'ready'
    }
    catch {
      return false
    }
  }, { timeout: 150_000, interval: 1500, label: 'workshop ready' })
  ok('E1', '生产构建隔离实例启动（workshop ready）', Boolean(healthy), `port=${port} home=${HOME}`)
  openDb()
  const email = `rsi-live-${TAG}@awshop.local`
  const reg = await api('POST', '/api/users/register', { name: `rsi-live-admin-${TAG}`, email, password: 'RsiLive#2026' })
  facts.token = reg.data?.token
  facts.userId = reg.data?.user?.id
  ok('E2', 'admin 注册/登录', Boolean(facts.token), `status=${reg.status}`)
  if (!facts.token) throw new Error('注册失败')

  // ── 1. 真实产线/节点/配方/频道 ─────────────────────────────────────────
  const lineA = pick(await api('POST', '/api/workshop/dcw/lines', { name: `RSI-LineA-${TAG}` }, H()), 'data.line.id', 'data.id')
  const lineB = pick(await api('POST', '/api/workshop/dcw/lines', { name: `RSI-LineB-${TAG}` }, H()), 'data.line.id', 'data.id')
  const tpl = pick(await api('POST', '/api/workshop/dcw/templates', {
    name: `RSI-Param-${TAG}`, ch: 'temperature', unit: 'C', min: 0, max: 300, decimals: 1,
  }, H()), 'data.template.key', 'data.key')
  const nodeA = pick(await api('POST', '/api/workshop/dcw', {
    templateRef: tpl, name: `RSI-NodeA-${TAG}`, driver: 'mock', lineId: lineA, stepLimit: 30,
    driverConfig: { key: `rsi-${TAG}` },
  }, H()), 'data.node.id', 'data.id')
  const product = pick(await api('POST', '/api/workshop/dcw/products', { lineId: lineA, name: `RSI-Product-${TAG}` }, H()), 'data.product.id', 'data.id')
  const recipe = pick(await api('POST', '/api/workshop/dcw/recipes', {
    productId: product, name: `RSI-Recipe-${TAG}`, params: [{ nodeId: nodeA, value: 120, min: 0, max: 300 }],
  }, H()), 'data.recipe.id', 'data.id')
  const nodeB = pick(await api('POST', '/api/workshop/dcw', {
    templateRef: tpl, name: `RSI-NodeB-${TAG}`, driver: 'mock', lineId: lineB, stepLimit: 30,
    driverConfig: { key: `rsi-b-${TAG}` },
  }, H()), 'data.node.id', 'data.id')
  const productB = pick(await api('POST', '/api/workshop/dcw/products', { lineId: lineB, name: `RSI-ProductB-${TAG}` }, H()), 'data.product.id', 'data.id')
  const recipeB = pick(await api('POST', '/api/workshop/dcw/recipes', {
    productId: productB, name: `RSI-RecipeB-${TAG}`, params: [{ nodeId: nodeB, value: 120, min: 0, max: 300 }],
  }, H()), 'data.recipe.id', 'data.id')
  await api('POST', '/api/workshop/dcw/controller', { action: 'start' }, H())

  const createChannel = (name, lineId) => api('POST', '/api/workshop/channels', {
    name: `${name}-${TAG}`, lineId, leadAgent: { name: `${name}-Lead-${TAG}`, harness: 'mock' },
  }, H()).then(r => pick(r, 'data'))
  const chA = await createChannel('RSI-ChA', lineA)
  const chB = await createChannel('RSI-ChB', lineA)
  const chC = await createChannel('RSI-ChC', lineA)
  const chD = await createChannel('RSI-ChD', lineB)
  const chE = await createChannel('RSI-ChE', lineA)
  const addWorker = async (channelId, name, delayMs = 60_000) => pick(await api('POST', `/api/workshop/channels/${channelId}/agents`, {
    name: `${name}-${TAG}`, role: 'worker', harness: 'mock', config: { delayMs },
  }, H()), 'data.id', 'data.agentId')
  const cap1 = await addWorker(chA.channelId, 'RSI-Capture1', 60_000)
  const cap2 = await addWorker(chA.channelId, 'RSI-Capture2', 60_000)
  const workerD = await addWorker(chD.channelId, 'RSI-WorkerD', 200)
  const workerE = await addWorker(chE.channelId, 'RSI-WorkerE', 200)
  for (const id of [chA.channelId, chB.channelId, chC.channelId, chD.channelId, chE.channelId]) await api('POST', `/api/workshop/channels/${id}/activate`, {}, H())
  facts.env = { lineA, lineB, tpl, nodeA, product, recipe, nodeB, productB, recipeB, chA: chA.channelId, chB: chB.channelId, chC: chC.channelId, chD: chD.channelId, chE: chE.channelId }
  ok('E3', '真实产线/节点/配方/五频道（A/B/C/E 同线，D 异线；项目频道 lead-only）',
    Boolean(lineA && lineB && tpl && nodeA && product && recipe && nodeB && productB && recipeB && chA.channelId && chB.channelId && chC.channelId && chD.channelId && chE.channelId && cap1 && cap2 && workerD && workerE),
    JSON.stringify(facts.env))

  const rotate = async (channelId, agentId) => (await api('POST', `/api/workshop/channels/${channelId}/agents/${agentId}/rotate-token`, {}, H())).data?.token
  const completeAs = async (channelId, agentId, taskId, text) => {
    const token = await rotate(channelId, agentId)
    await waitTask(taskId, ['WORKING'], 90_000)
    return api('POST', `/api/workshop/tasks/${taskId}/complete`, {
      artifacts: [{ artifactId: `art-${TAG}-${taskId.slice(0, 6)}`, name: 'result.md', parts: [{ text }] }],
    }, token)
  }

  // ── 2. 任务作业 → 反射器自动沉淀经验 ──────────────────────────────────
  const submitTask = async (title, description, assigneeId) => pick(await api('POST', `/api/workshop/channels/${chA.channelId}/tasks`, {
    title, description, assigneeId, mode: 'goal', modeConfig: { completionPolicy: 'no-deliverable' },
  }, H()), 'data.id', 'data.taskId')
  const t1 = await submitTask(`Soak zone tuning round A ${TAG}`, 'Adjust soak zone target and report measured effect', cap1)
  const t2 = await submitTask(`Soak zone tuning round B ${TAG}`, 'Repeat soak zone adjustment on an independent work order', cap2)
  const c1Task = await completeAs(chA.channelId, cap1, t1, `Soak zone A ${TAG}: target 120C; IAE improved 8%; device readback 120.0C`)
  const c2Task = await completeAs(chA.channelId, cap2, t2, `Soak zone B ${TAG}: repeat run target 120C; IAE improved 7%; device readback 120.0C`)
  const done1 = await waitTask(t1)
  const done2 = await waitTask(t2)
  ok('E4', '两个独立任务经真实调度完成（人工 artifact 交付）',
    c1Task.status === 200 && c2Task.status === 200 && done1.state === 'COMPLETED' && done2.state === 'COMPLETED', `${t1}/${t2}`)

  const stats1 = (await api('GET', `/api/workshop/channels/${chA.channelId}/memories/experience-stats`, undefined, H())).data
  const expRows = qa(`SELECT id, title, outcome, status, scope_kind AS scopeKind, scope_key AS scopeKey, evidence_json AS evidenceJson, dedup_key AS dedupKey
                        FROM agent_memories WHERE channel_id = ? AND kind = 'experience' ORDER BY created_at ASC`, chA.channelId)
  const captureRows = expRows.filter(r => r.dedupKey === `exp:task:${t1}` || r.dedupKey === `exp:task:${t2}`)
  ok('E5', '任务终态自动沉淀 line 经验（candidate + taskIds 证据）',
    captureRows.length === 2 && captureRows.every(r => r.status === 'candidate' && r.scopeKind === 'line' && r.scopeKey === lineA
      && (JSON.parse(r.evidenceJson || '{}').taskIds ?? []).length === 1),
    `total=${stats1?.total} byStatus=${JSON.stringify(stats1?.byStatus)} capture=${captureRows.length}`)
  facts.captureExperiences = captureRows.map(r => ({ id: r.id, title: r.title, status: r.status }))

  const singlePromote = await api('POST', `/api/workshop/channels/${chA.channelId}/memories/${captureRows[0].id}/promote`, { to: 'validated' }, H())
  ok('E6', '经验门 fail-closed：单任务证据拒绝 validated',
    singlePromote.status === 200 && singlePromote.data?.ok === false && /独立任务样本不足/.test(JSON.stringify(singlePromote.data?.reasons ?? [])),
    JSON.stringify(singlePromote.data ?? singlePromote).slice(0, 240))

  // ── 3. 项目 P1（任务实例 + write_intent + HITL）：mismatch → review 阻断 ──
  const createProject = async (name, objective) => pick(await api('POST', '/api/workshop/projects', {
    name, objective, successCriteria: ['artifact present', 'readback verified'],
    leaderHarness: 'mock', routingPolicy: 'technical', mode: 'supervised',
  }, H()), 'data')
  const setupProject = async (project, channelId, title, writeLineId, writeRecipeId) => {
    const bind = await api('POST', `/api/workshop/projects/${project.id}/channels`, { channelId, charter: 'RSI live E2E production work' }, H())
    const deliverable = pick(await api('POST', `/api/workshop/projects/${project.id}/deliverables`, {
      name: `${title} report ${TAG}`, ownerChannelId: channelId, acceptanceCriteria: ['artifact.present'],
    }, H()), 'data')
    const wi = pick(await api('POST', `/api/workshop/projects/${project.id}/work-items`, {
      deliverableId: deliverable.id, channelId, title: `${title} [mock:complex]`,
      brief: 'Execute the tuning job and provide artifact-backed result [mock:complex]',
      execBudgetMinutes: 60, dedupeKey: `${title}:${TAG}`,
    }, H()), 'data')
    await api('POST', `/api/workshop/projects/${project.id}/activate`, {}, H())
    const plan = await api('POST', `/api/workshop/projects/${project.id}/plan/request-approval`, {
      version: 1,
      plan: {
        facts: ['line and recipe verified'],
        deliverables: [{ key: deliverable.id, name: deliverable.name, channelId, acceptanceCriteria: ['artifact.present'] }],
        work_items: [{
          key: wi.id, deliverableKey: deliverable.id, channelId, title: `${title} [mock:complex]`,
          brief: 'Execute the tuning job and provide artifact-backed result [mock:complex]', execBudgetMinutes: 60,
        }],
      },
    }, H())
    if (plan.data?.id) await api('POST', `/api/workshop/projects/${project.id}/approvals/${plan.data.id}/decide`, { approve: true, reason: 'E2E plan' }, H())
    const dispatch = await api('POST', `/api/workshop/projects/${project.id}/work-items/${wi.id}/dispatch`, {}, H())
    const attempt = await waitFor(() => q1(
      'SELECT channel_id AS channelId FROM project_work_item_attempts WHERE work_item_id = ? ORDER BY attempt_no DESC LIMIT 1', wi.id,
    ), { timeout: 30_000, interval: 500, label: 'task instance attempt' })
    const instanceChannelId = attempt.channelId
    const root = q1('SELECT id FROM tasks WHERE project_work_item_id = ? ORDER BY created_at DESC LIMIT 1', wi.id)
    const leadId = q1(`SELECT id FROM channel_agents WHERE channel_id = ? AND role = 'lead'`, instanceChannelId)?.id
    // 任务实例 Channel 不继承 line 绑定（D5 只继承 AML profile）→ 显式绑定后才能调 line_start
    await api('PUT', `/api/workshop/channels/${instanceChannelId}/line`, { lineId: writeLineId }, H())
    // 实例 lead 继承母 lead 的绑定面（母 lead 未绑节点）→ 显式授予配方操作权（trial 的授权面）
    await api('POST', '/api/workshop/agent-tools/bindings', { agentId: leadId, nodeId: writeRecipeId, kind: 'recipe' }, H())
    await waitTask(root.id, ['WORKING'], 90_000)
    return { bind, deliverable, wi, dispatch, root, instanceChannelId, leadId }
  }
  const requestWriteIntent = async (projectId, leadId, rootId, tool, args, reason) => {
    const r = await invokeAgent(leadId, 'project_request_write_intent', { tool, args, reason, task_id: rootId })
    const body = parseToolJson(r)
    if (!body?.approvalId) throw new Error(`write_intent 申请失败: ${invText(r).slice(0, 240)}`)
    const dec = await api('POST', `/api/workshop/projects/${projectId}/approvals/${body.approvalId}/decide`, { approve: true, reason: 'E2E write intent' }, H())
    return { body, dec }
  }
  const governedWrite = async (leadId, tool, args, prefix) => {
    const known = await cardIdSet()
    const p = invokeAgent(leadId, tool, args)
    // 竞态：要么出现审批卡（等待人工），要么调用提前返回（参数/授权/频控拒绝）
    const first = await Promise.race([
      waitCard(known, prefix).then(card => ({ card })),
      p.then(r => ({ early: r })),
      sleep(20_000).then(() => ({ timeout: true })),
    ])
    if (first.card) {
      await approveCard(first.card)
      return { card: first.card, r: await p }
    }
    return { card: null, r: first.early ?? await p }
  }
  const reconcileDraft = async (projectId, wiId) => {
    await api('POST', `/api/workshop/projects/${projectId}/reconcile`, {}, H())
    const items = (await api('GET', `/api/workshop/projects/${projectId}/work-items`, undefined, H())).data ?? []
    const results = (await api('GET', `/api/workshop/projects/${projectId}/results`, undefined, H())).data ?? []
    return { wiState: items.find(x => x.id === wiId)?.state, draft: results.find(x => x.status === 'draft') }
  }

  const p1 = await createProject(`RSI Project Negative ${TAG}`, 'Prove blind readback blocks a false-done result')
  const s1 = await setupProject(p1, chB.channelId, 'Soak zone governed write', lineA, recipe)
  ok('E7', 'P1 项目→任务实例 Channel→计划门→派发（root 在实例频道）',
    Boolean(p1?.id && s1.deliverable?.id && s1.wi?.id && s1.root?.id && s1.instanceChannelId && s1.leadId && s1.dispatch.status === 200),
    `project=${p1?.id} wi=${s1.wi?.id} root=${s1.root?.id} instance=${s1.instanceChannelId}`)

  const startArgs = { recipe_id: recipe, reason: 'RSI live E2E approved start' }
  const wiStart = await requestWriteIntent(p1.id, s1.leadId, s1.root.id, 'line_start', startArgs, 'line start for governed tuning')
  ok('E8', '项目 write_intent 申请/批准（line_start）',
    wiStart.dec.status === 200 && wiStart.dec.data?.status === 'approved' && String(wiStart.body.digest ?? '').length === 64,
    `approval=${wiStart.body.approvalId} digest=${String(wiStart.body.digest).slice(0, 12)}…`)
  const start = await governedWrite(s1.leadId, 'line_start', startArgs, `line-start:${lineA}`)
  ok('E9', 'write_intent + HITL 双批准后 line_start 开跑且参数设备证实',
    !invErr(start.r) && /已开跑/.test(invText(start.r)) && /全部设备证实/.test(invText(start.r)), invText(start.r).slice(0, 240))

  // 节点级在线写间隔 60s（emergency 只豁免配方级频控，不豁免设备层间隔）→ 等过窗口再下发第二次写
  await sleep(62_000)

  const trialArgs = {
    recipe_id: recipe, params: [{ node_id: nodeA, value: 140 }],
    hypothesis: 'RSI live E2E: deliberate post-write divergence to prove blind verification', emergency: true,
  }
  const wiTrial = await requestWriteIntent(p1.id, s1.leadId, s1.root.id, 'recipe_trial', trialArgs, 'trial 140 for divergence drill')
  const trial = await governedWrite(s1.leadId, 'recipe_trial', trialArgs, '')
  ok('E10', 'write_intent + HITL 批准后 recipe_trial 下发 140（制造回读偏差）',
    wiTrial.dec.status === 200 && !invErr(trial.r), invText(trial.r).slice(0, 240))

  const root1Done = await completeAs(s1.instanceChannelId, s1.leadId, s1.root.id,
    `Soak zone governed write report ${TAG}: target 120C then trial 140C; IAE improved 8%; device readback captured.`)
  await waitTask(s1.root.id)
  ok('E11', 'P1 root 任务完成（真实 artifact 交付）', root1Done.status === 200, `status=${root1Done.status}`)

  const ver1 = await waitFor(() => {
    const rows = qa(`SELECT verdict, detail, task_id AS taskId FROM blind_verifications WHERE task_id = ?`, s1.root.id)
    return rows.length >= 2 ? rows : null
  }, { timeout: 30_000, interval: 700, label: 'blind verifications for P1 root' })
  const verdicts1 = ver1.map(r => r.verdict)
  ok('E12', 'C1 独立回读：同一任务内 mismatch 与 match 均落库（task_id 归属）',
    verdicts1.includes('mismatch') && verdicts1.includes('match'),
    JSON.stringify(ver1.map(r => ({ verdict: r.verdict, detail: String(r.detail).slice(0, 80) }))))

  const d1 = await reconcileDraft(p1.id, s1.wi.id)
  ok('E13', 'Reconciler 生成成果 draft（绑定 root task artifact）', Boolean(d1.draft?.id), `wi=${d1.wiState} result=${d1.draft?.id}`)
  const submitted1 = await api('POST', `/api/workshop/projects/${p1.id}/results/${d1.draft.id}/submit`, {
    summary: 'Soak zone write completed; readback evidence attached',
    method: 'line_start + recipe_trial via write_intent/HITL', validityScope: `line:${lineA}`,
  }, H())
  const negReview = await api('POST', `/api/workshop/projects/${p1.id}/results/${d1.draft.id}/review`, { decision: 'reviewed' }, H())
  ok('E14', 'C1→L1：回读 mismatch 使 review 409 阻断（False-Done 被拦）',
    negReview.status === 409 && negReview.code === 'ACCEPTANCE_CRITERIA_FAILED' && /blind\.readback/.test(JSON.stringify(negReview.data ?? negReview.message ?? negReview)),
    `status=${negReview.status} code=${negReview.code} msg=${String(negReview.message ?? '').slice(0, 200)}`)
  ok('E14b', 'owner 提交成果成功（submitted）',
    submitted1.status === 200 && submitted1.data?.status === 'submitted', `status=${submitted1.status} state=${submitted1.data?.status}`)

  // ── 4. 项目 P2（Channel B，同产线）：回读 match → review 通过 → 经验+KB ──
  const p2 = await createProject(`RSI Project Positive ${TAG}`, 'Prove a verified write passes L1 and crystallizes knowledge')
  const s2 = await setupProject(p2, chC.channelId, 'Soak zone verified write', lineB, recipeB)
  const startBArgs = { recipe_id: recipeB, reason: 'RSI live E2E approved start on line B' }
  const wiStartB = await requestWriteIntent(p2.id, s2.leadId, s2.root.id, 'line_start', startBArgs, 'start line B for verified write')
  const startB = await governedWrite(s2.leadId, 'line_start', startBArgs, `line-start:${lineB}`)
  ok('E15a', 'P2 line_start（write_intent + HITL）开跑 line B',
    wiStartB.dec.status === 200 && !invErr(startB.r) && /已开跑/.test(invText(startB.r)), invText(startB.r).slice(0, 200))
  await sleep(62_000)
  const restoreArgs = {
    recipe_id: recipeB, params: [{ node_id: nodeB, value: 120 }],
    hypothesis: 'RSI live E2E: restore verified setpoint before acceptance', emergency: true,
  }
  const wiRestore = await requestWriteIntent(p2.id, s2.leadId, s2.root.id, 'recipe_trial', restoreArgs, 'restore verified setpoint')
  const restore = await governedWrite(s2.leadId, 'recipe_trial', restoreArgs, '')
  ok('E15', 'P2 write_intent + HITL 双批准后下发 120（复原）',
    wiRestore.dec.status === 200 && !invErr(restore.r), invText(restore.r).slice(0, 200))
  const root2Done = await completeAs(s2.instanceChannelId, s2.leadId, s2.root.id,
    `Soak zone verified report ${TAG}: setpoint 120C confirmed by independent device readback; IAE stable.`)
  await waitTask(s2.root.id)
  const ver2 = await waitFor(() => {
    const rows = qa(`SELECT verdict FROM blind_verifications WHERE task_id = ?`, s2.root.id)
    return rows.length >= 2 ? rows : null
  }, { timeout: 30_000, interval: 700, label: 'blind verifications for P2 root' })
  ok('E16', 'P2 回读全部 match（独立设备值=指令值）',
    root2Done.status === 200 && ver2.length >= 1 && ver2.every(r => r.verdict === 'match'),
    `task=${s2.root.id} verdicts=${ver2.map(r => r.verdict).join(',')}`)
  const d2 = await reconcileDraft(p2.id, s2.wi.id)
  const submitted2 = await api('POST', `/api/workshop/projects/${p2.id}/results/${d2.draft.id}/submit`, {
    summary: 'Verified soak zone setpoint; device readback matches command',
    method: 'recipe_trial via write_intent/HITL + independent readback', validityScope: `line:${lineB}`,
  }, H())
  const posReview = await api('POST', `/api/workshop/projects/${p2.id}/results/${d2.draft.id}/review`, { decision: 'reviewed' }, H())
  ok('E17', 'C1→L1：回读 match → review 通过（无假阴性）',
    posReview.status === 200 && posReview.data?.status === 'reviewed',
    `status=${posReview.status} state=${posReview.data?.status} submit=${submitted2.status}`)

  const reviewExp = await waitFor(() => {
    const row = q1(`SELECT id, title, outcome, status, scope_kind AS scopeKind, scope_key AS scopeKey, evidence_json AS evidenceJson
                      FROM agent_memories WHERE channel_id = ? AND kind = 'experience' AND dedup_key LIKE 'exp:review:%'
                      ORDER BY created_at DESC LIMIT 1`, chC.channelId)
    return row ?? null
  }, { timeout: 30_000, interval: 700, label: 'review experience' })
  const kbProposal = q1(`SELECT id, kind, status, evidence_json AS evidenceJson FROM improvement_proposals
                           WHERE kind = 'kb_ingest' AND source_id = ?`, d2.draft.id)
  ok('E18', '评审终态沉淀经验 + kb_ingest 候选（D3）',
    reviewExp.outcome === 'positive' && reviewExp.scopeKind === 'line' && reviewExp.status === 'candidate'
    && JSON.parse(reviewExp.evidenceJson || '{}').resultId === d2.draft.id && Boolean(kbProposal),
    `exp=${reviewExp.id} kb=${kbProposal?.id ?? 'none'}`)
  facts.reviewExperience = { id: reviewExp.id, kbProposalId: kbProposal?.id }

  // ── 5. 证据合并（P1 已知缺口的策展路径）→ validated → 跨 Channel ──────
  const mergedTaskIds = [t1, t2]
  const mergedEvidence = { ...JSON.parse(captureRows[0].evidenceJson || '{}'), taskIds: mergedTaskIds }
  const mergedTitle = `Soak zone tuning replicated (${TAG})`
  const ftsTitle = mergedTitle.replace(/[()]/g, ' ')
  qrun(`UPDATE agent_memories SET title = ?, title_fts = ?, evidence_json = ? WHERE id = ?`,
    mergedTitle, ftsTitle, JSON.stringify(mergedEvidence), captureRows[0].id)
  const mergedPromote = await api('POST', `/api/workshop/channels/${chA.channelId}/memories/${captureRows[0].id}/promote`, { to: 'validated' }, H())
  const mergedRow = q1('SELECT status FROM agent_memories WHERE id = ?', captureRows[0].id)
  ok('E19', '证据合并（2 独立任务）后经验晋级 validated',
    mergedPromote.status === 200 && mergedPromote.data?.ok === true && mergedRow.status === 'validated',
    `ok=${mergedPromote.data?.ok} reasons=${JSON.stringify(mergedPromote.data?.reasons ?? []).slice(0, 160)}`)

  const readSameLine = await invokeAgent(workerE, 'search_memory', { query: 'Soak zone tuning replicated', scope: 'line' })
  const readOtherLine = await invokeAgent(workerD, 'search_memory', { query: 'Soak zone tuning replicated', scope: 'line' })
  ok('E20', '同产线跨 Channel 成员读回 validated 经验', !invErr(readSameLine) && /validated/.test(invText(readSameLine)) && /Soak zone tuning/.test(invText(readSameLine)),
    invText(readSameLine).slice(0, 220))
  ok('E21', '异产线零命中（隔离负样本）', /无命中/.test(invText(readOtherLine)), invText(readOtherLine).slice(0, 160))

  // ── 6. advisory（Channel D 无项目绑定，直接治理写被拒）────────────────
  {
    const known = await cardIdSet()
    const p = invokeAgent(chE.leadAgentId, 'line_stop', { reason: 'RSI live E2E rejected stop (advisory source)' })
    const card = await waitCard(known, `line-stop:${lineA}`)
    if (card) await rejectCard(card)
    const r = await p
    const persisted = card ? q1('SELECT status FROM hitl_requests WHERE id = ?', card.id)?.status : ''
    ok('E22', '被驳回的 line_stop 落 HITL 拒绝事实（advisory 来源）',
      Boolean(card) && persisted === 'rejected' && /未获批准|未做任何变更/.test(invText(r)),
      `card=${card?.id ?? 'none'} persisted=${persisted} text=${invText(r).slice(0, 120)}`)
  }

  // ── 7. B2 配对 → Profile shadow→active → 注入预览 → 回滚 ────────────────
  const runnerA = join(ROOT, 'runner-a.mjs')
  const runnerB = join(ROOT, 'runner-b.mjs')
  writeFileSync(runnerA, `const seed = Number(process.argv[2] ?? 0)\nconsole.log(JSON.stringify({ primary: 100 + seed, cost: 1 }))\n`)
  writeFileSync(runnerB, `const seed = Number(process.argv[2] ?? 0)\nconsole.log(JSON.stringify({ primary: 90 + seed, cost: 1.01 }))\n`)
  const benchOut = join(ROOT, 'bench.json')
  const ab = spawnSync(process.execPath, [join(REPO, 'bench/experiment/harness-ab.mjs'),
    '--seeds', '1,2,3,4,5,6,7,8,9,10',
    '--cmd-a', `"${process.execPath}" "${runnerA}" {seed}`,
    '--cmd-b', `"${process.execPath}" "${runnerB}" {seed}`,
    '--min-pairs', '10', '--out', benchOut,
  ], { encoding: 'utf8', timeout: 120_000 })
  const bench = existsSync(benchOut) ? JSON.parse(readFileSync(benchOut, 'utf8')) : null
  ok('E23', 'B2 配对评测产出显著改善结果（p<0.05，成本非劣）',
    ab.status === 0 && bench && bench.pValue !== null && bench.pValue < 0.05 && bench.primaryDelta > 0 && bench.costDelta <= 0.05,
    bench ? `p=${bench.pValue} Δ=${bench.primaryDelta} cost=${bench.costDelta} n=${bench.pairs}` : `exit=${ab.status} ${ab.stderr?.slice(0, 200)}`)

  const prof1 = pick(await api('POST', `/api/workshop/channels/${chE.channelId}/harness-profiles`, {
    overlay: 'Prefer the pinned soak-zone experience; governance gates unchanged.',
    pins: [captureRows[0].id],
    origin: { source: 'rsi-live-e2e' },
  }, H()), 'data.profile')
  const shadow1 = await api('POST', `/api/workshop/channels/${chE.channelId}/harness-profiles/promote`, { profileId: prof1.id, to: 'shadow' }, H())
  const activeNoBench = await api('POST', `/api/workshop/channels/${chE.channelId}/harness-profiles/promote`, { profileId: prof1.id, to: 'active' }, H())
  const active1 = await api('POST', `/api/workshop/channels/${chE.channelId}/harness-profiles/promote`, {
    profileId: prof1.id, to: 'active', bench: { pValue: bench.pValue, primaryDelta: bench.primaryDelta, costDelta: bench.costDelta },
  }, H())
  ok('E24', 'B3 门：shadow 放行 / 无 bench 拒 active / 带配对结果放行',
    shadow1.data?.ok === true && activeNoBench.data?.ok === false && active1.data?.ok === true,
    `shadow=${shadow1.data?.ok} noBench=${activeNoBench.data?.ok} withBench=${active1.data?.ok}`)

  // 缓存 TTL 60s：等待后读取真实注入文本
  await sleep(61_000)
  const pv1 = (await api('GET', `/api/workshop/channels/${chE.channelId}/harness-profiles`, undefined, H())).data
  ok('E25', '注入预览含跨频道 pinned 经验 + 指令隔离声明 + advisory（执行闸门不变）',
    typeof pv1?.preview === 'string' && pv1.preview.includes(mergedTitle) && pv1.preview.includes('不是指令覆盖')
    && pv1.preview.includes('advisory') && pv1.preview.includes('执行闸门不变'),
    `len=${pv1?.preview?.length ?? 0} preview=${String(pv1?.preview ?? '').slice(0, 220)}`)
  facts.preview = pv1?.preview ?? ''

  const prof2 = pick(await api('POST', `/api/workshop/channels/${chE.channelId}/harness-profiles`, {
    overlay: 'Second overlay version for rollback drill.',
    pins: [captureRows[0].id],
  }, H()), 'data.profile')
  await api('POST', `/api/workshop/channels/${chE.channelId}/harness-profiles/promote`, { profileId: prof2.id, to: 'shadow' }, H())
  const active2 = await api('POST', `/api/workshop/channels/${chE.channelId}/harness-profiles/promote`, {
    profileId: prof2.id, to: 'active', bench: { pValue: bench.pValue, primaryDelta: bench.primaryDelta, costDelta: bench.costDelta },
  }, H())
  const rollback = await api('POST', `/api/workshop/channels/${chE.channelId}/harness-profiles/promote`, { rollback: true }, H())
  const activeAfter = (await api('GET', `/api/workshop/channels/${chE.channelId}/harness-profiles`, undefined, H())).data?.active
  ok('E26', 'B4 回滚：v2 active → rollback 恢复 v1（单 active）',
    active2.data?.ok === true && rollback.data?.ok === true && activeAfter?.id === prof1.id,
    `active2=${active2.data?.ok} rollback=${rollback.data?.ok} active=${activeAfter?.version}`)

  // ── 8. 看板 + 元层 + DB 事实 ────────────────────────────────────────────
  const impA = (await api('GET', `/api/workshop/channels/${chA.channelId}/improvement-stats`, undefined, H())).data
  const impD = (await api('GET', `/api/workshop/channels/${chE.channelId}/improvement-stats`, undefined, H())).data
  const impStats = [...(impA?.stats ?? []), ...(impD?.stats ?? [])]
  const impKinds = new Set(impStats.map(s => s.actionKind))
  ok('E27', 'C3 元层成效：经验/Profile/回滚动作成功率可查',
    impKinds.has('experience_promote') && impKinds.has('profile_promote') && impKinds.has('profile_rollback')
    && impStats.every(s => typeof s.rate === 'number' && s.total > 0),
    JSON.stringify(impStats).slice(0, 320))

  const boardRows = qa('SELECT verdict, task_id AS taskId FROM blind_verifications ORDER BY created_at ASC')
  ok('E28', 'C1 验证台账可查（match/mismatch 均可见，含 task 归属）',
    boardRows.length >= 2 && boardRows.some(r => r.verdict === 'match') && boardRows.some(r => r.verdict === 'mismatch')
    && boardRows.every(r => String(r.taskId).length > 0),
    `rows=${boardRows.length} verdicts=${[...new Set(boardRows.map(r => r.verdict))].join(',')}`)

  const actionsA = qa('SELECT action_kind AS actionKind, decision FROM improvement_actions WHERE channel_id = ?', chA.channelId)
  const actionsD = qa('SELECT action_kind AS actionKind, decision FROM improvement_actions WHERE channel_id = ?', chE.channelId)
  const audit = qa(`SELECT action FROM audit_log WHERE target_id IN (?, ?)`, prof1.id, prof2.id)
  ok('E29', 'DB 事实：晋升/回滚动作入表 + 审计可查',
    actionsA.some(a => a.actionKind === 'experience_promote')
    && actionsD.some(a => a.actionKind === 'profile_rollback')
    && audit.length >= 2,
    `expActions=${actionsA.length} profileActions=${actionsD.length} audit=${audit.length}`)

  const redline = spawnSync(process.execPath, [join(REPO, 'scripts/check-rsi-redline.mjs')], { encoding: 'utf8' })
  ok('E30', '红线静态证明：RSI 学习环 0 设备写调用', redline.status === 0 && /PASS/.test(redline.stdout), String(redline.stdout).trim().slice(0, 120))
}
catch (err) {
  ok('HALT', '端到端流程未完成', false, err instanceof Error ? `${err.message}\n${err.stack?.split('\n').slice(1, 3).join('\n')}` : String(err))
}
finally {
  try {
    db?.close()
  }
  catch { /* ignore */ }
  server.kill('SIGTERM')
  await sleep(800)
  if (!KEEP) {
    rmSync(ROOT, { recursive: true, force: true })
  }
  else {
    console.log(`[keep] 现场保留: ${ROOT}`)
  }

  const pass = results.filter(r => r.pass).length
  const fail = results.filter(r => !r.pass).length
  const report = {
    kind: 'rsi-live-e2e',
    at: new Date().toISOString(),
    base: BASE,
    main: spawnSync('git', ['rev-parse', 'HEAD'], { cwd: REPO, encoding: 'utf8' }).stdout.trim(),
    home: KEEP ? HOME : '(removed)',
    pass,
    fail,
    total: results.length,
    results,
    facts,
  }
  writeFileSync(join(EVIDENCE_DIR, 'report.json'), `${JSON.stringify(report, null, 2)}\n`)
  const md = [
    '# RSI 真实环境端到端验收（2026-11-09）',
    '',
    `- 运行时间：${report.at}`,
    `- 代码版本：\`${report.main}\``,
    `- 结果：**PASS ${pass} / FAIL ${fail} / 共 ${results.length}**`,
    '',
    '| # | 断言 | 结果 | 证据 |',
    '|---|---|---|---|',
    ...results.map(r => `| ${r.id} | ${r.name.replace(/\|/g, '\\|')} | ${r.pass ? 'PASS' : 'FAIL'} | ${r.detail.replace(/\|/g, '\\|').slice(0, 220)} |`),
    '',
    '> 说明：生产构建 + 隔离 AW_HOME；产线设备为平台内置 mock 驱动（真实 DCW/DAQ 代码路径）；'
    + 'B2 配对使用合成 runner 验证统计与门接口链路，不是生产场景基准；Mimosa 扫描仍未完成，不宣称项目安全。',
  ].join('\n')
  writeFileSync(join(EVIDENCE_DIR, 'report.md'), `${md}\n`)
  console.log(`\n=== RSI LIVE E2E  pass=${pass} fail=${fail} total=${results.length} ===`)
  console.log(`evidence: ${join(EVIDENCE_DIR, 'report.md')}`)
  if (fail > 0) process.exitCode = 1
}
