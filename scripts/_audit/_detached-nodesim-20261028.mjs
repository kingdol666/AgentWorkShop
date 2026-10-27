/**
 * 2026-10-28 验收轮专用:真分离拉起 plc-node-simulator 多节点模拟器(presets/物理引擎)。
 * 用法: node scripts/_audit/_detached-nodesim-20261028.mjs --port 4020
 * 端口约定:SIM_PORT=<port>,MQTT broker 固定 18830(presets 烘焙地址)。
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
  console.log(`· ${PORT} 已有节点模拟器,跳过`)
  process.exit(0)
}

const out = openSync(join(outDir, `nodesim-${PORT}.log`), 'a')
const simDir = join(repo, 'plc-node-simulator')
const env = {
  ...process.env,
  NO_PROXY: '127.0.0.1,localhost', HTTP_PROXY: '', HTTPS_PROXY: '',
  SIM_PORT: String(PORT),
  MQTT_BROKER_PORT: '18830',
}
const child = spawn(process.execPath, [join('node_modules', 'tsx', 'dist', 'cli.mjs'), join('src', 'server', 'index.ts')], {
  cwd: simDir, env, detached: true, windowsHide: true, stdio: ['ignore', out, out],
})
writeFileSync(join(outDir, `nodesim-${PORT}.pid`), String(child.pid))
child.unref()
console.log(`✔ 节点模拟器分离启动 pid=${child.pid} port=${PORT}`)

let ok = false
for (let i = 0; i < 40; i++) {
  await new Promise(r => setTimeout(r, 1000))
  ok = await fetch(`http://127.0.0.1:${PORT}/api/nodes`, { signal: AbortSignal.timeout(2000) })
    .then(r => r.ok).catch(() => false)
  if (ok) break
}
console.log(ok ? `✔ 节点模拟器就绪 port=${PORT}` : `✖ 40s 未就绪,看日志 ${outDir}/nodesim-${PORT}.log`)
process.exit(ok ? 0 : 1)
