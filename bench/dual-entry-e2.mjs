#!/usr/bin/env node
/**
 * dual-entry-e2 —— E2:双入口等价性 + HITL 批/拒(论文 E2 证据)
 *
 * 前置:平台已启(建议 AW_MCP_ENABLED=true)且 injection 线已建(auto 模式)。
 * 部分:
 *   [A] HITL 批准路径:线切 manual → recipe_trial → 审批卡挂出 → 批准 → 设备值改变
 *   [B] HITL 拒绝路径:再次 trial → 拒绝 → 设备值不变
 *   [C] 双入口:同一工具(recipe_trial)分别经 (1) REST /agent-tools/invoke
 *       (2) MCP stdio 网关(aw-mcp-server) 执行,对比响应/批次/台账/操作标识。
 *       如实记录:两条入口各自暴露的 handler/operation 标识字段;若日志无显式
 *       handler-path 字段,按约定报告「共享分发设计 + 运行时效果等价」,不声称日志级等价。
 */
import { spawn } from 'node:child_process'
import { join } from 'node:path'

const B = process.env.AW_BASE ?? 'http://127.0.0.1:3600'
const REPO = process.cwd()
process.env.NO_PROXY = '127.0.0.1,localhost'
const j = async (p, o = {}, T) => {
  const r = await fetch(B + p, { ...o, headers: { 'content-type': 'application/json', ...(T ? { authorization: `Bearer ${T}` } : {}), ...(o.headers ?? {}) } })
  return r.json()
}
const sleep = ms => new Promise(r => setTimeout(r, ms))

const r2v = (mn, mx, cur) => {
  const span = mx - mn
  const want = cur + span * 0.1
  return Number(Math.max(mn + span * 0.05, Math.min(mx - span * 0.05, want)).toFixed(3))
}

const lg = await j('/api/users/login', { method: 'POST', body: JSON.stringify({ email: 'admin@awshop.local', password: 'admin123' }) })
const T = lg.data.token
const H = { 'authorization': `Bearer ${T}`, 'content-type': 'application/json' }

const lines = (await j('/api/workshop/dcw/lines', {}, T)).data.lines
const inj = lines.find(l => /injection/.test(l.name)) ?? lines[0]
const dcw = (await j('/api/workshop/dcw?limit=300', {}, T)).data.nodes.filter(n => n.lineId === inj.id)
// 目标节点:注塑线取保压;其余线(如 biax)取首个铸速类 SP;写值按当前值+10% 量程
const hp = dcw.find(n => /hold.pressure/i.test(n.name)) ?? dcw.find(n => /cast.spd/i.test(n.name)) ?? dcw[0]
const recipe = (await j('/api/workshop/dcw/recipes', {}, T)).data.recipes.filter(r => r.lineId === inj.id)[0]
const chs = (await j('/api/workshop/channels', {}, T)).data
const clist = Array.isArray(chs) ? chs : (chs?.channels ?? [])
let agentId = null
for (const c of clist.filter(c => /injection|biax/i.test(c.name))) {
  const ags = (await j(`/api/workshop/channels/${c.id}/agents`, {}, T)).data
  const arr = Array.isArray(ags) ? ags : (ags?.agents ?? [])
  const tool = arr.find(a => a.role === 'worker')
  if (tool) { agentId = tool.id; break }
}
// 绑定配方给工具执行器(与 bench mission 同一动作;auto 模式写直读,manual 模式出审批卡)
const bind = await j('/api/workshop/agent-tools/bindings', { method: 'POST', headers: H, body: JSON.stringify({ agentId, nodeId: recipe.id, kind: 'recipe', mode: 'manual' }) }, T)
console.log('[pre] line', inj.id, 'agent', agentId, 'recipe', recipe.id, 'hp', hp.value, '| bind:', bind.status ?? JSON.stringify(bind).slice(0, 80))

// 读模拟器信号现值(物理事实源)
const S = 'http://127.0.0.1:4010'
const simVal = async () => {
  const n = (await (await fetch(S + '/api/nodes')).json()).data?.find(x => x.id === 'inj-inject-opcua')
  const s = n?.signals?.find(x => x.id === 'hold-pressure-sp')
  return s?.runtime?.value ?? s?.value
}

