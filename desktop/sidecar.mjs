import { spawn, spawnSync } from 'node:child_process'
import { createHmac, randomBytes } from 'node:crypto'
import { createServer } from 'node:net'
import { join } from 'node:path'
import { setTimeout as wait } from 'node:timers/promises'

const HOST = '127.0.0.1'

async function allocatePort() {
  const server = createServer()
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, HOST, resolve)
  })
  const { port } = server.address()
  await new Promise((resolve, reject) => server.close(err => err ? reject(err) : resolve()))
  return port
}

export function isAppUrl(raw, origin) {
  try {
    const url = new URL(raw)
    return url.protocol === 'http:' && url.origin === origin && !url.username && !url.password
  }
  catch {
    return false
  }
}

export async function startSidecar({ node, backend, home, log, env = process.env }) {
  const port = await allocatePort()
  const secret = randomBytes(32).toString('hex')
  const sessionPassword = env.NUXT_SESSION_PASSWORD || randomBytes(32).toString('hex')
  const launcher = join(backend, 'scripts', 'start.mjs')
  const baseEnv = { ...env }
  for (const key of ['AW_DATA_DIR', 'AW_PACKAGE_ROOT', 'AW_STOP_TOKEN', 'AW_PARENT_PID', 'NODE_OPTIONS', 'NODE_PATH', 'NODE_USE_ENV_PROXY', 'ELECTRON_RUN_AS_NODE']) delete baseEnv[key]
  const init = spawnSync(node, [join(backend, 'scripts', 'home-bootstrap.mjs'), '--no-session-secret'], {
    cwd: backend, env: { ...baseEnv, AW_HOME: home }, windowsHide: true, timeout: 20_000,
  })
  if (init.error || init.status !== 0) throw new Error('Could not initialize the desktop data directory', { cause: init.error })

  const childEnv = {
    ...baseEnv,
    AW_HOME: home, AW_MODE: 'home', NODE_ENV: 'production', HOST,
    PORT: String(port), NITRO_HOST: HOST, NITRO_PORT: String(port),
    NITRO_UNIX_SOCKET: '', NITRO_SSL_CERT: '', NITRO_SSL_KEY: '',
    AW_DESKTOP_INSTANCE: secret, NUXT_SESSION_PASSWORD: sessionPassword,
  }
  const child = spawn(node, [launcher, '--port', String(port)], {
    cwd: home, env: childEnv, stdio: ['ignore', 'pipe', 'pipe', 'ipc'], windowsHide: true,
  })
  child.stdout.pipe(log, { end: false })
  child.stderr.pipe(log, { end: false })
  let failure
  const closed = new Promise((resolve) => {
    child.once('error', (err) => {
      failure = err
      resolve(-1)
    })
    child.once('close', resolve)
  })
  let binding
  child.on('message', (msg) => {
    if (msg?.type === 'aw.desktop.binding' && Number.isInteger(msg.port) && msg.port > 0 && msg.port <= 65535
      && /^[a-f0-9]{48}$/.test(msg.stopToken)) binding = msg
  })
  const client = (route, options = {}) => fetch(`http://${HOST}:${binding.port}${route}`, {
    ...options, signal: AbortSignal.timeout(1500), redirect: 'error',
  })
  async function ready() {
    if (!binding) return false
    const challenge = randomBytes(16).toString('hex')
    try {
      const res = await client('/api/health', { headers: { 'x-aw-desktop-challenge': challenge } })
      if (!res.ok) return false
      const { data } = await res.json()
      const expected = createHmac('sha256', secret).update(challenge).digest('hex')
      return data?.status === 'ok' && data.workshop === 'ready' && data.desktopProof === expected
    }
    catch {
      return false
    }
  }
  async function stop() {
    if (failure || child.exitCode !== null || child.signalCode) return
    // Authenticate the actual listener before sending the stop token.
    if (await ready()) {
      await client('/api/system/shutdown', { method: 'POST', headers: { 'x-aw-stop-token': binding.stopToken } }).catch(() => {})
    }
    const result = await Promise.race([closed, wait(11_000, 'timeout', { ref: false })])
    if (result !== 'timeout' || child.exitCode !== null || child.signalCode) return
    if (process.platform === 'win32') {
      // PID must still be our live supervisor and its command line must be the packaged launcher.
      const q = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `(Get-CimInstance Win32_Process -Filter 'ProcessId=${child.pid}').CommandLine`], { encoding: 'utf8', windowsHide: true, timeout: 4000 })
      if (q.status !== 0 || !String(q.stdout).toLowerCase().includes(launcher.toLowerCase()) || child.exitCode !== null) {
        throw new Error('Could not confirm ownership of the desktop server process')
      }
      const killed = spawnSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, timeout: 4000 })
      if (killed.status !== 0) throw new Error('Could not stop the desktop server process tree')
    }
    else child.kill('SIGTERM')
    if (await Promise.race([closed, wait(14_000, 'timeout', { ref: false })]) === 'timeout') {
      throw new Error('Desktop server did not exit')
    }
  }

  try {
    const until = Date.now() + 90_000
    while (Date.now() < until) {
      if (failure || child.exitCode !== null || child.signalCode) throw new Error('Desktop server exited before becoming ready', { cause: failure })
      if (await ready()) return { origin: `http://${HOST}:${binding.port}`, ready, stop, closed }
      await wait(250)
    }
    throw new Error('Desktop server did not become ready')
  }
  catch (err) {
    await stop()
    throw err
  }
}
