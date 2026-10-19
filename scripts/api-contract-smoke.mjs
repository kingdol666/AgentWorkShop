#!/usr/bin/env node
/**
 * API 契约 + Channel 作用域冒烟（2026-10-19）
 *
 * 补齐 api-live-e2e 未覆盖的只读面与真实的跨频道 agent-token 负例：
 *  - health / users/me / channels / workspaces / daq / dcw / hitl / plugins / ops-logs 形状
 *  - 两个临时频道：用 A 频道 lead 的实例 token 访问 B 频道的任务详情/列表，必须 403/SCOPE_VIOLATION
 *  - 结束后删除两个临时频道，不触碰既有业务数据
 *
 * 运行：AW_BASE=http://127.0.0.1:3001 AW_TOKEN=<user-token> node scripts/api-contract-smoke.mjs
 */
const BASE = process.env.AW_BASE ?? 'http://127.0.0.1:3001'
const TOKEN = process.env.AW_TOKEN
if (!TOKEN) throw new Error('AW_TOKEN required (user token, admin or owner)')
process.env.NO_PROXY = '127.0.0.1,localhost'

const results = []
const ok = (id, name, cond, detail = '') => {
  results.push({ id, name, pass: Boolean(cond), detail: String(detail).slice(0, 400) })
  console.log(`${cond ? '✔' : '✖'} [${id}] ${name}${cond ? '' : ` — ${String(detail).slice(0, 400)}`}`)
}
const api = async (method, path, { token = TOKEN, body } = {}) => {
  const r = await fetch(BASE + path, {
    method,
    headers: { 'authorization': `Bearer ${token}`, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  })
  const text = await r.text()
  let json
  try {
    json = text ? JSON.parse(text) : {}
  }
  catch {
    json = { raw: text }
  }
  return { status: r.status, ...json }
}
const data = r => r?.data ?? null
const tag = `scope${Date.now().toString(36).slice(-5)}`
const created = []

async function createChannel(name) {
  const r = await api('POST', '/api/workshop/channels', {
    body: { name, description: 'api-contract-smoke', leadAgent: { name: `${name}-lead`, harness: 'mock', config: { delayMs: 80 } } },
  })
  if (r.code !== 0 || !data(r)?.channelId) throw new Error(`channel create failed: ${JSON.stringify(r).slice(0, 300)}`)
  created.push(data(r).channelId)
  return data(r)
}

try {
  // ── 只读面 ──────────────────────────────────────────────────────────────
  const health = await api('GET', '/api/health')
  ok('R1', 'GET /api/health', health.code === 0 && health.data?.status === 'ok', `status=${health.status}`)

  const me = await api('GET', '/api/users/me')
  ok('R2', 'GET /api/users/me', me.code === 0 && Boolean(data(me)?.id) && Boolean(data(me)?.role), `role=${data(me)?.role}`)

  const noAuth = await api('GET', '/api/users/me', { token: 'deadbeef' })
  ok('R3', '无效 token /users/me → 401', noAuth.status === 401, `status=${noAuth.status}`)

  const channels = await api('GET', '/api/workshop/channels')
  ok('R4', 'GET /channels 数组', channels.code === 0 && Array.isArray(data(channels)), `n=${data(channels)?.length}`)

  const workspaces = await api('GET', '/api/workshop/workspaces')
  ok('R5', 'GET /workspaces 数组', workspaces.code === 0 && Array.isArray(data(workspaces)), `n=${data(workspaces)?.length}`)

  const daq = await api('GET', '/api/workshop/daq')
  ok('R6', 'GET /daq 节点面', daq.code === 0 && Array.isArray(data(daq)?.nodes), `nodes=${data(daq)?.nodes?.length}`)

  const dcw = await api('GET', '/api/workshop/dcw')
  ok('R7', 'GET /dcw 产线面', dcw.code === 0 && Array.isArray(data(dcw)?.lines) && Array.isArray(data(dcw)?.nodes), `lines=${data(dcw)?.lines?.length} nodes=${data(dcw)?.nodes?.length}`)

  const hitl = await api('GET', '/api/workshop/hitl/pending')
  ok('R8', 'GET /hitl/pending 形状', hitl.code === 0 && (Array.isArray(data(hitl)?.items) || Array.isArray(data(hitl))), `type=${Array.isArray(data(hitl)) ? 'array' : 'object'}`)

  const plugins = await api('GET', '/api/workshop/plugins')
  const pluginList = plugins.plugins ?? data(plugins)?.plugins
  ok('R9', 'GET /plugins 列表', Array.isArray(pluginList), `n=${pluginList?.length}`)

  const logs = await api('GET', '/api/workshop/ops-logs?limit=5')
  ok('R10', 'GET /ops-logs 查询', logs.code === 0 && Array.isArray(data(logs)?.logs), `n=${data(logs)?.logs?.length} count=${data(logs)?.count}`)

  // ── Channel 作用域 ─────────────────────────────────────────────────────
  const a = await createChannel(`api-scope-A-${tag}`)
  const b = await createChannel(`api-scope-B-${tag}`)
  const bActivate = await api('POST', `/api/workshop/channels/${b.channelId}/activate`)
  ok('C1', '创建两个临时频道并激活 B', Boolean(a.channelId && b.channelId && bActivate.code === 0), `A=${a.channelId?.slice(0, 8)} B=${b.channelId?.slice(0, 8)}`)

  const bTask = await api('POST', `/api/workshop/channels/${b.channelId}/tasks`, {
    body: { title: `scope-task-${tag}`, description: '跨频道作用域负例', mode: 'goal', modeConfig: { goalCriteria: '完成' } },
  })
  ok('C2', 'B 频道任务创建', bTask.code === 0 && Boolean(data(bTask)?.id), `task=${data(bTask)?.id?.slice(0, 8)}`)

  const aAgents = await api('GET', `/api/workshop/channels/${a.channelId}/agents`)
  const aLeadToken = data(aAgents)?.find?.(x => x.id === a.leadAgentId)?.token
  ok('C3', 'A 频道 lead 实例 token 可读', Boolean(aLeadToken), `token=${aLeadToken ? 'yes' : 'no'}`)

  const crossDetail = await api('GET', `/api/workshop/tasks/${data(bTask)?.id}`, { token: aLeadToken })
  const deniedDetail = crossDetail.status === 403 || crossDetail.code === 'SCOPE_VIOLATION' || crossDetail.code === 'FORBIDDEN'
  ok('C4', 'A token 读 B 任务详情 → 403/SCOPE_VIOLATION', deniedDetail, `status=${crossDetail.status} code=${crossDetail.code}`)

  const mgmtList = await api('GET', `/api/workshop/channels/${b.channelId}/tasks`, { token: aLeadToken })
  const mgmtDenied = [401, 403].includes(mgmtList.status) || mgmtList.code === 'SCOPE_VIOLATION' || mgmtList.code === 'FORBIDDEN'
  const mgmtLeak = Array.isArray(data(mgmtList)) && data(mgmtList).some(x => x.id === data(bTask)?.id)
  ok('C5', 'A token 访问 B 频道管理任务面被拒且无泄露', mgmtDenied && !mgmtLeak, `status=${mgmtList.status} code=${mgmtList.code} leaked=${mgmtLeak}`)

  // agent token 真正使用的列表端点:必须 200 且只返回本频道任务
  const scopedList = await api('GET', '/api/workshop/tasks', { token: aLeadToken })
  const scopedRows = Array.isArray(data(scopedList)) ? data(scopedList) : (data(scopedList)?.tasks ?? [])
  const scopedLeak = scopedRows.some(x => x.id === data(bTask)?.id)
  ok('C6', 'A token 的 /tasks 列表 200 且不含 B 任务', scopedList.code === 0 && Array.isArray(scopedRows) && !scopedLeak, `status=${scopedList.status} code=${scopedList.code} n=${scopedRows.length} leaked=${scopedLeak}`)
}
catch (e) {
  ok('FATAL', '脚本未抛异常', false, e.message)
}
finally {
  for (const id of created) {
    const r = await api('DELETE', `/api/workshop/channels/${id}`).catch(() => null)
    console.log(`  cleanup channel ${id.slice(0, 8)} → ${r?.code ?? 'err'}`)
  }
  const failed = results.filter(x => !x.pass).length
  console.log(`\n${failed === 0 ? '★ ALL PASS' : `✗ ${failed} FAILED`} (${results.length - failed} passed)`)
  process.exit(failed === 0 ? 0 : 1)
}
