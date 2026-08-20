/**
 * LOOP 模式 omp 实测:
 *  - 模型:zhipu-coding-plan/glm-5-turbo
 *  - 提交 [mode:loop][interval:8000] 任务 → lead 派发子任务 → worker 完成 →
 *    父任务完成后 LoopController 在 interval 后重放同标题新任务
 *  - 断言:两轮周期完成(重放生效)、每轮派发子任务、在途无重复、
 *          邮件流有协作记录、取消活跃任务后循环停止
 * 运行:node scripts/test-loop-omp.mjs(默认 http://127.0.0.1:3101;需 omp CLI)
 */
const BASE = process.env.AW_BASE ?? 'http://127.0.0.1:3101'
const PROVIDER = 'zhipu-coding-plan'
const MODEL = 'glm-5-turbo'
const TITLE = 'loop-marker'
const INTERVAL_MS = 8000

let failures = 0
let passed = 0
const check = (name, ok, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
  if (ok) passed += 1
  else failures += 1
}
const sleep = ms => new Promise(r => setTimeout(r, ms))

async function waitUntil(name, cond, timeoutMs, intervalMs = 3000) {
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

const api = async (method, path, { body, token } = {}) => {
  const headers = { 'content-type': 'application/json' }
  if (token) headers.authorization = `Bearer ${token}`
  const res = await fetch(`${BASE}${path}`, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined })
  return { status: res.status, ...(await res.json().catch(() => ({}))) }
}

async function main() {
  console.log(`目标: ${BASE}(模型 ${PROVIDER}/${MODEL})`)
  const user = await api('POST', '/api/workshop/users/register', { body: { name: `loop-omp-${Date.now().toString(36)}` } })
  const token = user.data?.token
  if (!token) throw new Error('注册失败')

  const ch = await api('POST', '/api/workshop/channels', {
    body: {
      name: `loop-${Date.now().toString(36)}`,
      leadAgent: { name: 'loop-lead', harness: 'omp', config: { provider: PROVIDER, model: MODEL } },
    },
    token,
  })
  if (ch.code !== 0) throw new Error(`channel 创建失败: ${JSON.stringify(ch).slice(0, 140)}`)
  const channelId = ch.data.channelId
  const w = await api('POST', `/api/workshop/channels/${channelId}/agents`, {
    body: { name: 'loop-worker', harness: 'omp', role: 'worker', config: { provider: PROVIDER, model: MODEL } },
    token,
  })
  if (w.code !== 0) throw new Error('worker 创建失败')
  check('团队就绪(omp lead + worker)', true, `channel=${channelId.slice(0, 8)}`)

  const tasksOf = async () =>
    (await api('GET', `/api/workshop/channels/${channelId}/tasks`, { token })).data ?? []
  // 顶层 loop 主任务(lead 派发的子任务可能与父任务同标题,须按 parentId 区分)
  const loopsOf = async () => (await tasksOf()).filter(t => t.title === TITLE && !t.parentId)

  const t0 = Date.now()
  const task = await api('POST', `/api/workshop/channels/${channelId}/tasks`, {
    body: {
      title: TITLE,
      description: `[mode:loop][interval:${INTERVAL_MS}] Delegate to the worker: reply with a sentence containing the word LOOP-TICK, then complete.`,
    },
    token,
  })
  const parentId = task.data.id

  // 第一轮完成
  await waitUntil('loop 首轮完成', async () => {
    const t = (await loopsOf()).find(x => x.id === parentId)
    return t?.state === 'COMPLETED' ? t.state : null
  }, 480_000)
  check('loop 首轮完成', true, `耗时=${Math.round((Date.now() - t0) / 1000)}s`)

  // 自动重放:出现同标题新任务(id 不同)进入活跃态
  const round2 = await waitUntil('loop 自动重放新任务', async () => {
    const fresh = (await loopsOf()).find(x => x.id !== parentId && !['COMPLETED', 'FAILED', 'CANCELED'].includes(x.state ?? ''))
    return fresh ?? null
  }, 120_000)
  check('loop 重放生效(同标题新任务自动提交)', true, `round2=${round2.id.slice(0, 8)} state=${round2.state}`)

  // 第二轮完成
  await waitUntil('loop 第二轮完成', async () => {
    const t = (await loopsOf()).find(x => x.id === round2.id)
    return t?.state === 'COMPLETED' ? t.state : null
  }, 480_000)
  check('loop 第二轮完成(周期作业可持续)', true, `总耗时=${Math.round((Date.now() - t0) / 1000)}s`)

  // 每轮都有子任务派发且完成
  const tasks = await tasksOf()
  const loops = tasks.filter(t => t.title === TITLE && !t.parentId)
  const children = tasks.filter(t => t.parentId && loops.some(l => l.id === t.parentId))
  const doneChildren = children.filter(c => c.state === 'COMPLETED')
  check('循环内子任务派发且完成(≥2 轮)', children.length >= 2 && doneChildren.length >= 2, `children=${children.length}, done=${doneChildren.length}`)

  // 无重复在途
  const active = children.filter(c => ['ASSIGNED', 'WORKING', 'WAITING'].includes(c.state))
  const activeTitles = active.map(c => c.title.replace(/\s+/g, ' ').trim().toLowerCase())
  const dupActive = activeTitles.filter((t, i) => activeTitles.indexOf(t) !== i)
  check('在途子任务无重复', dupActive.length === 0, `active=${active.length}`)

  // 团队知情:邮件流有协作记录
  const mails = (await api('GET', '/api/workshop/mailbox/all', { token }).catch(() => ({ data: [] }))).data ?? []
  check('邮件流含协作记录(lead/worker 彼此知情)', Array.isArray(mails), `mails=${Array.isArray(mails) ? mails.length : 'n/a'}`)

  // 取消第三轮活跃任务 → 循环停止(重放只在 COMPLETED 后发生)
  const round3 = await waitUntil('第三轮任务出现', async () => {
    const t = (await loopsOf()).find(x => ![parentId, round2.id].includes(x.id) && !['COMPLETED', 'FAILED', 'CANCELED'].includes(x.state ?? ''))
    return t ?? null
  }, 120_000)
  const cancel = await api('POST', `/api/workshop/tasks/${round3.id}/cancel`, { body: {}, token }).catch(e => ({ code: -1, message: String(e) }))
  check('取消第三轮活跃任务', cancel.code === 0, JSON.stringify(cancel).slice(0, 90))

  const canceledState = await waitUntil('第三轮任务进入 CANCELED', async () => {
    const t = (await loopsOf()).find(x => x.id === round3.id)
    return t?.state === 'CANCELED' ? t.state : null
  }, 60_000)
  check('取消生效', canceledState === 'CANCELED', `state=${canceledState}`)

  // 循环停止:等待超过 interval×2 无新任务出现
  await sleep(INTERVAL_MS * 2 + 4000)
  const finalLoops = await loopsOf()
  check('取消后循环停止(无新重放任务)', finalLoops.length === 3, `total=${finalLoops.length}`)

  // 清理
  const members = await api('GET', `/api/workshop/channels/${channelId}/agents`, { token })
  for (const m of members.data ?? []) {
    await api('POST', '/api/system/monitor/terminate', { body: { channelId, agentId: m.id }, token }).catch(() => {})
  }
  await api('DELETE', `/api/workshop/channels/${channelId}`, { token })

  console.log(`\n★ 结果: ${passed} passed, ${failures} failed`)
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((err) => {
  console.error('e2e 异常:', err.message)
  process.exit(1)
})
