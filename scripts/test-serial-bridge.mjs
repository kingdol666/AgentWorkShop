/**
 * 回归测试 —— serial-bridge 串口协议插件(纯协议层 + RTU 事务客户端 + 假端口驱动契约 + 插件入口契约)。
 * 运行: node scripts/test-serial-bridge.mjs
 * 退出码: 0 全通过 / 1 有失败
 *
 * 无需真实串口硬件:RTU 客户端(rtu.mjs)以假 SerialPort(内存从站应答)驱动,
 * 驱动工厂(drivers.mjs)以注入 opener 构建,ASCII 行用假行端口;插件入口用桩 ctx
 * 验证注册契约与 API 路由。
 */
import { Buffer } from 'node:buffer'
import {
  crc16Modbus,
  buildRtuFrame,
  parseRtuFrame,
  decodeRegisters,
  encodeWords,
  engToRaw,
  rawToEng,
  extractLineValue,
  normalizeSerialConfig,
  registerOffset,
} from '../server/plugins-builtin/serial-bridge/lib.mjs'
import { createSerialDrivers } from '../server/plugins-builtin/serial-bridge/drivers.mjs'
import { createRtuClient } from '../server/plugins-builtin/serial-bridge/rtu.mjs'
import serialBridge from '../server/plugins-builtin/serial-bridge/index.mjs'

let pass = 0
let fail = 0
const check = (name, ok, detail = '') => {
  if (ok) {
    pass++
    console.log(`  PASS  ${name}`)
    return
  }
  fail++
  console.log(`  FAIL  ${name}${detail ? '  — ' + detail : ''}`)
}
const approx = (a, b, eps = 1e-4) => Math.abs(a - b) <= eps

