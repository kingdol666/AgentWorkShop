/**
 * opencode impl 启动聚焦探针:复现 e2e 的 spawn+健康探测路径,逐次打印探测结果。
 * 运行:npx tsx --tsconfig .nuxt/tsconfig.server.json scripts/_dbg-opencode-start.ts
 */
import { spawn as launchChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { createServer } from 'node:net'

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer()
    srv.unref()
    srv.on('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address()
      const port = typeof addr === 'object' && addr ? addr.port : 0
      srv.close(() => (port ? resolve(port) : reject(new Error('无可用端口'))))
    })
  })
}

const port = await freePort()
const password = randomUUID()
console.log('port=', port)
const child = launchChildProcess('opencode', ['serve', '--port', String(port), '--hostname', '127.0.0.1'], {
  cwd: process.cwd(),
  env: { ...process.env, OPENCODE_SERVER_PASSWORD: password },
  windowsHide: true,
  shell: false,
})
console.log('pid=', child.pid)
child.stdout?.on('data', (d: Buffer) => process.stdout.write(`[out] ${d}`))
child.stderr?.on('data', (d: Buffer) => process.stderr.write(`[err] ${d}`))
child.on('exit', code => console.log('exit', code))
child.on('error', err => console.log('spawn error', err.message))

const basic = `Basic ${Buffer.from(`opencode:${password}`).toString('base64')}`
const deadline = Date.now() + 45_000
let n = 0
while (Date.now() < deadline) {
  n++
  try {
    const res = await fetch(`http://127.0.0.1:${port}/global/health`, {
      headers: { authorization: basic },
      signal: AbortSignal.timeout(2000),
    })
    const text = await res.text()
    console.log(`attempt ${n}: ${res.status} ${text.slice(0, 80)}`)
    if (res.ok) break
  }
  catch (err) {
    if (n % 10 === 0) console.log(`attempt ${n}: ${(err as Error).message}`)
  }
  await new Promise(r => setTimeout(r, 500))
}
child.kill('SIGKILL')
process.exit(0)
