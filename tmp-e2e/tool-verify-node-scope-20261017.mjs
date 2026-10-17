#!/usr/bin/env node
/**
 * 工具调用参数+节点绑定验证 —— 真实场景 E2E(2026-10-17)。
 *
 *   node tmp-e2e/tool-verify-node-scope-20261017.mjs
 *
 * 场景:隔离实例(AW_MODE=home,自带启动)→ 建 A/B 两条产线 → A 线两个数采节点
 * (1 号绑定给 worker、1b 号同线不绑)、B 线一个数采节点(2 号)→ 只绑 1 号 →
 * 真实调用工具验证「传入参数必须是当前绑定节点」的预检闸门。
 *
 * ══ 验收标准(先行定义,逐条判定)══
 *  E1  实例隔离启动 + admin 就绪
 *  E2  场景搭建:双线 + 3 数采节点 + worker(仅绑 1 号节点)
 *  E3【核心】调 2 号节点(他线未绑定)→ 拒绝,文案含「引用校验」+ 列出 1 号绑定面(可行动)
 *  E4【核心】调 1 号节点(绑定内)→ 正常执行(进入 handler 返回查询结果)
 *  E5  调 1b 号节点(同线但未绑定,频道未绑线)→ 同样拒绝(未绑定不等于可见)
 *  E6  dcw_journal 无参 → 参数校验拒绝(hint 说明该传 node_id/recipe_id)
 *  E7  dcw_journal 传 2 号节点 → 引用校验拒绝
 *  E8  line_status 传 B 线 → 拒绝(可读产线列表在文案内)
 *  E9  line_status 传 A 线 → 正常返回状态
 *  E10 频道绑线只读扩权:频道绑定 A 线后,1b 号(同线未绑定)可读;2 号(B 线)仍拒
 *  E11 recipe_apply 传 B 线配方(未绑定/不可读)→ 引用校验拒绝
 *  E12 拒绝入册:ops-logs 可查到 action=tool.call.denied
 * 判定:E1-E12 全绿 ⇒ 通过。
 */
import { spawn, spawnSync } from 'node:child_process'
import { mkdirSync, openSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const REPO = process.cwd()
const ROOT = 'D:/tmp/aw-tv'
rmSync(ROOT, { recursive: true, force: true })
mkdirSync(join(ROOT, 'home'), { recursive: true })
mkdirSync(join(REPO, '.AgentWorkShop', 'analysis'), { recursive: true })

const TAG = `tv${Date.now().toString(36).slice(-4)}`
const results = []
const ok = (id, name, cond, detail = '') => {
  results.push({ id, name, pass: Boolean(cond), detail: String(detail).slice(0, 200) })
  console.log(`${cond ? '✔' : '✖'} [${id}] ${name}${cond ? '' : ` — ${String(detail).slice(0, 260)}`}`)
}
const sleep = ms => new Promise(r => setTimeout(r, ms))

// ── 0. 隔离实例自启(dev:从源码跑,认 AW_HOME)──
const PORT_CANDIDATES = [3996, 3995, 3994, 3993]
let port = 0
for (const p of PORT_CANDIDATES) {
  try {
    const r = await fetch(`http://127.0.0.1:${p}/api/health`, { signal: AbortSignal.timeout(1200) })
    if (r.ok) { console.log(`  端口 ${p} 已被占用(健康响应),跳过`); continue }
  }
  catch { /* 空闲 */ }
  port = p
  break
}
if (!port) { console.error('无空闲端口可用'); process.exit(1) }
const BASE = `http://127.0.0.1:${port}`
process.env.NO_PROXY = '127.0.0.1,localhost'

const logFd = openSync(join(ROOT, 'dev.log'), 'a')
const child = spawn(process.execPath, [join(REPO, 'bin', 'aw.mjs'), 'dev', '--port', String(port)], {
  cwd: REPO,
  env: {
    ...process.env,
    AW_MODE: 'home',
    AW_HOME: join(ROOT, 'home'),
    AW_RATE_LIMIT_OFF: '1',
    NUXT_SESSION_PASSWORD: 'ToolVerify#2026-e2e-session-key',
    NO_PROXY: '127.0.0.1,localhost',
  },
  stdio: ['ignore', logFd, logFd],
  windowsHide: true,
})

async function api(method, path, body, token, timeoutMs = 60_000) {
  const res = await fetch(BASE + path, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  })
  let json = null
  try { json = await res.json() } catch { /* 非 JSON */ }
  return { status: res.status, ...json }
}
const invText = r => String(r?.data?.result?.text ?? r?.data?.text ?? '')
const invErr = r => Boolean(r?.data?.result?.isError ?? r?.data?.isError)

