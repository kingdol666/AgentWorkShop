#!/usr/bin/env node
/**
 * 工具面元数据驱动 · 多 Agent 实机 E2E(2026-10-24,隔离实例,真实 HTTP + MCP stdio)
 *
 * 验证用户核心关切:
 *  - 同一频道内不同 Agent(仅绑定不同)拿到不同工具描述(同一份 host-tools.json 动态装配);
 *  - 执行期 verify 按绑定面裁剪:自己的节点放行、跨线节点拒绝(原生 invoke 与 MCP 桥同源);
 *  - 配方写面:绑定配方的 Agent 进入 HITL 审批;未绑定者被 recipe 门直接拒绝;
 *  - WP2:ingest 兜底路径要求产线 operate 权限(普通用户 403,admin 200);回填窗 ±1h;
 *  - WP3:rotate-token 后旧 token 宽限内可用、新 token 立即可用;列表只回 tokenTail;
 *  - WP6:/agent-tools/list 带 ETag,If-None-Match 命中 304;industrial_resources 分页可用;
 *  - 面 B(stdio 桥)= 权威 per-agent 面:tools/list 描述按 Agent 差异化,tools/call 同链治理。
 *
 * 运行:node scripts/e2e-tool-surface-multiagent.mjs
 */
import { spawn, spawnSync } from 'node:child_process'
import { mkdirSync, openSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import { DatabaseSync } from 'node:sqlite'
import { createInterface } from 'node:readline'

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const TAG = `ts${Date.now().toString(36).slice(-4)}`
const ROOT = join(tmpdir(), `aw-tool-surface-e2e-${TAG}`)
mkdirSync(join(ROOT, 'home'), { recursive: true })
// 审批超时 1.5s:让「进入 HITL」可判定(未获批准路径),无需人工交互
writeFileSync(join(ROOT, 'home', 'runtime-settings.json'), JSON.stringify({ version: 1, overrides: { 'security.hitl_timeout_ms': 1500 } }))
const results = []
const ok = (id, name, cond, detail = '') => {
  results.push({ id, name, pass: Boolean(cond), detail: String(detail).slice(0, 400) })
  console.log(`${cond ? '✔' : '✖'} [${id}] ${name}${cond ? '' : ` — ${String(detail).slice(0, 400)}`}`)
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
    NUXT_SESSION_PASSWORD: 'ToolSurface#2026-e2e-key',
    NO_PROXY: '127.0.0.1,localhost',
  },
  stdio: ['ignore', logFd, logFd],
  windowsHide: true,
})

