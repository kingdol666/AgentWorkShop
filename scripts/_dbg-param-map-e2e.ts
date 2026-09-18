/**
 * 工艺参数映射层 E2E(真实 PLC 模拟器连通):
 * ①节点创建自动生成工艺参数映射 + 参数面不透出 PLC 寻址细节
 * ②真实 Modbus TCP 从站(dev-plc-simulator,一阶惯性温度回路)参数写→回读 roundtrip
 * ③参数基准限界联锁(常驻层) ④产品限界 + 配方窗口分层联锁(产线运行期)
 * ⑤配方下发同样受限(run.results 记失败) ⑥Agent param_control/param_read(绑定/越权/消歧)
 * ⑦节点删除级联清理映射 ⑧运行中 plc-node-simulator(16040)导出配置连通性交叉验证
 * 数据目录 AW_HOME 隔离,不触碰检出内 .AgentWorkShop。
 * 运行: npx tsx --tsconfig .nuxt/tsconfig.server.json scripts/_dbg-param-map-e2e.ts
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
// @ts-expect-error 既有验证脚本助手(无类型声明)
import { startPlcSim } from './_lib-plc-sim-child.mjs'

// 进程级隔离:配置根落在一次性目录(须在业务模块 import 前设置)
const awHome = mkdtempSync(join(tmpdir(), 'aw-param-map-e2e-'))
process.env.AW_MODE = 'home'
process.env.AW_HOME = awHome
process.env.NO_PROXY = '127.0.0.1,localhost'

let failures = 0
const check = (name: string, ok: boolean, detail = ''): void => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures += 1
}

// ===== 真实 Modbus 从站(scripts/dev-plc-simulator.mjs:40021 温度SP / 40001 温度PV,float32 大端) =====
const SIM_PORT = 15040
const sim = startPlcSim(SIM_PORT)
const simReady: Promise<boolean> = sim.ready

// ===== 服务层导入(隔离根内) =====
const { getDcwController } = await import('../server/services/workshop/dcw/dcw-controller')
const { getDcwParamRepo } = await import('../server/services/workshop/dcw/param-map.repo')
const { getDcwLineRepo } = await import('../server/services/workshop/dcw/dcw-line.repo')
const { getDcwProductRepo } = await import('../server/services/workshop/dcw/dcw-product.repo')
const { getDcwRecipeRepo } = await import('../server/services/workshop/dcw/dcw-recipe.repo')
const { getAgentNodeBindingRepo } = await import('../server/services/workshop/agents/node-bindings.repo')
const { toolParamControl, toolParamRead } = await import('../server/services/workshop/agents/industrial-tools')

const ctrl = getDcwController()
const paramRepo = getDcwParamRepo()

/** 捕获 AppError 的消息与状态码 */
async function errOf(fn: () => Promise<unknown> | unknown): Promise<{ status: number, message: string }> {
  try {
    await fn()
    return { status: 0, message: '(未抛错)' }
  }
  catch (err) {
    const e = err as { status?: number, statusCode?: number, message?: string }
    return { status: e.status ?? e.statusCode ?? 500, message: e.message ?? String(err) }
  }
}

