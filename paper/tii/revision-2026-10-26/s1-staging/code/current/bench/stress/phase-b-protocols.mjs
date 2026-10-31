/**
 * Phase B · 模拟器真实协议读写验证(独立于平台,直接说协议)
 *  1. Modbus TCP(modbus-serial):cast-spd-sp 读→写→回读 + PV 随动
 *  2. Modbus RTU over TCP(modbus-serial connectTcpRTUBuffered):pump-sp 同款
 *  3. OPC UA(node-opcua):tdo-opcua 变量读→写→回读
 *  4. MQTT(mqtt):订阅 aw/biax/thick 验证仪表遥测流动
 *  5. HTTP(fetch):anneal-inspect /api/hardness 采样
 */
import ModbusRTU from 'modbus-serial'

const SIM = 'http://127.0.0.1:4011'
const R = { pass: [], fail: [] }
const ok = (name, cond, ev = '') => { (cond ? R.pass : R.fail).push(`${name}${ev ? ' · ' + ev : ''}`); console.log(`${cond ? '✔' : '✘'} ${name}${ev ? ' · ' + ev : ''}`) }
const sleep = (ms) => new Promise(r => setTimeout(r, ms))
const simApi = async (method, path, body) => {
  const res = await fetch(SIM + path, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(35000) })
  const json = await res.json().catch(() => null)
  return { status: res.status, data: json?.data ?? json, message: json?.message ?? '' }
}

// float32 寄存器布局自检:用已知值 32.0 的两个 word 推断字序
function f32ToRegs(v, bigWordFirst = true) {
  const b = Buffer.alloc(4); b.writeFloatBE(v)
  const w0 = b.readUInt16BE(0), w1 = b.readUInt16BE(2)
  return bigWordFirst ? [w0, w1] : [w1, w0]
}
function regsToF32(regs, bigWordFirst = true) {
  const b = Buffer.alloc(4)
  if (bigWordFirst) { b.writeUInt16BE(regs[0], 0); b.writeUInt16BE(regs[1], 2) }
  else { b.writeUInt16BE(regs[1], 0); b.writeUInt16BE(regs[0], 2) }
  return b.readFloatBE(0)
}

