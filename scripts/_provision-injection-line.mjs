/**
 * 临时:在指定平台实例上**供给注塑场景产线**(PLC 模拟器 → 平台线/产品/DAQ/DCW/配方/开跑)。
 *
 * 为什么需要:`real-injection-closed-loop.mjs` 与 `_run-real-injection-fifo-goals.mjs` 是
 * "真实注塑闭环 + FIFO goal 多任务" 的实测脚本,但它们**不自建产线** —— 要求现场已存在
 * 名字含「注塑/injection」且节点齐全的线。供给逻辑在 bench/lib/scenarios.mjs 里
 * (ensureScenarioLine 装载模拟器场景 → provisionScenarioLine 建线并开跑)。
 *
 * 用法:
 *   AW_BASE=http://127.0.0.1:3300 AW_ADMIN_EMAIL=admin@awshop.local AW_ADMIN_PASS=admin123 \
 *   SIM_BASE=http://127.0.0.1:4010 node scripts/_provision-injection-line.mjs [sfx]
 */
import { SCENARIOS, ensureScenarioLine, provisionScenarioLine } from '../bench/lib/scenarios.mjs'
import { makeApi } from '../bench/lib/util.mjs'

process.env.SIM_BASE = process.env.SIM_BASE ?? 'http://127.0.0.1:4010'
const BASE = process.env.AW_BASE ?? 'http://127.0.0.1:3300'
const sfx = process.argv[2] ?? `p${Date.now().toString(36).slice(-5)}`

const api = makeApi(BASE)
const login = await api.login(
  process.env.AW_ADMIN_EMAIL ?? 'admin@awshop.local',
  process.env.AW_ADMIN_PASS ?? 'admin123',
)
if (!login.ok) {
  console.error('✘ 平台鉴权失败:', JSON.stringify(login).slice(0, 200))
  process.exit(1)
}
console.log('✔ 平台鉴权 OK', BASE)

await ensureScenarioLine(SCENARIOS.injection)
console.log('✔ 模拟器场景已装载(injection)')

const rec = await provisionScenarioLine(api, SCENARIOS.injection, { sfx })
console.log(`✔ 建线完成 name=${rec.lineName} reused=${rec.reused}`)
console.log(`  dcw=${JSON.stringify(rec.dcw)}`)
console.log(`  daq=${JSON.stringify(rec.daq)}`)
console.log(`  errors=${JSON.stringify(rec.errors ?? [])}`)
if (rec.lineId ?? rec.ids?.line) console.log(`  lineId=${rec.lineId ?? rec.ids?.line}`)
