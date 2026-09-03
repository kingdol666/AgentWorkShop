/**
 * DCW 读写集成单元测试:驱动 read 原语(mock/modbus 形态判定)/工程量↔原始值对称映射/
 * 节点读状态记账/运行时周期读调度/手动读取/Agent dcw_read 工具(鉴权+执行,AW_HOME 隔离)。
 * 运行: AW_MODE=home AW_HOME=<tmp> npx tsx --tsconfig .nuxt/tsconfig.server.json scripts/test-dcw-read.ts
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// 工具段需要文件型仓库:整体进程重定向到一次性配置根(避免触碰检出内 .AgentWorkShop)
const awHome = mkdtempSync(join(tmpdir(), 'aw-dcw-read-'))
process.env.AW_MODE = 'home'
process.env.AW_HOME = awHome

let failures = 0
function check(name: string, ok: boolean, detail = ''): void {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures += 1
}

// ===== 1. 驱动 read 原语 =====
console.log('\n--- 驱动 read 原语 ---')
{
  const { mockDcwDriver, supportsDcwRead } = await import('../server/services/workshop/dcw/drivers')
  const domain = { min: 0, max: 300 }
  const w = await mockDcwDriver.write({ eng: 165, tolerance: 0.1, domain, driverConfig: { key: 't1' } })
  check('mock 写入成功', w.ok)
  const r = await mockDcwDriver.read!({ domain, driverConfig: { key: 't1' } })
  check('mock 读回写值(读写闭环)', r.ok && r.eng === 165 && r.raw === 165, `eng=${r.eng}`)
  const miss = await mockDcwDriver.read!({ domain, driverConfig: { key: 'never-written' } })
  check('mock 未写地址读取明确失败', !miss.ok && miss.eng == null)
  check('读能力判定:mock/modbus-tcp/modbus-rtu/opcua 可读,mqtt/http 不可读',
    supportsDcwRead('mock') && supportsDcwRead('modbus-tcp') && supportsDcwRead('modbus-rtu') && supportsDcwRead('opcua')
    && !supportsDcwRead('mqtt') && !supportsDcwRead('http'))
}

// ===== 2. 工程量↔原始值映射对称 =====
console.log('\n--- 工程量↔原始值映射 ---')
{
  const { engToRaw, rawToEng } = await import('../server/services/workshop/dcw/drivers')
  const input = { eng: 50, tolerance: 0, domain: { min: 0, max: 100 }, driverConfig: { rawMin: 0, rawMax: 16383, engMin: 0, engMax: 100 } }
  const raw = engToRaw(50, input)
  check('线性映射:eng 50 → raw 8191.5', Math.abs(raw - 8191.5) < 1e-9, String(raw))
  check('映射对称:rawToEng(engToRaw(x)) = x', Math.abs(rawToEng(raw, input) - 50) < 1e-9)
  const pass = { eng: 7, tolerance: 0, domain: { min: 0, max: 100 }, driverConfig: {} }
  check('无原始量程:直传(float32 语义)', engToRaw(7, pass) === 7 && rawToEng(7, pass) === 7)
}

// ===== 3. 节点读状态记账 =====
console.log('\n--- 节点读状态 ---')
{
  const { DcwNode } = await import('../server/services/workshop/dcw/dcw-node')
  const n = new DcwNode({ id: 'dw-t1', templateRef: 'dcw-temp-sp', readIntervalMs: 2000 })
  const at = new Date().toISOString()
  n.applyReadResult(168.456, 168.456, true, '读回', at)
  check('成功读数回填(按 decimals 取整)', n.readValue === 168.5 && n.lastReadAt === at && n.lastReadError == null, `readValue=${n.readValue}`)
  n.applyReadResult(null, null, false, '链路超时', new Date().toISOString())
  check('失败读保留旧值并记原因', n.readValue === 168.5 && n.lastReadError === '链路超时')
  n.applyReadResult(170, 170, true, '读回', new Date().toISOString())
  check('恢复成功后清空错误', n.readValue === 170 && n.lastReadError == null)
  const row = n.toRow()
  const n2 = DcwNode.fromRow(row)
  check('持久化 roundtrip(readIntervalMs/readValue/lastRead*)', n2.readIntervalMs === 2000 && n2.readValue === 170 && n2.lastReadError == null)
  const v = n2.toView()
  check('视图透出读字段', v.readValue === 170 && v.readIntervalMs === 2000 && 'lastReadError' in v)
}

// ===== 4. 运行时周期读调度 =====
console.log('\n--- 运行时周期读调度 ---')
{
  const { DcwNode } = await import('../server/services/workshop/dcw/dcw-node')
  const rtMod = await import('../server/services/workshop/dcw/dcw-runtime')
  const { DcwNodeRuntime } = rtMod
  type DcwRuntimeHost = import('../server/services/workshop/dcw/dcw-runtime').DcwRuntimeHost
  type DcwNodeT = import('../server/services/workshop/dcw/dcw-node').DcwNode
  const reads: number[] = []
  const atNow = () => new Date().toISOString()
  // 记账语义与控制器一致:读成功回填节点 readValue
  const makeHost = (defaults: { holdIntervalMs: number, readIntervalMs: number }): DcwRuntimeHost => ({
    running: () => true,
    defaults: () => defaults,
    executeWrite: async () => ({ ok: true, message: '', raw: null, readback: null }),
    executeRead: async (node: DcwNodeT) => {
      reads.push(Date.now())
      node.applyReadResult(1, 1, true, '读回', atNow())
      return { ok: true, value: 1, raw: 1, message: '', at: atNow() }
    },
  })
  const n = new DcwNode({ id: 'dw-t2', templateRef: 'dcw-temp-sp', readIntervalMs: 1000 })
  const rt = new DcwNodeRuntime(n, makeHost({ holdIntervalMs: 0, readIntervalMs: 5000 }))
  const t0 = 1_000_000
  rt.tick(t0)
  rt.tick(t0 + 500)
  rt.tick(t0 + 1100)
  check('周期读按 readIntervalMs 节拍触发(两次窗内各一次)', reads.length === 2, `reads=${reads.length}`)
  check('写心跳不触发(value=null)', reads.length === 2)
  n.readValue = 165
  const manual = await rt.readNow()
  check('手动读取(readNow)执行并记账', manual.ok && n.readValue === 1 && n.lastReadError == null, `readValue=${n.readValue}`)
  const schedAfterManual = reads.length
  const off = new DcwNode({ id: 'dw-t3', templateRef: 'dcw-temp-sp', readIntervalMs: 0 })
  const rtOff = new DcwNodeRuntime(off, makeHost({ holdIntervalMs: 0, readIntervalMs: 5000 }))
  rtOff.tick(t0)
  rtOff.tick(t0 + 2000)
  check('readIntervalMs=0 关闭周期读', reads.length === schedAfterManual)
  // 在飞互斥:挂起中的读阻塞 readNow → 409
  let release: (() => void) | null = null
  const slowHost: DcwRuntimeHost = {
    running: () => true,
    defaults: () => ({ holdIntervalMs: 0, readIntervalMs: 5000 }),
    executeWrite: async () => ({ ok: true, message: '', raw: null, readback: null }),
    executeRead: async () => {
      await new Promise<void>((r) => {
        release = r
      })
      return { ok: true, value: 1, raw: null, message: '', at: atNow() }
    },
  }
  const rtSlow = new DcwNodeRuntime(new DcwNode({ id: 'dw-t4', templateRef: 'dcw-temp-sp', readIntervalMs: null }), slowHost)
  const inFlight = rtSlow.readNow()
  let conflicted = false
  await rtSlow.readNow().catch((e: unknown) => {
    conflicted = (e as { status?: number }).status === 409
  })
  release!()
  const done = await inFlight
  check('读在飞互斥(并发 readNow → 409)', conflicted && done.ok)
}

// ===== 5. Agent dcw_read 工具(鉴权 + 执行;隔离配置根) =====
console.log('\n--- Agent dcw_read 工具 ---')
{
  const { toolDcwRead } = await import('../server/services/workshop/agents/industrial-tools')
  const denied = await toolDcwRead('agent-x', { node_id: 'dw-none' })
  check('未绑定 agent 读取被拒', denied.isError === true && /未绑定|无权/.test(denied.text))
  const { getDcwController } = await import('../server/services/workshop/dcw/dcw-controller')
  const { getAgentNodeBindingRepo } = await import('../server/services/workshop/agents/node-bindings.repo')
  const node = getDcwController().create({ templateRef: 'dcw-temp-sp', driver: 'mock', driverConfig: { key: 'agent-t' }, readIntervalMs: 0, name: '读链路测试节点' })
  const repo = getAgentNodeBindingRepo()
  repo.bind('agent-a', node.id, 'dcw', 'auto')
  const before = await toolDcwRead('agent-a', { node_id: node.id })
  check('从未下发的节点:鉴权通过并如实报告读取失败(mock 无记录)', before.isError === true && /读取失败/.test(before.text) && !/无权|未绑定/.test(before.text), before.text.slice(0, 80))
  await getDcwController().write(node.id, 172.5, null, { source: 'manual', actor: 'tester' })
  const after = await toolDcwRead('agent-a', { node_id: node.id })
  check('写入后读取:ACT 与 SET 一致', after.isError !== true && /172\.5/.test(after.text) && /一致/.test(after.text), after.text.replace(/\n/g, ' | ').slice(0, 140))
  const other = await toolDcwRead('agent-b', { node_id: node.id })
  check('其他 agent 越权读取被拒', other.isError === true)
}

// 收尾
rmSync(awHome, { recursive: true, force: true })
console.log(failures === 0 ? '\nDCW-READ ALL PASS' : `\nDCW-READ FAILED(${failures})`)
process.exit(failures === 0 ? 0 : 1)
