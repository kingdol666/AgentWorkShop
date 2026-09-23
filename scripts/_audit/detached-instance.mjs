/**
 * 把 AgentWorkShop 以**真分离**方式拉起(dev 或 start),用于真实 E2E 的长跑服务。
 *
 * 为什么不用 agent 工具的后台作业:回合结束/回收时会连子进程一起终止,
 * 表现为「日志停在半路、无 fatal、端口释放、退出码 1」,极易误判成服务崩溃。
 *
 * 为什么带隔离:`ensureDataDir()` 在 repo 模式下解析到 `.AgentWorkShop/data`
 * (线上累积数据)。E2E 必须用**全新 AW_HOME**(home 模式),否则会污染真实库,
 * 也会读到历史脏数据导致断言随机失败。
 *
 * 用法:
 *   node scripts/_audit/detached-instance.mjs --port 3457 [--mode dev|start] [--home <dir>]
 *   node scripts/_audit/detached-instance.mjs --port 3457 --status
 *   node scripts/_audit/detached-instance.mjs --port 3457 --stop
 */
import { spawn, spawnSync } from 'node:child_process'
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const arg = (k, d) => {
  const i = process.argv.indexOf(k)
  return i >= 0 ? process.argv[i + 1] : d
}
const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const PORT = Number(arg('--port', '3457'))
const MODE = arg('--mode', 'dev')
const HOME = resolve(arg('--home', join(repo, '.e2e-home')))
const LOG = resolve(arg('--log', join(repo, `.e2e-${MODE}-${PORT}.log`)))
const PIDFILE = `${LOG}.pid`
const BASE = `http://127.0.0.1:${PORT}`

const health = async () => {
  try {
    const r = await fetch(`${BASE}/api/health`, { signal: AbortSignal.timeout(8000) })
    const j = await r.json()
    return j?.data?.status === 'ok' ? { ok: true, version: j.data.version, uptimeMs: j.data.uptimeMs } : { ok: false }
  }
  catch { return { ok: false } }
}

if (process.argv.includes('--status')) {
  const h = await health()
  console.log(h.ok ? `✔ 健康 version=${h.version} uptime=${Math.round(h.uptimeMs / 1000)}s` : '✖ 不可达')
  const pid = existsSync(PIDFILE) ? readFileSync(PIDFILE, 'utf8').trim() : '(无 pid 文件)'
  console.log(`  pid=${pid}  log=${LOG}  AW_HOME=${HOME}`)
  if (existsSync(LOG)) {
    const tail = readFileSync(LOG, 'utf8').split(/\r?\n/).filter(Boolean).slice(-8)
    for (const l of tail) console.log('    ' + l.slice(0, 160))
  }
  process.exitCode = h.ok ? 0 : 1
}
else if (process.argv.includes('--stop')) {
  const pid = existsSync(PIDFILE) ? Number(readFileSync(PIDFILE, 'utf8').trim()) : NaN
  if (Number.isInteger(pid)) {
    const r = spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' })
    console.log(r.status === 0 ? `✔ 已终止 pid=${pid}` : `· taskkill 退出码 ${r.status}(可能已退出)`)
  }
  else console.log('· 无 pid 文件')
}
else {
  const pre = await health()
  if (pre.ok) {
    console.log(`· ${BASE} 已有健康实例(version=${pre.version}),不重复启动`)
  }
  else {
    mkdirSync(HOME, { recursive: true })
    const out = openSync(LOG, 'a')
    // 本机 7890 代理会拦 localhost;AW_MODE=home + AW_HOME 指向全新目录 = 完全隔离
    const env = {
      ...process.env,
      NO_PROXY: '127.0.0.1,localhost',
      HTTP_PROXY: '',
      HTTPS_PROXY: '',
      no_proxy: '127.0.0.1,localhost',
      AW_MODE: 'home',
      AW_HOME: HOME,
      NUXT_SESSION_PASSWORD: process.env.NUXT_SESSION_PASSWORD ?? 'e2e-session-password-0123456789abcdef',
    }
    const args = [join(repo, 'bin', 'aw.mjs'), MODE, '--port', String(PORT)]
    const child = spawn(process.execPath, args, { cwd: repo, env, detached: true, windowsHide: true, stdio: ['ignore', out, out] })
    closeSync(out)
    child.unref()
    writeFileSync(PIDFILE, String(child.pid), 'utf8')
    console.log(`✔ 已分离启动(${MODE}) pid=${child.pid} → ${BASE}`)
    console.log(`  AW_HOME=${HOME}`)
    console.log(`  日志 ${LOG}`)

    const waitS = Number(arg('--wait', MODE === 'dev' ? '180' : '60'))
    let ok = false
    for (let i = 0; i < waitS; i += 3) {
      await new Promise(r => setTimeout(r, 3000))
      const h = await health()
      if (h.ok) {
        console.log(`✔ 健康门通过 version=${h.version}(${i + 3}s)`)
        ok = true
        break
      }
    }
    if (!ok) {
      console.error(`✖ ${waitS}s 内未通过健康门,看日志:${LOG}`)
      if (existsSync(LOG)) {
        const tail = readFileSync(LOG, 'utf8').split(/\r?\n/).filter(Boolean).slice(-15)
        for (const l of tail) console.error('    ' + l.slice(0, 160))
      }
      process.exitCode = 1
    }
    else if (existsSync(LOG)) {
      console.log(`  日志大小 ${(statSync(LOG).size / 1024).toFixed(1)} KB`)
    }
  }
}
