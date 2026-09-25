/**
 * 临时:以 detached 方式启动**全局安装的打包系统**(aw start),用于 0.7.46 发版实测。
 * 用法:PORT=3001 AW_HOME=<dir> node scripts/_aw-packaged-start.cjs
 */
const { spawn } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')

const repo = path.resolve(__dirname, '..')
const port = process.env.PORT ?? '3001'
const logDir = path.join(repo, '.e2e-matrix')
fs.mkdirSync(logDir, { recursive: true })
const out = fs.openSync(path.join(logDir, `aw-packaged-${port}.out.log`), 'a')
const p = spawn('aw', ['start', '--port', port], {
  detached: true,
  stdio: ['ignore', out, out],
  env: process.env,
  cwd: repo,
  shell: true,
})
p.unref()
console.log(`[aw-packaged] spawned pid=${p.pid} port=${port} home=${process.env.AW_HOME ?? '(default)'}`)