console.log('\n━━━ 1. 纯协议层(lib.mjs) ━━━')
{
  // Modbus CRC16 已知向量:01 03 00 00 00 02 → C4 0B(Modbus 官方工具可复算)
  const crc = crc16Modbus(Buffer.from([0x01, 0x03, 0x00, 0x00, 0x00, 0x02]))
  check('CRC16 已知向量 01 03 00 00 00 02 → 0xC40B', crc === 0x0BC4, `got 0x${crc.toString(16)}`)

  const frame = buildRtuFrame(1, 3, [0x00, 0x00, 0x00, 0x02])
  check('RTU 帧构造(CRC lo/hi 序)', frame.length === 8 && frame[6] === 0xC4 && frame[7] === 0x0B, frame.toString('hex'))

  const parsed = parseRtuFrame(frame)
  check('RTU 帧解析(addr/func/data)', parsed.addr === 1 && parsed.func === 3 && parsed.data.length === 4)
  const bad = Buffer.from(frame)
  bad[2] ^= 0xFF
  check('RTU 帧篡改 → crc 错误', parseRtuFrame(bad).error === 'crc')
  check('RTU 短帧 → short', parseRtuFrame(Buffer.from([1, 2])).error === 'short')

  // 寄存器编解码:float32 123.456 全字节序 roundtrip(int16 零点用带符号验证)
  for (const byteOrder of ['big', 'little', 'wordSwap']) {
    const words = encodeWords(123.456, 'float32', byteOrder)
    const back = decodeRegisters(words, 'float32', byteOrder)
    check(`float32 ${byteOrder} 编解码互逆`, approx(words.length === 2 ? back : back, 123.456), `got ${back}`)
  }
  const i16 = decodeRegisters([0xFFFE], 'int16', 'big')
  check('int16 带符号解码 0xFFFE → -2', i16 === -2, `got ${i16}`)
  const u32 = decodeRegisters(encodeWords(3000000123, 'uint32', 'big'), 'uint32', 'big')
  check('uint32 3000000123 roundtrip', u32 === 3000000123, `got ${u32}`)

  // 与内置 modbus 驱动同规约:40001 → 偏移 0,30001 → 0
  check('registerOffset 40001→0 / 30001→0', registerOffset(40001, 'holding') === 0 && registerOffset(30001, 'input') === 0)

  // 工程量↔原始值线性映射(0~27648 ↔ 0~100)
  const cfg = { rawMin: 0, rawMax: 27648, engMin: 0, engMax: 100 }
  const raw = engToRaw(50, cfg)
  check('engToRaw 50 → 13824', approx(raw, 13824, 0.01), `got ${raw}`)
  check('rawToEng 互逆', approx(rawToEng(raw, cfg), 50, 1e-6))
  check('未配置量程直传', engToRaw(7.5, {}) === 7.5)

  // ASCII 行取值
  check('裸数字行', extractLineValue('25.3\n', '') === 25.3)
  check('JSON 无路径 → null(需配置 jsonPath,取值路径语义显式)', extractLineValue('{"temp": 21.5}', '') === null)
  check('JSON jsonPath', extractLineValue('{"data":{"temp":21.5}}', 'data.temp') === 21.5)
  check('JSON 数组下标路径', extractLineValue('{"arr":[1,2,9.5]}', 'arr.2') === 9.5)
  check('垃圾行 → null(跳帧)', extractLineValue('ERROR OVERHEAT', '') === null)
  check('空行 → null', extractLineValue('  \n', '') === null)

  // 配置规范化
  const n1 = normalizeSerialConfig({ path: 'COM3', register: 40001 })
  check('缺省补齐(mode/baud/type/byteOrder)', n1.errors.length === 0 && n1.cfg.mode === 'modbus-rtu' && n1.cfg.baudRate === 9600 && n1.cfg.dataType === 'float32' && n1.cfg.byteOrder === 'big')
  const n2 = normalizeSerialConfig({ mode: 'ascii-line' })
  check('ascii-line 不要求 register,仍要求 path', n2.errors.length === 1 && /path/.test(n2.errors[0]))
  const n3 = normalizeSerialConfig({ path: 'COM3', register: 1, mode: 'nope' })
  check('非法 mode 报错且回退 modbus-rtu', n3.cfg.mode === 'modbus-rtu' && n3.errors.some(e => /mode/.test(e)))
  const n4 = normalizeSerialConfig({ path: 'COM3', register: 40001, scale: 0 })
  check('scale=0 拒绝(除零保护)', n4.cfg.scale === 1)
}

