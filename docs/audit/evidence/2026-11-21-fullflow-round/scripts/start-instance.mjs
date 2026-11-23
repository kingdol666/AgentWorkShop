#!/usr/bin/env node
/**
 * Round launcher: start the built app detached with an isolated AW_HOME.
 * Generates the session secret at runtime; never writes it to disk.
 *
 * usage: node start-instance.mjs --port 3031 --home D:/tmp/.../clean-home \
 *          [--user-home D:/tmp/.../clean-user-home] [--log <path>] [--wait 90]
 */
import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { resolve } from 'node:path'

const arg = (k, d) => {
  const i = process.argv.indexOf(k)
  return i >= 0 ? process.argv[i + 1] : d
}
const repo = resolve(arg('--repo', 'D:/codes/ABO/AgentWorkShop'))
const port = String(arg('--port', '3031'))
const home = resolve(arg('--home'))
const userHome = arg('--user-home', '')
const log = resolve(arg('--log', `D:/tmp/aw-e2e-1121/logs/aw-${port}.log`))
const waitS = String(arg('--wait', '90'))

const env = {
  ...process.env,
  AW_MODE: 'home',
  AW_HOME: home,
  BACKUP_DISABLED: '1',
  AW_ALLOW_PRIVATE_OUTBOUND: '1',
  NUXT_SESSION_PASSWORD: randomBytes(32).toString('hex'),
  NO_PROXY: '127.0.0.1,localhost',
  HTTP_PROXY: '',
  HTTPS_PROXY: '',
}
if (userHome) {
  env.USERPROFILE = resolve(userHome)
  env.HOME = resolve(userHome)
}

console.log(`[launcher] port=${port} home=${home} userHome=${userHome || '(default)'} log=${log}`)
const child = spawn(process.execPath, [
  'scripts/_audit/detached-start.mjs',
  '--port', port,
  '--cwd', repo,
  '--log', log,
  '--wait', waitS,
], { cwd: repo, env, stdio: 'inherit' })
child.on('exit', code => process.exit(code ?? 1))
