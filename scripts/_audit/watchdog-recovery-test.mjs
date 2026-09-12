/**
 * watchdog-recovery-test.mjs —— 确定性验证「停滞裁决不丢成果」
 * ------------------------------------------------------------
 * 改动:scheduler-loop 的 WORKING 停滞裁决,原先 notify 一次后**无条件 cancel**,
 * 会把 progress>0、交付物齐全的任务整单作废。现在按有无产出分流:
 *   有产出(progress>0 或存在 input 以外的交付物)→ complete(成果保留)
 *   完全无产出                                  → cancel(防永挂)
 *
 * 怎么做到确定性(踩过两次坑后定的方案):
 *   · 看门狗**不回收 busy 成员**(设计如此),所以必须让 worker 的回合真的结束;
 *   · `report_progress` 是 agent 运行期工具,参数只有 {progress,message},没有 task id ——
 *     脱离回合调用是空操作,不能用来造状态;
 *   ⇒ 用 mock worker 的 delayMs 控制"上报到第几档就被打断":
 *       delayMs=1000 → 1s 报 25% → 2s 报 50% → … → 4s 收口
 *     在 ~1.5s 调 stop 打断它,任务就停在 WORKING + progress=25,成员转 idle。
 *     再等 stall_ms×2,看门狗应当**收口**而不是取消。
 *   ⇒ 对照组 delayMs 调到极大(600s),任务 progress 恒为 0,成员被 stop 后
 *     看门狗应当**取消**(没干过活不留永挂)。
 *
 * 需要先把 workshop.stall_ms 调到最小(10s),否则要等 10 分钟。
 * 用法:
 *   node scripts/_audit/watchdog-recovery-test.mjs --base http://127.0.0.1:3112
 */
const arg = (k, d) => {
  const i = process.argv.indexOf(`--${k}`)
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : d
}
const BASE = arg('base', 'http://127.0.0.1:3112').replace(/\/$/, '')
const WAIT_MS = Number(arg('wait', 150_000))
const INTERRUPT_MS = Number(arg('interrupt', 1500))

