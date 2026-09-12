/**
 * 把 `aw start` 以**真分离**方式拉起(脱离 agent 作业的进程组),日志落文件。
 *
 * 为什么需要它:agent 工具的后台作业在回合结束/被回收时会连子进程一起终止,
 * 而 `aw start` 的 stdout 缓冲区随之丢失 —— 表现为「日志停在半路、无 fatal 行、
 * 端口释放、退出码 1」,极易误判成服务自己崩了(实测踩过两次)。
 *
 * 做法:node 的 spawn + detached + stdio 重定向到文件。
 * Windows 上还要 unref 并用 windowsHide,否则父进程退出时子进程一起走。
 *
 * 用法:
 *   node scripts/_audit/detached-start.mjs [--log <path>] [--cwd <dir>] [--port 3001] [--wait 45]
 *   node scripts/_audit/detached-start.mjs --status     # 只看健康门与日志尾
 *   node scripts/_audit/detached-start.mjs --stop       # 停掉分离实例
 */
import { spawn, spawnSync } from 'node:child_process'
import { closeSync, existsSync, openSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const arg = (k, d) => {
  const i = process.argv.indexOf(k)
  return i >= 0 ? process.argv[i + 1] : d
}
const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const CWD = resolve(arg('--cwd', repo))
const PORT = Number(arg('--port', '3001'))
const LOG = resolve(arg('--log', join(CWD, '..', 'aw-detached.log')))
const PIDFILE = LOG + '.pid'
const BASE = `http://127.0.0.1:${PORT}`

const health = async () => {
  try {
    const r = await fetch(`${BASE}/api/health`, { signal: AbortSignal.timeout(6000) })
    const j = await r.json()
    return j?.data?.status === 'ok' ? { ok: true, version: j.data.version, uptimeMs: j.data.uptimeMs } : { ok: false }
  }
  catch { return { ok: false } }
}

if (process.argv.includes('--status')) {
  const h = await health()
  console.log(h.ok ? `✔ 健康 version=${h.version} uptime=${Math.round(h.uptimeMs / 1000)}s` : '✖ 不可达')
  const pid = existsSync(PIDFILE) ? readFileSync(PIDFILE, 'utf8').trim() : '(无 pid 文件)'
  console.log(`  分离 pid 文件: ${pid}`)
  if (existsSync(LOG)) {
    const size = statSync(LOG).size
    const tail = readFileSync(LOG, 'utf8').split(/\r?\n/).slice(-6)
    console.log(`  日志 ${LOG} (${(size / 1024).toFixed(1)} KB) 尾部:`)
    for (const l of tail) if (l.trim()) console.log('    ' + l.slice(0, 150))
  }
  process.exitCode = h.ok ? 0 : 1
}

else if (process.argv.includes('--stop')) {
  const pid = existsSync(PIDFILE) ? Number(readFileSync(PIDFILE, 'utf8').trim()) : NaN
  if (Number.isInteger(pid)) {
    const r = spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' })
    console.log(r.status === 0 ? `✔ 已终止分离实例 pid=${pid}` : `· taskkill 退出码 ${r.status}(进程可能已退出)`)
  }
  else console.log('· 无 pid 文件,改用 aw stop')
  if (!Number.isInteger(pid)) spawnSync('aw', ['stop'], { cwd: CWD, stdio: 'inherit', shell: true })
}

else {
  const pre = await health()
  if (pre.ok) {
    console.log(`· ${BASE} 已有健康实例(version=${pre.version}),不重复启动`)
    process.exitCode = 0
  }
  else {
    const out = openSync(LOG, 'a')
    // 只清大小写重复的代理变量:7890 会拦 localhost
    const env = { ...process.env, NO_PROXY: '127.0.0.1,localhost', HTTP_PROXY: '', HTTPS_PROXY: '' }
    const child = spawn(process.execPath, [join(repo, 'bin', 'aw.mjs'), 'start', '--port', String(PORT)], {
      cwd: CWD,
      env,
      detached: true,
      windowsHide: true,
      stdio: ['ignore', out, out],
    })
    closeSync(out)
    child.unref()
    const { writeFileSync } = await import('node:fs')
    writeFileSync(PIDFILE, String(child.pid), 'utf8')
    console.log(`✔ 已分离启动 pid=${child.pid} → ${BASE},日志 ${LOG}`)

    const waitS = Number(arg('--wait', '45'))
    for (let i = 0; i < waitS; i += 3) {
      await new Promise(r => setTimeout(r, 3000))
      const h = await health()
      if (h.ok) {
        console.log(`✔ 健康门通过 version=${h.version}(${(i + 3)}s)`)
        process.exitCode = 0
        break
      }
    }
    if (process.exitCode === undefined) {
      console.error(`✖ ${waitS}s 内未通过健康门,看日志:${LOG}`)
      process.exitCode = 1
    }
  }
}