console.log('\n━━━ 2. RTU 事务客户端(rtu.mjs,假 SerialPort 从站) ━━━')
{
  /** 内存 RTU 从站:以 EventEmitter 风格的假 SerialPort,写请求即回应答帧 */
  function makeFakeSerialSlave({ unitId = 7, holding = new Map(), corrupt = false, silent = false, badAddr = false } = {}) {
    const listeners = { data: [], error: [], close: [], open: [] }
    const port = {
      isOpen: false,
      on(ev, fn) { listeners[ev]?.push(fn) },
      once(ev, fn) { listeners[ev]?.push(fn) },
      write(buf, cb) {
        setImmediate(() => cb?.())
        if (silent) return
        const req = Buffer.from(buf)
        const func = req[1]
        const respAddr = badAddr ? unitId + 1 : unitId
        let resp
        if (func === 3 || func === 4) {
          const offset = req.readUInt16BE(2)
          const count = req.readUInt16BE(4)
          const data = Buffer.alloc(count * 2)
          for (let i = 0; i < count; i++) data.writeUInt16BE(holding.get(offset + i) ?? 0, i * 2)
          resp = Buffer.concat([Buffer.from([respAddr, func, count * 2]), data])
        }
        else if (func === 6) {
          resp = Buffer.from(req.subarray(0, 6))
        }
        else if (func === 16) {
          resp = Buffer.from([respAddr, func, req[2], req[3], req[4], req[5]])
        }
        else {
          resp = Buffer.from([respAddr, func | 0x80, 1])
        }
        if (corrupt) resp[resp.length - 1] ^= 0xFF
        const c = Buffer.alloc(2)
        c.writeUInt16LE(crc16Modbus(resp))
        const frame = Buffer.concat([resp, c])
        if (corrupt) frame[frame.length - 1] ^= 0xFF
        setImmediate(() => listeners.data.forEach(fn => fn(frame)))
      },
      close(cb) {
        port.isOpen = false
        listeners.close.forEach(fn => fn())
        setImmediate(() => cb?.())
      },
    }
    // autoOpen 语义:构造即异步发 open 事件(与真实 serialport 一致)
    setImmediate(() => {
      port.isOpen = true
      listeners.open.forEach(fn => fn())
    })
    return port
  }

  const regs = new Map([[0, 0x41D4], [1, 0x0000]]) // float32 big 26.5
  /** rtu.mjs 需要的是「类」(open() 内 new SerialPort(opts));构造器返回实例对象 */
  const mkClass = (opts = {}) => function FakeSerialPortClass() {
    return makeFakeSerialSlave({ holding: regs, ...opts })
  }
  const mk = (opts = {}) => createRtuClient(mkClass(opts), { path: 'FAKE', baudRate: 9600, dataBits: 8, stopBits: 1, parity: 'none', unitId: 7, timeoutMs: 400 })

  const client = mk()
  await client.open()
  check('RTU open 后 isOpen', client.isOpen === true)

  const r1 = await client.readHoldingRegisters(0, 2)
  check('RTU FC03 读保持寄存器(float32 字序)', r1.data.length === 2 && r1.data[0] === 0x41D4 && r1.data[1] === 0x0000, JSON.stringify(r1))

  const w1 = await client.writeRegister(5, 0xABCD)
  check('RTU FC06 写单寄存器(回显)', w1.value === 0xABCD, JSON.stringify(w1))

  const w2 = await client.writeRegisters(10, [1, 2, 3])
  check('RTU FC16 写多寄存器', w2.length === 3, JSON.stringify(w2))
  await client.close()
  check('RTU close 后 isOpen=false', client.isOpen === false)

  // 异常帧:专用假从站对一切请求回 func|0x80 + code=2(带合法 CRC)
  function ExceptionPortClass() {
    const __l = { data: [], error: [], close: [], open: [] }
    const port = {
      isOpen: false,
      on(ev, fn) { __l[ev].push(fn) },
      once(ev, fn) { __l[ev].push(fn) },
      write(buf, cb) {
        setImmediate(() => cb?.())
        const body = Buffer.from([7, Buffer.from(buf)[1] | 0x80, 2])
        const c = Buffer.alloc(2)
        c.writeUInt16LE(crc16Modbus(body))
        setImmediate(() => __l.data.forEach(fn => fn(Buffer.concat([body, c]))))
      },
      close(cb) { setImmediate(() => cb?.()) },
    }
    setImmediate(() => {
      port.isOpen = true
      __l.open.forEach(fn => fn())
    })
    return port
  }
  const exReal = createRtuClient(ExceptionPortClass, { path: 'FAKE', baudRate: 9600, dataBits: 8, stopBits: 1, parity: 'none', unitId: 7, timeoutMs: 400 })
  await exReal.open()
  let exErr = null
  await exReal.readHoldingRegisters(0, 1).catch(e => (exErr = e.message))
  check('RTU 异常帧 → exception code 错误', exErr?.includes('exception code=2'), exErr)

  const crcClient = mk({ corrupt: true })
  await crcClient.open()
  let crcErr = null
  await crcClient.readHoldingRegisters(0, 1).catch(e => (crcErr = e.message))
  check('RTU CRC 篡改 → CRC 错误', crcErr?.includes('CRC'), crcErr)

  const addrClient = mk({ badAddr: true })
  await addrClient.open()
  let addrErr = null
  await addrClient.readHoldingRegisters(0, 1).catch(e => (addrErr = e.message))
  check('RTU 从站地址不匹配 → 报错', addrErr?.includes('从站地址不匹配'), addrErr)

  const silentClient = mk({ silent: true })
  await silentClient.open()
  const t0 = Date.now()
  let timeoutErr = null
  await silentClient.readHoldingRegisters(0, 1).catch(e => (timeoutErr = e.message))
  check('RTU 无应答 → 硬超时(250ms)', timeoutErr?.includes('超时') && Date.now() - t0 < 1500, timeoutErr)
}

