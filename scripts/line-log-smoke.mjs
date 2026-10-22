#!/usr/bin/env node
/**
 * 产线日志验收(2026-10-19;隔离实例,真实 HTTP + Agent 工具桥):
 *  G1 隔离实例 + admin 注册
 *  G2 建线/节点/产品/配方/频道(lead)+ 绑线 + 节点绑定
 *  G3 生成真实产线操作:dcw.create / line.update / recipe.create / recipe.apply /
 *     recipe.dispatch.ack / line.start / line.stop / 人工记录
 *  G4 生成全局污染事件:user.create + auth.login(必须被产线日志排除)
 *  G5 API:默认 line 域 / 按 line / 按 recipe / 按时间 / 非法时间区间 / scope=all
 *  G6 Agent 工具:ops_log(line+recipe+时间)、recipe_log、越权产线、非法时间、node_id
 *
 * 运行:node scripts/line-log-smoke.mjs
 */
import { spawn, spawnSync } from 'node:child_process'
import { mkdirSync, openSync, rmSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const ROOT = join(tmpdir(), 'aw-line-log-smoke')
rmSync(ROOT, { recursive: true, force: true })
mkdirSync(join(ROOT, 'home'), { recursive: true })
const TAG = `ll${Date.now().toString(36).slice(-4)}`
const results = []
const ok = (id, name, cond, detail = '') => {
  results.push({ id, name, pass: Boolean(cond), detail: String(detail).slice(0, 320) })
  console.log(`${cond ? '✔' : '✖'} [${id}] ${name}${cond ? '' : ` — ${String(detail).slice(0, 320)}`}`)
}
const sleep = ms => new Promise(r => setTimeout(r, ms))

let port = 0
for (const p of [3993, 3992, 3991, 3990]) {
  try {
    const r = await fetch(`http://127.0.0.1:${p}/api/health`, { signal: AbortSignal.timeout(1200) })
    if (r.ok) continue
  }
  catch { /* 空闲 */ }
  port = p
  break
}
if (!port) {
  console.error('无空闲端口')
  process.exit(1)
}
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
    NUXT_SESSION_PASSWORD: 'LineLog#2026-e2e-session-key',
    NO_PROXY: '127.0.0.1,localhost',
  },
  stdio: ['ignore', logFd, logFd],
  windowsHide: true,
})

async function api(method, path, body, token, timeoutMs = 120_000) {
  const res = await fetch(BASE + path, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  })
  let json = null
  try {
    json = await res.json()
  }
  catch { /* 非 JSON */ }
  return { status: res.status, ...json }
}
const data = r => r?.data ?? null
const invText = r => String(r?.data?.result?.text ?? r?.data?.text ?? '')
const invErr = r => Boolean(r?.data?.result?.isError ?? r?.data?.isError)
const invoke = (agentId, tool, args, token) => api('POST', '/api/workshop/agent-tools/invoke', { agentId, tool, args }, token)

