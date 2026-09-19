/**
 * serial-bridge —— 驱动工厂(串口读/写驱动;连接池 + 队列化事务)。
 *
 * createSerialDrivers({ openRtu, openLine, isAvailable, log }) 与具体串口实现解耦:
 *  - openRtu(cfg) → modbus-serial 客户端(RTU over 串口;connectRTUBuffered)
 *  - openLine(cfg) → { writeLine, close, latest } 行协议端口(serialport + readline)
 * 测试脚本注入假 opener 即可覆盖 sample/write/readback 全契约,无需真实硬件。
 *
 * 池语义与内置 modbus-tcp 驱动一致(同链路串行化、连续故障驱逐、空闲回收):
 *  - 池 key = mode|path@baud,parity,dataBits,stopBits(同一物理链路多节点复用);
 *  - withConn 队列:单事务硬超时(半开串口防悬挂),超时作废连接;
 *  - 连续 3 次故障 → 驱逐,下次采样重建(自愈)。
 */
import {
  classifySerialError,
  decodeRegisters,
  encodeWords,
  engToRaw,
  extractLineValue,
  normalizeSerialConfig,
  rawToEng,
  registerOffset,
  WORDS_OF,
} from './lib.mjs'

/** 空闲连接回收(10 分钟未用断开;采样周期最长 60s,足够保守) */
const IDLE_MS = 600_000
/** 采/控共用链路积压保护(与内置 modbus 驱动同阈值) */
const PENDING_SKIP = 8

// ============================================================
// 驱动目录自描述(前端动态参数表单;DriverConfigField 同形)
// ============================================================

export const SERIAL_READ_FIELDS = [
  { key: 'mode', label: '协议模式', type: 'select', default: 'modbus-rtu', options: [
    { value: 'modbus-rtu', label: 'Modbus RTU(RS-485/232)' },
    { value: 'ascii-line', label: 'ASCII 行(每行一个数值/JSON)' },
  ] },
  { key: 'path', label: '串口路径(path)', type: 'string', required: true, placeholder: 'COM3', hint: 'Windows 如 COM3;Linux 如 /dev/ttyUSB0' },
  { key: 'baudRate', label: '波特率', type: 'number', default: 9600, hint: '与设备一致(常见 9600/19200/115200)' },
  { key: 'parity', label: '校验位', type: 'select', default: 'none', options: [
    { value: 'none', label: '无(None)' },
    { value: 'even', label: '偶校验(Even)' },
    { value: 'odd', label: '奇校验(Odd)' },
  ] },
  { key: 'dataBits', label: '数据位', type: 'select', default: 8, options: [
    { value: 7, label: '7' },
    { value: 8, label: '8' },
  ] },
  { key: 'stopBits', label: '停止位', type: 'select', default: 1, options: [
    { value: 1, label: '1' },
    { value: 2, label: '2' },
  ] },
  { key: 'unitId', label: '从站地址(unitId)', type: 'number', default: 1, hint: 'Modbus RTU 从站地址 1~247' },
  { key: 'register', label: '寄存器地址', type: 'number', required: true, placeholder: '40001', hint: '4xxxx=保持寄存器(FC03);3xxxx=输入寄存器(FC04)' },
  { key: 'registerType', label: '寄存器区', type: 'select', default: 'holding', options: [
    { value: 'holding', label: '保持寄存器(4x)' },
    { value: 'input', label: '输入寄存器(3x)' },
  ] },
  { key: 'dataType', label: '数据类型', type: 'select', default: 'float32', options: [
    { value: 'int16', label: 'int16(1 寄存器)' },
    { value: 'uint16', label: 'uint16(1 寄存器)' },
    { value: 'int32', label: 'int32(2 寄存器)' },
    { value: 'uint32', label: 'uint32(2 寄存器)' },
    { value: 'float32', label: 'float32(2 寄存器,常用)' },
  ] },
  { key: 'byteOrder', label: '字节序', type: 'select', default: 'big', options: [
    { value: 'big', label: '大端(AB CD)' },
    { value: 'little', label: '小端(CD AB)' },
    { value: 'wordSwap', label: '字交换(CD AB / 交换单字)' },
  ] },
  { key: 'scale', label: '缩放系数', type: 'number', default: 1, hint: '原始值 × scale = 工程量(如 0.1)' },
  { key: 'jsonPath', label: '取值路径(ASCII 模式)', type: 'string', placeholder: 'data.temp', hint: 'ASCII 行为 JSON 时按路径取数值;裸数字留空' },
  { key: 'staleMs', label: '数据保鲜窗 ms(ASCII 模式)', type: 'number', default: 30000, hint: '超过该时长未收到新行视为停发,采样跳帧(不重复消费陈旧值)' },
]