async function api(method, path, body, token, extraHeaders = {}, timeoutMs = 120_000) {
  const res = await fetch(BASE + path, {
    method,
    headers: {
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...extraHeaders,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  })
  let json = null
  try {
    json = await res.json()
  }
  catch { /* 非 JSON */ }
  return { status: res.status, headers: res.headers, ...json }
}
const invText = r => String(r?.data?.result?.text ?? r?.data?.text ?? '')
const invErr = r => Boolean(r?.data?.result?.isError ?? r?.data?.isError)
const dbPath = join(ROOT, 'home', 'data', 'workshop.sqlite')
const agentTokenOf = (agentId) => {
  const db = new DatabaseSync(dbPath)
  try {
    return String(db.prepare('SELECT token FROM channel_agents WHERE id = ?').get(agentId)?.token ?? '')
  }
  finally {
    db.close()
  }
}
/** 取描述中的某段(段首标签 → 到行尾) */
const segment = (desc, label) => {
  const m = String(desc ?? '').match(new RegExp(`${label.replace(/[()（）]/g, m2 => `\\${m2}`)}[:：]([^\\n]*)`))
  return m ? m[1] : ''
}

/** 起一个 stdio MCP 桥(面 B)并完成 initialize */
async function startBridge(agentId, agentToken) {
  const proc = spawn(process.execPath, [join(REPO, 'server', 'harness', 'aw-mcp-bridge.mjs')], {
    cwd: REPO,
    env: { ...process.env, NO_PROXY: '127.0.0.1,localhost', HTTP_PROXY: '', HTTPS_PROXY: '', AW_BASE_URL: BASE, AW_AGENT_ID: agentId, AW_AGENT_TOKEN: agentToken },
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  })
  const pending = new Map()
  let nextId = 1
  const rl = createInterface({ input: proc.stdout })
  rl.on('line', (line) => {
    let msg
    try {
      msg = JSON.parse(line)
    }
    catch { return }
    if (msg?.id != null && pending.has(msg.id)) {
      pending.get(msg.id)(msg)
      pending.delete(msg.id)
    }
  })
  const request = (method, params) => new Promise((resolveRpc, reject) => {
    const id = nextId++
    const timer = setTimeout(() => reject(new Error(`MCP ${method} 超时`)), 60_000)
    pending.set(id, (msg) => {
      clearTimeout(timer)
      resolveRpc(msg)
    })
    proc.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
  })
  await request('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'e2e', version: '1' } })
  proc.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`)
  return {
    proc,
    request,
    stop: () => {
      try {
        proc.stdin.end()
      }
      catch { /* noop */ }
      try {
        proc.kill()
      }
      catch { /* noop */ }
    },
  }
}

const textOfMcp = msg => String(msg?.result?.content?.map(c => c.text ?? '').join('\n') ?? '')

try {
  let healthy = false
  for (let i = 0; i < 90; i++) {
    await sleep(2000)
    try {
      const h = await api('GET', '/api/health', undefined, undefined, {}, 3000)
      if (h?.data?.status === 'ok' && h?.data?.workshop === 'ready') {
        healthy = true
        break
      }
    }
    catch { /* 未就绪 */ }
  }
  ok('T1', '隔离实例启动 + workshop ready', healthy, `port=${port}`)
  if (!healthy) throw new Error('实例未就绪')

  const admin = (await api('POST', '/api/users/register', { name: `ts-admin-${TAG}`, email: `ts-${TAG}@awshop.local`, password: 'TsAdmin#2026' })).data?.token
  ok('T1b', 'admin 注册', Boolean(admin))
  const H = () => admin

  // T1c:普通用户(admin 建号 + 登录,避开自助注册开关差异)
  const plainEmail = `ts-plain-${TAG}@awshop.local`
  const created = await api('POST', '/api/users', { name: `ts-plain-${TAG}`, email: plainEmail, password: 'TsPlain#2026', role: 'user' }, H())
  const login = await api('POST', '/api/users/login', { email: plainEmail, password: 'TsPlain#2026' })
  const plain = login?.data?.token
  ok('T1c', '普通用户创建+登录(无产线授权)', created.status === 200 && Boolean(plain), `create=${created.status} login=${login.status}`)

  // ── T2 场景:两条产线 + 数采节点 + 数控/配方 ──
  const lineA = (await api('POST', '/api/workshop/dcw/lines', { name: `工具面线A-${TAG}` }, H())).data?.line?.id
  const lineB = (await api('POST', '/api/workshop/dcw/lines', { name: `工具面线B-${TAG}` }, H())).data?.line?.id
  const dnA1 = (await api('POST', '/api/workshop/daq', { templateRef: 'daq-temp-tc', name: `A1专属数采-${TAG}`, driver: 'mock', lineId: lineA, intervalMs: 1000, publishIntervalMs: 0 }, H())).data?.node?.id
  const dnA2 = (await api('POST', '/api/workshop/daq', { templateRef: 'daq-temp-tc', name: `A2专属数采-${TAG}`, driver: 'mock', lineId: lineA, intervalMs: 1000, publishIntervalMs: 0 }, H())).data?.node?.id
  const dnB1 = (await api('POST', '/api/workshop/daq', { templateRef: 'daq-temp-tc', name: `B线数采-${TAG}`, driver: 'mock', lineId: lineB, intervalMs: 1000, publishIntervalMs: 0 }, H())).data?.node?.id
  const tpl = (await api('POST', '/api/workshop/dcw/templates', { name: `工具面参数-${TAG}`, ch: '压力', unit: 'bar', min: 0, max: 100, decimals: 1 }, H())).data?.template?.key
  const dcwA = (await api('POST', '/api/workshop/dcw', { templateRef: tpl, name: `A线数控-${TAG}`, driver: 'mock', lineId: lineA, stepLimit: 20, driverConfig: { key: `ts-${TAG}` } }, H())).data?.node?.id
  const product = (await api('POST', '/api/workshop/dcw/products', { lineId: lineA, name: `工具面产品-${TAG}` }, H())).data?.product?.id
  const recipeA = (await api('POST', '/api/workshop/dcw/recipes', { productId: product, name: `工具面配方-${TAG}`, params: [{ nodeId: dcwA, value: 50, min: 0, max: 100 }] }, H())).data?.recipe?.id
  ok('T2', '建两条线/三数采节点/数控/产品/配方', Boolean(lineA && lineB && dnA1 && dnA2 && dnB1 && dcwA && product && recipeA),
    JSON.stringify({ lineA, lineB, dnA1, dnA2, dnB1, dcwA, recipeA }).slice(0, 320))

  // ── T3 频道(绑 A 线)+ 两个 worker(同角色,仅绑定不同) ──
  const ch = (await api('POST', '/api/workshop/channels', { name: `工具面频道-${TAG}`, leadAgent: { name: `工具面lead-${TAG}`, harness: 'omp' } }, H())).data
  const channelId = ch?.channelId
  await api('PUT', `/api/workshop/channels/${channelId}/line`, { lineId: lineA }, H())
  const wA = (await api('POST', `/api/workshop/channels/${channelId}/agents`, { name: `AgentA1-${TAG}`, harness: 'mock', role: 'worker' }, H())).data
  const wB = (await api('POST', `/api/workshop/channels/${channelId}/agents`, { name: `AgentA2-${TAG}`, harness: 'mock', role: 'worker' }, H())).data
  const agentA = String(wA?.id ?? wA?.agentId ?? '')
  const agentB = String(wB?.id ?? wB?.agentId ?? '')
  ok('T3', '频道创建 + 绑 A 线 + 两个 worker', Boolean(channelId && agentA && agentB), JSON.stringify({ channelId, agentA, agentB }).slice(0, 240))

  // ── T4 差异化绑定:AgentA1→dnA1(daq)+recipeA;B2→dnA2(daq,无配方) ──
  const bindA = await api('POST', '/api/workshop/agent-tools/bindings', { agentId: agentA, nodeId: dnA1, kind: 'daq' }, H())
  const bindB = await api('POST', '/api/workshop/agent-tools/bindings', { agentId: agentB, nodeId: dnA2, kind: 'daq' }, H())
  const bindRecipe = await api('POST', '/api/workshop/agent-tools/bindings', { agentId: agentA, nodeId: recipeA, kind: 'recipe' }, H())
  ok('T4', '差异化绑定(A1→dnA1+配方;A2→dnA2)', bindA.status === 200 && bindB.status === 200 && bindRecipe.status === 200,
    `status=${bindA.status}/${bindB.status}/${bindRecipe.status} msg=${String(bindB?.message ?? '').slice(0, 120)}`)

  // T4c:频道产线一致性——绑他线节点应被拒(产品规则,证明隔离)
  const crossBind = await api('POST', '/api/workshop/agent-tools/bindings', { agentId: agentB, nodeId: dnB1, kind: 'daq' }, H())
  ok('T4c', '频道绑 A 线 → 成员绑 B 线节点被拒(403 产线隔离)', crossBind.status === 403,
    `status=${crossBind.status} code=${String(crossBind?.code ?? '')} msg=${String(crossBind?.message ?? '').slice(0, 140)}`)

  const tokenA = agentTokenOf(agentA)
  const tokenB = agentTokenOf(agentB)
  ok('T4b', '两个 Agent 实例 token 独立', tokenA.length > 20 && tokenB.length > 20 && tokenA !== tokenB, `lenA=${tokenA.length} lenB=${tokenB.length}`)

  // ── T5 注入面:同一份工具面,描述按各自绑定差异化 ──
  const listA = await api('GET', `/api/workshop/agent-tools/list?agentId=${agentA}`, undefined, undefined, { 'x-aw-agent-token': tokenA })
  const listB = await api('GET', `/api/workshop/agent-tools/list?agentId=${agentB}`, undefined, undefined, { 'x-aw-agent-token': tokenB })
  const toolsA = listA?.data?.tools ?? []
  const toolsB = listB?.data?.tools ?? []
  const descA = String(toolsA.find(t => t.name === 'daq_query')?.description ?? '')
  const descB = String(toolsB.find(t => t.name === 'daq_query')?.description ?? '')
  const boundSegA = segment(descA, '本 Agent 直接绑定的数采节点(仅这些可查)')
  const boundSegB = segment(descB, '本 Agent 直接绑定的数采节点(仅这些可查)')
  const recipeSegA = segment(String(toolsA.find(t => t.name === 'recipe_update')?.description ?? ''), '本 Agent 已绑定的配方(仅这些可写/下发)')
  const recipeSegB = segment(String(toolsB.find(t => t.name === 'recipe_update')?.description ?? ''), '本 Agent 已绑定的配方(仅这些可写/下发)')
  ok('T5a', '两 Agent 工具面非空(同一份目录装配)', toolsA.length > 20 && toolsB.length > 20, `A=${toolsA.length} B=${toolsB.length}`)
  ok('T5b', 'A1 绑定段含 dnA1、不含 dnA2', boundSegA.includes(dnA1) && !boundSegA.includes(dnA2), boundSegA.slice(0, 180))
  ok('T5c', 'A2 绑定段含 dnA2、不含 dnA1', boundSegB.includes(dnA2) && !boundSegB.includes(dnA1), boundSegB.slice(0, 180))
  ok('T5d', '配方绑定只进 A1 描述(A2 无配方段)', recipeSegA.includes(recipeA) && !recipeSegB.includes(recipeA), `A=${recipeSegA.slice(0, 90)} B=${recipeSegB.slice(0, 60)}`)
  ok('T5e', 'A1 描述不含他线节点 dnB1', !descA.includes(dnB1), '')
  // T5f(对象模型取证):两 Agent 工具名集合完全一致、同一工具描述不同 ——
  // 证明设计是「单一静态定义 + 按 Agent 即时编译视图」,不是为每个 Agent 克隆一套工具对象
  const namesA = toolsA.map(t => t.name).sort()
  const namesB = toolsB.map(t => t.name).sort()
  ok('T5f', '同名工具集 + 不同描述(视图编译,非对象克隆)', JSON.stringify(namesA) === JSON.stringify(namesB) && descA !== descB,
    `names equal=${JSON.stringify(namesA) === JSON.stringify(namesB)} descDiff=${descA !== descB}`)

  // ── T6 ETag/304(WP6) ──
  const etag = listA.headers?.get('etag') ?? ''
  const cond = await fetch(`${BASE}/api/workshop/agent-tools/list?agentId=${agentA}`, {
    headers: { 'x-aw-agent-token': tokenA, 'if-none-match': etag },
    signal: AbortSignal.timeout(15_000),
  })
  ok('T6', '工具面 ETag + If-None-Match → 304 空体', Boolean(etag) && cond.status === 304, `etag=${etag} status=${cond.status}`)

  // ── T7 执行面 verify:原生 invoke 按绑定面裁剪 ──
  const callAs = (agentId, tok, tool, args) => api('POST', '/api/workshop/agent-tools/invoke', { agentId, tool, args }, undefined, { 'x-aw-agent-token': tok })
  const ownA = await callAs(agentA, tokenA, 'daq_query', { node_id: dnA1 })
  const otherA = await callAs(agentA, tokenA, 'daq_query', { node_id: dnB1 })
  const ownB = await callAs(agentB, tokenB, 'daq_query', { node_id: dnA2 })
  const sharedB = await callAs(agentB, tokenB, 'daq_query', { node_id: dnA1 })
  ok('T7a', 'A1 查自己绑定节点 → 放行', !invErr(ownA), invText(ownA).slice(0, 120))
  ok('T7b', 'A1 查他线节点 → 拒绝(引用校验,越线)', invErr(otherA) && /工具调用被拒/.test(invText(otherA)), invText(otherA).slice(0, 200))
  ok('T7c', 'A2 查自己绑定节点 → 放行', !invErr(ownB), invText(ownB).slice(0, 120))
  ok('T7d', '频道绑线只读扩权:A2 可读 A 线未绑定节点', !invErr(sharedB), invText(sharedB).slice(0, 120))

  // ── T8 配方写面:未绑定被 recipe 门拒;已绑定进入 HITL(超时拒绝) ──
  const trialB = await callAs(agentB, tokenB, 'recipe_trial', { recipe_id: recipeA, params: [{ node_id: dcwA, value: 55 }], hypothesis: 'E2E:验证未绑定配方写面被拒' })
  ok('T8a', 'A2(未绑配方)recipe_trial → 绑定门拒绝(未进入审批)', invErr(trialB) && /绑定|授权|被拒/.test(invText(trialB)) && !/审批/.test(invText(trialB)), invText(trialB).slice(0, 220))
  const trialA = await callAs(agentA, tokenA, 'recipe_trial', { recipe_id: recipeA, params: [{ node_id: dcwA, value: 55 }], hypothesis: 'E2E:验证已绑定配方进入 HITL' })
  // 运行门:未开跑的配方不可写入/下发(产品约束)。因此可判定的差异是「闸门深度」:
  // 未绑定者停在①绑定门;已绑定者通过①②,停在③运行门 —— 证明绑定面真的在参与执行期判定。
  ok('T8b', 'A1(已绑配方)通过绑定门、被更深层运行门拒绝(未绑定者到不了该门)',
    invErr(trialA) && /运行门|未在执行/.test(invText(trialA)) && !/你未绑定该配方/.test(invText(trialA)), invText(trialA).slice(0, 240))

  // ── T9 MCP 桥(面 B):per-agent tools/list + tools/call 同链治理 ──
  const bridgeA = await startBridge(agentA, tokenA)
  try {
    const list = await bridgeA.request('tools/list', {})
    const mcpTools = list?.result?.tools ?? []
    const mcpDescA = String(mcpTools.find(t => t.name === 'daq_query')?.description ?? '')
    ok('T9a', 'MCP tools/list 返回 per-agent 工具面(≥20)', mcpTools.length >= 20, `count=${mcpTools.length}`)
    ok('T9b', 'MCP 描述与原生注入面同源(A1 绑定段含 dnA1)', segment(mcpDescA, '本 Agent 直接绑定的数采节点(仅这些可查)').includes(dnA1), mcpDescA.slice(-140))
    const callOwn = await bridgeA.request('tools/call', { name: 'daq_query', arguments: { node_id: dnA1 } })
    ok('T9c', 'MCP tools/call 自己节点 → 成功', !callOwn?.result?.isError, textOfMcp(callOwn).slice(0, 120))
    const callOther = await bridgeA.request('tools/call', { name: 'daq_query', arguments: { node_id: dnB1 } })
    ok('T9d', 'MCP tools/call 他线节点 → 同链拒绝(与原生一致)', Boolean(callOther?.result?.isError) && /工具调用被拒/.test(textOfMcp(callOther)), textOfMcp(callOther).slice(0, 200))
    const callRes = await bridgeA.request('tools/call', { name: 'industrial_resources', arguments: { limit: 10 } })
    ok('T9e', 'industrial_resources 经 MCP 可用(分页绑定面)', !callRes?.result?.isError && /绑定面资源/.test(textOfMcp(callRes)), textOfMcp(callRes).slice(0, 160))
  }
  finally {
    bridgeA.stop()
  }

  // ── T10 WP2:ingest 兜底路径需产线 operate ──
  const pushPlain = await api('POST', `/api/workshop/daq/${dnA1}/ingest`, { value: 42, at: new Date().toISOString() }, plain)
  const pushAdmin = await api('POST', `/api/workshop/daq/${dnA1}/ingest`, { value: 42, at: new Date().toISOString() }, admin)
  ok('T10a', '普通用户(无产线授权)推送 → 403 LINE_FORBIDDEN', pushPlain.status === 403, `status=${pushPlain.status} code=${String(pushPlain?.code ?? '')} msg=${String(pushPlain?.message ?? '').slice(0, 120)}`)
  ok('T10b', 'admin(operate)推送 → 200 落库', pushAdmin.status === 200 && pushAdmin?.data?.accepted === true, `status=${pushAdmin.status}`)
  const tooOld = await api('POST', `/api/workshop/daq/${dnA1}/ingest`, { value: 1, at: new Date(Date.now() - 6 * 3600_000).toISOString() }, admin)
  ok('T10c', '超回填窗(6h 前)→ 400(默认 ±1h)', tooOld.status === 400, `status=${tooOld.status} msg=${String(tooOld?.message ?? '').slice(0, 120)}`)

  // ── T11 WP3:rotate 后旧 token 宽限内可用;列表只回 tokenTail ──
  const rotated = await api('POST', `/api/workshop/channels/${channelId}/agents/${agentA}/rotate-token`, {}, H())
  const newToken = String(rotated?.data?.token ?? '')
  ok('T11a', 'rotate-token 返回一次性新 token', rotated.status === 200 && newToken.length > 20 && newToken !== tokenA, `status=${rotated.status}`)
  const afterOld = await callAs(agentA, tokenA, 'daq_query', { node_id: dnA1 })
  const afterNew = await callAs(agentA, newToken, 'daq_query', { node_id: dnA1 })
  ok('T11b', '旧 token 宽限窗内仍可用(桥重连过渡)', !invErr(afterOld), invText(afterOld).slice(0, 100))
  ok('T11c', '新 token 立即生效', !invErr(afterNew), invText(afterNew).slice(0, 100))
  const tpls = await api('GET', '/api/workshop/agents', undefined, H())
  const arr = Array.isArray(tpls?.data) ? tpls.data : []
  const inst = arr.flatMap(a => a.instances ?? []).find(i => i.id === agentA) ?? null
  ok('T11d', '列表接口不回全量 token(只回 tokenTail)', inst == null || (inst.token === undefined && typeof inst.tokenTail === 'string' && inst.tokenTail.length === 4),
    JSON.stringify(inst).slice(0, 160))

  // ── T12 审计:rotate 留痕 ──
  const audit = await api('GET', '/api/workshop/ops-logs?scope=all&limit=300', undefined, H())
  const acts = (audit?.data?.logs ?? []).map(x => x.action)
  ok('T12', 'rotate 审计落账(agent.token.rotate)', acts.includes('agent.token.rotate'), acts.filter(a => String(a).startsWith('agent.')).join(','))

  // ── T13 真实作业:两 Agent 并行各自完成一次真实作业闭环(查数→结论留痕) ──
  // 每个作业链只触碰自己绑定面的对象:作业 A 读 dnA1、作业 B 读 dnA2,各自 analysis_save 留痕
  // (台账 target line=频道绑线),再从台账读面核验归因。
  {
    const runInspectionJob = async (agentId, tok, nodeId, title, summary) => {
      const q = await callAs(agentId, tok, 'daq_query', { node_id: nodeId })
      if (invErr(q)) return { text: invText(q), err: true }
      const save = await callAs(agentId, tok, 'analysis_save', { title, summary })
      return { text: invText(save), err: invErr(save) }
    }
    const [rA, rB] = await Promise.all([
      runInspectionJob(agentA, tokenA, dnA1, `作业A-节点健康巡检-${TAG}`, `AgentA1 基于 dnA1 窗口数据完成巡检留痕(作业闭环验证)`),
      runInspectionJob(agentB, tokenB, dnA2, `作业B-节点健康巡检-${TAG}`, `AgentA2 基于 dnA2 窗口数据完成巡检留痕(作业闭环验证)`),
    ])
    ok('T13a', '作业A 闭环(查数+留痕)成功', !rA.err && /已保存|留痕|台账/.test(rA.text ?? ''), String(rA.text).slice(0, 180))
    ok('T13b', '作业B 闭环(查数+留痕)成功', !rB.err && /已保存|留痕|台账/.test(rB.text ?? ''), String(rB.text).slice(0, 180))
    const ledger = await callAs(agentA, tokenA, 'analysis_query', {})
    const bothVisible = /作业A-节点健康巡检/.test(invText(ledger)) && /作业B-节点健康巡检/.test(invText(ledger))
    ok('T13c', '两份作业产物均落分析台账(可读回)', !invErr(ledger) && bothVisible, invText(ledger).slice(0, 220))
  }

  const pass = results.filter(r => r.pass).length
  const total = results.length
  console.log(`\n═══ 工具面多 Agent 实机 E2E:${pass} PASS / ${total - pass} FAIL ═══`)
  const outDir = join(REPO, 'docs', 'audit', 'evidence', '2026-10-24-tool-surface')
  mkdirSync(outDir, { recursive: true })
  writeFileSync(join(outDir, 'multiagent-report.json'), JSON.stringify({ at: new Date().toISOString(), port, results, pass, total }, null, 2))
  process.exitCode = total - pass === 0 ? 0 : 1
}
finally {
  try {
    const pid = child.pid
    if (pid) spawnSync('taskkill', ['//T', '//F', '//PID', String(pid)], { stdio: 'ignore', windowsHide: true })
  }
  catch { /* 清场失败不掩盖结果 */ }
}
