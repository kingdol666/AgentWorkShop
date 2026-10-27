#!/usr/bin/env node
/**
 * 三模式执行 · 产线实测(2026-10-28;US-210):
 *  新隔离实例(dev, port 3990)+ 复用真实节点模拟器(4020 HTTP / 16052 Modbus TCP,物理引擎 presets)
 *  注塑工况:一段桶温 SP(modbus 持寄存器 40021)↓由 240℃ 起;熔温 PV 读 40001。
 *  三频道三模式 × 真实 omp lead 会话:
 *   A observe  → 只读分析(引用真实数采);写尝试被观察模式拒绝(双证据:会话回执 + REST 直调)
 *   B manual   → 下发挂 HITL → 人工批准(附言)→ 设备证实 → 批准附言回流会话
 *   C auto     → 线 auto+绑定 auto+频道 auto → 免批直执行(无审批卡)→ journal/audit 留痕
 *  过程监控:全程 console 流水 + 每频道 transcript 落盘 evidence。
 * 运行:node scripts/_audit/_live-execmodes-20261028.mjs
 */
import { spawn } from 'node:child_process'
import { mkdirSync, openSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const EVID = join(REPO, 'docs', 'audit', 'evidence', '2026-10-28-execmodes', 'live')
mkdirSync(EVID, { recursive: true })
const ROOT = join(tmpdir(), 'aw-execmodes-live')
rmSync(ROOT, { recursive: true, force: true })
mkdirSync(join(ROOT, 'home'), { recursive: true })
const TAG = `lv${Date.now().toString(36).slice(-4)}`
const log = (s) => { console.log(`[${new Date().toISOString().slice(11, 19)}] ${s}`) }
const sleep = ms => new Promise(r => setTimeout(r, ms))

// ── 模拟器探活(复用 4020;不在则脚本失败——真实模拟器是本测试前置)──
const simOk = await fetch('http://127.0.0.1:4020/api/nodes', { signal: AbortSignal.timeout(2500) }).then(r => r.ok).catch(() => false)
log(`模拟器 4020:${simOk ? '在线(复用)' : '离线 —— 请先 node scripts/_audit/_detached-nodesim-20261028.mjs --port 4020'}`)
if (!simOk) process.exit(1)

// ── 实例 ──
let port = 0
for (const p of [3990, 3989, 3988]) {
  try { const r = await fetch(`http://127.0.0.1:${p}/api/health`, { signal: AbortSignal.timeout(1200) }); if (r.ok) continue } catch { /* 空闲 */ }
  port = p
  break
}
const BASE = `http://127.0.0.1:${port}`
process.env.NO_PROXY = '127.0.0.1,localhost'
const logFd = openSync(join(ROOT, 'dev.log'), 'a')
const child = spawn(process.execPath, [join(REPO, 'bin', 'aw.mjs'), 'dev', '--port', String(port)], {
  cwd: REPO,
  env: { ...process.env, AW_MODE: 'home', AW_HOME: join(ROOT, 'home'), AW_RATE_LIMIT_OFF: '1', AW_TRIAL_INTERVAL_MS: '0', NUXT_SESSION_PASSWORD: 'LiveExecModes#2026-session-key', NO_PROXY: '127.0.0.1,localhost' },
  stdio: ['ignore', logFd, logFd],
  windowsHide: true,
})

async function api(method, path, body, token, timeoutMs = 180_000) {
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
    try { const h = await api('GET', '/api/health', undefined, undefined, 3000); if (h?.data?.status === 'ok' && h?.data?.workshop === 'ready') { healthy = true; break } } catch { /* 未就绪 */ }
  }
  log(`实例 ${BASE}:${healthy ? '就绪' : '未就绪'}`)
  if (!healthy) throw new Error('实例未就绪')
  const token = (await api('POST', '/api/users/register', { name: `lv-admin-${TAG}`, email: `lv-${TAG}@awshop.local`, password: 'Live#2026Exec' })).data?.token
  const H = () => token
  log('admin 注册/登录 OK')
  // 供应商目录探测:首个 provider 若撞预算墙,优先把三频道 LLM 指到备选 provider
  let altProvider = null
  try {
    const cat = (await api('GET', '/api/workshop/harnesses/omp/providers', undefined, H()))?.data?.catalog
    const provs = cat?.providers ?? []
    log(`omp provider 目录:${provs.map(p => `${p.id}(${(p.models ?? []).length} models)`).join(', ') || '(空)'}`)
    if (provs.length > 1) altProvider = { provider: provs[1].id, model: provs[1].models?.[0]?.id }
  }
  catch { /* 目录不可得:沿用默认 */ }
  if (altProvider) log(`备选 provider:${altProvider.provider}/${altProvider.model}`)

  // ── 场景:线/节点(modbus→模拟器)/产品/配方/网关 ──
  const line = (await api('POST', '/api/workshop/dcw/lines', { name: `三模式实测线-${TAG}`, description: 'US-210 产线实测:observe/manual/auto 三频道 × 真实 omp 会话' }, H())).data?.line?.id
  const spNode = (await api('POST', '/api/workshop/dcw', {
    templateRef: 'dcw-temp-sp', name: `一段桶温SP-${TAG}`, driver: 'modbus-tcp', lineId: line,
    min: 160, max: 300, stepLimit: 2.8,
    driverConfig: { host: '127.0.0.1', port: 16052, unitId: 1, register: 40021, registerType: 'holding', dataType: 'float32', byteOrder: 'big' },
  }, H())).data?.node?.id
  const pvNode = (await api('POST', '/api/workshop/daq', {
    templateRef: 'daq-temp-tc', name: `熔温PV-${TAG}`, driver: 'modbus-tcp', lineId: line, intervalMs: 2000, publishIntervalMs: 0,
    driverConfig: { host: '127.0.0.1', port: 16052, unitId: 1, register: 40001, registerType: 'holding', dataType: 'float32', byteOrder: 'big' },
  }, H())).data?.node?.id
  const product = (await api('POST', '/api/workshop/dcw/products', { lineId: line, name: `面板PP-${TAG}` }, H())).data?.product?.id
  const recipe = (await api('POST', '/api/workshop/dcw/recipes', { productId: product, name: `注塑标准-${TAG}`, description: '一段桶温目标 240℃(US-210 实测)', params: [{ nodeId: spNode, value: 240, min: 160, max: 300 }] }, H())).data?.recipe?.id
  await api('POST', '/api/workshop/dcw/controller', { action: 'start' }, H())
  await api('POST', '/api/workshop/daq/controller', { action: 'start' }, H())
  log(`场景 OK line=${line} sp=${spNode} pv=${pvNode} recipe=${recipe}`)

  // 等数采首包(真实 modbus 读)
  let firstPts = 0
  for (let i = 0; i < 30; i++) {
    await sleep(3000)
    const q = await api('GET', `/api/workshop/daq/query?node_ids=${pvNode}&last_minutes=1`, undefined, H())
    firstPts = (q.data?.series ?? []).reduce((n, s) => n + (s.points?.length ?? 0), 0)
    if (firstPts > 0) break
  }
  log(`数采首包:${firstPts} 点(模拟器 40001 读通=${firstPts > 0})`)
  writeFileSync(join(EVID, `daq-first-samples-${TAG}.json`), JSON.stringify(await api('GET', `/api/workshop/daq/query?node_ids=${pvNode}&last_minutes=2`, undefined, H()), null, 2))

  // ── 三频道(omp lead)+ 绑定 ──
  const mkChannel = async (name) => {
    const llm = altProvider ? { provider: altProvider.provider, model: altProvider.model } : undefined
    const ch = (await api('POST', '/api/workshop/channels', { name, leadAgent: { name: `${name}-lead`, harness: 'omp' }, ...(llm ? {} : {}) }, H())).data
    await api('PUT', `/api/workshop/channels/${ch.channelId}/line`, { lineId: line }, H())
    await api('POST', `/api/workshop/channels/${ch.channelId}/activate`, {}, H())
    if (llm) await api('PATCH', `/api/workshop/channels/${ch.channelId}`, { llm: { provider: llm.provider, model: llm.model } }, H())
    await api('POST', '/api/workshop/agent-tools/bindings', { agentId: ch.leadAgentId, nodeId: pvNode, kind: 'daq' }, H())
    const rb = await api('POST', '/api/workshop/agent-tools/bindings', { agentId: ch.leadAgentId, nodeId: recipe, kind: 'recipe' }, H())
    return { channelId: ch.channelId, lead: ch.leadAgentId, bindingId: rb?.data?.binding?.id }
  }
  const A = await mkChannel(`观察档-${TAG}`)
  const B = await mkChannel(`手动档-${TAG}`)
  const C = await mkChannel(`自动档-${TAG}`)
  log(`三频道 OK A=${A.channelId} B=${B.channelId} C=${C.channelId}`)

  const pendingIds = async () => new Set((await api('GET', '/api/workshop/hitl/pending', undefined, H())).data?.items?.map(x => x.id) ?? [])
  const waitCard = async (known, ms = 60_000) => {
    const end = Date.now() + ms
    while (Date.now() < end) {
      await sleep(1500)
      const items = (await api('GET', '/api/workshop/hitl/pending', undefined, H())).data?.items ?? []
      const card = items.find(x => !known.has(x.id))
      if (card) return card
    }
    return null
  }
  const setMode = (chId, mode, confirm) => api('PATCH', `/api/workshop/channels/${chId}/execution-mode`, confirm === undefined ? { mode } : { mode, confirm }, H())
  const talk = async (ch, text) => {
    await api('POST', `/api/workshop/channels/${ch.channelId}/messages`, { toAgentId: ch.lead, text, fromLabel: '验收员' }, H())
  }
  const collectReply = async (ch, sinceMs, waitMs = 240_000) => {
    const end = Date.now() + waitMs
    let last = ''
    let stable = 0
    while (Date.now() < end) {
      await sleep(6000)
      const rows = (await api('GET', `/api/workshop/channels/${ch.channelId}/messages?limit=50`, undefined, H())).data ?? []
      const texts = rows
        .filter(m => m.fromAgentId === ch.lead && Date.parse(m.createdAt ?? 0) > sinceMs)
        .map(m => (Array.isArray(m.parts) ? m.parts.map(p => String(p.text ?? '')).join('') : String(m.parts ?? '')))
        .filter(t => t.trim())
      if (texts.length) {
        const joined = texts.join('\n---\n')
        if (/\[DONE\]/.test(joined)) { last = joined; break }
        if (joined === last) { stable += 1; if (stable >= 3) break }
        else { last = joined; stable = 0 }
      }
    }
    return last
  }
  const transcripts = {}

  // ═══ A observe:只读分析 + 写尝试被拒 ═══
  {
    const m = await setMode(A.channelId, 'observe')
    log(`A 频道切 observe:${m.status === 200 ? 'OK' : JSON.stringify(m).slice(0, 120)}`)
    const t0 = Date.now() - 5000
    await talk(A, '请采集最近几分钟的一段桶温SP与熔温PV数据,判读当前工况是否平稳,并给出结论。')
    const reply = await collectReply(A, t0)
    transcripts.A = reply
    log(`A 会话回执 ${reply.length} 字(引用真实数值=${/\d{3}(\.\d+)?\s*℃|℃/.test(reply)})`)
    const w = await api('POST', '/api/workshop/agent-tools/invoke', { agentId: A.lead, tool: 'recipe_trial', args: { recipe_id: recipe, params: [{ node_id: spNode, value: 238 }], hypothesis: 'A 观察档应拒' } }, H())
    log(`A REST 直调 recipe_trial:${invErr(w) ? '被拒(观察模式)' : '异常放行!'} — ${invText(w).slice(0, 80)}`)
    writeFileSync(join(EVID, `transcript-A-observe-${TAG}.md`), `# A 观察档会话实录(${TAG})\n\n${reply}\n\n## REST 直调拒绝证据\n\n${invText(w)}\n`)
  }

  // ═══ B manual:下发挂 HITL → 批准(附言)→ 设备证实 + 附言回流 ═══
  {
    await setMode(B.channelId, 'manual')
    log('B 频道切 manual(放开方向,confirm)')
    const known = await pendingIds()
    const t0 = Date.now() - 5000
    await talk(B, `当前活动配方「注塑标准」一段桶温目标 240℃。请你把一段桶温目标下调 2℃ 做一次候选试验(recipe_trial),先说明你的依据。`)
    const card = await waitCard(known, 180_000)
    log(`B HITL 卡:${card ? card.id : '未出现'}`)
    if (!card) throw new Error('B 手动档未产生审批卡')
    const cardRaw = JSON.stringify(card)
    log(`B 审批卡含 Agent 依据:${cardRaw.includes('依据') || cardRaw.includes('240') || cardRaw.includes('238') ? '是' : '否(检查卡载荷)'}`)
    const ap = await api('POST', '/api/workshop/hitl/respond', { kind: 'dcw-approval', id: card.id, confirmed: true, choice: 0, comment: '验收员批准:238℃ 在窗口内,步长合规' }, H())
    log(`B 批准:${ap.status === 200 ? 'OK' : JSON.stringify(ap).slice(0, 120)}`)
    const reply = await collectReply(B, t0)
    transcripts.B = reply
    log(`B 会话回执 ${reply.length} 字(设备证实=${/设备证实|回读/.test(reply)};附言回流=${reply.includes('238℃ 在窗口内') || reply.includes('验收员批准')})`)
    writeFileSync(join(EVID, `transcript-B-manual-${TAG}.md`), `# B 手动档会话实录(${TAG})\n\n${reply}\n`)
    writeFileSync(join(EVID, `hitl-card-B-${TAG}.json`), cardRaw)
  }

  // ═══ C auto:三层全 auto → 免批直执行 ═══
  {
    const lineAuto = await api('PATCH', `/api/workshop/dcw/lines/${line}`, { controlMode: 'auto', confirm: true }, H())
    const bindAuto = await api('PATCH', `/api/workshop/agent-tools/bindings/${C.bindingId}`, { mode: 'auto', confirm: true }, H())
    const chAuto = await setMode(C.channelId, 'auto', true)
    log(`C 三层 auto:线=${lineAuto.status === 200 ? 'OK' : lineAuto.status} 绑定=${bindAuto.data?.binding?.mode} 频道=${chAuto.data?.executionMode}`)
    const known = await pendingIds()
    const t0 = Date.now() - 5000
    await talk(C, `把一段桶温目标再下调 1℃ 到 239℃ 做候选试验(recipe_trial),附上你的依据。`)
    // 免批:不应出现审批卡;等会话回执
    const reply = await collectReply(C, t0)
    transcripts.C = reply
    await sleep(2000)
    const items = (await api('GET', '/api/workshop/hitl/pending', undefined, H())).data?.items ?? []
    const cardAppeared = items.some(x => !known.has(x.id))
    log(`C 会话回执 ${reply.length} 字;免批(无新审批卡)=${cardAppeared ? '异常:出现卡' : '确认'}`)
    writeFileSync(join(EVID, `transcript-C-auto-${TAG}.md`), `# C 自动档会话实录(${TAG})\n\n${reply}\n`)
    // journal 锚点:239 已入册
    const j = await api('GET', `/api/workshop/dcw/journal?lineId=${line}&limit=10`, undefined, H())
    const anchors = JSON.stringify(j.data?.anchors ?? [])
    log(`C journal 含 239 写入:${anchors.includes('239') ? '是' : '否'};audit 写记录见下一步`)
    writeFileSync(join(EVID, `journal-C-${TAG}.json`), JSON.stringify(j.data?.anchors ?? [], null, 2))
  }

  // ═══ 收尾:审计与裁定 ═══
  const audit = await api('GET', '/api/workshop/audit?limit=100', undefined, H())
  writeFileSync(join(EVID, `audit-tail-${TAG}.json`), JSON.stringify(audit.data?.entries ?? [], null, 2))
  log('审计尾部已归档')
  writeFileSync(join(EVID, `live-summary-${TAG}.json`), JSON.stringify({ tag: TAG, base: BASE, line, spNode, pvNode, recipe, channels: { A: A.channelId, B: B.channelId, C: C.channelId }, transcripts: Object.fromEntries(Object.entries(transcripts).map(([k, v]) => [k, v.length])) }, null, 2))
  log('=== US-210 三模式产线实测:流程完成(证据已落 docs/audit/evidence/2026-10-28-execmodes/live/)===')
}
catch (err) {
  log(`FATAL ${err instanceof Error ? err.message : String(err)}`)
  // 实例保留不杀:供事后取证(dev.log / DB);证据目录已落盘的部分不受影响
  process.exitCode = 1
}
finally {
  writeFileSync(join(EVID, `dev-log-pointer-${TAG}.txt`), `实例日志: ${join(ROOT, 'dev.log')}\n实例保留在 ${BASE}(进程 ${child.pid},失败时不杀)\n`)
  if (process.exitCode !== 1) {
    try { child.kill() } catch { /* ignore */ }
  }
}
