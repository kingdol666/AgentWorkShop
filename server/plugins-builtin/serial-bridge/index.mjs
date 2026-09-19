/**
 * serial-bridge —— 串口通信协议插件(内置;随服务启动期装载)。
 *
 * 能力:
 *  1. 数采读驱动(kind='serial'):Modbus RTU(RS-485/232,FC03/FC04)与 ASCII 行协议
 *     (每行一个数值或 JSON)两种模式,经 ctx.daq.registerDriver 注入 —— 前端数采中心
 *     「添加节点」即出现「串口 Serial」协议与动态参数表单;
 *  2. 写控驱动(kind='serial'):Modbus RTU 写保持寄存器(FC06/FC16)+ 同址回读校验,
 *     ASCII 行模板下行(无回读),经 ctx.dcw.registerWriteDriver 注入;
 *  3. 后端 API(/api/plugins/serial-bridge/*):health(链路健康)/ ports(系统串口枚举)/
 *     probe(无落库连接探针,支持 ASCII 发行探测);
 *  4. Agent 工具 serial_ports:让 Agent 能枚举本机串口并诊断链路;
 *  5. 前端面板(plugins.page 插槽):串口包可用性、系统端口表、探针表单、链路状态。
 *
 * 运行时依赖:serialport(optionalDependencies;缺失时 available=false 如实降级,
 * 主服务与其余插件不受影响)。RTU 帧机为插件自研(rtu.mjs,单 serialport 原生栈)——
 * 不用 modbus-serial:其包装层与 nitro dev worker isolate 组合会触发 V8 HandleScope
 * 原生崩溃(实测稳定复现),纯 serialport 打开同口正常。
 * 插件契约见 docs/plugins.md;驱动工厂见 drivers.mjs(可注入 opener,单测免硬件)。
 */
import { createRequire } from 'node:module'
import { createSerialDrivers, SERIAL_READ_FIELDS } from './drivers.mjs'
import { classifySerialError, normalizeSerialConfig } from './lib.mjs'
import { createRtuClient } from './rtu.mjs'

const require = createRequire(import.meta.url)

/** serialport 可用性探测(包缺失/原生二进制不匹配 → null,驱动如实「未安装」) */
function loadSerialPort() {
  try {
    const mod = require('serialport')
    const SerialPort = mod.SerialPort ?? mod.default?.SerialPort
    return SerialPort ? { SerialPort } : null
  }
  catch {
    return null
  }
}

/** 带硬超时的等待(建连/开串口防悬挂) */
function withTimeout(p, ms, message) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(message)), ms)
    Promise.resolve(p).then(
      (v) => {
        clearTimeout(t)
        resolve(v)
      },
      (e) => {
        clearTimeout(t)
        reject(e)
      },
    )
  })
}

