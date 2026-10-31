#!/usr/bin/env node
/**
 * mcp-bridge-e2e-demo.mjs —— 真桥实测:aw-mcp-bridge.mjs 以 stdio MCP 子进程拉起,
 * 验证「harness 只传业务参数,agentId 由框架注入」三件事:
 *   1) tools/list:引擎可见 schema 中不存在任何 agentId 参数
 *   2) tools/call 只传业务参数:成功,结果按 env 身份的绑定面裁剪
 *   3) 在工具参数里伪造 agentId:被忽略,结果仍按 env 身份执行
 * 用法:node docs/dev/onboarding-e2e-20261028/mcp-bridge-e2e-demo.mjs
 */
import { spawn } from 'node:child_process'

const BASE_URL = 'http://127.0.0.1:3105'
const AGENT_ID = process.env.DEMO_AGENT_ID ?? ''
const AGENT_TOKEN = process.env.DEMO_AGENT_TOKEN ?? ''
if (!AGENT_ID || !AGENT_TOKEN) {
  console.error('需要 DEMO_AGENT_ID / DEMO_AGENT_TOKEN 环境变量')
  process.exit(1)
}

const child = spawn(process.execPath, ['server/harness/aw-mcp-bridge.mjs'], {
  env: {
    ...process.env,
    AW_BASE_URL: BASE_URL,
    AW_AGENT_ID: AGENT_ID,
    AW_AGENT_TOKEN: AGENT_TOKEN,
    AW_MCP_TOOL_TIMEOUT_MS: '60000',
    NO_PROXY: '127.0.0.1,localhost',
  },
  stdio: ['pipe', 'pipe', 'pipe'],
})
child.stderr.on('data', d => process.stderr.write(`[bridge stderr] ${d}`))

const pending = new Map()
let nextId = 1
const lines = []
let buf = ''
child.stdout.on('data', (chunk) => {
  buf += chunk.toString()
  let idx
  while ((idx = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, idx).trim()
    buf = buf.slice(idx + 1)
    if (!line) continue
    try {
      const msg = JSON.parse(line)
      if (msg.id && pending.has(msg.id)) {
        pending.get(msg.id)(msg)
        pending.delete(msg.id)
      }
      else lines.push(msg)
    }
    catch { /* 非JSON行忽略 */ }
  }
})

function request(method, params, timeoutMs = 45_000) {
  const id = nextId++
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`${method} 超时`)) }, timeoutMs)
    pending.set(id, (msg) => { clearTimeout(timer); resolve(msg) })
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
  })
}
const textOf = (resp) => {
  const c = resp?.result?.content
  return String(Array.isArray(c) ? c.map(x => x.text ?? '').join('') : '')
}

/* 1) MCP 握手 */
const init = await request('initialize', {
  protocolVersion: '2024-11-05',
  capabilities: {},
  clientInfo: { name: 'aw-bridge-demo', version: '1.0.0' },
})
console.log('══ 1. MCP 握手:', init.result?.serverInfo?.name ?? JSON.stringify(init).slice(0, 120))
child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`)

/* 2) tools/list:引擎可见 schema 不得含 agentId */
const list = await request('tools/list', {})
const tools = list.result?.tools ?? []
// 只检查「调用者身份」语义的参数;to_agent_id(消息接收方)等业务参数不算。
// 实测 71 工具中唯一含 agent 字样的是 send_message_to_agent.to_agent_id(收件人)。
const CALLER_IDENTITY_PARAMS = new Set(['agentid', 'agent_id', 'callerid', 'caller_id', 'selfagentid'])
const withAgentId = tools.filter((t) => {
  const props = t.inputSchema?.properties ?? t.parameters?.properties ?? {}
  return Object.keys(props).some((k) => CALLER_IDENTITY_PARAMS.has(k.toLowerCase()))
})
console.log(`══ 2. tools/list: ${tools.length} 个工具;含 agentId 参数的工具 = ${withAgentId.length} 个${withAgentId.length ? ' ←✗' : ' ←✓ 引擎无需也无法传身份'}`)
console.log('   工具抽样:', tools.slice(0, 8).map(t => t.name).join(', '), '…')

/* 3) tools/call 只传业务参数(my_industrial_nodes:查看我的绑定面) */
const call1 = await request('tools/call', { name: 'my_industrial_nodes', arguments: {} })
const t1 = textOf(call1)
console.log('══ 3. tools/call(my_industrial_nodes, 零业务参数) isError =', call1.result?.isError ?? false)
console.log('   回包(前 320 字):', t1.replace(/\n/g, ' | ').slice(0, 320))

/* 4) 参数伪造 agentId(冒充工艺工程师) → 必须被忽略,仍按 env 身份执行 */
const FORGED = '6cce84ea-d5f0-4dda-9a29-8b77a669ab26'
const call2 = await request('tools/call', { name: 'my_industrial_nodes', arguments: { agentId: FORGED } })
const t2 = textOf(call2)
const showsForged = t2.includes('rc-c4ccb815') // 伪造目标的配方绑定面
console.log('══ 4. tools/call 参数内伪造 agentId(冒充工艺工程师) isError =', call2.result?.isError ?? false)
console.log('   伪造是否生效(出现被冒充者的配方绑定面) =', showsForged ? '是 ←✗ 严重缺陷' : '否 ←✓ 身份只来自进程 env')
console.log('   回包(前 240 字):', t2.replace(/\n/g, ' | ').slice(0, 240))

/* 5) 越权写经桥路径被 verify 拦截(身份注入 + 执行面校验全链) */
const call3 = await request('tools/call', {
  name: 'recipe_propose',
  arguments: { recipe_id: 'rc-c4ccb815', packages: [{ name: 'T-桥路径越权', params: [{ node_id: 'dw-3c4ef389', to: 120, basis: 'x', exp_ref: 'y' }] }] },
})
const t3 = textOf(call3)
console.log('══ 5. tools/call(recipe_propose 越权写,数据分析师无写授权) isError =', call3.result?.isError ?? true)
console.log('   拒绝报文(前 200 字):', t3.replace(/\n/g, ' | ').slice(0, 200))

child.kill()
const pass = tools.length > 0 && withAgentId.length === 0 && !showsForged && (call3.result?.isError === true)
console.log(`\n═══ 真桥实测结论: ${pass ? 'PASS(注入/防伪造/verify 全部符合设计)' : 'FAIL'} ═══`)
process.exit(pass ? 0 : 1)