let TOKEN = null
const api = async (method, path, { body } = {}) => {
  const headers = { 'content-type': 'application/json' }
  if (TOKEN) headers.authorization = `Bearer ${TOKEN}`
  const res = await fetch(`${BASE}${path}`, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined })
  return { status: res.status, ...(await res.json().catch(() => ({}))) }
}
const data = r => r?.data ?? {}
const sleep = ms => new Promise(r => setTimeout(r, ms))
let pass = 0
let fail = 0
const check = (n, ok, d = '') => { console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${n}${d ? `  — ${d}` : ''}`); ok ? pass++ : fail++ }

TOKEN = data(await api('POST', '/api/users/login', { body: { email: 'plant@awshop.local', password: 'Plant!2026' } })).token
if (!TOKEN) { console.error('✖ 登录失败'); process.exitCode = 2; throw new Error('login') }

const cfg = data(await api('GET', '/api/system/settings'))
const stallMs = cfg.effective?.['workshop.stall_ms']
console.log(`workshop.stall_ms = ${stallMs ?? '(未读到)'}(看门狗需要 2× 该值才会收口)`)

async function makeChannel(tag, workerDelayMs) {
  const created = await api('POST', '/api/workshop/channels', {
    body: { name: `停滞-${tag}`, description: 'watchdog 回收验证', leadAgent: { name: `调度长W-${tag}`, harness: 'mock', config: { delayMs: 40 } } },
  })
  const channelId = data(created).channelId ?? data(created).id
  const tpl = data(await api('POST', '/api/workshop/agents', {
    body: { name: `慢执行员-${tag}`, harness: 'mock', config: { delayMs: workerDelayMs } },
  }))
  await api('POST', `/api/workshop/channels/${channelId}/agents`, { body: { agentId: tpl.id, role: 'worker' } })
  const membersRaw = data(await api('GET', `/api/workshop/channels/${channelId}/agents`))
  const members = Array.isArray(membersRaw) ? membersRaw : (membersRaw.agents ?? [])
  return { channelId, worker: members.find(m => m.role === 'worker') }
}

const getTask = async (channelId, taskId) => {
  const list = data(await api('GET', `/api/workshop/channels/${channelId}/tasks`)) ?? []
  return (Array.isArray(list) ? list : []).find(x => x.id === taskId)
}

async function waitTerminal(channelId, taskId, budget) {
  const deadline = Date.now() + budget
  let last = null
  while (Date.now() < deadline) {
    await sleep(2500)
    const t = await getTask(channelId, taskId)
    if (!t) continue
    if (`${t.state}:${t.progress}` !== last) {
      last = `${t.state}:${t.progress}`
      console.log(`     · ${t.state} progress=${t.progress}`)
    }
    if (['COMPLETED', 'FAILED', 'CANCELED'].includes(t.state)) return t
  }
  return await getTask(channelId, taskId)
}

// ── 用例 1:干过活(progress>0)却没收口 → 应收口保存成果 ──
console.log('\n━━━ 用例 1:progress>0 的停滞任务应被**收口**(成果保留)━━━')
{
  const { channelId, worker } = await makeChannel('keep', 1000)
  const taskRes = await api('POST', `/api/workshop/channels/${channelId}/tasks`, {
    body: { title: '停滞-有产出', parts: [{ text: '上报进度后被打断。' }], assigneeId: worker.id },
  })
  const taskId = data(taskRes).task?.id ?? data(taskRes).id
  console.log(`  任务 ${String(taskId).slice(0, 8)} 下发;${INTERRUPT_MS}ms 后打断 worker(它 4s 才会自己收口)`)
  await sleep(INTERRUPT_MS)
  await api('POST', `/api/workshop/channels/${channelId}/agents/${worker.id}/stop`)
  const cur = await getTask(channelId, taskId)
  console.log(`  打断后:state=${cur?.state} progress=${cur?.progress}`)
  check('已构造 WORKING + progress>0 且成员已 idle 的停滞态', cur?.state === 'WORKING' && cur?.progress > 0,
    `state=${cur?.state} progress=${cur?.progress}`)
  const final = await waitTerminal(channelId, taskId, WAIT_MS)
  check('停滞任务被收口为 COMPLETED(而非 CANCELED)', final?.state === 'COMPLETED',
    `state=${final?.state} progress=${final?.progress}`)
}

// ── 用例 2:零产出 → 仍应取消(防永挂)──
console.log('\n━━━ 用例 2:零产出的停滞任务应**取消**(防永挂)━━━')
{
  const { channelId, worker } = await makeChannel('drop', 600_000)
  const taskRes = await api('POST', `/api/workshop/channels/${channelId}/tasks`, {
    body: { title: '停滞-无产出', parts: [{ text: '什么都不做。' }], assigneeId: worker.id },
  })
  const taskId = data(taskRes).task?.id ?? data(taskRes).id
  console.log(`  任务 ${String(taskId).slice(0, 8)} 下发(worker delayMs=600s,不会上报任何进度)`)
  await sleep(2500)
  await api('POST', `/api/workshop/channels/${channelId}/agents/${worker.id}/stop`)
  const cur = await getTask(channelId, taskId)
  console.log(`  打断后:state=${cur?.state} progress=${cur?.progress}`)
  check('已构造 WORKING + progress=0 且成员已 idle 的停滞态', (cur?.progress ?? -1) === 0,
    `state=${cur?.state} progress=${cur?.progress}`)
  const final = await waitTerminal(channelId, taskId, WAIT_MS)
  check('零产出停滞任务被取消(未误判为完成)', final?.state === 'CANCELED', `state=${final?.state}`)
}

console.log(`\n${fail ? '✖' : '✅'} 看门狗回收:${pass} 通过 / ${fail} 失败`)
process.exitCode = fail ? 1 : 0
