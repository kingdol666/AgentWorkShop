// 全局包冒烟:临时 prefix 安装的 0.7.66 起隔离实例,断言健康页版本/应用就绪。
import { spawn, spawnSync } from 'node:child_process'
import { mkdirSync, openSync } from 'node:fs'
import { join } from 'node:path'

const BIN = 'D:/tmp/aw-global/node_modules/agentworkshop/bin/aw.mjs'
const ROOT = 'D:/tmp/aw-global-home'
const CWD = 'D:/tmp/aw-global-run'
mkdirSync(ROOT, { recursive: true })
mkdirSync(CWD, { recursive: true })
const port = 3991
const fd = openSync(join(ROOT, 'out.log'), 'a')
const child = spawn(process.execPath, [BIN, 'start', '--port', String(port)], {
  cwd: CWD,
  env: {
    ...process.env,
    AW_MODE: 'home',
    AW_HOME: ROOT,
    NUXT_SESSION_PASSWORD: 'global-smoke-session-password-0123456789abcdef',
    AW_RATE_LIMIT_OFF: '1',
    NO_PROXY: '127.0.0.1,localhost',
  },
  stdio: ['ignore', fd, fd],
  windowsHide: true,
})

const base = `http://127.0.0.1:${port}`
let ok = false
try {
  for (let i = 0; i < 50; i++) {
    await new Promise(r => setTimeout(r, 1500))
    try {
      const res = await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(2500) })
      if (res.ok) {
        const body = await res.json()
        const version = body?.data?.version ?? '?'
        ok = version === '0.7.66'
        console.log(`${ok ? '✔' : '✖'} 全局包健康页: version=${version}(期望 0.7.66)`)
        break
      }
    }
    catch { /* 未就绪 */ }
  }
  if (ok) {
    const res = await fetch(`${base}/api/users/setup-status`, { signal: AbortSignal.timeout(5000) })
    console.log(`${res.ok ? '✔' : '✖'} /api/users/setup-status → ${res.status}`)
  }
  else {
    console.log('✖ 全局包实例未在 75s 内就绪')
  }
}
finally {
  try { spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' }) } catch { /* ignore */ }
}
console.log(ok ? '═══ GLOBAL PACKAGE SMOKE PASS ═══' : '═══ GLOBAL PACKAGE SMOKE FAIL ═══')
process.exit(ok ? 0 : 1)
