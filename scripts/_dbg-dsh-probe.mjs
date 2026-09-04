/**
 * dsh ACP 裸协议探针:spawn `dsh --profile acp`,发 initialize,原样打印 stdout/stderr。
 * 运行:node scripts/_dbg-dsh-probe.mjs
 */
import { spawn } from 'node:child_process'

const child = spawn('cmd.exe', ['/d', '/s', '/c', 'dsh --profile acp'], {
  env: { ...process.env },
  stdio: ['pipe', 'pipe', 'pipe'],
  windowsVerbatimArguments: true,
  shell: false,
})
child.stdout.on('data', (d) => process.stdout.write('[out] ' + d))
child.stderr.on('data', (d) => process.stderr.write('[err] ' + d))
child.on('exit', (code) => { console.log('[exit]', code); process.exit(0) })

setTimeout(() => {
  console.log('\n── sending initialize (t+15s) ──')
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: 1, clientCapabilities: {} } }) + '\n')
}, 15_000)

setTimeout(() => {
  console.log('\n── resending initialize (t+40s) ──')
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'initialize', params: { protocolVersion: 1, clientCapabilities: {} } }) + '\n')
}, 40_000)

setTimeout(() => {
  console.log('\n── timeout, killing ──')
  child.kill('SIGKILL')
  process.exit(0)
}, 70_000)
