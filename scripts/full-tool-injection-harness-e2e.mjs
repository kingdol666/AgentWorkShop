/**
 * 全功能验证：逐 harness 工具注入 + Agent 专属数采/下发工具面 + MCP 桥执行 + 一次 HITL 下发。
 * 读取 scenario-suite-setup 生成的临时 context；平台/模拟器需在线。
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const CTX_PATH = process.argv[2] ?? ''
if (!CTX_PATH) throw new Error('用法: node scripts/full-tool-injection-harness-e2e.mjs <scenario-context.json>')
const c = JSON.parse(readFileSync(CTX_PATH, 'utf8'))
const EVID = join(REPO, 'docs', 'audit', '2026-10-21-full-function-evidence')
mkdirSync(EVID, { recursive: true })
const sleep = ms => new Promise(r => setTimeout(r, ms))
const results = []
function ok(id, name, cond, detail = '') {
  results.push({ id, name, pass: Boolean(cond), detail: String(detail).slice(0, 800) })
  console.log(`${cond ? '✔' : '✖'} [${id}] ${name}${detail ? ` — ${String(detail).slice(0, 260)}` : ''}`)
}
async function api(method, path, body, token = c.adminToken) {
  const r = await fetch(c.base + path, {
    method,
    headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(180_000),
  })
  return { status: r.status, ...(await r.json().catch(() => ({}))) }
}
function bridge(agent) {
  const p = spawn(process.execPath, [join(REPO, 'server', 'harness', 'aw-mcp-bridge.mjs')], {
    cwd: REPO,
    env: { ...process.env, NO_PROXY: '127.0.0.1,localhost', HTTP_PROXY: '', HTTPS_PROXY: '', AW_BASE_URL: c.base, AW_AGENT_ID: agent.id, AW_AGENT_TOKEN: agent.token },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  const pending = new Map()
  let nextId = 1
  const rl = createInterface({ input: p.stdout })
  rl.on('line', (line) => {
    let msg
    try {
      msg = JSON.parse(line)
    }
    catch {
      return
    }
    if (msg?.id != null && pending.has(msg.id)) {
      pending.get(msg.id)(msg)
      pending.delete(msg.id)
    }
  })
  p.stderr.on('data', () => {})
  const rpc = (method, params, timeoutMs = 60_000) => new Promise((res, rej) => {
    const id = nextId++
    const t = setTimeout(() => {
      pending.delete(id)
      rej(new Error(`rpc timeout ${method}`))
    }, timeoutMs)
    pending.set(id, (msg) => {
      clearTimeout(t)
      res(msg)
    })
    p.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
  })
  const call = (name, args, timeoutMs) => rpc('tools/call', { name, arguments: args }, timeoutMs)
  return { p, rpc, call, close: () => {
    try {
      p.kill()
    }
    catch { /* exited */ }
  } }
}

const HARNESS_ORDER = ['mock', 'omp', 'opencode', 'codex', 'dsh', 'claude', 'gemini', 'copilot', 'cursor', 'crush', 'goose', 'qwen', 'pi', 'hermes']

