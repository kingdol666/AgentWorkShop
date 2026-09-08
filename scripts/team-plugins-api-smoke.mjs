/**
 * 团队级插件开关 + 内置插件 + 配置化 API — 轻量 HTTP 冒烟(AgentWorkShop 3001)。
 * 覆盖:内置识别 / 建队带 plugins / 团队插件 GET+PUT / 工具清单团队过滤 /
 * dispatch 拒绝 / 系统配置 plugins 组读写与热更新 / 插件健康检测。
 * 无真实诊断、无 LLM 会话消耗。
 */
import { readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'

const BASE = process.env.AW_BASE ?? 'http://localhost:3001'
const saved = JSON.parse(readFileSync(new URL('../.AgentWorkShop/data/.three-system-e2e-token.json', import.meta.url), 'utf8'))
const T = process.env.AW_E2E_TOKEN ?? saved.token

// admin 夹具:settings API 需要 admin/editor;临时把 e2e 夹具用户全升为 editor,结束还原
const db = new DatabaseSync(new URL('../.AgentWorkShop/data/users.sqlite', import.meta.url))
db.exec('PRAGMA busy_timeout=4000')
const fixtureIds = (db.prepare('SELECT id FROM users WHERE name = \'three-system-demo\' OR name LIKE \'e2e3sys-%\'').all() ?? [])
  .map(r => r.id)
const upgraded = []
for (const id of fixtureIds) {
  const role = db.prepare('SELECT role FROM users WHERE id = ?').get(id)?.role
  if (role && role !== 'admin') {
    upgraded.push({ id, role })
    db.prepare('UPDATE users SET role = ? WHERE id = ?').run('admin', id)
  }
}

let pass = 0
let fail = 0
const ok = (cond, label, detail = '') => {
  if (cond) {
    pass++
    console.log(`  ✔ ${label}${detail ? ` —— ${detail}` : ''}`)
  }
  else {
    fail++
    console.error(`  ✘ ${label}${detail ? ` —— ${detail}` : ''}`)
  }
}
const sleep = ms => new Promise(r => setTimeout(r, ms))
async function api(method, path, { body, token, timeoutMs = 20000 } = {}) {
  const headers = {}
  if (body !== undefined) headers['content-type'] = 'application/json'
  if (token) headers.authorization = `Bearer ${token}`
  const res = await fetch(`${BASE}${path}`, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(timeoutMs) })
  return { status: res.status, json: await res.json().catch(() => null) }
}

console.log('\n══ 团队插件开关 + 内置插件 + 配置化 API 冒烟 ══')
// 1) 内置识别
const plugs = await api('GET', '/api/workshop/plugins', { token: T })
const list = plugs.json?.plugins ?? plugs.json?.data?.plugins ?? []
const bridges = list.filter(p => ['rag-bridge', 'diag-bridge'].includes(p?.name))
ok(list.length > 0, '插件清单可读', `count=${list.length}`)
ok(bridges.length === 2 && bridges.every(p => p.builtin && p.enabled && p.scope === 'builtin'), '两桥接插件以内置作用域识别且启用', bridges.map(p => `${p.name}(${p.scope})`).join(','))

// 2) 健康检测
const ragH = await api('GET', '/api/plugins/rag-bridge/health', { token: T })
ok(ragH.status === 200 && ragH.json?.backend?.ok === true && ragH.json?.web?.ok === true, 'rag-bridge 健康检测(backend+web)', `kb=${ragH.json?.kb?.name}`)
const dgH = await api('GET', '/api/plugins/diag-bridge/health', { token: T })
ok(dgH.status === 200 && dgH.json?.remote?.status === 'ok', 'diag-bridge 健康检测(3210 可达)', `activeRuns=${dgH.json?.remote?.activeRuns}`)

// 3) 系统配置 plugins 组(读 + 写 + 热更新)
const cfg = await api('GET', '/api/system/settings', { token: T })
const eff = cfg.json?.data?.effective ?? cfg.json?.effective ?? {}
ok(eff['plugins.kb.base_url'] === 'http://127.0.0.1:8770' && eff['plugins.diag.base_url'] === 'http://127.0.0.1:3210', '系统配置 plugins 组可读(schema 驱动)', `kb=${eff['plugins.kb.base_url']} diag=${eff['plugins.diag.base_url']}`)
const patch = await api('PATCH', '/api/system/settings', { token: T, body: { override: { 'plugins.kb.web_url': 'http://127.0.0.1:6789' } } })
const pRes = patch.json?.data ?? patch.json ?? {}
ok(pRes.ok === true, 'plugins 配置项可写(热生效)', `changed=${(pRes.changed ?? []).join(',') || '-'}`)

// 4) 建队带 plugins(默认全启用)与关闭插件团队
const nameA = `冒烟-全启用-${Date.now().toString(36)}`
const cA = await api('POST', '/api/workshop/channels', {
  token: T,
  body: { name: nameA, leadAgent: { name: '冒烟组长', harness: 'mock' } },
})
const chA = cA.json?.data?.channelId
ok(Boolean(chA), '建队(未传 plugins → 默认全启用)')
const nameB = `冒烟-关闭KB-${Date.now().toString(36)}`
const cB = await api('POST', '/api/workshop/channels', {
  token: T,
  body: {
    name: nameB,
    leadAgent: { name: '冒烟组长B', harness: 'mock' },
    plugins: [{ name: 'rag-bridge', enabled: false }, { name: 'diag-bridge', enabled: true }],
  },
})
const chB = cB.json?.data?.channelId
ok(Boolean(chB), '建队带 plugins 勾选(rag-bridge 关闭)')