try {
  let healthy = false
  for (let i = 0; i < 90; i++) {
    await sleep(2000)
    try {
      const h = await api('GET', '/api/health', undefined, undefined, 3000)
      if (h?.data?.status === 'ok' && h?.data?.workshop === 'ready') { healthy = true; break }
    }
    catch { /* 未就绪 */ }
    if (i % 10 === 9) console.log(`  · 等待实例就绪 ${(i + 1) * 2}s…`)
  }
  ok('E1', '隔离实例启动 + workshop ready', healthy, `port=${port}`)
  if (!healthy) throw new Error('实例未就绪,中止')

  const email = `tv-${TAG}@awshop.local`
  let token = (await api('POST', '/api/users/register', { name: `tv-admin-${TAG}`, email, password: 'TvAdmin#2026' })).data?.token
  ok('E1b', 'admin 注册/登录', Boolean(token))
  const H = () => token

  // ── E2 场景搭建 ──
  const lineA = (await api('POST', '/api/workshop/dcw/lines', { name: `校验线A-${TAG}` }, H())).data?.line?.id
  const lineB = (await api('POST', '/api/workshop/dcw/lines', { name: `校验线B-${TAG}` }, H())).data?.line?.id
  const mkDaq = async (name, lineId) => (await api('POST', '/api/workshop/daq', {
    templateRef: 'daq-temp-tc', name, driver: 'mock', lineId, intervalMs: 1000, publishIntervalMs: 0,
  }, H())).data?.node?.id
  const node1 = await mkDaq(`1号绑定节点-${TAG}`, lineA)
  const node1b = await mkDaq(`1b同线未绑-${TAG}`, lineA)
  const node2 = await mkDaq(`2号他线节点-${TAG}`, lineB)
  const channelId = (await api('POST', '/api/workshop/channels', { name: `校验频道-${TAG}`, templateKey: 'legacy' }, H())).data?.channelId
  const workerId = (await api('POST', `/api/workshop/channels/${channelId}/agents`, { name: `校验工程师-${TAG}`, role: 'worker', harness: 'omp' }, H())).data?.id
  const bind = await api('POST', '/api/workshop/agent-tools/bindings', { agentId: workerId, nodeId: node1, kind: 'daq', mode: 'auto' }, H())
  await api('POST', '/api/workshop/daq/controller', { action: 'start' }, H())
  ok('E2', '双线+3 数采节点+worker(仅绑 1 号)',
    Boolean(lineA && lineB && node1 && node1b && node2 && workerId) && bind.status === 200,
    `bind=${bind.status} ${bind.message ?? ''}`)

  // ── E3/E4 核心:调 2 号被拒 / 调 1 号成功 ──
  const deny2 = await api('POST', '/api/workshop/agent-tools/invoke', { agentId: workerId, tool: 'daq_query', args: { node_id: node2 } }, H())
  const deny2Text = invText(deny2)
  ok('E3', '调 2 号(他线未绑定)→ 拒绝且文案可行动',
    invErr(deny2) && /引用校验/.test(deny2Text) && deny2Text.includes(node1) && deny2Text.includes(node2),
    deny2Text.slice(0, 240))

  const ok1 = await api('POST', '/api/workshop/agent-tools/invoke', { agentId: workerId, tool: 'daq_query', args: { node_id: node1, last_minutes: 5 } }, H())
  ok('E4', '调 1 号(绑定内)→ 正常执行', !invErr(ok1) && /数采数据查询结果/.test(invText(ok1)), invText(ok1).slice(0, 160))

  // ── E5 同线未绑定(频道未绑线)──
  const deny1b = await api('POST', '/api/workshop/agent-tools/invoke', { agentId: workerId, tool: 'daq_query', args: { node_id: node1b } }, H())
  ok('E5', '调 1b(同线未绑定,频道未绑线)→ 拒绝', invErr(deny1b) && /引用校验/.test(invText(deny1b)), invText(deny1b).slice(0, 200))

  // ── E6/E7 dcw_journal:缺参 / 越界 ──
  const j0 = await api('POST', '/api/workshop/agent-tools/invoke', { agentId: workerId, tool: 'dcw_journal', args: {} }, H())
  ok('E6', 'dcw_journal 无参 → 参数校验拒绝(hint 明确)', invErr(j0) && /node_id 或 recipe_id 至少提供一个/.test(invText(j0)), invText(j0).slice(0, 200))
  const j2 = await api('POST', '/api/workshop/agent-tools/invoke', { agentId: workerId, tool: 'dcw_journal', args: { node_id: node2 } }, H())
  ok('E7', 'dcw_journal 传 2 号 → 引用校验拒绝', invErr(j2) && /引用校验/.test(invText(j2)), invText(j2).slice(0, 200))

  // ── E8/E9 line_status:B 线拒 / A 线通 ──
  const lsB = await api('POST', '/api/workshop/agent-tools/invoke', { agentId: workerId, tool: 'line_status', args: { line_id: lineB } }, H())
  ok('E8', 'line_status B 线 → 拒绝(列可读产线)', invErr(lsB) && (lsB.data?.result?.text ?? '').includes(lineA), invText(lsB).slice(0, 200))
  const lsA = await api('POST', '/api/workshop/agent-tools/invoke', { agentId: workerId, tool: 'line_status', args: { line_id: lineA } }, H())
  ok('E9', 'line_status A 线 → 正常返回', !invErr(lsA) && /产线状态/.test(invText(lsA)), invText(lsA).slice(0, 160))

  // ── E10 频道绑线只读扩权 ──
  await api('PUT', `/api/workshop/channels/${channelId}/line`, { lineId: lineA }, H())
  const ok1b = await api('POST', '/api/workshop/agent-tools/invoke', { agentId: workerId, tool: 'daq_query', args: { node_id: node1b, last_minutes: 5 } }, H())
  const still2 = await api('POST', '/api/workshop/agent-tools/invoke', { agentId: workerId, tool: 'daq_query', args: { node_id: node2 } }, H())
  ok('E10', '频道绑线后:1b(同线)可读、2 号(他线)仍拒',
    !invErr(ok1b) && invErr(still2) && /引用校验/.test(invText(still2)),
    `1b:${invText(ok1b).slice(0, 60)} | 2:${invText(still2).slice(0, 80)}`)

  // ── E11 配方面:他线配方被拒 ──
  const productB = (await api('POST', '/api/workshop/dcw/products', { lineId: lineB, name: `B产品-${TAG}` }, H())).data?.product?.id
  const tplB = (await api('POST', '/api/workshop/dcw/templates', { name: `B参数-${TAG}`, ch: 'B温度', unit: '℃', min: 0, max: 200, decimals: 1 }, H())).data?.template?.key
  const dcwB = (await api('POST', '/api/workshop/dcw', { templateRef: tplB, name: `B数控-${TAG}`, driver: 'mock', lineId: lineB, stepLimit: 20 }, H())).data?.node?.id
  const recipeB = (await api('POST', '/api/workshop/dcw/recipes', { productId: productB, name: `B配方-${TAG}`, params: [{ nodeId: dcwB, value: 100, min: 0, max: 200 }] }, H())).data?.recipe?.id
  const rp = await api('POST', '/api/workshop/agent-tools/invoke', { agentId: workerId, tool: 'recipe_apply', args: { recipe_id: recipeB, reason: '越界验证' } }, H())
  ok('E11', 'recipe_apply 他线配方 → 引用校验拒绝', invErr(rp) && /引用校验/.test(invText(rp)) && /配方/.test(invText(rp)), invText(rp).slice(0, 220))

  // ── E12 拒绝入册 ──
  const logs = await api('GET', '/api/workshop/ops-logs?limit=200', undefined, H())
  const all = logs.data?.logs ?? logs.data?.items ?? logs.data ?? []
  const rows = Array.isArray(all) ? all.filter(r => r?.action === 'tool.call.denied') : []
  ok('E12', '拒绝入册 audit(tool.call.denied ≥3 条)', rows.length >= 3, `denied=${rows.length} total=${Array.isArray(all) ? all.length : typeof all}`)
}
catch (err) {
  ok('EX', '执行异常', false, err instanceof Error ? err.message : String(err))
}
finally {
  // 收尾:杀实例树(taskkill /T 连子进程),写验收报告
  try { spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }) } catch { /* 已退出 */ }
  const passed = results.filter(r => r.pass).length
  const failed = results.filter(r => !r.pass)
  const verdict = failed.length === 0 ? 'PASS' : 'FAIL'
  const md = [
    `# 工具调用参数+节点绑定验证 E2E(${TAG})`,
    '',
    `- 时间:${new Date().toISOString()}  实例:${BASE}(dev,隔离 home)  结论:**${verdict}**(${passed}/${results.length})`,
    '- 场景:worker 仅绑定「1 号节点」;调 2 号(他线)/1b(同线未绑)→ 引用校验拒绝并列出绑定面;调 1 号 → 正常执行;',
    '  频道绑线后同线只读扩权生效;参数缺省(dcw_journal 无参)、line_status 越线、他线配方均被统一预检拦截;拒绝入册。',
    '',
    '| 编号 | 项目 | 判定 | 证据 |',
    '|---|---|---|---|',
    ...results.map(r => `| ${r.id} | ${r.name} | ${r.pass ? '✔' : '✖'} | ${r.detail.replace(/\|/g, '/')} |`),
    '',
  ].join('\n')
  writeFileSync(join(REPO, '.AgentWorkShop', 'analysis', `tool-verify-node-scope-${new Date().toISOString().slice(0, 10)}.md`), md)
  console.log(`\n═══ 结论:${verdict}(${passed}/${results.length})═══`)
  if (failed.length) { console.log('失败项:'); for (const f of failed) console.log(`  ✖ [${f.id}] ${f.name} — ${f.detail}`) }
  process.exit(failed.length === 0 ? 0 : 1)
}
