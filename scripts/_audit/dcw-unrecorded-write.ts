/**
 * 审计实验 3 —— 「写入落到硬件但未入账」链路(只读审计;全部走本地假 PLC,不触真实数据)。
 *
 * 组成:
 *  A) 假 Modbus TCP PLC(FC16 写 / FC03 读;可切换「回读返回陈旧值」和「永不响应」)
 *  B) 真实 modbus-tcp 写驱动(server/services/workshop/dcw/drivers.ts)
 *  C) 真实 RecipeRollBackRepo(账本;cwd 已切到 scripts/_audit/.tmp,绝不碰 server/data/*)
 *  D) 忠实复刻 dcw-controller.ts:536 的入册闸门 `if (outcome.ok !== false)`
 *
 * 运行:node --experimental-transform-types scripts/_audit/run.mjs scripts/_audit/dcw-unrecorded-write.ts
 */
import { mkdirSync } from 'node:fs'
import net from 'node:net'

const TMP_DIR = new URL('./.tmp/server/data/', import.meta.url)
mkdirSync(TMP_DIR, { recursive: true })
process.chdir(new URL('./.tmp/', import.meta.url).pathname.replace(/^\//, ''))

const { modbusTcpDcwDriver } = await import('../../server/services/workshop/dcw/drivers')
const { RecipeRollBackRepo } = await import('../../server/services/workshop/dcw/recipe-rollback.repo')
const { writeTolerance } = await import('../../server/services/workshop/dcw/dcw-runtime')

let failures = 0
function check(name: string, cond: boolean, extra = ''): void {
  if (cond) {
    console.log(`  PASS  ${name}${extra ? ` (${extra})` : ''}`)
  }
  else {
    failures++
    console.log(`  FAIL  ${name}${extra ? ` (${extra})` : ''}`)
  }
}

interface FakePlc {
  port: number
  registers: Map<number, number>
  writeCount: number
  mode: 'stale-readback' | 'hang'
  close: () => void
}

function startFakePlc(opts: { staleReadback?: number, mode?: 'stale-readback' | 'hang' }): Promise<FakePlc> {
  const registers = new Map<number, number>()
  const state = { writeCount: 0, mode: opts.mode ?? 'stale-readback' as 'stale-readback' | 'hang' }
  const server = net.createServer((sock) => {
    let buf = Buffer.alloc(0)
    sock.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk])
      while (buf.length >= 6) {
        const len = buf.readUInt16BE(4)
        const total = 6 + len
        if (buf.length < total) break
        const unitId = buf.readUInt8(6)
        const pdu = buf.subarray(7, total)
        const fc = pdu.readUInt8(0)
        const tid = buf.readUInt16BE(0)
        if (state.mode === 'hang') {
          buf = buf.subarray(total)
          continue // 收到即吞:模拟半开链路(不响应)
        }
        let resp: Buffer
        if (fc === 0x10) { // write multiple registers
          const addr = pdu.readUInt16BE(1)
          const qty = pdu.readUInt16BE(3)
          for (let i = 0; i < qty; i++) registers.set(addr + i, pdu.readUInt16BE(6 + i * 2))
          state.writeCount++
          resp = Buffer.from([0x10, pdu[1]!, pdu[2]!, pdu[3]!, pdu[4]!])
        }
        else if (fc === 0x03) { // read holding registers
          const addr = pdu.readUInt16BE(1)
          const qty = pdu.readUInt16BE(3)
          const data: number[] = []
          for (let i = 0; i < qty; i++) {
            // 关键:回读一律返回「陈旧值」——模拟 PLC 尚未生效/慢一拍
            data.push(opts.staleReadback != null ? opts.staleReadback : (registers.get(addr + i) ?? 0))
          }
          resp = Buffer.from([0x03, data.length * 2, ...data.flatMap(v => [v >> 8 & 0xFF, v & 0xFF])])
        }
        else {
          resp = Buffer.from([fc | 0x80, 0x01])
        }
        const head = Buffer.alloc(6)
        head.writeUInt16BE(tid, 0)
        head.writeUInt16BE(0, 2)
        head.writeUInt16BE(resp.length + 1, 4)
        sock.write(Buffer.concat([head, Buffer.from([unitId]), resp]))
        buf = buf.subarray(total)
      }
    })
    sock.on('error', () => {})
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({
        port: (server.address() as net.AddressInfo).port,
        registers,
        get writeCount() { return state.writeCount },
        mode: state.mode,
        close: () => server.close(),
      } as FakePlc)
    })
  })
}

const nodeLike = { decimals: 2, min: 0, max: 100 } as never