// ── [A]+[B] HITL 批/拒(线切 manual) ──
await j(`/api/workshop/dcw/lines/${inj.id}`, { method: 'PATCH', headers: H, body: JSON.stringify({ controlMode: 'manual', confirm: true }) }, T)
console.log('[mode] manual')
// 运行门:trial 需要活动批 —— 线未跑先开跑(auto→manual 切换会收窗)
const runSt = await j(`/api/workshop/dcw/lines/${inj.id}/start`, { method: 'POST', headers: H, body: JSON.stringify({ recipeId: recipe.id }) }, T)
console.log('[run] line start:', runSt.status, String(runSt.message ?? '').slice(0, 80))

const trial = () => j('/api/workshop/agent-tools/invoke', { method: 'POST', headers: H, body: JSON.stringify({ agentId, tool: 'recipe_trial', args: { recipe_id: recipe.id, params: [{ node_id: hp.id, value: Number(hp.max) ? r2v(Number(hp.min ?? 0), Number(hp.max), Number(hp.value ?? 0)) : Number(hp.value) }], hypothesis: 'E2 HITL 批/拒' } }) }, T)
const waitCard = async () => {
  for (let i = 0; i < 30; i++) {
    await sleep(1000)
    const items = (await j('/api/workshop/hitl/pending', {}, T)).data?.items ?? []
    const card = items.find(x => String(x.nodeId ?? '').startsWith('recipe:'))
    if (card) return card
  }
  return null
}

console.log('[A] 批准路径:')
let c1 = await waitCard()
const p1 = trial()
c1 = c1 ?? await waitCard()
if (!c1) {
  const r1txt = await p1
  console.log('  ✘ 无审批卡;trial 回执:', String(r1txt?.data?.result?.text ?? JSON.stringify(r1txt).slice(0, 150)).slice(0, 220))
  process.exit(1)
}
const TARGETV = Number(hp.max) ? r2v(Number(hp.min ?? 0), Number(hp.max), Number(hp.value ?? 0)) : null
const beforeA = await simVal()
const dec1 = await j('/api/workshop/hitl/respond', { method: 'POST', headers: H, body: JSON.stringify({ kind: c1.kind ?? 'dcw-approval', id: c1.id, confirmed: true, choice: 0, comment: 'E2 批准路径' }) }, T)
const r1 = await p1
await sleep(10000)
const afterA = await simVal()
console.log(`  卡=${c1.id} 批准=${dec1.status} 模拟器信号 ${beforeA}→${afterA} ${TARGETV != null && Math.abs(afterA - TARGETV) <= Math.max(0.05, Math.abs(TARGETV) * 0.01) ? '✔ 已生效' : '✘ 未生效(目标 ' + TARGETV + ')'}`)

console.log('[B] 拒绝路径:')
const p2 = trial()
const c2 = await waitCard()
if (!c2) { console.log('  ✘ 无审批卡'); process.exit(1) }
const beforeB = await simVal()
const dec2 = await j('/api/workshop/hitl/respond', { method: 'POST', headers: H, body: JSON.stringify({ kind: c2.kind ?? 'dcw-approval', id: c2.id, confirmed: false, choice: 0, comment: 'E2 拒绝路径' }) }, T)
const r2 = await p2
await sleep(4000)
const afterB = await simVal()
const rejText = String(r2?.data?.result?.text ?? '')
console.log(`  卡=${c2.id} 拒绝=${dec2.status} 模拟器信号 ${beforeB}→${afterB} ${TARGETV != null && Math.abs(afterB - TARGETV) > Math.max(0.05, Math.abs(TARGETV) * 0.01) ? '✔ 未写入(拒绝生效)' : '✘ 意外写入'}`)
console.log(`  拒绝回执片段:${rejText.slice(0, 120)}`)

// ── [C] 双入口(REST vs MCP) ──
await j(`/api/workshop/dcw/lines/${inj.id}`, { method: 'PATCH', headers: H, body: JSON.stringify({ controlMode: 'auto', confirm: true }) }, T)
console.log('[mode] auto(双入口段)')

