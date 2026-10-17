// 构建产物冒烟:从 .output 起隔离生产实例,探健康页,验证预检代码随包分发。
import { spawn, spawnSync } from 'node:child_process'
import { mkdirSync, openSync } from 'node:fs'
import { join } from 'node:path'

const REPO = process.cwd()
const ROOT = 'D:/tmp/aw-smoke'
mkdirSync(ROOT, { recursive: true })
const port = 3992
const logPath = join(ROOT, 'out.log')
const fd = openSync(logPath, 'a')
const child = spawn(process.execPath, ['.output/server/index.mjs'], {
  cwd: REPO,
  env: {
    ...process.env,
    AW_MODE: 'home',
    AW_HOME: ROOT,
    PORT: String(port),
    NITRO_PORT: String(port),
    NUXT_SESSION_PASSWORD: 'smoke-only-session-password-0123456789abcdef',
    AW_RATE_LIMIT_OFF: '1',
    NO_PROXY: '127.0.0.1,localhost',
  },
  stdio: ['ignore', fd, fd],
  windowsHide: true,
})

const base = `http://127.0.0.1:${port}`
let ok = false
let health = null
try {
  for (let i = 0; i < 40; i++) {
    await new Promise(r => setTimeout(r, 1500))
    try {
      const res = await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(2500) })
      if (res.ok) {
        health = await res.json().catch(() => null)
        ok = true
        break
      }
    }
    catch { /* 未就绪 */ }
  }
  console.log(ok ? `✔ 构建产物启动成功: GET /api/health 200 → ${JSON.stringify(health).slice(0, 160)}` : '✖ 健康检查超时')
  // 预检文案与动作名随产物分发(打包完整性)
  const { readFileSync, readdirSync, statSync } = await import('node:fs')
  const hits = []
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name)
      const st = statSync(p)
      if (st.isDirectory()) { if (name !== 'node_modules') walk(p) }
      else if (name.endsWith('.mjs')) {
        const s = readFileSync(p, 'utf8')
        if (s.includes('引用校验') && s.includes('tool.call.denied')) hits.push(p)
      }
    }
  }
  walk(join(REPO, '.output', 'server', 'chunks'))
  console.log(hits.length > 0 ? `✔ 预检代码已进产物: ${hits.slice(0, 2).join(', ')}` : '✖ 产物中未找到预检代码')
  if (!hits.length) ok = false
}
finally {
  try { spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' }) } catch { /* ignore */ }
}
console.log(ok ? '═══ BUILD SMOKE PASS ═══' : '═══ BUILD SMOKE FAIL ═══')
process.exit(ok ? 0 : 1)