// 5) 团队插件视图
const viewA = await api('GET', `/api/workshop/channels/${chA}/plugins`, { token: T })
ok(viewA.json?.data?.source === 'default' && viewA.json?.data?.plugins?.every(p => p.enabled), 'A 团队视图:source=default 全启用', `count=${viewA.json?.data?.plugins?.length}`)
const viewB = await api('GET', `/api/workshop/channels/${chB}/plugins`, { token: T })
const kbView = (viewB.json?.data?.plugins ?? []).find(p => p.name === 'rag-bridge')
const dgView = (viewB.json?.data?.plugins ?? []).find(p => p.name === 'diag-bridge')
ok(viewB.json?.data?.source === 'explicit' && kbView?.enabled === false && dgView?.enabled === true, 'B 团队视图:显式配置(rag 关/diag 开)', `source=${viewB.json?.data?.source}`)

// 工具直调用 omp 执行器(mock lead 无 dispatch 面);建队后补执行器成员
const mkExec = async (ch, name) => {
  const members = (await api('GET', `/api/workshop/channels/${ch}/agents`, { token: T })).json?.data ?? []
  if (!members.some(m => m?.name === name)) {
    await api('POST', `/api/workshop/channels/${ch}/agents`, { token: T, body: { name, harness: 'omp', role: 'worker' } })
  }
  return ((await api('GET', `/api/workshop/channels/${ch}/agents`, { token: T })).json?.data ?? []).find(m => m?.name === name)
}
const execA = await mkExec(chA, '冒烟执行器A')
const execB = await mkExec(chB, '冒烟执行器B')

// 6) 工具清单团队过滤(A 团队执行器含 kb_*;B 团队执行器无 kb_*)
const toolsA = (await api('GET', `/api/workshop/agent-tools/list?agentId=${execA.id}`, { token: T })).json?.data?.tools ?? []
const toolsB = (await api('GET', `/api/workshop/agent-tools/list?agentId=${execB.id}`, { token: T })).json?.data?.tools ?? []
ok(toolsA.some(t => t.name === 'kb_search') && toolsA.some(t => t.name === 'diag_run'), 'A 团队工具清单含 kb_*/diag_*(插件工具注入)', `total=${toolsA.length}`)
ok(!toolsB.some(t => t.name === 'kb_search') && !toolsB.some(t => t.name === 'kb_store'), 'B 团队工具清单无 kb_*(关闭插件不注入,防上下文污染)', `total=${toolsB.length}`)
ok(toolsB.some(t => t.name === 'diag_run'), 'B 团队 diag_* 仍在(diag-bridge 开启)')

// 7) dispatch 拒绝:B 团队调 kb_search → isError
const invB = await api('POST', '/api/workshop/agent-tools/invoke', {
  token: T,
  body: { agentId: execB.id, tool: 'kb_search', args: { query: '冒烟' } },
})
const rB = invB.json?.data?.result
ok(rB?.isError === true && String(rB?.text).includes('未启用插件'), 'B 团队调用被拒插件工具 → isError + 引导开启', String(rB?.text).slice(0, 70))
// A 团队正常
const invA = await api('POST', '/api/workshop/agent-tools/invoke', {
  token: T, timeoutMs: 60000,
  body: { agentId: execA.id, tool: 'kb_search', args: { query: '冒烟验证' } },
})
const rA = invA.json?.data?.result
ok(rA && rA.isError !== true, 'A 团队调用插件工具正常(工具桥链路通)', String(rA?.text ?? '').slice(0, 60))

// 8) 团队设置切换:PUT 开回 rag-bridge → 工具回来
const put = await api('PUT', `/api/workshop/channels/${chB}/plugins`, {
  token: T,
  body: { plugins: [{ name: 'rag-bridge', enabled: true }, { name: 'diag-bridge', enabled: true }] },
})
ok(put.status === 200 && put.json?.data?.saved === 2, '团队设置 PUT 切换开关', `saved=${put.json?.data?.saved}`)
await sleep(1000)
const toolsB2 = (await api('GET', `/api/workshop/agent-tools/list?agentId=${execB.id}`, { token: T })).json?.data?.tools ?? []
ok(toolsB2.some(t => t.name === 'kb_search'), '开回后 kb_search 回到 B 团队工具清单(热生效)')

// 9) 清理:还原角色、删冒烟频道(删除级联 channel_plugins)
for (const u of upgraded) db.prepare('UPDATE users SET role = ? WHERE id = ?').run(u.role, u.id)
db.close()
for (const ch of [chA, chB]) {
  await api('DELETE', `/api/workshop/channels/${ch}`, { token: T }).catch(() => null)
}
console.log(`\n══ 冒烟结果:${pass} 通过 / ${fail} 失败 ══`)
process.exit(fail > 0 ? 1 : 0)
