/**
 * 断线重连 + 状态持久化 端到端真实测试(对运行中的 dev server)。
 *
 * 场景 A(常规执行监控):用已有 channel 的 lead 配置一个新的慢速 channel
 *  (mock delayMs=4000),提交任务 → 轮询观察 WORKING → COMPLETED → 全员 idle。
 * 场景 B(断线重连):提交慢任务 → 等到 WORKING → 硬杀服务器(taskkill /F,模拟崩溃)
 *  → 验证 DB 中任务停留 WORKING(状态持久化)→ 重启服务器 → 验证任务被自动
 *  重新装配执行至 COMPLETED(断线重连),且 agent 回 idle。
 * 场景 C(消费缺口重投):直接 sqlite 把 WORKING 任务的 assign 消息改为 consumed
 *  (模拟"消息已消费但任务未完成"缺口)→ 重启 → restore 重投 → COMPLETED。
 *
 * 用法:
 *   node scripts/e2e-resume-crash.mjs watch        # 场景 A
 *   node scripts/e2e-resume-crash.mjs crash        # 场景 B(杀服务器→输出状态→退出)
 *   node scripts/e2e-resume-crash.mjs verify       # 场景 B(重启后验证自动恢复)
 *   node scripts/e2e-resume-crash.mjs gap          # 场景 C(制造缺口→杀→退出)
 *   node scripts/e2e-resume-crash.mjs verify-gap   # 场景 C(重启后验证重投恢复)
 */
import { DatabaseSync } from 'node:sqlite'

const BASE = 'http://127.0.0.1:3000/api/workshop'
const DB_PATH = 'data/workshop.sqlite'
const DELAY_MS = 6000

let pass = 0
let fail = 0
function check(name, ok, detail = '') {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
  if (ok) pass++
  else fail++
}
const sleep = ms => new Promise(r => setTimeout(r, ms))

// 用户级隔离:注册测试用户;管理面 API 全程携带用户 token。
// 跨阶段复用(crash→重启→verify):AW_RESUME_TOKEN 环境变量优先 —— verify 阶段的 channel
// 属于 crash 阶段注册的用户,新注册用户看不该 channel(403),必须沿用同一 token。
let __user
if (process.env.AW_RESUME_TOKEN) {
  __user = { data: { token: process.env.AW_RESUME_TOKEN } }
}
else {
  __user = await fetch(BASE + '/users/register', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'e2e-' + Math.random().toString(36).slice(2, 10) }),
  }).then(r => r.json()).catch(() => null)
}
const __userToken = __user?.data?.token
if (!__userToken) {
  console.error('用户注册失败')
  process.exit(1)
}