export const SERIAL_WRITE_FIELDS = [
  { key: 'mode', label: '协议模式', type: 'select', default: 'modbus-rtu', options: [
    { value: 'modbus-rtu', label: 'Modbus RTU(写保持寄存器,带回读)' },
    { value: 'ascii-line', label: 'ASCII 行(发 {v} 模板行,无回读)' },
  ] },
  { key: 'path', label: '串口路径(path)', type: 'string', required: true, placeholder: 'COM3', hint: 'Windows 如 COM3;Linux 如 /dev/ttyUSB0' },
  { key: 'baudRate', label: '波特率', type: 'number', default: 9600 },
  { key: 'parity', label: '校验位', type: 'select', default: 'none', options: [
    { value: 'none', label: '无(None)' },
    { value: 'even', label: '偶校验(Even)' },
    { value: 'odd', label: '奇校验(Odd)' },
  ] },
  { key: 'dataBits', label: '数据位', type: 'select', default: 8, options: [{ value: 7, label: '7' }, { value: 8, label: '8' }] },
  { key: 'stopBits', label: '停止位', type: 'select', default: 1, options: [{ value: 1, label: '1' }, { value: 2, label: '2' }] },
  { key: 'unitId', label: '从站地址(unitId)', type: 'number', default: 1 },
  { key: 'register', label: '寄存器地址', type: 'number', required: true, placeholder: '40001', hint: '写保持寄存器(FC06/FC16)+ 同址回读校验' },
  { key: 'dataType', label: '数据类型', type: 'select', default: 'float32', options: [
    { value: 'int16', label: 'int16(1 寄存器,FC06)' },
    { value: 'uint16', label: 'uint16(1 寄存器,FC06)' },
    { value: 'int32', label: 'int32(2 寄存器,FC16)' },
    { value: 'uint32', label: 'uint32(2 寄存器,FC16)' },
    { value: 'float32', label: 'float32(2 寄存器,FC16)' },
  ] },
  { key: 'byteOrder', label: '字节序', type: 'select', default: 'big', options: [
    { value: 'big', label: '大端(AB CD)' },
    { value: 'little', label: '小端(CD AB)' },
    { value: 'wordSwap', label: '字交换(CD AB / 交换单字)' },
  ] },
  { key: 'rawMin', label: '原始量程下限(可选)', type: 'number', placeholder: '0', hint: '工程量↔原始值线性映射;两值都填才启用' },
  { key: 'rawMax', label: '原始量程上限(可选)', type: 'number', placeholder: '27648', hint: '如西门子 0~27648 对应 4~20mA' },
  { key: 'engMin', label: '工程量程下限(可选)', type: 'number', placeholder: '0', hint: '缺省取节点工艺量程 min' },
  { key: 'engMax', label: '工程量程上限(可选)', type: 'number', placeholder: '100', hint: '缺省取节点工艺量程 max' },
  { key: 'writeTemplate', label: 'ASCII 写模板(可选)', type: 'string', placeholder: 'SET {v}\\n', hint: 'ascii-line 模式下发行模板;{v} 替换为数值,\\n 自动补行尾' },
]

// ============================================================
// 连接池 + 队列化事务
// ============================================================

function connKey(cfg) {
  return `${cfg.mode}|${cfg.path}@${cfg.baudRate},${cfg.parity},${cfg.dataBits},${cfg.stopBits}`
}

