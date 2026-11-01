#!/usr/bin/env node
/**
 * bench/experiment/authorization-probe.mjs —— E4·L1 授权面一致性（Agent 工具面）
 *
 * 目的：补齐「防御纵深」里唯一没有证据的一层——Agent 写路径的绑定/授权门。
 * 与 E1a（REST 手动身份，不经授权门）不同，本测试走 **Agent 工具面**
 * （`optimization_explore` → `dcwControlGovernedInternal`），验证：
 *   ① 未绑定节点的 Agent 写入被拒（grant/binding 门）；
 *   ② 绑定本节点的 Agent 写入成功（控制项，证明拒绝不是环境问题）；
 *   ③ 绑定 A 的 Agent 写 B 被拒（跨节点越权）。
 *
 * 不做任何旁路，可在隔离实例上随时重跑。判据：①②③ 全部符合预期。
 *
 * 用法：
 *   node bench/experiment/authorization-probe.mjs --scenario injection --base http://127.0.0.1:3005
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { makeApi, sleep } from '../lib/util.mjs'
import { ensureSimulator, simUp, SIM_BASE } from '../lib/sim.mjs'
import { ensurePlatform } from '../lib/platform.mjs'
import { SCENARIOS, ensureScenarioLine, provisionScenarioLine } from '../lib/scenarios.mjs'
import { ensureGateway } from '../lib/provision.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = resolve(HERE, '..', '..')
const args = process.argv.slice(2)
const arg = (k, d) => { const i = args.indexOf(`--${k}`); return i >= 0 ? (args[i + 1] ?? '') : d }
const has = (k) => args.includes(`--${k}`)
const scenarioId = arg('scenario', 'injection')
const base = arg('base', process.env.AW_BASE ?? 'http://127.0.0.1:3001')
const autostart = !has('no-autostart')
const rid = `${new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)}-authorization`
const outDir = resolve(arg('out', join(REPO, 'bench', 'results', rid)))

const bind = async (api, agentId, nodeId, kind, mode = 'auto') => {
  const b = await api.call('POST', '/api/workshop/agent-tools/bindings', { agentId, nodeId, kind, mode })
  const id = b?.data?.binding?.id
  if (id && b?.data?.binding?.mode !== mode) {
    await api.call('PATCH', `/api/workshop/agent-tools/bindings/${id}`, { mode, confirm: true }).catch(() => {})
  }
  return b?.data?.binding ?? null
}

async function newChannelAgent(api, harness, tag) {
  const bt = await api.call('POST', '/api/workshop/channel-templates', { name: `auth-blank-${tag}`, description: '', lead: null, members: [], visibility: 'private' })
  const btId = bt.data?.template?.id ?? bt.data?.id
  const inst = btId
    ? await api.call('POST', `/api/workshop/channel-templates/${encodeURIComponent(btId)}/instantiate`, { name: `auth-${tag}`, toolProfile: 'aml_optimization', optimizationMode: 'exploration' })
    : { data: {} }
  if (btId) await api.call('DELETE', `/api/workshop/channel-templates/${encodeURIComponent(btId)}`).catch(() => {})
  const chId = inst?.data?.channelId ?? inst?.data?.channel?.id
  const ag = await api.call('POST', '/api/workshop/agents', { name: `auth-agent-${tag}`, harness, config: {} })
  const join1 = await api.call('POST', `/api/workshop/channels/${chId}/agents`, { agentId: ag.data?.id, role: 'worker' })
  return { chId, instId: join1.data?.id ?? join1.data?.agentId }
}

/** 前置清理：同节点遗留的 open 优化记录会触发 Agent 写互斥（属主≠本次 actor，孤儿接管 30 min）。
 *  每笔探针前先判定收口（keep），否则会得到「控制项被误拒」的假 FAIL（2026-11-01 实测）。 */
async function closeOpenRecords(api, nodeId, tag) {
  const r = await api.call('GET', '/api/workshop/dcw/optimizations')
  const list = r.data?.records ?? []
  const open = list.filter(x => x.status === 'open' && x.nodeId === nodeId)
  for (const rec of open) {
    await api.call('POST', `/api/workshop/dcw/optimizations/${rec.id}/judge`, { verdict: 'keep', reason: `${tag} 前置清理：上一轮遗留 open 记录` }).catch(() => {})
  }
  return open.length
}

const explore = async (api, agentId, controlNodeId, targetNodeId, step) => {
  const r = await api.call('POST', '/api/workshop/agent-tools/invoke', {
    agentId,
    tool: 'optimization_explore',
    args: { control_node_id: controlNodeId, target_node_id: targetNodeId, direction: 'up', step, settle_seconds: 10, hypothesis: 'L1 authorization probe: 验证绑定/授权门是否在驱动前拒绝' },
  }, 90_000)
  const res = r.data?.result ?? {}
  return { status: r.status, isError: res.isError === true, text: String(res.text ?? '').slice(0, 220) }
}

