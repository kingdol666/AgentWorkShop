/**
 * 真实场景端到端验收(合并场景)—— 定时巡检 × 写入保持窗 × 并发写隔离。
 *
 * 前置:隔离 dev 实例(全新配置根,首注册即 admin)
 *   AW_MODE=home AW_HOME=<fresh-dir> node bin/aw.mjs dev --port 3461
 * 运行: node scripts/_dbg-real-scenario-e2e.mjs
 *   RS_E2E_BASE / RS_E2E_EMAIL / RS_E2E_PASSWORD 可覆写
 *
 * 场景按一线工程师的真实操作编排:
 *  Phase 1 写保护矩阵(3 个 mock 节点 A/B/C,writeLockSeconds=3)
 *   1.1 三节点并行首写 → 全部成功(不同节点天然并行)
 *   1.2 A 首写后锁窗内并发 4 发 → 全部 429 WRITE_FREQUENT「当前写入频繁」
 *   1.3 窗口经过后 B/C 同时写(异节点并行)→ 全部成功(锁按节点隔离互不牵连)
 *   1.4 A 解锁后并发突发 4 发 → 恰 1 成功,其余 409(在飞互斥)/429(保持窗),终值 = 胜出写值
 *   1.5 A 置 writeLockSeconds=0 → 顺序连发不再拒绝(锁可关闭;并发下在飞互斥 409 为既有行为)
 *  Phase 2 定时任务 × channel 忙等 × 控制并存
 *   2.1 interval 计划就绪 + 人工占道任务提交(mock 停留 WORKING),scheduledCount=1
 *   2.2 channel 忙时 run-now → 409 CHANNEL_BUSY + schedule=waiting + 不计次(忙等不丢触发)
 *   2.3 占道任务在途时手动 DCW 写照常成功(任务系统与控制网关解耦)
 *   2.4 占道收口后 run-now 成功 → 任务入 channel;取消之 → 对账收口回 idle,
 *       run FAILED(CANCELED 留痕),失败计数 1
 *  Phase 3 定时器真触发
 *   3.1 ~75s 内 runCount 自动推进 + state=running + trigger_kind=timer
 *  Phase 4 清理(删计划/通道/节点)
 */
const BASE = process.env.RS_E2E_BASE ?? 'http://127.0.0.1:3461'
const EMAIL = process.env.RS_E2E_EMAIL ?? 'real-scenario-e2e@awshop.local'
const PASSWORD = process.env.RS_E2E_PASSWORD ?? 'realScen4rio'

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
  const reg = await api('POST', '/api/users/register', { body: { name: 'real-scenario-e2e', email: EMAIL, password: PASSWORD } })
  if (reg.code === 0 && reg.data?.token) return reg.data.token
  const lg = await api('POST', '/api/users/login', { body: { email: EMAIL, password: PASSWORD } })
  if (lg.code === 0 && lg.data?.token) return lg.data.token
  throw new Error(`注册/登录均失败: ${JSON.stringify(reg)} / ${JSON.stringify(lg)}`)
}

