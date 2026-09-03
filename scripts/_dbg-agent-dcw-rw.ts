/**
 * Agent 数控读写真机验证(协议级):
 * ①真实 omp --mode rpc 子进程接受含 dcw_read/dcw_control 的 set_host_tools
 * ②真实 OmpRpcAgentImpl.handleHostTool 分发 → toolDcwRead/toolDcwControl 执行体:
 *   mock 节点写读对照 / 真实 Modbus TCP(1502 从站 40023)写读 roundtrip / 越权与量程联锁。
 * 数据目录 AW_HOME 隔离,不触碰检出内 .AgentWorkShop。
 * 运行: npx tsx --tsconfig .nuxt/tsconfig.server.json scripts/_dbg-agent-dcw-rw.ts
 */
import { spawn } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// 进程级隔离:配置根落在一次性目录(须在业务模块 import 前设置)
const awHome = mkdtempSync(join(tmpdir(), 'aw-agent-dcw-rw-'))
process.env.AW_MODE = 'home'
process.env.AW_HOME = awHome
process.env.NO_PROXY = '127.0.0.1,localhost'

let failures = 0
const check = (name: string, ok: boolean, detail = ''): void => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures += 1
}

// ===== 环境准备(隔离配置根内):mock 节点 + 真实 Modbus 节点 + Agent 绑定 =====
const { getDcwController } = await import('../server/services/workshop/dcw/dcw-controller')
const { getAgentNodeBindingRepo } = await import('../server/services/workshop/agents/node-bindings.repo')
const AGENT = 'agent-rw-verify'
const mockNode = getDcwController().create({ templateRef: 'dcw-temp-sp', name: 'Agent验证·mock', driver: 'mock', driverConfig: { key: 'agent-rw-mock' }, readIntervalMs: 0 })
const modbusNode = getDcwController().create({
  templateRef: 'dcw-temp-sp', name: 'Agent验证·Modbus真实', driver: 'modbus-tcp', readIntervalMs: 0,
  min: 0, max: 300,
  driverConfig: { host: '127.0.0.1', port: 1502, unitId: 1, register: 40023, dataType: 'float32', byteOrder: 'big' },
})
const repo = getAgentNodeBindingRepo()
repo.bind(AGENT, mockNode.id, 'dcw', 'auto')
repo.bind(AGENT, modbusNode.id, 'dcw', 'auto')
console.log(`mock=${mockNode.id} modbus=${modbusNode.id}(40023)\n`)

// ===== ① 真实 omp 子进程:set_host_tools 含 dcw_read/dcw_control → 协议接受 =====
console.log('--- ① 真实 omp 子进程工具面注入 ---')
const { hostToolsForRole, OmpRpcAgentImpl } = await import('../server/services/workshop/agents/omp-agent')

{
  const tools = hostToolsForRole('worker')
  const child = spawn('omp', ['--mode', 'rpc'], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
  let buf = ''
  let sent = false
  let accepted: unknown = null
  await new Promise<unknown>((resolve) => {
    const timer = setTimeout(() => resolve('timeout'), 30_000)
    child.stdout!.setEncoding('utf-8')
    child.stdout!.on('data', (chunk: string) => {
      buf += chunk
      let idx: number
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx)
        buf = buf.slice(idx + 1)
        if (!line.trim()) continue
        try {
          const frame = JSON.parse(line)
          if (frame.type === 'ready' && !sent) {
            sent = true
            child.stdin!.write(`${JSON.stringify({ id: 'req_tools', type: 'set_host_tools', tools })}\n`)
          }
          else if (frame.type === 'response' && frame.id === 'req_tools') {
            clearTimeout(timer)
            accepted = frame
            resolve(frame)
          }
        }
        catch { /* 非 JSON 行忽略 */ }
      }
    })
    child.on('exit', () => resolve(accepted ?? 'exit'))
  })
  child.kill()
  const resp = accepted as { success?: boolean, data?: { toolNames?: string[] } } | null
  const names = resp?.data?.toolNames ?? []
  check('①真实 omp 接受含 dcw_read/dcw_control 的 set_host_tools',
    !!resp && resp.success === true && names.includes('dcw_read') && names.includes('dcw_control'),
    `工具数=${names.length}`)
}

