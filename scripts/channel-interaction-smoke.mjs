#!/usr/bin/env node
/**
 * Channel 交互冒烟（2026-10-19）：消息落历史 + 任务生命周期 + 真实 worker 身份。
 * 运行：AW_BASE=... AW_TOKEN=... CHANNEL_ID=... node scripts/channel-interaction-smoke.mjs
 */
const BASE = process.env.AW_BASE ?? 'http://127.0.0.1:3000'
const TOKEN = process.env.AW_TOKEN
const CHANNEL_ID = process.env.CHANNEL_ID
if (!TOKEN || !CHANNEL_ID) throw new Error('AW_TOKEN and CHANNEL_ID required')
process.env.NO_PROXY = '127.0.0.1,localhost'
const H = { 'authorization': `Bearer ${TOKEN}`, 'content-type': 'application/json' }
const sleep = ms => new Promise(r => setTimeout(r, ms))
const results = []
const ok = (id, name, cond, detail = '') => {
  results.push({ id, name, pass: Boolean(cond), detail: String(detail).slice(0, 400) })
  console.log(`${cond ? '✔' : '✖'} [${id}] ${name}${cond ? '' : ` — ${String(detail).slice(0, 400)}`}`)
}
async function api(method, path, body) {
  const r = await fetch(BASE + path, {
    method, headers: H, body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  })
  const text = await r.text()
  try {
    return { status: r.status, ...JSON.parse(text) }
  }
  catch {
    return { status: r.status, raw: text }
  }
}
const data = r => r?.data ?? null
const tag = `chsmoke${Date.now().toString(36).slice(-5)}`

try {
  const ch = await api('GET', `/api/workshop/channels/${CHANNEL_ID}`)
  const activated = await api('POST', `/api/workshop/channels/${CHANNEL_ID}/activate`)
  console.log(`  channel activate: code=${activated.code} status=${activated.status}`)
  ok('H1', '频道详情可读', ch.code === 0 && Boolean(data(ch)?.id), `name=${data(ch)?.name}`)

  const ag = await api('GET', `/api/workshop/channels/${CHANNEL_ID}/agents`)
  const agents = data(ag) ?? []
  const opt = agents.find(a => a.role === 'worker' && /工艺优化/.test(a.name))
  ok('H2', '频道内存在启用的工艺优化 worker', Boolean(opt && opt.enabled), `name=${opt?.name} harness=${opt?.harness}`)
  ok('H3', 'worker 使用真实 omp + deepseek-flash', opt?.harness === 'omp' && opt?.config?.provider === 'deepseek' && opt?.config?.model === 'deepseek-flash', `harness=${opt?.harness} provider=${opt?.config?.provider} model=${opt?.config?.model}`)
  ok('H4', '频道 lead 实例 token 可读(任务路由证据)', Boolean(agents.find(a => a.role === 'lead')?.token), 'lead token present')

  const before = await api('GET', `/api/workshop/channels/${CHANNEL_ID}/messages?limit=50`)
  ok('H5', 'Channel 消息历史可读', before.code === 0 && Array.isArray(data(before)), `msgs=${data(before)?.length}`)

  const lead = agents.find(a => a.role === 'lead')
  const msg = await api('POST', `/api/workshop/channels/${CHANNEL_ID}/messages`, { toAgentId: lead?.id, text: `channel-interaction-${tag}` })
  ok('H6', 'POST /channels/:id/messages 发送', msg.code === 0, `code=${msg.code} status=${msg.status}`)

  const after = await api('GET', `/api/workshop/channels/${CHANNEL_ID}/messages?limit=50`)
  ok('H7', '消息持久化到 Channel 历史', after.code === 0 && (data(after) ?? []).some(m => JSON.stringify(m.parts ?? m).includes(`channel-interaction-${tag}`)), `msgs=${data(after)?.length}`)

  const task = await api('POST', `/api/workshop/channels/${CHANNEL_ID}/tasks`, {
    title: `channel-task-${tag}`, description: 'Channel 交互验收:确认收到并收口', mode: 'goal', modeConfig: { goalCriteria: '收到并收口' },
  })
  const taskId = data(task)?.id
  ok('H8', 'POST /channels/:id/tasks 提交', task.code === 0 && Boolean(taskId), `id=${taskId?.slice(0, 8)} state=${data(task)?.state}`)

  let state = data(task)?.state
  for (let i = 0; i < 30 && state !== 'COMPLETED' && state !== 'FAILED'; i++) {
    await sleep(2000)
    const list = await api('GET', `/api/workshop/channels/${CHANNEL_ID}/tasks`)
    const mine = (data(list) ?? []).find(x => x.id === taskId)
    state = mine?.state ?? state
  }
  ok('H9', 'Channel 任务生命周期到终态', state === 'COMPLETED', `state=${state}`)

  const list = await api('GET', `/api/workshop/channels/${CHANNEL_ID}/tasks`)
  ok('H10', '任务在 Channel 任务列表可追溯', (data(list) ?? []).some(x => x.id === taskId), `tasks=${data(list)?.length}`)
}
catch (e) {
  ok('FATAL', '脚本未抛异常', false, e.message)
}
const failed = results.filter(x => !x.pass).length
console.log(`\n${failed === 0 ? '★ ALL PASS' : `✗ ${failed} FAILED`} (${results.length - failed} passed)`)
process.exit(failed === 0 ? 0 : 1)