try {
  console.log('\n--- ① 节点创建 → 自动工艺参数映射(参数面语义) ---')
  if (!await simReady) throw new Error(`Modbus 模拟器未就绪(${SIM_PORT},可能端口被占)`)
  console.log(`  模拟器就绪 @ 127.0.0.1:${SIM_PORT}`)
  const line = getDcwLineRepo().create({ name: '参数映射验证线' })
  const node = ctrl.create({
    templateRef: 'dcw-temp-sp',
    name: 'PP验证·烘箱温度',
    driver: 'modbus-tcp',
    driverConfig: { host: '127.0.0.1', port: SIM_PORT, unitId: 1, register: 40021, dataType: 'float32', byteOrder: 'big' },
    min: 0,
    max: 300,
    readIntervalMs: 0,
    lineId: line.id,
  })
  const prow = paramRepo.byNode(node.id)
  check('节点创建自动生成工艺参数映射', !!prow && prow.key === 'temp-sp')
  const pview0 = paramRepo.listViews().find(p => p.nodeId === node.id)
  check('参数视图为语义面(无 driverConfig/寄存器/数据类型/字节序)', !!pview0
    && !('driverConfig' in (pview0 ?? {}))
    && !JSON.stringify(pview0).includes('register')
    && !JSON.stringify(pview0).includes('float32')
    && !JSON.stringify(pview0).includes('byteOrder'),
  JSON.stringify(pview0).slice(0, 120))
  check('参数视图携带驱动类别(仅类别)与产线归属', pview0?.driver === 'modbus-tcp' && pview0?.lineId === line.id)
  const pid = pview0!.id

  console.log('\n--- ② 真实 Modbus 参数写→回读 roundtrip(工程量纲直写) ---')
  const w1 = await ctrl.writeParam(pid, 180, { source: 'manual', actor: 'e2e', actorName: 'E2E' })
  check('参数写入成功(180℃)', w1.ok, w1.message)
  check('PLC 同址回读一致(标定后物理值)', w1.readback != null && Math.abs((w1.readback ?? 0) - 180) < 0.5, `readback=${w1.readback}`)
  check('执行节点设定值回填', ctrl.byId(node.id)?.value != null && Math.abs((ctrl.byId(node.id)!.value ?? 0) - 180) < 0.5)
  await ctrl.readParam(pid).then((r) => {
    check('参数读取成功(PLC 当前值)', r.ok && Math.abs((r.value ?? 0) - 180) < 0.5, `value=${r.value}`)
  })

  console.log('\n--- ③ 工艺参数基准限界(常驻层) ---')
  paramRepo.update(pid, { min: 100, max: 250 })
  const eHi = await errOf(() => ctrl.writeParam(pid, 260))
  check('超出基准限界 260 → 拒绝且点名参数层', eHi.status === 400 && eHi.message.includes('基准限界'), eHi.message.slice(0, 90))
  const eLo = await errOf(() => ctrl.writeParam(pid, 90))
  check('低于基准限界 90 → 拒绝', eLo.status === 400 && eLo.message.includes('基准限界'))
  const w2 = await ctrl.writeParam(pid, 200)
  check('限界内 200 → 通过', w2.ok)
  const eNode = await errOf(() => ctrl.write(node.id, 260))
  check('节点面直写越参数限界 → 同样拒绝(同一咽喉点)', eNode.status === 400 && eNode.message.includes('基准限界'))

  console.log('\n--- ④ 产品限界 + 配方窗口(产线运行期分层联锁) ---')
  const eBadKey = await errOf(() => ctrl.createProduct({ name: 'PP验证产品·坏键', lineId: line.id, paramLimits: { 'no-such-param': { min: 1, max: 2 } } }))
  check('产品限界引用不存在的参数键 → 400(防静默失效)', eBadKey.status === 400 && eBadKey.message.includes('no-such-param'))
  const eBadRange = await errOf(() => ctrl.createProduct({ name: 'PP验证产品·坏区间', lineId: line.id, paramLimits: { 'temp-sp': { min: 200, max: 150 } } }))
  check('产品限界 min>max → 400', eBadRange.status === 400)
  const product = ctrl.createProduct({
    name: 'PP验证产品',
    lineId: line.id,
    paramLimits: { 'temp-sp': { min: 150, max: 210 } },
  })
  check('产品限界设定成功(150~210)', (product.paramLimits?.['temp-sp']?.max ?? 0) === 210)
  const recipe = ctrl.createRecipe({
    productId: product.id,
    name: 'PP验证配方',
    params: [{ nodeId: node.id, value: 180, min: 160, max: 220 }],
  })
  const run = await ctrl.lineStart(line.id, recipe.id)
  check('产线开跑(批次激活)', !!run.id)
  const eProduct = await errOf(() => ctrl.writeParam(pid, 215))
  check('215 在参数限界内但超产品上限 210 → 拒绝且点名产品层', eProduct.status === 400 && eProduct.message.includes('产品'), eProduct.message.slice(0, 90))
  const eRecipe = await errOf(() => ctrl.writeParam(pid, 155))
  check('155 在产品限界内但低于配方下限 160 → 拒绝且点名配方层', eRecipe.status === 400 && eRecipe.message.includes('配方'), eRecipe.message.slice(0, 90))
  const w3 = await ctrl.writeParam(pid, 170)
  check('170 四层交集内 → 通过', w3.ok)
  const eNodeGate = await errOf(() => ctrl.write(node.id, 215))
  check('节点面直写 215 → 产品层同样拦截', eNodeGate.status === 400 && eNodeGate.message.includes('产品'))

  console.log('\n--- ⑤ 配方下发同样受限(run.results 记失败;产线保持运行) ---')
  ctrl.updateRecipe(recipe.id, { params: [{ nodeId: node.id, value: 215, min: 160, max: 220 }] }, { by: 'user', actor: 'e2e', actorName: 'E2E', description: '压到产品上限外验证下发拦截' })
  const run2 = await ctrl.applyRecipe(recipe.id)
  const r2 = run2.results[0] as { ok: boolean, message: string }
  check('配方参数 215 超产品上限 210 → 下发失败入档(不阻塞批次)', r2.ok === false && r2.message.includes('产品'), r2.message.slice(0, 90))
  ctrl.updateRecipe(recipe.id, { params: [{ nodeId: node.id, value: 180, min: 160, max: 220 }] }, { by: 'user', actor: 'e2e', actorName: 'E2E', description: '回退验证值' })
  const run3 = await ctrl.applyRecipe(recipe.id)
  check('配方参数 180 限界内 → 下发成功', (run3.results[0] as { ok: boolean }).ok === true)
  // 跨配方下发不误伤:配方乙自身窗口 [150,210] 值 155,低于活动批次配方甲窗口下限 160
  // —— 配方下发路径跳过配方层(自身窗口保存时已校验),产品/参数层照常 → 应放行
  const recipeB = ctrl.createRecipe({ productId: product.id, name: 'PP验证配方·乙', params: [{ nodeId: node.id, value: 155, min: 150, max: 210 }] })
  const runB = await ctrl.applyRecipe(recipeB.id)
  const rB = runB.results[0] as { ok: boolean, message: string }
  check('运行中应用配方乙(155 在甲窗口外、乙窗口内)→ 不被旧批次窗口误伤', rB.ok === true, rB.message.slice(0, 90))

  console.log('\n--- ⑥ Agent 参数面(param_control/param_read;批次运行中) ---')
  const AGENT = 'agent-pp-verify'
  getAgentNodeBindingRepo().bind(AGENT, node.id, 'dcw', 'auto')
  const t1 = await toolParamControl(AGENT, { param: 'temp-sp', value: 175 })
  check('param_control 按 key 下发成功(语义回包含参数名/有效区间)', !t1.isError && t1.text.includes('工艺参数') && t1.text.includes('有效写入区间'), t1.text.slice(0, 100))
  const t2 = await toolParamControl(AGENT, { param: 'temp-sp', value: 215 })
  check('param_control 超产品限界 → 拒绝(文案含产品层)', t2.isError === true && t2.text.includes('产品'), t2.text.slice(0, 100))
  const t3 = await toolParamControl(AGENT, { param: pid, value: 168 })
  check('param_control 按 pp-id 下发成功', !t3.isError)
  const t4 = await toolParamRead(AGENT, { param: 'temp-sp' })
  check('param_read 返回读数 + 限界区间', !t4.isError && t4.text.includes('PLC 读数'), t4.text.slice(0, 80))
  const t5 = await toolParamControl('agent-nobody', { param: 'temp-sp', value: 170 })
  check('未绑定 Agent → 拒绝', t5.isError === true)
  // 跨产线:第二条线同模板节点,key 产线内唯一
  const line2 = getDcwLineRepo().create({ name: '参数映射验证线·乙' })
  const node2 = ctrl.create({ templateRef: 'dcw-speed-sp', name: 'PP验证乙·速度', driver: 'mock', driverConfig: { key: `pp-e2e-2-${Date.now()}` }, readIntervalMs: 0, lineId: line2.id })
  check('第二产线节点自动映射(speed-sp)', paramRepo.byNode(node2.id)?.key === 'speed-sp')
  const t6 = await toolParamControl(AGENT, { param: 'speed-sp', value: 300 })
  check('未绑定节点的参数 → 拒绝(权限沿用节点绑定)', t6.isError === true, t6.text.slice(0, 80))

  console.log('\n--- ⑦ 级联:节点删除 → 参数映射自动清理 ---')
  ctrl.remove(node2.id)
  check('执行节点删除后映射移除', paramRepo.byNode(node2.id) == null)

  console.log('\n--- ⑧ 运行中 plc-node-simulator(16040)连通性交叉验证 ---')
  try {
    const res = await fetch('http://127.0.0.1:4010/api/nodes', { signal: AbortSignal.timeout(3000) }).then(r => r.json()) as { data?: Array<{ id: string, protocol: string }> }
    const mbNode = (res.data ?? []).find(n => n.protocol === 'modbus-tcp')
    if (mbNode) {
      const exp = await fetch(`http://127.0.0.1:4010/api/nodes/${mbNode.id}/export`, { signal: AbortSignal.timeout(3000) }).then(r => r.json()) as { data?: { items?: Array<{ driver: string, driverConfig: Record<string, unknown> }> } }
      const cfg = exp.data?.items?.[0]?.driverConfig
      const test = await ctrl.testDriver('modbus-tcp', cfg as Record<string, unknown>)
      check('五协议模拟器导出配置 → 网关连通测试通过', test.ok === true, JSON.stringify(cfg))
    }
    else {
      check('五协议模拟器连通性交叉验证', false, '无 modbus-tcp 设备(模拟器未启动或无预设)')
    }
  }
  catch (err) {
    check('五协议模拟器连通性交叉验证', false, `模拟器不可达:${err instanceof Error ? err.message : String(err)}`)
  }

  console.log('\n--- ⑨ 标准转换模式:线级双向换算验证(原始寄存器字核对) ---')
  const ModbusRTU = (await import('modbus-serial')).default
  const raw = new ModbusRTU()
  await raw.connectTCP('127.0.0.1', { port: SIM_PORT })
  raw.setID(1)
  // float32 直写模式:速度SP 40023(2 寄存器,大端)
  const f32 = ctrl.createParamMapping({
    key: 'oven_f32', templateRef: 'dcw-speed-sp', name: '转换验证·float32', lineId: line.id,
    access: { host: '127.0.0.1', port: SIM_PORT, unitId: 1, register: 40023, conversion: { mode: 'float32' } },
  })
  check('access 一键建映射:自动建节点+参数面+float32 模式留存', !!f32.nodeId && f32.conversion?.mode === 'float32', `${f32.id} → ${f32.nodeId}`)
  check('映射视图仍不透出 driverConfig', !JSON.stringify(f32).includes('driverConfig'))
  await ctrl.writeParam(f32.id, 320)
  const w32 = await raw.readHoldingRegisters(40023 - 40001, 2)
  const buf32 = Buffer.alloc(4)
  buf32.writeUInt16BE(w32.data[0]!, 0)
  buf32.writeUInt16BE(w32.data[1]!, 2)
  check('float32 直写:PLC 寄存器字 = float32BE(320)', Math.abs(buf32.readFloatBE(0) - 320) < 0.01, `words=[${w32.data}]`)
  // int16 线性标定模式:eng 0~50 ↔ raw 0~500,寄存器 40025(1 寄存器)
  const i16 = ctrl.createParamMapping({
    key: 'oven_i16', templateRef: 'dcw-tension-sp', name: '转换验证·int16标定', lineId: line.id,
    access: { host: '127.0.0.1', port: SIM_PORT, unitId: 1, register: 40025, conversion: { mode: 'int16-scaled', engMin: 0, engMax: 50, rawMin: 0, rawMax: 500 } },
  })
  await ctrl.writeParam(i16.id, 22)
  const w16 = await raw.readHoldingRegisters(40025 - 40001, 1)
  check('int16 线性标定写:eng 22 → 原始字 220(0.1 分辨率)', w16.data[0] === 220, `word=${w16.data[0]}`)
  // 读方向:原始字 300 → 工程值 30.0(接收同样自动换算)
  await raw.writeRegister(40025 - 40001, 300)
  const rd16 = await ctrl.readParam(i16.id)
  check('int16 线性标定读:原始字 300 → 工程值 30', rd16.ok && Math.abs((rd16.value ?? 0) - 30) < 0.01, `value=${rd16.value}`)
  // 非法转换模式在配置期即拒
  const eBadConv = await errOf(() => ctrl.createParamMapping({
    key: 'bad-conv', templateRef: 'dcw-temp-sp', lineId: line.id,
    access: { host: '127.0.0.1', register: 40021, conversion: { mode: 'int16-scaled' } as never },
  }))
  check('int16 标定缺量程 → 配置期 400 拒绝', eBadConv.status === 400, eBadConv.message.slice(0, 80))
  raw.close()

  console.log('\n--- 清理 ---')
  // removeLine 自带活动批次窗口停止;lineStop 为同步抛错方法,勿在此直调
  await ctrl.removeLine(line.id, { purge: true })
  await ctrl.removeLine(line2.id, { purge: true })
  check('产线 purge 后参数映射全部清理', paramRepo.listViews().filter(p => [line.id, line2.id].includes(p.lineId)).length === 0)
}
catch (err) {
  failures += 1
  console.error('\nE2E 异常中断:', err)
}
finally {
  sim.kill()
}

console.log(`\n${failures === 0 ? '✅ 全部通过' : `❌ ${failures} 项失败`}  (AW_HOME=${awHome})`)
process.exit(failures === 0 ? 0 : 1)
