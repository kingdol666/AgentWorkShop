#!/usr/bin/env node
/**
 * reference-integration —— 「独立集成方案」参照实现(E4 对照组)
 *
 * 目的:回答论文对照组问题——不走 AgentWorkShop,直接对一台 Modbus TCP 设备做
 * 「参数下发 + 回读验证」需要多少代码/多长时间,以及能提供多完整的证据链。
 * 实现:标准库 modbus-serial(独立集成者现实的作法),不经平台任何治理面。
 *
 * 范围(如实):只覆盖 **Modbus TCP 单设备单参数**(float32 holding register,两寄存器)。
 * OPC UA / MQTT / Modbus RTU(串口) / HTTP 各需额外的厂商栈——这正是被对照的集成成本本体。
 * 证据链对照:本参照能提供 = 自己的 stdout;不能提供 = 批次号/配方台账/操作归属/
 * HITL 审批记录/签名写历史/按产线检索 —— 这些是平台治理面提供的部分。
 *
 * 用法:node bench/reference-integration.mjs [--host 127.0.0.1] [--port 16052] [--unit 1]
 *       [--register 40021] [--value 268]
 */
import ModbusRTU from 'modbus-serial'

const args = process.argv.slice(2)
const arg = (k, d) => { const i = args.indexOf(`--${k}`); return i >= 0 ? (args[i + 1] ?? '') : d }
const CFG = {
  host: arg('host', '127.0.0.1'),
  port: Number(arg('port', '16052')),
  unitId: Number(arg('unit', '1')),
  register: Number(arg('register', '40021')) - 40001, // 6 位寄存器号 → 0 基地址
  value: Number(arg('value', '268')),
}

async function main() {
  const t0 = Date.now()
  const client = new ModbusRTU()
  await client.connectTCP(CFG.host, { port: CFG.port })
  client.setID(CFG.unitId)
  client.setTimeout(3000)
  console.log(`[ref] TCP 已连接 ${CFG.host}:${CFG.port} unit=${CFG.unitId}`)

  // float32 big-endian → 2 个 holding 寄存器
  const buf = Buffer.alloc(4)
  buf.writeFloatBE(CFG.value, 0)
  await client.writeRegisters(CFG.register, [buf.readUInt16BE(0), buf.readUInt16BE(2)])
  console.log(`[ref] 写入完成:register ${CFG.register} ← ${CFG.value}`)

  await new Promise(r => setTimeout(r, 800))
  const rr = await client.readHoldingRegisters(CFG.register, 2)
  const back = Buffer.from(rr.buffer).readFloatBE(0)
  console.log(`[ref] 回读:${back} ${Math.abs(back - CFG.value) <= 0.5 ? '(一致 ✔)' : '(不一致 ✘)'}`)

  await client.close()
  const wallMs = Date.now() - t0
  console.log('──── 独立集成参照 · 度量 ────')
  console.log('适配代码量:约 25 行核心逻辑(connect/write/read + float32 编解码;不含重连/队列/多参数/异常分类)')
  console.log(`运行耗时:${wallMs}ms(单次连接+写+读)`)
  console.log(`调用成功率:本次 ${Math.abs(back - CFG.value) <= 0.5 ? 1 : 0}/1(单点;无重复试验设计与统计)`)
  console.log('证据链:批号=无 · 配方台账=无 · 操作归属=无 · HITL 审批=无 · 签名历史=无 · 按产线检索=无 · 运行门=无 · 限界联锁=无')
  console.log('协议覆盖:modbus-tcp=本实现;modbus-rtu(串口栈)/opcua(节点栈)/mqtt(broker 栈)/http(有,但亦需自行拼鉴权与模板)各需另接——累计成本即对照结论')
}
main().catch(e => { console.error('[ref] 失败:', e.message); process.exit(1) })