console.log('\n━━━ 3. 驱动契约(假端口,免硬件) ━━━')
{
  // 内存 Modbus 从站:保持寄存器阵列 + 写镜像
  function makeFakeRtu() {
    const holding = new Map()
    const input = new Map()
    const client = {
      isOpen: true,
      closed: false,
      setID() {},
      on() {},
      async readHoldingRegisters(offset, length) {
        const out = []
        for (let i = 0; i < length; i++) out.push(holding.get(offset + i) ?? 0)
        return { data: out }
      },
      async readInputRegisters(offset, length) {
        const out = []
        for (let i = 0; i < length; i++) out.push(input.get(offset + i) ?? 0)
        return { data: out }
      },
      async writeRegister(offset, value) { holding.set(offset, value & 0xFFFF) },
      async writeRegisters(offset, words) { words.forEach((w, i) => holding.set(offset + i, w & 0xFFFF)) },
      async close() {
        client.closed = true
        client.isOpen = false
      },
    }
    client.__holding = holding
    client.__input = input
    return client
  }

  // float32 26.5(0x41D40000)按 big 端写入保持寄存器 0
  const seedWords = (v) => {
    const b = Buffer.alloc(4)
    b.writeFloatBE(v, 0)
    return [(b[0] << 8) | b[1], (b[2] << 8) | b[3]]
  }

  const fake = makeFakeRtu()
  const w = seedWords(26.5)
  fake.__holding.set(0, w[0])
  fake.__holding.set(1, w[1])

  const linePort = {
    aliveRet: true,
    alive() { return this.aliveRet },
    latestRet: { text: '25.3', at: Date.now() },
    latest() { return this.latestRet },
    written: [],
    async writeLine(line) { this.written.push(line) },
    async close() {},
  }

  const factory = createSerialDrivers({
    openRtu: async () => fake,
    openLine: async () => linePort,
    isAvailable: () => true,
    log: { warn: () => {} },
  })

  const cfgRtu = { mode: 'modbus-rtu', path: 'COM9', baudRate: 19200, register: 40001, dataType: 'float32', byteOrder: 'big', scale: 1 }
  const v1 = await factory.readDriver.sample({ driverConfig: cfgRtu })
  check('sample: RTU float32 读数', approx(v1, 26.5), `got ${v1}`)

  const cfgRtuScaled = { ...cfgRtu, scale: 0.1 }
  const v2 = await factory.readDriver.sample({ driverConfig: cfgRtuScaled })
  check('sample: 缩放系数生效(26.5×0.1)', approx(v2, 2.65), `got ${v2}`)

  const cfgInput = { ...cfgRtu, registerType: 'input', register: 30001 }
  fake.__input.set(0, 100)
  const v3 = await factory.readDriver.sample({ driverConfig: { ...cfgInput, dataType: 'uint16' } })
  check('sample: 输入寄存器(3x)FC04', v3 === 100, `got ${v3}`)

  const cfgAscii = { mode: 'ascii-line', path: 'COM10', baudRate: 9600 }
  const v4 = await factory.readDriver.sample({ driverConfig: cfgAscii })
  check('sample: ASCII 行取值', v4 === 25.3, `got ${v4}`)

  linePort.latestRet = { text: '{"data":{"t":-3.5}}', at: Date.now() }
  const v5 = await factory.readDriver.sample({ driverConfig: { ...cfgAscii, jsonPath: 'data.t' } })
  check('sample: ASCII JSON 路径 + 负值', v5 === -3.5, `got ${v5}`)

  linePort.latestRet = { text: '99', at: Date.now() - 60_000 }
  const v6 = await factory.readDriver.sample({ driverConfig: { ...cfgAscii, staleMs: 30000 } })
  check('sample: 保鲜窗外 → null 跳帧', v6 === null, `got ${v6}`)

  // 写 + 回读校验(0~27648 ↔ 0~100 映射)
  const cfgWrite = { mode: 'modbus-rtu', path: 'COM9', baudRate: 19200, register: 40001, dataType: 'uint16', byteOrder: 'big', rawMin: 0, rawMax: 27648, engMin: 0, engMax: 100 }
  const wr1 = await factory.writeDriver.write({ eng: 50, tolerance: 0.5, domain: { min: 0, max: 100 }, driverConfig: cfgWrite })
  check('write: 写+回读一致 ACK', wr1.ok === true && approx(wr1.readback, 50, 0.5), JSON.stringify(wr1))

  // 从站写入失真(写入值 ≠ 回读值,如从站寄存器故障)→ 回读不一致 → 拒绝 ACK
  const corruptRtu = makeFakeRtu()
  corruptRtu.writeRegister = async function (offset, value) {
    this.__holding.set(offset, (value + 1000) & 0xFFFF)
  }
  corruptRtu.writeRegisters = async function (offset, words) {
    words.forEach((w, i) => this.__holding.set(offset + i, (w + 1000) & 0xFFFF))
  }
  const corruptFactory = createSerialDrivers({
    openRtu: async () => corruptRtu,
    openLine: async () => linePort,
    isAvailable: () => true,
    log: { warn: () => {} },
  })
  const wr2 = await corruptFactory.writeDriver.write({ eng: 50, tolerance: 0.5, domain: { min: 0, max: 100 }, driverConfig: cfgWrite })
  check('write: 回读不一致 → 拒绝', wr2.ok === false && /不一致/.test(wr2.message), JSON.stringify(wr2))
  await corruptFactory.closeAll()

  // ASCII 写模板下行
  const wr3 = await factory.writeDriver.write({ eng: 42.5, tolerance: 0.5, domain: { min: 0, max: 100 }, driverConfig: { mode: 'ascii-line', path: 'COM10', writeTemplate: 'SET {v}' } })
  check('write: ASCII 模板下行(无回读诚实标注)', wr3.ok === true && linePort.written[0] === 'SET 42.5' && wr3.readback === null, JSON.stringify({ wr3, written: linePort.written }))

  // 连接测试
  const t1 = await factory.readDriver.test(cfgRtu)
  check('test: 通过并带回读数', t1.ok === true && t1.sampleValue != null, JSON.stringify(t1))
  const t2 = await factory.readDriver.test({ mode: 'modbus-rtu', path: '' })
  check('test: 缺 path 给可读错误', t2.ok === false && /path/.test(t2.message))
  const t3 = await factory.writeDriver.test(cfgWrite)
  check('test: 写驱动测试不触发真实写', t3.ok === true, JSON.stringify(t3))

  // meta 自描述(前端动态表单数据源)
  check('读驱动 meta.configFields 非空', Array.isArray(factory.readDriver.meta?.configFields) && factory.readDriver.meta.configFields.length >= 10)
  check('写驱动 meta.configFields 含量程映射', factory.writeDriver.meta.configFields.some(f => f.key === 'rawMax'))

  // 串行队列:前一事务阻塞时后续排队(契约:同一物理链路不并发)
  let busy = 0
  let maxBusy = 0
  const slowFactory = createSerialDrivers({
    openRtu: async () => ({
      isOpen: true,
      setID() {},
      on() {},
      async readHoldingRegisters() {
        busy++
        maxBusy = Math.max(maxBusy, busy)
        await new Promise(r => setTimeout(r, 20))
        busy--
        return { data: [1, 2] }
      },
      async close() {},
    }),
    openLine: async () => linePort,
    isAvailable: () => true,
    log: { warn: () => {} },
  })
  const cfgSlow = { mode: 'modbus-rtu', path: 'COMX', register: 40001 }
  await Promise.all([
    slowFactory.readDriver.sample({ driverConfig: cfgSlow }),
    slowFactory.readDriver.sample({ driverConfig: cfgSlow }),
    slowFactory.readDriver.sample({ driverConfig: cfgSlow }),
  ])
  check('同链路事务串行化(无并发读)', maxBusy === 1, `maxBusy=${maxBusy}`)

  await factory.closeAll()
  check('closeAll 关闭串口连接', fake.closed === true)
}