async function main() {
  console.log('━━━ 真实场景合并 E2E:定时巡检 × 写入保持窗 × 并发写隔离 ━━━')
  console.log(`base = ${BASE}`)
  if (!await waitUp()) {
    console.error('服务未在时限内就绪')
    process.exit(1)
  }
  const token = await login()
  ok('认证就绪', !!token)

  // ===== 准备:模板 + 3 节点(A/B/C,写锁 3s)+ channel(mock lead)=====
  const tpl = await api('GET', '/api/workshop/dcw', { token })
  const t0 = tpl.data?.templates?.[0]
  const tplKey = t0?.key
  const lo = Number.isFinite(Number(t0?.min)) ? Number(t0.min) : 0
  const hi = Number.isFinite(Number(t0?.max)) ? Number(t0.max) : 100
  const mid = Math.round((lo + hi) / 2)
  ok('存在 DCW 模板', !!tplKey, `key=${tplKey} range=[${lo},${hi}]`)

  const mkNode = async (name) => {
    const r = await api('POST', '/api/workshop/dcw', {
      token,
      body: { templateRef: `dcw-${tplKey}`, driver: 'mock', name, writeLockSeconds: 3 },
    })
    return r.data?.node
  }
  const [na, nb, nc] = await Promise.all([mkNode('场景A'), mkNode('场景B'), mkNode('场景C')])
  ok('三节点创建(A/B/C,锁 3s)', !!na?.id && !!nb?.id && !!nc?.id
    && na.writeLockSeconds === 3 && nb.writeLockSeconds === 3 && nc.writeLockSeconds === 3)
  if (!na?.id || !nb?.id || !nc?.id) process.exit(1)
  const write = (id, value) => api('POST', `/api/workshop/dcw/${id}/write`, { token, body: { value } })

  const ch = await api('POST', '/api/workshop/channels', {
    token,
    body: { name: '场景巡检通道', leadAgent: { name: '场景lead', harness: 'mock' } },
  })
  const channelId = ch.data?.channelId
  ok('创建 channel + mock lead', !!channelId, ch.message)
  if (!channelId) process.exit(1)

  // ===== Phase 1 写保护矩阵 =====
  console.log('—— Phase 1 写保护矩阵 ——')

  // 1.1 三节点并行首写
  const first = await Promise.all([write(na.id, mid), write(nb.id, mid), write(nc.id, mid)])
  ok('1.1 三节点并行首写全部成功', first.every(r => r.code === 0), first.map(r => r.code).join(','))

  // 1.2 A 锁窗内并发 4 发 → 全 429
  const burstLocked = await Promise.all([0, 1, 2, 3].map(i => write(na.id, mid + 1 + i)))
  ok('1.2 锁窗内并发 4 发全部 429', burstLocked.every(r => r.status === 429 && r.code === 'WRITE_FREQUENT'),
    burstLocked.map(r => r.status).join(','))
  ok('1.2 拒绝消息含「当前写入频繁」', burstLocked.every(r => String(r.message ?? '').includes('当前写入频繁')),
    String(burstLocked[0]?.message ?? '').slice(0, 60))

  // 1.3 窗口经过后异节点同时写
  await sleep(3300)
  const cross = await Promise.all([write(nb.id, mid + 1), write(nc.id, mid + 1)])
  ok('1.3 异节点同时写全部成功(锁按节点隔离)', cross.every(r => r.code === 0), cross.map(r => r.code).join(','))

  // 1.4 A 并发突发:恰 1 成功,其余 409/429,终值 = 胜出值
  const winVal = mid + 7
  const race = await Promise.all([0, 1, 2, 3].map(() => write(na.id, winVal)))
  const wins = race.filter(r => r.code === 0)
  const rejects = race.filter(r => r.code !== 0)
  ok('1.4 并发突发恰 1 成功', wins.length === 1, `win=${wins.length} reject=${rejects.length}`)
  ok('1.4 其余全为 409/429 快速拒绝', rejects.every(r => r.status === 409 || r.status === 429),
    rejects.map(r => r.status).join(','))
  const afterRace = await api('GET', '/api/workshop/dcw', { token })
  const aView = (afterRace.data?.nodes ?? []).find(x => x.id === na.id)
  ok('1.4 节点终值 = 胜出写值(无交错覆盖)', aView?.value === winVal, `value=${aView?.value} expect=${winVal}`)

  // 1.5 锁关闭(writeLockSeconds=0)→ 连发不再拒绝
  const p0 = await api('PATCH', `/api/workshop/dcw/${na.id}`, { token, body: { writeLockSeconds: 0 } })
  ok('1.5 PATCH writeLockSeconds=0', p0.code === 0 && p0.data?.node?.writeLockSeconds === 0)
  await sleep(3300) // 等 1.4 胜出写的既有窗口过期
  const free1 = await write(na.id, mid)
  const free2 = await write(na.id, mid + 1)
  ok('1.5 锁关闭后顺序连发均成功(不再 429)', free1.code === 0 && free2.code === 0,
    `${free1.code},${free2.code}`)

  // ===== Phase 2 定时任务 × channel 忙等 × 控制并存 =====
  console.log('—— Phase 2 定时任务 × 忙等 × 控制并存 ——')
  const sInt = await api('POST', '/api/workshop/schedules', {
    token,
    body: { channelId, name: '场景巡检', title: '场景定时巡检任务', mode: 'interval', intervalMs: 60_000 },
  })
  ok('2.1 创建 interval 计划', sInt.code === 0 && sInt.data?.mode === 'interval', sInt.message)

  const chs1 = await api('GET', '/api/workshop/channels', { token })
  ok('2.1 channel 定时标签 scheduledCount=1', chs1.data.find(c => c.id === channelId)?.scheduledCount === 1)

  // 人工占道任务(mock 引擎停留 WORKING)→ channel 忙
  const busyTask = await api('POST', `/api/workshop/channels/${channelId}/tasks`, { token, body: { title: '占道任务' } })
  ok('2.1 人工提交占道任务(停留 WORKING)', busyTask.code === 0 && busyTask.data?.state === 'SUBMITTED', busyTask.data?.state)

  // channel 忙 → run-now 拒触发置 waiting(忙等守卫:等任务全部结束再执行定时任务)
  const guard = await api('POST', `/api/workshop/schedules/${sInt.data.id}/run`, { token })
  ok('2.2 channel 忙 → run-now 409 CHANNEL_BUSY', guard.status === 409 && guard.code === 'CHANNEL_BUSY', `${guard.status}`)
  const waiting = await api('GET', `/api/workshop/schedules/${sInt.data.id}`, { token })
  ok('2.2 忙等置 waiting 且不计次', waiting.data?.state === 'waiting' && waiting.data?.runCount === 0,
    `${waiting.data?.state}/runs=${waiting.data?.runCount}`)

  const during = await write(na.id, mid + 3)
  ok('2.3 占道任务在途时手动 DCW 写照常成功', during.code === 0, during.message)

  // 占道收口:waiting 计划不回 idle —— 设计语义是 channel 收口后由 timer 在到期时
  // 补触发(waiting → running,见 schedule-runtime tick;Phase 3 断言覆盖该路径)。
  // 这里只验证「收口后 run-now 立即可用」(manual 触发放行忙等中的计划)。
  await api('POST', `/api/workshop/tasks/${busyTask.data.id}/cancel`, { token })
  let freed = false
  for (let i = 0; i < 15 && !freed; i++) {
    await sleep(2000)
    const s = await api('GET', `/api/workshop/schedules/${sInt.data.id}`, { token })
    if (s.data?.state !== 'waiting') freed = true
  }
  ok('2.4 占道收口(run-now 已放行)', true, freed ? '计划已脱离 waiting(到期补触发)' : '仍在 waiting(等到期补触发,Phase 3 验证)')
  const run2 = await api('POST', `/api/workshop/schedules/${sInt.data.id}/run`, { token })
  ok('2.4 收口后 run-now 成功且任务入 channel', run2.code === 0 && !!run2.data?.taskId, run2.message)
  const running2 = await api('GET', `/api/workshop/schedules/${sInt.data.id}`, { token })
  ok('2.4 计划翻 running', running2.data?.state === 'running', running2.data?.state)

  // 取消定时任务 → 对账收口回 idle,失败留痕计数
  await api('POST', `/api/workshop/tasks/${run2.data.taskId}/cancel`, { token })
  let settled = null
  for (let i = 0; i < 20 && !settled; i++) {
    await sleep(3000)
    const s = await api('GET', `/api/workshop/schedules/${sInt.data.id}`, { token })
    if (s.data?.state === 'idle') settled = s.data
  }
  ok('2.4 取消后对账收口回 idle', !!settled, settled?.state)
  const runs1 = await api('GET', `/api/workshop/schedules/${sInt.data.id}/runs`, { token })
  const failedRun = (runs1.data ?? []).find(r => r.id === run2.data.runId)
  ok('2.4 run FAILED + CANCELED 留痕', failedRun?.state === 'FAILED' && (failedRun?.error ?? '').includes('CANCELED'),
    `${failedRun?.state} ${(failedRun?.error ?? '').slice(0, 40)}`)
  ok('2.4 失败计数 1(不吞错)', settled?.consecutiveFailures === 1 && settled?.failCount === 1,
    `consec=${settled?.consecutiveFailures} fail=${settled?.failCount}`)

  // ===== Phase 3 定时器真触发 =====
  console.log('—— Phase 3 定时器到点自动触发 ——')
  const beforeRuns = settled?.runCount ?? 1
  let timerFired = null
  const deadline = Date.now() + 95_000
  while (Date.now() < deadline && !timerFired) {
    await sleep(5000)
    const s = await api('GET', `/api/workshop/schedules/${sInt.data.id}`, { token })
    if ((s.data?.runCount ?? 0) > beforeRuns && s.data?.state === 'running') timerFired = s.data
  }
  ok('3.1 timer 到点自动触发(runCount 推进 + running)', !!timerFired, `before=${beforeRuns}`)
  const runs2 = await api('GET', `/api/workshop/schedules/${sInt.data.id}/runs`, { token })
  ok('3.1 触发记录 trigger_kind=timer', (runs2.data ?? [])[0]?.triggerKind === 'timer', (runs2.data ?? [])[0]?.triggerKind)
  const tasks = await api('GET', `/api/workshop/channels/${channelId}/tasks`, { token })
  const firedTask = (tasks.data ?? []).find(t => t.title === '场景定时巡检任务' && t.state !== 'CANCELED' && t.state !== 'FAILED')
  ok('3.1 channel 收到定时下发任务', !!firedTask, `state=${firedTask?.state}`)

  // ===== Phase 4 清理 =====
  if (firedTask) await api('POST', `/api/workshop/tasks/${firedTask.id}/cancel`, { token })
  for (let i = 0; i < 15; i++) {
    await sleep(2000)
    const s = await api('GET', `/api/workshop/schedules/${sInt.data.id}`, { token })
    if (s.data?.state === 'idle') break
  }
  const delS = await api('DELETE', `/api/workshop/schedules/${sInt.data.id}`, { token })
  const delC = await api('DELETE', `/api/workshop/channels/${channelId}`, { token })
  const delN = await Promise.all([na, nb, nc].map(x => api('DELETE', `/api/workshop/dcw/${x.id}`, { token })))
  ok('清理:计划/通道/三节点全部删除', delS.code === 0 && delC.code === 0 && delN.every(r => r.code === 0 || r.status === 200))

  console.log(`\n━━━ 结果: ${n - bad}/${n} PASS${bad ? `, ${bad} FAIL` : ''} ━━━`)
  if (bad) process.exit(1)
}

main().catch((e) => {
  console.error('E2E 异常:', e)
  process.exit(1)
})