async function req(method, path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${__userToken}`,
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  })
  return { status: res.status, json: await res.json().catch(() => null) }
}

/** 直接查 sqlite(WAL 只读;镜像进程外视角验证持久化) */
function dbQuery(sql, ...params) {
  const db = new DatabaseSync(DB_PATH, { readOnly: true })
  try {
    return db.prepare(sql).all(...params)
  }
  finally {
    db.close()
  }
}

async function makeSlowChannel(name) {
  // 独立慢速 channel:lead + 1 worker,全部 mock delayMs=DELAY_MS
  const leadTpl = await req('POST', '/agents', { name: `${name}-lead`, harness: 'mock', config: { delayMs: DELAY_MS } })
  const workerTpl = await req('POST', '/agents', { name: `${name}-worker`, harness: 'mock', config: { delayMs: DELAY_MS } })
  const ch = await req('POST', '/channels', { name, description: `resume e2e ${name}` })
  const channelId = ch.json.data.channelId
  await req('POST', `/channels/${channelId}/agents`, { agentId: leadTpl.json.data.id, role: 'lead' })
  await req('POST', `/channels/${channelId}/agents`, { agentId: workerTpl.json.data.id, role: 'worker' })
  return channelId
}

async function submitTask(channelId, title) {
  const r = await req('POST', `/channels/${channelId}/tasks`, { title, description: `${title} — resume e2e` })
  return r.json.data.id
}

async function waitState(taskId, states, timeoutMs) {
  const start = Date.now()
  let last = ''
  while (Date.now() - start < timeoutMs) {
    const { json } = await req('GET', `/tasks/${taskId}`)
    last = json?.data?.state ?? '(none)'
    if (states.includes(last)) return last
    await sleep(400)
  }
  return last
}

// ───────── 场景 A:常规执行监控 ─────────
async function watch() {
  console.log('━━━ 场景 A:提交任务 → 监控 WORKING → COMPLETED → idle ━━━')
  const channelId = await makeSlowChannel('watch')
  const taskId = await submitTask(channelId, 'watch-task')
  check('提交任务', !!taskId, `task=${taskId.slice(0, 8)}…`)

  // 观察到 WORKING(子任务执行中)
  const sawWorking = await waitState(taskId, ['WORKING'], 8000) === 'WORKING'
  // 注:父任务 WAITING、子任务 WORKING;查 channel 任务列表确认有 WORKING
  const chTasks = await req('GET', `/channels/${channelId}/tasks`)
  const anyWorking = (chTasks.json.data ?? []).some(t => t.state === 'WORKING')
  check('执行中出现 WORKING(真实执行)', sawWorking || anyWorking, `sawWorking=${sawWorking} anyWorking=${anyWorking}`)

  const finalState = await waitState(taskId, ['COMPLETED', 'FAILED', 'CANCELED'], 30_000)
  check('任务执行至 COMPLETED', finalState === 'COMPLETED', `state=${finalState}`)

  // 全员 idle(执行完成的 agent 状态必须回空闲)
  await sleep(1500)
  const queue = await req('GET', `/channels/${channelId}/queue`)
  const states = (queue.json.data ?? []).map(a => `${a.name}:${a.state}`)
  check('执行完成后全员 idle', (queue.json.data ?? []).every(a => a.state === 'idle'), JSON.stringify(states))

  await req('DELETE', `/channels/${channelId}`)
  console.log(`\n结果: PASS=${pass} FAIL=${fail}`)
  process.exit(fail === 0 ? 0 : 1)
}

// ───────── 场景 B:崩溃 → 持久化 → 重启自动恢复 ─────────
async function crash() {
  console.log('━━━ 场景 B:WORKING 中硬杀服务器 → 验证 DB 持久化 ━━━')
  const channelId = await makeSlowChannel('crash')
  const taskId = await submitTask(channelId, 'crash-task')
  await waitState(taskId, ['WORKING', 'WAITING'], 8000)
  const chTasks = await req('GET', `/channels/${channelId}/tasks`)
  const working = (chTasks.json.data ?? []).find(t => t.state === 'WORKING')
  check('杀前存在 WORKING 任务', !!working, working ? `task=${working.id.slice(0, 8)}…` : '')
  if (!working) process.exit(1)

  // 硬杀(taskkill /F 不走 graceful close,模拟崩溃断电)
  const { execSync } = await import('node:child_process')
  const pid = execSync('netstat -ano | findstr :3000 | findstr LISTENING').toString().match(/(\d+)\s*$/)?.[1]
  execSync(`taskkill /PID ${pid} /F`)
  console.log(`  服务器已硬杀(pid=${pid})`)
  await sleep(1200)

  // 进程外视角直接查 sqlite:WORKING 必须持久化在盘上
  const rows = dbQuery('SELECT id, state FROM tasks WHERE id = ?', working.id)
  check('崩溃后 DB 中任务仍 WORKING(持久化)', rows[0]?.state === 'WORKING', `db.state=${rows[0]?.state}`)
  // 写入标记文件供 verify 阶段使用
  const { writeFileSync } = await import('node:fs')
  writeFileSync('.resume-test.json', JSON.stringify({ channelId, taskId, workerTaskId: working.id, token: __userToken }))
  console.log(`  标记写入 .resume-test.json (channel=${channelId.slice(0, 8)}… task=${taskId.slice(0, 8)}…)`)
  console.log(`\n结果: PASS=${pass} FAIL=${fail}`)
  process.exit(fail === 0 ? 0 : 1)
}

async function verify() {
  console.log('━━━ 场景 B:重启 → 断线重连自动恢复执行 ━━━')
  const { readFileSync, unlinkSync } = await import('node:fs')
  const mark = JSON.parse(readFileSync('.resume-test.json', 'utf8'))
  console.log(`  恢复目标: task=${mark.taskId.slice(0, 8)}… (workerTask=${mark.workerTaskId.slice(0, 8)}…)`)

  // 重启后立即查 DB:消息应已重投(resetConsuming/redeliverAssign 落库)。
  // dev server 首次请求才懒编译路由,restore 在 HTTP 可达前已跑完 —— 慢 worker 可能
  // 已被快速接走甚至完成(consumed),故按"存在重投轨迹"断言(pending/consuming/consumed)。
  const pending = dbQuery(
    `SELECT COUNT(*) AS n FROM messages WHERE task_id = ? AND state IN ('pending', 'consuming', 'consumed')`,
    mark.workerTaskId,
  )
  check('重启后 assign 重投轨迹存在(pending/consuming/consumed)', pending[0].n > 0, `trail=${pending[0].n}`)

  // 等待自动恢复执行至 COMPLETED(restore 唤醒 → worker 重放)
  const finalState = await waitState(mark.taskId, ['COMPLETED', 'FAILED', 'CANCELED'], 40_000)
  check('断线重连:任务自动恢复至 COMPLETED', finalState === 'COMPLETED', `state=${finalState}`)

  const wState = await req('GET', `/tasks/${mark.workerTaskId}`)
  check('子任务 COMPLETED(lead 完成一项标记一项)', wState.json.data.state === 'COMPLETED', `state=${wState.json.data.state}`)

  await sleep(1500)
  const queue = await req('GET', `/channels/${mark.channelId}/queue`)
  const states = (queue.json.data ?? []).map(a => `${a.name}:${a.state}`)
  check('恢复执行后全员 idle', (queue.json.data ?? []).every(a => a.state === 'idle'), JSON.stringify(states))

  await req('DELETE', `/channels/${mark.channelId}`)
  unlinkSync('.resume-test.json')
  console.log(`\n结果: PASS=${pass} FAIL=${fail}`)
  process.exit(fail === 0 ? 0 : 1)
}

// ───────── 场景 C:消费缺口重投(消息已 consumed 但任务未完成) ─────────
async function gap() {
  console.log('━━━ 场景 C:assign 已 consumed + 任务 WORKING → 重启必须重投 ━━━')
  const channelId = await makeSlowChannel('gap')
  const taskId = await submitTask(channelId, 'gap-task')
  await waitState(taskId, ['WORKING', 'WAITING'], 8000)
  const chTasks = await req('GET', `/channels/${channelId}/tasks`)
  const working = (chTasks.json.data ?? []).find(t => t.state === 'WORKING')
  check('制造 WORKING 任务', !!working)
  if (!working) process.exit(1)

  // 硬杀服务器
  const { execSync } = await import('node:child_process')
  const pid = execSync('netstat -ano | findstr :3000 | findstr LISTENING').toString().match(/(\d+)\s*$/)?.[1]
  execSync(`taskkill /PID ${pid} /F`)
  await sleep(1200)

  // 进程外直接把该任务全部消息标为 consumed(模拟极端缺口:消息已消费但任务未完成)
  const db = new DatabaseSync(DB_PATH)
  db.exec(`UPDATE messages SET state = 'consumed', consumed_at = datetime('now') WHERE task_id = '${working.id}'`)
  const left = db.prepare(`SELECT COUNT(*) AS n FROM messages WHERE task_id = ? AND state != 'consumed'`).get(working.id)
  db.close()
  check('缺口已制造(无任何待消费消息)', left.n === 0, `remaining=${left.n}`)

  const { writeFileSync } = await import('node:fs')
  writeFileSync('.resume-test.json', JSON.stringify({ channelId, taskId, workerTaskId: working.id, token: __userToken }))
  console.log(`\n结果: PASS=${pass} FAIL=${fail}`)
  process.exit(fail === 0 ? 0 : 1)
}

async function verifyGap() {
  console.log('━━━ 场景 C:重启 → restore 重投缺口 assign → 自动恢复 ━━━')
  const { readFileSync, unlinkSync } = await import('node:fs')
  const mark = JSON.parse(readFileSync('.resume-test.json', 'utf8'))

  const pending = dbQuery(
    `SELECT COUNT(*) AS n FROM messages WHERE task_id = ? AND state IN ('pending','consuming','consumed') AND metadata_json LIKE '%"x-aw-task-kind":"assign"%'`,
    mark.workerTaskId,
  )
  check('restore 重投缺口 assign(轨迹存在)', pending[0].n > 0, `assign-trail=${pending[0].n}`)

  const finalState = await waitState(mark.taskId, ['COMPLETED', 'FAILED', 'CANCELED'], 40_000)
  check('缺口任务自动恢复至 COMPLETED', finalState === 'COMPLETED', `state=${finalState}`)

  await sleep(1500)
  const queue = await req('GET', `/channels/${mark.channelId}/queue`)
  check('恢复后全员 idle', (queue.json.data ?? []).every(a => a.state === 'idle'))

  await req('DELETE', `/channels/${mark.channelId}`)
  unlinkSync('.resume-test.json')
  console.log(`\n结果: PASS=${pass} FAIL=${fail}`)
  process.exit(fail === 0 ? 0 : 1)
}

const mode = process.argv[2] ?? 'watch'
const modes = { watch, crash, verify, gap, 'verify-gap': verifyGap }
if (!modes[mode]) {
  console.error(`未知模式: ${mode}`)
  process.exit(2)
}
await modes[mode]()
