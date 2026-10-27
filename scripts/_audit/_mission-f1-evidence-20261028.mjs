/**
 * 2026-10-28 缺陷取证:F1 平台 DCW(OPC UA)写与模拟器 signal 存储双向失联。
 * 复现三步(全部落 JSON 证据):
 *  1) REST manual 写 85 → signal=85, 但 OPC UA 变量读仍 55(旧值)
 *  2) 平台 DCW 写 56.5 → 回读"一致"(变量 echo), signal 仍 85(植物未收到)
 *  3) 物理验证: signal 真到 85 时 weight=33.45(模型一致) → 植物链路本身正常
 * 证据: docs/audit/evidence/2026-10-28-full-acceptance-run2/f1-opcua-signal-divergence.json
 */
import { writeFileSync, mkdirSync } from 'node:fs'

process.env.NO_PROXY = '127.0.0.1,localhost'
const SIM = 'http://127.0.0.1:4020'
const BASE = 'http://127.0.0.1:3470'
const NODE = 'inj-inject-opcua'
const OUT = 'docs/audit/evidence/2026-10-28-full-acceptance-run2/f1-opcua-signal-divergence.json'
const sleep = ms => new Promise(r => setTimeout(r, ms))
const getNodes = async () => {
  const j = await fetch(`${SIM}/api/nodes`).then(r => r.json())
  const ns = j.data?.nodes ?? j.data ?? j
  return (Array.isArray(ns) ? ns : []).find(n => n.id === NODE)
}
const signalOf = (n, id) => (n?.signals ?? []).find(s => s.id === id)?.value
const login = await fetch(`${BASE}/api/users/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'admin@mission.local', password: 'Mission#2026Acc' }) }).then(r => r.json())
const TOK = login.data.token

const evidence = { finding: 'F1 OPC UA 变量与 signal 存储双向失联(疑似未提交子模块回归)', at: new Date().toISOString(), steps: [] }

// 步骤 0:当前状态
let n = await getNodes()
evidence.steps.push({ step: 0, note: '初态', signal_hold_pressure: signalOf(n, 'hold-pressure-sp'), signal_weight: signalOf(n, 'part-weight') })

// 步骤 1:REST manual 写 85(已是 85) → 读平台侧(OPC UA 变量)
await fetch(`${SIM}/api/nodes/${NODE}/signals/hold-pressure-sp/manual`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ value: 85 }) })
n = await getNodes()
await sleep(4000)
const platRd1 = await fetch(`${BASE}/api/workshop/dcw/dw-05bba123/read`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${TOK}` }, body: '{}' }).then(r => r.json())
evidence.steps.push({ step: 1, note: 'REST 写 85 后:signal vs 平台读', simSignal: signalOf(n, 'hold-pressure-sp'), platformRead: platRd1.data?.read?.value, diverged: signalOf(n, 'hold-pressure-sp') !== platRd1.data?.read?.value })

// 步骤 2:平台写 57(合规小步) → 读 signal
const w = await fetch(`${BASE}/api/workshop/dcw/dw-05bba123/write`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${TOK}` }, body: JSON.stringify({ value: 57 }) }).then(r => r.json())
await sleep(6000)
n = await getNodes()
evidence.steps.push({ step: 2, note: '平台写 57 后:平台回读 vs signal', platformOutcome: w.data?.outcome?.message?.slice(0, 80), platformReadback: w.data?.outcome?.readback, simSignal: signalOf(n, 'hold-pressure-sp'), diverged: signalOf(n, 'hold-pressure-sp') !== 57 })

// 步骤 3:物理验证记录(此前实验:signal=85 时 weight=33.45)
evidence.steps.push({ step: 3, note: '物理验证(前序实验)', simSignal85_weight: 33.45, modelExpected: '31.0+0.052×45+0.05×4+melt修正 ≈ 33.5', conclusion: '植物模型链路正常;失联发生在 OPC UA 变量↔signal 同步层' })

// 清理:恢复基线 55
await fetch(`${SIM}/api/nodes/${NODE}/signals/hold-pressure-sp/manual`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ value: 55 }) })
n = await getNodes()
evidence.cleanup = { simSignal: signalOf(n, 'hold-pressure-sp') }

mkdirSync('docs/audit/evidence/2026-10-28-full-acceptance-run2', { recursive: true })
writeFileSync(OUT, JSON.stringify(evidence, null, 2))
for (const s of evidence.steps) console.log(JSON.stringify(s).slice(0, 200))
console.log(`→ ${OUT}`)
