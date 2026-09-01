/**
 * 本地协议测试栈启动器:dev server + 4 个模拟器 + mini RTU 从站,一键拉起。
 * 用法:node scripts/_dev-stack.mjs  (前台常驻;stop = kill 本进程树)
 */
import { spawn, spawnSync } from 'node:child_process'

const killPort = (port) => {
  const out = spawnSync('cmd.exe', ['/c', `netstat -ano | findstr ":${port}" | findstr "LISTENING"`]).stdout?.toString() ?? ''
  for (const line of out.split('\n')) {
    const pid = line.trim().split(/\s+/).pop()
    if (pid && /^\d+$/.test(pid)) {
      try {
        spawnSync('taskkill', ['/PID', pid, '/T', '/F'], { shell: 'cmd.exe', stdio: 'ignore' })
      }
      catch { /* 已退出 */ }
    }
  }
}

for (const p of [3000, 1502, 4840, 1883, 1889, 15030]) killPort(p)

const logs = {}
const start = (name, cmd, args, env = {}) => {
  const child = spawn(process.execPath, cmd, { args, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] })
  logs[name] = ''
  const keep = (d) => {
    logs[name] += d
    if (logs[name].length > 8000)
      logs[name] = logs[name].slice(-4000)
  }
  child.stdout.on('data', keep)
  child.stderr.on('data', keep)
  child.on('exit', (c) => {
    logs[name] += `\n[exited ${c}]`
  })
  return child
}

start('dev', ['scripts/dev-guard.mjs', 'dev'])
start('modbus-sim', ['scripts/dev-modbus-simulator.mjs'])
start('opcua-sim', ['scripts/dev-opcua-simulator.mjs'])
start('proto-sim', ['scripts/dev-protocol-simulators.mjs'])
start('rtu-slave', ['scripts/_rtu-mini-slave.mjs'])

setInterval(() => {}, 10_000)
console.log('[dev-stack] 已启动:dev/modbus-sim/opcua-sim/proto-sim/rtu-slave')
