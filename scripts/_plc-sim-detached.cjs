/**
 * 临时:detached 拉起 PLC 节点模拟器(API :4010 + Modbus TCP :16040 等六协议)。
 * 用法:node scripts/_plc-sim-detached.cjs
 */
const { spawn } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')

const repo = path.resolve(__dirname, '..')
const simDir = path.join(repo, 'plc-node-simulator')
const logDir = path.join(repo, '.e2e-matrix')
fs.mkdirSync(logDir, { recursive: true })
const out = fs.openSync(path.join(logDir, 'plc-sim-0746.out.log'), 'a')
const tsx = path.join(simDir, 'node_modules', 'tsx', 'dist', 'cli.mjs')
const p = spawn(process.execPath, [tsx, 'src/server/index.ts'], {
  detached: true,
  stdio: ['ignore', out, out],
  env: { ...process.env, SIM_PORT: process.env.SIM_PORT ?? '4010' },
  cwd: simDir,
})
p.unref()
console.log(`[plc-sim] spawned pid=${p.pid}`)