/**
 * 创建串口驱动组(每插件装载一次;热重载 dispose 时 closeAll 回收全部串口)。
 */
export function createSerialDrivers({ openRtu, openLine, isAvailable, log = console }) {
  const pool = new Map()
  let sweep = null

  async function closeConn(conn) {
    try {
      if (conn.kind === 'rtu') await withTimeout(conn.client.close?.(), 500)
      else await withTimeout(conn.line.close(), 500)
    }
    catch { /* 已断 */ }
  }

  function withTimeout(p, ms) {
    return Promise.race([
      Promise.resolve(p),
      new Promise(r => setTimeout(() => r(), ms)),
    ])
  }

  /** 获取(或建立)串口连接;半开/死连接重建 + 在飞建连去重(串口独占,并发首连
   *  若各开各的,后写池者覆盖前者 → 前一条串口无人持有永久泄漏,Windows 独占打开还会
   *  直接报错。同键并发复用同一条建连任务,与内置 OPC UA 驱动同方案)。 */
  const inflight = new Map()
  async function getConn(cfg) {
    const key = connKey(cfg)
    const existing = pool.get(key)
    const healthy = existing
      && (existing.kind === 'rtu' ? existing.client.isOpen !== false : existing.line.alive() !== false)
    if (existing && healthy) {
      existing.lastUsed = Date.now()
      return existing
    }
    if (existing) {
      pool.delete(key)
      await closeConn(existing)
    }
    const pending = inflight.get(key)
    if (pending) return pending
    const task = (async () => (cfg.mode === 'modbus-rtu'
      ? { kind: 'rtu', client: await openRtu(cfg), lastUsed: Date.now(), tail: Promise.resolve(), pending: 0, errors: 0 }
      : { kind: 'line', line: await openLine(cfg), lastUsed: Date.now(), tail: Promise.resolve(), pending: 0, errors: 0 }))()
    inflight.set(key, task)
    try {
      const conn = await task
      // 竞态二次校验:建连期间若已有连接入池,关闭本次新建并复用既有
      const raced = pool.get(key)
      if (raced && raced !== conn) {
        await closeConn(conn)
        return raced
      }
      pool.set(key, conn)
      return conn
    }
    finally {
      inflight.delete(key)
    }
  }

  /**
   * 连接级排队执行:单事务硬超时(默认 3s)——半开串口(拔线/对端掉电)时底层
   * 回调永不返回,超时后作废连接并重置队列,防止单条死链堵死同串口全部节点。
   */
  function withConn(conn, fn, timeoutMs = 3000) {
    conn.pending++
    const run = conn.tail.then(() => fn(), () => fn())
    let dead = false
    const guarded = Promise.race([
      run,
      new Promise((_, rej) => setTimeout(() => {
        dead = true
        rej(new Error(`串口响应超时(${timeoutMs}ms)——检查接线/波特率/从站地址`))
      }, timeoutMs)),
    ])
    void guarded.catch(() => { /* 超时分支先 reject,防 unhandled */ })
    conn.tail = guarded.then(
      () => { conn.pending-- },
      () => { conn.pending-- },
    ).then(() => {
      if (dead) {
        conn.tail = Promise.resolve()
        // 超时即作废:关闭并移出池,下次采样重建
        for (const [k, c] of pool) if (c === conn) pool.delete(k)
        closeConn(conn).catch(() => {})
      }
    })
    return guarded
  }

  /** 连续故障驱逐(自愈):同链路 3 次失败后断开重建 */
  function bumpErrors(conn, cfg, err) {
    conn.errors++
    if (conn.errors >= 3) {
      log.warn(`串口链路连续故障,重建: ${connKey(cfg)}(${err?.message ?? err})`)
      for (const [k, c] of pool) if (c === conn) pool.delete(k)
      closeConn(conn).catch(() => {})
    }
  }

  // 空闲回收 sweep(单例;工厂随插件热重载整体销毁)
  if (!sweep) {
    sweep = setInterval(() => {
      const now = Date.now()
      for (const [key, conn] of pool) {
        if (now - conn.lastUsed > IDLE_MS && conn.pending === 0) {
          pool.delete(key)
          closeConn(conn).catch(() => {})
        }
      }
    }, 120_000)
    sweep.unref?.()
  }

  async function closeAll() {
    clearInterval(sweep)
    sweep = null
    const entries = [...pool]
    pool.clear()
    for (const [, conn] of entries) await closeConn(conn)
  }

  function poolSnapshot() {
    return [...pool.entries()].map(([key, c]) => ({
      key,
      kind: c.kind,
      lastUsedAt: c.lastUsed,
      pending: c.pending,
      errors: c.errors,
    }))
  }

  // ---------- 读路径(采样 / 测试) ----------

  async function readOnce(cfg, conn) {
    if (conn.kind === 'rtu') {
      const area = cfg.registerType
      const offset = registerOffset(cfg.register, area)
      const words = WORDS_OF[cfg.dataType] ?? 2
      const res = area === 'input'
        ? await conn.client.readInputRegisters(offset, words)
        : await conn.client.readHoldingRegisters(offset, words)
      const raw = decodeRegisters(res.data ?? res.buffer ?? [], cfg.dataType, cfg.byteOrder)
      return { value: raw * cfg.scale, raw }
    }
    // ascii-line:最新行 + 保鲜窗(停发即 null,不重复消费陈旧值)
    const latest = conn.line.latest()
    if (!latest || !latest.text) return { value: null, raw: null }
    if (Date.now() - latest.at > cfg.staleMs) return { value: null, raw: null, stale: true }
    const v = extractLineValue(latest.text, cfg.jsonPath)
    return { value: v == null ? null : v * cfg.scale, raw: v }
  }

  const readDriver = {
    kind: 'serial',
    meta: { label: '串口 Serial(RS-232/485)', status: 'real', configFields: SERIAL_READ_FIELDS },
    available: () => Promise.resolve(Boolean(isAvailable())),
    async sample({ driverConfig }) {
      const { cfg, errors } = normalizeSerialConfig(driverConfig)
      if (errors.length) throw new Error(errors[0])
      const conn = await getConn(cfg)
      if (conn.pending > PENDING_SKIP) return null
      conn.lastUsed = Date.now()
      return withConn(conn, async () => {
        try {
          const r = await readOnce(cfg, conn)
          conn.errors = 0
          return r.value
        }
        catch (err) {
          bumpErrors(conn, cfg, err)
          throw new Error(classifySerialError(err), { cause: err })
        }
      }, cfg.timeoutMs)
    },
    async test(driverConfig) {
      const t0 = Date.now()
      const { cfg, errors } = normalizeSerialConfig(driverConfig)
      if (errors.length) return { ok: false, message: errors.join(';') }
      try {
        const conn = await getConn(cfg)
        const r = await withConn(conn, () => readOnce(cfg, conn), cfg.timeoutMs)
        conn.errors = 0
        if (r.value == null) {
          return {
            ok: true,
            message: cfg.mode === 'ascii-line'
              ? `串口已打开 ${cfg.path}@${cfg.baudRate}(保鲜窗内暂无新鲜数据行;设备上报后采样即开始)`
              : `串口已打开 ${cfg.path}@${cfg.baudRate},读数为空`,
            latencyMs: Date.now() - t0,
          }
        }
        return {
          ok: true,
          message: `串口连接成功,读取 ${cfg.mode === 'modbus-rtu' ? `${cfg.register}(原始 ${r.raw})` : `行 ${String(r.raw)}`} = ${r.value}`,
          sampleValue: r.value,
          latencyMs: Date.now() - t0,
        }
      }
      catch (err) {
        return { ok: false, message: `串口连接失败: ${classifySerialError(err)}` }
      }
    },
  }

  // ---------- 写路径(写 + 回读校验 / 周期读) ----------

  const writeDriver = {
    kind: 'serial',
    meta: { label: '串口 Serial 写(RS-232/485)', status: 'real', configFields: SERIAL_WRITE_FIELDS },
    available: () => Promise.resolve(Boolean(isAvailable())),
    async write(input) {
      const { cfg, errors } = normalizeSerialConfig(input.driverConfig)
      if (errors.length) return { ok: false, message: errors.join(';'), raw: null, readback: null }
      if (cfg.mode === 'ascii-line') {
        // ASCII 写:发模板行(无协议回读;诚实标注)
        try {
          const conn = await getConn(cfg)
          const line = String(cfg.writeTemplate || '{v}').replace('{v}', String(input.eng))
          await withConn(conn, () => conn.line.writeLine(line), cfg.timeoutMs)
          return { ok: true, message: `已发送「${line.trim()}」到 ${cfg.path}(ascii-line 无回读,建议配合数采节点校验)`, raw: input.eng, readback: null }
        }
        catch (err) {
          return { ok: false, message: `串口写入失败: ${classifySerialError(err)}`, raw: null, readback: null }
        }
      }
      try {
        const conn = await getConn(cfg)
        return await withConn(conn, async () => {
          const raw = engToRaw(input.eng, input.driverConfig, input.domain)
          const words = encodeWords(raw, cfg.dataType, cfg.byteOrder)
          const offset = registerOffset(cfg.register, 'holding')
          if (words.length === 1) await conn.client.writeRegister(offset, words[0])
          else await conn.client.writeRegisters(offset, words)
          // 回读校验:同址读回 → 解码 → 换算回工程量 → 死区容差比较(与内置写驱动同语义)
          const back = await conn.client.readHoldingRegisters(offset, words.length)
          const rawBack = decodeRegisters(back.data ?? back.buffer ?? [], cfg.dataType, cfg.byteOrder)
          const engBack = rawToEng(rawBack, input.driverConfig, input.domain)
          const ok = Math.abs(engBack - input.eng) <= Math.max(input.tolerance, 1e-9)
          conn.errors = 0
          return {
            ok,
            message: ok
              ? `写入成功:${input.eng} → raw ${Number(raw.toFixed(4))},回读 ${Number(engBack.toFixed(4))} 一致`
              : `回读不一致:写入 ${input.eng},回读 ${Number(engBack.toFixed(4))}(容差 ${input.tolerance})`,
            raw,
            readback: engBack,
          }
        }, cfg.timeoutMs)
      }
      catch (err) {
        return { ok: false, message: `串口写入失败: ${classifySerialError(err)}`, raw: null, readback: null }
      }
    },
    async read(input) {
      const { cfg, errors } = normalizeSerialConfig(input.driverConfig)
      if (errors.length) return { ok: false, message: errors.join(';'), eng: null, raw: null }
      try {
        const conn = await getConn(cfg)
        const r = await withConn(conn, () => readOnce(cfg, conn), cfg.timeoutMs)
        if (r.value == null) return { ok: true, message: '串口无新鲜数据', eng: null, raw: null }
        return {
          ok: true,
          message: cfg.mode === 'modbus-rtu' ? `读取 raw ${r.raw} = ${r.value}` : `读取行值 ${r.value}`,
          eng: r.value,
          raw: r.raw,
        }
      }
      catch (err) {
        return { ok: false, message: classifySerialError(err), eng: null, raw: null }
      }
    },
    async test(driverConfig) {
      const t0 = Date.now()
      const { cfg, errors } = normalizeSerialConfig(driverConfig)
      if (errors.length) return { ok: false, message: errors.join(';') }
      if (cfg.mode === 'ascii-line' && cfg.writeTemplate === '') return { ok: false, message: 'ascii-line 模式缺少写模板 writeTemplate' }
      const r = await writeDriver.read({ domain: { min: 0, max: 100 }, driverConfig })
      if (!r.ok) return { ok: false, message: `串口连接失败: ${r.message}` }
      return {
        ok: true,
        message: `串口连接成功(${Date.now() - t0}ms;${cfg.mode === 'modbus-rtu' ? '读回读链路正常' : 'ascii 行链路正常'};未执行写入测试,避免误触发真实设备动作)`,
      }
    },
  }

  return { readDriver, writeDriver, closeAll, poolSnapshot, getConn }
}
