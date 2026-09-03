/**
 * 插件扩展验证 A(REST 链路):插件模板建节点 → sink 加工入库断言(×2 标定 + 指纹)
 * → 绑定 Agent(为 B 段工具读库做准备)。产出 .e2e-plugin-ctx.json 供后续段使用。
 * 运行: node scripts/_dbg-plugin-sink-rest.mjs
 */
import { writeFileSync } from 'node:fs'

const ROOT = process.env.E2E_ROOT ?? 'http://127.0.0.1:3000'
const sleep = ms => new Promise(r => setTimeout(r, ms))
const fail = (msg) => { console.error('FAIL:', msg); process.exitCode = 1 }

const login = await fetch(`${ROOT}/api/users/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'zhangwei@awshop.io', password: 'Awshop@123' }) }).then(r => r.json())
const H = { authorization: `Bearer ${login.data.token}`, 'content-type': 'application/json' }
const j = (u, m = 'GET', b) => fetch(ROOT + u, { method: m, headers: H, body: b ? JSON.stringify(b) : undefined }).then(r => r.json())

// ===== 1. 插件模板在目录中(plugin 标记)=====
const daq0 = (await j('/api/workshop/daq')).data
const tpl = daq0.templates.find(t => t.key === 'plug-verify-x2-profile')
if (tpl && tpl.plugin && tpl.signalKind === 'vector') console.log('PASS 插件模板在目录:', tpl.key, 'plugin=' + tpl.plugin)
else { fail(`template missing: ${JSON.stringify(tpl?.plugin)}`); process.exit(1) }

// ===== 2. 开跑 + 建节点(挂产线)=====
const d = (await j('/api/workshop/dcw')).data
const cand = d.lines.map(l => ({ line: l, recipe: d.recipes.find(r => r.lineId === l.id) })).find(x => x.recipe)
await j(`/api/workshop/dcw/lines/${cand.line.id}/stop`, 'POST').catch(() => {})
await sleep(800)
await j(`/api/workshop/dcw/lines/${cand.line.id}/start`, 'POST', { recipeId: cand.recipe.id })
const node = (await j('/api/workshop/daq', 'POST', {
  templateRef: 'plug-verify-x2-profile', lineId: cand.line.id, name: 'VERIFY ×2 标定',
  posX: 100, posZ: 100,
})).data.node
console.log('node:', node.id)

// ===== 3. 等帧 → sink 加工断言 =====
let frames = []
for (let i = 0; i < 15; i++) {
  await sleep(2000)
  frames = (await j(`/api/workshop/daq/${node.id}/frames?limit=5`)).data.frames
  if (frames.length >= 3) break
}
if (frames.length < 3) { fail(`frames insufficient: ${frames.length}`); process.exit(1) }
const f = frames[0]
const pts = f.points ?? []
const inScaledRange = pts.every(p => p >= 0.79 && p <= 1.21) // 0.4~0.6 经 ×2 → 0.8~1.2(钳位后加工的证明)
if (f.kind === 'vector' && pts.length === 24 && inScaledRange) console.log(`PASS sink 加工: 24 点全部为 ×2 标定值(${pts[0]}…,原始量程 0.4~0.6 的 2 倍域)`)
else fail(`sink processing: len=${pts.length} range=[${Math.min(...pts)},${Math.max(...pts)}]`)
if (f.metrics.verifyTag === 1) console.log('PASS 插件处理器指纹: metrics.verifyTag=1')
else fail(`verifyTag missing: ${JSON.stringify(f.metrics)}`)
if (Number.isFinite(f.metrics.avg) && f.metrics.avg > 0.9 && f.metrics.avg < 1.1) console.log(`PASS derive-metric 在插件处理器之后执行: avg=${f.metrics.avg}(≈1.0 量级)`)
else fail(`avg order wrong: ${f.metrics.avg}`)
if (f.lineId === cand.line.id) console.log('PASS 打标继承: lineId=' + f.lineId)
else fail(`lineId=${f.lineId}`)

// ===== 4. 标量表零污染(插件模板节点不进 daq_samples)=====
const scalar = (await j(`/api/workshop/daq/${node.id}/samples?limit=5`)).data.points
if (scalar.length === 0) console.log('PASS 标量表零污染: 默认节点行为已被插件 sink 替换')
else fail(`scalar pollution: ${scalar.length}`)

// ===== 5. 绑定 Agent(为 B 段 daq_frames 工具读库做准备)=====
const agents = (await j('/api/workshop/agents')).data
const agents2 = agents.agents ?? agents
const agent = agents2.find(a => a.enabled !== 0 && a.role === 'worker') ?? agents2[0]
if (!agent) { fail('no agent to bind'); process.exit(1) }
await fetch(`${ROOT}/api/workshop/agent-tools/bindings`, { method: 'POST', headers: H, body: JSON.stringify({ agentId: agent.id, nodeId: node.id, kind: 'daq', mode: 'manual' }) }).then(r => r.json())
const bindings = (await j(`/api/workshop/agent-tools/bindings?agentId=${agent.id}`)).data.bindings
if (bindings.some(b => b.nodeId === node.id && b.kind === 'daq')) console.log(`PASS Agent 绑定: ${agent.id.slice(0, 8)} ↔ ${node.id}`)
else fail('binding missing')

writeFileSync('.e2e-plugin-ctx.json', JSON.stringify({ nodeId: node.id, agentId: agent.id, lineId: cand.line.id }))
console.log('ctx saved → .e2e-plugin-ctx.json(节点与产线保持运行,供 B/C 段使用)')
