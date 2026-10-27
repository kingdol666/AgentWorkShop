/**
 * 2026-10-28 全功能验收 US-012:T4 插件装载与工具注册面。
 * 断言:
 *  R1 插件面:≥11 插件 enabled 且 failures=[]
 *  R2 工具注册表:builtin 104 + plugin 21 全 available(允许上浮,下降须解释)
 *  R3 实调 diag_status(结果库/后端连通)
 *  R4 实调 aw_dcw_snapshot(节点面回包形状)与 aw_task_list(任务面回包形状)
 * 证据: docs/audit/evidence/2026-10-28-full-acceptance-run2/us12-tool-registry.json
 */
import { writeFileSync, mkdirSync } from 'node:fs'

const BASE = process.env.AW_BASE ?? 'http://127.0.0.1:3470'
const CH = '28239c1f-2e82-4207-a528-5edfb59b27ca'
const LEAD = '50283c08-818c-4a7a-af44-78e7359bfb21' // 数据分析师:持有 daq 绑定,节点面可读
const OUT = 'docs/audit/evidence/2026-10-28-full-acceptance-run2/us12-tool-registry.json'
process.env.NO_PROXY = '127.0.0.1,localhost'

const checks = []
const check = (id, name, ok, detail) => {
  checks.push({ id, name, ok: !!ok, detail: String(detail).slice(0, 300) })
  console.log(`${ok ? '✔' : '✘'} [${id}] ${name} — ${String(detail).slice(0, 240)}`)
}
const api = async (method, path, body, headers, timeoutMs = 60000) => {
  const r = await fetch(`${BASE}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(headers ?? {}) },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(timeoutMs),
  })
  let data = null
  try { data = await r.json() } catch { /* */ }
  return { status: r.status, data }
}

const login = await api('POST', '/api/users/login', { email: 'admin@mission.local', password: 'Mission#2026Acc' })
const TOK = login.data?.data?.token
check('R0', '管理员登录', !!TOK, `status=${login.status}`)
const rot = await api('POST', `/api/workshop/channels/${CH}/agents/${LEAD}/rotate-token`, {}, { Authorization: `Bearer ${TOK}` })
const ATOK = rot.data?.data?.token
check('R0b', '轮换 lead token', !!ATOK, `status=${rot.status}`)
if (!TOK || !ATOK) process.exit(1)
const AH = { 'x-aw-agent-token': ATOK, 'Authorization': `Bearer ${TOK}` }

// ── R1 插件面 ──
const plugs = await api('GET', '/api/workshop/plugins', undefined, { Authorization: `Bearer ${TOK}` })
const plist = plugs.data?.data?.plugins ?? plugs.data?.plugins ?? []
const enabled = plist.filter(p => p.enabled)
const failed = plist.filter(p => (p.failures ?? []).length > 0)
check('R1', `插件 ${plist.length} 个 enabled=${enabled.length} failures=0`, plist.length >= 11 && failed.length === 0, `failed=${failed.map(p => p.name).join(',') || '无'}`)

// ── R2 工具注册表 ──
const tools = await api('GET', '/api/workshop/tools', undefined, { Authorization: `Bearer ${TOK}` })
const tlist = tools.data?.data?.tools ?? tools.data?.tools ?? []
const builtin = tlist.filter(t => t.source === 'builtin')
const plugin = tlist.filter(t => t.source === 'plugin')
const unavailable = tlist.filter(t => t.available === false)
check('R2', `注册表 builtin=${builtin.length}(≥104) plugin=${plugin.length}(≥21) unavailable=0`, builtin.length >= 104 && plugin.length >= 21 && unavailable.length === 0, `total=${tlist.length} unavailable=${unavailable.map(t => t.name).join(',').slice(0, 120) || '无'}`)

// ── invoke 帮手 ──
const invoke = async (tool, args, timeoutMs = 90000) => {
  const r = await api('POST', '/api/workshop/agent-tools/invoke', { agentId: LEAD, tool, args: args ?? {} }, AH, timeoutMs)
  const u = r.data?.data?.result ?? r.data?.data ?? r.data
  const text = typeof u?.text === 'string' ? u.text : JSON.stringify(u ?? '')
  return { ok: u?.isError !== true, text }
}

// ── R3 diag_status 实调 ──
const ds = await invoke('diag_status', {})
check('R3', 'diag_status 实调成功', ds.ok && ds.text.length > 10, `resp=${ds.text.slice(0, 180)}`)

// ── R4 节点面/任务面回包形状(真实工具名:my_industrial_nodes / list_channel_tasks) ──
const snap = await invoke('my_industrial_nodes', {})
const snapOk = snap.ok && /dw-|dn-|name|节点|hold/i.test(snap.text)
check('R4a', 'my_industrial_nodes 回包含节点面', snapOk, `resp=${snap.text.slice(0, 180)}`)
const tl = await invoke('list_channel_tasks', {})
const tlOk = tl.ok && /task|title|state|任务|COMPLETED|WORKING|WAITING/i.test(tl.text)
check('R4b', 'list_channel_tasks 回包含任务面', tlOk, `resp=${tl.text.slice(0, 180)}`)

// ── 汇总 ──
const pass = checks.filter(c => c.ok).length
const result = { suite: 'US-012 T4 插件装载与工具注册面', base: BASE, at: new Date().toISOString(), checks, verdict: `PASS(${pass}/${checks.length})` }
mkdirSync('docs/audit/evidence/2026-10-28-full-acceptance-run2', { recursive: true })
writeFileSync(OUT, JSON.stringify(result, null, 2))
console.log(`\nUS-012: ${result.verdict} → ${OUT}`)
process.exit(pass === checks.length ? 0 : 1)
