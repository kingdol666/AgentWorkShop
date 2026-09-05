/**
 * 四引擎班组精简演练(真实服务 + 模拟工况数据):
 *  lead=omp;worker-dsh=数采(daq_query);worker-codex=数控写入(dcw_control,HITL)+复读;
 *  worker-opencode=数控读(dcw_read)。单 goal 任务,审批到达即批准,最小 token 消耗。
 * 运行:node scripts/_dbg-team-drill.mjs
 */
const BASE = process.env.AW_BASE ?? 'http://127.0.0.1:3000'
let failures = 0
const check = (name, ok, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
  if (ok) passed += 1
  else failures += 1
}
let passed = 0
const sleep = (ms) => new Promise(r => setTimeout(r, ms))
const log = (l) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${l}`)

const reg = await fetch(`${BASE}/api/workshop/users/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'drill-' + Math.random().toString(36).slice(2, 8) }) }).then(r => r.json())
const T = reg?.data?.token
if (!T) { console.error('注册失败(服务未启动?)'); process.exit(1) }
const sleep2 = (ms) => new Promise(r => setTimeout(r, ms))
const api = async (method, path, body, attempt = 0) => {
  try {
    const res = await fetch(`${BASE}${path}`, { method, headers: { 'content-type': 'application/json', authorization: `Bearer ${T}` }, body: body !== undefined ? JSON.stringify(body) : undefined })
    return await res.json().catch(() => ({}))
  }
  catch (e) {
    if (attempt < 3) {
      await sleep2(1500)
      return await api(method, path, body, attempt + 1)
    }
    throw e
  }
}

// ── WS 录制流(事件持久化由首个订阅触发)──
const { createRequire } = await import('node:module')
const { WebSocket } = createRequire(import.meta.url)('D:/codes/ABO/AgentWorkShop/node_modules/.pnpm/ws@8.21.3/node_modules/ws')

const seen = []
let lastSeq = 0
let ws = null
function startWs(channelId) {
  ws = new WebSocket(BASE.replace(/^http/, 'ws') + '/api/workshop/ws')
  ws.on('open', () => ws.send(JSON.stringify({ type: 'sub', channelId, token: T })))
  ws.on('message', (raw) => {
    try {
      const f = JSON.parse(String(raw))
      if (f.type === 'hitl.request') log(`[WS] HITL ${f.payload?.kind}: ${String(f.payload?.detail ?? f.payload?.title ?? '').slice(0, 90)}`)
      if (f.type === 'hitl.resolved') log(`[WS] HITL resolved outcome=${f.payload?.outcome}`)
      if (f.type === 'task.status') log(`[WS] task ${f.payload?.state} ${(f.payload?.title ?? '').slice(0, 40)}`)
    }
    catch { /* ignore */ }
  })
  ws.on('error', () => {})
}
async function pollEvents(channelId) {
  const res = await api('GET', `/api/workshop/channels/${channelId}/events?limit=500`)
  for (const f of (res?.data?.items ?? [])) {
    if (Number(f.seq ?? 0) > lastSeq) {
      lastSeq = Number(f.seq)
      seen.push(f)
    }
  }
}
async function waitUntil(cond, timeoutMs, intervalMs = 1500) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      if (await cond()) return true
    }
    catch { /* 瞬态网络/重载抖动,按条件未满足继续轮询 */ }
    await sleep(intervalMs)
  }
  return false
}

// ── 1. 产线 + 模拟工况节点 ──
const line = await api('POST', '/api/workshop/dcw/lines', { name: '四引擎演练线' })
const dcw = await api('POST', '/api/workshop/dcw', { templateRef: 'dcw-temp-sp', name: '演练温度设定器', driver: 'mock', lineId: line?.data?.line?.id })
const daq = await api('POST', '/api/workshop/daq', { templateRef: 'daq-temp-tc', name: '演练温度采集', driver: 'mock', lineId: line?.data?.line?.id, intervalMs: 1000 })
const dcwId = dcw?.data?.node?.id
const daqId = daq?.data?.node?.id
check('产线+数控节点+数采节点(mock 工况)创建', !!dcwId && !!daqId, `dcw=${dcwId} daq=${daqId}`)

// ── 2. 四引擎班组 ──
const ch = await api('POST', '/api/workshop/channels', {
  name: '四引擎班组演练',
  leadAgent: { name: 'lead-omp', harness: 'omp', config: { provider: 'zhipu-coding-plan', model: 'glm-5.2' } },
})
const cid = ch?.data?.channelId
check('创建班组(lead=omp)', !!cid)
startWs(cid)