const main = async () => {
  if (autostart) {
    await ensureSimulator({ log: (m) => console.log(`[sim] ${m}`) })
    if (!(await simUp())) throw new Error('PLC 模拟器不可达')
    await ensurePlatform({ base, log: (m) => console.log(`[platform] ${m}`) })
  }
  const api = makeApi(base)
  const login = await api.login('admin@awshop.local', 'admin123')
  if (!login.ok) throw new Error(`鉴权失败: ${login.how}`)
  if (!(await ensureGateway(api))) throw new Error('DAQ 采样总控启动失败')

  const scen = SCENARIOS[scenarioId]
  if (!scen) throw new Error(`未知场景 ${scenarioId}`)
  await ensureScenarioLine(scen)
  const line = await provisionScenarioLine(api, scen, { sfx: `auth${Date.now().toString(36).slice(-4)}` })
  if (!line.ids?.lineId) throw new Error('建线失败')

  const snap = await api.call('GET', '/api/workshop/dcw')
  const nodes = (snap.data?.nodes ?? []).filter(n => n.lineId === line.ids.lineId && n.enabled !== false)
  if (nodes.length < 2) throw new Error('可写节点不足 2 个，无法做跨节点越权')
  const [a, b] = nodes
  const target = Object.values(line.daq)[0]
  const rows = []

  // ① 未绑定 Agent
  const u = await newChannelAgent(api, 'opencode', `u${Date.now().toString(36).slice(-4)}`)
  const unbound = await explore(api, u.instId, a.id, target, 1)
  rows.push({ case: 'unbound write', agent: 'U(no binding)', node: a.id, expect: 'reject', got: unbound.isError ? 'reject' : 'ACCEPTED', status: unbound.status, text: unbound.text })

  // ② 绑定后的控制项
  await bind(api, u.instId, a.id, 'dcw', 'auto')
  await bind(api, u.instId, target, 'daq', 'auto')
  await sleep(300)
  const bound = await explore(api, u.instId, a.id, target, 1)
  rows.push({ case: 'bound write (control)', agent: 'U(bound A)', node: a.id, expect: 'accept', got: bound.isError ? 'REJECTED' : 'accept', status: bound.status, text: bound.text })

  // ③ 跨节点越权
  const v = await newChannelAgent(api, 'opencode', `v${Date.now().toString(36).slice(-4)}`)
  await bind(api, v.instId, a.id, 'dcw', 'auto')
  await bind(api, v.instId, target, 'daq', 'auto')
  await sleep(300)
  await closeOpenRecords(api, b.id, 'L1 cross')
  const cross = await explore(api, v.instId, b.id, target, 1)
  rows.push({ case: 'cross-node write', agent: 'V(bound A)', node: b.id, expect: 'reject', got: cross.isError ? 'reject' : 'ACCEPTED', status: cross.status, text: cross.text })

  const pass = rows.every(r => r.got === r.expect)
  const md = [
    '# E4·L1 授权面一致性（Agent 工具面）',
    '',
    `- run: \`${rid}\` · base ${base} · scenario ${scenarioId} · line ${line.ids.lineId}`,
    `- 节点 A=${a.name}(${a.id}) · 节点 B=${b.name}(${b.id}) · 目标观测 ${target}`,
    '',
    '| 用例 | Agent | 目标节点 | 期望 | 实际 | 面板状态 | 回包（截断） |',
    '|---|---|---|---|---|---|---|',
    ...rows.map(r => `| ${r.case} | ${r.agent} | ${r.node} | ${r.expect} | **${r.got}** | ${r.status} | ${String(r.text).replaceAll('|', '/').slice(0, 90)} |`),
    '',
    pass ? '**判定：PASS** — 未绑定拒绝、绑定放行、跨节点越权拒绝。' : '**判定：FAIL** — 存在越权写被执行或控制项被误拒。',
    '',
  ].join('\n')

  mkdirSync(outDir, { recursive: true })
  writeFileSync(join(outDir, 'e4-authorization.csv'), [
    'case,agent,node,expect,got,status,text',
    ...rows.map(r => [r.case, r.agent, r.node, r.expect, r.got, r.status, String(r.text).split(/[\s]+/).join(' ').replaceAll(',', ';')].join(',')),
  ].join('\n'))
  writeFileSync(join(outDir, 'e4-authorization.md'), md)
  writeFileSync(join(outDir, 'run.json'), JSON.stringify({ runId: rid, at: new Date().toISOString(), base, simBase: SIM_BASE, scenarioId, lineId: line.ids.lineId, rows, pass, reproCmd: `node bench/experiment/authorization-probe.mjs --scenario ${scenarioId} --base ${base}` }, null, 2))
  console.log(`\n${md}`)
  console.log(`产物: ${outDir}`)
  if (!pass) process.exitCode = 1
}

main().catch((err) => { console.error(`\nFAIL: ${err?.message ?? err}`); process.exitCode = 1 })