export default {
  name: 'serial-bridge',
  version: '1.0.0',
  description: '串口通信协议桥:Modbus RTU(RS-485/232)与 ASCII 行协议读驱动、带回读校验的写驱动、串口枚举/探针 API 与前端面板。',
  auth: 'user',
  client: './client.mjs',
  setup(ctx) {
    // ---- 运行时依赖探测(缺失不阻断装载,驱动 available=false 如实降级) ----
    const sp = loadSerialPort()
    if (!sp) ctx.logger.warn('serialport 包不可用(可选依赖未安装或原生二进制不匹配):串口驱动将显示「未安装」。npm i serialport 后重启即恢复。')

    // ---- 协议栈实现(注入驱动工厂) ----

    /** Modbus RTU over 串口:自研事务客户端(单 serialport 原生栈;见 rtu.mjs 头注) */
    async function openRtu(cfg) {
      if (!sp) throw new Error('serialport 包不可用(npm i serialport 后重启)')
      const client = createRtuClient(sp.SerialPort, cfg)
      await client.open()
      return client
    }

    /** ASCII 行协议:serialport + 行分割;缓存最新行(保鲜窗在驱动层判定) */
    async function openLine(cfg) {
      if (!sp) throw new Error('serialport 包不可用(npm i serialport 后重启)')
      const port = new sp.SerialPort({
        path: cfg.path,
        baudRate: cfg.baudRate,
        dataBits: cfg.dataBits,
        stopBits: cfg.stopBits,
        parity: cfg.parity,
        autoOpen: true,
      })
      await withTimeout(
        new Promise((resolve, reject) => {
          port.once('open', resolve)
          port.once('error', reject)
        }),
        cfg.timeoutMs,
        `串口打开超时(${cfg.timeoutMs}ms): ${cfg.path}@${cfg.baudRate}`,
      )
      const state = { latest: { text: '', at: 0 }, alive: true }
      // 行分割:优先 readline 解析器;不可用时按 buffer 手工切行(等价语义)
      let buffer = ''
      const feed = (chunk) => {
        buffer += chunk.toString('utf8')
        let i
        while ((i = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, i).replace(/\r$/, '')
          buffer = buffer.slice(i + 1)
          if (line.trim()) state.latest = { text: line, at: Date.now() }
        }
      }
      port.on('data', feed)
      const markDead = () => void (state.alive = false)
      port.on('error', markDead)
      port.on('close', markDead)
      return {
        alive: () => state.alive,
        latest: () => state.latest,
        writeLine: line => new Promise((resolve, reject) => {
          port.write(`${line.endsWith('\n') ? line : `${line}\n`}`, (err) => {
            if (err) reject(err)
            else resolve()
          })
        }),
        close: () => new Promise((resolve) => {
          if (!port.isOpen) return resolve()
          port.close(() => resolve())
        }),
      }
    }

    const factory = createSerialDrivers({
      openRtu,
      openLine,
      isAvailable: () => Boolean(sp),
      log: ctx.logger,
    })

    // ---- 驱动注入(数采读 + 写控;插件系统核心链路) ----
    ctx.daq.registerDriver(factory.readDriver)
    ctx.dcw.registerWriteDriver(factory.writeDriver)
    ctx.onDispose(() => factory.closeAll())

    // ---- 后端 API(/api/plugins/serial-bridge/*) ----

    // 系统串口枚举(路径/厂商/序列号/友好名;供前端探针表单与运维排障)
    ctx.route('GET', '/ports', async () => {
      if (!sp) return { success: false, error: 'serialport 包不可用(npm i serialport 后重启)', ports: [] }
      try {
        const list = await sp.SerialPort.list()
        return {
          success: true,
          ports: list.map(p => ({
            path: p.path,
            manufacturer: p.manufacturer ?? null,
            serialNumber: p.serialNumber ?? null,
            vendorId: p.vendorId ?? null,
            productId: p.productId ?? null,
            friendlyName: p.friendlyName ?? p.pnpId ?? null,
          })),
        }
      }
      catch (err) {
        return { success: false, error: classifySerialError(err), ports: [] }
      }
    })

    // 链路健康(协议栈可用性 + 打开的串口连接池快照;路由与 Agent 工具共用)
    async function healthPayload() {
      const nodes = await ctx.daq.nodes().catch(() => [])
      const serialNodes = (Array.isArray(nodes) ? nodes : []).filter(n => n?.driver === 'serial')
      return {
        plugin: ctx.name,
        available: Boolean(sp),
        packages: { serialport: Boolean(sp) },
        links: factory.poolSnapshot(),
        /** 使用串口驱动的数采节点(读侧;写控节点见 dcw) */
        readNodes: serialNodes.map(n => ({ id: n.id, name: n.name, lineId: n.lineId ?? null, path: n.driverConfig?.path ?? null, enabled: n.enabled !== false })),
      }
    }

    ctx.route('GET', '/health', () => healthPayload())

    // 连接探针(不落库):按给定参数开串口读一次;ascii 模式可选先行下发探测行。
    // 复用驱动工厂的连接池与超时语义 —— probe 通过 = 该参数创建节点后必可采。
    ctx.route('POST', '/probe', async (event) => {
      const b = event?.awBody ?? {}
      const driverConfig = {
        mode: b.mode,
        path: b.path,
        baudRate: b.baudRate,
        parity: b.parity,
        dataBits: b.dataBits,
        stopBits: b.stopBits,
        unitId: b.unitId,
        register: b.register,
        registerType: b.registerType,
        dataType: b.dataType,
        byteOrder: b.byteOrder,
        jsonPath: b.jsonPath,
        timeoutMs: b.timeoutMs,
      }
      const { cfg, errors } = normalizeSerialConfig(driverConfig)
      if (errors.length) return { success: false, error: errors.join(';') }
      const t0 = Date.now()
      try {
        // ascii 探测行:先发一条(如「?」问询帧),给主动上报型设备一个触发
        if (cfg.mode === 'ascii-line' && b.sendLine) {
          const conn = await factory.getConn(cfg)
          await conn.line.writeLine(String(b.sendLine))
        }
        const r = await factory.readDriver.test(driverConfig)
        return { success: true, ...r, latencyMs: r.latencyMs ?? Date.now() - t0 }
      }
      catch (err) {
        return { success: false, ok: false, message: classifySerialError(err), latencyMs: Date.now() - t0 }
      }
    })

    // ---- Agent 工具:串口枚举 + 链路诊断 ----
    ctx.omp.registerTool({
      name: 'serial_ports',
      label: '串口诊断',
      description: '枚举本机串口端口(路径/厂商)与 serial-bridge 插件的串口链路健康(打开的连接/错误计数/串口数采节点)。串口设备接入与排障时使用。',
      parameters: { type: 'object', properties: {} },
      roles: ['lead', 'worker'],
      handler: async () => {
        try {
          const d = await healthPayload()
          const lines = [
            `可用性: ${d.available === true ? 'serialport 就绪(RTU 帧机内建)' : `不可用(${JSON.stringify(d.packages ?? {})})`}`,
            `串口数采节点: ${(d.readNodes ?? []).length} 个${(d.readNodes ?? []).length ? `(${d.readNodes.map(n => `${n.name || n.id}@${n.path || '?'}${n.enabled ? '' : '[停用]'}`).join(', ')})` : ''}`,
            `打开的链路: ${(d.links ?? []).length} 条`,
          ]
          for (const l of d.links ?? []) lines.push(`  - ${l.key}(pending=${l.pending}, errors=${l.errors}, 最近使用 ${l.lastUsedAt ? new Date(l.lastUsedAt).toISOString() : '-'})`)
          if (sp) {
            const ports = await sp.SerialPort.list()
            lines.push(`系统串口: ${ports.length ? ports.map(p => p.path).join(', ') : '(无)'}`)
          }
          return { text: lines.join('\n') }
        }
        catch (err) {
          return { text: `serial_ports 异常: ${err?.message ?? err}`, isError: true }
        }
      },
    })

    ctx.logger.info(`serial-bridge 就绪:驱动 serial(读 ${SERIAL_READ_FIELDS.length} 参数)+ 写控 serial + 路由 health/ports/probe + 工具 serial_ports;serialport ${sp ? '可用' : '未安装(驱动显示未安装)'}`)
  },
}
