/**
 * PLC 模拟器子进程启动助手(供验证脚本复用)。
 * 启动 scripts/dev-plc-simulator.mjs 并等待「就绪」;返回句柄与 kill()。
 */
import { spawn } from 'node:child_process'

export function startPlcSim(port) {
  const sim = spawn(process.execPath, ['scripts/dev-plc-simulator.mjs', '--port', String(port)], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
  const ready = new Promise((resolve) => {
    const t = setTimeout(() => resolve(false), 8000)
    sim.stdout.on('data', (d) => {
      if (String(d).includes('就绪')) {
        clearTimeout(t)
        resolve(true)
      }
    })
    sim.stderr.on('data', () => {})
  })
  return {
    ready,
    kill: () => {
      try {
        sim.kill()
      }
      catch { /* 已退出 */ }
    },
  }
}