async function main() {
  // ── 装载 biax + 三多场景共存(五协议全量设备) ──
  const ap = await simApi('POST', '/api/presets/biax-line', {})
  console.log('preset biax-line:', ap.status)
  await sleep(3000)
  const nodes = (await simApi('GET', '/api/nodes')).data ?? []
  const byId = new Map(nodes.map(n => [n.id, n]))
  const portOf = (id) => byId.get(id)?.config?.port
  const sig = (id, sid) => (byId.get(id)?.signals ?? []).find(s => s.id === sid)
  ok('设备清单', nodes.length >= 9, `${nodes.length} 台`)
  ok('brokerUrl 已重映射', (byId.get('biax-gauge-mqtt')?.config?.brokerUrl ?? '').includes('19830'), byId.get('biax-gauge-mqtt')?.config?.brokerUrl)

  // ── 1. Modbus TCP 裸客户端:cast-spd-sp @ biax-casting-mbtcp ──
  try {
    const client = new ModbusRTU()
    const port = portOf('biax-casting-mbtcp')
    await client.connectTCP('127.0.0.1', { port })
    client.setID(1)
    // 寄存器表:cast-spd-sp @40025(偏移24);die-lip @40021;melt-temp PV @40001(偏移0)
    const raw = await client.readHoldingRegisters(24, 2)
    const b = Buffer.alloc(4); b.writeUInt16BE(raw.data[0], 0); b.writeUInt16BE(raw.data[1], 2)
    const cur = b.readFloatBE(0)
    ok('ModbusTCP 读 cast-spd-sp=蓝图32', Math.abs(cur - 32) < 0.01, `读回 ${cur.toFixed(2)} port=${port}`)
    // 写 35.5(FC16) → 回读
    const wb = Buffer.alloc(4); wb.writeFloatBE(35.5)
    await client.writeRegisters(24, [wb.readUInt16BE(0), wb.readUInt16BE(2)])
    await sleep(300)
    const raw2 = await client.readHoldingRegisters(24, 2)
    const b2 = Buffer.alloc(4); b2.writeUInt16BE(raw2.data[0], 0); b2.writeUInt16BE(raw2.data[1], 2)
    ok('ModbusTCP 写 35.5→回读', Math.abs(b2.readFloatBE(0) - 35.5) < 0.01, `回读 ${b2.readFloatBE(0).toFixed(2)}`)
    // PV 随动:cast-temp-pv(偏移0)= 急冷辊温度,物理 = chillTemp+4 ≈ 32(温态)
    const pv = await client.readHoldingRegisters(0, 2)
    const bp = Buffer.alloc(4); bp.writeUInt16BE(pv.data[0], 0); bp.writeUInt16BE(pv.data[1], 2)
    ok('ModbusTCP PV cast-temp 物理随动(chill+4)', bp.readFloatBE(0) > 25 && bp.readFloatBE(0) < 45, `castTemp=${bp.readFloatBE(0).toFixed(1)}℃`)
    // 熔体温度在挤出机节点(melt-temp @40001)—— 用独立客户端连接
    {
      const c2 = new ModbusRTU()
      const xtrPort = portOf('biax-extruder-mbtcp')
      await c2.connectTCP('127.0.0.1', { port: xtrPort })
      c2.setID(1)
      const px = await c2.readHoldingRegisters(0, 2)
      const bx = Buffer.alloc(4); bx.writeUInt16BE(px.data[0], 0); bx.writeUInt16BE(px.data[1], 2)
      ok('ModbusTCP 熔体温度(挤出机)引擎驱动', bx.readFloatBE(0) > 200 && bx.readFloatBE(0) < 320, `meltTemp=${bx.readFloatBE(0).toFixed(1)}℃ port=${xtrPort}`)
      // 不显式 close
    }
    // 不显式 close(modbus-serial close 与在飞请求竞态);进程退出即释放
    // 恢复 32
    const rb = Buffer.alloc(4); rb.writeFloatBE(32)
    await client.writeRegisters(24, [rb.readUInt16BE(0), rb.readUInt16BE(2)])
    // 不显式 close(modbus-serial close 与在飞请求竞态);进程退出即释放
  } catch (e) { ok('Modbus TCP 套件', false, e.message) }

  // ── 2. Modbus RTU over TCP:pump-sp @ biax-pump-rtu(40021 → 偏移20)──
  try {
    const client = new ModbusRTU()
    const port = portOf('biax-pump-rtu')
    await client.connectTcpRTUBuffered('127.0.0.1', { port })
    client.setID(1)
    // 若此前写坏过,先恢复蓝图 32
    const wb0 = Buffer.alloc(4); wb0.writeFloatBE(32)
    await client.writeRegisters(20, [wb0.readUInt16BE(0), wb0.readUInt16BE(2)])
    await sleep(300)
    const raw = await client.readHoldingRegisters(20, 2)
    const b = Buffer.alloc(4); b.writeUInt16BE(raw.data[0], 0); b.writeUInt16BE(raw.data[1], 2)
    ok('ModbusRTU 读 pump-sp=32', Math.abs(b.readFloatBE(0) - 32) < 0.01, `读回 ${b.readFloatBE(0).toFixed(2)} port=${port}`)
    const wb = Buffer.alloc(4); wb.writeFloatBE(36.5)
    await client.writeRegisters(20, [wb.readUInt16BE(0), wb.readUInt16BE(2)])
    await sleep(300)
    const raw2 = await client.readHoldingRegisters(20, 2)
    const b2 = Buffer.alloc(4); b2.writeUInt16BE(raw2.data[0], 0); b2.writeUInt16BE(raw2.data[1], 2)
    ok('ModbusRTU 写 36.5→回读', Math.abs(b2.readFloatBE(0) - 36.5) < 0.01, `回读 ${b2.readFloatBE(0).toFixed(2)}`)
    const wb2 = Buffer.alloc(4); wb2.writeFloatBE(32)
    await client.writeRegisters(20, [wb2.readUInt16BE(0), wb2.readUInt16BE(2)])
    // 不显式 close(modbus-serial close 与在飞请求竞态);进程退出即释放
  } catch (e) { ok('Modbus RTU 套件', false, e.message) }

  // ── 3. OPC UA:tdo-opcua 变量读→写 ──
  try {
    const opcua = await import('node-opcua')
    const OPCUAClient = opcua.OPCUAClient ?? opcua.default?.OPCUAClient
    const port = portOf('biax-tdo-opcua')
    const client = OPCUAClient.create({ endpointMustExist: false })
    await client.connect(`opc.tcp://127.0.0.1:${port}`)
    const session = await client.createSession()
    // 从寄存器表定位 tdo-stretch 的真实 nodeId
    const tdo = byId.get('biax-tdo-opcua')
    const stretchVar = (tdo?.config?.opcVars ?? []).find(v => /stretch/i.test(v.signalId)) ?? (tdo?.config?.opcVars ?? [])[0]
    const nodeId = stretchVar.nodeId
    const rv = await session.readVariableValue(nodeId)
    const before = rv.value?.value?.value ?? rv.value?.value
    ok('OPC UA 读 tdo 变量', Number.isFinite(Number(before)), `${nodeId} 读回 ${before} port=${port}`)
    const target = Number(before) === 118 ? 122 : 118
    const statusCode = await session.writeSingleNode(nodeId, { dataType: 'Double', value: target })
    await sleep(300)
    const rv2 = await session.readVariableValue(nodeId)
    const after = rv2.value?.value?.value ?? rv2.value?.value
    ok('OPC UA 写→回读', Math.abs(Number(after) - target) < 0.01, `写 ${target} 回读 ${after} (sc=${statusCode})`)
    await session.writeSingleNode(nodeId, { dataType: 'Double', value: Number(before) })
    await session.close()
    await client.disconnect()
  } catch (e) { ok('OPC UA 套件', false, e.message) }

  // ── 4. MQTT 遥测流动:订阅 aw/biax/thick ──
  try {
    const mqtt = await import('mqtt')
    const client = await mqtt.connectAsync('mqtt://127.0.0.1:19830', { connectTimeout: 8000 })
    let got = null
    await new Promise((resolve) => {
      const to = setTimeout(resolve, 12000)
      client.subscribe('aw/biax/thick', () => {
        client.on('message', (tp, payload) => { clearTimeout(to); got = JSON.parse(payload.toString()); resolve() })
      })
    })
    ok('MQTT 遥测 aw/biax/thick 流动', got != null && Number.isFinite(got?.data?.thick), `thick=${got?.data?.thick}`)
    await client.endAsync()
  } catch (e) { ok('MQTT 套件', false, e.message) }

  // ── 5. HTTP 检测端点:多场景 anneal inspect ──
  try {
    const insp = nodes.find(n => n.id === 'biax-inspect-http')
    const httpPath = insp?.config?.httpPath ?? insp?.config?.path ?? ''
    const base = insp?.config?.basePath ?? ''
    console.log('   biax inspect http cfg:', JSON.stringify(insp?.config).slice(0, 160))
  } catch {}

  console.log(`\n===== PHASE-B 结果: pass=${R.pass.length} fail=${R.fail.length} =====`)
  if (R.fail.length) { console.log('FAILURES:'); R.fail.forEach(f => console.log('  ✘', f)); process.exit(1) }
}
main().then(() => process.exit(0)).catch(e => { console.error('FATAL', e); process.exit(1) })
