/**
 * 定时任务 REST E2E(v16)—— 对运行中的隔离实例验证完整链路。
 *
 * 前置:隔离 dev 实例(全新配置根,首注册即 admin)
 *   AW_MODE=home AW_HOME=<fresh-dir> node bin/aw.mjs dev --port 3457
 * 运行: node scripts/_dbg-schedule-e2e.mjs
 *   SCHED_E2E_BASE / SCHED_E2E_EMAIL / SCHED_E2E_PASSWORD 可覆写
 *
 * 覆盖:
 *  1. channels 列表附 scheduledCount 标志(0 → 建 2 个计划 → 2 → 删/停用回落)
 *  2. 建计划:参数校验(interval 下限 / 非法 dailyTime → 400)+ next_run_at 计算
 *  3. 忙等守卫:channel 有未收口任务 → run-now 409 CHANNEL_BUSY + 计划置 waiting;
 *     channel 收口后 run-now 成功
 *  4. 对账收口:在途任务取消 → run FAILED(错误留痕)→ 计划回 idle + 连续失败计数
 *  5. timer 到点自动触发(60s 间隔计划在 ~75s 内被运行时自动触发)
 *  6. 状态机:PATCH 停用/启用(disabled ↔ idle 且重新计时)+ 删除清理
 *
 * 注:mock lead 的任务不会自行终态(停留 WORKING),故收口验证走「取消任务 →
 *     reconcile → FAILED」的确定性路径;COMPLETED 路径由单元测试覆盖。
 */
const BASE = process.env.SCHED_E2E_BASE ?? 'http://127.0.0.1:3457'
const EMAIL = process.env.SCHED_E2E_EMAIL ?? 'sched-e2e@awshop.local'
const PASSWORD = process.env.SCHED_E2E_PASSWORD ?? 'sched2E2e'
const NAME = 'sched-e2e'

let n = 0
let bad = 0
const ok = (name, cond, detail = '') => {
  n += 1
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
  if (!cond) bad += 1
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms))

async function api(method, path, { token, body } = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  })
  const json = await res.json().catch(() => ({}))
  return { status: res.status, ...json }
}

async function waitUp(deadlineMs = 180_000) {
  const deadline = Date.now() + deadlineMs
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`${BASE}/api/users/setup-status`)
      if (r.ok) return true
    }
    catch { /* not up yet */ }
    await sleep(1500)
  }
  return false
}

async function login() {
  const reg = await api('POST', '/api/users/register', { body: { name: NAME, email: EMAIL, password: PASSWORD } })
  if (reg.code === 0 && reg.data?.token) return reg.data.token
  const login = await api('POST', '/api/users/login', { body: { email: EMAIL, password: PASSWORD } })
  if (login.code === 0 && login.data?.token) return login.data.token
  throw new Error(`注册/登录均失败: ${JSON.stringify(reg)} / ${JSON.stringify(login)}`)
}

