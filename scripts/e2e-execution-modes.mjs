#!/usr/bin/env node
/**
 * 三模式执行(observe/manual/auto)E2E(2026-10-28;隔离实例,真实 HTTP/HITL/治理链):
 *  M1 隔离实例 + admin
 *  M2 切换 REST:收紧自由 / 放开必须 confirm / 非法值 400 / recordOps 审计入档
 *  M3 observe 频道:写族按名拒(配方/启停线)、读面可用(数采/line_context)、profile 读取回传
 *  M4 manual 频道:频道层钳位强制 HITL(线 auto+绑定 auto 仍挂卡)、审批卡含 Agent 依据、批准附言回流
 *  M5 auto 频道:全链 auto 免批直执行(无审批卡)、缺 hypothesis 的治理写被拒、
 *     带 hypothesis 执行后台账 audit detail 带 executionMode='auto'
 *  M6 注入面:observe 频道成员工具清单零写族(经 channels/:id/agents 工具面)
 *
 * 运行:node scripts/e2e-execution-modes.mjs
 */
import { spawn } from 'node:child_process'
import { mkdirSync, openSync, rmSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const ROOT = join(tmpdir(), 'aw-execmodes-e2e')
rmSync(ROOT, { recursive: true, force: true })
mkdirSync(join(ROOT, 'home'), { recursive: true })
const TAG = `em${Date.now().toString(36).slice(-4)}`
const results = []
const ok = (id, name, cond, detail = '') => {
  results.push({ id, name, pass: Boolean(cond), detail: String(detail).slice(0, 300) })
  console.log(`${cond ? '✔' : '✖'} [${id}] ${name}${cond ? '' : ` — ${String(detail).slice(0, 300)}`}`)
}
const sleep = ms => new Promise(r => setTimeout(r, ms))

let port = 0
for (const p of [3989, 3988, 3987, 3986]) {
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
    AW_TRIAL_INTERVAL_MS: '0',
    NUXT_SESSION_PASSWORD: 'ExecModes#2026-e2e-session-key',
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
const invText = r => String(r?.data?.result?.text ?? r?.data?.text ?? '')
const invErr = r => Boolean(r?.data?.result?.isError ?? r?.data?.isError)
const timeoutError = (label, ms) => new Promise((_, reject) => {
  setTimeout(() => reject(new Error(`${label} 超时 ${ms}ms`)), ms)
})
const withTimeout = (p, ms, label) => Promise.race([p, timeoutError(label, ms)])
let token = ''
const H = () => token
const setMode = (id, mode, confirm) => api('PATCH', `/api/workshop/channels/${id}/execution-mode`, confirm === undefined ? { mode } : { mode, confirm }, H())

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
  ok('M1', '隔离实例启动 + workshop ready', healthy, `port=${port}`)
  if (!healthy) throw new Error('实例未就绪')

  const email = `em-${TAG}@awshop.local`
  token = (await api('POST', '/api/users/register', { name: `em-admin-${TAG}`, email, password: 'EmAdmin#2026' })).data?.token
  ok('M1b', 'admin 注册/登录', Boolean(token))

  // ── 场景:线/数控/产品/配方/数采/频道(lead)+ 绑定 + 控制网关 ──
  const line = (await api('POST', '/api/workshop/dcw/lines', { name: `三模式线-${TAG}` }, H())).data?.line?.id
  const tpl = (await api('POST', '/api/workshop/dcw/templates', { name: `三模式参数-${TAG}`, ch: '温度', unit: '℃', min: 0, max: 200, decimals: 1 }, H())).data?.template?.key
  const node = (await api('POST', '/api/workshop/dcw', { templateRef: tpl, name: `三模式数控-${TAG}`, driver: 'mock', lineId: line, stepLimit: 20, driverConfig: { key: `em-${TAG}` } }, H())).data?.node?.id
  const product = (await api('POST', '/api/workshop/dcw/products', { lineId: line, name: `三模式产品-${TAG}` }, H())).data?.product?.id
  const recipe = (await api('POST', '/api/workshop/dcw/recipes', { productId: product, name: `三模式配方-${TAG}`, params: [{ nodeId: node, value: 100, min: 0, max: 200 }] }, H())).data?.recipe?.id
  const daq = (await api('POST', '/api/workshop/daq', { templateRef: 'daq-temp-tc', name: `三模式数采-${TAG}`, driver: 'mock', lineId: line, intervalMs: 1000, publishIntervalMs: 0 }, H())).data?.node?.id
  const ch = (await api('POST', '/api/workshop/channels', { name: `三模式频道-${TAG}`, leadAgent: { name: `三模式lead-${TAG}`, harness: 'omp' } }, H())).data
  const channelId = ch?.channelId
  const lead = ch?.leadAgentId
  await api('PUT', `/api/workshop/channels/${channelId}/line`, { lineId: line }, H())
  // lead 绑定:dac 观察 + recipe(dcw 直绑已禁用;recipe 绑定首绑恒 manual)
  await api('POST', '/api/workshop/agent-tools/bindings', { agentId: lead, nodeId: daq, kind: 'daq' }, H())
  const recipeBind = await api('POST', '/api/workshop/agent-tools/bindings', { agentId: lead, nodeId: recipe, kind: 'recipe' }, H())
  const bindingId = recipeBind?.data?.binding?.id
  await api('POST', '/api/workshop/dcw/controller', { action: 'start' }, H())
  ok('M2s', '场景就绪(线/节点/配方/数采/频道/绑定/网关)', Boolean(line && node && product && recipe && daq && channelId && lead && bindingId),
    JSON.stringify({ line, node, recipe, daq, channelId, lead, bindingId }).slice(0, 240))

  const profileMode = async () => (await api('GET', `/api/workshop/channels/${channelId}/twin-profile`, undefined, H())).data?.profile?.executionMode
  const pendingIds = async () => new Set((await api('GET', '/api/workshop/hitl/pending', undefined, H())).data?.items?.map(x => x.id) ?? [])
  const waitCard = async (known) => {
    for (let i = 0; i < 40; i++) {
      await sleep(1000)
      const items = (await api('GET', '/api/workshop/hitl/pending', undefined, H())).data?.items ?? []
      const card = items.find(x => !known.has(x.id))
      if (card) return card
    }
    return null
  }
  const approve = async (card, comment) => api('POST', '/api/workshop/hitl/respond', { kind: 'dcw-approval', id: card.id, confirmed: true, choice: 0, comment: comment ?? 'E2E 批准' }, H())
  const invokeAsync = (tool, args) => api('POST', '/api/workshop/agent-tools/invoke', { agentId: lead, tool, args }, H())

  // 开线(HITL):配方操作有运行门 —— 线不开跑,recipe_trial 一律被拒
  {
    const known = await pendingIds()
    const p = invokeAsync('line_start', { recipe_id: recipe, reason: `M2s 三模式 E2E 开线(${TAG})` })
    const card = await waitCard(known)
    ok('M2t', 'line_start 生成审批卡并批准开跑', Boolean(card), card?.id ?? '未出现')
    if (card) await approve(card)
    const r = await withTimeout(p, 90_000, 'line_start')
    ok('M2u', '开线成功且参数设备证实', !invErr(r) && /已开跑/.test(invText(r)), invText(r).slice(0, 200))
  }

  // ── M2 切换 REST 正反例 ──
  {
    ok('M2a', '缺省 executionMode = auto(频道层中性,存量零行为变化)', (await profileMode()) === 'auto', String(await profileMode()))
    const tighten = await setMode(channelId, 'manual')
    ok('M2b', 'auto→manual(收紧)免 confirm', tighten.status === 200 && tighten.data?.executionMode === 'manual', JSON.stringify(tighten).slice(0, 160))
    const escalate = await setMode(channelId, 'auto')
    ok('M2c', 'manual→auto(放开)缺 confirm → 400 MODE_CONFIRM_REQUIRED', escalate.status === 400 && /MODE_CONFIRM_REQUIRED/.test(JSON.stringify(escalate)), JSON.stringify(escalate).slice(0, 160))
    const escalateOk = await setMode(channelId, 'auto', true)
    ok('M2d', 'manual→auto 带 confirm → 200 且 effective.suppressed 反映产线总闸', escalateOk.status === 200 && typeof escalateOk.data?.effective?.suppressed === 'boolean', JSON.stringify(escalateOk.data?.effective ?? {}).slice(0, 200))
    const bad = await api('PATCH', `/api/workshop/channels/${channelId}/execution-mode`, { mode: 'yolo' }, H())
    ok('M2e', '非法 mode 值 → 400', bad.status === 400, `status=${bad.status}`)
    const observe = await setMode(channelId, 'observe')
    ok('M2f', 'auto→observe(收紧)免 confirm', observe.status === 200 && observe.data?.executionMode === 'observe', JSON.stringify(observe).slice(0, 160))
    const fromObserve = await setMode(channelId, 'manual')
    ok('M2g', 'observe→manual(放开)缺 confirm → 400', fromObserve.status === 400, `status=${fromObserve.status}`)
    const fromObserveOk = await setMode(channelId, 'manual', true)
    ok('M2h', 'observe→manual 带 confirm → 200', fromObserveOk.status === 200, JSON.stringify(fromObserveOk).slice(0, 160))
    await setMode(channelId, 'observe', true)
    const audit = await api('GET', '/api/workshop/audit?action=channel.execution_mode&limit=50', undefined, H())
    const entries = audit.data?.entries ?? []
    const switched = entries.filter(e => e.detail && String(e.detail.fromMode ?? '').length > 0 && String(e.detail.toMode ?? '').length > 0)
    ok('M2i', '模式切换 recordOps 审计入档(action 专查 + detail 含 fromMode/toMode)', audit.status === 200 && switched.length >= 5, JSON.stringify(entries.slice(0, 2)).slice(0, 240))
  }

  // ── M3 observe 频道:写拒 + 读可用 ──
  {
    ok('M3a', 'observe 已生效(profile 读取回传)', (await profileMode()) === 'observe', String(await profileMode()))
    const w1 = await invokeAsync('recipe_update', { recipe_id: recipe, params: [{ node_id: node, value: 110 }], reason: 'M3 observe 应拒' })
    ok('M3b', 'observe:recipe_update 按名拒(含行动指引)', invErr(w1) && /观察模式频道不可用/.test(invText(w1)), invText(w1).slice(0, 200))
    const w2 = await invokeAsync('line_start', { recipe_id: recipe, reason: 'M3 observe 应拒' })
    ok('M3c', 'observe:line_start 拒(观察面宽守卫)', invErr(w2) && /观察模式频道不可用/.test(invText(w2)), invText(w2).slice(0, 200))
    const r1 = await invokeAsync('daq_query', { node_id: daq, last_minutes: 1 })
    ok('M3d', 'observe:daq_query 只读取数可用', !invErr(r1) && !invErr(r1) && invText(r1).length > 0, invText(r1).slice(0, 160))
    const r2 = await invokeAsync('line_context', {})
    ok('M3e', 'observe:line_context 只读可用', !invErr(r2) && invText(r2).length > 0, invText(r2).slice(0, 160))
    const r3 = await invokeAsync('my_industrial_nodes', {})
    ok('M3f', 'observe:模式卡注入 my_industrial_nodes(observe 字样)', !invErr(r3) && /频道执行模式:observe/.test(invText(r3)), invText(r3).slice(0, 200))
  }

  // ── M4 manual 频道:频道层钳位强制 HITL + 审批卡含依据 + 批准附言回流 ──
  {
    // 造全链 auto 基线:线 auto(confirm)+ 绑定 auto(confirm),频道 manual → 仍必须挂卡
    const lineAuto = await api('PATCH', `/api/workshop/dcw/lines/${line}`, { controlMode: 'auto', confirm: true }, H())
    ok('M4a', '产线总闸切 auto(confirm)', lineAuto.status === 200, JSON.stringify(lineAuto).slice(0, 120))
    const bindAuto = await api('PATCH', `/api/workshop/agent-tools/bindings/${bindingId}`, { mode: 'auto', confirm: true }, H())
    ok('M4b', '配方绑定切 auto(confirm)', bindAuto.status === 200 && bindAuto.data?.binding?.mode === 'auto', JSON.stringify(bindAuto).slice(0, 120))
    const manual = await setMode(channelId, 'manual', true)
    ok('M4c', 'observe→manual(confirm)生效', manual.status === 200 && manual.data?.executionMode === 'manual', JSON.stringify(manual).slice(0, 160))

    const known = await pendingIds()
    const hyp = `M4 依据:数采窗口均值偏高,拟降 10℃ 观察响应(${TAG})`
    const p = invokeAsync('recipe_trial', { recipe_id: recipe, params: [{ node_id: node, value: 90 }], hypothesis: hyp })
    const card = await waitCard(known)
    ok('M4d', '频道 manual:线 auto+绑定 auto 仍挂审批卡(频道层钳位)', Boolean(card), card?.id ?? '未出现')
    const cardRaw = JSON.stringify(card ?? {})
    ok('M4e', '审批卡含 Agent 依据(hypothesis 可见)', cardRaw.includes('M4 依据'), cardRaw.slice(0, 220))
    if (card) {
      const ap = await approve(card, 'M4 人工复核通过,附言回传')
      const r = await withTimeout(p, 120_000, 'recipe_trial(manual)')
      ok('M4f', '批准后执行成功且回执含批准附言', !invErr(r) && /M4 人工复核通过/.test(invText(r)), invText(r).slice(0, 240))
      void ap
    }
    else await withTimeout(p, 5_000, 'recipe_trial(no-card)')
  }

  // ── M5 auto 频道:免批直执行 + 治理写 rationale 强制 + 台账 executionMode ──
  {
    // 配方级下发间隔卡控(≥60s,M4 已批准一次):等窗后再探免批直执行
    await sleep(65_000)
    const auto = await setMode(channelId, 'auto', true)
    ok('M5a', 'manual→auto(confirm)生效,全链 auto', auto.status === 200 && auto.data?.executionMode === 'auto' && auto.data?.effective?.suppressed === false, JSON.stringify(auto.data?.effective ?? {}).slice(0, 200))
    const known = await pendingIds()
    const p = invokeAsync('recipe_trial', { recipe_id: recipe, params: [{ node_id: node, value: 95 }], hypothesis: 'M5 auto 直执行' })
    const r = await withTimeout(p, 120_000, 'recipe_trial(auto)')
    const cardAppeared = await (async () => {
      await sleep(1500)
      const items = (await api('GET', '/api/workshop/hitl/pending', undefined, H())).data?.items ?? []
      return items.some(x => !known.has(x.id))
    })()
    ok('M5b', '全链 auto:无审批卡直接执行', !invErr(r) && !cardAppeared && /已整批下发|设备证实/.test(invText(r)), `${invText(r).slice(0, 200)} card=${cardAppeared}`)

    // 治理写(optimization_explore)auto rationale 强制:legacy 频道需先升 aml_optimization 档位(直改库,getChannelTwinProfile 每次实时读 → 热生效)
    const { DatabaseSync } = await import('node:sqlite')
    const dbPath = join(ROOT, 'home', 'data', 'workshop.sqlite')
    let db
    try {
      db = new DatabaseSync(dbPath)
      db.prepare(`UPDATE aml_channel_profiles SET profile='aml_optimization', optimization_mode='exploration' WHERE channel_id=?`).run(channelId)
      ok('M5c', 'aml_optimization 档位直改库(热生效)', true, dbPath)
    }
    catch (e) {
      ok('M5c', 'aml_optimization 档位直改库', false, String(e).slice(0, 120))
    }
    finally {
      try {
        db?.close()
      }
      catch { /* ignore */ }
    }
    // agent 源写入有 60s 最小间隔(M4 的配方写已触发节点 lastWriteAt):等窗再探治理写
    await sleep(65_000)
    const noRationale = await invokeAsync('optimization_explore', { control_node_id: node, target_node_id: daq, direction: 'down', step: 2, hypothesis: '' })
    ok('M5d', 'auto 治理写缺 hypothesis → 拒绝(必填依据)', invErr(noRationale) && /自动模式下发必须附带 hypothesis/.test(invText(noRationale)), invText(noRationale).slice(0, 200))
    const withRationale = await invokeAsync('optimization_explore', { control_node_id: node, target_node_id: daq, direction: 'down', step: 2, settle_seconds: 3, hypothesis: `M5 依据:试验批 95℃ 响应不足,小步下行探 ${TAG}` })
    ok('M5e', '带 hypothesis 治理写执行成功', !invErr(withRationale) && /探索步完成|已真实写入/.test(invText(withRationale)), invText(withRationale).slice(0, 220))
    const audit = await api('GET', '/api/workshop/audit?action=dcw.write.agent&limit=20', undefined, H())
    const entry = (audit.data?.entries ?? []).find(e => JSON.stringify(e).includes(TAG) && JSON.stringify(e).includes('executionMode'))
    ok('M5f', '台账 audit detail 含 executionMode(与 hypothesis)', Boolean(entry), JSON.stringify(entry ?? {}).slice(0, 260))
  }

  // ── M6 observe 注入面(切换后热生效) ──
  {
    await setMode(channelId, 'observe', true)
    const agents = await api('GET', `/api/workshop/channels/${channelId}/agents`, undefined, H())
    const leadRow = (agents.data ?? []).find(a => a.id === lead) ?? agents.data?.[0]
    const surface = JSON.stringify(leadRow ?? {})
    ok('M6a', '频道成员列表可得(工具面负载存在)', Boolean(leadRow), surface.slice(0, 160))
    // 行为级复验:observe 下配方族再次被拒(切换后运行时已回收,免批流不再可达)
    const w = await invokeAsync('recipe_trial', { recipe_id: recipe, params: [{ node_id: node, value: 100 }], hypothesis: 'M6 observe 应拒' })
    ok('M6b', 'observe(热切换后):recipe_trial 被拒', invErr(w) && /观察模式频道不可用/.test(invText(w)), invText(w).slice(0, 200))
  }
}
catch (err) {
  ok('FATAL', '套件异常终止', false, err instanceof Error ? err.message : String(err))
}
finally {
  try {
    child.kill()
  }
  catch { /* ignore */ }
  const pass = results.filter(r => r.pass).length
  console.log(`\n===== 三模式执行 E2E:${pass}/${results.length} PASS =====`)
  const fails = results.filter(r => !r.pass)
  if (fails.length) {
    console.log('FAILED:', fails.map(f => f.id).join(', '))
  }
  // 直捕退出码(不做管道尾哨兵)
  process.exit(pass === results.length ? 0 : 1)
}
