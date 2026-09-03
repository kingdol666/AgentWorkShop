/**
 * Agent × 数采 × 数控 全闭环真机验证(进程内平台 + 真实 Modbus 接线):
 * 完整产线运营流(建线/产品/配方,开跑后配方参数经真实 Modbus 写入)。
 * Agent 工具闭环:dcw_read 取证,dcw_control 调温,数采 PV 跟随收敛,daq_query 取证序列。
 * 数据目录 AW_HOME 隔离;PLC 模拟器为本脚本子进程(15041)。
 * 运行: npx tsx --tsconfig .nuxt/tsconfig.server.json scripts/_dbg-plc-agent-loop.ts
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startPlcSim } from './_lib-plc-sim-child.mjs'

const awHome = mkdtempSync(join(tmpdir(), 'aw-plc-loop-'))
process.env.AW_MODE = 'home'
process.env.AW_HOME = awHome
process.env.NO_PROXY = '127.0.0.1,localhost'

let failures = 0
const check = (name: string, ok: boolean, detail = ''): void => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures += 1
}
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

// ===== 启动 PLC 模拟器(子进程,固定端口) =====
const PLC_PORT = 15041
const sim = startPlcSim(PLC_PORT)
const simReady = await sim.ready
check('PLC 模拟器就绪(15041)', simReady)

// ===== 平台装配(隔离配置根;真实产线运营流) =====
const { getDcwController } = await import('../server/services/workshop/dcw/dcw-controller')
const { getDaqController } = await import('../server/services/workshop/daq/daq-controller')
const { bindDaqHost } = await import('../server/services/workshop/daq/host-bindings')
const { getAgentNodeBindingRepo } = await import('../server/services/workshop/agents/node-bindings.repo')

// 数采网关的宿主端口(WS 广播 + 产线运行门控)由 REST 路由绑定;harness 无路由,手动绑定
bindDaqHost(() => {})

const AGENT = 'agent-plc-loop'
const dcw = getDcwController()
const daq = getDaqController()

const line = dcw.createLine({ name: 'PLC 闭环验证线' })
const product = dcw.createProduct({ name: '闭环验证产品', lineId: line.id })
const mbSp = { host: '127.0.0.1', port: PLC_PORT, unitId: 1, register: 40021, dataType: 'float32', byteOrder: 'big' }
const mbPv = { host: '127.0.0.1', port: PLC_PORT, unitId: 1, register: 40001, registerType: 'holding', dataType: 'float32', byteOrder: 'big' }
const spNode = dcw.create({ templateRef: 'dcw-temp-sp', name: '烘箱温度设定', driver: 'modbus-tcp', driverConfig: mbSp, min: 0, max: 300, lineId: line.id })
const pvNode = daq.create({ templateRef: 'daq-temp-tc', name: '烘箱温度PV', driver: 'modbus-tcp', driverConfig: mbPv, lineId: line.id })
const recipe = dcw.createRecipe({ productId: product.id, name: 'A-闭环工艺', params: [{ nodeId: spNode.id, value: 160, min: 100, max: 200 }], daqWindows: [{ nodeId: pvNode.id, min: 0, max: 400 }] })
const repo = getAgentNodeBindingRepo()
repo.bind(AGENT, spNode.id, 'dcw', 'auto')
repo.bind(AGENT, pvNode.id, 'daq', 'auto')
console.log(`line=${line.id} sp=${spNode.id} pv=${pvNode.id}\n`)

// ===== ① 开跑:配方参数 160 经真实 Modbus 写入 =====
const run = await dcw.lineStart(line.id, recipe.id)
const spResult = run.results.find(r => r.nodeId === spNode.id)
check('①开跑下发配方参数(160 → 真实 PLC,回读一致)', spResult?.ok === true, spResult?.message.slice(0, 80))

// ===== ② Agent 闭环:观察 PV 收敛 → 调温 → 复核 =====
const { OmpRpcAgentImpl } = await import('../server/services/workshop/agents/omp-agent')
const impl = new OmpRpcAgentImpl({ agentId: AGENT, name: '闭环调控员', role: 'worker', channelId: 'ch-plc-loop' })
;(impl as unknown as { workspace: unknown }).workspace = { listAgents: async () => [] }
const handle = (impl as unknown as Record<string, (req: unknown) => Promise<{ text: string, isError?: boolean }>>).handleHostTool.bind(impl)

const pvOf = (): number | null => daq.byId(pvNode.id)?.value ?? null
let pv = pvOf()
const t0 = Date.now()
while ((pv == null || pv < 120) && Date.now() - t0 < 90_000) {
  await sleep(3000)
  pv = pvOf()
}
check('②开跑后 PV 向 160 收敛(越过 120℃)', pv != null && pv > 120, `PV=${pv} 耗时=${Math.round((Date.now() - t0) / 1000)}s`)

const r1 = await handle({ toolName: 'dcw_read', arguments: { node_id: spNode.id } })
check('③dcw_read 取证:ACT ≈ 配方设定 160', !r1.isError && /160/.test(r1.text) && /一致/.test(r1.text), r1.text.replace(/\n/g, ' ').slice(0, 110))

const w = await handle({ toolName: 'dcw_control', arguments: { node_id: spNode.id, value: 180, hypothesis: '提温 20℃ 预期 PV 跟随上升,60s 后复测' } })
check('④Agent 联锁内调温 180(开优化记录)', !w.isError && /下发成功/.test(w.text), w.text.replace(/\n/g, ' ').slice(0, 110))

let pv2: number | null = null
const t1 = Date.now()
while (Date.now() - t1 < 120_000) {
  await sleep(4000)
  pv2 = pvOf()
  if (pv2 != null && pv2 >= 172) break
}
check('⑤调温后 PV 跟随收敛 ≥172℃(真实闭环)', pv2 != null && pv2 >= 172, `PV=${pv2} 耗时=${Math.round((Date.now() - t1) / 1000)}s`)

const r2 = await handle({ toolName: 'dcw_read', arguments: { node_id: spNode.id } })
check('⑥dcw_read 复核:ACT=180 与 SET 一致', !r2.isError && /180/.test(r2.text) && /一致/.test(r2.text), r2.text.replace(/\n/g, ' ').slice(0, 110))

const q = await handle({ toolName: 'daq_query', arguments: { node_id: pvNode.id, last_minutes: 5 } })
check('⑦daq_query 取证序列含 PV 数据', !q.isError && /(avg|min|max|样本|latest|最近)/i.test(q.text), q.text.replace(/\n/g, ' ').slice(0, 110))

const deny = await handle({ toolName: 'dcw_control', arguments: { node_id: spNode.id, value: 350 } })
check('⑧越量程调温被拒(350 ∉ [0,300])', deny.isError === true && /越出|量程/.test(deny.text))

sim.kill()
console.log(failures === 0 ? '\nPLC-AGENT-LOOP ALL PASS' : `\nPLC-AGENT-LOOP FAILED(${failures})`)
process.exit(failures === 0 ? 0 : 1)
