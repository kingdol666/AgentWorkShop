/**
 * plc-agent-task.mjs —— 在既有 Channel 上补一个可确定性完成的 Agent 任务
 * ------------------------------------------------------------
 * 背景:上一轮用 `mock` 调度长 + `omp` 工艺员派发巡检任务,任务在 90s 后变成 CANCELED,
 * 且日志里**没有任何 spawn / dispatch 记录** —— 也就是 omp 根本没被拉起。
 * 为把「Channel → 任务 → Agent 执行 → 终态」这条路走完并留证,这里:
 *   ① 先用 mock 工艺员跑一次(确定性,验证链路本身可用)
 *   ② 再打印 omp 那次的历史,便于如实报告
 */
const BASE = (() => {
  const i = process.argv.indexOf('--base')
  return (i > 0 ? process.argv[i + 1] : 'http://127.0.0.1:3112').replace(/\/$/, '')
})()
const ADMIN = { email: 'plant@awshop.local', password: 'Plant!2026' }

// 记住登录态:helper 自动带上 token —— 之前每个调用点都要手写 token,
// 漏一个就静默 401(data=undefined),排查成本很高。
let TOKEN = null
const api = async (method, path, { body } = {}) => {
  const headers = { 'content-type': 'application/json' }
  if (TOKEN) headers.authorization = `Bearer ${TOKEN}`
  const res = await fetch(`${BASE}${path}`, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined })
  return { status: res.status, ...(await res.json().catch(() => ({}))) }
}
const data = r => r?.data ?? {}
const sleep = ms => new Promise(r => setTimeout(r, ms))

const login = await api('POST', '/api/users/login', { body: ADMIN })
TOKEN = data(login).token
if (!TOKEN) throw new Error('登录失败')

const chRaw = data(await api('GET', '/api/workshop/channels'))
const chans = Array.isArray(chRaw) ? chRaw : (chRaw.channels ?? [])
const ch = chans[0]
if (!ch) throw new Error('没有 Channel')
console.log(`Channel: ${ch.name} (${ch.id})`)

// ① mock 工艺员:确定性完成,证明 Channel 任务链路可用
const worker = data(await api('POST', '/api/workshop/agents', {
  body: { name: `巡检员-mock`, harness: 'mock', config: { delayMs: 30 } },
}))
await api('POST', `/api/workshop/channels/${ch.id}/agents`, { body: { agentId: worker.id, role: 'worker' } })
console.log(`mock worker: ${worker.id}`)

const task = await api('POST', `/api/workshop/channels/${ch.id}/tasks`, {
  body: {
    title: '工艺巡检(mock 链路验证)',
    parts: [{ text: '读取三路数采最近数据并汇报稳态判定。' }],
    assigneeId: worker.id,
  },
})
const taskId = data(task).task?.id ?? data(task).id
console.log(`task: ${taskId}`)

let final = null
for (let i = 0; i < 40; i++) {
  const list = data(await api('GET', `/api/workshop/channels/${ch.id}/tasks`)) ?? []
  const me = (Array.isArray(list) ? list : []).find(x => x.id === taskId)
  if (me && ['COMPLETED', 'FAILED', 'CANCELED'].includes(me.state)) {
    final = me
    break
  }
  await sleep(1500)
}
console.log(`mock 任务终态: ${final?.state ?? '(超时未终态)'}`)
console.log(final?.state === 'COMPLETED' ? '✅ Channel → 任务 → Agent 执行 → COMPLETED 链路可用' : `✖ 未完成: ${JSON.stringify(final).slice(0, 300)}`)

// ② 如实打印上一轮 omp 任务的历史
const all = data(await api('GET', `/api/workshop/channels/${ch.id}/tasks`)) ?? []
console.log('\n全部任务:')
for (const t of (Array.isArray(all) ? all : [])) {
  console.log(`  ${t.state.padEnd(10)} ${t.title}  assignee=${String(t.assigneeId ?? '').slice(0, 8)} progress=${t.progress ?? 0}`)
}
process.exitCode = final?.state === 'COMPLETED' ? 0 : 1