try {
  let healthy = false
  for (let i = 0; i < 90; i++) {
    await sleep(2000)
    try {
      const h = await api('GET', '/api/health', undefined, undefined, 3000)
      if (h?.data?.status === 'ok' && h?.data?.workshop === 'ready') {
        healthy = true
        break
      }
    }
    catch { /* 未就绪 */ }
  }
  ok('G1a', '隔离实例启动 + workshop ready', healthy, `port=${port}`)
  if (!healthy) throw new Error('实例未就绪')

  const email = `ll-${TAG}@awshop.local`
  const token = data(await api('POST', '/api/users/register', { name: `ll-admin-${TAG}`, email, password: 'LineLog#2026' }))?.token
  ok('G1b', 'admin 注册/登录', Boolean(token))
  const H = () => token

  // ── G2 场景 ──
  const lineA = data(await api('POST', '/api/workshop/dcw/lines', { name: `日志线A-${TAG}` }, H()))?.line?.id
  const lineB = data(await api('POST', '/api/workshop/dcw/lines', { name: `日志线B-${TAG}` }, H()))?.line?.id
  const tpl = data(await api('POST', '/api/workshop/dcw/templates', { name: `日志参数-${TAG}`, ch: '温度', unit: '℃', min: 0, max: 200, decimals: 1 }, H()))?.template?.key
  const node = data(await api('POST', '/api/workshop/dcw', { templateRef: tpl, name: `日志数控-${TAG}`, driver: 'mock', lineId: lineA, stepLimit: 20, driverConfig: { key: `ll-${TAG}` } }, H()))?.node?.id
  const product = data(await api('POST', '/api/workshop/dcw/products', { lineId: lineA, name: `日志产品-${TAG}` }, H()))?.product?.id
  const recipe = data(await api('POST', '/api/workshop/dcw/recipes', { productId: product, name: `日志配方-${TAG}`, params: [{ nodeId: node, value: 100, min: 0, max: 200 }] }, H()))?.recipe?.id
  const ch = data(await api('POST', '/api/workshop/channels', { name: `日志频道-${TAG}`, leadAgent: { name: `日志lead-${TAG}`, harness: 'omp' } }, H()))
  const channelId = ch?.channelId
  const lead = ch?.leadAgentId
  const bindLine = await api('PUT', `/api/workshop/channels/${channelId}/line`, { lineId: lineA }, H())
  // 不额外做节点/配方绑定:只靠频道绑线的只读扩权,验证 ops_log/recipe_log 的读面口径
  ok('G2', '建线/节点/产品/配方/频道(lead)/绑线',
    Boolean(lineA && lineB && tpl && node && product && recipe && channelId && lead) && bindLine.status === 200,
    JSON.stringify({ lineA, lineB, node, recipe, channelId, lead, bindLine: bindLine.status }).slice(0, 300))

  // ── G3 真实产线操作 ──
  await api('POST', '/api/workshop/dcw/controller', { action: 'start' }, H())
  const apply = await api('POST', `/api/workshop/dcw/recipes/${recipe}/apply`, {}, H())
  const start = await api('POST', `/api/workshop/dcw/lines/${lineA}/start`, { recipeId: recipe }, H())
  const stop = await api('POST', `/api/workshop/dcw/lines/${lineA}/stop`, {}, H())
  const patch = await api('PATCH', `/api/workshop/dcw/lines/${lineA}`, { description: `line-log-${TAG}` }, H())
  const manualSummary = `人工值班记录-${TAG}`
  const manual = await api('POST', '/api/workshop/ops-logs', { summary: manualSummary, lineId: lineA, recipeId: recipe, detail: { tag: TAG } }, H())
  ok('G3', '真实产线操作已生成(recipe.apply/line.start/stop/line.update/manual)',
    apply.status === 200 && start.status === 200 && stop.status === 200 && patch.status === 200 && manual.status === 200,
    JSON.stringify({ apply: apply.status, start: start.status, stop: stop.status, patch: patch.status, manual: manual.status, msg: apply.message ?? start.message ?? manual.message }).slice(0, 300))

  // ── G4 全局污染事件(必须不出现在产线日志)──
  const tempEmail = `ll-temp-${TAG}@awshop.local`
  const tempUser = data(await api('POST', '/api/users', { name: `ll-temp-${TAG}`, email: tempEmail, password: 'LineLog#2026', role: 'user' }, H()))
  const login = await api('POST', '/api/users/login', { email: tempEmail, password: 'LineLog#2026' })
  ok('G4', '全局事件已生成(user.create + auth.login)', Boolean(tempUser?.id) && login.status === 200,
    JSON.stringify({ userId: tempUser?.id, login: login.status }).slice(0, 200))

  await sleep(1200)
  const all = await api('GET', '/api/workshop/ops-logs?limit=500', undefined, H())
  const allRows = data(all)?.logs ?? []
  ok('G5a', '产线日志默认只返回 scope=line 且 line_id 非空的记录',
    all.status === 200 && allRows.length > 0 && allRows.every(r => r.scope === 'line' && String(r.lineId ?? '') !== ''),
    `status=${all.status} n=${allRows.length} badScope=${allRows.filter(r => r.scope !== 'line').length} noLine=${allRows.filter(r => !r.lineId).length}`)
  ok('G5b', '登录/用户创建/系统设置/备份不进入产线日志',
    !allRows.some(r => r.action === 'auth.login' || r.action === 'user.create' || String(r.action).startsWith('system.')),
    `actions=${[...new Set(allRows.map(r => r.action))].slice(0, 16).join(',')}`)

  const byLine = data(await api('GET', `/api/workshop/ops-logs?lineId=${encodeURIComponent(lineA)}&limit=500`, undefined, H()))?.logs ?? []
  const lineActions = new Set(byLine.map(r => r.action))
  ok('G5c', '按产线过滤:全部命中该线,含无 recipe 的产线事件与开线/配方/人工事件',
    byLine.length > 0 && byLine.every(r => r.lineId === lineA && r.scope === 'line')
    && ['line.start', 'line.stop', 'line.update', 'recipe.apply', 'recipe.dispatch.ack', 'dcw.create', 'ops.manual'].every(a => lineActions.has(a))
    && byLine.some(r => !r.recipeId),
    `n=${byLine.length} noRecipe=${byLine.filter(r => !r.recipeId).length} actions=${[...lineActions].join(',')}`)
  ok('G5d', '按产线查询不含其他产线记录', !byLine.some(r => r.lineId === lineB), `lineB=${lineB}`)

  const byRecipe = data(await api('GET', `/api/workshop/ops-logs?lineId=${encodeURIComponent(lineA)}&recipeId=${encodeURIComponent(recipe)}&limit=500`, undefined, H()))?.logs ?? []
  ok('G5e', '按产线+配方过滤:全部命中该配方,含下发/回执/开停线/人工记录,排除无 recipe 事件',
    byRecipe.length > 0 && byRecipe.every(r => r.recipeId === recipe && r.scope === 'line')
    && ['recipe.apply', 'recipe.dispatch.ack', 'line.start', 'line.stop', 'ops.manual'].every(a => byRecipe.some(r => r.action === a))
    && !byRecipe.some(r => r.action === 'dcw.create' || r.action === 'line.update'),
    `n=${byRecipe.length} actions=${[...new Set(byRecipe.map(r => r.action))].join(',')}`)

  const from = new Date(Date.now() - 10 * 60_000).toISOString()
  const to = new Date(Date.now() + 10 * 60_000).toISOString()
  const byTime = data(await api('GET', `/api/workshop/ops-logs?lineId=${encodeURIComponent(lineA)}&from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}&limit=500`, undefined, H()))?.logs ?? []
  const inRange = byTime.every((r) => {
    const t = Date.parse(String(r.at))
    return Number.isFinite(t) && t >= Date.parse(from) && t <= Date.parse(to)
  })
  ok('G5f', '按时间区间过滤:结果全部落在 from~to 内且包含人工记录',
    byTime.length > 0 && inRange && byTime.some(r => r.action === 'ops.manual' && r.summary === manualSummary),
    `n=${byTime.length} inRange=${inRange}`)

  const badRange = await api('GET', `/api/workshop/ops-logs?from=${encodeURIComponent(to)}&to=${encodeURIComponent(from)}`, undefined, H())
  ok('G5g', '非法时间区间返回 400 且可行动', badRange.status === 400 && badRange.code === 'VALIDATION_ERROR' && /时间区间无效/.test(String(badRange.message)),
    `status=${badRange.status} code=${badRange.code} msg=${badRange.message}`)

  const allScope = data(await api('GET', '/api/workshop/ops-logs?scope=all&limit=500', undefined, H()))?.logs ?? []
  ok('G5h', 'scope=all 保留全局安全审计(登录/用户创建可见)',
    allScope.some(r => r.action === 'auth.login') && allScope.some(r => r.action === 'user.create'),
    `n=${allScope.length} authLogin=${allScope.filter(r => r.action === 'auth.login').length}`)

  const systemScope = data(await api('GET', '/api/workshop/ops-logs?scope=system&limit=500', undefined, H()))?.logs ?? []
  ok('G5i', 'scope=system 只返回系统域记录(登录/用户创建可见,产线事件不可见)',
    systemScope.length > 0 && systemScope.every(r => r.scope === 'system')
    && systemScope.some(r => r.action === 'auth.login') && !systemScope.some(r => r.action === 'line.start'),
    `n=${systemScope.length} actions=${[...new Set(systemScope.map(r => r.action))].slice(0, 10).join(',')}`)

  // ── G6 Agent 工具 ──
  const opsLineRecipe = await invoke(lead, 'ops_log', { line_id: lineA, recipe_id: recipe, minutes: 60, limit: 100 }, H())
  const opsText = invText(opsLineRecipe)
  ok('G6a', 'Agent ops_log(line+recipe) 回包带 scope/产线/配方归属与人工记录',
    !invErr(opsLineRecipe) && opsText.includes('scope=line') && opsText.includes(lineA) && opsText.includes(recipe) && opsText.includes(`日志线A-${TAG}`) && opsText.includes(manualSummary),
    `err=${invErr(opsLineRecipe)} text=${opsText.slice(0, 260)}`)
  console.log(`  ops_log sample:\n${opsText.split('\n').slice(0, 6).map(l => `    ${l}`).join('\n')}`)

  const opsRecipeTime = await invoke(lead, 'ops_log', { recipe_id: recipe, from, to, limit: 100 }, H())
  const opsRecipeTimeText = invText(opsRecipeTime)
  ok('G6b', 'Agent ops_log(只传 recipe_id + from/to) 自动收窄产线并命中',
    !invErr(opsRecipeTime) && opsRecipeTimeText.includes(lineA) && opsRecipeTimeText.includes(manualSummary) && /时间窗/.test(opsRecipeTimeText),
    `err=${invErr(opsRecipeTime)} text=${opsRecipeTimeText.slice(0, 260)}`)

  const recipeLog = await invoke(lead, 'recipe_log', { recipe_id: recipe, minutes: 60, limit: 100 }, H())
  const recipeLogText = invText(recipeLog)
  ok('G6c', 'Agent recipe_log(recipe_id) 命中创建/下发/回执且带 scope=line',
    !invErr(recipeLog) && /配方创建|配方下发|下发回执/.test(recipeLogText) && recipeLogText.includes(`日志配方-${TAG}`) && recipeLogText.includes('scope=line'),
    `err=${invErr(recipeLog)} text=${recipeLogText.slice(0, 260)}`)
  console.log(`  recipe_log sample:\n${recipeLogText.split('\n').slice(0, 5).map(l => `    ${l}`).join('\n')}`)

  const opsNode = await invoke(lead, 'ops_log', { line_id: lineA, node_id: node, minutes: 60, limit: 100 }, H())
  ok('G6d', 'Agent ops_log(node_id) 绑定面内可查',
    !invErr(opsNode) && invText(opsNode).includes(node.slice(0, 8)),
    `err=${invErr(opsNode)} text=${invText(opsNode).slice(0, 220)}`)

  const denied = await invoke(lead, 'ops_log', { line_id: lineB, minutes: 60 }, H())
  ok('G6e', '越权产线被拒且列出可读产线', invErr(denied) && /无权查询产线|不在你的可读范围/.test(invText(denied)),
    `err=${invErr(denied)} text=${invText(denied).slice(0, 220)}`)

  const badTime = await invoke(lead, 'ops_log', { line_id: lineA, from: to, to: from }, H())
  ok('G6f', 'Agent 非法时间区间被拒', invErr(badTime) && /时间区间无效/.test(invText(badTime)),
    `err=${invErr(badTime)} text=${invText(badTime).slice(0, 220)}`)

  const noLine = await invoke(lead, 'ops_log', { minutes: 60, limit: 100 }, H())
  ok('G6g', 'Agent 不传 line_id 时默认频道绑定产线', !invErr(noLine) && invText(noLine).includes(lineA) && invText(noLine).includes(manualSummary),
    `err=${invErr(noLine)} text=${invText(noLine).slice(0, 220)}`)

  const alias = await invoke(lead, 'line_log', { line_id: lineA, minutes: 60, limit: 100 }, H())
  const aliasText = invText(alias)
  ok('G6h', 'line_log 显式别名可用且回包与 ops_log 同口径', !invErr(alias) && aliasText.includes('scope=line') && aliasText.includes(lineA) && aliasText.includes(manualSummary),
    `err=${invErr(alias)} text=${aliasText.slice(0, 240)}`)

  const opsLineOnly = await invoke(lead, 'line_log', { line_id: lineA, minutes: 60, limit: 100 }, H())
  const opsLineOnlyText = invText(opsLineOnly)
  ok('G6i', 'Agent 按线查询包含无 recipe 的产线事件(dcw.create/line.update)',
    !invErr(opsLineOnly) && opsLineOnlyText.includes('dcw.create') && opsLineOnlyText.includes('line.update') && opsLineOnlyText.includes('配方=-'),
    `err=${invErr(opsLineOnly)} text=${opsLineOnlyText.slice(0, 320)}`)

  const opsByRecipe = await invoke(lead, 'line_log', { recipe_id: recipe, minutes: 60, limit: 100 }, H())
  const opsByRecipeText = invText(opsByRecipe)
  ok('G6j', 'Agent 按 recipe 查询排除无 recipe 事件', !invErr(opsByRecipe) && !opsByRecipeText.includes('dcw.create') && !opsByRecipeText.includes('line.update'),
    `err=${invErr(opsByRecipe)} text=${opsByRecipeText.slice(0, 280)}`)
}
catch (err) {
  ok('GX', '执行异常', false, err instanceof Error ? err.stack ?? err.message : String(err))
}
finally {
  try {
    spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true })
  }
  catch { /* 已退出 */ }
  const passed = results.filter(r => r.pass).length
  const failed = results.filter(r => !r.pass)
  console.log(`\n═══ 结论:${failed.length === 0 ? 'PASS' : 'FAIL'}(${passed}/${results.length})═══`)
  if (failed.length) {
    console.log('失败项:')
    for (const f of failed) console.log(`  ✖ [${f.id}] ${f.name} — ${f.detail}`)
  }
  process.exit(failed.length === 0 ? 0 : 1)
}