async function main() {
  console.log('━━━ 定时任务 REST E2E ━━━')
  console.log(`base = ${BASE}`)
  if (!await waitUp()) {
    console.error('服务未在时限内就绪')
    process.exit(1)
  }
  const token = await login()
  ok('认证就绪', !!token)

  // 建 channel(mock lead)+ **慢 worker**:
  // 忙等守卫的"占道任务"必须真的长期在途。mock lead 会把简单任务在首个监督轮直接收口,
  // 只有把任务显式声明为 complex 并派给 delayMs 很大的 worker,子任务才会稳定停在 WORKING
  // (delayMs 加在 lead 上没用 —— lead 不执行任务)。
  const ch = await api('POST', '/api/workshop/channels', {
    token,
    body: { name: '定时E2E通道', leadAgent: { name: '定时lead', harness: 'mock' } },
  })
  ok('创建 channel + mock lead', ch.code === 0 && !!ch.data?.channelId, ch.message)
  const channelId = ch.data.channelId
  const slowWorker = await api('POST', '/api/workshop/agents', {
    token,
    body: { name: '定时慢worker', harness: 'mock', config: { delayMs: 300_000 } },
  })
  const joined = await api('POST', `/api/workshop/channels/${channelId}/agents`, {
    token,
    body: { agentId: slowWorker.data?.id, role: 'worker' },
  })
  ok('加入慢 worker(delayMs=300s,占道任务长期在途)', joined.code === 0, joined.message)

  // channels 列表:标志字段恒在
  const chs0 = await api('GET', '/api/workshop/channels', { token })
  ok('channels 附 scheduledCount 标志(初始 0)', chs0.data.find(c => c.id === channelId)?.scheduledCount === 0)

  // 参数校验
  const badShort = await api('POST', '/api/workshop/schedules', {
    token,
    body: { channelId, name: '太快', title: 't', mode: 'interval', intervalMs: 5000 },
  })
  ok('interval < 60s → 400', badShort.status === 400, `${badShort.status}`)
  const badDaily = await api('POST', '/api/workshop/schedules', {
    token,
    body: { channelId, name: '坏时刻', title: 't', mode: 'daily', dailyTime: '25:99' },
  })
  ok('daily 非法 HH:MM → 400', badDaily.status === 400, `${badDaily.status}`)

  // 建两个计划(interval + daily)
  const now = new Date()
  const sInt = await api('POST', '/api/workshop/schedules', {
    token,
    body: { channelId, name: 'E2E巡检', title: '[mock:complex] 定时巡检任务', description: 'E2E interval:需分解派发给 worker 执行', mode: 'interval', intervalMs: 60_000, maxConsecutiveFailures: 3 },
  })
  ok('创建 interval 计划', sInt.code === 0 && sInt.data?.mode === 'interval', sInt.message)
  const nextMs = sInt.data?.nextRunAt ? new Date(sInt.data.nextRunAt).getTime() - now.getTime() : 0
  ok('interval next_run_at ≈ +60s', nextMs > 45_000 && nextMs <= 62_000, `${Math.round(nextMs / 1000)}s`)
  const sDaily = await api('POST', '/api/workshop/schedules', {
    token,
    body: { channelId, name: 'E2E晨报', title: '定时晨报任务', mode: 'daily', dailyTime: '08:00' },
  })
  ok('创建 daily 计划', sDaily.code === 0 && sDaily.data?.dailyTime === '08:00', sDaily.message)
  const nextDaily = sDaily.data?.nextRunAt ? new Date(sDaily.data.nextRunAt) : null
  ok('daily next_run_at 落在 08:00 且 > now', nextDaily !== null && nextDaily.getHours() === 8 && nextDaily.getTime() > now.getTime(), sDaily.data?.nextRunAt)

  // channel 定时标志 = 2
  const chs1 = await api('GET', '/api/workshop/channels', { token })
  ok('channel scheduledCount = 2', chs1.data.find(c => c.id === channelId)?.scheduledCount === 2,
    String(chs1.data.find(c => c.id === channelId)?.scheduledCount))

  // ===== 忙等守卫:channel 有未收口任务 =====
  // `[mock:complex]` → lead 必分解派发给慢 worker,子任务停在 WORKING(占道成立)
  const busy = await api('POST', `/api/workshop/channels/${channelId}/tasks`, {
    token,
    body: { title: '[mock:complex] 占道任务', description: '端到端实现占道:需分解派发给 worker 执行' },
  })
  ok('人工提交占道任务(未收口)', busy.code === 0 && busy.data?.state === 'SUBMITTED', busy.data?.state)
  // 等子任务真正进入 WORKING(忙等守卫把 SUBMITTED/ASSIGNED/WORKING/WAITING 都算在途,
  // 但派发本身是异步的 —— 先等一拍再断言,避免"提交瞬间就 run-now"的时序假象)
  let inFlight = false
  for (let i = 0; i < 20 && !inFlight; i++) {
    await sleep(500)
    const ts = await api('GET', `/api/workshop/channels/${channelId}/tasks`, { token })
    inFlight = (ts.data ?? []).some(t => t.parentId && t.state === 'WORKING')
  }
  ok('占道子任务进入 WORKING(真实在途)', inFlight)
  const guard = await api('POST', `/api/workshop/schedules/${sInt.data.id}/run`, { token })
  ok('channel 忙 → run-now 409 CHANNEL_BUSY', guard.status === 409 && guard.code === 'CHANNEL_BUSY', `${guard.status}`)
  const waiting = await api('GET', `/api/workshop/schedules/${sInt.data.id}`, { token })
  ok('计划置 waiting', waiting.data?.state === 'waiting', waiting.data?.state)
  ok('忙等不触发、不计次', waiting.data?.runCount === 0)

  // channel 收口(取消占道任务**及其子任务**)→ run-now 成功。
  // 只取消父任务不够:子任务仍在 WORKING,mock worker 的 delayMs=300s 会一直占着 channel。
  const release = async () => {
    const list = await api('GET', `/api/workshop/channels/${channelId}/tasks`, { token })
    for (const t of (list.data ?? []).filter(x => !['COMPLETED', 'FAILED', 'CANCELED'].includes(x.state))) {
      await api('POST', `/api/workshop/tasks/${t.id}/cancel`, { token })
    }
    for (let i = 0; i < 30; i++) {
      await sleep(500)
      const again = await api('GET', `/api/workshop/channels/${channelId}/tasks`, { token })
      if ((again.data ?? []).every(x => ['COMPLETED', 'FAILED', 'CANCELED'].includes(x.state))) return true
    }
    return false
  }
  ok('取消占道任务及子任务 → channel 收口', await release())
  let freed = false
  for (let i = 0; i < 15 && !freed; i++) {
    await sleep(2000)
    const s = await api('GET', `/api/workshop/schedules/${sInt.data.id}`, { token })
    if (s.data?.state !== 'waiting') freed = true
  }
  const run = await api('POST', `/api/workshop/schedules/${sInt.data.id}/run`, { token })
  ok('channel 收口后 run-now 成功', run.code === 0 && !!run.data?.taskId, run.message ?? JSON.stringify(run.data))
  const tasks = await api('GET', `/api/workshop/channels/${channelId}/tasks`, { token })
  const schedTask = (tasks.data ?? []).find(t => t.id === run.data?.taskId)
  ok('定时任务已提交到 channel', !!schedTask && schedTask.title === '[mock:complex] 定时巡检任务', `state=${schedTask?.state}`)
  const runningState = await api('GET', `/api/workshop/schedules/${sInt.data.id}`, { token })
  ok('计划翻 running', runningState.data?.state === 'running', runningState.data?.state)
  const reRun = await api('POST', `/api/workshop/schedules/${sInt.data.id}/run`, { token })
  ok('在途重复 run-now → 409', reRun.status === 409, `${reRun.status} ${reRun.code}`)

  // ===== 对账收口:取消在途任务(**含其子任务**)→ run FAILED + 计数 =====
  // 子任务必须一起取消:否则慢 worker 的子任务继续占着 channel,timer 到点会被忙等守卫拦下。
  ok('取消在途定时任务及子任务 → channel 再次收口', await release())
  let settled = null
  for (let i = 0; i < 20 && !settled; i++) {
    await sleep(3000)
    const s = await api('GET', `/api/workshop/schedules/${sInt.data.id}`, { token })
    if (s.data?.state === 'idle') settled = s.data
  }
  ok('run 收口后计划回 idle', !!settled, JSON.stringify(settled?.state))
  const runs = await api('GET', `/api/workshop/schedules/${sInt.data.id}/runs`, { token })
  const failedRun = (runs.data ?? []).find(r => r.id === run.data.runId)
  ok('run FAILED + 错误留痕(CANCELED)', failedRun?.state === 'FAILED' && (failedRun?.error ?? '').includes('CANCELED'),
    `${failedRun?.state} ${failedRun?.error}`)
  ok('连续失败计数 = 1(failCount=1,runCount=1)', settled?.consecutiveFailures === 1 && settled?.failCount === 1 && settled?.runCount === 1,
    `consec=${settled?.consecutiveFailures} fail=${settled?.failCount} runs=${settled?.runCount}`)

  // ===== timer 到点自动触发(60s 计划在 ~75s 内被运行时自动触发)=====
  const before = await api('GET', `/api/workshop/schedules/${sInt.data.id}`, { token })
  let timerFired = false
  const deadline = Date.now() + 90_000
  while (Date.now() < deadline && !timerFired) {
    await sleep(5000)
    const s = await api('GET', `/api/workshop/schedules/${sInt.data.id}`, { token })
    if ((s.data?.runCount ?? 0) > (before.data?.runCount ?? 0) && s.data?.state === 'running') timerFired = true
  }
  ok('timer 到点自动触发(runCount 推进 + running)', timerFired, `runCount ${before.data?.runCount} → ?`)
  const afterRuns = await api('GET', `/api/workshop/schedules/${sInt.data.id}/runs`, { token })
  ok('自动触发 run 记 trigger_kind=timer', (afterRuns.data ?? [])[0]?.triggerKind === 'timer', (afterRuns.data ?? [])[0]?.triggerKind)

  // ===== 状态机:停用/启用 =====
  // 先取消 timer 刚触发的任务,让计划回 idle 再做停用/启用断言
  const liveTask = (await api('GET', `/api/workshop/channels/${channelId}/tasks`, { token })).data
    .find(t => t.state !== 'COMPLETED' && t.state !== 'CANCELED' && t.state !== 'FAILED')
  if (liveTask) await api('POST', `/api/workshop/tasks/${liveTask.id}/cancel`, { token })
  for (let i = 0; i < 20; i++) {
    await sleep(2000)
    const s = await api('GET', `/api/workshop/schedules/${sInt.data.id}`, { token })
    if (s.data?.state === 'idle') break
  }
  const off = await api('PATCH', `/api/workshop/schedules/${sInt.data.id}`, { token, body: { enabled: 0 } })
  ok('停用 → disabled', off.data?.enabled === 0 && off.data?.state === 'disabled', `${off.data?.enabled}/${off.data?.state}`)
  const chs2 = await api('GET', '/api/workshop/channels', { token })
  ok('停用后 scheduledCount 只算启用 = 1', chs2.data.find(c => c.id === channelId)?.scheduledCount === 1,
    String(chs2.data.find(c => c.id === channelId)?.scheduledCount))
  const on = await api('PATCH', `/api/workshop/schedules/${sInt.data.id}`, { token, body: { enabled: 1 } })
  ok('启用 → idle + 重新计时(next 未来)', on.data?.enabled === 1 && on.data?.state === 'idle' && new Date(on.data?.nextRunAt).getTime() > Date.now(),
    `${on.data?.state} next=${on.data?.nextRunAt}`)
  ok('启用重置连续失败', on.data?.consecutiveFailures === 0, String(on.data?.consecutiveFailures))

  // 列表/详情/删除清理
  const list = await api('GET', '/api/workshop/schedules', { token })
  ok('列表含计划(附 channel 名)', (list.data ?? []).length >= 2 && list.data.every(s => s.channelName))
  const del1 = await api('DELETE', `/api/workshop/schedules/${sInt.data.id}`, { token })
  const del2 = await api('DELETE', `/api/workshop/schedules/${sDaily.data.id}`, { token })
  ok('删除两个计划', del1.code === 0 && del2.code === 0)
  const chs3 = await api('GET', '/api/workshop/channels', { token })
  ok('删除后 scheduledCount 回落 0', chs3.data.find(c => c.id === channelId)?.scheduledCount === 0)
  const gone = await api('GET', `/api/workshop/schedules/${sInt.data.id}`, { token })
  ok('已删计划详情 → 404', gone.status === 404, String(gone.status))

  await api('DELETE', `/api/workshop/channels/${channelId}`, { token })

  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
  console.log(`  ${bad === 0 ? `🎉 全部通过(${n} 项)` : `❌ ${bad}/${n} 项失败`}`)
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
  process.exit(bad === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error('E2E 异常:', e)
  process.exit(1)
})
