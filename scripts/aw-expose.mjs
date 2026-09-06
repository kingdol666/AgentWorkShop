#!/usr/bin/env node
/**
 * aw-expose —— 把本机 AgentWorkShop 通过 Cloudflare Tunnel 映射到公网。
 *
 * 用法(在本机已能访问 Web UI 的前提下):
 *   node scripts/aw-expose.mjs                     # 自动探测本机实例(默认端口 3001/顺延)
 *   node scripts/aw-expose.mjs --port 3002         # 指定本地端口
 *   node scripts/aw-expose.mjs --token <TUNNEL_TOKEN>   # 具名隧道(绑定自己的域名;token 来自
 *       # Cloudflare Zero Trust → Networks → Tunnels → Create tunnel 的安装令牌,
 *       # 也可用环境变量 CLOUDFLARE_TUNNEL_TOKEN 传入,避免进入 shell 历史)
 *
 * 两种模式:
 *   - 快速隧道(默认,免账号):分配 https://<随机>.trycloudflare.com 公网地址,每次启动会变;
 *   - 具名隧道(--token):固定绑定你 Cloudflare 账号里的域名,地址长期不变,生产推荐。
 *
 * 行为:
 *   1) 定位 cloudflared(PATH → Windows 默认安装位 → ~/.AgentWorkShop/bin);
 *   2) 探活 http://127.0.0.1:<port>/api/health,实例未启动则给出 `aw start` 提示(--start 自动拉起);
 *   3) 拉起隧道进程,从输出解析公网 URL 并打印;
 *   4) 常驻保活(cloudflared 崩溃自动重启,10s 退避);Ctrl+C 一并收尾本地实例(--start 模式)与隧道。
 *
 * 安全提示:公网地址任何人可访问,登录门/权限体系是唯一边界;建议用具名隧道 +
 * Cloudflare Access(Zero Trust)做外层鉴权后再长期公开。
 */
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir, platform } from 'node:os'
import { join } from 'node:path'

// ---------- 参数 ----------
const argv = process.argv.slice(2)
const argOf = (name) => {
  const i = argv.indexOf(name)
  return i >= 0 && argv[i + 1] ? argv[i + 1] : undefined
}
const hasFlag = name => argv.includes(name)
const PORT = argOf('--port') ?? '3001'
const LOCAL = `http://127.0.0.1:${PORT}`
const TUNNEL_TOKEN = argOf('--token') ?? process.env.CLOUDFLARE_TUNNEL_TOKEN ?? ''
const WANT_START = hasFlag('--start')
const IS_WIN = platform() === 'win32'
const BIN = join(homedir(), '.AgentWorkShop', 'bin')

const say = msg => console.log(`[aw-expose] ${msg}`)
const die = (msg) => {
  say(`✖ ${msg}`)
  process.exit(1)
}

// ---------- 定位 cloudflared ----------
function findCloudflared() {
  const candidates = [
    argOf('--cloudflared'),
    join(BIN, IS_WIN ? 'cloudflared.exe' : 'cloudflared'),
    ...(IS_WIN ? [join(process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)', 'cloudflared', 'cloudflared.exe')] : ['/usr/local/bin/cloudflared', '/usr/bin/cloudflared']),
  ]
  for (const c of candidates) {
    if (c && existsSync(c)) return c
  }
  return null // 最后交给 PATH
}

async function healthy() {
  try {
    const res = await fetch(`${LOCAL}/api/health`, { signal: AbortSignal.timeout(3000) })
    return res.ok
  }
  catch {
    return false
  }
}

async function waitForHealthy(timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await healthy()) return true
    await new Promise(r => setTimeout(r, 1500))
  }
  return false
}

// ---------- 主流程 ----------
const cloudflared = findCloudflared()
if (!cloudflared) {
  die(`未找到 cloudflared。安装方式任选其一:
  winget install --id Cloudflare.cloudflared
  # 或下载到 ~/.AgentWorkShop/bin/cloudflared.exe
  https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/`)
}
say(`cloudflared: ${cloudflared}`)
say(`本地实例: ${LOCAL}`)

if (!(await healthy())) {
  if (!WANT_START) {
    die(`本地实例未就绪。请先启动(或加 --start 由本脚本拉起):
  aw start          # 生产模式(默认端口 3001,占用时自动顺延)
  aw start --port ${PORT}`)
  }
  say('本地实例未就绪,--start 模式:拉起 aw start …')
  const appRoot = process.env.AW_PACKAGE_ROOT ?? process.cwd()
  const awBin = join(appRoot, 'bin', 'aw.mjs')
  if (!existsSync(awBin)) die(`未找到 ${awBin};请在项目/包目录内运行,或用 --port 指向已运行实例`)
  const app = spawn(process.execPath, [awBin, 'start', '--port', PORT], {
    cwd: appRoot,
    stdio: 'ignore',
    detached: false,
    shell: false,
    env: { ...process.env },
  })
  app.on('exit', (code) => {
    if (code !== 0 && code !== null) say(`aw start 退出(code=${code})`)
  })
  say('等待本地实例就绪(最长 120s)…')
  if (!(await waitForHealthy(120_000))) die('本地实例 120s 内未就绪,放弃(可手工 aw start 后重试)')
}

// ---------- 隧道进程(崩溃自动重启) ----------
let quitting = false
let child = null
let currentUrl = ''

function startTunnel() {
  const args = TUNNEL_TOKEN
    ? ['tunnel', '--no-autoupdate', 'run', '--token', TUNNEL_TOKEN]
    : ['tunnel', '--no-autoupdate', '--url', LOCAL]
  child = spawn(cloudflared, args, { stdio: ['ignore', 'pipe', 'pipe'], shell: false })
  const scan = (buf) => {
    for (const line of String(buf).split(/\r?\n/)) {
      const m = line.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/i)
      if (m && m[0] !== currentUrl) {
        currentUrl = m[0]
        say('公网地址(快速隧道,重启会变):')
        console.log(`\n    ${currentUrl}\n`)
        say('浏览器打开即为本机 AgentWorkShop;Ctrl+C 结束映射。')
      }
      if (/Registered tunnel connection|connect.*registered/i.test(line) && TUNNEL_TOKEN) {
        say('具名隧道已连接(域名以 Cloudflare Tunnels 配置为准)。')
      }
    }
  }
  child.stdout.on('data', scan)
  child.stderr.on('data', scan)
  child.on('exit', (code) => {
    if (quitting) return
    say(`隧道进程退出(code=${code}),10s 后重启…`)
    setTimeout(startTunnel, 10_000)
  })
}

startTunnel()

const cleanup = () => {
  quitting = true
  say('正在结束隧道…')
  if (child) child.kill(IS_WIN ? undefined : 'SIGTERM')
  process.exit(0)
}
process.on('SIGINT', cleanup)
process.on('SIGTERM', cleanup)