console.log('\n━━━ 3. 插件入口契约(index.mjs + 桩 ctx) ━━━')
{
  const registered = { daqDrivers: [], dcwDrivers: [], routes: new Map(), tools: [], disposed: [] }
  const ctx = {
    name: 'serial-bridge',
    logger: { info: () => {}, warn: m => console.warn('    [log]', m), error: () => {} },
    daq: {
      registerDriver: d => registered.daqDrivers.push(d),
      nodes: async () => [{ id: 'n1', name: '炉温', driver: 'serial', enabled: true, lineId: 'L1', driverConfig: { path: 'COM3' } }],
    },
    dcw: { registerWriteDriver: d => registered.dcwDrivers.push(d) },
    route: (method, path, handler) => registered.routes.set(`${method} ${path}`, handler),
    omp: { registerTool: t => registered.tools.push(t) },
    onDispose: fn => registered.disposed.push(fn),
    http: {},
  }
  await serialBridge.setup(ctx)

  check('数采读驱动已注册(kind=serial)', registered.daqDrivers.length === 1 && registered.daqDrivers[0].kind === 'serial')
  check('写控驱动已注册(kind=serial)', registered.dcwDrivers.length === 1 && registered.dcwDrivers[0].kind === 'serial')
  check('驱动 available 探测可用(serialport 已安装)', await registered.daqDrivers[0].available() === true)
  check('API 路由已注册(health/ports/probe)', ['GET /health', 'GET /ports', 'POST /probe'].every(k => registered.routes.has(k)))
  check('omp 工具已注册(serial_ports)', registered.tools.length === 1 && registered.tools[0].name === 'serial_ports')
  check('dispose 已登记(串口回收)', registered.disposed.length >= 1)

  const health = await registered.routes.get('GET /health')()
  check('GET /health:可用性 + 串口节点识别', health.available === true && health.readNodes.length === 1 && health.readNodes[0].path === 'COM3', JSON.stringify(health))
  const ports = await registered.routes.get('GET /ports')()
  check('GET /ports:系统串口枚举(免硬件)', ports.success === true && Array.isArray(ports.ports), JSON.stringify(ports).slice(0, 120))
  const probe1 = await registered.routes.get('POST /probe')({ awBody: { mode: 'modbus-rtu' } })
  check('POST /probe:缺参数给可读错误', probe1.success === false && /path/i.test(probe1.error))
  const probe2 = await registered.routes.get('POST /probe')({ awBody: { mode: 'ascii-line', path: 'COM_NOT_EXIST_42', timeoutMs: 800 } })
  check('POST /probe:不存在的串口给可行动诊断', probe2.success === true && probe2.ok === false && /串口/.test(probe2.message), JSON.stringify(probe2))

  const tool = registered.tools[0]
  const r = await tool.handler({})
  check('serial_ports 工具返回诊断文本', r.text.includes('可用性') && r.text.includes('炉温'), r.text)
}

console.log(`\n━━━ 结果: ${pass} 通过 / ${fail} 失败 ━━━`)
process.exit(fail ? 1 : 0)
