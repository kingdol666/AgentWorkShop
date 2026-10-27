/**
 * 2026-10-28 验收轮专用:真分离拉起 MES REST 模拟器(自定义 MES API 面供 US-005 绑定)。
 * 用法: node scripts/_audit/_detached-mes-20261028.mjs --port 15160
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
const PORT = Number(arg('--port', '15160'))
const outDir = join(repo, '.e2e-tmp', 'live-mission-3470')
mkdirSync(outDir, { recursive: true })

const probe = await fetch(`http://127.0.0.1:${PORT}/api/v1/batches`, { signal: AbortSignal.timeout(2500) })
  .then(r => r.status < 500).catch(() => false)
if (probe) {
  console.log(`· ${PORT} 已有 MES 模拟器,跳过`)
  process.exit(0)
}

const out = openSync(join(outDir, `mes-${PORT}.log`), 'a')
const env = {
  ...process.env,
  NO_PROXY: '127.0.0.1,localhost', HTTP_PROXY: '', HTTPS_PROXY: '',
  MES_SIM_PORT: String(PORT),
  MES_SIM_TOKEN: 'mission-mes-token-2026',
}
const child = spawn(process.execPath, [join(repo, 'scripts', 'dev-mes-simulator.mjs'), '--port', String(PORT)], {
  cwd: repo, env, detached: true, windowsHide: true, stdio: ['ignore', out, out],
})
writeFileSync(join(outDir, `mes-${PORT}.pid`), String(child.pid))
child.unref()
console.log(`✔ MES 模拟器分离启动 pid=${child.pid} port=${PORT}`)

let ok = false
for (let i = 0; i < 10; i++) {
  await new Promise(r => setTimeout(r, 1000))
  ok = await fetch(`http://127.0.0.1:${PORT}/api/v1/batches`, { signal: AbortSignal.timeout(2000) })
    .then(r => r.status < 500).catch(() => false)
  if (ok) break
}
console.log(ok ? `✔ MES 模拟器就绪 port=${PORT}` : `✖ 10s 未就绪,看日志 ${outDir}/mes-${PORT}.log`)
process.exit(ok ? 0 : 1)