console.log('\n=== A. 回读陈旧值:写已落到寄存器,但 ACK 判定失败(ok=false) ===')
{
  const plc = await startFakePlc({ staleReadback: 5 })
  const cfg = { host: '127.0.0.1', port: plc.port, unitId: 1, register: 0, dataType: 'int16', byteOrder: 'big' }
  const res = await modbusTcpDcwDriver.write({
    eng: 20,
    tolerance: writeTolerance(nodeLike),
    domain: { min: 0, max: 100 },
    driverConfig: cfg,
  })
  console.log(`  驱动返回: ok=${res.ok} raw=${res.raw} readback=${res.readback} message=${res.message}`)
  check('硬件寄存器已收到写入值 20', plc.registers.get(0) === 20, `reg0=${plc.registers.get(0)}`)
  check('驱动判定为 ACK 失败(ok=false)', res.ok === false)
  check('失败原因 = 回读偏差超容差', /回读偏差超容差/.test(res.message), res.message)
  check('readback 为陈旧值 5', res.readback === 5)

  // 账本语义复刻:dcw-controller.ts:536「仅成功写记锚」→ ok=false 时 afterWrite 不被调用
  const repo = new RecipeRollBackRepo()
  repo.appendAnchor({ lineId: 'ln', nodeId: 'dw-1', prevValue: 5, newValue: 10, source: 'manual', actor: 'user', recipeRunId: null })
  const outcome = res
  let ledgerAppends = 0
  if (outcome.ok !== false) { // ← 与 dcw-controller.ts:532-536 同构
    repo.appendAnchor({ lineId: 'ln', nodeId: 'dw-1', prevValue: 10, newValue: 20, source: 'manual', actor: 'user', recipeRunId: null })
    ledgerAppends++
  }
  check('ok=false 时账本未入册(闸门同构复刻)', ledgerAppends === 0)
  const stable = repo.lastStableAnchor('dw-1')
  console.log(`  账本最新稳定锚 = {prev:${stable?.prevValue}, new:${stable?.newValue}};硬件寄存器 = ${plc.registers.get(0)}`)
  check('入册锚不是本次写入(20 不在册)', stable?.newValue === 10, `new=${stable?.newValue}`)
  check('硬件实际值(20)≠ 入册锚 newValue(10):账本与硬件漂移', plc.registers.get(0) !== stable?.newValue)
  check('seeded 锚的 prevValue=5 仍是回退目标:回退将跳过真实的上一设定值 10', stable?.prevValue === 5)
  plc.close()
}

console.log('\n=== B. 同理:另一个方向的漂移(node.value = 陈旧回读值 → 保写心跳将重下发陈旧值) ===')
{
  const plc = await startFakePlc({ staleReadback: 5 })
  const cfg = { host: '127.0.0.1', port: plc.port, unitId: 1, register: 0, dataType: 'int16', byteOrder: 'big' }
  const res = await modbusTcpDcwDriver.write({ eng: 20, tolerance: writeTolerance(nodeLike), domain: { min: 0, max: 100 }, driverConfig: cfg })
  // dcw-controller.ts:176 等价:node.applyWriteResult(outcome.readback ?? eng, ok, ...)
  const DcwNodeMod = await import('../../server/services/workshop/dcw/dcw-node')
  const node = DcwNodeMod.DcwNode.fromRow({ id: 'dw-1', templateRef: 'cw-temp', min: 0, max: 100, decimals: 2, holdIntervalMs: 1000, driver: 'modbus-tcp', driverConfig: cfg })
  node.value = 10
  node.applyWriteResult(res.readback ?? 20, res.ok, res.message, new Date().toISOString())
  console.log(`  写入 20 / 回读 ${res.readback} → node.value=${node.value}(state=${node.state})`)
  check('node.value 被写成陈旧回读值 5(既非设定值 20 也非真实上一设定 10)', node.value === 5, `value=${node.value}`)
  plc.close()
}

console.log('\n=== C. 写超时(假 PLC 收到即吞):是否 bounded、是否误判 ===')
{
  const plc = await startFakePlc({ mode: 'hang' })
  const cfg = { host: '127.0.0.1', port: plc.port, unitId: 1, register: 0, dataType: 'int16', byteOrder: 'big' }
  const t0 = Date.now()
  const res = await modbusTcpDcwDriver.write({ eng: 30, tolerance: writeTolerance(nodeLike), domain: { min: 0, max: 100 }, driverConfig: cfg })
  const dt = Date.now() - t0
  console.log(`  返回: ok=${res.ok} message=${res.message} elapsed=${dt}ms`)
  check('写有硬超时(<=4s 返回,实测 withModbusConn 3s)', dt < 4000, `${dt}ms`)
  check('超时映射为 ACK 失败(ok=false)', res.ok === false)
  check('超时时 readback=null(账本/节点值无法判定硬件真实状态)', res.readback === null, `readback=${res.readback}`)
  plc.close()
}

console.log(`\nresult: ${failures === 0 ? 'ALL PASS' : `${failures} FAILED`}`)
process.exit(failures === 0 ? 0 : 1)