async function main() {
  console.log(`━━━ 全工具注入/逐 harness 验收 @ ${c.base} line=${c.lineId} ━━━`)
  const avail = await api('GET', '/api/workshop/harnesses')
  const availMap = new Map((avail?.data?.harnesses ?? []).map(h => [h.id, h]))
  const report = { at: new Date().toISOString(), base: c.base, lineId: c.lineId, recipeId: c.recipeId, harnesses: [], mcp: [], write: null }
  const ch = await api('POST', '/api/workshop/channels', {
    name: `harness-tools-${Date.now().toString(36).slice(-5)}`,
    lineId: c.lineId,
    leadAgent: { name: 'harness-tools-lead', harness: 'mock' },
  })
  const channelId = ch?.data?.channelId
  ok('H0', '建立工具注入测试 Channel', Boolean(channelId), `HTTP ${ch.status} ${ch.message ?? ''}`)
  if (!channelId) return finish(report)

  // 每 harness 一个 worker；每个绑定一个不同的 DAQ 节点，配方统一 manual
  const daqIds = Object.values(c.daq ?? {})
  const recipeId = c.recipeId
  const holdPressure = c.dcw?.['hold-pressure-sp']
  let added = 0
  let daqCursor = 0
  for (const harness of HARNESS_ORDER) {
    const a = availMap.get(harness)
    if (!a?.available) {
      report.harnesses.push({ harness, available: false, skipped: true, reason: a?.error ?? 'not installed' })
      ok(`H-${harness}`, `${harness} 环境可用`, false, a?.error ?? 'not installed')
      continue
    }
    const name = `tool-${harness}-${Date.now().toString(36).slice(-4)}`
    const addedRes = await api('POST', `/api/workshop/channels/${channelId}/agents`, { name, harness, role: 'worker' })
    if (!addedRes?.data?.id) {
      report.harnesses.push({ harness, available: true, created: false, reason: addedRes?.message ?? addedRes?.code ?? 'add failed' })
      ok(`H-${harness}`, `${harness} Agent 创建`, false, JSON.stringify(addedRes).slice(0, 200))
      continue
    }
    added++
    const rows = (await api('GET', `/api/workshop/channels/${channelId}/agents`))?.data ?? []
    const rowList = Array.isArray(rows) ? rows : (rows.agents ?? [])
    const agent = rowList.find(a => a.id === addedRes.data.id) ?? addedRes.data
    const daqNode = daqIds[daqCursor++ % Math.max(daqIds.length, 1)]
    const bindDaq = await api('POST', '/api/workshop/agent-tools/bindings', { agentId: agent.id, nodeId: daqNode, kind: 'daq', mode: 'auto' })
    const bindRecipe = await api('POST', '/api/workshop/agent-tools/bindings', { agentId: agent.id, nodeId: recipeId, kind: 'recipe', mode: 'manual' })
    const bindOk = bindDaq.code === 0 && bindRecipe.code === 0
    const list = await api('GET', `/api/workshop/agent-tools/list?agentId=${encodeURIComponent(agent.id)}`)
    const tools = list?.data?.tools ?? []
    const byName = new Map(tools.map(t => [t.name, t]))
    const daq = byName.get('daq_query')
    const trial = byName.get('recipe_trial')
    const update = byName.get('recipe_update')
    const hasTools = ['daq_query', 'recipe_catalog', 'recipe_trial', 'recipe_update', 'analysis_save'].every(n => byName.has(n))
    const daqDesc = String(daq?.description ?? '')
    const recipeDesc = String(trial?.description ?? '') + ' ' + String(update?.description ?? '')
    const daqBound = daqDesc.includes(daqNode)
    const recipeBound = recipeDesc.includes(recipeId) || Object.keys(c.dcw ?? {}).some(k => recipeDesc.includes(k))
    report.harnesses.push({ harness, available: true, created: true, agentId: agent.id, daqNode, recipeId, bindOk, toolCount: tools.length, hasTools, daqBound, recipeBound })
    ok(`H-${harness}`, `${harness} 专属 DAQ/配方绑定`, bindOk, `daq=${daqNode} recipe=${recipeId}`)
    ok(`H-${harness}`, `${harness} 工具面含数采/配方工具`, hasTools, `count=${tools.length}`)
    ok(`H-${harness}`, `${harness} daq_query 描述含专属节点`, daqBound, daqDesc.slice(0, 160) || '(无)')
    ok(`H-${harness}`, `${harness} recipe_trial/update 描述含配方`, recipeBound, recipeDesc.slice(0, 160) || '(无)')

    // MCP 桥（非 omp/pi 的原生路径也由同一工具面；此处验证所有 harness 的 MCP 可调用性）
    const b = bridge(agent)
    try {
      const init = await b.rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: `verify-${harness}`, version: '1' } })
      b.p.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`)
      const tl = await b.rpc('tools/list', {})
      const names = (tl?.result?.tools ?? []).map(t => t.name)
      const read = await b.call('daq_query', { last_minutes: 1, limit: 5 }, 90_000)
      const text = read?.result?.content?.[0]?.text ?? ''
      const mcpOk = Boolean(init?.result) && names.includes('daq_query') && names.includes('recipe_trial') && text.includes('数采数据查询结果')
      report.mcp.push({ harness, agentId: agent.id, listCount: names.length, readOk: text.includes('数采数据查询结果'), text: text.slice(0, 300) })
      ok(`M-${harness}`, `${harness} MCP 桥可列工具并执行 daq_query`, mcpOk, `tools=${names.length} ${text.slice(0, 100)}`)
    }
    catch (err) {
      report.mcp.push({ harness, agentId: agent.id, error: err instanceof Error ? err.message : String(err) })
      ok(`M-${harness}`, `${harness} MCP 桥可列工具并执行 daq_query`, false, err instanceof Error ? err.message : String(err))
    }
    finally {
      b.close()
    }
  }
  ok('H1', '至少 2 个 harness 成功创建并绑定', added >= 2, `added=${added}`)

  // 一次真实下发：选第一个可用非 mock harness（优先 copilot/omp），走 MCP + HITL
  const candidate = report.harnesses.find(x => x.available && x.created && x.harness !== 'mock')
  if (candidate && holdPressure) {
    const agentList = (await api('GET', `/api/workshop/channels/${channelId}/agents`))?.data ?? []
    const agent = (Array.isArray(agentList) ? agentList : agentList.agents ?? []).find(a => a.id === candidate.agentId)
    if (agent?.token) {
      const cur = (await api('GET', '/api/workshop/dcw'))?.data?.nodes?.find(n => n.id === holdPressure)
      const from = Number(cur?.value)
      const step = Math.min(1.8, Math.max(0.1, Number(cur?.stepLimit) || 1.8))
      const to = Number((from + step).toFixed(2))
      const known = new Set(((await api('GET', '/api/workshop/hitl/pending'))?.data?.items ?? []).map(x => x.id))
      const b = bridge(agent)
      try {
        await b.rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'verify-write', version: '1' } })
        b.p.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`)
        const callP = b.call('recipe_trial', { recipe_id: c.recipeId, params: [{ node_id: holdPressure, value: to }], hypothesis: `全功能验收:${candidate.harness} 经 MCP 小步试验 ${from}→${to}`, emergency: true }, 240_000)
        let card = null
        for (let i = 0; i < 90 && !card; i++) {
          await sleep(1000)
          const items = (await api('GET', '/api/workshop/hitl/pending'))?.data?.items ?? []
          card = items.find(x => !known.has(x.id) && String(x.nodeId ?? '').startsWith('recipe:')) ?? null
        }
        if (card) await api('POST', '/api/workshop/hitl/respond', { kind: 'dcw-approval', id: card.id, confirmed: true, choice: 0, comment: '全功能验收批准' })
        const w = await callP
        const text = w?.result?.content?.[0]?.text ?? ''
        const after = (await api('GET', '/api/workshop/dcw'))?.data?.nodes?.find(n => n.id === holdPressure)
        const readback = Number(after?.value)
        const writeOk = Boolean(card) && text.includes('证实') && Math.abs(readback - to) < 1e-6
        report.write = { harness: candidate.harness, from, to, card: card?.id ?? null, text: text.slice(0, 700), readback, ok: writeOk }
        ok('W1', `${candidate.harness} 经 MCP recipe_trial + HITL 真实下发/回读`, writeOk, `card=${card?.id ?? '-'} ${from}→${to} readback=${readback} ${text.slice(0, 100)}`)
      }
      catch (err) {
        report.write = { harness: candidate.harness, error: err instanceof Error ? err.message : String(err) }
        ok('W1', `${candidate.harness} 经 MCP recipe_trial + HITL 真实下发/回读`, false, err instanceof Error ? err.message : String(err))
      }
      finally {
        b.close()
      }
    }
  }
  writeFileSync(join(EVID, 'harness-tool-injection.json'), JSON.stringify(report, null, 2))
  return finish(report)
}

function finish(report) {
  const pass = results.filter(r => r.pass).length
  writeFileSync(join(EVID, 'harness-tool-injection-summary.json'), JSON.stringify({ at: new Date().toISOString(), pass, fail: results.length - pass, results, report }, null, 2))
  console.log(`\n═══ 工具注入/逐 harness: ${pass}/${results.length} PASS ═══`)
  if (pass !== results.length) process.exitCode = 1
}
main().catch((e) => {
  console.error(e)
  ok('ERR', '脚本未抛异常', false, e.message)
  finish({})
})
