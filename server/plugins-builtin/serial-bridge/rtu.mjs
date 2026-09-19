/**
 * serial-bridge —— Modbus RTU 事务客户端(直接架在 serialport 之上)。
 *
 * 为什么不用 modbus-serial 的 connectRTUBuffered:其包装层与 nitro dev 的 worker
 * isolate 组合下触发 V8 HandleScope 原生崩溃(实测稳定复现,纯 serialport 打开同口
 * 正常)—— 详见 docs/plugins.md「已知边界」。本类用 lib.mjs 的 CRC16/帧编解码自行
 * 实现 FC03/FC04/FC06/FC16:连接级队列(drivers.mjs withConn)保证同链路同时只有
 * 一个事务,故「请求 → 等响应帧」的匹配无需复杂多路复用。
 *
 * 帧形态(RTU):
 *   请求  [addr, func, ...payload, crcLo, crcHi]
 *   读响应 addr, func, byteCount, data…, crc(8+2×words 字节)
 *   写响应 FC06 回显 8 字节;FC16 回 [addr, func, offsetHi, offsetLo, countHi, countLo, crc…]
 *   异常  addr, func|0x80, exceptionCode, crc(5 字节)
 */
import { buildRtuFrame, crc16Modbus } from './lib.mjs'

const hi8 = x => (x >> 8) & 0xFF
const lo8 = x => x & 0xFF

/**
 * @param {Function} SerialPort serialport 构造器(注入,便于测试)
 * @param {{ path, baudRate, dataBits, stopBits, parity, unitId, timeoutMs }} cfg
 */
export function createRtuClient(SerialPort, cfg) {
  let port = null
  let buffer = Buffer.alloc(0)
  /** 当前在飞事务的收帧器(连接级队列保证至多一个) */
  let waiter = null
  let dead = false

  /** 响应帧期望总长(-1 = 还差 byteCount 字节没法判) */
  function frameLength(func) {
    if ((func & 0x7F) === 3 || (func & 0x7F) === 4) return -1
    if ((func & 0x7F) === 6 || (func & 0x7F) === 16) return 8
    return 0
  }

  function feed(chunk) {
    buffer = Buffer.concat([buffer, chunk])
    if (!waiter) {
      buffer = Buffer.alloc(0)
      return
    }
    const min = 4
    if (buffer.length < min) return
    const func = buffer[1]
    let need
    if (func & 0x80) need = 5
    else {
      const fixed = frameLength(func)
      need = fixed >= 0 ? fixed : (buffer.length >= 3 ? 5 + buffer[2] : -1)
    }
    if (need < 0 || buffer.length < need) return
    const frame = buffer.subarray(0, need)
    buffer = Buffer.from(buffer.subarray(need))
    const w = waiter
    waiter = null
    const crc = frame.readUInt16LE(frame.length - 2)
    if (crc !== crc16Modbus(frame.subarray(0, frame.length - 2))) {
      w.reject(new Error('CRC 校验失败(CRC mismatch)'))
      return
    }
    if (frame[0] !== cfg.unitId) {
      w.reject(new Error(`响应从站地址不匹配(期望 ${cfg.unitId},收到 ${frame[0]})`))
      return
    }
    if (frame[1] & 0x80) {
      w.reject(new Error(`Modbus 异常响应 exception code=${frame[2]}(功能码 ${frame[1] & 0x7F})`))
      return
    }
    w.resolve(frame)
  }

  /** 单事务:写请求帧 → 等匹配响应帧(硬超时;连接级队列保证同时至多一个) */
  function transact(func, payload) {
    if (dead || !port || !port.isOpen) return Promise.reject(new Error('Port is not open'))
    return new Promise((resolveP, rejectP) => {
      const frame = buildRtuFrame(cfg.unitId, func, payload)
      const timer = setTimeout(() => {
        waiter = null
        rejectP(new Error(`Modbus 响应超时(${cfg.timeoutMs}ms)`))
      }, cfg.timeoutMs)
      waiter = {
        resolve: (f) => {
          clearTimeout(timer)
          resolveP(f)
        },
        reject: (e) => {
          clearTimeout(timer)
          rejectP(e)
        },
      }
      buffer = Buffer.alloc(0)
      port.write(frame, (err) => {
        if (err) {
          clearTimeout(timer)
          waiter = null
          rejectP(err)
        }
      })
    })
  }

  function wordsFrom(frame) {
    const byteCount = frame[2]
    const out = []
    for (let i = 0; i < byteCount / 2; i++) out.push(frame.readUInt16BE(3 + i * 2))
    return out
  }

  return {
    /** 打开串口(autoOpen;open/error 事件二选一收敛,硬超时由 cfg.timeoutMs 保护) */
    open() {
      return new Promise((resolveP, rejectP) => {
        port = new SerialPort({
          path: cfg.path,
          baudRate: cfg.baudRate,
          dataBits: cfg.dataBits,
          stopBits: cfg.stopBits,
          parity: cfg.parity,
          autoOpen: true,
        })
        const timer = setTimeout(() => rejectP(new Error(`串口打开超时(${cfg.timeoutMs}ms): ${cfg.path}@${cfg.baudRate}`)), cfg.timeoutMs)
        port.once('open', () => {
          clearTimeout(timer)
          resolveP()
        })
        port.once('error', (err) => {
          clearTimeout(timer)
          rejectP(err)
        })
        port.on('data', feed)
        const markDead = () => void (dead = true)
        port.on('error', markDead)
        port.on('close', markDead)
      })
    },
    /** modbus-serial 兼容面(drivers.mjs 零改动):isOpen、setID、读写方法、close */
    get isOpen() { return Boolean(port && port.isOpen && !dead) },
    setID() { /* 单连接绑定单从站:unitId 在 cfg 固定 */ },
    on() { /* 兼容位;端口错误已在内部标记 dead */ },
    async readHoldingRegisters(offset, length) {
      const f = await transact(3, [hi8(offset), lo8(offset), hi8(length), lo8(length)])
      return { data: wordsFrom(f) }
    },
    async readInputRegisters(offset, length) {
      const f = await transact(4, [hi8(offset), lo8(offset), hi8(length), lo8(length)])
      return { data: wordsFrom(f) }
    },
    async writeRegister(offset, value) {
      await transact(6, [hi8(offset), lo8(offset), hi8(value), lo8(value)])
      return { address: offset, value }
    },
    async writeRegisters(offset, words) {
      const byteCount = words.length * 2
      const payload = [hi8(offset), lo8(offset), hi8(words.length), lo8(words.length), byteCount, ...words.flatMap(w => [hi8(w), lo8(w)])]
      await transact(16, payload)
      return { address: offset, length: words.length }
    },
    close() {
      return new Promise((resolveP) => {
        if (!port || !port.isOpen) return resolveP()
        port.close(() => resolveP())
      })
    },
  }
}
