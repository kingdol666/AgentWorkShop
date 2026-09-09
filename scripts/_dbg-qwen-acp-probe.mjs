/**
 * qwen ACP 手工探针:initialize → sendUserMessage,完整抓 stderr。
 * 运行:ZHIPU_API_KEY=... node scripts/_dbg-qwen-acp-probe.mjs
 */
import { spawn } from 'node:child_process'

const key = process.env.ZHIPU_API_KEY
if (!key) throw new Error('export ZHIPU_API_KEY first')
const env = {
  ...process.env,
  OPENAI_API_KEY: process.env.OPENAI_API_KEY ?? key,
  OPENAI_BASE_URL: process.env.OPENAI_BASE_URL ?? 'https://open.bigmodel.cn/api/coding/paas/v4',
}
const child = spawn('cmd.exe', ['/d', '/s', '/c', 'qwen -m glm-5.3-flash --experimental-acp --allowed-mcp-server-names aw'], { env, shell: false, stdio: ['pipe', 'pipe', 'pipe'], windowsVerbatimArguments: true })
let buf = ''
child.stdout.on('data', (d) => {
  buf += d
  let i
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i)
    buf = buf.slice(i + 1)
    if (line.trim()) console.log('IN>', line.slice(0, 300))
  }
})
child.stderr.on('data', (d) => process.stderr.write(`[err] ${String(d)}`))
const send = (o) => child.stdin.write(`${JSON.stringify(o)}\n`)
let id = 0
setTimeout(() => send({ jsonrpc: '2.0', id: ++id, method: 'initialize', params: { protocolVersion: 1, clientCapabilities: {} } }), 4000)
setTimeout(() => send({ jsonrpc: '2.0', id: ++id, method: 'sendUserMessage', params: { chunks: [{ text: 'reply with exactly: ok' }] } }), 12000)
setTimeout(() => { child.kill('SIGKILL'); process.exit(0) }, 60000)
