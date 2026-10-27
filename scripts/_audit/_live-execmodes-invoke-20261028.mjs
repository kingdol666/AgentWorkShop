#!/usr/bin/env node
/**
 * 三模式执行 · 产线实测补充轮(invoke 驱动;2026-10-28 US-210):
 *  LLM 会话被外部 omp key 3h 预算墙阻断(机器共享 key,并行会话占用)——本脚本以
 *  agent-tools/invoke(真实 harness 工具链回程)在**运行中的实例 + 真实 Modbus 模拟器**
 *  上补齐三模式的物理级证据:
 *   V1 模拟器直读基线(绕过平台,MBAP 手写帧)
 *   V2 observe:真实数采可读 + 写按名拒(物理零写)
 *   V3 manual:trial→HITL 卡(含依据)→人工批准(附言)→回读证实→模拟器直读=新值
 *   V4 auto:三层 auto→免批直执行(无卡)→journal 锚点→模拟器直读=新值
 * 前置:node scripts/_audit/_live-execmodes-20261028.mjs 已跑(3990 实例存活,失败不杀)。
 * 运行:node scripts/_audit/_live-execmodes-invoke-20261028.mjs
 */
import { spawn } from 'node:child_process'
import { mkdirSync, openSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import net from 'node:net'

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const EVID = join(REPO, 'docs', 'audit', 'evidence', '2026-10-28-execmodes', 'live')
mkdirSync(EVID, { recursive: true })
const BASE = 'http://127.0.0.1:3989'
const ROOT = join(tmpdir(), 'aw-execmodes-invoke')
rmSync(join(ROOT, 'home'), { recursive: true, force: true })
mkdirSync(join(ROOT, 'home'), { recursive: true })
const TAG = `iv${Date.now().toString(36).slice(-4)}`
const sleep = ms => new Promise(r => setTimeout(r, ms))
const log = (s) => { console.log(`[${new Date().toISOString().slice(11, 19)}] ${s}`) }

// ── 自起隔离实例(真实模拟器前置探活)──
const simOk = await fetch('http://127.0.0.1:4020/api/nodes', { signal: AbortSignal.timeout(2500) }).then(r => r.ok).catch(() => false)
if (!simOk) {
  console.log('模拟器 4020 离线 —— 先 node scripts/_audit/_detached-nodesim-20261028.mjs --port 4020')
  process.exit(1)
}
const logFd = openSync(join(ROOT, 'dev.log'), 'a')
// 实例随脚本会话存活(实测完成后由端口清理;进程句柄故意不持有)
spawn(process.execPath, [join(REPO, 'bin', 'aw.mjs'), 'dev', '--port', '3989'], {
  cwd: REPO,
  env: { ...process.env, AW_MODE: 'home', AW_HOME: join(ROOT, 'home'), AW_RATE_LIMIT_OFF: '1', AW_TRIAL_INTERVAL_MS: '0', NUXT_SESSION_PASSWORD: 'InvokeExecModes#2026-session-key', NO_PROXY: '127.0.0.1,localhost' },
  stdio: ['ignore', logFd, logFd],
  windowsHide: true,
})

// ── 注册 admin ──
let ready = false
for (let i = 0; i < 90; i++) {
  await sleep(2000)
  try {
    const h = await fetch(`${BASE}/api/health`, { signal: AbortSignal.timeout(3000) }).then(r => r.json()).catch(() => null)
    if (h?.data?.status === 'ok' && h?.data?.workshop === 'ready') { ready = true; break }
  }
  catch { /* 未就绪 */ }
}
if (!ready) {
  log('实例未就绪')
  process.exit(1)
}
const reg = await fetch(`${BASE}/api/users/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: `iv-admin-${TAG}`, email: `iv-${TAG}@awshop.local`, password: 'Live#2026Exec' }) }).then(r => r.json())
const H = () => reg.data.token
log(`实例 3989 就绪,admin OK(${TAG})`)

const api = async (method, path, body, timeoutMs = 180_000) => {
  // 兼容旧调用形参:第 4 参可能传的是 token(H())——非数字视为缺省超时
  const timeout = typeof timeoutMs === 'number' ? timeoutMs : 180_000
  const res = await fetch(BASE + path, { method, headers: { 'content-type': 'application/json', 'authorization': `Bearer ${H()}` }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(timeout) })
  let json = null
  try { json = await res.json() } catch { /* 非 JSON */ }
  return { status: res.status, ...json }
}
const invText = r => String(r?.data?.result?.text ?? r?.data?.text ?? '')
const invErr = r => Boolean(r?.data?.result?.isError ?? r?.data?.isError)

/** Modbus TCP 直读(绕过平台;float32 BE @addr) */
function modbusRead(addr, qty = 2) {
  return new Promise((resolveP, rejectP) => {
    const s = net.connect(16052, '127.0.0.1')
    s.setTimeout(3000)
    s.on('connect', () => s.write(Buffer.from([0, 1, 0, 0, 0, 6, 1, 3, addr >> 8, addr & 0xFF, qty >> 8, qty & 0xFF])))
    s.on('data', (d) => {
      s.end()
      if (d.length >= 11) resolveP(d.readFloatBE(9))
      else rejectP(new Error(`短回包 ${d.toString('hex')}`))
    })
    s.on('error', rejectP)
    s.on('timeout', () => { s.destroy(); rejectP(new Error('timeout')) })
  })
}

try {
  // ── 场景(自建,daq 显式量程覆盖真实熔温)──
  const line = (await api('POST', '/api/workshop/dcw/lines', { name: `invoke实测线-${TAG}` }, H())).data?.line?.id
  const spNode = (await api('POST', '/api/workshop/dcw', {
    templateRef: 'dcw-temp-sp', name: `一段桶温SP-${TAG}`, driver: 'modbus-tcp', lineId: line,
    min: 160, max: 300, stepLimit: 2.8,
    driverConfig: { host: '127.0.0.1', port: 16052, unitId: 1, register: 40021, registerType: 'holding', dataType: 'float32', byteOrder: 'big' },
  }, H())).data?.node?.id
  const pvNode = (await api('POST', '/api/workshop/daq', {
    templateRef: 'daq-temp-tc', name: `熔温PV-${TAG}`, driver: 'modbus-tcp', lineId: line, intervalMs: 2000, publishIntervalMs: 0,
    min: 100, max: 400,
    driverConfig: { host: '127.0.0.1', port: 16052, unitId: 1, register: 40001, registerType: 'holding', dataType: 'float32', byteOrder: 'big' },
  }, H())).data?.node?.id
  const product = (await api('POST', '/api/workshop/dcw/products', { lineId: line, name: `面板PP-${TAG}` }, H())).data?.product?.id
  const recipe = (await api('POST', '/api/workshop/dcw/recipes', { productId: product, name: `注塑标准-${TAG}`, params: [{ nodeId: spNode, value: 240, min: 160, max: 300 }] }, H())).data?.recipe?.id
  await api('POST', '/api/workshop/dcw/controller', { action: 'start' }, H())
  await api('POST', '/api/workshop/daq/controller', { action: 'start' }, H())
  const ch = (await api('POST', '/api/workshop/channels', { name: `invoke实测频道-${TAG}`, leadAgent: { name: `invoke-lead-${TAG}`, harness: 'omp' } }, H())).data
  await api('PUT', `/api/workshop/channels/${ch.channelId}/line`, { lineId: line }, H())
  await api('POST', `/api/workshop/channels/${ch.channelId}/activate`, {}, H())
  await api('POST', '/api/workshop/agent-tools/bindings', { agentId: ch.leadAgentId, nodeId: pvNode, kind: 'daq' }, H())
  const rb = await api('POST', '/api/workshop/agent-tools/bindings', { agentId: ch.leadAgentId, nodeId: recipe, kind: 'recipe' }, H())
  const bindingId = rb?.data?.binding?.id
  const invoke = (tool, args) => api('POST', '/api/workshop/agent-tools/invoke', { agentId: ch.leadAgentId, tool, args }, H())
  log(`场景 OK line=${line} sp=${spNode} pv=${pvNode} recipe=${recipe} channel=${ch.channelId}`)

  // 开线(HITL):数采按产线活动批次门控 —— 线不开跑,DAQ 永远 offline
  {
    const known = new Set((await api('GET', '/api/workshop/hitl/pending', undefined, H())).data?.items?.map(x => x.id) ?? [])
    const p = invoke('line_start', { recipe_id: recipe, reason: `V0 invoke 实测开线(${TAG})` })
    let card = null
    for (let i = 0; i < 40 && !card; i++) {
      await sleep(1000)
      card = ((await api('GET', '/api/workshop/hitl/pending', undefined, H())).data?.items ?? []).find(x => !known.has(x.id))
    }
    if (card) await api('POST', '/api/workshop/hitl/respond', { kind: 'dcw-approval', id: card.id, confirmed: true, choice: 0, comment: '验收员批准开线' }, H())
    const r = await p
    log(`V0 开线:${/已开跑/.test(invText(r)) ? '成功且参数设备证实' : `失败:${invText(r).slice(0, 110)}`}`)
  }

  // V1 模拟器直读基线
  const spBefore = await modbusRead(40021 - 40001)
  const pvDirect = await modbusRead(0)
  log(`V1 模拟器直读:SP@40021=${spBefore.toFixed(2)}℃ PV@40001=${pvDirect.toFixed(2)}℃(绕过平台)`)

  // V2 observe:真实数采 + 写拒
  await api('PATCH', `/api/workshop/channels/${ch.channelId}/execution-mode`, { mode: 'observe' }, H())
  let pvPoints = 0
  for (let i = 0; i < 25; i++) {
    await sleep(3000)
    const q = await api('GET', `/api/workshop/daq/query?node_ids=${pvNode}&last_minutes=1`, undefined, H())
    pvPoints = (q.data?.series ?? []).reduce((n, s) => n + (s.points?.length ?? 0), 0)
    if (pvPoints > 0) break
  }
  log(`V2 observe:真实数采 ${pvPoints} 点入库(量程修复后)=${pvPoints > 0 ? '通过' : '仍失败'}`)
  const w = await invoke('recipe_trial', { recipe_id: recipe, params: [{ node_id: spNode, value: 238 }], hypothesis: 'V2 观察档应拒' })
  log(`V2 observe:recipe_trial ${invErr(w) ? '被拒(物理零写)' : '异常放行'} — ${invText(w).slice(0, 70)}`)
  writeFileSync(join(EVID, `invoke-V2-observe-${TAG}.md`), `# V2 观察档(${TAG})\n\n数采点数:${pvPoints}\n\n写拒绝回执:\n\n${invText(w)}\n`)

  // V3 manual:HITL 批准 → 物理证实
  await api('PATCH', `/api/workshop/channels/${ch.channelId}/execution-mode`, { mode: 'manual', confirm: true }, H())
  const pendingBefore = new Set((await api('GET', '/api/workshop/hitl/pending', undefined, H())).data?.items?.map(x => x.id) ?? [])
  const trialP = invoke('recipe_trial', { recipe_id: recipe, params: [{ node_id: spNode, value: 238 }], hypothesis: `V3 依据:熔温 ${pvDirect.toFixed(1)}℃ 高于目标带,SP 240→238 小步下探(${TAG})` })
  let card = null
  for (let i = 0; i < 40 && !card; i++) {
    await sleep(1000)
    card = ((await api('GET', '/api/workshop/hitl/pending', undefined, H())).data?.items ?? []).find(x => !pendingBefore.has(x.id))
  }
  log(`V3 manual:HITL 卡=${card ? card.id : '未出现'};卡含依据=${card && JSON.stringify(card).includes('V3 依据') ? '是' : '否'}`)
  writeFileSync(join(EVID, `invoke-V3-card-${TAG}.json`), JSON.stringify(card, null, 2))
  if (card) {
    await api('POST', '/api/workshop/hitl/respond', { kind: 'dcw-approval', id: card.id, confirmed: true, choice: 0, comment: '验收员批准:238℃ 合规,观察响应' }, H())
    const r = await trialP
    log(`V3 manual:批准后执行=${invErr(r) ? '失败' : '成功'} — ${invText(r).slice(0, 110)}`)
    writeFileSync(join(EVID, `invoke-V3-reply-${TAG}.md`), `# V3 手动档回执(${TAG})\n\n${invText(r)}\n`)
  }
  await sleep(4000)
  const spAfterManual = await modbusRead(40021 - 40001)
  log(`V3 manual:模拟器直读 SP=${spAfterManual.toFixed(2)}℃(期望 238)=${Math.abs(spAfterManual - 238) < 0.5 ? '物理证实✓' : '未达'}`)

  // V4 auto:三层 auto → 免批直执行
  await api('PATCH', `/api/workshop/dcw/lines/${line}`, { controlMode: 'auto', confirm: true }, H())
  await api('PATCH', `/api/workshop/agent-tools/bindings/${bindingId}`, { mode: 'auto', confirm: true }, H())
  await api('PATCH', `/api/workshop/channels/${ch.channelId}/execution-mode`, { mode: 'auto', confirm: true }, H())
  await sleep(65_000) // 配方级下发间隔 ≥60s
  const pendingBefore2 = new Set((await api('GET', '/api/workshop/hitl/pending', undefined, H())).data?.items?.map(x => x.id) ?? [])
  const noRationale = await invoke('optimization_explore', { control_node_id: spNode, target_node_id: pvNode, direction: 'down', step: 1, hypothesis: '' }).catch(e => ({ data: { result: { text: String(e), isError: true } } }))
  log(`V4 auto:缺依据治理写=${invErr(noRationale) ? '拒绝(必填依据)' : '异常放行'} — ${invText(noRationale).slice(0, 80)}`)
  const trial4 = await invoke('recipe_trial', { recipe_id: recipe, params: [{ node_id: spNode, value: 236 }], hypothesis: `V4 依据:238℃ 响应良好,继续向窗口中值靠拢(${TAG})` })
  await sleep(2000)
  const newCards = ((await api('GET', '/api/workshop/hitl/pending', undefined, H())).data?.items ?? []).filter(x => !pendingBefore2.has(x.id))
  log(`V4 auto:免批直执行=${invErr(trial4) ? `失败:${invText(trial4).slice(0, 80)}` : '成功'};审批卡出现=${newCards.length ? '异常' : '无(免批确认)'}`)
  await sleep(4000)
  const spAfterAuto = await modbusRead(40021 - 40001)
  const j = await api('GET', `/api/workshop/dcw/journal?lineId=${line}&limit=10`, undefined, H())
  log(`V4 auto:模拟器直读 SP=${spAfterAuto.toFixed(2)}℃(期望 236)=${Math.abs(spAfterAuto - 236) < 0.5 ? '物理证实✓' : '未达'};journal 含 236=${JSON.stringify(j.data?.anchors ?? []).includes('236') ? '是' : '否'}`)

  writeFileSync(join(EVID, `invoke-summary-${TAG}.json`), JSON.stringify({
    tag: TAG, line, spNode, pvNode, recipe, channelId: ch.channelId,
    v1: { spBefore, pvDirect },
    v2: { pvPoints, observeRejected: invErr(w) },
    v3: { card: !!card, spAfterManual },
    v4: { autoExecuted: !invErr(trial4), cards: newCards.length, spAfterAuto, noRationaleRejected: invErr(noRationale) },
  }, null, 2))
  const pass = pvPoints > 0 && invErr(w) && !!card && Math.abs(spAfterManual - 238) < 0.5 && !invErr(trial4) && newCards.length === 0 && Math.abs(spAfterAuto - 236) < 0.5 && invErr(noRationale)
  log(`=== invoke 驱动产线实测:${pass ? '全部通过' : '存在失败项(见上)'} ===`)
  process.exit(pass ? 0 : 1)
}
catch (err) {
  log(`FATAL ${err instanceof Error ? err.message : String(err)}`)
  process.exit(1)
}
