/**
 * codex app-server 裸协议探针:initialize → thread/start → turn/start,原样打印全部通知。
 * 运行:node scripts/_dbg-codex-probe.mjs
 */
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, copyFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir, tmpdir } from 'node:os'

const home = mkdtempSync(join(tmpdir(), 'aw-codex-probe-'))
try { copyFileSync(join(homedir(), '.codex', 'auth.json'), join(home, 'auth.json')) } catch {}
console.log('CODEX_HOME=', home)

const child = spawn('cmd.exe', ['/d', '/s', '/c', 'codex app-server'], {
  env: { ...process.env, CODEX_HOME: home },
  stdio: ['pipe', 'pipe', 'pipe'],
  windowsVerbatimArguments: true,
  shell: false,
})
let seq = 0
const pending = new Map()
const rl = createInterface({ input: child.stdout })
rl.on('line', (line) => {
  let f
  try { f = JSON.parse(line) } catch { console.log('[non-json]', line.slice(0, 120)); return }
  if (f.id !== undefined && (f.result !== undefined || f.error !== undefined)) {
    const p = pending.get(f.id)
    if (p) { pending.delete(f.id); p(f) }
    else console.log('[resp-no-waiter]', JSON.stringify(f).slice(0, 200))
    return
  }
  console.log('[notify]', JSON.stringify(f).slice(0, 400))
})
child.stderr.on('data', d => process.stderr.write('[stderr] ' + d))

function request(method, params, timeoutMs = 30_000) {
  const id = ++seq
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout ${method}`)), timeoutMs)
    pending.set(id, (f) => { clearTimeout(timer); f.error ? reject(new Error(JSON.stringify(f.error))) : resolve(f.result) })
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, ...(params !== undefined ? { params } : {}) }) + '\n')
  })
}

const init = await request('initialize', { clientInfo: { name: 'aw-probe', title: 'probe', version: '0.0.1' } })
console.log('[init.result]', JSON.stringify(init).slice(0, 300))
child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'initialized', params: {} }) + '\n')

const thread = await request('thread/start', { cwd: process.cwd(), approvalPolicy: 'on-request', sandbox: 'workspace-write' })
const threadId = thread?.thread?.id ?? thread?.id
console.log('[thread]', threadId)

await request('turn/start', { threadId, input: [{ type: 'text', text: 'Reply with exactly: OK' }] }, 60_000)
console.log('[turn/start accepted]; waiting notifications...')

setTimeout(() => { console.log('[done listening]'); child.kill('SIGKILL'); process.exit(0) }, 45_000)