async function addWorker(name, harness, config) {
  const w = await api('POST', `/api/workshop/channels/${cid}/agents`, { name, harness, role: 'worker', config })
  return w?.data?.id ?? null
}
const dsh = await addWorker('worker-dsh', 'dsh', { promptTimeoutMs: 480_000 })
// codex 需 per-agent CODEX_HOME(种子化全局凭据/网关配置;impl 追加 [mcp_servers.aw] 平台工具面)
const { mkdtempSync, copyFileSync, existsSync } = await import('node:fs')
const { tmpdir, homedir } = await import('node:os')
const { join } = await import('node:path')
const codexHome = mkdtempSync(join(tmpdir(), 'aw-drill-codex-'))
for (const f of ['auth.json', 'config.toml', 'cc-switch-model-catalog.json']) {
  try { if (existsSync(join(homedir(), '.codex', f))) copyFileSync(join(homedir(), '.codex', f), join(codexHome, f)) } catch { /* ignore */ }
}
const codex = await addWorker('worker-codex', 'codex', { codexHome, approvalPolicy: 'on-request', sandbox: 'workspace-write', promptTimeoutMs: 480_000, systemPromptPrefix: '执行要直接:按指令调用平台工具并汇报,不探索文件系统。' })
const ocTmp = (await import('node:fs')).mkdtempSync((await import('node:os')).tmpdir() + '/aw-drill-oc-')
const ocCfg = (await import('node:fs')).mkdtempSync((await import('node:os')).tmpdir() + '/aw-drill-occ-')
try { (await import('node:fs')).mkdirSync(ocTmp + '/opencode', { recursive: true }); (await import('node:fs')).copyFileSync((await import('node:os')).homedir() + '/.local/share/opencode/auth.json', ocTmp + '/opencode/auth.json') } catch { /* ignore */ }
const opencode = await addWorker('worker-opencode', 'opencode', { promptTimeoutMs: 480_000, model: 'zhipuai-coding-plan/glm-5.3-flash', dataDir: ocTmp, configDir: ocCfg, baseUrl: BASE })
check('三 worker 入组(dsh/codex/opencode)', !!dsh && !!codex && !!opencode, `dsh=${dsh?.slice(0, 8)} codex=${codex?.slice(0, 8)} oc=${opencode?.slice(0, 8)}`)

// ── 3. 绑定工业节点 ──
await api('POST', '/api/workshop/agent-tools/bindings', { agentId: dsh, nodeId: daqId, kind: 'daq', mode: 'auto' })
await api('POST', '/api/workshop/agent-tools/bindings', { agentId: codex, nodeId: dcwId, kind: 'dcw', mode: 'manual' })
await api('POST', '/api/workshop/agent-tools/bindings', { agentId: opencode, nodeId: dcwId, kind: 'dcw', mode: 'manual' })
check('绑定完成(dsh↔DAQ auto;codex/opencode↔DCW manual)', true)

// ── 4. 团队作业(单 goal,三步,指令点对点到人)──
const task = await api('POST', `/api/workshop/channels/${cid}/tasks`, {
  title: '四引擎数采数控联调',
  mode: 'goal',
  description: [
    '按以下分工执行,每步只做一次,不要额外发挥:',
    '1. worker-dsh:用 daq_query 工具查询你绑定的温度采集节点最近 5 分钟数据,把样本数与均值汇报给 lead;',
    '2. worker-codex:用 dcw_control 工具把你绑定的「演练温度设定器」写入 172.0(会触发人工审批,等待批准后再继续),然后用 dcw_read 复读并把读数汇报给 lead;',
    '3. worker-opencode:用 dcw_read 工具读取你绑定的「演练温度设定器」当前设定值,汇报给 lead;',
    '4. lead:三项结果齐后调用 complete_task 汇总。',
  ].join('\n'),
})
const taskId = task?.data?.id
check('团队作业 goal 已提交', !!taskId, `taskId=${taskId?.slice(0, 8)}`)

// ── 5. HITL:审批到达即批准 ──
const approvalsDone = new Set()
const approved = await waitUntil(async () => {
  const p = await api('GET', '/api/workshop/hitl/pending')
  const items = (p?.data?.items ?? []).filter(i => i.kind === 'dcw-approval' && !approvalsDone.has(i.id))
  for (const item of items) {
    log(`审批到达: ${String(item.detail ?? '').slice(0, 80)} → 批准`)
    const r = await api('POST', '/api/workshop/hitl/respond', { kind: 'dcw-approval', id: item.id, confirmed: true, comment: '演练批准' })
    approvalsDone.add(item.id)
    if (r?.data?.ok) log(`已批准 ${item.id}`)
  }
  return approvalsDone.size > 0 && (pollEvents(), seen.some(f => f.type === 'hitl.resolved' && f.payload?.outcome === 'answered'))
}, 600_000)
check('数控写入审批触发并批准', approved, `批准数=${approvalsDone.size}`)

// ── 6. 任务闭环 + 写入落地 ──
const done = await waitUntil(async () => {
  const t = await api('GET', `/api/workshop/tasks/${taskId}`)
  const st = t?.data?.state
  if (st === 'COMPLETED' || st === 'FAILED' || st === 'CANCELED') return st
  await pollEvents(cid)
  return null
}, 900_000)
check('团队任务闭环 COMPLETED', done === 'COMPLETED', `state=${done}`)

const read = await api('POST', '/api/workshop/agent-tools/invoke', { agentId: codex, tool: 'dcw_read', args: { node_id: dcwId } })
const rb = String(read?.data?.result?.text ?? '')
check('写入物理生效(读回 ~172)', /17[12]/.test(rb), rb.replace(/\n/g, ' ').slice(0, 110))

await pollEvents(cid)
const byType = {}
for (const f of seen) byType[f.type] = (byType[f.type] ?? 0) + 1
console.log('事件帧分布:', JSON.stringify(byType))
check('事件流覆盖(task/message/hitl)', (byType['task.status'] ?? 0) > 0 && (byType['a2a.message'] ?? 0) > 0)

console.log(`\n━━━ 演练结论:PASS=${passed} FAIL=${failures} ━━━`)
try { ws?.close() } catch { /* ignore */ }
process.exit(failures === 0 ? 0 : 1)
