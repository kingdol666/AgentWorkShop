/**
 * 2026-10-28 验收轮专用:真分离拉起 PLC 模拟器(脱离会话进程组)。
 * 用法: node scripts/_audit/_detached-sim-20261028.mjs --port 4020
 * 幂等:端口已有健康实例则跳过。pid 写 <cwd>/.e2e-tmp/live-mission-3470/sim-<port>.pid
 */
import { spawn } from 'node:child_process'
import { mkdirSync, openSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const arg = (k, d) => {
  const i = process.argv.indexOf(k)
  return i >= 0 ? process.argv[i + 1] : d
}
const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const PORT = Number(arg('--port', '4020'))
const outDir = join(repo, '.e2e-tmp', 'live-mission-3470')
mkdirSync(outDir, { recursive: true })

const probe = await fetch(`http://127.0.0.1:${PORT}/api/nodes`, { signal: AbortSignal.timeout(2500) })
  .then(r => r.ok).catch(() => false)
if (probe) {
  console.log(`· ${PORT} 已有模拟器,跳过`)
  process.exit(0)
}

const out = openSync(join(outDir, `sim-${PORT}.log`), 'a')
const env = { ...process.env, NO_PROXY: '127.0.0.1,localhost', HTTP_PROXY: '', HTTPS_PROXY: '' }
const child = spawn(process.execPath, [join(repo, 'scripts', 'dev-plc-simulator.mjs'), '--port', String(PORT)], {
  cwd: repo, env, detached: true, windowsHide: true, stdio: ['ignore', out, out],
})
writeFileSync(join(outDir, `sim-${PORT}.pid`), String(child.pid))
child.unref()
console.log(`✔ 模拟器分离启动 pid=${child.pid} port=${PORT}`)

let ok = false
for (let i = 0; i < 10; i++) {
  await new Promise(r => setTimeout(r, 1000))
  ok = await fetch(`http://127.0.0.1:${PORT}/api/nodes`, { signal: AbortSignal.timeout(2000) })
    .then(r => r.ok).catch(() => false)
  if (ok) break
}
console.log(ok ? `✔ 模拟器就绪 port=${PORT}` : `✖ 10s 未就绪,看日志 ${outDir}/sim-${PORT}.log`)
process.exit(ok ? 0 : 1)