// ===== ② 真实分发 + 执行:handleHostTool → dcw_read / dcw_control =====
console.log('\n--- ② Agent 工具真实执行(mock) ---')
{
  const impl = new OmpRpcAgentImpl({ agentId: AGENT, name: '读写验证员', role: 'worker', channelId: 'ch-rw-v' })
  // 真实 server 里 workspace 由 run 上下文注入 ensureClient;工具执行体不依赖 workspace
  // 内函数 —— harness 注入最小桩以通过就绪门(与 server 行为一致:非空即放行)
  ;(impl as unknown as { workspace: unknown }).workspace = { listAgents: async () => [] }
  const handle = (impl as unknown as Record<string, (req: unknown) => Promise<{ text: string, isError?: boolean }>>).handleHostTool.bind(impl)

  const r0 = await handle({ toolName: 'dcw_read', arguments: { node_id: mockNode.id } })
  check('②dcw_read:mock 未写入如实报失败(鉴权通过)', r0.isError === true && /读取失败/.test(r0.text) && !/无权/.test(r0.text), r0.text.slice(0, 90))

  const w = await handle({ toolName: 'dcw_control', arguments: { node_id: mockNode.id, value: 175.5, hypothesis: 'Agent 真机验证写入' } })
  check('②Agent 下发 175.5 成功(开优化记录)', !w.isError && /下发成功/.test(w.text), w.text.replace(/\n/g, ' ').slice(0, 100))
  const r1 = await handle({ toolName: 'dcw_read', arguments: { node_id: mockNode.id } })
  check('②dcw_read 读回 ACT=175.5 且与 SET 一致', !r1.isError && /175\.5/.test(r1.text) && /一致/.test(r1.text), r1.text.replace(/\n/g, ' ').slice(0, 120))

  // 越权:未绑定节点读取/写入均拒
  const rDeny = await handle({ toolName: 'dcw_read', arguments: { node_id: 'dw-not-bound' } })
  const wDeny = await handle({ toolName: 'dcw_control', arguments: { node_id: 'dw-not-bound', value: 1 } })
  check('②未绑定节点读取/写入均被拒', rDeny.isError === true && wDeny.isError === true && /无权/.test(rDeny.text) && /无权/.test(wDeny.text))

  // 量程联锁:越工艺安全量程下发被拒
  const wRange = await handle({ toolName: 'dcw_control', arguments: { node_id: mockNode.id, value: 999 } })
  check('②越量程下发被拒(999 ∉ [150,200])', wRange.isError === true && /越出|量程/.test(wRange.text), wRange.text.slice(0, 80))
}

// ===== ③ 真实 Modbus TCP:Agent 写 → 读(真寄存器 roundtrip) =====
console.log('\n--- ③ Agent 经真实 Modbus(1502 从站 40023)读写 ---')
{
  const impl = new OmpRpcAgentImpl({ agentId: AGENT, name: '读写验证员', role: 'worker', channelId: 'ch-rw-v' })
  ;(impl as unknown as { workspace: unknown }).workspace = { listAgents: async () => [] }
  const handle = (impl as unknown as Record<string, (req: unknown) => Promise<{ text: string, isError?: boolean }>>).handleHostTool.bind(impl)

  const wm = await handle({ toolName: 'dcw_control', arguments: { node_id: modbusNode.id, value: 4.5, hypothesis: '真实链路验证' } })
  check('③Agent 经真实 Modbus 下发 4.5 成功(同址回读一致)', !wm.isError && /下发成功/.test(wm.text), wm.text.replace(/\n/g, ' ').slice(0, 110))
  const rm = await handle({ toolName: 'dcw_read', arguments: { node_id: modbusNode.id } })
  check('③Agent 从真实寄存器读回 4.5(ACT=SET)', !rm.isError && /4\.5/.test(rm.text) && /一致/.test(rm.text), rm.text.replace(/\n/g, ' ').slice(0, 130))

  const wm2 = await handle({ toolName: 'dcw_control', arguments: { node_id: modbusNode.id, value: 12.75 } })
  const rm2 = await handle({ toolName: 'dcw_read', arguments: { node_id: modbusNode.id } })
  check('③第二轮:写 12.75 → 读回 12.75', !wm2.isError && !rm2.isError && /12\.75/.test(rm2.text), rm2.text.replace(/\n/g, ' ').slice(0, 110))
}

console.log(failures === 0 ? '\nAGENT-DCW-RW ALL PASS' : `\nAGENT-DCW-RW FAILED(${failures})`)
process.exit(failures === 0 ? 0 : 1)
