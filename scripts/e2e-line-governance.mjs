#!/usr/bin/env node
/**
 * 产线治理专项 E2E(2026-10-18;隔离实例,真实 HTTP/DCW/DAQ/HITL):
 *  L1 隔离实例 + admin
 *  L2 建线/数控节点/产品/配方/频道(lead) + 频道绑线
 *  L3 line_start:审批 → 开跑成功,参数全部设备证实
 *  L4 line_stop:审批 → 收窗,line_status 显示未运行
 *  L5 审批期换线:line_start 挂起后把频道换到 B 线 → 审批单取消,未开线
 *  L6 全部参数不可下发(节点停用):line_start 批准后如实报错并自动停线
 *  L7 DAQ 非法参数反馈 + 频道绑线只读导出
 *  L8 停线审批期间人工换批次:旧单被拒,新批次不被误停
 *  L9 开线审批期间配方改版:旧快照被拒
 *  L10 换线清理跨线绑定
 *  L11 Agent token 自证路径(频道成员直调工具)
 *  L12 DAQ 实采 + DCW 写/回读/单步/60s/量程
 *
 * 运行:node scripts/e2e-line-governance.mjs
 */
import { spawn, spawnSync } from 'node:child_process'
import { mkdirSync, openSync, rmSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import { DatabaseSync } from 'node:sqlite'

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const ROOT = join(tmpdir(), 'aw-line-mgmt-e2e')
rmSync(ROOT, { recursive: true, force: true })
mkdirSync(join(ROOT, 'home'), { recursive: true })
const TAG = `lm${Date.now().toString(36).slice(-4)}`
const results = []
const ok = (id, name, cond, detail = '') => {
  results.push({ id, name, pass: Boolean(cond), detail: String(detail).slice(0, 300) })
  console.log(`${cond ? '✔' : '✖'} [${id}] ${name}${cond ? '' : ` — ${String(detail).slice(0, 300)}`}`)
}
const sleep = ms => new Promise(r => setTimeout(r, ms))

let port = 0
for (const p of [3997, 3996, 3995, 3994]) {
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
    NUXT_SESSION_PASSWORD: 'LineMgmt#2026-e2e-session-key',
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
  ok('L1', '隔离实例启动 + workshop ready', healthy, `port=${port}`)
  if (!healthy) throw new Error('实例未就绪')

  const email = `lm-${TAG}@awshop.local`
  const token = (await api('POST', '/api/users/register', { name: `lm-admin-${TAG}`, email, password: 'LmAdmin#2026' })).data?.token
  ok('L1b', 'admin 注册/登录', Boolean(token))
  const H = () => token

  // ── L2 场景 ──
  const lineA = (await api('POST', '/api/workshop/dcw/lines', { name: `管理线A-${TAG}` }, H())).data?.line?.id
  const lineB = (await api('POST', '/api/workshop/dcw/lines', { name: `管理线B-${TAG}` }, H())).data?.line?.id
  const tpl = (await api('POST', '/api/workshop/dcw/templates', { name: `管理参数-${TAG}`, ch: '温度', unit: '℃', min: 0, max: 200, decimals: 1 }, H())).data?.template?.key
  const nodeA = (await api('POST', '/api/workshop/dcw', { templateRef: tpl, name: `管理数控-${TAG}`, driver: 'mock', lineId: lineA, stepLimit: 20, driverConfig: { key: `lm-${TAG}` } }, H())).data?.node?.id
  const nodeBad = (await api('POST', '/api/workshop/dcw', { templateRef: tpl, name: `停用数控-${TAG}`, driver: 'mock', lineId: lineA, stepLimit: 20, driverConfig: { key: `lm-bad-${TAG}` } }, H())).data?.node?.id
  const product = (await api('POST', '/api/workshop/dcw/products', { lineId: lineA, name: `管理产品-${TAG}` }, H())).data?.product?.id
  const recipeA = (await api('POST', '/api/workshop/dcw/recipes', { productId: product, name: `管理配方-${TAG}`, params: [{ nodeId: nodeA, value: 100, min: 0, max: 200 }] }, H())).data?.recipe?.id
  const recipeBad = (await api('POST', '/api/workshop/dcw/recipes', { productId: product, name: `停用配方-${TAG}`, params: [{ nodeId: nodeBad, value: 120, min: 0, max: 200 }] }, H())).data?.recipe?.id
  const ch = (await api('POST', '/api/workshop/channels', { name: `管理频道-${TAG}`, leadAgent: { name: `管理lead-${TAG}`, harness: 'omp' } }, H())).data
  const channelId = ch?.channelId
  const lead = ch?.leadAgentId
  await api('PUT', `/api/workshop/channels/${channelId}/line`, { lineId: lineA }, H())
  await api('POST', '/api/workshop/dcw/controller', { action: 'start' }, H())
  ok('L2', '建线/节点/产品/配方/频道(lead)/绑线', Boolean(lineA && lineB && nodeA && nodeBad && product && recipeA && recipeBad && channelId && lead),
    JSON.stringify({ lineA, lineB, nodeA, nodeBad, recipeA, recipeBad, channelId, lead }).slice(0, 240))

  const pendingIds = async () => new Set((await api('GET', '/api/workshop/hitl/pending', undefined, H())).data?.items?.map(x => x.id) ?? [])
  const waitCard = async (known, prefix) => {
    for (let i = 0; i < 40; i++) {
      await sleep(1000)
      const items = (await api('GET', '/api/workshop/hitl/pending', undefined, H())).data?.items ?? []
      const card = items.find(x => !known.has(x.id) && String(x.nodeId ?? '').startsWith(prefix))
      if (card) return card
    }
    return null
  }
  const approve = async card => api('POST', '/api/workshop/hitl/respond', { kind: 'dcw-approval', id: card.id, confirmed: true, choice: 0, comment: 'E2E 批准' }, H())
  const invokeAsync = (agentId, tool, args) => api('POST', '/api/workshop/agent-tools/invoke', { agentId, tool, args }, H())
  const lineState = async (lineId) => {
    const r = await api('POST', '/api/workshop/agent-tools/invoke', { agentId: lead, tool: 'line_status', args: { line_id: lineId } }, H())
    return { text: invText(r), isError: invErr(r) }
  }

  // ── L3 line_start 成功 ──
  {
    const known = await pendingIds()
    const p = invokeAsync(lead, 'line_start', { recipe_id: recipeA, reason: 'L3 管理 E2E 开线' })
    const card = await waitCard(known, `line-start:${lineA}`)
    ok('L3a', 'line_start 生成审批卡(line-start:*)', Boolean(card), card?.id ?? '未出现')
    if (card) await approve(card)
    const r = await withTimeout(p, 60_000, 'line_start')
    const txt = invText(r)
    ok('L3b', '批准后开线成功且参数设备证实', !invErr(r) && /已开跑/.test(txt) && /全部设备证实/.test(txt), txt.slice(0, 220))
    const st = await lineState(lineA)
    ok('L3c', 'line_status 显示运行中', !st.isError && /运行中/.test(st.text), st.text.slice(0, 160))
  }

  // ── L4 line_stop ──
  {
    const known = await pendingIds()
    const p = invokeAsync(lead, 'line_stop', { reason: 'L4 管理 E2E 停线' })
    const card = await waitCard(known, `line-stop:${lineA}`)
    ok('L4a', 'line_stop 生成审批卡(line-stop:*)', Boolean(card), card?.id ?? '未出现')
    if (card) await approve(card)
    const r = await withTimeout(p, 60_000, 'line_stop')
    ok('L4b', '批准后停线成功', !invErr(r) && /已停线/.test(invText(r)), invText(r).slice(0, 200))
    const st = await lineState(lineA)
    ok('L4c', '停线后 line_status 未运行', !st.isError && /未运行/.test(st.text), st.text.slice(0, 160))
  }

  // ── L5 审批期换线 → 审批取消,不开线 ──
  {
    const known = await pendingIds()
    const p = invokeAsync(lead, 'line_start', { recipe_id: recipeA, reason: 'L5 审批期换线' })
    const card = await waitCard(known, `line-start:${lineA}`)
    ok('L5a', '换线前审批卡已挂起', Boolean(card), card?.id ?? '未出现')
    await api('PUT', `/api/workshop/channels/${channelId}/line`, { lineId: lineB }, H())
    const r = await withTimeout(p, 60_000, 'line_start cancel')
    const txt = invText(r)
    ok('L5b', '换线后审批单取消且未开线', /绑定已解除|未获批准/.test(txt), txt.slice(0, 220))
    // 频道已换到 B 线,lead 的 line_status 对 A 线必然被拒 —— 用 admin 产线列表读运行态
    const lines = await api('GET', '/api/workshop/dcw/lines', undefined, H())
    const stA = (lines.data?.states ?? []).find(s => s.lineId === lineA)
    ok('L5c', 'A 线仍未运行', stA?.active === false, JSON.stringify(stA ?? {}).slice(0, 160))
    await api('PUT', `/api/workshop/channels/${channelId}/line`, { lineId: lineA }, H())
  }

  // ── L6 全部参数不可下发 → 如实报错并自动停线 ──
  {
    await api('PATCH', `/api/workshop/dcw/${nodeBad}`, { enabled: false }, H())
    const known = await pendingIds()
    const p = invokeAsync(lead, 'line_start', { recipe_id: recipeBad, reason: 'L6 全失败自动停线' })
    const card = await waitCard(known, `line-start:${lineA}`)
    ok('L6a', '不可下发配方仍生成审批卡(预检在批准后执行)', Boolean(card), card?.id ?? '未出现')
    if (card) await approve(card)
    const r = await withTimeout(p, 90_000, 'line_start all-failed')
    const txt = invText(r)
    console.log('    L6 raw:', JSON.stringify(r).slice(0, 500))
    ok('L6b', '全部参数失败 → isError + 已自动停线', invErr(r) && /全部 .*参数均未下发成功/.test(txt) && /已自动停线/.test(txt), txt.slice(0, 260))
    const st = await lineState(lineA)
    ok('L6c', '自动停线后 line_status 未运行', /未运行/.test(st.text), st.text.slice(0, 160))
  }

  // ── L7 DAQ 参数错误反馈 + 频道绑线导出面 ──
  {
    const daq = (await api('POST', '/api/workshop/daq', { templateRef: 'daq-temp-tc', name: `管理数采-${TAG}`, driver: 'mock', lineId: lineA, intervalMs: 1000, publishIntervalMs: 0 }, H())).data?.node?.id
    ok('L7a', '数采节点创建(不直接绑定,仅频道绑线可读)', Boolean(daq), `daq=${daq}`)
    const badLimit = await invokeAsync(lead, 'daq_query', { node_id: daq, limit: -5 })
    ok('L7b', 'daq_query limit=-5 → 参数错误', invErr(badLimit) && /limit 必须是正整数/.test(invText(badLimit)), invText(badLimit).slice(0, 160))
    const badWindow = await invokeAsync(lead, 'daq_query', { node_id: daq, from_ms: Date.now(), to_ms: Date.now() - 1000 })
    ok('L7c', 'daq_query from>=to → 时间窗错误', invErr(badWindow) && /时间窗非法/.test(invText(badWindow)), invText(badWindow).slice(0, 160))
    const badBucket = await invokeAsync(lead, 'daq_query', { node_id: daq, bucket_ms: -1 })
    ok('L7d', 'daq_query bucket_ms=-1 → 参数错误', invErr(badBucket) && /bucket_ms 必须是非负/.test(invText(badBucket)), invText(badBucket).slice(0, 160))
    const badKind = await invokeAsync(lead, 'daq_frames', { node_id: daq, kind: 'foo' })
    ok('L7e', 'daq_frames kind=foo → 参数错误', invErr(badKind) && /kind 只能是/.test(invText(badKind)), invText(badKind).slice(0, 160))
    // 未直接绑定 daq、仅频道绑线:导出应沿用只读扩权(而不是拒绝)
    const exp = await invokeAsync(lead, 'daq_export', { node_ids: [daq], last_minutes: 1 })
    ok('L7f', '频道绑线节点可只读导出(daq_export 授权同源)', !invErr(exp) && /daqexp-/.test(invText(exp)), invText(exp).slice(0, 200))
  }

  // ── L8 停线审批期间人工换批次 → 旧单不得误停新批次 ──
  {
    const known = await pendingIds()
    const pStart = invokeAsync(lead, 'line_start', { recipe_id: recipeA, reason: 'L8 预备开线' })
    const cStart = await waitCard(known, `line-start:${lineA}`)
    if (cStart) await approve(cStart)
    const start = await withTimeout(pStart, 60_000, 'L8 line_start')
    ok('L8a', '预备批次已开跑', !invErr(start) && /已开跑/.test(invText(start)), invText(start).slice(0, 160))

    const known2 = await pendingIds()
    const pStop = invokeAsync(lead, 'line_stop', { reason: 'L8 旧批次停线审批' })
    const cStop = await waitCard(known2, `line-stop:${lineA}`)
    ok('L8b', '停线审批卡已挂起', Boolean(cStop), cStop?.id ?? '未出现')
    // 审批挂起期间人工停线并重开新批次
    await api('POST', `/api/workshop/dcw/lines/${lineA}/stop`, undefined, H())
    const restart = await api('POST', `/api/workshop/dcw/lines/${lineA}/start`, { recipeId: recipeA }, H())
    ok('L8c', '人工停线后重开新批次', restart.status === 200 && Boolean(restart.data?.run?.id), JSON.stringify(restart.data?.run?.id ?? restart.message ?? '').slice(0, 100))
    if (cStop) await approve(cStop)
    const stop = await withTimeout(pStop, 60_000, 'L8 line_stop')
    ok('L8d', '旧停线审批被批次复核拒绝', invErr(stop) && /批次已变更/.test(invText(stop)), invText(stop).slice(0, 220))
    const lines = await api('GET', '/api/workshop/dcw/lines', undefined, H())
    const stNow = (lines.data?.states ?? []).find(s => s.lineId === lineA)
    ok('L8e', '新批次仍在运行(未被旧单误停)', stNow?.active === true, JSON.stringify(stNow ?? {}).slice(0, 160))
    await api('POST', `/api/workshop/dcw/lines/${lineA}/stop`, undefined, H())
  }

  // ── L9 开线审批期间配方被改版 → 批准后拒绝旧快照 ──
  {
    const known = await pendingIds()
    const p = invokeAsync(lead, 'line_start', { recipe_id: recipeA, reason: 'L9 配方改版复核' })
    const card = await waitCard(known, `line-start:${lineA}`)
    ok('L9a', '开线审批卡已挂起', Boolean(card), card?.id ?? '未出现')
    const patch = await api('PATCH', `/api/workshop/dcw/recipes/${recipeA}`, { params: [{ nodeId: nodeA, value: 110, min: 0, max: 200 }] }, H())
    ok('L9b', '审批期间配方改版成功', patch.status === 200 && Number(patch.data?.recipe?.version ?? 0) >= 2, JSON.stringify(patch.data?.recipe?.version ?? patch.message ?? '').slice(0, 80))
    if (card) await approve(card)
    const r = await withTimeout(p, 60_000, 'L9 line_start')
    ok('L9c', '旧配方快照批准后拒绝开线', invErr(r) && /审批期间已变更/.test(invText(r)), invText(r).slice(0, 240))
    const lines = await api('GET', '/api/workshop/dcw/lines', undefined, H())
    const stNow = (lines.data?.states ?? []).find(s => s.lineId === lineA)
    ok('L9d', '配方变更后产线未开跑', stNow?.active === false, JSON.stringify(stNow ?? {}).slice(0, 160))
  }

  // ── L10 换线清理跨线绑定(频道=单产线工作区不变量) ──
  {
    const daqB = (await api('POST', '/api/workshop/daq', { templateRef: 'daq-temp-tc', name: `B线数采-${TAG}`, driver: 'mock', lineId: lineB, intervalMs: 1000, publishIntervalMs: 0 }, H())).data?.node?.id
    await api('PUT', `/api/workshop/channels/${channelId}/line`, { lineId: null }, H())
    const bindB = await api('POST', '/api/workshop/agent-tools/bindings', { agentId: lead, nodeId: daqB, kind: 'daq', mode: 'auto' }, H())
    ok('L10a', '解绑线后可显式绑 B 线节点', bindB.status === 200, `status=${bindB.status} ${bindB.message ?? ''}`)
    await api('PUT', `/api/workshop/channels/${channelId}/line`, { lineId: lineA }, H())
    const qB = await invokeAsync(lead, 'daq_query', { node_id: daqB, last_minutes: 1 })
    ok('L10b', '换线到 A 后 B 线绑定被清理(查询被拒)', invErr(qB) && /引用校验|无权/.test(invText(qB)), invText(qB).slice(0, 200))
  }

  // ── L11 Agent token 自证路径:不经 admin user token,由频道成员执行工具 ──
  {
    const db = new DatabaseSync(join(ROOT, 'home', 'data', 'workshop.sqlite'))
    const row = db.prepare('SELECT token FROM channel_agents WHERE id = ?').get(lead)
    db.close()
    const agentToken = String(row?.token ?? '')
    ok('L11a', '读取频道成员 agent token', Boolean(agentToken), `len=${agentToken.length}`)
    const callAsAgent = async (tool, args) => {
      const r = await fetch(BASE + '/api/workshop/agent-tools/invoke', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-aw-agent-token': agentToken },
        body: JSON.stringify({ agentId: lead, tool, args }),
        signal: AbortSignal.timeout(120_000),
      })
      return { status: r.status, ...(await r.json().catch(() => ({}))) }
    }
    const daqA = (await api('POST', '/api/workshop/daq', { templateRef: 'daq-temp-tc', name: `Agent自证数采-${TAG}`, driver: 'mock', lineId: lineA, intervalMs: 1000, publishIntervalMs: 0 }, H())).data?.node?.id
    const q = await callAsAgent('daq_query', { node_id: daqA, last_minutes: 1 })
    ok('L11b', 'agent token 调用 daq_query 成功(频道绑线只读面)', !invErr(q) && /数采数据查询结果/.test(invText(q)), JSON.stringify(q).slice(0, 220))
    const badToken = await fetch(BASE + '/api/workshop/agent-tools/invoke', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-aw-agent-token': 'not-a-real-token' },
      body: JSON.stringify({ agentId: lead, tool: 'daq_query', args: { node_id: daqA } }),
      signal: AbortSignal.timeout(15_000),
    })
    ok('L11e', '错误 agent token 被拒(401/403)', badToken.status === 401 || badToken.status === 403, `status=${badToken.status}`)
    const known = await pendingIds()
    const p = callAsAgent('line_start', { recipe_id: recipeA, reason: 'L11 agent token 开线' })
    const card = await waitCard(known, `line-start:${lineA}`)
    ok('L11c', 'agent token 发起 line_start 并挂审批', Boolean(card), card?.id ?? '未出现')
    if (card) await approve(card)
    const start = await withTimeout(p, 60_000, 'L11 line_start')
    ok('L11d', 'agent token 经治理链开线成功', !invErr(start) && /已开跑/.test(invText(start)), invText(start).slice(0, 220))
    await api('POST', `/api/workshop/dcw/lines/${lineA}/stop`, undefined, H())
  }

  // ── L12 DAQ 实采 + DCW 写/回读/限界/节拍 全链路 ──
  {
    const nodeW = (await api('POST', '/api/workshop/dcw', { templateRef: tpl, name: `写控验证-${TAG}`, driver: 'mock', lineId: lineA, stepLimit: 20, driverConfig: { key: `lm-w-${TAG}` } }, H())).data?.node?.id
    const daqD = (await api('POST', '/api/workshop/daq', { templateRef: 'daq-temp-tc', name: `实采验证-${TAG}`, driver: 'mock', driverConfig: { base: 100, amp: 10, min: 0, max: 200 }, lineId: lineA, intervalMs: 1000, publishIntervalMs: 0 }, H())).data?.node?.id
    await api('POST', '/api/workshop/daq/controller', { action: 'start' }, H())
    const restart = await api('POST', `/api/workshop/dcw/lines/${lineA}/start`, { recipeId: recipeA }, H())
    ok('L12a', '产线开跑用于实采', restart.status === 200 && Boolean(restart.data?.run?.id), JSON.stringify(restart.data?.run?.id ?? restart.message ?? '').slice(0, 100))
    await sleep(7000)
    const dq = await invokeAsync(lead, 'daq_query', { node_id: daqD, last_minutes: 2, bucket_ms: 1000, limit: 50 })
    ok('L12b', 'DAQ 实采样本可查', !invErr(dq) && /样本 [1-9]/.test(invText(dq)), invText(dq).slice(0, 240))

    const w1 = await api('POST', `/api/workshop/dcw/${nodeW}/write`, { value: 110 }, H())
    const o1 = w1.data?.outcome
    ok('L12c', 'DCW 写入受理 + ACK 等级如实', w1.status === 200 && o1?.ok === true && ['transport-ack', 'readback-verified'].includes(o1?.ack), JSON.stringify(o1 ?? {}).slice(0, 200))
    const rd = await api('POST', `/api/workshop/dcw/${nodeW}/read`, undefined, H())
    ok('L12d', 'DCW 回读一致', rd.status === 200 && Number(rd.data?.read?.value) === 110, JSON.stringify(rd.data?.read ?? {}).slice(0, 160))
    const step = await api('POST', `/api/workshop/dcw/${nodeW}/write`, { value: 160 }, H())
    ok('L12e', '超单步限幅被拒(20)', step.status >= 400 && /单步|步长|STEP_LIMIT|步限/i.test(JSON.stringify(step)), JSON.stringify(step).slice(0, 220))
    const interval = await api('POST', `/api/workshop/dcw/${nodeW}/write`, { value: 115 }, H())
    ok('L12f', '60s 写间隔被拒', interval.status >= 400 && /60s|间隔|WRITE_INTERVAL|频繁/i.test(JSON.stringify(interval)), JSON.stringify(interval).slice(0, 220))
    const limit = await api('POST', `/api/workshop/dcw/${nodeW}/write`, { value: 999 }, H())
    ok('L12g', '越节点量程被拒', limit.status >= 400 && /量程|限界|VALIDATION|范围/i.test(JSON.stringify(limit)), JSON.stringify(limit).slice(0, 220))
    await api('POST', `/api/workshop/dcw/lines/${lineA}/stop`, undefined, H())
  }
}
catch (err) {
  ok('LX', '执行异常', false, err instanceof Error ? err.stack ?? err.message : String(err))
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