try {
// 入口 1:REST invoke(auto 模式直读,无审批卡)
  const restResp = await j('/api/workshop/agent-tools/invoke', { method: 'POST', headers: H, body: JSON.stringify({ agentId, tool: 'recipe_trial', args: { recipe_id: recipe.id, params: [{ node_id: hp.id, value: Number(hp.value) + 1 }], hypothesis: 'E2 REST 入口' } }) }, T)
  const restText = String(restResp?.data?.result?.text ?? '')
  const restBatch = (restText.match(/批次\s+([A-Za-z0-9-]+)/) ?? [])[1] ?? null
  console.log(`[C1] REST invoke:isError=${restResp?.data?.result?.isError ?? false} 批次=${restBatch}`)

  // 入口 2:MCP stdio(需平台 AW_MCP_ENABLED=true)
  console.log('[C2] MCP stdio 入口:')
  const mcpResp = await new Promise((resolve) => {
    const child = spawn(process.execPath, [join(REPO, 'mcp', 'aw-mcp-server.mjs')], {
      env: { ...process.env, AW_BASE_URL: B, AW_TOKEN: T, AW_MCP_TIMEOUT_MS: '60000' },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    let buf = ''
    let errored = false
    child.stderr.on('data', d => { const s = String(d); if (/MCP 集成已停用|未发现运行中的/.test(s)) errored = true })
    const send = obj => child.stdin.write(JSON.stringify(obj) + '\n')
    const online = (want) => new Promise(res => {
      const h = d => {
        buf += String(d)
        let idx
        while ((idx = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, idx); buf = buf.slice(idx + 1)
          try { const msg = JSON.parse(line); if (msg.id === want) { child.stdout.off('data', h); res(msg) } } catch { /* 非 JSON 行 */ }
        }
      }
      child.stdout.on('data', h)
    })
  ;(async () => {
      try {
        const initP = online(1)
        send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'e2', version: '1' } } })
        await initP
        send({ jsonrpc: '2.0', method: 'notifications/initialized' })
        const listP = online(2)
        send({ jsonrpc: '2.0', id: 2, method: 'tools/list' })
        const list = await listP
        const names = (list.result?.tools ?? []).map(x => x.name)
        console.log(`  MCP tools=${names.length}${names.includes('recipe_trial') ? '(含 recipe_trial)' : '(不含 recipe_trial!)'}`)
        const callP = online(3)
        send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'recipe_trial', arguments: { recipe_id: recipe.id, params: [{ node_id: hp.id, value: Number(hp.value) + 2 }], hypothesis: 'E2 MCP 入口' } } })
        const call = await callP
        const text = String(call.result?.content?.[0]?.text ?? '')
        const batch = (text.match(/批次\s+([A-Za-z0-9-]+)/) ?? [])[1] ?? null
        console.log(`  MCP invoke:isError=${call.result?.isError ?? false} 批次=${batch} 回执=${text.slice(0, 100).replace(/\n/g, ' ')}`)
        resolve({ names, batch, text: text.slice(0, 200) })
      } catch (e) { resolve({ error: String(e).slice(0, 120) }) }
      finally { child.kill() }
    })()
    setTimeout(() => resolve({ error: 'mcp-timeout' }), 90000)
  })
  console.log('[C] 对照记录:')
  console.log(`  REST 批次=${restBatch} | MCP 批次=${mcpResp?.batch ?? mcpResp?.error ?? 'n/a'}`)
  console.log(`  可核验标识现状:批次号(两入口均有)· 工具名(均有)· 操作者归属(台账) ;显式 handler-path 字段=${'未记录(设计层面共享 dispatch,见 industrial.ts 工具表与 REST 路由各自的 handler)'}`)
  console.log('[C] 台账核验:查最近两笔批次的 recipe_log/ops_log 归档字段')
} catch (e) { console.log('[C] 双入口段异常(如实记录):', String(e).slice(0, 140)) }
const ops = (await j('/api/workshop/ops-logs?limit=20', {}, T)).data
const arr = Array.isArray(ops) ? ops : (ops?.items ?? ops?.logs ?? [])
console.log('  ops_log 最近条目(动作/归属/摘要):')
for (const o of arr.slice(0, 6)) console.log(`   - ${o.action ?? o.kind} | ${o.actorName ?? o.actor} | ${String(o.summary ?? '').slice(0, 70)}`)
