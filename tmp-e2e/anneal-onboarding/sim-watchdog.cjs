// 模拟器看门狗(本机已知"模拟器进程周期退出"不稳定的保活措施;轮内使用)
// 用法:node tmp-e2e/anneal-onboarding/sim-watchdog.cjs  (后台常驻;每 20s 探活,死则拉起+boot 设备)
const { spawn } = require('node:child_process')

let restarts = 0
let mesRestarts = 0
async function alive() {
  try {
    const r = await fetch('http://127.0.0.1:4010/api/plant/state', { signal: AbortSignal.timeout(2500) })
    return r.status === 200
  }
  catch { return false }
}
async function mesAlive() {
  try {
    const r = await fetch('http://127.0.0.1:15060/health', { signal: AbortSignal.timeout(2500) })
    return r.status === 200
  }
  catch { return false }
}
async function bootDevices() {
  try {
    const ns = await (await fetch('http://127.0.0.1:4010/api/nodes')).json()
    for (const n of (ns.data ?? []).filter(x => x.enabled)) {
      try {
        await fetch(`http://127.0.0.1:4010/api/nodes/${n.id}/start`, { method: 'POST' })
      }
      catch { /* 单设备失败继续 */ }
    }
  }
  catch { /* ignore */ }
}
console.log('[sim-watchdog] on')
setInterval(async () => {
  if (!(await alive())) {
    restarts += 1
    console.log(`[sim-watchdog] plc dead at ${new Date().toISOString().slice(11, 19)} — restarting (#${restarts})`)
    try {
      spawn('node', ['scripts/_plc-sim-detached.cjs'], { cwd: process.cwd(), stdio: 'ignore' }).unref()
    }
    catch { /* ignore */ }
    await new Promise(r => setTimeout(r, 8000))
    await bootDevices()
    console.log('[sim-watchdog] plc restarted + devices booted')
  }
  if (!(await mesAlive())) {
    mesRestarts += 1
    console.log(`[sim-watchdog] mes dead at ${new Date().toISOString().slice(11, 19)} — restarting (#${mesRestarts})`)
    try {
      const p = spawn('node', ['scripts/dev-mes-simulator.mjs', '--port', '15060'], { cwd: process.cwd(), detached: true, stdio: 'ignore' })
      p.unref()
    }
    catch { /* ignore */ }
  }
}, 20_000)
